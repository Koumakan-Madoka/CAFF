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
  let closed = 0;
  const wizard = context.window.CaffPersonas.createCatalogImport({
    root: dom.window.document.getElementById('root'),
    isEnabled: () => true,
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      return fetchImpl(url, options);
    },
    getCsrfToken: () => 'csrf-token',
    showToast: () => {},
    onImported: (providerId, modelId) => imported.push({ providerId, modelId }),
    onClose: () => { closed += 1; },
  });
  return {
    wizard,
    calls,
    imported,
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
    return Promise.resolve({ projection: projectionFor(decodeURIComponent(match[1]), decodeURIComponent(match[2])) });
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
  assert.equal(session.input('catalog-import-name').value, 'GPT-5');
  assert.equal(session.input('catalog-import-base-url').value, 'https://api.openai.com/v1');
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
  });
  assert.equal(bodyText.includes('AZURE_API_KEY'), false, 'env names are not submitted');
  assert.equal(bodyText.includes('apiKey'), false, 'no apiKey field submitted');
  assert.deepEqual(session.imported, [{ providerId: 'azure', modelId: 'gpt-5' }]);
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
