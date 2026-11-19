const test = require('node:test');
const assert = require('node:assert/strict');
const { createLicenseClient } = require('../actions/lib/licenses');

const HOST = 'https://author-p1-e1.adobeaemcloud.com';
const jwt = `h.${Buffer.from(JSON.stringify({ client_id: 'aem-assets-frontend-1' })).toString('base64url')}.s`;
const res = (status, body, extra = {}) => ({
  status, ok: status < 400, headers: { get: (k) => extra[k.toLowerCase()] ?? null },
  json: async () => body, arrayBuffer: async () => Buffer.from(body)
});

test('requires a user token and an AEM author host', () => {
  assert.throws(() => createLicenseClient({ aemHost: HOST, token: '' }), /signed-in user/);
  assert.throws(() => createLicenseClient({ aemHost: 'https://evil.example.com', token: jwt }), /author host/);
});

test('lists current licenses with the token client id as api key, skipping superseded ones', async () => {
  let seen;
  const c = createLicenseClient({ aemHost: HOST, token: jwt, orgId: 'ORG', fetchImpl: async (url, init) => {
    seen = { url, init };
    return res(200, { items: [{ licenseId: 'a', windows: [{ channels: ['WEB'], regions: ['US'] }] }, { licenseId: 'b', supersededAt: '2026-01-01' }] });
  } });
  const list = await c.listLicenses();
  assert.deepEqual(list.map((l) => l.licenseId), ['a']);
  assert.match(seen.url, /\/adobe\/experimental\/licenses-expires-20261201\/assets\/licenses\?limit=100/);
  assert.equal(seen.init.headers['x-api-key'], 'aem-assets-frontend-1');
  assert.equal(seen.init.headers['x-gw-ims-org-id'], 'ORG');
});

test('falls back to the GA prefix on 404 and remembers it', async () => {
  const urls = [];
  const c = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async (url) => {
    urls.push(url);
    return url.includes('experimental') ? res(404, {}) : res(200, { items: [] });
  } });
  await c.listLicenses();
  await c.listLicenses();
  assert.equal(urls.length, 3);
});

test('document download only follows Azure blob URLs', async () => {
  const bad = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async () => res(200, { href: 'https://evil.example.com/x.pdf' }) });
  await assert.rejects(() => bad.getLicenseDocument('a'), /Unexpected license document location/);
  const calls = [];
  const ok = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async (url) => {
    calls.push(url);
    return url.startsWith(HOST) ? res(200, { href: 'https://acct.blob.core.windows.net/c/x.pdf?sig=1' }) : res(200, '%PDF-1.4');
  } });
  assert.equal((await ok.getLicenseDocument('a')).toString(), '%PDF-1.4');
  assert.equal(calls.length, 2);
});

test('assign sends the assignments body and validates inputs', async () => {
  let body;
  const c = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async (url, init) => {
    body = JSON.parse(init.body);
    return res(200, { data: { state: 'COMPLETED', assignments: [{ target: { id: '/content/dam/a.png' }, status: 200, licenseId: 'L' }] } });
  } });
  const out = await c.assignLicense(['/content/dam/a.png'], 'L');
  assert.deepEqual(body, { assignments: [{ target: { id: '/content/dam/a.png', type: 'ASSET' }, licenseId: 'L' }] });
  assert.equal(out.state, 'COMPLETED');
  await assert.rejects(() => c.assignLicense([], 'L'), /1 to 10/);
  await assert.rejects(() => c.assignLicense(['/etc/passwd'], 'L'));
});

test('403 from the API surfaces as a permission error', async () => {
  const c = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async () => res(403, {}) });
  await assert.rejects(() => c.listLicenses(), /not permitted/);
});

test('getLicenseDocumentUrl returns the pre-signed Azure URL without downloading it', async () => {
  const calls = [];
  const c = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async (url) => {
    calls.push(url);
    return res(200, { href: 'https://acct.blob.core.windows.net/c/x.pdf?sig=1' });
  } });
  assert.equal(await c.getLicenseDocumentUrl('a'), 'https://acct.blob.core.windows.net/c/x.pdf?sig=1');
  assert.equal(calls.length, 1);
  const bad = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async () => res(200, { href: 'https://evil.example.com/x.pdf' }) });
  await assert.rejects(() => bad.getLicenseDocumentUrl('a'), /Unexpected license document location/);
});

test('getLicenseDocumentRange requests the byte range and reports the total', async () => {
  let rangeHeader;
  const body = Buffer.from('0123456789');
  const c = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async (url, init) => {
    if (url.startsWith(HOST)) return res(200, { href: 'https://acct.blob.core.windows.net/c/x.pdf?sig=1' });
    rangeHeader = init.headers.Range;
    return { status: 206, ok: true, headers: { get: (k) => (k.toLowerCase() === 'content-range' ? 'bytes 2-5/10' : null) }, arrayBuffer: async () => body.slice(2, 6) };
  } });
  const out = await c.getLicenseDocumentRange('a', 2, 4);
  assert.equal(rangeHeader, 'bytes=2-5');
  assert.deepEqual({ offset: out.offset, length: out.length, total: out.total }, { offset: 2, length: 4, total: 10 });
  assert.equal(Buffer.from(out.data, 'base64').toString(), '2345');
});

test('getLicenseDocumentRange slices locally when the server ignores Range', async () => {
  const body = Buffer.from('0123456789');
  const c = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async (url) =>
    url.startsWith(HOST)
      ? res(200, { href: 'https://acct.blob.core.windows.net/c/x.pdf?sig=1' })
      : { status: 200, ok: true, headers: { get: () => null }, arrayBuffer: async () => body } });
  const out = await c.getLicenseDocumentRange('a', 6, 100);
  assert.equal(out.total, 10);
  assert.equal(Buffer.from(out.data, 'base64').toString(), '6789');
});

test('getAssignedLicenseIds reads dam:licenseIds with the user token and never throws', async () => {
  let url;
  const c = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async (u) => { url = u; return res(200, { 'dam:licenseIds': ['A', 'B'] }); } });
  assert.deepEqual(await c.getAssignedLicenseIds('/content/dam/my folder/a.png'), ['A', 'B']);
  assert.match(url, /my%20folder\/a\.png\/jcr:content\/metadata\.json$/);
  const single = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async () => res(200, { 'dam:licenseIds': 'A' }) });
  assert.deepEqual(await single.getAssignedLicenseIds('/content/dam/a.png'), ['A']);
  const none = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async () => res(200, {}) });
  assert.deepEqual(await none.getAssignedLicenseIds('/content/dam/a.png'), []);
  const denied = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async () => res(403, {}) });
  assert.deepEqual(await denied.getAssignedLicenseIds('/content/dam/a.png'), []);
  const boom = createLicenseClient({ aemHost: HOST, token: jwt, fetchImpl: async () => { throw new Error('net'); } });
  assert.deepEqual(await boom.getAssignedLicenseIds('/content/dam/a.png'), []);
});
