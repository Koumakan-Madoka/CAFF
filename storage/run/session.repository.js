class RunSessionRepository {
  constructor(db) {
    this.upsertStatement = db.prepare(`
      INSERT INTO sessions (
        agent_dir,
        session_path,
        session_name,
        created_at,
        updated_at,
        last_run_id
      ) VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(session_path) DO UPDATE SET
        agent_dir = excluded.agent_dir,
        session_name = excluded.session_name,
        updated_at = excluded.updated_at
      RETURNING id
    `);
    this.touchStatement = db.prepare(`
      UPDATE sessions
      SET
        updated_at = ?,
        last_run_id = ?
      WHERE id = ?
    `);
  }

  ensure(payload) {
    const row = this.upsertStatement.get(
      payload.agentDir,
      payload.sessionPath,
      payload.sessionName,
      payload.createdAt,
      payload.updatedAt
    );

    return row ? Number(row.id) : null;
  }

  touch(sessionId, payload) {
    this.touchStatement.run(payload.updatedAt, payload.lastRunId, sessionId);
  }
}

function createRunSessionRepository(db) {
  return new RunSessionRepository(db);
}

module.exports = {
  RunSessionRepository,
  createRunSessionRepository,
};
