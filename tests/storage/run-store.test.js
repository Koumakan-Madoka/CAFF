const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');
const { createSqliteRunStore } = require('../../lib/sqlite-store');
const { withTempDir } = require('../helpers/temp-dir');

function listColumnNames(db, tableName) {
  return new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => String(column.name))
  );
}

test('run store migrates legacy runs schema and records task lifecycle data', (t) => {
  const tempDir = withTempDir('caff-run-m2-');
  const sqlitePath = path.join(tempDir, 'legacy-run.sqlite');
  const legacyDb = new Database(sqlitePath);
  let store = null;
  let migratedDb = null;

  t.after(() => {
    try {
      migratedDb && migratedDb.close();
    } catch {}
    try {
      store && store.close();
    } catch {}
    try {
      legacyDb.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  legacyDb.exec(`
CREATE TABLE runs (
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
  terminate_grace_ms INTEGER,
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
  assistant_errors_json TEXT
);
  `);
  legacyDb.close();

  store = createSqliteRunStore({ agentDir: tempDir, sqlitePath });

  const runRecord = store.startRun({
    sessionPath: path.join(tempDir, 'named-sessions', 'demo.jsonl'),
    requestedSession: 'demo',
    requestedResume: false,
    provider: 'openai',
    model: 'gpt-test',
    thinking: 'medium',
    prompt: 'run something',
    heartbeatIntervalMs: 1000,
    heartbeatTimeoutMs: 2000,
    terminateGraceMs: 3000,
    cwd: tempDir,
    metadata: { source: 'test' },
  });

  store.finishRun(runRecord.runId, {
    status: 'completed',
    exitCode: 0,
    reply: 'done',
    stderrTail: '',
    parseErrors: 0,
    assistantErrors: [],
  });

  const createdTask = store.createTask({
    taskId: 'task-root',
    kind: 'workflow',
    title: 'Root Task',
    status: 'queued',
    runId: runRecord.runId,
    sessionPath: path.join(tempDir, 'named-sessions', 'demo.jsonl'),
    metadata: { step: 1 },
  });
  const updatedTask = store.updateTask('task-root', {
    status: 'completed',
    outputText: 'All good',
    artifactSummary: [{ kind: 'text', name: 'summary' }],
  });
  store.appendTaskEvent('task-root', 'task_completed', { ok: true });
  store.addArtifact('task-root', {
    kind: 'text',
    name: 'result',
    contentText: 'artifact body',
    metadata: { saved: true },
  });

  assert.equal(createdTask.status, 'queued');
  assert.equal(updatedTask.status, 'completed');
  assert.equal(updatedTask.output_text, 'All good');
  assert.deepEqual(updatedTask.artifactSummary, [{ kind: 'text', name: 'summary' }]);
  assert.equal(store.getTask('task-root').status, 'completed');
  assert.equal(store.listTasksByParent().length, 1);
  assert.equal(store.listTaskEvents('task-root').length, 1);
  assert.deepEqual(store.listTaskEvents('task-root')[0].payload, { ok: true });

  store.close();

  migratedDb = new Database(sqlitePath, { readonly: true });

  const runColumns = listColumnNames(migratedDb, 'runs');
  const taskTable = migratedDb
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'a2a_tasks'
      LIMIT 1
    `)
    .get();
  const sessionRow = migratedDb.prepare('SELECT session_name, last_run_id FROM sessions LIMIT 1').get();
  const artifactCount = migratedDb.prepare('SELECT COUNT(*) AS count FROM a2a_artifacts').get();

  assert.equal(runColumns.has('heartbeat_interval_ms'), true);
  assert.equal(runColumns.has('heartbeat_timeout_ms'), true);
  assert.equal(runColumns.has('parent_run_id'), true);
  assert.equal(runColumns.has('task_id'), true);
  assert.equal(runColumns.has('task_kind'), true);
  assert.equal(runColumns.has('task_role'), true);
  assert.equal(runColumns.has('run_metadata_json'), true);
  assert.equal(Boolean(taskTable), true);
  assert.equal(sessionRow.session_name, 'demo');
  assert.equal(sessionRow.last_run_id, runRecord.runId);
  assert.equal(artifactCount.count, 1);
});
