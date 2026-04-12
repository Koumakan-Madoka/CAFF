export class ChatChannelBindingRepository {
  getByExternalChatIdStatement: any;
  getByConversationIdStatement: any;
  insertStatement: any;
  updateStatement: any;

  constructor(db: any) {
    this.getByExternalChatIdStatement = db.prepare(`
      SELECT *
      FROM chat_channel_bindings
      WHERE platform = ? AND external_chat_id = ?
      LIMIT 1
    `);
    this.getByConversationIdStatement = db.prepare(`
      SELECT *
      FROM chat_channel_bindings
      WHERE platform = ? AND conversation_id = ?
      LIMIT 1
    `);
    this.insertStatement = db.prepare(`
      INSERT INTO chat_channel_bindings (
        platform,
        external_chat_id,
        conversation_id,
        metadata_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.updateStatement = db.prepare(`
      UPDATE chat_channel_bindings
      SET
        conversation_id = ?,
        metadata_json = ?,
        updated_at = ?
      WHERE platform = ? AND external_chat_id = ?
    `);
  }

  getByExternalChatId(platform: string, externalChatId: string) {
    return this.getByExternalChatIdStatement.get(platform, externalChatId);
  }

  getByConversationId(platform: string, conversationId: string) {
    return this.getByConversationIdStatement.get(platform, conversationId);
  }

  create(payload: any) {
    this.insertStatement.run(
      payload.platform,
      payload.externalChatId,
      payload.conversationId,
      payload.metadataJson,
      payload.createdAt,
      payload.updatedAt
    );

    return this.getByExternalChatId(payload.platform, payload.externalChatId);
  }

  update(platform: string, externalChatId: string, payload: any) {
    this.updateStatement.run(
      payload.conversationId,
      payload.metadataJson,
      payload.updatedAt,
      platform,
      externalChatId
    );

    return this.getByExternalChatId(platform, externalChatId);
  }
}

export function createChatChannelBindingRepository(db: any) {
  return new ChatChannelBindingRepository(db);
}
