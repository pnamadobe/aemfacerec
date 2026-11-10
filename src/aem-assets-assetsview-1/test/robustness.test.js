const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

const {
  withRetry,
  mapWithConcurrency,
  isRetryableAwsError,
  computeBackoff
} = require('../actions/lib/retry');
const { createRekognitionService } = require('../actions/lib/rekognition');
const { createAemClient, parseRetryAfterMs, MAX_IMAGE_BYTES } = require('../actions/lib/aem');
const { decodeImageBuffer, cropFaceAvatar } = require('../actions/lib/cropper');
const { createStorage } = require('../actions/lib/storage');
const { createFaceService } = require('../actions/lib/face-service');
const { PublicError } = require('../actions/lib/security');

const AEM = 'https://author-p12345-e67890.adobeaemcloud.com';
const noSleep = async () => {};

function awsError(name, httpStatusCode = 400) {
  const err = new Error(name);
  err.name = name;
  err.$metadata = { httpStatusCode };
  return err;
}

function mockResponse(status, { body = '{}', headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => lower[h.toLowerCase()] ?? null },
    async text() {
      return typeof body === 'string' ? body : body.toString();
    },
    async json() {
      return JSON.parse(body);
    },
    async arrayBuffer() {
      return Buffer.from(body);
    }
  };
}

function quietConsole() {
  const orig = console.error;
  console.error = () => {};
  return () => {
    console.error = orig;
  };
}

// ---------------------------------------------------------------------------
// Scriptable test harness for the face service
// ---------------------------------------------------------------------------

/**
 * Mock Rekognition client. `script[cmdName]` may be a function (input, nth) => result | throw.
 * Default behavior: IndexFaces returns `nextFaces`, searches return no matches, others succeed.
 */
function createMockRekognition() {
  const calls = [];
  const counts = {};
  const script = {};
  let nextFaces = [];

  const client = {
    async send(command) {
      const cmd = command.constructor.name.replace(/Command$/, '');
      counts[cmd] = (counts[cmd] || 0) + 1;
      calls.push({ cmd, input: command.input });
      if (script[cmd]) return script[cmd](command.input, counts[cmd]);
      if (cmd === 'DescribeCollection') return { FaceCount: 0, UserCount: 0 };
      if (cmd === 'IndexFaces') {
        return {
          FaceRecords: nextFaces.map((faceId, i) => ({
            Face: {
              FaceId: faceId,
              Confidence: 99,
              BoundingBox: { Left: 0.1 + i * 0.3, Top: 0.2, Width: 0.2, Height: 0.2 }
            }
          }))
        };
      }
      if (cmd === 'SearchUsers') return { UserMatches: [] };
      if (cmd === 'SearchFaces') return { FaceMatches: [] };
      return {};
    }
  };

  return {
    client,
    calls,
    script,
    count: (cmd) => calls.filter((c) => c.cmd === cmd).length,
    inputsOf: (cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.input),
    setNextFaces(ids) {
      nextFaces = ids;
    },
    reset() {
      calls.length = 0;
      for (const k of Object.keys(counts)) delete counts[k];
      for (const k of Object.keys(script)) delete script[k];
    }
  };
}

function createMockAem() {
  const writes = [];
  const failPaths = new Set();
  let inFlight = 0;
  let maxInFlight = 0;
  let writeDelayMs = 0;

  return {
    client: {
      async checkFolderEligibility() {
        return { eligible: true };
      },
      async getAssetInfo(p) {
        return { assetId: `id:${p}`, assetPath: p, assetTitle: p.split('/').pop() };
      },
      async fetchAssetRenditionBuffer() {
        return Buffer.from('mock-image-bytes');
      },
      async updateAssetFaceMetadata(assetPath, payload) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
          if (failPaths.has(assetPath)) {
            throw new Error(`AEM request failed (HTTP 500) for ${AEM}${assetPath}`);
          }
          writes.push({ assetPath, payload });
          return { updated: true, assetPath, metadata: payload };
        } finally {
          inFlight--;
        }
      }
    },
    writes,
    failPaths,
    get maxInFlight() {
      return maxInFlight;
    },
    setWriteDelay(ms) {
      writeDelayMs = ms;
    }
  };
}

