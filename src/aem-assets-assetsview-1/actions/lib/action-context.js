/**
 * Builds the per-invocation security context for Runtime actions.
 * Never mutates process.env (warm containers are shared between invocations).
 */

const crypto = require('crypto');
const {
  PublicError,
  resolveAemHost,
  extractBearerToken,
  isWebInvocation,
  isRuntimeEnvironment,
  isTruthyFlag
} = require('./security');

const BASE_CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-gw-ims-org-id, x-facerec-skill-key',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
};

function corsHeaders(methods) {
  return { ...BASE_CORS_HEADERS, 'Access-Control-Allow-Methods': methods };
}

/**
 * Derives a deterministic 32-char HMAC skill key from the deployment's `ENCRYPTION_SECRET`
 * so the Adobe Coworker cloud sandbox skill can authenticate via `skillKey` / `x-facerec-skill-key`
 * without requiring local `.env` files or exposing unauthenticated endpoints.
 */
function deriveSkillKey(encryptionSecret) {
  if (!encryptionSecret || String(encryptionSecret).length < 16) return '';
  return crypto
    .createHmac('sha256', String(encryptionSecret))
    .update('facerec-coworker-skill-v1')
    .digest('hex')
    .slice(0, 32);
}

function isValidSkillKey(params = {}, encryptionSecret = '') {
  const expected = deriveSkillKey(encryptionSecret);
  if (!expected) return false;
  const headers = params.__ow_headers || {};
  const candidate = String(
    params.skillKey || headers['x-facerec-skill-key'] || headers['X-Facerec-Skill-Key'] || ''
  ).trim();
  if (candidate.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch (e) {
    return false;
  }
}

/**
 * True when the payload is an Adobe I/O Events webhook delivery (`aem.assets.asset.*`
 * CloudEvents / ActivityStreams envelope).
 */
function isAdobeIoEventPayload(params = {}) {
  const evt = params.event || params.data || params;
  if (!evt || typeof evt !== 'object') return false;
  return Boolean(
    evt['activitystreams:object'] ||
      params.event_id ||
      evt['@id'] ||
      (typeof evt.type === 'string' && evt.type.startsWith('aem.assets.'))
  );
}

/**
 * @returns {{ aemHost: string, token: string, serviceCredentials: object|null,
 *             encryptionSecret: string, isWeb: boolean, isIoEvent: boolean, isSkillAuth: boolean, maintenanceOpsEnabled: boolean }}
 */
function buildActionContext(params = {}) {
  const isWeb = isWebInvocation(params);
  const isIoEvent = isAdobeIoEventPayload(params);
  const token = isWeb ? extractBearerToken(params) : '';
  const encryptionSecret = params.ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET || '';
  const isSkillAuth = isWeb && isValidSkillKey(params, encryptionSecret);

  // Defense in depth: web requests must carry a user IMS Bearer token, a verified Coworker
  // skill key, or be an Adobe I/O Events webhook delivery.
  if (isWeb && isRuntimeEnvironment() && !token && !isIoEvent && !isSkillAuth) {
    throw new PublicError('Authentication required.', 401);
  }

  // I/O Events webhook deliveries and Coworker skill calls can never override the deployment-configured AEM host
  const { aemHost, isConfiguredHost } =
    isIoEvent || isSkillAuth
      ? resolveAemHost({ AEM_HOST: params.AEM_HOST, AEM_AUTHOR_URL: params.AEM_AUTHOR_URL })
      : resolveAemHost(params);

  // Technical-account credentials are reserved for trusted non-web invocations, verified
  // I/O Events webhooks, or verified Coworker skill requests against the configured AEM host.
  const serviceCredentials =
    (!isWeb || ((isIoEvent || isSkillAuth) && !token)) &&
    isConfiguredHost &&
    (params.AEM_SC_JSON || params.AEM_DEV_TOKEN)
      ? { scJson: params.AEM_SC_JSON || '', devToken: params.AEM_DEV_TOKEN || '' }
      : null;

  return {
    aemHost,
    token,
    serviceCredentials,
    encryptionSecret,
    isWeb,
    isIoEvent,
    isSkillAuth,
    maintenanceOpsEnabled: isTruthyFlag(params.ENABLE_MAINTENANCE_OPS)
  };
}

module.exports = {
  corsHeaders,
  buildActionContext,
  isAdobeIoEventPayload,
  deriveSkillKey
};
