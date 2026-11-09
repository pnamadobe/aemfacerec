const { createFaceService } = require('../lib/face-service');

function extractBearerToken(params) {
  const headers = params.__ow_headers || {};
  const auth = headers.authorization || headers.Authorization || params.token || '';
  return auth.replace(/^Bearer\s+/i, '');
}

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

  return { assetPath, assetId };
}

async function main(params = {}) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-gw-ims-org-id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (params.__ow_method === 'options') {
    return { statusCode: 200, headers: corsHeaders, body: {} };
  }

  // Adobe I/O Events Webhook Challenge verification
  if (params.challenge) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: { challenge: params.challenge }
    };
  }

  try {
    const token = extractBearerToken(params);
    const aemHost = params.aemHost || params.AEM_HOST || process.env.AEM_HOST;
    const faceService = await createFaceService({ aemHost, token });

    const operation = params.operation || 'ingestAsset';

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
        force: params.force !== undefined ? Boolean(params.force) : true
      });
      return { statusCode: 200, headers: corsHeaders, body: result };
    }

    const { assetPath, assetId } = extractAssetFromIoEvent(params);
    if (!assetPath) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: { error: 'assetPath is required to ingest an asset.' }
      };
    }

    // If invoked directly from the UI ("Scan / Re-scan Asset"), force=true bypasses folder check
    const isManualTrigger = Boolean(params.force);
    const result = await faceService.ingestAsset({
      assetPath,
      assetId,
      assetTitle: params.assetTitle,
      force: isManualTrigger
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: result
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: {
        error: err.message || 'Failed to ingest asset for facial recognition.'
      }
    };
  }
}

exports.main = main;
