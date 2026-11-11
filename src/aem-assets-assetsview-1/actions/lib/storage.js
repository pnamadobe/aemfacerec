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
const EVENT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_STORED_EVENT_KEYS = 2000;

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
  enableSecondaryMetadataProperty: true,
  secondaryMetadataProperty: 'xdm:persona',
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
  minImageSize: 200,
  // Governance: when true, only AEM Administrators or members of curatorGroups can
  // name, rename, merge, split, or delete face groups
  restrictCuratorActionsToAdmins: false,
  curatorGroups: ['administrators', 'dam-administrators']
};

const MIME_TYPE_PATTERN = /^image\/[a-z0-9][a-z0-9.+-]{0,99}$/;
const CURATOR_GROUP_PATTERN = /^[a-zA-Z0-9_.\-: ]{1,128}$/;

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

      // Cross-container distributed lease + event dedupe via @adobe/aio-lib-state when available.
      // Initialized lazily so read-only calls (e.g. getAssetFaces) never wait on stateLib.init().
      let stateClientPromise = null;
      const getStateClient = () => {
        if (!stateClientPromise) {
          stateClientPromise = Promise.resolve()
            .then(() => {
              const stateLib = require('@adobe/aio-lib-state');
              return stateLib.init();
            })
            .catch(() => null);
        }
        return stateClientPromise;
      };
      const LOCK_KEY = 'facerec_db_lease_lock_v1';
      backend.acquireLease = async (ownerId, ttlSeconds = 60) => {
        const state = await getStateClient();
        if (!state) return true;
        const res = await state.put(LOCK_KEY, ownerId, {
          ttl: Math.max(60, Math.ceil(ttlSeconds)),
          ifNotExists: true
        });
        return Boolean(res);
      };
      backend.releaseLease = async (ownerId) => {
        const state = await getStateClient();
        if (!state) return;
        try {
          const cur = await state.get(LOCK_KEY);
          if (!cur || !cur.value || cur.value === ownerId) {
            await state.delete(LOCK_KEY);
          }
        } catch (e) {
          // lease will expire naturally via TTL
        }
      };
      backend.claimIdempotencyKey = async (eventKey, ttlSeconds = 86400) => {
        const state = await getStateClient();
        if (!state) return true;
        const safeKey = `facerec_evt_${crypto.createHash('sha256').update(String(eventKey)).digest('hex').slice(0, 40)}`;
        const res = await state.put(safeKey, new Date().toISOString(), {
          ttl: Math.max(60, Math.ceil(ttlSeconds)),
          ifNotExists: true
        });
        return Boolean(res);
      };
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
      },
      async acquireLease(ownerId, ttlSeconds = 60) {
        const lockDir = path.join(baseDir, 'db/.lease.lock');
        fs.mkdirSync(path.dirname(lockDir), { recursive: true });
        try {
          fs.mkdirSync(lockDir);
          fs.writeFileSync(
            path.join(lockDir, 'owner.json'),
            JSON.stringify({ ownerId, expiresAt: Date.now() + ttlSeconds * 1000 })
          );
          return true;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          try {
            const info = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
            if (info.expiresAt && Date.now() > info.expiresAt) {
              fs.rmSync(lockDir, { recursive: true, force: true });
              return this.acquireLease(ownerId, ttlSeconds);
            }
          } catch (e) {
            // another process is mid-write
          }
          return false;
        }
      },
      async releaseLease(ownerId) {
        const lockDir = path.join(baseDir, 'db/.lease.lock');
        try {
          const info = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
          if (!info.ownerId || info.ownerId === ownerId) {
            fs.rmSync(lockDir, { recursive: true, force: true });
          }
        } catch (e) {
          fs.rmSync(lockDir, { recursive: true, force: true });
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

  // Serializes mutations inside the same Node process and coordinates across processes/containers
  // via backend.acquireLease when available.
  let inProcessChain = Promise.resolve();
  const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function withDatabaseLock(fn, { timeoutMs = 15000, leaseTtlSeconds = 60 } = {}) {
    const runExclusive = async () => {
      const ownerId = crypto.randomBytes(12).toString('hex');
      if (typeof backend.acquireLease === 'function') {
        const deadline = Date.now() + timeoutMs;
        let acquired = false;
        let attempt = 0;
        while (Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop
          if (await backend.acquireLease(ownerId, leaseTtlSeconds)) {
            acquired = true;
            break;
          }
          attempt++;
          // eslint-disable-next-line no-await-in-loop
          await sleep(Math.min(200, 15 * attempt) + Math.floor(Math.random() * 25));
        }
        if (!acquired) {
          throw new Error('Timed out waiting for database write lock.');
        }
      }
      try {
        return await fn();
      } finally {
        if (typeof backend.releaseLease === 'function') {
          await backend.releaseLease(ownerId);
        }
      }
    };

    const next = inProcessChain.then(runExclusive, runExclusive);
    inProcessChain = next.catch(() => {});
    return next;
  }

  /**
   * Computes a revision map over a database snapshot so saveDatabase can detect which
   * collections changed since getDatabase() and merge concurrent edits to untouched records.
   */
  function snapshotDatabase(db) {
    return {
      groups: structuredClone(db.groups || {}),
      faces: structuredClone(db.faces || {}),
      assets: structuredClone(db.assets || {}),
      counters: structuredClone(db.counters || { nextPersonNumber: 1 })
    };
  }

  function mergeMapChanges(baseMap = {}, workingMap = {}, latestMap = {}) {
    const merged = { ...latestMap };
    const allKeys = new Set([
      ...Object.keys(baseMap),
      ...Object.keys(workingMap),
      ...Object.keys(latestMap)
    ]);
    let changed = false;

    for (const key of allKeys) {
      const inBase = Object.prototype.hasOwnProperty.call(baseMap, key);
      const inWorking = Object.prototype.hasOwnProperty.call(workingMap, key);
      const inLatest = Object.prototype.hasOwnProperty.call(latestMap, key);
      const baseJson = inBase ? JSON.stringify(baseMap[key]) : null;
      const workingJson = inWorking ? JSON.stringify(workingMap[key]) : null;
      const latestJson = inLatest ? JSON.stringify(latestMap[key]) : null;

      // Only apply this caller's change if the caller actually touched `key`
      if (workingJson !== baseJson) {
        if (!inWorking) {
          if (inLatest) {
            delete merged[key];
            changed = true;
          }
        } else if (
          inLatest &&
          latestJson !== baseJson &&
          Array.isArray(workingMap[key]?.faceIds) &&
          Array.isArray(latestMap[key]?.faceIds)
        ) {
          // Concurrent update to the same group/asset record: preserve faceIds added by the
          // other writer and only remove faceIds that this caller explicitly removed.
          const baseFaceIds = Array.isArray(baseMap[key]?.faceIds) ? baseMap[key].faceIds : [];
          const removedByWorking = new Set(
            baseFaceIds.filter((id) => !workingMap[key].faceIds.includes(id))
          );
          const removedByLatest = new Set(
            baseFaceIds.filter((id) => !latestMap[key].faceIds.includes(id))
          );
          const unionFaceIds = Array.from(
            new Set([...latestMap[key].faceIds, ...workingMap[key].faceIds])
          ).filter((id) => !removedByWorking.has(id) && !removedByLatest.has(id));
          merged[key] = {
            ...latestMap[key],
            ...workingMap[key],
            faceIds: unionFaceIds
          };
          changed = true;
        } else if (workingJson !== latestJson) {
          merged[key] = workingMap[key];
          changed = true;
        }
      }
    }
    return { merged, changed };
  }

  return {
    async getAssetsMap() {
      return readJson('db/assets.json', {});
    },

    async getDatabase({ readOnly = false } = {}) {
      if (readOnly) {
        const [groups, faces, assets] = await Promise.all([
          readJson('db/groups.json', {}),
          readJson('db/faces.json', {}),
          readJson('db/assets.json', {})
        ]);
        return { groups, faces, assets, counters: { nextPersonNumber: 1 } };
      }
      const [groups, faces, assets, counters] = await Promise.all([
        readJson('db/groups.json', {}),
        readJson('db/faces.json', {}),
        readJson('db/assets.json', {}),
        readJson('db/counters.json', { nextPersonNumber: 1 })
      ]);
      const db = { groups, faces, assets, counters };
      Object.defineProperty(db, '_baseSnapshot', {
        value: snapshotDatabase(db),
        enumerable: false,
        configurable: true,
        writable: true
      });
      return db;
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

    /**
     * Persists database changes under a distributed/in-process lock, merging record-level
     * additions, updates, and deletions against the latest stored state so concurrent
     * operations never clobber each other's changes (R1/R3).
     */
    async saveDatabase(db) {
      return withDatabaseLock(async () => {
        const base = db._baseSnapshot || null;

        if (!base) {
          // Full replacement (e.g. clearAllData / seedDemoData / unit-test seed)
          if (db.faces) await writeJson('db/faces.json', db.faces);
          if (db.groups) await writeJson('db/groups.json', db.groups);
          if (db.assets) await writeJson('db/assets.json', db.assets);
          if (db.counters) await writeJson('db/counters.json', db.counters);
          Object.defineProperty(db, '_baseSnapshot', {
            value: snapshotDatabase(db),
            enumerable: false,
            configurable: true,
            writable: true
          });
          return;
        }

        const [latestGroups, latestFaces, latestAssets, latestCounters] = await Promise.all([
          readJson('db/groups.json', {}),
          readJson('db/faces.json', {}),
          readJson('db/assets.json', {}),
          readJson('db/counters.json', { nextPersonNumber: 1 })
        ]);

        const facesDiff = mergeMapChanges(base.faces, db.faces || {}, latestFaces);
        const groupsDiff = mergeMapChanges(base.groups, db.groups || {}, latestGroups);
        const assetsDiff = mergeMapChanges(base.assets, db.assets || {}, latestAssets);

        // Assign globally unique `Person #N` placeholder labels across concurrent ingests
        // and auto-repair any existing duplicate `autoLabel` collisions.
        const usedNumbers = new Set();
        let maxUsedNumber = Math.max(
          0,
          (Number(latestCounters?.nextPersonNumber) || 1) - 1,
          (Number(db.counters?.nextPersonNumber) || 1) - 1
        );

        // 1. Reserve numbers from groups that already existed before this save
        const sortedGroups = Object.values(groupsDiff.merged).sort((a, b) =>
          String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
          String(a.groupId || '').localeCompare(String(b.groupId || ''))
        );
        const collidingGroups = [];

        for (const grp of sortedGroups) {
          if (!grp) continue;
          const m = String(grp.autoLabel || '').match(/^Person #(\d+)$/);
          const num = m ? Number(m[1]) : 0;
          if (num > 0 && !usedNumbers.has(num)) {
            usedNumbers.add(num);
            if (num > maxUsedNumber) maxUsedNumber = num;
          } else {
            collidingGroups.push(grp);
          }
        }

        // 2. Give any colliding or newly-created duplicate group its own sequential Person #N
        for (const grp of collidingGroups) {
          maxUsedNumber += 1;
          usedNumbers.add(maxUsedNumber);
          grp.autoLabel = `Person #${maxUsedNumber}`;
          groupsDiff.changed = true;
        }

        const nextPersonNumber = maxUsedNumber + 1;
        const mergedCounters = { ...latestCounters, ...db.counters, nextPersonNumber };
        const countersChanged = JSON.stringify(mergedCounters) !== JSON.stringify(latestCounters);

        // Write in dependency order (faces -> groups -> assets -> counters) and only for
        // collections that actually changed.
        if (facesDiff.changed) await writeJson('db/faces.json', facesDiff.merged);
        if (groupsDiff.changed) await writeJson('db/groups.json', groupsDiff.merged);
        if (assetsDiff.changed) await writeJson('db/assets.json', assetsDiff.merged);
        if (countersChanged) await writeJson('db/counters.json', mergedCounters);

        db.groups = groupsDiff.merged;
        db.faces = facesDiff.merged;
        db.assets = assetsDiff.merged;
        db.counters = mergedCounters;
        Object.defineProperty(db, '_baseSnapshot', {
          value: snapshotDatabase(db),
          enumerable: false,
          configurable: true,
          writable: true
        });
      });
    },

    /**
     * Runs an atomic read-modify-write transaction under the database lock.
     */
    async transactDatabase(mutatorFn) {
      return withDatabaseLock(async () => {
        const db = await this.getDatabase();
        const result = await mutatorFn(db);
        // Save directly without re-acquiring the lock
        const base = db._baseSnapshot;
        const facesChanged = JSON.stringify(db.faces) !== JSON.stringify(base.faces);
        const groupsChanged = JSON.stringify(db.groups) !== JSON.stringify(base.groups);
        const assetsChanged = JSON.stringify(db.assets) !== JSON.stringify(base.assets);
        const countersChanged = JSON.stringify(db.counters) !== JSON.stringify(base.counters);
        if (facesChanged) await writeJson('db/faces.json', db.faces);
        if (groupsChanged) await writeJson('db/groups.json', db.groups);
        if (assetsChanged) await writeJson('db/assets.json', db.assets);
        if (countersChanged) await writeJson('db/counters.json', db.counters);
        return result;
      });
    },

    /**
     * Claims an I/O Event idempotency key (`R10`). Returns `true` the first time the key is
     * seen within the TTL window, and `false` on duplicate/retry deliveries.
     */
    async claimEventIdempotencyKey(eventKey, ttlMs = EVENT_DEDUPE_TTL_MS) {
      if (!eventKey) return true;
      const cleanKey = String(eventKey).trim().slice(0, 300);
      if (!cleanKey) return true;

      if (typeof backend.claimIdempotencyKey === 'function') {
        return backend.claimIdempotencyKey(cleanKey, Math.ceil(ttlMs / 1000));
      }

      return withDatabaseLock(async () => {
        const now = Date.now();
        const events = await readJson('db/events.json', {});
        for (const [k, expiresAt] of Object.entries(events)) {
          if (!expiresAt || expiresAt <= now) delete events[k];
        }
        if (events[cleanKey] && events[cleanKey] > now) {
          return false;
        }
        events[cleanKey] = now + ttlMs;
        const keys = Object.keys(events);
        if (keys.length > MAX_STORED_EVENT_KEYS) {
          for (const oldKey of keys.slice(0, keys.length - MAX_STORED_EVENT_KEYS)) {
            delete events[oldKey];
          }
        }
        await writeJson('db/events.json', events);
        return true;
      });
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
        enableSecondaryMetadataProperty: Boolean(
          merged.enableSecondaryMetadataProperty ?? DEFAULT_SETTINGS.enableSecondaryMetadataProperty
        ),
        secondaryMetadataProperty:
          merged.secondaryMetadataProperty || DEFAULT_SETTINGS.secondaryMetadataProperty,
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
          : DEFAULT_SETTINGS.minImageSize,
        restrictCuratorActionsToAdmins: Boolean(merged.restrictCuratorActionsToAdmins ?? false),
        curatorGroups:
          Array.isArray(merged.curatorGroups) && merged.curatorGroups.length > 0
            ? merged.curatorGroups
            : DEFAULT_SETTINGS.curatorGroups
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
      if (typeof newSettings.enableSecondaryMetadataProperty === 'boolean') {
        updated.enableSecondaryMetadataProperty = newSettings.enableSecondaryMetadataProperty;
      }
      if (
        typeof newSettings.secondaryMetadataProperty === 'string' &&
        newSettings.secondaryMetadataProperty.trim()
      ) {
        const secProp = newSettings.secondaryMetadataProperty.trim();
        if (!isValidMetadataProperty(secProp)) {
          throw new PublicError(
            `Invalid secondary metadata property '${secProp}'. Use a namespaced name such as 'iptc4xmpExt:PersonInImage'.`
          );
        }
        updated.secondaryMetadataProperty = secProp;
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

      if (typeof newSettings.restrictCuratorActionsToAdmins === 'boolean') {
        updated.restrictCuratorActionsToAdmins = newSettings.restrictCuratorActionsToAdmins;
      }
      if (Array.isArray(newSettings.curatorGroups)) {
        const groups = Array.from(
          new Set(
            newSettings.curatorGroups
              .map((g) => String(g).trim().toLowerCase())
              .filter(Boolean)
          )
        );
        const invalid = groups.filter((g) => !CURATOR_GROUP_PATTERN.test(g));
        if (invalid.length > 0) {
          throw new PublicError(
            `Invalid curator group name(s): ${invalid.join(', ')}. Use AEM group IDs such as 'administrators' or 'face-curators'.`
          );
        }
        updated.curatorGroups =
          groups.length > 0 ? groups : DEFAULT_SETTINGS.curatorGroups;
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
