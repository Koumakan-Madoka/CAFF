export class ChatPlanRepository {
  getByOwnerStatement: any;
  getByIdStatement: any;
  listByStatusStatement: any;
  insertStatement: any;
  updateStatement: any;

  constructor(db: any) {
    this.getByOwnerStatement = db.prepare(`
      SELECT *
      FROM chat_plans
      WHERE owner_conversation_id = ?
      LIMIT 1
    `);
    this.getByIdStatement = db.prepare(`
      SELECT *
      FROM chat_plans
      WHERE id = ?
      LIMIT 1
    `);
    this.listByStatusStatement = db.prepare(`
      SELECT *
      FROM chat_plans
      WHERE status = ?
      ORDER BY updated_at ASC
    `);
    this.insertStatement = db.prepare(`
      INSERT INTO chat_plans (
        id,
        owner_conversation_id,
        status,
        version,
        doc_json,
        activated_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Optimistic concurrency guard: caller must supply the version it read.
    this.updateStatement = db.prepare(`
      UPDATE chat_plans
      SET
        status = @status,
        version = @version,
        doc_json = @docJson,
        activated_at = @activatedAt,
        updated_at = @updatedAt
      WHERE id = @id
        AND version = @expectedVersion
    `);
  }

  getByOwnerConversationId(ownerConversationId: string) {
    return this.getByOwnerStatement.get(ownerConversationId) || null;
  }

  getById(planId: string) {
    return this.getByIdStatement.get(planId) || null;
  }

  /** Scheduler reconcile (D25): enumerate plans in a given lifecycle status. */
  listByStatus(status: string) {
    return this.listByStatusStatement.all(status);
  }

  create(payload: any) {
    this.insertStatement.run(
      payload.id,
      payload.ownerConversationId,
      payload.status,
      payload.version,
      payload.docJson,
      payload.activatedAt || null,
      payload.createdAt,
      payload.updatedAt
    );
    return this.getById(payload.id);
  }

  /** Returns the updated row, or null when the version guard rejected the write. */
  updateWithVersionGuard(payload: any) {
    const result = this.updateStatement.run({
      id: payload.id,
      expectedVersion: payload.expectedVersion,
      status: payload.status,
      version: payload.version,
      docJson: payload.docJson,
      activatedAt: payload.activatedAt || null,
      updatedAt: payload.updatedAt,
    });
    if (!result || result.changes === 0) {
      return null;
    }
    return this.getById(payload.id);
  }
}

export function createChatPlanRepository(db: any) {
  return new ChatPlanRepository(db);
}
