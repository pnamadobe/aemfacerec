/**
 * Video Scene-Change Shot Planning, Timestamp Formatting & Server-Side FFmpeg Helper
 *
 * Implements:
 * 1. `planShotSampleTimestamps(cutTimestampsSec, durationSec, options)`:
 *    Given scene-cut timestamps (from FFmpeg `scdet` or browser Luma-SAD scan) and video duration:
 *    - Filters out sub-0.20s flash/strobe frames.
 *    - Applies the Shot-Clamped Offset formula:
 *        t_sample = t_start + min(shotOffsetSec, 0.45 * shotDuration)
 *      so normal cuts settle past cross-dissolves/whip-pans/pre-laps (+0.60s default) while rapid
 *      commercial cuts (< 1.2s) sample near the shot midpoint without bleeding into the next scene.
 *    - Adds periodic fallback samples (`maxSampleIntervalSec`, default 4.0s) inside long takes (> 5.0s).
 *    - Enforces `maxFramesPerAsset` (default 24): if more samples exist, prioritizes the primary sample
 *      of the longest shots first so every major scene is covered within the Rekognition cost cap (`V1`).
 * 2. `formatVideoTimestamp(seconds)` & `parseVideoTimestamp(value)`:
 *    Formats seconds as `MM:SS.d` (e.g. `4.2` -> `"00:04.2"`, `75.5` -> `"01:15.5"`) for `xdm:faceTimestamps`
 *    and UI pills, and parses `"MM:SS.d"` or numeric strings back to seconds.
 * 3. `extractVideoFramesWithFfmpeg(streamUrl, options)`:
 *    Optional server-side two-pass FFmpeg extractor (`scdet` + input-side HTTP Range `-ss` seek) when
 *    an `ffmpeg` binary is available (`process.env.FFMPEG_PATH` or `/tmp/ffmpeg`). Returns `null` cleanly
 *    when `ffmpeg` is not installed so `face-service.js` can fall back to the AEM video poster rendition.
 */

const fs = require('fs');
const { spawn } = require('child_process');

const DEFAULT_SHOT_OFFSET_SEC = 0.6;
const DEFAULT_MAX_SAMPLE_INTERVAL_SEC = 4.0;
const DEFAULT_MAX_FRAMES_PER_ASSET = 24;
const MIN_SHOT_DURATION_SEC = 0.2;
const LONG_TAKE_THRESHOLD_SEC = 5.0;

/**
 * Formats a timestamp in seconds into `MM:SS.d` (or `HH:MM:SS.d` if >= 1 hour).
 *
 * @param {number} seconds
 * @param {{ includeTenths?: boolean }} [options]
 * @returns {string}
 */
function formatVideoTimestamp(seconds, { includeTenths = true } = {}) {
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
 * Parses a timestamp string (`"14.5"`, `"00:14.5"`, `"01:02:03.4"`) or number into seconds.
 * Returns `null` if invalid.
 */
function parseVideoTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Number(value.toFixed(2)) : null;
  }
  const str = String(value).trim();
  if (!str) return null;
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    const n = Number(str);
    return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(2)) : null;
  }
  const parts = str.split(':');
  if (parts.length === 2 || parts.length === 3) {
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
    const total =
      parts.length === 3
        ? nums[0] * 3600 + nums[1] * 60 + nums[2]
        : nums[0] * 60 + nums[1];
    return Number(total.toFixed(2));
  }
  return null;
}

/**
 * Computes clamped sample timestamps and shot intervals `[shotStartSec, shotEndSec]`
 * from a list of detected scene-cut timestamps and total video duration.
 *
 * @param {number[]} cutTimestampsSec - Scene cut times in seconds (e.g. `[0, 3.6, 8.1]`)
 * @param {number} durationSec - Total video duration in seconds
 * @param {object} [options]
 * @param {number} [options.shotOffsetSec=0.6] - Target delay after cut (clamped to 45% of shot)
 * @param {number} [options.maxSampleIntervalSec=4.0] - Periodic re-sample interval for long takes
 * @param {number} [options.maxFramesPerAsset=24] - Hard cap on returned sample frames
 * @param {number} [options.minShotDurationSec=0.2] - Minimum shot length to ignore flash frames
 * @returns {Array<{ sampleIndex: number, shotIndex: number, timestampSec: number, shotRangeSec: [number, number], isPeriodicFallback: boolean }>}
 */
