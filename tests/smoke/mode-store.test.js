const assert = require('node:assert/strict');
const path = require('node:fs');
const fs = require('node:fs');
const os = require('node:os');
const test = require('node:test');

const { migrateChatSchema } = require('../../build/storage/sqlite/migrations');
const { ModeStore } = require('../../build/lib/mode-store');

function createTestDb() {
  const betterSqlite3 = require('better-sqlite3');
  const db = betterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateChatSchema(db);
  return db;
}

// ─── CRUD ────────────────────────────────────────────────────

test('ModeStore: seeds 4 builtin modes on construction', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const modes = store.list();
  assert.equal(modes.length, 4);

  const ids = modes.map((mode) => mode.id).sort();
  assert.deepEqual(ids, ['skill_test_design', 'standard', 'werewolf', 'who_is_undercover']);

  const skillTestDesignMode = store.get('skill_test_design');
  assert.deepEqual(skillTestDesignMode.skillIds, ['skill-test-design-workbench']);
  assert.equal(skillTestDesignMode.loadingStrategy, 'dynamic');
  assert.ok(modes.every((mode) => mode.builtin === true));
});

test('ModeStore: get returns a single mode by id', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const mode = store.get('werewolf');
  assert.ok(mode);
  assert.equal(mode.id, 'werewolf');
  assert.equal(mode.name, '狼人杀');
  assert.equal(mode.builtin, true);
});

test('ModeStore: get returns null for missing id', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const mode = store.get('does-not-exist');
  assert.equal(mode, null);
});

test('ModeStore: save creates a new custom mode', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const created = store.save({
    name: 'Coding',
    description: 'Coding assistant mode',
    skillIds: ['check', 'before-dev'],
    loadingStrategy: 'dynamic',
  });

  assert.ok(created);
  assert.ok(created.id);
  assert.equal(created.name, 'Coding');
  assert.equal(created.description, 'Coding assistant mode');
  assert.equal(created.builtin, false);
  assert.deepEqual(created.skillIds, ['check', 'before-dev']);
  assert.equal(created.loadingStrategy, 'dynamic');

  // Persisted
  const fetched = store.get(created.id);
  assert.equal(fetched.name, 'Coding');
});

test('ModeStore: save with explicit id uses that id', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const created = store.save({
    id: 'coding',
    name: 'Coding Mode',
  });

  assert.equal(created.id, 'coding');
});

test('ModeStore: save updates an existing mode', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const created = store.save({ name: 'Temp' });
  const updated = store.save({ id: created.id, name: 'Updated', description: 'Now with desc' });

  assert.equal(updated.id, created.id);
  assert.equal(updated.name, 'Updated');
  assert.equal(updated.description, 'Now with desc');

  // Only one extra custom mode (total 5)
  assert.equal(store.list().length, 5);
});

test('ModeStore: save throws if name is empty', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  assert.throws(() => store.save({ name: '' }), /name is required/i);
});

test('ModeStore: delete removes a custom mode', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const created = store.save({ name: 'ToDelete' });
  assert.equal(store.list().length, 5);

  store.delete(created.id);
  assert.equal(store.get(created.id), null);
  assert.equal(store.list().length, 4);
});

// ─── Builtin protection ──────────────────────────────────────

test('ModeStore: cannot delete builtin modes', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  for (const id of ['standard', 'skill_test_design', 'werewolf', 'who_is_undercover']) {
    assert.throws(() => store.delete(id), /cannot delete builtin/i);
  }
});

test('ModeStore: can update builtin mode name and skillIds', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const updated = store.save({
    id: 'werewolf',
    name: '大灰狼',
    skillIds: ['werewolf-skill'],
    loadingStrategy: 'full',
  });

  assert.equal(updated.name, '大灰狼');
  assert.deepEqual(updated.skillIds, ['werewolf-skill']);
  assert.equal(updated.builtin, true);
  assert.equal(updated.loadingStrategy, 'full');
});

// ─── normalizeSkillIds ───────────────────────────────────────

test('ModeStore: save deduplicates skillIds', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const created = store.save({
    name: 'Dedup',
    skillIds: ['alpha', 'beta', 'alpha', 'gamma', 'beta'],
  });

  assert.deepEqual(created.skillIds, ['alpha', 'beta', 'gamma']);
});

test('ModeStore: save filters out empty and whitespace-only skillIds', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const created = store.save({
    name: 'Clean',
    skillIds: ['valid', '', '  ', 'also-valid'],
  });

  assert.deepEqual(created.skillIds, ['valid', 'also-valid']);
});

test('ModeStore: save with no skillIds defaults to empty array', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const created = store.save({ name: 'Empty' });
  assert.deepEqual(created.skillIds, []);
});

