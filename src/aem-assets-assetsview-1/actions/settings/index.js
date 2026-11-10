const { createStorage } = require('../lib/storage');
const { createRekognitionService } = require('../lib/rekognition');
const { createFaceService } = require('../lib/face-service');
const { createAemClient } = require('../lib/aem');
const { corsHeaders: buildCors, buildActionContext } = require('../lib/action-context');
const { PublicError, errorResponse } = require('../lib/security');

function mergeProfileChoices(discoveredProfiles = [], currentName = 'Face Recognition') {
  const seen = new Set();
  const list = [];
  const add = (name, path = '') => {
    const clean = String(name || '').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({
      name: clean,
      path:
        path ||
        `/conf/global/settings/dam/processing/${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    });
  };
  for (const p of discoveredProfiles) {
    add(p?.name, p?.path);
  }
  add(currentName);
  add('Face Recognition');
  return list;
}

async function main(params = {}) {
  const corsHeaders = buildCors('GET, POST, OPTIONS');

  if (params.__ow_method === 'options') {
    return { statusCode: 200, headers: corsHeaders, body: {} };
  }

  try {
    const ctx = buildActionContext(params);
    const storage = await createStorage({ encryptionSecret: ctx.encryptionSecret });
    const aemClient = createAemClient({
      aemHost: ctx.aemHost,
      token: ctx.token,
      serviceCredentials: ctx.serviceCredentials
    });
    const operation = params.operation || 'getSettings';

    const settings = await storage.getSettings({ includeDecryptedSecret: false });
    const { isAdmin, isCurator, processingProfiles } = await aemClient.getAdminStatusAndProfiles({
      includeProfiles: true,
      curatorGroups: settings.curatorGroups
    });
    const canManageGroups = settings.restrictCuratorActionsToAdmins ? isCurator : true;

    if (operation === 'getSettings') {
      const profiles = mergeProfileChoices(processingProfiles, settings.processingProfileName);
      if (!isAdmin) {
        // Non-admin authors only receive non-sensitive display settings and role flags
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: {
            isAdmin: false,
            isCurator,
            canManageGroups,
            processingProfiles: profiles,
            settings: {
              metadataProperty: settings.metadataProperty,
              includeUnnamedInMetadata: settings.includeUnnamedInMetadata,
              processingProfileName: settings.processingProfileName,
              requireProcessingProfile: settings.requireProcessingProfile,
              restrictCuratorActionsToAdmins: settings.restrictCuratorActionsToAdmins,
              curatorGroups: settings.curatorGroups
            }
          }
        };
      }
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: {
          isAdmin: true,
          isCurator: true,
          canManageGroups: true,
          processingProfiles: profiles,
          settings
        }
      };
    }

    if (!isAdmin) {
      throw new PublicError(
        'Only AEM Administrators are permitted to view or modify BYOK AWS Rekognition settings.',
        403
      );
    }

    if (operation === 'saveSettings') {
      const previousSettings = await storage.getSettings({ includeDecryptedSecret: false });
      if (!params.settings || typeof params.settings !== 'object') {
        throw new PublicError('A settings object is required.');
      }
      const updatedSettings = await storage.saveSettings(params.settings);

      // If includeUnnamedInMetadata or metadataProperty changed, re-sync all AEM assets automatically
      let resyncResult = null;
      // R14: pass a 15s time budget so settings saves never exceed the 30s gateway timeout
      if (
        previousSettings.includeUnnamedInMetadata !== updatedSettings.includeUnnamedInMetadata ||
        previousSettings.metadataProperty !== updatedSettings.metadataProperty
      ) {
        const faceService = await createFaceService({
          aemHost: ctx.aemHost,
          token: ctx.token,
          serviceCredentials: ctx.serviceCredentials,
          storage
        });
        resyncResult = await faceService.resyncAllAssetsMetadata({
          timeBudgetMs: Math.min(Math.max(Number(params.timeBudgetMs) || 15000, 1000), 22000)
        });
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: {
          settings: updatedSettings,
          resyncedAssets: resyncResult?.syncedAssetCount ?? 0,
          hasMoreToSync: Boolean(resyncResult?.hasMoreToSync),
          nextSyncOffset: resyncResult?.nextSyncOffset ?? null,
          remainingAssetCount: resyncResult?.remainingAssetCount ?? 0
        }
      };
    }

    if (operation === 'testConnection') {
      // Save any provided credentials first so "Test Connection" also persists the keys
      const inputSettings = params.settings || {};
      if (inputSettings.awsAccessKeyId || inputSettings.awsSecretAccessKey) {
        await storage.saveSettings(inputSettings);
      }

      const stored = await storage.getSettings({ includeDecryptedSecret: true });

      const testConfig = {
        awsRegion: inputSettings.awsRegion || stored.awsRegion,
        awsAccessKeyId: inputSettings.awsAccessKeyId || stored.awsAccessKeyId,
        awsSecretAccessKey:
          inputSettings.awsSecretAccessKey &&
          !String(inputSettings.awsSecretAccessKey).startsWith('••••')
            ? inputSettings.awsSecretAccessKey
            : stored.awsSecretAccessKey,
        collectionId: inputSettings.collectionId || stored.collectionId
      };

      const rekognition = createRekognitionService(testConfig);
      let collectionStatus;
      try {
        collectionStatus = await rekognition.ensureCollection();
      } catch (awsErr) {
        if (awsErr.expose) throw awsErr;
        throw new PublicError(
          `Could not connect to AWS Rekognition (${awsErr.name || 'Error'}). Check the region and credentials.`,
          502
        );
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: {
          connected: true,
          ...collectionStatus
        }
      };
    }

    return {
      statusCode: 400,
      headers: corsHeaders,
      body: { error: `Unknown settings operation: ${operation}` }
    };
  } catch (err) {
    return errorResponse(err, corsHeaders, 'Settings operation failed.');
  }
}

exports.main = main;
