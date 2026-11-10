const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAemClient } = require('../actions/lib/aem');
const { createStorage } = require('../actions/lib/storage');
const { createFaceService } = require('../actions/lib/face-service');

const AEM = 'https://author-p12345-e67890.adobeaemcloud.com';

function assetEntity(name, uuid = null, format = 'image/jpeg') {
  return {
    class: ['assets/asset'],
    properties: {
      name,
      ...(uuid ? { 'jcr:uuid': uuid } : {}),
      metadata: { 'dc:format': format }
    }
  };
}

function jsonResponse(obj) {
  const text = JSON.stringify(obj);
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => text,
    json: async () => obj
  };
}

// ---------------------------------------------------------------------------
// R11: Folder pagination past 200 items
// ---------------------------------------------------------------------------

test('R11: browseDamFolder pages past 200 items and gathers all assets and subfolders', async () => {
  const totalAssets = 450;
  const allEntities = [
    { class: ['assets/folder'], properties: { name: 'subfolder-a', 'dc:title': 'Subfolder A' } },
    ...Array.from({ length: totalAssets }, (_, i) => assetEntity(`img-${i}.jpg`, `uuid-${i}`))
  ];

  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(String(url));
    const u = new URL(url);
    const limit = Number(u.searchParams.get('limit')) || 200;
    const offset = Number(u.searchParams.get('offset')) || 0;
    const slice = allEntities.slice(offset, offset + limit);
    const hasMore = offset + slice.length < allEntities.length;
    return jsonResponse({
      properties: { 'dc:title': 'Big Shoot' },
      entities: slice,
      links: hasMore ? [{ rel: ['next'], href: `${url}` }] : []
    });
  };

  const aem = createAemClient({ aemHost: AEM, token: 't', fetchImpl });
  const res = await aem.browseDamFolder('/content/dam/big-shoot');

  assert.equal(res.folderTitle, 'Big Shoot');
  assert.equal(res.folders.length, 1);
  assert.equal(res.assets.length, totalAssets);
  assert.equal(res.assets[0].assetPath, '/content/dam/big-shoot/img-0.jpg');
  assert.equal(res.assets[449].assetPath, '/content/dam/big-shoot/img-449.jpg');
  assert.equal(requestedUrls.length, 3, '200 + 200 + 51 across 3 pages');
  assert.match(requestedUrls[0], /limit=200&offset=0$/);
  assert.match(requestedUrls[1], /limit=200&offset=200$/);
  assert.match(requestedUrls[2], /limit=200&offset=400$/);
});

test('R11: browseDamFolder stops cleanly if a server ignores offset and repeats the first page', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse({
      entities: Array.from({ length: 200 }, (_, i) => assetEntity(`dup-${i}.jpg`))
    });
  };
  const aem = createAemClient({ aemHost: AEM, token: 't', fetchImpl });
  const res = await aem.browseDamFolder('/content/dam/broken-server');
  assert.equal(res.assets.length, 200);
  assert.equal(calls, 2, 'stops as soon as the second page yields 0 new items');
});

test('R11: browseDamFolder follows a "next" link even when a page has fewer than 200 items', async () => {
  const pages = [
    { entities: [assetEntity('a.jpg'), assetEntity('b.jpg')], links: [{ rel: ['next'], href: 'next' }] },
    { entities: [assetEntity('c.jpg')], links: [] }
  ];
  let idx = 0;
  const aem = createAemClient({
    aemHost: AEM,
    token: 't',
    fetchImpl: async () => jsonResponse(pages[idx++])
  });
  const res = await aem.browseDamFolder('/content/dam/paged');
  assert.deepEqual(res.assets.map((a) => a.assetPath.split('/').pop()), ['a.jpg', 'b.jpg', 'c.jpg']);
});

// ---------------------------------------------------------------------------
// R9: Canonical asset IDs across ingestion paths
// ---------------------------------------------------------------------------