async function createHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-rob-'));
  const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
  await storage.saveSettings({ awsAccessKeyId: 'AKIATEST', awsSecretAccessKey: 'secret' });
  const rek = createMockRekognition();
  const aem = createMockAem();
  const svc = await createFaceService({
    storage,
    rekognitionClient: rek.client,
    aemClient: aem.client,
    retryOptions: { sleep: noSleep }
  });
  return {
    dir,
    storage,
    rek,
    aem,
    svc,
    async reloadDb() {
      const fresh = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
      return fresh.getDatabase();
    },
    avatarExists(faceId) {
      return fs.existsSync(path.join(dir, 'avatars', `${faceId}.jpg`));
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// Retry primitives
// ---------------------------------------------------------------------------

test('retry: transient errors are retried until success', async () => {
  const delays = [];
  let n = 0;
  const result = await withRetry(
    async () => {
      n++;
      if (n < 3) throw awsError('ThrottlingException');
      return 'ok';
    },
    { sleep: async (ms) => delays.push(ms), random: () => 1 }
  );
  assert.equal(result, 'ok');
  assert.equal(n, 3);
  assert.deepEqual(delays, [200, 400]); // full-jitter ceiling grows exponentially
});

test('retry: non-retryable errors are thrown immediately', async () => {
  let n = 0;
  await assert.rejects(
    withRetry(
      async () => {
        n++;
        throw awsError('AccessDeniedException');
      },
      { sleep: noSleep }
    ),
    { name: 'AccessDeniedException' }
  );
  assert.equal(n, 1);
});

test('retry: gives up after maxAttempts and throws the last error', async () => {
  let n = 0;
  await assert.rejects(
    withRetry(
      async () => {
        n++;
        throw awsError('ThrottlingException');
      },
      { maxAttempts: 4, sleep: noSleep }
    ),
    { name: 'ThrottlingException' }
  );
  assert.equal(n, 4);
});

test('retry: total delay budget stops retries before a gateway timeout', async () => {
  let n = 0;
  let slept = 0;
  await assert.rejects(
    withRetry(
      async () => {
        n++;
        throw awsError('ThrottlingException');
      },
      {
        maxAttempts: 50,
        baseDelayMs: 1000,
        maxDelayMs: 1000,
        maxTotalDelayMs: 2500,
        random: () => 1,
        sleep: async (ms) => {
          slept += ms;
        }
      }
    )
  );
  assert.equal(slept, 2000);
  assert.equal(n, 3);
});

test('retry: server-provided Retry-After is honored and capped', async () => {
  const delays = [];
  let n = 0;
  await withRetry(
    async () => {
      n++;
      if (n === 1) throw Object.assign(new Error('x'), { retryAfter: 1500 });
      if (n === 2) throw Object.assign(new Error('x'), { retryAfter: 60000 });
      return 'ok';
    },
    {
      isRetryable: () => true,
      getRetryAfterMs: (err) => err.retryAfter,
      maxDelayMs: 3000,
      sleep: async (ms) => delays.push(ms)
    }
  );
  assert.deepEqual(delays, [1500, 3000]);
});

test('retry: AWS error classification', () => {
  for (const name of [
    'ThrottlingException',
    'ProvisionedThroughputExceededException',
    'InternalServerError',
    'ServiceUnavailableException'
  ]) {
    assert.equal(isRetryableAwsError(awsError(name)), true, name);
  }
  assert.equal(isRetryableAwsError(awsError('Whatever', 503)), true);
  assert.equal(isRetryableAwsError(awsError('Whatever', 429)), true);
  assert.equal(isRetryableAwsError(Object.assign(new Error('x'), { $retryable: {} })), true);
  assert.equal(isRetryableAwsError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);

  for (const name of [
    'InvalidParameterException',
    'AccessDeniedException',
    'ResourceNotFoundException',
    'InvalidImageFormatException',
    'UnrecognizedClientException'
  ]) {
    assert.equal(isRetryableAwsError(awsError(name)), false, name);
  }
});

test('retry: backoff stays within [0, min(max, base*2^n)]', () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const ceiling = Math.min(3000, 200 * 2 ** attempt);
    assert.equal(computeBackoff(attempt, { baseDelayMs: 200, maxDelayMs: 3000, random: () => 0.999999 }), ceiling - 1);
    assert.equal(computeBackoff(attempt, { baseDelayMs: 200, maxDelayMs: 3000, random: () => 0 }), 0);
  }
});

