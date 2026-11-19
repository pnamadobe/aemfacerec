/**
 * Extracts embedded JPEG (DCTDecode) images from a PDF buffer without any PDF library.
 *
 * Contract PDFs carry the signer's headshot as an unfiltered DCT stream, so the raw stream
 * bytes are already a valid JPEG. Only images (not text/vector content) are returned, largest
 * first. This deliberately handles only DCTDecode; other filters are ignored.
 */
const MIN_IMAGE_BYTES = 8 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);

function extractJpegImages(pdfBuffer, { minBytes = MIN_IMAGE_BYTES } = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) return [];
  if (pdfBuffer.length > MAX_PDF_BYTES) return [];
  if (pdfBuffer.slice(0, 5).toString('latin1') !== '%PDF-') return [];

  const text = pdfBuffer.toString('latin1');
  const images = [];
  const objRe = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bstream\r?\n/g;
  let m;
  while ((m = objRe.exec(text)) !== null) {
    const dict = m[3];
    if (!/\/Subtype\s*\/Image/.test(dict) || !/\/DCTDecode/.test(dict)) continue;
    const start = objRe.lastIndex;
    const lengthMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    let end = lengthMatch ? start + Number(lengthMatch[1]) : -1;
    if (end <= start || end > pdfBuffer.length || !/^\s*endstream/.test(text.slice(end, end + 12))) {
      end = text.indexOf('endstream', start);
      if (end < 0) continue;
      while (end > start && (text[end - 1] === '\n' || text[end - 1] === '\r')) end -= 1;
    }
    const data = pdfBuffer.slice(start, end);
    if (data.length < minBytes || data.slice(0, 3).compare(JPEG_SOI) !== 0) continue;
    const width = Number((dict.match(/\/Width\s+(\d+)/) || [])[1]) || null;
    const height = Number((dict.match(/\/Height\s+(\d+)/) || [])[1]) || null;
    images.push({ data, width, height, bytes: data.length });
  }
  return images.sort((a, b) => b.bytes - a.bytes);
}

module.exports = { extractJpegImages, MAX_PDF_BYTES };
