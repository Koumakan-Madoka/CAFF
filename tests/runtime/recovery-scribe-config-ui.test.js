const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');
const MODEL_OPTIONS = [
  {
    key: 'deepseek\u001fdeepseek-v4-flash',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    source: 'models_json',
    supportedThinkingLevels: ['off', 'low', 'high'],
  },
  {
    key: 'openai\u001fgpt-5',
    provider: 'openai',
    model: 'gpt-5',
    label: 'GPT-5',
    source: 'models_json',
    supportedThinkingLevels: ['off', 'medium', 'high'],
  },
];

function setup({ modelOptions = MODEL_OPTIONS, enabled = true } = {}) {
  const dom = new JSDOM('<div id="root"></div>');
  const requests = [];
  const toasts = [];
  let managedProviders = 0;
  const response = {
    config: {
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: 'low',
      timeoutMs: 60_000,
    },
    source: 'runtime_defaults',
    updatedAt: null,
    modelOptions,
  };
  const context = {
    document: dom.window.document,
    Event: dom.window.Event,
    window: { CaffPersonas: {}, CaffShared: {} },
  };
  for (const rel of [
    'public/shared/model-options.js',
    'public/personas/management-utils.js',
    'public/personas/recovery-scribe-management.js',
  ]) {
    const sourcePath = path.join(ROOT, rel);
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }
  const management = context.window.CaffPersonas.createRecoveryScribeManagement({
    root: dom.window.document.getElementById('root'),
    isEnabled: () => enabled,
    getCsrfToken: () => 'csrf-token',
    onManageProviders() { managedProviders += 1; },
    showToast(message) { toasts.push(message); },
    async fetchJson(url, options = {}) {
      requests.push({ url, options });
      if ((options.method || 'GET') === 'PUT') {
        response.config = structuredClone(options.body);
        response.source = 'persisted';
        response.updatedAt = '2026-08-26T12:00:00.000Z';
      }
      return structuredClone(response);
    },
  });
  return { dom, management, requests, toasts, managedProviders: () => managedProviders };
}

test('system scribe editor loads configured models and saves a full hot configuration snapshot', async () => {
  const session = setup();
  await session.management.refresh();
  const { document, Event } = session.dom.window;

  assert.equal(document.getElementById('recovery-scribe-enabled').checked, true);
  assert.equal(document.getElementById('recovery-scribe-model').value, 'deepseek\u001fdeepseek-v4-flash');
  assert.equal(document.querySelector('#recovery-scribe-model option[value=""]'), null);
  assert.equal(document.getElementById('recovery-scribe-thinking').value, 'low');
  assert.equal(document.getElementById('recovery-scribe-timeout').value, '60');
  assert.match(document.getElementById('recovery-scribe-config-source').textContent, /启动默认/u);
  assert.match(document.getElementById('root').textContent, /当 Agent 回复失败时/u);
  assert.match(document.getElementById('root').textContent, /已完成的操作、可能已生效但未确认的改动、未完成的部分/u);
  assert.match(document.getElementById('root').textContent, /模型来自「模型供应商」中已配置的模型/u);
  assert.match(document.getElementById('root').textContent, /无需创建角色/u);
  assert.match(document.getElementById('root').textContent, /摘要、摘要压缩、标题润色和失败现场整理/u);
  assert.match(document.getElementById('root').textContent, /输出预算来自「模型供应商」中该模型的最大输出 token/u);
  assert.match(document.getElementById('root').textContent, /Pi 默认 16384/u);
  assert.match(document.getElementById('root').textContent, /最多自动再调用一次并关闭思考/u);
  assert.match(document.getElementById('root').textContent, /429、模型服务错误或超时不会自动重试/u);
  assert.equal(document.querySelectorAll('input[type="number"]').length, 1, 'token budget must not add another input');
  assert.match(document.getElementById('root').textContent, /失败消息上不再显示「整理失败现场」按钮/u);
  assert.match(document.getElementById('root').textContent, /整理超时/u);
  assert.match(document.getElementById('root').textContent, /不执行命令、不修改文件、不重试任务/u);
  assert.match(document.getElementById('root').textContent, /原始失败记录保持原样/u);
  document.getElementById('manage-providers-from-recovery-scribe').click();
  assert.equal(session.managedProviders(), 1);

  const model = document.getElementById('recovery-scribe-model');
  model.value = 'openai\u001fgpt-5';
  model.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(
    Array.from(document.getElementById('recovery-scribe-thinking').options, (option) => option.value),
    ['off', 'medium', 'high']
  );
  document.getElementById('recovery-scribe-thinking').value = 'medium';
  document.getElementById('recovery-scribe-timeout').value = '45';
  document.getElementById('recovery-scribe-enabled').checked = false;

  await session.management.save();
  assert.deepEqual(JSON.parse(JSON.stringify(session.requests[1])), {
    url: '/api/system-services/recovery-scribe',
    options: {
      method: 'PUT',
      headers: { 'X-CAFF-CSRF-Token': 'csrf-token' },
      body: {
        enabled: false,
        provider: 'openai',
        model: 'gpt-5',
        thinking: 'medium',
        timeoutMs: 45_000,
      },
    },
  });
  assert.match(session.toasts.at(-1), /立即生效/u);
  assert.match(document.getElementById('recovery-scribe-config-source').textContent, /已保存/u);
});

