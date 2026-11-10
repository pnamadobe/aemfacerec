const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PublicError,
  assertDamPath,
  isValidMetadataProperty,
  requireEncryptionSecret
} = require('./security');

const AWS_REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const COLLECTION_ID_PATTERN = /^[a-zA-Z0-9_.\-]{1,255}$/;
const FACE_ID_PATTERN = /^[a-zA-Z0-9_.\-:]{1,128}$/;

function isNotFoundError(err) {
  if (!err) return false;
  const code = String(err.code || err.name || '');
  return (
    code === 'ENOENT' ||
    code === 'ERROR_FILE_NOT_EXISTS' ||
    code === 'NotFound' ||
    err.statusCode === 404 ||
    /not\s*exist|not\s*found/i.test(String(err.message || ''))
  );
}

function assertSafeFaceId(faceId) {
  if (!FACE_ID_PATTERN.test(String(faceId || ''))) {
    throw new Error('Invalid faceId.');
  }
  return String(faceId);
}

const DEFAULT_SETTINGS = {
  awsRegion: 'us-east-1',
  awsAccessKeyId: '',
  awsSecretAccessKeyEncrypted: '',
  collectionId: 'aem-assets-faces',
  similarityThreshold: 85,
  metadataProperty: 'xdm:faceNames',
  includeUnnamedInMetadata: true,
  processingProfileName: 'Face Recognition',
  requireProcessingProfile: true,
  enabledFolders: ['/content/dam'],
  // Only these asset types are ever sent for face analysis (AEM's JPEG rendition is what's sent)
  allowedImageTypes: [
    'image/jpeg',
    'image/png',
    'image/tiff',
    'image/vnd.adobe.photoshop',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/bmp'
  ],
  // Images whose shorter side is below this many pixels (logos, icons) are skipped
  minImageSize: 200
};

const MIME_TYPE_PATTERN = /^image\/[a-z0-9][a-z0-9.+-]{0,99}$/;

/**
 * Encrypts a plaintext string using AES-256-GCM with a key derived from secret.
 */
