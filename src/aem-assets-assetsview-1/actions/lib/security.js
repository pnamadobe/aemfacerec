/**
 * Shared request hardening helpers for the Runtime actions:
 * AEM host allowlisting, DAM path / metadata property validation,
 * encryption secret enforcement, and client-safe error responses.
 */

const crypto = require('crypto');

const DEFAULT_ALLOWED_HOST_PATTERN = /^https:\/\/author-p\d+-e\d+(-cmstg)?\.adobeaemcloud\.com$/i;
const METADATA_PROPERTY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}:[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const RESERVED_METADATA_NAMESPACES = ['jcr', 'sling', 'rep', 'cq', 'oak', 'nt', 'mix'];
const DAM_ROOT = '/content/dam';
const INSECURE_SECRETS = new Set([
  'default-aem-facerec-secret-key',
  'change-me-to-a-32-byte-secret-key!'
]);

/**
 * Error whose message is safe to return to the client.
 */
class PublicError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'PublicError';
    this.statusCode = statusCode;
    this.expose = true;
  }
}

function isRuntimeEnvironment() {
  return Boolean(process.env.__OW_NAMESPACE || process.env.__OW_ACTION_NAME);
}

function normalizeHost(host) {
  if (!host) return '';
  let clean = String(host).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(clean)) clean = `https://${clean}`;
  try {
    const u = new URL(clean);
    if (u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) {
      return '';
    }
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch (e) {
    return '';
  }
}

/**
 * True if `host` is an AEM author host we are willing to send tokens to.
 * `extraAllowed` is a comma-separated list of exact origins (AEM_ALLOWED_HOSTS).
 */
function isAllowedAemHost(host, extraAllowed = '') {
  const normalized = normalizeHost(host);
  if (!normalized || !normalized.startsWith('https://')) return false;
  const extras = String(extraAllowed || '')
    .split(',')
    .map((h) => normalizeHost(h))
    .filter(Boolean);
  return DEFAULT_ALLOWED_HOST_PATTERN.test(normalized) || extras.includes(normalized);
}

/**
 * Resolves the AEM host for a request.
 * - The deployment-configured host (AEM_AUTHOR_URL / AEM_HOST inputs) is always trusted.
 * - A caller-supplied host is only used if it passes the allowlist.
 * Returns { aemHost, isConfiguredHost }.
 */
function resolveAemHost(params = {}) {
  const configured = normalizeHost(params.AEM_AUTHOR_URL || params.AEM_HOST || '');
  const requested = normalizeHost(params.aemHost || params.aemAuthorUrl || '');

  if (requested && requested !== configured) {
    if (!isAllowedAemHost(requested, params.AEM_ALLOWED_HOSTS)) {
      throw new PublicError('The requested AEM host is not allowed.', 400);
    }
    return { aemHost: requested, isConfiguredHost: false };
  }
  return { aemHost: configured, isConfiguredHost: Boolean(configured) };
}

/**
 * Normalizes and validates a DAM path. Returns the clean path or throws PublicError.
 */
function assertDamPath(inputPath, label = 'path') {
  if (inputPath === undefined || inputPath === null || String(inputPath).trim() === '') {
    throw new PublicError(`A ${label} is required.`);
  }
  let clean = String(inputPath).trim();
  if (!clean.startsWith('/')) clean = `/${clean}`;
  clean = clean.replace(/\/+$/, '') || '/';

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(clean)) {
    throw new PublicError(`Invalid ${label}.`);
  }
  const segments = clean.split('/');
  if (segments.some((s, i) => i > 0 && (s === '' || s === '.' || s === '..'))) {
    throw new PublicError(`Invalid ${label}.`);
  }
  if (clean !== DAM_ROOT && !clean.startsWith(`${DAM_ROOT}/`)) {
    throw new PublicError(`The ${label} must be inside ${DAM_ROOT}.`);
  }
  return clean;
}

const SYSTEM_DAM_SEGMENT_RE = /^(?:_jcr_content|(?:jcr|cq|rep|oak|sling):)/i;

/**
 * True if a DAM path points inside an AEM Trash / soft-delete subtree (`.../jcr:content/cq:discarded/...`)
 * or a JCR system node (`jcr:content`, `_jcr_content`, `rep:policy`, etc.) rather than a live DAM asset/folder.
 */
function isDiscardedOrSystemDamPath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return false;
  const segments = inputPath.split('/').filter(Boolean);
  return segments.some((seg) => SYSTEM_DAM_SEGMENT_RE.test(seg));
}

