const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');

function baseResponse(overrides = {}) {
  return {
    serviceType: 'turn-time-breakdown-jev',
    config: { enabled: false },
    status: {
      effective: false,
      reason: 'db_switch_off',
      masterSwitchEnabled: true,
      apiKeyConfigured: true,
      dbSwitchEnabled: false,
      endpoint: 'https://api.typesafe.ai',
      model: 'jev-latest',
    },
    cache: { entries: 3 },
    ...overrides,
  };
}

function setup({ enabled = true, response = baseResponse(), failPut = null } = {}) {
  const dom = new JSDOM('<div id="root"></div><span id="dot"></span>');
  const requests = [];
  const toasts = [];
  const statuses = [];
  let current = structuredClone(response);
  const context = {
    document: dom.window.document,
    Event: dom.window.Event,
    setTimeout,
    clearTimeout,
    window: { CaffPersonas: {}, CaffShared: {} },
  };
  for (const rel of [
    'public/shared/model-options.js',
    'public/personas/management-utils.js',
    'public/personas/jev-config-management.js',
  ]) {
    const sourcePath = path.join(ROOT, rel);
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }
  const management = context.window.CaffPersonas.createJevConfigManagement({
    root: dom.window.document.getElementById('root'),
    isEnabled: () => enabled,
    getCsrfToken: () => 'csrf-token',
    showToast(message) { toasts.push(message); },
    onStatus(status) { statuses.push(status); },
    async fetchJson(url, options = {}) {
      requests.push({ url, options });
      const method = options.method || 'GET';
      if (method === 'PUT') {
        if (failPut) throw failPut;
        current.config.enabled = options.body.enabled === true;
        current.status.dbSwitchEnabled = current.config.enabled;
        current.status.effective = current.status.masterSwitchEnabled && current.status.apiKeyConfigured && current.config.enabled;
        current.status.reason = !current.status.masterSwitchEnabled
          ? 'master_switch_off'
          : !current.status.apiKeyConfigured
            ? 'api_key_missing'
            : current.config.enabled ? 'enabled' : 'db_switch_off';
        return structuredClone(current);
      }
      if (method === 'DELETE') {
        const cleared = current.cache.entries;
        current.cache.entries = 0;
        return { cleared };
      }
      return structuredClone(current);
    },
  });
  const $ = (selector) => dom.window.document.querySelector(selector);
  return { dom, management, requests, toasts, statuses, $, Event: dom.window.Event, getCurrent: () => current };
}

async function refreshAndGet(management, $) {
  await management.refresh();
  return $;
}

test('renders status card with gates, endpoint, model, conclusion; key never shown', async (t) => {
  const { management, $ } = setup();
  await management.refresh();

  const html = $('#root').innerHTML;
  assert.ok(html.includes('耗时分析分类（JEV）'));
  assert.ok(html.includes('TYPESAFE_ENABLED'));
  assert.ok(html.includes('TYPESAFE_API_KEY'));
  assert.ok(html.includes('已配置')); // key configured → shows 已配置, never a value
  assert.ok(html.includes('https://api.typesafe.ai'));
  assert.ok(html.includes('jev-latest'));
  assert.equal($('#jev-config-conclusion').dataset.reason, 'db_switch_off');
  assert.ok($('#jev-config-conclusion').textContent.includes('未生效'));
  assert.ok($('#jev-config-conclusion').textContent.includes('启用开关处于关闭状态'));
  assert.equal($('#jev-cache-count').textContent, '3');
  assert.equal($('#jev-config-enabled').checked, false);
});

test('save flips the toggle via PUT with CSRF and no credential fields; toast confirms immediate effect', async (t) => {
  const { management, requests, toasts, $, Event } = setup();
  await management.refresh();

  const saveButton = $('#save-jev-config');
  assert.equal(saveButton.disabled, true); // unchanged → disabled

  $('#jev-config-enabled').checked = true;
  $('#jev-config-enabled').dispatchEvent(new Event('change'));
  assert.equal(saveButton.disabled, false);

  saveButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const put = requests.find((r) => (r.options.method || 'GET') === 'PUT');
  assert.ok(put, 'a PUT must be issued');
  assert.equal(put.url, '/api/system-services/turn-time-breakdown-jev');
  assert.equal(put.options.headers['X-CAFF-CSRF-Token'], 'csrf-token');
  assert.equal(put.options.body.enabled, true);
  assert.deepEqual(Object.keys(put.options.body), ['enabled']);
  assert.ok(!JSON.stringify(put.options.body).toLowerCase().includes('key'));

  assert.equal($('#jev-config-enabled').checked, true);
  assert.equal($('#jev-config-conclusion').dataset.reason, 'enabled');
  assert.ok(toasts.some((m) => m.includes('已开启并即时生效')));
});