function encryptSecret(plaintext, secret) {
  if (!secret) throw new Error('An encryption secret is required.');
  if (!plaintext) return '';
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a string encrypted by encryptSecret.
 */
function decryptSecret(payload, secret) {
  if (!secret) throw new Error('An encryption secret is required.');
  if (!payload) return '';
  const parts = payload.split(':');
  if (parts.length !== 3) return '';
  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

function maskSecret(secretStr) {
  if (!secretStr) return '';
  if (secretStr.length <= 4) return '••••';
  return `••••••••••••${secretStr.slice(-4)}`;
}

/**
 * Creates a storage adapter backed by @adobe/aio-lib-files in production
 * or local filesystem / in-memory store for local development and testing.
 */
async function createStorage(options = {}) {
  const encryptionKey = requireEncryptionSecret(
    options.encryptionSecret || process.env.ENCRYPTION_SECRET
  );

  let backend = options.backend || null;

  if (!backend) {
    const isRuntime = Boolean(
      (process.env.__OW_NAMESPACE || process.env.AIO_runtime_namespace) && !options.useLocal
    );

    if (isRuntime) {
      // 1. Try @adobe/aio-lib-files (permanent cloud blob storage)
      try {
        const filesLib = require('@adobe/aio-lib-files');
        const files = await filesLib.init();
        // Verify write access with a lightweight probe or use directly
        backend = {
          type: 'aio-lib-files',
          async readText(filePath) {
            try {
              const buf = await files.read(filePath);
              return buf.toString('utf8');
            } catch (e) {
              if (isNotFoundError(e)) return null;
              throw e;
            }
          },
          async writeText(filePath, content) {
            await files.write(filePath, Buffer.from(content, 'utf8'));
          },
          async readBuffer(filePath) {
            try {
              return await files.read(filePath);
            } catch (e) {
              if (isNotFoundError(e)) return null;
              throw e;
            }
          },
          async writeBuffer(filePath, buffer) {
            await files.write(filePath, buffer);
          },
          async deleteFile(filePath) {
            try {
              await files.delete(filePath);
            } catch (e) {
              // ignore if missing
            }
          }
        };
      } catch (err) {
        // 2. Fallback to @adobe/aio-lib-state (persistent across Runtime containers, 1-year TTL)
        try {
          const stateLib = require('@adobe/aio-lib-state');
          const state = await stateLib.init();
          const ONE_YEAR_TTL = 31536000;
          const toKey = (filePath) =>
            `facerec_${String(filePath).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

          backend = {
            type: 'aio-lib-state',
            async readText(filePath) {
              const res = await state.get(toKey(filePath));
              return res?.value || null;
            },
            async writeText(filePath, content) {
              await state.put(toKey(filePath), content, { ttl: ONE_YEAR_TTL });
            },
            async readBuffer(filePath) {
              const res = await state.get(toKey(filePath));
              return res?.value ? Buffer.from(res.value, 'base64') : null;
            },
            async writeBuffer(filePath, buffer) {
              await state.put(toKey(filePath), buffer.toString('base64'), {
                ttl: ONE_YEAR_TTL
              });
            },
            async deleteFile(filePath) {
              await state.delete(toKey(filePath));
            }
          };
        } catch (stateErr) {
          // No persistent backend available: refuse to silently fall back to ephemeral /tmp
        }
      }
      if (!backend) {
        throw new Error(
          'No persistent storage backend (aio-lib-files / aio-lib-state) is available in this Runtime namespace.'
        );
      }
    }
  }

  if (!backend) {
    const defaultDir = process.env.__OW_NAMESPACE
      ? path.join(os.tmpdir(), 'aem-facerec-storage')
      : path.join(process.cwd(), '.local-storage');
    const baseDir = options.localDir || defaultDir;
    backend = {
      async readText(filePath) {
        const full = path.join(baseDir, filePath);
        if (!fs.existsSync(full)) return null;
        return fs.readFileSync(full, 'utf8');
      },
      async writeText(filePath, content) {
        const full = path.join(baseDir, filePath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, full);
      },
      async readBuffer(filePath) {
        const full = path.join(baseDir, filePath);
        if (!fs.existsSync(full)) return null;
        return fs.readFileSync(full);
      },
      async writeBuffer(filePath, buffer) {
        const full = path.join(baseDir, filePath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, buffer);
      },
      async deleteFile(filePath) {
        const full = path.join(baseDir, filePath);
        if (fs.existsSync(full)) {
          fs.unlinkSync(full);
        }
      }
    };
  }

  /**
   * Reads a JSON document. A missing document yields `defaultValue`; an unreadable or corrupt
   * document THROWS, so a transient storage error can never be persisted back as an empty DB.
   */
  async function readJson(filePath, defaultValue) {
    const raw = await backend.readText(filePath);
    if (raw === null || raw === undefined || raw === '') return structuredClone(defaultValue);
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`Stored document ${filePath} is corrupt and could not be parsed.`);
    }
  }

  async function writeJson(filePath, data) {
    await backend.writeText(filePath, JSON.stringify(data));
  }

  return {
    async getDatabase() {
      const [groups, faces, assets, counters] = await Promise.all([
        readJson('db/groups.json', {}),
        readJson('db/faces.json', {}),
        readJson('db/assets.json', {}),
        readJson('db/counters.json', { nextPersonNumber: 1 })
      ]);
      return { groups, faces, assets, counters };
    },

    async exportRawSnapshot() {
      const [groups, faces, assets, counters, settingsRaw] = await Promise.all([
        readJson('db/groups.json', {}),
        readJson('db/faces.json', {}),
        readJson('db/assets.json', {}),
        readJson('db/counters.json', { nextPersonNumber: 1 }),
        readJson('db/settings.json', {})
      ]);
      // Never export credentials, even encrypted
      const { awsSecretAccessKeyEncrypted, awsAccessKeyId, ...settingsRawSafe } = settingsRaw;
      return { groups, faces, assets, counters, settingsRaw: settingsRawSafe };
    },

    /**
     * Restores face data from a snapshot. Settings (and credentials) are intentionally NOT
     * imported; use saveSettings so they go through validation.
     */
    async importRawSnapshot({ groups, faces, assets, counters }) {
      const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
      for (const [name, value] of Object.entries({ groups, faces, assets, counters })) {
        if (value !== undefined && !isPlainObject(value)) {
          throw new PublicError(`Snapshot field '${name}' must be an object.`);
        }
      }
      const ops = [];
      if (groups) ops.push(writeJson('db/groups.json', groups));
      if (faces) ops.push(writeJson('db/faces.json', faces));
      if (assets) ops.push(writeJson('db/assets.json', assets));
      if (counters) ops.push(writeJson('db/counters.json', counters));
      await Promise.all(ops);
    },

    async saveDatabase({ groups, faces, assets, counters }) {
      const ops = [];
      if (groups) ops.push(writeJson('db/groups.json', groups));
      if (faces) ops.push(writeJson('db/faces.json', faces));
      if (assets) ops.push(writeJson('db/assets.json', assets));
      if (counters) ops.push(writeJson('db/counters.json', counters));
      await Promise.all(ops);
    },

    async getSettings({ includeDecryptedSecret = false } = {}) {
      const stored = await readJson('db/settings.json', {});
      const merged = { ...DEFAULT_SETTINGS, ...stored };

      let decryptedSecret = '';
      let secretUnreadable = false;
      if (merged.awsSecretAccessKeyEncrypted) {
        try {
          decryptedSecret = decryptSecret(merged.awsSecretAccessKeyEncrypted, encryptionKey);
        } catch (e) {
          // Encrypted with a different ENCRYPTION_SECRET (e.g. after key rotation). Treat as
          // not configured so the admin can re-enter it, instead of failing every request.
          secretUnreadable = true;
        }
      } else {
        decryptedSecret = process.env.AWS_SECRET_ACCESS_KEY || '';
      }

      const effectiveAccessKeyId =
        merged.awsAccessKeyId || process.env.AWS_ACCESS_KEY_ID || '';

      const result = {
        awsRegion: merged.awsRegion || process.env.AWS_REGION || 'us-east-1',
        awsAccessKeyId: effectiveAccessKeyId,
        hasAwsSecretKey: Boolean(decryptedSecret),
        awsSecretKeyUnreadable: secretUnreadable,
        awsSecretKeyMasked: maskSecret(decryptedSecret),
        collectionId:
          merged.collectionId ||
          process.env.REKOGNITION_COLLECTION_ID ||
          'aem-assets-faces',
        similarityThreshold: Number(merged.similarityThreshold ?? 85),
        metadataProperty: merged.metadataProperty || 'xdm:faceNames',
        includeUnnamedInMetadata: Boolean(merged.includeUnnamedInMetadata ?? true),
        processingProfileName: merged.processingProfileName ?? 'Face Recognition',
        requireProcessingProfile: Boolean(merged.requireProcessingProfile ?? true),
        enabledFolders: Array.isArray(merged.enabledFolders)
          ? merged.enabledFolders
          : ['/content/dam'],
        allowedImageTypes:
          Array.isArray(merged.allowedImageTypes) && merged.allowedImageTypes.length > 0
            ? merged.allowedImageTypes
            : DEFAULT_SETTINGS.allowedImageTypes,
        minImageSize: Number.isFinite(Number(merged.minImageSize))
          ? Number(merged.minImageSize)
          : DEFAULT_SETTINGS.minImageSize
      };

      if (includeDecryptedSecret) {
        result.awsSecretAccessKey = decryptedSecret;
      }

      return result;
    },

    async saveSettings(newSettings) {
      const currentRaw = await readJson('db/settings.json', {});
      const updated = { ...DEFAULT_SETTINGS, ...currentRaw };

      if (typeof newSettings.awsRegion === 'string' && newSettings.awsRegion.trim()) {
        const region = newSettings.awsRegion.trim();
        if (!AWS_REGION_PATTERN.test(region)) {
          throw new PublicError(`Invalid AWS region: ${region}`);
        }
        updated.awsRegion = region;
      }
      if (typeof newSettings.awsAccessKeyId === 'string') {
        updated.awsAccessKeyId = newSettings.awsAccessKeyId.trim();
      }
      if (
        typeof newSettings.awsSecretAccessKey === 'string' &&
        newSettings.awsSecretAccessKey.trim() !== '' &&
        !newSettings.awsSecretAccessKey.startsWith('••••')
      ) {
        updated.awsSecretAccessKeyEncrypted = encryptSecret(
          newSettings.awsSecretAccessKey.trim(),
          encryptionKey
        );
      }
      if (typeof newSettings.collectionId === 'string' && newSettings.collectionId.trim()) {
        const collectionId = newSettings.collectionId.trim();
        if (!COLLECTION_ID_PATTERN.test(collectionId)) {
          throw new PublicError('Collection ID may only contain letters, digits, _ . and -.');
        }
        updated.collectionId = collectionId;
      }
      if (newSettings.similarityThreshold !== undefined) {
        updated.similarityThreshold = Math.min(
          99,
          Math.max(50, Number(newSettings.similarityThreshold) || 85)
        );
      }
      if (typeof newSettings.metadataProperty === 'string' && newSettings.metadataProperty.trim()) {
        const prop = newSettings.metadataProperty.trim();
        if (!isValidMetadataProperty(prop)) {
          throw new PublicError(
            `Invalid metadata property '${prop}'. Use a namespaced name such as 'xdm:faceNames'.`
          );
        }
        updated.metadataProperty = prop;
      }
      if (typeof newSettings.includeUnnamedInMetadata === 'boolean') {
        updated.includeUnnamedInMetadata = newSettings.includeUnnamedInMetadata;
      }
      if (typeof newSettings.processingProfileName === 'string') {
        updated.processingProfileName = newSettings.processingProfileName.trim();
      }
      if (typeof newSettings.requireProcessingProfile === 'boolean') {
        updated.requireProcessingProfile = newSettings.requireProcessingProfile;
      }
      if (Array.isArray(newSettings.enabledFolders)) {
        updated.enabledFolders = newSettings.enabledFolders
          .map((f) => String(f).trim())
          .filter(Boolean)
          .map((f) => assertDamPath(f, 'enabled folder'));
      }

      if (Array.isArray(newSettings.allowedImageTypes)) {
        const types = Array.from(
          new Set(newSettings.allowedImageTypes.map((t) => String(t).trim().toLowerCase()).filter(Boolean))
        );
        const invalid = types.filter((t) => !MIME_TYPE_PATTERN.test(t));
        if (invalid.length > 0) {
          throw new PublicError(`Invalid image type(s): ${invalid.join(', ')}. Use values like image/jpeg.`);
        }
        if (types.length === 0) {
          throw new PublicError('At least one image type must be allowed.');
        }
        updated.allowedImageTypes = types;
      }
      if (newSettings.minImageSize !== undefined && newSettings.minImageSize !== '') {
        const size = Number(newSettings.minImageSize);
        if (!Number.isInteger(size) || size < 0 || size > 4000) {
          throw new PublicError('Minimum image size must be a whole number of pixels between 0 and 4000.');
        }
        updated.minImageSize = size;
      }

      await writeJson('db/settings.json', updated);
      return this.getSettings({ includeDecryptedSecret: false });
    },

    async saveAvatar(faceId, buffer) {
      const filePath = `avatars/${assertSafeFaceId(faceId)}.jpg`;
      await backend.writeBuffer(filePath, buffer);
      return filePath;
    },

    async getAvatar(faceId) {
      return backend.readBuffer(`avatars/${assertSafeFaceId(faceId)}.jpg`);
    },

    async deleteAvatar(faceId) {
      await backend.deleteFile(`avatars/${assertSafeFaceId(faceId)}.jpg`);
    }
  };
}

module.exports = {
  createStorage,
  encryptSecret,
  decryptSecret,
  maskSecret,
  DEFAULT_SETTINGS
};
