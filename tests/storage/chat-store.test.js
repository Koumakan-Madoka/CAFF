const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { migrateChatSchema } = require('../../build/storage/sqlite/migrations');
const { withTempDir } = require('../helpers/temp-dir');

const TEST_CONVERSATION_PARTICIPANTS = ['role-family-gpt'];

test('migrateChatSchema emits debug warning when FTS setup fails and debug logging is enabled', (t) => {
  const originalWarn = console.warn;
  const originalFlag = process.env.CAFF_DEBUG_SQLITE_MIGRATIONS;
  const warnings = [];
  const fakeDb = {
    prepare() {
      return {
        all() {
          return [];
        },
        get() {
          return null;
        },
        run() {},
      };
    },
    exec(sql) {
      if (String(sql || '').includes('CREATE VIRTUAL TABLE IF NOT EXISTS chat_message_search')) {
        throw new Error('fts unavailable in test');
      }
    },
  };

  console.warn = (message) => {
    warnings.push(String(message));
  };
  process.env.CAFF_DEBUG_SQLITE_MIGRATIONS = '1';

  t.after(() => {
    console.warn = originalWarn;
    if (originalFlag === undefined) {
      delete process.env.CAFF_DEBUG_SQLITE_MIGRATIONS;
    } else {
      process.env.CAFF_DEBUG_SQLITE_MIGRATIONS = originalFlag;
    }
  });

  migrateChatSchema(fakeDb);
  assert.ok(warnings.some((message) => message.includes('chat_message_search schema setup skipped')));
});

function listColumnNames(db, tableName) {
  return new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => String(column.name))
  );
}

