const { createFaceService } = require('../lib/face-service');

function extractBearerToken(params) {
  const headers = params.__ow_headers || {};
  const auth = headers.authorization || headers.Authorization || params.token || '';
  return auth.replace(/^Bearer\s+/i, '');
}

async function main(params = {}) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-gw-ims-org-id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  };

  if (params.__ow_method === 'options') {
    return { statusCode: 200, headers: corsHeaders, body: {} };
  }

  try {
    const token = extractBearerToken(params);
    const aemHost = params.aemHost || params.AEM_HOST || process.env.AEM_HOST;
    const faceService = await createFaceService({ aemHost, token });

    const operation = params.operation || 'listGroups';

    switch (operation) {
      case 'listGroups': {
        const result = await faceService.listGroups();
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'getAssetFaces': {
        const result = await faceService.getAssetFaces({
          assetId: params.assetId,
          assetPath: params.assetPath
        });
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'renameGroup': {
        if (!params.groupId) {
          return {
            statusCode: 400,
            headers: corsHeaders,
            body: { error: 'groupId is required to rename a group.' }
          };
        }
        const result = await faceService.renameGroup({
          groupId: params.groupId,
          name: params.name
        });
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'splitFaces': {
        const result = await faceService.splitFacesToNewGroup({
          faceIds: params.faceIds,
          newGroupName: params.newGroupName
        });
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'moveFaces': {
        const result = await faceService.moveFacesToGroup({
          faceIds: params.faceIds,
          targetGroupId: params.targetGroupId
        });
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'mergeGroups': {
        const result = await faceService.mergeGroups({
          sourceGroupIds: params.sourceGroupIds || [params.sourceGroupId],
          targetGroupId: params.targetGroupId
        });
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'resyncAllAssets': {
        const result = await faceService.resyncAllAssetsMetadata();
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'seedDemoData': {
        const result = await faceService.seedDemoData();
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      default:
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: { error: `Unsupported operation: ${operation}` }
        };
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: {
        error: err.message || 'Error processing face groups operation.'
      }
    };
  }
}

exports.main = main;
