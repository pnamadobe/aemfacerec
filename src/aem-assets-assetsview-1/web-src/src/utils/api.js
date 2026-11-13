/**
 * Frontend API Client for the App Builder Runtime Actions (`groups`, `ingest`, `settings`).
 *
 * Automatically resolves deployed action URLs from App Builder's generated `config.json`.
 * Also includes a seamless local state fallback when running in standalone browser preview
 * before `aio app deploy`.
 */

let actionUrls = {};
try {
  // In an App Builder build, config.json maps action names to their Runtime URLs
  // eslint-disable-next-line global-require, import/no-unresolved
  actionUrls = require('../config.json');
} catch (e) {
  actionUrls = {};
}

export function getActionUrl(actionName) {
  if (typeof window !== 'undefined' && window.__AIO_ACTION_URLS__?.[actionName]) {
    return window.__AIO_ACTION_URLS__[actionName];
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    const host = String(window.location.hostname || '').toLowerCase();
    if (host.endsWith('.adobeio-static.net') || host.endsWith('.adobeioruntime.net')) {
      return `${window.location.origin}/api/v1/web/aem-assets-assetsview-1/${actionName}`;
    }
  }
  const hit = Object.entries(actionUrls || {}).find(
    ([k]) => k.endsWith(`/${actionName}`) || k === actionName
  );
  if (hit) return hit[1];
  return null;
}

async function invokeAction(actionName, payload = {}, authContext = {}) {
  const url = getActionUrl(actionName);
  if (!url) {
    return invokeLocalPreviewFallback(actionName, payload);
  }

  const headers = {
    'Content-Type': 'application/json'
  };
  if (authContext.imsToken) {
    headers.Authorization = `Bearer ${authContext.imsToken}`;
  }
  if (authContext.imsOrg) {
    headers['x-gw-ims-org-id'] = authContext.imsOrg;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...payload,
      aemHost: authContext.aemHost || payload.aemHost
    })
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(
      `Action '${actionName}' returned a non-JSON response (HTTP ${response.status}).`
    );
  }

  if (!response.ok) {
    const err = new Error(
      data.error ||
        data.body?.error ||
        `Action '${actionName}' failed with HTTP ${response.status}`
    );
    err.status = response.status;
    throw err;
  }
  return data.body || data;
}

// ============================================================================
// Local Browser Preview Store (used when inspecting UI locally without Runtime)
// ============================================================================
const STORAGE_KEY = 'aem_facerec_local_preview_db_v1';

