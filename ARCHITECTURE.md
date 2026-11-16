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
   - Fast-path load: reuses the pre-warmed IMS token (`tokenSavedAt`, 5-minute TTL) + `BroadcastChannel` asset context from `ExtensionRegistration.js` to fire `getAssetFaces` immediately on mount, while the backend checks `db/assets.json` (`getAssetsMap`) first and avoids reading `db/faces.json`/`db/groups.json` or calling AEM QueryBuilder when `assetPath` is already provided.
   - Displays cropped face avatars for all people detected in the currently open asset.
   - Interactive bounding-box overlay preview showing which avatar corresponds to which person in multi-person photos.
   - Allows naming a person, splitting a mis-grouped face into its own group, or reassigning a face to another group directly from the asset.
5. **Face Management & Settings Console (Admin UI)**:
   - Sticky top action bar keeping **Scan Current Folder**, **Include already-scanned images**, and **Close** (also dismissible via the **`Esc`** keyboard shortcut) pinned while scrolling.
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
├── TODO.md                             # Project roadmap (e.g. Adobe Coworker skill)
├── hooks/
│   ├── post-build.js                   # Rewrites index.html to /web-src.bundle.js & keeps legacy hash aliases
│   └── post-deploy.js                  # Prints AEM Assets View developer preview URL
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
| `xdm:persona` | `String[]` | Optional secondary multi-value property (enabled by default via `enableSecondaryMetadataProperty`, configurable in Settings) that receives the exact same array of face names. `xdm:persona` (**Xdm Persona**) is pre-indexed out-of-the-box in AEM as a Cloud Service's Searchable Property Index (`/adobe/repository?resource=searchableproperties`) so it appears directly in the AEM Assets View Search Filter dropdown. |
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

---

## Video Asset Facial Recognition & Timestamp Deep-Linking Architecture

This section documents the architecture for extending `aemfacerec` from static raster images (`image/*`) to **video assets (`video/mp4`, `video/quicktime`, `video/webm`, `video/x-msvideo`, `video/x-matroska`)** with scene-change keyframe extraction, temporal face deduplication, AEM metadata sync, and frame-accurate timestamp deep-linking across AEM Assets View, Dynamic Media, and the Adobe Coworker `aem-face-recognition` skill.

---

### 1. End-to-End System Flow

