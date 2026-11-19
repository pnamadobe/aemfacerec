# License Suggestions (experimental)

Suggests AEM usage-rights licenses for the people recognized in an asset by matching the face in
each license's contract headshot. The user reviews the contract and confirms; confirming assigns the
license through the pre-GA AEM license API.

**Status: demo-ware.** It works end to end and is deliberately simple. It is off by default
(`enableLicenseSuggestions`). Section 1b explains how it is wired into the extension and how to
remove it; section 4 onward describes what a real-world deployment needs.

---

## 1. What it does today

1. The Recognized Faces panel loads an asset. If the flag is on, it calls `groups` →
   `suggestLicenses`.
2. The action lists licenses, downloads each unchecked license's PDF, extracts the embedded headshot
   JPEG, and runs Rekognition `SearchFacesByImage` against the existing face collection. The
   headshot is searched statelessly and never stored or indexed.
3. Hits are mapped to face groups. Each person card on the asset shows the licenses whose headshot
   matched that person: license name, match score (**Strong** at 90% or more, otherwise
   **Possible**), terms, restrictions.
4. **Review contract** opens a full-size dialog with two tabs: the rendered contract PDF, and the
   AEM-extracted properties (read-only, laid out like the product's *Property list* dialog). If the
   PDF cannot be rendered the dialog opens on the properties tab.
5. **Apply license** (from the card or the dialog) calls `assign`, which appends the license ID to
   the asset's `dam:licenseIds`. Nothing is assigned without an explicit confirm.

Matching is **face only**. Licenser, licensee and signer names are display information. An agency or
guardian can sign for the talent, so names are never used to match.

The product's own **Assign License**, **Unassign License** and **Check intended use** actions are
unchanged and independent. This feature adds one box inside the existing panel and no top-bar
buttons.

### Files

| Area | File |
| --- | --- |
| License API client (list, document URL, document range, assign, assigned IDs) | `src/aem-assets-assetsview-1/actions/lib/licenses.js` |
| Suggestion logic, cache, flag gating | `actions/lib/license-suggestions.js` |
| Headshot extraction from PDF bytes | `actions/lib/pdf-headshot.js` |
| Stateless face search | `actions/lib/rekognition.js` (`searchFacesByImage`) |
| Flag + match cache storage | `actions/lib/storage.js` (`enableLicenseSuggestions`, `db/license-matches.json`) |
| Operations | `actions/groups/index.js`: `suggestLicenses`, `applyLicense`, `getLicenseDocumentUrl`, `getLicenseDocumentChunk`; `getAssetFaces` also returns `licenseSuggestionsEnabled` |
| Person-card row | `web-src/src/components/LicenseSuggestionRow.js` (sets the flag-preservation rule in `utils/license-flag.js`) |
| Review dialog | `web-src/src/components/LicenseReviewModal.js` |
| Extracted-properties view | `web-src/src/components/LicensePropertiesView.js` |
| In-iframe PDF renderer (PDF.js) | `web-src/src/components/PdfPagesView.js`, `hooks/pre-build.js` |
| Admin switch | `web-src/src/components/AdminConsole.js` ("License Suggestions (experimental)") |
| Tests | `test/pdf-headshot`, `license-client`, `license-suggestions`, `license-suggestions-rekognition`, `license-suggestion-row`, `license-flag`, `license-ui-brand` |

### 1b. How it is wired into the extension (and how to remove it)

The feature lives **inside** the Face Recognition extension, behind one switch
(`enableLicenseSuggestions`, default off, in Face Groups settings). It is written as separate
modules, but it is not a separate deployable: it shares the extension's bundle, actions and
storage.

**New, self-contained files** (safe to delete as a set): `actions/lib/licenses.js`,
`license-suggestions.js`, `pdf-headshot.js`; `web-src/src/components/LicenseSuggestionRow.js`,
`LicenseReviewModal.js`, `LicensePropertiesView.js`, `PdfPagesView.js`;
`web-src/src/utils/license-flag.js`; `hooks/pre-build.js`; the tests listed above; this document.

**Shared files that were modified** (each change is small and tagged by the names below):

| File | Change |
| --- | --- |
| `actions/groups/index.js` | Four license operations; `getAssetFaces` also returns `licenseSuggestionsEnabled` |
| `actions/lib/rekognition.js` | `searchFacesByImage` (stateless search) |
| `actions/lib/storage.js` | `enableLicenseSuggestions` setting; `getLicenseMatches` / `saveLicenseMatches` |
| `web-src/src/components/AssetDetailsSidePanel.js` | Suggestion fetch, review/apply wiring, row under each person card |
| `web-src/src/components/AdminConsole.js` | The "License Suggestions (experimental)" switch |
| `web-src/src/components/App.js`, `Constants.js` | `modal-license-review` route; shared constants |
| `web-src/src/utils/api.js` | `suggestLicenses`, `applyLicense`, `getLicenseDocumentUrl`, `getLicenseDocumentChunk`, `fetchLicenseDocument` |
| `ext.config.yaml`, `.gitignore` | `pre-app-build` hook; ignore the copied PDF.js vendor files |
| `package.json` / lock | `pdfjs-dist` (the PDF viewer; the largest cost of the feature) |

**Behavior when the switch is off:** no license request is made, nothing is rendered, and no
license data is read or written. The code and the PDF viewer still ship in the bundle. If it must
not ship at all, remove the files and hunks above, or move the feature to a separate extension
(which would get its own rail icon; extensions cannot embed in each other's panels).

**Look and feel.** The screens are built from Adobe Spectrum components and tokens (`Badge`,
`Tabs`, `TagGroup`, `InlineAlert`, `StatusLight`, `ButtonGroup`, read-only text fields) and follow
the product's own *Property list* dialog. `test/license-ui-brand.test.js` fails the build on hard-coded
hex colors, raw buttons/inputs/tabs, `window.confirm`, em dashes or Title Case copy, and requires a
single accent button in the review dialog. The older panels in this extension still use their
original palette, and the app Provider is pinned to the light color scheme.

---

## 2. What we learned about the pre-GA license API

Verified against a test AEM as a Cloud Service author environment in November 2026.

- **Auth.** Only the **signed-in user's token** works. The Assets View token (client
  `aem-assets-frontend-1`) carries `aem.adobe.experimental` and `aem.assets.author`. The technical
  account (S2S/JWT) has neither scope and gets `403 "A valid experimental scope is required"`.
  The `x-api-key` header is the token's own `client_id`; `x-gw-ims-org-id` is the org.
- **Paths.** The experimental prefix is `/adobe/experimental/licenses-expires-20261201` and
  **expires 2026-12-01**. The GA prefix `/adobe` did not serve the list at the time (404, routed as
  an asset ID). `licenses.js` tries experimental first and falls back to GA on 404. **Re-verify and
  repoint before 2026-12-01.**
- **List.** `GET …/assets/licenses?limit=N` returns `items[]`. Each item has `licenseId`, `name`,
  `licensee`, `licenser`, `restrictions[]`, `windows[]`
  (`channels[]`, `regions[]`, `effectiveAt`, `expiresAt`, `perpetual`), `confidence`,
  `type` (`ORIGINAL`/`OVERRIDE`), `version`, `supersededAt`, `createdAt`. **The pagination cursor
  field is unverified** (the code accepts `nextCursor` or `cursor`). Confirm against the real
  response before relying on paging.
- **Document.** `GET …/assets/licenses/{id}/document` returns JSON `{ "href": <pre-signed Azure blob
  URL> }`. The blob host has **no CORS**, so the browser cannot read it directly. Following the
  `href` returns the original PDF.
- **Assign.** `POST …/assets/licenses/assign` with
  `{"assignments":[{"target":{"id":"<DAM path>","type":"ASSET"},"licenseId":"<id>"}]}` answered
  `200` synchronously with `data.state = COMPLETED` for one asset. The design allows up to 10 pairs
  per call, `FOLDER` targets that cascade recursively, and `202` plus a job for large requests.
  The only property written to the asset is `dam:licenseIds`. Terms (regions, channels, dates) live
  only in the license record.
- **Unassign.** `POST …/assets/licenses/unassign` (same body). It removes only the named ID, and
  removing the last ID removes the property. The license record is not touched.
- **Reading assignments.** `GET <asset>/jcr:content/metadata.json` with the user token returns
  `dam:licenseIds`. The product's `GET /assets/{id}/licenses` is the documented read path.
- **Extraction quality** on the three sample contracts (`licenses/`): 86 to 91% confidence. Regions,
  channels and dates are good. Nuances are lost: "paid social excluded" appears only in
  `restrictions` text (SOCIAL does not distinguish paid from organic), and David's "regional
  broadcast US/LatAm only" became GLOBAL.
- **Legacy mechanisms are separate.** `dc:license` (path to a PDF), `adobe_dam:restrictions` and
  `xmpRights:WebStatement` are the old download-gate flow. Do not mix them with `dam:licenseIds`.
  Pre-release builds may use other license-ID properties; this feature reads and writes
  `dam:licenseIds` only.

## 3. Platform gotchas found while building

- **Sandboxed iframes.** The host sandboxes extension iframes (`allow-scripts allow-forms
  allow-same-origin allow-downloads allow-popups`; no `allow-modals`). Consequences: Chrome will
  not show its built-in PDF viewer there, and a popup inherits the sandbox (so "open in new tab"
  fails too). `window.confirm` is blocked. The contract is therefore rendered with PDF.js onto
  canvases, from bytes the action proxies in 512 KB chunks.
- **PDF.js and the bundler.** Parcel fails resolving Node built-ins inside PDF.js. `hooks/pre-build.js`
  copies the minified files into `web-src/src/vendor/` as `.txt` (ignored by git) so Parcel treats
  them as raw assets. `PdfPagesView` fetches them and creates blob URLs at runtime. The main bundle
  is about 3.5 MB.
- **Stale `index.html`.** After a deploy the browser or CDN can keep serving an `index.html` that
  points at a deleted bundle hash (404, blank panel). For manual testing, reload with the cache
  disabled. `hooks/post-build.js` exists to mitigate this.
- **Published extensions.** A published workspace blocks plain `aio app deploy`; use
  `--force-deploy`.
- **Cross-frame messages.** A `BroadcastChannel` message from the review dialog to the panel did
  not arrive in practice. The panel instead trusts server state: `suggestLicenses` reports
  `assignedLicenseIds`, and the panel re-polls every 4 s (up to 3 min) after opening a review.
- **Scan results drop the flag.** `getAssetFaces` tells the panel that suggestions are enabled, but
  the scan actions (`ingestAsset`, `ingestVideoFrames`) do not. Replacing the panel's data with a
  scan result switched suggestions off until a full reload. `web-src/src/utils/license-flag.js`
  (`withLicenseFlag`) keeps the last known value, and suggestions also re-run when a re-scan
  changes who is in the asset (`licensePeopleKey`).
- **Workspaces.** Developer Console workspace files (`*.json`) are tied to one org. Deploy only
  with the workspace file that matches the org that owns the extension; a mismatched file is
  rejected with a 403.

---

## 4. Known limits of the demo design

| Limit | Where | Effect |
| --- | --- | --- |
| Reads only the first 200 licenses (`MAX_LICENSES`) | `licenses.js` | Contracts beyond 200 are never suggested |
| Checks at most 6 uncached licenses per open (`MAX_CHECKS_PER_CALL`) | `license-suggestions.js` | A large library fills in over many opens |
| Match cache: 1 h for matches, 5 min for everything else | `license-suggestions.js` | After expiry every open re-downloads PDFs and re-searches, one Rekognition call per license |
| Work grows with the number of contracts | design | Does not scale to thousands of contracts |
| Largest embedded image is assumed to be the headshot | `pdf-headshot.js` | Wrong for documents with logos or several photos |
| Only unfiltered `DCTDecode` JPEG streams are read | `pdf-headshot.js` | Scanned/flattened or JPX/Flate images yield no headshot |
| Single-asset apply only | `licenses.js` | No bulk or folder apply |
| Needs a signed-in user token | `groups/index.js` | No background or scheduled processing |
| The match cache is global to the deployment, not per user | storage | See the visibility issue in 5.5 |

---

## 5. Production design (not built)

### 5.1 Goals and assumptions

- Thousands to tens of thousands of contracts; many thousands of assets and people.
- Suggestion latency on opening an image should not depend on the number of contracts.
- New or changed contracts become matchable without anyone opening an image.
- A person only ever sees suggestions for licenses they are allowed to see.
- Biometric data is minimized, isolated and deletable.

### 5.2 Invert the search: index contract headshots once

The demo searches once **per license**. Rekognition is built to search once against a large index.

1. Create a dedicated collection, `aem-contracts-<tenant>`, separate from the asset-face
   collection. Do **not** mix contract faces into the asset collection: it would pollute grouping
   and `SearchUsers`.
2. For each license version, extract the headshot and call `IndexFaces`
   (`MaxFaces: 1` on the designated photo region, `QualityFilter: AUTO`,
   `ExternalImageId = lic_<licenseId>_v<version>` using only `[A-Za-z0-9_.\-:]`).
3. Persist `licenseId:version → { faceId, indexedAt, status }` in the extension's storage. The
   `FaceId` is needed to delete the vector later, and `ListFaces` cannot filter by external ID.
4. **Query side.** For each person group on the asset, call `SearchFacesByImage` on the
   **contracts collection** using that person's best face crop (the stored avatar is 160 px; prefer
   a fresh crop from the 1280 px web rendition with padding). Try the 2 to 3 best faces of the group
   and take the maximum similarity to reduce false negatives. One call per person per asset
   regardless of contract count.