function makePortraitSvg(bg, hair, skin, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
    <rect width="160" height="160" rx="20" fill="${bg}"/>
    <circle cx="80" cy="58" r="34" fill="${hair}"/>
    <circle cx="80" cy="66" r="26" fill="${skin}"/>
    <circle cx="71" cy="63" r="3" fill="#1f2937"/>
    <circle cx="89" cy="63" r="3" fill="#1f2937"/>
    <path d="M72 75 Q80 82 88 75" stroke="#1f2937" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <path d="M36 146 C36 108 124 108 124 146" fill="${hair}"/>
    <rect x="12" y="126" width="136" height="24" rx="8" fill="rgba(0,0,0,0.55)"/>
    <text x="80" y="142" font-family="sans-serif" font-size="11" font-weight="bold" fill="#ffffff" text-anchor="middle">${label}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function getInitialLocalDb() {
  const now = new Date().toISOString();
  return {
    counters: { nextPersonNumber: 5 },
    settings: {
      awsRegion: 'us-east-1',
      awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      hasAwsSecretKey: true,
      awsSecretKeyMasked: '••••••••••••wJal',
      collectionId: 'aem-assets-faces',
      similarityThreshold: 85,
      metadataProperty: 'xdm:faceNames',
      includeUnnamedInMetadata: true,
      processingProfileName: 'Face Recognition',
      requireProcessingProfile: true,
      enabledFolders: ['/content/dam/events', '/content/dam/campaigns']
    },
    groups: {
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
    },
    faces: {
      'face-sarah-1': {
        faceId: 'face-sarah-1',
        groupId: 'grp_sarah01',
        assetId: 'urn:aaid:aem:demo-keynote-panel',
        assetPath: '/content/dam/events/2026-summit/keynote-panel.jpg',
        assetTitle: 'keynote-panel.jpg',
        boundingBox: { left: 0.12, top: 0.22, width: 0.16, height: 0.28 },
        confidence: 99.92,
        matchConfidence: 98.4,
        avatarDataUrl: makePortraitSvg('#1e3a8a', '#451a03', '#f3d2b3', 'Sarah • crop 1'),
        createdAt: now
      },
      'face-marcus-1': {
        faceId: 'face-marcus-1',
        groupId: 'grp_marcus02',
        assetId: 'urn:aaid:aem:demo-keynote-panel',
        assetPath: '/content/dam/events/2026-summit/keynote-panel.jpg',
        assetTitle: 'keynote-panel.jpg',
        boundingBox: { left: 0.42, top: 0.18, width: 0.16, height: 0.29 },
        confidence: 99.87,
        matchConfidence: 96.1,
        avatarDataUrl: makePortraitSvg('#065f46', '#111827', '#c68642', 'Marcus • crop 1'),
        createdAt: now
      },
      'face-p3-1': {
        faceId: 'face-p3-1',
        groupId: 'grp_unnamed03',
        assetId: 'urn:aaid:aem:demo-keynote-panel',
        assetPath: '/content/dam/events/2026-summit/keynote-panel.jpg',
        assetTitle: 'keynote-panel.jpg',
        boundingBox: { left: 0.71, top: 0.24, width: 0.15, height: 0.27 },
        confidence: 99.54,
        matchConfidence: null,
        avatarDataUrl: makePortraitSvg('#5b21b6', '#9a3412', '#f7dec4', 'Person #3 • crop 1'),
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
        avatarDataUrl: makePortraitSvg('#1d4ed8', '#451a03', '#f3d2b3', 'Sarah • crop 2'),
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
        matchConfidence: 86.2,
        avatarDataUrl: makePortraitSvg('#6d28d9', '#78350f', '#e0ac69', 'Person #3 • crop 2'),
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
        avatarDataUrl: makePortraitSvg('#047857', '#111827', '#c68642', 'Marcus • crop 2'),
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
        avatarDataUrl: makePortraitSvg('#9d174d', '#78350f', '#e0ac69', 'Person #4 • crop 1'),
        createdAt: now
      }
    },
    assets: {
      'urn:aaid:aem:demo-keynote-panel': {
        assetId: 'urn:aaid:aem:demo-keynote-panel',
        assetPath: '/content/dam/events/2026-summit/keynote-panel.jpg',
        assetTitle: 'keynote-panel.jpg',
        faceIds: ['face-sarah-1', 'face-marcus-1', 'face-p3-1']
      },
      'urn:aaid:aem:demo-backstage-chat': {
        assetId: 'urn:aaid:aem:demo-backstage-chat',
        assetPath: '/content/dam/events/2026-summit/backstage-chat.jpg',
        assetTitle: 'backstage-chat.jpg',
        faceIds: ['face-sarah-2', 'face-p3-2']
      },
      'urn:aaid:aem:demo-executive-portrait': {
        assetId: 'urn:aaid:aem:demo-executive-portrait',
        assetPath: '/content/dam/events/2026-summit/executive-portrait.jpg',
        assetTitle: 'executive-portrait.jpg',
        faceIds: ['face-marcus-2']
      },
      'urn:aaid:aem:demo-workshop-session': {
        assetId: 'urn:aaid:aem:demo-workshop-session',
        assetPath: '/content/dam/events/2026-summit/workshop-session.jpg',
        assetTitle: 'workshop-session.jpg',
        faceIds: ['face-p4-1']
      }
    }
  };
}

function loadLocalDb() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    // ignore
  }
  const initial = getInitialLocalDb();
  saveLocalDb(initial);
  return initial;
}

function saveLocalDb(db) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (e) {
    // ignore
  }
}