test('concurrency: mapWithConcurrency respects the limit and keeps order', async () => {
  let inFlight = 0;
  let max = 0;
  const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0, 6], 3, async (v) => {
    inFlight++;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, v));
    inFlight--;
    return v * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30, 0, 60]);
  assert.ok(max <= 3 && max > 1, `max in flight was ${max}`);
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
});

// ---------------------------------------------------------------------------
// Rekognition service
// ---------------------------------------------------------------------------

function rekService(rek) {
  return createRekognitionService(
    { awsAccessKeyId: 'A', awsSecretAccessKey: 'B', collectionId: 'c', similarityThreshold: 85 },
    rek.client,
    { sleep: noSleep }
  );
}

test('rekognition: throttled IndexFaces is retried and succeeds', async () => {
  const rek = createMockRekognition();
  rek.setNextFaces(['f1']);
  rek.script.IndexFaces = (input, nth) => {
    if (nth <= 2) throw awsError('ThrottlingException');
    return { FaceRecords: [{ Face: { FaceId: 'f1', Confidence: 99, BoundingBox: { Left: 0, Top: 0, Width: 0.1, Height: 0.1 } } }] };
  };
  const faces = await rekService(rek).indexAssetFaces(Buffer.from('x'), 'a', { skipEnsureCollection: true });
  assert.equal(faces.length, 1);
  assert.equal(rek.count('IndexFaces'), 3);
});

test('R6: persistent throttling during matching throws instead of returning "no match"', async () => {
  const rek = createMockRekognition();
  rek.script.SearchUsers = () => {
    throw awsError('ThrottlingException');
  };
  await assert.rejects(
    rekService(rek).findMatchingGroup('f1', {}, { g1: {} }),
    { name: 'ThrottlingException' }
  );
  assert.equal(rek.count('SearchUsers'), 5); // default maxAttempts
  assert.equal(rek.count('SearchFaces'), 0);
});

test('R6: throttled SearchFaces fallback also throws', async () => {
  const rek = createMockRekognition();
  rek.script.SearchUsers = () => {
    throw awsError('InvalidParameterException');
  };
  rek.script.SearchFaces = () => {
    throw awsError('ProvisionedThroughputExceededException');
  };
  await assert.rejects(rekService(rek).findMatchingGroup('f1', {}, {}), {
    name: 'ProvisionedThroughputExceededException'
  });
});

test('matching: "not ready" errors fall back to SearchFaces and still find the group', async () => {
  const rek = createMockRekognition();
  rek.script.SearchUsers = () => {
    throw awsError('InvalidParameterException');
  };
  rek.script.SearchFaces = () => ({ FaceMatches: [{ Face: { FaceId: 'old' }, Similarity: 97.123 }] });
  const match = await rekService(rek).findMatchingGroup('new', { old: { groupId: 'g1' } }, { g1: {} });
  assert.deepEqual(match, { groupId: 'g1', matchConfidence: 97.12 });
});

test('matching: empty collection (ResourceNotFound) is a clean "no match"', async () => {
  const rek = createMockRekognition();
  rek.script.SearchUsers = () => {
    throw awsError('ResourceNotFoundException');
  };
  rek.script.SearchFaces = () => {
    throw awsError('ResourceNotFoundException');
  };
  assert.equal(await rekService(rek).findMatchingGroup('f', {}, {}), null);
});

