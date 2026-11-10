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

function toApiAssetsRelativePath(assetPath) {
  const clean = normalizeDamPath(assetPath);
  return clean.replace(/^\/content\/dam\/?/, '');
}

const b64url = (x) =>
  Buffer.from(x)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

let cachedServiceToken = null;
let cachedServiceTokenExp = 0;

/**
 * Exchanges base64-encoded AEM Service Credentials JSON (AEM_SC_JSON) for an IMS access token.
 */
async function getFallbackServiceToken(fetchImpl = global.fetch) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedServiceToken && cachedServiceTokenExp > now + 60) {
    return cachedServiceToken;
  }

  const scB64 = process.env.AEM_SC_JSON;
  if (scB64 && fetchImpl) {
    try {
      const raw = JSON.parse(Buffer.from(scB64, 'base64').toString('utf8'));
      const sc = raw.integration || raw;
      const payload = {
        exp: now + 300,
        iss: sc.org,
        sub: sc.id,
        aud: `https://${sc.imsEndpoint}/c/${sc.technicalAccount.clientId}`
      };
      payload[`https://${sc.imsEndpoint}/s/${sc.metascopes}`] = true;
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
      const r = await fetchImpl(`https://${sc.imsEndpoint}/ims/exchange/jwt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (r.ok) {
        const data = await r.json();
        if (data.access_token) {
          cachedServiceToken = data.access_token;
          cachedServiceTokenExp = now + 240;
          return cachedServiceToken;
        }
      }
    } catch (e) {
      // Fall through to AEM_DEV_TOKEN
    }
  }

  if (process.env.AEM_DEV_TOKEN) {
    return String(process.env.AEM_DEV_TOKEN).trim();
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
 */
function createAemClient({ aemHost, token, fetchImpl = global.fetch } = {}) {
  const baseUrl = normalizeAemHost(
    aemHost || process.env.AEM_AUTHOR_URL || process.env.AEM_HOST
  );

  function buildAuthHeaders(bearerToken, extra = {}) {
    const headers = { ...extra };
    if (bearerToken) {
      headers.Authorization = bearerToken.startsWith('Bearer ')
        ? bearerToken
        : `Bearer ${bearerToken}`;
    }
    return headers;
  }

  /**
   * Executes a fetch against AEM with automatic fallback to AEM_SC_JSON / AEM_DEV_TOKEN
   * if the caller token is missing or if AEM returns an HTML login redirect (`<!DOCTYPE html>`).
   */
  async function fetchAemWithFallback(url, options = {}) {
    let activeToken = token || (await getFallbackServiceToken(fetchImpl));
    let res = await fetchImpl(url, {
      ...options,
      headers: buildAuthHeaders(activeToken, options.headers)
    });

    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
    const needsRetry = !res.ok || contentType.includes('text/html');

    if (needsRetry && token) {
      const fallbackToken = await getFallbackServiceToken(fetchImpl);
      if (fallbackToken && fallbackToken !== activeToken) {
        res = await fetchImpl(url, {
          ...options,
          headers: buildAuthHeaders(fallbackToken, options.headers)
        });
      }
    }

    return res;
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
      const cleanPath = normalizeDamPath(assetPath);
      const enabledFolders = Array.isArray(settings.enabledFolders)
        ? settings.enabledFolders
        : ['/content/dam'];

      const matchesFolderPrefix = enabledFolders.some((prefix) =>
        cleanPath.startsWith(normalizeDamPath(prefix))
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

      const targetProfile = (settings.processingProfileName || 'Face Recognition').toLowerCase();

      while (segments.length >= 2 && segments[0] === 'content' && segments[1] === 'dam') {
        const folderPath = `/${segments.join('/')}`;
        try {
          const url = `${baseUrl}${folderPath}/jcr:content.1.json`;
          const jcrContent = await fetchAemJson(url);
          const assignedProfile = String(
            jcrContent['dam:processingProfile'] ||
              jcrContent.processingProfile ||
              jcrContent.metadata?.['dam:processingProfile'] ||
              ''
          ).toLowerCase();

          const explicitFlag =
            jcrContent.faceRecognitionEnabled === true ||
            jcrContent.metadata?.faceRecognitionEnabled === true ||
            jcrContent.metadata?.['xdm:faceRecognitionEnabled'] === 'true';

          if (explicitFlag || (assignedProfile && assignedProfile.includes(targetProfile))) {
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
          cleanPath.startsWith(normalizeDamPath(prefix))
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
     * Fetches basic asset info (assetId / jcr:uuid, title, mimeType) from AEM.
     */
    async getAssetInfo(assetPath) {
      const cleanPath = normalizeDamPath(assetPath);
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
        return {
          assetId: uuid,
          assetPath: cleanPath,
          assetTitle: Array.isArray(title) ? title[0] : title
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
      const cleanPath = normalizeDamPath(assetPath);
      if (!baseUrl || !fetchImpl) {
        throw new Error('AEM host URL is required to download asset renditions.');
      }

      const candidateUrls = [
        `${baseUrl}${cleanPath}/_jcr_content/renditions/cq5dam.web.1280.1280.jpeg`,
        `${baseUrl}${cleanPath}/jcr:content/renditions/cq5dam.web.1280.1280.jpeg`,
        `${baseUrl}${cleanPath}/_jcr_content/renditions/cq5dam.thumbnail.319.319.png`,
        `${baseUrl}${cleanPath}/_jcr_content/renditions/original`
      ];

      for (const url of candidateUrls) {
        try {
          const res = await fetchAemWithFallback(url);
          if (res.ok) {
            const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
            if (contentType.includes('text/html')) {
              continue;
            }
            const arrayBuf = await res.arrayBuffer();
            const buf = Buffer.from(arrayBuf);
            if (!isHtmlPayload(buf) && buf.length > 0) {
              return buf;
            }
          }
        } catch (err) {
          // Try next rendition URL
        }
      }

      throw new Error(`Unable to fetch image rendition from AEM for ${cleanPath}`);
    },

    /**
     * Lists both child folders and image assets inside a DAM folder via the AEM Assets HTTP API.
     */
    async browseDamFolder(folderPath = '/content/dam') {
      const cleanFolder = normalizeDamPath(folderPath) || '/content/dam';
      if (!baseUrl || !fetchImpl) {
        return {
          folderPath: cleanFolder,
          folderTitle: cleanFolder.split('/').pop() || 'DAM',
          folders: [],
          assets: []
        };
      }

      const relFolder = toApiAssetsRelativePath(cleanFolder);
      const apiPath = relFolder ? `/api/assets/${relFolder}.json?limit=200` : '/api/assets.json?limit=200';
      const url = `${baseUrl}${apiPath}`;
      const data = await fetchAemJson(url);

      const entities = data.entities || [];
      const folders = [];
      const assets = [];

      for (const entity of entities) {
        const classes = entity.class || [];
        const name = entity.properties?.name || '';
        if (!name) continue;
        const title = entity.properties?.['dc:title'] || entity.properties?.title || name;
        const fullPath = `${cleanFolder.replace(/\/$/, '')}/${name}`;

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
          if (!mimeType || String(mimeType).startsWith('image/')) {
            assets.push({
              assetId: entity.properties?.['jcr:uuid'] || fullPath,
              assetPath: fullPath,
              assetTitle: Array.isArray(title) ? title[0] : title,
              mimeType: mimeType || 'image/jpeg',
              thumbnailUrl: `${baseUrl}${fullPath}/_jcr_content/renditions/cq5dam.thumbnail.319.319.png`
            });
          }
        }
      }

      return {
        folderPath: cleanFolder,
        folderTitle:
          data.properties?.['dc:title'] ||
          data.properties?.title ||
          cleanFolder.split('/').pop() ||
          'Assets',
        folders,
        assets
      };
    },

    /**
     * Lists image assets inside a DAM folder via the AEM Assets HTTP API.
     */
    async listFolderAssets(folderPath) {
      const browsed = await this.browseDamFolder(folderPath);
      return browsed.assets || [];
    },

    /**
     * Writes multi-value face metadata (`xdm:faceNames`, `xdm:faceGroupIds`, `xdm:faceCount`)
     * back to `jcr:content/metadata` on the AEM Asset.
     */
    async updateAssetFaceMetadata(
      assetPath,
      { faceNames = [], faceGroupIds = [], faceCount = 0, metadataProperty = 'xdm:faceNames' }
    ) {
      const cleanPath = normalizeDamPath(assetPath);
      if (!baseUrl || !fetchImpl) {
        return {
          updated: false,
          offline: true,
          assetPath: cleanPath,
          metadata: {
            [metadataProperty]: faceNames,
            'xdm:faceGroupIds': faceGroupIds,
            'xdm:faceCount': faceCount
          }
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

      const metadataUrl = `${baseUrl}${cleanPath}/jcr:content/metadata`;
      const slingRes = await fetchAemWithFallback(metadataUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData.toString()
      });

      if (!slingRes.ok) {
        const relPath = toApiAssetsRelativePath(cleanPath);
        await fetchAemWithFallback(`${baseUrl}/api/assets/${relPath}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            class: 'asset',
            properties: {
              metadata: {
                [metadataProperty]: faceNames,
                'xdm:faceGroupIds': faceGroupIds,
                'xdm:faceCount': faceCount
              }
            }
          })
        });
      }

      return {
        updated: true,
        assetPath: cleanPath,
        metadata: {
          [metadataProperty]: faceNames,
          'xdm:faceGroupIds': faceGroupIds,
          'xdm:faceCount': faceCount
        }
      };
    }
  };
}

module.exports = {
  createAemClient,
  normalizeAemHost,
  normalizeDamPath,
  toApiAssetsRelativePath
};
