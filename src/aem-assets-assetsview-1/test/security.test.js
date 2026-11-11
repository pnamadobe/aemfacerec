const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PublicError,
  isAllowedAemHost,
  resolveAemHost,
  assertDamPath,
  isValidMetadataProperty,
  requireEncryptionSecret,
  errorResponse
} = require('../actions/lib/security');
const { buildActionContext } = require('../actions/lib/action-context');
const { createAemClient } = require('../actions/lib/aem');
const { createStorage } = require('../actions/lib/storage');
const { createFaceService } = require('../actions/lib/face-service');

const AEM = 'https://author-p12345-e67890.adobeaemcloud.com';

function mockResponse(status, body = '{}', contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
    async arrayBuffer() {
      return Buffer.from(body);
    }
  };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-sec-'));
}

/**
 * Runs `fn` with cwd switched to an isolated temp dir so actions using the local
 * storage backend never touch the repo (and never race other test files).
 */
async function inIsolatedCwd(fn) {
  const prev = process.cwd();
  const dir = makeTmpDir();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

test('S2: AEM host allowlist accepts AEMaaCS author hosts and rejects lookalikes', () => {
  assert.equal(isAllowedAemHost(AEM), true);
  assert.equal(isAllowedAemHost('author-p1-e2.adobeaemcloud.com'), true);
  assert.equal(isAllowedAemHost('https://author-p1-e2-cmstg.adobeaemcloud.com'), true);

  assert.equal(isAllowedAemHost('https://evil.example.com'), false);
  assert.equal(isAllowedAemHost('http://author-p1-e2.adobeaemcloud.com'), false);
  assert.equal(isAllowedAemHost('https://author-p1-e2.adobeaemcloud.com.evil.com'), false);
  assert.equal(isAllowedAemHost('https://author-p1-e2.adobeaemcloud.com@evil.com'), false);
  assert.equal(isAllowedAemHost('https://author-p1-e2.adobeaemcloud.com/some/path'), false);
  assert.equal(isAllowedAemHost(''), false);

  assert.equal(isAllowedAemHost('https://aem.internal.corp', 'https://aem.internal.corp'), true);
});

test('S2: resolveAemHost trusts configured host and rejects non-allowlisted request hosts', () => {
  assert.deepEqual(resolveAemHost({ AEM_HOST: AEM }), { aemHost: AEM, isConfiguredHost: true });
  assert.deepEqual(resolveAemHost({ AEM_HOST: AEM, aemHost: `${AEM}/` }), {
    aemHost: AEM,
    isConfiguredHost: true
  });
  assert.deepEqual(
    resolveAemHost({ AEM_HOST: AEM, aemHost: 'https://author-p9-e9.adobeaemcloud.com' }),
    { aemHost: 'https://author-p9-e9.adobeaemcloud.com', isConfiguredHost: false }
  );
  assert.throws(
    () => resolveAemHost({ AEM_HOST: AEM, aemHost: 'https://evil.example.com' }),
    PublicError
  );
});

test('S6: DAM paths are confined to /content/dam with no traversal', () => {
  assert.equal(assertDamPath('/content/dam/a/b.jpg'), '/content/dam/a/b.jpg');
  assert.equal(assertDamPath('content/dam/a/'), '/content/dam/a');
  assert.equal(assertDamPath('/content/dam'), '/content/dam');

  for (const bad of [
    '/content/dam/../../etc/passwd',
    '/content/dam/./x',
    '/content/dam//x',
    '/content/damx/file.jpg',
    '/etc/packages/x.zip',
    '/libs/granite',
    '/content/dam/a\u0000b',
    '',
    null
  ]) {
    assert.throws(() => assertDamPath(bad), PublicError, `expected rejection for ${bad}`);
  }
});

test('S5: metadata property names are restricted to safe namespaced names', () => {
  assert.equal(isValidMetadataProperty('xdm:faceNames'), true);
  assert.equal(isValidMetadataProperty('acme:people_in_photo'), true);

  for (const bad of [
    '../../jcr:content/foo',
    './xdm:faceNames',
    'xdm:faceNames@Delete',
    'xdm:faceNames@TypeHint',
    'jcr:primaryType',
    'sling:resourceType',
    'rep:policy',
    'faceNames',
    'xdm:face Names',
    ':faceNames',
    42
  ]) {
    assert.equal(isValidMetadataProperty(bad), false, `expected rejection for ${bad}`);
  }
});

test('S4: encryption secret is mandatory and non-default inside Runtime', async () => {
  await withEnv({ __OW_NAMESPACE: 'test-ns', __OW_ACTION_NAME: undefined }, async () => {
    assert.throws(() => requireEncryptionSecret(''));
    assert.throws(() => requireEncryptionSecret('default-aem-facerec-secret-key'));
    assert.throws(() => requireEncryptionSecret('change-me-to-a-32-byte-secret-key!'));
    assert.throws(() => requireEncryptionSecret('short'));
    assert.equal(requireEncryptionSecret('a-sufficiently-long-random-secret'), 'a-sufficiently-long-random-secret');
  });
  await withEnv({ __OW_NAMESPACE: undefined, __OW_ACTION_NAME: undefined }, async () => {
    // Local development still works without a secret
    assert.ok(requireEncryptionSecret(''));
  });
});

test('Errors: unexpected errors are hidden behind a reference id; PublicErrors are returned', () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const hidden = errorResponse(
      new Error(`AEM request failed (HTTP 500) for ${AEM}/content/dam/secret.jpg`),
      {}
    );
    assert.equal(hidden.statusCode, 500);
    assert.ok(!hidden.body.error.includes('adobeaemcloud'));
    assert.match(hidden.body.error, /ref: [0-9a-f]{12}/);
  } finally {
    console.error = origError;
  }

  const shown = errorResponse(new PublicError('Face Group not found.', 404), {});
  assert.equal(shown.statusCode, 404);
  assert.equal(shown.body.error, 'Face Group not found.');
});

