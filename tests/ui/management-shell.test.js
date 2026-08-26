// Management AppShell regression tests (jsdom + source contracts).
// Milestone 2 locks:
// - four management routes share one fixed-viewport shell and global rail
// - list/detail panes own scrolling instead of the document
// - selectable management collections render ul > li > button
// - responsive/browser verification remains repository-owned

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const STYLES = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERIFY_UI = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-ui.mjs'), 'utf8');
const MANAGEMENT_HELPER = path.join(ROOT, 'public', 'shared', 'management-list.js');
const MANAGEMENT_VERIFY = path.join(ROOT, 'scripts', 'ui', 'verify-management-pages.mjs');

const ROUTES = ['/', '/personas.html', '/skills.html', '/projects.html', '/metrics.html'];
const PAGES = [
  {
    key: 'personas',
    file: 'personas.html',
    route: '/personas.html',
    lists: ['family-role-list', 'custom-role-list', 'provider-list', 'system-service-list'],
    criticalIds: ['show-role-management', 'show-provider-management', 'show-system-services', 'refresh-roles', 'new-custom-role', 'refresh-providers', 'add-provider', 'refresh-system-services', 'role-detail', 'provider-detail', 'recovery-scribe-detail'],
  },
  {
    key: 'skills',
    file: 'skills.html',
    route: '/skills.html',
    lists: ['skill-list', 'mode-list'],
    criticalIds: ['refresh-button', 'tab-skills', 'tab-modes', 'skill-form', 'mode-form'],
  },
  {
    key: 'projects',
    file: 'projects.html',
    route: '/projects.html',
    lists: ['project-list'],
    criticalIds: ['refresh-button', 'new-project-form', 'set-active-button', 'delete-project-button'],
  },
  {
    key: 'metrics',
    file: 'metrics.html',
    route: '/metrics.html',
    lists: ['agent-list'],
    criticalIds: ['refresh-button', 'filter-form', 'agent-report', 'tool-report'],
  },
];

function readPublic(file) {
  return fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
}

function pageDom(page) {
  return new JSDOM(readPublic(page.file), { url: `http://localhost${page.route}` });
}

for (const page of PAGES) {
  test(`${page.key} uses the fixed-viewport management shell and preserves page contracts`, () => {
    const { document } = pageDom(page).window;

    assert.equal(document.body.classList.contains('management-app'), true);
    assert.equal(document.body.dataset.page, page.key);
    assert.ok(document.querySelector('.management-shell'));
    assert.ok(document.querySelector('.management-main'));
    assert.ok(document.querySelector('.management-header'));
    assert.ok(document.querySelector('main.management-content'));
    assert.ok(document.querySelector('.management-index'));
    assert.ok(document.querySelector('.management-detail'));

    assert.equal(document.querySelector('.shell'), null, 'legacy page shell must be removed');
    assert.equal(document.querySelector('.topbar'), null, 'legacy oversized topbar must be removed');
    assert.equal(document.querySelector('.ambient'), null, 'ambient chrome must not overlay the fixed shell');

    const rail = document.querySelector('nav.rail[aria-label="主导航"]');
    assert.ok(rail, 'global rail must be a real navigation landmark');
    const links = Array.from(rail.querySelectorAll('a.rail-link'));
    assert.deepEqual(links.map((link) => link.getAttribute('href')), ROUTES);
    const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
    assert.equal(current.length, 1, 'exactly one rail destination must be current');
    assert.equal(current[0].getAttribute('href'), page.route);

    for (const id of page.criticalIds) {
      assert.ok(document.getElementById(id), `${page.file} must preserve #${id}`);
    }

    for (const id of page.lists) {
      assert.equal(document.getElementById(id)?.tagName, 'UL', `#${id} must be a semantic list`);
    }

    const scripts = Array.from(document.scripts).map((script) => script.getAttribute('src')).filter(Boolean);
    const helperIndex = scripts.indexOf('/shared/management-list.js');
    const pageIndex = scripts.indexOf(`/${page.key}.js`);
    assert.ok(helperIndex >= 0, 'management list helper must be loaded');
    assert.ok(pageIndex > helperIndex, 'management list helper must load before the page entry');
  });
}

