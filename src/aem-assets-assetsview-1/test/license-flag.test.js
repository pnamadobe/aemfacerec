const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

function load(file) {
  const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
    filename: file, babelrc: false, configFile: false,
    presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }]]
  });
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(code, file);
  return mod.exports;
}
const { withLicenseFlag, licensePeopleKey } = load(path.join(__dirname, '../web-src/src/utils/license-flag.js'));

test('a scan result keeps the license-suggestions flag the panel already knew', () => {
  const afterScan = withLicenseFlag({ licenseSuggestionsEnabled: true, faces: [] }, { faceCount: 2, faces: [{}, {}] });
  assert.equal(afterScan.licenseSuggestionsEnabled, true);
  assert.equal(afterScan.faceCount, 2);
});

test('an explicit flag on the new data wins, and unknown stays unknown', () => {
  assert.equal(withLicenseFlag({ licenseSuggestionsEnabled: true }, { licenseSuggestionsEnabled: false }).licenseSuggestionsEnabled, false);
  assert.equal(withLicenseFlag(null, { a: 1 }).licenseSuggestionsEnabled, undefined);
  assert.equal(withLicenseFlag({ a: 1 }, { b: 2 }).licenseSuggestionsEnabled, undefined);
  assert.equal(withLicenseFlag({ licenseSuggestionsEnabled: true }, null), null);
});

test('people key changes when a re-scan changes who is in the asset', () => {
  assert.equal(licensePeopleKey([{ groupId: 'b' }, { groupId: 'a' }]), 'a,b');
  assert.notEqual(licensePeopleKey([{ groupId: 'a' }]), licensePeopleKey([{ groupId: 'c' }]));
  assert.equal(licensePeopleKey(undefined), '');
  assert.equal(licensePeopleKey([{}, { groupId: 'x' }]), 'x');
});
