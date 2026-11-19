const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLicenseSuggestionService } = require('../actions/lib/license-suggestions');

const LIC_DIR = path.resolve(__dirname, '../../../licenses');
const pdf = fs.existsSync(LIC_DIR) ? fs.readFileSync(path.join(LIC_DIR, fs.readdirSync(LIC_DIR).filter((f) => f.endsWith('.pdf'))[0])) : null;

function build({ enabled = true, licenses, matchesByCall, cache = {}, faces }) {
  let cacheStore = cache;
  let searches = 0;
  const svc = createLicenseSuggestionService({
    storage: {
      getSettings: async () => ({ enableLicenseSuggestions: enabled, similarityThreshold: 85 }),
      getDatabase: async () => ({ faces: {}, groups: { g1: {}, g2: {} } }),
      getLicenseMatches: async () => cacheStore,
      saveLicenseMatches: async (m) => { cacheStore = m; }
    },
    faceService: { getAssetFaces: async () => ({ scanned: true, faces }) },
    licenseClient: {
      listLicenses: async () => licenses,
      getAssignedLicenseIds: async () => ['L1'],
      getLicenseDocumentRange: async (id, offset, length) => ({ id, offset, length, total: 9, data: 'AA==' }),
      getLicenseDocumentUrl: async (id) => `https://acct.blob.core.windows.net/c/${id}.pdf`,
      getLicenseDocument: async () => pdf,
      assignLicense: async (paths, id) => ({ state: 'COMPLETED', paths, id })
    },
    getRekognition: async () => ({ rekognition: { searchFacesByImage: async () => matchesByCall(searches++) } }),
    now: () => Date.parse('2026-11-19T12:00:00Z')
  });
  return { svc, searches: () => searches, cache: () => cacheStore };
}
const lic = (id, extra = {}) => ({ licenseId: id, version: 1, name: id, licenser: 'Someone Else', windows: [], restrictions: [], ...extra });

test('refuses when the flag is off', async () => {
  const { svc } = build({ enabled: false, licenses: [], matchesByCall: () => ({}), faces: [] });
  await assert.rejects(() => svc.suggestForAsset({ assetPath: '/content/dam/a.png' }), /not enabled/);
  await assert.rejects(() => svc.applyLicense({ assetPath: '/content/dam/a.png', licenseId: 'x' }), /not enabled/);
});

test('suggests by face only: the matched license is attached to the right person, whatever the licenser says', { skip: !pdf }, async () => {
  const { svc } = build({
    licenses: [lic('L1', { licenser: 'Northstar Talent Agency (guardian)' }), lic('L2')],
    matchesByCall: (n) => (n === 0 ? { matches: [{ groupId: 'g1', similarity: 97 }] } : { matches: [] }),
    faces: [{ groupId: 'g1', groupDisplayName: 'Elena' }, { groupId: 'g2', groupDisplayName: 'Other' }]
  });
  const out = await svc.suggestForAsset({ assetPath: '/content/dam/a.png' });
  assert.equal(out.people[0].suggestions.length, 1);
  assert.equal(out.people[0].suggestions[0].licenseId, 'L1');
  assert.equal(out.people[0].suggestions[0].strong, true);
  assert.equal(out.people[1].suggestions.length, 0);
});

test('weak matches are marked not strong; cached results are not re-searched', { skip: !pdf }, async () => {
  const h = build({
    licenses: [lic('L1')],
    matchesByCall: () => ({ matches: [{ groupId: 'g1', similarity: 86 }] }),
    faces: [{ groupId: 'g1', groupDisplayName: 'Elena' }]
  });
  const first = await h.svc.suggestForAsset({ assetPath: '/content/dam/a.png' });
  assert.equal(first.people[0].suggestions[0].strong, false);
  await h.svc.suggestForAsset({ assetPath: '/content/dam/a.png' });
  assert.equal(h.searches(), 1);
});

test('limits work per call and reports pending licenses', { skip: !pdf }, async () => {
  const licenses = Array.from({ length: 9 }, (_, i) => lic(`L${i}`));
  const h = build({ licenses, matchesByCall: () => ({ matches: [] }), faces: [{ groupId: 'g1', groupDisplayName: 'E' }] });
  const out = await h.svc.suggestForAsset({ assetPath: '/content/dam/a.png' });
  assert.equal(out.pendingCount, 3);
  assert.equal(h.searches(), 6);
});

test('a cached match to a deleted group is re-checked', { skip: !pdf }, async () => {
  const h = build({
    licenses: [lic('L1')],
    cache: { 'L1:1': { status: 'matched', checkedAt: '2026-11-19T11:59:00.000Z', matches: [{ groupId: 'deleted', similarity: 99 }] } },
    matchesByCall: () => ({ matches: [{ groupId: 'g1', similarity: 95 }] }),
    faces: [{ groupId: 'g1', groupDisplayName: 'E' }]
  });
  const out = await h.svc.suggestForAsset({ assetPath: '/content/dam/a.png' });
  assert.equal(h.searches(), 1);
  assert.equal(out.people[0].suggestions[0].licenseId, 'L1');
});

test('images with no recognized people return no suggestions and make no license calls', async () => {
  const h = build({ licenses: [lic('L1')], matchesByCall: () => ({}), faces: [] });
  const out = await h.svc.suggestForAsset({ assetPath: '/content/dam/a.png' });
  assert.deepEqual(out.people, []);
});

test('apply assigns the license to the asset', async () => {
  const h = build({ licenses: [], matchesByCall: () => ({}), faces: [] });
  assert.equal((await h.svc.applyLicense({ assetPath: '/content/dam/a.png', licenseId: 'L1' })).state, 'COMPLETED');
});

test('document URL for review is only served when the flag is on', async () => {
  const on = build({ licenses: [], matchesByCall: () => ({}), faces: [] });
  assert.deepEqual(await on.svc.getDocumentUrl({ licenseId: 'L1' }), { url: 'https://acct.blob.core.windows.net/c/L1.pdf' });
  await assert.rejects(() => on.svc.getDocumentUrl({}), /licenseId is required/);
  const off = build({ enabled: false, licenses: [], matchesByCall: () => ({}), faces: [] });
  await assert.rejects(() => off.svc.getDocumentUrl({ licenseId: 'L1' }), /not enabled/);
});

test('document chunks are only served when the flag is on', async () => {
  const on = build({ licenses: [], matchesByCall: () => ({}), faces: [] });
  assert.equal((await on.svc.getDocumentChunk({ licenseId: 'L1', offset: 0, length: 5 })).total, 9);
  const off = build({ enabled: false, licenses: [], matchesByCall: () => ({}), faces: [] });
  await assert.rejects(() => off.svc.getDocumentChunk({ licenseId: 'L1' }), /not enabled/);
});

test('suggestions report which licenses are already assigned to the asset', { skip: !pdf }, async () => {
  const h = build({
    licenses: [lic('L1'), lic('L2')],
    matchesByCall: () => ({ matches: [{ groupId: 'g1', similarity: 95 }] }),
    faces: [{ groupId: 'g1', groupDisplayName: 'E' }]
  });
  const out = await h.svc.suggestForAsset({ assetPath: '/content/dam/a.png' });
  assert.deepEqual(out.assignedLicenseIds, ['L1']);
  const byId = Object.fromEntries(out.people[0].suggestions.map((s) => [s.licenseId, s.assigned]));
  assert.deepEqual(byId, { L1: true, L2: false });
});
