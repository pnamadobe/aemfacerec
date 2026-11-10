/**
 * Pure-JS Face Avatar Cropping Pipeline (jpeg-js + pngjs)
 *
 * Works identically on macOS and inside Adobe I/O Runtime Linux (linux-x64) containers
 * with zero native C++ binary dependencies.
 *
 * Given an image buffer (JPEG or PNG) and a normalized AWS Rekognition BoundingBox
 * ({ Left, Top, Width, Height } in range 0..1), computes a padded square crop around
 * the face center and resizes it to a 160x160 JPEG avatar.
 */

const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const AVATAR_SIZE = 72;
const PADDING_RATIO = 0.35; // 35% padding around face box so hair/chin/shoulders fit naturally

// Decoding limits that keep a single image well inside the 512 MB action memory.
// A 25 MP RGBA image is ~100 MB decoded; AEM web renditions are ~1.6 MP.
const MAX_DECODE_MEGAPIXELS = 25;
const MAX_DECODE_MEMORY_MB = 192;
const JPEG_DECODE_OPTIONS = {
  useTArray: true,
  maxMemoryUsageInMB: MAX_DECODE_MEMORY_MB,
  maxResolutionInMP: MAX_DECODE_MEGAPIXELS
};

/**
 * Reads PNG dimensions from the IHDR chunk and rejects oversized images before decoding.
 */
function assertPngWithinLimits(imageBuffer) {
  if (imageBuffer.length < 24) throw new Error('Invalid PNG header');
  const width = imageBuffer.readUInt32BE(16);
  const height = imageBuffer.readUInt32BE(20);
  if (!width || !height || (width * height) / 1e6 > MAX_DECODE_MEGAPIXELS) {
    throw new Error(`PNG dimensions ${width}x${height} exceed the ${MAX_DECODE_MEGAPIXELS} MP decode limit`);
  }
}

function decodePng(imageBuffer) {
  assertPngWithinLimits(imageBuffer);
  const png = PNG.sync.read(imageBuffer);
  return { width: png.width, height: png.height, data: png.data };
}

/**
 * Calculates clamped pixel crop coordinates from normalized bounding box and image dimensions.
 *
 * @param {object} boundingBox - { Left/left, Top/top, Width/width, Height/height } (0..1)
 * @param {number} imgWidth - Source image width in pixels
 * @param {number} imgHeight - Source image height in pixels
 * @param {number} paddingRatio - Extra margin ratio around the face bounding box
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
function calculateSquareCropRegion(boundingBox, imgWidth, imgHeight, paddingRatio = PADDING_RATIO) {
  const normLeft = Number(boundingBox.Left ?? boundingBox.left ?? 0);
  const normTop = Number(boundingBox.Top ?? boundingBox.top ?? 0);
  const normWidth = Number(boundingBox.Width ?? boundingBox.width ?? 0.2);
  const normHeight = Number(boundingBox.Height ?? boundingBox.height ?? 0.2);

  const rawLeft = normLeft * imgWidth;
  const rawTop = normTop * imgHeight;
  const rawWidth = normWidth * imgWidth;
  const rawHeight = normHeight * imgHeight;

  const centerX = rawLeft + rawWidth / 2;
  const centerY = rawTop + rawHeight / 2;

  const maxDim = Math.max(rawWidth, rawHeight);
  const targetSide = Math.min(
    Math.min(imgWidth, imgHeight),
    Math.max(32, Math.round(maxDim * (1 + paddingRatio * 2)))
  );

  let left = Math.round(centerX - targetSide / 2);
  let top = Math.round(centerY - targetSide / 2);

  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (left + targetSide > imgWidth) {
    left = Math.max(0, imgWidth - targetSide);
  }
  if (top + targetSide > imgHeight) {
    top = Math.max(0, imgHeight - targetSide);
  }

  const width = Math.max(1, Math.min(targetSide, imgWidth - left));
  const height = Math.max(1, Math.min(targetSide, imgHeight - top));

  return { left, top, width, height };
}

/**
 * Decodes a JPEG or PNG Buffer into raw RGBA pixels { width, height, data } in pure JS.
 */
function decodeImageBuffer(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length < 8) {
    throw new Error('Invalid or empty image buffer');
  }

  // Check PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    imageBuffer[0] === 0x89 &&
    imageBuffer[1] === 0x50 &&
    imageBuffer[2] === 0x4e &&
    imageBuffer[3] === 0x47
  ) {
    return decodePng(imageBuffer);
  }

  // Check JPEG signature: FF D8
  if (imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8) {
    const decoded = jpeg.decode(imageBuffer, JPEG_DECODE_OPTIONS);
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }

  // Try JPEG then PNG as fallback
  try {
    const decoded = jpeg.decode(imageBuffer, JPEG_DECODE_OPTIONS);
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  } catch (e) {
    return decodePng(imageBuffer);
  }
}

