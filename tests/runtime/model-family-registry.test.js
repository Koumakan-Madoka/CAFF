const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyModelFamily } = require('../../build/server/domain/models/model-family-registry');

test('model family registry applies explicit, provider, model, conflict, and unknown precedence', () => {
  assert.deepEqual(classifyModelFamily({
    provider: 'openai',
    model: 'claude-sonnet-5',
    explicitFamily: 'kimi',
  }), { family: 'kimi', familySource: 'explicit' });
  assert.deepEqual(classifyModelFamily({ provider: 'openai', model: 'gpt-5.4' }), {
    family: 'gpt',
    familySource: 'provider_alias',
  });
  assert.deepEqual(classifyModelFamily({ provider: 'openrouter', model: 'anthropic/claude-opus-4-7' }), {
    family: 'claude',
    familySource: 'model_alias',
  });
  assert.deepEqual(classifyModelFamily({ provider: 'openai', model: 'claude-opus-4-7' }), {
    family: null,
    familySource: 'conflict',
  });
  assert.deepEqual(classifyModelFamily({ provider: 'openrouter', model: 'acme-research-model' }), {
    family: null,
    familySource: 'unknown',
  });
});

test('model family registry uses exact provider aliases and anchored model segments', () => {
  const providerCases = [
    ['openai-codex', 'gpt'],
    ['claude', 'claude'],
    ['google-gemini', 'gemini'],
    ['deepseek', 'deepseek'],
    ['dashscope', 'qwen'],
    ['bigmodel', 'glm'],
    ['kimi-coding', 'kimi'],
  ];
  for (const [provider, family] of providerCases) {
    assert.equal(classifyModelFamily({ provider, model: 'unclassified-model' }).family, family);
  }

  const modelCases = [
    ['gpt-5.4', 'gpt'],
    ['vendor/claude-opus-4-7', 'claude'],
    ['gemini-3.1-pro-preview', 'gemini'],
    ['accounts/vendor/models/deepseek-v4-pro', 'deepseek'],
    ['Qwen/Qwen3-32B', 'qwen'],
    ['qwq-32b-preview', 'qwen'],
    ['workers-ai/@cf/zai-org/glm-5.2', 'glm'],
    ['kimi-k2.5', 'kimi'],
    ['k2.6', 'kimi'],
  ];
  for (const [model, family] of modelCases) {
    assert.equal(classifyModelFamily({ provider: 'openrouter', model }).family, family);
  }

  for (const provider of ['', 'openrouter', 'ollama', 'lmstudio', 'openai-compatible', 'packycode']) {
    assert.equal(classifyModelFamily({ provider, model: 'acme-model' }).family, null);
  }
  for (const model of ['notgpt-model', 'my-claude-proxy', 'acme-glm-adapter', 'ak2', 'k20']) {
    assert.equal(classifyModelFamily({ provider: 'openrouter', model }).family, null);
  }
});
