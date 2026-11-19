const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractJpegImages } = require('../actions/lib/pdf-headshot');

const LICENSES_DIR = path.resolve(__dirname, '../../../licenses');
const pdfs = fs.existsSync(LICENSES_DIR)
  ? fs.readdirSync(LICENSES_DIR).filter((f) => f.endsWith('.pdf'))
  : [];

test('extracts the embedded headshot JPEG from each sample contract', { skip: pdfs.length === 0 }, () => {
  for (const f of pdfs) {
    const images = extractJpegImages(fs.readFileSync(path.join(LICENSES_DIR, f)));
    assert.equal(images.length, 1, f);
    assert.equal(images[0].width, 1856);
    assert.equal(images[0].height, 2304);
    assert.equal(images[0].data.slice(0, 3).toString('hex'), 'ffd8ff');
    assert.equal(images[0].data.slice(-2).toString('hex'), 'ffd9', 'complete JPEG (EOI marker)');
  }
});

test('returns [] for non-PDF, empty and image-free input', () => {
  assert.deepEqual(extractJpegImages(Buffer.from('hello')), []);
  assert.deepEqual(extractJpegImages(Buffer.alloc(0)), []);
  assert.deepEqual(extractJpegImages(null), []);
  assert.deepEqual(extractJpegImages(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n')), []);
});
