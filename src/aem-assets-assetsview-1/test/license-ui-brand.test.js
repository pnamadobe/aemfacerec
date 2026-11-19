/**
 * Brand consistency guard for the license-suggestion screens: they must be built from
 * Adobe Spectrum components and tokens, not hand-rolled controls or hard-coded colors.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '../web-src/src/components');
const FILES = ['LicenseSuggestionRow.js', 'LicenseReviewModal.js', 'LicensePropertiesView.js', 'PdfPagesView.js'];
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

test('no hard-coded hex colors (use Spectrum color tokens and semantic variants)', () => {
  for (const f of FILES) {
    const hits = read(f).match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepEqual(hits, [], `${f} contains hex colors: ${hits.join(', ')}`);
  }
});

test('no raw interactive HTML controls (use Spectrum Button, Tabs, TextField)', () => {
  for (const f of FILES) {
    const src = read(f);
    for (const tag of ['<button', '<input', '<select', '<textarea', 'role="tab"', 'window.confirm']) {
      assert.ok(!src.includes(tag), `${f} uses ${tag}`);
    }
  }
});

test('buttons use Spectrum variants and the primary action is the single accent button', () => {
  const modal = read('LicenseReviewModal.js');
  assert.equal((modal.match(/variant="accent"/g) || []).length, 1);
  assert.ok(modal.includes('Tabs') && modal.includes('ButtonGroup') && modal.includes('InlineAlert'));
  assert.ok(read('LicensePropertiesView.js').includes('Badge') && read('LicensePropertiesView.js').includes('TagGroup'));
});

test('UI copy is sentence case and avoids em dashes', () => {
  for (const f of FILES) {
    const strings = (read(f).match(/>([^<>{}\n]{3,})</g) || []).map((m) => m.slice(1, -1).trim());
    for (const text of strings) {
      assert.ok(!text.includes('—'), `${f}: em dash in "${text}"`);
      assert.ok(!/^[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+/.test(text), `${f}: Title Case in "${text}"`);
    }
  }
});
