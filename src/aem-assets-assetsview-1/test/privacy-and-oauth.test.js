const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAemClient, getServiceToken } = require('../actions/lib/aem');
const { createStorage } = require('../actions/lib/storage');
const { createFaceService } = require('../actions/lib/face-service');
const { PublicError } = require('../actions/lib/security');
const groupsAction = require('../actions/groups/index');

const AEM = 'https://author-p12345-e67890.adobeaemcloud.com';

// ---------------------------------------------------------------------------
// S9: OAuth Server-to-Server credentials support
// ---------------------------------------------------------------------------

test('S9: getServiceToken exchanges OAuth Server-to-Server credentials via /ims/token/v3 and caches the token', async () => {
  const oauthConfig = {
    clientId: 'oauth-client-id-123',
    clientSecrets: ['oauth-client-secret-xyz'],
    scopes: ['openid', 'AdobeID', 'aem.assets.author'],
    imsEndpoint: 'ims-na1.adobelogin.com'
  };
  const scJsonB64 = Buffer.from(JSON.stringify(oauthConfig), 'utf8').toString('base64');

  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method, body: String(opts.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return { access_token: 'oauth-s2s-token-999', expires_in: 3600 };
      }
    };
  };

  const token1 = await getServiceToken(fetchImpl, { scJson: scJsonB64 });
  assert.equal(token1, 'oauth-s2s-token-999');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ims-na1.adobelogin.com/ims/token/v3');
  assert.equal(calls[0].method, 'POST');
  const params = new URLSearchParams(calls[0].body);
  assert.equal(params.get('grant_type'), 'client_credentials');
  assert.equal(params.get('client_id'), 'oauth-client-id-123');
  assert.equal(params.get('client_secret'), 'oauth-client-secret-xyz');
  assert.equal(params.get('scope'), 'openid,AdobeID,aem.assets.author');

  // Cached on second call
  const token2 = await getServiceToken(fetchImpl, { scJson: scJsonB64 });
  assert.equal(token2, 'oauth-s2s-token-999');
  assert.equal(calls.length, 1);
});

test('S9: createAemClient attaches OAuth Server-to-Server token on event/service requests', async () => {
  const rawJson = JSON.stringify({
    client_id: 's2s-client',
    client_secret: 's2s-secret',
    scope: 'openid,AdobeID,aem.assets.author'
  });
  const authHeaders = [];
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('/ims/token/v3')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: 's2s-bearer-token', expires_in: 3600 };
        }
      };
    }
    authHeaders.push(opts.headers?.Authorization);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      async text() {
        return JSON.stringify({ entities: [] });
      }
    };
  };

  const aem = createAemClient({
    aemHost: AEM,
    fetchImpl,
    serviceCredentials: { scJson: rawJson }
  });
  await aem.browseDamFolder('/content/dam');
  assert.deepEqual(authHeaders, ['Bearer s2s-bearer-token']);
});

// ---------------------------------------------------------------------------
// S10: Per-person erasure (deleteGroup) & full clearAllData cleanup
// ---------------------------------------------------------------------------

