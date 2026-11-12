/**
 * AEM as a Cloud Service Assets Client
 *
 * Handles:
 * 1. Checking if an asset's folder has the Face Recognition Processing Profile applied
 *    or matches the enabled folders list.
 * 2. Fetching the asset's 1280x1280 web rendition buffer for AWS Rekognition & avatar cropping.
 * 3. Listing image assets in a DAM folder for batch scanning.
 * 4. Writing multi-value face group names (`xdm:faceNames`) and group IDs (`xdm:faceGroupIds`)
 *    back to `jcr:content/metadata` on the AEM asset.
 */

const crypto = require('crypto');
const {
  PublicError,
  assertDamPath,
  isValidDamPath,
  isValidMetadataProperty
} = require('./security');
const { withRetry, isNetworkError, RETRYABLE_HTTP_STATUSES } = require('./retry');

// AWS Rekognition accepts at most 5 MB of image bytes, so anything larger is useless and
// only risks exhausting action memory.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FOLDER_PAGE_SIZE = 200;
const MAX_FOLDER_PAGES = 50; // up to 10,000 entries per folder

class RetryableHttpStatus extends Error {
  constructor(response) {
    super(`Retryable HTTP ${response.status}`);
    this.response = response;
  }
}

/**
 * Parses an HTTP Retry-After header (seconds or HTTP date) into milliseconds.
 */
function parseRetryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Reads a response body into a Buffer, aborting once it exceeds maxBytes.
 * Returns null when the body is too large.
 */
async function readBodyWithLimit(res, maxBytes) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch (e) {
          // ignore
        }
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > maxBytes ? null : buf;
}

function normalizeAemHost(aemHost) {
  if (!aemHost) return '';
  let clean = String(aemHost).trim().replace(/\/+$/, '');
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = `https://${clean}`;
  }
  return clean;
}

function normalizeDamPath(assetPath) {
  if (!assetPath) return '';
  let clean = String(assetPath).trim();
  if (!clean.startsWith('/')) clean = `/${clean}`;
  return clean;
}

/**
 * Segment-aware prefix match: '/content/dam/events' matches '/content/dam/events/x.jpg'
 * but not '/content/dam/events-private/x.jpg'.
 */
function isPathWithin(childPath, parentPath) {
  const parent = normalizeDamPath(parentPath).replace(/\/+$/, '');
  const child = normalizeDamPath(childPath);
  return child === parent || child.startsWith(`${parent}/`);
}

