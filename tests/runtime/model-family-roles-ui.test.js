const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const projectRoot = path.resolve(__dirname, '..', '..');

function loadManagementModules() {
  const modelOptionsPath = path.join(projectRoot, 'public/shared/model-options.js');
  const sourcePath = path.join(projectRoot, 'public/personas/management-utils.js');
  const dom = new JSDOM('<select id="shared"></select><select id="management"></select>');
  const context = {
    document: dom.window.document,
    structuredClone,
    window: { CaffPersonas: {}, CaffShared: {} },
  };
  vm.runInNewContext(fs.readFileSync(modelOptionsPath, 'utf8'), context, { filename: modelOptionsPath });
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return {
    managementUtils: context.window.CaffPersonas.managementUtils,
    modelOptionUtils: context.window.CaffShared.modelOptions,
    document: context.document,
  };
}

function loadManagementUtils() {
  return loadManagementModules().managementUtils;
}

function loadProviderManagement(provider) {
  const dom = new JSDOM(`
    <ul id="provider-list"></ul>
    <section id="provider-detail"></section>
    <button id="add-provider"></button>
    <button id="import-provider"></button>
    <button id="refresh-providers"></button>
    <span id="provider-count"></span>
  `);
  const context = {
    document: dom.window.document,
    window: dom.window,
  };
  context.window.CaffShared = {};
  context.window.CaffPersonas = {
    createProviderEditor() {
      return { show() {} };
    },
    createCatalogImport() {
      return { async open() {} };
    },
  };

  for (const file of ['public/shared/management-list.js', 'public/personas/provider-management.js']) {
    const sourcePath = path.join(projectRoot, file);
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }

  const management = context.window.CaffPersonas.createProviderManagement({
    list: context.document.getElementById('provider-list'),
    detail: context.document.getElementById('provider-detail'),
    addButton: context.document.getElementById('add-provider'),
    importButton: context.document.getElementById('import-provider'),
    refreshButton: context.document.getElementById('refresh-providers'),
    count: context.document.getElementById('provider-count'),
    isEnabled: () => true,
    getCsrfToken: () => '',
    showToast() {},
    async onProvidersChanged() {},
    async fetchJson(url) {
      assert.equal(url, '/api/model-providers');
      return { providers: [provider] };
    },
  });

  return { document: context.document, management };
}

test('production management page loads focused modules before the entry and preserves the compatibility route', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'public/personas.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script defer src="([^"]+)"/gu), (match) => match[1]);
  assert.deepEqual(scripts.slice(-8), [
    '/personas/management-utils.js',
    '/personas/role-editor.js',
    '/personas/role-management.js',
    '/personas/provider-editor.js',
    '/personas/catalog-import.js',
    '/personas/provider-management.js',
    '/personas/recovery-scribe-management.js',
    '/personas.js',
  ]);
  assert.match(html, /id="role-management-view"/u);
  assert.match(html, /id="provider-management-view"/u);
  assert.match(html, /模型供应商/u);
  assert.equal(html.includes('人格管理中心'), false);
});

test('configured provider cards display the provider id instead of the runtime API dialect', async () => {
  const { document, management } = loadProviderManagement({
    id: 'kimi-for-coding',
    name: 'Kimi K3-256K',
    api: 'anthropic-messages',
    models: [{ id: 'kimi-k3-256k' }],
  });

  await management.refresh();

  const meta = document.querySelector('#provider-list small');
  assert.ok(meta);
  assert.match(meta.textContent, /kimi-for-coding/u);
  assert.doesNotMatch(meta.textContent, /anthropic-messages/u);
});

