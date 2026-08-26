const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  RecoveryScribeConfigError,
  createRecoveryScribeConfigManager,
} = require('../../build/server/domain/conversation/recovery-scribe-config');
const { withTempDir } = require('../helpers/temp-dir');

const DEFAULTS = {
  enabled: true,
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  thinking: 'low',
  timeoutMs: 60_000,
};

const MODEL_OPTIONS = [
  {
    key: 'deepseek\u001fdeepseek-v4-flash',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    supportedThinkingLevels: ['off', 'low', 'high'],
  },
  {
    key: 'openai\u001fgpt-5',
    provider: 'openai',
    model: 'gpt-5',
    label: 'GPT-5',
    supportedThinkingLevels: ['off', 'medium', 'high'],
  },
];

function createFixture(t) {
  const tempDir = withTempDir('caff-recovery-scribe-config-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  const modelCatalog = { getOptions: () => structuredClone(MODEL_OPTIONS) };
  t.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { store, modelCatalog };
}

test('recovery scribe configuration uses runtime defaults until a persisted override is saved', (t) => {
  const { store, modelCatalog } = createFixture(t);
  const manager = createRecoveryScribeConfigManager({ store, modelCatalog, defaults: DEFAULTS });

  assert.deepEqual(manager.getConfigSnapshot(), DEFAULTS);
  assert.equal(manager.getConfiguration().source, 'runtime_defaults');

  const saved = manager.updateConfiguration({
    enabled: false,
    provider: 'openai',
    model: 'gpt-5',
    thinking: 'medium',
    timeoutMs: 45_000,
  });
  assert.equal(saved.source, 'persisted');
  assert.deepEqual(saved.config, {
    enabled: false,
    provider: 'openai',
    model: 'gpt-5',
    thinking: 'medium',
    timeoutMs: 45_000,
  });
  assert.deepEqual(manager.getConfigSnapshot(), saved.config);

  const restarted = createRecoveryScribeConfigManager({ store, modelCatalog, defaults: DEFAULTS });
  assert.deepEqual(restarted.getConfigSnapshot(), saved.config);
  assert.equal(restarted.getConfiguration().updatedAt, saved.updatedAt);
});

test('recovery scribe configuration rejects unknown fields, unavailable models, unsupported thinking and invalid limits', (t) => {
  const { store, modelCatalog } = createFixture(t);
  const manager = createRecoveryScribeConfigManager({ store, modelCatalog, defaults: DEFAULTS });
  const valid = {
    enabled: true,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    thinking: 'low',
    timeoutMs: 30_000,
  };

  const rejects = [
    [{ ...valid, prompt: 'relax safety' }, 'recovery_config_field_not_allowed', 'body.prompt'],
    [{ ...valid, enabled: 'yes' }, 'recovery_config_enabled_invalid', 'body.enabled'],
    [{ ...valid, model: 'missing' }, 'recovery_config_model_unavailable', 'body.model'],
    [{ ...valid, thinking: 'medium' }, 'recovery_config_thinking_unsupported', 'body.thinking'],
    [{ ...valid, timeoutMs: 999 }, 'recovery_config_timeout_invalid', 'body.timeoutMs'],
    [{ ...valid, timeoutMs: 60_001 }, 'recovery_config_timeout_invalid', 'body.timeoutMs'],
  ];

  for (const [payload, code, issuePath] of rejects) {
    assert.throws(
      () => manager.updateConfiguration(payload),
      (error) => error instanceof RecoveryScribeConfigError && error.code === code && error.path === issuePath
    );
  }

  assert.equal(store.getSystemServiceConfig('recovery_scribe'), null);
});
