# AEM Assets View — Facial Recognition & Grouping Extension (App Builder + AWS Rekognition)

## Overview

This Adobe Developer App Builder application extends **AEM as a Cloud Service (Assets View)** with automated facial detection, vector clustering, face avatar cropping, and human-in-the-loop face group management powered by a customer's own **AWS Rekognition** account (BYOK).

### Key Capabilities
1. **Processing Profile & Folder-Scoped Ingestion**:
   - Triggered automatically via **Adobe I/O Events** (`aem.assets.asset.processing_completed`) or an **Asset Compute Worker** when an image is uploaded to a DAM folder where the **Face Recognition Processing Profile** is applied (or matches an enabled folder path prefix).
   - Also supports on-demand scanning of individual assets or entire DAM folders from the Admin UI or Side Panel.
2. **AWS Rekognition Vector Indexing & Auto-Grouping**:
   - Indexes all faces in an asset in a single call (`IndexFaces`).
   - Uses Rekognition `Users` (`SearchUsers`, `CreateUser`, `AssociateFaces`, `DisassociateFaces`, `DeleteUser`) + `SearchFaces` fallback to automatically cluster faces of the same person across assets.
3. **Single-Pass `72×72` Pure-JS Face Avatar Cropping**:
   - Reuses the downloaded AEM web rendition buffer in memory with pure JavaScript (`jpeg-js` + `pngjs`, zero native C++ binary dependencies) to crop padded `72×72` square portrait avatars for every detected face and stores them in `@adobe/aio-lib-files`.
   - Also sniffs JPEG/PNG header dimensions before calling AWS so small images (`< minImageSize`, default `200px`, e.g. logos/icons) are skipped at zero AWS cost.
4. **Assets View Details Side Panel (`aem/assets/assetsview/1`)**:
   - Displays cropped face avatars for all people detected in the currently open asset.
   - Interactive bounding-box overlay preview showing which avatar corresponds to which person in multi-person photos.
   - Allows naming a person, splitting a mis-grouped face into its own group, or reassigning a face to another group directly from the asset.
5. **Face Management & Settings Console (Admin UI)**:
   - Sticky top action bar keeping **Scan Current Folder**, **Include already-scanned images**, and **Close** pinned while scrolling.
   - Server-paged Face Groups grid (60 per page) with server-side search and Named/Unnamed filtering.
   - **Name / Rename** a face group, or permanently **Delete Group** (removes vectors from AWS Rekognition, deletes avatars, and updates AEM metadata).
   - **Remove / Split** one or more faces out of a group into a new standalone group.
   - **Combine / Merge** a face or an entire face group into another group using dropdown pickers with circular `22×22` face avatar thumbnails.
   - Direct **new-tab deep links** (`↗`) next to each face's filename under *Faces in this Group* opening the asset in AEM Assets View (`experience.adobe.com`).
   - **Role-Based Governance & Curator Groups**: The **Settings Tab** is visible and accessible only to AEM Administrators (`administrators` / `dam-administrators`). Admins can also toggle **Restrict group management to Administrators & Curator Groups** and specify custom AEM user groups (`curatorGroups`, e.g. `face-curators`) so regular DAM users get a read-only view while curators can manage groups.
   - **Settings Tab**: Configure customer's AWS Rekognition API credentials, Collection ID, similarity threshold, Processing Profile name (via a dropdown populated from `/conf/global/settings/dam/processing`), enabled folders, AWS cost controls (`allowedImageTypes`, `minImageSize`), curator role permissions, target metadata property (`xdm:faceNames`), and the toggle to **show or hide unnamed placeholder labels** (`Person #N`) in AEM asset metadata.
6. **Multi-Face AEM Metadata Sync (`xdm:faceNames`)**:
   - Automatically computes and writes deduplicated multi-value `String[]` metadata (`xdm:faceNames`, `xdm:faceGroupIds`, `xdm:faceCount`) to `jcr:content/metadata` on every affected AEM asset whenever faces are ingested, named, split, or merged.

---

## Project Structure