test('chat store migrates legacy chat tables and preserves historical data', (t) => {
  const tempDir = withTempDir('caff-chat-m2-');
  const sqlitePath = path.join(tempDir, 'legacy-chat.sqlite');
  const legacyDb = new Database(sqlitePath);
  let store = null;
  let migratedDb = null;

  t.after(() => {
    try {
      migratedDb && migratedDb.close();
    } catch {}
    try {
      store && store.close();
    } catch {}
    try {
      legacyDb.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  legacyDb.exec(`
CREATE TABLE chat_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  persona_prompt TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  accent_color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT
);

CREATE TABLE chat_conversation_agents (
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, agent_id)
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
  created_at TEXT NOT NULL
);

CREATE TABLE chat_memory_cards (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'conversation-agent',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent-tool',
  status TEXT NOT NULL DEFAULT 'active',
  ttl_days INTEGER,
  expires_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(conversation_id, agent_id, title)
);
  `);

  legacyDb
    .prepare(`
      INSERT INTO chat_agents (
        id, name, description, persona_prompt, provider, model, thinking, accent_color, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      'legacy-agent',
      'Legacy Agent',
      'Migrated from the old schema',
      'Reply tersely.',
      '',
      '',
      '',
      '#123456',
      '2026-03-20T00:00:00.000Z',
      '2026-03-20T00:00:00.000Z'
    );
  legacyDb
    .prepare(`
      INSERT INTO chat_conversations (
        id, title, created_at, updated_at, last_message_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      'legacy-conversation',
      'Legacy Conversation',
      '2026-03-20T00:00:00.000Z',
      '2026-03-20T00:00:00.000Z',
      '2026-03-20T00:00:00.000Z'
    );
  legacyDb
    .prepare(`
      INSERT INTO chat_conversation_agents (
        conversation_id, agent_id, sort_order, created_at
      ) VALUES (?, ?, ?, ?)
    `)
    .run('legacy-conversation', 'legacy-agent', 0, '2026-03-20T00:00:00.000Z');
  legacyDb
    .prepare(`
      INSERT INTO chat_messages (
        id, conversation_id, turn_id, role, agent_id, sender_name, content, status, task_id, run_id, error_message, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      'legacy-message',
      'legacy-conversation',
      'legacy-turn',
      'assistant',
      'legacy-agent',
      'Legacy Agent',
      'Historical message',
      'completed',
      null,
      null,
      null,
      null,
      '2026-03-20T00:00:00.000Z'
    );
  legacyDb
    .prepare(`
      INSERT INTO chat_memory_cards (
        id, conversation_id, agent_id, scope, title, content, source, status, ttl_days, expires_at, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      'legacy-memory-card',
      'legacy-conversation',
      'legacy-agent',
      'conversation-agent',
      'preference',
      'Legacy scoped memory survives migration.',
      'agent-tool',
      'active',
      30,
      '2099-04-19T00:00:00.000Z',
      JSON.stringify({ legacy: true }),
      '2026-03-20T00:00:00.000Z',
      '2026-03-20T00:00:00.000Z'
    );
  legacyDb.close();

  store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  const conversation = store.getConversation('legacy-conversation');
  assert.equal(conversation.id, 'legacy-conversation');
  assert.equal(conversation.type, 'standard');
  assert.deepEqual(conversation.metadata, {});
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0].content, 'Historical message');
  assert.equal(conversation.agents.length, 1);
  assert.equal(conversation.agents[0].id, 'legacy-agent');
  assert.deepEqual(conversation.agents[0].conversationSkillIds, []);
  assert.equal(conversation.agents[0].selectedModelProfileId, null);
  assert.equal(store.listConversationMemoryCards('legacy-conversation', 'legacy-agent')[0].title, 'preference');
  assert.equal(store.listVisibleMemoryCards('legacy-conversation', 'legacy-agent')[0].ownerKey, 'legacy-conversation');

  store.close();

  migratedDb = new Database(sqlitePath, { readonly: true });

  const agentColumns = listColumnNames(migratedDb, 'chat_agents');
  const conversationColumns = listColumnNames(migratedDb, 'chat_conversations');
  const participantColumns = listColumnNames(migratedDb, 'chat_conversation_agents');
  const memoryCardColumns = listColumnNames(migratedDb, 'chat_memory_cards');

  assert.equal(agentColumns.has('sandbox_name'), true);
  assert.equal(agentColumns.has('skills_json'), true);
  assert.equal(agentColumns.has('model_profiles_json'), true);
  assert.equal(conversationColumns.has('type'), true);
  assert.equal(conversationColumns.has('metadata_json'), true);
  assert.equal(participantColumns.has('model_profile_id'), true);
  assert.equal(participantColumns.has('conversation_skills_json'), true);
  assert.equal(memoryCardColumns.has('owner_key'), true);
});

test('chat store persists repository-backed writes for conversations and messages', (t) => {
  const tempDir = withTempDir('caff-chat-write-m2-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  let store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveCustomRoleConfig({
    id: 'repo-agent',
    name: 'Repository Agent',
    personaPrompt: 'Stay concise.',
    skillIds: ['skill-one', 'skill-one'],
    modelProfiles: [{ id: 'fast', label: 'Fast', model: 'gpt-test' }],
  });

  const conversation = store.createConversation({
    id: 'repo-conversation',
    title: 'Repository Conversation',
    participants: [
      {
        agentId: agent.id,
        modelProfileId: 'fast',
        conversationSkillIds: ['skill-one', 'skill-two', 'skill-two'],
      },
    ],
  });

  const message = store.createMessage({
    id: 'repo-message',
    conversationId: conversation.id,
    turnId: 'repo-turn',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Hello',
    metadata: { phase: 'draft' },
  });

  store.appendMessageText(message.id, ' world');
  store.createPrivateMessage({
    id: 'repo-private-message',
    conversationId: conversation.id,
    turnId: 'repo-turn',
    senderAgentId: agent.id,
    senderName: agent.name,
    recipientAgentIds: [agent.id],
    content: 'Secret note',
    metadata: { visibility: 'private' },
  });

  store.close();
  store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  const persistedConversation = store.getConversation(conversation.id);
  const persistedMessage = store.getMessage(message.id);
  const privateMessages = store.listPrivateMessages(conversation.id);

  assert.equal(persistedConversation.agents.length, 1);
  assert.equal(persistedConversation.agents[0].selectedModelProfileId, 'fast');
  assert.deepEqual(persistedConversation.agents[0].conversationSkillIds, ['skill-one', 'skill-two']);
  assert.equal(persistedMessage.content, 'Hello world');
  assert.deepEqual(persistedMessage.metadata, { phase: 'draft' });
  assert.equal(privateMessages.length, 1);
  assert.deepEqual(privateMessages[0].recipientAgentIds, [agent.id]);
  assert.deepEqual(privateMessages[0].metadata, { visibility: 'private' });
});

test('chat store reconciles locked family fields without overwriting runtime configuration', (t) => {
  const tempDir = withTempDir('caff-family-reconcile-');
  const sqlitePath = path.join(tempDir, 'roles.sqlite');
  let store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  assert.equal(store.listAgents().filter((agent) => agent.roleKind === 'model_family').length, 7);
  const cleanQwenUpdatedAt = store.getAgent('role-family-qwen').updatedAt;
  store.close();
  store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  assert.equal(store.getAgent('role-family-qwen').updatedAt, cleanQwenUpdatedAt);

  store.db.prepare(`
    UPDATE chat_agents
    SET
      name = 'Mutated GPT',
      sandbox_name = 'mutated-sandbox',
      description = 'Mutated description',
      avatar_data_url = 'data:image/png;base64,AAAA',
      provider = 'openai',
      model = 'gpt-test',
      thinking = 'high',
      accent_color = '#000000',
      skills_json = '["forbidden-skill"]',
      model_profiles_json = '[{"id":"max","name":"Max","provider":"openai","model":"gpt-test","thinking":"max"}]',
      is_default_chat_role = 1
    WHERE id = 'role-family-gpt'
  `).run();
  store.db.prepare(`
    UPDATE chat_role_identities
    SET display_name_snapshot = 'Mutated GPT', accent_color_snapshot = '#000000'
    WHERE role_id = 'role-family-gpt'
  `).run();

  store.close();
  store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  const gpt = store.getAgent('role-family-gpt');
  const identity = store.db.prepare('SELECT * FROM chat_role_identities WHERE role_id = ?').get('role-family-gpt');
  assert.equal(gpt.name, 'GPT');
  assert.equal(gpt.sandboxName, 'role-family-gpt');
  assert.notEqual(gpt.description, 'Mutated description');
  assert.equal(gpt.avatarDataUrl, '');
  assert.equal(gpt.accentColor, '#3975c6');
  assert.deepEqual(gpt.skillIds, []);
  assert.equal(gpt.provider, 'openai');
  assert.equal(gpt.model, 'gpt-test');
  assert.equal(gpt.thinking, 'high');
  assert.equal(gpt.isDefaultChatRole, true);
  assert.equal(gpt.modelProfiles[0].id, 'max');
  assert.equal(identity.display_name_snapshot, 'GPT');
  assert.equal(identity.accent_color_snapshot, '#3975c6');
  assert.equal(identity.origin_kind, 'model_family');
  assert.equal(identity.lifecycle_state, 'active');
});

test('chat store retires custom role config after snapshotting active rosters', (t) => {
  const tempDir = withTempDir('caff-custom-retire-');
  const sqlitePath = path.join(tempDir, 'roles.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveCustomRoleConfig({
    id: 'custom-retire-role',
    name: 'Custom retire role',
    personaPrompt: 'Preserve my identity and memory.',
  });
  const conversation = store.createConversation({
    id: 'custom-retire-conversation',
    title: 'Custom retirement',
    participants: [{
      agentId: agent.id,
      modelProfileId: null,
      conversationSkillIds: ['conversation-skill'],
    }],
  });
  store.saveConversationMemoryCard(conversation.id, agent.id, {
    title: 'Retained memory',
    content: 'This memory remains after active config retirement.',
  });

  store.retireRoleConfig(agent.id, 'custom_role_deleted');

  assert.equal(store.getAgent(agent.id), null);
  assert.equal(store.getConversation(conversation.id).agents.length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM chat_memory_cards WHERE agent_id = ?').get(agent.id).count, 1);

  const identity = store.db.prepare('SELECT * FROM chat_role_identities WHERE role_id = ?').get(agent.id);
  assert.equal(identity.lifecycle_state, 'retired');
  assert.equal(identity.retired_reason, 'custom_role_deleted');

  const history = store.db.prepare('SELECT * FROM chat_conversation_agent_history WHERE role_id = ?').all(agent.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].conversation_id, conversation.id);
  assert.equal(history[0].display_name_snapshot, agent.name);
  assert.equal(history[0].role_kind_snapshot, 'custom');
  assert.deepEqual(JSON.parse(history[0].conversation_skills_json), ['conversation-skill']);
});

test('chat store pages public messages by stable created-at and id cursors', (t) => {
  const tempDir = withTempDir('caff-chat-message-page-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    id: 'message-page-conversation',
    title: 'Message Page Conversation',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });
  const otherConversation = store.createConversation({
    id: 'message-page-other-conversation',
    title: 'Other Message Page Conversation',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });
  const fixtures = [
    ['a', '2026-07-28T00:00:00.000Z'],
    ['b', '2026-07-28T00:00:00.000Z'],
    ['c', '2026-07-28T00:00:00.000Z'],
    ['d', '2026-07-28T00:01:00.000Z'],
    ['e', '2026-07-28T00:01:00.000Z'],
    ['f', '2026-07-28T00:02:00.000Z'],
    ['g', '2026-07-28T00:03:00.000Z'],
    ['h', '2026-07-28T00:03:00.000Z'],
    ['i', '2026-07-28T00:04:00.000Z'],
    ['j', '2026-07-28T00:05:00.000Z'],
  ];

  for (const [id, createdAt] of fixtures) {
    store.createMessage({
      id,
      conversationId: conversation.id,
      turnId: `turn-${id}`,
      role: 'user',
      senderName: 'User',
      content: `message-${id}`,
      createdAt,
    });
  }

  store.createMessage({
    id: 'other-message',
    conversationId: otherConversation.id,
    turnId: 'other-turn',
    role: 'user',
    senderName: 'Other User',
    content: 'must stay scoped out',
    createdAt: '2026-07-28T00:06:00.000Z',
  });

  const latest = store.listMessagePage(conversation.id, { limit: 3 });
  assert.deepEqual(latest.items.map((message) => message.id), ['h', 'i', 'j']);
  assert.equal(latest.hasMore, true);
  assert.deepEqual(latest.nextBefore, {
    createdAt: '2026-07-28T00:03:00.000Z',
    id: 'h',
  });

  store.db.prepare('DELETE FROM chat_messages WHERE id = ?').run('h');
  store.createMessage({
    id: 'k',
    conversationId: conversation.id,
    turnId: 'turn-k',
    role: 'user',
    senderName: 'User',
    content: 'message-k',
    createdAt: '2026-07-28T00:06:00.000Z',
  });

  const pageBeforeDeletedCursor = store.listMessagePage(conversation.id, {
    limit: 3,
    before: latest.nextBefore,
  });
  assert.deepEqual(pageBeforeDeletedCursor.items.map((message) => message.id), ['e', 'f', 'g']);
  assert.equal(pageBeforeDeletedCursor.hasMore, true);

  const visitedIds = [];
  let before = null;

  do {
    const page = store.listMessagePage(conversation.id, { limit: 3, before });
    visitedIds.unshift(...page.items.map((message) => message.id));
    before = page.nextBefore;
  } while (before);

  assert.deepEqual(visitedIds, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'i', 'j', 'k']);
  assert.equal(new Set(visitedIds).size, visitedIds.length);
  assert.equal(store.getConversation(conversation.id).messages.length, 10);
  assert.throws(() => store.listMessagePage(conversation.id, { limit: 0 }), /limit/i);
  assert.throws(() => store.listMessagePage(conversation.id, { limit: 101 }), /limit/i);

  const emptyConversation = store.createConversation({
    id: 'message-page-empty-conversation',
    title: 'Empty Message Page Conversation',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });
  assert.deepEqual(store.listMessagePage(emptyConversation.id, { limit: 1 }), {
    items: [],
    nextBefore: null,
    hasMore: false,
  });
});

