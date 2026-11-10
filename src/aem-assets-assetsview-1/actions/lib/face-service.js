const crypto = require('crypto');
const { createStorage } = require('./storage');
const { createRekognitionService } = require('./rekognition');
const { createAemClient, normalizeDamPath } = require('./aem');
const { PublicError, assertDamPath } = require('./security');
const { mapWithConcurrency } = require('./retry');

const AEM_WRITE_CONCURRENCY = 4;
const DEFAULT_SYNC_TIME_BUDGET_MS = 18000;

// Page sizes keep every response far below the 1 MB Adobe I/O Runtime limit.
// A 72px JPEG avatar is ~2-4 KB as a data URL.
const GROUP_PAGE_SIZE = 60;
const MAX_GROUP_PAGE_SIZE = 100;
const GROUP_FACES_PAGE_SIZE = 60;
const MAX_GROUP_FACES_PAGE_SIZE = 100;
const MAX_GROUP_OPTIONS = 2000;
const MAX_GROUP_OPTIONS_WITH_AVATARS = 180; // keeps response < 750 KB with ~3 KB cover avatars
const {
  AVATAR_SIZE,
  getImageDimensions,
  generatePreviewThumbnailDataUrl,
  cropFaceAvatar,
  decodeImageBuffer,
  cropAndResizeRgbaToJpeg
} = require('./cropper');

