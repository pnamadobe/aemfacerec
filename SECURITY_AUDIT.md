# Security, Robustness & Performance Audit

**Scope:** the whole repository (Runtime actions, shared libraries, web UI, deployment manifest)
**Lens:** enterprise-scale deployment (large DAMs, many concurrent users and events, regulated biometric data)
**Audit date:** 2026-11-10

Status legend: ✅ Fixed · 🟡 Partially addressed · ⬜ Open

---

## Executive summary

The extension works as a prototype. Before the first round of fixes, three problems made it unsafe for production:

1. **Every web action could be called anonymously.** This exposed biometric data export, data wipe, and credential replacement.
2. **The AEM technical-account token could be sent to any host, and was used silently in place of the user's token** (SSRF and privilege escalation).
3. **All state lives in a few JSON documents.** Each request reads and rewrites the whole document, with no concurrency control, and a single read error could wipe the database.

This round fixes the critical security issues (S1–S7, S9 partially) and the worst data-loss risks (R2, R4, R8, R12). The remaining items are architectural: a real data store, a queue-based ingestion pipeline, and privacy/compliance tooling. They are tracked below with recommended designs.

---

## 1. Security

| ID | Severity | Finding | Status | Remediation |
|---|---|---|---|---|
| S1 | Critical | Web actions used `require-adobe-auth: false` with `Access-Control-Allow-Origin: *`. Anyone could call `exportSnapshot` (all biometric data plus the encrypted AWS key), `importSnapshot`, `clearAllData` or `saveSettings`, for example to point ingestion at an attacker's AWS account. | ✅ | `require-adobe-auth: true` on all web actions. Defense in depth: anonymous web calls in Runtime get 401 (`action-context.js`). `seedDemoData`, `clearAllData`, `exportSnapshot` and `importSnapshot` are disabled unless the deployment sets `ENABLE_MAINTENANCE_OPS` (a `final` input, so callers can't override it). Export no longer contains credentials, and import can't overwrite settings. |
| S2 | Critical | SSRF and credential exfiltration: the AEM host came from the request (`aemHost`), and the client attached the technical-account token, so `aemHost=https://evil` received it. | ✅ | `resolveAemHost` allowlists `https://author-pN-eN(-cmstg).adobeaemcloud.com` plus an optional `AEM_ALLOWED_HOSTS`. The AEM client refuses to send credentials to any origin other than its bound host, and doesn't follow redirects (`redirect: 'manual'`). |
| S3 | Critical | Privilege escalation: any failing or fake user token was retried with the technical-account token, bypassing AEM permissions. | ✅ | User requests use only the user's token. Service credentials are used only by non-web (I/O Events) invocations, only against the configured host, and only when no user token exists. They're removed from the web actions' inputs entirely. |
| S4 | Critical | Hardcoded default encryption key. `ingest` and `groups` never received `ENCRYPTION_SECRET`, so they used the public default. | ✅ | No default key. In Runtime the code refuses a missing, short (<16) or known-default secret. Every action now receives `ENCRYPTION_SECRET`. ⬜ Follow-up: derive the key with HKDF and add key versioning and rotation. |
| S5 | Critical | `metadataProperty` went straight into a Sling POST field name, so `../../jcr:content/x` or `jcr:*` could write arbitrary properties. | ✅ | Strict `ns:name` pattern, with `jcr`, `sling`, `rep`, `cq`, `oak`, `nt` and `mix` blocked. Checked both when settings are saved and when metadata is written. |
| S6 | High | Asset and folder paths weren't confined to the DAM (with S3 this meant reads from `/etc`, `/apps`, …). Folder-prefix checks matched `/events-private` against `/events`. | ✅ | `assertDamPath` rejects anything outside `/content/dam`, plus `..`, `.`, `//` and control characters. Folder matching is segment-aware. UUID lookups are format-checked. Scan batches are capped at 50 assets. |
| S7 | High | Actions copied request and config values into `process.env`. Warm containers share it, along with a module-level token cache. | ✅ | No more `process.env` writes. Credentials are passed explicitly. The token cache is keyed by a hash of the credentials. |
| S8 | High | Long-lived AWS access keys (BYOK) stored in app storage. Whoever operates the deployment holds both `ENCRYPTION_SECRET` and the ciphertext, so the operator can decrypt customer AWS keys. A customer-supplied encryption secret would not fix this, because the server must decrypt the key to call AWS, including during unattended event ingestion. | ⬜ Deferred (2026-11-10) | Preferred: a cross-account IAM role in the customer's AWS account, used via STS `AssumeRole` with a per-customer `ExternalId` and scoped to one collection. No secret is stored, and the customer can revoke access and audit it in CloudTrail. Alternatives: envelope encryption with a customer-managed KMS key, or customer self-deployment into their own App Builder project. Interim: store `ENCRYPTION_SECRET` in a vault and restrict who can read `.env` and the Runtime namespace. |
| S9 | High | JWT service credentials (`AEM_SC_JSON`) are end-of-life. Tokens were accepted from `params.token`, which is logged. | 🟡 | `params.token` is no longer accepted (only the `Authorization` header). ⬜ Migrate to OAuth Server-to-Server credentials. |
| S10 | High | Biometric data obligations (GDPR Art. 9, BIPA, CCPA): no consent tracking, retention limits, audit log or per-person erasure. `clearAllData` leaves Rekognition faces and avatar files behind. | ⬜ | Add consent and purpose metadata per collection, retention jobs, an audit log of who named, merged or split groups, and a "forget person" operation covering Rekognition, the data store and avatars. |
| S11 | High | No tenant isolation: one storage area and one collection per namespace; the IMS org header is ignored. | ⬜ | Partition storage and collections by IMS org. Validate that the token's org matches the configured org. |
| S12 | Medium | Raw error messages (internal URLs, paths) returned to clients. | ✅ | `errorResponse` returns `PublicError` messages as-is and a generic message plus a reference id for everything else. Details are logged server-side. |
| S13 | Medium | `LOG_LEVEL: debug` in production. | ✅ | Set to `info`. |
| S14 | Medium | The webhook challenge echoed arbitrary input. | ✅ | Only `[A-Za-z0-9_-]{1,128}` is echoed. |
| S15 | Medium | `npm audit` reports moderate advisories (minimatch/glob ReDoS, deepmerge, @octokit). Unused packages (`sharp`, `node-fetch`, `chalk`, `js-yaml`) are in production dependencies. | ⬜ | `npm audit fix`. Move CLI/hook-only packages to `devDependencies` and remove unused ones. |
| S16 | Low | Security response headers missing. | ✅ | `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` on all action responses. |
| S17 | Low | Group names unbounded. | ✅ | Limited to 200 characters. |