```text
aemfacerec/
├── app.config.yaml                     # App Builder root configuration
├── package.json                        # Dependencies & scripts
├── .env.example                        # Environment variable template
├── ARCHITECTURE.md                     # Technical architecture & data model
├── SECURITY_AUDIT.md                   # Enterprise security, robustness & scale audit
└── src/
    └── aem-assets-assetsview-1/
        ├── ext.config.yaml             # Extension point manifest (aem/assets/assetsview/1)
        ├── actions/
        │   ├── lib/
        │   │   ├── security.js         # Host allowlist, DAM path & metadata validation, safe errors
        │   │   ├── action-context.js   # Per-invocation auth/host context (no process.env mutation)
        │   │   ├── retry.js            # Exponential backoff + jitter & bounded concurrency
        │   │   ├── storage.js          # Persistent state & avatar storage (@adobe/aio-lib-files)
        │   │   ├── rekognition.js      # AWS Rekognition SDK v3 client (Collections, Users, Faces)
        │   │   ├── cropper.js          # Pure-JS 72x72 face avatar cropper + header dimension sniffer
        │   │   ├── aem.js              # AEM Assets HTTP API, paged folder browser & profile inspector
        │   │   └── face-service.js     # Core domain logic (ingest, split, merge, rename, paged queries)
        │   ├── ingest/
        │   │   └── index.js            # Runtime Action: manual scan, folder scan & I/O Events
        │   ├── groups/
        │   │   └── index.js            # Runtime Action: paged face groups CRUD, split, merge
        │   └── settings/
        │       └── index.js            # Runtime Action: BYOK AWS config, cost controls & re-sync
        ├── web-src/
        │   ├── index.html              # SPA entry HTML
        │   └── src/
        │       ├── index.js            # React bootstrap
        │       ├── utils/
        │       │   └── api.js          # Frontend API client for App Builder Runtime actions
        │       └── components/
        │           ├── App.js                      # HashRouter (Extension Registration, Side Panel, Admin)
        │           ├── ExtensionRegistration.js    # Registers aem/assets/assetsview/1 side panel & action bar
        │           ├── AssetDetailsSidePanel.js    # Side Panel UI with face avatars & bounding boxes
        │           └── AdminConsole.js             # Paged Face Group Manager, Folder Scanner & Settings UI
        └── test/
            ├── face-service.test.js         # Core grouping, splitting, merging & metadata tests
            ├── security.test.js             # Auth, SSRF, path/property validation & storage fail-safes
            ├── robustness.test.js           # Retries, throttling, ingest failure ordering & image caps
            ├── paging.test.js               # 1 MB response budget, server paging/search/filter
            ├── cost.test.js                 # Skip already-scanned, MIME allowlist & min image dimensions
            ├── folder-and-asset-id.test.js  # DAM folder pagination (>200 items) & canonical asset IDs
            ├── concurrency-and-jobs.test.js # Distributed lock, record-level merge, event dedupe & R14
            ├── privacy-and-oauth.test.js    # Per-person erasure (deleteGroup), clearAllData & OAuth S2S
            ├── ui-api.test.js               # Client banner & folder-scan batching tests
            └── ui-admin-console.test.js     # End-to-end jsdom UI tests against real Runtime actions
```

---

## Data Model & Multi-Face Metadata Invariant

### AEM Asset Metadata (`jcr:content/metadata`)
| Property | JCR Type | Description |
| :--- | :--- | :--- |
| `xdm:faceNames` | `String[]` | Multi-value array of face group names on the asset (e.g., `["Sarah Jenkins", "Marcus Vance", "Person #12"]`). If `includeUnnamedInMetadata` is turned off in Settings, unnamed placeholder labels (`Person #12`) are omitted until named. |
| `iptc4xmpExt:PersonInImage` | `String[]` | Optional secondary multi-value property (enabled by default via `enableSecondaryMetadataProperty`, configurable in Settings) that receives the exact same array of face names for standard IPTC Person Shown & AEM Search Filter Rail compatibility. |
| `xdm:faceGroupIds` | `String[]` | Multi-value array of internal group IDs on the asset (e.g., `["grp_a1b2c3d4", "grp_e5f6g7h8"]`). |
| `xdm:faceCount` | `Long` | Total number of faces detected on the asset. |

### The `syncAssetMetadata(assetId)` Invariant
Because a single AEM asset can contain multiple faces (and potentially even multiple detections mapped to the same group before or after a merge/split), we **never** mutate `xdm:faceNames` by naively appending or removing a single string. Instead, on every operation (ingest, rename, split, merge, delete, or toggling `includeUnnamedInMetadata`), `syncAssetMetadata(assetId)` recomputes the asset's metadata from the ground truth:

```javascript
const assetFaces = assetRecord.faceIds.map(id => faces[id]).filter(Boolean);
const groupsOnAsset = assetFaces.map(f => groups[f.groupId]).filter(Boolean);

const faceNames = Array.from(new Set(
  groupsOnAsset
    .map(g => g.name ? g.name.trim() : (settings.includeUnnamedInMetadata ? g.autoLabel : null))
    .filter(Boolean)
));
```

This guarantees that `xdm:faceNames` on the AEM asset is always 100% consistent.
