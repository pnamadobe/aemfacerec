# AEM Assets View — Facial Recognition & Grouping Extension

An **Adobe Developer App Builder** extension for **AEM as a Cloud Service (Assets View)** that integrates with a customer's **AWS Rekognition** account (Bring Your Own Key / BYOK) to automatically detect faces on uploaded images, crop portrait avatars, cluster matching faces into Face Groups, provide an administrative UI to name, split, or merge groups, and write multi-value group names to `xdm:faceNames` on AEM assets.

> 📖 **Looking for step-by-step installation, AWS IAM key setup, AEM Processing Profile setup, and Adobe I/O Events wiring?** See **[SETUP.md](./SETUP.md)**.

---

## Table of Contents

1. [Overview & Key Capabilities](#1-overview--key-capabilities)
2. [End-to-End Architecture](#2-end-to-end-architecture)
3. [How AWS Rekognition Collections & Users Work](#3-how-aws-rekognition-collections--users-work)
4. [Single-Pass `160×160` Face Avatar Cropping Pipeline](#4-single-pass-160160-face-avatar-cropping-pipeline)
5. [Multi-Face AEM Metadata (`xdm:faceNames`) & Placeholder Toggle](#5-multi-face-aem-metadata-xdmfacenames--placeholder-toggle)
6. [UI Surfaces](#6-ui-surfaces)
   - [Surface 1: Assets View Details Side Panel (`aem/assets/details/1`)](#surface-1-assets-view-details-side-panel-aemassetsdetails1)
   - [Surface 2: Face Management & BYOK Settings Console (`/#/admin`)](#surface-2-face-management--byok-settings-console-admin)
7. [Step-by-Step Setup & Deployment Guide](#7-step-by-step-setup--deployment-guide)
   - [Step 1: Customer AWS Rekognition IAM Setup (BYOK)](#step-1-customer-aws-rekognition-iam-setup-byok)
   - [Step 2: AEM Metadata Form Configuration (`xdm:faceNames`)](#step-2-aem-metadata-form-configuration-xdmfacenames)
   - [Step 3: AEM Folder Processing Profile Configuration](#step-3-aem-folder-processing-profile-configuration)
   - [Step 4: Adobe Developer Console & App Builder Deployment](#step-4-adobe-developer-console--app-builder-deployment)
8. [Runtime Action API Reference](#8-runtime-action-api-reference)
9. [Local Development & Automated Tests](#9-local-development--automated-tests)

---

## 1. Overview & Key Capabilities

| Capability | Description |
| :--- | :--- |
| **Customer BYOK AWS Rekognition** | Customers enter their own AWS Access Key ID, Secret Access Key, Region, and Rekognition Collection ID in the Settings screen. The Secret Access Key is encrypted at rest using **AES-256-GCM** and masked (`••••••••••••abcd`) on read. |
| **Processing Profile Folder Opt-In** | Automatically runs when images are uploaded to DAM folders that have the **`Face Recognition`** Processing Profile applied (or match configured folder path prefixes). Also supports manual on-demand scanning of a single asset or an entire DAM folder. |
| **Multi-Face Vector Extraction & Auto-Grouping** | Extracts all face vectors (`FaceId`) and normalized `BoundingBox` coordinates from an asset in a single `IndexFaces` call, then matches each face against existing Face Groups using Rekognition `SearchUsers` + `SearchFaces`. |
| **Padded `160×160` Face Avatar Cropping** | Reuses the in-memory AEM `1280×1280` web rendition buffer with `sharp` to crop a padded `160×160` JPEG portrait avatar for every detected face and stores it in `@adobe/aio-lib-files`. |
| **Split Face from Group** | Admins can remove one or more misgrouped faces from a Face Group; the removed face(s) become their own standalone Face Group in AWS Rekognition (`DisassociateFaces` -> `CreateUser` -> `AssociateFaces`). |
| **Combine / Merge Faces & Groups** | Admins can move individual face(s) into another group or merge entire Face Groups together (`DisassociateFaces` -> `AssociateFaces` -> `DeleteUser`). |
| **Name Group & Sync to `xdm:faceNames`** | Naming or renaming a Face Group writes the name to `./jcr:content/metadata/xdm:faceNames` (`String[]`) across every AEM asset containing a face from that group. |
| **Unnamed Placeholder Toggle** | Includes a Settings toggle (`includeUnnamedInMetadata`) to control whether unnamed groups appear on `xdm:faceNames` as placeholder labels (`Person #1`, `Person #2`) or remain hidden from `xdm:faceNames` until given a real name. |

---

## 2. End-to-End Architecture

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                        AEM as a Cloud Service (Author)                       │
│                                                                              │
│  ┌─────────────────────────┐  ┌──────────────────────┐  ┌─────────────────┐  │
│  │ DAM Folder              │  │ Asset Metadata       │  │ Assets View UI  │  │
│  │ (Processing Profile:    │  │ jcr:content/metadata │  │ - Details Panel │  │
│  │  "Face Recognition")    │  │ - xdm:faceNames[]    │  │   (Face Avatars)│  │
│  └───────────┬─────────────┘  │ - xdm:faceGroupIds[] │  │ - Admin Console │  │
│              │ Upload         │ - xdm:faceCount      │  └────────┬────────┘  │
└──────────────┼────────────────┴──────────▲───────────┘           │           ┘
               │                           │                       │
      1. I/O Event /              5. POST/PUT Asset       6. UI API Calls
      Manual Trigger                 Metadata               (IMS Auth)
               │                           │                       │
┌──────────────▼───────────────────────────┴───────────────────────▼───────────┐
│                         Adobe Developer App Builder                          │
│                                                                              │
│  ┌─────────────────────────┐             ┌────────────────────────────────┐  │
│  │ Action: ingest          │             │ Actions: groups & settings     │  │
│  │ - Check folder profile  │             │ - List/Search Groups & Faces   │  │
│  │ - Fetch 1280px rendition│             │ - Name / Rename Group          │  │
│  │ - Call Rekognition      │             │ - Split Face(s) -> New Group   │  │
│  │ - Crop avatars (sharp)  │             │ - Merge Group A -> Group B     │  │
│  │ - Match or create Group │             │ - Save BYOK AWS Settings       │  │
│  └───────────┬─────────────┘             └───────────────┬────────────────┘  │
│              │                                           │                   │
│              ▼                                           ▼                   │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ App Builder Persistent Storage (@adobe/aio-lib-files)                  │  │
│  │ - db/groups.json        (Group ID, Name, AutoLabel, Cover, FaceIDs[])  │  │
│  │ - db/faces.json         (Face ID, Group ID, Asset ID/Path, BBox)       │  │
│  │ - db/assets.json        (Asset ID/Path, FaceIDs[], Computed Metadata)  │  │
│  │ - db/settings.json      (AES-256-GCM Encrypted AWS Keys & Rules)       │  │
│  │ - avatars/<faceId>.jpg  (160x160 padded JPEG face crops)               │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────┬───────────────────┘
                               │                           │
                      2. IndexFaces /             7. AssociateFaces /
                         SearchUsers                 DisassociateFaces
                               │                           │
┌──────────────────────────────▼───────────────────────────▼───────────────────┐
│                     Customer's AWS Account (BYOK)                            │
│                        AWS Rekognition Collection                            │
│  - Indexed Face Vectors (FaceId + BoundingBox + ExternalImageId)             │
│  - Rekognition Users (UserId = groupId, aggregates multiple FaceId vectors)  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. How AWS Rekognition Collections & Users Work

1. **Vector Extraction (`IndexFaces`)**:
   - When an image is sent to `IndexFaces`, AWS Rekognition detects all faces in the image, extracts the facial feature vector for each face internally, stores the vector inside your Rekognition Collection, and returns an array of `FaceRecords`.
   - Each `FaceRecord` includes:
     - `Face.FaceId`: The unique UUID handle for that face vector inside Rekognition.
     - `Face.BoundingBox`: `{ Left, Top, Width, Height }` normalized coordinates (`0.0–1.0`).
     - `Face.Confidence`: Detection confidence (`0–100`).
2. **Face Grouping via Rekognition `Users` (`CreateUser`, `AssociateFaces`, `SearchUsers`)**:
   - Each **Face Group** in our extension maps 1-to-1 to a Rekognition `User` (`UserId = groupId`, e.g., `grp_9a8b7c6d`).
   - Associated `FaceId` vectors under a `UserId` are combined by Rekognition into an aggregated identity vector, improving recognition accuracy across different angles, lighting, and expressions.
   - During ingestion of a new face (`faceId`):
     1. We call `SearchUsers({ CollectionId, FaceId: faceId, MaxUsers: 1, UserMatchThreshold: 85 })`.
     2. If no `User` match is returned (for example, if a single-face `User` was created moments earlier and its vector is still indexing), we fall back to `SearchFaces({ CollectionId, FaceId: faceId, MaxFaces: 5, FaceMatchThreshold: 85 })` and resolve the matched face's `groupId`.
     3. If a match is found, we call `AssociateFaces` to add `faceId` to that group.
     4. If no match is found, we create a new group (`CreateUser` + `AssociateFaces`) with placeholder label `Person #N`.
3. **Splitting & Merging in Rekognition**:
   - **Split Face(s) from Group**: Calls `DisassociateFaces` on the old group, `CreateUser` for the new group, and `AssociateFaces` to bind the removed `FaceId`(s) to the new group.
   - **Merge Group A into Group B**: Calls `DisassociateFaces` on Group A, `AssociateFaces` on Group B, and `DeleteUser` on Group A.

---

## 4. Single-Pass `160×160` Face Avatar Cropping Pipeline

You do **not** need to crop images before sending them to AWS Rekognition — `IndexFaces` accepts the full image (we pass AEM's `cq5dam.web.1280.1280.jpeg` rendition) and returns bounding boxes for every detected face.

To power the face avatars in the **Asset Details Side Panel** and **Face Management Console**, `src/aem-assets-details-1/actions/lib/cropper.js` reuses the **exact same `1280×1280` Buffer already in memory**:
1. Converts the normalized `BoundingBox { Left, Top, Width, Height }` into pixel coordinates.
2. Expands the box by `+28%` padding around the center of the face (clamped to the image boundaries) so hair, chin, and shoulders are framed naturally as a square portrait.
3. Crops and resizes to a `160×160` JPEG (`quality: 82`, ~6 KB) using `sharp`.
4. Stores both the binary file (`avatars/<faceId>.jpg` in `@adobe/aio-lib-files`) and a compact data URL for immediate rendering in the UI.

---

## 5. Multi-Face AEM Metadata (`xdm:faceNames`) & Placeholder Toggle

An AEM asset can contain multiple faces (e.g., a keynote panel photo with 3 people).

Whenever faces on an asset are indexed, named, split, or merged, `computeAssetFaceMetadata()` in `face-service.js` recomputes the asset's metadata from the ground-truth state:

- **`xdm:faceNames`** (`String[]` multi-value):
  - Contains the deduplicated display names of all Face Groups present on the asset.
  - **Placeholder Toggle (`includeUnnamedInMetadata`)**:
    - When **`true` (default)**: Unnamed groups are included using their placeholder label (e.g., `["Sarah Jenkins", "Marcus Vance", "Person #3"]`).
    - When **`false`**: Only groups that have been given a real name by an admin are written to `xdm:faceNames` (e.g., `["Sarah Jenkins", "Marcus Vance"]`).
    - Toggling this setting in the Admin Console automatically triggers `resyncAllAssetsMetadata()` to update `xdm:faceNames` across all indexed AEM assets.
- **`xdm:faceGroupIds`** (`String[]` multi-value):
  - Stores the internal group IDs (`["grp_sarah01", "grp_marcus02", "grp_unnamed03"]`) so assets can always be queried by cluster ID.
- **`xdm:faceCount`** (`Long`):
  - Total number of faces detected on the asset.

> **JCR Multi-Value Guarantee**: When writing to AEM (`src/aem-assets-details-1/actions/lib/aem.js`), the client sends `xdm:faceNames@TypeHint=String[]` (and `xdm:faceNames@Delete=true` when empty). This guarantees AEM always stores `xdm:faceNames` as a `String[]` array in JCR even when an asset has only `1` recognized person.

---

## 6. UI Surfaces

### Surface 1: Assets View Details Side Panel (`aem/assets/details/1`)
Implemented in `src/aem-assets-details-1/web-src/src/components/AssetDetailsSidePanel.js` (`/#/side-panel`):
- **Interactive Bounding-Box Locator**: Renders the asset's detected face positions; hovering over a face card or bounding box highlights which avatar corresponds to which person in the image.
- **Live `xdm:faceNames` Metadata Preview**: Displays the exact multi-value pills written to `jcr:content/metadata/xdm:faceNames` on the asset.
- **Face Avatar Cards**:
  - Shows each person's `160×160` cropped face avatar, current group name (or `Placeholder` badge), detection confidence, and total faces in that group.
  - **Name / Rename**: Inline input to name or rename the person's group right from the asset.
  - **Split to New Group**: 1-click button to remove this specific face from its current group and make it its own standalone group.
  - **Combine Into...**: Dropdown picker to move this face into another existing Face Group.
- **Re-scan Button**: Manually triggers AWS Rekognition detection on the currently viewed asset.

### Surface 2: Face Management & BYOK Settings Console (`/#/admin`)
Implemented in `src/aem-assets-details-1/web-src/src/components/AdminConsole.js` (`/#/admin`):
- **Tab 1 — Face Groups & Split / Merge Manager**:
  - Filter groups by `All Groups`, `Named People`, or `Unnamed Placeholders`, and search by name or ID.
  - Check multiple groups in the grid to **Merge Groups** in bulk.
  - Click any group to open the **Manage Group** panel:
    - Name or rename the group.
    - Combine the entire group into another group.
    - Inspect all individual `160×160` face avatars in the group along with the source AEM asset filename and confidence score.
    - Select one or more individual faces to **Split into a New Standalone Group** or **Move to an Existing Group**.
- **Tab 2 — Scan Folder / On-Demand Ingest**:
  - Run facial recognition across an entire AEM DAM folder path or on a single AEM asset path.
- **Tab 3 — BYOK AWS Rekognition & Metadata Settings**:
  - Configure `AWS Region`, `Access Key ID`, `Secret Access Key`, `Rekognition Collection ID`, and `Similarity Threshold (%)`.
  - Click **Test AWS Connection & Verify Collection** to validate credentials and auto-create the Rekognition Collection if needed.
  - Configure target metadata property (`xdm:faceNames`), toggle **Include unnamed placeholder labels (`Person #N`) in `xdm:faceNames`**, and configure the **AEM Processing Profile Name** (`Face Recognition`) and enabled DAM folder prefixes.

---

## 7. Step-by-Step Setup & Deployment Guide

### Step 1: Customer AWS Rekognition IAM Setup (BYOK)
Create an IAM user in the customer's AWS account with programmatic access and attach the following minimum-privilege policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AemFaceRecognitionCollectionAccess",
      "Effect": "Allow",
      "Action": [
        "rekognition:CreateCollection",
        "rekognition:DescribeCollection",
        "rekognition:IndexFaces",
        "rekognition:SearchFaces",
        "rekognition:SearchUsers",
        "rekognition:CreateUser",
        "rekognition:DeleteUser",
        "rekognition:AssociateFaces",
        "rekognition:DisassociateFaces",
        "rekognition:DeleteFaces"
      ],
      "Resource": "arn:aws:rekognition:*:*:collection/*"
    }
  ]
}
```

### Step 2: AEM Metadata Form Configuration (`xdm:faceNames`)
To display the recognized face group names on Asset Details / Properties in AEM:
1. In AEM Author, navigate to **Tools > Assets > Metadata Forms** (or configure the Metadata Form in **Assets View > Administration > Metadata Forms**).
2. Edit the Metadata Form applied to your image assets.
3. Add a **Multi-value Text** field:
   - **Field Label**: `Recognized Faces` (or `People`)
   - **Property Name / Map to Property**: `./jcr:content/metadata/xdm:faceNames`
4. Save the form. Assets with multiple detected faces will display all group names as multi-value tags/entries.

### Step 3: AEM Folder Processing Profile Configuration
1. In AEM Author, navigate to **Tools > Assets > Processing Profiles**.
2. Create a Processing Profile named **`Face Recognition`**.
3. Apply the **`Face Recognition`** Processing Profile to the DAM folders where you want automatic facial recognition to run on upload (e.g., `/content/dam/events`).
4. When an asset is uploaded to a folder with this profile applied, `checkFolderEligibility()` inspects `jcr:content/dam:processingProfile` on the folder hierarchy and processes the asset automatically.

### Step 4: Adobe Developer Console & App Builder Deployment
1. In [Adobe Developer Console](https://developer.adobe.com/console), create a new **Project from Template > App Builder**.
2. Add the **AEM Assets View UI Extensibility** service (`aem/assets/details/1`) and optionally **I/O Events** (`AEM Assets — Asset Processing Completed` routed to the `aem-face-rec/ingest` Runtime Action).
3. Clone this repository and install dependencies:
   ```bash
   git clone https://github.com/pnamadobe/aemfacerec.git
   cd aemfacerec
   npm install
   cp .env.example .env
   ```
4. Sign in with the Adobe I/O CLI and link your project workspace:
   ```bash
   aio login
   aio console org select
   aio console project select
   aio console workspace select
   aio app use
   ```
5. Build and deploy:
   ```bash
   npm run deploy
   ```

---

## 8. Runtime Action API Reference

### 1. `aem-assets-assetsview-1/ingest` (`src/aem-assets-assetsview-1/actions/ingest/index.js`)
- **Ingest Single Asset (or Adobe I/O Event Webhook)**:
  ```json
  {
    "operation": "ingestAsset",
    "assetPath": "/content/dam/events/2026-summit/keynote-panel.jpg",
    "force": true,
    "rescan": true
  }
  ```
- **Browse DAM Folder (paged past 200 items, filtered by `allowedImageTypes`)**:
  ```json
  {
    "operation": "browseFolder",
    "folderPath": "/content/dam/events/2026-summit"
  }
  ```
- **Scan DAM Folder (skips already-scanned images unless `rescan: true`)**:
  ```json
  {
    "operation": "scanFolder",
    "folderPath": "/content/dam/events/2026-summit",
    "force": true,
    "rescan": false
  }
  ```

### 2. `aem-assets-assetsview-1/groups` (`src/aem-assets-assetsview-1/actions/groups/index.js`)
- **List Face Groups (paged summaries, server-side filter & search)**:
  ```json
  {
    "operation": "listGroups",
    "offset": 0,
    "limit": 60,
    "filter": "all",
    "query": ""
  }
  ```
- **List Lightweight Group Options (for merge/move pickers, no avatars)**:
  `{ "operation": "listGroupOptions", "query": "" }`
- **Get Single Group with Paged Member Faces**:
  ```json
  {
    "operation": "getGroup",
    "groupId": "grp_sarah01",
    "faceOffset": 0,
    "faceLimit": 60
  }
  ```
- **Get Faces & Metadata for an Asset**:
  ```json
  {
    "operation": "getAssetFaces",
    "assetId": "urn:aaid:aem:demo-keynote-panel",
    "assetPath": "/content/dam/events/2026-summit/keynote-panel.jpg"
  }
  ```
- **Name / Rename a Face Group**:
  ```json
  {
    "operation": "renameGroup",
    "groupId": "grp_unnamed03",
    "name": "Elena Rostova"
  }
  ```
- **Split Face(s) from Group into New Group**:
  ```json
  {
    "operation": "splitFaces",
    "faceIds": ["face-p3-2"],
    "newGroupName": "Optional New Name"
  }
  ```
- **Move / Combine Face(s) into Existing Group**:
  ```json
  {
    "operation": "moveFaces",
    "faceIds": ["face-p3-2"],
    "targetGroupId": "grp_sarah01"
  }
  ```
- **Merge Entire Face Group(s) into Target Group**:
  ```json
  {
    "operation": "mergeGroups",
    "sourceGroupIds": ["grp_unnamed03"],
    "targetGroupId": "grp_sarah01"
  }
  ```

### 3. `aem-face-rec/settings` (`src/aem-assets-details-1/actions/settings/index.js`)
- **Get Settings (Secret Key Masked)**: `{ "operation": "getSettings" }`
- **Save Settings & Auto-Resync Metadata**:
  ```json
  {
    "operation": "saveSettings",
    "settings": {
      "awsRegion": "us-east-1",
      "awsAccessKeyId": "AKIA...",
      "awsSecretAccessKey": "your-secret-key",
      "collectionId": "aem-assets-faces",
      "similarityThreshold": 85,
      "metadataProperty": "xdm:faceNames",
      "includeUnnamedInMetadata": true,
      "requireProcessingProfile": true,
      "processingProfileName": "Face Recognition",
      "enabledFolders": ["/content/dam/events"],
      "allowedImageTypes": ["image/jpeg", "image/png", "image/tiff", "image/vnd.adobe.photoshop", "image/webp", "image/heic", "image/heif", "image/bmp"],
      "minImageSize": 200
    }
  }
  ```
- **Test AWS Rekognition Connection**: `{ "operation": "testConnection" }`

---

## 9. Local Development & Automated Tests

Run the automated test suite (verifying AES-256-GCM credential encryption, avatar square-crop math & boundary clamping, multi-face ingestion, splitting faces, merging groups, toggling `includeUnnamedInMetadata` on `xdm:faceNames`, folder Processing Profile inspection, and Runtime Action entry points):

```bash
npm test
```

To launch the local App Builder development server:

```bash
npm run run
```