test('system scribe editor replaces an empty model select with a provider setup action', async () => {
  const session = setup({ modelOptions: [] });
  await session.management.refresh();
  const { document } = session.dom.window;

  assert.equal(document.getElementById('recovery-scribe-model'), null);
  assert.match(document.getElementById('root').textContent, /还没有可用模型/u);
  assert.match(document.getElementById('root').textContent, /请先到「模型供应商」添加连接并配置可用模型/u);
  assert.match(document.getElementById('root').textContent, /无需创建角色/u);
  assert.equal(document.getElementById('save-recovery-scribe-config').disabled, true);
  document.getElementById('manage-providers-from-recovery-scribe').click();
  assert.equal(session.managedProviders(), 1);
});

test('system scribe provider navigation remains available in a read-only deployment', async () => {
  const session = setup({ enabled: false });
  await session.management.refresh();
  const { document } = session.dom.window;

  assert.equal(document.getElementById('recovery-scribe-enabled').disabled, true);
  assert.equal(document.getElementById('manage-providers-from-recovery-scribe').disabled, false);
  document.getElementById('manage-providers-from-recovery-scribe').click();
  assert.equal(session.managedProviders(), 1);
});

test('personas management exposes a separate system services tab and chat listens for hot config changes', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'personas.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const personas = fs.readFileSync(path.join(ROOT, 'public', 'personas.js'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="show-system-services"/u);
  assert.match(html, /id="system-services-view"/u);
  assert.match(html, /id="recovery-scribe-detail"/u);
  assert.match(html, /\/personas\/recovery-scribe-management\.js/u);
  assert.match(html, /失败回复的只读现场报告/u);
  assert.match(html, /不是普通角色/u);
  assert.match(personas, /onManageProviders:\s*\(\)\s*=>\s*showView\('providers'\)/u);
  assert.match(app, /system_service_config_updated/u);
  assert.match(app, /scheduleConversationRefresh\(state\.selectedConversationId\)/u);
  assert.match(styles, /data-page="personas"\]\s+\.management-view-switch\s*\{[^}]*grid-template-columns:\s*repeat\(3,/su);
  assert.match(styles, /data-page="personas"\]\s+\.management-icon-button\s*\{[^}]*grid-row:\s*1/su);
});

test('provider refresh failure does not block the initial system services view or scribe load', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'personas.html'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'public', 'personas.js'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/personas.html#system-services',
  });
  const calls = [];
  const toasts = [];
  dom.window.CaffShared = {
    avatar: {},
    createToastController() {
      return { show(message) { toasts.push(String(message)); } };
    },
    async fetchJson(url) {
      assert.equal(url, '/api/bootstrap');
      return {
        localAdmin: {
          modelProviders: { enabled: true, csrfToken: 'provider-token' },
          systemServices: { enabled: true, csrfToken: 'service-token' },
        },
      };
    },
  };
  dom.window.CaffPersonas = {
    createRoleManagement() {
      return {
        setDirectory() { calls.push('roles'); },
        async refresh() { calls.push('roles-refresh'); },
      };
    },
    createProviderManagement() {
      return {
        async refresh() {
          calls.push('providers');
          throw new Error('provider fixture rejected');
        },
      };
    },
    createRecoveryScribeManagement() {
      return {
        async refresh() { calls.push('system-services'); },
      };
    },
  };

  dom.window.eval(source);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ['roles', 'providers', 'system-services']);
  assert.equal(dom.window.document.body.dataset.managementReady, 'true');
  assert.equal(dom.window.document.getElementById('system-services-view').classList.contains('hidden'), false);
  assert.equal(dom.window.document.getElementById('show-system-services').getAttribute('aria-selected'), 'true');
  assert.ok(toasts.some((message) => message.includes('provider fixture rejected')));
});
