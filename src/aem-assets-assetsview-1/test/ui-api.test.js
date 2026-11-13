const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

/**
 * Loads the browser ESM module web-src/src/utils/api.js in Node by transpiling it to CommonJS.
 */
function loadApiModule() {
  const file = path.join(__dirname, '../web-src/src/utils/api.js');
  const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
    filename: file,
    babelrc: false,
    configFile: false,
    presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }]]
  });
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(code, file);
  return mod.exports;
}

const { resultBanner } = loadApiModule();

test('UI: successful results produce a positive banner', () => {
  const b = resultBanner('Saved.', { syncedAssetCount: 3, failedAssetCount: 0, failedAssets: [] });
  assert.deepEqual(b, { type: 'positive', text: 'Saved.' });
  // Older/empty responses (e.g. local preview mode) stay positive
  assert.deepEqual(resultBanner('Done.', {}), { type: 'positive', text: 'Done.' });
  assert.deepEqual(resultBanner('Done.'), { type: 'positive', text: 'Done.' });
});

test('UI: failed AEM metadata writes produce a warning banner', () => {
  const b = resultBanner('Saved name "Alice".', {
    failedAssetCount: 2,
    failedAssets: [{ assetPath: '/content/dam/a.jpg', error: 'AEM metadata update failed.' }]
  });
  assert.equal(b.type, 'negative');
  assert.match(b.text, /^Saved name "Alice"\. Warning: /);
  assert.match(b.text, /2 asset\(s\)/);
  assert.match(b.text, /\/content\/dam\/a\.jpg/);
});

test('UI: single-asset scan with metadata failure produces a warning banner', () => {
  const b = resultBanner('Scanned 2 face(s).', { metadataSynced: false, metadataSyncError: 'AEM metadata update failed.' });
  assert.equal(b.type, 'negative');
  assert.match(b.text, /AEM metadata update failed/);
  assert.equal(resultBanner('Scanned.', { metadataSynced: true }).type, 'positive');
});

test('UI: folder scans with failed items produce a warning banner', () => {
  const b = resultBanner('Folder scan complete.', {
    results: [
      { assetPath: '/content/dam/1.jpg', status: 'processed' },
      { assetPath: '/content/dam/2.tif', status: 'error', error: 'This image format is not supported.' }
    ]
  });
  assert.equal(b.type, 'negative');
  assert.match(b.text, /1 asset\(s\) failed/);
  assert.match(b.text, /2\.tif/);
});

// ---------------------------------------------------------------------------
// Folder scan (client side): skip already-scanned images before calling the backend
// ---------------------------------------------------------------------------

function withFakeBackend(browseResult, fn) {
  const calls = [];
  const prevWindow = global.window;
  const prevFetch = global.fetch;
  global.window = { __AIO_ACTION_URLS__: { ingest: 'https://runtime.test/ingest' } };
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    let result;
    if (body.operation === 'browseFolder') {
      result = browseResult;
    } else {
      result = {
        results: body.assets.map((a) => ({ assetPath: a.assetPath, status: 'processed', faceCount: 2 }))
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(result) };
  };
  return Promise.resolve(fn(calls)).finally(() => {
    global.window = prevWindow;
    global.fetch = prevFetch;
  });
}

const browsed = {
  folderPath: '/content/dam/f',
  excludedAssetCount: 3,
  assets: Array.from({ length: 12 }, (_, i) => ({
    assetId: `id${i}`,
    assetPath: `/content/dam/f/${i}.jpg`,
    assetTitle: `${i}.jpg`,
    mimeType: 'image/jpeg',
    scanned: i < 9, // 9 already scanned, 3 new
    faceCount: i < 9 ? 1 : 0
  }))
};

test('UI scanFolder: only new images are sent to the backend by default', async () => {
  const { api } = loadApiModule();
  await withFakeBackend(browsed, async (calls) => {
    const progress = [];
    const res = await api.scanFolder('/content/dam/f', {}, (p) => progress.push(p.completed));
    const scanCalls = calls.filter((c) => c.operation === 'scanFolder');
    assert.equal(scanCalls.length, 1);
    assert.deepEqual(scanCalls[0].assets.map((a) => a.assetPath), ['/content/dam/f/9.jpg', '/content/dam/f/10.jpg', '/content/dam/f/11.jpg']);
    assert.equal(scanCalls[0].rescan, false);
    assert.equal(scanCalls[0].assets[0].mimeType, 'image/jpeg');
    assert.deepEqual(res.summary, {
      scanned: 3,
      faces: 6,
      skipped: 9,
      skippedByReason: { 'already-scanned': 9 },
      failed: 0,
      excluded: 3
    });
    assert.deepEqual(progress, [3]);
  });
});

test('UI scanFolder: a folder where everything is already scanned makes no scan calls', async () => {
  const { api } = loadApiModule();
  const allScanned = { ...browsed, assets: browsed.assets.map((a) => ({ ...a, scanned: true })) };
  await withFakeBackend(allScanned, async (calls) => {
    const res = await api.scanFolder('/content/dam/f', {});
    assert.equal(calls.filter((c) => c.operation === 'scanFolder').length, 0);
    assert.equal(res.summary.skipped, 12);
    assert.equal(res.summary.scanned, 0);
  });
});

test('UI scanFolder: "include already-scanned" sends everything in batches of 5', async () => {
  const { api } = loadApiModule();
  await withFakeBackend(browsed, async (calls) => {
    const res = await api.scanFolder('/content/dam/f', {}, null, { rescan: true });
    const scanCalls = calls.filter((c) => c.operation === 'scanFolder');
    assert.deepEqual(scanCalls.map((c) => c.assets.length), [5, 5, 2]);
    assert.ok(scanCalls.every((c) => c.rescan === true));
    assert.equal(res.summary.scanned, 12);
  });
});

test('UI: scan summary text', () => {
  const { describeScanSummary, summarizeScanResults } = loadApiModule();
  const summary = summarizeScanResults(
    [
      { status: 'processed', faceCount: 2 },
      { status: 'skipped', reasonCode: 'already-scanned' },
      { status: 'skipped', reasonCode: 'already-scanned' },
      { status: 'skipped', reasonCode: 'too-small' },
      { status: 'skipped', reasonCode: 'unsupported-type' },
      { status: 'error', error: 'x' }
    ],
    4
  );
  assert.equal(
    describeScanSummary(summary),
    'Analyzed 1 image(s) (2 face(s)). Skipped 4: 2 already scanned, 1 too small, 1 unsupported file type. 4 non-image or excluded file type(s) ignored.'
  );
  assert.equal(describeScanSummary(summarizeScanResults([])), 'Analyzed 0 image(s) (0 face(s)).');
});

test('UI: getActionUrl resolves current workspace action URL from window.location.origin on *.adobeio-static.net', () => {
  const { getActionUrl } = loadApiModule();
  const prevWindow = global.window;
  try {
    global.window = {
      location: {
        origin: 'https://12345-customerapp.adobeio-static.net',
        hostname: '12345-customerapp.adobeio-static.net'
      }
    };
    assert.equal(
      getActionUrl('groups'),
      'https://12345-customerapp.adobeio-static.net/api/v1/web/aem-assets-assetsview-1/groups'
    );
    assert.equal(
      getActionUrl('ingest'),
      'https://12345-customerapp.adobeio-static.net/api/v1/web/aem-assets-assetsview-1/ingest'
    );
    assert.equal(
      getActionUrl('settings'),
      'https://12345-customerapp.adobeio-static.net/api/v1/web/aem-assets-assetsview-1/settings'
    );
  } finally {
    global.window = prevWindow;
  }
});