test('rekognition: unsupported images produce a user-readable error and are not retried', async () => {
  const rek = createMockRekognition();
  rek.script.IndexFaces = () => {
    throw awsError('InvalidImageFormatException');
  };
  await assert.rejects(
    rekService(rek).indexAssetFaces(Buffer.from('x'), 'a', { skipEnsureCollection: true }),
    (err) => err instanceof PublicError && /not supported/.test(err.message)
  );
  assert.equal(rek.count('IndexFaces'), 1);
});

// ---------------------------------------------------------------------------
// Face service: ingest failure handling
// ---------------------------------------------------------------------------

test('R6: transient throttling while matching no longer creates a duplicate person', async () => {
  const h = await createHarness();
  try {
    h.rek.setNextFaces(['a1']);
    const first = await h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true });
    const groupId = first.faces[0].groupId;

    h.rek.setNextFaces(['a2']);
    h.rek.script.SearchUsers = (input, nth) => {
      if (nth <= 3) throw awsError('ThrottlingException');
      return { UserMatches: [{ User: { UserId: groupId }, Similarity: 99 }] };
    };
    const second = await h.svc.ingestAsset({ assetPath: '/content/dam/p/2.jpg', assetId: 'A2', force: true });

    assert.equal(second.faces[0].groupId, groupId);
    const db = await h.reloadDb();
    assert.equal(Object.keys(db.groups).length, 1);
    assert.deepEqual(db.groups[groupId].faceIds.sort(), ['a1', 'a2']);
  } finally {
    h.cleanup();
  }
});

test('R6/R5: persistent throttling while matching leaves the database untouched and cleans up', async () => {
  const h = await createHarness();
  const restore = quietConsole();
  try {
    h.rek.setNextFaces(['old1']);
    await h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true });
    const before = await h.reloadDb();
    const writesBefore = h.aem.writes.length;

    h.rek.reset();
    h.rek.setNextFaces(['new1', 'new2']);
    h.rek.script.SearchUsers = () => {
      throw awsError('ThrottlingException');
    };

    await assert.rejects(
      h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true }),
      { name: 'ThrottlingException' }
    );

    const after = await h.reloadDb();
    assert.deepEqual(after, before, 'database must be unchanged');
    // Old face was NOT removed from Rekognition; new faces were discarded
    assert.deepEqual(h.rek.inputsOf('DeleteFaces').map((i) => i.FaceIds), [['new1', 'new2']]);
    assert.equal(h.rek.count('DisassociateFaces'), 0);
    assert.equal(h.rek.count('CreateUser'), 0);
    assert.equal(h.avatarExists('new1'), false);
    assert.equal(h.avatarExists('old1'), true);
    assert.equal(h.aem.writes.length, writesBefore);
  } finally {
    restore();
    h.cleanup();
  }
});

test('R5: failure while removing previous faces on re-scan leaves the database untouched', async () => {
  const h = await createHarness();
  const restore = quietConsole();
  try {
    h.rek.setNextFaces(['old1']);
    await h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true });
    const before = await h.reloadDb();

    h.rek.reset();
    h.rek.setNextFaces(['new1']);
    h.rek.script.DeleteFaces = (input) => {
      if (input.FaceIds.includes('old1')) throw awsError('AccessDeniedException');
      return {};
    };

    await assert.rejects(
      h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true }),
      { name: 'AccessDeniedException' }
    );
    assert.deepEqual(await h.reloadDb(), before);
    // Cleanup of the new face was still attempted
    assert.ok(h.rek.inputsOf('DeleteFaces').some((i) => i.FaceIds.includes('new1')));
  } finally {
    restore();
    h.cleanup();
  }
});