async function createAssetIdHarness({ uuidByPath = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-r9-'));
  const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
  await storage.saveSettings({ awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'secret' });

  let faceSeq = 0;
  const deletedFaces = [];
  const rekognitionClient = {
    async send(cmd) {
      const name = cmd.constructor.name.replace(/Command$/, '');
      if (name === 'IndexFaces') {
        return {
          FaceRecords: [
            {
              Face: {
                FaceId: `face-${++faceSeq}`,
                Confidence: 99,
                BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.2, Height: 0.2 }
              }
            }
          ]
        };
      }
      if (name === 'DeleteFaces') {
        deletedFaces.push(...cmd.input.FaceIds);
      }
      return {};
    }
  };

  const aemWrites = [];
  const aemClient = {
    async checkFolderEligibility() {
      return { eligible: true };
    },
    async getAssetInfo(assetPath) {
      const uuid = uuidByPath[assetPath];
      return {
        assetId: uuid || `urn:aaid:aem:${Buffer.from(assetPath).toString('hex').slice(0, 24)}`,
        assetPath,
        assetTitle: assetPath.split('/').pop()
      };
    },
    async fetchAssetRenditionBuffer() {
      return Buffer.from('mock-image-bytes');
    },
    async updateAssetFaceMetadata(assetPath, payload) {
      aemWrites.push({ assetPath, payload });
      return { updated: true, assetPath, metadata: payload };
    },
    async browseDamFolder(folderPath) {
      return {
        folderPath,
        folderTitle: 'Folder',
        folders: [],
        assets: Object.entries(uuidByPath).map(([assetPath, uuid]) => ({
          // Note: AEM Assets HTTP API often omits jcr:uuid on child entities, so browseDamFolder
          // falls back to fullPath as assetId.
          assetId: uuid || assetPath,
          assetPath,
          assetTitle: assetPath.split('/').pop(),
          mimeType: 'image/jpeg'
        }))
      };
    }
  };

  const svc = await createFaceService({
    storage,
    rekognitionClient,
    aemClient,
    retryOptions: { sleep: async () => {} }
  });

  return {
    svc,
    storage,
    deletedFaces,
    aemWrites,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

test('R9: scanning via folder (path as assetId) then re-scanning via event/UI (urn:aaid UUID) updates one record and cleans up old faces', async () => {
  const pathA = '/content/dam/shoot/hero.jpg';
  const uuidA = '11111111-2222-3333-4444-555555555555';
  const h = await createAssetIdHarness({ uuidByPath: { [pathA]: uuidA } });
  try {
    // 1. Folder scan where the caller passed assetId = fullPath (because browseDamFolder didn't get a UUID)
    await h.svc.scanFolder({
      folderPath: '/content/dam/shoot',
      assets: [{ assetId: pathA, assetPath: pathA, assetTitle: 'hero.jpg' }],
      force: true
    });

    let db = await h.storage.getDatabase();
    assert.deepEqual(Object.keys(db.assets), [uuidA], 'stored under canonical UUID, not the path');
    assert.deepEqual(db.assets[uuidA].faceIds, ['face-1']);

    // 2. Re-scan from Assets View / I/O Event passing urn:aaid:aem:<uuid>
    await h.svc.ingestAsset({
      assetId: `urn:aaid:aem:${uuidA}`,
      assetPath: pathA,
      force: true,
      rescan: true
    });

    db = await h.storage.getDatabase();
    assert.deepEqual(Object.keys(db.assets), [uuidA], 'still a single asset record');
    assert.deepEqual(db.assets[uuidA].faceIds, ['face-2']);
    assert.deepEqual(Object.keys(db.faces), ['face-2'], 'old face removed from db');
    assert.deepEqual(h.deletedFaces, ['face-1'], 'old face deleted from Rekognition');

    // 3. Lookups work by raw UUID, urn:aaid, or path
    for (const query of [
      { assetId: uuidA },
      { assetId: `urn:aaid:aem:${uuidA}` },
      { assetPath: pathA }
    ]) {
      const found = await h.svc.getAssetFaces(query);
      assert.equal(found.scanned, true);
      assert.equal(found.faceCount, 1);
    }
  } finally {
    h.cleanup();
  }
});

test('R9: legacy database with duplicate records (one keyed by path, one by urn:aaid) is consolidated on re-scan', async () => {
  const pathA = '/content/dam/shoot/dup.jpg';
  const uuidA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const h = await createAssetIdHarness({ uuidByPath: { [pathA]: uuidA } });
  try {
    // Seed a legacy state with two records for the same asset
    const db = await h.storage.getDatabase();
    db.groups.g1 = {
      groupId: 'g1',
      name: 'Alice',
      autoLabel: 'Person #1',
      coverFaceId: 'old-path-face',
      faceIds: ['old-path-face', 'old-urn-face']
    };
    db.faces['old-path-face'] = {
      faceId: 'old-path-face',
      groupId: 'g1',
      assetId: pathA,
      assetPath: pathA
    };
    db.faces['old-urn-face'] = {
      faceId: 'old-urn-face',
      groupId: 'g1',
      assetId: `urn:aaid:aem:${uuidA}`,
      assetPath: pathA
    };
    db.assets[pathA] = { assetId: pathA, assetPath: pathA, faceIds: ['old-path-face'] };
    db.assets[`urn:aaid:aem:${uuidA}`] = {
      assetId: `urn:aaid:aem:${uuidA}`,
      assetPath: pathA,
      faceIds: ['old-urn-face']
    };
    await h.storage.saveDatabase(db);

    // Before re-scan: group assetCount and totalAssets deduplicate by path, and rename only writes once
    const listedBefore = await h.svc.listGroups();
    assert.equal(listedBefore.totalAssets, 1);
    assert.equal(listedBefore.groups[0].assetCount, 1);
    await h.svc.renameGroup({ groupId: 'g1', name: 'Alice Renamed' });
    assert.equal(h.aemWrites.length, 1);

    // Re-scanning removes faces from BOTH legacy records and leaves only the canonical key
    await h.svc.ingestAsset({ assetPath: pathA, force: true, rescan: true });
    const after = await h.storage.getDatabase();
    assert.deepEqual(Object.keys(after.assets), [uuidA]);
    assert.deepEqual(h.deletedFaces.sort(), ['old-path-face', 'old-urn-face']);
    assert.deepEqual(Object.keys(after.faces), ['face-1']);
  } finally {
    h.cleanup();
  }
});

test('R9: when AEM has no UUID (offline/synthetic), the DAM path is used as the canonical key instead of a synthetic hex hash', async () => {
  const pathA = '/content/dam/offline/pic.jpg';
  const h = await createAssetIdHarness({ uuidByPath: {} });
  try {
    await h.svc.ingestAsset({ assetPath: pathA, force: true });
    const db = await h.storage.getDatabase();
    assert.deepEqual(Object.keys(db.assets), [pathA]);
  } finally {
    h.cleanup();
  }
});
