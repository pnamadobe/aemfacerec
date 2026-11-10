const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStorage } = require('../actions/lib/storage');
const { createFaceService } = require('../actions/lib/face-service');
const { PublicError } = require('../actions/lib/security');

// Adobe I/O Runtime rejects responses over 1 MB. Keep a safety margin.
const RESPONSE_BUDGET_BYTES = 900 * 1024;

function responseBytes(body) {
  return Buffer.byteLength(JSON.stringify({ statusCode: 200, body }));
}

/** A realistic 72px JPEG avatar is ~2-4 KB as a data URL; use 4 KB to be conservative. */
function fakeAvatar() {
  return `data:image/jpeg;base64,${crypto.randomBytes(3000).toString('base64')}`;
}

/**
 * Builds a large database directly in storage:
 * - `groupCount` groups, the first `namedCount` named
 * - `bigGroupFaces` faces in the first group, 2 faces in every other group
 * - one crowd asset with `crowdFaces` faces
 */
function buildLargeDb({ groupCount, namedCount, bigGroupFaces, crowdFaces }) {
  const db = { groups: {}, faces: {}, assets: {}, counters: { nextPersonNumber: groupCount + 1 } };
  let faceSeq = 0;
  const now = new Date().toISOString();

  function addFace(groupId, assetId) {
    const faceId = `face-${String(faceSeq++).padStart(6, '0')}`;
    db.faces[faceId] = {
      faceId,
      groupId,
      assetId,
      assetPath: `/content/dam/big/${assetId}.jpg`,
      assetTitle: `${assetId}.jpg`,
      boundingBox: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
      confidence: 99.5,
      matchConfidence: 97.1,
      avatarFile: `avatars/${faceId}.jpg`,
      avatarDataUrl: fakeAvatar(),
      createdAt: now
    };
    db.groups[groupId].faceIds.push(faceId);
    db.assets[assetId] = db.assets[assetId] || {
      assetId,
      assetPath: `/content/dam/big/${assetId}.jpg`,
      assetTitle: `${assetId}.jpg`,
      faceIds: [],
      scannedAt: now,
      updatedAt: now
    };
    db.assets[assetId].faceIds.push(faceId);
    return faceId;
  }

  for (let i = 0; i < groupCount; i++) {
    const groupId = `grp_${String(i).padStart(5, '0')}`;
    db.groups[groupId] = {
      groupId,
      name: i < namedCount ? `Person Name ${i}` : null,
      autoLabel: `Person #${i + 1}`,
      coverFaceId: null,
      faceIds: [],
      createdAt: now,
      updatedAt: now
    };
    const n = i === 0 ? bigGroupFaces : 2;
    for (let f = 0; f < n; f++) addFace(groupId, `asset-${i}-${f % 50}`);
    db.groups[groupId].coverFaceId = db.groups[groupId].faceIds[0];
  }

  // Crowd photo: many faces on one asset, each in its own group
  for (let c = 0; c < crowdFaces; c++) {
    const groupId = `grp_crowd_${c}`;
    db.groups[groupId] = {
      groupId,
      name: null,
      autoLabel: `Person #crowd${c}`,
      coverFaceId: null,
      faceIds: [],
      createdAt: now,
      updatedAt: now
    };
    db.groups[groupId].coverFaceId = addFace(groupId, 'crowd');
  }
  return db;
}