test('R5: failure while applying faces saves a consistent partial result', async () => {
  const h = await createHarness();
  const restore = quietConsole();
  try {
    h.rek.setNextFaces(['f1', 'f2']);
    h.rek.script.CreateUser = (input, nth) => {
      if (nth === 2) throw awsError('AccessDeniedException');
      return {};
    };

    await assert.rejects(
      h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true }),
      { name: 'AccessDeniedException' }
    );

    const db = await h.reloadDb();
    assert.deepEqual(Object.keys(db.faces), ['f1']);
    assert.equal(Object.keys(db.groups).length, 1);
    const [group] = Object.values(db.groups);
    assert.deepEqual(group.faceIds, ['f1']);
    assert.deepEqual(db.assets.A1.faceIds, ['f1']);
    assert.equal(db.assets.A1.incomplete, true);
    assert.equal(db.counters.nextPersonNumber, 2);
    // The unapplied face was removed from Rekognition and its avatar deleted
    assert.ok(h.rek.inputsOf('DeleteFaces').some((i) => i.FaceIds.length === 1 && i.FaceIds[0] === 'f2'));
    assert.equal(h.avatarExists('f2'), false);
    // AEM metadata reflects what was recorded
    assert.equal(h.aem.writes.at(-1).payload.faceCount, 1);

    // A clean re-scan recovers fully
    h.rek.reset();
    h.rek.setNextFaces(['f3', 'f4']);
    const res = await h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true });
    assert.equal(res.faceCount, 2);
    const db2 = await h.reloadDb();
    assert.deepEqual(Object.keys(db2.faces).sort(), ['f3', 'f4']);
    assert.equal(db2.assets.A1.incomplete, undefined);
    assert.equal(Object.keys(db2.groups).length, 2);
  } finally {
    restore();
    h.cleanup();
  }
});

test('re-scan matching a group that is about to be emptied creates a fresh group safely', async () => {
  const h = await createHarness();
  try {
    h.rek.setNextFaces(['old1']);
    const first = await h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true });
    const oldGroup = first.faces[0].groupId;

    h.rek.reset();
    h.rek.setNextFaces(['new1']);
    // Rekognition says the new face matches the old group (it is the same person)
    h.rek.script.SearchUsers = () => ({ UserMatches: [{ User: { UserId: oldGroup }, Similarity: 99 }] });
    const res = await h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true });

    const db = await h.reloadDb();
    assert.equal(db.groups[oldGroup], undefined, 'old single-face group was deleted');
    const newGroup = res.faces[0].groupId;
    assert.notEqual(newGroup, oldGroup);
    assert.deepEqual(db.groups[newGroup].faceIds, ['new1']);
    assert.equal(h.rek.count('AssociateFaces'), 1); // createGroup's association only
  } finally {
    h.cleanup();
  }
});

test('R8: AEM metadata failure on ingest keeps the scan result and reports a warning', async () => {
  const h = await createHarness();
  const restore = quietConsole();
  try {
    h.aem.failPaths.add('/content/dam/p/1.jpg');
    h.rek.setNextFaces(['f1']);
    const res = await h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true });
    assert.equal(res.faceCount, 1);
    assert.equal(res.metadataSynced, false);
    assert.equal(res.metadataSyncError, 'AEM metadata update failed.');
    assert.ok(!res.metadataSyncError.includes('adobeaemcloud'));

    const db = await h.reloadDb();
    assert.deepEqual(db.assets.A1.faceIds, ['f1']);
    assert.equal(db.assets.A1.metadataSyncError, 'AEM metadata update failed.');
  } finally {
    restore();
    h.cleanup();
  }
});

