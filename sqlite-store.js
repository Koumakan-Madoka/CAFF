const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_SQLITE_FILENAME = 'pi-state.sqlite';

const TASK_UPDATE_COLUMN_MAP = {
  parentTaskId: 'parent_task_id',
  parentRunId: 'parent_run_id',
  runId: 'run_id',
  kind: 'kind',
  title: 'title',
  status: 'status',
  assignedAgent: 'assigned_agent',
  assignedRole: 'assigned_role',
  provider: 'provider',
  model: 'model',
  requestedSession: 'requested_session',
  sessionPath: 'session_path',
  inputText: 'input_text',
  outputText: 'output_text',
  errorMessage: 'error_message',
  metadataJson: 'metadata_json',
  artifactSummaryJson: 'artifact_summary_json',
  startedAt: 'started_at',
  endedAt: 'ended_at',
};

function nowIso() {
  return new Date().toISOString();
}

function resolveSqlitePath(agentDir, sqlitePath) {
  if (sqlitePath) {
    return path.resolve(sqlitePath);
  }

  return path.resolve(agentDir, DEFAULT_SQLITE_FILENAME);
}

function deriveSessionName(sessionPath, agentDir) {
  if (!sessionPath) {
    return '';
  }

  const normalizedSessionPath = path.resolve(sessionPath);
  const namedSessionDir = path.resolve(agentDir, 'named-sessions');
  const sessionDir = path.dirname(normalizedSessionPath);

  if (sessionDir !== namedSessionDir) {
    return '';
  }

  if (!normalizedSessionPath.endsWith('.jsonl')) {
    return path.basename(normalizedSessionPath);
  }

  return path.basename(normalizedSessionPath, '.jsonl');
}

function serializeJson(value) {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value === undefined ? null : value);
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeSessionPath(sessionPath) {
  if (!sessionPath) {
    return null;
  }

  return path.resolve(sessionPath);
}

function normalizeTaskUpdates(updates = {}) {
  const normalized = { ...updates };

  if (Object.prototype.hasOwnProperty.call(normalized, 'sessionPath')) {
    normalized.sessionPath = normalizeSessionPath(normalized.sessionPath);
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'metadata')) {
    normalized.metadataJson = serializeJson(normalized.metadata);
    delete normalized.metadata;
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'artifactSummary')) {
    normalized.artifactSummaryJson = serializeJson(normalized.artifactSummary);
    delete normalized.artifactSummary;
  }

  return normalized;
}

function normalizeTaskRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    metadata: parseJson(row.metadata_json),
    artifactSummary: parseJson(row.artifact_summary_json),
  };
}

class SqliteRunStore {
  constructor({ agentDir, sqlitePath }) {
    this.agentDir = path.resolve(agentDir);
    this.databasePath = resolveSqlitePath(this.agentDir, sqlitePath);

    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });

    this.db = new Database(this.databasePath, { timeout: 5000 });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_dir TEXT NOT NULL,
  session_path TEXT NOT NULL UNIQUE,
  session_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_id INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  session_path TEXT,
  requested_session TEXT,
  requested_resume INTEGER NOT NULL DEFAULT 0,
  agent_dir TEXT NOT NULL,
  cwd TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  prompt TEXT NOT NULL,
  prompt_length INTEGER NOT NULL,
  timeout_ms INTEGER,
  idle_timeout_ms INTEGER,
  heartbeat_interval_ms INTEGER,
  heartbeat_timeout_ms INTEGER,
  terminate_grace_ms INTEGER,
  parent_run_id INTEGER,
  task_id TEXT,
  task_kind TEXT,
  task_role TEXT,
  run_metadata_json TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  signal TEXT,
  termination_type TEXT,
  termination_signal TEXT,
  error_message TEXT,
  reply TEXT,
  reply_length INTEGER,
  stderr_tail TEXT,
  parse_errors INTEGER NOT NULL DEFAULT 0,
  assistant_errors_json TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (parent_run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS a2a_tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT,
  parent_run_id INTEGER,
  run_id INTEGER,
  kind TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  assigned_agent TEXT,
  assigned_role TEXT,
  provider TEXT,
  model TEXT,
  requested_session TEXT,
  session_path TEXT,
  input_text TEXT,
  output_text TEXT,
  error_message TEXT,
  metadata_json TEXT,
  artifact_summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  FOREIGN KEY (parent_task_id) REFERENCES a2a_tasks(id),
  FOREIGN KEY (parent_run_id) REFERENCES runs(id),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS a2a_task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES a2a_tasks(id)
);