```text
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                          AEM as a Cloud Service (Author + Blob CDN)                      │
│  • Video Asset (/content/dam/.../clip.mp4)                                               │
│  • Renditions: mobile.mp4 (~3 MB, 480p/720p), cq5dam.web.1280.1280.jpeg, original        │
│  • Direct Binary Access: 302 / R-API presigned Azure Blob URL (HTTP 206 Range + CORS *)  │
└───────────────┬──────────────────────────────────────────────────────┬───────────────────┘
                │ 1. Resolve Presigned Stream URL                      │ 6. Sync JCR Metadata
                │    (mobile.mp4 preferred over original)              │    • xdm:faceNames / xdm:persona
                ▼                                                      │    • xdm:faceLabels / xdm:faceGroupIds
┌───────────────────────────────────────────────────────┐              │    • xdm:faceTimestamps ("Name@t1,t2")
│      Shot-Boundary & Keyframe Extraction Layer        │              │    • xdm:faceTimelineJson (shots + boxes)
│                                                       │              │
│  Path A (UI / Interactive Scan — Primary):            │              │
│  • Browser <video> + Offscreen <canvas>               │              │
│  • 64×36 Luma SAD Shot Detector + Clamped Offset      │              │
│  • Emits JPEG frames + timestampSec + shotRangeSec    │              │
│                                                       │              │
│  Path B (Headless Webhook / CLI / Fallback):          │              │
│  • Two-pass FFmpeg (scdet -> HTTP Range -ss seek)     │              │
│  • Tier-0 fallback: cq5dam.web.1280.1280.jpeg (t=0s)  │              │
└───────────────┬───────────────────────────────────────┘              │
                │ 2. Extracted Keyframes                               │
                │    [{ frameIndex, timestampSec, shotRangeSec, jpeg }]│
                ▼                                                      │
┌──────────────────────────────────────────────────────────────────────┴───────────────────┐
│                 App Builder Runtime: face-service.js (ingestVideoFrames)                 │
│                                                                                          │
│  3. Per-Frame AWS Rekognition Indexing & Pure-JS 72×72 Avatar Cropping:                  │
│     • Calls rekognition.indexAssetFaces() & rekognition.findMatchingGroup() per frame    │
│     • Crops 72×72 JPEG avatar via cropper.js (jpeg-js)                                   │
│  4. Intra-Video Person Consolidation (Temporal Deduplication):                           │
│     • Collapses multiple keyframes of the same groupId within the same video into ONE    │
│       canonical face record (picking the highest-quality frame by frontality × area)     │
│     • Preserves all appearance timestamps (`timestampsSec[]`, `appearances[]` with       │
│       per-shot bounding boxes) and disassociates redundant intra-video vectors in AWS    │
│  5. Persists to @adobe/aio-lib-files (`db/faces.json`, `db/assets.json`, `avatars/*.jpg`)│
└───────────────┬──────────────────────────────────────────────────────┬───────────────────┘
                │                                                      │
                ▼                                                      ▼
┌───────────────────────────────────────────┐  ┌───────────────────────────────────────────┐
│   AEM Assets View UI (React Spectrum)     │  │   Adobe Coworker (`aem-face-recognition`) │
│  • Side Panel (`AssetDetailsSidePanel`):  │  │  • Reads `xdm:faceTimestamps` via         │
│    Inline <video> player + Bounding-Box   │  │    `search-assets` with zero extra calls  │
│    overlay + Clickable `0:14.5` pills     │  │  • Generates `#t=14.5` Assets View &      │
│  • Admin Console (`AdminConsole.js`):     │  │    direct MP4 media-fragment deep links   │
│    Video badge + `↗ 0:14` deep links      │  │                                           │
└───────────────────────────────────────────┘  └───────────────────────────────────────────┘
```

---

### 2. Research Spike Findings & Architectural Decisions

#### Spike 1: Scene-Change Frame (`t_cut`) vs. Delayed Offset (`t_cut + Δt`)
- **Finding**: Capturing the immediate scene-change frame (`t_cut`, Frame 0 of a new shot) produces the highest rate of missed detections and noisy embeddings due to:
  1. **Gradual Transitions (Cross-Dissolves, Fades, Wipes)**: Inter-frame difference (`scene` / `scdet`) crosses the threshold mid-transition, producing a 50/50 alpha-blended ghost frame or underexposed fade frame.
  2. **Cut-on-Action & Whip Pans**: Editors cut on movement; Frame 0 has peak motion blur across eyes, nose, and mouth, whereas camera and subject settle `0.4s–0.8s` (12–20 frames) after the cut.
  3. **Dialogue Pre-Laps (J/L-Cuts)**: Cuts often land 10–15 frames before the speaker turns toward the camera.
  4. **Codec GOP Transients**: Non-IDR cuts or VBR rate-control spikes cause elevated macroblocking on the first 1–3 frames after a high-complexity cut.
- **Why a Fixed `+1.5s` or `+2.0s` Offset Also Fails**: Fast commercial/montage cuts are often `0.4s–1.2s` long. A blind `+2.0s` delay overshoots into the *next* scene.
- **Architectural Decision — Shot-Clamped Offset + Long-Take Periodic Sampling**:
  For every detected shot boundary $[t_i, t_{i+1})$ with duration $d_i = t_{i+1} - t_i$:
  1. **Filter Flash Frames**: Discard micro-shots where $d_i < 0.20\text{s}$ (camera flashes, strobe frames).
  2. **Primary Shot Sample (`t_sample`)**:
     $$t_{\text{sample}} = t_i + \min\left(0.60\text{s},\; 0.45 \times d_i\right)$$
     - On normal/long shots ($d_i \ge 1.35\text{s}$), waits **`+0.60s`** after the cut so dissolves clear and subjects settle.
     - On rapid cuts ($0.20\text{s} \le d_i < 1.35\text{s}$), samples at **45% of the shot duration** (near the shot midpoint), guaranteeing it never bleeds into $t_{i+1}$.
  3. **Long-Take Periodic Fallback (`Δt_periodic = 4.0s`)**:
     - If a shot lasts longer than `5.0s` (e.g., a continuous interview, walk-and-talk, or pan where a second person enters mid-take), emit additional samples every `4.0s` ($t_{\text{sample}} + 4.0\text{s}, +8.0\text{s}, \dots$) up to $t_{i+1} - 0.50\text{s}$, capped at `maxVideoFrames` (default `24` frames per video).

#### Spike 2: AEM Video Renditions, Presigned Blob URLs & `HTTP 206` Streaming
Live testing against AEM as a Cloud Service (`author-p59602-e475952.adobeaemcloud.com`) verified:
1. **Use `mobile.mp4` Instead of `original` for Analysis & Preview**:
   - On AEMaaCS, a 43.9 MB `original` video (`two people mountain.mp4`) has an out-of-the-box `mobile.mp4` rendition that is only **3.2 MB** (`video/mp4`) alongside `cq5dam.web.1280.1280.jpeg` (`1280×675`, `46 KB`).
   - Preferring `mobile.mp4` reduces bandwidth and decode time by **~14×** while providing ample resolution for Rekognition `IndexFaces` and `72×72` avatar cropping.
2. **AEM Direct Binary Access (`aem-blob-ns-...`) Supports Unauthenticated `HTTP 206` Range Requests & `CORS: *`**:
   - AEM serves binary renditions via pre-signed Azure Blob SAS URLs (`https://author-p...-e....adobeaemcloud.com/aem-blob-ns-.../?sig=...&se=...&rsct=video%2Fmp4&rscd=attachment...&sp=r&sr=b`).
   - Live probe with `Range: bytes=0-1023` and `Accept-Encoding: identity` confirmed:
     - `HTTP 206 Partial Content` (`Content-Range: bytes 0-1023/43902342`, `Accept-Ranges: bytes`)
     - `Access-Control-Allow-Origin: *`
   - **Critical SAS Signature Invariant**: Never mutate `rscd=attachment` to `rscd=inline` or re-encode `%2B` in the query string after AEM signs the URL—`rscd` is part of Azure's canonical HMAC-SHA256 `StringToSign`, so altering it causes `403 AuthenticationFailed`. HTML5 `<video src="...">` elements ignore `Content-Disposition: attachment` and stream/scrub inline natively.
3. **Why Adobe I/O Runtime Needs a Dual-Engine Extractor**:
   - Standard `ffmpeg-static` binaries are ~80 MB uncompressed (~32–38 MB zipped), which breaches OpenWhisk's compressed action package limit and breaks under default `@adobe/aio-cli` webpack bundling.
   - Therefore, `aemfacerec` uses a **Hybrid Dual-Engine Extractor** that converges on a single `ingestVideoFrames` domain method in `face-service.js`:
     - **Engine 1 (Browser `<video>` + `<canvas>` Scene Extractor)**: Runs in the React SPA during interactive Side Panel or Admin Console scans with **0 KB** impact on Runtime action zips and hardware-accelerated H.264/HEVC decoding.
     - **Engine 2 (Server-Side FFmpeg via HTTP Range + Poster Fallback)**: Runs in Node.js for CLI / local / custom Runtime binary deployments (`ffmpeg` reading presigned URLs via HTTP `Range`), with automatic graceful fallback to AEM's `cq5dam.web.1280.1280.jpeg` video poster rendition (`t = 0.0s`) when running in an uncustomized Runtime container on background I/O Events.

#### Spike 3: Deep-Linking & Scrubbing to Timestamp `t` Across AEM Surfaces
| AEM Surface | Native `?t=` / `#t=` Support? | How `aemfacerec` Enables Instant Timestamp Scrubbing |
| :--- | :--- | :--- |
| **1. AEM Assets View (`experience.adobe.com`) + `aemfacerec` Side Panel** | Host player ignores URL `#t=`; **Supported natively by `aemfacerec`** | `buildAssetDetailUrl(assetPath, hostContext, fallbackHost, { timestampSec })` appends `?t=14.5` inside the hash route (`#/@tenant/assets/detail/<ns>_face-recognition-panel/content/dam/.../clip.mp4?t=14.5`) and broadcasts `pendingSeekTimestamp` via `STORAGE_KEY_CTX` / `BroadcastChannel`. `AssetDetailsSidePanel.js` mounts an inline `<video>` player with bounding-box overlay and seeks to `14.5s` on `loadedmetadata`! |
| **2. Direct MP4 Rendition / Delivery URLs** | **Yes (Native W3C Media Fragments `#t=`)** | Appending `#t=14.5` or `#t=14.5,18.2` to a progressive MP4 rendition URL (or Dynamic Media `/is/content/<company>/<video-encode>#t=14.5`) scrubs the browser's native HTML5 video player directly to `14.5s`. |
| **3. Dynamic Media HTML5 Video Viewer (`s7viewers.VideoViewer`)** | No URL param; **Yes via JS SDK `seek(ms)` or WebVTT Chapters** | Call `videoViewer.getComponent('videoPlayer').seek(timestampSec * 1000)` inside the `NOTF_DURATION` listener, or pass `&navigation=<chapters.vtt>` generated from the detected face timestamps. |
| **4. AEM Author Touch UI (`assetdetails.html`)** | No URL param | Manual jump via **Preview → Annotate → Jump (seconds)** or saved timeline annotations. |

---

### 3. Data Model Extensions (`storage.js`, `db/faces.json`, `db/assets.json` & AEM JCR Metadata)

#### A. Settings Schema Additions (`DEFAULT_SETTINGS` in `src/aem-assets-assetsview-1/actions/lib/storage.js`)
```javascript
{
  // Added video MIME types alongside image/* in allowedImageTypes (or allowedMediaTypes):
  allowedImageTypes: [
    'image/jpeg',
    'image/png',
    'image/tiff',
    'image/vnd.adobe.photoshop',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/bmp',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-m4v'
  ],
  // Video-specific cost & sampling guardrails:
  enableVideoFaceRecognition: true,
  videoSceneThreshold: 0.28,          // Normalized scene-change threshold (0.10 - 0.60)
  videoShotOffsetSec: 0.6,            // Clamped delay after scene cut (seconds)
  videoMaxSampleIntervalSec: 4.0,     // Periodic fallback sampling inside long takes (seconds)
  videoMaxFramesPerAsset: 24,         // Hard cap on Rekognition IndexFaces calls per video
  videoDedupeWindowSec: 0             // 0 = consolidate per person across entire video (1 face card per person with timestampsSec[])
}
```
*Note*: Update `MIME_TYPE_PATTERN` in `storage.js` from `/^image\/.../` to `/^(?:image|video)\/[a-z0-9][a-z0-9.+-]{0,99}$/` and `IMAGE_EXT_RE` in `ExtensionRegistration.js` / `aem.js` to recognize `.mp4`, `.mov`, `.webm`, `.m4v`, `.mkv`, `.avi`.

#### B. Per-Shot `faceId` Independence + View-Level Rollup (`buildAssetFacesView`)
In enterprise video workflows, if a spokesperson appears in 3 shots (`0:01.2`, `0:06.4`, `0:14.8`), one of those shots (e.g., `0:06.4`) might be a lookalike false positive that a curator needs to **split** into its own group without disturbing `0:01.2` and `0:14.8`.

Therefore, `ingestVideoFrames` and `buildAssetFacesView` separate **storage-level shot independence** from **view-level person rollup**:
1. **Storage Level (`db/faces.json` & Rekognition)**:
   - Adjacent frames within `< 0.45s` of the same continuous shot are deduplicated (keeping the sharpest frame).
   - Every **distinct shot** (`>= 0.45s` apart) keeps its own `faceId`, cropped `72×72` avatar, `timestampSec`, and Rekognition vector, linked to the person via `face.groupId`.
2. **View Level (`buildAssetFacesView` in `face-service.js` & `AssetDetailsSidePanel.js`)**:
   - Rolls multiple shots sharing the same `groupId` on a video into **one card per person** (using the highest-quality shot's `faceId` and avatar as the default cover).
   - Populates `appearances[]` (`[{ faceId, timestampSec, shotRangeSec, boundingBox, avatarDataUrl }]`) and `shotFaceIds[]` on the rolled-up card.
   - When a curator clicks a timestamp pill (`▶ 00:06.4`) in the Side Panel, the card previews that specific shot's cropped avatar and changes the action button to **`Split Shot (00:06.4)`**, allowing that single shot's `faceId` to be split or moved independently!

#### C. Extended `db/faces.json` Record Schema
```json
{
  "faceId": "a1b2c3d4-...",
  "groupId": "grp_cc233d4a...",
  "assetId": "e78284bd-b78c-4b6a-9e1d-4bef3a152f2a",
  "assetPath": "/content/dam/campaigns/summer-spot.mp4",
  "assetTitle": "summer-spot.mp4",
  "mediaType": "video",
  "boundingBox": { "left": 0.34, "top": 0.18, "width": 0.22, "height": 0.38 },
  "confidence": 99.6,
  "matchConfidence": 98.4,
  "bestFrameQualityScore": 47.82,
  "timestampSec": 4.2,
  "shotRangeSec": [3.6, 8.1],
  "timestampsSec": [4.2],
  "appearances": [
    {
      "faceId": "a1b2c3d4-...",
      "timestampSec": 4.2,
      "shotRangeSec": [3.6, 8.1],
      "boundingBox": { "left": 0.34, "top": 0.18, "width": 0.22, "height": 0.38 },
      "confidence": 99.6
    }
  ],
  "avatarFile": "tenants/org/avatars/a1b2c3d4-....jpg",
  "avatarStoredExternally": true,
  "createdAt": "2026-11-14T18:00:00.000Z"
}
```
*(Backward-compatible: for static images, `mediaType` is `'image'` and `timestampSec` / `appearances` are `null` / omitted.)*

#### D. Extended AEM Asset Metadata (`jcr:content/metadata`)
In addition to the existing `xdm:faceNames`, `xdm:persona`, `xdm:faceLabels`, `xdm:faceGroupIds`, and `xdm:faceCount` properties, video assets receive two temporal metadata properties written by `aemClient.updateAssetFaceMetadata` (no AEM Metadata Schema Form changes are required since JCR `nt:unstructured` stores them natively and the custom Side Panel + Coworker skill read them directly):

| Property | JCR Type | Example Value | Purpose |
| :--- | :--- | :--- | :--- |
| `xdm:faceTimestamps` | `String[]` | `["grp_cc233d4a@00:04.2,00:14.5", "grp_89f01b2c@00:09.8"]` | Multi-value array keyed by **immutable `groupId`** in 1-to-1 order with `xdm:faceGroupIds` / `xdm:faceLabels`. Keying by `groupId` ensures timestamp strings are immutable when a person is named/renamed, and returned automatically by AEM `search-assets` for the Coworker skill! |
| `xdm:faceTimelineJson` | `String` | `'[{"f":"a1b2","g":"grp_cc23","t":4.2,"s":[3.6,8.1],"b":[0.34,0.18,0.22,0.38]}]'` | Compact JSON timeline of per-shot `faceId` (`f`), `groupId` (`g`), timestamp (`t`), shot range (`s`), and bounding box (`b`) (capped `< 16 KB`). |

---

### 4. Component-by-Component Implementation Specification

#### A. AEM Client Video Extensions (`src/aem-assets-assetsview-1/actions/lib/aem.js`)
Add two methods to `createAemClient`:

1. **`resolveVideoStreamUrl(assetPath, { assetId } = {})`**:
   - Discovers the best playable MP4 rendition in priority order:
     1. `/_jcr_content/renditions/mobile.mp4`
     2. `/_jcr_content/renditions/cq5dam.video.iehq.mp4` / `cq5dam.video.hq.m4v`
     3. `/_jcr_content/renditions/original` (if `.mp4` / `.webm` / `.m4v`)
   - Issues an authenticated `GET` with `headers: { Range: 'bytes=0-0' }` and `redirect: 'manual'`:
     - **If AEM returns `301 | 302 | 303 | 307 | 308`**: Reads `res.headers.get('location')`, verifies the redirect host is `${baseUrl}` (`/aem-blob-ns-...`) or `*.blob.core.windows.net` / `*.adobeaemcloud.com`, and returns `{ streamUrl: location, renditionName, expiresInSec: 43200, supportsRange: true }` **verbatim** (without mutating `rscd` or percent-encoding).
     - **If Fastly swallows the redirect (`200` / `206`)**: Queries AEM's `/api/assets/<relPath>/renditions/<renditionName>.json` or `/adobe/assets/<urn>/renditions` to extract the presigned blob `href` if exposed, or returns the authenticated rendition URL.
2. **`fetchVideoPosterOrFrames(assetPath, settings)`**:
   - Used when `ingestAsset` is invoked headlessly on a `video/*` asset (e.g., via Adobe I/O Events webhook when no browser `frames[]` array was provided).
   - If a local/container `ffmpeg` binary is available (`process.env.FFMPEG_PATH` or `/tmp/ffmpeg`), executes the two-pass HTTP `Range` pipeline against the presigned `mobile.mp4` URL (see Section 4.B below).
   - Otherwise, falls back gracefully to `fetchAssetRenditionBuffer(assetPath)` (`cq5dam.web.1280.1280.jpeg`) as a single frame at `timestampSec: 0, shotStartSec: 0, extractionMode: 'poster-fallback'`, and marks `assetRecord.posterOnly = true` so the Side Panel UI can offer a 1-click **"Full Scene Scan"** button when a user opens the video.

#### B. Dual-Engine Scene Detector & Frame Extractor

##### Engine 1: Browser `<video>` + `<canvas>` Scene Extractor (`src/aem-assets-assetsview-1/web-src/src/utils/video-frame-extractor.js`)
Runs in the browser during interactive scans (`AssetDetailsSidePanel.js` & `AdminConsole.js`):
1. **Load Stream**: Creates an offscreen `<video muted playsInline preload="auto" crossOrigin="anonymous" src={streamUrl}>` and waits for `loadedmetadata` (`duration`, `videoWidth`, `videoHeight`).
2. **Pass 1 — Fast Coarse Luma-SAD Scene Scan**:
   - Steps through the video at coarse intervals ($\Delta t_{\text{probe}} = 0.25\text{s}$ for videos $\le 60\text{s}$, or $\max(0.25\text{s}, \text{duration} / 240)$ for longer videos).
   - Draws each frame onto a tiny **`64×36` offscreen `<canvas>`**, converts RGB to Luma ($Y = 0.299R + 0.587G + 0.114B$), and computes the normalized Mean Absolute Frame Difference ($\text{MAFD} \in [0, 1]$) + 16-bin histogram intersection against the previous step.
   - Identifies all scene-cut boundaries $T = [0, t_1, t_2, \dots, t_k, \text{duration}]$ where $\text{MAFD} > \text{videoSceneThreshold}$ (default `0.28`).
3. **Shot-Clamped Timestamp Selection**:
   - For each shot $[t_i, t_{i+1})$ with $d_i = t_{i+1} - t_i \ge 0.20\text{s}$:
     - Primary sample: $t_{\text{sample}} = t_i + \min(0.60, 0.45 \times d_i)$.
     - Additional periodic samples every `4.0s` if $d_i > 5.0\text{s}$.
   - Caps total sample timestamps at `videoMaxFramesPerAsset` (`24`).
4. **Pass 2 — High-Res Frame Capture (`<= 1280px` JPEG)**:
   - Seeks `<video>` to each $t_{\text{sample}}$ (or capturing inline during Pass 1 when probing hits $t_{\text{sample}}$), draws onto a `<= 1280×1280` `<canvas>`, checks Laplacian sharpness / non-black variance, and exports `canvas.toDataURL('image/jpeg', 0.84)` (~40–65 KB per frame).
5. **Chunked Upload to Runtime (`ingestVideoFrames`)**:
   - Sends frames in batches of `4` frames per HTTP POST (`< 300 KB` payload, well under Adobe I/O Runtime's `1 MB` action payload limit and `20s` timeout budget), reporting live progress (`"Analyzing scene 8 of 14 (00:18.4)..."`).

##### Engine 2: Server-Side FFmpeg Extractor (`src/aem-assets-assetsview-1/actions/lib/video-extractor.js`)
Used for CLI (`facerec_cli.mjs`), local Node, or Runtime containers with a minimal `ffmpeg` binary:
1. **Pass 1 — Shot Detection on Downscaled Stream**:
   ```bash
   ffmpeg -nostdin -nostats -i "<presignedMobileMp4Url>" \
     -vf "scale=-2:360,scdet=threshold=10.0:sc_pass=1,metadata=mode=print:file=-" \
     -an -f null -
   ```
   Parses `lavfi.scd.time` lines from stdout to build shot intervals $[t_i, t_{i+1})$ and computes $t_{\text{sample}} = t_i + \min(0.60, 0.45 \times d_i)$.
2. **Pass 2 — Fast Input-Side HTTP Range Seek per Shot**:
   ```bash
   ffmpeg -nostdin -ss <t_sample> -i "<presignedMobileMp4Url>" \
     -frames:v 1 \
     -vf "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease" \
     -q:v 3 -f image2pipe -vcodec mjpeg pipe:1
   ```
   Because `-ss` precedes `-i` on an HTTP `206`-capable URL, FFmpeg seeks via byte-range headers without downloading the full video to `/tmp`.

#### C. Domain Service (`ingestVideoFrames` in `src/aem-assets-assetsview-1/actions/lib/face-service.js`)
Add `ingestVideoFrames` (and extend `getAssetFaces` / `getGroup`) in `face-service.js`:
1. **Batch-Friendly Incremental Ingestion (`isFirstBatch` / `isFinalBatch`)**:
   - When the browser sends 20 scene frames in 5 batches of 4 frames:
     - Batch 1 (`resetExisting: true`, `syncMetadata: false`): Clears old faces on the video asset (`removeExistingAssetFaces`), indexes frames 1..4.
     - Batches 2..N-1 (`resetExisting: false`, `syncMetadata: false`): Indexes frames and merges into the asset's existing `db.faces` records (consolidating matching `groupId`s and appending new `appearances[]` / `timestampsSec[]`).
     - Final Batch (`resetExisting: false`, `syncMetadata: true`): Indexes the final frames, computes `xdm:faceNames`, `xdm:persona`, `xdm:faceLabels`, `xdm:faceGroupIds`, `xdm:faceTimestamps`, and `xdm:faceTimelineJson`, and calls `syncAssetsToAem`.
2. **Intra-Video Consolidation Logic**:
   - When a newly detected face on frame $k$ matches `assignedGroupId`, check if `assetRecord.faceIds` already has a `faceRecord` on this video with `faceRecord.groupId === assignedGroupId`:
     - **If yes**:
       - Append `{ timestampSec, shotRangeSec, boundingBox, confidence }` to `existingFace.appearances` (sorted ascending by `timestampSec`, deduplicating timestamps within `0.8s` of each other).
       - Update `existingFace.timestampsSec = existingFace.appearances.map(a => a.timestampSec)`.
       - Compare quality score ($Q = \text{confidence} \times \sqrt{w \times h}$): if the new frame is higher quality, replace `existingFace.avatarFile` / `boundingBox` / `timestampSec` with the sharper frame's crop; otherwise keep the existing avatar.
       - Call `rekognition.deleteFaces([newDetectedFaceId])` immediately so only 1 vector per person per video remains in the Rekognition collection.
     - **If no**:
       - Create the new `db.faces[faceId]` record with `mediaType: 'video'`, `timestampSec`, `shotRangeSec`, `timestampsSec: [timestampSec]`, and `appearances: [{ timestampSec, shotRangeSec, boundingBox, confidence }]`.

#### D. UI Enhancements (`AssetDetailsSidePanel.js` & `AdminConsole.js`)

##### 1. `AssetDetailsSidePanel.js` (Interactive Video Scrubber + Bounding Box Overlay)
- **Auto-Detect Video Assets**: When `assetData.mediaType === 'video'` or `hostContext.assetPath` ends with `.mp4|.mov|.webm|.m4v`:
  - Fetch the presigned `videoStreamUrl` via `api.getVideoStreamUrl({ assetPath, assetId }, hostContext)`.
  - Replace the static `150px` gradient locator box at the top of the side panel with an **Interactive Video & Bounding-Box Stage**:
    - Renders `<video ref={videoRef} src={videoStreamUrl} controls playsInline preload="metadata" onTimeUpdate={...} />`.
    - Overlays the SVG/div bounding boxes for any `face.appearances` whose `shotRangeSec[0] <= currentTime <= shotRangeSec[1]` (or within `±1.0s` of `timestampSec` when paused after clicking a timestamp chip).
  - **Clickable Timestamp Pills on Every Face Card**:
    - Below `"Appears in X shot(s) in this video"`, render clickable timecode pills (`▶ 0:04.2`, `▶ 0:14.5`, `▶ 0:27.8`).
    - Clicking a pill calls:
      ```javascript
      videoRef.current.currentTime = app.timestampSec;
      videoRef.current.pause(); // or play() based on user toggle, showing the exact frame + bounding box!
      setActiveAppearance({ faceId: face.faceId, ...app });
      ```
  - **Deep-Link Auto-Seek on Mount**:
    - Reads `?t=<seconds>` from `window.location.hash` or `pendingSeekTimestamp` from `localStorage.getItem(STORAGE_KEY_CTX)` / `BroadcastChannel`.
    - When `<video onLoadedMetadata>` fires, automatically sets `videoRef.current.currentTime = initialTimestampSec` and highlights the corresponding face card.

##### 2. `AdminConsole.js` (Timestamp Badges & Deep-Links to Video Frame)
- In the **Faces in this Group** grid (`activeGroup.faces`):
  - If `face.mediaType === 'video'` (or `face.timestampsSec?.length > 0`), display a compact video badge (`🎬 0:04, 0:14`) on the face card.
  - Enhance `buildAssetDetailUrl(face.assetPath, hostContext, serverAemHost, { timestampSec: face.timestampSec })`:
    - Appends `?t=${face.timestampSec}` to the hash route:
      `https://experience.adobe.com/?repoId=...#/@tenant/assets/detail/<ns>_face-recognition-panel/content/dam/.../clip.mp4?t=4.2`
    - Also writes `{ pendingSeekAssetPath: face.assetPath, pendingSeekTimestamp: face.timestampSec, savedAt: Date.now() }` to `localStorage` (`STORAGE_KEY_CTX`) on click so even if the Experience Cloud Shell strips query params from the hash route during navigation, `AssetDetailsSidePanel.js` picks up `pendingSeekTimestamp` from `localStorage` and scrubs straight to `0:04.2`!

#### E. Coworker Skill Update (`skills/aem-face-recognition/SKILL.md`)
- Update **Workflow 1 (Folder Inspection)**, **Workflow 2 (Single Asset Inspection)**, and **Workflow 3 (Find Person Across DAM)** in `SKILL.md`:
  - Remove the `image/`-only filter (`.filter(a => /^(image|video)\//.test(a.repositoryMetadata?.['dc:format'] || ''))`).
  - Read `a.assetMetadata['xdm:faceTimestamps']` (e.g. `["Jill Jelly@00:04.2,00:14.5"]`).
  - Format video results with clickable timestamp deep links:
    - **AEM Assets View Deep Link**: `[summer-spot.mp4 (0:04.2)](https://experience.adobe.com/?repoId=...#/assets/detail/content/dam/.../summer-spot.mp4?t=4.2)`
    - **Direct Browser Media-Fragment Scrub Link**: `[Scrub to 0:04.2](https://author-p...-e....adobeaemcloud.com/content/dam/.../summer-spot.mp4/_jcr_content/renditions/mobile.mp4#t=4.2)`

---

### 5. Security, Cost & Scale Guardrails for Video

| Guardrail ID | Threat / Risk | Mitigation in Architecture |
| :--- | :--- | :--- |
| **`V1` (Rekognition API Cost Cap)** | A 30-minute raw B-roll video with 400 cuts could trigger 400 `IndexFaces` calls ($0.40/video) and exceed action timeouts. | Enforce `settings.videoMaxFramesPerAsset` (default `24` frames, max `60`). If a video has `> 24` shots, rank shots by duration $d_i$ and sample the top 24 longest shots. |
| **`V2` (Collection Vector Bloat)** | Indexing 24 frames where the same actor appears in 20 shots would store 20 duplicate face vectors for 1 asset. | Intra-video consolidation in `ingestVideoFrames` keeps only the **1 highest-quality vector per person per video** in Rekognition and immediately calls `DeleteFaces` on intra-video duplicates while storing all 20 timestamps in `appearances[]`. |
| **`V3` (Runtime 1 MB Payload & 60s Timeout)** | Sending 24 decoded frames or a 50 MB MP4 in one HTTP POST fails with `413 Payload Too Large` or `504 Gateway Timeout`. | Browser extractor sends compact `<= 1280px` JPEG frames (`~45 KB` each) in chunked batches of `4` frames (`~250 KB/request`), using the same proven client batching pattern as `scanFolder`. |
| **`V4` (SSRF & Credential Leakage on 302 Redirects)** | Following an untrusted `302 Location` header could leak the AEM `Authorization: Bearer` token to an external host (`S2`). | `resolveVideoStreamUrl` uses `redirect: 'manual'`, never forwards `Authorization` headers to the redirect target, and validates that the `Location` host matches the bound AEM author host or Azure Blob storage (`*.blob.core.windows.net`). |
| **`V5` (JCR Metadata Size Bound)** | A long video with hundreds of detections could create an oversized `xdm:faceTimelineJson` property in Oak. | `xdm:faceTimestamps` stores at most 12 formatted timestamps per person (`"Name@00:04.2,00:14.5,..."`), and `xdm:faceTimelineJson` rounds coordinates to 3 decimals and caps at `16 KB`. |

---

### 6. Phased Implementation Roadmap

- [ ] **Phase 1 — Storage, Settings & AEM Video Stream Resolution (`storage.js`, `security.js`, `aem.js`)**:
  - Add video MIME types (`video/mp4`, `video/quicktime`, `video/webm`, `video/x-m4v`) and video sampling settings (`videoSceneThreshold`, `videoShotOffsetSec`, `videoMaxSampleIntervalSec`, `videoMaxFramesPerAsset`) to `DEFAULT_SETTINGS`.
  - Implement `aemClient.resolveVideoStreamUrl(assetPath)` with `mobile.mp4` priority and presigned `Location` / download URL resolution.
  - Extend `aemClient.updateAssetFaceMetadata` to write `xdm:faceTimestamps` (`String[]`) and `xdm:faceTimelineJson` (`String`).
- [ ] **Phase 2 — Multi-Frame Video Ingestion & Temporal Consolidation (`face-service.js` & `actions/ingest/index.js`)**:
  - Implement `faceService.ingestVideoFrames` with intra-video person deduplication, quality-ranked avatar selection, `appearances[]` / `timestampsSec[]` tracking, and `computeAssetFaceMetadata` support for `faceTimestamps`.
  - Expose `operation: 'getVideoStreamUrl'` and `operation: 'ingestVideoFrames'` in `actions/ingest/index.js` and `actions/groups/index.js`.
- [ ] **Phase 3 — Browser `<video>` + `<canvas>` Scene Extractor & Server FFmpeg Extractor (`video-frame-extractor.js` & `video-extractor.js`)**:
  - Build the client-side two-pass Luma-SAD shot detector + clamped `+0.60s` offset frame sampler in `web-src/src/utils/video-frame-extractor.js`.
  - Build the server-side `scdet` + HTTP `Range` `-ss` FFmpeg helper in `actions/lib/video-extractor.js` (with `cq5dam.web.1280.1280.jpeg` poster fallback when FFmpeg is absent).
- [ ] **Phase 4 — Interactive Video Scrubber UI (`AssetDetailsSidePanel.js` & `AdminConsole.js`)**:
  - Add the inline `<video>` player with synchronized shot bounding-box overlay and clickable `▶ 0:14.5` timestamp pills in `AssetDetailsSidePanel.js`.
  - Add video timestamp badges and `?t=` + `STORAGE_KEY_CTX` deep-link auto-seeking in `AdminConsole.js`.
- [ ] **Phase 5 — Coworker Skill & Automated Tests (`SKILL.md` & `test/video-faces.test.js`)**:
  - Update `skills/aem-face-recognition/SKILL.md` to surface `xdm:faceTimestamps` and timestamped links for video assets.
  - Add unit and integration tests covering clamped shot offset math, intra-video person consolidation, `xdm:faceTimestamps` metadata sync, presigned `302` stream URL resolution, and UI timestamp scrubbing.
