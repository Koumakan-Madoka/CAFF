const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

const LEGACY_ROLE_IDS = [
  'agent-strategist',
  'agent-builder',
  'agent-critic',
  'agent-tsundere-senpai',
  'agent-miko-oracle',
  'agent-mecha-engineer',
  'agent-idol-spark',
  'agent-kuudere-archivist',
  'agent-chuunibyou-visionary',
];

const FAMILY_ROLE_IDS = [
  'role-family-gpt',
  'role-family-claude',
  'role-family-gemini',
  'role-family-deepseek',
  'role-family-qwen',
  'role-family-glm',
  'role-family-kimi',
];

function stableHash(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function createLegacyFixture(databasePath) {
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
CREATE TABLE chat_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sandbox_name TEXT,
  description TEXT,
  avatar_data_url TEXT,
  persona_prompt TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  accent_color TEXT,
  skills_json TEXT,
  model_profiles_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'standard',
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT
);

CREATE TABLE chat_conversation_agents (
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model_profile_id TEXT,
  conversation_skills_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, agent_id),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES chat_agents(id) ON DELETE CASCADE
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  task_id TEXT,
  run_id INTEGER,
  error_message TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES chat_agents(id) ON DELETE SET NULL
);

CREATE TABLE chat_private_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  sender_agent_id TEXT,
  sender_name TEXT NOT NULL,
  recipient_agent_ids_json TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_agent_id) REFERENCES chat_agents(id) ON DELETE SET NULL
);

CREATE TABLE chat_memory_cards (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'conversation-agent',
  owner_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent-tool',
  status TEXT NOT NULL DEFAULT 'active',
  ttl_days INTEGER,
  expires_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, owner_key, agent_id, title),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES chat_agents(id) ON DELETE CASCADE
);

CREATE TABLE chat_summary_segments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  source_digest_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL DEFAULT 'entry',
  conversation_title TEXT NOT NULL DEFAULT '',
  task_name TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  open_questions_json TEXT NOT NULL DEFAULT '[]',
  next_actions_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  trigger_reason TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  from_message_id TEXT,
  to_message_id TEXT,
  created_by TEXT,
  segment_created_at TEXT NOT NULL,
  segment_updated_at TEXT NOT NULL,
  metadata_json TEXT,
  search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
);

CREATE TABLE chat_channel_bindings (
  platform TEXT NOT NULL,
  external_chat_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (platform, external_chat_id),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
);

