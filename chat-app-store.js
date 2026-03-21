const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { resolveSqlitePath } = require('./sqlite-store');

const DEFAULT_AGENT_SEEDS = [
  {
    id: 'agent-strategist',
    name: 'Strategist',
    description: 'Frames goals, clarifies scope, and keeps the discussion outcome-focused.',
    personaPrompt: [
      'You are Strategist, a calm planning-oriented AI collaborator.',
      'Lead with structure, priorities, risks, and tradeoffs.',
      'Respond in the user language when it is obvious.',
      'Do not speak for other agents.',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#ef7d57',
  },
  {
    id: 'agent-builder',
    name: 'Builder',
    description: 'Turns ideas into concrete implementation steps and working decisions.',
    personaPrompt: [
      'You are Builder, a direct implementation-focused AI collaborator.',
      'Prefer practical solutions, examples, and next actions.',
      'Respond in the user language when it is obvious.',
      'Do not speak for other agents.',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#2a9d8f',
  },
  {
    id: 'agent-critic',
    name: 'Critic',
    description: 'Challenges assumptions, spots risks, and proposes safer alternatives.',
    personaPrompt: [
      'You are Critic, a careful review-oriented AI collaborator.',
      'Look for weak assumptions, edge cases, missing tests, and failure modes.',
      'Respond in the user language when it is obvious.',
      'Do not speak for other agents.',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#3d405b',
  },
];

function nowIso() {
  return new Date().toISOString();
}

function serializeJson(value) {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value === undefined ? null : value);
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeAgentRow(row) {
  if (!row) {
    return null;
  }

  const normalized = {
    id: row.id,
    name: row.name,
    description: row.description || '',
    personaPrompt: row.persona_prompt || '',
    provider: row.provider || '',
    model: row.model || '',
    thinking: row.thinking || '',
    accentColor: row.accent_color || '#3d405b',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.sort_order !== undefined) {
    normalized.sortOrder = Number(row.sort_order || 0);
  }

  return normalized;
}

function normalizeMessageRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    role: row.role,
    agentId: row.agent_id || null,
    senderName: row.sender_name,
    content: row.content,
    status: row.status,
    taskId: row.task_id || null,
    runId: typeof row.run_id === 'number' ? row.run_id : row.run_id ? Number(row.run_id) : null,
    errorMessage: row.error_message || '',
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function normalizeConversationHeader(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at || null,
    messageCount: Number(row.message_count || 0),
    agentCount: Number(row.agent_count || 0),
    lastMessagePreview: row.last_message_preview || '',
  };
}

function normalizeConversation(row, agents, messages) {
  const header = normalizeConversationHeader(row);

  if (!header) {
    return null;
  }

  return {
    ...header,
    agents,
    messages,
  };
}

function pickDefaultAgentIds(agents, requestedIds) {
  if (Array.isArray(requestedIds) && requestedIds.length > 0) {
    return requestedIds;
  }

  return agents.slice(0, 3).map((agent) => agent.id);
}

class ChatAppStore {
  constructor({ agentDir, sqlitePath }) {
    this.agentDir = path.resolve(agentDir);
    this.databasePath = resolveSqlitePath(this.agentDir, sqlitePath);

    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });

    this.db = new Database(this.databasePath, { timeout: 5000 });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
CREATE TABLE IF NOT EXISTS chat_agents (
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

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_conversation_agents (
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, agent_id),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES chat_agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_messages (
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

CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated_at ON chat_conversations (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_last_message_at ON chat_conversations (last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversation_agents_agent_id ON chat_conversation_agents (agent_id, sort_order ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages (conversation_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_turn_id ON chat_messages (turn_id, created_at ASC, id ASC);
    `);

    this.countAgentsStatement = this.db.prepare('SELECT COUNT(*) AS count FROM chat_agents');
    this.listAgentsStatement = this.db.prepare(`
      SELECT *
      FROM chat_agents
      ORDER BY created_at ASC, id ASC
    `);
    this.getAgentStatement = this.db.prepare(`
      SELECT *
      FROM chat_agents
      WHERE id = ?
      LIMIT 1
    `);
    this.insertAgentStatement = this.db.prepare(`
      INSERT INTO chat_agents (
        id,
        name,
        description,
        persona_prompt,
        provider,
        model,
        thinking,
        accent_color,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateAgentStatement = this.db.prepare(`
      UPDATE chat_agents
      SET
        name = ?,
        description = ?,
        persona_prompt = ?,
        provider = ?,
        model = ?,
        thinking = ?,
        accent_color = ?,
        updated_at = ?
      WHERE id = ?
    `);
    this.deleteAgentStatement = this.db.prepare('DELETE FROM chat_agents WHERE id = ?');

    this.listConversationHeadersStatement = this.db.prepare(`
      SELECT
        c.*,
        (
          SELECT COUNT(*)
          FROM chat_messages m
          WHERE m.conversation_id = c.id
        ) AS message_count,
        (
          SELECT COUNT(*)
          FROM chat_conversation_agents ca
          WHERE ca.conversation_id = c.id
        ) AS agent_count,
        (
          SELECT m.content
          FROM chat_messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ) AS last_message_preview
      FROM chat_conversations c
      ORDER BY COALESCE(c.last_message_at, c.updated_at, c.created_at) DESC, c.id DESC
    `);
    this.getConversationStatement = this.db.prepare(`
      SELECT
        c.*,
        (
          SELECT COUNT(*)
          FROM chat_messages m
          WHERE m.conversation_id = c.id
        ) AS message_count,
        (
          SELECT COUNT(*)
          FROM chat_conversation_agents ca
          WHERE ca.conversation_id = c.id
        ) AS agent_count,
        (
          SELECT m.content
          FROM chat_messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ) AS last_message_preview
      FROM chat_conversations c
      WHERE c.id = ?
      LIMIT 1
    `);
    this.insertConversationStatement = this.db.prepare(`
      INSERT INTO chat_conversations (
        id,
        title,
        created_at,
        updated_at,
        last_message_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.updateConversationStatement = this.db.prepare(`
      UPDATE chat_conversations
      SET
        title = ?,
        updated_at = ?
      WHERE id = ?
    `);
    this.touchConversationStatement = this.db.prepare(`
      UPDATE chat_conversations
      SET
        updated_at = ?,
        last_message_at = COALESCE(?, last_message_at)
      WHERE id = ?
    `);
    this.deleteConversationStatement = this.db.prepare('DELETE FROM chat_conversations WHERE id = ?');

    this.deleteConversationAgentsStatement = this.db.prepare(`
      DELETE FROM chat_conversation_agents
      WHERE conversation_id = ?
    `);
    this.insertConversationAgentStatement = this.db.prepare(`
      INSERT INTO chat_conversation_agents (
        conversation_id,
        agent_id,
        sort_order,
        created_at
      ) VALUES (?, ?, ?, ?)
    `);
    this.listConversationAgentsStatement = this.db.prepare(`
      SELECT a.*, ca.sort_order
      FROM chat_conversation_agents ca
      JOIN chat_agents a ON a.id = ca.agent_id
      WHERE ca.conversation_id = ?
      ORDER BY ca.sort_order ASC, ca.created_at ASC, a.created_at ASC
    `);

    this.insertMessageStatement = this.db.prepare(`
      INSERT INTO chat_messages (
        id,
        conversation_id,
        turn_id,
        role,
        agent_id,
        sender_name,
        content,
        status,
        task_id,
        run_id,
        error_message,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.listMessagesStatement = this.db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `);
    this.updateMessageStatement = this.db.prepare(`
      UPDATE chat_messages
      SET
        content = ?,
        status = ?,
        task_id = ?,
        run_id = ?,
        error_message = ?,
        metadata_json = ?
      WHERE id = ?
    `);
    this.appendMessageTextStatement = this.db.prepare(`
      UPDATE chat_messages
      SET content = COALESCE(content, '') || ?
      WHERE id = ?
    `);

    this.saveAgentTransaction = this.db.transaction((payload) => {
      const timestamp = nowIso();
      const existing = this.getAgentStatement.get(payload.id);

      if (existing) {
        this.updateAgentStatement.run(
          payload.name,
          payload.description,
          payload.personaPrompt,
          payload.provider,
          payload.model,
          payload.thinking,
          payload.accentColor,
          timestamp,
          payload.id
        );
      } else {
        this.insertAgentStatement.run(
          payload.id,
          payload.name,
          payload.description,
          payload.personaPrompt,
          payload.provider,
          payload.model,
          payload.thinking,
          payload.accentColor,
          timestamp,
          timestamp
        );
      }

      return this.getAgent(payload.id);
    });

    this.replaceConversationAgentsTransaction = this.db.transaction((conversationId, agentIds) => {
      this.deleteConversationAgentsStatement.run(conversationId);

      agentIds.forEach((agentId, index) => {
        this.insertConversationAgentStatement.run(conversationId, agentId, index, nowIso());
      });
    });

    this.createConversationTransaction = this.db.transaction((payload) => {
      const timestamp = nowIso();

      this.insertConversationStatement.run(payload.id, payload.title, timestamp, timestamp, null);
      this.replaceConversationAgentsTransaction(payload.id, payload.agentIds);

      return this.getConversation(payload.id);
    });

    this.updateConversationTransaction = this.db.transaction((conversationId, updates) => {
      if (updates.title !== undefined) {
        this.updateConversationStatement.run(updates.title, nowIso(), conversationId);
      } else {
        this.touchConversationStatement.run(nowIso(), null, conversationId);
      }

      if (Array.isArray(updates.agentIds)) {
        this.replaceConversationAgentsTransaction(conversationId, updates.agentIds);
      }

      return this.getConversation(conversationId);
    });

    this.createMessageTransaction = this.db.transaction((payload) => {
      const createdAt = payload.createdAt || nowIso();

      this.insertMessageStatement.run(
        payload.id,
        payload.conversationId,
        payload.turnId,
        payload.role,
        payload.agentId || null,
        payload.senderName,
        payload.content || '',
        payload.status || 'completed',
        payload.taskId || null,
        payload.runId || null,
        payload.errorMessage || null,
        serializeJson(payload.metadata),
        createdAt
      );
      this.touchConversationStatement.run(createdAt, createdAt, payload.conversationId);

      return this.getMessage(payload.id);
    });

    this.seedDefaultAgents();
  }

  seedDefaultAgents() {
    const row = this.countAgentsStatement.get();

    if (row && Number(row.count || 0) > 0) {
      return;
    }

    for (const seed of DEFAULT_AGENT_SEEDS) {
      this.saveAgent(seed);
    }
  }

  getAgent(agentId) {
    return normalizeAgentRow(this.getAgentStatement.get(agentId));
  }

  listAgents() {
    return this.listAgentsStatement.all().map(normalizeAgentRow);
  }

  saveAgent(input = {}) {
    const id = String(input.id || randomUUID()).trim();
    const name = String(input.name || '').trim();
    const personaPrompt = String(input.personaPrompt || '').trim();

    if (!name) {
      throw new Error('Agent name is required');
    }

    if (!personaPrompt) {
      throw new Error('Agent personaPrompt is required');
    }

    return this.saveAgentTransaction({
      id,
      name,
      description: String(input.description || '').trim(),
      personaPrompt,
      provider: String(input.provider || '').trim(),
      model: String(input.model || '').trim(),
      thinking: String(input.thinking || '').trim(),
      accentColor: String(input.accentColor || '#3d405b').trim() || '#3d405b',
    });
  }

  deleteAgent(agentId) {
    this.deleteAgentStatement.run(agentId);
  }

  listConversations() {
    return this.listConversationHeadersStatement.all().map(normalizeConversationHeader);
  }

  getConversation(conversationId) {
    const row = this.getConversationStatement.get(conversationId);

    if (!row) {
      return null;
    }

    return normalizeConversation(
      row,
      this.listConversationAgents(conversationId),
      this.listMessages(conversationId)
    );
  }

  createConversation(input = {}) {
    const id = String(input.id || randomUUID()).trim();
    const title = String(input.title || '').trim() || 'New Conversation';
    const agentIds = this.normalizeAgentIds(input.agentIds);

    return this.createConversationTransaction({
      id,
      title,
      agentIds: pickDefaultAgentIds(this.listAgents(), agentIds),
    });
  }

  updateConversation(conversationId, updates = {}) {
    const existing = this.getConversation(conversationId);

    if (!existing) {
      return null;
    }

    const title = updates.title === undefined ? existing.title : String(updates.title || '').trim() || existing.title;
    const agentIds = Array.isArray(updates.agentIds) ? this.normalizeAgentIds(updates.agentIds) : undefined;

    return this.updateConversationTransaction(conversationId, {
      title,
      agentIds,
    });
  }

  deleteConversation(conversationId) {
    this.deleteConversationStatement.run(conversationId);
  }

  listConversationAgents(conversationId) {
    return this.listConversationAgentsStatement.all(conversationId).map(normalizeAgentRow);
  }

  listMessages(conversationId) {
    return this.listMessagesStatement.all(conversationId).map(normalizeMessageRow);
  }

  getMessage(messageId) {
    const row = this.db
      .prepare(`
        SELECT *
        FROM chat_messages
        WHERE id = ?
        LIMIT 1
      `)
      .get(messageId);

    return normalizeMessageRow(row);
  }

  createMessage(payload = {}) {
    const conversation = this.getConversation(payload.conversationId);

    if (!conversation) {
      throw new Error('Conversation not found');
    }

    const senderName =
      String(payload.senderName || '').trim() ||
      (payload.role === 'user' ? 'You' : payload.role === 'assistant' ? 'Assistant' : 'System');

    return this.createMessageTransaction({
      id: String(payload.id || randomUUID()).trim(),
      conversationId: payload.conversationId,
      turnId: String(payload.turnId || randomUUID()).trim(),
      role: String(payload.role || 'assistant').trim(),
      agentId: payload.agentId || null,
      senderName,
      content: String(payload.content || ''),
      status: String(payload.status || 'completed').trim() || 'completed',
      taskId: payload.taskId || null,
      runId: payload.runId || null,
      errorMessage: String(payload.errorMessage || '').trim(),
      metadata: payload.metadata,
      createdAt: payload.createdAt,
    });
  }

  updateMessage(messageId, updates = {}) {
    const existing = this.getMessage(messageId);

    if (!existing) {
      return null;
    }

    const nextContent =
      updates.content === undefined ? existing.content : String(updates.content || '');
    const nextStatus =
      updates.status === undefined ? existing.status : String(updates.status || '').trim() || existing.status;
    const nextTaskId = updates.taskId === undefined ? existing.taskId : updates.taskId || null;
    const nextRunId = updates.runId === undefined ? existing.runId : updates.runId || null;
    const nextErrorMessage =
      updates.errorMessage === undefined ? existing.errorMessage : String(updates.errorMessage || '').trim();
    const nextMetadata = updates.metadata === undefined ? existing.metadata : updates.metadata;

    this.updateMessageStatement.run(
      nextContent,
      nextStatus,
      nextTaskId,
      nextRunId,
      nextErrorMessage || null,
      serializeJson(nextMetadata),
      messageId
    );

    return this.getMessage(messageId);
  }

  appendMessageText(messageId, delta) {
    const text = String(delta || '');

    if (!text) {
      return this.getMessage(messageId);
    }

    this.appendMessageTextStatement.run(text, messageId);
    return this.getMessage(messageId);
  }

  ensureStarterConversation() {
    const conversations = this.listConversations();

    if (conversations.length > 0) {
      return conversations[0];
    }

    const agents = this.listAgents();
    return this.createConversation({
      title: '新协作会话',
      agentIds: agents.slice(0, 3).map((agent) => agent.id),
    });
  }

  normalizeAgentIds(agentIds) {
    const knownAgents = new Set(this.listAgents().map((agent) => agent.id));
    const deduped = [];

    for (const agentId of Array.isArray(agentIds) ? agentIds : []) {
      const value = String(agentId || '').trim();

      if (!value || deduped.includes(value) || !knownAgents.has(value)) {
        continue;
      }

      deduped.push(value);
    }

    return deduped;
  }

  close() {
    this.db.close();
  }
}

function createChatAppStore(options) {
  return new ChatAppStore(options);
}

module.exports = {
  ChatAppStore,
  DEFAULT_AGENT_SEEDS,
  createChatAppStore,
};
