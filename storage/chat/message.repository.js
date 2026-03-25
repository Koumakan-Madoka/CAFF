class ChatMessageRepository {
  constructor(db) {
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

  create(payload) {
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

  listByConversationId(conversationId) {
    return this.listByConversationStatement.all(conversationId);
  }

  get(messageId) {
    return this.getStatement.get(messageId);
  }

  update(messageId, payload) {
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

  appendText(messageId, delta) {
    this.appendTextStatement.run(delta, messageId);
    return this.get(messageId);
  }
}

function createChatMessageRepository(db) {
  return new ChatMessageRepository(db);
}

module.exports = {
  ChatMessageRepository,
  createChatMessageRepository,
};