5. Cache `groupId → [{ licenseId, similarity }]`, keyed by a group version/hash and invalidated
   when the group's faces change (the storage layer already merges per-record revisions). New
   contracts are covered because they are in the index.

### 5.3 Keeping the index in sync

A sync job reconciles the license list with the contracts collection:

- **Initial backfill:** page through all licenses (use the list's `limit`/cursor, and the
  documented filters `includeSuperseded`, `orderBy`), index anything not in the mapping.
- **Incremental:** repeat on a schedule or on demand, indexing new `licenseId:version` pairs.
- **Removal:** delete vectors (`DeleteFaces`) for superseded or deleted licenses, and for licenses
  whose document no longer contains a usable headshot.
- **Job shape:** App Builder actions time out (60 to 120 s). Process in bounded batches, checkpoint
  the cursor and a status document, and resume (same pattern as the existing `scanFolder`
  batching). Respect Rekognition throttling with the existing `withRetry` and a small concurrency
  limit (2 to 4).
- **Idempotency:** key on `licenseId:version`. A re-run never double-indexes.
- **Headshot selection:** pick the image inside the designated photo area rather than "largest".
  Options in order of effort: (a) prefer an image whose placement/size matches a portrait box,
  (b) run face detection on every candidate image and index the one with exactly one high-quality
  face, (c) let an admin mark the headshot region per template. Record failures as statuses
  (`no-headshot`, `no-face`, `multi-face`, `unreadable`) instead of silently skipping, and surface
  counts in the admin console.
