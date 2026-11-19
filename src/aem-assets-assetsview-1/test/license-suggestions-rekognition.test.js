const test = require('node:test');
const assert = require('node:assert/strict');
const { createRekognitionService } = require('../actions/lib/rekognition');
const { createStorage, DEFAULT_SETTINGS } = require('../actions/lib/storage');

function svc(sendImpl) {
  return createRekognitionService(
    { collectionId: 'c', similarityThreshold: 90 },
    { send: async (cmd) => sendImpl(cmd) },
    { maxAttempts: 1 }
  );
}

test('searchFacesByImage groups matches by live face group, best similarity first', async () => {
  let sent;
  const r = svc((cmd) => {
    sent = cmd.input;
    return {
      FaceMatches: [
        { Similarity: 93.1, Face: { FaceId: 'f1' } },
        { Similarity: 97.4, Face: { FaceId: 'f2' } },
        { Similarity: 99, Face: { FaceId: 'f3' } },
        { Similarity: 95, Face: { FaceId: 'unknown' } }
      ]
    };
  });
  const faces = { f1: { groupId: 'g1' }, f2: { groupId: 'g1' }, f3: { groupId: 'gone' } };
  const res = await r.searchFacesByImage(Buffer.from('x'), faces, { g1: {} });
  assert.deepEqual(res.matches, [{ groupId: 'g1', similarity: 97.4 }]);
  assert.equal(sent.FaceMatchThreshold, 90);
  assert.equal(sent.CollectionId, 'c');
});

test('searchFacesByImage reports noFace instead of throwing for undetectable images', async () => {
  const err = Object.assign(new Error('no face'), { name: 'InvalidParameterException' });
  const r = svc(() => { throw err; });
  assert.deepEqual(await r.searchFacesByImage(Buffer.from('x')), { noFace: true, matches: [] });
});

test('enableLicenseSuggestions defaults to off and persists only when set', async () => {
  assert.equal(DEFAULT_SETTINGS.enableLicenseSuggestions, false);
  const storage = await createStorage({ encryptionSecret: 'x'.repeat(24), useLocal: true, localDir: require('os').tmpdir() + '/lic-sugg-' + Date.now() });
  assert.equal((await storage.getSettings()).enableLicenseSuggestions, false);
  await storage.saveSettings({ enableLicenseSuggestions: true });
  assert.equal((await storage.getSettings()).enableLicenseSuggestions, true);
});