test('chat store page queries reuse the composite index for a 50,000-message conversation', (t) => {
  const tempDir = withTempDir('caff-chat-message-page-long-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    id: 'message-page-long-conversation',
    title: 'Long Message Page Conversation',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });
  const insertMessage = store.db.prepare(`
    INSERT INTO chat_messages (
      id,
      conversation_id,
      turn_id,
      role,
      sender_name,
      content,
      status,
      metadata_json,
      created_at
    ) VALUES (?, ?, ?, 'user', 'User', ?, 'completed', '{}', ?)
  `);
  const insertFixtures = store.db.transaction(() => {
    for (let index = 0; index < 50_000; index += 1) {
      const suffix = String(index).padStart(5, '0');
      insertMessage.run(
        `long-message-${suffix}`,
        conversation.id,
        `long-turn-${suffix}`,
        `message-${suffix}`,
        `2026-07-28T00:${String(Math.floor(index / 1000)).padStart(2, '0')}:00.000Z`
      );
    }
  });
  insertFixtures();

  const repository = store.messageRepository;
  const latestSql = repository.pageByConversationStatement.source;
  const beforeSql = repository.pageBeforeConversationStatement.source;
  const latestPlan = store.db
    .prepare(`EXPLAIN QUERY PLAN ${latestSql}`)
    .all(conversation.id, 51);
  const beforePlan = store.db
    .prepare(`EXPLAIN QUERY PLAN ${beforeSql}`)
    .all(conversation.id, '2026-07-28T00:40:00.000Z', 'long-message-40000', 51);

  for (const plan of [latestPlan, beforePlan]) {
    const detail = plan.map((row) => String(row.detail || '')).join('\n');
    assert.match(detail, /USING INDEX idx_chat_messages_conversation_id/u);
    assert.doesNotMatch(detail, /USE TEMP B-TREE/u);
  }

  const startedAt = performance.now();
  const page = store.listMessagePage(conversation.id, { limit: 50 });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(page.items.length, 50);
  assert.equal(page.items[0].id, 'long-message-49950');
  assert.equal(page.items[49].id, 'long-message-49999');
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.nextBefore, {
    createdAt: '2026-07-28T00:49:00.000Z',
    id: 'long-message-49950',
  });
  t.diagnostic(`50,000-message latest page: ${elapsedMs.toFixed(3)}ms`);
  t.diagnostic(`latest plan: ${latestPlan.map((row) => row.detail).join(' | ')}`);
  t.diagnostic(`before plan: ${beforePlan.map((row) => row.detail).join(' | ')}`);
});