async function createHarness(db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-page-'));
  const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
  await storage.saveSettings({ awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'secret' });
  if (db) await storage.saveDatabase(db);
  const rekognitionClient = { async send() { return {}; } };
  const aemClient = {
    async updateAssetFaceMetadata(p, m) {
      return { updated: true, assetPath: p, metadata: m };
    }
  };
  const svc = await createFaceService({
    storage,
    rekognitionClient,
    aemClient,
    retryOptions: { sleep: async () => {} }
  });
  return { dir, storage, svc, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// One large dataset shared by the read-only tests (building it is the slow part)
let shared;
test.before(async () => {
  shared = await createHarness(
    buildLargeDb({ groupCount: 3000, namedCount: 40, bigGroupFaces: 1500, crowdFaces: 100 })
  );
});
test.after(() => shared && shared.cleanup());

// ---------------------------------------------------------------------------
// Response size: every read response stays under the 1 MB Runtime limit
// ---------------------------------------------------------------------------

test('P2: the old "everything in one response" shape would exceed 1 MB on this dataset', async () => {
  const db = await shared.storage.getDatabase();
  const oldStyle = Object.values(db.groups).map((g) => ({ ...g, faces: g.faceIds.map((id) => db.faces[id]) }));
  assert.ok(responseBytes({ groups: oldStyle }) > 10 * 1024 * 1024, 'dataset is large enough to be meaningful');
});

test('P2: listGroups stays under the response budget at default and maximum page size', async () => {
  for (const limit of [undefined, 60, 100, 100000]) {
    const res = await shared.svc.listGroups({ limit });
    const bytes = responseBytes(res);
    assert.ok(bytes < RESPONSE_BUDGET_BYTES, `limit=${limit}: ${bytes} bytes`);
    assert.ok(res.groups.length <= 100);
    for (const g of res.groups) assert.equal(g.faces, undefined, 'summaries must not include faces');
  }
});

test('P2: getGroup on a 1,500-face group stays under budget and pages faces', async () => {
  for (const faceLimit of [undefined, 100, 5000]) {
    const res = await shared.svc.getGroup({ groupId: 'grp_00000', faceLimit });
    const bytes = responseBytes(res);
    assert.ok(bytes < RESPONSE_BUDGET_BYTES, `faceLimit=${faceLimit}: ${bytes} bytes`);
    assert.ok(res.group.faces.length <= 100);
    assert.equal(res.group.faceCount, 1500);
    assert.equal(res.hasMoreFaces, true);
  }
});

test('P2: listGroupOptions for 3,100 groups stays under budget and has no images', async () => {
  const res = await shared.svc.listGroupOptions();
  assert.ok(responseBytes(res) < RESPONSE_BUDGET_BYTES, `${responseBytes(res)} bytes`);
  assert.equal(res.total, 3100);
  assert.equal(res.options.length, 2000);
  assert.equal(res.truncated, true);
  assert.deepEqual(Object.keys(res.options[0]).sort(), ['displayName', 'faceCount', 'groupId', 'isNamed']);
});

test('P2: getAssetFaces for a 100-face crowd photo stays under budget', async () => {
  const res = await shared.svc.getAssetFaces({ assetId: 'crowd' });
  assert.equal(res.faceCount, 100);
  assert.ok(responseBytes(res) < RESPONSE_BUDGET_BYTES, `${responseBytes(res)} bytes`);
});

// ---------------------------------------------------------------------------
// Paging, filtering and search behavior
// ---------------------------------------------------------------------------

test('paging visits every group exactly once, in a stable order, named people first', async () => {
  const seen = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const res = await shared.svc.listGroups({ offset, limit: 100 });
    seen.push(...res.groups);
    pages++;
    if (!res.hasMore) break;
    offset += res.groups.length;
  }
  assert.equal(pages, 31);
  assert.equal(seen.length, 3100);
  assert.equal(new Set(seen.map((g) => g.groupId)).size, 3100);
  assert.ok(seen.slice(0, 40).every((g) => g.isNamed));
  assert.ok(seen.slice(40).every((g) => !g.isNamed));
  // Biggest unnamed groups come first
  assert.ok(seen[40].faceCount >= seen[41].faceCount);

  const again = await shared.svc.listGroups({ offset: 500, limit: 100 });
  assert.deepEqual(again.groups.map((g) => g.groupId), seen.slice(500, 600).map((g) => g.groupId));
});

test('listGroups returns totals and counts regardless of filter', async () => {
  const res = await shared.svc.listGroups({ filter: 'named' });
  assert.equal(res.totalGroups, 3100);
  assert.equal(res.namedCount, 40);
  assert.equal(res.unnamedCount, 3060);
  assert.equal(res.matchedCount, 40);
  assert.equal(res.groups.length, 40);
  assert.equal(res.hasMore, false);
  assert.ok(res.groups.every((g) => g.isNamed));
  assert.equal(res.totalFaces, 1500 + 2999 * 2 + 100);

  const unnamed = await shared.svc.listGroups({ filter: 'unnamed', limit: 10 });
  assert.equal(unnamed.matchedCount, 3060);
  assert.ok(unnamed.groups.every((g) => !g.isNamed));
});

test('search is case-insensitive and matches name, placeholder label and id', async () => {
  const byName = await shared.svc.listGroups({ query: 'person name 1' });
  // "Person Name 1", "Person Name 10".."19"
  assert.equal(byName.matchedCount, 11);
  const byLabel = await shared.svc.listGroups({ query: 'PERSON #2999' });
  assert.deepEqual(byLabel.groups.map((g) => g.groupId), ['grp_02998']);
  const byId = await shared.svc.listGroups({ query: 'grp_crowd_7' });
  // Substring match: grp_crowd_7 and grp_crowd_70..79
  assert.equal(byId.matchedCount, 11);
  assert.ok(byId.groups.some((g) => g.groupId === 'grp_crowd_7'));
  const none = await shared.svc.listGroups({ query: 'nobody-matches-this' });
  assert.equal(none.matchedCount, 0);
  assert.deepEqual(none.groups, []);
  // Combined with a filter
  const namedSearch = await shared.svc.listGroups({ filter: 'unnamed', query: 'person name' });
  assert.equal(namedSearch.matchedCount, 0);
});

test('invalid paging input is clamped instead of failing', async () => {
  const res = await shared.svc.listGroups({ offset: -50, limit: 'abc', filter: 'bogus' });
  assert.equal(res.offset, 0);
  assert.equal(res.limit, 60);
  assert.equal(res.matchedCount, 3100);
  const past = await shared.svc.listGroups({ offset: 999999 });
  assert.deepEqual(past.groups, []);
  assert.equal(past.hasMore, false);
});

test('summaries carry the fields the UI needs', async () => {
  const [g] = (await shared.svc.listGroups({ query: 'grp_00000' })).groups;
  assert.equal(g.groupId, 'grp_00000');
  assert.equal(g.displayName, 'Person Name 0');
  assert.equal(g.isNamed, true);
  assert.equal(g.faceCount, 1500);
  assert.equal(g.assetCount, 50);
  assert.match(g.coverAvatarDataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(g.autoLabel, 'Person #1');
});

test('getGroup pages through all faces without gaps or duplicates', async () => {
  const ids = [];
  let faceOffset = 0;
  for (;;) {
    const res = await shared.svc.getGroup({ groupId: 'grp_00000', faceOffset, faceLimit: 100 });
    ids.push(...res.group.faces.map((f) => f.faceId));
    if (!res.hasMoreFaces) break;
    faceOffset += res.group.faces.length;
  }
  assert.equal(ids.length, 1500);
  assert.equal(new Set(ids).size, 1500);
  assert.ok(ids.every((id) => id));
});

test('getGroup for a missing group is a 404 PublicError', async () => {
  await assert.rejects(
    shared.svc.getGroup({ groupId: 'grp_missing' }),
    (err) => err instanceof PublicError && err.statusCode === 404
  );
});

test('listGroupOptions supports search', async () => {
  const res = await shared.svc.listGroupOptions({ query: 'Person Name 3' });
  assert.equal(res.total, 11);
  assert.equal(res.truncated, false);
});

// ---------------------------------------------------------------------------
// Mutation responses stay small too
// ---------------------------------------------------------------------------

test('P2: rename, split, move and merge responses never include all member faces', async () => {
  const h = await createHarness(
    buildLargeDb({ groupCount: 3, namedCount: 0, bigGroupFaces: 800, crowdFaces: 0 })
  );
  try {
    const rename = await h.svc.renameGroup({ groupId: 'grp_00000', name: 'Big Group' });
    assert.equal(rename.group.faces, undefined);
    assert.equal(rename.group.faceCount, 800);
    assert.ok(responseBytes({ ...rename, syncedAssets: [] }) < 50 * 1024);

    const db = await h.storage.getDatabase();
    const [f1, f2] = db.groups.grp_00000.faceIds;
    const split = await h.svc.splitFacesToNewGroup({ faceIds: [f1] });
    assert.equal(split.newGroup.faces, undefined);

    const move = await h.svc.moveFacesToGroup({ faceIds: [f2], targetGroupId: 'grp_00001' });
    assert.equal(move.targetGroup.faces, undefined);

    const merge = await h.svc.mergeGroups({ sourceGroupIds: ['grp_00001'], targetGroupId: 'grp_00000' });
    assert.equal(merge.targetGroup.faces, undefined);
    assert.equal(merge.targetGroup.faceCount, 798 + 3);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Runtime action wiring
// ---------------------------------------------------------------------------

test('groups action exposes paged listGroups, listGroupOptions and getGroup', async () => {
  const groupsAction = require('../actions/groups/index');
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-act-'));
  process.chdir(dir);
  try {
    const seed = await groupsAction.main({ operation: 'seedDemoData', ENABLE_MAINTENANCE_OPS: 'true' });
    assert.equal(seed.statusCode, 200);
    assert.equal(seed.body.totalGroups, 4);

    const page = await groupsAction.main({ operation: 'listGroups', offset: '1', limit: '2', filter: 'all' });
    assert.equal(page.statusCode, 200);
    assert.equal(page.body.groups.length, 2);
    assert.equal(page.body.offset, 1);
    assert.equal(page.body.hasMore, true);

    const named = await groupsAction.main({ operation: 'listGroups', filter: 'named', query: 'sarah' });
    assert.deepEqual(named.body.groups.map((g) => g.displayName), ['Sarah Jenkins']);

    const options = await groupsAction.main({ operation: 'listGroupOptions' });
    assert.equal(options.body.options.length, 4);

    const one = await groupsAction.main({ operation: 'getGroup', groupId: 'grp_sarah01', faceLimit: '1' });
    assert.equal(one.statusCode, 200);
    assert.equal(one.body.group.faces.length, 1);
    assert.equal(one.body.hasMoreFaces, true);

    const missing = await groupsAction.main({ operation: 'getGroup', groupId: 'nope' });
    assert.equal(missing.statusCode, 404);
    const noId = await groupsAction.main({ operation: 'getGroup' });
    assert.equal(noId.statusCode, 400);
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