async function createErasureHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-s10-'));
  const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
  await storage.saveSettings({ awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'secret' });

  const rekCalls = [];
  let seq = 0;
  const rekognitionClient = {
    async send(cmd) {
      const name = cmd.constructor.name.replace(/Command$/, '');
      rekCalls.push({ name, input: cmd.input });
      if (name === 'IndexFaces') {
        return {
          FaceRecords: [
            {
              Face: {
                FaceId: `face-${++seq}`,
                Confidence: 99,
                BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.2, Height: 0.2 }
              }
            },
            {
              Face: {
                FaceId: `face-${++seq}`,
                Confidence: 98,
                BoundingBox: { Left: 0.5, Top: 0.1, Width: 0.2, Height: 0.2 }
              }
            }
          ]
        };
      }
      if (name === 'SearchUsers') return { UserMatches: [] };
      return {};
    }
  };

  const aemUpdates = {};
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
      aemUpdates[p] = m;
      return { updated: true, assetPath: p, metadata: m };
    }
  };

  const svc = await createFaceService({
    storage,
    rekognitionClient,
    aemClient,
    retryOptions: { sleep: async () => {} }
  });

  return {
    dir,
    storage,
    svc,
    rekCalls,
    aemUpdates,
    avatarExists(faceId) {
      return fs.existsSync(path.join(dir, 'avatars', `${faceId}.jpg`));
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

test('S10: deleteGroup removes the group, deletes Rekognition User + Face vectors, deletes avatars, and updates AEM metadata', async () => {
  const h = await createErasureHarness();
  try {
    const assetPath = '/content/dam/events/pair.jpg';
    const ingested = await h.svc.ingestAsset({ assetPath, force: true });
    assert.equal(ingested.faces.length, 2);

    const [faceA, faceB] = ingested.faces;
    await h.svc.renameGroup({ groupId: faceA.groupId, name: 'Forget Me' });
    await h.svc.renameGroup({ groupId: faceB.groupId, name: 'Keep Me' });
    assert.deepEqual(h.aemUpdates[assetPath].faceNames.sort(), ['Forget Me', 'Keep Me']);
    assert.equal(h.avatarExists(faceA.faceId), true);
    assert.equal(h.avatarExists(faceB.faceId), true);

    h.rekCalls.length = 0;
    const delRes = await h.svc.deleteGroup({ groupId: faceA.groupId });
    assert.equal(delRes.deletedGroupId, faceA.groupId);
    assert.equal(delRes.deletedDisplayName, 'Forget Me');
    assert.equal(delRes.deletedFaceCount, 1);
    assert.equal(delRes.syncedAssetCount, 1);

    // Rekognition disassociate + deleteUser + deleteFaces called for faceA
    assert.ok(
      h.rekCalls.some((c) => c.name === 'DisassociateFaces' && c.input.UserId === faceA.groupId)
    );
    assert.ok(h.rekCalls.some((c) => c.name === 'DeleteUser' && c.input.UserId === faceA.groupId));
    assert.ok(
      h.rekCalls.some((c) => c.name === 'DeleteFaces' && c.input.FaceIds.includes(faceA.faceId))
    );

    // Avatar deleted for faceA, kept for faceB
    assert.equal(h.avatarExists(faceA.faceId), false);
    assert.equal(h.avatarExists(faceB.faceId), true);

    // Database and AEM metadata updated to only include 'Keep Me'
    const db = await h.storage.getDatabase();
    assert.equal(db.groups[faceA.groupId], undefined);
    assert.equal(db.faces[faceA.faceId], undefined);
    assert.deepEqual(db.assets['uuid-pair.jpg'].faceIds, [faceB.faceId]);
    assert.deepEqual(h.aemUpdates[assetPath].faceNames, ['Keep Me']);

    // Deleting a non-existent group throws 404 PublicError
    await assert.rejects(
      () => h.svc.deleteGroup({ groupId: 'grp_missing' }),
      (err) => err instanceof PublicError && err.statusCode === 404
    );
  } finally {
    h.cleanup();
  }
});

test('S10: clearAllData purges Rekognition Users, Face vectors, and avatar files before wiping the database', async () => {
  const h = await createErasureHarness();
  try {
    const ingested = await h.svc.ingestAsset({
      assetPath: '/content/dam/events/clear-test.jpg',
      force: true
    });
    const faceIds = ingested.faces.map((f) => f.faceId);
    for (const fId of faceIds) assert.equal(h.avatarExists(fId), true);

    h.rekCalls.length = 0;
    await h.svc.clearAllData();

    assert.ok(h.rekCalls.some((c) => c.name === 'DeleteUser'));
    assert.ok(
      h.rekCalls.some(
        (c) => c.name === 'DeleteFaces' && faceIds.every((id) => c.input.FaceIds.includes(id))
      )
    );
    for (const fId of faceIds) assert.equal(h.avatarExists(fId), false);

    const db = await h.storage.getDatabase();
    assert.deepEqual(db.groups, {});
    assert.deepEqual(db.faces, {});
    assert.deepEqual(db.assets, {});
  } finally {
    h.cleanup();
  }
});

test('S10: groups Runtime action exposes deleteGroup and validates groupId', async () => {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-del-act-'));
  process.chdir(dir);
  try {
    const storage = await createStorage({});
    await storage.saveSettings({ awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'secret' });
    await groupsAction.main({ operation: 'seedDemoData', ENABLE_MAINTENANCE_OPS: 'true' });

    const missingId = await groupsAction.main({ operation: 'deleteGroup' });
    assert.equal(missingId.statusCode, 400);

    const notFound = await groupsAction.main({ operation: 'deleteGroup', groupId: 'grp_nope' });
    assert.equal(notFound.statusCode, 404);
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
