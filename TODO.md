# Project TODOs

## 1. Write an Adobe Coworker Skill (`aem-face-recognition`) — ✅ Completed
- [x] Created and installed the `aem-face-recognition` skill (`skills/aem-face-recognition/SKILL.md` and `~/.claude/skills/aem-face-recognition/SKILL.md`) along with the `facerec_cli.mjs` helper (`skills/aem-face-recognition/scripts/facerec_cli.mjs`).
- [x] Added the `findRelatedAssets` backend operation to `face-service.js` and `actions/groups/index.js` (with left-to-right face sorting and co-appearance ranking across both named people and unnamed `Person #N` placeholders).
- [x] Wired `AEM_SC_JSON` and `AEM_DEV_TOKEN` into `groups` and `settings` in `ext.config.yaml` for non-web OpenWhisk API invocations so CLI/Coworker renames, merges, splits, and deletes sync `xdm:faceNames` and `xdm:persona` back to AEM Author.
- [ ] *(Optional Future Enhancement)* Expose a Streamable HTTP MCP endpoint action in `ext.config.yaml` if remote zero-install tool discovery is needed across multiple external machines.
