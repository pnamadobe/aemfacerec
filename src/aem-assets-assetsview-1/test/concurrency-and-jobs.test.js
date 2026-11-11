const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStorage } = require('../actions/lib/storage');
const { createFaceService } = require('../actions/lib/face-service');
const ingestAction = require('../actions/ingest/index');

const AEM = 'https://author-p12345-e67890.adobeaemcloud.com';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-g3-'));
}

async function createConcurrentHarness({ matchingGroupId = null, aemDelayMs = 0 } = {}) {
  const dir = makeTmpDir();
  const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
  await storage.saveSettings({ awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'secret' });

  let faceSeq = 0;
  const rekognitionClient = {
    async send(cmd) {
      const name = cmd.constructor.name.replace(/Command$/, '');
      if (name === 'IndexFaces') {
        const fId = `face-${++faceSeq}`;
        return {
          FaceRecords: [
            {
              Face: {
                FaceId: fId,
                Confidence: 99,
                BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.2, Height: 0.2 }
              }
            }
          ]
        };
      }
      if (name === 'SearchUsers') {
        if (matchingGroupId) {
          return { UserMatches: [{ User: { UserId: matchingGroupId }, Similarity: 98.5 }] };
        }
        return { UserMatches: [] };
      }
      return {};
    }
  };

  let aemWrites = 0;
  let resolveLookups = 0;
  const aemClient = {
    async checkFolderEligibility() {
      return { eligible: true };
    },
    async getAssetInfo(p) {
      return { assetId: `uuid-${p.split('/').pop()}`, assetPath: p, assetTitle: p.split('/').pop() };
    },
    async fetchAssetRenditionBuffer() {
      return Buffer.from('mock-image-bytes');
    },
    async updateAssetFaceMetadata(assetPath, payload) {
      aemWrites++;
      if (aemDelayMs) await new Promise((r) => setTimeout(r, aemDelayMs));
      return { updated: true, assetPath, metadata: payload };
    },
    async resolvePathByAssetUuid(uuid) {
      resolveLookups++;
      return `/content/dam/resolved/${uuid}.jpg`;
    }
  };

  // Separate storage instances pointing at the same directory simulate separate Runtime containers
  async function newServiceInstance() {
    const instStorage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
    return createFaceService({
      storage: instStorage,
      rekognitionClient,
      aemClient,
      retryOptions: { sleep: async () => {} }
    });
  }

  return {
    dir,
    storage,
    newServiceInstance,
    get aemWrites() {
      return aemWrites;
    },
    get resolveLookups() {
      return resolveLookups;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

// ---------------------------------------------------------------------------
// R1 / R3: Concurrent writes & record-level delta merging
// ---------------------------------------------------------------------------

test('R1: 5 parallel ingests across separate service instances preserve all 5 assets, faces, and groups (zero lost updates)', async () => {
  const h = await createConcurrentHarness();
  try {
    const services = await Promise.all(Array.from({ length: 5 }, () => h.newServiceInstance()));
    await Promise.all(
      services.map((svc, idx) =>
        svc.ingestAsset({
          assetPath: `/content/dam/parallel/photo-${idx}.jpg`,
          force: true
        })
      )
    );

    const db = await h.storage.getDatabase();
    assert.equal(Object.keys(db.assets).length, 5, 'all 5 assets persisted');
    assert.equal(Object.keys(db.faces).length, 5, 'all 5 faces persisted');
    assert.equal(Object.keys(db.groups).length, 5, 'all 5 groups persisted');
    const labels = Object.values(db.groups).map((g) => g.autoLabel).sort();
    assert.deepEqual(
      labels,
      ['Person #1', 'Person #2', 'Person #3', 'Person #4', 'Person #5'],
      'each concurrent group gets a unique Person #N label'
    );
    assert.equal(db.counters.nextPersonNumber, 6);
  } finally {
    h.cleanup();
  }
});

test('R1: concurrent ingests matching into the SAME existing group preserve all faceIds in that group', async () => {
  const h = await createConcurrentHarness();
  try {
    const seedSvc = await h.newServiceInstance();
    const first = await seedSvc.ingestAsset({ assetPath: '/content/dam/parallel/seed.jpg', force: true });
    const sharedGroupId = first.faces[0].groupId;

    // Now create a harness pointing at the same dir where every new face matches sharedGroupId
    const dir = h.dir;
    let seq = 100;
    const rekClient = {
      async send(cmd) {
        const name = cmd.constructor.name.replace(/Command$/, '');
        if (name === 'IndexFaces') {
          return {
            FaceRecords: [
              {
                Face: {
                  FaceId: `face-${++seq}`,
                  Confidence: 99,
                  BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.2, Height: 0.2 }
                }
              }
            ]
          };
        }
        if (name === 'SearchUsers') {
          return { UserMatches: [{ User: { UserId: sharedGroupId }, Similarity: 99 }] };
        }
        return {};
      }
    };
    const aemClient = {
      async checkFolderEligibility() {
        return { eligible: true };
      },
      async getAssetInfo(p) {
        return { assetId: `uuid-${p.split('/').pop()}`, assetPath: p, assetTitle: p.split('/').pop() };
      },
      async fetchAssetRenditionBuffer() {
        return Buffer.from('mock-image-bytes');
      },
      async updateAssetFaceMetadata(p, m) {
        return { updated: true, assetPath: p, metadata: m };
      }
    };

    const workers = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const st = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
        return createFaceService({ storage: st, rekognitionClient: rekClient, aemClient });
      })
    );

    await Promise.all(
      workers.map((svc, idx) =>
        svc.ingestAsset({ assetPath: `/content/dam/parallel/match-${idx}.jpg`, force: true })
      )
    );

    const db = await h.storage.getDatabase();
    assert.equal(db.groups[sharedGroupId].faceIds.length, 5, 'seed face + 4 concurrent matched faces');
  } finally {
    h.cleanup();
  }
});

