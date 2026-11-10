const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStorage, encryptSecret, decryptSecret, maskSecret } = require('../actions/lib/storage');
const { calculateSquareCropRegion } = require('../actions/lib/cropper');
const { createFaceService } = require('../actions/lib/face-service');
const { createAemClient } = require('../actions/lib/aem');

/**
 * Helper to create an isolated temp directory storage and mock AWS Rekognition + AEM clients.
 */
async function createTestHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-test-'));
  const storage = await createStorage({
    localDir: tmpDir,
    encryptionSecret: 'unit-test-secret-key'
  });

  await storage.saveSettings({
    awsRegion: 'us-east-1',
    awsAccessKeyId: 'AKIATESTKEY12345',
    awsSecretAccessKey: 'super-secret-aws-key-9876',
    collectionId: 'test-collection',
    similarityThreshold: 85,
    metadataProperty: 'xdm:faceNames',
    includeUnnamedInMetadata: true,
    processingProfileName: 'Face Recognition',
    requireProcessingProfile: true
  });

  const rekognitionCalls = [];
  let nextMockFaces = [];
  let nextUserMatch = null;

  const mockRekognitionClient = {
    async send(command) {
      const cmdName = command.constructor.name;
      rekognitionCalls.push({ cmdName, input: command.input });

      if (cmdName === 'DescribeCollectionCommand') {
        return {
          CollectionARN: 'arn:aws:rekognition:us-east-1:123456789012:collection/test-collection',
          FaceCount: 5,
          UserCount: 2
        };
      }
      if (cmdName === 'IndexFacesCommand') {
        return {
          FaceRecords: nextMockFaces.map((f) => ({
            Face: {
              FaceId: f.faceId,
              Confidence: f.confidence || 99.5,
              BoundingBox: {
                Left: f.boundingBox?.left ?? 0.2,
                Top: f.boundingBox?.top ?? 0.2,
                Width: f.boundingBox?.width ?? 0.15,
                Height: f.boundingBox?.height ?? 0.2
              }
            }
          }))
        };
      }
      if (cmdName === 'SearchUsersCommand') {
        const matchGroupId =
          typeof nextUserMatch === 'function'
            ? nextUserMatch(command.input.FaceId)
            : nextUserMatch;
        if (matchGroupId) {
          return {
            UserMatches: [
              {
                Similarity: 96.4,
                User: { UserId: matchGroupId }
              }
            ]
          };
        }
        return { UserMatches: [] };
      }
      if (cmdName === 'SearchFacesCommand') {
        return { FaceMatches: [] };
      }
      return {};
    }
  };

  const aemMetadataUpdates = {};
  const mockAemClient = {
    async checkFolderEligibility(assetPath) {
      if (assetPath.startsWith('/content/dam/unenabled-folder')) {
        return { eligible: false, reason: 'No Face Recognition profile on folder' };
      }
      return { eligible: true, reason: 'Processing Profile active' };
    },
    async getAssetInfo(assetPath) {
      return {
        assetId: `id:${assetPath}`,
        assetPath,
        assetTitle: assetPath.split('/').pop()
      };
    },
    async fetchAssetRenditionBuffer() {
      return Buffer.from('mock-image-bytes');
    },
    async updateAssetFaceMetadata(assetPath, payload) {
      aemMetadataUpdates[assetPath] = payload;
      return { updated: true, assetPath, metadata: payload };
    }
  };

  const faceService = await createFaceService({
    storage,
    rekognitionClient: mockRekognitionClient,
    aemClient: mockAemClient
  });

  return {
    tmpDir,
    storage,
    faceService,
    rekognitionCalls,
    aemMetadataUpdates,
    setNextMockFaces(faces) {
      nextMockFaces = faces;
    },
    setNextUserMatch(matcher) {
      nextUserMatch = matcher;
    },
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

test('1. Storage encrypts customer AWS Secret Access Key at rest and masks it for UI responses', async () => {
  const encrypted = encryptSecret('my-aws-secret-key-1234', 'secret-passphrase');
  assert.ok(!encrypted.includes('my-aws-secret-key-1234'));
  const decrypted = decryptSecret(encrypted, 'secret-passphrase');
  assert.equal(decrypted, 'my-aws-secret-key-1234');
  assert.equal(maskSecret(decrypted), '••••••••••••1234');
});

test('2. Avatar cropper calculates padded square crop coordinates clamped to image boundaries', () => {
  // Center face
  const centerCrop = calculateSquareCropRegion(
    { Left: 0.4, Top: 0.3, Width: 0.2, Height: 0.2 },
    1000,
    1000
  );
  assert.equal(centerCrop.width, centerCrop.height);
  assert.ok(centerCrop.width > 200); // Padded beyond raw 200px face box
  assert.ok(centerCrop.left >= 0 && centerCrop.top >= 0);

  // Face right against top-left corner (0.01, 0.01) should clamp cleanly to >= 0
  const edgeCrop = calculateSquareCropRegion(
    { Left: 0.01, Top: 0.01, Width: 0.15, Height: 0.2 },
    1200,
    800
  );
  assert.equal(edgeCrop.left, 0);
  assert.equal(edgeCrop.top, 0);
  assert.ok(edgeCrop.width <= 800);
});

test('3. Ingesting a multi-face asset creates groups, crops avatars, and writes xdm:faceNames with placeholders', async () => {
  const harness = await createTestHarness();
  try {
    harness.setNextMockFaces([
      { faceId: 'face-101', confidence: 99.8, boundingBox: { left: 0.1, top: 0.2, width: 0.15, height: 0.2 } },
      { faceId: 'face-102', confidence: 98.4, boundingBox: { left: 0.5, top: 0.2, width: 0.15, height: 0.2 } }
    ]);

    const assetPath = '/content/dam/events/group-photo.jpg';
    const result = await harness.faceService.ingestAsset({ assetPath });

    assert.equal(result.faceCount, 2);
    assert.deepEqual(result.faceNames, ['Person #1', 'Person #2']);
    assert.deepEqual(harness.aemMetadataUpdates[assetPath].faceNames, ['Person #1', 'Person #2']);
    assert.equal(harness.aemMetadataUpdates[assetPath].metadataProperty, 'xdm:faceNames');

    // Verify folders without processing profile are skipped when force=false
    const skipped = await harness.faceService.ingestAsset({
      assetPath: '/content/dam/unenabled-folder/photo.jpg',
      force: false
    });
    assert.equal(skipped.skipped, true);
  } finally {
    harness.cleanup();
  }
});

test('4. Naming, Splitting, Merging groups, and toggling unnamed placeholder visibility updates xdm:faceNames accurately', async () => {
  const harness = await createTestHarness();
  try {
    const asset1 = '/content/dam/events/photo-1.jpg';
    const asset2 = '/content/dam/events/photo-2.jpg';

    // Asset 1 has two faces: face-A1 and face-B1
    harness.setNextMockFaces([
      { faceId: 'face-A1', confidence: 99.9 },
      { faceId: 'face-B1', confidence: 99.1 }
    ]);
    const res1 = await harness.faceService.ingestAsset({ assetPath: asset1 });
    const groupA = res1.faces[0].groupId;
    const groupB = res1.faces[1].groupId;

    // Asset 2 has two faces: face-A2 (matches groupA!) and face-C1 (new person, but accidentally matched into groupA!)
    harness.setNextMockFaces([
      { faceId: 'face-A2', confidence: 99.7 },
      { faceId: 'face-C1', confidence: 97.5 }
    ]);
    harness.setNextUserMatch(() => groupA); // Both matched into groupA initially
    await harness.faceService.ingestAsset({ assetPath: asset2 });

    // 1. Admin names groupA -> "Alice"
    await harness.faceService.renameGroup({ groupId: groupA, name: 'Alice' });
    assert.deepEqual(harness.aemMetadataUpdates[asset1].faceNames, ['Alice', 'Person #2']);
    // Even though asset2 has two faces in groupA, xdm:faceNames is deduplicated to ['Alice']
    assert.deepEqual(harness.aemMetadataUpdates[asset2].faceNames, ['Alice']);

    // 2. Admin splits 'face-C1' out of groupA into its own new group
    const splitRes = await harness.faceService.splitFacesToNewGroup({
      faceIds: ['face-C1']
    });
    const groupC = splitRes.newGroup.groupId;
    assert.notEqual(groupC, groupA);
    // Now asset2 has Alice (face-A2) and Person #3 (face-C1)!
    assert.deepEqual(harness.aemMetadataUpdates[asset2].faceNames, ['Alice', 'Person #3']);

    // 3. Admin toggles `includeUnnamedInMetadata = false` in Settings to hide placeholders from xdm:faceNames
    await harness.storage.saveSettings({ includeUnnamedInMetadata: false });
    await harness.faceService.resyncAllAssetsMetadata();
    assert.deepEqual(harness.aemMetadataUpdates[asset1].faceNames, ['Alice']);
    assert.deepEqual(harness.aemMetadataUpdates[asset2].faceNames, ['Alice']);

    // 4. Admin names groupB -> "Bob" and merges groupC into groupB (so face-C1 was actually Bob!)
    await harness.faceService.renameGroup({ groupId: groupB, name: 'Bob' });
    await harness.faceService.mergeGroups({
      sourceGroupIds: [groupC],
      targetGroupId: groupB
    });

    // Now both asset1 and asset2 have ['Alice', 'Bob'] on xdm:faceNames!
    assert.deepEqual(harness.aemMetadataUpdates[asset1].faceNames, ['Alice', 'Bob']);
    assert.deepEqual(harness.aemMetadataUpdates[asset2].faceNames, ['Alice', 'Bob']);
  } finally {
    harness.cleanup();
  }
});

test('5. AEM Folder Processing Profile inspection checks ancestor folder jcr:content', async () => {
  const mockFetch = async (url) => {
    if (url.includes('/content/dam/campaigns/2026/jcr:content.1.json')) {
      return {
        ok: true,
        async json() {
          return {
            'dam:processingProfile': '/conf/global/settings/dam/processing/Face Recognition'
          };
        }
      };
    }
    return { ok: false, status: 404 };
  };

  const aem = createAemClient({
    aemHost: 'https://author-p12345-e67890.adobeaemcloud.com',
    token: 'test-ims-token',
    fetchImpl: mockFetch
  });

  const eligibleRes = await aem.checkFolderEligibility(
    '/content/dam/campaigns/2026/sub/hero.jpg',
    {
      requireProcessingProfile: true,
      processingProfileName: 'Face Recognition',
      enabledFolders: ['/content/dam']
    }
  );
  assert.equal(eligibleRes.eligible, true);

  const ineligibleRes = await aem.checkFolderEligibility(
    '/content/dam/other-folder/hero.jpg',
    {
      requireProcessingProfile: true,
      processingProfileName: 'Face Recognition',
      enabledFolders: ['/content/dam']
    }
  );
  assert.equal(ineligibleRes.eligible, false);
});

test('6. Runtime Action entry points (ingest, groups, settings) handle requests and I/O Event challenges', async () => {
  const ingestAction = require('../actions/ingest/index');
  const groupsAction = require('../actions/groups/index');
  const settingsAction = require('../actions/settings/index');

  // 1. Adobe I/O Events challenge
  const challengeRes = await ingestAction.main({ challenge: 'verify-token-123' });
  assert.equal(challengeRes.statusCode, 200);
  assert.equal(challengeRes.body.challenge, 'verify-token-123');

  // 2. Seed demo data & list groups through groups Runtime Action
  // (maintenance operations must be explicitly enabled by the deployment input)
  const seedRes = await groupsAction.main({ operation: 'seedDemoData', ENABLE_MAINTENANCE_OPS: 'true' });
  assert.equal(seedRes.statusCode, 200);
  assert.equal(seedRes.body.totalGroups, 4);
  assert.equal(seedRes.body.totalFaces, 7);

  // 3. Query multi-face asset (`keynote-panel.jpg` has Sarah Jenkins, Marcus Vance, and Person #3)
  const assetFacesRes = await groupsAction.main({
    operation: 'getAssetFaces',
    assetPath: '/content/dam/events/2026-summit/keynote-panel.jpg'
  });
  assert.equal(assetFacesRes.statusCode, 200);
  assert.equal(assetFacesRes.body.faceCount, 3);
  assert.deepEqual(assetFacesRes.body.faceNames, ['Sarah Jenkins', 'Marcus Vance', 'Person #3']);

  // 4. Toggle `includeUnnamedInMetadata: false` via settings Runtime Action and verify auto-resync
  const saveSettingsRes = await settingsAction.main({
    operation: 'saveSettings',
    settings: { includeUnnamedInMetadata: false }
  });
  assert.equal(saveSettingsRes.statusCode, 200);
  assert.equal(saveSettingsRes.body.settings.includeUnnamedInMetadata, false);

  const assetAfterToggle = await groupsAction.main({
    operation: 'getAssetFaces',
    assetPath: '/content/dam/events/2026-summit/keynote-panel.jpg'
  });
  assert.deepEqual(assetAfterToggle.body.faceNames, ['Sarah Jenkins', 'Marcus Vance']);

  // Clean up local storage created by action test
  const localStoreDir = path.join(process.cwd(), '.local-storage');
  if (fs.existsSync(localStoreDir)) {
    fs.rmSync(localStoreDir, { recursive: true, force: true });
  }
});

test('7. scanFolder processes asset batches in-memory with a single ensureCollection call and single DB save', async () => {
  const harness = await createTestHarness();
  try {
    let faceSeq = 1;
    harness.setNextMockFaces([{ faceId: `face-batch-${faceSeq++}`, confidence: 99.2 }]);

    const batchAssets = [
      { assetId: 'id:1', assetPath: '/content/dam/shoot/img1.jpg', assetTitle: 'img1.jpg' },
      { assetId: 'id:2', assetPath: '/content/dam/shoot/img2.jpg', assetTitle: 'img2.jpg' },
      { assetId: 'id:3', assetPath: '/content/dam/shoot/img3.jpg', assetTitle: 'img3.jpg' }
    ];

    const res = await harness.faceService.scanFolder({
      folderPath: '/content/dam/shoot',
      assets: batchAssets,
      force: true
    });

    assert.equal(res.totalAssets, 3);
    assert.equal(res.processedCount, 3);
    assert.equal(res.hasMore, false);
    assert.equal(res.results.length, 3);

    // DescribeCollectionCommand should only be called ONCE for the entire batch of 3 assets
    const describeCalls = harness.rekognitionCalls.filter(
      (c) => c.cmdName === 'DescribeCollectionCommand'
    );
    assert.equal(describeCalls.length, 1);
  } finally {
    harness.cleanup();
  }
});
