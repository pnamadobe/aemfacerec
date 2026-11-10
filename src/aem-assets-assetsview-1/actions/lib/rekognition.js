const { PublicError } = require('./security');
const { withRetry, isRetryableAwsError } = require('./retry');

// Errors that mean "nothing to match against yet" (empty collection, face or user vectors
// not ready). Anything else, notably throttling, must NOT be treated as "no match", or every
// face would end up in a new group.
const NO_MATCH_ERRORS = new Set(['ResourceNotFoundException', 'InvalidParameterException']);

function makeCommandClass(name) {
  return {
    [name]: class {
      constructor(input) {
        this.input = input;
      }
    }
  }[name];
}

let awsRekognition;
try {
  // eslint-disable-next-line global-require
  awsRekognition = require('@aws-sdk/client-rekognition');
} catch (e) {
  awsRekognition = {
    RekognitionClient: class {
      constructor(config) {
        this.config = config;
      }
    },
    CreateCollectionCommand: makeCommandClass('CreateCollectionCommand'),
    DescribeCollectionCommand: makeCommandClass('DescribeCollectionCommand'),
    IndexFacesCommand: makeCommandClass('IndexFacesCommand'),
    SearchUsersCommand: makeCommandClass('SearchUsersCommand'),
    SearchFacesCommand: makeCommandClass('SearchFacesCommand'),
    CreateUserCommand: makeCommandClass('CreateUserCommand'),
    DeleteUserCommand: makeCommandClass('DeleteUserCommand'),
    AssociateFacesCommand: makeCommandClass('AssociateFacesCommand'),
    DisassociateFacesCommand: makeCommandClass('DisassociateFacesCommand'),
    DeleteFacesCommand: makeCommandClass('DeleteFacesCommand')
  };
}

const {
  RekognitionClient,
  CreateCollectionCommand,
  DescribeCollectionCommand,
  IndexFacesCommand,
  SearchUsersCommand,
  SearchFacesCommand,
  CreateUserCommand,
  DeleteUserCommand,
  AssociateFacesCommand,
  DisassociateFacesCommand,
  DeleteFacesCommand
} = awsRekognition;

/**
 * AWS Rekognition requires ExternalImageId to match [a-zA-Z0-9_.\-:]+ (max 255 chars).
 */
function sanitizeExternalImageId(assetIdOrPath) {
  if (!assetIdOrPath) return 'aem-asset';
  return String(assetIdOrPath)
    .replace(/[^a-zA-Z0-9_.\-:]/g, '_')
    .slice(0, 250);
}

/**
 * Chunks an array into batches of size N (AWS Rekognition AssociateFaces/DisassociateFaces max is 100).
 */
function chunkArray(items, chunkSize = 100) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Creates a Rekognition service wrapper using the customer's BYOK AWS credentials.
 */