function planShotSampleTimestamps(
  cutTimestampsSec = [],
  durationSec = 0,
  {
    shotOffsetSec = DEFAULT_SHOT_OFFSET_SEC,
    maxSampleIntervalSec = DEFAULT_MAX_SAMPLE_INTERVAL_SEC,
    maxFramesPerAsset = DEFAULT_MAX_FRAMES_PER_ASSET,
    minShotDurationSec = MIN_SHOT_DURATION_SEC
  } = {}
) {
  const totalDuration = Math.max(0, Number(durationSec) || 0);
  const offset = Math.max(0, Number.isFinite(Number(shotOffsetSec)) ? Number(shotOffsetSec) : DEFAULT_SHOT_OFFSET_SEC);
  const interval = Math.max(
    0.5,
    Number.isFinite(Number(maxSampleIntervalSec))
      ? Number(maxSampleIntervalSec)
      : DEFAULT_MAX_SAMPLE_INTERVAL_SEC
  );
  const maxFrames = Math.max(
    1,
    Math.min(60, Number.parseInt(maxFramesPerAsset, 10) || DEFAULT_MAX_FRAMES_PER_ASSET)
  );

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

  // Normalize, clamp, and deduplicate cut boundaries
  const rawBounds = [
    0,
    ...(Array.isArray(cutTimestampsSec) ? cutTimestampsSec : [])
      .map((t) => Number(t))
      .filter((t) => Number.isFinite(t) && t > 0 && t < totalDuration),
    totalDuration
  ].sort((a, b) => a - b);

  // Merge cut boundaries that are closer than minShotDurationSec (flash frames)
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

  // Generate primary clamped-offset sample + optional long-take periodic samples per shot
  const candidates = [];
  for (const shot of shots) {
    const clampedDelta = Math.min(offset, 0.45 * shot.duration);
    const primaryTs = Number(Math.min(shot.end, shot.start + clampedDelta).toFixed(2));
    const sampleTimes = [primaryTs];

    if (shot.duration > Math.max(LONG_TAKE_THRESHOLD_SEC, interval + offset)) {
      let nextTs = primaryTs + interval;
      while (nextTs <= shot.end - Math.min(0.5, shot.duration * 0.15)) {
        sampleTimes.push(Number(nextTs.toFixed(2)));
        nextTs += interval;
      }
    }

    // Partition long shots into sub-windows around each sample timestamp so bounding boxes
    // from t=4.6s never display at t=0.6s
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

  // Enforce maxFramesPerAsset cap by keeping highest-priority samples, then re-sorting chronologically
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
 * Computes a composite quality score for a detected face to pick the sharpest, most frontal
 * avatar when the same person appears across multiple frames of a video.
 */
function computeFaceFrameQualityScore(boundingBox = {}, confidence = 99) {
  const w = Math.max(0.01, Number(boundingBox.width ?? boundingBox.Width ?? 0.15));
  const h = Math.max(0.01, Number(boundingBox.height ?? boundingBox.Height ?? 0.15));
  const left = Number(boundingBox.left ?? boundingBox.Left ?? 0.4);
  const top = Number(boundingBox.top ?? boundingBox.Top ?? 0.3);
  const conf = Math.max(1, Number(confidence) || 90);

  // Penalize faces clipped against the extreme edges of the frame
  const centerX = left + w / 2;
  const centerY = top + h / 2;
  const edgeMargin = Math.min(centerX, 1 - centerX, centerY, 1 - centerY);
  const edgeFactor = edgeMargin < 0.08 ? 0.65 : 1.0;

  return Number((conf * Math.sqrt(w * h) * edgeFactor).toFixed(4));
}

/**
 * Resolves an available `ffmpeg` binary path if present on the system or in `/tmp/ffmpeg`.
 */
function resolveFfmpegBinaryPath() {
  const candidates = [
    process.env.FFMPEG_PATH,
    '/tmp/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/bin/ffmpeg'
  ].filter(Boolean);

  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand)) return cand;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

/**
 * Runs a child process and collects stdout/stderr buffers with a timeout.
 */
function runProcess(bin, args, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch (e) {
        // ignore
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks)
      });
    });
  });
}

/**
 * Parses `scdet` scene cut timestamps and video `Duration:` from FFmpeg output.
 */
