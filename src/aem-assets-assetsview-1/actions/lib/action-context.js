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
 *             encryptionSecret: string, isWeb: boolean, isIoEvent: boolean, maintenanceOpsEnabled: boolean }}
 */
function buildActionContext(params = {}) {
  const isWeb = isWebInvocation(params);
  const isIoEvent = isAdobeIoEventPayload(params);
  const token = isWeb ? extractBearerToken(params) : '';

  // Defense in depth: web requests must carry a user IMS Bearer token unless they are
  // an Adobe I/O Events webhook delivery (which is forced onto the strictly gated
  // `force=false` processing-profile path against the deployment-configured AEM host).
  if (isWeb && isRuntimeEnvironment() && !token && !isIoEvent) {
    throw new PublicError('Authentication required.', 401);
  }

  // I/O Events webhook deliveries can never override the deployment-configured AEM host
  const { aemHost, isConfiguredHost } = isIoEvent
    ? resolveAemHost({ AEM_HOST: params.AEM_HOST, AEM_AUTHOR_URL: params.AEM_AUTHOR_URL })
    : resolveAemHost(params);

  // Technical-account credentials are reserved for trusted event invocations
  // (non-web `ingest-event` or verified I/O Events webhook payloads) against the
  // deployment-configured AEM host when no user token is present.
  const serviceCredentials =
    (!isWeb || (isIoEvent && !token)) &&
    isConfiguredHost &&
    (params.AEM_SC_JSON || params.AEM_DEV_TOKEN)
      ? { scJson: params.AEM_SC_JSON || '', devToken: params.AEM_DEV_TOKEN || '' }
      : null;

  return {
    aemHost,
    token,
    serviceCredentials,
    encryptionSecret: params.ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET || '',
    isWeb,
    isIoEvent,
    maintenanceOpsEnabled: isTruthyFlag(params.ENABLE_MAINTENANCE_OPS)
  };
}

module.exports = {
  corsHeaders,
  buildActionContext,
  isAdobeIoEventPayload
};
