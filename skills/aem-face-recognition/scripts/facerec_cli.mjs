#!/usr/bin/env node
/**
 * CLI & Agent helper for the AEM Assets View Facial Recognition & Grouping App Builder Extension.
 *
 * Supports:
 *   node facerec_cli.mjs scan-folder <folder-url-or-path> [--rescan] [--json]
 *   node facerec_cli.mjs scan-asset <asset-url-or-path> [--json]
 *   node facerec_cli.mjs inspect-asset <asset-url-or-path> [--json]
 *   node facerec_cli.mjs related-assets <asset-url-or-path> [--mode any|all] [--no-auto-scan] [--json]
 *   node facerec_cli.mjs find-person <name-or-groupId...> [--mode any|all] [--json]
 *   node facerec_cli.mjs name-faces-ltr <asset-url-or-path> "<Name 1>" "<Name 2>" ... [--json]
 *   node facerec_cli.mjs rename <groupId-or-currentName> "<New Name>" [--json]
 *   node facerec_cli.mjs combine <sourceGroup-or-name> <targetGroup-or-name> [--json]
 *   node facerec_cli.mjs split <faceId> ["<Optional New Group Name>"] [--json]
 *   node facerec_cli.mjs delete <groupId-or-name> [--json]
 *   node facerec_cli.mjs triage-unnamed [--limit 20] [--json]
 *   node facerec_cli.mjs list-groups [--filter all|named|unnamed] [--query <q>] [--limit 60] [--json]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_REPO_DIR = '/Users/pnam/Sandbox/aemfacerec';
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|tiff?|bmp|avif|heic|heif|psd)$/i;

function loadEnvFile(repoDir = DEFAULT_REPO_DIR) {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(repoDir, '.env'),
    path.resolve(__dirname, '../../../.env')
  ];
  const env = {};
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (!(key in env)) env[key] = val;
      }
      break;
    }
  }
  return { ...env, ...process.env };
}

/**
 * Parses any AEM Assets View URL, AEM Touch UI URL, DAM path, or asset UUID into:
 * `{ damPath, assetId, isAssetFile, aemHost, imsTenant }`
 */
