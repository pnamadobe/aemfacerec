const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
  enabledFolders: ['/content/dam']
};

/**
 * Encrypts a plaintext string using AES-256-GCM with a key derived from secret.
 */
function encryptSecret(plaintext, secret = 'default-aem-facerec-secret-key') {
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
function decryptSecret(payload, secret = 'default-aem-facerec-secret-key') {
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
  const encryptionKey =
    options.encryptionSecret ||
    process.env.ENCRYPTION_SECRET ||
    'default-aem-facerec-secret-key';

  let backend = options.backend || null;

  if (!backend) {
    if (process.env.AIO_runtime_namespace && !options.useLocal) {
      try {
        const filesLib = require('@adobe/aio-lib-files');
        const files = await filesLib.init();
        backend = {
          async readText(filePath) {
            try {
              const buf = await files.read(filePath);
              return buf.toString('utf8');
            } catch (e) {
              return null;
            }
          },
          async writeText(filePath, content) {
            await files.write(filePath, Buffer.from(content, 'utf8'));
          },
          async readBuffer(filePath) {
            try {
              return await files.read(filePath);
            } catch (e) {
              return null;
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
        // Fallback to local disk storage if aio-lib-files cannot initialize
      }
    }
  }

  if (!backend) {
    const baseDir = options.localDir || path.join(process.cwd(), '.local-storage');
    backend = {
      async readText(filePath) {
        const full = path.join(baseDir, filePath);
        if (!fs.existsSync(full)) return null;
        return fs.readFileSync(full, 'utf8');
      },
      async writeText(filePath, content) {
        const full = path.join(baseDir, filePath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
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

  async function readJson(filePath, defaultValue) {
    const raw = await backend.readText(filePath);
    if (!raw) return structuredClone(defaultValue);
    try {
      return JSON.parse(raw);
    } catch (e) {
      return structuredClone(defaultValue);
    }
  }

  async function writeJson(filePath, data) {
    await backend.writeText(filePath, JSON.stringify(data, null, 2));
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

      const decryptedSecret = merged.awsSecretAccessKeyEncrypted
        ? decryptSecret(merged.awsSecretAccessKeyEncrypted, encryptionKey)
        : process.env.AWS_SECRET_ACCESS_KEY || '';

      const effectiveAccessKeyId =
        merged.awsAccessKeyId || process.env.AWS_ACCESS_KEY_ID || '';

      const result = {
        awsRegion: merged.awsRegion || process.env.AWS_REGION || 'us-east-1',
        awsAccessKeyId: effectiveAccessKeyId,
        hasAwsSecretKey: Boolean(decryptedSecret),
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
          : ['/content/dam']
      };

      if (includeDecryptedSecret) {
        result.awsSecretAccessKey = decryptedSecret;
      }

      return result;
    },

    async saveSettings(newSettings) {
      const currentRaw = await readJson('db/settings.json', {});
      const updated = { ...DEFAULT_SETTINGS, ...currentRaw };

      if (typeof newSettings.awsRegion === 'string') {
        updated.awsRegion = newSettings.awsRegion.trim();
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
        updated.collectionId = newSettings.collectionId.trim();
      }
      if (newSettings.similarityThreshold !== undefined) {
        updated.similarityThreshold = Math.min(
          99,
          Math.max(50, Number(newSettings.similarityThreshold) || 85)
        );
      }
      if (typeof newSettings.metadataProperty === 'string' && newSettings.metadataProperty.trim()) {
        updated.metadataProperty = newSettings.metadataProperty.trim();
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
          .filter(Boolean);
      }

      await writeJson('db/settings.json', updated);
      return this.getSettings({ includeDecryptedSecret: false });
    },

    async saveAvatar(faceId, buffer) {
      const filePath = `avatars/${faceId}.jpg`;
      await backend.writeBuffer(filePath, buffer);
      return filePath;
    },

    async getAvatar(faceId) {
      return backend.readBuffer(`avatars/${faceId}.jpg`);
    },

    async deleteAvatar(faceId) {
      await backend.deleteFile(`avatars/${faceId}.jpg`);
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
