const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';

function baseResponse(overrides = {}) {
  return {
    serviceType: 'turn-time-breakdown-jev',
    config: { enabled: false, apiKeyConfigured: true },
    status: {
      effective: false,
      reason: 'db_switch_off',
      apiKeyConfigured: true,
      dbSwitchEnabled: false,
      endpoint: DEFAULT_ENDPOINT,
      model: DEFAULT_MODEL,
    },
    cache: { entries: 3 },
    ...overrides,
  };
}

function setup({ enabled = true, response = baseResponse(), failPut = null, failDelete = null } = {}) {
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
        // Mimic the real service: apply the write, never echo the key.
        const body = options.body || {};
        if (typeof body.enabled === 'boolean') current.config.enabled = body.enabled;
        if (typeof body.apiKey === 'string' && body.apiKey) current.config.apiKeyConfigured = true;
        if (body.clearApiKey === true) current.config.apiKeyConfigured = false;
        if (typeof body.baseUrl === 'string') current.status.endpoint = body.baseUrl || DEFAULT_ENDPOINT;
        if (typeof body.model === 'string') current.status.model = body.model || DEFAULT_MODEL;
        current.status.apiKeyConfigured = current.config.apiKeyConfigured;
        current.status.dbSwitchEnabled = current.config.enabled;
        current.status.reason = !current.config.apiKeyConfigured
          ? 'api_key_missing'
          : current.config.enabled ? 'enabled' : 'db_switch_off';
        current.status.effective = current.status.reason === 'enabled';
        return structuredClone(current);
      }
      if (method === 'DELETE') {
        if (failDelete) throw failDelete;
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

const tick = () => new Promise((resolve) => setImmediate(resolve));

function inputValue($, selector, value, Event) {
  const input = $(selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

test('renders status card with two DB gates, endpoint, model, conclusion; key never shown', async () => {
  const { management, $ } = setup();
  await management.refresh();

  const html = $('#root').innerHTML;
  assert.ok(html.includes('耗时分析分类（JEV）'));
  assert.ok(html.includes('已配置')); // key configured → shows 已配置, never a value
  assert.ok(html.includes(DEFAULT_ENDPOINT));
  assert.ok(html.includes(DEFAULT_MODEL));
  assert.equal($('#jev-config-conclusion').dataset.reason, 'db_switch_off');
  assert.ok($('#jev-config-conclusion').textContent.includes('未生效'));
  assert.ok($('#jev-config-conclusion').textContent.includes('启用开关处于关闭状态'));
  assert.equal($('#jev-cache-count').textContent, '3');
  assert.equal($('#jev-config-enabled').checked, false);
  // The credential section states the env-migration boundary out loud.
  assert.ok(html.includes('不会') && html.includes('TYPESAFE_API_KEY'));
  assert.ok(html.includes('不再读取任何环境变量'));
});

test('save flips the toggle via PUT with CSRF; body carries only changed fields', async () => {
  const { management, requests, toasts, $, Event } = setup();
  await management.refresh();

  const saveButton = $('#save-jev-config');
  assert.equal(saveButton.disabled, true); // unchanged → disabled

  $('#jev-config-enabled').checked = true;
  $('#jev-config-enabled').dispatchEvent(new Event('change'));
  assert.equal(saveButton.disabled, false);

  saveButton.click();
  await tick(); await tick();

  const put = requests.find((r) => (r.options.method || 'GET') === 'PUT');
  assert.ok(put, 'a PUT must be issued');
  assert.equal(put.url, '/api/system-services/turn-time-breakdown-jev');
  assert.equal(put.options.headers['X-CAFF-CSRF-Token'], 'csrf-token');
  assert.deepEqual(Object.keys(put.options.body), ['enabled']);
  assert.equal(put.options.body.enabled, true);

  assert.equal($('#jev-config-enabled').checked, true);
  assert.equal($('#jev-config-conclusion').dataset.reason, 'enabled');
  assert.ok(toasts.some((m) => m.includes('已开启并即时生效')));
});

test('typing a key stages apiKey in the PUT; the panel never displays the value after save', async () => {
  const { management, requests, toasts, $, Event } = setup({
    response: baseResponse({ config: { enabled: true, apiKeyConfigured: false }, status: {
      effective: false, reason: 'api_key_missing', apiKeyConfigured: false, dbSwitchEnabled: true,
      endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL,
    } }),
  });
  await management.refresh();

  // ON but not effective: the toggle note must say exactly why.
  assert.equal($('#jev-config-effective').textContent, '未生效');
  assert.ok($('#jev-config-toggle-note').textContent.includes('已开启，但当前不生效'));
  assert.ok($('#jev-config-toggle-note').textContent.includes('API key 未配置'));

  inputValue($, '#jev-api-key-input', 'sk-ui-secret-123', Event);
  assert.equal($('#save-jev-config').disabled, false);
  $('#save-jev-config').click();
  await tick(); await tick();

  const put = requests.find((r) => (r.options.method || 'GET') === 'PUT');
  assert.equal(put.options.body.apiKey, 'sk-ui-secret-123');

  // After save: input cleared, badge flips, no key material in the DOM.
  assert.equal($('#jev-api-key-input').value, '');
  assert.equal($('#jev-config-effective').textContent, '生效中');
  assert.ok(!$('#root').innerHTML.includes('sk-ui-secret-123'));
  assert.ok(toasts.some((m) => m.includes('API key 已更新并即时生效')));
});

test('staged key clear is applied by the same save button; typing a replacement unstages the clear', async () => {
  const { management, requests, toasts, $, Event } = setup({
    response: baseResponse({ config: { enabled: true, apiKeyConfigured: true }, status: {
      effective: true, reason: 'enabled', apiKeyConfigured: true, dbSwitchEnabled: true,
      endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL,
    } }),
  });
  await management.refresh();

  const clearKeyButton = $('#clear-jev-key');
  assert.equal(clearKeyButton.disabled, false);
  clearKeyButton.click(); // stage the clear
  assert.equal(clearKeyButton.textContent, '将在保存后清除（点击撤销）');
  assert.equal($('#save-jev-config').disabled, false, 'a staged clear is a pending change');

  // Typing a replacement key contradicts the staged clear — newest wins.
  inputValue($, '#jev-api-key-input', 'sk-replacement', Event);
  assert.equal($('#clear-jev-key').textContent, '清除已保存的 key');

  $('#save-jev-config').click();
  await tick(); await tick();

  const put = requests.find((r) => (r.options.method || 'GET') === 'PUT');
  assert.equal(put.options.body.apiKey, 'sk-replacement');
  assert.equal(put.options.body.clearApiKey, undefined, 'the unstaged clear must not be sent');

  // Now actually stage + save a clear.
  $('#clear-jev-key').click();
  $('#save-jev-config').click();
  await tick(); await tick();

  const puts = requests.filter((r) => (r.options.method || 'GET') === 'PUT');
  assert.equal(puts[1].options.body.clearApiKey, true);
  assert.equal(puts[1].options.body.apiKey, undefined);
  assert.ok(toasts.some((m) => m.includes('API key 已清除')));
  assert.equal($('#jev-config-conclusion').dataset.reason, 'api_key_missing');
});

test('advanced section: changed endpoint/model join the PUT; untouched fields are not sent', async () => {
  const { management, requests, $, Event } = setup();
  await management.refresh();

  inputValue($, '#jev-endpoint-input', 'https://proxy.example.com', Event);
  inputValue($, '#jev-model-input', 'jev-pro', Event);
  $('#save-jev-config').click();
  await tick(); await tick();

  const put = requests.find((r) => (r.options.method || 'GET') === 'PUT');
  assert.equal(put.options.body.baseUrl, 'https://proxy.example.com');
  assert.equal(put.options.body.model, 'jev-pro');
  assert.equal(put.options.body.apiKey, undefined);

  // After save the inputs re-render with the new effective values and the
  // save button disables again (nothing staged).
  assert.equal($('#jev-endpoint-input').value, 'https://proxy.example.com');
  assert.equal($('#save-jev-config').disabled, true);
});

test('clear cache is a two-step confirm: first click arms, second sends DELETE with CSRF and refreshes', async () => {
  const { management, requests, toasts, $ } = setup();
  await management.refresh();

  const clearButton = $('#clear-jev-cache');
  assert.equal(clearButton.disabled, false);

  clearButton.click(); // arm only
  assert.equal(clearButton.textContent, '确认清空？再次点击确认');
  assert.ok(!requests.some((r) => r.options.method === 'DELETE'), 'no DELETE on the arming click');

  clearButton.click(); // confirm
  await tick(); await tick(); await tick();

  const del = requests.find((r) => r.options.method === 'DELETE');
  assert.ok(del, 'a DELETE must be issued');
  assert.equal(del.url, '/api/system-services/turn-time-breakdown-jev/cache');
  assert.equal(del.options.headers['X-CAFF-CSRF-Token'], 'csrf-token');
  // Seam lock: the local-admin guard rejects mutations without a JSON
  // content-type (415), and fetchJson only adds that header when a body is
  // present — so the DELETE must carry a body.
  assert.ok(del.options.body && typeof del.options.body === 'object', 'DELETE must carry a JSON body so fetchJson emits application/json');
  assert.ok(toasts.some((m) => m.includes('已清空 3 条')));
  // After refresh the count renders zero and the button disables.
  assert.equal($('#jev-cache-count').textContent, '0');
  assert.equal($('#clear-jev-cache').disabled, true);
});

test('clear failure resets the confirm label: the button must not read 确认清空 while disarmed', async () => {
  const { management, requests, $ } = setup({
    failDelete: { status: 500, message: 'boom' },
  });
  await management.refresh();

  $('#clear-jev-cache').click(); // arm
  $('#clear-jev-cache').click(); // confirm → DELETE fails
  await tick(); await tick(); await tick();

  assert.equal(requests.filter((r) => r.options.method === 'DELETE').length, 1);
  const button = $('#clear-jev-cache');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '清空分类缓存', 'label must match the disarmed internal state');
  assert.ok(!$('#jev-config-error').classList.contains('hidden'));

  button.click(); // after failure, a click only re-arms — it must not execute
  await tick();
  assert.equal(requests.filter((r) => r.options.method === 'DELETE').length, 1);
  assert.equal($('#clear-jev-cache').textContent, '确认清空？再次点击确认');
});

test('clear button starts disabled when the cache is empty', async () => {
  const { management, $ } = setup({ response: baseResponse({ cache: { entries: 0 } }) });
  await management.refresh();
  assert.equal($('#jev-cache-count').textContent, '0');
  assert.equal($('#clear-jev-cache').disabled, true);
});

test('a re-render disarms the two-step clear confirm: one click after refresh must not DELETE', async () => {
  const { management, requests, $ } = setup();
  await management.refresh();

  $('#clear-jev-cache').click(); // arm
  assert.equal($('#clear-jev-cache').textContent, '确认清空？再次点击确认');

  await management.refresh(); // re-render replaces the button node
  const reRenderedButton = $('#clear-jev-cache');
  assert.equal(reRenderedButton.textContent, '清空分类缓存');

  reRenderedButton.click(); // must arm again, not execute
  await tick(); await tick();

  assert.ok(!requests.some((r) => r.options.method === 'DELETE'), 'no DELETE may fire after a re-render disarmed the confirm');
  assert.equal($('#clear-jev-cache').textContent, '确认清空？再次点击确认');
});

test('read-only deployment renders a locked empty state and issues no request', async () => {
  const { management, requests, $ } = setup({ enabled: false });
  await management.refresh();

  assert.equal(requests.length, 0);
  assert.ok($('#root').textContent.includes('只读'));
});

test('save failure surfaces the mapped error in the panel and keeps the stored state', async () => {
  const { management, requests, $, Event } = setup({
    failPut: { statusCode: 422, message: 'Unprocessable', issues: [{ code: 'credential_conflict', path: 'apiKey' }] },
  });
  await management.refresh();

  $('#jev-config-enabled').checked = true;
  $('#jev-config-enabled').dispatchEvent(new Event('change'));
  $('#save-jev-config').click();
  await tick(); await tick();

  const error = $('#jev-config-error');
  assert.equal(error.classList.contains('hidden'), false);
  assert.equal(error.textContent, '不能在同一次保存中同时设置与清除 API key');
  // The stored configuration was not touched by the failed write.
  assert.ok(requests.some((r) => (r.options.method || 'GET') === 'PUT'));
  assert.equal($('#jev-config-conclusion').dataset.reason, 'db_switch_off');
});

test('onStatus callback reflects the effective flag for the list dot', async () => {
  const { management, statuses } = setup();
  await management.refresh();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].effective, false);
  assert.equal(statuses[0].reason, 'db_switch_off');
});