test('chat store searches conversation public messages with scoped capped results', (t) => {
  const tempDir = withTempDir('caff-chat-search-store-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveCustomRoleConfig({
    id: 'search-agent',
    name: 'Search Agent',
    personaPrompt: 'Search carefully.',
  });
  const otherAgent = store.saveCustomRoleConfig({
    id: 'search-agent-other',
    name: 'Other Search Agent',
    personaPrompt: 'Search carefully too.',
  });

  const conversation = store.createConversation({
    id: 'search-conversation',
    title: 'Search Conversation',
    participants: [agent.id],
  });
  const otherConversation = store.createConversation({
    id: 'search-conversation-other',
    title: 'Other Conversation',
    participants: [agent.id],
  });

  store.createMessage({
    id: 'search-message-1',
    conversationId: conversation.id,
    turnId: 'search-turn-1',
    role: 'user',
    senderName: 'User',
    content: 'Hermes memory retrieval should be searchable.',
  });
  store.createMessage({
    id: 'search-message-2',
    conversationId: conversation.id,
    turnId: 'search-turn-2',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Hermes recall can stay retrieval-first.',
  });
  store.createMessage({
    id: 'search-message-3',
    conversationId: conversation.id,
    turnId: 'search-turn-3',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Thinking...',
    status: 'streaming',
  });
  store.createMessage({
    id: 'search-message-cjk',
    conversationId: conversation.id,
    turnId: 'search-turn-cjk',
    role: 'user',
    senderName: 'User',
    content: 'Hermes 是一个开源项目。',
  });
  store.createMessage({
    id: 'search-message-other-agent',
    conversationId: conversation.id,
    turnId: 'search-turn-other-agent',
    role: 'assistant',
    agentId: otherAgent.id,
    senderName: otherAgent.name,
    content: 'Hermes retrieval from another speaker must stay filterable.',
  });
  store.createMessage({
    id: 'search-message-other',
    conversationId: otherConversation.id,
    turnId: 'search-turn-other',
    role: 'user',
    senderName: 'Other User',
    content: 'Hermes appears here too but must stay scoped out.',
  });

  const result = store.searchConversationMessages(conversation.id, {
    query: 'Hermes',
    limit: 1,
  });

  assert.equal(result.scope, 'conversation-public');
  assert.equal(result.query, 'Hermes');
  assert.equal(result.resultCount, 1);
  assert.ok(result.searchMode === 'fts5' || result.searchMode === 'like');
  assert.equal(Array.isArray(result.diagnostics), true);
  assert.equal(result.results[0].conversationId, conversation.id);
  assert.equal(result.results[0].messageId === 'search-message-1' || result.results[0].messageId === 'search-message-2' || result.results[0].messageId === 'search-message-cjk', true);
  assert.match(result.results[0].snippet, /Hermes/u);
  assert.equal(result.results.some((entry) => entry.messageId === 'search-message-other'), false);
  assert.equal(result.results.some((entry) => entry.messageId === 'search-message-3'), false);

  const cjkResult = store.searchConversationMessages(conversation.id, {
    query: 'Hermes 开源项目',
    limit: 5,
  });

  assert.equal(cjkResult.scope, 'conversation-public');
  assert.equal(cjkResult.query, 'Hermes 开源项目');
  assert.equal(cjkResult.resultCount >= 1, true);
  assert.equal(cjkResult.results.some((entry) => entry.messageId === 'search-message-cjk'), true);
  assert.equal(cjkResult.results.some((entry) => entry.messageId === 'search-message-other'), false);
  assert.match(cjkResult.results[0].snippet, /Hermes|开源项目/u);
  if (cjkResult.searchMode === 'like') {
    assert.equal(cjkResult.diagnostics.some((entry) => entry && entry.code === 'fts5_no_match_fallback'), true);
  }

  const speakerResult = store.searchConversationMessages(conversation.id, {
    speaker: agent.name,
    limit: 5,
  });

  assert.equal(speakerResult.query, '');
  assert.equal(speakerResult.scope, 'conversation-public');
  assert.equal(speakerResult.filters.speaker, agent.name);
  assert.equal(speakerResult.searchMode, 'filtered');
  assert.equal(speakerResult.resultCount >= 1, true);
  assert.equal(speakerResult.results.every((entry) => entry.senderName === agent.name), true);
  assert.equal(speakerResult.results.some((entry) => entry.messageId === 'search-message-2'), true);
  assert.equal(speakerResult.results.some((entry) => entry.messageId === 'search-message-1'), false);
  assert.equal(speakerResult.results.some((entry) => entry.messageId === 'search-message-other-agent'), false);

  const filteredQueryResult = store.searchConversationMessages(conversation.id, {
    query: 'Hermes',
    speaker: otherAgent.name,
    limit: 5,
  });

  assert.equal(filteredQueryResult.filters.speaker, otherAgent.name);
  assert.equal(filteredQueryResult.resultCount, 1);
  assert.equal(filteredQueryResult.results[0].messageId, 'search-message-other-agent');
});

