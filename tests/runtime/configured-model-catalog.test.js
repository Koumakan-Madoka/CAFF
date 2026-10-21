const test = require('node:test');
const assert = require('node:assert/strict');

const { createConfiguredModelCatalog } = require('../../build/server/domain/models/configured-model-catalog');
const { createBootstrapPayloadBuilder } = require('../../build/server/api/bootstrap-payload');

function runtimeModels() {
  return [
    {
      provider: 'openai',
      id: 'gpt-5.4',
      name: 'GPT 5.4',
      supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      input: ['text', 'image'],
    },
    {
      provider: 'anthropic',
      id: 'claude-opus-4-7',
      name: 'Claude Opus 4.7',
      supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      provider: 'moonshotai',
      id: 'kimi-k2.5',
      name: 'Kimi K2.5',
      supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
    },
  ];
}

function providerDocument() {
  return {
    providers: {
      openai: {
        models: [{ id: 'gpt-5.4', name: 'Configured GPT', family: 'gpt', input: ['text', 'image'] }],
      },
      custom: {
        baseUrl: 'https://custom.example/v1',
        api: 'openai-completions',
        models: [{ id: 'mystery-1', name: 'Mystery Qwen', family: 'qwen' }],
      },
    },
  };
}

test('configured model catalog exposes configured models and the exact runtime default while registry data only enriches them', () => {
  const catalog = createConfiguredModelCatalog({
    loadRuntimeModels: () => runtimeModels(),
    readProviderDocument: () => providerDocument(),
    readRuntimeDefault: () => ({ provider: 'anthropic', model: 'claude-opus-4-7' }),
  });

  const options = catalog.getOptions();
  assert.equal(new Set(options.map((option) => option.key)).size, options.length);
  assert.equal(options.length, 3, 'the full runtime registry must not become a user-facing picker');
  assert.deepEqual(options.find((option) => option.key === 'openai\u001fgpt-5.4'), {
    key: 'openai\u001fgpt-5.4',
    provider: 'openai',
    model: 'gpt-5.4',
    label: 'Configured GPT',
    source: 'models_json',
    sourceLabel: 'models.json',
    runtimeResolvable: true,
    family: 'gpt',
    familySource: 'explicit',
    api: '',
    supportsFast: false,
    supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    input: ['text', 'image'],
    contextWindow: null,
  });
  assert.deepEqual(options.find((option) => option.key === 'custom\u001fmystery-1'), {
    key: 'custom\u001fmystery-1',
    provider: 'custom',
    model: 'mystery-1',
    label: 'Mystery Qwen',
    source: 'models_json',
    sourceLabel: 'models.json',
    runtimeResolvable: false,
    family: 'qwen',
    familySource: 'explicit',
    api: '',
    supportsFast: false,
    supportedThinkingLevels: ['off'],
    input: ['text'],
    contextWindow: null,
  });
  assert.equal(options.find((option) => option.key === 'moonshotai\u001fkimi-k2.5'), undefined);
  assert.deepEqual(options.find((option) => option.key === 'anthropic\u001fclaude-opus-4-7'), {
    key: 'anthropic\u001fclaude-opus-4-7',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    source: 'runtime',
    sourceLabel: 'runtime default',
    runtimeResolvable: true,
    family: 'claude',
    familySource: 'provider_alias',
    api: '',
    supportsFast: false,
    supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    input: ['text'],
    contextWindow: null,
  });
});

test('configured model catalog exposes runtime input capability as the single truth source for unknown models', () => {
  const catalog = createConfiguredModelCatalog({
    loadRuntimeModels: () => [{ provider: 'google', id: 'gemini-vision', input: ['text', 'image'] }],
    readProviderDocument: () => ({ providers: {} }),
    readRuntimeDefault: () => ({ provider: 'google', model: 'gemini-vision' }),
  });

  const option = catalog.getOptions().find((entry) => entry.key === 'google\u001fgemini-vision');
  assert.deepEqual(option.input, ['text', 'image']);
});

test('configured model catalog caches snapshots until explicit invalidation', () => {
  let runtimeReads = 0;
  let providerReads = 0;
  const catalog = createConfiguredModelCatalog({
    loadRuntimeModels() {
      runtimeReads += 1;
      return runtimeModels();
    },
    readProviderDocument() {
      providerReads += 1;
      return providerDocument();
    },
    readRuntimeDefault: () => ({ provider: 'openai', model: 'gpt-5.4' }),
  });

  catalog.getOptions();
  catalog.getOptions();
  assert.deepEqual({ runtimeReads, providerReads }, { runtimeReads: 1, providerReads: 1 });
  catalog.invalidate();
  catalog.getOptions();
  assert.deepEqual({ runtimeReads, providerReads }, { runtimeReads: 2, providerReads: 2 });
});

