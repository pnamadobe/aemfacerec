---
name: aem-face-recognition
description: Scan AEM DAM folders or individual image assets for faces using AWS Rekognition, find other DAM assets containing the same people as a given image (co-appearance search across named and unnamed people), search assets by person name, name people in a photo from left-to-right, rename/combine/split/delete face groups, and triage frequent unnamed faces. Use whenever the user is on a DAM folder or asset detail page in AEM and asks to "scan this folder for faces", "scan this asset/image for faces", "who is in this photo?", "what other assets have the same people as this image?", "find all photos with <Person>", "name the people in this image from left to right", "combine/merge/split these face groups", or "which unnamed people appear the most?".
---

# AEM Assets Facial Recognition & Grouping (`aem-face-recognition`)

Interacts with the **AEM Assets View Facial Recognition & Grouping App Builder Extension** (`aem/assets/assetsview/1`, deployed in `/Users/pnam/Sandbox/aemfacerec`) powered by customer BYOK **AWS Rekognition**.

`$SKILL` = the directory containing this `SKILL.md` (`/Users/pnam/.claude/skills/aem-face-recognition` or `/Users/pnam/Sandbox/aemfacerec/skills/aem-face-recognition`).

---

## Core Practitioner Workflows Supported

0. **Verify Extension Is Active on the Target AEM Instance (`check-instance`)**:
   - Before running face recognition on an AEM instance (or when the user provides an AEM URL with a specific `repoId` / `author-p...-e....adobeaemcloud.com` host), verifies that:
     1. The target AEM host matches the AEM environment bound to this App Builder extension (`AEM_HOST` / `AEM_ALLOWED_HOSTS`),
     2. The App Builder Runtime actions (`groups`, `ingest`, `settings`) are reachable and AWS Rekognition credentials + Collection ID are configured,
     3. The **`Face Recognition`** Processing Profile is installed on that AEM instance (`/conf/global/settings/dam/processing`) and reports which DAM folders are enabled.
   - Note: Every command (`scan-folder`, `scan-asset`, `inspect-asset`, `related-assets`, `name-faces-ltr`) also runs this host check automatically when given an AEM URL and fails fast with a clear message if the user is on a different AEM environment.
1. **Scan a DAM Folder for Faces (`scan-folder`)**:
   - User is viewing a folder in AEM Assets View (or provides a folder URL / `/content/dam/...` path) and asks to scan the assets for faces.
   - Automatically skips already-scanned images at zero AWS cost (pass `--rescan` to force re-analysis), batches in chunks of 5 to avoid 30s gateway timeouts, and summarizes detected faces per image.
2. **Scan or Inspect a Single Asset (`scan-asset` / `inspect-asset`)**:
   - User is on an AEM Asset Detail page (or provides a detail URL, DAM path, or `urn:aaid:aem:<uuid>`) and asks to scan the image or see who is in it.
   - Returns all detected faces **ordered left-to-right (`#1 leftmost` → `#N rightmost`)** with bounding box coordinates, group names / `Person #N` placeholder labels, total appearances across the DAM, and synced `xdm:faceNames` / `xdm:persona` metadata.
3. **Find Other Assets with the Same People as the Current Image (`related-assets`)**:
   - User asks: *"What other assets have the same people as the current image?"* or *"Which other photos have ALL of the people in this shot together?"*
   - Works for **both named people (`Jill Jelly`) AND unnamed placeholders (`Person #37`)** via internal `groupId` vectors — even when `includeUnnamedInMetadata` is turned off in AEM metadata!
   - If the source asset hasn't been scanned yet, automatically scans it first, then ranks all other DAM assets by how many people they share (`--mode any` default, or `--mode all` for exact co-appearance), returning direct clickable AEM Assets View deep links.
4. **Search Assets by Person Name or Group (`find-person`)**:
   - User asks: *"Find all photos of Belinda Baker"* or *"Which assets have both Freddie Father and Belinda Baker together?"* (`--mode all`).
