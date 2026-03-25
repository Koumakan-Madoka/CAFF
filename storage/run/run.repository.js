class RunRepository {
  constructor(db) {
    this.insertStatement = db.prepare(`
      INSERT INTO runs (
        session_id,
        session_path,
        requested_session,
        requested_resume,
        agent_dir,
        cwd,
        provider,
        model,
        thinking,
        prompt,
        prompt_length,
        timeout_ms,
        idle_timeout_ms,
        heartbeat_interval_ms,
        heartbeat_timeout_ms,
        terminate_grace_ms,
        parent_run_id,
        task_id,
        task_kind,
        task_role,
        run_metadata_json,
        status,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.finishStatement = db.prepare(`
      UPDATE runs
      SET
        status = ?,
        ended_at = ?,
        exit_code = ?,
        signal = ?,
        termination_type = ?,
        termination_signal = ?,
        error_message = ?,
        reply = ?,
        reply_length = ?,
        stderr_tail = ?,
        parse_errors = ?,
        assistant_errors_json = ?
      WHERE id = ?
    `);
  }

  create(payload) {
    const info = this.insertStatement.run(
      payload.sessionId,
      payload.sessionPath,
      payload.requestedSession,
      payload.requestedResume,
      payload.agentDir,
      payload.cwd,
      payload.provider,
      payload.model,
      payload.thinking,
      payload.prompt,
      payload.promptLength,
      payload.timeoutMs,
      payload.idleTimeoutMs,
      payload.heartbeatIntervalMs,
      payload.heartbeatTimeoutMs,
      payload.terminateGraceMs,
      payload.parentRunId,
      payload.taskId,
      payload.taskKind,
      payload.taskRole,
      payload.runMetadataJson,
      payload.status,
      payload.startedAt
    );

    return Number(info.lastInsertRowid);
  }

  finish(runId, payload) {
    this.finishStatement.run(
      payload.status,
      payload.endedAt,
      payload.exitCode,
      payload.signal,
      payload.terminationType,
      payload.terminationSignal,
      payload.errorMessage,
      payload.reply,
      payload.replyLength,
      payload.stderrTail,
      payload.parseErrors,
      payload.assistantErrorsJson,
      runId
    );
  }
}

function createRunRepository(db) {
  return new RunRepository(db);
}

module.exports = {
  RunRepository,
  createRunRepository,
};
