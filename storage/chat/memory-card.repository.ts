const DEFAULT_LOCAL_USER_OWNER_KEY = 'local-user';
const CONVERSATION_MEMORY_SCOPE = 'conversation-agent';
const LOCAL_USER_MEMORY_SCOPE = 'local-user-agent';

export class ChatMemoryCardRepository {
  insertStatement: any;
  updateStatement: any;
  getStatement: any;
  getByScopeOwnerAgentTitleStatement: any;
  listActiveByScopeOwnerAgentStatement: any;
  countActiveByScopeOwnerAgentStatement: any;

  constructor(db: any) {
    this.insertStatement = db.prepare(`
      INSERT INTO chat_memory_cards (
        id,
        conversation_id,
        agent_id,
        scope,
        owner_key,
        title,
        content,
        source,
        status,
        ttl_days,
        expires_at,
        metadata_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateStatement = db.prepare(`
      UPDATE chat_memory_cards
      SET
        conversation_id = ?,
        content = ?,
        source = ?,
        status = ?,
        ttl_days = ?,
        expires_at = ?,
        metadata_json = ?,
        updated_at = ?
      WHERE id = ?
    `);
    this.getStatement = db.prepare(`
      SELECT *
      FROM chat_memory_cards
      WHERE id = ?
      LIMIT 1
    `);
    this.getByScopeOwnerAgentTitleStatement = db.prepare(`
      SELECT *
      FROM chat_memory_cards
      WHERE scope = ?
        AND owner_key = ?
        AND agent_id = ?
        AND title = ?
      LIMIT 1
    `);
    this.listActiveByScopeOwnerAgentStatement = db.prepare(`
      SELECT *
      FROM chat_memory_cards
      WHERE scope = ?
        AND owner_key = ?
        AND agent_id = ?
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT ?
    `);
    this.countActiveByScopeOwnerAgentStatement = db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_memory_cards
      WHERE scope = ?
        AND owner_key = ?
        AND agent_id = ?
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
    `);
  }

  create(payload: any) {
    this.insertStatement.run(
      payload.id,
      payload.conversationId || null,
      payload.agentId,
      payload.scope,
      payload.ownerKey,
      payload.title,
      payload.content,
      payload.source,
      payload.status,
      payload.ttlDays,
      payload.expiresAt || null,
      payload.metadataJson,
      payload.createdAt,
      payload.updatedAt
    );

    return this.get(payload.id);
  }

  update(memoryCardId: string, payload: any) {
    this.updateStatement.run(
      payload.conversationId || null,
      payload.content,
      payload.source,
      payload.status,
      payload.ttlDays,
      payload.expiresAt || null,
      payload.metadataJson,
      payload.updatedAt,
      memoryCardId
    );

    return this.get(memoryCardId);
  }

  get(memoryCardId: string) {
    return this.getStatement.get(memoryCardId);
  }

  getByScopeOwnerAgentTitle(scope: string, ownerKey: string, agentId: string, title: string) {
    return this.getByScopeOwnerAgentTitleStatement.get(scope, ownerKey, agentId, title);
  }

  listActiveByScopeOwnerAgent(scope: string, ownerKey: string, agentId: string, options: any = {}) {
    const now = String(options.now || '').trim() || new Date().toISOString();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 6;
    return this.listActiveByScopeOwnerAgentStatement.all(scope, ownerKey, agentId, now, limit);
  }

  countActiveByScopeOwnerAgent(scope: string, ownerKey: string, agentId: string, options: any = {}) {
    const now = String(options.now || '').trim() || new Date().toISOString();
    const row = this.countActiveByScopeOwnerAgentStatement.get(scope, ownerKey, agentId, now);
    return Number(row && row.count ? row.count : 0);
  }

  getByConversationAgentTitle(conversationId: string, agentId: string, title: string) {
    return this.getByScopeOwnerAgentTitle(CONVERSATION_MEMORY_SCOPE, conversationId, agentId, title);
  }

  listActiveByConversationAgent(conversationId: string, agentId: string, options: any = {}) {
    return this.listActiveByScopeOwnerAgent(CONVERSATION_MEMORY_SCOPE, conversationId, agentId, options);
  }

  countActiveByConversationAgent(conversationId: string, agentId: string, options: any = {}) {
    return this.countActiveByScopeOwnerAgent(CONVERSATION_MEMORY_SCOPE, conversationId, agentId, options);
  }

  getByLocalUserAgentTitle(agentId: string, title: string, options: any = {}) {
    const ownerKey = String(options.ownerKey || '').trim() || DEFAULT_LOCAL_USER_OWNER_KEY;
    return this.getByScopeOwnerAgentTitle(LOCAL_USER_MEMORY_SCOPE, ownerKey, agentId, title);
  }

  listActiveByLocalUserAgent(agentId: string, options: any = {}) {
    const ownerKey = String(options.ownerKey || '').trim() || DEFAULT_LOCAL_USER_OWNER_KEY;
    return this.listActiveByScopeOwnerAgent(LOCAL_USER_MEMORY_SCOPE, ownerKey, agentId, options);
  }

  countActiveByLocalUserAgent(agentId: string, options: any = {}) {
    const ownerKey = String(options.ownerKey || '').trim() || DEFAULT_LOCAL_USER_OWNER_KEY;
    return this.countActiveByScopeOwnerAgent(LOCAL_USER_MEMORY_SCOPE, ownerKey, agentId, options);
  }
}

export function createChatMemoryCardRepository(db: any) {
  return new ChatMemoryCardRepository(db);
}