// ---------------------------------------------------------------------------
// Action context / credentials handling
// ---------------------------------------------------------------------------

test('S2/S3/S7: web invocations never receive technical-account credentials', () => {
  const webCtx = buildActionContext({
    __ow_method: 'post',
    __ow_headers: { authorization: 'Bearer user-token' },
    AEM_HOST: AEM,
    AEM_SC_JSON: 'c2VjcmV0',
    AEM_DEV_TOKEN: 'dev-token'
  });
  assert.equal(webCtx.token, 'user-token');
  assert.equal(webCtx.serviceCredentials, null);

  const eventCtx = buildActionContext({ AEM_HOST: AEM, AEM_DEV_TOKEN: 'dev-token' });
  assert.equal(eventCtx.token, '');
  assert.deepEqual(eventCtx.serviceCredentials, { scJson: '', devToken: 'dev-token' });

  // Event invocation pointed at a non-configured host gets no service credentials either
  const redirected = buildActionContext({
    AEM_HOST: AEM,
    aemHost: 'https://author-p9-e9.adobeaemcloud.com',
    AEM_DEV_TOKEN: 'dev-token'
  });
  assert.equal(redirected.serviceCredentials, null);
});

test('S9: tokens passed as a body/query parameter are ignored', () => {
  const ctx = buildActionContext({ __ow_method: 'post', __ow_headers: {}, token: 'leaky', AEM_HOST: AEM });
  assert.equal(ctx.token, '');
});

test('S1: anonymous web requests are rejected inside Runtime (while I/O Events webhook payloads are accepted onto the force=false path)', async () => {
  const groupsAction = require('../actions/groups/index');
  const ingestAction = require('../actions/ingest/index');
  await withEnv({ __OW_NAMESPACE: 'test-ns' }, async () => {
    const res = await groupsAction.main({
      __ow_method: 'post',
      __ow_headers: {},
      operation: 'listGroups',
      AEM_HOST: AEM,
      ENCRYPTION_SECRET: 'a-sufficiently-long-random-secret'
    });
    assert.equal(res.statusCode, 401);

    const unauthScan = await ingestAction.main({
      __ow_method: 'post',
      __ow_headers: {},
      operation: 'scanFolder',
      folderPath: '/content/dam',
      AEM_HOST: AEM,
      ENCRYPTION_SECRET: 'a-sufficiently-long-random-secret'
    });
    assert.equal(unauthScan.statusCode, 401);

    // Adobe I/O Events webhook challenge and event payload are accepted on the web action
    const challengeRes = await ingestAction.main({
      __ow_method: 'get',
      __ow_headers: {},
      challenge: 'webhook-challenge-abc'
    });
    assert.equal(challengeRes.statusCode, 200);
    assert.equal(challengeRes.body.challenge, 'webhook-challenge-abc');

    const ioEvtCtx = buildActionContext({
      __ow_method: 'post',
      __ow_headers: {},
      AEM_HOST: AEM,
      aemHost: 'https://evil.example.com',
      AEM_DEV_TOKEN: 'svc-token',
      event: {
        '@id': 'evt-1',
        'activitystreams:object': { 'xdmAsset:path': '/content/dam/test/a.jpg' }
      }
    });
    assert.equal(ioEvtCtx.isIoEvent, true);
    assert.equal(ioEvtCtx.aemHost, AEM, 'I/O Event webhook cannot override configured AEM_HOST');
    assert.deepEqual(ioEvtCtx.serviceCredentials, { scJson: '', devToken: 'svc-token' });
  });
});

