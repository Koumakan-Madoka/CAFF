const UPDATE_COLUMNS: Record<string, string> = {
  status: 'status',
  recoveryRunId: 'recovery_run_id',
  recoveryMessageId: 'recovery_message_id',
  capsuleJson: 'capsule_json',
  modelOutput: 'model_output',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  fallbackUsed: 'fallback_used',
  startedAt: 'started_at',
  endedAt: 'ended_at',
};

export class ChatMessageRecoveryRepository {
  db: any;
  insertStatement: any;
  getStatement: any;
  getBySourceStatement: any;

  constructor(db: any) {
    this.db = db;
    this.insertStatement = db.prepare(`
      INSERT INTO chat_message_recoveries (
        id,
        conversation_id,
        source_message_id,
        source_task_id,
        source_run_id,
        recovery_task_id,
        status,
        fallback_used,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
    `);
    this.getStatement = db.prepare(`
      SELECT *
      FROM chat_message_recoveries
      WHERE id = ?
      LIMIT 1
    `);
    this.getBySourceStatement = db.prepare(`
      SELECT *
      FROM chat_message_recoveries
      WHERE source_message_id = ?
      LIMIT 1
    `);
  }

  create(payload: any) {
    this.insertStatement.run(
      payload.id,
      payload.conversationId,
      payload.sourceMessageId,
      payload.sourceTaskId,
      payload.sourceRunId,
      payload.recoveryTaskId,
      payload.createdAt,
      payload.updatedAt
    );
    return this.get(payload.id);
  }

  get(id: string) {
    return this.getStatement.get(id);
  }

  getBySourceMessageId(sourceMessageId: string) {
    return this.getBySourceStatement.get(sourceMessageId);
  }

  listBySourceMessageIds(sourceMessageIds: string[]) {
    const ids = Array.from(new Set(
      (Array.isArray(sourceMessageIds) ? sourceMessageIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ));
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT *
      FROM chat_message_recoveries
      WHERE source_message_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `).all(...ids);
  }

  transition(id: string, expectedStatuses: string[], updates: Record<string, any>, updatedAt: string) {
    const statuses = Array.from(new Set(
      (Array.isArray(expectedStatuses) ? expectedStatuses : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ));
    if (statuses.length === 0) {
      throw new Error('Message recovery transition requires an expected status');
    }

    const targetStatus = Object.prototype.hasOwnProperty.call(updates, 'status')
      ? String(updates.status || '').trim()
      : '';
    const allowedTargets: Record<string, Set<string>> = {
      queued: new Set(['running', 'failed']),
      running: new Set(['completed', 'failed']),
    };
    const mutableStatuses = statuses.filter((status) => {
      if (!allowedTargets[status]) {
        return false;
      }
      return !targetStatus || allowedTargets[status].has(targetStatus);
    });
    if (mutableStatuses.length === 0) {
      return null;
    }

    const assignments: string[] = [];
    const values: any[] = [];
    for (const [key, column] of Object.entries(UPDATE_COLUMNS)) {
      if (!Object.prototype.hasOwnProperty.call(updates, key)) {
        continue;
      }
      assignments.push(`${column} = ?`);
      values.push(updates[key]);
    }
    if (assignments.length === 0) {
      return this.get(id);
    }

    assignments.push('updated_at = ?');
    values.push(updatedAt, id, ...mutableStatuses);
    const statusPlaceholders = mutableStatuses.map(() => '?').join(', ');
    const row = this.db.prepare(`
      UPDATE chat_message_recoveries
      SET ${assignments.join(', ')}
      WHERE id = ?
        AND status IN (${statusPlaceholders})
      RETURNING *
    `).get(...values);
    return row || null;
  }
}

export function createChatMessageRecoveryRepository(db: any) {
  return new ChatMessageRecoveryRepository(db);
}
