export class ChatConversationRepository {
  listHeadersStatement: any;
  getStatement: any;
  insertStatement: any;
  updateStatement: any;
  touchStatement: any;
  deleteStatement: any;

  constructor(db: any) {
    this.listHeadersStatement = db.prepare(`
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
    this.getStatement = db.prepare(`
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
    this.insertStatement = db.prepare(`
      INSERT INTO chat_conversations (
        id,
        title,
        type,
        metadata_json,
        created_at,
        updated_at,
        last_message_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateStatement = db.prepare(`
      UPDATE chat_conversations
      SET
        title = ?,
        type = ?,
        metadata_json = ?,
        updated_at = ?
      WHERE id = ?
    `);
    this.touchStatement = db.prepare(`
      UPDATE chat_conversations
      SET
        updated_at = ?,
        last_message_at = COALESCE(?, last_message_at)
      WHERE id = ?
    `);
    this.deleteStatement = db.prepare('DELETE FROM chat_conversations WHERE id = ?');
  }

  listHeaders() {
    return this.listHeadersStatement.all();
  }

  get(conversationId: string) {
    return this.getStatement.get(conversationId);
  }

  create(payload: any) {
    this.insertStatement.run(
      payload.id,
      payload.title,
      payload.type,
      payload.metadataJson,
      payload.createdAt,
      payload.updatedAt,
      payload.lastMessageAt || null
    );

    return this.get(payload.id);
  }

  update(conversationId: string, payload: any) {
    this.updateStatement.run(
      payload.title,
      payload.type,
      payload.metadataJson,
      payload.updatedAt,
      conversationId
    );

    return this.get(conversationId);
  }

  touch(conversationId: string, payload: any) {
    this.touchStatement.run(payload.updatedAt, payload.lastMessageAt || null, conversationId);
    return this.get(conversationId);
  }

  delete(conversationId: string) {
    this.deleteStatement.run(conversationId);
  }
}

export function createChatConversationRepository(db: any) {
  return new ChatConversationRepository(db);
}