test('R1: concurrent group rename and new-asset ingest both survive without clobbering each other', async () => {
  const h = await createConcurrentHarness();
  try {
    const svc1 = await h.newServiceInstance();
    const svc2 = await h.newServiceInstance();

    const initial = await svc1.ingestAsset({ assetPath: '/content/dam/parallel/one.jpg', force: true });
    const groupId = initial.faces[0].groupId;

    await Promise.all([
      svc1.renameGroup({ groupId, name: 'Concurrent Alice' }),
      svc2.ingestAsset({ assetPath: '/content/dam/parallel/two.jpg', force: true })
    ]);

    const db = await h.storage.getDatabase();
    assert.equal(db.groups[groupId].name, 'Concurrent Alice');
    assert.equal(Object.keys(db.assets).length, 2);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// R13: Read paths never write the database
// ---------------------------------------------------------------------------

test('R13: getAssetFaces resolving a UUID via QueryBuilder does NOT write to storage', async () => {
  const h = await createConcurrentHarness();
  try {
    const svc = await h.newServiceInstance();
    const db = await h.storage.getDatabase();
    db.assets['legacy-key'] = {
      assetId: 'legacy-key',
      assetPath: '/content/dam/resolved/uuid-999.jpg',
      faceIds: []
    };
    await h.storage.saveDatabase(db);

    const mtimeBefore = fs.statSync(path.join(h.dir, 'db/assets.json')).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));

    const res = await svc.getAssetFaces({ assetId: 'urn:aaid:aem:uuid-999' });
    assert.equal(res.scanned, true);
    assert.equal(h.resolveLookups, 1);

    const mtimeAfter = fs.statSync(path.join(h.dir, 'db/assets.json')).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, 'assets.json must not be rewritten during a read');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// R10: Event idempotency / deduplication
// ---------------------------------------------------------------------------

test('R10: duplicate I/O Events with the same event id are skipped on the second delivery', async () => {
  const prevCwd = process.cwd();
  const dir = makeTmpDir();
  const prevFetch = global.fetch;
  let aemCalls = 0;
  global.fetch = async (url) => {
    aemCalls++;
    if (String(url).includes('/api/assets/')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({ properties: { 'jcr:uuid': 'u-1', metadata: { 'dc:format': 'application/pdf' } } })
      };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' };
  };
  process.chdir(dir);
  try {
    const storage = await createStorage({});
    await storage.saveSettings({
      awsAccessKeyId: 'AKIA',
      awsSecretAccessKey: 'secret',
      requireProcessingProfile: false,
      enabledFolders: ['/content/dam']
    });

    const eventPayload = {
      AEM_HOST: AEM,
      event: {
        '@id': 'evt-12345-unique',
        'activitystreams:object': {
          'xdmAsset:path': '/content/dam/events/doc.pdf',
          'xdmAsset:asset_id': 'urn:aaid:aem:u-1',
          'xdmAsset:format': 'application/pdf'
        }
      }
    };

    const first = await ingestAction.main(eventPayload);
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.reasonCode, 'unsupported-type');

    // Second delivery of the exact same event id is short-circuited as duplicate-event
    const second = await ingestAction.main(eventPayload);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.skipped, true);
    assert.equal(second.body.reasonCode, 'duplicate-event');
    assert.equal(aemCalls, 0);
  } finally {
    process.chdir(prevCwd);
    global.fetch = prevFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R14: Time-budgeted metadata syncs & resumable resyncAllAssetsMetadata
// ---------------------------------------------------------------------------

test('R14: resyncAllAssetsMetadata stops cleanly when its time budget expires and resumes from nextSyncOffset', async () => {
  const h = await createConcurrentHarness({ aemDelayMs: 12 });
  try {
    const svc = await h.newServiceInstance();
    const db = await h.storage.getDatabase();
    for (let i = 0; i < 12; i++) {
      db.assets[`a-${i}`] = {
        assetId: `a-${i}`,
        assetPath: `/content/dam/bulk/img-${i}.jpg`,
        faceIds: []
      };
    }
    await h.storage.saveDatabase(db);

    // Tight budget (15ms): processes the first concurrency chunk (4 assets), then stops with hasMoreToSync
    const firstChunk = await svc.resyncAllAssetsMetadata({ offset: 0, timeBudgetMs: 15 });
    assert.equal(firstChunk.hasMoreToSync, true);
    assert.ok(firstChunk.syncedAssetCount >= 4 && firstChunk.syncedAssetCount < 12);
    assert.equal(firstChunk.nextSyncOffset, firstChunk.syncedAssetCount);
    assert.equal(firstChunk.remainingAssetCount, 12 - firstChunk.syncedAssetCount);

    // Resume from nextSyncOffset with generous budget to finish the rest
    const rest = await svc.resyncAllAssetsMetadata({
      offset: firstChunk.nextSyncOffset,
      timeBudgetMs: 5000
    });
    assert.equal(rest.hasMoreToSync, false);
    assert.equal(rest.nextSyncOffset, null);
    assert.equal(firstChunk.syncedAssetCount + rest.syncedAssetCount, 12);
  } finally {
    h.cleanup();
  }
});

test('R14: renameGroup persists the new name BEFORE syncing AEM metadata, so a tight time budget never loses the rename', async () => {
  const h = await createConcurrentHarness({ aemDelayMs: 15 });
  try {
    const svc = await h.newServiceInstance();
    const db = await h.storage.getDatabase();
    db.groups.g1 = {
      groupId: 'g1',
      name: null,
      autoLabel: 'Person #1',
      coverFaceId: 'f-0',
      faceIds: Array.from({ length: 10 }, (_, i) => `f-${i}`)
    };
    for (let i = 0; i < 10; i++) {
      db.faces[`f-${i}`] = {
        faceId: `f-${i}`,
        groupId: 'g1',
        assetId: `a-${i}`,
        assetPath: `/content/dam/rename/img-${i}.jpg`
      };
      db.assets[`a-${i}`] = {
        assetId: `a-${i}`,
        assetPath: `/content/dam/rename/img-${i}.jpg`,
        faceIds: [`f-${i}`]
      };
    }
    await h.storage.saveDatabase(db);

    const res = await svc.renameGroup({ groupId: 'g1', name: 'Saved First', timeBudgetMs: 10 });
    assert.equal(res.group.displayName, 'Saved First');
    assert.equal(res.hasMoreToSync, true);
    assert.ok(res.remainingAssetCount > 0);

    const reloaded = await h.storage.getDatabase();
    assert.equal(reloaded.groups.g1.name, 'Saved First');
  } finally {
    h.cleanup();
  }
});