CREATE TABLE IF NOT EXISTS a2a_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  mime_type TEXT,
  content_text TEXT,
  uri TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES a2a_tasks(id)
);
    `);
    this.ensureRunColumns();
    this.db.exec(`
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs (session_id);
CREATE INDEX IF NOT EXISTS idx_runs_parent_run_id ON runs (parent_run_id);
CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs (task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_parent_task_id ON a2a_tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_parent_run_id ON a2a_tasks (parent_run_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_run_id ON a2a_tasks (run_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_status ON a2a_tasks (status);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_updated_at ON a2a_tasks (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_task_events_task_id ON a2a_task_events (task_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_a2a_artifacts_task_id ON a2a_artifacts (task_id, created_at ASC);
    `);

    this.upsertSessionStatement = this.db.prepare(`
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

    this.insertRunStatement = this.db.prepare(`
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

    this.finishRunStatement = this.db.prepare(`
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

    this.touchSessionStatement = this.db.prepare(`
      UPDATE sessions
      SET
        updated_at = ?,
        last_run_id = ?
      WHERE id = ?
    `);

    this.insertTaskStatement = this.db.prepare(`
      INSERT INTO a2a_tasks (
        id,
        parent_task_id,
        parent_run_id,
        run_id,
        kind,
        title,
        status,
        assigned_agent,
        assigned_role,
        provider,
        model,
        requested_session,
        session_path,
        input_text,
        output_text,
        error_message,
        metadata_json,
        artifact_summary_json,
        created_at,
        updated_at,
        started_at,
        ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertTaskEventStatement = this.db.prepare(`
      INSERT INTO a2a_task_events (
        task_id,
        event_type,
        event_json,
        created_at
      ) VALUES (?, ?, ?, ?)
    `);

    this.insertArtifactStatement = this.db.prepare(`
      INSERT INTO a2a_artifacts (
        task_id,
        kind,
        name,
        mime_type,
        content_text,
        uri,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getTaskStatement = this.db.prepare(`
      SELECT *
      FROM a2a_tasks
      WHERE id = ?
      LIMIT 1
    `);

    this.listChildTasksStatement = this.db.prepare(`
      SELECT *
      FROM a2a_tasks
      WHERE parent_task_id IS ?
      ORDER BY created_at ASC, id ASC
    `);

    this.listTaskEventsStatement = this.db.prepare(`
      SELECT *
      FROM a2a_task_events
      WHERE task_id = ?
      ORDER BY created_at ASC, id ASC
    `);
  }

  ensureSession(sessionPath) {
    if (!sessionPath) {
      return null;
    }

    const timestamp = nowIso();
    const normalizedSessionPath = path.resolve(sessionPath);
    const row = this.upsertSessionStatement.get(
      this.agentDir,
      normalizedSessionPath,
      deriveSessionName(normalizedSessionPath, this.agentDir),
      timestamp,
      timestamp
    );

    return row ? Number(row.id) : null;
  }

  ensureRunColumns() {
    const rows = this.db.prepare('PRAGMA table_info(runs)').all();
    const columnNames = new Set(rows.map((row) => String(row.name)));

    if (!columnNames.has('heartbeat_interval_ms')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN heartbeat_interval_ms INTEGER');
    }

    if (!columnNames.has('heartbeat_timeout_ms')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN heartbeat_timeout_ms INTEGER');
    }

    if (!columnNames.has('parent_run_id')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN parent_run_id INTEGER');
    }

    if (!columnNames.has('task_id')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN task_id TEXT');
    }

    if (!columnNames.has('task_kind')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN task_kind TEXT');
    }

    if (!columnNames.has('task_role')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN task_role TEXT');
    }

    if (!columnNames.has('run_metadata_json')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN run_metadata_json TEXT');
    }
  }

  startRun({
    sessionPath,
    requestedSession,
    requestedResume,
    provider,
    model,
    thinking,
    prompt,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    terminateGraceMs,
    cwd,
    parentRunId,
    taskId,
    taskKind,
    taskRole,
    metadata,
  }) {
    const sessionId = this.ensureSession(sessionPath);
    const normalizedSessionPath = normalizeSessionPath(sessionPath);
    const info = this.insertRunStatement.run(
      sessionId,
      normalizedSessionPath,
      requestedSession || null,
      requestedResume ? 1 : 0,
      this.agentDir,
      cwd,
      provider || null,
      model || null,
      thinking || null,
      prompt,
      prompt.length,
      null,
      null,
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      terminateGraceMs,
      parentRunId || null,
      taskId || null,
      taskKind || null,
      taskRole || null,
      serializeJson(metadata),
      'running',
      nowIso()
    );

    const runId = Number(info.lastInsertRowid);

    if (sessionId) {
      this.touchSessionStatement.run(nowIso(), runId, sessionId);
    }

    return {
      runId,
      sessionId,
      databasePath: this.databasePath,
    };
  }

  finishRun(runId, result) {
    if (!runId) {
      return;
    }

    const assistantErrors = Array.isArray(result.assistantErrors) ? result.assistantErrors : [];

    this.finishRunStatement.run(
      result.status,
      nowIso(),
      result.exitCode ?? null,
      result.signal ?? null,
      result.terminationType ?? null,
      result.terminationSignal ?? null,
      result.errorMessage ?? null,
      result.reply ?? null,
      typeof result.reply === 'string' ? result.reply.length : 0,
      result.stderrTail ?? null,
      result.parseErrors || 0,
      JSON.stringify(assistantErrors),
      runId
    );
  }

  createTask({
    taskId,
    parentTaskId,
    parentRunId,
    runId,
    kind,
    title,
    status,
    assignedAgent,
    assignedRole,
    provider,
    model,
    requestedSession,
    sessionPath,
    inputText,
    outputText,
    errorMessage,
    metadata,
    artifactSummary,
    startedAt,
    endedAt,
  }) {
    const createdAt = nowIso();
    const normalizedSessionPath = normalizeSessionPath(sessionPath);

    this.insertTaskStatement.run(
      taskId,
      parentTaskId || null,
      parentRunId || null,
      runId || null,
      kind || 'task',
      title || null,
      status || 'queued',
      assignedAgent || null,
      assignedRole || null,
      provider || null,
      model || null,
      requestedSession || null,
      normalizedSessionPath,
      inputText || null,
      outputText || null,
      errorMessage || null,
      serializeJson(metadata),
      serializeJson(artifactSummary),
      createdAt,
      createdAt,
      startedAt || null,
      endedAt || null
    );

    return this.getTask(taskId);
  }

  updateTask(taskId, updates = {}) {
    const normalized = normalizeTaskUpdates(updates);
    const assignments = [];
    const values = [];

    for (const [key, columnName] of Object.entries(TASK_UPDATE_COLUMN_MAP)) {
      if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
        continue;
      }

      assignments.push(`${columnName} = ?`);
      values.push(normalized[key]);
    }

    assignments.push('updated_at = ?');
    values.push(nowIso(), taskId);

    const statement = this.db.prepare(`
      UPDATE a2a_tasks
      SET ${assignments.join(', ')}
      WHERE id = ?
    `);

    statement.run(...values);
    return this.getTask(taskId);
  }

  appendTaskEvent(taskId, eventType, payload) {
    this.insertTaskEventStatement.run(taskId, eventType, serializeJson(payload), nowIso());
  }

  addArtifact(taskId, artifact = {}) {
    this.insertArtifactStatement.run(
      taskId,
      artifact.kind || 'text',
      artifact.name || null,
      artifact.mimeType || null,
      artifact.contentText || null,
      artifact.uri || null,
      serializeJson(artifact.metadata),
      nowIso()
    );
  }

  getTask(taskId) {
    return normalizeTaskRow(this.getTaskStatement.get(taskId));
  }

  listTasksByParent(parentTaskId = null) {
    return this.listChildTasksStatement.all(parentTaskId).map(normalizeTaskRow);
  }

  listTaskEvents(taskId) {
    return this.listTaskEventsStatement.all(taskId).map((row) => ({
      ...row,
      payload: parseJson(row.event_json),
    }));
  }

  close() {
    this.db.close();
  }
}

function createSqliteRunStore(options) {
  return new SqliteRunStore(options);
}

module.exports = {
  SqliteRunStore,
  createSqliteRunStore,
  resolveSqlitePath,
};
