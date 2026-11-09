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
3. **Single-Pass `160x160` Face Avatar Cropping**:
   - Reuses the downloaded AEM web rendition buffer in memory with `sharp` to crop padded `160x160` square portrait avatars for every detected face and stores them in `@adobe/aio-lib-files`.
4. **Assets View Details Side Panel (`aem/assets/details/1`)**:
   - Displays cropped face avatars for all people detected in the currently open asset.
   - Interactive bounding-box overlay preview showing which avatar corresponds to which person in multi-person photos.
   - Allows naming a person, splitting a mis-grouped face into its own group, or reassigning a face to another group directly from the asset.
5. **Face Management & Settings Console (Admin UI)**:
   - Manage all recognized Face Groups (Named People & Unnamed Placeholders like `Person #12`).
   - **Name / Rename** a face group.
   - **Remove / Split** one or more faces out of a group into a new standalone group.
   - **Combine / Merge** a face or an entire face group into another group.
   - **Settings Tab**: Configure customer's AWS Rekognition API credentials, Collection ID, similarity threshold, Processing Profile name, enabled folders, target metadata property (`xdm:faceNames`), and the toggle to **show or hide unnamed placeholder labels** (`Person #N`) in AEM asset metadata.
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
└── src/
    └── aem-assets-details-1/
        ├── ext.config.yaml             # Extension point manifest (aem/assets/details/1)
        ├── actions/
        │   ├── lib/
        │   │   ├── storage.js          # Persistent state & avatar storage (@adobe/aio-lib-files)
        │   │   ├── rekognition.js      # AWS Rekognition SDK v3 client (Collections, Users, Faces)
        │   │   ├── cropper.js          # Padded 160x160 face avatar cropper (sharp)
        │   │   ├── aem.js              # AEM Assets HTTP API & Processing Profile inspector
        │   │   └── face-service.js     # Core domain logic (ingest, split, merge, rename, sync)
        │   ├── ingest/
        │   │   └── index.js            # Runtime Action: I/O Event, Asset Compute & manual scan
        │   ├── groups/
        │   │   └── index.js            # Runtime Action: Face groups CRUD, split, merge & avatars
        │   └── settings/
        │       └── index.js            # Runtime Action: BYOK AWS config, folder rules & re-sync
        ├── web-src/
        │   ├── index.html              # SPA entry HTML
        │   └── src/
        │       ├── index.js            # React bootstrap
        │       ├── utils/
        │       │   └── api.js          # Frontend API client for App Builder Runtime actions
        │       └── components/
        │           ├── App.js                      # HashRouter (Extension Registration, Side Panel, Admin)
        │           ├── ExtensionRegistration.js    # Registers aem/assets/details/1 side panel
        │           ├── AssetDetailsSidePanel.js    # Side Panel UI with face avatars & bounding boxes
        │           └── AdminConsole.js             # Full-page Face Group Manager & BYOK Settings UI
        └── test/
            └── face-service.test.js    # Automated test suite for grouping, splitting, merging & metadata
```

---

## Data Model & Multi-Face Metadata Invariant

### AEM Asset Metadata (`jcr:content/metadata`)
| Property | JCR Type | Description |
| :--- | :--- | :--- |
| `xdm:faceNames` | `String[]` | Multi-value array of face group names on the asset (e.g., `["Sarah Jenkins", "Marcus Vance", "Person #12"]`). If `includeUnnamedInMetadata` is turned off in Settings, unnamed placeholder labels (`Person #12`) are omitted until named. |
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
