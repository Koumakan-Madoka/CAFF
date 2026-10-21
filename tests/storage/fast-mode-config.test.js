const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { migrateChatSchema } = require('../../build/storage/sqlite/migrations');
const { createRoleService } = require('../../build/server/domain/roles/role-service');
const {
  FAST_MODE_API,
  FAST_MODE_MODEL_ALLOWLIST,
  supportsFastMode,
} = require('../../build/server/domain/models/fast-mode-support');
const { withTempDir } = require('../helpers/temp-dir');

const CODEX_OPTION = {
  key: 'openai-codexgpt-6.1-sol',
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  label: 'Codex / GPT 6.1 Sol',
  source: 'models_json',
  sourceLabel: 'models.json',
  runtimeResolvable: true,
  family: 'gpt',
  familySource: 'explicit',
  api: 'openai-codex-responses',
  supportsFast: true,
  supportedThinkingLevels: ['off', 'low', 'high'],
};

const CLAUDE_OPTION = {
  key: 'anthropicclaude-opus',
  provider: 'anthropic',
  model: 'claude-opus',
  label: 'Anthropic / Claude Opus',
  source: 'models_json',
  sourceLabel: 'models.json',
  runtimeResolvable: true,
  family: 'claude',
  familySource: 'explicit',
  api: 'anthropic-messages',
  supportsFast: false,
  supportedThinkingLevels: ['off', 'low', 'high'],
};

const CODEX_MINI_OPTION = {
  key: 'openai-codexgpt-5.4-mini',
  provider: 'openai-codex',
  model: 'gpt-5.4-mini',
  label: 'Codex / GPT 5.4 mini',
  source: 'models_json',
  sourceLabel: 'models.json',
  runtimeResolvable: true,
  family: 'gpt',
  familySource: 'explicit',
  api: 'openai-codex-responses',
  supportsFast: false,
  supportedThinkingLevels: ['off', 'low', 'high'],
};

function modelOptions() {
  return [structuredClone(CODEX_OPTION), structuredClone(CLAUDE_OPTION), structuredClone(CODEX_MINI_OPTION)];
}

function createService(roles) {
  return createRoleService({
    store: {
      listAgents() {
        return structuredClone(roles);
      },
      getAgent(roleId) {
        return structuredClone(roles.find((role) => role.id === roleId) || null);
      },
      getRoleIdentity() {
        return null;
      },
      saveCustomRoleConfig(candidate) {
        if (!candidate.id) {
          candidate.id = `custom-${roles.length + 1}`;
        }
        const index = roles.findIndex((role) => role.id === candidate.id);
        if (index === -1) roles.push(structuredClone(candidate));
        else roles[index] = structuredClone(candidate);
        return structuredClone(candidate);
      },
      saveSystemRoleConfig(candidate) {
        const index = roles.findIndex((role) => role.id === candidate.id);
        roles[index] = structuredClone({ ...roles[index], ...candidate });
        return structuredClone(roles[index]);
      },
      normalizeConversationParticipantsInput(input) {
        return input.participants.map((participant) => ({
          agentId: participant.agentId,
          modelProfileId: participant.modelProfileId || null,
          conversationSkills: participant.conversationSkillIds || [],
        }));
      },
    },
    modelCatalog: { getOptions: modelOptions },
  });
}

function gptFamilyRole(overrides = {}) {
  return {
    id: 'role-family-gpt',
    name: 'GPT',
    roleKind: 'model_family',
    modelFamily: 'gpt',
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    thinking: 'low',
    fast: false,
    modelProfiles: [],
    isDefaultChatRole: false,
    ...overrides,
  };
}

test('fast support detection gates on the subscription provider, codex api and W1 allowlist', () => {
  assert.equal(FAST_MODE_API, 'openai-codex-responses');
  assert.ok(FAST_MODE_MODEL_ALLOWLIST.includes('gpt-6.1-sol'));
  const codex = { provider: 'openai-codex', api: 'openai-codex-responses', model: 'gpt-6.1-sol' };
  assert.equal(supportsFastMode(codex), true);
  assert.equal(supportsFastMode({ ...codex, provider: 'custom-codex' }), false);
  assert.equal(supportsFastMode({ ...codex, provider: '' }), false);
  assert.equal(supportsFastMode({ ...codex, model: 'gpt-5.4-mini' }), false);
  assert.equal(supportsFastMode({ ...codex, api: 'openai-responses' }), false);
  assert.equal(supportsFastMode({ ...codex, api: '' }), false);
  assert.equal(supportsFastMode({ ...codex, model: '' }), false);
  assert.equal(supportsFastMode(null), false);
});

