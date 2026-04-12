export class ChatExternalEventRepository {
  getByIdStatement: any;
  insertStatement: any;
  updateStatement: any;
  deleteStatement: any;

  constructor(db: any) {
    this.getByIdStatement = db.prepare(`
      SELECT *
      FROM chat_external_events
      WHERE id = ?
      LIMIT 1
    `);
    this.insertStatement = db.prepare(`
      INSERT INTO chat_external_events (
        platform,
        direction,
        external_event_id,
        external_message_id,
        conversation_id,
        message_id,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateStatement = db.prepare(`
      UPDATE chat_external_events
      SET
        external_event_id = ?,
        external_message_id = ?,
        conversation_id = ?,
        message_id = ?,
        metadata_json = ?
      WHERE id = ?
    `);
    this.deleteStatement = db.prepare('DELETE FROM chat_external_events WHERE id = ?');
  }

  get(eventRecordId: number) {
    return this.getByIdStatement.get(eventRecordId);
  }

  create(payload: any) {
    const result = this.insertStatement.run(
      payload.platform,
      payload.direction,
      payload.externalEventId || null,
      payload.externalMessageId || null,
      payload.conversationId || null,
      payload.messageId || null,
      payload.metadataJson,
      payload.createdAt
    );

    return this.get(Number(result.lastInsertRowid));
  }

  update(eventRecordId: number, payload: any) {
    this.updateStatement.run(
      payload.externalEventId || null,
      payload.externalMessageId || null,
      payload.conversationId || null,
      payload.messageId || null,
      payload.metadataJson,
      eventRecordId
    );

    return this.get(eventRecordId);
  }

  delete(eventRecordId: number) {
    this.deleteStatement.run(eventRecordId);
  }
}

export function createChatExternalEventRepository(db: any) {
  return new ChatExternalEventRepository(db);
}