- **Non-JPEG images:** add decoders for `FlateDecode` and `JPXDecode` or use a real PDF library.
  The current extractor only reads unfiltered `DCTDecode` streams.

### 5.4 The auth blocker for background sync

The license API accepts **only a user token** today. A scheduled job has no user token and the
technical account lacks `aem.adobe.experimental`. Options, in order of preference:

1. Ask the license API owners for a service-level scope or an S2S-callable variant (the license
   backend is fronted by a gateway whose client allowlist is the control point).
2. **Admin-triggered sync** from the console, using the admin's forwarded token (same pattern as
   the existing folder scan). Add a "last synced" indicator and a "sync now" action.
3. Sync a bounded delta on image open (newest N licenses by `createdAt`), as a stopgap.

Until (1) exists, true unattended sync is not possible.

### 5.5 Permissions and visibility

The index and any cache are shared across users, but license visibility is per user. A shared
cache must not reveal that a contract (or a person's rights) exists to a user who cannot see it.

- After the face search returns candidate license IDs, **re-check each against the API with the
  requesting user's token** (a `GET …/licenses/{id}` that 200s or 403s) before returning it.
- Do not return the license name, licenser or terms from the cache without that check.
- Treat the "who has a contract" signal itself as sensitive.

### 5.6 Privacy, compliance, retention

- Storing contract face vectors is **biometric processing** (BIPA, GDPR Art. 9, CCPA/CPRA and
  similar). Confirm that the contracts' consent language covers it before enabling in production.
  A model release for likeness is not automatically consent for biometric matching.
- The headshot image is never stored; only the vector in the dedicated collection and the
  `licenseId → faceId` mapping.
- Delete the collection and mapping when the feature is turned off. Delete a contract's vector on
  license deletion or supersede. Provide an admin "purge all contract face data" action.
- Keep the AWS region configurable and document data residency.
- **Minors and guardians:** matching still requires human confirmation. Consider blocking
  auto-suggestion when the license metadata or terms indicate a minor, or when the licenser differs
  from the pictured talent and an age flag is present. Never auto-apply.
- **Audit:** log each apply (who, when, asset, license, similarity, strong/possible, whether the
  contract was reviewed in the dialog). Use the product's license event stream if it exists.

### 5.6b Matching quality

- Keep both thresholds configurable: the search threshold (currently the lower of the setting and
  90) and the Strong cut-off (90). Track false positives per threshold before choosing defaults.
- One person can have several licenses (renewals, overrides, multiple shoots). Show all, prefer
  active windows, and flag expired or not-yet-effective ones.
- Lookalikes and twins are real. A score is never proof; the review dialog is the safeguard.
- A contract with two faces (talent plus guardian) should index only the designated photo, or be
  marked `multi-face` for manual handling.

### 5.7 Applying at scale

- `assign` takes up to 10 pairs per call, supports `FOLDER` targets (recursive), and may answer
  `202` with a job to poll (`/adobe/assets/jobs/{jobId}/status|result`). Handle both.
- Add **"apply to all assets of this person"**: find assets by `xdm:faceGroupIds` (already
  indexed metadata), show a count and a sample, and require confirm. Chunk into 10-pair requests
  and report per-asset results. Idempotent, so re-runs are safe.
- Overlapping licenses on one asset are allowed (the property is multi-valued); the UI should list
  all assigned licenses and link to the product's **Check intended use**.
- Reversal is the product's own **Unassign License** and the `unassign` endpoint. No custom undo.

### 5.8 UX at scale

- Show the top few suggestions per person with a "more" affordance; surface the sync state
  ("indexing 4,120 of 9,800 contracts") instead of silently showing nothing.
- When there is no match, link the user to the product's **Assign License** wizard.
- Keep the review dialog as the confirm gate. Show the extracted-properties tab beside the PDF.
- Disclose to admins, in the settings switch text, that contract face data is processed.

### 5.9 Reliability and operations

- Retries and backoff on Rekognition and the license API, with a circuit breaker on repeated 403
  (token without scope) so the UI shows a clear message, not an empty box.
- Metrics: contracts indexed, failures by status, sync duration, searches per day, suggestions
  shown, applies, applies after review vs. direct.
- Storage: the mapping and cache can outgrow a single JSON document. Shard by license ID prefix or
  move to `aio-lib-state`/a real store before reaching thousands of entries, and keep the existing
  lease/merge discipline for concurrent writes.
- API drift: the experimental API is pre-GA and its path expires 2026-12-01. Isolate it behind
  `licenses.js` and add contract tests that run against stage.

### 5.10 Cost (verify current AWS pricing)

Approximate, at the time of writing: Rekognition image APIs (`IndexFaces`, `SearchFacesByImage`)
are about $0.001 per image for the first million; stored face vectors are about $0.00001 per face
per month. Indexing 10,000 contracts is roughly $10 once; ongoing searches are one per person per
asset open (cacheable). The current demo design repeats about one search per contract per cache
expiry, which is the cost this redesign removes.

### 5.11 Deployment and packaging

- Keep the flag default-off. Gating on the flag does not remove the code from the bundle; the
  bundle already includes the viewer (about 3.5 MB). If this must not ship to general users, build
  it behind a build-time flag or as a separate extension (a separate extension gets its own rail
  icon and cannot embed in this panel).
- Update the Exchange package listing/privacy text if this ships broadly.

### 5.12 Test plan

- Unit: headshot extraction on varied PDFs (flate, JPX, multi-image, scanned), index/delete
  bookkeeping, cursor paging, status handling, per-user visibility filter.
- Integration (stage, real token): create licenses from the sample contracts, run the sync,
  confirm the expected person matches and no cross-person matches.
- Quality: build a labelled set (same person, lookalikes, minors, bad photos) and measure
  precision/recall per threshold before choosing defaults.
- Load: backfill several thousand synthetic licenses to measure Rekognition throttling and action
  time budgets.

### 5.13 Suggested build order

1. Contracts collection + mapping + sync action (admin-triggered), with status reporting.
2. Query path against the contracts collection; per-user visibility re-check; cache invalidation.
3. Replace `suggestLicenses` internals (keep the same response shape so the UI is unchanged).
4. Headshot selection improvements and non-JPEG decoding.
5. Bulk apply and audit logging.
6. Scheduled sync once a service scope exists.

### 5.14 Open questions

- Is there, or will there be, an S2S/service scope for the license API?
- What is the list endpoint's real cursor field, and is there a `since`/`updatedAfter` filter?
- Do license create/update/delete emit events we can subscribe to (replace polling)?
- Legal sign-off on storing contract face vectors; retention period; who is the controller.
- How should a license for a minor, or signed by a guardian, be handled?
- Should usage terms be evaluated by this feature, or left to the product's **Check intended use**?

---

## 6. Operating the demo

1. Open Face Groups → Settings, enable **License Suggestions (experimental)** and save.
2. Upload the contract PDFs through the product's **Assign License** wizard so licenses exist.
3. Scan and name the people in an image set. Open an image: each person card shows matching
   licenses. **Review contract** shows the PDF and extracted properties; confirm to assign.
4. Reverse with the product's **Unassign License**.

Spike notes: the throwaway project used to prove the API (`aemlicensespike`) is not needed and can
be revoked and removed.
