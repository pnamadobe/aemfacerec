/**
 * Browser-Side Video Scene-Change Detector & Keyframe Extractor (`<video>` + `<canvas>`)
 *
 * Implements the two-pass Shot-Clamped Offset strategy in pure browser JS:
 * 1. Pass 1 (Coarse Luma-SAD Scene Scan):
 *    Steps through an offscreen muted `<video>` element at ~0.25s-0.5s intervals, draws each frame
 *    onto a tiny 64x36 `<canvas>`, computes the normalized Mean Absolute Frame Difference (MAFD)
 *    in Luma (Y = 0.299R + 0.587G + 0.114B), and records scene cut timestamps where MAFD > threshold.
 * 2. Shot-Clamped Sample Planning:
 *    For each shot `[t_start, t_end)` with duration `d >= 0.20s`:
 *      t_sample = t_start + min(shotOffsetSec, 0.45 * d)
 *    Plus periodic samples (`maxSampleIntervalSec`, default 4.0s) for long takes (`d > 5.0s`),
 *    capped at `maxFramesPerAsset` (default 24).
 * 3. Pass 2 (High-Resolution Keyframe Capture):
 *    Seeks to each `t_sample`, draws to a `<= 1280px` `<canvas>`, and exports a compact JPEG
 *    data URL (`quality = 0.84`, ~40-65 KB) ready for chunked upload to `ingestVideoFrames`.
 */

const PROBE_WIDTH = 64;
const PROBE_HEIGHT = 36;
const MAX_CAPTURE_DIM = 1280;

export function isVideoPathOrMime(assetPath = '', mimeType = '') {
  const cleanMime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (cleanMime.startsWith('video/')) return true;
  return /\.(mp4|mov|webm|m4v|avi|mkv|mpeg|mpg)$/i.test(String(assetPath || '').trim());
}

export function formatVideoTimestamp(seconds, { includeTenths = true } = {}) {
  const clean = Math.max(0, Number(seconds) || 0);
  const roundedTenths = Math.round(clean * 10) / 10;
  const wholeSeconds = Math.floor(roundedTenths);
  const tenths = Math.round((roundedTenths - wholeSeconds) * 10);
  const hrs = Math.floor(wholeSeconds / 3600);
  const mins = Math.floor((wholeSeconds % 3600) / 60);
  const secs = wholeSeconds % 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  const base = hrs > 0 ? `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}` : `${pad2(mins)}:${pad2(secs)}`;
  return includeTenths ? `${base}.${tenths}` : base;
}

/**
 * Pure helper (matching `actions/lib/video-extractor.js`) that computes shot-clamped sample
 * timestamps `[t_sample]` and shot bounds `[shotStart, shotEnd]` from scene cuts.
 */
