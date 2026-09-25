const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const projectRoot = path.resolve(__dirname, '..', '..');

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const PROVENANCE = {
  kind: 'vendored',
  sourceUrl: 'https://models.dev/api.json',
  payloadSha256: 'abc123',
  fetchedAt: '2026-08-06T00:00:00.000Z',
  commitSha: 'deadbeef',
};

const INDEX = {
  provenance: PROVENANCE,
  providers: [
    {
      id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'],
      models: [{ id: 'gpt-5', name: 'GPT-5', dialect: 'openai-responses', family: 'gpt', familyStatus: 'mapped', manualConfigurationRequired: false }],
    },
    {
      id: 'azure', name: 'Azure OpenAI', env: ['AZURE_API_KEY', 'AZURE_RESOURCE_NAME'],
      models: [{ id: 'gpt-5', name: 'GPT-5 on Azure', dialect: 'openai-responses', family: 'gpt', familyStatus: 'mapped', manualConfigurationRequired: false }],
    },
    {
      id: 'mystery', name: 'Mystery', env: [],
      models: [{ id: 'm-1', name: 'M1', familyStatus: 'unclassified', manualConfigurationRequired: true }],
    },
  ],
};

function projectionFor(providerId, modelId) {
  if (providerId === 'mystery') {
    return {
      providerId, modelId, name: 'M1', dialect: undefined, baseUrl: '', family: undefined,
      familyStatus: 'unclassified', env: [], manualConfigurationRequired: true,
      catalogMetadata: { modalities: undefined, reasoningOptions: undefined, cost: undefined, limit: undefined },
      provenance: PROVENANCE,
    };
  }
  const azure = providerId === 'azure';
  return {
    providerId, modelId, name: azure ? 'GPT-5 on Azure' : 'GPT-5',
    dialect: 'openai-responses', baseUrl: azure ? 'https://example.openai.azure.com' : 'https://api.openai.com/v1',
    family: 'gpt', familyStatus: 'mapped',
    env: azure
      ? [{ name: 'AZURE_API_KEY', kind: 'parameter', required: false }, { name: 'AZURE_RESOURCE_NAME', kind: 'parameter', required: false }]
      : [{ name: 'OPENAI_API_KEY', kind: 'key', required: true }],
    manualConfigurationRequired: false,
    input: azure ? undefined : ['text'],
    contextWindow: 400000,
    maxTokens: 128000,
    catalogMetadata: {
      modalities: { input: ['text'], output: ['text'] },
      reasoningOptions: { effort: ['low', 'high'] },
      cost: { input: 1.25, output: 10 },
      limit: { context: 400000, output: 128000 },
    },
    provenance: PROVENANCE,
  };
}

function setup({ fetchImpl, onImported, onClose }) {
  const dom = new JSDOM('<div id="root"></div>');
  const context = {
    document: dom.window.document,
    Event: dom.window.Event,
    URL,
    structuredClone,
    window: { CaffPersonas: {}, CaffShared: {} },
  };
  for (const rel of ['public/shared/model-options.js', 'public/shared/endpoint-diagnostics.js', 'public/personas/management-utils.js', 'public/personas/catalog-import.js']) {
    const sourcePath = path.join(projectRoot, rel);
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }
  const calls = [];
  const imported = [];
  const toasts = [];
  let closed = 0;
  const wizard = context.window.CaffPersonas.createCatalogImport({
    root: dom.window.document.getElementById('root'),
    isEnabled: () => true,
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      return fetchImpl(url, options);
    },
    getCsrfToken: () => 'csrf-token',
    showToast: (message) => toasts.push(message),
    onImported: onImported || ((providerId, modelId) => imported.push({ providerId, modelId })),
    onClose: onClose || (() => { closed += 1; }),
  });
  return {
    wizard,
    calls,
    imported,
    toasts,
    document: dom.window.document,
    isClosed: () => closed > 0,
    input(id) {
      return dom.window.document.getElementById(id);
    },
    type(id, value) {
      const element = dom.window.document.getElementById(id);
      element.value = value;
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    },
  };
}

function indexFetch(url) {
  if (url === '/api/model-catalog') return Promise.resolve(structuredClone(INDEX));
  const match = /\/api\/model-catalog\?providerId=([^&]+)&modelId=(.+)$/u.exec(url);
  if (match) {
    return Promise.resolve({
      projection: projectionFor(decodeURIComponent(match[1]), decodeURIComponent(match[2])),
      runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 },
    });
  }
  if (url === '/api/model-catalog/import') return Promise.resolve({ providers: [], write: { backupCreated: true } });
  return Promise.reject(new Error(`unexpected url ${url}`));
}

test('catalog import wizard lists providers, filters by search, and keeps catalog metadata separate from runtime controls', async () => {
  const session = setup({ fetchImpl: indexFetch });
  await session.wizard.open();

  const rows = Array.from(session.document.querySelectorAll('[data-catalog-provider]'));
  assert.equal(rows.length, 3);

  session.type('catalog-import-search', 'azure');
  const filtered = Array.from(session.document.querySelectorAll('[data-catalog-provider]'))
    .filter((row) => !row.classList.contains('hidden'));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].dataset.catalogProvider, 'azure');

  session.type('catalog-import-search', '');
  session.document.querySelector('[data-catalog-provider="openai"] button').click();
  session.document.querySelector('[data-catalog-model="gpt-5"] button').click();
  await flush();

  const metadata = session.document.getElementById('catalog-import-metadata');
  assert.ok(metadata, 'metadata section exists');
  assert.match(metadata.textContent, /OPENAI_API_KEY/u);
  assert.match(metadata.textContent, /密钥/u);
  assert.match(metadata.textContent, /参考/u);
  assert.match(metadata.textContent, /deadbeef/u);
  assert.match(metadata.textContent, /目录元数据/u);
  assert.equal(metadata.textContent.includes('sk-'), false, 'never renders secret-looking values');

  const controls = session.document.getElementById('catalog-import-controls');
  assert.ok(controls, 'import controls section exists');
  assert.equal(controls.contains(metadata), false, 'metadata is not nested inside runtime controls');
  assert.match(controls.textContent, /模型显示名称/u);
  assert.equal(session.input('catalog-import-name').value, 'GPT-5');
  assert.equal(session.input('catalog-import-base-url').value, 'https://api.openai.com/v1');
  assert.equal(session.input('catalog-import-context-window').value, '400000');
  assert.equal(session.input('catalog-import-context-window').readOnly, true);
  assert.equal(session.input('catalog-import-max-tokens').value, '128000');
  assert.equal(session.input('catalog-import-max-tokens').readOnly, true);
  assert.match(session.document.getElementById('catalog-import-limit-source').textContent, /写入模型运行配置/u);
  assert.equal(session.input('catalog-import-confirm').disabled, false);
});

test('catalog import search matches provider id and name only', async () => {
  const session = setup({ fetchImpl: indexFetch });
  await session.wizard.open();

  session.type('catalog-import-search', 'm-1');
  let visible = Array.from(session.document.querySelectorAll('[data-catalog-provider]'))
    .filter((row) => !row.classList.contains('hidden'));
  assert.deepEqual(visible.map((row) => row.dataset.catalogProvider), [], 'model-only query does not match a provider');

  session.type('catalog-import-search', 'azure open');
  visible = Array.from(session.document.querySelectorAll('[data-catalog-provider]'))
    .filter((row) => !row.classList.contains('hidden'));
  assert.deepEqual(visible.map((row) => row.dataset.catalogProvider), ['azure']);

  session.type('catalog-import-search', '');
  visible = Array.from(session.document.querySelectorAll('[data-catalog-provider]'))
    .filter((row) => !row.classList.contains('hidden'));
  assert.equal(visible.length, 3, 'clearing the filter restores the full provider list');
});

