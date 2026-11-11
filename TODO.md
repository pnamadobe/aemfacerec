# Project TODOs

## 1. Write an Adobe Coworker Skill (`aem-face-recognition`)
- [ ] Create a Coworker skill (`SKILL.md`) so Adobe Coworker knows about and can interact with this App Builder extension (`aem/assets/assetsview/1`).
- [ ] Document the dual interaction model in the skill:
  1. **Native AEM Asset Search / Read (Zero Runtime Call Needed)**:
     - Query `jcr:content/metadata/xdm:persona` and `jcr:content/metadata/xdm:faceNames` (`String[]`), `xdm:faceGroupIds` (`String[]`), and `xdm:faceCount` (`Long`) directly via AEM Assets APIs / MCP tools to find assets by person name or face count.
  2. **App Builder Runtime Web Actions (`ingest`, `groups`, `settings`)**:
     - `aem-assets-assetsview-1/ingest`:
       - `ingestAsset` (`{ operation: "ingestAsset", assetPath, assetId, force: true, rescan: true }`)
       - `browseFolder` (`{ operation: "browseFolder", folderPath }`)
       - `scanFolder` (`{ operation: "scanFolder", folderPath, force: true, rescan: false }`)
     - `aem-assets-assetsview-1/groups`:
       - `listGroups`, `listGroupOptions`, `getGroup`, `getAssetFaces`
       - `renameGroup`, `splitFaces`, `moveFaces`, `mergeGroups`, `deleteGroup`, `resyncAllAssets`
     - `aem-assets-assetsview-1/settings`:
       - `getSettings`, `saveSettings`, `testConnection`
- [ ] Include auth & header requirements (`Authorization: Bearer <IMS_TOKEN>`, `x-gw-ims-org-id`, and `aemHost` in the JSON payload) so all mutations go through `face-service.js` and keep AWS Rekognition, App Builder storage, and AEM metadata in sync.
- [ ] *(Optional)* Evaluate exposing a lightweight MCP wrapper (or Streamable HTTP MCP action in `ext.config.yaml`) if typed tool discovery is needed across multiple users.
