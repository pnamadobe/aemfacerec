const crypto = require('crypto');
const { createStorage } = require('./storage');
const { createRekognitionService } = require('./rekognition');
const { createAemClient, normalizeDamPath } = require('./aem');
const { PublicError, assertDamPath } = require('./security');
const { mapWithConcurrency } = require('./retry');

const AEM_WRITE_CONCURRENCY = 4;
const {
  AVATAR_SIZE,
  cropFaceAvatar,
  decodeImageBuffer,
  cropAndResizeRgbaToJpeg
} = require('./cropper');

function generateGroupId() {
  // 128 bits: collisions would silently merge two people's groups
  return `grp_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Computes the resolved display name for a group based on settings.
 */
function getGroupEffectiveMetadataName(group, settings) {
  if (!group) return null;
  if (group.name && String(group.name).trim() !== '') {
    return String(group.name).trim();
  }
  if (settings.includeUnnamedInMetadata) {
    return group.autoLabel || group.groupId;
  }
  return null;
}

/**
 * Pure helper that computes the exact metadata payload (`xdm:faceNames`, `xdm:faceGroupIds`, `xdm:faceCount`)
 * for a given asset from the current faces and groups state.
 */
function computeAssetFaceMetadata(assetRecord, faces, groups, settings) {
  const faceIds = (assetRecord?.faceIds || []).filter((id) => Boolean(faces[id]));
  const resolvedGroups = faceIds
    .map((id) => groups[faces[id]?.groupId])
    .filter(Boolean);

  const faceNames = Array.from(
    new Set(
      resolvedGroups
        .map((g) => getGroupEffectiveMetadataName(g, settings))
        .filter(Boolean)
    )
  );

  const faceGroupIds = Array.from(
    new Set(resolvedGroups.map((g) => g.groupId).filter(Boolean))
  );

  const metadataProperty = settings.metadataProperty || 'xdm:faceNames';

  return {
    metadataProperty,
    faceNames,
    faceGroupIds,
    faceCount: faceIds.length
  };
}

/**
 * Creates the Face Recognition & Grouping domain service.
 */
async function createFaceService({
  aemHost,
  token,
  serviceCredentials = null,
  encryptionSecret,
  storage: customStorage,
  rekognitionClient: customRekognitionClient,
  aemClient: customAemClient,
  retryOptions = {}
} = {}) {
  const storage = customStorage || (await createStorage({ encryptionSecret }));
  const aemClient =
    customAemClient || createAemClient({ aemHost, token, serviceCredentials });

  async function getRekognition() {
    const settings = await storage.getSettings({ includeDecryptedSecret: true });
    return {
      settings,
      rekognition: createRekognitionService(settings, customRekognitionClient, retryOptions)
    };
  }

  /**
   * Enriches a raw face record with its group details for UI responses.
   */
  function enrichFace(face, groups) {
    if (!face) return null;
    const group = groups[face.groupId] || null;
    return {
      ...face,
      groupName: group?.name || null,
      groupAutoLabel: group?.autoLabel || 'Unassigned',
      groupDisplayName: group?.name || group?.autoLabel || 'Unassigned',
      groupFaceCount: group?.faceIds?.length || 1
    };
  }

  /**
   * Enriches a group record with its member faces and cover avatar data URL.
   */
  function enrichGroup(group, faces) {
    if (!group) return null;
    const memberFaces = (group.faceIds || [])
      .map((id) => faces[id])
      .filter(Boolean);
    const uniqueAssets = new Set(memberFaces.map((f) => f.assetId).filter(Boolean));
    const coverFace =
      faces[group.coverFaceId] || memberFaces[0] || null;

    return {
      ...group,
      displayName: group.name || group.autoLabel || group.groupId,
      isNamed: Boolean(group.name && group.name.trim()),
      faceCount: memberFaces.length,
      assetCount: uniqueAssets.size,
      coverAvatarDataUrl: coverFace?.avatarDataUrl || null,
      faces: memberFaces
    };
  }

  /**
   * Recomputes and writes AEM metadata for a set of assetIds.
   *
   * Writes run with bounded concurrency, and a failure on one asset never aborts the batch:
   * callers always persist their database changes and report failures to the user.
   * Returns { synced, failed }.
   */
  async function syncAssetsToAem(assetIds, db, settings) {
    const uniqueAssetIds = Array.from(new Set(assetIds.filter(Boolean)));
    const synced = [];
    const failed = [];

    await mapWithConcurrency(uniqueAssetIds, AEM_WRITE_CONCURRENCY, async (assetId) => {
      const assetRecord = db.assets[assetId];
      if (!assetRecord) return;

      const computed = computeAssetFaceMetadata(assetRecord, db.faces, db.groups, settings);

      assetRecord.faceNames = computed.faceNames;
      assetRecord.faceGroupIds = computed.faceGroupIds;
      assetRecord.faceCount = computed.faceCount;
      assetRecord.updatedAt = new Date().toISOString();

      if (!assetRecord.assetPath) return;
      try {
        const syncRes = await aemClient.updateAssetFaceMetadata(assetRecord.assetPath, computed);
        assetRecord.metadataSyncError = null;
        synced.push(syncRes);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[facerec] metadata sync failed for ${assetRecord.assetPath}:`, err.message);
        const message = err.expose ? err.message : 'AEM metadata update failed.';
        assetRecord.metadataSyncError = message;
        failed.push({ assetPath: assetRecord.assetPath, error: message });
      }
    });

    return { synced, failed };
  }

  function syncSummary({ synced, failed }) {
    return {
      syncedAssetCount: synced.length,
      syncedAssets: synced,
      failedAssetCount: failed.length,
      failedAssets: failed
    };
  }

  /**
   * Best-effort removal of faces that were indexed in Rekognition but never recorded,
   * so failed ingests don't leave orphaned biometric data behind.
   */
  async function discardIndexedFaces(faceIds, rekognition) {
    if (!faceIds.length) return;
    try {
      await rekognition.deleteFaces(faceIds);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[facerec] failed to discard orphaned faces:', e.message);
    }
    await Promise.all(faceIds.map((id) => storage.deleteAvatar(id).catch(() => {})));
  }

  /**
   * Removes faces previously indexed for an asset (used before re-scanning).
   *
   * All Rekognition calls run first and are idempotent; the in-memory db is only changed
   * once they have all succeeded, so a failure leaves the db untouched and safe to retry.
   */
  async function removeExistingAssetFaces(assetId, db, rekognition) {
    const existingAsset = db.assets[assetId];
    if (!existingAsset || !Array.isArray(existingAsset.faceIds) || existingAsset.faceIds.length === 0) {
      return;
    }

    const oldFaceIds = [...existingAsset.faceIds];
    const byGroup = {};
    for (const fId of oldFaceIds) {
      const face = db.faces[fId];
      if (face && face.groupId) {
        byGroup[face.groupId] = byGroup[face.groupId] || [];
        byGroup[face.groupId].push(fId);
      }
    }

    // 1. Rekognition (no db changes yet)
    const emptiedGroupIds = [];
    for (const [groupId, fIds] of Object.entries(byGroup)) {
      await rekognition.disassociateFaces(groupId, fIds);
      const grp = db.groups[groupId];
      if (grp && (grp.faceIds || []).every((id) => fIds.includes(id))) {
        await rekognition.deleteGroup(groupId);
        emptiedGroupIds.push(groupId);
      }
    }
    await rekognition.deleteFaces(oldFaceIds);

    // 2. Db
    for (const [groupId, fIds] of Object.entries(byGroup)) {
      const grp = db.groups[groupId];
      if (!grp) continue;
      if (emptiedGroupIds.includes(groupId)) {
        delete db.groups[groupId];
        continue;
      }
      const removed = new Set(fIds);
      grp.faceIds = (grp.faceIds || []).filter((id) => !removed.has(id));
      if (removed.has(grp.coverFaceId)) {
        grp.coverFaceId = grp.faceIds[0];
      }
    }
    for (const fId of oldFaceIds) {
      delete db.faces[fId];
    }
    existingAsset.faceIds = [];

    // 3. Avatars (best effort)
    await Promise.all(oldFaceIds.map((id) => storage.deleteAvatar(id).catch(() => {})));
  }

  /**
   * Core single-asset ingestion routine that operates on an already-loaded `db`, `settings`,
   * and `rekognition` instance so batch/folder operations only read and write storage once.
   *
   * Failure handling:
   * - Before the old faces are removed, any failure discards the newly indexed faces and
   *   leaves `db` untouched.
   * - After that point the error is thrown with `dbMutated = true`; `db` is kept consistent
   *   with Rekognition (faces applied so far are recorded) and the caller must save it.
   * - AEM metadata write failures do not fail the ingest; they are reported on the result.
   */
  async function ingestSingleAssetInMemory({
    assetPath,
    assetId,
    assetTitle,
    imageBuffer,
    force = false,
    db,
    settings,
    rekognition,
    collectionEnsured = false
  }) {
    let cleanPath = assetPath ? assertDamPath(assetPath, 'asset path') : '';
    if (!cleanPath && assetId) {
      const resolvedFromUuid = await aemClient.resolvePathByAssetUuid(assetId);
      if (resolvedFromUuid) {
        cleanPath = normalizeDamPath(resolvedFromUuid);
      }
    }

    if (!force && cleanPath) {
      const eligibility = await aemClient.checkFolderEligibility(cleanPath, settings);
      if (!eligibility.eligible) {
        return {
          skipped: true,
          assetPath: cleanPath,
          reason: eligibility.reason
        };
      }
    }

    const info =
      assetId && cleanPath
        ? {
            assetId,
            assetPath: cleanPath,
            assetTitle: assetTitle || cleanPath.split('/').pop()
          }
        : await aemClient.getAssetInfo(cleanPath);

    const resolvedAssetId = info.assetId;
    const resolvedPath = info.assetPath;
    const resolvedTitle = info.assetTitle;

    const buffer = imageBuffer || (await aemClient.fetchAssetRenditionBuffer(resolvedPath));

    // Phase 1: detect, match and crop. Nothing in `db` changes in this phase.
    const detectedFaces = await rekognition.indexAssetFaces(buffer, resolvedAssetId, {
      skipEnsureCollection: collectionEnsured
    });
    const indexedFaceIds = detectedFaces.map((f) => f.faceId);

    const prepared = [];
    try {
      let decodedImage = buffer;
      if (detectedFaces.length > 0) {
        try {
          decodedImage = decodeImageBuffer(buffer);
        } catch (e) {
          decodedImage = buffer;
        }
      }

      for (const detected of detectedFaces) {
        const avatar = await cropFaceAvatar(decodedImage, detected.boundingBox);
        const [avatarFile, match] = await Promise.all([
          storage.saveAvatar(detected.faceId, avatar.buffer),
          rekognition.findMatchingGroup(detected.faceId, db.faces, db.groups)
        ]);
        prepared.push({ ...detected, avatar, avatarFile, match });
      }

      // Re-scan: drop this asset's previous faces (Rekognition first, then db)
      await removeExistingAssetFaces(resolvedAssetId, db, rekognition);
    } catch (err) {
      await discardIndexedFaces(indexedFaceIds, rekognition);
      throw err;
    }

    // Phase 2: apply. From here on `db` is modified, so errors carry dbMutated = true.
    const now = new Date().toISOString();
    const newFaceIds = [];
    let applyError = null;

    for (const face of prepared) {
      const { faceId, confidence, boundingBox, avatar, avatarFile, match } = face;
      try {
        let assignedGroupId;
        let matchConfidence = null;

        if (match && db.groups[match.groupId]) {
          assignedGroupId = match.groupId;
          matchConfidence = match.matchConfidence;
          await rekognition.associateFaces(assignedGroupId, [faceId]);
          const grp = db.groups[assignedGroupId];
          if (!grp.faceIds.includes(faceId)) grp.faceIds.push(faceId);
          grp.updatedAt = now;
        } else {
          assignedGroupId = generateGroupId();
          await rekognition.createGroup(assignedGroupId, [faceId]);
          const personNumber = db.counters.nextPersonNumber || 1;
          db.counters.nextPersonNumber = personNumber + 1;
          db.groups[assignedGroupId] = {
            groupId: assignedGroupId,
            name: null,
            autoLabel: `Person #${personNumber}`,
            coverFaceId: faceId,
            faceIds: [faceId],
            createdAt: now,
            updatedAt: now
          };
        }

        db.faces[faceId] = {
          faceId,
          groupId: assignedGroupId,
          assetId: resolvedAssetId,
          assetPath: resolvedPath,
          assetTitle: resolvedTitle,
          boundingBox,
          confidence,
          matchConfidence,
          avatarFile,
          avatarDataUrl: avatar.dataUrl,
          createdAt: now
        };
        newFaceIds.push(faceId);
      } catch (err) {
        applyError = err;
        break;
      }
    }

    const assetRecord = {
      assetId: resolvedAssetId,
      assetPath: resolvedPath,
      assetTitle: resolvedTitle,
      faceIds: newFaceIds,
      scannedAt: now,
      updatedAt: now
    };
    if (applyError) assetRecord.incomplete = true;
    db.assets[resolvedAssetId] = assetRecord;

    if (applyError) {
      const unapplied = indexedFaceIds.filter((id) => !newFaceIds.includes(id));
      await discardIndexedFaces(unapplied, rekognition);
      await syncAssetsToAem([resolvedAssetId], db, settings);
      applyError.dbMutated = true;
      throw applyError;
    }

    const sync = await syncAssetsToAem([resolvedAssetId], db, settings);

    const computed = computeAssetFaceMetadata(assetRecord, db.faces, db.groups, settings);
    const enrichedFaces = newFaceIds.map((id) => enrichFace(db.faces[id], db.groups)).filter(Boolean);

    return {
      ...assetRecord,
      scanned: true,
      faceCount: computed.faceCount,
      faceNames: computed.faceNames,
      faceGroupIds: computed.faceGroupIds,
      metadataProperty: computed.metadataProperty,
      includeUnnamedInMetadata: settings.includeUnnamedInMetadata,
      metadataSynced: sync.failed.length === 0,
      metadataSyncError: sync.failed[0]?.error || null,
      faces: enrichedFaces
    };
  }

  return {
    /**
     * Ingests a single AEM asset: checks folder processing profile eligibility,
     * downloads web rendition, indexes faces in AWS Rekognition, crops avatars,
     * auto-matches or creates face groups, and writes `xdm:faceNames` back to AEM.
     */
    async ingestAsset({ assetPath, assetId, assetTitle, imageBuffer, force = false }) {
      const [{ settings, rekognition }, db] = await Promise.all([
        getRekognition(),
        storage.getDatabase()
      ]);

      let result;
      try {
        result = await ingestSingleAssetInMemory({
          assetPath,
          assetId,
          assetTitle,
          imageBuffer,
          force,
          db,
          settings,
          rekognition,
          collectionEnsured: false
        });
      } catch (err) {
        // Partial progress is already reflected in Rekognition; persist it so they stay in sync
        if (err.dbMutated) await storage.saveDatabase(db);
        throw err;
      }

      if (!result.skipped) {
        await storage.saveDatabase(db);
      }

      return result;
    },

    /**
     * Browses child subfolders and image assets inside a DAM folder for the visual folder/asset picker.
     */
    async browseFolder({ folderPath = '/content/dam' }) {
      const [browsed, db] = await Promise.all([
        aemClient.browseDamFolder(folderPath),
        storage.getDatabase()
      ]);

      const indexedByPath = {};
      for (const rec of Object.values(db.assets || {})) {
        if (rec.assetPath) indexedByPath[rec.assetPath] = rec;
      }

      const enrichedAssets = (browsed.assets || []).map((a) => {
        const indexed = db.assets[a.assetId] || indexedByPath[a.assetPath] || null;
        return {
          ...a,
          scanned: Boolean(indexed),
          faceCount: indexed?.faceIds?.length || 0,
          faceNames: indexed?.faceNames || []
        };
      });

      return {
        ...browsed,
        assets: enrichedAssets
      };
    },

    /**
     * Scans image assets in a DAM folder (or an explicit batch slice of folder assets).
     * Loads and saves the database once per batch and enforces a time budget (default 20s)
     * so requests through Adobe I/O Runtime / CloudFront (`*.adobeio-static.net`) never hit
     * a 30-second HTTP 504 Gateway Timeout.
     */
    async scanFolder({
      folderPath,
      assets: explicitAssets = null,
      offset = 0,
      limit = 0,
      force = true,
      timeBudgetMs = 20000
    }) {
      const startTime = Date.now();
      folderPath = assertDamPath(folderPath, 'folder path');
      if (Array.isArray(explicitAssets)) {
        if (explicitAssets.length > 50) {
          throw new PublicError('A scan batch may contain at most 50 assets.');
        }
        explicitAssets.forEach((a) => assertDamPath(a && a.assetPath, 'asset path'));
      }
      const [allAssets, { settings, rekognition }, db] = await Promise.all([
        Array.isArray(explicitAssets)
          ? Promise.resolve(explicitAssets)
          : aemClient.listFolderAssets(folderPath),
        getRekognition(),
        storage.getDatabase()
      ]);

      let collectionEnsured = false;
      if (allAssets.length > 0) {
        try {
          await rekognition.ensureCollection();
          collectionEnsured = true;
        } catch (e) {
          collectionEnsured = false;
        }
      }

      const startIdx = Math.max(0, Number(offset) || 0);
      const maxItems = Number(limit) > 0 ? Number(limit) : allAssets.length;
      const targetSlice = allAssets.slice(startIdx, startIdx + maxItems);

      const results = [];
      let dirty = false;
      let stoppedForTimeBudget = false;

      for (let i = 0; i < targetSlice.length; i++) {
        if (i > 0 && timeBudgetMs > 0 && Date.now() - startTime >= timeBudgetMs) {
          stoppedForTimeBudget = true;
          break;
        }
        const item = targetSlice[i];
        try {
          const res = await ingestSingleAssetInMemory({
            assetPath: item.assetPath,
            assetId: item.assetId,
            assetTitle: item.assetTitle,
            force,
            db,
            settings,
            rekognition,
            collectionEnsured
          });
          if (!res.skipped) {
            dirty = true;
          }
          results.push({
            assetPath: item.assetPath,
            status: res.skipped ? 'skipped' : 'processed',
            faceCount: res.faces?.length || 0,
            ...(res.metadataSyncError ? { warning: res.metadataSyncError } : {})
          });
        } catch (err) {
          if (err.dbMutated) dirty = true;
          // eslint-disable-next-line no-console
          console.error(`[facerec] scan failed for ${item.assetPath}:`, err.message);
          results.push({
            assetPath: item.assetPath,
            status: 'error',
            error: err.expose ? err.message : 'Face analysis failed for this asset.'
          });
        }
      }

      if (dirty) {
        await storage.saveDatabase(db);
      }

      const nextOffset = startIdx + results.length;
      const hasMore = stoppedForTimeBudget || nextOffset < allAssets.length;

      return {
        folderPath: normalizeDamPath(folderPath),
        totalAssets: allAssets.length,
        processedCount: results.length,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        results
      };
    },

    /**
     * Retrieves all detected faces and metadata for a specific AEM asset (by assetId, assetPath, or assetName).
     */
    async getAssetFaces({ assetId, assetPath, assetName }) {
      const [db, settings] = await Promise.all([
        storage.getDatabase(),
        storage.getSettings()
      ]);

      const rawUuid = assetId ? String(assetId).replace(/^urn:aaid:aem:/i, '').trim() : '';
      let decodedPath = '';
      if (assetPath) {
        try {
          decodedPath = normalizeDamPath(decodeURIComponent(assetPath));
        } catch (e) {
          decodedPath = normalizeDamPath(assetPath);
        }
      }

      const allAssets = Object.values(db.assets || {});
      let assetRecord =
        (assetId && db.assets[assetId]) ||
        (rawUuid && db.assets[rawUuid]) ||
        (rawUuid && allAssets.find((a) => a.uuid === rawUuid || a.assetId === rawUuid || a.assetId === `urn:aaid:aem:${rawUuid}`)) ||
        null;

      if (!assetRecord && decodedPath) {
        assetRecord =
          allAssets.find((a) => {
            try {
              return normalizeDamPath(decodeURIComponent(a.assetPath || '')) === decodedPath;
            } catch (e) {
              return a.assetPath === decodedPath;
            }
          }) || null;
      }

      if (!assetRecord && assetName) {
        const cleanName = String(assetName).trim();
        assetRecord =
          allAssets.find(
            (a) => a.assetTitle === cleanName || (a.assetPath && a.assetPath.endsWith(`/${cleanName}`))
          ) || null;
      }

      // If AEM Assets View only passed `urn:aaid:aem:<uuid>`, resolve the DAM path via AEM QueryBuilder
      if (!assetRecord && rawUuid) {
        const resolvedPath = await aemClient.resolvePathByAssetUuid(rawUuid);
        if (resolvedPath) {
          decodedPath = normalizeDamPath(resolvedPath);
          assetRecord =
            allAssets.find((a) => a.assetPath === decodedPath) || null;
          if (assetRecord) {
            assetRecord.uuid = rawUuid;
            await storage.saveDatabase(db);
          }
        }
      }

      if (!assetRecord) {
        return {
          assetId: assetId || null,
          assetPath: decodedPath || null,
          scanned: false,
          faceCount: 0,
          faceNames: [],
          faceGroupIds: [],
          metadataProperty: settings.metadataProperty,
          faces: []
        };
      }

      const computed = computeAssetFaceMetadata(assetRecord, db.faces, db.groups, settings);
      const enrichedFaces = (assetRecord.faceIds || [])
        .map((id) => enrichFace(db.faces[id], db.groups))
        .filter(Boolean);

      return {
        ...assetRecord,
        scanned: true,
        faceCount: computed.faceCount,
        faceNames: computed.faceNames,
        faceGroupIds: computed.faceGroupIds,
        metadataProperty: computed.metadataProperty,
        includeUnnamedInMetadata: settings.includeUnnamedInMetadata,
        faces: enrichedFaces
      };
    },

    /**
     * Lists all Face Groups (Named and Unnamed) for the Admin Console and group pickers.
     */
    async listGroups() {
      const [db, settings] = await Promise.all([
        storage.getDatabase(),
        storage.getSettings()
      ]);

      const groupsList = Object.values(db.groups)
        .map((g) => enrichGroup(g, db.faces))
        .filter(Boolean)
        .sort((a, b) => {
          if (a.isNamed !== b.isNamed) return a.isNamed ? -1 : 1;
          return b.faceCount - a.faceCount;
        });

      return {
        groups: groupsList,
        totalGroups: groupsList.length,
        totalFaces: Object.keys(db.faces).length,
        totalAssets: Object.keys(db.assets).length,
        settings: {
          metadataProperty: settings.metadataProperty,
          includeUnnamedInMetadata: settings.includeUnnamedInMetadata
        }
      };
    },

    /**
     * Names or renames a Face Group and immediately updates `xdm:faceNames` on all assets
     * containing any face in this group.
     */
    async renameGroup({ groupId, name }) {
      const [db, settings] = await Promise.all([
        storage.getDatabase(),
        storage.getSettings()
      ]);

      const group = db.groups[groupId];
      if (!group) {
        throw new PublicError(`Face Group '${groupId}' not found.`, 404);
      }

      const cleanName = typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
      if (cleanName && cleanName.length > 200) {
        throw new PublicError('Group names must be 200 characters or fewer.');
      }
      group.name = cleanName;
      group.updatedAt = new Date().toISOString();

      const affectedAssetIds = (group.faceIds || [])
        .map((fId) => db.faces[fId]?.assetId)
        .filter(Boolean);

      const sync = await syncAssetsToAem(affectedAssetIds, db, settings);
      await storage.saveDatabase(db);

      return {
        group: enrichGroup(group, db.faces),
        ...syncSummary(sync)
      };
    },

    /**
     * Splits one or more faces out of their current group into a brand new standalone group.
     * Updates AWS Rekognition User associations and recomputes `xdm:faceNames` on affected assets.
     */
    async splitFacesToNewGroup({ faceIds = [], newGroupName = null }) {
      if (!Array.isArray(faceIds) || faceIds.length === 0) {
        throw new PublicError('At least one faceId must be provided to split into a new group.');
      }

      const { settings, rekognition } = await getRekognition();
      const db = await storage.getDatabase();
      const now = new Date().toISOString();

      const validFaceIds = faceIds.filter((fId) => Boolean(db.faces[fId]));
      if (validFaceIds.length === 0) {
        throw new PublicError('None of the specified faceIds exist.', 404);
      }

      // Group faces by their current groupId so we can disassociate them cleanly
      const byOldGroup = {};
      const affectedAssetIds = [];

      for (const fId of validFaceIds) {
        const face = db.faces[fId];
        affectedAssetIds.push(face.assetId);
        if (face.groupId) {
          byOldGroup[face.groupId] = byOldGroup[face.groupId] || [];
          byOldGroup[face.groupId].push(fId);
        }
      }

      for (const [oldGroupId, fIds] of Object.entries(byOldGroup)) {
        await rekognition.disassociateFaces(oldGroupId, fIds);
        const oldGroup = db.groups[oldGroupId];
        if (oldGroup) {
          oldGroup.faceIds = (oldGroup.faceIds || []).filter((id) => !fIds.includes(id));
          oldGroup.updatedAt = now;
          if (oldGroup.faceIds.length === 0) {
            delete db.groups[oldGroupId];
            await rekognition.deleteGroup(oldGroupId);
          } else if (fIds.includes(oldGroup.coverFaceId)) {
            oldGroup.coverFaceId = oldGroup.faceIds[0];
          }
        }
      }

      const newGroupId = generateGroupId();
      const personNumber = db.counters.nextPersonNumber || 1;
      db.counters.nextPersonNumber = personNumber + 1;

      await rekognition.createGroup(newGroupId, validFaceIds);

      const cleanNewName =
        typeof newGroupName === 'string' && newGroupName.trim() !== ''
          ? newGroupName.trim()
          : null;

      db.groups[newGroupId] = {
        groupId: newGroupId,
        name: cleanNewName,
        autoLabel: `Person #${personNumber}`,
        coverFaceId: validFaceIds[0],
        faceIds: validFaceIds,
        createdAt: now,
        updatedAt: now
      };

      for (const fId of validFaceIds) {
        db.faces[fId].groupId = newGroupId;
      }

      const sync = await syncAssetsToAem(affectedAssetIds, db, settings);
      await storage.saveDatabase(db);

      return {
        newGroup: enrichGroup(db.groups[newGroupId], db.faces),
        ...syncSummary(sync)
      };
    },

    /**
     * Moves one or more faces from their current group(s) into an existing target group.
     * Supports combining an individual face into another group.
     */
    async moveFacesToGroup({ faceIds = [], targetGroupId }) {
      if (!Array.isArray(faceIds) || faceIds.length === 0) {
        throw new PublicError('At least one faceId is required.');
      }

      const { settings, rekognition } = await getRekognition();
      const db = await storage.getDatabase();
      const now = new Date().toISOString();

      const targetGroup = db.groups[targetGroupId];
      if (!targetGroup) {
        throw new PublicError(`Target Face Group '${targetGroupId}' not found.`, 404);
      }

      const facesToMove = faceIds.filter(
        (fId) => db.faces[fId] && db.faces[fId].groupId !== targetGroupId
      );

      if (facesToMove.length === 0) {
        return {
          targetGroup: enrichGroup(targetGroup, db.faces),
          ...syncSummary({ synced: [], failed: [] })
        };
      }

      const bySourceGroup = {};
      const affectedAssetIds = [];

      for (const fId of facesToMove) {
        const face = db.faces[fId];
        affectedAssetIds.push(face.assetId);
        if (face.groupId) {
          bySourceGroup[face.groupId] = bySourceGroup[face.groupId] || [];
          bySourceGroup[face.groupId].push(fId);
        }
      }

      for (const [sourceGroupId, fIds] of Object.entries(bySourceGroup)) {
        await rekognition.disassociateFaces(sourceGroupId, fIds);
        const sourceGroup = db.groups[sourceGroupId];
        if (sourceGroup) {
          sourceGroup.faceIds = (sourceGroup.faceIds || []).filter((id) => !fIds.includes(id));
          sourceGroup.updatedAt = now;
          if (sourceGroup.faceIds.length === 0) {
            delete db.groups[sourceGroupId];
            await rekognition.deleteGroup(sourceGroupId);
          } else if (fIds.includes(sourceGroup.coverFaceId)) {
            sourceGroup.coverFaceId = sourceGroup.faceIds[0];
          }
        }
      }

      await rekognition.associateFaces(targetGroupId, facesToMove);

      for (const fId of facesToMove) {
        if (!targetGroup.faceIds.includes(fId)) {
          targetGroup.faceIds.push(fId);
        }
        db.faces[fId].groupId = targetGroupId;
      }
      targetGroup.updatedAt = now;

      const sync = await syncAssetsToAem(affectedAssetIds, db, settings);
      await storage.saveDatabase(db);

      return {
        targetGroup: enrichGroup(targetGroup, db.faces),
        ...syncSummary(sync)
      };
    },

    /**
     * Combines / merges one or more source Face Groups into a target Face Group.
     * Disassociates faces from the source groups in AWS Rekognition, associates them
     * with targetGroupId, deletes the source groups, and updates `xdm:faceNames` on all affected assets.
     */
    async mergeGroups({ sourceGroupIds = [], targetGroupId }) {
      const sources = (Array.isArray(sourceGroupIds) ? sourceGroupIds : [sourceGroupIds]).filter(
        (id) => id && id !== targetGroupId
      );

      if (!targetGroupId || sources.length === 0) {
        throw new PublicError('A targetGroupId and at least one distinct sourceGroupId are required.');
      }

      const { settings, rekognition } = await getRekognition();
      const db = await storage.getDatabase();
      const now = new Date().toISOString();

      const targetGroup = db.groups[targetGroupId];
      if (!targetGroup) {
        throw new PublicError(`Target Face Group '${targetGroupId}' not found.`, 404);
      }

      const allMovedFaceIds = [];
      const affectedAssetIds = [];

      for (const srcId of sources) {
        const srcGroup = db.groups[srcId];
        if (!srcGroup) continue;

        const srcFaces = [...(srcGroup.faceIds || [])];
        if (srcFaces.length > 0) {
          await rekognition.disassociateFaces(srcId, srcFaces);
          allMovedFaceIds.push(...srcFaces);
          for (const fId of srcFaces) {
            if (db.faces[fId]) {
              db.faces[fId].groupId = targetGroupId;
              affectedAssetIds.push(db.faces[fId].assetId);
            }
          }
        }

        // If targetGroup is unnamed and source group had a name, inherit the source group's name
        if (!targetGroup.name && srcGroup.name) {
          targetGroup.name = srcGroup.name;
        }

        delete db.groups[srcId];
        await rekognition.deleteGroup(srcId);
      }

      if (allMovedFaceIds.length > 0) {
        await rekognition.associateFaces(targetGroupId, allMovedFaceIds);
        for (const fId of allMovedFaceIds) {
          if (!targetGroup.faceIds.includes(fId)) {
            targetGroup.faceIds.push(fId);
          }
        }
      }

      targetGroup.updatedAt = now;

      // Also include targetGroup's existing assets in case targetGroup inherited a name
      for (const fId of targetGroup.faceIds) {
        if (db.faces[fId]?.assetId) {
          affectedAssetIds.push(db.faces[fId].assetId);
        }
      }

      const sync = await syncAssetsToAem(affectedAssetIds, db, settings);
      await storage.saveDatabase(db);

      return {
        targetGroup: enrichGroup(targetGroup, db.faces),
        mergedGroupIds: sources,
        movedFaceCount: allMovedFaceIds.length,
        ...syncSummary(sync)
      };
    },

    /**
     * Re-computes and syncs `xdm:faceNames` on all indexed AEM assets
     * (e.g. after toggling `includeUnnamedInMetadata` in Settings).
     */
    async resyncAllAssetsMetadata() {
      const [db, settings] = await Promise.all([
        storage.getDatabase(),
        storage.getSettings()
      ]);

      const allAssetIds = Object.keys(db.assets);
      const sync = await syncAssetsToAem(allAssetIds, db, settings);
      await storage.saveDatabase(db);

      return {
        ...syncSummary(sync)
      };
    },

    /**
     * Seeds realistic sample assets, face groups, and SVG portrait avatars for instant demo/testing
     * before live AWS credentials or AEM assets are connected.
     */
    async seedDemoData() {
      const [db, settings] = await Promise.all([
        storage.getDatabase(),
        storage.getSettings()
      ]);

      const now = new Date().toISOString();

      function makePortraitSvg(bg, hair, skin, label) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
          <rect width="160" height="160" rx="20" fill="${bg}"/>
          <circle cx="80" cy="58" r="34" fill="${hair}"/>
          <circle cx="80" cy="66" r="26" fill="${skin}"/>
          <circle cx="71" cy="63" r="3" fill="#1f2937"/>
          <circle cx="89" cy="63" r="3" fill="#1f2937"/>
          <path d="M72 75 Q80 82 88 75" stroke="#1f2937" stroke-width="2.5" fill="none" stroke-linecap="round"/>
          <path d="M36 146 C36 108 124 108 124 146" fill="${hair}"/>
          <rect x="14" y="128" width="132" height="22" rx="8" fill="rgba(0,0,0,0.45)"/>
          <text x="80" y="143" font-family="sans-serif" font-size="11" font-weight="bold" fill="#ffffff" text-anchor="middle">${label}</text>
        </svg>`;
        return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
      }

      const demoGroups = {
        grp_sarah01: {
          groupId: 'grp_sarah01',
          name: 'Sarah Jenkins',
          autoLabel: 'Person #1',
          coverFaceId: 'face-sarah-1',
          faceIds: ['face-sarah-1', 'face-sarah-2'],
          createdAt: now,
          updatedAt: now
        },
        grp_marcus02: {
          groupId: 'grp_marcus02',
          name: 'Marcus Vance',
          autoLabel: 'Person #2',
          coverFaceId: 'face-marcus-1',
          faceIds: ['face-marcus-1', 'face-marcus-2'],
          createdAt: now,
          updatedAt: now
        },
        grp_unnamed03: {
          groupId: 'grp_unnamed03',
          name: null,
          autoLabel: 'Person #3',
          coverFaceId: 'face-p3-1',
          faceIds: ['face-p3-1', 'face-p3-2'],
          createdAt: now,
          updatedAt: now
        },
        grp_unnamed04: {
          groupId: 'grp_unnamed04',
          name: null,
          autoLabel: 'Person #4',
          coverFaceId: 'face-p4-1',
          faceIds: ['face-p4-1'],
          createdAt: now,
          updatedAt: now
        }
      };

      const demoFaces = {
        'face-sarah-1': {
          faceId: 'face-sarah-1',
          groupId: 'grp_sarah01',
          assetId: 'urn:aaid:aem:demo-keynote-panel',
          assetPath: '/content/dam/events/2026-summit/keynote-panel.jpg',
          assetTitle: 'keynote-panel.jpg',
          boundingBox: { left: 0.14, top: 0.22, width: 0.14, height: 0.22 },
          confidence: 99.92,
          matchConfidence: 98.4,
          avatarDataUrl: makePortraitSvg('#1e3a8a', '#451a03', '#f3d2b3', 'Sarah (1)'),
          createdAt: now
        },
        'face-marcus-1': {
          faceId: 'face-marcus-1',
          groupId: 'grp_marcus02',
          assetId: 'urn:aaid:aem:demo-keynote-panel',
          assetPath: '/content/dam/events/2026-summit/keynote-panel.jpg',
          assetTitle: 'keynote-panel.jpg',
          boundingBox: { left: 0.44, top: 0.20, width: 0.15, height: 0.23 },
          confidence: 99.87,
          matchConfidence: 96.1,
          avatarDataUrl: makePortraitSvg('#065f46', '#111827', '#c68642', 'Marcus (1)'),
          createdAt: now
        },
        'face-p3-1': {
          faceId: 'face-p3-1',
          groupId: 'grp_unnamed03',
          assetId: 'urn:aaid:aem:demo-keynote-panel',
          assetPath: '/content/dam/events/2026-summit/keynote-panel.jpg',
          assetTitle: 'keynote-panel.jpg',
          boundingBox: { left: 0.72, top: 0.24, width: 0.13, height: 0.21 },
          confidence: 99.54,
          matchConfidence: null,
          avatarDataUrl: makePortraitSvg('#5b21b6', '#9a3412', '#f7dec4', 'Person #3 (1)'),
          createdAt: now
        },
        'face-sarah-2': {
          faceId: 'face-sarah-2',
          groupId: 'grp_sarah01',
          assetId: 'urn:aaid:aem:demo-backstage-chat',
          assetPath: '/content/dam/events/2026-summit/backstage-chat.jpg',
          assetTitle: 'backstage-chat.jpg',
          boundingBox: { left: 0.25, top: 0.18, width: 0.18, height: 0.26 },
          confidence: 99.95,
          matchConfidence: 97.8,
          avatarDataUrl: makePortraitSvg('#1d4ed8', '#451a03', '#f3d2b3', 'Sarah (2)'),
          createdAt: now
        },
        'face-p3-2': {
          faceId: 'face-p3-2',
          groupId: 'grp_unnamed03',
          assetId: 'urn:aaid:aem:demo-backstage-chat',
          assetPath: '/content/dam/events/2026-summit/backstage-chat.jpg',
          assetTitle: 'backstage-chat.jpg',
          boundingBox: { left: 0.61, top: 0.21, width: 0.17, height: 0.25 },
          confidence: 98.91,
          matchConfidence: 88.2,
          avatarDataUrl: makePortraitSvg('#6d28d9', '#78350f', '#e0ac69', 'Misgrouped?'),
          createdAt: now
        },
        'face-marcus-2': {
          faceId: 'face-marcus-2',
          groupId: 'grp_marcus02',
          assetId: 'urn:aaid:aem:demo-executive-portrait',
          assetPath: '/content/dam/events/2026-summit/executive-portrait.jpg',
          assetTitle: 'executive-portrait.jpg',
          boundingBox: { left: 0.36, top: 0.16, width: 0.26, height: 0.36 },
          confidence: 99.98,
          matchConfidence: 99.1,
          avatarDataUrl: makePortraitSvg('#047857', '#111827', '#c68642', 'Marcus (2)'),
          createdAt: now
        },
        'face-p4-1': {
          faceId: 'face-p4-1',
          groupId: 'grp_unnamed04',
          assetId: 'urn:aaid:aem:demo-workshop-session',
          assetPath: '/content/dam/events/2026-summit/workshop-session.jpg',
          assetTitle: 'workshop-session.jpg',
          boundingBox: { left: 0.41, top: 0.23, width: 0.19, height: 0.28 },
          confidence: 99.41,
          matchConfidence: null,
          avatarDataUrl: makePortraitSvg('#9d174d', '#78350f', '#e0ac69', 'Person #4'),
          createdAt: now
        }
      };

      const demoAssets = {
        'urn:aaid:aem:demo-keynote-panel': {
          assetId: 'urn:aaid:aem:demo-keynote-panel',
          assetPath: '/content/dam/events/2026-summit/keynote-panel.jpg',
          assetTitle: 'keynote-panel.jpg',
          faceIds: ['face-sarah-1', 'face-marcus-1', 'face-p3-1'],
          scannedAt: now,
          updatedAt: now
        },
        'urn:aaid:aem:demo-backstage-chat': {
          assetId: 'urn:aaid:aem:demo-backstage-chat',
          assetPath: '/content/dam/events/2026-summit/backstage-chat.jpg',
          assetTitle: 'backstage-chat.jpg',
          faceIds: ['face-sarah-2', 'face-p3-2'],
          scannedAt: now,
          updatedAt: now
        },
        'urn:aaid:aem:demo-executive-portrait': {
          assetId: 'urn:aaid:aem:demo-executive-portrait',
          assetPath: '/content/dam/events/2026-summit/executive-portrait.jpg',
          assetTitle: 'executive-portrait.jpg',
          faceIds: ['face-marcus-2'],
          scannedAt: now,
          updatedAt: now
        },
        'urn:aaid:aem:demo-workshop-session': {
          assetId: 'urn:aaid:aem:demo-workshop-session',
          assetPath: '/content/dam/events/2026-summit/workshop-session.jpg',
          assetTitle: 'workshop-session.jpg',
          faceIds: ['face-p4-1'],
          scannedAt: now,
          updatedAt: now
        }
      };

      db.groups = demoGroups;
      db.faces = demoFaces;
      db.assets = demoAssets;
      db.counters = { nextPersonNumber: 5 };

      await syncAssetsToAem(Object.keys(demoAssets), db, settings);
      await storage.saveDatabase(db);

      return this.listGroups();
    },

    /**
     * Clears all groups, faces, and indexed asset records (e.g. to remove sample data).
     */
    async clearAllData() {
      const db = {
        groups: {},
        faces: {},
        assets: {},
        counters: { nextPersonNumber: 1 }
      };
      await storage.saveDatabase(db);
      return this.listGroups();
    },

    /**
     * Re-crops or compacts JPEG avatars so they are crisp 72x72 JPEGs and stay well under
     * Adobe I/O Runtime's 1 MB HTTP response payload limit even with 100+ faces.
     */
    async recropAllAvatars({ limit = 15 } = {}) {
      const db = await storage.getDatabase();
      const facesByAssetPath = {};
      let compactedInMemory = 0;

      for (const face of Object.values(db.faces || {})) {
        const url = face.avatarDataUrl || '';
        if (url.startsWith('data:image/jpeg;base64,') && url.length > 4000) {
          try {
            const rawB64 = url.slice('data:image/jpeg;base64,'.length);
            const buf = Buffer.from(rawB64, 'base64');
            const decoded = decodeImageBuffer(buf);
            const resized = cropAndResizeRgbaToJpeg(
              decoded,
              { left: 0, top: 0, width: decoded.width, height: decoded.height },
              AVATAR_SIZE,
              66
            );
            face.avatarDataUrl = `data:image/jpeg;base64,${resized.toString('base64')}`;
            compactedInMemory++;
          } catch (e) {
            // ignore
          }
        } else if (face.assetPath && (!url || url.startsWith('data:image/svg+xml'))) {
          facesByAssetPath[face.assetPath] = facesByAssetPath[face.assetPath] || [];
          facesByAssetPath[face.assetPath].push(face);
        }
      }

      const pendingPaths = Object.keys(facesByAssetPath);
      const batchPaths = pendingPaths.slice(0, limit);
      let updatedCount = compactedInMemory;
      const errors = [];

      for (const assetPath of batchPaths) {
        const assetFaces = facesByAssetPath[assetPath];
        try {
          const buffer = await aemClient.fetchAssetRenditionBuffer(assetPath);
          const decoded = decodeImageBuffer(buffer);
          for (const face of assetFaces) {
            const avatar = await cropFaceAvatar(decoded, face.boundingBox);
            await storage.saveAvatar(face.faceId, avatar.buffer);
            db.faces[face.faceId].avatarDataUrl = avatar.dataUrl;
            updatedCount++;
          }
        } catch (err) {
          errors.push({ assetPath, error: err.message });
        }
      }

      if (updatedCount > 0) {
        await storage.saveDatabase(db);
      }

      return {
        updatedCount,
        compactedInMemory,
        processedAssets: batchPaths.length,
        remainingAssets: Math.max(0, pendingPaths.length - batchPaths.length),
        errors
      };
    }
  };
}

module.exports = {
  createFaceService,
  computeAssetFaceMetadata,
  getGroupEffectiveMetadataName
};
