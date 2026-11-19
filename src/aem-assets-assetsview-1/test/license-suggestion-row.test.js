const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Lightweight stand-ins so the components can be rendered server-side without a DOM or the
// Spectrum stylesheet loader. They render their children and keep text/attributes testable.
const h = React.createElement;
const box = (tag = 'div') => ({ children, title }) => h(tag, { title }, children);
const spectrumStub = {
  View: box(), Flex: box(), Grid: box(), Form: box(), Content: box(), Heading: box('h4'), Text: box('span'),
  Badge: box('span'), StatusLight: box('span'), InlineAlert: box(), TagGroup: box('ul'), Item: box('li'),
  Tabs: box(), TabList: box(), TabPanels: box(), ButtonGroup: box(),
  TextField: ({ label, value }) => h('label', null, label, h('input', { value, readOnly: true })),
  ActionButton: ({ children, onPress }) => h('button', { onClick: onPress }, children),
  Button: ({ children, onPress, isDisabled }) => h('button', { onClick: onPress, disabled: isDisabled }, children)
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@adobe/react-spectrum') return spectrumStub;
  if (request.startsWith('@spectrum-icons/workflow/')) return { __esModule: true, default: () => null };
  return realLoad.call(this, request, ...rest);
};

function load(file) {
  const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
    filename: file,
    babelrc: false,
    configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx'],
    presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }]]
  });
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(code, file);
  return mod.exports;
}

const mod = load(path.join(__dirname, '../web-src/src/components/LicenseSuggestionRow.js'));
const Row = mod.default;
const render = (props) => renderToStaticMarkup(React.createElement(Row, props));

const suggestion = (extra = {}) => ({
  licenseId: 'L1',
  name: 'Model Release MR-2026-084',
  licenser: 'Northstar Talent Agency',
  similarity: 97.4,
  strong: true,
  restrictions: ['Paid social excluded.'],
  windows: [{ channels: ['WEB', 'EMAIL'], regions: ['US', 'CA'], effectiveAt: '2026-11-14', expiresAt: '2027-11-13', perpetual: false }],
  ...extra
});

test('isExpired only when every window has ended', () => {
  const win = (expiresAt, perpetual = false) => ({ expiresAt, perpetual });
  assert.equal(mod.isExpired({ windows: [win('2020-01-01')] }, '2026-11-19'), true);
  assert.equal(mod.isExpired({ windows: [win('2020-01-01'), win('2030-01-01')] }, '2026-11-19'), false);
  assert.equal(mod.isExpired({ windows: [win('2020-01-01', true)] }, '2026-11-19'), false);
  assert.equal(mod.isExpired({ windows: [] }, '2026-11-19'), false);
});

test('renders nothing when the person has no suggestions', () => {
  assert.ok(!render({ person: { suggestions: [] }, state: {}, onApply() {} }).includes('Suggested license'));
  assert.ok(!render({ person: undefined, state: {}, onApply() {} }).includes('Suggested license'));
});

test('shows a loading hint while checking', () => {
  assert.ok(render({ person: undefined, state: { loading: true }, onApply() {} }).includes('Checking licenses'));
});

test('renders terms, strong-match score and an Apply button; never assigns on render', () => {
  let applied = 0;
  const html = render({ person: { groupId: 'g', suggestions: [suggestion()] }, state: {}, onApply: () => { applied++; } });
  assert.ok(html.includes('Suggested license'));
  assert.ok(html.includes('Strong match'));
  assert.ok(html.includes('97%'));
  assert.ok(html.includes('US/CA · WEB, EMAIL · 2026-11-14 → 2027-11-13'));
  assert.ok(html.includes('Apply license'));
  assert.ok(html.includes('not by name'));
  assert.equal(applied, 0);
});

test('weak matches are labelled Possible and expired licenses are flagged', () => {
  const html = render({
    person: { groupId: 'g', suggestions: [suggestion({ strong: false, similarity: 86, windows: [{ channels: ['WEB'], regions: ['US'], effectiveAt: '2019-01-01', expiresAt: '2020-01-01' }] })] },
    state: {}, onApply() {}
  });
  assert.ok(html.includes('Possible match'));
  assert.ok(html.includes('Expired license'));
});

test('offers Review contract when a reviewer is wired, and shows already-applied licenses as assigned', () => {
  const person = { groupId: 'g', displayName: 'Elena', suggestions: [suggestion()] };
  const withReview = render({ person, state: {}, onApply() {}, onReview() {} });
  assert.ok(withReview.includes('Review contract'));
  assert.ok(withReview.includes('Apply license'));
  assert.ok(!render({ person, state: {}, onApply() {} }).includes('Review contract'));
  const applied = render({ person, state: {}, onApply() {}, onReview() {}, appliedIds: ['L1'] });
  assert.ok(applied.includes('License assigned to this asset'));
  assert.ok(!applied.includes('Review contract'));
});

test('extracted-properties view mirrors the product dialog: confidence, parties, windows, restrictions', () => {
  const View = load(path.join(__dirname, '../web-src/src/components/LicensePropertiesView.js')).default;
  const html = renderToStaticMarkup(React.createElement(View, { license: suggestion({ confidence: 86, licensee: 'Northstar Visual Media LLC' }) }));
  assert.ok(html.includes('86% confidence score'));
  assert.ok(html.includes('Northstar Visual Media LLC'));
  assert.ok(html.includes('Northstar Talent Agency'), 'licenser shown as an owner field, not used for matching');
  assert.ok(html.includes('Usage window 1'));
  assert.ok(html.includes('2026-11-14') && html.includes('2027-11-13'));
  assert.ok(html.includes('US') && html.includes('EMAIL'));
  assert.ok(html.includes('Paid social excluded.'));
  assert.ok(renderToStaticMarkup(React.createElement(View, { license: null })).includes('No extracted properties'));
});

test('a suggestion already assigned on the asset shows as assigned with no apply buttons', () => {
  const html = render({ person: { groupId: 'g', suggestions: [suggestion({ assigned: true })] }, state: {}, onApply() {}, onReview() {} });
  assert.ok(html.includes('License assigned to this asset'));
  assert.ok(!html.includes('Apply license') && !html.includes('Review contract'));
});

test('restrictions are collapsed behind a quiet toggle that shows the count', () => {
  const html = render({ person: { groupId: 'g', suggestions: [suggestion()] }, state: {}, onApply() {} });
  assert.ok(html.includes('Restrictions (1)'));
  assert.ok(!html.includes('Paid social excluded.'), 'details are hidden until expanded');
});