test('S1: destructive maintenance operations are disabled unless the deployment enables them', async () => {
  const groupsAction = require('../actions/groups/index');
  for (const operation of ['seedDemoData', 'clearAllData', 'exportSnapshot', 'importSnapshot']) {
    const res = await groupsAction.main({ operation, AEM_HOST: AEM });
    assert.equal(res.statusCode, 403, operation);
  }
});

test('S2: actions reject a caller-supplied non-allowlisted aemHost', async () => {
  const groupsAction = require('../actions/groups/index');
  const ingestAction = require('../actions/ingest/index');
  const res1 = await groupsAction.main({ operation: 'listGroups', AEM_HOST: AEM, aemHost: 'https://evil.example.com' });
  assert.equal(res1.statusCode, 400);
  const res2 = await ingestAction.main({
    operation: 'browseFolder',
    folderPath: '/content/dam',
    AEM_HOST: AEM,
    aemHost: 'evil.example.com'
  });
  assert.equal(res2.statusCode, 400);
});

test('S7: actions do not mutate process.env', async () => {
  const groupsAction = require('../actions/groups/index');
  await inIsolatedCwd(async () => {
    await withEnv(
      { AEM_SC_JSON: undefined, AEM_DEV_TOKEN: undefined, AEM_HOST: undefined, AEM_AUTHOR_URL: undefined },
      async () => {
        await groupsAction.main({
          operation: 'listGroups',
          AEM_HOST: AEM,
          AEM_SC_JSON: 'c2VjcmV0',
          AEM_DEV_TOKEN: 'dev-token'
        });
        assert.equal(process.env.AEM_SC_JSON, undefined);
        assert.equal(process.env.AEM_DEV_TOKEN, undefined);
        assert.equal(process.env.AEM_HOST, undefined);
      }
    );
  });
});

test('S6: scan/browse operations reject paths outside the DAM', async () => {
  const ingestAction = require('../actions/ingest/index');
  await inIsolatedCwd(async () => {
    const res = await ingestAction.main({
      operation: 'scanFolder',
      folderPath: '/content/dam/../../etc',
      AEM_HOST: AEM
    });
    assert.equal(res.statusCode, 400);
    const res2 = await ingestAction.main({ operation: 'browseFolder', folderPath: '/apps', AEM_HOST: AEM });
    assert.equal(res2.statusCode, 400);
  });
});

// ---------------------------------------------------------------------------
// AEM client
// ---------------------------------------------------------------------------

test('S3: a rejected user token is never retried with the technical account token', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    return mockResponse(403, 'forbidden', 'text/plain');
  };
  const aem = createAemClient({
    aemHost: AEM,
    token: 'user-token',
    fetchImpl,
    serviceCredentials: { devToken: 'service-token' }
  });

  await assert.rejects(() => aem.browseDamFolder('/content/dam/private'));
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.equal(c.auth, 'Bearer user-token');
  }
});

test('S2/S3: service credentials are only used when explicitly provided and no user token exists', async () => {
  const auths = [];
  const fetchImpl = async (url, opts) => {
    auths.push(opts.headers.Authorization);
    return mockResponse(200, JSON.stringify({ entities: [] }));
  };

  await createAemClient({ aemHost: AEM, fetchImpl }).browseDamFolder('/content/dam');
  assert.equal(auths.pop(), undefined);

  await createAemClient({ aemHost: AEM, fetchImpl, serviceCredentials: { devToken: 'svc' } }).browseDamFolder(
    '/content/dam'
  );
  assert.equal(auths.pop(), 'Bearer svc');
});

test('S6: AEM client refuses non-DAM paths before making any request', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return mockResponse(200, 'x', 'image/jpeg');
  };
  const aem = createAemClient({ aemHost: AEM, token: 't', fetchImpl });

  await assert.rejects(() => aem.fetchAssetRenditionBuffer('/etc/keys/private'), PublicError);
  await assert.rejects(() => aem.browseDamFolder('/content/dam/../../apps'), PublicError);
  await assert.rejects(() => aem.getAssetInfo('/libs/x'), PublicError);
  await assert.rejects(
    () => aem.updateAssetFaceMetadata('/conf/global', { faceNames: ['x'] }),
    PublicError
  );
  assert.equal(await aem.resolvePathByAssetUuid('/etc/passwd'), null);
  assert.equal(await aem.resolvePathByAssetUuid('abc" OR 1=1'), null);
  assert.equal(called, false);
});