test('catalog import search filters in place without replacing the input or refetching the catalog', async () => {
  const session = setup({ fetchImpl: indexFetch });
  await session.wizard.open();

  const search = session.input('catalog-import-search');
  const callsBeforeTyping = session.calls.length;
  search.focus();
  search.value = 'azure';
  search.setSelectionRange(3, 3);
  search.dispatchEvent(new session.document.defaultView.Event('input', { bubbles: true }));

  assert.equal(session.input('catalog-import-search'), search, 'filtering keeps the existing input node');
  assert.equal(search.value, 'azure');
  assert.equal(search.selectionStart, 3, 'selection start remains unchanged');
  assert.equal(search.selectionEnd, 3, 'selection end remains unchanged');
  assert.equal(session.calls.length, callsBeforeTyping, 'typing does not issue another catalog request');
});

test('catalog import confirm posts only the allowed import fields and never env values', async () => {
  const session = setup({ fetchImpl: indexFetch });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="azure"] button').click();
  session.document.querySelector('[data-catalog-model="gpt-5"] button').click();
  await flush();

  session.type('catalog-import-name', '我的 Azure GPT');
  session.input('catalog-import-reasoning').checked = true;
  session.input('catalog-import-confirm').click();
  await flush();

  const post = session.calls.find((call) => call.url === '/api/model-catalog/import');
  assert.ok(post, 'import POST issued');
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.headers['X-CAFF-CSRF-Token'], 'csrf-token');
  const bodyText = typeof post.options.body === 'string' ? post.options.body : JSON.stringify(post.options.body);
  assert.deepEqual(JSON.parse(bodyText), {
    providerId: 'azure',
    modelId: 'gpt-5',
    name: '我的 Azure GPT',
    baseUrl: 'https://example.openai.azure.com',
    reasoning: true,
    input: ['text'],
    contextWindow: 400000,
    maxTokens: 128000,
  });
  assert.equal(bodyText.includes('AZURE_API_KEY'), false, 'env names are not submitted');
  assert.equal(bodyText.includes('apiKey'), false, 'no apiKey field submitted');
  // onImported only fires on explicit completion (完成), after the advisory.
  assert.deepEqual(session.imported, []);
  session.document.getElementById('catalog-import-confirm').click();
  await flush();
  assert.deepEqual(session.imported, [{ providerId: 'azure', modelId: 'gpt-5' }]);
});

test('catalog import leaves missing limits empty and identifies server-projected Pi defaults without inventing values', async () => {
  const session = setup({
    fetchImpl: async (url, options) => {
      const result = await indexFetch(url, options);
      if (url.includes('providerId=mystery')) {
        result.runtimeDefaults = { contextWindow: 131072, maxTokens: 4096 };
      }
      return result;
    },
  });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="mystery"] button').click();
  session.document.querySelector('[data-catalog-model="m-1"] button').click();
  await flush();

  assert.equal(session.input('catalog-import-context-window').value, '');
  assert.equal(session.input('catalog-import-context-window').placeholder, 'Pi 默认 131072');
  assert.equal(session.input('catalog-import-max-tokens').value, '');
  assert.equal(session.input('catalog-import-max-tokens').placeholder, 'Pi 默认 4096');
  assert.match(session.document.getElementById('catalog-import-limit-source').textContent, /不会猜测或写入/u);
});

test('manual-configuration models fail closed and never offer an import action', async () => {
  const session = setup({ fetchImpl: indexFetch });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="mystery"] button').click();
  session.document.querySelector('[data-catalog-model="m-1"] button').click();
  await flush();

  assert.match(session.document.getElementById('catalog-import-metadata').innerHTML, /未归类/u);
  assert.match(session.document.getElementById('catalog-import-manual').textContent, /手工配置/u);
  assert.equal(session.input('catalog-import-confirm').disabled, true);
  session.input('catalog-import-confirm').click();
  await flush();
  assert.equal(session.calls.some((call) => call.url === '/api/model-catalog/import'), false);
});

test('catalog source unavailable renders an honest empty state without import actions', async () => {
  const error = new Error('Model catalog operation failed');
  error.issues = [{ code: 'catalog_source_unavailable', path: '/assets/model-catalog.json' }];
  const session = setup({
    fetchImpl: (url) => (url === '/api/model-catalog' ? Promise.reject(error) : Promise.reject(new Error('unexpected'))),
  });
  await session.wizard.open();
  assert.match(session.document.getElementById('catalog-import-unavailable').textContent, /目录快照未就位/u);
  assert.equal(session.document.querySelector('[data-catalog-provider]'), null);
});

const ONLINE_PROVENANCE = {
  kind: 'online',
  sourceUrl: 'https://models.dev/api.json',
  payloadSha256: 'def456',
  fetchedAt: '2026-09-15T00:00:00.000Z',
  etag: '"etag-2"',
  commitSha: 'online-sha',
};

test('catalog import wizard refreshes the online catalog and reports the new snapshot', async () => {
  const refreshedIndex = structuredClone(INDEX);
  refreshedIndex.provenance = ONLINE_PROVENANCE;
  let refreshed = false;
  const session = setup({
    fetchImpl: (url, options) => {
      if (url === '/api/model-catalog/refresh') {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-CAFF-CSRF-Token'], 'csrf-token');
        assert.equal(
          options.headers['Content-Type'],
          'application/json',
          'refresh is a bodyless admin mutation and must still declare application/json for the local admin guard'
        );
        refreshed = true;
        return Promise.resolve({
          status: 'refreshed',
          providerCount: 182,
          provenance: ONLINE_PROVENANCE,
        });
      }
      if (url === '/api/model-catalog') {
        return Promise.resolve(structuredClone(refreshed ? refreshedIndex : INDEX));
      }
      return indexFetch(url, options);
    },
  });
  await session.wizard.open();

  const refreshButton = session.document.getElementById('catalog-import-refresh');
  assert.ok(refreshButton, 'refresh button is rendered next to the catalog provenance');
  assert.match(refreshButton.textContent, /刷新目录/u);

  refreshButton.click();
  for (let index = 0; index < 5; index += 1) await flush();

  assert.equal(refreshed, true, 'refresh posts to the admin route');
  assert.match(
    session.document.querySelector('.management-card-title p').textContent,
    /online/u,
    'index provenance reflects the online cache after refresh'
  );
  assert.deepEqual(session.toasts, ['目录已更新：182 家供应商']);
});

test('catalog import wizard reports an etag hit without changing the catalog', async () => {
  let refreshed = false;
  const session = setup({
    fetchImpl: (url, options) => {
      if (url === '/api/model-catalog/refresh') {
        refreshed = true;
        return Promise.resolve({ status: 'not_modified', provenance: PROVENANCE, providerCount: 3 });
      }
      return indexFetch(url, options);
    },
  });
  await session.wizard.open();

  session.document.getElementById('catalog-import-refresh').click();
  for (let index = 0; index < 5; index += 1) await flush();

  assert.equal(refreshed, true);
  assert.equal(
    Array.from(session.document.querySelectorAll('[data-catalog-provider]')).length,
    3,
    'catalog content stays the same on a not-modified response'
  );
  assert.deepEqual(session.toasts, ['目录已是最新：远端内容未变化（ETag 命中）']);
});

test('catalog import wizard surfaces refresh failures without losing the loaded catalog', async () => {
  const session = setup({
    fetchImpl: (url, options) => {
      if (url === '/api/model-catalog/refresh') {
        return Promise.reject(new Error('upstream unavailable'));
      }
      return indexFetch(url, options);
    },
  });
  await session.wizard.open();

  session.document.getElementById('catalog-import-refresh').click();
  for (let index = 0; index < 5; index += 1) await flush();

  const error = session.document.getElementById('catalog-import-error');
  assert.ok(error, 'error element is present after a failed refresh');
  assert.equal(error.classList.contains('hidden'), false, 'refresh failure is visible');
  assert.equal(
    Array.from(session.document.querySelectorAll('[data-catalog-provider]')).length,
    3,
    'the previously loaded catalog stays usable'
  );
  assert.equal(session.document.getElementById('catalog-import-refresh').disabled, false, 'the refresh button re-enables');
});