function isValidDamPath(inputPath) {
  try {
    assertDamPath(inputPath);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Validates a metadata property name such as `xdm:faceNames`.
 * Rejects relative paths, Sling POST suffixes (@TypeHint, @Delete) and system namespaces.
 */
function isValidMetadataProperty(name) {
  if (typeof name !== 'string' || !METADATA_PROPERTY_PATTERN.test(name)) return false;
  const ns = name.split(':')[0].toLowerCase();
  return !RESERVED_METADATA_NAMESPACES.includes(ns);
}

/**
 * Returns the encryption secret, refusing missing/known-default secrets inside Runtime.
 */
function requireEncryptionSecret(secret) {
  const value = secret ? String(secret) : '';
  const weak = !value || INSECURE_SECRETS.has(value) || value.length < 16;
  if (weak) {
    if (isRuntimeEnvironment()) {
      throw new Error(
        'ENCRYPTION_SECRET is missing or insecure. Configure a random secret of at least 16 characters.'
      );
    }
    // Local development / tests only
    return value || 'local-dev-only-insecure-secret';
  }
  return value;
}

function isTruthyFlag(value) {
  return value === true || /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

/**
 * True when invoked as a web action (HTTP) rather than directly by I/O Events / Runtime triggers.
 */
function isWebInvocation(params = {}) {
  return Boolean(params.__ow_method || params.__ow_headers);
}

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

function extractBearerToken(params = {}) {
  const headers = params.__ow_headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  return String(auth).replace(/^Bearer\s+/i, '').trim();
}

/**
 * Extracts the IMS Org ID claim (`org` / `imsOrg` / `ims_org_id`) from a JWT Bearer token
 * if the token is a well-formed 3-part JWT. Returns '' for opaque tokens.
 */
function extractImsOrgFromJwt(bearerToken = '') {
  const raw = String(bearerToken || '').trim();
  if (!raw) return '';
  const parts = raw.split('.');
  if (parts.length !== 3) return '';
  try {
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    const org = payload?.org || payload?.imsOrg || payload?.ims_org_id || '';
    return typeof org === 'string' ? org.trim() : '';
  } catch (e) {
    return '';
  }
}

/**
 * Normalizes an IMS Org ID (e.g. `4A603BC061E191130A495FEF@AdobeOrg`) into a safe storage
 * partition slug (`4a603bc061e191130a495fef_adobeorg`).
 */
function sanitizeTenantId(imsOrgId = '') {
  const raw = String(imsOrgId || '').trim().toLowerCase();
  if (!raw) return '';
  const slug = raw
    .replace(/@/g, '_')
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 128);
  return TENANT_ID_PATTERN.test(slug) ? slug : '';
}

/**
 * Resolves and verifies the caller's tenant IMS Org ID (`S11`).
 * - Cross-checks the `x-gw-ims-org-id` header against the JWT `org` claim when both are present,
 *   rejecting any mismatch with 403 Forbidden so a tenant cannot spoof another org's header.
 * - Extracts `imsOrgId` from Adobe I/O Events envelopes when invoked via webhook.
 */
function resolveTenantOrg(params = {}, bearerToken = '') {
  const headers = params.__ow_headers || {};
  const headerOrg = String(
    headers['x-gw-ims-org-id'] || headers['X-GW-IMS-Org-Id'] || ''
  ).trim();
  const jwtOrg = extractImsOrgFromJwt(bearerToken);

  if (jwtOrg && headerOrg && jwtOrg.toLowerCase() !== headerOrg.toLowerCase()) {
    throw new PublicError(
      'IMS Organization header does not match authenticated token organization.',
      403
    );
  }

  const evt = params.event || params.data || {};
  const toObj = evt['activitystreams:to'] || params['activitystreams:to'] || {};
  const recipientObj = evt.recipient || params.recipient || {};
  const eventOrg = String(
    evt.imsOrgId ||
      evt['xdmEventEnvelope:imsOrgId'] ||
      toObj['xdmImsOrg:id'] ||
      toObj.imsOrgId ||
      recipientObj.imsOrgId ||
      params.imsOrgId ||
      params['xdmEventEnvelope:imsOrgId'] ||
      params.DEFAULT_IMS_ORG ||
      ''
  ).trim();

  const imsOrgId = jwtOrg || headerOrg || eventOrg || '';
  return {
    imsOrgId,
    tenantId: sanitizeTenantId(imsOrgId)
  };
}

/**
 * Converts an error into a client-safe HTTP response. Unexpected errors are logged
 * server-side and returned as a generic message with a correlation id.
 */
function errorResponse(err, headers, fallbackMessage = 'Request failed.') {
  if (err && err.expose) {
    return {
      statusCode: err.statusCode || 400,
      headers,
      body: { error: err.message }
    };
  }
  const ref = crypto.randomBytes(6).toString('hex');
  // eslint-disable-next-line no-console
  console.error(`[facerec] ref=${ref}`, err && err.stack ? err.stack : err);
  return {
    statusCode: 500,
    headers,
    body: { error: `${fallbackMessage} (ref: ${ref})` }
  };
}

module.exports = {
  PublicError,
  DAM_ROOT,
  isRuntimeEnvironment,
  normalizeHost,
  isAllowedAemHost,
  resolveAemHost,
  assertDamPath,
  isValidDamPath,
  isDiscardedOrSystemDamPath,
  isValidMetadataProperty,
  requireEncryptionSecret,
  isTruthyFlag,
  isWebInvocation,
  extractBearerToken,
  extractImsOrgFromJwt,
  sanitizeTenantId,
  resolveTenantOrg,
  errorResponse
};
