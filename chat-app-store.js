const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { resolveSqlitePath } = require('./sqlite-store');

const MAX_AVATAR_DATA_URL_LENGTH = 2 * 1024 * 1024;

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

function normalizeAvatarDataUrl(value) {
  const avatarDataUrl = String(value || '').trim();

  if (!avatarDataUrl) {
    return '';
  }

  if (avatarDataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
    throw new Error('Agent avatar is too large');
  }

  if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(avatarDataUrl)) {
    throw new Error('Agent avatar must be a PNG, JPEG, WEBP, or GIF image');
  }

  return avatarDataUrl;
}

function normalizeModelProfile(profile, index = 0) {
  if (!profile || typeof profile !== 'object') {
    return null;
  }

  const model = String(profile.model || '').trim();
  const provider = String(profile.provider || '').trim();
  const thinking = String(profile.thinking || '').trim();
  const personaPrompt = String(profile.personaPrompt || '').trim();
  const description = String(profile.description || '').trim();
  const name = String(profile.name || '').trim();
  const id = String(profile.id || `profile-${index + 1}`).trim() || `profile-${index + 1}`;

  if (!name && !model && !provider && !thinking && !personaPrompt && !description) {
    return null;
  }

  return {
    id,
    name: name || model || `Profile ${index + 1}`,
    description,
    provider,
    model,
    thinking,
    personaPrompt,
  };
}

function parseModelProfiles(value) {
  const parsed = parseJson(value);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((profile, index) => normalizeModelProfile(profile, index))
    .filter(Boolean);
}

function findModelProfile(modelProfiles, profileId) {
  if (!profileId) {
    return null;
  }

  return (Array.isArray(modelProfiles) ? modelProfiles : []).find((profile) => profile.id === profileId) || null;
}

