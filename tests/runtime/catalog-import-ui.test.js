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

function setup({ fetchImpl }) {
  const dom = new JSDOM('<div id="root"></div>');
  const context = {
    document: dom.window.document,
    Event: dom.window.Event,
    structuredClone,
    window: { CaffPersonas: {}, CaffShared: {} },
  };
  for (const rel of ['public/shared/model-options.js', 'public/personas/management-utils.js', 'public/personas/catalog-import.js']) {
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
    onImported: (providerId, modelId) => imported.push({ providerId, modelId }),
    onClose: () => { closed += 1; },
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
    code: 'anthropic_base_url_version_suffix',
    suggestion: 'https://api.kimi.com/coding',
    basis: 'vendored-anthropic-sdk-appends-v1-messages',
    message: 'Base URL 以 /v1 结尾，但 Anthropic 协议客户端会自动在其后追加 /v1/messages，实际请求路径会变成 https://api.kimi.com/coding/v1/v1/messages。建议使用 https://api.kimi.com/coding（Anthropic 端点不含 /v1 前缀）。',
  },
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
  assert.match(metadata.textContent, /https:\/\/api\.kimi\.com\/coding\/v1/u);
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

test('catalog import renders no endpoint warning for consistent projections', async () => {
  const session = setup({ fetchImpl: indexFetch });
  await session.wizard.open();

  session.document.querySelector('[data-catalog-provider="openai"] button').click();
  session.document.querySelector('[data-catalog-model="gpt-5"] button').click();
  await flush();

  assert.equal(session.document.getElementById('catalog-import-endpoint-warning'), null);
  assert.equal(session.document.getElementById('catalog-import-apply-endpoint-suggestion'), null);
});