export function planShotSampleTimestamps(
  cutTimestampsSec = [],
  durationSec = 0,
  {
    shotOffsetSec = 0.6,
    maxSampleIntervalSec = 4.0,
    maxFramesPerAsset = 24,
    minShotDurationSec = 0.2
  } = {}
) {
  const totalDuration = Math.max(0, Number(durationSec) || 0);
  const offset = Math.max(0, Number.isFinite(Number(shotOffsetSec)) ? Number(shotOffsetSec) : 0.6);
  const interval = Math.max(
    0.5,
    Number.isFinite(Number(maxSampleIntervalSec)) ? Number(maxSampleIntervalSec) : 4.0
  );
  const maxFrames = Math.max(1, Math.min(60, Number.parseInt(maxFramesPerAsset, 10) || 24));

  if (totalDuration <= 0) {
    return [
      {
        sampleIndex: 0,
        shotIndex: 0,
        timestampSec: 0,
        shotRangeSec: [0, 0],
        isPeriodicFallback: false
      }
    ];
  }

  const rawBounds = [
    0,
    ...(Array.isArray(cutTimestampsSec) ? cutTimestampsSec : [])
      .map((t) => Number(t))
      .filter((t) => Number.isFinite(t) && t > 0 && t < totalDuration),
    totalDuration
  ].sort((a, b) => a - b);

  const bounds = [0];
  for (let i = 1; i < rawBounds.length; i++) {
    const t = rawBounds[i];
    const prev = bounds[bounds.length - 1];
    if (i === rawBounds.length - 1) {
      if (t - prev < minShotDurationSec && bounds.length > 1) {
        bounds[bounds.length - 1] = t;
      } else {
        bounds.push(t);
      }
    } else if (t - prev >= minShotDurationSec) {
      bounds.push(t);
    }
  }

  const shots = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = Number(bounds[i].toFixed(2));
    const end = Number(bounds[i + 1].toFixed(2));
    const duration = Number((end - start).toFixed(2));
    if (duration <= 0) continue;
    shots.push({ shotIndex: shots.length, start, end, duration });
  }

  if (shots.length === 0) {
    return [
      {
        sampleIndex: 0,
        shotIndex: 0,
        timestampSec: Number(Math.min(offset, totalDuration * 0.45).toFixed(2)),
        shotRangeSec: [0, Number(totalDuration.toFixed(2))],
        isPeriodicFallback: false
      }
    ];
  }

  const candidates = [];
  for (const shot of shots) {
    const clampedDelta = Math.min(offset, 0.45 * shot.duration);
    const primaryTs = Number(Math.min(shot.end, shot.start + clampedDelta).toFixed(2));
    const sampleTimes = [primaryTs];

    if (shot.duration > Math.max(5.0, interval + offset)) {
      let nextTs = primaryTs + interval;
      while (nextTs <= shot.end - Math.min(0.5, shot.duration * 0.15)) {
        sampleTimes.push(Number(nextTs.toFixed(2)));
        nextTs += interval;
      }
    }

    for (let sIdx = 0; sIdx < sampleTimes.length; sIdx++) {
      const ts = sampleTimes[sIdx];
      const windowStart =
        sIdx === 0
          ? shot.start
          : Number(((sampleTimes[sIdx - 1] + ts) / 2).toFixed(2));
      const windowEnd =
        sIdx === sampleTimes.length - 1
          ? shot.end
          : Number(((ts + sampleTimes[sIdx + 1]) / 2).toFixed(2));
      candidates.push({
        shotIndex: shot.shotIndex,
        shotDuration: shot.duration,
        timestampSec: ts,
        shotRangeSec: [windowStart, windowEnd],
        isPeriodicFallback: sIdx > 0,
        priority: sIdx === 0 ? shot.duration + 1000 : shot.duration
      });
    }
  }

  const selected =
    candidates.length <= maxFrames
      ? candidates
      : [...candidates]
          .sort((a, b) => b.priority - a.priority || a.timestampSec - b.timestampSec)
          .slice(0, maxFrames)
          .sort((a, b) => a.timestampSec - b.timestampSec);

  return selected.map((c, idx) => ({
    sampleIndex: idx,
    shotIndex: c.shotIndex,
    timestampSec: c.timestampSec,
    shotRangeSec: c.shotRangeSec,
    isPeriodicFallback: c.isPeriodicFallback
  }));
}

/**
 * Computes normalized Mean Absolute Frame Difference (0..1) between two 64x36 Luma arrays.
 */
export function computeLumaMafd(lumaA, lumaB) {
  if (!lumaA || !lumaB || lumaA.length !== lumaB.length || lumaA.length === 0) return 0;
  let sumDiff = 0;
  for (let i = 0; i < lumaA.length; i++) {
    sumDiff += Math.abs(lumaA[i] - lumaB[i]);
  }
  return sumDiff / (lumaA.length * 255);
}

function rgbaToLumaArray(rgbaData) {
  const pixelCount = Math.floor(rgbaData.length / 4);
  const out = new Uint8Array(pixelCount);
  for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
    out[i] = Math.round(0.299 * rgbaData[p] + 0.587 * rgbaData[p + 1] + 0.114 * rgbaData[p + 2]);
  }
  return out;
}

