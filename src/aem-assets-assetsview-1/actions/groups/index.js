const { createFaceService } = require('../lib/face-service');
const { createStorage } = require('../lib/storage');
const { createAemClient } = require('../lib/aem');
const { corsHeaders: buildCors, buildActionContext } = require('../lib/action-context');
const { PublicError, errorResponse } = require('../lib/security');

const MAINTENANCE_OPERATIONS = new Set([
  'seedDemoData',
  'clearAllData',
  'exportSnapshot',
  'importSnapshot'
]);

const CURATOR_MUTATION_OPERATIONS = new Set([
  'renameGroup',
  'splitFaces',
  'moveFaces',
  'mergeGroups',
  'deleteGroup',
  'resyncAllAssets'
]);

async function resolveCallerPermissions(aemClient, settings) {
  if (!settings.restrictCuratorActionsToAdmins) {
    return { canManageGroups: true };
  }
  const { isCurator } = await aemClient.getAdminStatusAndProfiles({
    includeProfiles: false,
    curatorGroups: settings.curatorGroups
  });
  return { canManageGroups: Boolean(isCurator) };
}

async function main(params = {}) {
  const corsHeaders = buildCors('GET, POST, OPTIONS');

  if (params.__ow_method === 'options') {
    return { statusCode: 200, headers: corsHeaders, body: {} };
  }

  try {
    const ctx = buildActionContext(params);
    const operation = params.operation || 'listGroups';

    if (MAINTENANCE_OPERATIONS.has(operation) && !ctx.maintenanceOpsEnabled) {
      throw new PublicError(`Operation '${operation}' is disabled in this deployment.`, 403);
    }

    const storage = await createStorage({ encryptionSecret: ctx.encryptionSecret });
    const aemClient = createAemClient({
      aemHost: ctx.aemHost,
      token: ctx.token,
      serviceCredentials: ctx.serviceCredentials
    });
    const faceService = await createFaceService({
      aemHost: ctx.aemHost,
      token: ctx.token,
      serviceCredentials: ctx.serviceCredentials,
      storage,
      aemClient
    });

    if (CURATOR_MUTATION_OPERATIONS.has(operation)) {
      const settings = await storage.getSettings({ includeDecryptedSecret: false });
      const { canManageGroups } = await resolveCallerPermissions(aemClient, settings);
      if (!canManageGroups) {
        throw new PublicError(
          `Only AEM Administrators or members of the configured Curator Groups (${(
            settings.curatorGroups || []
          ).join(', ')}) are permitted to name, merge, split, or delete face groups.`,
          403
        );
      }
    }

    switch (operation) {
      case 'listGroups': {
        const result = await faceService.listGroups({
          offset: params.offset,
          limit: params.limit,
          filter: params.filter,
          query: params.query
        });
        const settings = await storage.getSettings({ includeDecryptedSecret: false });
        const { canManageGroups } = await resolveCallerPermissions(aemClient, settings);
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: { ...result, canManageGroups }
        };
      }

      case 'listGroupOptions': {
        const result = await faceService.listGroupOptions({ query: params.query, limit: params.limit });
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'getGroup': {
        if (!params.groupId) {
          throw new PublicError('groupId is required.');
        }
        const result = await faceService.getGroup({
          groupId: params.groupId,
          faceOffset: params.faceOffset,
          faceLimit: params.faceLimit
        });
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'getAssetFaces': {
        const result = await faceService.getAssetFaces({
          assetId: params.assetId,
          assetPath: params.assetPath,
          assetName: params.assetName
        });
        const settings = await storage.getSettings({ includeDecryptedSecret: false });
        const { canManageGroups } = await resolveCallerPermissions(aemClient, settings);
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: { ...result, canManageGroups }
        };
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

      case 'deleteGroup': {
        if (!params.groupId) {
          throw new PublicError('groupId is required to delete a group.');
        }
        const result = await faceService.deleteGroup({
          groupId: params.groupId,
          timeBudgetMs: params.timeBudgetMs
        });
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'resyncAllAssets': {
        const result = await faceService.resyncAllAssetsMetadata({
          offset: params.offset,
          limit: params.limit,
          timeBudgetMs: params.timeBudgetMs
        });
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'seedDemoData': {
        const result = await faceService.seedDemoData();
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'clearAllData': {
        const result = await faceService.clearAllData();
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'recropAllAvatars': {
        const result = await faceService.recropAllAvatars();
        return { statusCode: 200, headers: corsHeaders, body: result };
      }

      case 'exportSnapshot': {
        const snapshot = await storage.exportRawSnapshot();
        return { statusCode: 200, headers: corsHeaders, body: snapshot };
      }

      case 'importSnapshot': {
        await storage.importRawSnapshot(params.snapshot || {});
        const result = await faceService.listGroups();
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
    return errorResponse(err, corsHeaders, 'Error processing face groups operation.');
  }
}

exports.main = main;