test('shared management list primitive is repository-owned', () => {
  assert.equal(fs.existsSync(MANAGEMENT_HELPER), true, 'public/shared/management-list.js must exist');
  assert.match(PACKAGE.scripts.check, /public\/shared\/management-list\.js/);
});

test('shared management list primitive creates a native selectable list item', {
  skip: !fs.existsSync(MANAGEMENT_HELPER),
}, () => {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.eval(fs.readFileSync(MANAGEMENT_HELPER, 'utf8'));

  const createItem = window.CaffShared && window.CaffShared.createManagementListItem;
  const createEmptyState = window.CaffShared && window.CaffShared.createManagementListEmptyState;
  assert.equal(typeof createItem, 'function');
  assert.equal(typeof createEmptyState, 'function');
  const { row, button } = createItem({ id: 'item-1', active: true, compact: true });

  assert.equal(row.tagName, 'LI');
  assert.equal(row.firstElementChild, button);
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.type, 'button');
  assert.equal(button.dataset.id, 'item-1');
  assert.equal(button.classList.contains('agent-list-item'), true);
  assert.equal(button.classList.contains('compact'), true);
  assert.equal(button.classList.contains('active'), true);
  assert.equal(button.getAttribute('aria-current'), 'true');

  let clicked = false;
  button.addEventListener('click', () => {
    clicked = true;
  });
  button.click();
  assert.equal(clicked, true);

  const empty = createEmptyState('暂无内容');
  assert.equal(empty.tagName, 'LI');
  assert.equal(empty.classList.contains('empty-state'), true);
  assert.equal(empty.textContent, '暂无内容');
});

test('management CSS owns viewport, bounded panes, mobile rail, and touch targets', () => {
  assert.match(STYLES, /body\.management-app\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
  assert.match(STYLES, /body\.management-app\s+\.management-shell\s*\{[^}]*height:\s*100dvh/s);
  assert.match(STYLES, /body\.management-app\s+\.management-content\s*\{[^}]*grid-template-columns:[^}]*minmax\(0,\s*1fr\)/s);
  assert.match(STYLES, /body\.management-app\s+\.management-pane\s*\{[^}]*overflow:\s*auto/s);
  assert.match(STYLES, /body\.management-app\s+\.agent-list-item\s*\{[^}]*min-height:\s*44px/s);
  assert.match(STYLES, /body\.management-app\[data-page="metrics"\]\s+#filter-form\s+\.field-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(STYLES, /body\.management-app\[data-page="metrics"\]\s+#filter-form\s+input\[type="date"\]\s*\{[^}]*min-width:\s*0[^}]*width:\s*100%/s);
  assert.match(STYLES, /@media\s*\(max-width:\s*767px\)[\s\S]*body\.management-app\s+\.rail[\s\S]*position:\s*fixed/s);
  assert.match(STYLES, /@media\s*\(max-width:\s*767px\)[\s\S]*body\.management-app\s+\.management-content[\s\S]*grid-template-columns:\s*1fr/s);
});

test('management renderer migration uses the shared primitive instead of div click targets', () => {
  for (const file of ['personas/role-management.js', 'personas/provider-management.js', 'skills.js', 'projects.js', 'metrics.js']) {
    const source = readPublic(file);
    assert.match(source, /createManagementListItem/);
    assert.doesNotMatch(source, /createElement\(['"]div['"]\)[\s\S]{0,100}className\s*=\s*[`'"]agent-list-item/);
  }
});

test('test:ui runs the repository-owned management page verifier', () => {
  assert.equal(fs.existsSync(MANAGEMENT_VERIFY), true, 'management browser verifier must exist');
  assert.match(VERIFY_UI, /verifyManagementPages/);
  assert.match(VERIFY_UI, /ui-v2-1440-management\.png/);

  const managementVerifier = fs.readFileSync(MANAGEMENT_VERIFY, 'utf8');
  assert.match(managementVerifier, /since-input/);
  assert.match(managementVerifier, /until-input/);
  assert.match(managementVerifier, /\[1440, 820, 375\]/);
  assert.match(managementVerifier, /date controls are contained, non-overlapping, and reachable/);

  const screenshotNames = new Set(VERIFY_UI.match(/ui-v2-[\w-]+\.png/g) || []);
  assert.ok(screenshotNames.size > 0 && screenshotNames.size <= 3, 'combined browser evidence remains bounded to three PNGs');
});