5. **Name People in an Asset from Left to Right (`name-faces-ltr`)**:
   - User says: *"In this photo, the people from left to right are John Johnson, Jill Jelly, and Dave Driver."*
   - Sorts the asset's detected faces by `boundingBox.left` ascending (`#1` to `#N`), renames each person's Face Group (use `"-"` to skip a position), and automatically syncs `xdm:faceNames` + `xdm:persona` across every DAM asset where those people appear.
6. **Curation Triage — Top Unnamed People (`triage-unnamed`)**:
   - User asks: *"Which unnamed people appear in the most photos?"* or *"Who should we name first?"*
   - Lists unnamed `Person #N` clusters sorted by appearance count descending (`faceCount` / `assetCount`).
7. **Rename, Combine/Merge, Split, or Delete a Person (`rename`, `combine`, `split`, `delete`)**:
   - Rename any `Person #N` or existing person, merge duplicate clusters (`combine`), split a misgrouped face into its own standalone group (`split`), or permanently erase a person's biometric vectors, avatars, and metadata (`delete` — GDPR/BIPA right to be forgotten).

---

## Accepted Input Formats (URLs, Paths, UUIDs)

Every command in `facerec_cli.mjs` accepts **any** of the following directly:
- **AEM Assets View Folder URL**:
  `https://experience.adobe.com/?repoId=author-p59602-e520244.adobeaemcloud.com#/@tenant/assets/browse/content/dam/26H2/hertz/hertz-2026-fall%20shoot`
- **AEM Assets View Asset Detail URL** (with or without the `/<namespace>_face-recognition-panel` segment):
  `https://experience.adobe.com/?repoId=author-p59602-e520244.adobeaemcloud.com#/@tenant/assets/detail/767251-759moccasingayal_face-recognition-panel/content/dam/26H2/hertz/hertz-2026-fall%20shoot/hertz_elderly-couple_resort_luxury-sedan_v1.png`
- **AEM Author Touch UI URL**:
  `https://author-p59602-e520244.adobeaemcloud.com/assets.html/content/dam/26H2/hertz` or `/ui#/aem/assetdetails.html/content/dam/...`
- **Raw DAM Path**:
  `/content/dam/26H2/hertz/hertz-2026-fall shoot/hertz_elderly-couple_resort_luxury-sedan_v1.png`
- **Asset UUID**:
  `urn:aaid:aem:<uuid>` or `<uuid>`

---

## Quick CLI Commands

Run via `node $SKILL/scripts/facerec_cli.mjs` (reads `.env` from `/Users/pnam/Sandbox/aemfacerec/.env` automatically; pass `--json` on any command for structured JSON output):

```bash
# 0. Check whether the Face Recognition App Builder extension is active on a target AEM instance
node $SKILL/scripts/facerec_cli.mjs check-instance "<optional-aem-url-or-author-host>"

# 1. Scan all unscanned images in a DAM folder (or pass --rescan to re-analyze all)
node $SKILL/scripts/facerec_cli.mjs scan-folder "<folder-url-or-dam-path>"
node $SKILL/scripts/facerec_cli.mjs scan-folder "<folder-url-or-dam-path>" --rescan

# 2. Scan (or re-scan) a single image asset and list detected faces left-to-right
node $SKILL/scripts/facerec_cli.mjs scan-asset "<asset-detail-url-or-dam-path>"

# 3. Inspect already-indexed faces on an asset (ordered left-to-right, no AWS call)
node $SKILL/scripts/facerec_cli.mjs inspect-asset "<asset-detail-url-or-dam-path>"

# 4. Find other DAM assets that have ANY (or ALL) of the same people as this image
#    (Automatically scans the source image first if it hasn't been scanned yet)
node $SKILL/scripts/facerec_cli.mjs related-assets "<asset-detail-url-or-dam-path>"
node $SKILL/scripts/facerec_cli.mjs related-assets "<asset-detail-url-or-dam-path>" --mode all

# 5. Find all DAM assets containing specific people (by name, Person #N, or groupId)
node $SKILL/scripts/facerec_cli.mjs find-person "Jill Jelly"
node $SKILL/scripts/facerec_cli.mjs find-person "Freddie Father" "Belinda Baker" --mode all

# 6. Name the people in an asset from left to right (use "-" to skip a position)
node $SKILL/scripts/facerec_cli.mjs name-faces-ltr "<asset-url-or-path>" "John Johnson" "Jill Jelly" "Dave Driver"

# 7. Rename a face group (by Person #N, current name, or grp_... ID)
node $SKILL/scripts/facerec_cli.mjs rename "Person #37" "Jill Jelly"

# 8. Combine (merge) two groups, split a misgrouped face, or permanently delete a group
node $SKILL/scripts/facerec_cli.mjs combine "Person #42" "Jill Jelly"
node $SKILL/scripts/facerec_cli.mjs split "<faceId>" "Optional New Name"
node $SKILL/scripts/facerec_cli.mjs delete "Person #99"

# 9. Triage: list the most frequent unnamed people across the DAM so the user can name them
node $SKILL/scripts/facerec_cli.mjs triage-unnamed --limit 20
```

