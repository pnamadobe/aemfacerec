const { createStorage } = require('../lib/storage');
const { createRekognitionService } = require('../lib/rekognition');
const { createFaceService } = require('../lib/face-service');
const { corsHeaders: buildCors, buildActionContext } = require('../lib/action-context');
const { PublicError, errorResponse } = require('../lib/security');

async function main(params = {}) {
  const corsHeaders = buildCors('GET, POST, OPTIONS');

  if (params.__ow_method === 'options') {
    return { statusCode: 200, headers: corsHeaders, body: {} };
  }

  try {
    const ctx = buildActionContext(params);
    const storage = await createStorage({ encryptionSecret: ctx.encryptionSecret });
    const operation = params.operation || 'getSettings';

    if (operation === 'getSettings') {
      const settings = await storage.getSettings({ includeDecryptedSecret: false });
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: { settings }
      };
    }

    if (operation === 'saveSettings') {
      const previousSettings = await storage.getSettings({ includeDecryptedSecret: false });
      if (!params.settings || typeof params.settings !== 'object') {
        throw new PublicError('A settings object is required.');
      }
      const updatedSettings = await storage.saveSettings(params.settings);

      // If includeUnnamedInMetadata or metadataProperty changed, re-sync all AEM assets automatically
      let resyncResult = null;
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
        resyncResult = await faceService.resyncAllAssetsMetadata();
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: {
          settings: updatedSettings,
          resyncedAssets: resyncResult?.syncedAssetCount ?? 0
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
