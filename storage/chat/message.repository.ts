export class ChatMessageRepository {
  insertStatement: any;
  listByConversationStatement: any;
  getStatement: any;
  updateStatement: any;
  appendTextStatement: any;

  constructor(db: any) {
    this.insertStatement = db.prepare(`
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
    this.listByConversationStatement = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `);
    this.getStatement = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE id = ?
      LIMIT 1
    `);
    this.updateStatement = db.prepare(`
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
    this.appendTextStatement = db.prepare(`
      UPDATE chat_messages
      SET content = COALESCE(content, '') || ?
      WHERE id = ?
    `);
  }

  create(payload: any) {
    this.insertStatement.run(
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
      payload.metadataJson,
      payload.createdAt
    );

    return this.get(payload.id);
  }

  listByConversationId(conversationId: string) {
    return this.listByConversationStatement.all(conversationId);
  }

  get(messageId: string) {
    return this.getStatement.get(messageId);
  }

  update(messageId: string, payload: any) {
    this.updateStatement.run(
      payload.content,
      payload.status,
      payload.taskId,
      payload.runId,
      payload.errorMessage || null,
      payload.metadataJson,
      messageId
    );

    return this.get(messageId);
  }

  appendText(messageId: string, delta: string) {
    this.appendTextStatement.run(delta, messageId);
    return this.get(messageId);
  }
}

export function createChatMessageRepository(db: any) {
  return new ChatMessageRepository(db);
}