test('configured model catalog carries contextWindow from models.json and runtime models so session reuse can resolve it', () => {
  const catalog = createConfiguredModelCatalog({
    loadRuntimeModels: () => [
      { provider: 'anthropic', id: 'claude-opus-4-7', name: 'Claude Opus 4.7', contextWindow: 200000 },
    ],
    readProviderDocument: () => ({
      providers: {
        custom: {
          baseUrl: 'https://custom.example/v1',
          api: 'openai-completions',
          models: [
            { id: 'with-window', name: 'With Window', family: 'qwen', contextWindow: 262144 },
            { id: 'without-window', name: 'Without Window', family: 'qwen' },
            { id: 'invalid-window', name: 'Invalid Window', family: 'qwen', contextWindow: 'big' },
          ],
        },
      },
    }),
    readRuntimeDefault: () => ({ provider: 'anthropic', model: 'claude-opus-4-7' }),
  });

  const options = catalog.getOptions();
  assert.equal(
    options.find((option) => option.key === 'custom\u001fwith-window')?.contextWindow,
    262144,
    'models.json contextWindow must survive catalog assembly',
  );
  assert.equal(
    options.find((option) => option.key === 'custom\u001fwithout-window')?.contextWindow,
    null,
  );
  assert.equal(
    options.find((option) => option.key === 'custom\u001finvalid-window')?.contextWindow,
    null,
    'non-integer contextWindow must normalize to null',
  );
  assert.equal(
    options.find((option) => option.key === 'anthropic\u001fclaude-opus-4-7')?.contextWindow,
    200000,
    'runtime default must inherit the runtime model contextWindow',
  );
});

test('unresolvable synthetic defaults are omitted, including ambient env preferences', () => {
  const { withClearedRecoveryRuntimeEnvironment } = require('../helpers/recovery-runtime-env');
  withClearedRecoveryRuntimeEnvironment(() => {
    for (const preference of [null, { provider: 'missing-provider', model: 'missing-model' }]) {
      if (preference) {
        process.env.PI_PROVIDER = preference.provider;
        process.env.PI_MODEL = preference.model;
      }
      const catalog = createConfiguredModelCatalog({
        loadRuntimeModels: () => runtimeModels(),
        readProviderDocument: () => providerDocument(),
      });
      assert.equal(catalog.getOptions().length, 2);
      assert.equal(catalog.getOptions().some((option) => option.source === 'runtime'), false);
      assert.equal(catalog.getOptions().find((option) => option.provider === 'custom').runtimeResolvable, false);
    }
  });
});

test('configured model catalog projects Fast support only for allowlisted openai-codex-responses models', () => {
  const catalog = createConfiguredModelCatalog({
    loadRuntimeModels: () => [
      { provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', api: 'openai-codex-responses' },
      { provider: 'openai-codex', id: 'gpt-5.4-mini', name: 'GPT 5.4 mini', api: 'openai-codex-responses' },
      { provider: 'openai', id: 'gpt-6.1-sol', name: 'Relay Sol', api: 'openai-responses' },
    ],
    readProviderDocument: () => ({ providers: {
      'openai-codex': { models: [{ id: 'gpt-6.1-sol', family: 'gpt' }, { id: 'gpt-5.4-mini', family: 'gpt' }] },
      openai: { models: [{ id: 'gpt-6.1-sol', family: 'gpt' }] },
    } }),
    readRuntimeDefault: () => ({ provider: 'openai-codex', model: 'gpt-6.1-sol' }),
  });

  const options = catalog.getOptions();
  const solCodex = options.find((option) => option.key === 'openai-codex\u001fgpt-6.1-sol');
  assert.equal(solCodex.api, 'openai-codex-responses');
  assert.equal(solCodex.supportsFast, true, 'allowlisted codex model supports Fast');
  const miniCodex = options.find((option) => option.key === 'openai-codex\u001fgpt-5.4-mini');
  assert.equal(miniCodex.supportsFast, false, 'codex model outside the allowlist does not support Fast');
  const solRelay = options.find((option) => option.key === 'openai\u001fgpt-6.1-sol');
  assert.equal(solRelay.supportsFast, false, 'same model id on a non-codex api never supports Fast');
});

test('bootstrap model options cannot be expanded by stale Agent or Profile rows', () => {
  const expected = [{ key: 'openai\u001fgpt-5.4', provider: 'openai', model: 'gpt-5.4' }];
  const { buildConfiguredModelOptions } = createBootstrapPayloadBuilder({
    store: {
      listAgents() {
        throw new Error('Agent rows must not be read while building the catalog');
      },
    },
    modelCatalog: { getOptions: () => expected },
  });

  assert.deepEqual(buildConfiguredModelOptions(), expected);
});
