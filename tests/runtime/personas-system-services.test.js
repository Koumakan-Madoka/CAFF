// Personas page system-services wiring regression tests (JSDOM + vm slices).
// Locks the contract between personas.html / personas.js and the two system
// service modules: list selection switches detail panes, refresh fans out to
// both modules, and the JEV module receives the local-admin gate + CSRF token.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

function setup() {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public', 'personas.html'), 'utf8'), {
    url: 'http://localhost/personas.html#system-services',
  });
  const calls = { scribeRefresh: 0, jevRefresh: 0, jevOptions: null };
  const fetchCalls = [];
  const context = {
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    setTimeout,
    clearTimeout,
    window: {
      CaffShared: {
        modelOptions: {},
        avatar: {},
        createToastController: () => ({ show() {} }),
        async fetchJson(url) {
          fetchCalls.push(url);
          return {
            localAdmin: {
              modelProviders: { enabled: true, csrfToken: 'provider-csrf' },
              systemServices: { enabled: true, csrfToken: 'service-csrf' },
            },
          };
        },
      },
      CaffPersonas: {
        createRoleManagement: () => ({ async refresh() {}, async setDirectory() {} }),
        createProviderManagement: () => ({ async refresh() {} }),
        createRecoveryScribeManagement: () => ({
          async refresh() { calls.scribeRefresh += 1; },
        }),
        createJevConfigManagement: (options) => {
          calls.jevOptions = options;
          return {
            async refresh() { calls.jevRefresh += 1; },
          };
        },
      },
    },
  };
  // The modules register onto window.CaffPersonas; personas.js reads the bare
  // globals. Mirror the browser: window props are globals.
  context.CaffShared = context.window.CaffShared;
  context.CaffPersonas = context.window.CaffPersonas;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'personas.js'), 'utf8'), context, {
    filename: 'public/personas.js',
  });
  return { dom, calls, fetchCalls, document: dom.window.document };
}

async function waitForReady(document) {
  for (let i = 0; i < 100; i += 1) {
    if (document.body.dataset.managementReady) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('personas page did not finish init');
}

test('init refreshes both system service modules with the shared local-admin gate', async () => {
  const { document, calls, fetchCalls } = setup();
  await waitForReady(document);

  assert.equal(document.body.dataset.managementReady, 'true');
  assert.ok(fetchCalls.includes('/api/bootstrap'));
  assert.equal(calls.scribeRefresh, 1);
  assert.equal(calls.jevRefresh, 1);
  // The JEV module must inherit the system-services local-admin gate + CSRF.
  assert.equal(calls.jevOptions.isEnabled(), true);
  assert.equal(calls.jevOptions.getCsrfToken(), 'service-csrf');
});

test('selecting 耗时分析分类（JEV） switches the detail pane and aria state', async () => {
  const { document } = setup();
  await waitForReady(document);

  const scribeButton = document.getElementById('system-service-select-scribe');
  const jevButton = document.getElementById('system-service-select-jev');
  const scribeDetail = document.getElementById('recovery-scribe-detail');
  const jevDetail = document.getElementById('jev-config-detail');

  // Default: scribe selected, JEV pane hidden.
  assert.equal(scribeButton.classList.contains('active'), true);
  assert.equal(jevDetail.classList.contains('hidden'), true);

  jevButton.click();

  assert.equal(jevButton.classList.contains('active'), true);
  assert.equal(jevButton.getAttribute('aria-current'), 'true');
  assert.equal(scribeButton.classList.contains('active'), false);
  assert.equal(scribeButton.getAttribute('aria-current'), 'false');
  assert.equal(jevDetail.classList.contains('hidden'), false);
  assert.equal(scribeDetail.classList.contains('hidden'), true);

  scribeButton.click();

  assert.equal(scribeDetail.classList.contains('hidden'), false);
  assert.equal(jevDetail.classList.contains('hidden'), true);
});

test('刷新状态 fans out to both system service modules', async () => {
  const { document, calls } = setup();
  await waitForReady(document);

  document.getElementById('refresh-system-services').click();
  await waitForReady(document);
  for (let i = 0; i < 20 && calls.jevRefresh < 2; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(calls.scribeRefresh, 2);
  assert.equal(calls.jevRefresh, 2);
});
