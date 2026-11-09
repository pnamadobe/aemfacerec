const { createStorage } = require('../lib/storage');
const { createRekognitionService } = require('../lib/rekognition');
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
  };

  if (params.__ow_method === 'options') {
    return { statusCode: 200, headers: corsHeaders, body: {} };
  }

  try {
    const encryptionSecret = params.ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET;
    const storage = await createStorage({ encryptionSecret });
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
      const updatedSettings = await storage.saveSettings(params.settings || params);

      // If includeUnnamedInMetadata or metadataProperty changed, re-sync all AEM assets automatically
      let resyncResult = null;
      if (
        previousSettings.includeUnnamedInMetadata !== updatedSettings.includeUnnamedInMetadata ||
        previousSettings.metadataProperty !== updatedSettings.metadataProperty
      ) {
        const token = extractBearerToken(params);
        const aemHost = params.aemHost || params.AEM_HOST || process.env.AEM_HOST;
        const faceService = await createFaceService({ aemHost, token, storage });
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
      // Allow testing unsaved form inputs or already stored credentials
      const stored = await storage.getSettings({ includeDecryptedSecret: true });
      const inputSettings = params.settings || {};

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
      const collectionStatus = await rekognition.ensureCollection();

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
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: {
        error: err.message || 'Settings operation failed.'
      }
    };
  }
}

exports.main = main;
