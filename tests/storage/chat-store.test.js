const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

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

  const agent = store.saveAgent({
    id: 'search-agent',
    name: 'Search Agent',
    personaPrompt: 'Search carefully.',
  });
  const otherAgent = store.saveAgent({
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

  const agent = store.saveAgent({
    id: 'memory-agent',
    name: 'Memory Agent',
    personaPrompt: 'Remember durable things only.',
  });
  const otherAgent = store.saveAgent({
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

  const agent = store.saveAgent({
    id: 'memory-durable-agent',
    name: 'Durable Agent',
    personaPrompt: 'Remember stable things across conversations.',
  });
  const otherAgent = store.saveAgent({
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

  const agent = store.saveAgent({
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

  const agent = store.saveAgent({
    id: 'memory-mutation-agent',
    name: 'Mutation Agent',
    personaPrompt: 'Update durable memory carefully.',
  });
  const otherAgent = store.saveAgent({
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

  const agent = store.saveAgent({
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
