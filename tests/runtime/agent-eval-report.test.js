const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const { withTempDir } = require('../helpers/temp-dir');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function insertAssistantMessage(db, options = {}) {
  db.prepare(
    `
    INSERT INTO chat_messages (
      id,
      conversation_id,
      turn_id,
      role,
      agent_id,
      sender_name,
      status,
      task_id,
      metadata_json,
      created_at
    ) VALUES (
      @id,
      @conversationId,
      @turnId,
      'assistant',
      @agentId,
      @senderName,
      @status,
      @taskId,
      @metadataJson,
      @createdAt
    )
  `
  ).run({
    id: options.id,
    conversationId: options.conversationId || 'conversation-1',
    turnId: options.turnId || `turn-${options.id}`,
    agentId: options.agentId || 'agent-1',
    senderName: options.senderName || 'Agent 1',
    status: options.status || 'completed',
    taskId: options.taskId || '',
    metadataJson: JSON.stringify(options.metadata || {}),
    createdAt: options.createdAt || '2026-03-30T00:00:00.000Z',
  });
}

test('agent eval report CLI treats missing a2a_task_events as an empty event set', (t) => {
  const tempDir = withTempDir('caff-agent-eval-report-missing-events-');
  const sqlitePath = path.join(tempDir, 'report.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  db.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      turn_id TEXT,
      role TEXT,
      agent_id TEXT,
      sender_name TEXT,
      status TEXT,
      task_id TEXT,
      metadata_json TEXT,
      created_at TEXT
    );
  `);

  insertAssistantMessage(db, {
    id: 'message-1',
    taskId: 'task-1',
    metadata: { publicToolUsed: true, publicPostCount: 1 },
  });

  const report = JSON.parse(
    execFileSync('node', [path.join('scripts', 'agent-eval-report.js'), '--db-path', sqlitePath, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
  );

  assert.equal(report.agents.length, 1);
  assert.equal(report.agents[0].agentId, 'agent-1');
  assert.equal(report.agents[0].missingExpectations, 1);
  assert.deepEqual(report.tools, []);
});

test('agent eval report CLI avoids SQLite variable overflow for large task sets', (t) => {
  const tempDir = withTempDir('caff-agent-eval-report-many-tasks-');
  const sqlitePath = path.join(tempDir, 'report.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  db.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      turn_id TEXT,
      role TEXT,
      agent_id TEXT,
      sender_name TEXT,
      status TEXT,
      task_id TEXT,
      metadata_json TEXT,
      created_at TEXT
    );
    CREATE TABLE a2a_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      event_type TEXT,
      event_json TEXT,
      created_at TEXT
    );
  `);

  const insertEvent = db.prepare(
    `
    INSERT INTO a2a_task_events (task_id, event_type, event_json, created_at)
    VALUES (@taskId, @eventType, @eventJson, @createdAt)
  `
  );

  db.transaction(() => {
    for (let index = 0; index < 1005; index += 1) {
      const taskId = `task-${index}`;
      const timestamp = new Date(Date.UTC(2026, 2, 30, 0, 0, index % 60, 0)).toISOString();
      insertAssistantMessage(db, {
        id: `message-${index}`,
        turnId: `turn-${index}`,
        taskId,
        metadata: { publicToolUsed: true, publicPostCount: 1 },
        createdAt: timestamp,
      });
      insertEvent.run({
        taskId,
        eventType: 'agent_expectations',
        eventJson: JSON.stringify({
          expectations: {
            'send-public': 'required',
            'send-private': 'optional',
          },
        }),
        createdAt: timestamp,
      });
      insertEvent.run({
        taskId,
        eventType: 'agent_tool_call',
        eventJson: JSON.stringify({
          tool: 'send-public',
          status: 'succeeded',
          durationMs: 12,
        }),
        createdAt: timestamp,
      });
    }
  })();

  const report = JSON.parse(
    execFileSync('node', [path.join('scripts', 'agent-eval-report.js'), '--db-path', sqlitePath, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
  );

  assert.equal(report.agents.length, 1);
  assert.equal(report.agents[0].turns, 1005);
  assert.equal(report.agents[0].sendPublic.required, 1005);
  assert.equal(report.agents[0].sendPublic.recall, 1);
  assert.equal(report.tools.length, 1);
  assert.equal(report.tools[0].tool, 'send-public');
  assert.equal(report.tools[0].calls, 1005);
  assert.equal(report.tools[0].succeeded, 1005);
});