function enrichGroupLocal(group, db) {
  const memberFaces = (group.faceIds || []).map((id) => db.faces[id]).filter(Boolean);
  const uniqueAssets = new Set(memberFaces.map((f) => f.assetId));
  const coverFace = db.faces[group.coverFaceId] || memberFaces[0] || null;
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

function computeAssetFacesLocal(assetRecord, db) {
  const faceIds = (assetRecord.faceIds || []).filter((id) => Boolean(db.faces[id]));
  const groupsOnAsset = faceIds.map((id) => db.groups[db.faces[id].groupId]).filter(Boolean);
  const faceNames = Array.from(
    new Set(
      groupsOnAsset
        .map((g) =>
          g.name && g.name.trim()
            ? g.name.trim()
            : db.settings.includeUnnamedInMetadata
            ? g.autoLabel
            : null
        )
        .filter(Boolean)
    )
  );
  const faceGroupIds = Array.from(new Set(groupsOnAsset.map((g) => g.groupId)));
  const faces = faceIds.map((id) => {
    const f = db.faces[id];
    const g = db.groups[f.groupId];
    return {
      ...f,
      groupName: g?.name || null,
      groupAutoLabel: g?.autoLabel || 'Unassigned',
      groupDisplayName: g?.name || g?.autoLabel || 'Unassigned',
      groupFaceCount: g?.faceIds?.length || 1
    };
  });

  return {
    ...assetRecord,
    scanned: true,
    faceCount: faces.length,
    faceNames,
    faceGroupIds,
    metadataProperty: db.settings.metadataProperty || 'xdm:faceNames',
    includeUnnamedInMetadata: db.settings.includeUnnamedInMetadata,
    faces
  };
}

async function invokeLocalPreviewFallback(actionName, payload) {
  const db = loadLocalDb();
  const op = payload.operation;

  if (actionName === 'settings') {
    if (op === 'getSettings') {
      return {
        isAdmin: true,
        processingProfiles: [
          {
            name: db.settings.processingProfileName || 'Face Recognition',
            path: '/conf/global/settings/dam/processing/face-recognition'
          }
        ],
        settings: db.settings
      };
    }
    if (op === 'saveSettings') {
      db.settings = { ...db.settings, ...(payload.settings || {}) };
      saveLocalDb(db);
      return {
        settings: db.settings,
        resyncedAssets: Object.keys(db.assets).length
      };
    }
    if (op === 'testConnection') {
      return {
        connected: true,
        collectionId: payload.settings?.collectionId || db.settings.collectionId,
        faceCount: Object.keys(db.faces).length,
        userCount: Object.keys(db.groups).length
      };
    }
  }

  if (actionName === 'groups') {
    if (op === 'seedDemoData') {
      const fresh = getInitialLocalDb();
      saveLocalDb(fresh);
      return invokeLocalPreviewFallback('groups', { operation: 'listGroups' });
    }
    if (op === 'listGroups' || op === 'listGroupOptions') {
      const all = Object.values(db.groups)
        .map((g) => enrichGroupLocal(g, db))
        .sort((a, b) =>
          a.isNamed !== b.isNamed
            ? a.isNamed
              ? -1
              : 1
            : b.faceCount - a.faceCount || a.displayName.localeCompare(b.displayName)
        );
      const q = String(payload.query || '').trim().toLowerCase();
      const filter = op === 'listGroups' ? payload.filter || 'all' : 'all';
      const matched = all.filter((g) => {
        if (filter === 'named' && !g.isNamed) return false;
        if (filter === 'unnamed' && g.isNamed) return false;
        if (!q) return true;
        const haystack = q.startsWith('grp_')
          ? `${g.displayName} ${g.autoLabel || ''} ${g.groupId}`.toLowerCase()
          : `${g.displayName} ${g.autoLabel || ''}`.toLowerCase();
        return haystack.includes(q);
      });
      if (op === 'listGroupOptions') {
        return {
          options: matched.map(({ groupId, displayName, isNamed, faceCount, coverAvatarDataUrl }) => ({
            groupId,
            displayName,
            isNamed,
            faceCount,
            coverAvatarDataUrl: coverAvatarDataUrl || null
          })),
          total: matched.length,
          truncated: false
        };
      }
      const offset = Number(payload.offset) || 0;
      const limit = Number(payload.limit) || 60;
      const page = matched.slice(offset, offset + limit).map(({ faces, ...summary }) => summary);
      const namedCount = all.filter((g) => g.isNamed).length;
      return {
        groups: page,
        offset,
        limit,
        matchedCount: matched.length,
        hasMore: offset + page.length < matched.length,
        totalGroups: all.length,
        namedCount,
        unnamedCount: all.length - namedCount,
        totalFaces: Object.keys(db.faces).length,
        totalAssets: Object.keys(db.assets).length,
        settings: {
          metadataProperty: db.settings.metadataProperty,
          includeUnnamedInMetadata: db.settings.includeUnnamedInMetadata
        }
      };
    }
    if (op === 'getGroup') {
      const grp = db.groups[payload.groupId];
      if (!grp) {
        const notFound = new Error(`Face Group '${payload.groupId}' not found.`);
        notFound.status = 404;
        throw notFound;
      }
      const enriched = enrichGroupLocal(grp, db);
      const faceOffset = Number(payload.faceOffset) || 0;
      const faceLimit = Number(payload.faceLimit) || 60;
      return {
        group: { ...enriched, faces: enriched.faces.slice(faceOffset, faceOffset + faceLimit) },
        faceOffset,
        faceLimit,
        hasMoreFaces: faceOffset + faceLimit < enriched.faces.length
      };
    }
    if (op === 'getAssetFaces') {
      const assetRecord =
        db.assets[payload.assetId] ||
        Object.values(db.assets).find((a) => a.assetPath === payload.assetPath) ||
        db.assets['urn:aaid:aem:demo-keynote-panel'];
      return computeAssetFacesLocal(assetRecord, db);
    }
    if (op === 'renameGroup') {
      const grp = db.groups[payload.groupId];
      if (grp) {
        grp.name = payload.name && payload.name.trim() ? payload.name.trim() : null;
      }
      saveLocalDb(db);
      return {
        group: enrichGroupLocal(grp, db),
        syncedAssetCount: new Set((grp?.faceIds || []).map((id) => db.faces[id]?.assetId)).size
      };
    }
    if (op === 'splitFaces') {
      const faceIds = payload.faceIds || [];
      for (const fId of faceIds) {
        const face = db.faces[fId];
        if (!face) continue;
        const oldGrp = db.groups[face.groupId];
        if (oldGrp) {
          oldGrp.faceIds = oldGrp.faceIds.filter((id) => id !== fId);
          if (oldGrp.faceIds.length === 0) {
            delete db.groups[oldGrp.groupId];
          } else if (oldGrp.coverFaceId === fId) {
            oldGrp.coverFaceId = oldGrp.faceIds[0];
          }
        }
      }
      const newGroupId = `grp_${Math.random().toString(16).slice(2, 8)}`;
      const num = db.counters.nextPersonNumber++;
      db.groups[newGroupId] = {
        groupId: newGroupId,
        name: payload.newGroupName?.trim() || null,
        autoLabel: `Person #${num}`,
        coverFaceId: faceIds[0],
        faceIds
      };
      for (const fId of faceIds) {
        if (db.faces[fId]) db.faces[fId].groupId = newGroupId;
      }
      saveLocalDb(db);
      return {
        newGroup: enrichGroupLocal(db.groups[newGroupId], db),
        syncedAssetCount: faceIds.length
      };
    }
    if (op === 'moveFaces') {
      const { faceIds = [], targetGroupId } = payload;
      const targetGrp = db.groups[targetGroupId];
      for (const fId of faceIds) {
        const face = db.faces[fId];
        if (!face || face.groupId === targetGroupId) continue;
        const oldGrp = db.groups[face.groupId];
        if (oldGrp) {
          oldGrp.faceIds = oldGrp.faceIds.filter((id) => id !== fId);
          if (oldGrp.faceIds.length === 0) delete db.groups[oldGrp.groupId];
        }
        face.groupId = targetGroupId;
        if (targetGrp && !targetGrp.faceIds.includes(fId)) {
          targetGrp.faceIds.push(fId);
        }
      }
      saveLocalDb(db);
      return {
        targetGroup: enrichGroupLocal(targetGrp, db),
        syncedAssetCount: faceIds.length
      };
    }
    if (op === 'resyncAllAssets') {
      const total = Object.keys(db.assets).length;
      return {
        syncedAssetCount: total,
        failedAssetCount: 0,
        failedAssets: [],
        totalAssetsToSync: total,
        hasMoreToSync: false,
        nextSyncOffset: null,
        remainingAssetCount: 0
      };
    }
    if (op === 'deleteGroup') {
      const grp = db.groups[payload.groupId];
      if (!grp) throw new Error(`Face Group '${payload.groupId}' not found.`);
      const deletedDisplayName = grp.name || grp.autoLabel || grp.groupId;
      const memberFaceIds = [...(grp.faceIds || [])];
      for (const fId of memberFaceIds) {
        delete db.faces[fId];
      }
      for (const assetRecord of Object.values(db.assets || {})) {
        assetRecord.faceIds = (assetRecord.faceIds || []).filter((id) => !memberFaceIds.includes(id));
      }
      delete db.groups[payload.groupId];
      saveLocalDb(db);
      return {
        deletedGroupId: payload.groupId,
        deletedDisplayName,
        deletedFaceCount: memberFaceIds.length,
        syncedAssetCount: 1,
        failedAssetCount: 0,
        failedAssets: []
      };
    }
    if (op === 'mergeGroups') {
      const { sourceGroupIds = [], targetGroupId } = payload;
      const targetGrp = db.groups[targetGroupId];
      let moved = 0;
      for (const srcId of sourceGroupIds) {
        if (srcId === targetGroupId || !db.groups[srcId]) continue;
        const srcGrp = db.groups[srcId];
        if (!targetGrp.name && srcGrp.name) targetGrp.name = srcGrp.name;
        for (const fId of srcGrp.faceIds) {
          if (db.faces[fId]) db.faces[fId].groupId = targetGroupId;
          if (!targetGrp.faceIds.includes(fId)) targetGrp.faceIds.push(fId);
          moved++;
        }
        delete db.groups[srcId];
      }
      saveLocalDb(db);
      return {
        targetGroup: enrichGroupLocal(targetGrp, db),
        movedFaceCount: moved,
        syncedAssetCount: targetGrp.faceIds.length
      };
    }
  }

  if (actionName === 'ingest') {
    if (op === 'scanFolder') {
      return {
        folderPath: payload.folderPath,
        totalAssets: Object.keys(db.assets).length,
        results: Object.values(db.assets).map((a) => ({
          assetPath: a.assetPath,
          status: 'processed',
          faceCount: a.faceIds.length
        }))
      };
    }
    return invokeLocalPreviewFallback('groups', {
      operation: 'getAssetFaces',
      assetId: payload.assetId,
      assetPath: payload.assetPath
    });
  }

  return {};
}

const SKIP_REASON_LABELS = {
  'already-scanned': 'already scanned',
  'too-small': 'too small',
  'unsupported-type': 'unsupported file type'
};

/**
 * Counts scan outcomes: { scanned, faces, skipped, skippedByReason, failed, excluded }.
 */
export function summarizeScanResults(results = [], excludedAssetCount = 0) {
  const summary = { scanned: 0, faces: 0, skipped: 0, skippedByReason: {}, failed: 0, excluded: excludedAssetCount };
  for (const r of results) {
    if (r.status === 'processed') {
      summary.scanned++;
      summary.faces += r.faceCount || 0;
    } else if (r.status === 'skipped') {
      summary.skipped++;
      const key = r.reasonCode || 'other';
      summary.skippedByReason[key] = (summary.skippedByReason[key] || 0) + 1;
    } else if (r.status === 'error') {
      summary.failed++;
    }
  }
  return summary;
}

/**
 * Human-readable one-line scan summary, e.g.
 * "Analyzed 3 image(s) (5 faces). Skipped 40: 38 already scanned, 2 too small. 4 non-image or excluded file type(s) ignored."
 */
export function describeScanSummary(summary) {
  const parts = [`Analyzed ${summary.scanned} image(s) (${summary.faces} face(s)).`];
  if (summary.skipped > 0) {
    const reasons = Object.entries(summary.skippedByReason)
      .map(([code, n]) => `${n} ${SKIP_REASON_LABELS[code] || code}`)
      .join(', ');
    parts.push(`Skipped ${summary.skipped}: ${reasons}.`);
  }
  if (summary.excluded > 0) {
    parts.push(`${summary.excluded} non-image or excluded file type(s) ignored.`);
  }
  return parts.join(' ');
}

/**
 * Builds a status banner for an operation result, downgrading it to a warning when some
 * AEM metadata writes (or individual folder-scan items) failed.
 */
export function resultBanner(successText, res = {}) {
  const issues = [];
  if (res.hasMoreToSync && res.remainingAssetCount > 0) {
    issues.push(
      `Stopped before the request timeout with ${res.remainingAssetCount} asset(s) still queued for metadata sync.`
    );
  }
  if (res.failedAssetCount > 0) {
    const first = (res.failedAssets || [])[0];
    issues.push(
      `AEM metadata could not be updated on ${res.failedAssetCount} asset(s)${
        first ? ` (e.g. ${first.assetPath}: ${first.error})` : ''
      }. Re-run "Re-sync all assets" or re-scan to retry.`
    );
  }
  if (res.metadataSynced === false) {
    issues.push(`AEM metadata could not be updated: ${res.metadataSyncError || 'unknown error'}.`);
  }
  const failedItems = (res.results || []).filter((r) => r.status === 'error');
  if (failedItems.length > 0) {
    issues.push(
      `${failedItems.length} asset(s) failed (e.g. ${failedItems[0].assetPath}: ${failedItems[0].error}).`
    );
  }
  if (issues.length === 0) return { type: 'positive', text: successText };
  return { type: 'negative', text: `${successText} Warning: ${issues.join(' ')}` };
}

export const api = {
  /** params: { offset, limit, filter: 'all'|'named'|'unnamed', query } */
  listGroups: (ctx, params = {}) =>
    invokeAction('groups', { operation: 'listGroups', ...params }, ctx),
  listGroupOptions: (ctx, params = {}) =>
    invokeAction('groups', { operation: 'listGroupOptions', ...params }, ctx),
  /** params: { faceOffset, faceLimit } */
  getGroup: (groupId, ctx, params = {}) =>
    invokeAction('groups', { operation: 'getGroup', groupId, ...params }, ctx),
  getAssetFaces: (params, ctx) =>
    invokeAction('groups', { operation: 'getAssetFaces', ...params }, ctx),
  renameGroup: (groupId, name, ctx) =>
    invokeAction('groups', { operation: 'renameGroup', groupId, name }, ctx),
  splitFaces: (faceIds, newGroupName, ctx) =>
    invokeAction('groups', { operation: 'splitFaces', faceIds, newGroupName }, ctx),
  moveFaces: (faceIds, targetGroupId, ctx) =>
    invokeAction('groups', { operation: 'moveFaces', faceIds, targetGroupId }, ctx),
  mergeGroups: (sourceGroupIds, targetGroupId, ctx) =>
    invokeAction('groups', { operation: 'mergeGroups', sourceGroupIds, targetGroupId }, ctx),
  deleteGroup: (groupId, ctx) =>
    invokeAction('groups', { operation: 'deleteGroup', groupId }, ctx),
  /**
   * Re-syncs AEM metadata across all indexed assets in time-budgeted chunks (`R14`).
   */
  resyncAllAssets: async (ctx, onProgress) => {
    let offset = 0;
    let totalSynced = 0;
    let totalFailed = 0;
    const failedAssets = [];
    for (let page = 0; page < 200; page++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await invokeAction(
        'groups',
        { operation: 'resyncAllAssets', offset },
        ctx
      );
      totalSynced += res.syncedAssetCount || 0;
      totalFailed += res.failedAssetCount || 0;
      if (Array.isArray(res.failedAssets)) failedAssets.push(...res.failedAssets);
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            syncedAssetCount: totalSynced,
            remainingAssetCount: res.remainingAssetCount || 0,
            totalAssetsToSync: res.totalAssetsToSync || totalSynced
          });
        } catch (e) {
          // ignore
        }
      }
      if (!res.hasMoreToSync || res.nextSyncOffset === null || res.nextSyncOffset === undefined) {
        break;
      }
      offset = res.nextSyncOffset;
    }
    return {
      syncedAssetCount: totalSynced,
      failedAssetCount: totalFailed,
      failedAssets,
      hasMoreToSync: false,
      remainingAssetCount: 0
    };
  },
  seedDemoData: (ctx) => invokeAction('groups', { operation: 'seedDemoData' }, ctx),
  clearAllData: (ctx) => invokeAction('groups', { operation: 'clearAllData' }, ctx),
  ingestAsset: (params, ctx) =>
    invokeAction('ingest', { operation: 'ingestAsset', force: true, ...params }, ctx),
  browseFolder: (folderPath, ctx) =>
    invokeAction('ingest', { operation: 'browseFolder', folderPath }, ctx),
  /**
   * Scans the image assets in a folder in small batches.
   * By default images that were already scanned are skipped without calling the backend
   * (no AWS cost); pass { rescan: true } to analyze everything again.
   */
  scanFolder: async (folderPath, ctx, onProgress, { rescan = false } = {}) => {
    if (!getActionUrl('ingest')) {
      return invokeLocalPreviewFallback('ingest', { operation: 'scanFolder', folderPath });
    }
    const browsed = await invokeAction(
      'ingest',
      { operation: 'browseFolder', folderPath },
      ctx
    );
    const listedAssets = browsed.assets || [];
    const resolvedFolderPath = browsed.folderPath || folderPath;
    const excludedAssetCount = browsed.excludedAssetCount || 0;

    const allResults = [];
    const toScan = [];
    for (const a of listedAssets) {
      if (!rescan && a.scanned) {
        allResults.push({
          assetPath: a.assetPath,
          status: 'skipped',
          reasonCode: 'already-scanned',
          reason: 'Already scanned',
          faceCount: a.faceCount || 0
        });
      } else {
        toScan.push(a);
      }
    }

    const BATCH_SIZE = 5;
    let idx = 0;
    const report = () => {
      if (typeof onProgress !== 'function') return;
      try {
        onProgress({
          completed: Math.min(idx, toScan.length),
          total: toScan.length,
          results: allResults
        });
      } catch (e) {
        // ignore progress callback error
      }
    };

    while (idx < toScan.length) {
      const batch = toScan.slice(idx, idx + BATCH_SIZE).map((a) => ({
        assetPath: a.assetPath,
        assetId: a.assetId,
        assetTitle: a.assetTitle,
        mimeType: a.mimeType || null
      }));
      const batchRes = await invokeAction(
        'ingest',
        {
          operation: 'scanFolder',
          folderPath: resolvedFolderPath,
          assets: batch,
          force: true,
          rescan
        },
        ctx
      );
      const batchResults = batchRes.results || [];
      allResults.push(...batchResults);
      const step = Math.max(1, batchResults.length || batch.length);
      idx += step;
      report();
    }

    return {
      folderPath: resolvedFolderPath,
      totalAssets: listedAssets.length,
      excludedAssetCount,
      results: allResults,
      summary: summarizeScanResults(allResults, excludedAssetCount)
    };
  },
  getSettings: (ctx) => invokeAction('settings', { operation: 'getSettings' }, ctx),
  saveSettings: (settings, ctx) =>
    invokeAction('settings', { operation: 'saveSettings', settings }, ctx),
  testConnection: (settings, ctx) =>
    invokeAction('settings', { operation: 'testConnection', settings }, ctx)
};