function createRekognitionService(settings, customClient = null, retryOptions = {}) {
  const collectionId = settings.collectionId || 'aem-assets-faces';
  const similarityThreshold = Number(settings.similarityThreshold ?? 85);

  function getClient() {
    if (customClient) return customClient;
    if (!settings.awsAccessKeyId || !settings.awsSecretAccessKey) {
      if (settings.awsSecretKeyUnreadable) {
        throw new PublicError(
          'The stored AWS Secret Access Key can no longer be decrypted (the encryption secret changed). Please re-enter it in the Face Recognition Settings tab.'
        );
      }
      throw new PublicError(
        'AWS Rekognition credentials are not configured. Please provide your AWS Access Key ID and Secret Access Key in the Face Recognition Settings tab.'
      );
    }
    return new RekognitionClient({
      // Retries are handled by withRetry below so they are not multiplied by SDK retries
      maxAttempts: 1,
      region: settings.awsRegion || 'us-east-1',
      credentials: {
        accessKeyId: settings.awsAccessKeyId,
        secretAccessKey: settings.awsSecretAccessKey
      }
    });
  }

  let cachedClient = null;
  /**
   * Sends a Rekognition command, retrying throttling / transient errors with backoff.
   */
  function send(command) {
    if (!cachedClient) cachedClient = getClient();
    return withRetry(() => cachedClient.send(command), {
      isRetryable: isRetryableAwsError,
      ...retryOptions
    });
  }

  return {
    /**
     * Verifies AWS credentials and ensures the configured Rekognition Collection exists.
     */
    async ensureCollection() {
      try {
        const desc = await send(
          new DescribeCollectionCommand({ CollectionId: collectionId })
        );
        return {
          created: false,
          collectionId,
          faceCount: desc.FaceCount ?? 0,
          userCount: desc.UserCount ?? 0,
          collectionARN: desc.CollectionARN
        };
      } catch (err) {
        if (err.name === 'ResourceNotFoundException') {
          const created = await send(
            new CreateCollectionCommand({ CollectionId: collectionId })
          );
          return {
            created: true,
            collectionId,
            faceCount: 0,
            userCount: 0,
            collectionARN: created.CollectionArn
          };
        }
        throw err;
      }
    },

    /**
     * Indexes all faces detected in an image buffer into the Rekognition Collection.
     * Returns an array of detected face records with FaceId and normalized BoundingBox.
     */
    async indexAssetFaces(imageBuffer, assetId, { skipEnsureCollection = false } = {}) {
      if (!skipEnsureCollection) {
        await this.ensureCollection();
      }

      let response;
      try {
        response = await send(
          new IndexFacesCommand({
            CollectionId: collectionId,
            Image: { Bytes: imageBuffer },
            ExternalImageId: sanitizeExternalImageId(assetId),
            DetectionAttributes: ['DEFAULT'],
            QualityFilter: 'AUTO'
          })
        );
      } catch (err) {
        if (err.name === 'InvalidImageFormatException') {
          throw new PublicError('This image format is not supported for face analysis (use JPEG or PNG).');
        }
        if (err.name === 'ImageTooLargeException') {
          throw new PublicError('This image is too large for face analysis.');
        }
        throw err;
      }

      const faceRecords = response.FaceRecords || [];
      return faceRecords.map((record) => ({
        faceId: record.Face.FaceId,
        confidence: Number((record.Face.Confidence || 0).toFixed(2)),
        boundingBox: {
          left: Number((record.Face.BoundingBox.Left || 0).toFixed(4)),
          top: Number((record.Face.BoundingBox.Top || 0).toFixed(4)),
          width: Number((record.Face.BoundingBox.Width || 0).toFixed(4)),
          height: Number((record.Face.BoundingBox.Height || 0).toFixed(4))
        }
      }));
    },

    /**
     * Searches the Rekognition Collection for an existing Face Group (User) that matches faceId.
     * Uses SearchUsers first, then falls back to SearchFaces in case a recently created User
     * vector is still converging in Rekognition.
     */
    async findMatchingGroup(faceId, facesDb = {}, groupsDb = {}) {
      // 1. Primary search against aggregated Rekognition Users (Face Groups)
      try {
        const userSearch = await send(
          new SearchUsersCommand({
            CollectionId: collectionId,
            FaceId: faceId,
            MaxUsers: 1,
            UserMatchThreshold: similarityThreshold
          })
        );
        if (userSearch.UserMatches && userSearch.UserMatches.length > 0) {
          const topMatch = userSearch.UserMatches[0];
          const matchedGroupId = topMatch.User?.UserId;
          if (matchedGroupId && groupsDb[matchedGroupId]) {
            return {
              groupId: matchedGroupId,
              matchConfidence: Number((topMatch.Similarity || 0).toFixed(2))
            };
          }
        }
      } catch (err) {
        // Fall back to SearchFaces only when SearchUsers has nothing to search yet
        if (!NO_MATCH_ERRORS.has(err.name)) throw err;
      }

      // 2. Fallback search against individual indexed FaceIds
      try {
        const faceSearch = await send(
          new SearchFacesCommand({
            CollectionId: collectionId,
            FaceId: faceId,
            MaxFaces: 5,
            FaceMatchThreshold: similarityThreshold
          })
        );
        for (const match of faceSearch.FaceMatches || []) {
          const matchedFaceId = match.Face?.FaceId;
          if (matchedFaceId && matchedFaceId !== faceId && facesDb[matchedFaceId]) {
            const candidateGroupId = facesDb[matchedFaceId].groupId;
            if (candidateGroupId && groupsDb[candidateGroupId]) {
              return {
                groupId: candidateGroupId,
                matchConfidence: Number((match.Similarity || 0).toFixed(2))
              };
            }
          }
        }
      } catch (err) {
        if (!NO_MATCH_ERRORS.has(err.name)) throw err;
      }

      return null;
    },

    /**
     * Creates a new Rekognition User (Face Group) and associates initial FaceIds with it.
     */
    async createGroup(groupId, faceIds = []) {
      try {
        await send(
          new CreateUserCommand({
            CollectionId: collectionId,
            UserId: groupId
          })
        );
      } catch (err) {
        if (err.name !== 'ResourceAlreadyExistsException') {
          throw err;
        }
      }

      if (faceIds.length > 0) {
        await this.associateFaces(groupId, faceIds);
      }
    },

    /**
     * Associates one or more FaceIds with an existing Rekognition User (Face Group).
     */
    async associateFaces(groupId, faceIds = []) {
      if (!faceIds.length) return;
      for (const batch of chunkArray(faceIds, 100)) {
        await send(
          new AssociateFacesCommand({
            CollectionId: collectionId,
            UserId: groupId,
            FaceIds: batch,
            UserMatchThreshold: 50
          })
        );
      }
    },

    /**
     * Disassociates one or more FaceIds from a Rekognition User (Face Group).
     */
    async disassociateFaces(groupId, faceIds = []) {
      if (!faceIds.length) return;
      for (const batch of chunkArray(faceIds, 100)) {
        try {
          await send(
            new DisassociateFacesCommand({
              CollectionId: collectionId,
              UserId: groupId,
              FaceIds: batch
            })
          );
        } catch (err) {
          if (err.name !== 'ResourceNotFoundException') {
            throw err;
          }
        }
      }
    },

    /**
     * Deletes a Rekognition User (Face Group) when it has been merged or emptied.
     */
    async deleteGroup(groupId) {
      try {
        await send(
          new DeleteUserCommand({
            CollectionId: collectionId,
            UserId: groupId
          })
        );
      } catch (err) {
        if (err.name !== 'ResourceNotFoundException') {
          throw err;
        }
      }
    },

    /**
     * Deletes FaceIds from the Rekognition Collection (e.g., when an AEM asset is deleted or re-indexed).
     */
    async deleteFaces(faceIds = []) {
      if (!faceIds.length) return;
      for (const batch of chunkArray(faceIds, 1000)) {
        await send(
          new DeleteFacesCommand({
            CollectionId: collectionId,
            FaceIds: batch
          })
        );
      }
    }
  };
}

module.exports = {
  createRekognitionService,
  sanitizeExternalImageId,
  chunkArray
};