test('chat store saves conversation overlay memory cards with ttl and budget', (t) => {
  const tempDir = withTempDir('caff-chat-memory-store-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveCustomRoleConfig({
    id: 'memory-agent',
    name: 'Memory Agent',
    personaPrompt: 'Remember durable things only.',
  });
  const otherAgent = store.saveCustomRoleConfig({
    id: 'memory-agent-other',
    name: 'Other Memory Agent',
    personaPrompt: 'Do not leak memories.',
  });
  const conversation = store.createConversation({
    id: 'memory-conversation',
    title: 'Memory Conversation',
    participants: [agent.id, otherAgent.id],
  });

  const saved = store.saveConversationMemoryCard(conversation.id, agent.id, {
    title: 'preference',
    content: 'User prefers retrieval-first rollouts.',
    ttlDays: 14,
  });

  assert.equal(saved.card.scope, 'conversation-agent');
  assert.equal(saved.card.title, 'preference');
  assert.equal(saved.card.content, 'User prefers retrieval-first rollouts.');
  assert.equal(saved.card.ttlDays, 14);
  assert.equal(saved.cardCount, 1);
  assert.equal(saved.budget.maxCards, 6);

  const updated = store.saveConversationMemoryCard(conversation.id, agent.id, {
    title: 'preference',
    content: 'User prefers small safe rollouts.',
    ttlDays: 21,
  });

  assert.equal(updated.cardCount, 1);
  assert.equal(updated.card.content, 'User prefers small safe rollouts.');
  assert.equal(updated.card.ttlDays, 21);

  const visibleCards = store.listConversationMemoryCards(conversation.id, agent.id);
  const hiddenCards = store.listConversationMemoryCards(conversation.id, otherAgent.id);

  assert.equal(visibleCards.length, 1);
  assert.equal(visibleCards[0].title, 'preference');
  assert.equal(hiddenCards.length, 0);

  for (let index = 2; index <= 6; index += 1) {
    store.saveConversationMemoryCard(conversation.id, agent.id, {
      title: `card-${index}`,
      content: `Stable fact ${index}`,
      ttlDays: 7,
    });
  }

  assert.throws(
    () =>
      store.saveConversationMemoryCard(conversation.id, agent.id, {
        title: 'card-7',
        content: 'One card too many',
        ttlDays: 7,
      }),
    /Memory card budget exceeded/u
  );
});

test('chat store lists local-user durable memory cards across conversations with overlay precedence', (t) => {
  const tempDir = withTempDir('caff-chat-memory-durable-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveCustomRoleConfig({
    id: 'memory-durable-agent',
    name: 'Durable Agent',
    personaPrompt: 'Remember stable things across conversations.',
  });
  const otherAgent = store.saveCustomRoleConfig({
    id: 'memory-durable-other-agent',
    name: 'Other Durable Agent',
    personaPrompt: 'Do not read another agent memory.',
  });
  const conversationA = store.createConversation({
    id: 'memory-durable-conversation-a',
    title: 'Durable Memory A',
    participants: [agent.id, otherAgent.id],
  });
  const conversationB = store.createConversation({
    id: 'memory-durable-conversation-b',
    title: 'Durable Memory B',
    participants: [agent.id, otherAgent.id],
  });

  const durable = store.saveLocalUserMemoryCard(agent.id, {
    title: 'preference',
    content: 'User prefers cross-session durable memory.',
    ttlDays: 30,
  });

  assert.equal(durable.card.scope, 'local-user-agent');
  assert.equal(durable.card.conversationId, null);
  assert.equal(durable.card.ownerKey, 'local-user');
  assert.equal(durable.cardCount, 1);

  const visibleInB = store.listVisibleMemoryCards(conversationB.id, agent.id);
  assert.equal(visibleInB.length, 1);
  assert.equal(visibleInB[0].scope, 'local-user-agent');
  assert.equal(visibleInB[0].title, 'preference');

  const hiddenFromOtherAgent = store.listVisibleMemoryCards(conversationB.id, otherAgent.id);
  assert.equal(hiddenFromOtherAgent.length, 0);

  const overlay = store.saveConversationMemoryCard(conversationB.id, agent.id, {
    title: 'preference',
    content: 'Conversation-specific override wins first.',
    ttlDays: 7,
  });

  assert.equal(overlay.card.scope, 'conversation-agent');

  const merged = store.listVisibleMemoryCards(conversationB.id, agent.id);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].scope, 'conversation-agent');
  assert.equal(merged[0].content, 'Conversation-specific override wins first.');

  const localUserCards = store.listLocalUserMemoryCards(agent.id);
  assert.equal(localUserCards.length, 1);
  assert.equal(localUserCards[0].scope, 'local-user-agent');
  assert.equal(localUserCards[0].content, 'User prefers cross-session durable memory.');
});

test('chat store keeps case-distinct memory titles visible across overlay layering', (t) => {
  const tempDir = withTempDir('caff-chat-memory-case-visible-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveCustomRoleConfig({
    id: 'memory-case-visible-agent',
    name: 'Case Visible Agent',
    personaPrompt: 'Keep case-distinct memory titles separate.',
  });
  const conversation = store.createConversation({
    id: 'memory-case-visible-conversation',
    title: 'Case Visible Conversation',
    participants: [agent.id],
  });

  store.saveLocalUserMemoryCard(agent.id, {
    title: 'Preference',
    content: 'Durable uppercase preference.',
    ttlDays: 30,
  });
  store.saveConversationMemoryCard(conversation.id, agent.id, {
    title: 'preference',
    content: 'Conversation lowercase preference.',
    ttlDays: 7,
  });

  const visible = store.listVisibleMemoryCards(conversation.id, agent.id);
  assert.equal(visible.length, 2);
  assert.deepEqual(
    visible.map((card) => ({ title: card.title, scope: card.scope })),
    [
      { title: 'preference', scope: 'conversation-agent' },
      { title: 'Preference', scope: 'local-user-agent' },
    ]
  );
});