> **Behavioral change to note:** because web actions no longer fall back to the technical account, metadata write-back and asset reads run with the **signed-in user's** AEM permissions. Users need write access to the assets they scan or rename people on. This is intended: it enforces AEM permissions.

---

## 2. Robustness and data integrity

| ID | Severity | Finding | Status | Remediation |
|---|---|---|---|---|
| R1 | Critical | Each request reads, modifies and rewrites the whole database with no locking or version check. Parallel I/O Events overwrite each other. | ⬜ | Move to a store with per-record writes and version checks (App Builder Database, DynamoDB, or Postgres), with one record per face, group and asset. |
| R2 | Critical | `readJson` returned `{}` on any read or parse error, and the next save wiped the database. | ✅ | Only "not found" yields defaults. Corrupt documents and storage errors now throw, so nothing is written back. |
| R3 | High | The four JSON documents are written in parallel, so a failure leaves them out of sync. | 🟡 | The local backend now writes atomically (temp file plus rename). ⬜ Fully solved by R1. |
| R4 | High | Silent fallback to `aio-lib-state` (1 MB values) and then to the container's ephemeral `/tmp`. | ✅ | In Runtime, the action now fails loudly if no persistent backend is available. ⬜ `aio-lib-state` remains a fallback; its value-size limit will be hit at scale (resolved by R1). |
| R5 | High | No transactions spanning Rekognition and the database. Re-ingest deleted old faces *before* the new index succeeded. | 🟡 | **Ingest fixed:** detect, match and crop first, without touching the database. If anything fails, new faces and avatars are discarded and the database is unchanged. Old faces are then removed (AWS first, database second, idempotent). If applying faces fails partway, the faces applied so far are saved consistently, the rest are discarded, and the asset is flagged `incomplete` (a re-scan repairs it). ⬜ Split, move and merge still interleave AWS and database steps; retries make failures rare, but a reconciliation job is still recommended. |
| R6 | High | `findMatchingGroup` swallowed every error, including throttling, so each face got a new group. | ✅ | Only "nothing to match yet" errors (`ResourceNotFound`, `InvalidParameter`) count as no match. Throttling is retried, and if it persists the ingest fails cleanly (see R5) instead of creating duplicate people. |
| R7 | High | No retry, backoff or concurrency limits for Rekognition and AEM. | ✅ | `lib/retry.js`: exponential backoff with full jitter and a total delay budget, so retries can't push a request past its timeout. Rekognition retries throttling, 5xx and network errors (up to 5 attempts; the SDK's own retries are disabled so they don't stack). AEM retries 429, 502, 503, 504 and network errors (up to 4 attempts, honoring `Retry-After`). AEM metadata writes run with a concurrency of 4. |
| R8 | High | The fallback metadata write wasn't checked, so the function returned `updated: true` on failure. | ✅ | Failures are detected, but no longer abort the operation. Rename, split, move, merge, re-sync and ingest always save, and return `failedAssetCount` / `failedAssets` (and `metadataSynced: false` for ingest). The asset record keeps `metadataSyncError`, and the UI shows a warning banner. Fixes a regression where one failed AEM write discarded a rename after AWS had already been updated. |
| R9 | Medium | Inconsistent asset IDs (`urn:aaid`, `jcr:uuid`, path, hex-of-path), causing duplicates and orphaned faces. | ⬜ | Canonicalize to the AEM asset UUID, with a secondary index by path. |
| R10 | Medium | Event processing isn't idempotent; retries reprocess. | ⬜ | Dedupe on the event id plus asset version. |
| R11 | Medium | Folder listing stops at 200 entries. | ⬜ | Page through results with `offset`/`limit`. |
| R12 | Medium | 32-bit group IDs; a collision overwrites a group. | ✅ | 128-bit IDs. |
| R13 | Medium | `getAssetFaces` (a read) rewrites the whole database. | ⬜ | Persist UUID resolution as a single-record update (R1), or not at all. |
| R14 | High | Renaming a group, re-syncing and settings toggles do one AEM write per asset, in sequence, in a single request, and save only at the end. At scale they hit the timeout and lose all work. | ⬜ | Run these as background jobs with checkpoints (queue plus worker) and return a job id to the UI. |
| R15 | Medium | Thin test coverage. | 🟡 | Added `test/security.test.js` (26 tests covering auth, SSRF, path/property validation, storage failure modes, credential handling). ⬜ Add concurrency and failure-injection tests once R1/R5 land. |

