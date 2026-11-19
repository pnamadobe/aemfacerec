/**
 * Client for the pre-GA AEM Assets license API.
 *
 * Needs the signed-in user's IMS token: the Assets View token (client aem-assets-frontend-1)
 * carries the `aem.adobe.experimental` scope, a technical account does not.
 */
const { PublicError, assertDamPath } = require('./security');

// The experimental path expires on 2026-12-01; the GA path is tried second once it is served.
const API_PREFIXES = ['/adobe/experimental/licenses-expires-20261201', '/adobe'];
const BLOB_HOST_RE = /^https:\/\/[a-z0-9.-]+\.blob\.core\.windows\.net\//i;
const MAX_LICENSES = 200;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

function tokenClientId(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).client_id || '';
  } catch (e) {
    return '';
  }
}

function summarizeLicense(l = {}) {
  return {
    licenseId: l.licenseId,
    name: l.name || '',
    licensee: l.licensee || '',
    licenser: l.licenser || '',
    type: l.type || 'ORIGINAL',
    version: l.version ?? 0,
    confidence: l.confidence ?? null,
    restrictions: Array.isArray(l.restrictions) ? l.restrictions : [],
    windows: (Array.isArray(l.windows) ? l.windows : []).map((w) => ({
      channels: w.channels || [],
      regions: w.regions || [],
      effectiveAt: w.effectiveAt || null,
      expiresAt: w.expiresAt || null,
      perpetual: Boolean(w.perpetual)
    }))
  };
}

function createLicenseClient({ aemHost, token, orgId = '', fetchImpl = global.fetch } = {}) {
  if (!token) throw new PublicError('A signed-in user is required to use license suggestions.', 401);
  const base = String(aemHost || '').replace(/\/+$/, '');
  if (!/^https:\/\/author-p\d+-e\d+(-cmstg)?\.adobeaemcloud\.com$/i.test(base)) {
    throw new PublicError('A valid AEM author host is required.');
  }
  const headers = (extra = {}) => ({
    Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
    Accept: 'application/json',
    'x-api-key': tokenClientId(token.replace(/^Bearer /, '')),
    ...(orgId ? { 'x-gw-ims-org-id': orgId } : {}),
    ...extra
  });
  let prefixIndex = 0;

  /** Calls `path` under the experimental prefix, falling back to GA only on 404. */
  async function call(method, path, body) {
    let last;
    for (let i = prefixIndex; i < API_PREFIXES.length; i++) {
      const res = await fetchImpl(`${base}${API_PREFIXES[i]}${path}`, {
        method,
        redirect: 'manual',
        headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
      if (res.status === 404 && i < API_PREFIXES.length - 1) {
        last = res;
        continue;
      }
      prefixIndex = i;
      return res;
    }
    return last;
  }

  async function json(res, what) {
    if (res.status === 401 || res.status === 403) {
      throw new PublicError(`The signed-in user is not permitted to ${what}.`, 403);
    }
    if (!res.ok) throw new PublicError(`Could not ${what} (HTTP ${res.status}).`, 502);
    return res.json();
  }

  return {
    async listLicenses() {
      const out = [];
      let cursor = '';
      for (let page = 0; page < 10 && out.length < MAX_LICENSES; page++) {
        const q = `/assets/licenses?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const data = await json(await call('GET', q), 'list licenses');
        for (const item of data.items || []) {
          if (!item.supersededAt) out.push(summarizeLicense(item));
        }
        cursor = data.nextCursor || data.cursor || '';
        if (!cursor) break;
      }
      return out.slice(0, MAX_LICENSES);
    },

    /** Returns the short-lived pre-signed URL of the license's original PDF (Azure blob only). */
    async getLicenseDocumentUrl(licenseId) {
      const meta = await json(
        await call('GET', `/assets/licenses/${encodeURIComponent(licenseId)}/document`),
        'read the license document'
      );
      if (!meta.href || !BLOB_HOST_RE.test(meta.href)) {
        throw new PublicError('Unexpected license document location.', 502);
      }
      return meta.href;
    },

    /**
     * Returns one slice of the license PDF (base64) plus the total size. The browser cannot read
     * the storage URL directly (no CORS) and responses are size-limited, so the viewer pulls the
     * document in chunks through the action.
     */
    async getLicenseDocumentRange(licenseId, offset = 0, length = 512 * 1024) {
      const start = Math.max(0, Math.floor(Number(offset) || 0));
      const len = Math.min(768 * 1024, Math.max(1, Math.floor(Number(length) || 0)));
      const href = await this.getLicenseDocumentUrl(licenseId);
      const res = await fetchImpl(href, { headers: { Range: `bytes=${start}-${start + len - 1}` } });
      if (res.status !== 200 && res.status !== 206) {
        throw new PublicError(`Could not download the license document (HTTP ${res.status}).`, 502);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const contentRange = res.headers?.get?.('content-range') || '';
      let total = Number((contentRange.match(/\/(\d+)\s*$/) || [])[1]);
      let slice = buf;
      if (res.status === 200) {
        // Range ignored: the whole body came back
        total = buf.length;
        slice = buf.slice(start, start + len);
      }
      if (!Number.isFinite(total)) total = start + slice.length;
      if (total > MAX_PDF_BYTES) throw new PublicError('The license document is too large to display.');
      return { offset: start, length: slice.length, total, data: slice.toString('base64') };
    },

    /** Returns the license's original PDF as a Buffer. */
    async getLicenseDocument(licenseId) {
      const href = await this.getLicenseDocumentUrl(licenseId);
      const res = await fetchImpl(href);
      if (!res.ok) throw new PublicError(`Could not download the license document (HTTP ${res.status}).`, 502);
      const declared = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
        throw new PublicError('The license document is too large to analyze.');
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_PDF_BYTES) throw new PublicError('The license document is too large to analyze.');
      return buf;
    },

    /**
     * Reads which licenses are already assigned to an asset (`dam:licenseIds`) using the user's
     * token. Best effort: any failure just means "unknown", never an error for the caller.
     */
    async getAssignedLicenseIds(assetPath) {
      try {
        const path = assertDamPath(assetPath, 'asset path');
        const encoded = path.split('/').map(encodeURIComponent).join('/');
        const res = await fetchImpl(`${base}${encoded}/jcr:content/metadata.json`, {
          redirect: 'manual',
          headers: headers()
        });
        if (!res.ok) return [];
        const meta = await res.json();
        const ids = meta['dam:licenseIds'];
        return Array.isArray(ids) ? ids.map(String) : ids ? [String(ids)] : [];
      } catch (e) {
        return [];
      }
    },

    /** Assigns one license to DAM assets (appends to `dam:licenseIds`; idempotent). */
    async assignLicense(assetPaths, licenseId) {
      const paths = (assetPaths || []).map((p) => assertDamPath(p, 'asset path'));
      if (paths.length === 0 || paths.length > 10 || !licenseId) {
        throw new PublicError('Provide 1 to 10 asset paths and a licenseId.');
      }
      const res = await call('POST', '/assets/licenses/assign', {
        assignments: paths.map((id) => ({ target: { id, type: 'ASSET' }, licenseId }))
      });
      const data = await json(res, 'assign the license');
      return {
        state: data.data?.state || (res.status === 202 ? 'PROCESSING' : 'COMPLETED'),
        assignments: (data.data?.assignments || []).map((a) => ({
          assetPath: a.target?.id,
          status: a.status,
          licenseId: a.licenseId
        })),
        jobLocation: res.headers?.get?.('location') || null
      };
    }
  };
}

module.exports = { createLicenseClient, summarizeLicense, tokenClientId, API_PREFIXES };