CREATE TABLE chat_external_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  direction TEXT NOT NULL,
  external_event_id TEXT,
  external_message_id TEXT,
  conversation_id TEXT,
  message_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
);
  `);

  const timestamp = '2026-08-02T00:00:00.000Z';
  const insertAgent = db.prepare(`
    INSERT INTO chat_agents (
      id, name, sandbox_name, description, avatar_data_url, persona_prompt,
      provider, model, thinking, accent_color, skills_json, model_profiles_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [index, roleId] of LEGACY_ROLE_IDS.entries()) {
    insertAgent.run(
      roleId,
      roleId === 'agent-strategist' ? 'Operator Modified Strategist' : `Legacy ${index}`,
      `legacy-${index}`,
      `legacy description ${index}`,
      null,
      roleId === 'agent-strategist' ? 'operator modified prompt' : `legacy prompt ${index}`,
      'openai',
      'gpt-legacy',
      'high',
      '#123456',
      JSON.stringify([`legacy-skill-${index}`]),
      JSON.stringify([{ id: `legacy-profile-${index}`, model: 'gpt-legacy', thinking: 'high' }]),
      timestamp,
      timestamp
    );
  }

  insertAgent.run(
    'custom-architect',
    'Custom Architect',
    'custom-architect',
    'custom description',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'custom persona',
    'anthropic',
    'claude-custom',
    'max',
    '#abcdef',
    JSON.stringify(['source-audit', 'quality-gate']),
    JSON.stringify([{ id: 'deep-review', provider: 'anthropic', model: 'claude-custom', thinking: 'max', personaPrompt: 'profile persona' }]),
    timestamp,
    timestamp
  );

  db.prepare(`
    INSERT INTO chat_conversations (id, title, type, metadata_json, created_at, updated_at, last_message_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'conversation-legacy',
    'Legacy room',
    'werewolf',
    JSON.stringify({ game: { phase: 'night', players: LEGACY_ROLE_IDS.slice(0, 3) } }),
    timestamp,
    timestamp,
    timestamp
  );

  const insertParticipant = db.prepare(`
    INSERT INTO chat_conversation_agents (
      conversation_id, agent_id, model_profile_id, conversation_skills_json, sort_order, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertParticipant.run('conversation-legacy', 'agent-strategist', 'legacy-profile-0', JSON.stringify(['room-skill']), 0, timestamp);
  insertParticipant.run('conversation-legacy', 'agent-builder', null, JSON.stringify([]), 1, timestamp);
  insertParticipant.run('conversation-legacy', 'custom-architect', 'deep-review', JSON.stringify(['room-custom']), 2, timestamp);

  const insertMessage = db.prepare(`
    INSERT INTO chat_messages (
      id, conversation_id, turn_id, role, agent_id, sender_name, content, status,
      task_id, run_id, error_message, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertMessage.run('message-legacy', 'conversation-legacy', 'turn-1', 'assistant', 'agent-strategist', 'Modified Strategist', 'legacy answer', 'completed', 'task-1', 7, null, JSON.stringify({ tool: 'legacy' }), timestamp);
  insertMessage.run('message-custom', 'conversation-legacy', 'turn-2', 'assistant', 'custom-architect', 'Custom Architect', 'custom answer', 'completed', null, null, null, JSON.stringify({ tool: 'custom' }), timestamp);
  insertMessage.run('message-user', 'conversation-legacy', 'turn-3', 'user', null, 'Operator', 'user message', 'completed', null, null, null, null, timestamp);

  db.prepare(`
    INSERT INTO chat_private_messages (
      id, conversation_id, turn_id, sender_agent_id, sender_name,
      recipient_agent_ids_json, content, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'private-legacy',
    'conversation-legacy',
    'turn-private',
    'agent-builder',
    'Legacy Builder',
    JSON.stringify(['agent-strategist', 'custom-architect']),
    'private content',
    JSON.stringify({ private: true }),
    timestamp
  );

  const insertMemory = db.prepare(`
    INSERT INTO chat_memory_cards (
      id, conversation_id, agent_id, scope, owner_key, title, content, source,
      status, ttl_days, expires_at, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertMemory.run('memory-legacy', 'conversation-legacy', 'agent-strategist', 'conversation-agent', 'conversation-legacy', 'Legacy memory', 'must survive', 'agent-tool', 'active', null, null, JSON.stringify({ rank: 1 }), timestamp, timestamp);
  insertMemory.run('memory-custom', null, 'custom-architect', 'local-user-agent', 'local-user', 'Custom memory', 'custom survives', 'agent-tool', 'active', null, null, JSON.stringify({ rank: 2 }), timestamp, timestamp);

  db.prepare(`
    INSERT INTO chat_summary_segments (
      id, conversation_id, source_digest_id, source_kind, conversation_title, task_name,
      summary, facts_json, decisions_json, open_questions_json, next_actions_json,
      artifacts_json, trigger_reason, message_count, from_message_id, to_message_id,
      created_by, segment_created_at, segment_updated_at, metadata_json, search_text,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'summary-legacy', 'conversation-legacy', 'digest-legacy', 'entry', 'Legacy room', 'Migration',
    'summary content', JSON.stringify(['fact']), JSON.stringify(['decision']), JSON.stringify([]),
    JSON.stringify(['next']), JSON.stringify(['artifact']), 'manual', 3, 'message-legacy', 'message-user',
    'agent-strategist', timestamp, timestamp, JSON.stringify({ model: 'legacy' }), 'summary search', timestamp, timestamp
  );

  db.prepare(`
    INSERT INTO chat_channel_bindings (
      platform, external_chat_id, conversation_id, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('feishu', 'chat-external', 'conversation-legacy', JSON.stringify({ tenant: 'test' }), timestamp, timestamp);

  db.prepare(`
    INSERT INTO chat_external_events (
      platform, direction, external_event_id, external_message_id, conversation_id,
      message_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('feishu', 'inbound', 'event-legacy', 'external-message', 'conversation-legacy', 'message-user', JSON.stringify({ dedupe: true }), timestamp);

  const snapshot = {
    counts: {
      conversations: db.prepare('SELECT COUNT(*) AS count FROM chat_conversations').get().count,
      messages: db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count,
      privateMessages: db.prepare('SELECT COUNT(*) AS count FROM chat_private_messages').get().count,
      memoryCards: db.prepare('SELECT COUNT(*) AS count FROM chat_memory_cards').get().count,
      summaries: db.prepare('SELECT COUNT(*) AS count FROM chat_summary_segments').get().count,
      externalEvents: db.prepare('SELECT COUNT(*) AS count FROM chat_external_events').get().count,
    },
    messageHash: stableHash(db.prepare(`
      SELECT id, agent_id, sender_name, content, status, task_id, run_id, error_message, metadata_json, created_at
      FROM chat_messages ORDER BY id
    `).all()),
    privateHash: stableHash(db.prepare(`
      SELECT id, sender_agent_id, sender_name, recipient_agent_ids_json, content, metadata_json, created_at
      FROM chat_private_messages ORDER BY id
    `).all()),
    customAgent: db.prepare('SELECT * FROM chat_agents WHERE id = ?').get('custom-architect'),
  };

  db.close();
  return snapshot;
}

test('legacy role migration backs up once, preserves identity-bound history, and is restart-idempotent', (t) => {
  const tempDir = withTempDir('caff-model-family-role-migration-');
  const databasePath = path.join(tempDir, 'chat.sqlite');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const before = createLegacyFixture(databasePath);

  let store = createChatAppStore({ agentDir: tempDir, sqlitePath: databasePath });
  const db = store.db;

  const backupFiles = fs.readdirSync(tempDir).filter((name) => name.includes('.pre-model-family-roles.') && name.endsWith('.bak'));
  assert.equal(backupFiles.length, 1);
  const backupPath = path.join(tempDir, backupFiles[0]);
  const backupDb = new Database(backupPath, { readonly: true });
  assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM chat_agents').get().count, 10);
  assert.equal(backupDb.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('chat_agents') WHERE name = 'role_kind'").get().count, 0);
  backupDb.close();

  assert.deepEqual(
    db.prepare('SELECT id FROM chat_agents ORDER BY id').all().map((row) => row.id),
    ['custom-architect', ...FAMILY_ROLE_IDS].sort()
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM chat_agents WHERE id IN (${LEGACY_ROLE_IDS.map(() => '?').join(',')})`).get(...LEGACY_ROLE_IDS).count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM chat_role_identities WHERE origin_kind = 'legacy_system' AND lifecycle_state = 'retired'`).get().count, 9);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM chat_role_identities WHERE origin_kind = 'model_family' AND lifecycle_state = 'active'`).get().count, 7);
  assert.equal(db.prepare(`SELECT display_name_snapshot FROM chat_role_identities WHERE role_id = 'agent-strategist'`).get().display_name_snapshot, 'Operator Modified Strategist');

  const customAgent = db.prepare('SELECT * FROM chat_agents WHERE id = ?').get('custom-architect');
  for (const column of Object.keys(before.customAgent)) {
    assert.deepEqual(customAgent[column], before.customAgent[column], column);
  }
  assert.deepEqual(
    { roleKind: customAgent.role_kind, modelFamily: customAgent.model_family, isDefault: customAgent.is_default_chat_role },
    { roleKind: 'custom', modelFamily: null, isDefault: 0 }
  );

  assert.deepEqual(db.prepare(`
    SELECT role_id, display_name_snapshot, model_profile_id_snapshot, conversation_skills_json, sort_order
    FROM chat_conversation_agent_history
    ORDER BY sort_order
  `).all(), [
    {
      role_id: 'agent-strategist',
      display_name_snapshot: 'Operator Modified Strategist',
      model_profile_id_snapshot: 'legacy-profile-0',
      conversation_skills_json: JSON.stringify(['room-skill']),
      sort_order: 0,
    },
    {
      role_id: 'agent-builder',
      display_name_snapshot: 'Legacy 1',
      model_profile_id_snapshot: null,
      conversation_skills_json: JSON.stringify([]),
      sort_order: 1,
    },
  ]);
  assert.deepEqual(db.prepare('SELECT agent_id FROM chat_conversation_agents ORDER BY sort_order').all(), [{ agent_id: 'custom-architect' }]);

  assert.deepEqual({
    conversations: db.prepare('SELECT COUNT(*) AS count FROM chat_conversations').get().count,
    messages: db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count,
    privateMessages: db.prepare('SELECT COUNT(*) AS count FROM chat_private_messages').get().count,
    memoryCards: db.prepare('SELECT COUNT(*) AS count FROM chat_memory_cards').get().count,
    summaries: db.prepare('SELECT COUNT(*) AS count FROM chat_summary_segments').get().count,
    externalEvents: db.prepare('SELECT COUNT(*) AS count FROM chat_external_events').get().count,
  }, before.counts);
  assert.equal(stableHash(db.prepare(`
    SELECT id, agent_id, sender_name, content, status, task_id, run_id, error_message, metadata_json, created_at
    FROM chat_messages ORDER BY id
  `).all()), before.messageHash);
  assert.equal(stableHash(db.prepare(`
    SELECT id, sender_agent_id, sender_name, recipient_agent_ids_json, content, metadata_json, created_at
    FROM chat_private_messages ORDER BY id
  `).all()), before.privateHash);
  assert.equal(db.prepare("SELECT agent_id FROM chat_memory_cards WHERE id = 'memory-legacy'").get().agent_id, 'agent-strategist');
  for (const [tableName, fromColumn] of [
    ['chat_messages', 'agent_id'],
    ['chat_private_messages', 'sender_agent_id'],
    ['chat_memory_cards', 'agent_id'],
  ]) {
    const identityFk = db.prepare(`
      SELECT "table", "from", on_delete
      FROM pragma_foreign_key_list(?)
      WHERE "from" = ?
    `).get(tableName, fromColumn);
    assert.deepEqual(identityFk, {
      table: 'chat_role_identities',
      from: fromColumn,
      on_delete: 'RESTRICT',
    });
  }
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  const ledger = db.prepare(`
    SELECT status, backup_path, pre_counts_json, audit_json, completed_at
    FROM chat_schema_migrations
    WHERE migration_id = '2026-08-03-model-family-roles-v1'
  `).get();
  assert.equal(ledger.status, 'completed');
  assert.equal(path.resolve(ledger.backup_path), path.resolve(backupPath));
  assert.deepEqual(JSON.parse(ledger.pre_counts_json), before.counts);
  assert.ok(JSON.parse(ledger.audit_json).foreignKeyCheckPassed);
  assert.ok(ledger.completed_at);

  store.close();
  store = createChatAppStore({ agentDir: tempDir, sqlitePath: databasePath });
  assert.equal(fs.readdirSync(tempDir).filter((name) => name.includes('.pre-model-family-roles.') && name.endsWith('.bak')).length, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM chat_conversation_agent_history').get().count, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM chat_agents').get().count, 8);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM chat_agents WHERE id IN (${LEGACY_ROLE_IDS.map(() => '?').join(',')})`).get(...LEGACY_ROLE_IDS).count, 0);
  store.close();
});

test('fresh schema creates only family configs and permanently reserves legacy system role ids', (t) => {
  const tempDir = withTempDir('caff-model-family-role-fresh-');
  const databasePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: databasePath });
  t.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  assert.deepEqual(store.listAgents().map((agent) => agent.id).sort(), [...FAMILY_ROLE_IDS].sort());
  assert.ok(store.listAgents().every((agent) => (
    agent.roleKind === 'model_family'
    && agent.personaPrompt === ''
    && agent.isDefaultChatRole === false
  )));

  assert.throws(
    () => store.saveAgent({
      id: 'agent-strategist',
      name: 'Do not resurrect',
      personaPrompt: 'This id is permanently retired.',
    }),
    (error) => error && error.code === 'role_identity_not_reusable'
  );
  assert.equal(store.getAgent('agent-strategist'), null);
});

test('legacy file migration fails closed when the backup helper cannot create a recovery copy', (t) => {
  const tempDir = withTempDir('caff-model-family-role-backup-failure-');
  const databasePath = path.join(tempDir, 'chat.sqlite');
  const missingScriptPath = path.join(tempDir, 'missing-backup-helper.mjs');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  createLegacyFixture(databasePath);

  assert.throws(
    () => createChatAppStore({
      agentDir: tempDir,
      sqlitePath: databasePath,
      chatSchemaBackupScriptPath: missingScriptPath,
    }),
    (error) => error && error.code === 'chat_schema_backup_failed'
  );

  const db = new Database(databasePath, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_agents').get().count, 10);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('chat_agents') WHERE name = 'role_kind'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'chat_role_identities'").get().count, 0);
  db.close();
  assert.equal(fs.readdirSync(tempDir).filter((name) => name.endsWith('.bak')).length, 0);
});

test('migration audit failure rolls the role rebuild back and leaves the recovery backup usable', (t) => {
  const tempDir = withTempDir('caff-model-family-role-rollback-');
  const databasePath = path.join(tempDir, 'chat.sqlite');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  createLegacyFixture(databasePath);

  const legacyDb = new Database(databasePath);
  legacyDb.pragma('foreign_keys = OFF');
  legacyDb.prepare(`
    INSERT INTO chat_memory_cards (
      id, conversation_id, agent_id, scope, owner_key, title, content, source,
      status, ttl_days, expires_at, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'memory-orphan',
    'conversation-legacy',
    'missing-role-id',
    'conversation-agent',
    'conversation-legacy',
    'Orphan',
    'forces foreign_key_check to fail',
    'fixture',
    'active',
    null,
    null,
    null,
    '2026-08-02T00:00:00.000Z',
    '2026-08-02T00:00:00.000Z'
  );
  legacyDb.close();

  assert.throws(
    () => createChatAppStore({ agentDir: tempDir, sqlitePath: databasePath }),
    /migration content audit failed/
  );

  const db = new Database(databasePath, { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('chat_agents') WHERE name = 'role_kind'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_agents').get().count, 10);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM chat_memory_cards WHERE id = 'memory-orphan'").get().count, 1);
  assert.equal(db.prepare(`
    SELECT status
    FROM chat_schema_migrations
    WHERE migration_id = '2026-08-03-model-family-roles-v1'
  `).get().status, 'failed');
  db.close();

  const backupFile = fs.readdirSync(tempDir).find((name) => name.includes('.pre-model-family-roles.') && name.endsWith('.bak'));
  assert.ok(backupFile);
  const backupDb = new Database(path.join(tempDir, backupFile), { readonly: true });
  assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM chat_agents').get().count, 10);
  assert.equal(backupDb.prepare("SELECT COUNT(*) AS count FROM chat_memory_cards WHERE id = 'memory-orphan'").get().count, 1);
  backupDb.close();
});
