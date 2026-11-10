const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const { getImageDimensions } = require('../actions/lib/cropper');
const { createStorage, DEFAULT_SETTINGS } = require('../actions/lib/storage');
const { createFaceService } = require('../actions/lib/face-service');
const { createRekognitionService } = require('../actions/lib/rekognition');
const { createAemClient } = require('../actions/lib/aem');
const { PublicError } = require('../actions/lib/security');

const AEM = 'https://author-p12345-e67890.adobeaemcloud.com';

function makeJpeg(width, height) {
  const data = Buffer.alloc(width * height * 4, 128);
  return Buffer.from(jpeg.encode({ data, width, height }, 80).data);
}

function makePng(width, height) {
  const png = new PNG({ width, height });
  png.data.fill(200);
  return PNG.sync.write(png);
}

/** Inserts an APP1 (EXIF-like) segment after SOI so SOF is not the first segment. */
function withApp1Segment(jpegBuf, payloadBytes = 5000) {
  const payload = Buffer.alloc(payloadBytes, 0x41);
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe1;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpegBuf.subarray(0, 2), header, payload, jpegBuf.subarray(2)]);
}

// ---------------------------------------------------------------------------
// Harness: counts every AWS call, rendition download and AEM write
// ---------------------------------------------------------------------------
async function createHarness({ settings = {}, renditions = {}, assetInfo = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-cost-'));
  const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
  await storage.saveSettings({ awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'secret', ...settings });

  const aws = [];
  let faceSeq = 0;
  let facesPerImage = 1;
  const rekognitionClient = {
    async send(cmd) {
      const name = cmd.constructor.name.replace(/Command$/, '');
      aws.push(name);
      if (name === 'IndexFaces') {
        return {
          FaceRecords: Array.from({ length: facesPerImage }, () => ({
            Face: {
              FaceId: `face-${++faceSeq}`,
              Confidence: 99,
              BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.2, Height: 0.2 }
            }
          }))
        };
      }
      if (name === 'SearchUsers') return { UserMatches: [] };
      if (name === 'SearchFaces') return { FaceMatches: [] };
      return {};
    }
  };

  const downloads = [];
  const aemWrites = [];
  const infoCalls = [];
  const aemClient = {
    async checkFolderEligibility() {
      return { eligible: true };
    },
    async getAssetInfo(p) {
      infoCalls.push(p);
      return { assetId: `id:${p}`, assetPath: p, assetTitle: p.split('/').pop(), ...(assetInfo[p] || {}) };
    },
    async fetchAssetRenditionBuffer(p) {
      downloads.push(p);
      return renditions[p] || makeJpeg(400, 300);
    },
    async updateAssetFaceMetadata(p, m) {
      aemWrites.push(p);
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
    svc,
    storage,
    aws,
    downloads,
    aemWrites,
    infoCalls,
    setFacesPerImage(n) {
      facesPerImage = n;
    },
    resetCounters() {
      aws.length = 0;
      downloads.length = 0;
      aemWrites.length = 0;
      infoCalls.length = 0;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

const asset = (n, extra = {}) => ({ assetId: `A${n}`, assetPath: `/content/dam/c/${n}.jpg`, assetTitle: `${n}.jpg`, ...extra });

// ---------------------------------------------------------------------------
// Image dimension sniffing
// ---------------------------------------------------------------------------

test('getImageDimensions reads JPEG and PNG headers without decoding', () => {
  assert.deepEqual(getImageDimensions(makeJpeg(50, 30)), { width: 50, height: 30 });
  assert.deepEqual(getImageDimensions(makeJpeg(1280, 853)), { width: 1280, height: 853 });
  assert.deepEqual(getImageDimensions(makePng(319, 200)), { width: 319, height: 200 });
  // SOF after a large APP1/EXIF segment
  assert.deepEqual(getImageDimensions(withApp1Segment(makeJpeg(640, 480))), { width: 640, height: 480 });
});

test('getImageDimensions returns null for unknown or truncated data', () => {
  assert.equal(getImageDimensions(Buffer.from('mock-image-bytes-that-are-long')), null);
  assert.equal(getImageDimensions(Buffer.alloc(3)), null);
  assert.equal(getImageDimensions(makeJpeg(100, 100).subarray(0, 30)), null);
  assert.equal(getImageDimensions('not a buffer'), null);
  assert.equal(getImageDimensions(null), null);
});

// ---------------------------------------------------------------------------
// Skip already-scanned images
// ---------------------------------------------------------------------------

test('COST: folder scans skip already-scanned images with zero AWS calls, downloads or AEM writes', async () => {
  const h = await createHarness();
  try {
    await h.svc.scanFolder({ folderPath: '/content/dam/c', assets: [asset(1)] }); // has faces
    h.setFacesPerImage(0);
    await h.svc.scanFolder({ folderPath: '/content/dam/c', assets: [asset(2)] }); // no faces
    h.resetCounters();

    const res = await h.svc.scanFolder({ folderPath: '/content/dam/c', assets: [asset(1), asset(2)] });
    assert.deepEqual(res.results.map((r) => [r.status, r.reasonCode]), [
      ['skipped', 'already-scanned'],
      ['skipped', 'already-scanned']
    ]);
    assert.deepEqual(h.aws, [], 'no AWS calls at all, not even DescribeCollection');
    assert.deepEqual(h.downloads, []);
    assert.deepEqual(h.aemWrites, []);
  } finally {
    h.cleanup();
  }
});

test('COST: "include already-scanned" (rescan) analyzes everything again', async () => {
  const h = await createHarness();
  try {
    await h.svc.scanFolder({ folderPath: '/content/dam/c', assets: [asset(1), asset(2)] });
    h.resetCounters();
    const res = await h.svc.scanFolder({
      folderPath: '/content/dam/c',
      assets: [asset(1), asset(2)],
      rescan: true
    });
    assert.deepEqual(res.results.map((r) => r.status), ['processed', 'processed']);
    assert.equal(h.aws.filter((c) => c === 'IndexFaces').length, 2);
    assert.equal(h.aws.filter((c) => c === 'DescribeCollection').length, 1, 'collection checked once per batch');
  } finally {
    h.cleanup();
  }
});

test('COST: side panel re-scan and AEM upload events still analyze already-scanned images', async () => {
  const h = await createHarness();
  try {
    await h.svc.ingestAsset({ ...asset(1), force: true });
    h.resetCounters();
    // Default for ingestAsset is rescan = true
    const res = await h.svc.ingestAsset({ ...asset(1), force: true });
    assert.equal(res.skipped, undefined);
    assert.equal(h.aws.filter((c) => c === 'IndexFaces').length, 1);
  } finally {
    h.cleanup();
  }
});

test('COST: bulk single-asset scans (rescan=false) match records by id variants and by path', async () => {
  const h = await createHarness();
  try {
    await h.svc.ingestAsset({ assetId: 'urn:aaid:aem:1111-2222', assetPath: '/content/dam/c/x.jpg', force: true });
    h.resetCounters();

    for (const variant of [
      { assetId: 'urn:aaid:aem:1111-2222', assetPath: '/content/dam/c/x.jpg' },
      { assetId: '1111-2222', assetPath: '/content/dam/c/x.jpg' },
      { assetId: 'some-other-id', assetPath: '/content/dam/c/x.jpg' }
    ]) {
      const res = await h.svc.ingestAsset({ ...variant, force: true, rescan: false });
      assert.equal(res.reasonCode, 'already-scanned', JSON.stringify(variant));
    }
    assert.deepEqual(h.aws, []);
    assert.deepEqual(h.downloads, []);
  } finally {
    h.cleanup();
  }
});

test('COST: assets left incomplete by a failed scan are not skipped', async () => {
  const h = await createHarness();
  try {
    const db = await h.storage.getDatabase();
    db.assets.A1 = { ...asset(1), faceIds: [], incomplete: true };
    await h.storage.saveDatabase(db);
    const res = await h.svc.scanFolder({ folderPath: '/content/dam/c', assets: [asset(1)] });
    assert.equal(res.results[0].status, 'processed');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// File-type allowlist
// ---------------------------------------------------------------------------

test('COST: non-image and excluded types are skipped before download and before AWS', async () => {
  const h = await createHarness();
  try {
    const items = [
      asset(1, { assetPath: '/content/dam/c/doc.pdf', mimeType: 'application/pdf' }),
      asset(2, { assetPath: '/content/dam/c/clip.mp4', mimeType: 'video/mp4' }),
      asset(3, { assetPath: '/content/dam/c/logo.svg', mimeType: 'image/svg+xml' }),
      asset(4, { assetPath: '/content/dam/c/anim.gif', mimeType: 'image/gif' })
    ];
    const res = await h.svc.scanFolder({ folderPath: '/content/dam/c', assets: items });
    assert.ok(res.results.every((r) => r.status === 'skipped' && r.reasonCode === 'unsupported-type'));
    assert.deepEqual(h.aws, []);
    assert.deepEqual(h.downloads, []);
  } finally {
    h.cleanup();
  }
});

test('COST: allowed types (any case, with parameters) and unknown types are analyzed', async () => {
  const h = await createHarness();
  try {
    const items = [
      asset(1, { mimeType: 'image/jpeg' }),
      asset(2, { mimeType: 'IMAGE/TIFF' }),
      asset(3, { mimeType: 'image/png; charset=binary' }),
      asset(4, { mimeType: 'image/vnd.adobe.photoshop' }),
      asset(5) // unknown type: the rendition is still checked
    ];
    const res = await h.svc.scanFolder({ folderPath: '/content/dam/c', assets: items });
    assert.deepEqual(res.results.map((r) => r.status), Array(5).fill('processed'));
  } finally {
    h.cleanup();
  }
});

test('COST: the allowlist is configurable', async () => {
  const h = await createHarness({ settings: { allowedImageTypes: ['image/png'] } });
  try {
    const res = await h.svc.scanFolder({
      folderPath: '/content/dam/c',
      assets: [asset(1, { mimeType: 'image/jpeg' }), asset(2, { mimeType: 'image/png' })]
    });
    assert.deepEqual(res.results.map((r) => r.reasonCode || r.status), ['unsupported-type', 'processed']);
  } finally {
    h.cleanup();
  }
});

test('COST: when the caller does not know the type, it is looked up in AEM (no AWS call for PDFs)', async () => {
  const h = await createHarness({ assetInfo: { '/content/dam/c/report.pdf': { mimeType: 'application/pdf' } } });
  try {
    // Path only (e.g. from an event without an id): asset info is fetched, which includes the type
    const res = await h.svc.ingestAsset({ assetPath: '/content/dam/c/report.pdf', force: true });
    assert.equal(res.reasonCode, 'unsupported-type');
    assert.deepEqual(h.infoCalls, ['/content/dam/c/report.pdf']);
    assert.deepEqual(h.aws, []);
    assert.deepEqual(h.downloads, []);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tiny images
// ---------------------------------------------------------------------------

test('COST: images below the minimum size are skipped after download but before AWS', async () => {
  const h = await createHarness({
    renditions: {
      '/content/dam/c/1.jpg': makeJpeg(150, 400), // shorter side 150 < 200
      '/content/dam/c/2.jpg': makePng(64, 64), // icon
      '/content/dam/c/3.jpg': makeJpeg(200, 200), // exactly the minimum: analyzed
      '/content/dam/c/4.jpg': Buffer.from('unknown-format-bytes-0123456789') // unknown: analyzed
    }
  });
  try {
    const res = await h.svc.scanFolder({
      folderPath: '/content/dam/c',
      assets: [asset(1), asset(2), asset(3), asset(4)]
    });
    assert.deepEqual(res.results.map((r) => r.reasonCode || r.status), ['too-small', 'too-small', 'processed', 'processed']);
    assert.match(res.results[0].reason, /150x400px/);
    assert.equal(h.aws.filter((c) => c === 'IndexFaces').length, 2);
    // Skipped images are not recorded, so lowering the limit later lets them be scanned
    const db = await h.storage.getDatabase();
    assert.equal(db.assets.A1, undefined);
  } finally {
    h.cleanup();
  }
});

test('COST: minimum size is configurable and 0 disables the check', async () => {
  const h = await createHarness({
    settings: { minImageSize: 0 },
    renditions: { '/content/dam/c/1.jpg': makeJpeg(20, 20) }
  });
  try {
    const res = await h.svc.scanFolder({ folderPath: '/content/dam/c', assets: [asset(1)] });
    assert.equal(res.results[0].status, 'processed');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('settings: defaults and validation for cost controls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-cost-set-'));
  try {
    const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
    const defaults = await storage.getSettings();
    assert.deepEqual(defaults.allowedImageTypes, DEFAULT_SETTINGS.allowedImageTypes);
    assert.ok(defaults.allowedImageTypes.includes('image/jpeg'));
    assert.ok(!defaults.allowedImageTypes.includes('image/gif'));
    assert.ok(!defaults.allowedImageTypes.includes('image/svg+xml'));
    assert.equal(defaults.minImageSize, 200);

    await assert.rejects(storage.saveSettings({ allowedImageTypes: ['application/pdf'] }), PublicError);
    await assert.rejects(storage.saveSettings({ allowedImageTypes: ['jpeg'] }), PublicError);
    await assert.rejects(storage.saveSettings({ allowedImageTypes: [] }), PublicError);
    await assert.rejects(storage.saveSettings({ allowedImageTypes: ['  '] }), PublicError);
    for (const bad of [-1, 4001, 12.5, 'abc', NaN]) {
      await assert.rejects(storage.saveSettings({ minImageSize: bad }), PublicError, String(bad));
    }

    const saved = await storage.saveSettings({
      allowedImageTypes: ['IMAGE/JPEG', 'image/png', 'image/jpeg', ' image/webp '],
      minImageSize: '120'
    });
    assert.deepEqual(saved.allowedImageTypes, ['image/jpeg', 'image/png', 'image/webp']);
    assert.equal(saved.minImageSize, 120);

    // Unrelated saves keep the values
    const again = await storage.saveSettings({ similarityThreshold: 90 });
    assert.equal(again.minImageSize, 120);
    assert.deepEqual(again.allowedImageTypes, ['image/jpeg', 'image/png', 'image/webp']);
    // An empty string from the UI means "unchanged"
    assert.equal((await storage.saveSettings({ minImageSize: '' })).minImageSize, 120);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AEM folder listing filter
// ---------------------------------------------------------------------------

test('COST: folder listing applies the type allowlist and reports excluded assets', async () => {
  const entity = (name, format) => ({
    class: ['assets/asset'],
    properties: { name, ...(format ? { metadata: { 'dc:format': format } } : {}) }
  });
  const listing = {
    entities: [
      { class: ['assets/folder'], properties: { name: 'sub' } },
      entity('a.jpg', 'image/jpeg'),
      entity('b.JPG', 'IMAGE/JPEG'),
      entity('c.pdf', 'application/pdf'),
      entity('d.svg', 'image/svg+xml'),
      entity('e.bin', null)
    ]
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(listing)
  });
  const aem = createAemClient({ aemHost: AEM, token: 't', fetchImpl });

  const filtered = await aem.browseDamFolder('/content/dam/x', { allowedImageTypes: ['image/jpeg', 'image/png'] });
  assert.deepEqual(filtered.assets.map((a) => a.assetPath.split('/').pop()), ['a.jpg', 'b.JPG']);
  assert.equal(filtered.assets[1].mimeType, 'image/jpeg');
  assert.equal(filtered.excludedAssetCount, 3);
  assert.equal(filtered.folders.length, 1);

  // Without an allowlist: previous behavior (any image/* or unknown)
  const unfiltered = await aem.browseDamFolder('/content/dam/x');
  assert.deepEqual(unfiltered.assets.map((a) => a.assetPath.split('/').pop()), ['a.jpg', 'b.JPG', 'd.svg', 'e.bin']);
});

// ---------------------------------------------------------------------------
// Rekognition collection check
// ---------------------------------------------------------------------------

test('COST: the collection is checked at most once per request', async () => {
  const calls = [];
  const client = {
    async send(cmd) {
      calls.push(cmd.constructor.name);
      if (cmd.constructor.name === 'IndexFacesCommand') return { FaceRecords: [] };
      return {};
    }
  };
  const rek = createRekognitionService({ awsAccessKeyId: 'a', awsSecretAccessKey: 'b' }, client, { sleep: async () => {} });
  await rek.indexAssetFaces(Buffer.from('x'), 'a');
  await rek.indexAssetFaces(Buffer.from('y'), 'b');
  await rek.ensureCollection();
  assert.equal(calls.filter((c) => c === 'DescribeCollectionCommand').length, 1);
  assert.equal(calls.filter((c) => c === 'IndexFacesCommand').length, 2);
});

// ---------------------------------------------------------------------------
// AEM upload events
// ---------------------------------------------------------------------------

test('COST: an AEM upload event for a PDF is skipped without calling AEM or AWS', async () => {
  const ingestAction = require('../actions/ingest/index');
  const prevCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-cost-evt-'));
  const prevFetch = global.fetch;
  const fetched = [];
  global.fetch = async (url) => {
    fetched.push(String(url));
    throw new Error('network should not be used');
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

    const res = await ingestAction.main({
      AEM_HOST: AEM,
      event: {
        'activitystreams:object': {
          'xdmAsset:path': '/content/dam/docs/report.pdf',
          'xdmAsset:asset_id': 'urn:aaid:aem:aaaa-bbbb',
          'xdmAsset:format': 'application/pdf'
        }
      }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.skipped, true);
    assert.equal(res.body.reasonCode, 'unsupported-type');
    assert.deepEqual(fetched, []);
  } finally {
    process.chdir(prevCwd);
    global.fetch = prevFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