// ─── normalizeLoadingStrategy ────────────────────────────────

test('ModeStore: loadingStrategy "full" is preserved', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const created = store.save({ name: 'Full', loadingStrategy: 'full' });
  assert.equal(created.loadingStrategy, 'full');
});

test('ModeStore: loadingStrategy defaults to "dynamic" for unknown values', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const created = store.save({ name: 'Unknown', loadingStrategy: 'something-weird' });
  assert.equal(created.loadingStrategy, 'dynamic');
});

test('ModeStore: loadingStrategy is case-insensitive', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  const created = store.save({ name: 'Upper', loadingStrategy: 'FULL' });
  assert.equal(created.loadingStrategy, 'full');
});

// ─── Seed idempotency ───────────────────────────────────────

test('ModeStore: seedBuiltinModes is idempotent (constructing twice does not duplicate)', () => {
  const db = createTestDb();

  const store1 = new ModeStore(db);
  assert.equal(store1.list().length, 4);

  // Construct again on the same db — should not add duplicates
  const store2 = new ModeStore(db);
  assert.equal(store2.list().length, 4);
});

test('ModeStore: upgrades existing Skill Test design builtin with required workbench skill', () => {
  const db = createTestDb();
  const timestamp = '2026-04-21T00:00:00.000Z';

  db.prepare(`
    INSERT INTO modes (id, name, description, builtin, skill_ids_json, loading_strategy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('skill_test_design', 'Custom Skill Test 设计', 'Existing empty mode', 1, '[]', 'dynamic', timestamp, timestamp);

  const store = new ModeStore(db);
  const mode = store.get('skill_test_design');

  assert.equal(mode.name, 'Custom Skill Test 设计');
  assert.equal(mode.description, 'Existing empty mode');
  assert.deepEqual(mode.skillIds, ['skill-test-design-workbench']);
  assert.equal(mode.loadingStrategy, 'dynamic');
});

test('ModeStore: migrates legacy empty Feishu coding mode to custom Coding mode', () => {
  const db = createTestDb();
  const timestamp = '2026-04-14T00:00:00.000Z';

  db.prepare(`
    INSERT INTO modes (id, name, description, builtin, skill_ids_json, loading_strategy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('coding', 'Coding', 'Legacy empty Feishu coding mode', 1, '[]', 'dynamic', timestamp, timestamp);
  db.prepare(`
    INSERT INTO modes (id, name, description, builtin, skill_ids_json, loading_strategy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('custom-coding', 'Coding', 'User Trellis Coding mode', 0, JSON.stringify(['before-dev', 'check']), 'dynamic', timestamp, timestamp);
  db.prepare(`
    INSERT INTO chat_agents (id, name, persona_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('agent-1', 'Agent 1', 'Test persona', timestamp, timestamp);
  db.prepare(`
    INSERT INTO chat_conversations (id, title, type, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('conversation-1', 'Legacy Feishu chat', 'coding', '{}', timestamp, timestamp);
  db.prepare(`
    INSERT INTO chat_conversation_agents (conversation_id, agent_id, conversation_skills_json, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('conversation-1', 'agent-1', JSON.stringify(['start']), 0, timestamp);

  const store = new ModeStore(db);
  const modes = store.list();
  const conversation = db.prepare('SELECT type FROM chat_conversations WHERE id = ?').get('conversation-1');
  const participant = db.prepare(`
    SELECT conversation_skills_json
    FROM chat_conversation_agents
    WHERE conversation_id = ? AND agent_id = ?
  `).get('conversation-1', 'agent-1');

  assert.equal(store.get('coding'), null);
  assert.equal(modes.some((mode) => mode.id === 'coding'), false);
  assert.equal(conversation.type, 'custom-coding');
  assert.deepEqual(JSON.parse(participant.conversation_skills_json), ['start', 'before-dev', 'check']);
});

// ─── list ordering ──────────────────────────────────────────

test('ModeStore: list returns builtin modes first, then custom by created_at', () => {
  const db = createTestDb();
  const store = new ModeStore(db);

  store.save({ name: 'Zebra Mode' });
  store.save({ name: 'Alpha Mode' });

  const modes = store.list();
  // 4 builtin + 2 custom = 6
  assert.equal(modes.length, 6);

  // First 4 are builtin
  assert.ok(modes[0].builtin);
  assert.ok(modes[1].builtin);
  assert.ok(modes[2].builtin);
  assert.ok(modes[3].builtin);

  // Last 2 are custom (order depends on created_at resolution)
  const customNames = [modes[4].name, modes[5].name].sort();
  assert.deepEqual(customNames, ['Alpha Mode', 'Zebra Mode']);
});
