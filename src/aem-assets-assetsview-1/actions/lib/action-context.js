/**
 * Builds the per-invocation security context for Runtime actions.
 * Never mutates process.env (warm containers are shared between invocations).
 */

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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-gw-ims-org-id',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
};

function corsHeaders(methods) {
  return { ...BASE_CORS_HEADERS, 'Access-Control-Allow-Methods': methods };
}

/**
 * @returns {{ aemHost: string, token: string, serviceCredentials: object|null,
 *             encryptionSecret: string, isWeb: boolean, maintenanceOpsEnabled: boolean }}
 */
function buildActionContext(params = {}) {
  const isWeb = isWebInvocation(params);
  const token = isWeb ? extractBearerToken(params) : '';

  // Defense in depth: the gateway validates IMS tokens when require-adobe-auth is enabled,
  // but never process an anonymous web request in Runtime.
  if (isWeb && isRuntimeEnvironment() && !token) {
    throw new PublicError('Authentication required.', 401);
  }

  const { aemHost, isConfiguredHost } = resolveAemHost(params);

  // Technical-account credentials are reserved for trusted (non-web) event invocations
  // against the deployment-configured AEM host.
  const serviceCredentials =
    !isWeb && isConfiguredHost && (params.AEM_SC_JSON || params.AEM_DEV_TOKEN)
      ? { scJson: params.AEM_SC_JSON || '', devToken: params.AEM_DEV_TOKEN || '' }
      : null;

  return {
    aemHost,
    token,
    serviceCredentials,
    encryptionSecret: params.ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET || '',
    isWeb,
    maintenanceOpsEnabled: isTruthyFlag(params.ENABLE_MAINTENANCE_OPS)
  };
}

module.exports = {
  corsHeaders,
  buildActionContext
};