test('S5: metadata writes reject unsafe property names before contacting AEM', async () => {
  let called = false;
  const aem = createAemClient({
    aemHost: AEM,
    token: 't',
    fetchImpl: async () => {
      called = true;
      return mockResponse(200);
    }
  });
  await assert.rejects(
    () =>
      aem.updateAssetFaceMetadata('/content/dam/a.jpg', {
        faceNames: ['Alice'],
        metadataProperty: '../../jcr:content/sling:resourceType'
      }),
    PublicError
  );
  assert.equal(called, false);
});

test('R8: metadata write failure is reported instead of silently returning updated:true', async () => {
  const aem = createAemClient({
    aemHost: AEM,
    token: 't',
    fetchImpl: async () => mockResponse(500, 'err', 'text/plain')
  });
  await assert.rejects(() =>
    aem.updateAssetFaceMetadata('/content/dam/a.jpg', { faceNames: ['Alice'], faceGroupIds: ['g'], faceCount: 1 })
  );

  const ok = createAemClient({ aemHost: AEM, token: 't', fetchImpl: async () => mockResponse(200) });
  const res = await ok.updateAssetFaceMetadata('/content/dam/a.jpg', {
    faceNames: ['Alice'],
    secondaryMetadataProperty: 'iptc4xmpExt:PersonInImage'
  });
  assert.equal(res.updated, true);
  assert.deepEqual(res.metadata['xdm:faceNames'], ['Alice']);
  assert.deepEqual(res.metadata['iptc4xmpExt:PersonInImage'], ['Alice']);
});

test('Folder eligibility uses segment-aware prefix matching', async () => {
  const aem = createAemClient({ aemHost: '', token: '' });
  const settings = { requireProcessingProfile: false, enabledFolders: ['/content/dam/events'] };
  assert.equal((await aem.checkFolderEligibility('/content/dam/events/a.jpg', settings)).eligible, true);
  assert.equal((await aem.checkFolderEligibility('/content/dam/events-private/a.jpg', settings)).eligible, false);
});

// ---------------------------------------------------------------------------
// Storage robustness
// ---------------------------------------------------------------------------