function encodeDamPath(damPath) {
  return String(damPath || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function toApiAssetsRelativePath(assetPath) {
  const clean = normalizeDamPath(assetPath);
  const rel = clean.replace(/^\/content\/dam\/?/, '');
  return rel
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

const b64url = (x) =>
  Buffer.from(x)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const serviceTokenCache = new Map();

function parseServiceCredentialsJson(scJson) {
  const trimmed = String(scJson || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  return JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
}

/**
 * Exchanges AEM Service Credentials JSON (`scJson`) for an IMS access token (`S9`).
 * Supports both:
 * 1. Modern OAuth Server-to-Server credentials (`/ims/token/v3` client_credentials grant)
 * 2. Legacy JWT Service Account credentials (`/ims/exchange/jwt`, kept for backward compatibility)
 * Falls back to `devToken` when provided.
 */
async function getServiceToken(fetchImpl, { scJson, devToken } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const scRaw = scJson || '';
  const cacheKey = scRaw ? crypto.createHash('sha256').update(scRaw).digest('hex') : '';
  const cached = cacheKey && serviceTokenCache.get(cacheKey);
  if (cached && cached.exp > now + 60) {
    return cached.token;
  }

  if (scRaw && fetchImpl) {
    try {
      const raw = parseServiceCredentialsJson(scRaw);
      const sc = raw?.integration || raw || {};
      const imsHost = String(sc.imsEndpoint || raw?.imsEndpoint || 'ims-na1.adobelogin.com')
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '');

      // 1. OAuth Server-to-Server credentials (recommended; replaces deprecated JWT flow)
      const oauthClientId = sc.clientId || sc.client_id || sc.oauth?.clientId || sc.oauth?.client_id;
      const oauthClientSecret =
        sc.clientSecret ||
        sc.client_secret ||
        (Array.isArray(sc.clientSecrets) ? sc.clientSecrets[0] : null) ||
        sc.oauth?.clientSecret ||
        sc.oauth?.client_secret;
      const rawScopes = sc.scopes || sc.scope || sc.oauth?.scopes || 'openid,AdobeID,aem.folders,aem.assets.author';

      if (oauthClientId && oauthClientSecret && !sc.privateKey) {
        const scopeStr = Array.isArray(rawScopes) ? rawScopes.join(',') : String(rawScopes);
        const body = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: oauthClientId,
          client_secret: oauthClientSecret,
          scope: scopeStr
        });
        const r = await fetchImpl(`https://${imsHost}/ims/token/v3`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });
        if (r.ok) {
          const data = await r.json();
          if (data.access_token) {
            const ttl = Math.max(120, Math.min(Number(data.expires_in) || 3600, 86400) - 60);
            serviceTokenCache.set(cacheKey, { token: data.access_token, exp: now + ttl });
            return data.access_token;
          }
        }
      }

      // 2. Legacy JWT Service Account credentials (backward compatibility)
      if (sc.privateKey && sc.technicalAccount?.clientId) {
        const payload = {
          exp: now + 300,
          iss: sc.org,
          sub: sc.id,
          aud: `https://${imsHost}/c/${sc.technicalAccount.clientId}`
        };
        payload[`https://${imsHost}/s/${sc.metascopes}`] = true;
        const si =
          b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) +
          '.' +
          b64url(JSON.stringify(payload));
        const jwt =
          si + '.' + b64url(crypto.sign('RSA-SHA256', Buffer.from(si), sc.privateKey));
        const body = new URLSearchParams({
          client_id: sc.technicalAccount.clientId,
          client_secret: sc.technicalAccount.clientSecret,
          jwt_token: jwt
        });
        const r = await fetchImpl(`https://${imsHost}/ims/exchange/jwt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        if (r.ok) {
          const data = await r.json();
          if (data.access_token) {
            serviceTokenCache.set(cacheKey, { token: data.access_token, exp: now + 240 });
            return data.access_token;
          }
        }
      }
    } catch (e) {
      // Fall through to devToken
    }
  }

  if (devToken) {
    return String(devToken).trim();
  }

  return '';
}

function isHtmlPayload(textOrBuf) {
  if (!textOrBuf) return false;
  const sample = Buffer.isBuffer(textOrBuf)
    ? textOrBuf.slice(0, 64).toString('utf8').trimStart()
    : String(textOrBuf).slice(0, 64).trimStart();
  return /^<!doctype\s+html/i.test(sample) || /^<html/i.test(sample);
}

/**
 * Creates an AEM client bound to an author host and IMS bearer token.
 *
 * Authentication is deliberately strict:
 * - If a user token is supplied, ONLY that token is used (no silent escalation to the
 *   technical account when AEM rejects the user).
 * - `serviceCredentials` ({ scJson, devToken }) are only used when no user token is present,
 *   and callers must only pass them for trusted, non-web invocations (I/O Events) against
 *   the deployment-configured AEM host.
 */
function createAemClient({
  aemHost,
  token,
  fetchImpl = global.fetch,
  serviceCredentials = null,
  retryOptions = {}
} = {}) {
  const baseUrl = normalizeAemHost(aemHost);

  function buildAuthHeaders(bearerToken, extra = {}) {
    const headers = { ...extra };
    if (bearerToken) {
      headers.Authorization = bearerToken.startsWith('Bearer ')
        ? bearerToken
        : `Bearer ${bearerToken}`;
    }
    return headers;
  }

  let resolvedTokenPromise = null;
  function resolveToken() {
    if (token) return Promise.resolve(token);
    if (!serviceCredentials) return Promise.resolve('');
    if (!resolvedTokenPromise) {
      resolvedTokenPromise = getServiceToken(fetchImpl, serviceCredentials);
    }
    return resolvedTokenPromise;
  }

  /**
   * Executes an authenticated fetch against the bound AEM host.
   */
  async function fetchAemWithFallback(url, options = {}) {
    if (!String(url).startsWith(`${baseUrl}/`)) {
      throw new Error('Refusing to send AEM credentials to a different origin.');
    }
    const activeToken = await resolveToken();
    const doFetch = async () => {
      const res = await fetchImpl(url, {
        ...options,
        redirect: 'manual',
        headers: buildAuthHeaders(activeToken, options.headers)
      });
      if (RETRYABLE_HTTP_STATUSES.has(res.status)) {
        throw new RetryableHttpStatus(res);
      }
      return res;
    };

    // All requests made by this client are idempotent (GETs and Sling property sets),
    // so they are safe to retry on throttling, gateway errors and network failures.
    try {
      return await withRetry(doFetch, {
        maxAttempts: 4,
        baseDelayMs: 250,
        maxDelayMs: 4000,
        maxTotalDelayMs: 8000,
        isRetryable: (err) => err instanceof RetryableHttpStatus || isNetworkError(err),
        getRetryAfterMs: (err) =>
          err instanceof RetryableHttpStatus
            ? parseRetryAfterMs(err.response.headers?.get?.('retry-after'))
            : null,
        ...retryOptions
      });
    } catch (err) {
      // Out of retries on a retryable status: hand the response back so callers see it
      if (err instanceof RetryableHttpStatus) return err.response;
      throw err;
    }
  }

  /**
   * Fetches and safely parses JSON from AEM, throwing a clear error if AEM returns an HTML login page.
   */
  async function fetchAemJson(url, options = {}) {
    const res = await fetchAemWithFallback(url, options);
    if (!res.ok) {
      throw new Error(`AEM request failed (HTTP ${res.status}) for ${url}`);
    }

    if (typeof res.text === 'function') {
      const text = await res.text();
      if (isHtmlPayload(text)) {
        throw new Error(
          `AEM returned an HTML login page instead of JSON for ${url}. Please check your AEM session or service credentials.`
        );
      }
      return JSON.parse(text);
    }

    return res.json();
  }

  return {
    /**
     * Checks whether an asset's folder is eligible for Face Recognition.
     */
    async checkFolderEligibility(assetPath, settings) {
      const cleanPath = assertDamPath(assetPath, 'asset path');
      const enabledFolders = Array.isArray(settings.enabledFolders)
        ? settings.enabledFolders
        : ['/content/dam'];

      const matchesFolderPrefix = enabledFolders.some((prefix) =>
        isPathWithin(cleanPath, prefix)
      );

      if (!settings.requireProcessingProfile) {
        return {
          eligible: matchesFolderPrefix,
          reason: matchesFolderPrefix
            ? 'Asset path matches enabled DAM folder prefix'
            : 'Asset path is outside enabled DAM folders'
        };
      }

      if (!baseUrl || !fetchImpl) {
        return {
          eligible: matchesFolderPrefix,
          reason: 'Matched enabled folder prefix (offline mode)'
        };
      }

      const segments = cleanPath.split('/').filter(Boolean);
      segments.pop();

      const targetProfile = (settings.processingProfileName || 'Face Recognition').toLowerCase().trim();
      const targetProfileSlug = targetProfile.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

      while (segments.length >= 2 && segments[0] === 'content' && segments[1] === 'dam') {
        const folderPath = `/${segments.join('/')}`;
        const encodedFolderPath = encodeDamPath(folderPath);
        try {
          const url = `${baseUrl}${encodedFolderPath}/jcr:content.2.json`;
          let jcrContent;
          try {
            jcrContent = await fetchAemJson(url);
          } catch (e) {
            jcrContent = await fetchAemJson(`${baseUrl}${encodedFolderPath}/jcr:content.1.json`);
          }
          const assignedProfile = String(
            jcrContent['dam:processingProfile'] ||
              jcrContent.processingProfile ||
              jcrContent.metadata?.['dam:processingProfile'] ||
              jcrContent.metadata?.processingProfile ||
              ''
          ).toLowerCase();
          const assignedProfileSlug = assignedProfile.replace(/[^a-z0-9/]+/g, '-');

          const explicitFlag =
            jcrContent.faceRecognitionEnabled === true ||
            jcrContent.metadata?.faceRecognitionEnabled === true ||
            jcrContent.metadata?.['xdm:faceRecognitionEnabled'] === 'true';

          const profileMatched =
            Boolean(assignedProfile) &&
            (assignedProfile.includes(targetProfile) ||
              (Boolean(targetProfileSlug) && assignedProfileSlug.includes(targetProfileSlug)));

          if (explicitFlag || profileMatched) {
            return {
              eligible: true,
              reason: `Folder ${folderPath} has Processing Profile '${assignedProfile || targetProfile}' enabled`
            };
          }
        } catch (err) {
          // Continue walking up ancestor folders
        }
        segments.pop();
      }

      const specificFolderConfigured = enabledFolders.some(
        (prefix) =>
          normalizeDamPath(prefix) !== '/content/dam' &&
          isPathWithin(cleanPath, prefix)
      );

      if (specificFolderConfigured) {
        return {
          eligible: true,
          reason: 'Asset is inside an explicitly enabled DAM subfolder'
        };
      }

      return {
        eligible: false,
        reason: `No '${settings.processingProfileName}' processing profile found on ancestor folders of ${cleanPath}`
      };
    },

    /**
     * Resolves an AEM `urn:aaid:aem:<uuid>` or raw `jcr:uuid` to its `/content/dam/...` path
     * via AEM QueryBuilder.
     */
    async resolvePathByAssetUuid(assetId) {
      if (!assetId || !baseUrl || !fetchImpl) return null;
      const rawUuid = String(assetId).replace(/^urn:aaid:aem:/i, '').trim();
      if (!rawUuid) return null;
      if (rawUuid.startsWith('/')) return isValidDamPath(rawUuid) ? rawUuid : null;
      if (!/^[A-Za-z0-9-]{8,64}$/.test(rawUuid)) return null;

      try {
        const qbUrl = `${baseUrl}/bin/querybuilder.json?property=jcr:uuid&property.value=${encodeURIComponent(
          rawUuid
        )}&p.limit=1`;
        const data = await fetchAemJson(qbUrl);
        const hitPath = data.hits?.[0]?.path;
        if (hitPath && isValidDamPath(hitPath)) {
          return hitPath;
        }
      } catch (e) {
        // ignore if QueryBuilder is unavailable
      }
      return null;
    },

    /**
     * Fetches basic asset info (assetId / jcr:uuid, title, mimeType) from AEM.
     */
    async getAssetInfo(assetPath) {
      const cleanPath = assertDamPath(assetPath, 'asset path');
      const fallbackTitle = cleanPath.split('/').pop() || 'asset.jpg';

      if (!baseUrl || !fetchImpl) {
        return {
          assetId: `urn:aaid:aem:${Buffer.from(cleanPath).toString('hex').slice(0, 24)}`,
          assetPath: cleanPath,
          assetTitle: fallbackTitle
        };
      }

      const relPath = toApiAssetsRelativePath(cleanPath);
      try {
        const data = await fetchAemJson(`${baseUrl}/api/assets/${relPath}.json`);
        const uuid =
          data.properties?.['jcr:uuid'] ||
          data['jcr:uuid'] ||
          `urn:aaid:aem:${Buffer.from(cleanPath).toString('hex').slice(0, 24)}`;
        const title =
          data.properties?.['dc:title'] ||
          data.properties?.name ||
          fallbackTitle;
        const format = data.properties?.metadata?.['dc:format'] || data.properties?.['dc:format'] || null;
        return {
          assetId: uuid,
          assetPath: cleanPath,
          assetTitle: Array.isArray(title) ? title[0] : title,
          mimeType: format ? String(Array.isArray(format) ? format[0] : format).toLowerCase() : null
        };
      } catch (err) {
        // Fallback if API call fails
      }

      return {
        assetId: `urn:aaid:aem:${Buffer.from(cleanPath).toString('hex').slice(0, 24)}`,
        assetPath: cleanPath,
        assetTitle: fallbackTitle
      };
    },

    /**
     * Downloads the 1280x1280 JPEG web rendition (or fallback rendition) of an AEM asset as a Buffer.
     */
    async fetchAssetRenditionBuffer(assetPath) {
      const cleanPath = assertDamPath(assetPath, 'asset path');
      if (!baseUrl || !fetchImpl) {
        throw new Error('AEM host URL is required to download asset renditions.');
      }

      const encodedPath = encodeDamPath(cleanPath);
      const candidateUrls = [
        `${baseUrl}${encodedPath}/_jcr_content/renditions/cq5dam.web.1280.1280.jpeg`,
        `${baseUrl}${encodedPath}/jcr:content/renditions/cq5dam.web.1280.1280.jpeg`,
        `${baseUrl}${encodedPath}/_jcr_content/renditions/cq5dam.thumbnail.319.319.png`,
        // Last resort; skipped automatically when larger than MAX_IMAGE_BYTES
        `${baseUrl}${encodedPath}/_jcr_content/renditions/original`
      ];

      let sawOversized = false;
      for (const url of candidateUrls) {
        try {
          const res = await fetchAemWithFallback(url);
          if (res.ok) {
            const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
            if (contentType.includes('text/html')) {
              continue;
            }
            const buf = await readBodyWithLimit(res, MAX_IMAGE_BYTES);
            if (!buf) {
              sawOversized = true;
              continue;
            }
            if (!isHtmlPayload(buf) && buf.length > 0) {
              return buf;
            }
          }
        } catch (err) {
          // Try next rendition URL
        }
      }

      if (sawOversized) {
        throw new PublicError(
          `No rendition of ${cleanPath} is small enough to analyze (limit ${MAX_IMAGE_BYTES / 1024 / 1024} MB). Make sure AEM has generated its web rendition.`
        );
      }
      throw new PublicError(
        `Could not download an image rendition for ${cleanPath} from AEM. Check that the asset has finished processing and that you have access to it.`,
        502
      );
    },

    /**
     * Lists both child folders and image assets inside a DAM folder via the AEM Assets HTTP API.
     */
    /**
     * Lists child folders and assets. When `allowedImageTypes` is given, only assets of those
     * types are returned (assets with no recorded type are excluded too); the number of
     * excluded assets is reported as `excludedAssetCount`.
     */
    async browseDamFolder(folderPath = '/content/dam', { allowedImageTypes = null } = {}) {
      const cleanFolder = assertDamPath(folderPath || '/content/dam', 'folder path');
      if (!baseUrl || !fetchImpl) {
        return {
          folderPath: cleanFolder,
          folderTitle: cleanFolder.split('/').pop() || 'DAM',
          folders: [],
          assets: [],
          excludedAssetCount: 0
        };
      }

      const allowed = Array.isArray(allowedImageTypes)
        ? new Set(allowedImageTypes.map((t) => String(t).toLowerCase()))
        : null;
      let excludedAssetCount = 0;

      const relFolder = toApiAssetsRelativePath(cleanFolder);
      const basePath = relFolder ? `/api/assets/${relFolder}.json` : '/api/assets.json';

      const folders = [];
      const assets = [];
      const seenPaths = new Set();
      let folderTitle = null;
      let offset = 0;

      for (let page = 0; page < MAX_FOLDER_PAGES; page++) {
        const data = await fetchAemJson(
          `${baseUrl}${basePath}?limit=${FOLDER_PAGE_SIZE}&offset=${offset}`
        );
        if (page === 0) {
          folderTitle = data.properties?.['dc:title'] || data.properties?.title || null;
        }
        const entities = data.entities || [];
        if (entities.length === 0) break;

        let newInPage = 0;
        for (const entity of entities) {
        const classes = entity.class || [];
        const name = entity.properties?.name || '';
        if (!name) continue;
        const title = entity.properties?.['dc:title'] || entity.properties?.title || name;
        const fullPath = `${cleanFolder.replace(/\/$/, '')}/${name}`;

        if (seenPaths.has(fullPath)) continue;
        seenPaths.add(fullPath);
        newInPage++;

        if (classes.includes('assets/folder')) {
          folders.push({
            name,
            title: Array.isArray(title) ? title[0] : title,
            folderPath: fullPath
          });
        } else if (classes.includes('assets/asset')) {
          const mimeType =
            entity.properties?.metadata?.['dc:format'] ||
            entity.properties?.['dc:format'] ||
            '';
          const normalizedType = String(Array.isArray(mimeType) ? mimeType[0] : mimeType || '')
            .toLowerCase()
            .split(';')[0]
            .trim();
          const include = allowed
            ? allowed.has(normalizedType)
            : !normalizedType || normalizedType.startsWith('image/');
          if (!include) {
            excludedAssetCount++;
          } else {
            assets.push({
              assetId: entity.properties?.['jcr:uuid'] || fullPath,
              assetPath: fullPath,
              assetTitle: Array.isArray(title) ? title[0] : title,
              mimeType: normalizedType || null,
              thumbnailUrl: `${baseUrl}${fullPath}/_jcr_content/renditions/cq5dam.thumbnail.319.319.png`
            });
          }
        }
        }

        const hasNextLink = Array.isArray(data.links) && data.links.some((l) => {
          const rel = l?.rel;
          return Array.isArray(rel) ? rel.includes('next') : rel === 'next';
        });
        // Stop once we see a short page (with no 'next' link) or a server that ignores offset
        if (newInPage === 0 || (entities.length < FOLDER_PAGE_SIZE && !hasNextLink)) break;
        offset += entities.length;
      }

      return {
        folderPath: cleanFolder,
        folderTitle: folderTitle || cleanFolder.split('/').pop() || 'Assets',
        folders,
        assets,
        excludedAssetCount
      };
    },

    /**
     * Lists image assets inside a DAM folder via the AEM Assets HTTP API.
     */
    async listFolderAssets(folderPath, options = {}) {
      const browsed = await this.browseDamFolder(folderPath, options);
      return browsed.assets || [];
    },

    /**
     * Checks whether the caller is an AEM Administrator or member of the configured
     * `curatorGroups` (via `/libs/granite/security/currentuser.json` or read access to
     * `/conf/global/settings/dam/processing.2.json`) and optionally lists the DAM Processing
     * Profiles configured on the AEM instance for the Settings dropdown.
     */
    async getAdminStatusAndProfiles({
      includeProfiles = true,
      curatorGroups = ['administrators', 'dam-administrators']
    } = {}) {
      if (!baseUrl || !fetchImpl) {
        return {
          isAdmin: true,
          isCurator: true,
          userGroups: ['administrators'],
          processingProfiles: [
            {
              name: 'Face Recognition',
              path: '/conf/global/settings/dam/processing/face-recognition'
            }
          ]
        };
      }

      const requests = [
        fetchAemWithFallback(
          `${baseUrl}/libs/granite/security/currentuser.json?props=authorizableId,memberOf`
        )
      ];
      if (includeProfiles) {
        requests.push(
          fetchAemWithFallback(`${baseUrl}/conf/global/settings/dam/processing.2.json`)
        );
      }

      const [userRes, profilesRes] = await Promise.allSettled(requests);

      let explicitlyNonAdmin = false;
      let isAdminByGroup = false;
      let isCuratorByGroup = false;
      let userGroups = [];

      const allowedCurators = new Set(
        (Array.isArray(curatorGroups) ? curatorGroups : ['administrators', 'dam-administrators'])
          .map((g) => String(g || '').trim().toLowerCase())
          .filter(Boolean)
      );

      if (userRes.status === 'fulfilled') {
        const res = userRes.value;
        if (res.status === 401 || res.status === 403) {
          explicitlyNonAdmin = true;
        } else if (res.ok) {
          try {
            const text =
              typeof res.text === 'function'
                ? await res.text()
                : JSON.stringify(await res.json());
            if (!isHtmlPayload(text)) {
              const data = JSON.parse(text);
              const authId = String(data.authorizableId || '').toLowerCase();
              const rawMembers = Array.isArray(data.memberOf) ? data.memberOf : [];
              const groupNames = rawMembers
                .map((m) =>
                  String(typeof m === 'string' ? m : m?.authorizableId || m?.name || '')
                    .trim()
                    .toLowerCase()
                )
                .filter(Boolean);
              userGroups = groupNames;
              if (authId || groupNames.length > 0) {
                isAdminByGroup =
                  authId === 'admin' ||
                  groupNames.some(
                    (g) =>
                      g === 'administrators' ||
                      g === 'dam-administrators' ||
                      g.includes('administrators')
                  );
                isCuratorByGroup =
                  isAdminByGroup ||
                  (authId && allowedCurators.has(authId)) ||
                  groupNames.some((g) => allowedCurators.has(g));
                if (!isAdminByGroup) {
                  explicitlyNonAdmin = true;
                }
              }
            }
          } catch (e) {
            // ignore parse error
          }
        }
      }

      const processingProfiles = [];
      let canReadProcessingConf = false;

      if (profilesRes && profilesRes.status === 'fulfilled') {
        const res = profilesRes.value;
        if (res.status === 401 || res.status === 403) {
          explicitlyNonAdmin = true;
        } else if (res.ok) {
          try {
            const text =
              typeof res.text === 'function'
                ? await res.text()
                : JSON.stringify(await res.json());
            if (!isHtmlPayload(text)) {
              const data = JSON.parse(text);
              for (const [key, val] of Object.entries(data || {})) {
                if (key.startsWith('jcr:') || key.startsWith('rep:') || key.startsWith('sling:')) {
                  continue;
                }
                if (val && typeof val === 'object') {
                  canReadProcessingConf = true;
                  const jcr = val['jcr:content'] || val;
                  const title =
                    jcr['jcr:title'] ||
                    jcr.title ||
                    jcr['dc:title'] ||
                    val['jcr:title'] ||
                    key;
                  const cleanTitle = String(Array.isArray(title) ? title[0] : title).trim();
                  if (cleanTitle) {
                    processingProfiles.push({
                      name: cleanTitle,
                      nodeName: key,
                      path: `/conf/global/settings/dam/processing/${key}`
                    });
                  }
                }
              }
            }
          } catch (e) {
            // ignore parse error
          }
        }
      }

      const isAdmin =
        isAdminByGroup || (canReadProcessingConf && !explicitlyNonAdmin) || !explicitlyNonAdmin;
      const isCurator = isAdmin || isCuratorByGroup;

      return {
        isAdmin,
        isCurator,
        userGroups,
        processingProfiles
      };
    },

    /**
     * Writes multi-value face metadata (`xdm:faceNames`, optional secondary property such as
     * `iptc4xmpExt:PersonInImage`, `xdm:faceGroupIds`, `xdm:faceCount`) back to
     * `jcr:content/metadata` on the AEM Asset.
     */
    async updateAssetFaceMetadata(
      assetPath,
      {
        faceNames = [],
        faceLabels = [],
        faceGroupIds = [],
        faceCount = 0,
        metadataProperty = 'xdm:faceNames',
        secondaryMetadataProperty = null
      }
    ) {
      const cleanPath = assertDamPath(assetPath, 'asset path');
      if (!isValidMetadataProperty(metadataProperty)) {
        throw new PublicError(`Invalid metadata property name: ${metadataProperty}`);
      }
      if (secondaryMetadataProperty && !isValidMetadataProperty(secondaryMetadataProperty)) {
        throw new PublicError(
          `Invalid secondary metadata property name: ${secondaryMetadataProperty}`
        );
      }
      const hasDistinctSecondary =
        Boolean(secondaryMetadataProperty) && secondaryMetadataProperty !== metadataProperty;
      const effectiveLabels = Array.isArray(faceLabels) && faceLabels.length > 0 ? faceLabels : faceNames;
      const metadataOut = {
        [metadataProperty]: faceNames,
        ...(hasDistinctSecondary ? { [secondaryMetadataProperty]: faceNames } : {}),
        'xdm:faceLabels': effectiveLabels,
        'xdm:faceGroupIds': faceGroupIds,
        'xdm:faceCount': faceCount
      };

      if (!baseUrl || !fetchImpl) {
        return {
          updated: false,
          offline: true,
          assetPath: cleanPath,
          metadata: metadataOut
        };
      }

      const formData = new URLSearchParams();
      formData.append(`${metadataProperty}@TypeHint`, 'String[]');
      if (faceNames.length === 0) {
        formData.append(`${metadataProperty}@Delete`, 'true');
      } else {
        for (const name of faceNames) {
          formData.append(metadataProperty, name);
        }
      }

      if (hasDistinctSecondary) {
        formData.append(`${secondaryMetadataProperty}@TypeHint`, 'String[]');
        if (faceNames.length === 0) {
          formData.append(`${secondaryMetadataProperty}@Delete`, 'true');
        } else {
          for (const name of faceNames) {
            formData.append(secondaryMetadataProperty, name);
          }
        }
      }

      formData.append('xdm:faceLabels@TypeHint', 'String[]');
      if (effectiveLabels.length === 0) {
        formData.append('xdm:faceLabels@Delete', 'true');
      } else {
        for (const label of effectiveLabels) {
          formData.append('xdm:faceLabels', label);
        }
      }

      formData.append('xdm:faceGroupIds@TypeHint', 'String[]');
      if (faceGroupIds.length === 0) {
        formData.append('xdm:faceGroupIds@Delete', 'true');
      } else {
        for (const groupId of faceGroupIds) {
          formData.append('xdm:faceGroupIds', groupId);
        }
      }

      formData.append('xdm:faceCount', String(faceCount));
      formData.append('xdm:faceCount@TypeHint', 'Long');

      const metadataUrl = `${baseUrl}${encodeDamPath(cleanPath)}/jcr:content/metadata`;
      const slingRes = await fetchAemWithFallback(metadataUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData.toString()
      });

      if (!slingRes.ok) {
        const relPath = toApiAssetsRelativePath(cleanPath);
        const apiRes = await fetchAemWithFallback(`${baseUrl}/api/assets/${relPath}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            class: 'asset',
            properties: {
              metadata: metadataOut
            }
          })
        });
        if (!apiRes.ok) {
          throw new Error(
            `Failed to write face metadata to AEM (HTTP ${slingRes.status} / ${apiRes.status}) for ${cleanPath}`
          );
        }
      }

      return {
        updated: true,
        assetPath: cleanPath,
        metadata: metadataOut
      };
    }
  };
}

module.exports = {
  createAemClient,
  normalizeAemHost,
  normalizeDamPath,
  isPathWithin,
  toApiAssetsRelativePath,
  parseRetryAfterMs,
  readBodyWithLimit,
  MAX_IMAGE_BYTES,
  getServiceToken
};
