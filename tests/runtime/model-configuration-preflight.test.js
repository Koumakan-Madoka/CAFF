const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runtime = require('../../build/lib/minimal-pi');
const { createConfiguredModelCatalog } = require('../../build/server/domain/models/configured-model-catalog');
const { createRecoveryScribeConfigManager } = require('../../build/server/domain/conversation/recovery-scribe-config');
const { applyConversationDigestAction, maybeAutoCreateConversationDigest } = require('../../build/server/domain/conversation/conversation-digest');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { applyConversationSkillDraftAction } = require('../../build/server/domain/conversation/skill-draft');
const { withTempDir } = require('../helpers/temp-dir');
const { RECOVERY_RUNTIME_ENV_KEYS, withClearedRecoveryRuntimeEnvironment } = require('../helpers/recovery-runtime-env');

const SELECTION = { enabled: true, provider: 'test-provider', model: 'test-model', thinking: 'off', timeoutMs: 60000 };
const OPTION = { ...SELECTION, runtimeResolvable: true, supportedThinkingLevels: ['off'] };

function memoryStore() {
  let row = null;
  return {
    getSystemServiceConfig: () => row,
    saveSystemServiceConfig(_type, value) { row = { ...value }; return row; },
  };
}

function clearEnvironmentUntilTestEnds(t) {
  const before = new Map([...RECOVERY_RUNTIME_ENV_KEYS, 'CAFF_DIGEST_SUMMARY_MODE', 'CAFF_DIGEST_AUTO_TITLE_REFINE', 'CAFF_SKILL_DRAFT_PROVIDER', 'CAFF_SKILL_DRAFT_MODEL', 'CAFF_SKILL_DRAFT_THINKING'].map((key) => [key, process.env[key]]));
  for (const key of before.keys()) delete process.env[key];
  t.after(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('no exported vendor provider/model fallback remains', () => {
  assert.ok(!runtime.DEFAULT_PROVIDER, 'no hardcoded provider default');
  assert.ok(!runtime.DEFAULT_MODEL, 'no hardcoded model default');
});

test('an installed former default is not an implicit selection when env and user selection are empty', () => {
  withClearedRecoveryRuntimeEnvironment(() => {
    const catalog = createConfiguredModelCatalog({
      loadRuntimeModels: () => [{ provider: 'kimi-coding', id: 'k2p5', supportedThinkingLevels: ['off'] }],
      readProviderDocument: () => ({ providers: {} }),
    });
    assert.deepEqual(catalog.getOptions(), [], 'registry availability must not synthesize a default choice');
    assert.equal(catalog.getResolvedModel('kimi-coding', 'k2p5').runtimeResolvable, true,
      'removing the default must not remove PI resolution of explicit selections');
  });
});

test('empty system scribe model is a normal unconfigured state, not a startup failure', () => {
  const store = memoryStore();
  const manager = createRecoveryScribeConfigManager({
    store, defaults: { ...SELECTION, provider: '', model: '' },
    modelCatalog: { getOptions: () => [OPTION] },
  });
  const state = manager.getConfiguration();
  assert.equal(state.readiness.ready, false);
  assert.equal(state.config.provider, '');
  assert.equal(state.config.model, '');
  assert.equal(store.getSystemServiceConfig(), null);
});

test('resolvable startup settings cannot activate the scribe until the shared selection is saved', () => {
  const store = memoryStore();
  const manager = createRecoveryScribeConfigManager({
    store, defaults: SELECTION, modelCatalog: { getOptions: () => [OPTION] },
  });
  assert.equal(manager.getConfiguration().readiness.ready, false, 'no persisted system-service choice');
  assert.equal(manager.getConfigSnapshot().model, '', 'startup preference is not a saved scribe selection');
  assert.equal(store.getSystemServiceConfig(), null, 'do not migrate implicit defaults');
  assert.equal(manager.updateConfiguration(SELECTION).readiness.ready, true);
  assert.equal(manager.getConfigSnapshot().model, SELECTION.model);
});

test('automatic rule summaries and titles do not invoke models without a saved scribe', async (t) => {
  clearEnvironmentUntilTestEnds(t);
  process.env.PI_PROVIDER = SELECTION.provider;
  process.env.PI_MODEL = SELECTION.model;
  process.env.CAFF_DIGEST_PROVIDER = SELECTION.provider;
  process.env.CAFF_DIGEST_MODEL = SELECTION.model;
  const tempDir = withTempDir('caff-unconfigured-auto-digest-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  t.after(() => { store.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const agent = store.saveCustomRoleConfig({ id: 'auto-agent', name: 'Auto Agent', personaPrompt: 'test' });
  const conversation = store.createConversation({ title: 'New Conversation', participants: [agent.id] });
  for (let index = 0; index < 2; index++) store.createMessage({
    conversationId: conversation.id, turnId: `test-${index}`, role: 'user', senderName: 'User', content: `Configuration discussion ${index}`,
  });
  const titleBefore = store.getConversation(conversation.id).title;
  let digestCalls = 0;
  let titleCalls = 0;
  const result = await maybeAutoCreateConversationDigest(store, conversation.id, {
    autoCreate: true, autoCreateMessageBudget: 2, autoCreateIdleMs: 0, autoCreateCooldownMs: 0, summaryMode: 'auto', autoTitleRefine: true,
    resolveSystemModelConfigSnapshot: () => null,
    modelCatalog: { getOptions: () => [OPTION] },
    digestModelRunner: async () => {
      digestCalls++;
      return { summary: 'Unexpected model summary', facts: [], decisions: [], openQuestions: [], nextActions: [], artifacts: [] };
    },
    titleModelRunner: async () => { titleCalls++; return 'Unexpected title'; },
  });
  assert.equal(result.autoCreated, true, 'the existing non-model rule summary remains available');
  assert.equal(digestCalls, 0);
  assert.equal(titleCalls, 0);
  assert.equal(store.getConversation(conversation.id).title, titleBefore);
});

test('model skill drafts reject unconfigured or unresolved choices before runner or persistence', async (t) => {
  clearEnvironmentUntilTestEnds(t);
  const tempDir = withTempDir('caff-unconfigured-skill-');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const conversation = { id: 'skill-conversation', metadata: { conversationDigests: [{
    id: 'skill-digest', kind: 'entry', createdAt: '2026-09-24T00:00:00Z', summary: 'Reusable test workflow',
    facts: ['A test catches a regression'], decisions: ['Verify before deployment'], nextActions: ['Run tests'], artifacts: ['test.js'],
  }] } };
  let calls = 0;
  let writes = 0;
  const store = {
    getConversation: () => structuredClone(conversation),
    updateConversation(_id, update) { writes++; return { ...conversation, ...update }; },
  };
  for (const selection of [{ provider: '', model: '' }, SELECTION]) {
    await assert.rejects(() => applyConversationSkillDraftAction(store, conversation.id, {
      action: 'extract', digestId: 'skill-digest', generationMode: 'model', ...selection,
    }, {
      projectDir: tempDir, modelCatalog: { getOptions: () => [{ ...OPTION, runtimeResolvable: false }] },
      skillDraftModelRunner: async () => { calls++; return {}; },
    }), (error) => error.statusCode === 409 && error.code === 'skill_draft_model_unconfigured');
    assert.equal(calls, 0);
    assert.equal(writes, 0);
  }
  process.env.CAFF_SKILL_DRAFT_PROVIDER = SELECTION.provider;
  process.env.CAFF_SKILL_DRAFT_MODEL = SELECTION.model;
  const repaired = await applyConversationSkillDraftAction(store, conversation.id, {
    action: 'extract', digestId: 'skill-digest', generationMode: 'model',
  }, {
    projectDir: tempDir, modelCatalog: { getOptions: () => [OPTION] },
    skillDraftModelRunner: async ({ config }) => {
      calls++;
      assert.equal(config.provider, SELECTION.provider);
      assert.equal(config.model, SELECTION.model);
      return { name: 'Verified workflow', description: 'Regression verification', steps: ['Run the regression suite'] };
    },
  });
  assert.equal(repaired.changed, true);
  assert.equal(calls, 1, 'explicit env still works after configuration repair without restarting');
  assert.equal(writes, 1);
});

test('PI and Digest env settings cannot activate model summaries without a saved system scribe', async (t) => {
  clearEnvironmentUntilTestEnds(t);
  process.env.PI_PROVIDER = SELECTION.provider;
  process.env.PI_MODEL = SELECTION.model;
  process.env.CAFF_DIGEST_PROVIDER = SELECTION.provider;
  process.env.CAFF_DIGEST_MODEL = SELECTION.model;
  const tempDir = withTempDir('caff-unconfigured-digest-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  t.after(() => { store.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const agent = store.saveCustomRoleConfig({ id: 'test-scribe-agent', name: 'Test Scribe Agent', personaPrompt: 'test' });
  const conversation = store.createConversation({ title: 'Explicit test title', participants: [agent.id] });
  store.createMessage({ conversationId: conversation.id, turnId: 'test-turn', role: 'user', senderName: 'User', content: 'Summarize this message.' });
  const before = store.getConversation(conversation.id);
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { summary: 'Must not be generated without a saved selection.', facts: [], decisions: [], openQuestions: [], nextActions: [], artifacts: [] };
  };
  await assert.rejects(() => applyConversationDigestAction(store, conversation.id, {
    action: 'create', summaryMode: 'model',
  }, {
    resolveSystemModelConfigSnapshot: () => store.getSystemServiceConfig('recovery_scribe'),
    modelCatalog: { getOptions: () => [OPTION] },
    digestModelRunner: runner,
    titleModelRunner: runner,
  }), (error) => error.statusCode === 409 && error.code === 'conversation_digest_model_unconfigured');
  assert.equal(calls, 0);
  assert.deepEqual(store.getConversation(conversation.id), before, 'no digest/history mutation');
  assert.equal(store.getSystemServiceConfig('recovery_scribe'), null);
});
