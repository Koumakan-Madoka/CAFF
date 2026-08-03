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
        models: [{ id: 'gpt-5.4', name: 'Configured GPT', family: 'gpt' }],
      },
      custom: {
        baseUrl: 'https://custom.example/v1',
        api: 'openai-completions',
        models: [{ id: 'mystery-1', name: 'Mystery Qwen', family: 'qwen' }],
      },
    },
  };
}

test('configured model catalog merges runtime registry, models.json metadata, and exact runtime default', () => {
  const catalog = createConfiguredModelCatalog({
    loadRuntimeModels: () => runtimeModels(),
    readProviderDocument: () => providerDocument(),
    readRuntimeDefault: () => ({ provider: 'runtime-only', model: 'orphan-model' }),
  });

  const options = catalog.getOptions();
  assert.equal(new Set(options.map((option) => option.key)).size, options.length);
  assert.deepEqual(options.find((option) => option.key === 'openai\u001fgpt-5.4'), {
    key: 'openai\u001fgpt-5.4',
    provider: 'openai',
    model: 'gpt-5.4',
    label: 'Configured GPT',
    source: 'models_json',
    sourceLabel: 'models.json',
    family: 'gpt',
    familySource: 'explicit',
    supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  });
  assert.deepEqual(options.find((option) => option.key === 'custom\u001fmystery-1'), {
    key: 'custom\u001fmystery-1',
    provider: 'custom',
    model: 'mystery-1',
    label: 'Mystery Qwen',
    source: 'models_json',
    sourceLabel: 'models.json',
    family: 'qwen',
    familySource: 'explicit',
    supportedThinkingLevels: ['off'],
  });
  assert.deepEqual(options.find((option) => option.key === 'moonshotai\u001fkimi-k2.5'), {
    key: 'moonshotai\u001fkimi-k2.5',
    provider: 'moonshotai',
    model: 'kimi-k2.5',
    label: 'Kimi K2.5',
    source: 'runtime_registry',
    sourceLabel: 'runtime registry',
    family: 'kimi',
    familySource: 'model_alias',
    supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
  });
  assert.deepEqual(options.find((option) => option.key === 'runtime-only\u001forphan-model'), {
    key: 'runtime-only\u001forphan-model',
    provider: 'runtime-only',
    model: 'orphan-model',
    label: 'runtime-only / orphan-model',
    source: 'runtime',
    sourceLabel: 'runtime default',
    family: null,
    familySource: 'unknown',
    supportedThinkingLevels: ['off'],
  });
  assert.equal(options.find((option) => option.key === 'anthropic\u001fclaude-opus-4-7').supportedThinkingLevels.includes('max'), true);
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