test('R8: rename is saved even when some AEM metadata writes fail, and failures are reported', async () => {
  const h = await createHarness();
  const restore = quietConsole();
  try {
    h.rek.setNextFaces(['f1']);
    const r1 = await h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true });
    const groupId = r1.faces[0].groupId;
    h.rek.setNextFaces(['f2']);
    h.rek.script.SearchUsers = () => ({ UserMatches: [{ User: { UserId: groupId }, Similarity: 99 }] });
    await h.svc.ingestAsset({ assetPath: '/content/dam/p/2.jpg', assetId: 'A2', force: true });

    h.aem.failPaths.add('/content/dam/p/2.jpg');
    const res = await h.svc.renameGroup({ groupId, name: 'Alice' });

    assert.equal(res.syncedAssetCount, 1);
    assert.equal(res.failedAssetCount, 1);
    assert.equal(res.failedAssets[0].assetPath, '/content/dam/p/2.jpg');

    const db = await h.reloadDb();
    assert.equal(db.groups[groupId].name, 'Alice');

    // Retrying via resync succeeds once AEM recovers
    h.aem.failPaths.clear();
    const resync = await h.svc.resyncAllAssetsMetadata();
    assert.equal(resync.failedAssetCount, 0);
    assert.equal(resync.syncedAssetCount, 2);
    assert.equal((await h.reloadDb()).assets.A2.metadataSyncError, null);
  } finally {
    restore();
    h.cleanup();
  }
});

test('split/move/merge report failed AEM writes but still persist', async () => {
  const h = await createHarness();
  const restore = quietConsole();
  try {
    h.rek.setNextFaces(['f1', 'f2']);
    const r = await h.svc.ingestAsset({ assetPath: '/content/dam/p/1.jpg', assetId: 'A1', force: true });
    const [g1, g2] = r.faces.map((f) => f.groupId);
    h.aem.failPaths.add('/content/dam/p/1.jpg');

    const merged = await h.svc.mergeGroups({ sourceGroupIds: [g2], targetGroupId: g1 });
    assert.equal(merged.failedAssetCount, 1);
    let db = await h.reloadDb();
    assert.equal(db.groups[g2], undefined);
    assert.deepEqual(db.groups[g1].faceIds.sort(), ['f1', 'f2']);

    const split = await h.svc.splitFacesToNewGroup({ faceIds: ['f2'] });
    assert.equal(split.failedAssetCount, 1);
    db = await h.reloadDb();
    assert.equal(db.faces.f2.groupId, split.newGroup.groupId);

    const moved = await h.svc.moveFacesToGroup({ faceIds: ['f2'], targetGroupId: g1 });
    assert.equal(moved.failedAssetCount, 1);
    db = await h.reloadDb();
    assert.equal(db.faces.f2.groupId, g1);
  } finally {
    restore();
    h.cleanup();
  }
});

test('R7: AEM metadata writes run in parallel with a bounded concurrency of 4', async () => {
  const h = await createHarness();
  try {
    for (let i = 0; i < 10; i++) {
      h.rek.setNextFaces([`f${i}`]);
      await h.svc.ingestAsset({ assetPath: `/content/dam/p/${i}.jpg`, assetId: `A${i}`, force: true });
    }
    h.aem.setWriteDelay(15);
    const res = await h.svc.resyncAllAssetsMetadata();
    assert.equal(res.syncedAssetCount, 10);
    assert.ok(h.aem.maxInFlight > 1 && h.aem.maxInFlight <= 4, `max in flight: ${h.aem.maxInFlight}`);
  } finally {
    h.cleanup();
  }
});

test('scanFolder: a failing asset does not stop the batch; partial progress is saved; messages are safe', async () => {
  const h = await createHarness();
  const restore = quietConsole();
  try {
    let indexCall = 0;
    h.rek.script.IndexFaces = () => {
      indexCall++;
      const id = `s${indexCall}`;
      return { FaceRecords: [{ Face: { FaceId: id, Confidence: 99, BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.2, Height: 0.2 } } }] };
    };
    // 2nd asset: unexpected internal failure while applying -> partial db change
    h.rek.script.CreateUser = (input, nth) => {
      if (nth === 2) throw new Error(`socket hang up talking to ${AEM}`);
      return {};
    };
    h.aem.failPaths.add('/content/dam/s/3.jpg');

    const res = await h.svc.scanFolder({
      folderPath: '/content/dam/s',
      assets: [1, 2, 3].map((i) => ({ assetId: `S${i}`, assetPath: `/content/dam/s/${i}.jpg` })),
      force: true
    });

    assert.deepEqual(res.results.map((r) => r.status), ['processed', 'error', 'processed']);
    assert.equal(res.results[1].error, 'Face analysis failed for this asset.');
    assert.equal(res.results[2].warning, 'AEM metadata update failed.');

    const db = await h.reloadDb();
    assert.deepEqual(Object.keys(db.assets).sort(), ['S1', 'S2', 'S3']);
    assert.equal(db.assets.S2.incomplete, true);
    assert.deepEqual(db.assets.S2.faceIds, []);
  } finally {
    restore();
    h.cleanup();
  }
});