test('fast toggle persists for family and custom roles, defaults OFF, and survives reopen', (t) => {
  const tempDir = withTempDir('caff-fast-mode-config-');
  const sqlitePath = path.join(tempDir, 'roles.sqlite');
  let store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
  });

  // Fresh schema: the column exists and family roles default OFF.
  const columns = store.db.prepare("PRAGMA table_info('chat_agents')").all().map((column) => column.name);
  assert.ok(columns.includes('fast'));
  assert.equal(store.getAgent('role-family-gpt').fast, false);

  // Family role opt-in persists down to the column value.
  store.saveSystemRoleConfig({
    id: 'role-family-gpt',
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    thinking: 'low',
    fast: true,
    modelProfiles: [{ id: 'quick', name: 'Fast Profile', provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'low', fast: true }],
    isDefaultChatRole: true,
    sessionReuseEnabled: true,
  });
  let gpt = store.getAgent('role-family-gpt');
  assert.equal(gpt.fast, true);
  assert.equal(
    store.db.prepare('SELECT fast FROM chat_agents WHERE id = ?').get('role-family-gpt').fast,
    1
  );
  assert.equal(gpt.modelProfiles[0].fast, true);

  // Custom roles default OFF at creation and accept an explicit opt-in.
  const custom = store.saveCustomRoleConfig({ name: 'Fast Custom Role' });
  assert.equal(custom.fast, false);
  const updated = store.saveCustomRoleConfig({
    id: custom.id,
    name: 'Fast Custom Role',
    fast: true,
    modelProfiles: [{ id: 'p1', name: 'P1', provider: 'anthropic', model: 'claude-opus', thinking: '', fast: true }],
  });
  assert.equal(updated.fast, true);
  assert.equal(updated.modelProfiles[0].fast, true);

  // Re-opening re-runs the family reconcile, which must not reset fast.
  store.close();
  store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  gpt = store.getAgent('role-family-gpt');
  assert.equal(gpt.fast, true);
  assert.equal(gpt.modelProfiles[0].fast, true);
  const reopened = store.getAgent(custom.id);
  assert.equal(reopened.fast, true);
  assert.equal(reopened.modelProfiles[0].fast, true);
});

test('migrating a pre-fast database keeps existing roles and profiles OFF', () => {
  const tempDir = withTempDir('caff-fast-mode-migration-');
  const sqlitePath = path.join(tempDir, 'legacy.sqlite');

  let store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  store.saveSystemRoleConfig({
    id: 'role-family-gpt',
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    thinking: 'low',
    fast: true,
    modelProfiles: [{ id: 'quick', name: 'Quick', provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: '', fast: true }],
    isDefaultChatRole: true,
    sessionReuseEnabled: true,
  });
  store.close();

  // Simulate a pre-fast database by dropping the column and stripping the
  // profile flag from the stored JSON, then re-running the migration.
  const Database = require('better-sqlite3');
  const db = new Database(sqlitePath);
  db.pragma('foreign_keys = OFF');
  db.prepare('ALTER TABLE chat_agents DROP COLUMN fast').run();
  db.prepare(
    "UPDATE chat_agents SET model_profiles_json = '[{\"id\":\"quick\",\"name\":\"Quick\",\"provider\":\"openai-codex\",\"model\":\"gpt-6.1-sol\",\"thinking\":\"\",\"personaPrompt\":\"\"}]' WHERE id = 'role-family-gpt'"
  ).run();
  migrateChatSchema(db);
  db.close();

  store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  try {
    const gpt = store.getAgent('role-family-gpt');
    assert.equal(gpt.fast, false, 'migrated rows default OFF');
    assert.equal(gpt.modelProfiles[0].fast, false, 'migrated profiles default OFF');
  } finally {
    store.close();
  }
});

test('role service exposes fast as editable, persists it, and resolves runtimeConfig.fast with profile precedence', () => {
  const roles = [gptFamilyRole({
    fast: false,
    modelProfiles: [{ id: 'fast-profile', name: 'Fast', description: '', provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'high', fast: true, personaPrompt: '' }],
  })];
  const service = createService(roles);

  const directory = service.getDirectory();
  const gpt = directory.agents.find((role) => role.id === 'role-family-gpt');
  assert.ok(gpt.editableFields.includes('fast'));
  assert.equal(gpt.fast, false);
  assert.equal(gpt.modelProfiles[0].fast, true);
  const codexOption = directory.modelOptions.find((option) => option.model === 'gpt-6.1-sol');
  assert.equal(codexOption.supportsFast, true);

  // Family update toggles the role default without touching profiles.
  const updated = service.updateRole('role-family-gpt', { fast: true });
  const updatedGpt = updated.agents.find((role) => role.id === 'role-family-gpt');
  assert.equal(updatedGpt.fast, true);
  assert.equal(updatedGpt.modelProfiles[0].fast, true);

  // Resolved runtime config: profile toggle wins over the role default.
  const resolved = service.resolveRuntimeParticipants([
    { id: 'role-family-gpt', selectedModelProfileId: 'fast-profile' },
    { id: 'role-family-gpt', selectedModelProfileId: null },
  ]);
  assert.equal(resolved[0].runtimeConfig.fast, true, 'selected profile fast wins');
  assert.equal(resolved[1].runtimeConfig.fast, true, 'role default applies without a profile');

  // Custom role round-trip through create/update.
  const created = service.createCustomRole({
    name: 'Fast Custom',
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    thinking: 'low',
    fast: true,
    modelProfiles: [{ id: 'p1', name: 'P1', provider: 'anthropic', model: 'claude-opus', thinking: '', fast: true }],
  });
  const createdRole = created.agents.find((role) => role.name === 'Fast Custom');
  assert.equal(createdRole.fast, true);
  assert.equal(createdRole.modelProfiles[0].fast, true);

  const updatedCustom = service.updateRole(createdRole.id, { fast: false });
  const customRole = updatedCustom.agents.find((role) => role.id === createdRole.id);
  assert.equal(customRole.fast, false, 'explicit false clears the toggle');
  assert.equal(customRole.modelProfiles[0].fast, true, 'profiles untouched when not submitted');
});

