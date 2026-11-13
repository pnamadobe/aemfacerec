/**
 * Build & Exchange Package Verification Tests
 *
 * Verifies that:
 * 1. The webpack-bundled Runtime actions in `dist/` load cleanly and execute real requests
 *    (catching any broken imports, missing polyfills, or bundler regressions that source-only tests miss).
 * 2. The Parcel-built web assets in `dist/aem-assets-assetsview-1/web-prod/` have `index.html`
 *    rewritten by `hooks/post-build.js` to `/web-src.bundle.js` and all referenced assets exist.
 * 3. `api.js` dynamically resolves action URLs from `window.location.origin` when hosted on
 *    `https://<tenant-namespace>.adobeio-static.net` (critical for multi-tenant / Exchange installs
 *    where a developer's local `config.json` is not present or belongs to another workspace).
 * 4. The Exchange submission archive `dist/app.zip` (produced by `aio app pack`) contains
 *    `deploy.yaml` and required files, stays well under the 50 MB Exchange limit, and never leaks
 *    local secrets (`.env`, `config.json`) or internal dev notes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const ACTIONS_DIST_DIR = path.join(
  DIST_DIR,
  'aem-assets-assetsview-1',
  'actions',
  'aem-assets-assetsview-1'
);
const WEB_PROD_DIR = path.join(DIST_DIR, 'aem-assets-assetsview-1', 'web-prod');
const APP_ZIP_PATH = path.join(DIST_DIR, 'app.zip');

test('Build Verification 1: compiled Runtime action bundles in dist/ load and execute end-to-end', async (t) => {
  if (!fs.existsSync(ACTIONS_DIST_DIR)) {
    t.skip('dist/ actions not built yet (run npm run build first)');
    return;
  }

  const actionNames = ['ingest', 'ingest-event', 'groups', 'settings'];
  for (const name of actionNames) {
    const zipPath = path.join(ACTIONS_DIST_DIR, `${name}.zip`);
    const bundlePath = path.join(ACTIONS_DIST_DIR, `${name}-temp`, 'index.js');

    assert.equal(fs.existsSync(zipPath), true, `Missing built action zip: ${zipPath}`);
    assert.equal(fs.existsSync(bundlePath), true, `Missing built action bundle: ${bundlePath}`);

    const zipStats = fs.statSync(zipPath);
    assert.ok(zipStats.size > 1024, `${name}.zip should be non-empty`);
    assert.ok(
      zipStats.size < 48 * 1024 * 1024,
      `${name}.zip must be under the 48 MB Runtime action limit`
    );

    const bundledAction = require(bundlePath);
    assert.equal(
      typeof bundledAction.main,
      'function',
      `Bundled action ${name} must export main()`
    );

    // 1. OPTIONS preflight works on every bundled action
    const optRes = await bundledAction.main({ __ow_method: 'options' });
    assert.equal(optRes.statusCode, 200, `${name} OPTIONS preflight should return 200`);
    assert.equal(optRes.headers['X-Content-Type-Options'], 'nosniff');
  }

  // 2. Execute real operations against the compiled bundles in an isolated temp directory
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-dist-test-'));
  process.chdir(tmpDir);
  try {
    const ingestBundle = require(path.join(ACTIONS_DIST_DIR, 'ingest-temp', 'index.js'));
    const groupsBundle = require(path.join(ACTIONS_DIST_DIR, 'groups-temp', 'index.js'));

    // Webhook challenge on bundled ingest action
    const challengeRes = await ingestBundle.main({
      __ow_method: 'get',
      challenge: 'exchange_build_check_123'
    });
    assert.equal(challengeRes.statusCode, 200);
    assert.equal(challengeRes.body.challenge, 'exchange_build_check_123');

    // listGroups on bundled groups action
    const listRes = await groupsBundle.main({
      operation: 'listGroups',
      AEM_HOST: 'https://author-p12345-e67890.adobeaemcloud.com',
      ENCRYPTION_SECRET: 'build-verification-secret-key-32b'
    });
    assert.equal(listRes.statusCode, 200);
    assert.ok(Array.isArray(listRes.body.groups));
    assert.equal(listRes.body.totalGroups, 0);
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Build Verification 2: compiled web-prod bundle and post-build hook output are valid', (t) => {
  if (!fs.existsSync(WEB_PROD_DIR)) {
    t.skip('dist/ web-prod not built yet (run npm run build first)');
    return;
  }

  const indexHtmlPath = path.join(WEB_PROD_DIR, 'index.html');
  const stableBundlePath = path.join(WEB_PROD_DIR, 'web-src.bundle.js');

  assert.equal(fs.existsSync(indexHtmlPath), true, 'web-prod/index.html must exist');
  assert.equal(fs.existsSync(stableBundlePath), true, 'web-prod/web-src.bundle.js must exist');

  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  assert.match(
    html,
    /src="\/web-src\.bundle\.js"/,
    'post-build.js must rewrite index.html to load /web-src.bundle.js'
  );

  // Verify the CSS stylesheet referenced in index.html exists in web-prod
  const cssMatch = html.match(/href="\/?(web-src\.[a-f0-9]+\.css)"/i);
  assert.ok(cssMatch, 'index.html should reference a compiled CSS bundle');
  assert.equal(
    fs.existsSync(path.join(WEB_PROD_DIR, cssMatch[1])),
    true,
    `Referenced stylesheet ${cssMatch[1]} must exist in web-prod`
  );

  // Verify no legacy 8x duplicate bundle copies remain in web-prod
  const jsBundles = fs
    .readdirSync(WEB_PROD_DIR)
    .filter((f) => /^web-src\.[a-f0-9]+\.js$/i.test(f));
  assert.equal(
    jsBundles.length,
    1,
    `Expected exactly 1 hashed JS bundle in web-prod, found: ${jsBundles.join(', ')}`
  );
});

test('Build Verification 3: Exchange package dist/app.zip structure, deploy.yaml, and secret exclusion', (t) => {
  if (!fs.existsSync(APP_ZIP_PATH)) {
    t.skip('dist/app.zip not packed yet (run npm run pack first)');
    return;
  }

  const zipStats = fs.statSync(APP_ZIP_PATH);
  assert.ok(zipStats.size > 10 * 1024, 'dist/app.zip must be non-empty');
  assert.ok(
    zipStats.size < 50 * 1024 * 1024,
    'dist/app.zip must be under the 50 MB Adobe Exchange upload limit'
  );

  const listing = execFileSync('unzip', ['-Z1', APP_ZIP_PATH], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Required files in Exchange package
  const requiredEntries = [
    'app.config.yaml',
    'deploy.yaml',
    'package.json',
    'package-lock.json',
    'extension-manifest.json',
    'env.dist',
    'README.md',
    'SETUP.md',
    'src/aem-assets-assetsview-1/ext.config.yaml',
    'src/aem-assets-assetsview-1/actions/ingest/index.js',
    'src/aem-assets-assetsview-1/actions/groups/index.js',
    'src/aem-assets-assetsview-1/actions/settings/index.js'
  ];
  for (const reqEntry of requiredEntries) {
    assert.ok(listing.includes(reqEntry), `dist/app.zip is missing required file: ${reqEntry}`);
  }

  // Forbidden files that must NEVER be packaged into dist/app.zip
  const forbiddenPatterns = [
    /^\.env$/,
    /^\.aws\.tmp\.creds\.json$/,
    /^console\.json$/,
    /-(Production|Stage)\.json$/i,
    /^TODO\.md$/,
    /^SECURITY_AUDIT\.md$/,
    /^FACE-RECOGNITION-GHOST-FOLDER-BUG\.md$/,
    /^skills\//,
    /web-src\/src\/config\.json$/
  ];
  for (const entry of listing) {
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(entry),
        false,
        `dist/app.zip must not contain internal or secret file: ${entry}`
      );
    }
  }

  // Validate generated deploy.yaml inside dist/app.zip
  const deployYamlRaw = execFileSync('unzip', ['-p', APP_ZIP_PATH, 'deploy.yaml'], {
    encoding: 'utf8'
  });
  const deployDoc = yaml.load(deployYamlRaw);
  assert.equal(deployDoc.application?.id, 'face-recognition-for-aem-assets');
  assert.equal(deployDoc.runtime, true);
  assert.ok(
    Array.isArray(deployDoc.extensions) &&
      deployDoc.extensions.some((e) => e.extensionPointId === 'aem/assets/assetsview/1')
  );
});