test('enabled but API key missing: toggle note states the exact non-effective reason', async (t) => {
  const { management, $ } = setup({
    response: baseResponse({
      config: { enabled: true },
      status: {
        effective: false,
        reason: 'api_key_missing',
        masterSwitchEnabled: true,
        apiKeyConfigured: false,
        dbSwitchEnabled: true,
        endpoint: 'https://api.typesafe.ai',
        model: 'jev-latest',
      },
    }),
  });
  await management.refresh();

  // The toggle is ON but must not present as "已启用生效".
  assert.equal($('#jev-config-enabled').checked, true);
  assert.equal($('#jev-config-effective').textContent, '未生效');
  assert.ok($('#jev-config-toggle-note').textContent.includes('已开启，但当前不生效'));
  assert.ok($('#jev-config-toggle-note').textContent.includes('TYPESAFE_API_KEY 未配置'));
  assert.ok($('#jev-config-conclusion').textContent.includes('重启进程'));
  // The key row must say 未配置 without any value.
  const rows = Array.from($('#root').querySelectorAll('.jev-gate-row'));
  const keyRow = rows.find((row) => row.textContent.includes('API key'));
  assert.ok(keyRow.textContent.includes('未配置'));
});

test('master switch off shows the env-gate reason and restart wording', async (t) => {
  const { management, $ } = setup({
    response: baseResponse({
      status: {
        effective: false,
        reason: 'master_switch_off',
        masterSwitchEnabled: false,
        apiKeyConfigured: false,
        dbSwitchEnabled: false,
        endpoint: '',
        model: '',
      },
    }),
  });
  await management.refresh();

  assert.equal($('#jev-config-conclusion').dataset.reason, 'master_switch_off');
  assert.ok($('#jev-config-conclusion').textContent.includes('TYPESAFE_ENABLED 未开启'));
  assert.ok($('#jev-config-conclusion').textContent.includes('重启'));
});

test('enabled + all gates on shows 生效中 and the effective toast path on save off', async (t) => {
  const { management, toasts, $, Event } = setup({
    response: baseResponse({
      config: { enabled: true },
      status: {
        effective: true,
        reason: 'enabled',
        masterSwitchEnabled: true,
        apiKeyConfigured: true,
        dbSwitchEnabled: true,
        endpoint: 'https://api.typesafe.ai',
        model: 'jev-latest',
      },
    }),
  });
  await management.refresh();

  assert.equal($('#jev-config-effective').textContent, '生效中');
  assert.ok($('#jev-config-toggle-note').textContent.includes('已开启且生效中'));

  $('#jev-config-enabled').checked = false;
  $('#jev-config-enabled').dispatchEvent(new Event('change'));
  $('#save-jev-config').click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(toasts.some((m) => m.includes('已关闭')));
});

test('clear cache is a two-step confirm: first click arms, second sends DELETE with CSRF and refreshes', async (t) => {
  const { management, requests, toasts, $, Event } = setup();
  await management.refresh();

  const clearButton = $('#clear-jev-cache');
  assert.equal(clearButton.disabled, false);

  clearButton.click(); // arm only
  assert.equal(clearButton.textContent, '确认清空？再次点击确认');
  assert.ok(!requests.some((r) => r.options.method === 'DELETE'), 'no DELETE on the arming click');

  clearButton.click(); // confirm
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const del = requests.find((r) => r.options.method === 'DELETE');
  assert.ok(del, 'a DELETE must be issued');
  assert.equal(del.url, '/api/system-services/turn-time-breakdown-jev/cache');
  assert.equal(del.options.headers['X-CAFF-CSRF-Token'], 'csrf-token');
  assert.ok(toasts.some((m) => m.includes('已清空 3 条')));
  // After refresh the count renders zero and the button disables.
  assert.equal($('#jev-cache-count').textContent, '0');
  assert.equal($('#clear-jev-cache').disabled, true);
});

test('clear button starts disabled when the cache is empty', async (t) => {
  const { management, $ } = setup({ response: baseResponse({ cache: { entries: 0 } }) });
  await management.refresh();
  assert.equal($('#jev-cache-count').textContent, '0');
  assert.equal($('#clear-jev-cache').disabled, true);
});

test('read-only deployment renders a locked empty state and issues no request', async (t) => {
  const { management, requests, $ } = setup({ enabled: false });
  await management.refresh();

  assert.equal(requests.length, 0);
  assert.ok($('#root').textContent.includes('只读'));
});

test('save failure surfaces the mapped error in the panel and keeps the stored state', async (t) => {
  const { management, requests, $, Event } = setup({
    failPut: { statusCode: 422, message: 'Unprocessable', issues: [{ code: 'invalid_enabled_value', path: 'enabled' }] },
  });
  await management.refresh();

  $('#jev-config-enabled').checked = true;
  $('#jev-config-enabled').dispatchEvent(new Event('change'));
  $('#save-jev-config').click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const error = $('#jev-config-error');
  assert.equal(error.classList.contains('hidden'), false);
  assert.equal(error.textContent, '启用状态非法');
  // The stored configuration was not touched by the failed write.
  assert.ok(requests.some((r) => (r.options.method || 'GET') === 'PUT'));
  assert.equal($('#jev-config-conclusion').dataset.reason, 'db_switch_off');
});

test('onStatus callback reflects the effective flag for the list dot', async (t) => {
  const { management, statuses } = setup();
  await management.refresh();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].effective, false);
  assert.equal(statuses[0].reason, 'db_switch_off');
});