const STALE_KIMI_INDEX = {
  provenance: PROVENANCE,
  providers: [
    {
      id: 'kimi-for-coding', name: 'Kimi For Coding', env: ['KIMI_API_KEY'],
      models: [{ id: 'kimi-for-coding', name: 'kimi-for-coding', dialect: 'anthropic-messages', family: 'kimi', familyStatus: 'mapped', manualConfigurationRequired: false }],
    },
  ],
};

const STALE_KIMI_PROJECTION = {
  providerId: 'kimi-for-coding', modelId: 'kimi-for-coding', name: 'kimi-for-coding',
  dialect: 'anthropic-messages', baseUrl: 'https://api.kimi.com/coding/v1',
  family: 'kimi', familyStatus: 'mapped',
  env: [{ name: 'KIMI_API_KEY', kind: 'key', required: true }],
  manualConfigurationRequired: false,
  input: ['text'],
  endpointDiagnostic: {
    status: 'mismatch',
    code: 'verified_endpoint_protocol_mismatch',
    suggestion: 'https://api.kimi.com/coding',
    basis: 'pi-vendored-registry:kimi-coding',
    message: '已核实的 Kimi For Coding 端点：Anthropic 协议应使用 https://api.kimi.com/coding。客户端会自动追加 /v1/messages，当前地址实际会请求 https://api.kimi.com/coding/v1/v1/messages。',
  },
  effectiveDialect: 'anthropic-messages',
  dialectConflict: null,
  modelEndpointOverride: null,
  catalogMetadata: {},
  provenance: PROVENANCE,
};

function staleKimiFetch(url) {
  if (url === '/api/model-catalog') return Promise.resolve(structuredClone(STALE_KIMI_INDEX));
  if (url.startsWith('/api/model-catalog?')) {
    return Promise.resolve({
      projection: structuredClone(STALE_KIMI_PROJECTION),
      runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 },
    });
  }
  if (url === '/api/model-catalog/import') return Promise.resolve({ providers: [], write: { backupCreated: true } });
  return Promise.reject(new Error(`unexpected url ${url}`));
}

test('catalog import surfaces the endpoint diagnostic and applies the suggestion only on explicit click', async () => {
  const session = setup({ fetchImpl: staleKimiFetch });
  await session.wizard.open();

  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();

  // The raw catalog URL stays in the readonly metadata and in the editable input.
  const metadata = session.document.getElementById('catalog-import-metadata');
  assert.match(metadata.innerHTML, /https:\/\/api\.kimi\.com\/coding\/v1/u);
  assert.equal(session.input('catalog-import-base-url').value, 'https://api.kimi.com/coding/v1');

  // Diagnostic warning with the suggestion is visible.
  const warning = session.document.getElementById('catalog-import-endpoint-warning');
  assert.ok(warning, 'endpoint warning exists');
  assert.match(warning.textContent, /\/v1\/messages/u);
  assert.match(warning.textContent, /https:\/\/api\.kimi\.com\/coding/u);
  const apply = session.document.getElementById('catalog-import-apply-endpoint-suggestion');
  assert.ok(apply, 'explicit apply button exists');

  // Without clicking, import sends the original catalog URL untouched.
  session.document.getElementById('catalog-import-confirm').click();
  await flush();
  const importCall = session.calls.find((call) => call.url === '/api/model-catalog/import');
  assert.equal(importCall.options.body.baseUrl, 'https://api.kimi.com/coding/v1');
});

test('catalog import carries the suggested URL only after an explicit apply click', async () => {
  const session = setup({ fetchImpl: staleKimiFetch });
  await session.wizard.open();

  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();

  session.document.getElementById('catalog-import-apply-endpoint-suggestion').click();
  await flush();
  assert.equal(session.input('catalog-import-base-url').value, 'https://api.kimi.com/coding');

  session.document.getElementById('catalog-import-confirm').click();
  await flush();
  const importCall = session.calls.find((call) => call.url === '/api/model-catalog/import');
  assert.equal(importCall.options.body.baseUrl, 'https://api.kimi.com/coding');
});

test('unverified OpenAI endpoints get a neutral preview hint without a suggestion', async () => {
  const session = setup({ fetchImpl: indexFetch });
  await session.wizard.open();

  session.document.querySelector('[data-catalog-provider="openai"] button').click();
  session.document.querySelector('[data-catalog-model="gpt-5"] button').click();
  await flush();

  const hint = session.document.getElementById('catalog-import-endpoint-warning');
  assert.ok(hint, 'neutral verify hint shown for the unverified openai endpoint');
  assert.match(hint.textContent, /核对/u);
  assert.equal(session.document.getElementById('catalog-import-apply-endpoint-suggestion'), null, 'no suggestion button for unverified endpoints');
});

test('post-import advisory is displayed before any callback can replace the page', async () => {
  const importResponse = {
    providers: [],
    write: { backupCreated: true },
    endpointDiagnostic: {
      status: 'mismatch',
      code: 'verified_endpoint_protocol_mismatch',
      suggestion: 'https://api.kimi.com/coding',
      basis: 'pi-vendored-registry:kimi-coding',
      message: '已核实的 Kimi For Coding 端点：落盘后协议与地址仍不匹配。',
    },
    modelEndpointDiagnostic: {
      status: 'unverified',
      code: 'endpoint_not_verified',
      basis: 'vendored-openai-client-appends-chat-completions',
      message: '模型级覆盖的端点未核实，请自行核对。',
    },
    siblingEndpointDiagnostics: [
      {
        modelId: 'sibling-model',
        api: 'openai-completions',
        baseUrl: 'https://api.kimi.com/coding',
        diagnostic: {
          status: 'mismatch',
          code: 'verified_endpoint_protocol_mismatch',
          suggestion: 'https://api.kimi.com/coding/v1',
          basis: 'models.dev:kimi-code-plan-cn',
          message: '已核实的 Kimi For Coding 端点：OpenAI 兼容协议应使用 https://api.kimi.com/coding/v1。',
        },
      },
    ],
  };
  const session = setup({
    fetchImpl: (url) => {
      if (url === '/api/model-catalog') return Promise.resolve(structuredClone(STALE_KIMI_INDEX));
      if (url.startsWith('/api/model-catalog?')) {
        return Promise.resolve({ projection: structuredClone(STALE_KIMI_PROJECTION), runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 } });
      }
      if (url === '/api/model-catalog/import') return Promise.resolve(structuredClone(importResponse));
      return Promise.reject(new Error(`unexpected url ${url}`));
    },
  });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();

  session.document.getElementById('catalog-import-confirm').click();
  await flush();

  // The advisory must be visible while the wizard still owns the page: the
  // completion callback (which replaces the detail pane in the real chain)
  // only fires when the user explicitly finishes.
  assert.equal(session.imported.length, 0, 'onImported must not fire before the user dismisses the advisory');
  const advisory = session.document.getElementById('catalog-import-post-import');
  assert.ok(advisory, 'post-import advisory panel exists');
  assert.match(advisory.textContent, /落盘后协议与地址仍不匹配/u, 'provider-level advisory shown');
  assert.match(advisory.textContent, /模型级覆盖/u, 'model-level advisory shown');
  assert.match(advisory.textContent, /sibling-model/u, 'sibling impact reported');

  const confirmButton = /** @type {HTMLButtonElement} */ (session.document.getElementById('catalog-import-confirm'));
  assert.match(confirmButton.textContent, /完成/u, 'confirm becomes the completion button');
  assert.equal(confirmButton.disabled, false, 'completion button is clickable');
  confirmButton.click();
  await flush();
  assert.equal(session.imported.length, 1, 'onImported fires on explicit completion');
});

test('closing the advisory state still refreshes providers before returning', async () => {
  const session = setup({ fetchImpl: staleKimiFetch });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();

  session.document.getElementById('catalog-import-confirm').click();
  await flush();
  assert.ok(session.document.getElementById('catalog-import-post-import'));
  assert.equal(session.imported.length, 0);

  session.document.getElementById('catalog-import-close').click();
  await flush();
  await flush();
  assert.equal(session.imported.length, 1, 'close path refreshes providers too, so the list is never stale');
  assert.ok(session.isClosed(), 'onClose fired after the refresh');
});

