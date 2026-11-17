const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jpeg = require('jpeg-js');

const {
  formatVideoTimestamp,
  parseVideoTimestamp,
  planShotSampleTimestamps,
  computeFaceFrameQualityScore,
  parseScdetOutput
} = require('../actions/lib/video-extractor');
const { createStorage } = require('../actions/lib/storage');
const { createAemClient, isVideoAsset, isSafeRedirectStreamUrl } = require('../actions/lib/aem');
const { createFaceService } = require('../actions/lib/face-service');
const { PublicError } = require('../actions/lib/security');
const ingestAction = require('../actions/ingest/index');
const groupsAction = require('../actions/groups/index');

const AEM = 'https://author-p59602-e475952.adobeaemcloud.com';

function makeJpeg(width = 320, height = 240) {
  const data = Buffer.alloc(width * height * 4, 150);
  return Buffer.from(jpeg.encode({ data, width, height }, 80).data);
}

// ---------------------------------------------------------------------------
// 1. Shot-Clamped Offset Math & Periodic Long-Take Sampling
// ---------------------------------------------------------------------------

test('planShotSampleTimestamps applies clamped +0.60s offset and filters sub-0.20s flashes', () => {
  // Cuts at:
  // - 0.0 -> 0.12 (0.12s flash frame: merged/filtered)
  // - 0.0 -> 0.80 (0.80s rapid cut: clamped to 0.45 * 0.80 = 0.36s, NOT +0.60s!)
  // - 0.80 -> 4.00 (3.20s normal shot: 0.80 + min(0.60, 0.45*3.20) = 1.40s)
  // - 4.00 -> 14.00 (10.00s long interview take: 4.60s primary + periodic at 8.60s and 12.60s)
  const samples = planShotSampleTimestamps([0, 0.12, 0.8, 4.0], 14.0, {
    shotOffsetSec: 0.6,
    maxSampleIntervalSec: 4.0,
    maxFramesPerAsset: 24
  });

  assert.equal(samples.length, 5);
  // Shot 0: [0, 0.8], midpoint clamped at 0.36s (never overshoots into 0.80s)
  assert.equal(samples[0].timestampSec, 0.36);
  assert.deepEqual(samples[0].shotRangeSec, [0, 0.8]);
  assert.equal(samples[0].isPeriodicFallback, false);

  // Shot 1: [0.8, 4.0], settled at 0.8 + 0.6 = 1.4s
  assert.equal(samples[1].timestampSec, 1.4);
  assert.deepEqual(samples[1].shotRangeSec, [0.8, 4.0]);

  // Shot 2: [4.0, 14.0], partitioned into non-overlapping sub-windows around 4.6s, 8.6s, and 12.6s
  assert.equal(samples[2].timestampSec, 4.6);
  assert.deepEqual(samples[2].shotRangeSec, [4.0, 6.6]);
  assert.equal(samples[2].isPeriodicFallback, false);
  assert.equal(samples[3].timestampSec, 8.6);
  assert.deepEqual(samples[3].shotRangeSec, [6.6, 10.6]);
  assert.equal(samples[3].isPeriodicFallback, true);
  assert.equal(samples[4].timestampSec, 12.6);
  assert.deepEqual(samples[4].shotRangeSec, [10.6, 14.0]);
  assert.equal(samples[4].isPeriodicFallback, true);
});

test('planShotSampleTimestamps enforces maxFramesPerAsset cap and prioritizes primary shots', () => {
  const cuts = [0, 2, 5, 9, 14, 20, 27, 35];
  const capped = planShotSampleTimestamps(cuts, 45, {
    shotOffsetSec: 0.6,
    maxSampleIntervalSec: 3.0,
    maxFramesPerAsset: 4
  });
  assert.equal(capped.length, 4);
  // Returned timestamps remain strictly chronological
  for (let i = 1; i < capped.length; i++) {
    assert.ok(capped[i].timestampSec > capped[i - 1].timestampSec);
  }
  assert.ok(capped.every((s) => !s.isPeriodicFallback), 'primary shot samples outrank periodic extras');
});

test('formatVideoTimestamp and parseVideoTimestamp round-trip cleanly', () => {
  assert.equal(formatVideoTimestamp(4.2), '00:04.2');
  assert.equal(formatVideoTimestamp(75.54), '01:15.5');
  assert.equal(formatVideoTimestamp(3661.8), '01:01:01.8');
  assert.equal(parseVideoTimestamp('00:04.2'), 4.2);
  assert.equal(parseVideoTimestamp('01:15.5'), 75.5);
  assert.equal(parseVideoTimestamp('14.25'), 14.25);
  assert.equal(parseVideoTimestamp('invalid'), null);
});