export function parseAemTarget(rawInput = '') {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return { damPath: '', assetId: '', isAssetFile: false, aemHost: '', imsTenant: '' };
  }

  let aemHost = '';
  let imsTenant = '';
  let damPath = '';
  let assetId = '';

  // Check for repoId=... in Experience Cloud URLs
  const repoMatch = trimmed.match(/[?&]repoId=([^&#]+)/i);
  if (repoMatch) {
    const repoHost = decodeURIComponent(repoMatch[1])
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '');
    if (/^author-[a-z0-9-]+\.adobeaemcloud\.com$/i.test(repoHost)) {
      aemHost = `https://${repoHost}`;
    }
  }

  // Check for direct https://author-p...-e....adobeaemcloud.com host
  if (!aemHost) {
    const authorMatch = trimmed.match(/https:\/\/author-[a-z0-9-]+\.adobeaemcloud\.com/i);
    if (authorMatch) aemHost = authorMatch[0].replace(/\/+$/, '');
  }

  // Check for /@<tenant>/ in Experience Cloud URLs
  const tenantMatch = trimmed.match(/\/@([a-zA-Z0-9_-]+)\//);
  if (tenantMatch) imsTenant = tenantMatch[1];

  // Extract /content/dam/... path if present
  const damIdx = trimmed.indexOf('/content/dam');
  if (damIdx >= 0) {
    let rawPath = trimmed.slice(damIdx).split(/[?#]/)[0];
    try {
      rawPath = decodeURIComponent(rawPath);
    } catch (e) {
      // keep raw
    }
    damPath = rawPath.replace(/\/+$/, '') || '/content/dam';
  } else if (trimmed.startsWith('content/dam')) {
    damPath = `/${trimmed.replace(/\/+$/, '')}`;
  } else if (/^(urn:aaid:aem:)?[0-9a-fA-F-]{8,64}$/.test(trimmed)) {
    assetId = trimmed;
  } else if (trimmed.startsWith('/')) {
    damPath = trimmed.replace(/\/+$/, '');
  }

  const isAssetFile = Boolean(assetId) || IMAGE_EXT_RE.test(damPath);
  return { damPath, assetId, isAssetFile, aemHost, imsTenant };
}

/**
 * Builds a direct AEM Assets View deep link (`experience.adobe.com`) that opens the asset
 * with the Recognized Faces side panel active.
 */
export function buildAssetsViewDeepLink(assetPath, { aemHost = '', namespace = '', imsTenant = '' } = {}) {
  if (!assetPath) return '';
  const cleanPath = String(assetPath).startsWith('/') ? String(assetPath) : `/${assetPath}`;
  const repoId = String(aemHost || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!repoId) return cleanPath;
  const tenantPart = imsTenant ? `/@${imsTenant}` : '';
  const panelPart = namespace ? `/${namespace}_face-recognition-panel` : '';
  return `https://experience.adobe.com/?repoId=${encodeURIComponent(repoId)}#${tenantPart}/assets/detail${panelPart}${cleanPath}`;
}

/**
 * Invokes a deployed App Builder Runtime action (`groups`, `ingest`, `settings`) via the
 * OpenWhisk REST API using `AIO_runtime_auth` and `AIO_runtime_namespace` from `.env`.
 */
async function invokeRuntimeAction(actionShortName, payload = {}, env = {}) {
  const namespace = env.AIO_runtime_namespace;
  const auth = env.AIO_runtime_auth;
  const apiHost = (env.AIO_runtime_apihost || 'https://adobeioruntime.net').replace(/\/+$/, '');

  if (!namespace || !auth) {
    throw new Error(
      'Missing AIO_runtime_namespace or AIO_runtime_auth in .env. Run from /Users/pnam/Sandbox/aemfacerec or set env vars.'
    );
  }

  const actionTargetMap = {
    groups: 'aem-assets-assetsview-1/__secured_groups',
    ingest: 'aem-assets-assetsview-1/ingest-event',
    settings: 'aem-assets-assetsview-1/__secured_settings'
  };
  const actionPath = actionTargetMap[actionShortName] || `aem-assets-assetsview-1/${actionShortName}`;
  const url = `${apiHost}/api/v1/namespaces/${encodeURIComponent(namespace)}/actions/${actionPath}?blocking=true&result=true`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(auth).toString('base64')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(`Runtime action '${actionPath}' returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  const statusCode = data.statusCode || res.status;
  const body = data.body !== undefined ? data.body : data;
  if (!res.ok || statusCode >= 400) {
    throw new Error(body?.error || data?.error || `Runtime action '${actionPath}' failed (HTTP ${statusCode})`);
  }
  return body;
}

function sortFacesLeftToRight(faces = []) {
  return [...faces].sort(
    (a, b) => (Number(a.boundingBox?.left) || 0) - (Number(b.boundingBox?.left) || 0)
  );
}

async function resolveGroupIdentifier(queryOrId, env) {
  const clean = String(queryOrId || '').trim();
  if (!clean) throw new Error('Group name or ID is required.');
  if (clean.startsWith('grp_')) return { groupId: clean, displayName: clean };

  const res = await invokeRuntimeAction(
    'groups',
    { operation: 'listGroups', query: clean, limit: 50 },
    env
  );
  const groups = res.groups || [];
  const exact = groups.find(
    (g) =>
      String(g.displayName || '').toLowerCase() === clean.toLowerCase() ||
      String(g.autoLabel || '').toLowerCase() === clean.toLowerCase() ||
      String(g.groupId || '').toLowerCase() === clean.toLowerCase()
  );
  const picked = exact || groups[0];
  if (!picked) {
    throw new Error(`No face group found matching "${clean}".`);
  }
  return picked;
}

function parseFlags(argv) {
  const positional = [];
  const flags = {
    rescan: false,
    json: false,
    mode: 'any',
    autoScan: true,
    filter: 'all',
    query: '',
    limit: 20
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--rescan' || arg === '--force-rescan') {
      flags.rescan = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--no-auto-scan') {
      flags.autoScan = false;
    } else if (arg === '--mode' && argv[i + 1]) {
      flags.mode = argv[++i];
    } else if (arg.startsWith('--mode=')) {
      flags.mode = arg.split('=')[1];
    } else if (arg === '--filter' && argv[i + 1]) {
      flags.filter = argv[++i];
    } else if (arg.startsWith('--filter=')) {
      flags.filter = arg.split('=')[1];
    } else if (arg === '--query' && argv[i + 1]) {
      flags.query = argv[++i];
    } else if (arg.startsWith('--query=')) {
      flags.query = arg.split('=')[1];
    } else if (arg === '--limit' && argv[i + 1]) {
      flags.limit = Number(argv[++i]) || 20;
    } else if (arg.startsWith('--limit=')) {
      flags.limit = Number(arg.split('=')[1]) || 20;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function stripAvatarsForJson(obj) {
  return JSON.parse(
    JSON.stringify(obj, (k, v) => (k === 'avatarDataUrl' || k === 'coverAvatarDataUrl' || k === 'previewDataUrl' ? undefined : v))
  );
}

async function main() {
  const env = loadEnvFile();
  const namespace = env.AIO_runtime_namespace || '';
  const defaultAemHost = env.AEM_HOST || env.AEM_AUTHOR_URL || '';

  const { positional, flags } = parseFlags(process.argv.slice(2));
  const command = (positional[0] || 'help').toLowerCase();

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`AEM Assets Facial Recognition & Grouping CLI
Usage:
  node facerec_cli.mjs scan-folder <folder-url-or-path> [--rescan] [--json]
  node facerec_cli.mjs scan-asset <asset-url-or-path> [--json]
  node facerec_cli.mjs inspect-asset <asset-url-or-path> [--json]
  node facerec_cli.mjs related-assets <asset-url-or-path> [--mode any|all] [--no-auto-scan] [--json]
  node facerec_cli.mjs find-person <name-or-groupId...> [--mode any|all] [--json]
  node facerec_cli.mjs name-faces-ltr <asset-url-or-path> "<Name 1>" "<Name 2>" ... [--json]
  node facerec_cli.mjs rename <groupId-or-currentName> "<New Name>" [--json]
  node facerec_cli.mjs combine <sourceGroup-or-name> <targetGroup-or-name> [--json]
  node facerec_cli.mjs split <faceId> ["<Optional New Group Name>"] [--json]
  node facerec_cli.mjs delete <groupId-or-name> [--json]
  node facerec_cli.mjs triage-unnamed [--limit 20] [--json]
  node facerec_cli.mjs list-groups [--filter all|named|unnamed] [--query <q>] [--limit 60] [--json]`);
    return;
  }

  // -------------------------------------------------------------------------
  // 1. scan-folder
  // -------------------------------------------------------------------------
  if (command === 'scan-folder') {
    const target = parseAemTarget(positional[1] || '/content/dam');
    const folderPath = target.damPath || '/content/dam';
    const browsed = await invokeRuntimeAction(
      'ingest',
      { operation: 'browseFolder', folderPath },
      env
    );
    const listedAssets = browsed.assets || [];
    const resolvedFolderPath = browsed.folderPath || folderPath;
    const excludedAssetCount = browsed.excludedAssetCount || 0;

    const toScan = [];
    const allResults = [];
    for (const a of listedAssets) {
      if (!flags.rescan && a.scanned) {
        allResults.push({
          assetPath: a.assetPath,
          status: 'skipped',
          reasonCode: 'already-scanned',
          faceCount: a.faceCount || 0,
          faceNames: a.faceNames || []
        });
      } else {
        toScan.push(a);
      }
    }

    if (!flags.json) {
      console.log(
        `Folder: ${resolvedFolderPath} (${listedAssets.length} eligible image(s), ${
          listedAssets.length - toScan.length
        } already scanned, ${toScan.length} queued to scan, ${excludedAssetCount} non-image/excluded file(s) ignored)`
      );
    }

    const BATCH_SIZE = 5;
    for (let idx = 0; idx < toScan.length; idx += BATCH_SIZE) {
      const batch = toScan.slice(idx, idx + BATCH_SIZE).map((a) => ({
        assetPath: a.assetPath,
        assetId: a.assetId,
        assetTitle: a.assetTitle,
        mimeType: a.mimeType || null
      }));
      // eslint-disable-next-line no-await-in-loop
      const batchRes = await invokeRuntimeAction(
        'ingest',
        {
          operation: 'scanFolder',
          folderPath: resolvedFolderPath,
          assets: batch,
          force: true,
          rescan: flags.rescan
        },
        env
      );
      const batchResults = batchRes.results || [];
      allResults.push(...batchResults);
      if (!flags.json) {
        for (const r of batchResults) {
          console.log(
            `  • ${r.assetPath.split('/').pop()}: ${r.status.toUpperCase()} (${r.faceCount || 0} face(s))${
              r.reason ? ` — ${r.reason}` : ''
            }${r.error ? ` — ${r.error}` : ''}`
          );
        }
      }
    }

    const processedCount = allResults.filter((r) => r.status === 'processed').length;
    const skippedCount = allResults.filter((r) => r.status === 'skipped').length;
    const errorCount = allResults.filter((r) => r.status === 'error').length;
    const totalFacesInFolder = allResults.reduce((sum, r) => sum + (Number(r.faceCount) || 0), 0);

    const out = {
      folderPath: resolvedFolderPath,
      totalEligibleImages: listedAssets.length,
      excludedAssetCount,
      processedCount,
      skippedCount,
      errorCount,
      totalFacesInFolder,
      subfolders: (browsed.folders || []).map((f) => f.folderPath),
      results: allResults
    };

    if (flags.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(
        `\nSummary: Analyzed ${processedCount} image(s), skipped ${skippedCount} already-scanned/ineligible image(s), ${errorCount} error(s). Total faces across folder: ${totalFacesInFolder}.`
      );
    }
    return;
  }

  // -------------------------------------------------------------------------
  // 2. scan-asset
  // -------------------------------------------------------------------------
  if (command === 'scan-asset') {
    const target = parseAemTarget(positional[1]);
    if (!target.damPath && !target.assetId) {
      throw new Error('Please provide an AEM asset URL, DAM path (/content/dam/...), or asset UUID.');
    }
    const res = await invokeRuntimeAction(
      'ingest',
      {
        operation: 'ingestAsset',
        assetPath: target.damPath || undefined,
        assetId: target.assetId || undefined,
        force: true,
        rescan: true
      },
      env
    );

    const sortedFaces = sortFacesLeftToRight(res.faces || []);
    if (flags.json) {
      console.log(
        JSON.stringify(
          stripAvatarsForJson({
            ...res,
            facesLeftToRight: sortedFaces.map((f, i) => ({
              positionFromLeft: i + 1,
              faceId: f.faceId,
              groupId: f.groupId,
              displayName: f.groupDisplayName,
              isNamed: Boolean(f.groupName),
              groupFaceCount: f.groupFaceCount,
              confidence: f.confidence,
              boundingBox: f.boundingBox
            }))
          }),
          null,
          2
        )
      );
      return;
    }

    if (res.skipped) {
      console.log(`Skipped ${res.assetPath}: ${res.reason}`);
      return;
    }

    console.log(`Scanned Asset: ${res.assetPath || res.assetId}`);
    console.log(`Detected Faces: ${sortedFaces.length}`);
    console.log(
      `Synced Metadata (${res.metadataProperty || 'xdm:faceNames'}): ${
        (res.faceNames || []).length > 0 ? res.faceNames.join(', ') : '(none — only unnamed placeholders)'
      }`
    );
    sortedFaces.forEach((f, idx) => {
      const xPct = Math.round((Number(f.boundingBox?.left) || 0) * 100);
      console.log(
        `  #${idx + 1} (from left, x=${xPct}%): ${f.groupDisplayName} [${
          f.groupName ? 'Named' : 'Unnamed Placeholder'
        }] — Group ${f.groupId} (${f.groupFaceCount} total face(s) in DAM, ${f.confidence}% conf)`
      );
    });
    return;
  }

  // -------------------------------------------------------------------------
  // 3. inspect-asset
  // -------------------------------------------------------------------------
  if (command === 'inspect-asset') {
    const target = parseAemTarget(positional[1]);
    if (!target.damPath && !target.assetId) {
      throw new Error('Please provide an AEM asset URL, DAM path (/content/dam/...), or asset UUID.');
    }
    const res = await invokeRuntimeAction(
      'groups',
      {
        operation: 'getAssetFaces',
        assetPath: target.damPath || undefined,
        assetId: target.assetId || undefined
      },
      env
    );
    const sortedFaces = sortFacesLeftToRight(res.faces || []);
    const deepLink = buildAssetsViewDeepLink(res.assetPath || target.damPath, {
      aemHost: target.aemHost || res.aemHost || defaultAemHost,
      namespace,
      imsTenant: target.imsTenant
    });

    if (flags.json) {
      console.log(
        JSON.stringify(
          stripAvatarsForJson({
            ...res,
            deepLink,
            facesLeftToRight: sortedFaces.map((f, i) => ({
              positionFromLeft: i + 1,
              faceId: f.faceId,
              groupId: f.groupId,
              displayName: f.groupDisplayName,
              isNamed: Boolean(f.groupName),
              groupFaceCount: f.groupFaceCount,
              confidence: f.confidence,
              boundingBox: f.boundingBox
            }))
          }),
          null,
          2
        )
      );
      return;
    }

    console.log(`Asset: ${res.assetPath || target.damPath || target.assetId}`);
    console.log(`Scanned: ${res.scanned ? 'Yes' : 'No (not yet scanned)'}`);
    console.log(`Faces Detected: ${sortedFaces.length}`);
    if (deepLink) console.log(`Assets View Link: ${deepLink}`);
    sortedFaces.forEach((f, idx) => {
      const xPct = Math.round((Number(f.boundingBox?.left) || 0) * 100);
      console.log(
        `  #${idx + 1} (from left, x=${xPct}%): ${f.groupDisplayName} [${
          f.groupName ? 'Named' : 'Unnamed Placeholder'
        }] — Group ${f.groupId} (${f.groupFaceCount} appearance(s) in DAM)`
      );
    });
    return;
  }

  // -------------------------------------------------------------------------
  // 4. related-assets ("what other assets have the same people as this image?")
  // -------------------------------------------------------------------------
  if (command === 'related-assets') {
    const target = parseAemTarget(positional[1]);
    if (!target.damPath && !target.assetId) {
      throw new Error('Please provide an AEM asset URL, DAM path (/content/dam/...), or asset UUID.');
    }

    let res = await invokeRuntimeAction(
      'groups',
      {
        operation: 'findRelatedAssets',
        assetPath: target.damPath || undefined,
        assetId: target.assetId || undefined,
        matchMode: flags.mode,
        limit: flags.limit
      },
      env
    );

    if (!res.sourceAsset?.scanned && flags.autoScan) {
      if (!flags.json) {
        console.log(`Asset has not been scanned yet — scanning ${target.damPath || target.assetId} first...`);
      }
      await invokeRuntimeAction(
        'ingest',
        {
          operation: 'ingestAsset',
          assetPath: target.damPath || undefined,
          assetId: target.assetId || undefined,
          force: true,
          rescan: true
        },
        env
      );
      res = await invokeRuntimeAction(
        'groups',
        {
          operation: 'findRelatedAssets',
          assetPath: target.damPath || undefined,
          assetId: target.assetId || undefined,
          matchMode: flags.mode,
          limit: flags.limit
        },
        env
      );
    }

    const effectiveHost = target.aemHost || res.aemHost || defaultAemHost;
    const enrichedRelated = (res.relatedAssets || []).map((a) => ({
      ...a,
      deepLink: buildAssetsViewDeepLink(a.assetPath, {
        aemHost: effectiveHost,
        namespace,
        imsTenant: target.imsTenant
      })
    }));

    if (flags.json) {
      console.log(JSON.stringify({ ...res, relatedAssets: enrichedRelated }, null, 2));
      return;
    }

    const src = res.sourceAsset || {};
    console.log(`Source Asset: ${src.assetPath || target.damPath || target.assetId}`);
    console.log(
      `People in Source Asset (${(src.people || []).length}, ordered left-to-right): ${
        (src.people || [])
          .map((p) => `#${p.positionFromLeft} ${p.displayName} (${p.totalAssetAppearances} asset(s) total)`)
          .join(', ') || 'None'
      }`
    );
    console.log(
      `\nOther DAM Assets Sharing ${flags.mode === 'all' ? 'ALL' : 'ANY'} of These People (${res.totalRelatedAssets} found):`
    );
    if (enrichedRelated.length === 0) {
      console.log('  (No other indexed assets contain the same people yet.)');
    } else {
      for (const item of enrichedRelated) {
        const sharedNames = item.sharedPeople.map((p) => p.displayName).join(', ');
        console.log(
          `  • ${item.assetPath} — shares ${item.sharedPeopleCount} person(s): [${sharedNames}] (total faces on asset: ${item.faceCount})`
        );
        if (item.deepLink) {
          console.log(`    Link: ${item.deepLink}`);
        }
      }
    }
    return;
  }

  // -------------------------------------------------------------------------
  // 5. find-person ("find all assets with <person1> [and <person2>]")
  // -------------------------------------------------------------------------
  if (command === 'find-person') {
    const queries = positional.slice(1).filter(Boolean);
    if (queries.length === 0) {
      throw new Error('Provide one or more person names or group IDs.');
    }
    const groupIds = queries.filter((q) => q.startsWith('grp_'));
    const personNames = queries.filter((q) => !q.startsWith('grp_'));

    const res = await invokeRuntimeAction(
      'groups',
      {
        operation: 'findRelatedAssets',
        groupIds: groupIds.length > 0 ? groupIds : undefined,
        personNames: personNames.length > 0 ? personNames : undefined,
        matchMode: flags.mode,
        limit: flags.limit
      },
      env
    );

    const effectiveHost = res.aemHost || defaultAemHost;
    const enrichedRelated = (res.relatedAssets || []).map((a) => ({
      ...a,
      deepLink: buildAssetsViewDeepLink(a.assetPath, {
        aemHost: effectiveHost,
        namespace
      })
    }));

    if (flags.json) {
      console.log(JSON.stringify({ ...res, relatedAssets: enrichedRelated }, null, 2));
      return;
    }

    console.log(
      `Matched People (${(res.targetPeople || []).length}): ${
        (res.targetPeople || []).map((p) => `${p.displayName} [${p.groupId}] (${p.assetCount} asset(s))`).join(', ') ||
        'None'
      }`
    );
    console.log(
      `Assets Matching (${flags.mode.toUpperCase()} mode, ${res.totalRelatedAssets} total):`
    );
    for (const item of enrichedRelated) {
      console.log(
        `  • ${item.assetPath} — contains: [${item.sharedPeople.map((p) => p.displayName).join(', ')}]`
      );
      if (item.deepLink) console.log(`    Link: ${item.deepLink}`);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // 6. name-faces-ltr ("name the faces in this asset from left to right")
  // -------------------------------------------------------------------------
  if (command === 'name-faces-ltr') {
    const target = parseAemTarget(positional[1]);
    const names = positional.slice(2);
    if ((!target.damPath && !target.assetId) || names.length === 0) {
      throw new Error('Usage: name-faces-ltr <asset-url-or-path> "<Name 1>" "<Name 2>" ...');
    }

    const assetRes = await invokeRuntimeAction(
      'groups',
      {
        operation: 'getAssetFaces',
        assetPath: target.damPath || undefined,
        assetId: target.assetId || undefined
      },
      env
    );
    const sortedFaces = sortFacesLeftToRight(assetRes.faces || []);
    if (sortedFaces.length === 0) {
      throw new Error(`No indexed faces found on ${target.damPath || target.assetId}. Run scan-asset first.`);
    }

    const updates = [];
    for (let i = 0; i < Math.min(sortedFaces.length, names.length); i++) {
      const newName = String(names[i] || '').trim();
      if (!newName || newName === '-') continue;
      const face = sortedFaces[i];
      // eslint-disable-next-line no-await-in-loop
      const renameRes = await invokeRuntimeAction(
        'groups',
        {
          operation: 'renameGroup',
          groupId: face.groupId,
          name: newName
        },
        env
      );
      updates.push({
        positionFromLeft: i + 1,
        groupId: face.groupId,
        previousName: face.groupDisplayName,
        newName: renameRes.group.displayName,
        syncedAssetCount: renameRes.syncedAssetCount
      });
    }

    if (flags.json) {
      console.log(JSON.stringify({ assetPath: assetRes.assetPath, updates }, null, 2));
    } else {
      for (const u of updates) {
        console.log(
          `  #${u.positionFromLeft} (from left): "${u.previousName}" -> "${u.newName}" (${u.groupId}, synced across ${u.syncedAssetCount} asset(s))`
        );
      }
    }
    return;
  }

  // -------------------------------------------------------------------------
  // 7. rename
  // -------------------------------------------------------------------------
  if (command === 'rename') {
    const groupTarget = await resolveGroupIdentifier(positional[1], env);
    const newName = positional[2];
    if (newName === undefined) {
      throw new Error('Usage: rename <groupId-or-currentName> "<New Name>"');
    }
    const res = await invokeRuntimeAction(
      'groups',
      {
        operation: 'renameGroup',
        groupId: groupTarget.groupId,
        name: newName
      },
      env
    );
    if (flags.json) {
      console.log(JSON.stringify(stripAvatarsForJson(res), null, 2));
    } else {
      console.log(
        `Renamed ${groupTarget.groupId} ("${groupTarget.displayName}") -> "${res.group.displayName}" and synced metadata across ${res.syncedAssetCount} asset(s).`
      );
    }
    return;
  }

  // -------------------------------------------------------------------------
  // 8. combine / split / delete
  // -------------------------------------------------------------------------
  if (command === 'combine' || command === 'merge') {
    const srcGrp = await resolveGroupIdentifier(positional[1], env);
    const dstGrp = await resolveGroupIdentifier(positional[2], env);
    const res = await invokeRuntimeAction(
      'groups',
      {
        operation: 'mergeGroups',
        sourceGroupIds: [srcGrp.groupId],
        targetGroupId: dstGrp.groupId
      },
      env
    );
    if (flags.json) {
      console.log(JSON.stringify(stripAvatarsForJson(res), null, 2));
    } else {
      console.log(
        `Combined "${srcGrp.displayName}" (${srcGrp.groupId}) into "${res.targetGroup.displayName}" (${res.targetGroup.groupId}) — moved ${res.movedFaceCount} face(s), synced ${res.syncedAssetCount} asset(s).`
      );
    }
    return;
  }

  if (command === 'split') {
    const faceId = positional[1];
    const newGroupName = positional[2] || null;
    if (!faceId) throw new Error('Usage: split <faceId> ["<Optional New Group Name>"]');
    const res = await invokeRuntimeAction(
      'groups',
      {
        operation: 'splitFaces',
        faceIds: [faceId],
        newGroupName
      },
      env
    );
    if (flags.json) {
      console.log(JSON.stringify(stripAvatarsForJson(res), null, 2));
    } else {
      console.log(
        `Split face ${faceId} into new group "${res.newGroup.displayName}" (${res.newGroup.groupId}) and synced ${res.syncedAssetCount} asset(s).`
      );
    }
    return;
  }

  if (command === 'delete') {
    const grp = await resolveGroupIdentifier(positional[1], env);
    const res = await invokeRuntimeAction(
      'groups',
      {
        operation: 'deleteGroup',
        groupId: grp.groupId
      },
      env
    );
    if (flags.json) {
      console.log(JSON.stringify(stripAvatarsForJson(res), null, 2));
    } else {
      console.log(
        `Deleted group "${res.deletedDisplayName}" (${res.deletedGroupId}): removed ${res.deletedFaceCount} face vector(s) & avatar(s) and updated ${res.syncedAssetCount} asset(s).`
      );
    }
    return;
  }

  // -------------------------------------------------------------------------
  // 9. triage-unnamed & list-groups
  // -------------------------------------------------------------------------
  if (command === 'triage-unnamed' || command === 'list-groups') {
    const filter = command === 'triage-unnamed' ? 'unnamed' : flags.filter;
    const res = await invokeRuntimeAction(
      'groups',
      {
        operation: 'listGroups',
        filter,
        query: flags.query,
        limit: flags.limit
      },
      env
    );
    if (flags.json) {
      console.log(JSON.stringify(stripAvatarsForJson(res), null, 2));
      return;
    }
    console.log(
      `Face Groups (Filter: ${filter}, Total Groups: ${res.totalGroups} [${res.namedCount} named, ${res.unnamedCount} unnamed], Total Faces: ${res.totalFaces}, Total Assets: ${res.totalAssets}):`
    );
    for (const g of res.groups || []) {
      console.log(
        `  • ${g.displayName} [${g.groupId}] — ${g.faceCount} face(s) across ${g.assetCount} asset(s)${
          g.isNamed ? '' : ' (Unnamed Placeholder)'
        }`
      );
    }
    return;
  }

  throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