test('chat store updates and forgets durable memory cards with optimistic concurrency', async (t) => {
  const tempDir = withTempDir('caff-chat-memory-mutation-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveCustomRoleConfig({
    id: 'memory-mutation-agent',
    name: 'Mutation Agent',
    personaPrompt: 'Update durable memory carefully.',
  });
  const otherAgent = store.saveCustomRoleConfig({
    id: 'memory-mutation-other-agent',
    name: 'Other Mutation Agent',
    personaPrompt: 'Stay isolated.',
  });
  const conversation = store.createConversation({
    id: 'memory-mutation-conversation',
    title: 'Mutation Conversation',
    participants: [agent.id, otherAgent.id],
  });
  const otherConversation = store.createConversation({
    id: 'memory-mutation-conversation-other',
    title: 'Mutation Conversation Other',
    participants: [agent.id, otherAgent.id],
  });

  const saved = store.saveLocalUserMemoryCard(agent.id, {
    title: 'preference',
    content: 'User prefers retrieval-first rollouts.',
    ttlDays: 30,
  });

  await new Promise((resolve) => setTimeout(resolve, 5));

  const updated = store.updateLocalUserMemoryCard(agent.id, {
    title: 'preference',
    content: 'User now prefers answer-first replies.',
    expectedUpdatedAt: saved.card.updatedAt,
    lastMutation: {
      action: 'update',
      reasonTag: 'explicit-user-request',
      tool: 'test',
    },
  });

  assert.equal(updated.card.scope, 'local-user-agent');
  assert.equal(updated.card.content, 'User now prefers answer-first replies.');
  assert.equal(updated.card.status, 'active');
  assert.notEqual(updated.card.updatedAt, saved.card.updatedAt);

  const visibleInOtherConversation = store.listVisibleMemoryCards(otherConversation.id, agent.id);
  assert.equal(visibleInOtherConversation.length, 1);
  assert.equal(visibleInOtherConversation[0].content, 'User now prefers answer-first replies.');
  assert.equal(store.listVisibleMemoryCards(otherConversation.id, otherAgent.id).length, 0);

  assert.throws(
    () =>
      store.updateLocalUserMemoryCard(agent.id, {
        title: 'preference',
        content: 'Stale overwrite should fail.',
        expectedUpdatedAt: saved.card.updatedAt,
      }),
    /changed since it was last read/u
  );

  await new Promise((resolve) => setTimeout(resolve, 5));

  const forgotten = store.forgetLocalUserMemoryCard(agent.id, {
    title: 'preference',
    expectedUpdatedAt: updated.card.updatedAt,
    lastMutation: {
      action: 'forget',
      reasonTag: 'explicit-user-request',
      tool: 'test',
    },
  });

  assert.equal(forgotten.card.status, 'deleted');
  assert.equal(store.listVisibleMemoryCards(conversation.id, agent.id).length, 0);
  assert.equal(store.listVisibleMemoryCards(otherConversation.id, agent.id).length, 0);
  assert.throws(() => store.forgetLocalUserMemoryCard(agent.id, { title: 'preference' }), /Memory card not found/u);

  const revived = store.saveLocalUserMemoryCard(agent.id, {
    title: 'preference',
    content: 'User prefers concise answers.',
    ttlDays: 30,
  });

  assert.equal(revived.card.status, 'active');
  assert.equal(revived.card.content, 'User prefers concise answers.');
  assert.equal(revived.card.metadata.lastMutation, undefined);
});

test('chat store enforces memory card budget when reviving forgotten durable cards', (t) => {
  const tempDir = withTempDir('caff-chat-memory-revive-budget-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveCustomRoleConfig({
    id: 'memory-revive-budget-agent',
    name: 'Revive Budget Agent',
    personaPrompt: 'Respect memory budgets even when reviving forgotten cards.',
  });

  for (let index = 1; index <= 5; index += 1) {
    store.saveLocalUserMemoryCard(agent.id, {
      title: `card-${index}`,
      content: `Stable fact ${index}`,
      ttlDays: 30,
    });
  }

  store.saveLocalUserMemoryCard(agent.id, {
    title: 'revive-me',
    content: 'First version.',
    ttlDays: 30,
  });

  store.forgetLocalUserMemoryCard(agent.id, { title: 'revive-me' });

  store.saveLocalUserMemoryCard(agent.id, {
    title: 'card-6',
    content: 'Stable fact 6',
    ttlDays: 30,
  });

  assert.throws(
    () =>
      store.saveLocalUserMemoryCard(agent.id, {
        title: 'revive-me',
        content: 'Second version should respect budget.',
        ttlDays: 30,
      }),
    /Memory card budget exceeded/u
  );
});

test('chat store persists external channel bindings and idempotency records', (t) => {
  const tempDir = withTempDir('caff-chat-feishu-store-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  let store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    id: 'feishu-store-conversation',
    title: 'Feishu Store Conversation',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });
  const message = store.createMessage({
    id: 'feishu-store-message',
    conversationId: conversation.id,
    turnId: 'feishu-store-turn',
    role: 'user',
    senderName: 'FeishuUser:ou-store-user',
    content: 'hello store',
    metadata: { source: 'feishu' },
  });
  const binding = store.createConversationChannelBinding({
    platform: 'feishu',
    externalChatId: 'oc-store-chat-1',
    conversationId: conversation.id,
    metadata: { chatType: 'p2p' },
  });
  const nextConversation = store.createConversation({
    id: 'feishu-store-conversation-next',
    title: 'Feishu Store Conversation Next',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });
  const updatedBinding = store.updateConversationChannelBinding({
    platform: 'feishu',
    externalChatId: 'oc-store-chat-1',
    conversationId: nextConversation.id,
    metadata: { chatType: 'p2p', command: '/new' },
  });
  const reservedEvent = store.reserveExternalEvent({
    platform: 'feishu',
    direction: 'inbound',
    externalEventId: 'evt-store-1',
    externalMessageId: 'om-store-1',
    metadata: { status: 'reserved' },
  });
  const duplicateEvent = store.reserveExternalEvent({
    platform: 'feishu',
    direction: 'inbound',
    externalEventId: 'evt-store-1',
    externalMessageId: 'om-store-1',
    metadata: { status: 'duplicate' },
  });

  assert.ok(binding);
  assert.equal(updatedBinding.conversationId, nextConversation.id);
  assert.ok(reservedEvent);
  assert.equal(duplicateEvent, null);

  const updatedEvent = store.updateExternalEvent(reservedEvent.id, {
    conversationId: conversation.id,
    messageId: message.id,
    metadata: { status: 'processed' },
  });

  store.close();
  store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  const persistedBinding = store.getConversationChannelBinding('feishu', 'oc-store-chat-1');
  const persistedEvent = store.db.prepare('SELECT * FROM chat_external_events WHERE id = ?').get(updatedEvent.id);

  assert.equal(persistedBinding.conversationId, nextConversation.id);
  assert.deepEqual(persistedBinding.metadata, { chatType: 'p2p', command: '/new' });
  assert.equal(persistedEvent.platform, 'feishu');
  assert.equal(persistedEvent.external_event_id, 'evt-store-1');
  assert.equal(persistedEvent.external_message_id, 'om-store-1');
  assert.equal(persistedEvent.conversation_id, conversation.id);
  assert.equal(persistedEvent.message_id, message.id);
});