test('scanFolder: user-readable errors (e.g. unsupported format) are shown as-is', async () => {
  const h = await createHarness();
  try {
    h.rek.script.IndexFaces = () => {
      throw awsError('InvalidImageFormatException');
    };
    const res = await h.svc.scanFolder({
      folderPath: '/content/dam/s',
      assets: [{ assetId: 'S1', assetPath: '/content/dam/s/1.tif' }],
      force: true
    });
    assert.equal(res.results[0].status, 'error');
    assert.match(res.results[0].error, /not supported/);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AEM client retries and image size limits
// ---------------------------------------------------------------------------

function aemWith(responses, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method || 'GET' });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url) : next;
  };
  const sleeps = [];
  const client = createAemClient({
    aemHost: AEM,
    token: 't',
    fetchImpl,
    retryOptions: { sleep: async (ms) => sleeps.push(ms) },
    ...extra
  });
  return { client, calls, sleeps };
}

test('R7: AEM 503 is retried and then succeeds', async () => {
  const { client, calls } = aemWith([
    mockResponse(503, { body: 'busy' }),
    mockResponse(200, { body: JSON.stringify({ entities: [] }) })
  ]);
  const res = await client.browseDamFolder('/content/dam');
  assert.deepEqual(res.assets, []);
  assert.equal(calls.length, 2);
});

test('R7: AEM 429 Retry-After header is honored', async () => {
  const { client, sleeps } = aemWith([
    mockResponse(429, { headers: { 'Retry-After': '2' } }),
    mockResponse(200, { body: JSON.stringify({ entities: [] }) })
  ]);
  await client.browseDamFolder('/content/dam');
  assert.deepEqual(sleeps, [2000]);
});

test('R7: AEM network errors are retried', async () => {
  const { client, calls } = aemWith([
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }),
    mockResponse(200, { body: JSON.stringify({ entities: [] }) })
  ]);
  await client.browseDamFolder('/content/dam');
  assert.equal(calls.length, 3);
});

test('R7: persistent AEM 503 gives up after 4 attempts with a clear error', async () => {
  const responses = Array.from({ length: 10 }, () => mockResponse(503));
  const { client, calls } = aemWith(responses);
  await assert.rejects(client.browseDamFolder('/content/dam'), /HTTP 503/);
  assert.equal(calls.length, 4);
});

test('R7: AEM 400/403/404/500 are not retried', async () => {
  for (const status of [400, 403, 404, 500]) {
    const { client, calls } = aemWith([mockResponse(status), mockResponse(200)]);
    await assert.rejects(client.browseDamFolder('/content/dam'));
    assert.equal(calls.length, 1, `status ${status}`);
  }
});

test('R7: metadata write is retried on 503 and reports success', async () => {
  const { client, calls } = aemWith([mockResponse(503), mockResponse(200)]);
  const res = await client.updateAssetFaceMetadata('/content/dam/a.jpg', { faceNames: ['A'] });
  assert.equal(res.updated, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.method === 'POST'));
});

test('P5: oversized renditions are skipped by Content-Length without being downloaded', async () => {
  let bodyRead = false;
  const big = {
    ...mockResponse(200, { headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_IMAGE_BYTES + 1) } }),
    async arrayBuffer() {
      bodyRead = true;
      return Buffer.alloc(10);
    }
  };
  const small = mockResponse(200, { body: Buffer.from('PNGDATA'), headers: { 'content-type': 'image/png' } });
  const { client, calls } = aemWith([big, mockResponse(404), small]);
  const buf = await client.fetchAssetRenditionBuffer('/content/dam/a.jpg');
  assert.equal(buf.toString(), 'PNGDATA');
  assert.equal(bodyRead, false);
  assert.match(calls[2].url, /thumbnail\.319\.319\.png$/);
});

