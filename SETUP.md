# End-to-End Setup Guide — Facial Recognition & Grouping for AEM Assets View

This guide walks through every step required to set up, configure, and deploy the **Facial Recognition & Grouping Extension for Adobe Experience Manager Assets View** (`aem/assets/assetsview/1`) with **AWS Rekognition (Cross-Account IAM Role or BYOK)**, **AEM Processing Profiles**, and **Adobe I/O Events**.

> 🏢 **Deployment Options — Public Adobe Exchange or Self-Hosted App Builder**
> - **Installing from Adobe Exchange**: Click **Acquire / Install** on the Adobe Exchange listing, select your organization's AEM Author environment, and provide the required configuration parameters (`AEM_HOST`, `ENCRYPTION_SECRET`) during the Exchange installation prompt. Every subscribing organization is isolated in its own per-tenant storage partition (`tenants/<tenantId>/`) with its own HKDF-SHA256 AES-256-GCM encryption key.
> - **Deploying from Source (Downloadable / Developer Console)**: Clone this repository, copy `.env.dist` (or `.env.example`) to `.env`, bind to your Adobe Developer Console project workspace (`aio app use`), and run `aio app deploy` (or `aio app pack` to create `dist/app.zip` for Exchange distribution).

---

## Table of Contents

1. [Part 1: AWS Rekognition IAM Key Setup (BYOK)](#part-1-aws-rekognition-iam-key-setup-byok)
2. [Part 2: AEM Author Configuration](#part-2-aem-author-configuration)
   - [2A. Create & Apply the `Face Recognition` Processing Profile](#2a-create--apply-the-face-recognition-processing-profile)
   - [2B. Add `xdm:faceNames` to the AEM Metadata Form](#2b-add-xdmfacenames-to-the-aem-metadata-form)
3. [Part 3: Adobe Developer Console & App Builder Deployment](#part-3-adobe-developer-console--app-builder-deployment)
   - [3A. Deploy to Stage or Production](#3a-deploy-to-stage-or-production)
   - [3B. Wire Automatic Upload Trigger via Adobe I/O Events](#3b-wire-automatic-upload-trigger-via-adobe-io-events)
4. [Part 4: Entering Your AWS Key & Using the Extension in AEM](#part-4-entering-your-aws-key--using-the-extension-in-aem)
5. [Part 5: How Auto-Processing vs. Manual Scanning Works](#part-5-how-auto-processing-vs-manual-scanning-works)
6. [Part 6: Troubleshooting & Gotchas](#part-6-troubleshooting--gotchas)

---

## Part 1: AWS Rekognition IAM Key Setup (BYOK)

Customers supply their own AWS Rekognition credentials in the extension's **Settings** tab. No pre-created Rekognition Collection is needed — the extension automatically creates the collection (`aem-assets-faces`) on first connection.

### Step 1: Create an IAM User in AWS Console
1. Sign in to the **[AWS IAM Console](https://console.aws.amazon.com/iam/)** and go to **Users** -> **Create user**.
2. Enter a user name (e.g., `aem-face-recognition-bot`) and click **Next**.

### Step 2: Attach Rekognition Permissions
1. Select **Attach policies directly**.
2. Search for **`Rekognition`** and check the box next to **`AmazonRekognitionFullAccess`**.
   *(Alternatively, attach the least-privilege custom policy below)*:
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
3. Click **Next**, then click **Create user**.

### Step 3: Choose Cross-Account IAM Role (`sts:AssumeRole`) or Access Keys (BYOK)
- **Option A — Cross-Account IAM Role (`sts:AssumeRole`)**:
  1. Create an IAM Role in AWS Console with the `AemFaceRecognitionCollectionAccess` permissions policy above.
  2. Configure its **Trust Policy** to allow `sts:AssumeRole` conditioned on an `sts:ExternalId` string of your choice.
  3. In the extension's **Settings** tab, select **`Cross-Account IAM Role (STS AssumeRole)`** and enter the **IAM Role ARN** and **External ID**.
- **Option B — IAM User Access Key ID & Secret Access Key (BYOK)**:
  1. Click into your IAM user and open the **Security credentials** tab.
  2. Scroll down to **Access keys** and click **Create access key**.
  3. Select **Application running outside AWS**, check the confirmation box, and click **Next** -> **Create access key**.
  4. Copy the **Access key ID** (`AKIA...`) and **Secret access key**.

---

## Part 2: AEM Author Configuration

### 2A. Create & Apply the `Face Recognition` Processing Profile
To opt specific DAM folders into automatic facial recognition on asset upload:

1. In AEM Author, go to **Tools (🔨) > Assets > Processing Profiles**.
2. Click **Create** in the top-right corner.
3. On the **Basic** tab:
   - **Name**: Enter **`Face Recognition`** *(must match the `AEM Processing Profile Name` setting in the extension)*.
   - **Check `"Create FPO rendition"`** *(Important: AEM's Processing Profile form disables the **Save** button unless at least one built-in option is checked. Leave the **Custom** tab empty).*
4. Click **Save** in the top-right corner.
5. In the **Processing Profiles** list, check the box next to **`Face Recognition`**, click **Apply Profile to Folder(s)** in the top bar, and select the DAM folder(s) where you want automatic facial recognition enabled.
   - *Under the hood*: AEM writes `jcr:content/dam:processingProfile = /conf/global/settings/dam/processing/Face Recognition` on that folder node, which the `ingest` action inspects when an upload event fires.

### 2B. Add `xdm:faceNames` & `xdm:persona` to AEM Metadata & Search Filter Forms
So that recognized people appear on Asset Details / Properties and in the left Search Filter rail:

1. **Metadata Form (Asset Details / Properties)**:
   - In AEM Author, go to **Tools > Assets > Metadata Forms** (or **Assets View > Administration > Metadata Forms**).
   - Edit the Metadata Form applied to your images and drag a **Multi-value Text** field onto the form:
     - **Field Label**: `Recognized Faces` (or `People`)
     - **Map to Property**: `./jcr:content/metadata/xdm:faceNames` (and/or `./jcr:content/metadata/xdm:persona`, which the extension dual-writes by default).
   - Click **Save**.
2. **Search Filter Rail (Left-Rail Facets)**:
   - **Full-Text Search (Top Search Bar)**: Works automatically out-of-the-box for any name in `xdm:faceNames` or `xdm:persona`.
   - **AEM Assets View Left Filter Rail (Zero-Code Setup via `xdm:persona`)**:
     - Because `jcr:content/metadata/xdm:persona` (**Xdm Persona**) is pre-indexed out-of-the-box in AEM as a Cloud Service's `/adobe/repository?resource=searchableproperties` index, the extension dual-writes face names to `xdm:persona` by default!
     - In **AEM Assets View**, go to **Settings (⚙️) > General Settings > Search > Files > Add new form / Customize**, select **`Xdm Persona`** (`xdm:persona`) from the property dropdown, label it **`Recognized Faces / People`**, and click **Save**.
   - **AEM Admin UI Left Search Rail**: Go to **Tools > General > Search Forms > Assets Admin Search Rail > Edit**, drag a **Multi Value Property Predicate** (or **Property Predicate**) onto the form, set **Field Label** to `Recognized Faces`, and set **Property Name** to `./jcr:content/metadata/xdm:faceNames` (or `./jcr:content/metadata/xdm:persona`).

---

## Part 3: Adobe Developer Console & App Builder Deployment

### 3A. Deploy to Stage or Production

1. Install dependencies and configure `.env` from `.env.dist` (or `.env.example`):
   ```bash
   npm install --legacy-peer-deps
   cp .env.dist .env
   ```
2. Ensure `.env` includes your target AEM Author URL, a strong encryption secret and (optionally) the technical-account credentials used by the I/O Events ingestion action:
   ```dotenv
   AEM_HOST=https://author-p<program>-e<env>.adobeaemcloud.com
   AEM_AUTHOR_URL=https://author-p<program>-e<env>.adobeaemcloud.com
   # REQUIRED – generate with: openssl rand -base64 32
   ENCRYPTION_SECRET=<random-secret>
   # Used ONLY by the non-web ingest-event action
   AEM_SC_JSON=<base64-encoded-aem-service-credentials-json>
   # Keep false in production (enables seed/clear/export/import operations)
   ENABLE_MAINTENANCE_OPS=false
   ```
   > **Security notes:** `groups` and `settings` enforce `require-adobe-auth: true` at the Runtime gateway, while `ingest` enforces user IMS Bearer token authentication inside `buildActionContext()` (so Adobe I/O Events `GET ?challenge=` verification probes and webhook `POST` deliveries can reach the action without `x-gw-ims-org-id` headers). Web actions call AEM with the **signed-in user's** token and never with the technical account. As a result, users can only scan and tag assets they are allowed to modify in AEM. See [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md).
3. Select your Adobe Developer Console project & workspace (`Stage` or `Production`), download the workspace config, and deploy:
   ```bash
   aio login
   aio console org select
   aio console project select
   aio console workspace select
   aio console workspace download
   aio app use <downloaded-workspace-config>.json --overwrite
   rm -f <downloaded-workspace-config>.json

   # Deploy actions and web bundle to Adobe I/O Runtime & CDN
   aio app deploy

   # Subsequent updates to an already-published Production workspace (skips Exchange revoke/re-approve):
   npx aio app deploy --force-deploy
   ```
4. At the end of `aio app deploy`, the CLI prints the **AEM Assets View Extension Manager Preview URL**:
   ```text
   https://experience.adobe.com/aem/extension-manager/preview/<base64>
   ```

### 3B. Wire Automatic Upload Trigger via Adobe I/O Events

To have AEM automatically invoke the extension whenever an image finishes uploading into a DAM folder:

1. Open **[Adobe Developer Console](https://developer.adobe.com/console)** and open your project workspace (`Stage` or `Production`).
2. Click **Add Service > Event**.
3. **Step 1 — Select Event Provider**:
   - Choose **Experience Cloud > AEM Assets**, select your AEM Cloud Service Author instance, and click **Next**.
4. **Step 2 — Subscribe to Events**:
   - Check **`Asset processing completed`** (`aem.assets.asset.processing_completed`) and click **Next**.
5. **Step 3 — Configure Credentials**:
   - Check the **`OAuth Server-to-Server`** checkbox (keep the default credential name or enter `AEM Face Rec Event Cred`) and click **Next**.
6. **Step 4 — Event Registration Details & Delivery Method**:
   - **Event registration name**: `AEM Face Recognition Upload Trigger`
   - **How to receive events** (choose either option):
     - **Option A — `Runtime Action` (Recommended)**:
       - Select **`aem-assets-assetsview-1/ingest-event`** *(the non-web `web: 'no'` action entry in `ext.config.yaml`)*.
     - **Option B — `Webhook` (with OAuth Server-to-Server IMS auth enabled)**:
       - **Delivery style**: Select **`Single`** *(so each uploaded asset gets its own dedicated Runtime invocation)*.
       - **Webhook URL**: Paste your deployed `ingest` Web Action URL:
         ```text
         https://<your-namespace>.adobeio-static.net/api/v1/web/aem-assets-assetsview-1/ingest
         ```
   - Click **Save configured events**.

---

## Part 4: Entering Your AWS Key & Using the Extension in AEM

1. Open AEM Assets View using the **Extension Manager Preview URL** (or directly after publishing the extension to your org).
2. Click **`Face Groups`** in the top header bar of AEM Assets View.
3. Open the **`BYOK AWS Rekognition & Metadata Settings`** tab:
   - Enter your **AWS Region** (e.g., `us-east-1`), **AWS Access Key ID**, and **AWS Secret Access Key**.
   - Click **`Test AWS Connection & Verify Collection`**.
   - This both encrypts/saves your AWS credentials in App Builder storage and creates the `aem-assets-faces` Rekognition Collection in your AWS account.
   - Adjust the **Include unnamed placeholder labels (e.g. "Person #3") in `xdm:faceNames`** switch if you want to show or hide placeholder names on assets before a group is named, select your **AEM Processing Profile Name** from the dropdown, and optionally enable **Restrict group management to Administrators & Curator Groups** (adding any custom AEM Curator Groups such as `face-curators`), then click **`Save Settings & Sync Asset Metadata`**.

---

## Part 5: How Auto-Processing vs. Manual Scanning Works

| Trigger | Scope | How It Works |
| :--- | :--- | :--- |
| **1. Automatic Upload Event** (`Adobe I/O Events`) | **Only folders with `Face Recognition` Processing Profile** | When a new image finishes uploading in AEM, `ingest` checks if the asset's folder (or an ancestor folder) has the **`Face Recognition`** Processing Profile applied. If yes, it runs AWS Rekognition, crops `72×72` face avatars, matches/creates Face Groups, and writes `xdm:faceNames`. If no, it skips the upload. |
| **2. Selection Bar (`Recognize Faces`)** | **Works in any folder** | Select one or more images (or a folder) in the AEM Assets View grid and click **`Recognize Faces`** in the bottom action bar to scan them on demand. |
| **3. Modal (`Scan Current Folder`)** | **Works in any folder** | Inside the **`Face Groups`** modal, click **`Scan Current Folder`** in the top header to scan all images in the folder you are currently browsing. |
| **4. Asset Details Side Panel (`Recognized Faces`)** | **Works on any open asset** | Open any image in AEM Assets View and click the **`Recognized Faces`** icon in the right-hand side rail to view cropped face avatars, see bounding box locations on hover, name/rename people, or click **`Re-scan`**. |

---

## Part 6: Troubleshooting & Gotchas

| Symptom | Cause & Resolution |
| :--- | :--- |
| **AWS Error: `not authorized to perform: rekognition:DescribeCollection`** | The IAM user does not have Rekognition permissions attached yet. In AWS Console -> **IAM > Users > `<your-user>` > Add permissions > Attach policies directly**, attach **`AmazonRekognitionFullAccess`**. |
| **AEM Processing Profile `Save` button is disabled** | AEM does not allow saving an empty Processing Profile. On the **Basic** tab of the Processing Profile, check **`Create FPO rendition`** (leave the **Custom** tab empty) and click **Save**. |
| **`Runtime Action` dropdown is not shown in Developer Console Add Event wizard** | Adobe Developer Console only lists actions with `web: 'no'` in the `Runtime Action` dropdown (`aem-assets-assetsview-1/ingest-event`), or you can select **`Webhook`** (Delivery style: **`Single`**) and paste the `.../api/v1/web/aem-assets-assetsview-1/ingest` URL. |
| **`Face Groups` button disappears after a hard browser refresh** | Before an extension is published org-wide in Developer Console / Admin Console, AEM Assets View only loads it inside the preview session initiated by the `https://experience.adobe.com/aem/extension-manager/preview/...` URL. Re-open via the preview link or publish the Production workspace in Developer Console. |
| **Adobe I/O Events webhook registration marked `UNSTABLE` or `verification_failed`** | Ensure `ingest` in `ext.config.yaml` has `require-adobe-auth: false` at the Runtime gateway (user auth is enforced in-code via `buildActionContext()`), redeploy (`npx aio app deploy --force-deploy`), and click **Update / Save** on the event registration in Adobe Developer Console to re-verify and reset its status to `VERIFIED`. |
