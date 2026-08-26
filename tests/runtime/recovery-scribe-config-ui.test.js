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

function setup() {
  const dom = new JSDOM('<div id="root"></div>');
  const requests = [];
  const toasts = [];
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
    modelOptions: MODEL_OPTIONS,
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
    isEnabled: () => true,
    getCsrfToken: () => 'csrf-token',
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
  return { dom, management, requests, toasts };
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
  assert.match(document.getElementById('root').textContent, /摘要、摘要压缩、标题润色与失败现场整理/u);
  assert.match(document.getElementById('root').textContent, /启停仅控制失败现场整理/u);
  assert.match(document.getElementById('root').textContent, /超时仅用于失败现场整理/u);

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

test('personas management exposes a separate system services tab and chat listens for hot config changes', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'personas.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="show-system-services"/u);
  assert.match(html, /id="system-services-view"/u);
  assert.match(html, /id="recovery-scribe-detail"/u);
  assert.match(html, /\/personas\/recovery-scribe-management\.js/u);
  assert.match(app, /system_service_config_updated/u);
  assert.match(app, /scheduleConversationRefresh\(state\.selectedConversationId\)/u);
  assert.match(styles, /data-page="personas"\]\s+\.management-view-switch\s*\{[^}]*grid-template-columns:\s*repeat\(3,/su);
  assert.match(styles, /data-page="personas"\]\s+\.management-icon-button\s*\{[^}]*grid-row:\s*1/su);
});
