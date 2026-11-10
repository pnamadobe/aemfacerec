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
