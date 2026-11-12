---
name: aem-face-recognition
description: Inspect, list, search, and manage recognized faces and people across AEM DAM folders and image assets. Use whenever the user is viewing a DAM folder or asset detail page in AEM and asks to "list the faces in each of the assets here", "who is in this folder/image?", "what other assets have the same people as this image?", "find all photos with <Person>", "which unnamed people appear the most?", "is face recognition enabled on this AEM instance?", or "scan this folder/asset for faces". Works natively inside the AEM Coworker sidebar via AEM `read-api` (`search-assets`) with zero local files or Node/CLI dependencies required.
---

# AEM Assets Facial Recognition & Grouping (`aem-face-recognition`)

Works with the **AEM Assets View Facial Recognition & Grouping App Builder Extension** (`aem/assets/assetsview/1`, bound to `https://author-p59602-e520244.adobeaemcloud.com`).

## Critical: How This Skill Runs in the AEM Coworker Sidebar

**Do NOT shell out to `node` or look for local `.env` files when running inside the AEM Coworker cloud sandbox.**
Instead, use **`Adobe Experience Manager: read-api`** (`aem.post('/adobe/experimental/aemmcpserver-expires-20991231/search-assets', ...)`).

Every image scanned by the Face Recognition App Builder extension has its face-detection results synced directly onto `assetMetadata` (`jcr:content/metadata`) in AEM Author:

| `assetMetadata` Field | Type | Meaning |
| :--- | :--- | :--- |
| `xdm:faceCount` | `String` / `Number` | Total faces detected on the asset (`"0"`, `"1"`, `"2"`, ...). If `undefined`, the asset has **not** been scanned yet. |
| `xdm:faceLabels` | `String[]` | **Ordered left-to-right (`#1 leftmost` → `#N rightmost`)**. Always contains the display label for every detected person — **both named people (`"John Johnson"`, `"Jill Jelly"`) AND unnamed placeholders (`"Person #38"`, `"Person #70"`)**. |
| `xdm:faceGroupIds` | `String[]` | **Ordered left-to-right** in 1-to-1 correspondence with `xdm:faceLabels` (e.g. `["grp_2a9b64a3", "grp_cc233d4a"]`). Uniquely identifies each person across the entire DAM even before they are given a real name. |
| `xdm:faceNames` | `String[]` | Named people on the asset (omits `Person #N` placeholders when *Hide unnamed placeholders* is enabled in Settings). |
| `xdm:persona` | `String[]` | Dual-written copy of `xdm:faceNames` (pre-indexed in AEM Assets View's Search Filter rail). |

> **Practitioner Communication Note**: Present people by their human-readable names (`"Jill Jelly"`, `"John Johnson"`) or placeholder labels (`"Person #38"`), ordered left-to-right, and refer to assets by their filename/title. Keep raw `grp_...` IDs and `xdm:*` property names internal unless the user asks for technical details.

---

## Workflow 0: Verify the Face Recognition Extension Is Active on the AEM Instance

Before running a query (or if the user asks whether face recognition is available on the current AEM environment), check:
1. This extension deployment is bound to **`https://author-p59602-e520244.adobeaemcloud.com`**.
2. You can verify face recognition metadata is active on any `aemUrl` with a single `read-api` call:

```javascript
// Run in read-api with aemUrl
const r = await aem.post('/adobe/experimental/aemmcpserver-expires-20991231/search-assets', {
  termFilters: [{ key: "repositoryMetadata.repo:ancestors", value: "/content/dam" }],
  limit: 50
});
const results = r.body.results || [];
const scannedSample = results.filter(a => a.assetMetadata && a.assetMetadata['xdm:faceCount'] !== undefined);
return {
  extensionActive: scannedSample.length > 0,
  sampledAssets: results.length,
  scannedAssetsInSample: scannedSample.length
};
```
If `extensionActive` is `false` (and the host is not `author-p59602-e520244.adobeaemcloud.com`), let the user know that the Face Recognition extension is not active on that AEM environment.

---

## Workflow 1: List the Faces in Each Asset in a Folder ("list the faces in each of the assets here")

When the user is on a DAM folder (e.g. `/content/dam/26H2/hertz/hertz-2026-fall shoot`) and asks to **list the faces in each asset**, **see who is in the folder**, or **inspect the folder**:
- **Never re-scan already-scanned assets.**
- Run this single **`read-api`** call to get every asset in the folder, its left-to-right face list (`xdm:faceLabels`), and a summary of recurring people across the folder:

```javascript
// Run in read-api with aemUrl = "https://author-p59602-e520244.adobeaemcloud.com"
const FOLDER = "/content/dam/26H2/hertz/hertz-2026-fall shoot"; // replace with target folder path
const allAssets = [];
let cursor = null;
do {
  const r = await aem.post('/adobe/experimental/aemmcpserver-expires-20991231/search-assets', {
    termFilters: [{ key: "repositoryMetadata.repo:ancestors", value: FOLDER }],
    limit: 100,
    cursor
  });
  allAssets.push(...(r.body.results || []));
  cursor = r.body.cursor;
} while (cursor);

// Filter to direct child image assets of FOLDER (or keep all descendants if user asked recursively)
const toArray = (v) => Array.isArray(v) ? v : (v ? [v] : []);
const peopleCounts = {};
const assets = allAssets
  .filter(a => String(a.repositoryMetadata?.['dc:format'] || '').startsWith('image/'))
  .map(a => {
    const meta = a.assetMetadata || {};
    const scanned = meta['xdm:faceCount'] !== undefined;
    const faceCount = scanned ? Number(meta['xdm:faceCount'] || 0) : null;
    const facesLeftToRight = toArray(meta['xdm:faceLabels'].length ? meta['xdm:faceLabels'] : meta['xdm:faceNames']);
    for (const label of facesLeftToRight) {
      peopleCounts[label] = (peopleCounts[label] || 0) + 1;
    }
    return {
      name: a.repositoryMetadata['repo:name'],
      path: a.repositoryMetadata['repo:path'],
      scanned,
      faceCount,
      facesLeftToRight
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const recurringPeople = Object.entries(peopleCounts)
  .sort((a, b) => b[1] - a[1])
  .map(([person, assetCount]) => ({ person, assetCount }));

return {
  folder: FOLDER,
  totalImages: assets.length,
  scannedCount: assets.filter(a => a.scanned).length,
  unscannedCount: assets.filter(a => !a.scanned).length,
  recurringPeople,
  assets
};
```

Present the results clearly:
1. **Summary**: Total images in the folder, how many have faces detected, and any recurring people across multiple photos in the folder.
2. **Per-Asset Breakdown**: Each image filename, its face count, and the people detected (ordered **left-to-right**).
3. If `unscannedCount > 0`, mention which images haven't been scanned yet and let the user know they can click **Scan Current Folder** in the **Face Groups** modal (or **Recognize Faces** in the action bar) to analyze the new ones.

---

## Workflow 2: Inspect a Single Asset & What Other Assets Share the Same People

When the user is on an **Asset Detail** page (or names a specific image) and asks:
- *"Who is in this image?"*
- *"What other assets have the same people as the current image?"*
- *"Where else do the people in this photo appear?"*

Run this single **`read-api`** call. It looks up the source image's `xdm:faceGroupIds` and `xdm:faceLabels` (ordered left-to-right), then searches across `/content/dam` for every other asset sharing one or more of those `xdm:faceGroupIds` — **working for both named people (`Freddie Father`, `Jill Jelly`) AND unnamed placeholders (`Person #38`)**:

```javascript
// Run in read-api with aemUrl = "https://author-p59602-e520244.adobeaemcloud.com"
const SOURCE_FOLDER = "/content/dam/26H2/hertz/hertz-2026-fall shoot"; // parent folder of current asset
const SOURCE_NAME = "hertz_elderly-couple_resort_luxury-sedan_v1.png";   // filename of current asset
const toArray = (v) => Array.isArray(v) ? v : (v ? [v] : []);

// 1. Fetch the source asset
const srcRes = await aem.post('/adobe/experimental/aemmcpserver-expires-20991231/search-assets', {
  termFilters: [
    { key: "repositoryMetadata.repo:ancestors", value: SOURCE_FOLDER },
    { key: "repositoryMetadata.repo:name", value: SOURCE_NAME }
  ],
  limit: 5
});
const srcAsset = (srcRes.body.results || [])[0];
if (!srcAsset) return { error: `Asset ${SOURCE_NAME} not found in ${SOURCE_FOLDER}` };

const srcMeta = srcAsset.assetMetadata || {};
const srcPath = srcAsset.repositoryMetadata['repo:path'];
const srcLabels = toArray(srcMeta['xdm:faceLabels'] || srcMeta['xdm:faceNames']);
const srcGroupIds = toArray(srcMeta['xdm:faceGroupIds']);

// Map groupId -> display label from source asset
const labelByGroupId = {};
srcGroupIds.forEach((gId, i) => {
  labelByGroupId[gId] = srcLabels[i] || gId;
});
const targetGroupSet = new Set(srcGroupIds);

// 2. Scan indexed DAM assets to find all other assets sharing any of these people
const allDamAssets = [];
let cursor = null, pages = 0;
do {
  const r = await aem.post('/adobe/experimental/aemmcpserver-expires-20991231/search-assets', {
    termFilters: [{ key: "repositoryMetadata.repo:ancestors", value: "/content/dam" }],
    limit: 100,
    cursor
  });
  allDamAssets.push(...(r.body.results || []));
  cursor = r.body.cursor;
  pages++;
} while (cursor && pages < 25);

const relatedAssets = [];
for (const a of allDamAssets) {
  const path = a.repositoryMetadata?.['repo:path'];
  if (!path || path === srcPath) continue;
  const meta = a.assetMetadata || {};
  const gIds = toArray(meta['xdm:faceGroupIds']);
  const labels = toArray(meta['xdm:faceLabels'] || meta['xdm:faceNames']);
  const sharedPeople = [];
  gIds.forEach((gId, idx) => {
    if (targetGroupSet.has(gId)) {
      sharedPeople.push(labels[idx] || labelByGroupId[gId] || gId);
    }
  });
  if (sharedPeople.length > 0) {
    relatedAssets.push({
      name: a.repositoryMetadata['repo:name'],
      path,
      sharedPeopleCount: sharedPeople.length,
      sharedPeople,
      allFacesLeftToRight: labels,
      totalFacesOnAsset: Number(meta['xdm:faceCount'] || labels.length)
    });
  }
}

relatedAssets.sort((a, b) => b.sharedPeopleCount - a.sharedPeopleCount || a.path.localeCompare(b.path));

return {
  sourceAsset: {
    name: SOURCE_NAME,
    path: srcPath,
    scanned: srcMeta['xdm:faceCount'] !== undefined,
    faceCount: Number(srcMeta['xdm:faceCount'] || 0),
    facesLeftToRight: srcLabels
  },
  totalRelatedAssets: relatedAssets.length,
  relatedAssets
};
```

---

## Workflow 3: Find All Assets Containing a Specific Person (or Combination of People) or Triage Unnamed Faces

When the user asks *"Find all photos with Jill Jelly"*, *"Which photos have both Freddie Father and Belinda Baker?"*, or *"Which unnamed people appear in the most photos?"*:

```javascript
// Run in read-api with aemUrl = "https://author-p59602-e520244.adobeaemcloud.com"
const SEARCH_PEOPLE = ["Jill Jelly"]; // or leave empty [] to rank all people across the DAM
const REQUIRE_ALL = false;            // true = must contain ALL listed people together
const toArray = (v) => Array.isArray(v) ? v : (v ? [v] : []);

const allDamAssets = [];
let cursor = null, pages = 0;
do {
  const r = await aem.post('/adobe/experimental/aemmcpserver-expires-20991231/search-assets', {
    termFilters: [{ key: "repositoryMetadata.repo:ancestors", value: "/content/dam" }],
    limit: 100,
    cursor
  });
  allDamAssets.push(...(r.body.results || []));
  cursor = r.body.cursor;
  pages++;
} while (cursor && pages < 25);

const roster = {};
const matchingAssets = [];

for (const a of allDamAssets) {
  const meta = a.assetMetadata || {};
  if (meta['xdm:faceCount'] === undefined) continue;
  const labels = toArray(meta['xdm:faceLabels'] || meta['xdm:faceNames']);
  const name = a.repositoryMetadata?.['repo:name'];
  const path = a.repositoryMetadata?.['repo:path'];

  for (const label of labels) {
    if (!roster[label]) roster[label] = { person: label, isNamed: !label.startsWith('Person #'), count: 0, sampleAssets: [] };
    roster[label].count++;
    if (roster[label].sampleAssets.length < 5) roster[label].sampleAssets.push(path);
  }

  if (SEARCH_PEOPLE.length > 0) {
    const matched = SEARCH_PEOPLE.filter(q =>
      labels.some(l => l.toLowerCase().includes(q.toLowerCase()))
    );
    if ((REQUIRE_ALL && matched.length === SEARCH_PEOPLE.length) || (!REQUIRE_ALL && matched.length > 0)) {
      matchingAssets.push({ name, path, matchedPeople: matched, facesLeftToRight: labels });
    }
  }
}

return {
  matchingAssets,
  topPeople: Object.values(roster).sort((a, b) => b.count - a.count).slice(0, 30)
};
```

---

## Workflow 4: Scanning Unscanned Assets or Renaming / Combining / Splitting Face Groups

1. **In the AEM Assets View UI (when inside the Coworker cloud sandbox)**:
   - **To scan a folder**: Click **Face Groups** in the top header bar → click **Scan Current Folder** (automatically skips already-scanned images at zero AWS cost), or select assets/folders and click **Recognize Faces** in the action bar.
   - **To scan or curate a single asset**: Open the asset and click the **Recognized Faces** icon in the right rail to view cropped face avatars, highlight bounding boxes, **Name / Rename** a person, **Split Face**, or **Combine Into...** another group.
2. **In a Local Terminal / OpenCode Session (where `/Users/pnam/Sandbox/aemfacerec/.env` is present)**:
   Run the bundled CLI helper `scripts/facerec_cli.mjs`:
   ```bash
   node /Users/pnam/Sandbox/aemfacerec/skills/aem-face-recognition/scripts/facerec_cli.mjs check-instance
   node /Users/pnam/Sandbox/aemfacerec/skills/aem-face-recognition/scripts/facerec_cli.mjs scan-folder "<folder-url-or-path>"
   node /Users/pnam/Sandbox/aemfacerec/skills/aem-face-recognition/scripts/facerec_cli.mjs scan-asset "<asset-url-or-path>"
   node /Users/pnam/Sandbox/aemfacerec/skills/aem-face-recognition/scripts/facerec_cli.mjs related-assets "<asset-url-or-path>"
   node /Users/pnam/Sandbox/aemfacerec/skills/aem-face-recognition/scripts/facerec_cli.mjs name-faces-ltr "<asset-url-or-path>" "Name 1" "Name 2"
   node /Users/pnam/Sandbox/aemfacerec/skills/aem-face-recognition/scripts/facerec_cli.mjs rename "Person #38" "Elena Rostova"
   node /Users/pnam/Sandbox/aemfacerec/skills/aem-face-recognition/scripts/facerec_cli.mjs combine "Person #70" "Elena Rostova"
   ```
