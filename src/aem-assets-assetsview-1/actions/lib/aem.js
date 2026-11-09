/**
 * AEM as a Cloud Service Assets Client
 *
 * Handles:
 * 1. Checking if an asset's folder has the Face Recognition Processing Profile applied
 *    or matches the enabled folders list.
 * 2. Fetching the asset's 1280x1280 web rendition buffer for AWS Rekognition & avatar cropping.
 * 3. Listing image assets in a DAM folder for batch scanning.
 * 4. Writing multi-value face group names (`xdm:faceNames`) and group IDs (`xdm:faceGroupIds`)
 *    back to `jcr:content/metadata` on the AEM asset.
 */

function normalizeAemHost(aemHost) {
  if (!aemHost) return '';
  let clean = String(aemHost).trim().replace(/\/+$/, '');
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = `https://${clean}`;
  }
  return clean;
}

function normalizeDamPath(assetPath) {
  if (!assetPath) return '';
  let clean = String(assetPath).trim();
  if (!clean.startsWith('/')) clean = `/${clean}`;
  return clean;
}

function toApiAssetsRelativePath(assetPath) {
  const clean = normalizeDamPath(assetPath);
  return clean.replace(/^\/content\/dam\/?/, '');
}

/**
 * Creates an AEM client bound to an author host and IMS bearer token.
 */