test('chat store indexes digest summary segments for cross-conversation search', (t) => {
  const tempDir = withTempDir('caff-chat-summary-segments-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    id: 'summary-source-conversation',
    title: 'BetterGI Deployment Notes',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });
  store.createConversation({
    id: 'summary-active-conversation',
    title: 'Active Conversation',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });

  const segment = store.saveSummarySegmentFromDigest(conversation.id, {
    id: 'digest-summary-segment-1',
    kind: 'entry',
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z',
    createdBy: 'model:deepseek/test',
    triggerReason: 'manual',
    messageRange: {
      fromMessageId: 'm1',
      toMessageId: 'm2',
      messageCount: 2,
    },
    summary: 'BetterGI one-dragon launch should use scheduled tasks and verify logs.',
    facts: ['Scheduled task avoids UAC bypass assumptions.'],
    decisions: ['Use log and process status checks after launch.'],
    openQuestions: [],
    nextActions: ['Document launch verification checklist.'],
    artifacts: ['.pi-sandbox/skills/bettergi-one-dragon/SKILL.md'],
  });

  assert.equal(segment.sourceDigestId, 'digest-summary-segment-1');
  assert.equal(segment.conversationTitle, 'BetterGI Deployment Notes');

  const searchResult = store.searchSummarySegments({
    query: 'BetterGI scheduled task logs',
    excludeConversationId: 'summary-active-conversation',
  });

  assert.equal(searchResult.scope, 'summary-segments');
  assert.equal(searchResult.resultCount, 1);
  assert.equal(searchResult.results[0].sourceDigestId, 'digest-summary-segment-1');
  assert.equal(searchResult.results[0].decisions[0], 'Use log and process status checks after launch.');

  const provenanceSearch = store.searchSummarySegments({
    query: 'manual deepseek',
    excludeConversationId: 'summary-active-conversation',
  });

  assert.equal(provenanceSearch.resultCount, 1);
  assert.equal(provenanceSearch.results[0].sourceDigestId, 'digest-summary-segment-1');
  assert.deepEqual(provenanceSearch.results[0].matchedTerms, ['manual', 'deepseek']);
});

test('chat store filters summary memory by task and source kind', (t) => {
  const tempDir = withTempDir('caff-chat-summary-segment-filters-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    id: 'summary-filter-conversation',
    title: 'Digest Filter Notes',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });
  const otherConversation = store.createConversation({
    id: 'summary-filter-other-conversation',
    title: 'Other Memory Notes',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });

  store.saveSummarySegmentFromDigest(conversation.id, {
    id: 'digest-filter-entry',
    kind: 'entry',
    summary: 'digest filter keyword detailed entry for the first task.',
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z',
  }, { taskName: 'digest-v1' });
  store.saveSummarySegmentFromDigest(conversation.id, {
    id: 'digest-filter-rollup',
    kind: 'rollup',
    summary: 'digest filter keyword compact rollup for the second task.',
    createdAt: '2026-05-04T00:01:00.000Z',
    updatedAt: '2026-05-04T00:01:00.000Z',
  }, { taskName: 'digest-v2' });
  store.saveSummarySegmentFromDigest(otherConversation.id, {
    id: 'digest-filter-other-rollup',
    kind: 'rollup',
    summary: 'digest filter keyword compact rollup for a similarly tagged conversation.',
    createdAt: '2026-05-04T00:02:00.000Z',
    updatedAt: '2026-05-04T00:02:00.000Z',
  }, { taskName: 'digest-v2' });
  store.saveSummarySegmentFromDigest(conversation.id, {
    id: 'digest-filter-rollup-newer-out-of-range',
    kind: 'rollup',
    summary: 'digest filter keyword compact rollup outside the selected date window.',
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
  }, { taskName: 'digest-v2' });

  const filtered = store.searchSummarySegments({
    query: 'digest filter keyword',
    taskName: 'digest-v2',
    sourceKind: 'rollup',
    conversationTitle: 'Digest Filter',
    updatedAfter: '2026-05-04T00:00:00.000Z',
    updatedBefore: '2026-05-04T23:59:59.999Z',
  });

  assert.deepEqual(filtered.filters, {
    taskName: 'digest-v2',
    sourceKind: 'rollup',
    conversationTitle: 'Digest Filter',
    updatedAfter: '2026-05-04T00:00:00.000Z',
    updatedBefore: '2026-05-04T23:59:59.999Z',
  });
  assert.equal(filtered.resultCount, 1);
  assert.equal(filtered.results[0].sourceDigestId, 'digest-filter-rollup');
});

test('chat store searches Chinese summary memory with word-segmented query terms', (t) => {
  const tempDir = withTempDir('caff-chat-summary-segment-cjk-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    id: 'summary-cjk-conversation',
    participants: TEST_CONVERSATION_PARTICIPANTS,
    title: '中文长期记忆复盘',
  });

  store.saveSummarySegmentFromDigest(conversation.id, {
    id: 'digest-cjk-memory',
    kind: 'entry',
    summary: '长期经验记忆层的回归验证需要覆盖召回测试。',
    facts: ['中文查询不应该被整句关键词卡住。'],
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z',
  }, { taskName: '跨会话长期经验记忆层' });

  const searchResult = store.searchSummarySegments({
    query: '长期记忆回归测试',
  });

  assert.equal(searchResult.resultCount, 1);
  assert.equal(searchResult.results[0].sourceDigestId, 'digest-cjk-memory');
  assert.deepEqual(searchResult.results[0].matchedTerms, ['长期', '记忆', '回归', '测试']);
});