function seekVideoElement(video, timeSec, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, Math.min(Number(video.duration) || 0, Number(timeSec) || 0));
    if (Math.abs((video.currentTime || 0) - target) < 0.01 && video.readyState >= 2) {
      resolve();
      return;
    }
    let settled = false;
    const onSeeked = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Video seek failed.'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    }

    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    try {
      video.currentTime = target;
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

/**
 * Extracts scene-change keyframes in the browser from a playable video `streamUrl`.
 * Returns `null` if the browser cannot load or CORS-read the video (allowing the caller
 * to fall back seamlessly to server-side `api.ingestAsset`).
 */
export async function extractSceneFramesInBrowser(
  streamUrl,
  {
    sceneThreshold = 0.28,
    shotOffsetSec = 0.6,
    maxSampleIntervalSec = 4.0,
    maxFramesPerAsset = 24,
    onProgress = null
  } = {}
) {
  if (!streamUrl || typeof document === 'undefined') return null;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out loading video metadata')), 10000);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('CORS or media error loading video for scene extraction'));
      };
      video.src = streamUrl;
    });

    const durationSec = Number(video.duration) || 0;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return null;
    }

    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = PROBE_WIDTH;
    probeCanvas.height = PROBE_HEIGHT;
    const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
    if (!probeCtx) return null;

    // Pass 1: Coarse Luma-SAD Scene Scan (at most 0.40s between steps so cuts in 60-90s videos are not missed)
    const probeStepSec = Math.min(0.4, Math.max(0.25, Number((durationSec / 180).toFixed(2))));
    const effectiveThreshold = Math.min(Number(sceneThreshold) || 0.28, 0.2);
    const cutTimestampsSec = [0];
    let prevLuma = null;

    for (let t = 0; t < durationSec; t += probeStepSec) {
      if (typeof onProgress === 'function') {
        onProgress({ phase: 'detecting-scenes', currentTimeSec: Number(t.toFixed(1)), durationSec });
      }
      // eslint-disable-next-line no-await-in-loop
      await seekVideoElement(video, t);
      probeCtx.drawImage(video, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
      // Accessing getImageData also verifies the canvas is not CORS-tainted
      const imgData = probeCtx.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
      const currLuma = rgbaToLumaArray(imgData.data);
      if (prevLuma) {
        const mafd = computeLumaMafd(prevLuma, currLuma);
        if (mafd >= effectiveThreshold) {
          cutTimestampsSec.push(Number(t.toFixed(2)));
        }
      }
      prevLuma = currLuma;
    }

    const planned = planShotSampleTimestamps(cutTimestampsSec, durationSec, {
      shotOffsetSec,
      maxSampleIntervalSec,
      maxFramesPerAsset
    });

    // Pass 2: High-res frame capture at each clamped shot timestamp
    const srcW = Number(video.videoWidth) || 640;
    const srcH = Number(video.videoHeight) || 360;
    const scale = Math.min(1, MAX_CAPTURE_DIM / Math.max(srcW, srcH));
    const capW = Math.max(64, Math.round(srcW * scale));
    const capH = Math.max(64, Math.round(srcH * scale));

    const capCanvas = document.createElement('canvas');
    capCanvas.width = capW;
    capCanvas.height = capH;
    const capCtx = capCanvas.getContext('2d');

    const frames = [];
    for (let i = 0; i < planned.length; i++) {
      const sample = planned[i];
      if (typeof onProgress === 'function') {
        onProgress({
          phase: 'extracting-frames',
          completedFrames: i,
          totalFrames: planned.length,
          timestampSec: sample.timestampSec
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await seekVideoElement(video, sample.timestampSec);
      capCtx.drawImage(video, 0, 0, capW, capH);
      const dataUrl = capCanvas.toDataURL('image/jpeg', 0.84);
      frames.push({
        sampleIndex: sample.sampleIndex,
        shotIndex: sample.shotIndex,
        timestampSec: sample.timestampSec,
        shotRangeSec: sample.shotRangeSec,
        imageBase64: dataUrl
      });
    }

    return {
      extractionMode: 'browser-scene',
      durationSec: Number(durationSec.toFixed(2)),
      cutTimestampsSec,
      frames
    };
  } catch (e) {
    return null;
  } finally {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch (e) {
      // ignore
    }
  }
}
