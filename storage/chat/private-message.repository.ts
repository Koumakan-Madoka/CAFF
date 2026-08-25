export class ChatPrivateMessageRepository {
  insertStatement: any;
  listByConversationStatement: any;
  listVisibleByConversationAgentStatement: any;

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
    this.listVisibleByConversationAgentStatement = db.prepare(`
      SELECT *
      FROM (
        SELECT private_message.*
        FROM chat_private_messages private_message
        WHERE private_message.conversation_id = @conversationId
          AND (
            private_message.sender_agent_id = @agentId
            OR (
              json_valid(private_message.recipient_agent_ids_json) = 1
              AND EXISTS (
                SELECT 1
                FROM json_each(private_message.recipient_agent_ids_json) recipient
                WHERE recipient.value = @agentId
              )
            )
          )
        ORDER BY private_message.created_at DESC, private_message.id DESC
        LIMIT @limit
      ) bounded_private_messages
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

  listVisibleByConversationAgent(conversationId: string, agentId: string, limit: number) {
    const normalizedConversationId = String(conversationId || '').trim();
    const normalizedAgentId = String(agentId || '').trim();
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 24;

    if (!normalizedConversationId || !normalizedAgentId) {
      return [];
    }

    return this.listVisibleByConversationAgentStatement.all({
      conversationId: normalizedConversationId,
      agentId: normalizedAgentId,
      limit: normalizedLimit,
    });
  }
}

export function createChatPrivateMessageRepository(db: any) {
  return new ChatPrivateMessageRepository(db);
}