test('role service rejects non-boolean fast input instead of coercing truthiness', () => {
  const roles = [gptFamilyRole()];
  const service = createService(roles);

  for (const bad of ['false', '0', '1', [], {}, 0, 1, null]) {
    assert.throws(
      () => service.updateRole('role-family-gpt', { fast: bad }),
      (error) => error.statusCode === 422 && error.issues[0].code === 'fast_not_boolean' && error.issues[0].path === 'fast',
      `family role default must reject ${JSON.stringify(bad)}`
    );
    assert.throws(
      () => service.createCustomRole({ name: 'Bad Fast', fast: bad }),
      (error) => error.statusCode === 422 && error.issues[0].code === 'fast_not_boolean',
      `custom role must reject ${JSON.stringify(bad)}`
    );
    assert.throws(
      () => service.updateRole('role-family-gpt', {
        modelProfiles: [{ id: 'p', name: 'P', provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: '', fast: bad }],
      }),
      (error) => error.statusCode === 422 && error.issues[0].code === 'fast_not_boolean' && error.issues[0].path === 'modelProfiles[0].fast',
      `profile must reject ${JSON.stringify(bad)}`
    );
  }

  // Absent keeps the current value; explicit booleans work.
  const on = service.updateRole('role-family-gpt', { fast: true });
  assert.equal(on.agents[0].fast, true);
  const kept = service.updateRole('role-family-gpt', { thinking: 'low' });
  assert.equal(kept.agents[0].fast, true, 'absent fast keeps the stored value');
  const off = service.updateRole('role-family-gpt', { fast: false });
  assert.equal(off.agents[0].fast, false);
});

test('runtimeConfig.fast profile precedence survives opposing role defaults', () => {
  const roles = [gptFamilyRole({
    fast: true,
    modelProfiles: [
      { id: 'plain', name: 'Plain', description: '', provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'low', fast: false, personaPrompt: '' },
      { id: 'legacy', name: 'Legacy', description: '', provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'low', personaPrompt: '' },
      { id: 'quick', name: 'Quick', description: '', provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'low', fast: true, personaPrompt: '' },
    ],
  })];
  const service = createService(roles);

  const resolved = service.resolveRuntimeParticipants([
    { id: 'role-family-gpt', selectedModelProfileId: 'plain' },
    { id: 'role-family-gpt', selectedModelProfileId: null },
  ]);
  assert.equal(resolved[0].runtimeConfig.fast, false, 'profile explicit false overrides role default true');
  assert.equal(resolved[1].runtimeConfig.fast, true, 'role default applies when no profile is selected');
  const legacy = service.resolveRuntimeParticipants([{ id: 'role-family-gpt', selectedModelProfileId: 'legacy' }]);
  assert.equal(legacy[0].runtimeConfig.fast, false, 'profile missing fast defaults OFF, not to the role default');
  service.updateRole('role-family-gpt', { fast: false });
  const quick = service.resolveRuntimeParticipants([{ id: 'role-family-gpt', selectedModelProfileId: 'quick' }]);
  assert.equal(quick[0].runtimeConfig.fast, true, 'profile true overrides role default false');
});

test('role service keeps fast on unsupported models permissive at write time (UI and runtime gate instead)', () => {
  const roles = [gptFamilyRole()];
  const service = createService(roles);

  const result = service.updateRole('role-family-gpt', {
    modelProfiles: [{ id: 'mini-fast', name: 'Mini Fast', provider: 'openai-codex', model: 'gpt-5.4-mini', thinking: '', fast: true }],
  });
  const gpt = result.agents.find((role) => role.id === 'role-family-gpt');
  assert.equal(gpt.modelProfiles[0].fast, true, 'value is stored; injection gating happens at runtime');
  const miniOption = result.modelOptions.find((option) => option.model === 'gpt-5.4-mini');
  assert.equal(miniOption.supportsFast, false, 'catalog still reports the model as unsupported');
});
