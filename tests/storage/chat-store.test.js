const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');
const { createChatAppStore } = require('../../lib/chat-app-store');

function listColumnNames(db, tableName) {
  return new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => String(column.name))
  );
}

function withTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

  store.close();

  migratedDb = new Database(sqlitePath, { readonly: true });

  const agentColumns = listColumnNames(migratedDb, 'chat_agents');
  const conversationColumns = listColumnNames(migratedDb, 'chat_conversations');
  const participantColumns = listColumnNames(migratedDb, 'chat_conversation_agents');

  assert.equal(agentColumns.has('sandbox_name'), true);
  assert.equal(agentColumns.has('skills_json'), true);
  assert.equal(agentColumns.has('model_profiles_json'), true);
  assert.equal(conversationColumns.has('type'), true);
  assert.equal(conversationColumns.has('metadata_json'), true);
  assert.equal(participantColumns.has('model_profile_id'), true);
  assert.equal(participantColumns.has('conversation_skills_json'), true);
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

  const agent = store.saveAgent({
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
