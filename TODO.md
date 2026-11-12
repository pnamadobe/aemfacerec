# Project TODOs & Implementation Plans

## 1. Write an Adobe Coworker Skill (`aem-face-recognition`) — ✅ Completed
- [x] Created and installed the `aem-face-recognition` skill (`skills/aem-face-recognition/SKILL.md`, `~/.config/opencode/skills/aem-face-recognition/SKILL.md`, and `~/.claude/skills/aem-face-recognition/SKILL.md`) along with `facerec_cli.mjs`.
- [x] Synced left-to-right `xdm:faceLabels` and `xdm:faceGroupIds` to AEM `jcr:content/metadata` across all indexed assets so Coworker's native `read-api` (`search-assets`) can list faces per asset in a folder, inspect single assets, and find co-appearing assets via indexed `assetMetadata.xdm:persona` + `xdm:faceGroupIds` with zero local CLI dependencies.
- [x] Added dynamic AEM Assets View `detailUrl` deep links (using `repo:repositoryId` and dynamic tenant resolution, with no hardcoded tenant/host).

---

## 2. Plan: Search DAM Assets by Uploaded Face Photo ("Is this person in AEM Assets?")

### Goal
Allow a user to upload or provide an external photo of a person (e.g., a talent headshot, press photo, or multi-person reference shot) in **Adobe Coworker** (or the **Face Groups Admin Console UI**) and find:
1. Whether the person(s) in the uploaded photo match any existing Face Group (`Named` or `Unnamed Person #N`) in the Rekognition Collection.
2. Every scanned AEM DAM asset where the matched person(s) appear, ranked by match confidence and number of shared people, with clickable AEM Assets View deep links.

---

### Architectural Design

#### A. AWS Rekognition Layer (`src/aem-assets-assetsview-1/actions/lib/rekognition.js`)
1. **Stateless Ephemeral Matching (Zero Biometric Retention for Query Photos)**:
   - Unlike `IndexFaces` (which permanently stores vectors in the Rekognition Collection), query-by-photo must be **100% read-only / stateless** so uploaded query photos never pollute the collection or leave orphaned vectors.
2. **Single-Face vs. Multi-Face Query Photo Handling**:
   - **Important Rekognition Quirk**: AWS Rekognition's `SearchUsersByImageCommand` and `SearchFacesByImageCommand` only analyze the **single largest face** in the input image buffer and ignore any other faces in the photo.
   - **Fast Path (Single-Face Portrait — default)**:
     1. Call `SearchUsersByImageCommand({ CollectionId, Image: { Bytes: buffer }, MaxUsers: 5, UserMatchThreshold: similarityThreshold })`.
     2. Also call `SearchFacesByImageCommand({ CollectionId, Image: { Bytes: buffer }, MaxFaces: 10, FaceMatchThreshold: similarityThreshold })` in parallel (or as fallback when a newly created single-face `User` vector is still indexing in Rekognition), resolving matched `FaceId`s to their `groupId` in `db.faces`.
     3. Return the best matching `groupId`(s), `similarity` (`0–100%`), and the detected `SearchedFaceBoundingBox`.
   - **Multi-Face Query Mode (`detectAllFaces: true`)**:
     1. If the user uploads a group photo and asks *"Are any of the people in this photo in our DAM?"*, first call `DetectFacesCommand({ Image: { Bytes: buffer } })` (or inspect if multiple faces exist).
     2. If `> 1` face is detected, reuse our pure-JS `cropper.js` (`decodeImageBuffer` + padded crop per `BoundingBox`) in memory to crop each detected face (sorted left-to-right by `BoundingBox.Left`) and run `SearchUsersByImage` + `SearchFacesByImage` for each cropped face concurrently (`mapWithConcurrency`, max 4).
3. **IAM Policy Update (`README.md` & `SETUP.md`)**:
   - Document adding `rekognition:SearchUsersByImage`, `rekognition:SearchFacesByImage`, and (optional for multi-face queries) `rekognition:DetectFaces` to the customer BYOK IAM policy.

---

#### B. Domain & Runtime Action Layer (`face-service.js` & `actions/groups/index.js`)
Add operation **`searchFacesByImage`** to `face-service.js` and `actions/groups/index.js`:

- **Accepted Inputs**:
  - `imageBase64`: Base64-encoded JPEG/PNG bytes (or `data:image/...;base64,...` data URL) of the uploaded photo.
  - `assetPath` / `assetId`: *(Alternative)* If the query image was uploaded to AEM DAM, fetch its rendition buffer directly via `aemClient.fetchAssetRenditionBuffer(assetPath)`.
  - `similarityThreshold`: Optional override (`50–99`, defaults to `settings.similarityThreshold` = `85%`).
  - `matchMode`: `'any'` (default — assets containing any matched person from the query photo) or `'all'` (assets containing all matched people together).
  - `detectAllFaces`: `boolean` (default `true` when `DetectFaces` is permitted, falling back gracefully to single-largest-face `SearchUsersByImage` if `DetectFaces` is not in the IAM policy).