function parseScdetOutput(outputText = '') {
  const cuts = [0];
  let durationSec = 0;

  const durMatch = String(outputText).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (durMatch) {
    durationSec =
      Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
  }

  const scdRegex = /lavfi\.scd\.time\s*[:=]\s*(\d+(?:\.\d+)?)/gi;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = scdRegex.exec(outputText)) !== null) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t > 0) {
      cuts.push(Number(t.toFixed(2)));
    }
  }

  return {
    cutTimestampsSec: Array.from(new Set(cuts)).sort((a, b) => a - b),
    durationSec: Number(durationSec.toFixed(2))
  };
}

/**
 * Extracts scene-change keyframes from a video URL or file path using two-pass FFmpeg:
 * - Pass 1: Downscaled `360p` `scdet` pass to find exact shot boundaries.
 * - Pass 2: Fast input-side `-ss <t_sample> -i <input>` seek (uses HTTP `Range` requests on
 *   presigned AEM blob URLs) to extract `<= 1280px` JPEG buffers at each clamped shot timestamp.
 *
 * Returns `null` if no `ffmpeg` binary is available.
 */
async function extractVideoFramesWithFfmpeg(
  videoInput,
  {
    sceneThreshold = 0.28,
    shotOffsetSec = DEFAULT_SHOT_OFFSET_SEC,
    maxSampleIntervalSec = DEFAULT_MAX_SAMPLE_INTERVAL_SEC,
    maxFramesPerAsset = DEFAULT_MAX_FRAMES_PER_ASSET,
    ffmpegPath = null,
    timeoutMs = 25000
  } = {}
) {
  const bin = ffmpegPath || resolveFfmpegBinaryPath();
  if (!bin || !videoInput) return null;

  // Map normalized threshold (0.05..0.95) to scdet's 0..100 scale (~8..35)
  const scdetThreshold = Math.max(4, Math.min(50, Number((Number(sceneThreshold || 0.28) * 36).toFixed(1))));

  // Pass 1: detect scene boundaries
  const pass1 = await runProcess(
    bin,
    [
      '-nostdin',
      '-nostats',
      '-i',
      String(videoInput),
      '-vf',
      `scale=-2:360,scdet=threshold=${scdetThreshold}:sc_pass=1,metadata=mode=print:file=-`,
      '-an',
      '-f',
      'null',
      '-'
    ],
    { timeoutMs }
  );

  const combinedLog = `${pass1.stdout.toString('utf8')}\n${pass1.stderr.toString('utf8')}`;
  const { cutTimestampsSec, durationSec } = parseScdetOutput(combinedLog);
  const planned = planShotSampleTimestamps(cutTimestampsSec, durationSec || 10, {
    shotOffsetSec,
    maxSampleIntervalSec,
    maxFramesPerAsset
  });

  const extractedFrames = [];
  for (const sample of planned) {
    // eslint-disable-next-line no-await-in-loop
    const pass2 = await runProcess(
      bin,
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-ss',
        String(sample.timestampSec),
        '-i',
        String(videoInput),
        '-frames:v',
        '1',
        '-vf',
        "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease",
        '-q:v',
        '3',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1'
      ],
      { timeoutMs: 10000 }
    );

    if (pass2.stdout && pass2.stdout.length > 64 && pass2.stdout[0] === 0xff && pass2.stdout[1] === 0xd8) {
      extractedFrames.push({
        sampleIndex: sample.sampleIndex,
        shotIndex: sample.shotIndex,
        timestampSec: sample.timestampSec,
        shotRangeSec: sample.shotRangeSec,
        imageBuffer: pass2.stdout
      });
    }
  }

  return extractedFrames.length > 0
    ? {
        extractionMode: 'ffmpeg-scdet',
        durationSec,
        cutTimestampsSec,
        frames: extractedFrames
      }
    : null;
}

module.exports = {
  formatVideoTimestamp,
  parseVideoTimestamp,
  planShotSampleTimestamps,
  computeFaceFrameQualityScore,
  parseScdetOutput,
  resolveFfmpegBinaryPath,
  extractVideoFramesWithFfmpeg,
  DEFAULT_SHOT_OFFSET_SEC,
  DEFAULT_MAX_SAMPLE_INTERVAL_SEC,
  DEFAULT_MAX_FRAMES_PER_ASSET
};