test('role UI payload keeps family fields credential-free and preserves complete custom capabilities', () => {
  const utils = loadManagementUtils();
  const family = utils.buildRolePayload({
    id: 'role-family-gpt', roleKind: 'model_family', provider: 'openai', model: 'gpt-5.4', thinking: 'high',
    avatarDataUrl: 'data:image/png;base64,AAAA',
    personaPrompt: 'must not leak', skillIds: ['must-not-submit'], isDefaultChatRole: true,
    modelProfiles: [{ id: 'deep', name: 'Deep', provider: 'openai', model: 'gpt-5.4', thinking: 'high', personaPrompt: 'must not leak' }],
  }, [{
    key: 'openai\u001fgpt-5.4', provider: 'openai', model: 'gpt-5.4', family: 'gpt',
    supportedThinkingLevels: ['off', 'low', 'high'],
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(family)), {
    provider: 'openai', model: 'gpt-5.4', thinking: 'high',
    avatarDataUrl: 'data:image/png;base64,AAAA',
    modelProfiles: [{ id: 'deep', name: 'Deep', description: '', provider: 'openai', model: 'gpt-5.4', thinking: 'high' }],
    isDefaultChatRole: true,
    sessionReuseEnabled: true,
  });

  const custom = utils.buildRolePayload({
    id: 'custom-reviewer', roleKind: 'custom', name: 'Reviewer', description: 'Review', sandboxName: 'reviewer',
    avatarDataUrl: '', personaPrompt: 'Review carefully', provider: 'anthropic', model: 'claude-opus', thinking: 'high',
    accentColor: '#123456', skillIds: ['source-audit'], isDefaultChatRole: false,
    modelProfiles: [{ id: 'deep', name: 'Deep', provider: 'openai', model: 'gpt-5.4', thinking: 'high', personaPrompt: 'Profile persona' }],
  }, [
    { key: 'anthropic\u001fclaude-opus', provider: 'anthropic', model: 'claude-opus', supportedThinkingLevels: ['off', 'low', 'high'] },
    { key: 'openai\u001fgpt-5.4', provider: 'openai', model: 'gpt-5.4', supportedThinkingLevels: ['off', 'low', 'high'] },
  ]);
  assert.equal(custom.personaPrompt, 'Review carefully');
  assert.deepEqual(Array.from(custom.skillIds), ['source-audit']);
  assert.equal(custom.modelProfiles[0].personaPrompt, 'Profile persona');
});

test('all model selectors identify provider and catalog source for same-name models', () => {
  const { managementUtils, modelOptionUtils, document } = loadManagementModules();
  const options = [
    { key: 'moonshot\u001fkimi-code', provider: 'moonshot', model: 'kimi-code', label: 'Kimi Code', source: 'models_json', sourceLabel: 'models.json' },
    { key: 'together\u001fkimi-code', provider: 'together', model: 'kimi-code', label: 'Kimi Code', source: 'runtime', sourceLabel: 'runtime default' },
  ];

  const sharedSelect = document.getElementById('shared');
  modelOptionUtils.fillModelSelect(sharedSelect, options);
  const managementSelect = document.getElementById('management');
  managementUtils.fillModelSelect(managementSelect, options, '', '');

  const expected = [
    'Kimi Code · moonshot · 已配置',
    'Kimi Code · together · 运行时默认',
  ];
  assert.deepEqual(Array.from(sharedSelect.options).slice(1).map((option) => option.textContent), expected);
  assert.deepEqual(Array.from(managementSelect.options).map((option) => option.textContent), expected);
});

test('shared fetch client merges CSRF headers without changing the JSON contract', async () => {
  let captured = null;
  const sourcePath = path.join(projectRoot, 'public/shared/api-client.js');
  const context = {
    fetch: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
    window: { CaffShared: {} },
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  const result = await context.window.CaffShared.fetchJson('/api/model-providers/openai', {
    method: 'PUT', body: { apiKey: '' }, headers: { 'X-CAFF-CSRF-Token': 'token' },
  });
  assert.equal(result.ok, true);
  assert.equal(captured.options.headers['X-CAFF-CSRF-Token'], 'token');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.equal(captured.options.body, '{"apiKey":""}');
});