test('parseScdetOutput extracts lavfi.scd.time cuts and Duration from FFmpeg logs', () => {
  const sampleLog = `
    Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'mobile.mp4':
      Duration: 00:00:18.40, start: 0.000000, bitrate: 1400 kb/s
    frame:120 pts:120000 pts_time:4.000
    lavfi.scd.score=14.52
    lavfi.scd.time=4.00
    frame:315 pts:315000 pts_time:10.500
    lavfi.scd.score=21.10
    lavfi.scd.time=10.50
  `;
  const parsed = parseScdetOutput(sampleLog);
  assert.equal(parsed.durationSec, 18.4);
  assert.deepEqual(parsed.cutTimestampsSec, [0, 4, 10.5]);
});

// ---------------------------------------------------------------------------
// 2. AEM Presigned Video Stream URL Resolution & SSRF Safety (`V4`)
// ---------------------------------------------------------------------------

test('resolveVideoStreamUrl prefers mobile.mp4 and preserves verbatim Azure Blob SAS redirect', async () => {
  const sasUrl =
    'https://author-p59602-e475952.adobeaemcloud.com/aem-blob-ns-team/blob123?sig=mRBFd3%2B4Wio%3D&se=2026-11-15T00%3A28%3A40Z&rsct=video%2Fmp4&rscd=attachment%3B%20filename%3D%22mobile.mp4%22&sp=r&sr=b';

  const seenUrls = [];
  const fetchImpl = async (url, opts = {}) => {
    seenUrls.push({ url, method: opts.method || 'GET', headers: opts.headers });
    if (url.endsWith('/mobile.mp4')) {
      return {
        ok: false,
        status: 302,
        headers: {
          get: (h) => (h.toLowerCase() === 'location' ? sasUrl : null)
        }
      };
    }
    if (url.endsWith('.jpeg')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/jpeg' }
      };
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => null }
    };
  };

  const aem = createAemClient({ aemHost: AEM, token: 'ims-user-token', fetchImpl });
  const res = await aem.resolveVideoStreamUrl('/content/dam/demo/two people mountain.mp4');

  assert.equal(res.renditionName, 'mobile.mp4');
  assert.equal(res.presigned, true);
  assert.equal(res.supportsRange, true);
  // Verbatim check: %2B and rscd=attachment are untouched so Azure SAS sig remains valid
  assert.equal(res.streamUrl, sasUrl);
});

test('V4: isSafeRedirectStreamUrl blocks untrusted external redirect hosts', () => {
  assert.equal(
    isSafeRedirectStreamUrl(
      'https://author-p59602-e475952.adobeaemcloud.com/aem-blob-ns/x?sig=1',
      AEM
    ),
    true
  );
  assert.equal(
    isSafeRedirectStreamUrl('https://aemblobs.blob.core.windows.net/container/video.mp4?sig=1', AEM),
    true
  );
  assert.equal(isSafeRedirectStreamUrl('https://evil.example.com/video.mp4', AEM), false);
  assert.equal(isSafeRedirectStreamUrl('http://author-p59602-e475952.adobeaemcloud.com/x', AEM), false);
});

test('isVideoAsset detects video MIME types and extensions', () => {
  assert.equal(isVideoAsset('/content/dam/a/clip.mp4', 'video/mp4'), true);
  assert.equal(isVideoAsset('/content/dam/a/clip.MOV', ''), true);
  assert.equal(isVideoAsset('/content/dam/a/photo.jpg', 'image/jpeg'), false);
});

// ---------------------------------------------------------------------------
// 3. Intra-Video Person Consolidation & AEM `xdm:faceTimestamps` Sync
// ---------------------------------------------------------------------------

