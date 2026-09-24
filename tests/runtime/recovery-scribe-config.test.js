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
    runtimeResolvable: true,
    supportedThinkingLevels: ['off', 'low', 'high'],
  },
  {
    key: 'openai\u001fgpt-5',
    provider: 'openai',
    model: 'gpt-5',
    label: 'GPT-5',
    runtimeResolvable: true,
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

test('recovery scribe remains unconfigured until a shared selection is explicitly saved', (t) => {
  const { store, modelCatalog } = createFixture(t);
  const manager = createRecoveryScribeConfigManager({ store, modelCatalog, defaults: DEFAULTS });

  assert.deepEqual(manager.getConfigSnapshot(), { ...DEFAULTS, provider: '', model: '', thinking: 'off' });
  assert.equal(manager.getConfiguration().source, 'unconfigured');
  assert.equal(manager.getConfiguration().readiness.ready, false);

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

test('unresolvable config is diagnosed, cannot be saved, but can be disabled unchanged and repaired live', (t) => {
  const { store } = createFixture(t);
  let resolvable = false;
  const modelCatalog = { getOptions: () => MODEL_OPTIONS.map((option) => ({ ...option, runtimeResolvable: resolvable })) };
  const manager = createRecoveryScribeConfigManager({ store, modelCatalog, defaults: DEFAULTS });
  assert.throws(() => manager.updateConfiguration(DEFAULTS), (error) => error.code === 'recovery_config_model_unavailable');
  assert.equal(store.getSystemServiceConfig('recovery_scribe'), null);
  store.saveSystemServiceConfig('recovery_scribe', DEFAULTS);
  const blocked = manager.getConfiguration();
  assert.equal(blocked.config.enabled, true);
  assert.equal(blocked.readiness.ready, false);
  assert.equal(blocked.readiness.code, 'recovery_config_model_unavailable');
  assert.deepEqual(blocked.config, DEFAULTS);
  assert.throws(() => manager.updateConfiguration({ ...DEFAULTS, enabled: false, model: 'other-bad-model' }),
    (error) => error.code === 'recovery_config_model_unavailable');
  const disabled = manager.updateConfiguration({ ...DEFAULTS, enabled: false });
  assert.equal(disabled.config.enabled, false);
  assert.equal(disabled.readiness.ready, false);
  assert.throws(() => manager.updateConfiguration(DEFAULTS), (error) => error.code === 'recovery_config_model_unavailable');
  resolvable = true;
  assert.equal(manager.getConfiguration().readiness.ready, true, 'no service restart required');
  assert.equal(manager.updateConfiguration(DEFAULTS).readiness.ready, true);
});

test('legacy unmarked options require authoritative resolution and expose normalized readiness to the picker', (t) => {
  const { store } = createFixture(t);
  store.saveSystemServiceConfig('recovery_scribe', DEFAULTS);
  const legacy = MODEL_OPTIONS.map(({ runtimeResolvable, ...option }) => option);
  let resolved = null;
  const calls = [];
  const modelCatalog = {
    getOptions: () => legacy,
    getResolvedModel(provider, model) {
      calls.push([provider, model]);
      return resolved && provider === resolved.provider && model === resolved.model ? resolved : null;
    },
  };
  const manager = createRecoveryScribeConfigManager({ store, modelCatalog, defaults: DEFAULTS });
  const blocked = manager.getConfiguration();
  assert.equal(blocked.readiness.ready, false);
  assert.equal(blocked.modelOptions[0].runtimeResolvable, false);
  assert.throws(() => manager.updateConfiguration(DEFAULTS), (error) => error.code === 'recovery_config_model_unavailable');
  assert.equal(store.getSystemServiceConfig('recovery_scribe').model, DEFAULTS.model);
  resolved = { ...MODEL_OPTIONS[0], supportedThinkingLevels: ['off', 'low'] };
  const ready = manager.getConfiguration();
  assert.equal(ready.readiness.ready, true);
  assert.equal(ready.modelOptions[0].runtimeResolvable, true);
  assert.deepEqual(ready.modelOptions[0].supportedThinkingLevels, ['off', 'low'], 'use authoritative capabilities');
  assert.equal(ready.modelOptions[1].runtimeResolvable, false);
  assert.equal(manager.updateConfiguration(DEFAULTS).readiness.ready, true);
  assert.ok(calls.some(([provider, model]) => provider === DEFAULTS.provider && model === DEFAULTS.model));
  assert.equal(Object.hasOwn(legacy[0], 'runtimeResolvable'), false, 'never mutate injected catalog');
  resolved = { ...resolved, supportedThinkingLevels: ['off'] };
  assert.equal(manager.getConfiguration().readiness.code, 'recovery_config_thinking_unsupported');
  resolved = { ...resolved, runtimeResolvable: undefined };
  assert.equal(manager.getConfiguration().readiness.ready, false, 'unverified resolver response must not be trusted');
  delete modelCatalog.getResolvedModel;
  assert.equal(manager.getConfiguration().modelOptions[0].runtimeResolvable, false);
});

test('authoritative resolution failure stays diagnosable and explicit false is never overridden', (t) => {
  const { store } = createFixture(t);
  store.saveSystemServiceConfig('recovery_scribe', DEFAULTS);
  const modelCatalog = {
    getOptions: () => [{ ...MODEL_OPTIONS[0], runtimeResolvable: false }],
    getResolvedModel() { throw new Error('private resolver detail'); },
  };
  const manager = createRecoveryScribeConfigManager({ store, modelCatalog, defaults: DEFAULTS });
  assert.equal(manager.getConfiguration().readiness.code, 'recovery_config_model_unavailable');
  modelCatalog.getOptions = () => [{ ...MODEL_OPTIONS[0], runtimeResolvable: undefined }];
  const failed = manager.getConfiguration();
  assert.equal(failed.readiness.code, 'recovery_config_catalog_unavailable');
  assert.equal(JSON.stringify(failed).includes('private resolver detail'), false);
  assert.equal(manager.updateConfiguration({ ...DEFAULTS, enabled: false }).config.enabled, false);
});

test('invalid model may be disabled with unchanged fractional-second timeout but cannot smuggle other changes', (t) => {
  const { store, modelCatalog } = createFixture(t);
  const invalid = { ...DEFAULTS, model: 'deleted-model', timeoutMs: 1500 };
  store.saveSystemServiceConfig('recovery_scribe', invalid);
  const manager = createRecoveryScribeConfigManager({ store, modelCatalog, defaults: DEFAULTS });
  assert.deepEqual(manager.updateConfiguration({ ...invalid, enabled: false }).config, { ...invalid, enabled: false });
  for (const change of [{ timeoutMs: 3500 }, { model: 'other-missing' }, { provider: 'other' }, { thinking: 'high' }]) {
    assert.throws(() => manager.updateConfiguration({ ...invalid, enabled: false, ...change }),
      (error) => error.code === 'recovery_config_model_unavailable');
  }
  assert.equal(store.getSystemServiceConfig('recovery_scribe').timeoutMs, 1500);
});

test('missing persisted model never falls back to a valid default and catalog failure is diagnosable', (t) => {
  const { store, modelCatalog } = createFixture(t);
  const manager = createRecoveryScribeConfigManager({ store, modelCatalog, defaults: DEFAULTS });
  store.saveSystemServiceConfig('recovery_scribe', { ...DEFAULTS, model: 'removed' });
  assert.equal(manager.getConfiguration().config.model, 'removed');
  assert.equal(manager.getConfiguration().readiness.ready, false);
  modelCatalog.getOptions = () => { throw new Error('private catalog detail'); };
  const state = manager.getConfiguration();
  assert.equal(state.readiness.code, 'recovery_config_catalog_unavailable');
  assert.equal(JSON.stringify(state).includes('private catalog detail'), false);
  assert.equal(manager.updateConfiguration({ ...state.config, enabled: false }).config.enabled, false);
});

test('real catalog invalidation refreshes readiness and explicit resolvable defaults need not be picker defaults', (t) => {
  const { createConfiguredModelCatalog } = require('../../build/server/domain/models/configured-model-catalog');
  const { withClearedRecoveryRuntimeEnvironment } = require('../helpers/recovery-runtime-env');
  const { store } = createFixture(t);
  withClearedRecoveryRuntimeEnvironment(() => {
    let runtimeModels = [];
    const catalog = createConfiguredModelCatalog({
      loadRuntimeModels: () => runtimeModels,
      readProviderDocument: () => ({ providers: {} }),
    });
    const defaults = { ...DEFAULTS, model: 'deepseek/deepseek-v4-flash' };
    store.saveSystemServiceConfig('recovery_scribe', defaults);
    const manager = createRecoveryScribeConfigManager({ store, modelCatalog: catalog, defaults });
    assert.equal(manager.getConfiguration().readiness.ready, false);
    runtimeModels = [{ provider: 'deepseek', id: 'deepseek-v4-flash', supportedThinkingLevels: ['off', 'low'] }];
    assert.equal(manager.getConfiguration().readiness.ready, false, 'catalog cache is explicit');
    catalog.invalidate();
    const ready = manager.getConfiguration();
    assert.equal(ready.readiness.ready, true);
    assert.deepEqual(ready.config, defaults);
    assert.equal(ready.modelOptions[0].model, defaults.model, 'preserve the explicitly selected provider-prefixed ID');
    assert.equal(catalog.getOptions().length, 0, 'explicit Recovery model does not expand the shared picker');
    assert.equal(manager.updateConfiguration(defaults).readiness.ready, true);
    runtimeModels = [];
    catalog.invalidate();
    assert.equal(manager.getConfiguration().readiness.ready, false, 'removed explicit selection cannot fall back');
    assert.equal(manager.getConfigSnapshot().model, defaults.model);
  });
});

test('unsupported model thinking is consistently blocked and may only be disabled unchanged', (t) => {
  const { store, modelCatalog } = createFixture(t);
  const invalid = { ...DEFAULTS, thinking: 'max' };
  store.saveSystemServiceConfig('recovery_scribe', invalid);
  const manager = createRecoveryScribeConfigManager({ store, modelCatalog, defaults: DEFAULTS });
  assert.equal(manager.getConfiguration().readiness.code, 'recovery_config_thinking_unsupported');
  assert.throws(() => manager.updateConfiguration(invalid), (error) => error.code === 'recovery_config_thinking_unsupported');
  assert.equal(manager.updateConfiguration({ ...invalid, enabled: false }).config.thinking, 'max');
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
    modelCatalog,
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
    modelCatalog,
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