test('a clean import result reports no diagnosable problems', async () => {
  const session = setup({ fetchImpl: staleKimiFetch });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();

  session.document.getElementById('catalog-import-apply-endpoint-suggestion').click();
  await flush();
  session.document.getElementById('catalog-import-confirm').click();
  await flush();

  const advisory = session.document.getElementById('catalog-import-post-import');
  assert.ok(advisory, 'post-import advisory panel exists');
  assert.match(advisory.textContent, /未发现/u, 'clean result is stated explicitly instead of silence');
  assert.equal(session.imported.length, 0, 'completion still waits for the user');
});

test('R3b: applying a provider-level suggestion lists the sibling impact before anything is applied', async () => {
  const siblingProjection = {
    ...structuredClone(STALE_KIMI_PROJECTION),
    siblingModelOverrides: [
      { modelId: 'sibling-model', api: 'openai-completions', baseUrl: '' },
      { modelId: 'pinned-model', api: 'openai-completions', baseUrl: 'https://api.kimi.com/coding/v1' },
    ],
  };
  const session = setup({
    fetchImpl: (url) => {
      if (url === '/api/model-catalog') return Promise.resolve(structuredClone(STALE_KIMI_INDEX));
      if (url.startsWith('/api/model-catalog?')) {
        return Promise.resolve({ projection: structuredClone(siblingProjection), runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 } });
      }
      if (url === '/api/model-catalog/import') return Promise.resolve({ providers: [], write: { backupCreated: true } });
      return Promise.reject(new Error(`unexpected url ${url}`));
    },
  });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();

  // The suggestion is offered together with its provider-level impact: the
  // sibling without its own baseUrl would become a verified mismatch under
  // the suggested URL; the sibling with its own baseUrl override is unaffected.
  const impact = session.document.getElementById('catalog-import-sibling-impact');
  assert.ok(impact, 'sibling impact block exists next to the suggestion');
  assert.match(impact.textContent, /sibling-model/u);
  assert.match(impact.textContent, /不匹配/u, 'the broken sibling is called out');
  assert.match(impact.textContent, /https:\/\/api\.kimi\.com\/coding\/v1/u, 'sibling advice shown');
  assert.doesNotMatch(impact.textContent, /pinned-model/u, 'siblings with their own baseUrl are unaffected and not listed');
  assert.ok(session.document.getElementById('catalog-import-apply-endpoint-suggestion'), 'apply button present with its explanation');
});

test('R3b: an api-only model override no longer claims the provider URL is irrelevant', async () => {
  const apiOnlyProjection = {
    ...structuredClone(STALE_KIMI_PROJECTION),
    modelEndpointOverride: {
      api: 'openai-completions',
      diagnostic: {
        status: 'mismatch',
        code: 'verified_endpoint_protocol_mismatch',
        suggestion: 'https://api.kimi.com/coding/v1',
        basis: 'models.dev:kimi-code-plan-cn',
        message: '已核实的 Kimi For Coding 端点：OpenAI 兼容协议应使用 https://api.kimi.com/coding/v1。',
      },
    },
  };
  const session = setup({
    fetchImpl: (url) => {
      if (url === '/api/model-catalog') return Promise.resolve(structuredClone(STALE_KIMI_INDEX));
      if (url.startsWith('/api/model-catalog?')) {
        return Promise.resolve({ projection: structuredClone(apiOnlyProjection), runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 } });
      }
      if (url === '/api/model-catalog/import') return Promise.resolve({ providers: [], write: { backupCreated: true } });
      return Promise.reject(new Error(`unexpected url ${url}`));
    },
  });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();

  const overrideNote = session.document.getElementById('catalog-import-model-override');
  assert.ok(overrideNote);
  assert.match(overrideNote.textContent, /openai-completions/u, 'the effective protocol is stated');
  assert.match(overrideNote.textContent, /会改变该模型的实际请求/u, 'the note admits the provider URL still drives this model');
  assert.doesNotMatch(overrideNote.textContent, /不会改变该模型的实际请求/u, 'the old wrong claim is gone');
});

test('R3: a stored provider protocol conflict is shown and no suggestion is offered against the catalog dialect', async () => {
  // Stored provider already uses openai-completions; the stale catalog pairs
  // anthropic-messages with /coding/v1. The effective combination (openai +
  // /coding/v1) is consistent, so no apply button may appear.
  const conflictProjection = {
    ...structuredClone(STALE_KIMI_PROJECTION),
    endpointDiagnostic: null,
    effectiveDialect: 'openai-completions',
    dialectConflict: { storedApi: 'openai-completions', catalogDialect: 'anthropic-messages' },
  };
  const session = setup({
    fetchImpl: (url) => {
      if (url === '/api/model-catalog') return Promise.resolve(structuredClone(STALE_KIMI_INDEX));
      if (url.startsWith('/api/model-catalog?')) {
        return Promise.resolve({ projection: structuredClone(conflictProjection), runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 } });
      }
      if (url === '/api/model-catalog/import') return Promise.resolve({ providers: [], write: { backupCreated: true } });
      return Promise.reject(new Error(`unexpected url ${url}`));
    },
  });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();

  const conflict = session.document.getElementById('catalog-import-dialect-conflict');
  assert.ok(conflict, 'dialect conflict note exists');
  assert.match(conflict.textContent, /openai-completions/u);
  assert.match(conflict.textContent, /anthropic-messages/u);
  assert.match(conflict.textContent, /不会/u, 'note explains the import will not change the stored protocol');
  assert.equal(session.document.getElementById('catalog-import-endpoint-warning'), null, 'no mismatch warning for the effective combination');
  assert.equal(session.document.getElementById('catalog-import-apply-endpoint-suggestion'), null, 'no suggestion offered');

  session.document.getElementById('catalog-import-confirm').click();
  await flush();
  const importCall = session.calls.find((call) => call.url === '/api/model-catalog/import');
  assert.equal(importCall.options.body.baseUrl, 'https://api.kimi.com/coding/v1', 'import still posts the visible URL');
});

test('R3: a stored model-level override is surfaced and survives the provider-level suggestion', async () => {
  const overrideProjection = {
    ...structuredClone(STALE_KIMI_PROJECTION),
    modelEndpointOverride: {
      baseUrl: 'https://api.kimi.com/coding/v1',
      diagnostic: {
        status: 'mismatch',
        code: 'verified_endpoint_protocol_mismatch',
        suggestion: 'https://api.kimi.com/coding',
        basis: 'pi-vendored-registry:kimi-coding',
        message: '已核实的 Kimi For Coding 端点：Anthropic 协议应使用 https://api.kimi.com/coding。',
      },
    },
  };
  const session = setup({
    fetchImpl: (url) => {
      if (url === '/api/model-catalog') return Promise.resolve(structuredClone(STALE_KIMI_INDEX));
      if (url.startsWith('/api/model-catalog?')) {
        return Promise.resolve({ projection: structuredClone(overrideProjection), runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 } });
      }
      if (url === '/api/model-catalog/import') return Promise.resolve({ providers: [], write: { backupCreated: true } });
      return Promise.reject(new Error(`unexpected url ${url}`));
    },
  });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();

  const overrideNote = session.document.getElementById('catalog-import-model-override');
  assert.ok(overrideNote, 'model override note exists');
  assert.match(overrideNote.textContent, /模型级/u);
  assert.match(overrideNote.textContent, /优先/u, 'note explains the override keeps precedence');

  // Applying the provider-level suggestion fixes the provider URL input but
  // the override warning must remain — the model still uses its own address.
  session.document.getElementById('catalog-import-apply-endpoint-suggestion').click();
  await flush();
  assert.equal(session.input('catalog-import-base-url').value, 'https://api.kimi.com/coding');
  assert.equal(session.document.getElementById('catalog-import-endpoint-warning'), null, 'provider-level warning clears');
  assert.ok(session.document.getElementById('catalog-import-model-override'), 'override note remains after provider fix');
});