function createAemClient({ aemHost, token, fetchImpl = global.fetch } = {}) {
  const baseUrl = normalizeAemHost(aemHost || process.env.AEM_HOST);

  function authHeaders(extra = {}) {
    const headers = { ...extra };
    if (token) {
      headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }
    return headers;
  }

  return {
    /**
     * Checks whether an asset's folder is eligible for Face Recognition:
     * 1. Checks if the folder (or an ancestor folder up to /content/dam) has
     *    `dam:processingProfile` matching `settings.processingProfileName`
     *    or `jcr:content/metadata/faceRecognitionEnabled == true`.
     * 2. Or, if `requireProcessingProfile` is false, checks if `assetPath` starts with
     *    one of `settings.enabledFolders`.
     */
    async checkFolderEligibility(assetPath, settings) {
      const cleanPath = normalizeDamPath(assetPath);
      const enabledFolders = Array.isArray(settings.enabledFolders)
        ? settings.enabledFolders
        : ['/content/dam'];

      const matchesFolderPrefix = enabledFolders.some((prefix) =>
        cleanPath.startsWith(normalizeDamPath(prefix))
      );

      if (!settings.requireProcessingProfile) {
        return {
          eligible: matchesFolderPrefix,
          reason: matchesFolderPrefix
            ? 'Asset path matches enabled DAM folder prefix'
            : 'Asset path is outside enabled DAM folders'
        };
      }

      // If no live AEM host is configured (e.g. local/offline test), fall back to folder prefix check
      if (!baseUrl || !fetchImpl) {
        return {
          eligible: matchesFolderPrefix,
          reason: 'Matched enabled folder prefix (offline mode)'
        };
      }

      // Walk up folder hierarchy from asset's parent folder up to /content/dam
      const segments = cleanPath.split('/').filter(Boolean);
      // Remove the asset filename itself
      segments.pop();

      const targetProfile = (settings.processingProfileName || 'Face Recognition').toLowerCase();

      while (segments.length >= 2 && segments[0] === 'content' && segments[1] === 'dam') {
        const folderPath = `/${segments.join('/')}`;
        try {
          const url = `${baseUrl}${folderPath}/jcr:content.1.json`;
          const res = await fetchImpl(url, { headers: authHeaders() });
          if (res.ok) {
            const jcrContent = await res.json();
            const assignedProfile = String(
              jcrContent['dam:processingProfile'] ||
                jcrContent.processingProfile ||
                jcrContent.metadata?.['dam:processingProfile'] ||
                ''
            ).toLowerCase();

            const explicitFlag =
              jcrContent.faceRecognitionEnabled === true ||
              jcrContent.metadata?.faceRecognitionEnabled === true ||
              jcrContent.metadata?.['xdm:faceRecognitionEnabled'] === 'true';

            if (explicitFlag || (assignedProfile && assignedProfile.includes(targetProfile))) {
              return {
                eligible: true,
                reason: `Folder ${folderPath} has Processing Profile '${assignedProfile || targetProfile}' enabled`
              };
            }
          }
        } catch (err) {
          // Continue walking up ancestor folders
        }
        segments.pop();
      }

      // Also honor explicit folder prefix allowlist if configured for a specific subfolder
      const specificFolderConfigured = enabledFolders.some(
        (prefix) =>
          normalizeDamPath(prefix) !== '/content/dam' &&
          cleanPath.startsWith(normalizeDamPath(prefix))
      );

      if (specificFolderConfigured) {
        return {
          eligible: true,
          reason: 'Asset is inside an explicitly enabled DAM subfolder'
        };
      }

      return {
        eligible: false,
        reason: `No '${settings.processingProfileName}' processing profile found on ancestor folders of ${cleanPath}`
      };
    },

    /**
     * Fetches basic asset info (assetId / jcr:uuid, title, mimeType) from AEM.
     */
    async getAssetInfo(assetPath) {
      const cleanPath = normalizeDamPath(assetPath);
      const fallbackTitle = cleanPath.split('/').pop() || 'asset.jpg';

      if (!baseUrl || !fetchImpl) {
        return {
          assetId: `urn:aaid:aem:${Buffer.from(cleanPath).toString('hex').slice(0, 24)}`,
          assetPath: cleanPath,
          assetTitle: fallbackTitle
        };
      }

      const relPath = toApiAssetsRelativePath(cleanPath);
      try {
        const res = await fetchImpl(`${baseUrl}/api/assets/${relPath}.json`, {
          headers: authHeaders()
        });
        if (res.ok) {
          const data = await res.json();
          const uuid =
            data.properties?.['jcr:uuid'] ||
            data['jcr:uuid'] ||
            `urn:aaid:aem:${Buffer.from(cleanPath).toString('hex').slice(0, 24)}`;
          const title =
            data.properties?.['dc:title'] ||
            data.properties?.name ||
            fallbackTitle;
          return {
            assetId: uuid,
            assetPath: cleanPath,
            assetTitle: Array.isArray(title) ? title[0] : title
          };
        }
      } catch (err) {
        // Fallback if API call fails
      }

      return {
        assetId: `urn:aaid:aem:${Buffer.from(cleanPath).toString('hex').slice(0, 24)}`,
        assetPath: cleanPath,
        assetTitle: fallbackTitle
      };
    },

    /**
     * Downloads the 1280x1280 JPEG web rendition (or fallback rendition) of an AEM asset as a Buffer.
     */
    async fetchAssetRenditionBuffer(assetPath) {
      const cleanPath = normalizeDamPath(assetPath);
      if (!baseUrl || !fetchImpl) {
        throw new Error('AEM host URL is required to download asset renditions.');
      }

      const candidateUrls = [
        `${baseUrl}${cleanPath}/_jcr_content/renditions/cq5dam.web.1280.1280.jpeg`,
        `${baseUrl}${cleanPath}/jcr:content/renditions/cq5dam.web.1280.1280.jpeg`,
        `${baseUrl}${cleanPath}/_jcr_content/renditions/cq5dam.thumbnail.319.319.png`,
        `${baseUrl}${cleanPath}/_jcr_content/renditions/original`
      ];

      for (const url of candidateUrls) {
        try {
          const res = await fetchImpl(url, { headers: authHeaders() });
          if (res.ok) {
            const arrayBuf = await res.arrayBuffer();
            return Buffer.from(arrayBuf);
          }
        } catch (err) {
          // Try next rendition URL
        }
      }

      throw new Error(`Unable to fetch image rendition from AEM for ${cleanPath}`);
    },

    /**
     * Lists image assets inside a DAM folder via the AEM Assets HTTP API.
     */
    async listFolderAssets(folderPath) {
      const cleanFolder = normalizeDamPath(folderPath);
      if (!baseUrl || !fetchImpl) return [];

      const relFolder = toApiAssetsRelativePath(cleanFolder);
      const url = `${baseUrl}/api/assets/${relFolder}.json?limit=200`;
      const res = await fetchImpl(url, { headers: authHeaders() });
      if (!res.ok) {
        throw new Error(`Failed to list folder ${cleanFolder} from AEM (HTTP ${res.status})`);
      }

      const data = await res.json();
      const entities = data.entities || [];
      const assets = [];

      for (const entity of entities) {
        const isAsset = (entity.class || []).includes('assets/asset');
        const mimeType =
          entity.properties?.metadata?.['dc:format'] ||
          entity.properties?.['dc:format'] ||
          '';
        if (isAsset && (!mimeType || String(mimeType).startsWith('image/'))) {
          const name = entity.properties?.name || '';
          const fullPath = `${cleanFolder.replace(/\/$/, '')}/${name}`;
          assets.push({
            assetId: entity.properties?.['jcr:uuid'] || fullPath,
            assetPath: fullPath,
            assetTitle: entity.properties?.title || name
          });
        }
      }

      return assets;
    },

    /**
     * Writes multi-value face metadata (`xdm:faceNames`, `xdm:faceGroupIds`, `xdm:faceCount`)
     * back to `jcr:content/metadata` on the AEM Asset.
     *
     * Uses both the AEM Assets HTTP API (`PUT /api/assets/<path>`) and Sling POST `@TypeHint=String[]`
     * so single-person and multi-person arrays are always stored as `String[]` on `jcr:content/metadata`.
     */
    async updateAssetFaceMetadata(assetPath, { faceNames = [], faceGroupIds = [], faceCount = 0, metadataProperty = 'xdm:faceNames' }) {
      const cleanPath = normalizeDamPath(assetPath);
      if (!baseUrl || !fetchImpl) {
        return {
          updated: false,
          offline: true,
          assetPath: cleanPath,
          metadata: {
            [metadataProperty]: faceNames,
            'xdm:faceGroupIds': faceGroupIds,
            'xdm:faceCount': faceCount
          }
        };
      }

      // 1. Update via Sling POST to jcr:content/metadata with explicit String[] @TypeHint
      const formData = new URLSearchParams();
      formData.append(`${metadataProperty}@TypeHint`, 'String[]');
      if (faceNames.length === 0) {
        formData.append(`${metadataProperty}@Delete`, 'true');
      } else {
        for (const name of faceNames) {
          formData.append(metadataProperty, name);
        }
      }

      formData.append('xdm:faceGroupIds@TypeHint', 'String[]');
      if (faceGroupIds.length === 0) {
        formData.append('xdm:faceGroupIds@Delete', 'true');
      } else {
        for (const groupId of faceGroupIds) {
          formData.append('xdm:faceGroupIds', groupId);
        }
      }

      formData.append('xdm:faceCount', String(faceCount));
      formData.append('xdm:faceCount@TypeHint', 'Long');

      const metadataUrl = `${baseUrl}${cleanPath}/jcr:content/metadata`;
      const slingRes = await fetchImpl(metadataUrl, {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/x-www-form-urlencoded'
        }),
        body: formData.toString()
      });

      if (!slingRes.ok) {
        // Fallback to AEM Assets HTTP API PUT /api/assets/<relPath>
        const relPath = toApiAssetsRelativePath(cleanPath);
        await fetchImpl(`${baseUrl}/api/assets/${relPath}`, {
          method: 'PUT',
          headers: authHeaders({
            'Content-Type': 'application/json'
          }),
          body: JSON.stringify({
            class: 'asset',
            properties: {
              metadata: {
                [metadataProperty]: faceNames,
                'xdm:faceGroupIds': faceGroupIds,
                'xdm:faceCount': faceCount
              }
            }
          })
        });
      }

      return {
        updated: true,
        assetPath: cleanPath,
        metadata: {
          [metadataProperty]: faceNames,
          'xdm:faceGroupIds': faceGroupIds,
          'xdm:faceCount': faceCount
        }
      };
    }
  };
}

module.exports = {
  createAemClient,
  normalizeAemHost,
  normalizeDamPath,
  toApiAssetsRelativePath
};