test('chat store ranks summary memory by matched term coverage', (t) => {
  const tempDir = withTempDir('caff-chat-summary-segment-ranking-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    id: 'summary-ranking-conversation',
    title: 'Digest Ranking Notes',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });

  store.saveSummarySegmentFromDigest(conversation.id, {
    id: 'digest-ranking-partial-newer',
    kind: 'entry',
    summary: 'Digest tests use environment overrides for auto-create settings.',
    createdAt: '2026-05-04T00:02:00.000Z',
    updatedAt: '2026-05-04T00:02:00.000Z',
  });
  store.saveSummarySegmentFromDigest(conversation.id, {
    id: 'digest-ranking-full-older',
    kind: 'entry',
    summary: 'Digest environment variable tests should pin idle and cooldown gates.',
    facts: ['Idle and cooldown env settings can block automatic summaries.'],
    createdAt: '2026-05-04T00:01:00.000Z',
    updatedAt: '2026-05-04T00:01:00.000Z',
  });

  const searchResult = store.searchSummarySegments({
    query: 'digest environment cooldown',
    limit: 2,
  });

  assert.equal(searchResult.searchMode, 'like_scored_or');
  assert.equal(searchResult.resultCount, 2);
  assert.equal(searchResult.results[0].sourceDigestId, 'digest-ranking-full-older');
  assert.equal(searchResult.results[0].score, 3);
  assert.deepEqual(searchResult.results[0].matchedTerms, ['digest', 'environment', 'cooldown']);
  assert.equal(searchResult.results[1].sourceDigestId, 'digest-ranking-partial-newer');
  assert.equal(searchResult.results[1].score, 2);
  assert.deepEqual(searchResult.results[1].matchedTerms, ['digest', 'environment']);
});

test('chat store returns enough summary memory candidates for automatic recall diversity', (t) => {
  const tempDir = withTempDir('caff-chat-summary-segment-candidate-limit-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    id: 'summary-candidate-limit-conversation',
    title: 'Digest Candidate Notes',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });

  for (let index = 0; index < 16; index += 1) {
    const minute = String(index).padStart(2, '0');

    store.saveSummarySegmentFromDigest(conversation.id, {
      id: `digest-candidate-limit-${index}`,
      kind: 'entry',
      summary: `candidate budget digest memory ${index}`,
      createdAt: `2026-05-04T00:${minute}:00.000Z`,
      updatedAt: `2026-05-04T00:${minute}:00.000Z`,
    });
  }

  const searchResult = store.searchSummarySegments({
    query: 'candidate budget digest memory',
    limit: 15,
  });

  assert.equal(searchResult.resultCount, 15);
  assert.equal(searchResult.results[0].sourceDigestId, 'digest-candidate-limit-15');
  assert.equal(searchResult.results[14].sourceDigestId, 'digest-candidate-limit-1');
});

test('chat store rejects missing, empty, unknown, duplicate, and invalid-profile participant rosters before writing', (t) => {
  const tempDir = withTempDir('caff-chat-explicit-participants-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const role = store.saveCustomRoleConfig({
    id: 'explicit-participant-role',
    name: 'Explicit Participant Role',
    personaPrompt: 'Use only explicitly confirmed conversation rosters.',
    modelProfiles: [{ id: 'fast', name: 'Fast', model: 'test-model' }],
  });
  const assertRosterError = (create, code) => {
    assert.throws(create, (error) => {
      assert.equal(error.code, code);
      assert.equal(error.issues[0].code, code);
      return true;
    });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM chat_conversations').get().count, 0);
  };

  assertRosterError(
    () => store.createConversation({ id: 'missing-roster' }),
    'participants_required'
  );
  assertRosterError(
    () => store.createConversation({ id: 'empty-roster', participants: [] }),
    'participants_required'
  );
  assertRosterError(
    () => store.createConversation({
      id: 'unknown-roster',
      participants: [{ agentId: 'missing-role' }],
    }),
    'participant_role_unknown'
  );
  assertRosterError(
    () => store.createConversation({
      id: 'duplicate-roster',
      participants: [{ agentId: role.id }, { agentId: role.id }],
    }),
    'participant_duplicate'
  );
  assertRosterError(
    () => store.createConversation({
      id: 'invalid-profile-roster',
      participants: [{ agentId: role.id, modelProfileId: 'missing-profile' }],
    }),
    'participant_profile_invalid'
  );
  assertRosterError(
    () => store.getOrCreateExternalConversation({
      platform: 'feishu',
      externalChatId: 'oc-explicit-participants',
      participants: [],
    }),
    'participants_required'
  );

  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM chat_channel_bindings').get().count, 0);
});

test('listConversationIdsWithPendingUserMessages returns only conversations whose trailing message is a non-side user message', (t) => {
  const tempDir = withTempDir('caff-pending-user-messages-');
  const sqlitePath = path.join(tempDir, 'pending-user-messages.sqlite');
  let store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const mainPending = store.createConversation({
    id: 'pending-main-trailing',
    title: 'Main pending trailing',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });
  store.createMessage({
    id: 'pending-main-message',
    conversationId: mainPending.id,
    turnId: 'pending-main-turn',
    role: 'user',
    agentId: null,
    senderName: 'User',
    content: 'Trailing user message',
    createdAt: '2026-08-14T00:00:00.000Z',
  });

  const sideOnly = store.createConversation({
    id: 'pending-side-only',
    title: 'Side dispatch only',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });
  store.createMessage({
    id: 'pending-side-message',
    conversationId: sideOnly.id,
    turnId: 'pending-side-turn',
    role: 'user',
    agentId: null,
    senderName: 'User',
    content: 'Side dispatch user message',
    metadata: { dispatchLane: 'side' },
    createdAt: '2026-08-14T00:00:01.000Z',
  });

  const completed = store.createConversation({
    id: 'pending-completed',
    title: 'Completed user assistant',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });
  store.createMessage({
    id: 'pending-completed-user',
    conversationId: completed.id,
    turnId: 'pending-completed-turn',
    role: 'user',
    agentId: null,
    senderName: 'User',
    content: 'Consumed user message',
    createdAt: '2026-08-14T00:00:02.000Z',
  });
  store.createMessage({
    id: 'pending-completed-assistant',
    conversationId: completed.id,
    turnId: 'pending-completed-turn',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'Assistant',
    content: 'Consumed assistant reply',
    createdAt: '2026-08-14T00:00:03.000Z',
  });

  const result = store.listConversationIdsWithPendingUserMessages();

  assert.deepEqual(result, [mainPending.id]);
});
