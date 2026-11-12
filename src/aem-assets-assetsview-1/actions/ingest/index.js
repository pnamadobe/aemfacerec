const { createFaceService } = require('../lib/face-service');
const { createStorage } = require('../lib/storage');
const { corsHeaders: buildCors, buildActionContext } = require('../lib/action-context');
const { PublicError, isRuntimeEnvironment, errorResponse } = require('../lib/security');

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Extracts assetPath and assetId from an Adobe I/O Events payload
 * (`aem.assets.asset.processing_completed` or `aem.assets.asset.created`).
 */
function extractAssetFromIoEvent(params) {
  const event = params.event || params.data || params;
  const obj = event['activitystreams:object'] || event.object || {};
  const repoMeta = event.repositoryMetadata || obj.repositoryMetadata || {};

  const assetPath =
    params.assetPath ||
    obj['xdmAsset:path'] ||
    repoMeta['repo:path'] ||
    event.path ||
    null;

  const assetId =
    params.assetId ||
    obj['xdmAsset:asset_id'] ||
    repoMeta['repo:id'] ||
    event.assetId ||
    null;

  const format =
    params.mimeType ||
    obj['xdmAsset:format'] ||
    obj['dc:format'] ||
    repoMeta['dc:format'] ||
    event.format ||
    null;

  const eventId =
    params.event_id ||
    event.id ||
    event['@id'] ||
    event.event_id ||
    obj['repo:etag'] ||
    repoMeta['repo:etag'] ||
    null;

  return {
    assetPath,
    assetId,
    mimeType: format ? String(format) : null,
    eventId: eventId ? String(eventId) : null
  };
}

/**
 * Parses an optional boolean parameter that may arrive as a boolean or a string.
 */
function parseFlag(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

async function main(params = {}) {
  const corsHeaders = buildCors('GET, POST, OPTIONS');

  if (params.__ow_method === 'options') {
    return { statusCode: 200, headers: corsHeaders, body: {} };
  }

  // Adobe I/O Events Webhook Challenge verification
  if (params.challenge && CHALLENGE_PATTERN.test(String(params.challenge))) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: { challenge: params.challenge }
    };
  }

  try {
    const ctx = buildActionContext(params);
    const storage = await createStorage({
      encryptionSecret: ctx.encryptionSecret,
      tenantId: ctx.tenantId
    });
    const faceService = await createFaceService({
      aemHost: ctx.aemHost,
      token: ctx.token,
      serviceCredentials: ctx.serviceCredentials,
      storage
    });

    const operation = params.operation || 'ingestAsset';

    if (operation === 'browseFolder' || operation === 'scanFolder') {
      if (ctx.isWeb && isRuntimeEnvironment() && !ctx.token && !ctx.isSkillAuth) {
        throw new PublicError('Authentication required.', 401);
      }
    }

    if (operation === 'browseFolder') {
      const result = await faceService.browseFolder({
        folderPath: params.folderPath || '/content/dam'
      });
      return { statusCode: 200, headers: corsHeaders, body: result };
    }

    if (operation === 'scanFolder') {
      if (!params.folderPath) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: { error: 'folderPath is required for scanFolder operation.' }
        };
      }
      const result = await faceService.scanFolder({
        folderPath: params.folderPath,
        assets: Array.isArray(params.assets) ? params.assets : null,
        offset: params.offset,
        limit: params.limit,
        timeBudgetMs: Math.min(Math.max(Number(params.timeBudgetMs) || 20000, 1000), 25000),
        force: parseFlag(params.force, true),
        // Folder scans skip already-scanned images unless explicitly asked to re-scan
        rescan: parseFlag(params.rescan, false)
      });
      return { statusCode: 200, headers: corsHeaders, body: result };
    }

    const { assetPath, assetId, mimeType, eventId } = extractAssetFromIoEvent(params);
    if (!assetPath) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: { error: 'assetPath is required to ingest an asset.' }
      };
    }

    // If invoked directly from the UI ("Scan / Re-scan Asset") with a user token, force=true
    // bypasses the folder check. Unauthenticated I/O Event webhooks are ALWAYS force=false so
    // they strictly require the Face Recognition Processing Profile on the folder.
    const isManualTrigger =
      Boolean(ctx.token || ctx.isSkillAuth || !ctx.isWeb) && parseFlag(params.force, false);

    // R10: I/O Event idempotency — skip duplicate/retry deliveries of the same event
    if (!isManualTrigger && eventId) {
      const idempotencyKey = `${eventId}:${assetId || assetPath}`;
      const claimed = await storage.claimEventIdempotencyKey(idempotencyKey);
      if (!claimed) {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: {
            skipped: true,
            assetPath,
            reasonCode: 'duplicate-event',
            reason: `Duplicate event '${eventId}' already processed.`
          }
        };
      }
    }
    const result = await faceService.ingestAsset({
      assetPath,
      assetId,
      assetTitle: params.assetTitle,
      mimeType,
      force: isManualTrigger,
      // Uploads (events) and the side panel's Re-scan always analyze; bulk actions pass rescan=false
      rescan: parseFlag(params.rescan, true)
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: result
    };
  } catch (err) {
    return errorResponse(err, corsHeaders, 'Failed to ingest asset for facial recognition.');
  }
}

exports.main = main;