test('ingestVideoFrames consolidates multiple shots of the same person into 1 face record, picks best quality avatar, deletes duplicate vectors, and writes xdm:faceTimestamps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-video-'));
  try {
    const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
    await storage.saveSettings({
      awsAccessKeyId: 'AKIA',
      awsSecretAccessKey: 'secret',
      enableVideoFaceRecognition: true
    });

    const deletedRekognitionFaceIds = [];
    const associatedRekognitionFaces = [];
    let indexCall = 0;

    // Frame 1 (t=1.2s): Person A (small bounding box) + Person B
    // Frame 2 (t=6.4s): Person A again (much larger, sharper frontal bounding box!)
    // Frame 3 (t=14.8s): Person A again (medium bounding box)
    const frameResponses = [
      [
        {
          FaceId: 'rek-personA-shot1',
          Confidence: 98.0,
          BoundingBox: { Left: 0.25, Top: 0.25, Width: 0.12, Height: 0.12 }
        },
        {
          FaceId: 'rek-personB-shot1',
          Confidence: 99.1,
          BoundingBox: { Left: 0.6, Top: 0.2, Width: 0.2, Height: 0.25 }
        }
      ],
      [
        {
          FaceId: 'rek-personA-shot2',
          Confidence: 99.8,
          BoundingBox: { Left: 0.3, Top: 0.15, Width: 0.35, Height: 0.42 }
        }
      ],
      [
        {
          FaceId: 'rek-personA-shot3',
          Confidence: 98.5,
          BoundingBox: { Left: 0.28, Top: 0.2, Width: 0.18, Height: 0.22 }
        }
      ]
    ];

    const rekognitionClient = {
      async send(cmd) {
        const name = cmd.constructor.name.replace(/Command$/, '');
        if (name === 'IndexFaces') {
          const recs = frameResponses[indexCall++] || [];
          return { FaceRecords: recs.map((Face) => ({ Face })) };
        }
        if (name === 'SearchUsers') {
          return { UserMatches: [] };
        }
        if (name === 'SearchFaces') {
          const qFaceId = cmd.input.FaceId;
          // rek-personA-shot2 and rek-personA-shot3 match rek-personA-shot1!
          if (qFaceId === 'rek-personA-shot2' || qFaceId === 'rek-personA-shot3') {
            return {
              FaceMatches: [
                {
                  Similarity: 97.5,
                  Face: { FaceId: 'rek-personA-shot1' }
                }
              ]
            };
          }
          return { FaceMatches: [] };
        }
        if (name === 'AssociateFaces') {
          associatedRekognitionFaces.push(...(cmd.input.FaceIds || []));
          return {};
        }
        if (name === 'DeleteFaces') {
          deletedRekognitionFaceIds.push(...(cmd.input.FaceIds || []));
          return {};
        }
        return {};
      }
    };

    const aemMetadataWrites = [];
    const aemClient = {
      async checkFolderEligibility() {
        return { eligible: true };
      },
      async getAssetInfo(p) {
        return {
          assetId: 'urn:aaid:aem:video-uuid-1',
          assetPath: p,
          assetTitle: 'two people mountain.mp4',
          mimeType: 'video/mp4'
        };
      },
      async updateAssetFaceMetadata(p, meta) {
        aemMetadataWrites.push({ assetPath: p, meta });
        return { updated: true, assetPath: p, metadata: meta };
      }
    };

    const svc = await createFaceService({
      storage,
      rekognitionClient,
      aemClient,
      retryOptions: { sleep: async () => {} }
    });

    const frameJpeg = makeJpeg(640, 360);
    const res = await svc.ingestVideoFrames({
      assetPath: '/content/dam/demo/two people mountain.mp4',
      assetId: 'urn:aaid:aem:video-uuid-1',
      assetTitle: 'two people mountain.mp4',
      mimeType: 'video/mp4',
      durationSec: 20.0,
      frames: [
        { timestampSec: 1.2, shotRangeSec: [0.6, 4.5], imageBuffer: frameJpeg },
        { timestampSec: 6.4, shotRangeSec: [5.8, 11.0], imageBuffer: frameJpeg },
        { timestampSec: 14.8, shotRangeSec: [14.2, 20.0], imageBuffer: frameJpeg }
      ]
    });

    // 1. Rolls up 4 total detections across 3 shots into 2 unique people on the video view,
    //    while keeping each distinct shot's faceId in storage so individual shots can be split!
    assert.equal(res.faceCount, 2);
    assert.equal(res.faces.length, 2);
    assert.equal(res.mediaType, 'video');

    // 2. Person A's rolled-up view card uses shot 2 (largest/sharpest) as its primary faceId & avatar
    const personACard = res.faces.find((f) => f.groupDisplayName === 'Person #1');
    const personBCard = res.faces.find((f) => f.groupDisplayName === 'Person #2');
    assert.ok(personACard && personBCard);
    assert.equal(personACard.faceId, 'rek-personA-shot2', 'best-quality shot is primary');
    assert.deepEqual(personACard.timestampsSec, [1.2, 6.4, 14.8]);
    assert.deepEqual(personACard.shotFaceIds, [
      'rek-personA-shot1',
      'rek-personA-shot2',
      'rek-personA-shot3'
    ]);
    assert.equal(personACard.appearances.length, 3);
    assert.equal(personACard.boundingBox.width, 0.35);

    // 3. AEM metadata write keys xdm:faceTimestamps by immutable groupId (so renaming does NOT mutate timestamp strings)
    assert.equal(aemMetadataWrites.length, 1);
    const writtenMeta = aemMetadataWrites[0].meta;
    assert.deepEqual(writtenMeta.faceTimestamps, [
      `${personACard.groupId}@00:01.2,00:06.4,00:14.8`,
      `${personBCard.groupId}@00:01.2`
    ]);
    assert.ok(writtenMeta.faceTimelineJson.includes('"t":6.4'));

    // 4. Splitting ONLY Shot 2 (t=6.4s, 'rek-personA-shot2') into a new group leaves Shot 1 (1.2s)
    //    and Shot 3 (14.8s) in Person A's original group!
    const splitRes = await svc.splitFacesToNewGroup({
      faceIds: ['rek-personA-shot2'],
      newGroupName: 'Lookalike Sister'
    });
    const newSisterGroupId = splitRes.newGroup.groupId;

    const afterSplitWrite = aemMetadataWrites[aemMetadataWrites.length - 1].meta;
    assert.deepEqual(afterSplitWrite.faceTimestamps, [
      `${personACard.groupId}@00:01.2,00:14.8`,
      `${personBCard.groupId}@00:01.2`,
      `${newSisterGroupId}@00:06.4`
    ]);
    assert.deepEqual(afterSplitWrite.faceLabels, [
      'Person #1',
      'Person #2',
      'Lookalike Sister'
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Video Settings Validation & Runtime Action Endpoints
// ---------------------------------------------------------------------------

test('settings: validates video settings and keeps enableVideoFaceRecognition false by default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-vset-'));
  try {
    const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
    const defaults = await storage.getSettings();
    assert.equal(defaults.enableVideoFaceRecognition, false);
    assert.equal(defaults.videoShotOffsetSec, 0.6);
    assert.equal(defaults.videoSceneThreshold, 0.28);
    assert.equal(defaults.videoMaxFramesPerAsset, 24);

    const saved = await storage.saveSettings({
      enableVideoFaceRecognition: true,
      allowedVideoTypes: ['VIDEO/MP4', 'video/quicktime'],
      videoShotOffsetSec: 0.75,
      videoSceneThreshold: 0.32,
      videoMaxFramesPerAsset: 18
    });
    assert.equal(saved.enableVideoFaceRecognition, true);
    assert.deepEqual(saved.allowedVideoTypes, ['video/mp4', 'video/quicktime']);
    assert.equal(saved.videoShotOffsetSec, 0.75);
    assert.equal(saved.videoSceneThreshold, 0.32);
    assert.equal(saved.videoMaxFramesPerAsset, 18);

    await assert.rejects(
      storage.saveSettings({ allowedVideoTypes: ['image/jpeg'] }),
      PublicError
    );
    await assert.rejects(
      storage.saveSettings({ videoShotOffsetSec: 25 }),
      PublicError
    );
    await assert.rejects(
      storage.saveSettings({ videoMaxFramesPerAsset: 100 }),
      PublicError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1/R5 Video Enterprise Readiness: multi-batch ingestVideoFrames hydrates avatars from earlier batches, synthesizes xdm:videoSummary, and cleans up orphaned faces on mid-batch errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-vbatch-'));
  try {
    const storage = await createStorage({ localDir: dir, encryptionSecret: 'unit-test-secret-key' });
    await storage.saveSettings({
      awsAccessKeyId: 'AKIA',
      awsSecretAccessKey: 'secret',
      enableVideoFaceRecognition: true
    });

    let seq = 0;
    let shouldFailAssociateOnFaceId = null;
    const deletedFaces = [];

    const rekognitionClient = {
      async send(cmd) {
        const name = cmd.constructor.name.replace(/Command$/, '');
        if (name === 'IndexFaces') {
          const fId = `batch-face-${++seq}`;
          return {
            FaceRecords: [
              {
                Face: {
                  FaceId: fId,
                  Confidence: 99.2,
                  BoundingBox: { Left: 0.3, Top: 0.15, Width: 0.25, Height: 0.35 }
                },
                FaceDetail: {
                  Emotions: [{ Type: 'HAPPY', Confidence: 96.4 }],
                  Smile: { Value: true, Confidence: 98.1 },
                  Pose: { Yaw: 4.2, Pitch: 1.1, Roll: 0.5 }
                }
              }
            ]
          };
        }
        if (name === 'SearchUsers') return { UserMatches: [] };
        if (name === 'SearchFaces') return { FaceMatches: [] };
        if (name === 'CreateUser' && shouldFailAssociateOnFaceId === `batch-face-${seq}`) {
          throw new Error('Simulated Rekognition transient failure');
        }
        if (name === 'DeleteFaces') {
          deletedFaces.push(...(cmd.input.FaceIds || []));
          return {};
        }
        return {};
      }
    };

    const aemWrites = [];
    const aemClient = {
      async checkFolderEligibility() {
        return { eligible: true };
      },
      async getAssetInfo(p) {
        return {
          assetId: 'urn:aaid:aem:video-batch-1',
          assetPath: p,
          assetTitle: 'enterprise-spot.mp4',
          mimeType: 'video/mp4',
          machineKeywords: ['roasting', 'packaging', 'coffee maker', 'person']
        };
      },
      async updateAssetFaceMetadata(p, meta) {
        aemWrites.push(meta);
        return { updated: true, assetPath: p, metadata: meta };
      }
    };

    const svc = await createFaceService({
      storage,
      rekognitionClient,
      aemClient,
      retryOptions: { sleep: async () => {} }
    });

    const frameJpeg = makeJpeg(640, 360);

    // Batch 1 (resetExisting: true, syncMetadata: false)
    await svc.ingestVideoFrames({
      assetPath: '/content/dam/demo/enterprise-spot.mp4',
      assetId: 'urn:aaid:aem:video-batch-1',
      frames: [{ timestampSec: 1.0, shotRangeSec: [0, 4.0], imageBuffer: frameJpeg }],
      durationSec: 12.0,
      resetExisting: true,
      syncMetadata: false
    });

    // Verify Batch 1 stripped inline avatarDataUrl on disk (P1)
    const diskFacesAfterBatch1 = JSON.parse(
      fs.readFileSync(path.join(dir, 'db/faces.json'), 'utf8')
    );
    assert.equal(diskFacesAfterBatch1['batch-face-1'].avatarDataUrl, undefined);

    // Batch 2 (resetExisting: false, syncMetadata: true — final batch!)
    const finalRes = await svc.ingestVideoFrames({
      assetPath: '/content/dam/demo/enterprise-spot.mp4',
      assetId: 'urn:aaid:aem:video-batch-1',
      frames: [{ timestampSec: 6.0, shotRangeSec: [4.0, 12.0], imageBuffer: frameJpeg }],
      durationSec: 12.0,
      resetExisting: false,
      syncMetadata: true
    });

    // Both Batch 1's face and Batch 2's face have hydrated avatarDataUrl in the final response!
    assert.equal(finalRes.faces.length, 2);
    for (const face of finalRes.faces) {
      assert.match(face.avatarDataUrl || '', /^data:image\/jpeg;base64,/);
      assert.equal(face.attributes?.emotion, 'HAPPY');
      assert.equal(face.shotFraming?.scale, 'Medium close-up');
      assert.ok(face.frameVisuals?.dominantHex);
    }

    // Deterministic zero-LLM videoSummary is synthesized and written to AEM metadata
    assert.match(finalRes.videoSummary || '', /12s .*video \(2 scenes/);
    assert.match(finalRes.videoSummary || '', /Themes: roasting, packaging, coffee maker/);
    assert.match(finalRes.videoSummary || '', /Predominant expression: happy/);
    assert.equal(aemWrites.at(-1).videoSummary, finalRes.videoSummary);

    // R5: Mid-frame failure discards unapplied Rekognition face vector and marks asset incomplete
    shouldFailAssociateOnFaceId = 'batch-face-3';
    await assert.rejects(
      svc.ingestVideoFrames({
        assetPath: '/content/dam/demo/enterprise-spot.mp4',
        assetId: 'urn:aaid:aem:video-batch-1',
        frames: [{ timestampSec: 9.0, shotRangeSec: [8.0, 12.0], imageBuffer: frameJpeg }],
        resetExisting: false,
        syncMetadata: true
      }),
      /Simulated Rekognition transient failure/
    );
    assert.ok(
      deletedFaces.includes('batch-face-3'),
      'orphaned face vector is discarded from Rekognition on error'
    );
    const dbAfterErr = await storage.getDatabase({ readOnly: true });
    assert.equal(dbAfterErr.assets['video-batch-1'].incomplete, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