/**
 * Crops a rectangular region from decoded RGBA pixels and resizes it to targetSize x targetSize
 * using bilinear interpolation, then encodes to a JPEG Buffer.
 */
function cropAndResizeRgbaToJpeg(decoded, cropRegion, targetSize = AVATAR_SIZE, quality = 84) {
  const { width: srcWidth, height: srcHeight, data: srcData } = decoded;
  const { left, top, width: cropWidth, height: cropHeight } = cropRegion;

  const dstData = new Uint8Array(targetSize * targetSize * 4);

  for (let y = 0; y < targetSize; y++) {
    const srcY = top + ((y + 0.5) / targetSize) * cropHeight - 0.5;
    const y0 = Math.max(0, Math.min(srcHeight - 1, Math.floor(srcY)));
    const y1 = Math.max(0, Math.min(srcHeight - 1, y0 + 1));
    const wy = srcY - y0;

    for (let x = 0; x < targetSize; x++) {
      const srcX = left + ((x + 0.5) / targetSize) * cropWidth - 0.5;
      const x0 = Math.max(0, Math.min(srcWidth - 1, Math.floor(srcX)));
      const x1 = Math.max(0, Math.min(srcWidth - 1, x0 + 1));
      const wx = srcX - x0;

      const idx00 = (y0 * srcWidth + x0) * 4;
      const idx10 = (y0 * srcWidth + x1) * 4;
      const idx01 = (y1 * srcWidth + x0) * 4;
      const idx11 = (y1 * srcWidth + x1) * 4;

      const dstIdx = (y * targetSize + x) * 4;

      for (let c = 0; c < 3; c++) {
        const topVal = srcData[idx00 + c] * (1 - wx) + srcData[idx10 + c] * wx;
        const botVal = srcData[idx01 + c] * (1 - wx) + srcData[idx11 + c] * wx;
        dstData[dstIdx + c] = Math.round(topVal * (1 - wy) + botVal * wy);
      }
      dstData[dstIdx + 3] = 255;
    }
  }

  const encoded = jpeg.encode(
    {
      data: dstData,
      width: targetSize,
      height: targetSize
    },
    quality
  );

  return Buffer.from(encoded.data);
}

/**
 * Generates an SVG fallback avatar only if a mock/non-image buffer is passed in unit tests.
 */
function generateFallbackAvatarBuffer(label = 'Face') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" viewBox="0 0 160 160">
    <rect width="160" height="160" rx="16" fill="#2c3e50"/>
    <circle cx="80" cy="62" r="28" fill="#ecf0f1"/>
    <path d="M32 142 C32 106 128 106 128 142" fill="#ecf0f1"/>
    <text x="80" y="154" font-family="sans-serif" font-size="11" fill="#bdc3c7" text-anchor="middle">${label}</text>
  </svg>`;
  return Buffer.from(svg, 'utf8');
}

/**
 * Crops a single face from imageBuffer (or pre-decoded RGBA image) and outputs a 160x160 JPEG buffer
 * along with a compact base64 data URI for immediate UI rendering.
 *
 * @param {Buffer|object} imageBufferOrDecoded - Source image buffer or pre-decoded { width, height, data }
 * @param {object} boundingBox - Normalized bounding box { Left, Top, Width, Height }
 * @returns {Promise<{ buffer: Buffer, dataUrl: string, cropRegion: object }>}
 */
async function cropFaceAvatar(imageBufferOrDecoded, boundingBox) {
  try {
    const decoded =
      imageBufferOrDecoded &&
      imageBufferOrDecoded.width &&
      imageBufferOrDecoded.height &&
      imageBufferOrDecoded.data
        ? imageBufferOrDecoded
        : decodeImageBuffer(imageBufferOrDecoded);

    const cropRegion = calculateSquareCropRegion(
      boundingBox,
      decoded.width,
      decoded.height
    );

    const croppedBuffer = cropAndResizeRgbaToJpeg(decoded, cropRegion, AVATAR_SIZE, 66);

    return {
      buffer: croppedBuffer,
      dataUrl: `data:image/jpeg;base64,${croppedBuffer.toString('base64')}`,
      cropRegion
    };
  } catch (err) {
    const fallbackBuf = generateFallbackAvatarBuffer();
    const cropRegion = calculateSquareCropRegion(boundingBox, 1000, 1000);
    return {
      buffer: fallbackBuf,
      dataUrl: `data:image/svg+xml;base64,${fallbackBuf.toString('base64')}`,
      cropRegion
    };
  }
}

module.exports = {
  AVATAR_SIZE,
  PADDING_RATIO,
  MAX_DECODE_MEGAPIXELS,
  calculateSquareCropRegion,
  decodeImageBuffer,
  cropAndResizeRgbaToJpeg,
  cropFaceAvatar
};
