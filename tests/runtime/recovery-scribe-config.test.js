const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  RecoveryScribeConfigError,
  createRecoveryScribeConfigManager,
} = require('../../build/server/domain/conversation/recovery-scribe-config');
const {
  applyConversationDigestAction,
} = require('../../build/server/domain/conversation/conversation-digest');
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

test('persisted system model selection is shared by digests without sharing the recovery enable flag', async (t) => {
  const { store, modelCatalog } = createFixture(t);
  const manager = createRecoveryScribeConfigManager({ store, modelCatalog, defaults: DEFAULTS });
  manager.updateConfiguration({
    enabled: false,
    provider: 'openai',
    model: 'gpt-5',
    thinking: 'medium',
    timeoutMs: 45_000,
  });
  const digestAgent = store.saveCustomRoleConfig({
    id: 'shared-system-model-agent',
    name: 'Shared System Model Agent',
    personaPrompt: 'test',
  });
  const conversation = store.createConversation({
    id: 'shared-system-model-digest',
    title: 'Shared system model digest',
    participants: [digestAgent.id],
  });
  store.createMessage({
    id: 'shared-system-model-message',
    conversationId: conversation.id,
    turnId: 'shared-system-model-turn',
    role: 'user',
    senderName: 'User',
    content: '请生成一份模型摘要。',
  });

  let releaseFirstCall;
  const firstCallBlocked = new Promise((resolve) => {
    releaseFirstCall = resolve;
  });
  let firstCallStarted;
  const firstCallReady = new Promise((resolve) => {
    firstCallStarted = resolve;
  });
  const calls = [];
  const firstDigestPromise = applyConversationDigestAction(store, conversation.id, {
    action: 'create',
    summaryMode: 'model',
  }, {
    resolveSystemModelConfigSnapshot: manager.getConfigSnapshot,
    digestModelRunner: async (context) => {
      calls.push(structuredClone(context.config));
      firstCallStarted();
      await firstCallBlocked;
      return {
        summary: '第一份共享配置摘要。',
        facts: [],
        decisions: [],
        openQuestions: [],
        nextActions: [],
        artifacts: [],
      };
    },
  });

  await firstCallReady;
  manager.updateConfiguration({
    enabled: true,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    thinking: 'high',
    timeoutMs: 30_000,
  });
  releaseFirstCall();
  const firstDigest = await firstDigestPromise;

  assert.deepEqual(
    {
      provider: calls[0].provider,
      model: calls[0].model,
      thinking: calls[0].thinking,
    },
    { provider: 'openai', model: 'gpt-5', thinking: 'medium' }
  );
  assert.equal(firstDigest.digest.createdBy, 'model:openai/gpt-5');

  await applyConversationDigestAction(store, conversation.id, {
    action: 'create',
    summaryMode: 'model',
  }, {
    resolveSystemModelConfigSnapshot: manager.getConfigSnapshot,
    digestModelRunner: async (context) => {
      calls.push(structuredClone(context.config));
      return {
        summary: '第二份共享配置摘要。',
        facts: [],
        decisions: [],
        openQuestions: [],
        nextActions: [],
        artifacts: [],
      };
    },
  });
  assert.equal(calls[1].provider, 'deepseek');
  assert.equal(calls[1].model, 'deepseek-v4-flash');
  assert.equal(calls[1].thinking, 'high');
});

test('conversation digest rejects request-scoped model selection overrides', async (t) => {
  const { store } = createFixture(t);
  const digestAgent = store.saveCustomRoleConfig({
    id: 'digest-model-override-agent',
    name: 'Digest Model Override Agent',
    personaPrompt: 'test',
  });
  const conversation = store.createConversation({
    id: 'digest-model-override-rejected',
    title: 'Digest model override rejected',
    participants: [digestAgent.id],
  });
  store.createMessage({
    id: 'digest-model-override-message',
    conversationId: conversation.id,
    turnId: 'digest-model-override-turn',
    role: 'user',
    senderName: 'User',
    content: '摘要模型必须来自系统服务配置。',
  });

  for (const field of ['provider', 'model', 'thinking']) {
    await assert.rejects(
      () => applyConversationDigestAction(store, conversation.id, {
        action: 'create',
        summaryMode: 'model',
        [field]: 'request-override',
      }),
      (error) => error.statusCode === 400
        && error.code === 'conversation_digest_model_override_not_allowed'
        && error.field === field
    );
  }
});