test('catalog import shows an unverified hint without a suggestion for unknown anthropic gateways', async () => {
  const gatewayProjection = {
    ...structuredClone(STALE_KIMI_PROJECTION),
    providerId: 'gateway',
    modelId: 'kimi-for-coding',
    baseUrl: 'https://gateway.example.com/tenant/v1',
    endpointDiagnostic: {
      status: 'unverified',
      code: 'anthropic_base_url_version_suffix',
      basis: 'vendored-anthropic-sdk-appends-v1-messages',
      message: 'Anthropic 客户端会自动追加 /v1/messages，实际请求 https://gateway.example.com/tenant/v1/v1/messages。该端点不在已核实清单内，请自行核对。',
    },
  };
  const gatewayIndex = structuredClone(STALE_KIMI_INDEX);
  gatewayIndex.providers[0].id = 'gateway';
  const session = setup({
    fetchImpl: (url) => {
      if (url === '/api/model-catalog') return Promise.resolve(structuredClone(gatewayIndex));
      if (url.startsWith('/api/model-catalog?')) {
        return Promise.resolve({ projection: structuredClone(gatewayProjection), runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 } });
      }
      if (url === '/api/model-catalog/import') return Promise.resolve({ providers: [], write: { backupCreated: true } });
      return Promise.reject(new Error(`unexpected url ${url}`));
    },
  });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="gateway"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();

  const hint = session.document.getElementById('catalog-import-endpoint-warning');
  assert.ok(hint, 'unverified hint exists');
  assert.match(hint.textContent, /核对/u);
  assert.equal(session.document.getElementById('catalog-import-apply-endpoint-suggestion'), null, 'no guessed suggestion');
});

test('catalog import recomputes the diagnostic as the URL input changes', async () => {
  const session = setup({ fetchImpl: staleKimiFetch });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();
  assert.ok(session.document.getElementById('catalog-import-endpoint-warning'));

  session.type('catalog-import-base-url', 'https://api.kimi.com/coding');
  await flush();
  assert.equal(session.document.getElementById('catalog-import-endpoint-warning'), null, 'manual fix clears the warning');
  assert.equal(session.document.getElementById('catalog-import-apply-endpoint-suggestion'), null);

  session.type('catalog-import-base-url', 'https://api.kimi.com/coding/v1');
  await flush();
  assert.ok(session.document.getElementById('catalog-import-endpoint-warning'), 'warning returns on the mismatching URL');
  assert.ok(session.document.getElementById('catalog-import-apply-endpoint-suggestion'));
});

// ---------------------------------------------------------------------------
// R3a integration: the real provider-management chain. The wizard, the editor
// and the management pane share one detail container; the post-import advisory
// must survive until the user finishes, and finishing must hand the pane back
// to the editor with refreshed data.
// ---------------------------------------------------------------------------