test('R2: a corrupt database file raises an error instead of being treated as empty', async () => {
  const dir = makeTmpDir();
  try {
    const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
    // Missing files still yield empty defaults
    const empty = await storage.getDatabase();
    assert.deepEqual(empty.groups, {});

    await storage.saveDatabase({ groups: { g1: { groupId: 'g1' } }, faces: {}, assets: {}, counters: { nextPersonNumber: 2 } });
    fs.writeFileSync(path.join(dir, 'db/faces.json'), '{"truncated": ');

    await assert.rejects(() => storage.getDatabase(), /corrupt/);
    // The good file must be untouched
    const groupsRaw = JSON.parse(fs.readFileSync(path.join(dir, 'db/groups.json'), 'utf8'));
    assert.deepEqual(groupsRaw, { g1: { groupId: 'g1' } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R4: Runtime never silently falls back to ephemeral /tmp storage', async () => {
  await withEnv({ __OW_NAMESPACE: 'test-ns' }, async () => {
    // Neither aio-lib-files nor aio-lib-state can initialise without Runtime credentials here
    await assert.rejects(() =>
      createStorage({ encryptionSecret: 'a-sufficiently-long-random-secret' })
    );
  });
});

test('S5/S6: saveSettings validates metadata property, region, collection and folders', async () => {
  const dir = makeTmpDir();
  try {
    const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
    await assert.rejects(() => storage.saveSettings({ metadataProperty: '../../jcr:content/x' }), PublicError);
    await assert.rejects(() => storage.saveSettings({ metadataProperty: 'jcr:title' }), PublicError);
    await assert.rejects(() => storage.saveSettings({ awsRegion: 'evil.com/' }), PublicError);
    await assert.rejects(() => storage.saveSettings({ collectionId: 'a/b' }), PublicError);
    await assert.rejects(() => storage.saveSettings({ enabledFolders: ['/apps'] }), PublicError);

    const saved = await storage.saveSettings({
      metadataProperty: 'acme:people',
      awsRegion: 'eu-west-1',
      collectionId: 'my-faces',
      enabledFolders: ['/content/dam/events/']
    });
    assert.equal(saved.metadataProperty, 'acme:people');
    assert.equal(saved.awsRegion, 'eu-west-1');
    assert.deepEqual(saved.enabledFolders, ['/content/dam/events']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S1/S4: snapshot export omits credentials and import cannot overwrite settings', async () => {
  const dir = makeTmpDir();
  try {
    const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
    await storage.saveSettings({ awsAccessKeyId: 'AKIAREAL', awsSecretAccessKey: 'real-secret-value' });

    const snapshot = await storage.exportRawSnapshot();
    assert.equal(snapshot.settingsRaw.awsSecretAccessKeyEncrypted, undefined);
    assert.equal(snapshot.settingsRaw.awsAccessKeyId, undefined);

    await storage.importRawSnapshot({
      groups: {},
      settingsRaw: { awsAccessKeyId: 'AKIAATTACKER', awsSecretAccessKeyEncrypted: '' }
    });
    const after = await storage.getSettings();
    assert.equal(after.awsAccessKeyId, 'AKIAREAL');
    assert.equal(after.hasAwsSecretKey, true);

    await assert.rejects(() => storage.importRawSnapshot({ faces: 'not-an-object' }), PublicError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S4: secrets encrypted with one key cannot be read with another, and that does not break the app', async () => {
  const dir = makeTmpDir();
  try {
    const a = await createStorage({ localDir: dir, encryptionSecret: 'first-secret-value-123' });
    await a.saveSettings({ awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'aws-secret' });
    await a.saveDatabase({ groups: {}, faces: {}, assets: {}, counters: { nextPersonNumber: 1 } });

    const b = await createStorage({ localDir: dir, encryptionSecret: 'other-secret-value-456' });
    const s = await b.getSettings({ includeDecryptedSecret: true });
    assert.equal(s.awsSecretAccessKey, '');
    assert.equal(s.hasAwsSecretKey, false);
    assert.equal(s.awsSecretKeyUnreadable, true);

    // Read paths used by the side panel and admin console keep working
    const svc = await createFaceService({ storage: b, aemClient: {} });
    const faces = await svc.getAssetFaces({ assetPath: '/content/dam/a.jpg' });
    assert.equal(faces.scanned, false);
    await svc.listGroups();

    // Operations that need AWS explain how to recover
    await assert.rejects(
      () =>
        svc.ingestAsset({
          assetPath: '/content/dam/a.jpg',
          assetId: 'id-a',
          imageBuffer: Buffer.from('x'),
          force: true
        }),
      (err) => err instanceof PublicError && /re-enter/.test(err.message)
    );

    // Re-entering the secret with the current key recovers
    await b.saveSettings({ awsSecretAccessKey: 'aws-secret-2' });
    const fixed = await b.getSettings({ includeDecryptedSecret: true });
    assert.equal(fixed.awsSecretAccessKey, 'aws-secret-2');
    assert.equal(fixed.awsSecretKeyUnreadable, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Avatar storage rejects path-like face ids', async () => {
  const dir = makeTmpDir();
  try {
    const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
    await assert.rejects(() => storage.saveAvatar('../../escape', Buffer.from('x')));
    const p = await storage.saveAvatar('a1b2c3d4-0000-1111-2222-333344445555', Buffer.from('x'));
    assert.equal(p, 'avatars/a1b2c3d4-0000-1111-2222-333344445555.jpg');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Face service
// ---------------------------------------------------------------------------

test('R12: new face group ids carry 128 bits of randomness', async () => {
  const dir = makeTmpDir();
  try {
    const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
    await storage.saveSettings({ awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'secret' });
    const rekognitionClient = {
      async send(cmd) {
        if (cmd.constructor.name === 'IndexFacesCommand') {
          return {
            FaceRecords: [{ Face: { FaceId: 'f-1', Confidence: 99, BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.2, Height: 0.2 } } }]
          };
        }
        return {};
      }
    };
    const aemClient = {
      async checkFolderEligibility() {
        return { eligible: true };
      },
      async fetchAssetRenditionBuffer() {
        return Buffer.from('not-an-image');
      },
      async updateAssetFaceMetadata(p, m) {
        return { updated: true, assetPath: p, metadata: m };
      }
    };
    const svc = await createFaceService({ storage, rekognitionClient, aemClient });
    const res = await svc.ingestAsset({ assetPath: '/content/dam/a.jpg', assetId: 'id-a', force: true });
    assert.match(res.faces[0].groupId, /^grp_[0-9a-f]{32}$/);

    await assert.rejects(
      () => svc.ingestAsset({ assetPath: '/content/dam/../../etc/x.jpg', assetId: 'id-b', force: true }),
      PublicError
    );
    await assert.rejects(() => svc.renameGroup({ groupId: res.faces[0].groupId, name: 'x'.repeat(201) }), PublicError);
    await assert.rejects(() => svc.renameGroup({ groupId: 'missing', name: 'x' }), PublicError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
