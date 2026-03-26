export class ChatPrivateMessageRepository {
  insertStatement: any;
  listByConversationStatement: any;

  constructor(db: any) {
    this.insertStatement = db.prepare(`
      INSERT INTO chat_private_messages (
        id,
        conversation_id,
        turn_id,
        sender_agent_id,
        sender_name,
        recipient_agent_ids_json,
        content,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.listByConversationStatement = db.prepare(`
      SELECT *
      FROM chat_private_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `);
  }

  create(payload: any) {
    this.insertStatement.run(
      payload.id,
      payload.conversationId,
      payload.turnId,
      payload.senderAgentId || null,
      payload.senderName,
      payload.recipientAgentIdsJson,
      payload.content || '',
      payload.metadataJson,
      payload.createdAt
    );

    return {
      id: payload.id,
      conversation_id: payload.conversationId,
      turn_id: payload.turnId,
      sender_agent_id: payload.senderAgentId || null,
      sender_name: payload.senderName,
      recipient_agent_ids_json: payload.recipientAgentIdsJson,
      content: payload.content || '',
      metadata_json: payload.metadataJson,
      created_at: payload.createdAt,
    };
  }

  listByConversationId(conversationId: string) {
    return this.listByConversationStatement.all(conversationId);
  }
}

export function createChatPrivateMessageRepository(db: any) {
  return new ChatPrivateMessageRepository(db);
}