---

## Direct AEM Metadata & Runtime API Reference (When Calling Without the CLI)

### A. Native AEM Asset Metadata (`jcr:content/metadata`)
Every scan, rename, split, merge, or delete automatically syncs these properties on `jcr:content/metadata`:
- `xdm:persona` (`String[]`) — Pre-indexed out-of-the-box in AEM Assets View's Searchable Property Index (`/adobe/repository?resource=searchableproperties`).
- `xdm:faceNames` (`String[]`) — Primary multi-value array of face group names on the asset.
- `xdm:faceGroupIds` (`String[]`) — Internal cluster IDs (`grp_...`) on the asset.
- `xdm:faceCount` (`Long`) — Number of detected faces on the asset.

> **Important**: Never edit `xdm:faceNames` or `xdm:persona` directly via raw JCR/Sling writes when renaming or merging people — always use the `groups` Runtime action (or `facerec_cli.mjs`) so AWS Rekognition vectors, App Builder storage, and all affected AEM assets stay in sync.

### B. App Builder Runtime Actions (`aem-assets-assetsview-1`)
- **`ingest` (`aem-assets-assetsview-1/ingest`)**:
  - `browseFolder`: `{ "operation": "browseFolder", "folderPath": "/content/dam/..." }`
  - `scanFolder`: `{ "operation": "scanFolder", "folderPath": "/content/dam/...", "assets": [...], "force": true, "rescan": false }`
  - `ingestAsset`: `{ "operation": "ingestAsset", "assetPath": "/content/dam/.../img.png", "force": true, "rescan": true }`
- **`groups` (`aem-assets-assetsview-1/groups`)**:
  - `getAssetFaces`: `{ "operation": "getAssetFaces", "assetPath": "/content/dam/.../img.png" }`
  - `findRelatedAssets`: `{ "operation": "findRelatedAssets", "assetPath": "/content/dam/.../img.png", "matchMode": "any" }` (or pass `"personNames": ["Jill Jelly"]`, `"groupIds": ["grp_..."]`)
  - `listGroups`: `{ "operation": "listGroups", "filter": "all" | "named" | "unnamed", "query": "", "offset": 0, "limit": 60 }`
  - `renameGroup`: `{ "operation": "renameGroup", "groupId": "grp_...", "name": "Jill Jelly" }`
  - `mergeGroups`: `{ "operation": "mergeGroups", "sourceGroupIds": ["grp_..."], "targetGroupId": "grp_..." }`
  - `splitFaces`: `{ "operation": "splitFaces", "faceIds": ["<faceId>"], "newGroupName": "..." }`
  - `deleteGroup`: `{ "operation": "deleteGroup", "groupId": "grp_..." }`