test('R3a: the real management chain keeps the advisory visible until the user finishes', async () => {
  const dom = new JSDOM(`
    <div id="provider-count"></div>
    <ul id="provider-list"></ul>
    <div id="provider-detail"></div>
    <button id="add-provider"></button>
    <button id="import-provider"></button>
    <button id="refresh-providers"></button>
  `);
  const context = {
    document: dom.window.document,
    Event: dom.window.Event,
    URL,
    structuredClone,
    window: { CaffPersonas: {}, CaffShared: {} },
  };
  for (const rel of [
    'public/shared/management-list.js',
    'public/shared/model-options.js',
    'public/shared/endpoint-diagnostics.js',
    'public/personas/management-utils.js',
    'public/personas/provider-editor.js',
    'public/personas/subscription-login.js',
    'public/personas/catalog-import.js',
    'public/personas/provider-management.js',
  ]) {
    const sourcePath = path.join(projectRoot, rel);
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }

  let providerBaseUrl = 'https://api.kimi.com/coding/v1';
  const providerList = () => ({
    providers: [{
      id: 'kimi-for-coding', name: 'Kimi For Coding', baseUrl: providerBaseUrl,
      api: 'anthropic-messages', authHeader: false, apiKeyMode: 'literal', hasApiKey: true,
      hasExternalAuth: false, hasCustomHeaders: false,
      models: [{ id: 'kimi-for-coding', name: 'kimi-for-coding', family: 'kimi', reasoning: false, input: ['text'] }],
    }],
  });
  const providersChanged = [];
  const management = context.window.CaffPersonas.createProviderManagement({
    list: dom.window.document.getElementById('provider-list'),
    detail: dom.window.document.getElementById('provider-detail'),
    addButton: dom.window.document.getElementById('add-provider'),
    importButton: dom.window.document.getElementById('import-provider'),
    refreshButton: dom.window.document.getElementById('refresh-providers'),
    count: dom.window.document.getElementById('provider-count'),
    subscriptionButton: null,
    isEnabled: () => true,
    getCsrfToken: () => 'csrf-token',
    showToast() {},
    onProvidersChanged: async () => { providersChanged.push('changed'); },
    fetchJson: async (url, options) => {
      if (url === '/api/model-providers') return providerList();
      if (url === '/api/subscription-auth') return { channels: [], logins: [] };
      if (url === '/api/model-catalog') return structuredClone(STALE_KIMI_INDEX);
      if (url.startsWith('/api/model-catalog?')) {
        return { projection: structuredClone(STALE_KIMI_PROJECTION), runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 } };
      }
      if (url === '/api/model-catalog/import') {
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        providerBaseUrl = body.baseUrl || providerBaseUrl;
        return {
          providers: providerList().providers,
          write: { backupCreated: true },
          endpointDiagnostic: {
            status: 'mismatch', code: 'verified_endpoint_protocol_mismatch',
            suggestion: 'https://api.kimi.com/coding', basis: 'pi-vendored-registry:kimi-coding',
            message: '已核实的 Kimi For Coding 端点：落盘后协议与地址仍不匹配。',
          },
          modelEndpointDiagnostic: null,
        };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  await management.refresh();
  const document = dom.window.document;

  document.getElementById('import-provider').click();
  await flush();
  document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();
  document.getElementById('catalog-import-apply-endpoint-suggestion').click();
  await flush();
  document.getElementById('catalog-import-confirm').click();
  await flush();
  await flush();

  // R3a regression point: in the real chain onImported used to fire
  // immediately and replace the detail pane, erasing the advisory.
  const advisory = document.getElementById('catalog-import-post-import');
  assert.ok(advisory, 'advisory is visible in the real management page');
  assert.ok(document.getElementById('provider-detail').contains(advisory), 'the wizard still owns the detail pane');
  assert.equal(providersChanged.length, 0, 'the pane is not replaced before the user finishes');

  document.getElementById('catalog-import-confirm').click(); // 完成
  await flush();
  await flush();
  await flush();

  assert.equal(providersChanged.length, 1, 'finishing refreshes downstream consumers');
  assert.equal(document.getElementById('catalog-import-post-import'), null, 'the wizard handed the pane back');
  assert.ok(document.getElementById('provider-base-url'), 'the provider editor now owns the detail pane');
  assert.equal(document.getElementById('provider-base-url').value, 'https://api.kimi.com/coding', 'editor shows the imported URL');
});

// ---------------------------------------------------------------------------
// R4: import lifecycle. Two CHANGES_REQUESTED findings from the a9630c8
// review: (1) navigating to another model right after an import left the
// target page disabled and then overwritten by the delayed provider refresh;
// (2) the advisory state rebuilt the editable form from the stale projection,
// so the shown URL could diverge from the persisted one while the main button
// had already become a non-saving 完成 button.
// ---------------------------------------------------------------------------

const PERSISTED_KIMI_IMPORT_RESPONSE = (baseUrl) => ({
  providers: [{
    id: 'kimi-for-coding', name: 'Kimi For Coding', baseUrl, api: 'anthropic-messages',
    authHeader: false, apiKeyMode: 'literal', hasApiKey: true, hasExternalAuth: false, hasCustomHeaders: false,
    models: [{
      id: 'kimi-for-coding', name: 'kimi-for-coding', api: '', baseUrl: '',
      family: 'kimi', reasoning: false, input: ['text'], contextWindow: null, maxTokens: null, hasCustomHeaders: false,
    }],
  }],
  endpointDiagnostic: null,
  modelEndpointDiagnostic: null,
  siblingEndpointDiagnostics: [],
  write: { backupCreated: true },
});

function persistedKimiFetch(baseUrlByImport = () => 'https://api.kimi.com/coding') {
  return (url) => {
    if (url === '/api/model-catalog') return Promise.resolve(structuredClone(STALE_KIMI_INDEX));
    if (url.startsWith('/api/model-catalog?')) {
      return Promise.resolve({ projection: structuredClone(STALE_KIMI_PROJECTION), runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 } });
    }
    if (url === '/api/model-catalog/import') return Promise.resolve(structuredClone(PERSISTED_KIMI_IMPORT_RESPONSE(baseUrlByImport())));
    return Promise.reject(new Error(`unexpected url ${url}`));
  };
}

test('R4b: the advisory state shows the persisted values read-only instead of a stale editable form', async () => {
  const session = setup({ fetchImpl: persistedKimiFetch() });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();

  session.document.getElementById('catalog-import-apply-endpoint-suggestion').click();
  await flush();
  session.document.getElementById('catalog-import-confirm').click();
  await flush();

  // No editable import form may survive into the advisory state: the main
  // button is now 完成 and would not save anything.
  assert.equal(session.document.getElementById('catalog-import-base-url'), null, 'no editable base URL input after import');
  assert.equal(session.document.getElementById('catalog-import-name'), null, 'no editable name input after import');
  assert.equal(session.document.getElementById('catalog-import-apply-endpoint-suggestion'), null, 'no apply-suggestion button after import');
  assert.equal(session.document.getElementById('catalog-import-endpoint-warning'), null, 'no pre-import warning re-rendered from the stale projection');

  // The persisted combination (as returned by the import response) is shown
  // read-only instead — the displayed URL must be the submitted /coding, not
  // the catalog's /coding/v1.
  const result = session.document.getElementById('catalog-import-result');
  assert.ok(result, 'read-only import result card exists');
  assert.equal(/** @type {HTMLInputElement} */ (session.document.getElementById('catalog-import-result-base-url')).value, 'https://api.kimi.com/coding');
  assert.equal(/** @type {HTMLInputElement} */ (session.document.getElementById('catalog-import-result-base-url')).readOnly, true);
  assert.equal(/** @type {HTMLInputElement} */ (session.document.getElementById('catalog-import-result-api')).value, 'anthropic-messages');
  assert.equal(/** @type {HTMLInputElement} */ (session.document.getElementById('catalog-import-result-model')).value, 'kimi-for-coding');
  assert.match(result.textContent, /只读/u, 'the card states it is read-only');
  assert.ok(session.document.getElementById('catalog-import-post-import'), 'post-import advisory remains part of the result');
  const confirmButton = /** @type {HTMLButtonElement} */ (session.document.getElementById('catalog-import-confirm'));
  assert.match(confirmButton.textContent, /完成/u);
  assert.equal(confirmButton.disabled, false);
});

test('R4b: a persisted model-level override is reported with its effective combination', async () => {
  const session = setup({
    fetchImpl: (url) => {
      if (url === '/api/model-catalog/import') {
        return Promise.resolve(structuredClone({
          ...PERSISTED_KIMI_IMPORT_RESPONSE('https://api.kimi.com/coding'),
          modelEndpointDiagnostic: {
            status: 'mismatch',
            code: 'verified_endpoint_protocol_mismatch',
            suggestion: 'https://api.kimi.com/coding/v1',
            basis: 'models.dev:kimi-code-plan-cn',
            message: '已核实的 Kimi For Coding 端点：OpenAI 兼容协议应使用 https://api.kimi.com/coding/v1。',
          },
          providers: [{
            id: 'kimi-for-coding', name: 'Kimi For Coding', baseUrl: 'https://api.kimi.com/coding', api: 'anthropic-messages',
            authHeader: false, apiKeyMode: 'literal', hasApiKey: true, hasExternalAuth: false, hasCustomHeaders: false,
            models: [{
              id: 'kimi-for-coding', name: 'kimi-for-coding', api: 'openai-completions', baseUrl: '',
              family: 'kimi', reasoning: false, input: ['text'], contextWindow: null, maxTokens: null, hasCustomHeaders: false,
            }],
          }],
        }));
      }
      return persistedKimiFetch()(url);
    },
  });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();
  session.document.getElementById('catalog-import-confirm').click();
  await flush();

  const result = session.document.getElementById('catalog-import-result');
  assert.ok(result);
  assert.match(result.textContent, /模型级覆盖/u, 'the persisted model override is stated');
  assert.match(result.textContent, /openai-completions/u, 'the model override protocol is stated');
  assert.match(result.textContent, /优先/u, 'the precedence over the provider config is stated');
});

test('R4c: a failed provider refresh on completion is retryable, not a dead end', async () => {
  let attempts = 0;
  let succeeded = 0;
  const session = setup({
    fetchImpl: persistedKimiFetch(),
    onImported: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('provider refresh failed');
      succeeded += 1;
    },
  });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();
  session.document.getElementById('catalog-import-confirm').click();
  await flush();

  // First completion attempt fails: the wizard must stay usable and explicit
  // about the failure instead of silently disabling the button forever.
  session.document.getElementById('catalog-import-confirm').click(); // 完成 (1st)
  await flush();
  const confirmButton = /** @type {HTMLButtonElement} */ (session.document.getElementById('catalog-import-confirm'));
  assert.equal(confirmButton.disabled, false, '完成 stays clickable after a failed refresh');
  const error = session.document.getElementById('catalog-import-error');
  assert.ok(error, 'error element exists');
  assert.equal(error.classList.contains('hidden'), false, 'the refresh failure is surfaced');
  assert.match(error.textContent, /provider refresh failed/u, 'the surfaced error carries the actual refresh failure');
  assert.equal(attempts, 1);

  // Retry succeeds and hands the page back.
  confirmButton.click(); // 完成 (2nd)
  await flush();
  await flush();
  assert.equal(attempts, 2, 'retry issued a second onImported');
  assert.equal(succeeded, 1);
});

test('R4d: refreshing the catalog after an import keeps the handback pending until the user leaves', async () => {
  const session = setup({
    fetchImpl: (url, requestOptions) => {
      if (url === '/api/model-catalog/refresh') return Promise.resolve({ status: 'updated', providerCount: 1 });
      return persistedKimiFetch()(url, requestOptions);
    },
  });
  await session.wizard.open();
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();
  session.document.getElementById('catalog-import-confirm').click();
  await flush();
  assert.ok(session.document.getElementById('catalog-import-post-import'));

  // In-wizard navigation (catalog refresh/reopen) must not fire the completion
  // callback or hand the pane to the editor behind the user's back.
  session.document.getElementById('catalog-import-refresh').click();
  await flush();
  await flush();
  assert.ok(session.document.querySelector('[data-catalog-provider="kimi-for-coding"]'), 'the catalog view is rendered again');
  assert.equal(session.document.getElementById('catalog-import-post-import'), null, 'advisory is cleared on navigation');
  assert.equal(session.imported.length, 0, 'onImported does not fire on in-wizard navigation');
  assert.equal(session.isClosed(), false);

  // Leaving the wizard afterwards still refreshes the provider list exactly once.
  session.document.getElementById('catalog-import-close').click();
  await flush();
  await flush();
  assert.deepEqual(session.imported, [{ providerId: 'kimi-for-coding', modelId: 'kimi-for-coding' }]);
  assert.equal(session.isClosed(), true, 'the pane is handed back after the refresh');
});

test('R4e: consecutive imports navigate cleanly and finish with a single handback', async () => {
  const twoModelIndex = {
    provenance: PROVENANCE,
    providers: [{
      id: 'kimi-for-coding', name: 'Kimi For Coding', env: ['KIMI_API_KEY'],
      models: [
        { id: 'kimi-for-coding', name: 'kimi-for-coding', dialect: 'anthropic-messages', family: 'kimi', familyStatus: 'mapped', manualConfigurationRequired: false },
        { id: 'kimi-for-coding-2', name: 'kimi-2', dialect: 'anthropic-messages', family: 'kimi', familyStatus: 'mapped', manualConfigurationRequired: false },
      ],
    }],
  };
  const importBodies = [];
  const session = setup({
    fetchImpl: (url, requestOptions) => {
      if (url === '/api/model-catalog') return Promise.resolve(structuredClone(twoModelIndex));
      if (url.startsWith('/api/model-catalog?')) {
        const modelId = decodeURIComponent(/&modelId=(.+)$/u.exec(url)[1]);
        return Promise.resolve({
          projection: { ...structuredClone(STALE_KIMI_PROJECTION), modelId, name: modelId },
          runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 },
        });
      }
      if (url === '/api/model-catalog/import') {
        const body = typeof requestOptions.body === 'string' ? JSON.parse(requestOptions.body) : requestOptions.body;
        importBodies.push(body);
        return Promise.resolve(structuredClone(PERSISTED_KIMI_IMPORT_RESPONSE(body.baseUrl)));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    },
  });
  await session.wizard.open();

  // Import the first model.
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();
  session.document.getElementById('catalog-import-confirm').click();
  await flush();
  assert.ok(session.document.getElementById('catalog-import-post-import'), 'first import advisory shown');

  // Navigate straight to the second model: the page must be fully usable.
  session.document.querySelector('[data-catalog-model="kimi-for-coding-2"] button').click();
  await flush();
  assert.equal(session.imported.length, 0, 'navigation does not fire the handback');
  assert.equal(session.document.getElementById('catalog-import-post-import'), null, 'advisory cleared on navigation');
  const confirmButton = /** @type {HTMLButtonElement} */ (session.document.getElementById('catalog-import-confirm'));
  assert.equal(confirmButton.disabled, false, 'the second model import is not blocked by the first import');
  assert.match(confirmButton.textContent, /确认导入/u, 'the second model gets a real import button');

  // Import the second model and finish: exactly one handback for the latest import.
  confirmButton.click();
  await flush();
  assert.ok(session.document.getElementById('catalog-import-post-import'), 'second import advisory shown');
  session.document.getElementById('catalog-import-confirm').click(); // 完成
  await flush();
  await flush();
  assert.equal(importBodies.length, 2, 'both imports were posted');
  assert.deepEqual(session.imported, [{ providerId: 'kimi-for-coding', modelId: 'kimi-for-coding-2' }], 'a single handback fires for the latest import');
});

// Full management chain with a deferred provider fetch: the delayed refresh
// from the first import must never disable or overwrite the second model's
// page while the user keeps browsing the catalog.
test('R4a: browsing another model after an import stays owned by the wizard despite the delayed refresh', async () => {
  const dom = new JSDOM(`
    <div id="provider-count"></div>
    <ul id="provider-list"></ul>
    <div id="provider-detail"></div>
    <button id="add-provider"></button>
    <button id="import-provider"></button>
    <button id="refresh-providers"></button>
  `);
  const context = {
    document: dom.window.document,
    Event: dom.window.Event,
    URL,
    structuredClone,
    window: { CaffPersonas: {}, CaffShared: {} },
  };
  for (const rel of [
    'public/shared/management-list.js',
    'public/shared/model-options.js',
    'public/shared/endpoint-diagnostics.js',
    'public/personas/management-utils.js',
    'public/personas/provider-editor.js',
    'public/personas/subscription-login.js',
    'public/personas/catalog-import.js',
    'public/personas/provider-management.js',
  ]) {
    const sourcePath = path.join(projectRoot, rel);
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }

  let providerBaseUrl = 'https://api.kimi.com/coding/v1';
  const providerList = () => ({
    providers: [{
      id: 'kimi-for-coding', name: 'Kimi For Coding', baseUrl: providerBaseUrl,
      api: 'anthropic-messages', authHeader: false, apiKeyMode: 'literal', hasApiKey: true,
      hasExternalAuth: false, hasCustomHeaders: false,
      models: [
        { id: 'kimi-for-coding', name: 'kimi-for-coding', family: 'kimi', reasoning: false, input: ['text'] },
        { id: 'kimi-for-coding-2', name: 'kimi-2', family: 'kimi', reasoning: false, input: ['text'] },
      ],
    }],
  });
  const twoModelIndex = {
    provenance: PROVENANCE,
    providers: [{
      id: 'kimi-for-coding', name: 'Kimi For Coding', env: ['KIMI_API_KEY'],
      models: [
        { id: 'kimi-for-coding', name: 'kimi-for-coding', dialect: 'anthropic-messages', family: 'kimi', familyStatus: 'mapped', manualConfigurationRequired: false },
        { id: 'kimi-for-coding-2', name: 'kimi-2', dialect: 'anthropic-messages', family: 'kimi', familyStatus: 'mapped', manualConfigurationRequired: false },
      ],
    }],
  };
  const providersChanged = [];
  let providerCalls = 0;
  let pendingProviderResolvers = [];
  const releasePendingProviderFetches = async () => {
    const resolvers = pendingProviderResolvers.splice(0);
    resolvers.forEach((resolve) => resolve());
    await flush();
    await flush();
  };
  const management = context.window.CaffPersonas.createProviderManagement({
    list: dom.window.document.getElementById('provider-list'),
    detail: dom.window.document.getElementById('provider-detail'),
    addButton: dom.window.document.getElementById('add-provider'),
    importButton: dom.window.document.getElementById('import-provider'),
    refreshButton: dom.window.document.getElementById('refresh-providers'),
    count: dom.window.document.getElementById('provider-count'),
    subscriptionButton: null,
    isEnabled: () => true,
    getCsrfToken: () => 'csrf-token',
    showToast() {},
    onProvidersChanged: async () => { providersChanged.push('changed'); },
    fetchJson: async (url, requestOptions) => {
      if (url === '/api/model-providers') {
        providerCalls += 1;
        if (providerCalls > 1) await new Promise((resolve) => { pendingProviderResolvers.push(resolve); });
        return providerList();
      }
      if (url === '/api/subscription-auth') return { channels: [], logins: [] };
      if (url === '/api/model-catalog') return structuredClone(twoModelIndex);
      if (url.startsWith('/api/model-catalog?')) {
        const modelId = decodeURIComponent(/&modelId=(.+)$/u.exec(url)[1]);
        return { projection: { ...structuredClone(STALE_KIMI_PROJECTION), modelId, name: modelId }, runtimeDefaults: { contextWindow: 128000, maxTokens: 16384 } };
      }
      if (url === '/api/model-catalog/import') {
        const body = typeof requestOptions.body === 'string' ? JSON.parse(requestOptions.body) : requestOptions.body;
        providerBaseUrl = body.baseUrl || providerBaseUrl;
        return structuredClone(PERSISTED_KIMI_IMPORT_RESPONSE(providerBaseUrl));
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  await management.refresh();
  const document = dom.window.document;

  document.getElementById('import-provider').click();
  await flush();
  document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  await flush();
  document.getElementById('catalog-import-apply-endpoint-suggestion').click();
  await flush();
  document.getElementById('catalog-import-confirm').click();
  await flush();
  await flush();
  assert.ok(document.getElementById('catalog-import-post-import'), 'advisory shown after the import');

  // Browse straight to the second model without finishing.
  document.querySelector('[data-catalog-model="kimi-for-coding-2"] button').click();
  await flush();

  const confirmButton = /** @type {HTMLButtonElement} */ (document.getElementById('catalog-import-confirm'));
  assert.ok(document.getElementById('catalog-import-base-url'), 'the second model form is rendered');
  assert.equal(confirmButton.disabled, false, 'the second model import is not disabled by the first import');
  assert.match(confirmButton.textContent, /确认导入/u);
  assert.equal(document.getElementById('catalog-import-post-import'), null, 'advisory cleared on navigation');

  // The delayed provider refresh (if any was started) must not reclaim the
  // pane or fire downstream consumers while the wizard is still browsing.
  await releasePendingProviderFetches();
  assert.ok(document.getElementById('catalog-import-base-url'), 'the wizard still owns the detail pane after any delayed refresh');
  assert.equal(document.getElementById('provider-base-url'), null, 'the editor did not take over the wizard page');
  assert.equal(providersChanged.length, 0, 'no downstream consumer fired during in-wizard navigation');

  // Leaving the wizard hands the pane back with refreshed data.
  document.getElementById('catalog-import-close').click();
  await flush();
  await releasePendingProviderFetches();
  assert.equal(providersChanged.length, 1, 'leaving refreshes downstream consumers exactly once');
  assert.ok(document.getElementById('provider-base-url'), 'the provider editor owns the detail pane after leaving');
  assert.equal(document.getElementById('provider-base-url').value, 'https://api.kimi.com/coding', 'editor shows the imported URL');
});

// ---------------------------------------------------------------------------
// R5: abnormal exits. Fifth-round CHANGES_REQUESTED findings: (1) after a
// failed catalog reload the close button crashed on the null catalog index
// (unhandled TypeError, callbacks never fired, completion flag locked);
// (2) leaving while an import POST was in flight let the late response
// re-render the advisory into the pane the parent already owned.
// ---------------------------------------------------------------------------

function openKimiModel(session) {
  session.document.querySelector('[data-catalog-provider="kimi-for-coding"] button').click();
  session.document.querySelector('[data-catalog-model="kimi-for-coding"] button').click();
  return flush();
}

test('R5a: a failed catalog reload still allows exiting with the pending handback', async () => {
  let indexAvailable = true;
  const session = setup({
    fetchImpl: (url, requestOptions) => {
      if (url === '/api/model-catalog') {
        if (indexAvailable) return Promise.resolve(structuredClone(STALE_KIMI_INDEX));
        return Promise.reject(new Error('catalog fetch failed'));
      }
      if (url === '/api/model-catalog/refresh') {
        indexAvailable = false;
        return Promise.resolve({ status: 'updated', providerCount: 1 });
      }
      return persistedKimiFetch()(url, requestOptions);
    },
  });
  await session.wizard.open();
  await openKimiModel(session);
  session.document.getElementById('catalog-import-confirm').click();
  await flush();
  assert.ok(session.document.getElementById('catalog-import-post-import'), 'advisory shown');

  // Reload the catalog; the index GET now fails and leaves an error page.
  session.document.getElementById('catalog-import-refresh').click();
  await flush();
  await flush();
  assert.ok(session.document.getElementById('catalog-import-error'), 'catalog error page rendered');
  assert.equal(session.document.getElementById('catalog-import-error').classList.contains('hidden'), false);
  assert.ok(session.document.getElementById('catalog-import-close'), 'the error page offers an exit');

  // Exiting from the error page must flush the pending handback instead of
  // crashing on the missing catalog index.
  session.document.getElementById('catalog-import-close').click();
  await flush();
  await flush();
  assert.deepEqual(session.imported, [{ providerId: 'kimi-for-coding', modelId: 'kimi-for-coding' }], 'the pending handback fires from the error page');
  assert.ok(session.isClosed(), 'the pane is handed back');
});

test('R5b: the unavailable-snapshot page can also exit with a pending handback', async () => {
  let indexAvailable = true;
  const unavailableError = new Error('Model catalog operation failed');
  unavailableError.issues = [{ code: 'catalog_source_unavailable', path: '/assets/model-catalog.json' }];
  const session = setup({
    fetchImpl: (url, requestOptions) => {
      if (url === '/api/model-catalog') {
        if (indexAvailable) return Promise.resolve(structuredClone(STALE_KIMI_INDEX));
        return Promise.reject(unavailableError);
      }
      if (url === '/api/model-catalog/refresh') {
        indexAvailable = false;
        return Promise.resolve({ status: 'updated', providerCount: 1 });
      }
      return persistedKimiFetch()(url, requestOptions);
    },
  });
  await session.wizard.open();
  await openKimiModel(session);
  session.document.getElementById('catalog-import-confirm').click();
  await flush();

  session.document.getElementById('catalog-import-refresh').click();
  await flush();
  await flush();
  assert.ok(session.document.getElementById('catalog-import-unavailable'), 'unavailable page rendered');

  session.document.getElementById('catalog-import-close').click();
  await flush();
  await flush();
  assert.deepEqual(session.imported, [{ providerId: 'kimi-for-coding', modelId: 'kimi-for-coding' }], 'the pending handback fires from the unavailable page');
  assert.ok(session.isClosed());
});

test('R5c: exiting during an in-flight import waits for it and hands back once', async () => {
  let releaseImport = null;
  const session = setup({
    fetchImpl: (url, requestOptions) => {
      if (url === '/api/model-catalog/import') {
        return new Promise((resolve) => {
          releaseImport = () => resolve(structuredClone(PERSISTED_KIMI_IMPORT_RESPONSE('https://api.kimi.com/coding')));
        });
      }
      return persistedKimiFetch()(url, requestOptions);
    },
  });
  await session.wizard.open();
  await openKimiModel(session);
  session.document.getElementById('catalog-import-confirm').click(); // POST in flight
  await flush();

  // Leave while the POST is pending: the wizard must not hand the pane back
  // yet, or the late response would re-render into the parent's page.
  session.document.getElementById('catalog-import-close').click();
  await flush();
  assert.equal(session.isClosed(), false, 'the wizard waits for the in-flight import before handing the pane back');
  assert.equal(session.imported.length, 0);
  const closeButton = /** @type {HTMLButtonElement} */ (session.document.getElementById('catalog-import-close'));
  assert.equal(closeButton.disabled, true, 'the exit is visibly pending');

  // The import lands: exactly one handback, and only after the import.
  releaseImport();
  await flush();
  await flush();
  await flush();
  assert.deepEqual(session.imported, [{ providerId: 'kimi-for-coding', modelId: 'kimi-for-coding' }], 'the handback includes the just-persisted import');
  assert.ok(session.isClosed(), 'the pane is handed back after the import settles');
});

test('R5d: a late import failure during exit keeps the page and allows retrying the exit', async () => {
  let rejectImport = null;
  const session = setup({
    fetchImpl: (url, requestOptions) => {
      if (url === '/api/model-catalog/import') {
        return new Promise((_resolve, reject) => {
          rejectImport = () => reject(new Error('import failed'));
        });
      }
      return persistedKimiFetch()(url, requestOptions);
    },
  });
  await session.wizard.open();
  await openKimiModel(session);
  session.document.getElementById('catalog-import-confirm').click(); // POST in flight
  await flush();

  session.document.getElementById('catalog-import-close').click();
  await flush();
  assert.equal(session.isClosed(), false, 'the wizard waits for the in-flight import');

  // The import fails: the failure must stay visible and the exit retryable.
  rejectImport();
  await flush();
  await flush();
  assert.equal(session.isClosed(), false, 'a failed import does not close the wizard silently');
  assert.equal(session.imported.length, 0, 'no handback without a persisted import');
  const error = session.document.getElementById('catalog-import-error');
  assert.ok(error, 'error element exists');
  assert.equal(error.classList.contains('hidden'), false, 'the import failure is surfaced');
  const closeButton = /** @type {HTMLButtonElement} */ (session.document.getElementById('catalog-import-close'));
  assert.equal(closeButton.disabled, false, 'the exit is retryable after the failure');

  // Retrying the exit now closes without a refresh (nothing was imported).
  closeButton.click();
  await flush();
  await flush();
  assert.ok(session.isClosed(), 'the retry exits the wizard');
  assert.equal(session.imported.length, 0);
});
