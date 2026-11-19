/**
 * License suggestions: for the people recognized in an asset, find AEM licenses whose contract
 * headshot matches that person's face (Rekognition SearchFacesByImage). Matching is face-only;
 * licenser/licensee names are display information and never influence a match.
 *
 * The contract headshot is searched statelessly and never stored. Only the resulting
 * licenseId -> faceGroup mapping is cached.
 */
const { PublicError } = require('./security');
const { extractJpegImages } = require('./pdf-headshot');

const STRONG_SIMILARITY = 90;
const MAX_REKOGNITION_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CHECKS_PER_CALL = 6;
const MATCHED_TTL_MS = 60 * 60 * 1000;
const OTHER_TTL_MS = 5 * 60 * 1000; // no-match results go stale as new faces get indexed

function isFresh(entry, groups, now) {
  if (!entry) return false;
  const age = now - Date.parse(entry.checkedAt || 0);
  if (entry.status === 'matched') {
    // A merged/deleted group invalidates the mapping
    return age < MATCHED_TTL_MS && entry.matches.every((m) => groups[m.groupId]);
  }
  return age < OTHER_TTL_MS;
}

function createLicenseSuggestionService({ storage, faceService, licenseClient, getRekognition, now = () => Date.now() }) {
  async function checkLicense(license, db, rekognition, threshold) {
    const base = { checkedAt: new Date(now()).toISOString() };
    let pdf;
    try {
      pdf = await licenseClient.getLicenseDocument(license.licenseId);
    } catch (e) {
      if (e && e.statusCode === 403) throw e;
      return { ...base, status: 'unreadable', matches: [] };
    }
    const [headshot] = extractJpegImages(pdf);
    if (!headshot) return { ...base, status: 'no-headshot', matches: [] };
    if (headshot.bytes > MAX_REKOGNITION_IMAGE_BYTES) return { ...base, status: 'too-large', matches: [] };
    const res = await rekognition.searchFacesByImage(headshot.data, db.faces, db.groups, { threshold });
    if (res.noFace) return { ...base, status: 'no-face', matches: [] };
    if (res.matches.length === 0) return { ...base, status: 'no-match', matches: [] };
    return { ...base, status: 'matched', matches: res.matches.slice(0, 3) };
  }

  return {
    async suggestForAsset({ assetId, assetPath, assetName }) {
      const settings = await storage.getSettings();
      if (!settings.enableLicenseSuggestions) {
        throw new PublicError('License suggestions are not enabled for this deployment.', 403);
      }
      const asset = await faceService.getAssetFaces({ assetId, assetPath, assetName });
      const people = [];
      const seen = new Set();
      for (const f of asset.faces || []) {
        if (!f.groupId || seen.has(f.groupId)) continue;
        seen.add(f.groupId);
        people.push({ groupId: f.groupId, displayName: f.groupDisplayName, suggestions: [] });
      }
      if (people.length === 0) {
        return { scanned: Boolean(asset.scanned), people, licenseCount: 0, checkedCount: 0, pendingCount: 0 };
      }

      const licenses = await licenseClient.listLicenses();
      const db = await storage.getDatabase({ readOnly: true });
      const cache = await storage.getLicenseMatches();
      const t = now();
      const stale = licenses.filter((l) => !isFresh(cache[`${l.licenseId}:${l.version}`], db.groups, t));
      const batch = stale.slice(0, MAX_CHECKS_PER_CALL);

      if (batch.length > 0) {
        const { rekognition } = await getRekognition();
        const threshold = Math.min(settings.similarityThreshold, STRONG_SIMILARITY);
        for (const license of batch) {
          // Sequential on purpose: each check downloads a PDF and calls Rekognition
          // eslint-disable-next-line no-await-in-loop
          cache[`${license.licenseId}:${license.version}`] = await checkLicense(license, db, rekognition, threshold);
        }
        await storage.saveLicenseMatches(cache);
      }

      const assignedLicenseIds = licenseClient.getAssignedLicenseIds
        ? await licenseClient.getAssignedLicenseIds(asset.assetPath || assetPath)
        : [];
      const byGroup = new Map(people.map((p) => [p.groupId, p]));
      for (const license of licenses) {
        const entry = cache[`${license.licenseId}:${license.version}`];
        if (!entry || entry.status !== 'matched') continue;
        for (const m of entry.matches) {
          const person = byGroup.get(m.groupId);
          if (person) {
            person.suggestions.push({
              ...license,
              similarity: m.similarity,
              strong: m.similarity >= STRONG_SIMILARITY,
              assigned: assignedLicenseIds.includes(license.licenseId)
            });
          }
        }
      }
      for (const p of people) p.suggestions.sort((a, b) => b.similarity - a.similarity);

      return {
        scanned: true,
        people,
        assignedLicenseIds,
        licenseCount: licenses.length,
        checkedCount: licenses.length - (stale.length - batch.length),
        pendingCount: stale.length - batch.length
      };
    },

    /** Short-lived URL so the user can review the contract before confirming a suggestion. */
    async getDocumentUrl({ licenseId }) {
      const settings = await storage.getSettings();
      if (!settings.enableLicenseSuggestions) {
        throw new PublicError('License suggestions are not enabled for this deployment.', 403);
      }
      if (!licenseId) throw new PublicError('licenseId is required.');
      return { url: await licenseClient.getLicenseDocumentUrl(licenseId) };
    },

    /** One chunk of the contract PDF for the in-modal viewer. */
    async getDocumentChunk({ licenseId, offset, length }) {
      const settings = await storage.getSettings();
      if (!settings.enableLicenseSuggestions) {
        throw new PublicError('License suggestions are not enabled for this deployment.', 403);
      }
      if (!licenseId) throw new PublicError('licenseId is required.');
      return licenseClient.getLicenseDocumentRange(licenseId, offset, length);
    },

    async applyLicense({ assetPath, licenseId }) {
      const settings = await storage.getSettings();
      if (!settings.enableLicenseSuggestions) {
        throw new PublicError('License suggestions are not enabled for this deployment.', 403);
      }
      if (!assetPath || !licenseId) throw new PublicError('assetPath and licenseId are required.');
      return licenseClient.assignLicense([assetPath], licenseId);
    }
  };
}

module.exports = { createLicenseSuggestionService, STRONG_SIMILARITY, MAX_CHECKS_PER_CALL };