function normalizeAgentRow(row) {
  if (!row) {
    return null;
  }

  const modelProfiles = parseModelProfiles(row.model_profiles_json);
  const selectedModelProfileId = row.selected_model_profile_id ? String(row.selected_model_profile_id).trim() : null;
  const selectedModelProfile = findModelProfile(modelProfiles, selectedModelProfileId);
  const normalized = {
    id: row.id,
    name: row.name,
    description: row.description || '',
    avatarDataUrl: row.avatar_data_url || '',
    personaPrompt: row.persona_prompt || '',
    provider: row.provider || '',
    model: row.model || '',
    thinking: row.thinking || '',
    accentColor: row.accent_color || '#3d405b',
    modelProfiles,
    selectedModelProfileId: selectedModelProfile ? selectedModelProfile.id : null,
    selectedModelProfile,
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

function pickDefaultParticipants(agents, requestedParticipants) {
  if (Array.isArray(requestedParticipants) && requestedParticipants.length > 0) {
    return requestedParticipants;
  }

  return agents.slice(0, 3).map((agent) => ({
    agentId: agent.id,
    modelProfileId: null,
  }));
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
  avatar_data_url TEXT,
  persona_prompt TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  accent_color TEXT,
  model_profiles_json TEXT,
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
  model_profile_id TEXT,
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

    const chatAgentColumns = new Set(
      this.db.prepare('PRAGMA table_info(chat_agents)').all().map((column) => column.name)
    );
    const conversationAgentColumns = new Set(
      this.db.prepare('PRAGMA table_info(chat_conversation_agents)').all().map((column) => column.name)
    );

    if (!chatAgentColumns.has('model_profiles_json')) {
      this.db.exec('ALTER TABLE chat_agents ADD COLUMN model_profiles_json TEXT');
    }

    if (!chatAgentColumns.has('avatar_data_url')) {
      this.db.exec('ALTER TABLE chat_agents ADD COLUMN avatar_data_url TEXT');
    }

    if (!conversationAgentColumns.has('model_profile_id')) {
      this.db.exec('ALTER TABLE chat_conversation_agents ADD COLUMN model_profile_id TEXT');
    }

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
        avatar_data_url,
        persona_prompt,
        provider,
        model,
        thinking,
        accent_color,
        model_profiles_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateAgentStatement = this.db.prepare(`
      UPDATE chat_agents
      SET
        name = ?,
        description = ?,
        avatar_data_url = ?,
        persona_prompt = ?,
        provider = ?,
        model = ?,
        thinking = ?,
        accent_color = ?,
        model_profiles_json = ?,
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
        model_profile_id,
        sort_order,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.listConversationAgentsStatement = this.db.prepare(`
      SELECT a.*, ca.sort_order, ca.model_profile_id AS selected_model_profile_id
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
          payload.avatarDataUrl,
          payload.personaPrompt,
          payload.provider,
          payload.model,
          payload.thinking,
          payload.accentColor,
          serializeJson(payload.modelProfiles),
          timestamp,
          payload.id
        );
      } else {
        this.insertAgentStatement.run(
          payload.id,
          payload.name,
          payload.description,
          payload.avatarDataUrl,
          payload.personaPrompt,
          payload.provider,
          payload.model,
          payload.thinking,
          payload.accentColor,
          serializeJson(payload.modelProfiles),
          timestamp,
          timestamp
        );
      }

      return this.getAgent(payload.id);
    });

    this.replaceConversationAgentsTransaction = this.db.transaction((conversationId, participants) => {
      this.deleteConversationAgentsStatement.run(conversationId);

      participants.forEach((participant, index) => {
        this.insertConversationAgentStatement.run(
          conversationId,
          participant.agentId,
          participant.modelProfileId || null,
          index,
          nowIso()
        );
      });
    });

    this.createConversationTransaction = this.db.transaction((payload) => {
      const timestamp = nowIso();

      this.insertConversationStatement.run(payload.id, payload.title, timestamp, timestamp, null);
      this.replaceConversationAgentsTransaction(payload.id, payload.participants);

      return this.getConversation(payload.id);
    });

    this.updateConversationTransaction = this.db.transaction((conversationId, updates) => {
      if (updates.title !== undefined) {
        this.updateConversationStatement.run(updates.title, nowIso(), conversationId);
      } else {
        this.touchConversationStatement.run(nowIso(), null, conversationId);
      }

      if (Array.isArray(updates.participants)) {
        this.replaceConversationAgentsTransaction(conversationId, updates.participants);
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
      avatarDataUrl: normalizeAvatarDataUrl(input.avatarDataUrl),
      personaPrompt,
      provider: String(input.provider || '').trim(),
      model: String(input.model || '').trim(),
      thinking: String(input.thinking || '').trim(),
      accentColor: String(input.accentColor || '#3d405b').trim() || '#3d405b',
      modelProfiles: this.normalizeModelProfiles(input.modelProfiles),
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
    const participants = this.normalizeConversationParticipantsInput(input);

    return this.createConversationTransaction({
      id,
      title,
      participants: pickDefaultParticipants(this.listAgents(), participants),
    });
  }

  updateConversation(conversationId, updates = {}) {
    const existing = this.getConversation(conversationId);

    if (!existing) {
      return null;
    }

    const title = updates.title === undefined ? existing.title : String(updates.title || '').trim() || existing.title;
    const participants = this.hasConversationParticipantsInput(updates)
      ? this.normalizeConversationParticipantsInput(updates)
      : undefined;

    return this.updateConversationTransaction(conversationId, {
      title,
      participants,
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
      participants: agents.slice(0, 3).map((agent) => ({
        agentId: agent.id,
        modelProfileId: null,
      })),
    });
  }

  normalizeModelProfiles(modelProfiles) {
    const seenIds = new Set();
    const normalized = [];

    for (const [index, profile] of Array.isArray(modelProfiles) ? modelProfiles.entries() : []) {
      const nextProfile = normalizeModelProfile(profile, index);

      if (!nextProfile || seenIds.has(nextProfile.id)) {
        continue;
      }

      seenIds.add(nextProfile.id);
      normalized.push(nextProfile);
    }

    return normalized;
  }

  hasConversationParticipantsInput(input = {}) {
    return Array.isArray(input.participants) || Array.isArray(input.agentIds);
  }

  normalizeConversationParticipantsInput(input = {}) {
    if (Array.isArray(input.participants)) {
      return this.normalizeConversationParticipants(input.participants);
    }

    const agentProfileIds =
      input.agentProfileIds && typeof input.agentProfileIds === 'object' ? input.agentProfileIds : {};
    const legacyParticipants = Array.isArray(input.agentIds)
      ? input.agentIds.map((agentId) => ({
          agentId,
          modelProfileId: agentProfileIds[agentId] || null,
        }))
      : [];

    return this.normalizeConversationParticipants(legacyParticipants);
  }

  normalizeConversationParticipants(participants) {
    const knownAgents = new Map(this.listAgents().map((agent) => [agent.id, agent]));
    const deduped = [];
    const seenAgentIds = new Set();

    for (const participant of Array.isArray(participants) ? participants : []) {
      const agentId =
        typeof participant === 'string'
          ? String(participant || '').trim()
          : String((participant && (participant.agentId || participant.id)) || '').trim();

      if (!agentId || seenAgentIds.has(agentId) || !knownAgents.has(agentId)) {
        continue;
      }

      const agent = knownAgents.get(agentId);
      const requestedProfileId =
        typeof participant === 'string'
          ? ''
          : String(
              (participant && (participant.modelProfileId || participant.selectedModelProfileId || '')) || ''
            ).trim();
      const modelProfileId = findModelProfile(agent.modelProfiles, requestedProfileId) ? requestedProfileId : null;

      seenAgentIds.add(agentId);
      deduped.push({
        agentId,
        modelProfileId,
      });
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