function generateGroupId() {
  // 128 bits: collisions would silently merge two people's groups
  return `grp_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Strips the `urn:aaid:aem:` prefix so `urn:aaid:aem:123` and `123` compare as the same id.
 */
function stripUrnPrefix(assetId) {
  if (!assetId) return '';
  return String(assetId).trim().replace(/^urn:aaid:aem:/i, '');
}

function safeNormalizeDamPath(p) {
  if (!p) return '';
  try {
    return normalizeDamPath(decodeURIComponent(String(p)));
  } catch (e) {
    return normalizeDamPath(String(p));
  }
}

/**
 * Returns every record in `db.assets` that represents the same asset (matched by id,
 * `urn:aaid:aem:`-stripped id, `uuid` field, or normalized DAM path) as `{ key, record }` pairs.
 */
function findMatchingAssetEntries(db, { assetId, assetPath } = {}) {
  const assets = db?.assets || {};
  const rawId = stripUrnPrefix(assetId);
  const cleanPath = safeNormalizeDamPath(assetPath);
  const matches = [];
  const seenKeys = new Set();

  function add(key, record) {
    if (record && !seenKeys.has(key)) {
      seenKeys.add(key);
      matches.push({ key, record });
    }
  }

  if (assetId && assets[assetId]) add(assetId, assets[assetId]);
  if (rawId && assets[rawId]) add(rawId, assets[rawId]);
  if (rawId && assets[`urn:aaid:aem:${rawId}`]) add(`urn:aaid:aem:${rawId}`, assets[`urn:aaid:aem:${rawId}`]);

  for (const [key, rec] of Object.entries(assets)) {
    if (seenKeys.has(key) || !rec) continue;
    if (rawId && (stripUrnPrefix(rec.assetId) === rawId || stripUrnPrefix(rec.uuid) === rawId)) {
      add(key, rec);
      continue;
    }
    if (cleanPath && safeNormalizeDamPath(rec.assetPath) === cleanPath) {
      add(key, rec);
    }
  }
  return matches;
}

/**
 * Canonical storage key for an asset:
 * - A real id (UUID / `urn:aaid` / test id) is stored without the `urn:aaid:aem:` prefix,
 *   unless it is the synthetic hex-of-path fallback produced when AEM is unreachable.
 * - Otherwise the normalized DAM path is used.
 */
function canonicalAssetKey(assetId, assetPath) {
  const cleanPath = safeNormalizeDamPath(assetPath);
  const raw = stripUrnPrefix(assetId);
  const syntheticHex = cleanPath ? Buffer.from(cleanPath).toString('hex').slice(0, 24) : '';
  if (raw && !raw.startsWith('/') && raw !== syntheticHex) {
    return raw;
  }
  return cleanPath || raw;
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
   * Compact group summary for lists and mutation responses. Never includes member faces,
   * so responses stay small regardless of how many faces a group has.
   */
  function summarizeGroup(group, faces, { includeCover = true } = {}) {
    if (!group) return null;
    const memberFaces = (group.faceIds || []).map((id) => faces[id]).filter(Boolean);
    const uniqueAssets = new Set(
      memberFaces.map((f) => safeNormalizeDamPath(f.assetPath) || f.assetId).filter(Boolean)
    );
    const coverFace = faces[group.coverFaceId] || memberFaces[0] || null;

    const summary = {
      groupId: group.groupId,
      name: group.name || null,
      autoLabel: group.autoLabel || null,
      displayName: group.name || group.autoLabel || group.groupId,
      isNamed: Boolean(group.name && String(group.name).trim()),
      faceCount: memberFaces.length,
      assetCount: uniqueAssets.size,
      coverFaceId: coverFace?.faceId || null,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt
    };
    if (includeCover) summary.coverAvatarDataUrl = coverFace?.avatarDataUrl || null;
    return summary;
  }

  /**
   * Named people first, then by size; ties broken by name and id so paging is stable.
   */
  function compareGroupSummaries(a, b) {
    if (a.isNamed !== b.isNamed) return a.isNamed ? -1 : 1;
    if (b.faceCount !== a.faceCount) return b.faceCount - a.faceCount;
    const byName = a.displayName.localeCompare(b.displayName);
    return byName !== 0 ? byName : a.groupId.localeCompare(b.groupId);
  }

  function matchesGroupFilter(summary, filter, query) {
    if (filter === 'named' && !summary.isNamed) return false;
    if (filter === 'unnamed' && summary.isNamed) return false;
    if (query) {
      const haystack = `${summary.displayName} ${summary.autoLabel || ''} ${summary.groupId}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  }

  function clampInt(value, { min, max, fallback }) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /**
   * Recomputes and writes AEM metadata for a set of assetIds.
   *
   * - Writes run with bounded concurrency (`AEM_WRITE_CONCURRENCY`).
   * - Enforces an optional `timeBudgetMs` so large fan-outs (e.g. a person in 1,000 photos
   *   or a full-library resync) stop cleanly before the 30s gateway timeout and return
   *   `hasMore: true, nextOffset, remainingAssetCount` (`R14`).
   * - A failure on one asset never aborts the batch; callers always persist their database
   *   changes first and report failures/remaining counts to the user.
   */
  async function syncAssetsToAem(
    assetIds,
    db,
    settings,
    { offset = 0, limit = 0, timeBudgetMs = 0 } = {}
  ) {
    const startTime = Date.now();
    const seenPaths = new Set();
    const dedupedRecords = [];

    for (const assetId of assetIds.filter(Boolean)) {
      const assetRecord = findAssetRecord(db, assetId, null);
      if (!assetRecord) continue;
      const dedupeKey = safeNormalizeDamPath(assetRecord.assetPath) || assetRecord.assetId;
      if (seenPaths.has(dedupeKey)) continue;
      seenPaths.add(dedupeKey);

      const computed = computeAssetFaceMetadata(assetRecord, db.faces, db.groups, settings);
      assetRecord.faceNames = computed.faceNames;
      assetRecord.faceGroupIds = computed.faceGroupIds;
      assetRecord.faceCount = computed.faceCount;
      assetRecord.updatedAt = new Date().toISOString();
      dedupedRecords.push({ assetRecord, computed });
    }

    const startIdx = Math.max(0, Number(offset) || 0);
    const maxItems = Number(limit) > 0 ? Number(limit) : dedupedRecords.length;
    const targetSlice = dedupedRecords.slice(startIdx, startIdx + maxItems);

    const synced = [];
    const failed = [];
    let processedCount = 0;
    let stoppedForTimeBudget = false;

    for (let i = 0; i < targetSlice.length; i += AEM_WRITE_CONCURRENCY) {
      if (i > 0 && timeBudgetMs > 0 && Date.now() - startTime >= timeBudgetMs) {
        stoppedForTimeBudget = true;
        break;
      }
      const chunk = targetSlice.slice(i, i + AEM_WRITE_CONCURRENCY);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        chunk.map(async ({ assetRecord, computed }) => {
          processedCount++;
          if (!assetRecord.assetPath) return;
          try {
            const syncRes = await aemClient.updateAssetFaceMetadata(
              assetRecord.assetPath,
              computed
            );
            assetRecord.metadataSyncError = null;
            synced.push(syncRes);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(
              `[facerec] metadata sync failed for ${assetRecord.assetPath}:`,
              err.message
            );
            const message = err.expose ? err.message : 'AEM metadata update failed.';
            assetRecord.metadataSyncError = message;
            failed.push({ assetPath: assetRecord.assetPath, error: message });
          }
        })
      );
    }

    const nextOffset = startIdx + processedCount;
    const hasMore = stoppedForTimeBudget || nextOffset < dedupedRecords.length;
    const remainingAssetCount = Math.max(0, dedupedRecords.length - nextOffset);

    return {
      synced,
      failed,
      totalAssets: dedupedRecords.length,
      processedCount,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
      remainingAssetCount
    };
  }

  function syncSummary(sync) {
    return {
      syncedAssetCount: sync.synced.length,
      syncedAssets: sync.synced,
      failedAssetCount: sync.failed.length,
      failedAssets: sync.failed,
      totalAssetsToSync: sync.totalAssets ?? sync.synced.length + sync.failed.length,
      hasMoreToSync: Boolean(sync.hasMore),
      nextSyncOffset: sync.nextOffset ?? null,
      remainingAssetCount: sync.remainingAssetCount ?? 0
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
   * Removes faces previously indexed for an asset (used before re-scanning), across all
   * duplicate records for the same asset (e.g. one keyed by path and one keyed by UUID).
   *
   * All Rekognition calls run first and are idempotent; the in-memory db is only changed
   * once they have all succeeded, so a failure leaves the db untouched and safe to retry.
   */
  async function removeExistingAssetFaces({ assetId, assetPath, canonicalKey }, db, rekognition) {
    const entries = findMatchingAssetEntries(db, { assetId, assetPath });
    const oldFaceIds = Array.from(
      new Set(entries.flatMap(({ record }) => record.faceIds || []).filter(Boolean))
    );

    if (oldFaceIds.length > 0) {
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
    }

    for (const { key, record } of entries) {
      if (canonicalKey && key !== canonicalKey) {
        delete db.assets[key];
      } else {
        record.faceIds = [];
      }
    }

    // 3. Avatars (best effort)
    await Promise.all(oldFaceIds.map((id) => storage.deleteAvatar(id).catch(() => {})));
  }

  function findAssetRecord(db, assetId, assetPath) {
    const entries = findMatchingAssetEntries(db, { assetId, assetPath });
    return entries[0]?.record || null;
  }

  function skippedResult(assetPath, reasonCode, reason) {
    return { skipped: true, assetPath, reasonCode, reason };
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
    rescan = true,
    mimeType = null,
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

    // Cost controls, all checked before anything is sent to AWS:
    // 1. Already scanned (unless an explicit re-scan was requested)
    if (!rescan) {
      const existing = findAssetRecord(db, assetId, cleanPath);
      if (existing && !existing.incomplete) {
        return skippedResult(cleanPath, 'already-scanned', 'Already scanned');
      }
    }

    // Only skip getAssetInfo when the caller already passed a real asset id (not a path)
    const callerHasRealId = Boolean(assetId && !stripUrnPrefix(assetId).startsWith('/'));
    const info =
      callerHasRealId && cleanPath
        ? {
            assetId,
            assetPath: cleanPath,
            assetTitle: assetTitle || cleanPath.split('/').pop(),
            mimeType
          }
        : await aemClient.getAssetInfo(cleanPath);

    const resolvedPath = info.assetPath;
    const resolvedAssetId = canonicalAssetKey(
      callerHasRealId ? assetId : info.assetId,
      resolvedPath
    );
    const resolvedTitle = assetTitle || info.assetTitle;

    // 2. File type allowlist (unknown types are allowed through; the rendition is still checked)
    const allowedTypes = (settings.allowedImageTypes || []).map((t) => String(t).toLowerCase());
    const assetType = String(mimeType || info.mimeType || '').toLowerCase().split(';')[0].trim();
    if (assetType && allowedTypes.length > 0 && !allowedTypes.includes(assetType)) {
      return skippedResult(resolvedPath, 'unsupported-type', `File type ${assetType} is not enabled for face recognition`);
    }

    const buffer = imageBuffer || (await aemClient.fetchAssetRenditionBuffer(resolvedPath));

    // 3. Tiny images (logos, icons) can't contain usable faces
    const minSize = Number(settings.minImageSize) || 0;
    const dims = minSize > 0 ? getImageDimensions(buffer) : null;
    if (dims && Math.min(dims.width, dims.height) < minSize) {
      return skippedResult(
        resolvedPath,
        'too-small',
        `Image is ${dims.width}x${dims.height}px (minimum ${minSize}px)`
      );
    }

    // Phase 1: detect, match and crop. Nothing in `db` changes in this phase.
    const detectedFaces = await rekognition.indexAssetFaces(buffer, resolvedAssetId, {
      skipEnsureCollection: collectionEnsured
    });
    const indexedFaceIds = detectedFaces.map((f) => f.faceId);

    const prepared = [];
    let previewDataUrl = null;
    try {
      let decodedImage = buffer;
      if (detectedFaces.length > 0) {
        try {
          decodedImage = decodeImageBuffer(buffer);
          previewDataUrl = generatePreviewThumbnailDataUrl(decodedImage, 280, 62);
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

      // Re-scan: drop this asset's previous faces across any legacy keys (Rekognition first, then db)
      await removeExistingAssetFaces(
        { assetId: resolvedAssetId, assetPath: resolvedPath, canonicalKey: resolvedAssetId },
        db,
        rekognition
      );
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
      ...(previewDataUrl ? { previewDataUrl } : {}),
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
    async ingestAsset({
      assetPath,
      assetId,
      assetTitle,
      imageBuffer,
      force = false,
      rescan = true,
      mimeType = null
    }) {
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
          rescan,
          mimeType,
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
      const settings = await storage.getSettings();
      const [browsed, db] = await Promise.all([
        aemClient.browseDamFolder(folderPath, { allowedImageTypes: settings.allowedImageTypes }),
        storage.getDatabase()
      ]);

      const enrichedAssets = (browsed.assets || []).map((a) => {
        const indexed = findAssetRecord(db, a.assetId, a.assetPath);
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
      rescan = false,
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
      const [{ settings, rekognition }, db] = await Promise.all([getRekognition(), storage.getDatabase()]);
      const allAssets = Array.isArray(explicitAssets)
        ? explicitAssets
        : await aemClient.listFolderAssets(folderPath, { allowedImageTypes: settings.allowedImageTypes });
      // The collection check is cached per request and only happens if an image needs AWS
      const collectionEnsured = false;

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
            mimeType: item.mimeType || null,
            force,
            rescan,
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
            ...(res.skipped ? { reasonCode: res.reasonCode, reason: res.reason } : {}),
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
            // R13: getAssetFaces is a read path; never rewrite the database during a read
            assetRecord.uuid = rawUuid;
          }
        }
      }

      if (!assetRecord) {
        return {
          assetId: assetId || null,
          assetPath: decodedPath || null,
          aemHost: aemHost || null,
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
        aemHost: aemHost || null,
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
    /**
     * Lists Face Groups one page at a time (filtered and searched server-side) so the
     * response stays well under the 1 MB Runtime limit however many groups exist.
     */
    async listGroups({ offset = 0, limit = GROUP_PAGE_SIZE, filter = 'all', query = '' } = {}) {
      const [db, settings] = await Promise.all([
        storage.getDatabase(),
        storage.getSettings()
      ]);

      const pageOffset = clampInt(offset, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
      const pageLimit = clampInt(limit, { min: 1, max: MAX_GROUP_PAGE_SIZE, fallback: GROUP_PAGE_SIZE });
      const normalizedFilter = ['named', 'unnamed'].includes(filter) ? filter : 'all';
      const normalizedQuery = String(query || '').trim().toLowerCase().slice(0, 200);

      const all = Object.values(db.groups)
        .map((g) => summarizeGroup(g, db.faces, { includeCover: false }))
        .filter(Boolean);
      const namedCount = all.filter((g) => g.isNamed).length;

      const matched = all
        .filter((g) => matchesGroupFilter(g, normalizedFilter, normalizedQuery))
        .sort(compareGroupSummaries);

      const page = matched
        .slice(pageOffset, pageOffset + pageLimit)
        .map((g) => summarizeGroup(db.groups[g.groupId], db.faces));

      return {
        groups: page,
        offset: pageOffset,
        limit: pageLimit,
        matchedCount: matched.length,
        hasMore: pageOffset + page.length < matched.length,
        totalGroups: all.length,
        namedCount,
        unnamedCount: all.length - namedCount,
        totalFaces: Object.keys(db.faces).length,
        totalAssets: new Set(
          Object.values(db.assets || {}).map((a) => safeNormalizeDamPath(a?.assetPath) || a?.assetId)
        ).size,
        aemHost: aemHost || null,
        settings: {
          metadataProperty: settings.metadataProperty,
          includeUnnamedInMetadata: settings.includeUnnamedInMetadata
        }
      };
    },

    /**
     * Option list used by the "combine into..." pickers. Includes cover avatars for the first
     * `MAX_GROUP_OPTIONS_WITH_AVATARS` groups so dropdown items can render a face thumbnail
     * while keeping the response well under the 1 MB Runtime payload limit.
     */
    async listGroupOptions({ query = '', limit = MAX_GROUP_OPTIONS, includeAvatars = true } = {}) {
      const db = await storage.getDatabase();
      const optionLimit = clampInt(limit, { min: 1, max: MAX_GROUP_OPTIONS, fallback: MAX_GROUP_OPTIONS });
      const normalizedQuery = String(query || '').trim().toLowerCase().slice(0, 200);

      const matched = Object.values(db.groups)
        .map((g) => summarizeGroup(g, db.faces, { includeCover: false }))
        .filter((g) => g && matchesGroupFilter(g, 'all', normalizedQuery))
        .sort(compareGroupSummaries);

      return {
        options: matched.slice(0, optionLimit).map((g, idx) => {
          const item = {
            groupId: g.groupId,
            displayName: g.displayName,
            isNamed: g.isNamed,
            faceCount: g.faceCount
          };
          if (includeAvatars && idx < MAX_GROUP_OPTIONS_WITH_AVATARS) {
            const coverFace = g.coverFaceId ? db.faces[g.coverFaceId] : null;
            item.coverAvatarDataUrl = coverFace?.avatarDataUrl || null;
          }
          return item;
        }),
        total: matched.length,
        truncated: matched.length > optionLimit
      };
    },

    /**
     * Returns one group with a page of its member faces (including avatars).
     */
    async getGroup({ groupId, faceOffset = 0, faceLimit = GROUP_FACES_PAGE_SIZE } = {}) {
      const db = await storage.getDatabase();
      const group = db.groups[groupId];
      if (!group) {
        throw new PublicError(`Face Group '${groupId}' not found.`, 404);
      }

      const offset = clampInt(faceOffset, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
      const limit = clampInt(faceLimit, { min: 1, max: MAX_GROUP_FACES_PAGE_SIZE, fallback: GROUP_FACES_PAGE_SIZE });
      const memberFaces = (group.faceIds || []).map((id) => db.faces[id]).filter(Boolean);
      const facesPage = memberFaces.slice(offset, offset + limit);

      return {
        group: { ...summarizeGroup(group, db.faces), faces: facesPage },
        faceOffset: offset,
        faceLimit: limit,
        hasMoreFaces: offset + facesPage.length < memberFaces.length
      };
    },

    /**
     * Names or renames a Face Group and immediately updates `xdm:faceNames` on all assets
     * containing any face in this group.
     */
    async renameGroup({ groupId, name, timeBudgetMs = DEFAULT_SYNC_TIME_BUDGET_MS }) {
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

      // Save the rename first so it is never lost if the AEM sync hits a time budget
      await storage.saveDatabase(db);
      const sync = await syncAssetsToAem(affectedAssetIds, db, settings, { timeBudgetMs });
      await storage.saveDatabase(db);

      return {
        group: summarizeGroup(group, db.faces),
        ...syncSummary(sync)
      };
    },

    /**
     * Splits one or more faces out of their current group into a brand new standalone group.
     * Updates AWS Rekognition User associations and recomputes `xdm:faceNames` on affected assets.
     */
    async splitFacesToNewGroup({
      faceIds = [],
      newGroupName = null,
      timeBudgetMs = DEFAULT_SYNC_TIME_BUDGET_MS
    }) {
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

      await storage.saveDatabase(db);
      const sync = await syncAssetsToAem(affectedAssetIds, db, settings, { timeBudgetMs });
      await storage.saveDatabase(db);

      return {
        newGroup: summarizeGroup(db.groups[newGroupId], db.faces),
        ...syncSummary(sync)
      };
    },

    /**
     * Moves one or more faces from their current group(s) into an existing target group.
     * Supports combining an individual face into another group.
     */
    async moveFacesToGroup({
      faceIds = [],
      targetGroupId,
      timeBudgetMs = DEFAULT_SYNC_TIME_BUDGET_MS
    }) {
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
          targetGroup: summarizeGroup(targetGroup, db.faces),
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

      const existingInTarget = new Set(targetGroup.faceIds || []);
      for (const fId of facesToMove) {
        if (!existingInTarget.has(fId)) {
          targetGroup.faceIds.push(fId);
          existingInTarget.add(fId);
        }
        db.faces[fId].groupId = targetGroupId;
      }
      targetGroup.updatedAt = now;

      await storage.saveDatabase(db);
      const sync = await syncAssetsToAem(affectedAssetIds, db, settings, { timeBudgetMs });
      await storage.saveDatabase(db);

      return {
        targetGroup: summarizeGroup(targetGroup, db.faces),
        ...syncSummary(sync)
      };
    },

    /**
     * Combines / merges one or more source Face Groups into a target Face Group.
     * Disassociates faces from the source groups in AWS Rekognition, associates them
     * with targetGroupId, deletes the source groups, and updates `xdm:faceNames` on all affected assets.
     */
    async mergeGroups({
      sourceGroupIds = [],
      targetGroupId,
      timeBudgetMs = DEFAULT_SYNC_TIME_BUDGET_MS
    }) {
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
        const existingInTarget = new Set(targetGroup.faceIds || []);
        for (const fId of allMovedFaceIds) {
          if (!existingInTarget.has(fId)) {
            targetGroup.faceIds.push(fId);
            existingInTarget.add(fId);
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

      await storage.saveDatabase(db);
      const sync = await syncAssetsToAem(affectedAssetIds, db, settings, { timeBudgetMs });
      await storage.saveDatabase(db);

      return {
        targetGroup: summarizeGroup(targetGroup, db.faces),
        mergedGroupIds: sources,
        movedFaceCount: allMovedFaceIds.length,
        ...syncSummary(sync)
      };
    },

    /**
     * Permanently deletes a single Face Group ("Right to be Forgotten" / false-positive removal, `S10`):
     * 1. Disassociates and deletes all member face vectors and the User in AWS Rekognition
     * 2. Deletes all cropped avatar files from storage
     * 3. Removes the group and face records from the database and detaches them from assets
     * 4. Re-computes and syncs `xdm:faceNames` on all affected AEM assets
     */
    async deleteGroup({ groupId, timeBudgetMs = DEFAULT_SYNC_TIME_BUDGET_MS }) {
      if (!groupId) {
        throw new PublicError('groupId is required to delete a group.');
      }

      const [{ settings, rekognition }, db] = await Promise.all([
        getRekognition(),
        storage.getDatabase()
      ]);

      const group = db.groups[groupId];
      if (!group) {
        throw new PublicError(`Face Group '${groupId}' not found.`, 404);
      }

      const deletedDisplayName = group.name || group.autoLabel || group.groupId;
      const memberFaceIds = [...(group.faceIds || [])];
      const removedSet = new Set(memberFaceIds);
      const affectedAssetIds = [];

      for (const fId of memberFaceIds) {
        const face = db.faces[fId];
        if (face?.assetId) affectedAssetIds.push(face.assetId);
      }

      // 1. Remove from AWS Rekognition (User + Face vectors)
      if (memberFaceIds.length > 0) {
        await rekognition.disassociateFaces(groupId, memberFaceIds);
      }
      await rekognition.deleteGroup(groupId);
      if (memberFaceIds.length > 0) {
        await rekognition.deleteFaces(memberFaceIds);
      }

      // 2. Remove from database and detach from asset records
      delete db.groups[groupId];
      for (const fId of memberFaceIds) {
        delete db.faces[fId];
      }
      for (const assetRecord of Object.values(db.assets || {})) {
        if (Array.isArray(assetRecord?.faceIds) && assetRecord.faceIds.some((id) => removedSet.has(id))) {
          assetRecord.faceIds = assetRecord.faceIds.filter((id) => !removedSet.has(id));
        }
      }

      // 3. Delete avatar files (best effort) and persist DB before AEM metadata fan-out
      await Promise.all(memberFaceIds.map((id) => storage.deleteAvatar(id).catch(() => {})));
      await storage.saveDatabase(db);

      // 4. Recompute and update AEM metadata on affected assets
      const sync = await syncAssetsToAem(affectedAssetIds, db, settings, { timeBudgetMs });
      await storage.saveDatabase(db);

      return {
        deletedGroupId: groupId,
        deletedDisplayName,
        deletedFaceCount: memberFaceIds.length,
        ...syncSummary(sync)
      };
    },

    /**
     * Re-computes and syncs `xdm:faceNames` on all indexed AEM assets
     * (e.g. after toggling `includeUnnamedInMetadata` in Settings).
     */
    async resyncAllAssetsMetadata({
      offset = 0,
      limit = 0,
      timeBudgetMs = DEFAULT_SYNC_TIME_BUDGET_MS
    } = {}) {
      const [db, settings] = await Promise.all([
        storage.getDatabase(),
        storage.getSettings()
      ]);

      const allAssetIds = Object.keys(db.assets);
      const sync = await syncAssetsToAem(allAssetIds, db, settings, {
        offset,
        limit,
        timeBudgetMs
      });
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
     * Clears all groups, faces, avatars, Rekognition vectors/users, and indexed asset records (`S10`).
     */
    async clearAllData() {
      const existingDb = await storage.getDatabase();
      const allFaceIds = Object.keys(existingDb.faces || {});
      const allGroupIds = Object.keys(existingDb.groups || {});

      // Best-effort purge of Rekognition Users/Faces and stored avatar files when credentials exist
      try {
        const { settings, rekognition } = await getRekognition();
        if (settings.awsAccessKeyId && settings.awsSecretAccessKey) {
          for (const gId of allGroupIds) {
            const gFaces = existingDb.groups[gId]?.faceIds || [];
            if (gFaces.length > 0) {
              // eslint-disable-next-line no-await-in-loop
              await rekognition.disassociateFaces(gId, gFaces).catch(() => {});
            }
            // eslint-disable-next-line no-await-in-loop
            await rekognition.deleteGroup(gId).catch(() => {});
          }
          if (allFaceIds.length > 0) {
            await rekognition.deleteFaces(allFaceIds).catch(() => {});
          }
        }
      } catch (e) {
        // Proceed with local wipe even if AWS credentials are not configured
      }

      await Promise.all(allFaceIds.map((id) => storage.deleteAvatar(id).catch(() => {})));

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