- **Validation & Cost/Memory Guardrails**:
  - Reject base64 payloads decoding to `> 5 MB` (and recommend `<= 640px` JPEG on the client/sandbox side so the HTTP request stays well under Adobe I/O Runtime's 1 MB web action payload limit).
  - Verify JPEG/PNG magic bytes and minimum dimensions (`getImageDimensions(buffer)`) before calling AWS.
- **Response Schema**:
  ```json
  {
    "queryFacesDetected": 1,
    "matchedPeople": [
      {
        "positionFromLeft": 1,
        "groupId": "grp_cc233d4a",
        "displayName": "Jill Jelly",
        "isNamed": true,
        "matchConfidence": 99.14,
        "queryBoundingBox": { "left": 0.31, "top": 0.18, "width": 0.38, "height": 0.52 },
        "totalAssetAppearances": 2
      }
    ],
    "unmatchedFaceCount": 0,
    "totalMatchingAssets": 2,
    "matchingAssets": [
      {
        "assetId": "...",
        "assetPath": "/content/dam/26H2/hertz/hertz-2026-fall shoot/hertz_elderly-couple_resort_luxury-sedan_v1.png",
        "assetTitle": "hertz_elderly-couple_resort_luxury-sedan_v1.png",
        "sharedPeopleCount": 1,
        "sharedPeople": [{ "groupId": "grp_cc233d4a", "displayName": "Jill Jelly", "matchConfidence": 99.14 }],
        "allPeopleOnAsset": ["John Johnson", "Jill Jelly", "Dave Driver"],
        "faceCount": 3
      }
    ]
  }
  ```

---

#### C. Coworker Sidebar Execution Strategy (Two-Path Routing for Sandbox Egress)

When a user uploads an image attachment into a Coworker chat, the file is mounted in the Coworker bash sandbox (e.g., `/mnt/user-data/uploads/<filename>`). Because Coworker cloud sandboxes may restrict outbound `bash` network egress, the skill will support **two paths**:

1. **Path 1 — Direct HTTPS `POST` from Coworker `bash` (Fastest, ~300ms)**:
   - A small Python snippet in `SKILL.md` loads the uploaded image with Pillow (`PIL.Image`), downscales it so its longest edge is `<= 640px` and encodes as JPEG quality `85` (`~25–45 KB` base64 — guaranteeing it never hits the 1 MB Runtime payload limit even if the user uploaded a 15 MB raw headshot), and `POST`s `{ operation: "searchFacesByImage", imageBase64, skillKey }` to `https://<namespace>.adobeio-static.net/api/v1/web/aem-assets-assetsview-1/groups`.
   - Renders the matched person name(s), similarity %, and clickable AEM Assets View `detailUrl` links.

2. **Path 2 — AEM-Relayed Fallback (When `*.adobeio-static.net` Is Blocked by Sandbox Egress)**:
   - If the Python `POST` to `*.adobeio-static.net` fails with a network/proxy error because the Coworker sandbox only allows `*.adobeaemcloud.com`:
   - **Option 2A (Temporary Scratch Asset in AEM via `write-api` + I/O Events)**:
     - Upload the query photo to a designated scratch folder `/content/dam/_facerec-temp/` in AEM (or ask the user to drop it into a DAM folder), where Adobe I/O Events (`aem.assets.asset.processing_completed`) automatically triggers `ingest-event` in the background and writes `xdm:faceGroupIds` + `xdm:faceLabels` back to the scratch asset's metadata.
     - Coworker then reads `xdm:faceGroupIds` from the scratch asset via `read-api` (`search-assets`), finds all matching DAM assets via `Workflow 2`, and deletes the temporary scratch asset via `delete-api`.
   - **Option 2B (In-App "Find by Photo" Dropzone in the AEM Assets View UI)**:
     - Provide a **"Find by Photo"** button right in the **Face Groups** modal (`AdminConsole.js`) and **Recognized Faces** right rail (`AssetDetailsSidePanel.js`), which runs directly in the user's browser where `*.adobeio-static.net` is always reachable.

---

#### D. UI Surface Enhancement (`AdminConsole.js` & `AssetDetailsSidePanel.js`)
- Add a **"Find Person by Photo"** button (with file picker / drag-and-drop image input) in the top bar of `AdminConsole.js`:
  - Downscales the selected image on an HTML5 `<canvas>` (`<= 640px` JPEG) in the browser.
  - Calls `api.searchFacesByImage({ imageBase64 })`.
  - Displays the matched Face Group card(s) with similarity % badge (`99.1% match`) and filters/selects the matched group so the user can immediately see all DAM assets containing that person (and click the `↗` deep link on any asset).

---

#### E. Implementation Checklist (When Ready to Build)
- [ ] **Step 1 (`rekognition.js`)**: Add `searchFacesByImage(imageBuffer, facesMap, groupsMap, { detectAllFaces })` using `SearchUsersByImageCommand` + `SearchFacesByImageCommand` (and optional `DetectFacesCommand` + `cropper.js` for multi-face query images).
- [ ] **Step 2 (`face-service.js` & `actions/groups/index.js`)**: Add `searchFacesByImage({ imageBase64, assetPath, assetId, similarityThreshold, matchMode })` with 5 MB / dimension guards and ranked asset resolution.
- [ ] **Step 3 (`AdminConsole.js` & `api.js`)**: Add `api.searchFacesByImage` and the **"Find by Photo"** upload button + match result banner in the Face Management Console.
- [ ] **Step 4 (`SKILL.md` & `facerec_cli.mjs`)**: Add Workflow 5 (`search-by-image <file-or-url>`) to `SKILL.md` and `facerec_cli.mjs` with automatic Pillow downscaling (`<= 640px` JPEG) and AEM-relayed fallback instructions.
- [ ] **Step 5 (Tests & Docs)**: Add unit and UI tests for single-face match, multi-face query image, no-match photo, oversized payload rejection, and update `README.md` / `SETUP.md` IAM policy with `rekognition:SearchUsersByImage` and `rekognition:SearchFacesByImage`.