test('P5: streaming bodies are cut off once they exceed the limit', async () => {
  let chunksRead = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const streaming = {
    ...mockResponse(200, { headers: { 'content-type': 'image/jpeg' } }),
    body: {
      getReader() {
        return {
          async read() {
            chunksRead++;
            return { done: chunksRead > 100, value: chunk };
          },
          async cancel() {
            cancelled = true;
          }
        };
      }
    }
  };
  const tooBig = () => streaming;
  const { client } = aemWith([tooBig, tooBig, tooBig, tooBig]);
  await assert.rejects(
    client.fetchAssetRenditionBuffer('/content/dam/a.jpg'),
    (err) => err instanceof PublicError && /small enough/.test(err.message)
  );
  assert.ok(cancelled);
  assert.ok(chunksRead <= 4 * 7, `read ${chunksRead} chunks`);
});

test('P5: small original is still used as a last resort', async () => {
  const original = mockResponse(200, { body: Buffer.from('ORIG'), headers: { 'content-type': 'image/jpeg', 'content-length': '4' } });
  const { client, calls } = aemWith([mockResponse(404), mockResponse(404), mockResponse(404), original]);
  const buf = await client.fetchAssetRenditionBuffer('/content/dam/a.jpg');
  assert.equal(buf.toString(), 'ORIG');
  assert.match(calls[3].url, /renditions\/original$/);
});

test('no rendition available produces a user-readable error', async () => {
  const { client } = aemWith([mockResponse(404), mockResponse(404), mockResponse(404), mockResponse(404)]);
  await assert.rejects(
    client.fetchAssetRenditionBuffer('/content/dam/a.jpg'),
    (err) => err instanceof PublicError && /finished processing/.test(err.message)
  );
});

test('parseRetryAfterMs handles seconds, HTTP dates and junk', () => {
  assert.equal(parseRetryAfterMs('3'), 3000);
  assert.equal(parseRetryAfterMs('0'), 0);
  const now = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(parseRetryAfterMs('Tue, 10 Nov 2026 00:00:05 GMT', now), 5000);
  assert.equal(parseRetryAfterMs('Mon, 09 Nov 2026 00:00:00 GMT', now), 0);
  assert.equal(parseRetryAfterMs('soon'), null);
  assert.equal(parseRetryAfterMs(null), null);
});

// ---------------------------------------------------------------------------
// Image decoding limits
// ---------------------------------------------------------------------------

function pngWithHeader(width, height) {
  // Valid signature + IHDR length/type + dimensions; body intentionally truncated
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test('P5: PNGs over the megapixel limit are rejected before decoding', () => {
  assert.throws(() => decodeImageBuffer(pngWithHeader(20000, 20000)), /exceed/);
  assert.throws(() => decodeImageBuffer(pngWithHeader(0, 10)), /exceed/);
});

test('P5: oversized images fall back to a placeholder avatar instead of crashing', async () => {
  const avatar = await cropFaceAvatar(pngWithHeader(30000, 30000), { left: 0.1, top: 0.1, width: 0.2, height: 0.2 });
  assert.match(avatar.dataUrl, /^data:image\/svg\+xml/);
});

test('normal PNG renditions still decode and crop', async () => {
  const png = new PNG({ width: 64, height: 48 });
  png.data.fill(200);
  const buf = PNG.sync.write(png);
  const decoded = decodeImageBuffer(buf);
  assert.equal(decoded.width, 64);
  assert.equal(decoded.height, 48);
  const avatar = await cropFaceAvatar(buf, { left: 0.25, top: 0.25, width: 0.3, height: 0.3 });
  assert.match(avatar.dataUrl, /^data:image\/jpeg;base64,/);
});