---

## 3. Performance and scalability

| ID | Finding | Status | Remediation |
|---|---|---|---|
| P1 | Every request loads and rewrites the full database. Base64 avatars are stored inline (around 2–4 KB per face), so 100k faces is over 300 MB of JSON, more than the 512 MB action memory once parsed. | 🟡 | Pretty-printing removed (about 30% smaller). ⬜ Per-record store (R1). Store avatars only as files and drop `avatarDataUrl` from the records. |
| P2 | `listGroups` returned every group with every face and avatar: **972 KB in production for 163 faces, just under the 1 MB Runtime limit.** | ✅ | Groups are paged (60 per page, max 100), and filtering and search moved to the server. A names-only `listGroupOptions` feeds the pickers. `getGroup` loads one group's faces in pages of 60. Rename, split, move and merge return summaries without member faces. The side panel no longer downloads the groups list at all (it never used it). Production after deploy: groups page 183 KB, options 17.5 KB, group view 18 KB. Tests show every read stays under 900 KB with 3,100 groups and a 1,500-face group. ⬜ Avatars are still stored inline in `faces.json` (P1).
| P3 | Full linear scans for asset lookups; quadratic `includes` in merges. | ⬜ | Indexed lookups (R1); use `Set`s in merge, split and move. |
| P4 | Everything is sequential: Rekognition per face, AEM per asset, and an uncached ancestor-folder walk on every event. | ⬜ | Bounded parallelism (for example 4–8). Cache folder eligibility per ancestor with a TTL. |
| P5 | Pure-JS JPEG decode with `maxMemoryUsageInMB: 512` in a 512 MB container. The `original` rendition fallback could be up to 100 MP. | ✅ | Downloads are capped at 5 MB (Rekognition's own limit), checked by `Content-Length` and while streaming. The original is used only if it's under the cap. Decoding is capped at 25 MP / 192 MB, and PNG dimensions are checked from the header before decoding. |
| P6 | Every non-OK AEM response was re-requested (doubling traffic for rendition probes). | ✅ | Removed along with the S3 fix. |
| P7 | The browser drives folder scans; closing the tab aborts the job. | ⬜ | Server-side job (see R14). |

---

## 3b. AWS cost

| ID | Finding | Status | Remediation |
|---|---|---|---|
| C1 | Folder scans and the bulk "Recognize Faces" action re-sent **every** image to AWS on every run, including already-scanned ones and ones with no faces. Each re-scan also re-created the image's faces and re-matched them. | ✅ | Already-scanned images are skipped. The browser filters them out before calling the backend, and the backend double-checks by asset id, its `urn:aaid` variants, or path. Skipped images cause zero AWS calls, downloads or AEM writes. An "Include already-scanned images" option forces a full re-scan. The side panel's Re-scan and AEM upload events still always analyze. Images left `incomplete` by a failed scan are retried. |
| C2 | No file-type control: the folder scan accepted any `image/*` type (SVG, GIF, icons) or unknown type, and events and single scans had no check, so PDFs and videos had their previews analyzed. | ✅ | One configurable allowlist for all paths (default: JPEG, PNG, TIFF, PSD, WebP, HEIC/HEIF, BMP). It's checked before any download, using the type from the folder listing, the upload event, or the AEM asset info. Excluded files are counted and reported. |
| C3 | Logos and icons were sent to AWS. | ✅ | Images whose shorter side is under `minImageSize` (default 200px, configurable, 0 = off) are skipped. Dimensions are read from the downloaded JPEG/PNG header, before the AWS call. Skipped images aren't recorded, so lowering the limit later makes them eligible. |
| C4 | Every batch called `DescribeCollection`, even when nothing needed analysis. | ✅ | Checked at most once per request, and only when an image actually needs AWS. |
| C5 | Images with no faces still cost one AWS call on their **first** scan. | ⬜ Won't fix | AWS's detect-only call costs the same as indexing; a local detector adds weight and misses small faces; Smart Tags hints are unreliable. After C1 the cost is paid once per image. |

## 4. Target architecture (recommended)

```
AEM Assets ──I/O Events (journal)──► ingest-event worker ──► queue (per org)
                                                             │
UI (IMS token) ──► web actions (auth, validation) ──► jobs ──┤
                                                             ▼
                              Rekognition (AssumeRole, per-org collection)
                              Data store (faces / groups / assets records, versioned writes)
                              Files (avatars) ──► signed URLs to UI
                              AEM metadata write-back (batched, retried, idempotent)
```

---

## 5. Test coverage added in this round

`src/aem-assets-assetsview-1/test/security.test.js`: run with `npm test`.

Against the original code, 11 of these tests fail. With the fixes, the full suite (33 tests, including the original 7 functional tests) passes. Covered:

- Host allowlist, including lookalike, userinfo and path tricks, and rejection of `aemHost` at the action level.
- No use of the technical-account token for web calls, no retry with it after a user-token failure, and no tokens accepted from body or query parameters.
- 401 for anonymous web calls in Runtime; 403 for maintenance operations unless enabled.
- `process.env` is not mutated by actions.
- DAM path confinement (traversal, `/etc`, `/apps`, `/libs`, control characters) at the action, service and client layers.
- Metadata property validation at the settings and write layers.
- Metadata write failures are reported.
- Segment-aware folder matching.
- Corrupt-database handling (no wipe); no silent `/tmp` fallback.
- Settings validation; export without credentials; import can't overwrite settings.
- Encryption-secret enforcement and key separation.

`test/robustness.test.js` (39 tests) and `test/ui-api.test.js` (4 tests), added in the second round (R5–R8, P5). Against the previous code, 24 of the 39 robustness tests fail. Covered:

- Retry primitives: backoff bounds, delay budget, `Retry-After`, error classification, bounded concurrency.
- Rekognition: throttled calls retried; persistent throttling surfaces instead of creating a new person; "not ready" errors fall back to `SearchFaces`; unsupported images get readable errors.
- Ingest failure handling: the database is unchanged when matching or old-face removal fails, and orphaned faces and avatars are cleaned up; a failure partway through applying faces saves a consistent partial result and a re-scan recovers.
- AEM metadata failures don't lose renames, merges, splits, moves or scans, are reported per asset, and can be retried via re-sync.
- AEM retries on 429/503/network errors, no retries on 4xx/500, image size caps (header and streaming), the original rendition as last resort, decode limits.
- UI warning banners for partial failures.

`test/paging.test.js` (15 tests) and `test/ui-admin-console.test.js` (8 tests), added in the third round (P2). The UI tests render the real Admin Console and side panel in jsdom against the real Runtime actions and storage, with only AWS, AEM and the host connection mocked. Against the previous UI, 7 of the 8 fail. Covered:

- Response-size budget (<900 KB) for every read operation on a 3,100-group dataset, including a 1,500-face group and a 100-face crowd photo.
- Complete, duplicate-free, stable paging; named-first ordering; server-side filter and search; input clamping; 404s.
- UI: no requests before the IMS token is available; Next/Previous paging; debounced search sends one request and resets to page 1 (this caught a double-request bug during development); "Load more faces"; rename; merging the selected group selects the target; the side panel makes exactly one request.
- Avatar path safety; 128-bit group IDs; group name limits.

## 6. Deployment checklist for this change

1. Set `ENCRYPTION_SECRET` (`openssl rand -base64 32`) in `.env` before deploying. **If data was previously encrypted with the default key, re-enter the AWS secret in Settings after deploying.**
2. Keep `ENABLE_MAINTENANCE_OPS=false` in production. The UI's "Load sample data" and "Clear all data" buttons will return a "disabled" message.
3. Make sure Assets View users who scan or name people have write permission on the relevant DAM folders.
4. If AEM is reached through a custom domain, add it to `AEM_ALLOWED_HOSTS`.

`test/cost.test.js` (17 tests), plus additions to `ui-api.test.js` (+4) and `ui-admin-console.test.js` (+2), added in the fourth round (C1–C4). Against the previous code, 12 of the 17 cost tests fail. The assertions count AWS calls, downloads and AEM writes for every skip path, including an upload event for a PDF that must not touch AEM or AWS. The end-to-end UI test checks that a second folder scan with nothing new makes no AWS calls.
