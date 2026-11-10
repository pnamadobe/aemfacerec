/**
 * End-to-end UI test: renders the real Admin Console (React Spectrum) in jsdom, wired to the
 * real Runtime actions and a real (temporary) local database, with only the AEM host
 * connection (@adobe/uix-guest) and AWS/AEM clients mocked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const { JSDOM } = require('jsdom');

// ---------------------------------------------------------------------------
// Browser environment
// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://localhost/index.html#/admin',
  pretendToBeVisual: true
});
const { window } = dom;
Object.defineProperty(global, 'window', { value: window, configurable: true, writable: true });
for (const key of Object.getOwnPropertyNames(window)) {
  if (key in global || key.startsWith('_')) continue;
  try {
    Object.defineProperty(global, key, { value: window[key], configurable: true, writable: true });
  } catch (e) {
    // some properties are not copyable; ignore
  }
}
// React's scheduler would otherwise hold a MessagePort open and keep Node from exiting
global.MessageChannel = undefined;
window.MessageChannel = undefined;
window.CSS = { supports: () => false, escape: (s) => String(s) };
global.CSS = window.CSS;
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.ResizeObserver = window.ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = function () {};
global.IS_REACT_ACT_ENVIRONMENT = true;

// Stylesheets are handled by the bundler in the real build; class names are enough here
Module._extensions['.css'] = function (module) {
  module.exports = new Proxy({}, { get: (_, key) => (key === '__esModule' ? false : String(key)) });
};

// Transpile web-src (JSX/ESM) on the fly, the same way the build's .babelrc does
const WEB_SRC = path.join(__dirname, '../web-src/src');
const originalJsLoader = Module._extensions['.js'];
Module._extensions['.js'] = function (module, filename) {
  if (filename.startsWith(WEB_SRC)) {
    const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
      filename,
      babelrc: false,
      configFile: false,
      presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
      plugins: [require.resolve('@babel/plugin-transform-react-jsx')]
    });
    module._compile(code, filename);
    return;
  }
  originalJsLoader(module, filename);
};

// Mock the AEM host connection: resolves with an IMS token after a short delay
const IMS_TOKEN = 'test-ims-token';
const awsCommands = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@aws-sdk/client-rekognition') {
    // Never call real AWS from tests: every command succeeds with an empty result
    const commands = {};
    for (const name of ['CreateCollection', 'DescribeCollection', 'IndexFaces', 'SearchUsers', 'SearchFaces', 'CreateUser', 'DeleteUser', 'AssociateFaces', 'DisassociateFaces', 'DeleteFaces']) {
      commands[`${name}Command`] = class {
        constructor(input) {
          this.input = input;
        }
      };
      Object.defineProperty(commands[`${name}Command`], 'name', { value: `${name}Command` });
    }
    return {
      ...commands,
      RekognitionClient: class {
        constructor() {
          this.config = {};
        }
        async send(command) {
          awsCommands.push(command.constructor.name);
          return {};
        }
      }
    };
  }
  if (request === '@adobe/uix-guest') {
    return {
      attach: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return {
          host: { auth: { getIMSInfo: async () => ({ accessToken: IMS_TOKEN, imsOrg: 'ORG@AdobeOrg' }) } },
          sharedContext: null
        };
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const React = require('react');
const { render, screen, fireEvent, waitFor, within, cleanup } = require('@testing-library/react');
const { Provider, defaultTheme } = require('@adobe/react-spectrum');
const { MemoryRouter } = require('react-router-dom');

// ---------------------------------------------------------------------------
// Backend: real actions + real storage in a temp working directory
// ---------------------------------------------------------------------------
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aem-facerec-ui-'));
const originalCwd = process.cwd();
process.chdir(workDir);

const { createStorage } = require('../actions/lib/storage');
const groupsAction = require('../actions/groups/index');
const settingsAction = require('../actions/settings/index');
const ingestAction = require('../actions/ingest/index');

const AVATAR = `data:image/jpeg;base64,${Buffer.alloc(300, 7).toString('base64')}`;
const GROUP_COUNT = 75; // more than one page of 60

async function seedDatabase() {
  const storage = await createStorage({});
  const db = { groups: {}, faces: {}, assets: {}, counters: { nextPersonNumber: GROUP_COUNT + 1 } };
  const now = new Date().toISOString();
  for (let i = 0; i < GROUP_COUNT; i++) {
    const groupId = `grp_${String(i).padStart(3, '0')}`;
    // grp_000 is large (70 faces) to exercise "load more faces"; grp_001 and grp_002 are named
    const faceTotal = i === 0 ? 70 : 1;
    const faceIds = [];
    for (let f = 0; f < faceTotal; f++) {
      const faceId = `face-${i}-${f}`;
      const assetId = `asset-${i}-${f}`;
      faceIds.push(faceId);
      db.faces[faceId] = {
        faceId,
        groupId,
        assetId,
        assetPath: `/content/dam/ui/${assetId}.jpg`,
        assetTitle: `${assetId}.jpg`,
        boundingBox: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
        confidence: 99,
        avatarDataUrl: AVATAR,
        createdAt: now
      };
      db.assets[assetId] = {
        assetId,
        assetPath: `/content/dam/ui/${assetId}.jpg`,
        assetTitle: `${assetId}.jpg`,
        faceIds: [faceId],
        scannedAt: now
      };
    }
    db.groups[groupId] = {
      groupId,
      name: i === 1 ? 'Alice Example' : i === 2 ? 'Bob Example' : null,
      autoLabel: `Person #${i + 1}`,
      coverFaceId: faceIds[0],
      faceIds,
      createdAt: now,
      updatedAt: now
    };
  }
  db.assets['already-id'] = {
    assetId: 'already-id',
    assetPath: '/content/dam/already.jpg',
    assetTitle: 'already.jpg',
    faceIds: [],
    scannedAt: now
  };
  await storage.saveDatabase(db);
  await storage.saveSettings({ awsAccessKeyId: 'AKIATEST', awsSecretAccessKey: 'test-secret' });
  return storage;
}

// Route the UI's fetch() calls to the real actions, recording every request
const requests = [];
const ACTIONS = { groups: groupsAction, settings: settingsAction, ingest: ingestAction };
window.__AIO_ACTION_URLS__ = {
  groups: 'https://runtime.test/api/v1/web/pkg/groups',
  settings: 'https://runtime.test/api/v1/web/pkg/settings',
  ingest: 'https://runtime.test/api/v1/web/pkg/ingest'
};
const aemRequests = [];
const jpegJs = require('jpeg-js');
const SAMPLE_JPEG = Buffer.from(
  jpegJs.encode({ data: Buffer.alloc(400 * 300 * 4, 120), width: 400, height: 300 }, 80).data
);
const damEntity = (name, format) => ({ class: ['assets/asset'], properties: { name, metadata: { 'dc:format': format } } });
// /content/dam listing: one already-scanned image, one new image, one PDF
const DAM_ROOT_LISTING = [
  damEntity('already.jpg', 'image/jpeg'),
  damEntity('new.jpg', 'image/jpeg'),
  damEntity('doc.pdf', 'application/pdf')
];
function jsonResponse(obj) {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => text, json: async () => obj };
}
global.fetch = async (url, opts = {}) => {
  // Backend -> AEM calls (metadata write-back): accept them
  if (String(url).startsWith('https://author-p1-e1.adobeaemcloud.com/')) {
    aemRequests.push({ url: String(url), method: opts.method || 'GET' });
    if (String(url).includes('/api/assets.json')) {
      return jsonResponse({ entities: DAM_ROOT_LISTING });
    }
    if (String(url).includes('/renditions/')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
        arrayBuffer: async () => SAMPLE_JPEG
      };
    }
    return jsonResponse({});
  }
  const actionName = String(url).split('/').pop();
  const body = JSON.parse(opts.body || '{}');
  const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  requests.push({ action: actionName, body, headers });
  const res = await ACTIONS[actionName].main({
    ...body,
    __ow_method: 'post',
    __ow_headers: headers,
    // Deployment inputs (normally injected by Runtime)
    AEM_HOST: 'https://author-p1-e1.adobeaemcloud.com'
  });
  const status = res.statusCode || 200;
  const text = JSON.stringify(res.body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
};
window.fetch = global.fetch;

const AdminConsole = require('../web-src/src/components/AdminConsole').default;

function renderConsole() {
  return render(
    React.createElement(
      Provider,
      { theme: defaultTheme, colorScheme: 'light' },
      React.createElement(MemoryRouter, null, React.createElement(AdminConsole))
    )
  );
}

function groupRequests(operation) {
  return requests.filter((r) => r.action === 'groups' && r.body.operation === operation);
}

function groupCardTitles() {
  return screen.queryAllByText(/^(Person #\d+|Alice Example|Bob Example|Renamed Person)$/).map((el) => el.textContent);
}

test.before(async () => {
  await seedDatabase();
});

test.after(() => {
  cleanup();
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
  Module._load = originalLoad;
  Module._extensions['.js'] = originalJsLoader;
  window.close();
});

test.beforeEach((t) => {
  requests.length = 0;
  process.stderr.write(`[ui-test] start: ${t.name}\n`);
});

test.afterEach((t) => {
  cleanup();
  process.stderr.write(`[ui-test] end: ${t.name}\n`);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('UI: loads the first page only after the IMS token is available', async () => {
  renderConsole();
  await screen.findByText('Alice Example');

  assert.ok(requests.length > 0);
  for (const r of requests) {
    assert.equal(r.headers.authorization, `Bearer ${IMS_TOKEN}`, `${r.action}/${r.body.operation} had no token`);
  }
  const [list] = groupRequests('listGroups');
  assert.equal(list.body.offset, 0);
  assert.equal(list.body.limit, 60);
  assert.equal(groupRequests('listGroupOptions').length, 1);

  // First page shows 60 cards, named people first
  await waitFor(() => assert.equal(groupCardTitles().length, 60));
  assert.deepEqual(groupCardTitles().slice(0, 2), ['Alice Example', 'Bob Example']);
  // KPI and filter counts come from server totals, not the page
  screen.getByText(`Showing 1–60 of ${GROUP_COUNT} group(s)`);
});

test('UI: Next/Previous page through groups', async () => {
  renderConsole();
  await screen.findByText(`Showing 1–60 of ${GROUP_COUNT} group(s)`);

  fireEvent.click(screen.getByText('Next'));
  await screen.findByText(`Showing 61–${GROUP_COUNT} of ${GROUP_COUNT} group(s)`);
  await waitFor(() => assert.equal(groupCardTitles().length, GROUP_COUNT - 60));
  assert.equal(groupRequests('listGroups').at(-1).body.offset, 60);
  assert.equal(screen.getByText('Next').closest('button').disabled, true);

  fireEvent.click(screen.getByText('Previous'));
  await screen.findByText(`Showing 1–60 of ${GROUP_COUNT} group(s)`);
});

test('UI: search is debounced, sent to the server, and resets to page 1', async () => {
  renderConsole();
  await screen.findByText(`Showing 1–60 of ${GROUP_COUNT} group(s)`);
  fireEvent.click(screen.getByText('Next'));
  await screen.findByText(`Showing 61–${GROUP_COUNT} of ${GROUP_COUNT} group(s)`);

  const before = groupRequests('listGroups').length;
  const input = screen.getByLabelText('Search by Name or ID');
  for (const partial of ['b', 'bo', 'bob']) {
    fireEvent.change(input, { target: { value: partial } });
  }

  await waitFor(() => assert.deepEqual(groupCardTitles(), ['Bob Example']));
  const searches = groupRequests('listGroups').slice(before);
  assert.equal(searches.length, 1, `expected one debounced request, got ${searches.map((r) => r.body.query)}`);
  assert.equal(searches[0].body.query, 'bob');
  assert.equal(searches[0].body.offset, 0);

  fireEvent.change(input, { target: { value: 'no such person' } });
  await screen.findByText('No face groups match this filter or search.');
});

test('UI: opening a big group loads faces in pages with "Load more"', async () => {
  renderConsole();
  await screen.findByText('Alice Example');

  const bigCard = screen.getAllByText('Person #1').find((el) => el.closest('div[style*="cursor: pointer"]'));
  fireEvent.click(bigCard);

  await screen.findByText('Faces in this Group (70)');
  assert.equal(groupRequests('getGroup').at(-1).body.groupId, 'grp_000');
  assert.equal(screen.getAllByAltText(/^face-0-/).length, 60);

  fireEvent.click(screen.getByText('Load more faces (60 of 70)'));
  await waitFor(() => assert.equal(screen.getAllByAltText(/^face-0-/).length, 70));
  assert.equal(groupRequests('getGroup').at(-1).body.faceOffset, 60);
  assert.equal(screen.queryByText(/Load more faces/), null);
});

test('UI: renaming a group updates the list and keeps the selection', async () => {
  renderConsole();
  await screen.findByText('Alice Example');
  const card = screen.getAllByText('Person #4').find((el) => el.closest('div[style*="cursor: pointer"]'));
  fireEvent.click(card);
  await screen.findByText('Faces in this Group (1)');

  const nameInput = screen.getByLabelText(/Person Name/);
  fireEvent.change(nameInput, { target: { value: 'Renamed Person' } });
  fireEvent.click(screen.getByText('Save Name'));

  await screen.findByText(/Saved name "Renamed Person"/);
  await waitFor(() => assert.ok(groupCardTitles().includes('Renamed Person')));
  screen.getByText('Manage Group: Renamed Person');
});

test('UI: merging the selected group into another selects the target (no stale "not found")', async () => {
  renderConsole();
  await screen.findByText('Alice Example');
  const card = screen.getAllByText('Person #10').find((el) => el.closest('div[style*="cursor: pointer"]'));
  fireEvent.click(card);
  await screen.findByText('Manage Group: Person #10');

  // React Spectrum renders a hidden native <select> (inside a <label>) for pickers; drive that one
  const select = screen
    .getAllByText('Combine this entire group into another group:')
    .map((el) => el.closest('label')?.querySelector('select'))
    .find(Boolean);
  assert.ok(select, 'combine picker hidden <select> not found');
  const bobOption = within(select).getByText(/^Bob Example/);
  fireEvent.change(select, { target: { value: bobOption.value } });

  await screen.findByText(/Combined 1 face\(s\) into "Bob Example"/);
  await screen.findByText('Manage Group: Bob Example');
  assert.ok(awsCommands.includes('DisassociateFacesCommand') && awsCommands.includes('AssociateFacesCommand'));
  assert.equal(screen.queryByText(/not found/), null);
  await waitFor(() => assert.ok(!groupCardTitles().includes('Person #10')));
});

const AssetDetailsSidePanel = require('../web-src/src/components/AssetDetailsSidePanel').default;

function renderSidePanel(assetPath) {
  window.location.hash = `#/asset-details?assetPath=${encodeURIComponent(assetPath)}`;
  return render(
    React.createElement(
      Provider,
      { theme: defaultTheme, colorScheme: 'light' },
      React.createElement(MemoryRouter, null, React.createElement(AssetDetailsSidePanel))
    )
  );
}

test('UI side panel: loads only this asset\'s faces, with the IMS token, and never the full group list', async () => {
  renderSidePanel('/content/dam/ui/asset-1-0.jpg');
  await screen.findAllByText(/Alice Example/);

  assert.ok(requests.length > 0);
  for (const r of requests) {
    assert.equal(r.headers.authorization, `Bearer ${IMS_TOKEN}`, `${r.action}/${r.body.operation} had no token`);
  }
  assert.deepEqual(
    requests.map((r) => r.body.operation),
    ['getAssetFaces'],
    'side panel should make exactly one request'
  );
  assert.equal(screen.getAllByAltText('Alice Example').length >= 1, true);
});

test('UI side panel: unscanned asset shows the scan prompt instead of an error', async () => {
  renderSidePanel('/content/dam/ui/never-scanned.jpg');
  await screen.findByText('No faces indexed for this asset yet.');
  screen.getByText('Scan Asset with AWS Rekognition');
});

test('UI cost: folder scan analyzes only new images and explains what was skipped', async () => {
  renderConsole();
  await screen.findByText('Alice Example');
  const indexCallsBefore = awsCommands.filter((c) => c === 'IndexFacesCommand').length;

  fireEvent.click(screen.getByText('Scan Current Folder'));
  await screen.findByText(
    'Folder scan complete for /content/dam. Analyzed 1 image(s) (0 face(s)). Skipped 1: 1 already scanned. 1 non-image or excluded file type(s) ignored.'
  );
  const scanCalls = requests.filter((r) => r.action === 'ingest' && r.body.operation === 'scanFolder');
  assert.equal(scanCalls.length, 1);
  assert.deepEqual(scanCalls[0].body.assets.map((a) => a.assetPath), ['/content/dam/new.jpg']);
  assert.equal(scanCalls[0].body.rescan, false);
  assert.equal(awsCommands.filter((c) => c === 'IndexFacesCommand').length - indexCallsBefore, 1);

  // Scanning again: nothing new, so no AWS calls at all
  requests.length = 0;
  const awsBefore = awsCommands.length;
  await waitFor(() => assert.equal(screen.getByText('Scan Current Folder').closest('button').disabled, false));
  fireEvent.click(screen.getByText('Scan Current Folder'));
  await screen.findByText(
    'Folder scan complete for /content/dam. Analyzed 0 image(s) (0 face(s)). Skipped 2: 2 already scanned. 1 non-image or excluded file type(s) ignored.'
  );
  assert.equal(requests.filter((r) => r.body.operation === 'scanFolder').length, 0);
  assert.equal(awsCommands.length, awsBefore);

  // With "Include already-scanned images" both images are analyzed again
  const includeScanned = screen.getByLabelText('Include already-scanned images');
  await waitFor(() => assert.equal(includeScanned.disabled, false));
  fireEvent.click(includeScanned);
  assert.equal(includeScanned.checked, true);
  await waitFor(() => assert.equal(screen.getByText('Scan Current Folder').closest('button').disabled, false));
  fireEvent.click(screen.getByText('Scan Current Folder'));
  await screen.findByText(
    'Folder scan complete for /content/dam. Analyzed 2 image(s) (0 face(s)). 1 non-image or excluded file type(s) ignored.'
  );
  const rescanCall = requests.filter((r) => r.body.operation === 'scanFolder').at(-1);
  assert.equal(rescanCall.body.rescan, true);
  assert.equal(rescanCall.body.assets.length, 2);
});

test('UI cost: cost-control settings load, save, and are validated', async () => {
  renderConsole();
  await screen.findByText('Alice Example');
  fireEvent.click(
    screen.getAllByText('BYOK AWS Rekognition & Metadata Settings').find((el) => el.closest('[role="tab"]'))
  );

  const typesField = await screen.findByLabelText('Image types to analyze (comma-separated)');
  await waitFor(() => assert.match(typesField.value, /^image\/jpeg, image\/png/));
  const sizeField = screen.getByLabelText('Skip images smaller than (pixels, shorter side)');
  assert.equal(sizeField.value, '200');

  fireEvent.change(typesField, { target: { value: 'image/jpeg, image/png' } });
  fireEvent.change(sizeField, { target: { value: '120' } });
  fireEvent.click(screen.getByText('Save Settings & Sync Asset Metadata'));
  await screen.findByText(/^Settings saved\./);

  const save = requests.filter((r) => r.action === 'settings' && r.body.operation === 'saveSettings').at(-1);
  assert.deepEqual(save.body.settings.allowedImageTypes, ['image/jpeg', 'image/png']);
  assert.equal(save.body.settings.minImageSize, 120);
  const stored = await (await createStorage({})).getSettings();
  assert.deepEqual(stored.allowedImageTypes, ['image/jpeg', 'image/png']);
  assert.equal(stored.minImageSize, 120);

  // Invalid input shows the server's validation message
  fireEvent.change(typesField, { target: { value: 'application/pdf' } });
  fireEvent.click(screen.getByText('Save Settings & Sync Asset Metadata'));
  await screen.findByText(/Invalid image type\(s\): application\/pdf/);
});

test('UI UX: top header is sticky so Close/actions stay visible on scroll, and combine dropdowns include face avatars', async () => {
  renderConsole();
  await screen.findByText('Alice Example');

  const heading = screen.getByText('AEM Facial Recognition & Group Management');
  const stickyBar = heading.closest('div[style*="position: sticky"]');
  assert.ok(stickyBar, 'top navigation bar should use position: sticky');
  assert.equal(stickyBar.style.top, '0px');
  assert.ok(within(stickyBar).getByText('Close'));

  // Select a group and open the "Combine this entire group into another group:" Picker popover
  const card = screen.getAllByText('Person #5').find((el) => el.closest('div[style*="cursor: pointer"]'));
  fireEvent.click(card);
  await screen.findByText('Manage Group: Person #5');

  const combineButtons = screen
    .getAllByText('Combine this entire group into another group:')
    .map((el) => el.parentElement?.querySelector('button'))
    .filter(Boolean);
  assert.ok(combineButtons.length > 0, 'combine Picker trigger button exists');
  fireEvent.click(combineButtons[0]);

  const listbox = await screen.findByRole('listbox');
  const optionImgs = listbox.querySelectorAll('img');
  assert.ok(optionImgs.length > 0, 'dropdown options render face avatar thumbnails');
  assert.match(optionImgs[0].getAttribute('src'), /^data:image\/jpeg;base64,/);
});
