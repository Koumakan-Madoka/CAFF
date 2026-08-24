const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { createMetricsController } = require('../../build/server/api/metrics-controller');
const { withTempDir } = require('../helpers/temp-dir');

const WINDOW_ERROR_CODE = 'metrics_agent_window_invalid';

function createHarness(t, name) {
  const tempDir = withTempDir(`caff-metrics-agent-window-${name}-`);
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const db = new Database(sqlitePath);

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

  const insertMessage = db.prepare(
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
      'completed',
      @taskId,
      @metadataJson,
      @createdAt
    )
  `
  );

  insertMessage.run({
    id: 'message-in-window',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    senderName: 'Agent 1',
    taskId: 'task-in-window',
    metadataJson: JSON.stringify({ publicToolUsed: true, publicPostCount: 1 }),
    createdAt: '2026-08-10T12:00:00.000Z',
  });

  insertMessage.run({
    id: 'message-outside-window',
    conversationId: 'conversation-1',
    turnId: 'turn-2',
    agentId: 'agent-1',
    senderName: 'Agent 1',
    taskId: 'task-outside-window',
    metadataJson: JSON.stringify({ publicToolUsed: true, publicPostCount: 1 }),
    createdAt: '2026-09-05T12:00:00.000Z',
  });

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = { db, databasePath: sqlitePath };
  const controller = createMetricsController({ store });

  return { controller, store };
}

function createGetContext(query = '') {
  const state = { body: '', statusCode: 0, headers: {} };
  const res = {
    writeHead(statusCode, headers) {
      state.statusCode = statusCode;
      state.headers = headers || {};
    },
    end(body = '') {
      state.body = String(body || '');
    },
  };

  return {
    req: { method: 'GET' },
    res,
    pathname: '/api/metrics/agent',
    requestUrl: new URL(`http://127.0.0.1/api/metrics/agent${query}`),
    state,
  };
}

async function assertWindowRejected(t, name, query) {
  const { controller } = createHarness(t, name);
  const context = createGetContext(query);

  await assert.rejects(
    () => controller(context),
    (error) => {
      assert.equal(error.statusCode, 400, `expected 400 for query ${query}, got ${error.statusCode}`);
      assert.equal(error.code, WINDOW_ERROR_CODE);
      assert.ok(typeof error.message === 'string' && error.message.length > 0);
      return true;
    }
  );
  assert.equal(context.state.statusCode, 0, 'no response body must be sent when the window is rejected');
}

test('metrics agent endpoint rejects a request missing both since and until', async (t) => {
  await assertWindowRejected(t, 'missing-both', '');
});

test('metrics agent endpoint rejects a request missing since', async (t) => {
  await assertWindowRejected(t, 'missing-since', '?until=2026-08-31');
});

test('metrics agent endpoint rejects a request missing until', async (t) => {
  await assertWindowRejected(t, 'missing-until', '?since=2026-08-01');
});

test('metrics agent endpoint rejects a reversed window', async (t) => {
  await assertWindowRejected(t, 'reversed', '?since=2026-08-31&until=2026-08-01');
});

test('metrics agent endpoint rejects a window longer than 31 days', async (t) => {
  await assertWindowRejected(t, 'oversized-32d', '?since=2026-08-01&until=2026-09-01');
  await assertWindowRejected(t, 'oversized-60d', '?since=2026-07-01&until=2026-09-01');
});

test('metrics agent endpoint rejects a malformed date boundary', async (t) => {
  await assertWindowRejected(t, 'malformed-since', '?since=not-a-date&until=2026-08-31');
  await assertWindowRejected(t, 'malformed-until', '?since=2026-08-01&until=2026/08/31');
});

test('metrics agent endpoint accepts a complete 31-day window and echoes boundaries', async (t) => {
  const { controller } = createHarness(t, 'valid-31d');
  const context = createGetContext('?since=2026-08-01&until=2026-08-31');

  assert.equal(await controller(context), true);
  assert.equal(context.state.statusCode, 200);

  const report = JSON.parse(context.state.body);
  assert.equal(report.since, '2026-08-01');
  assert.equal(report.until, '2026-08-31');
  assert.equal(report.agents.length, 1);
  assert.equal(report.agents[0].turns, 1);
  assert.equal(report.agents[0].publicPostCount, 1);
});

test('metrics agent endpoint accepts a full ISO datetime window inside 31 days', async (t) => {
  const { controller } = createHarness(t, 'valid-iso');
  const context = createGetContext('?since=2026-08-01T00:00:00.000Z&until=2026-08-31T23:59:59.999Z');

  assert.equal(await controller(context), true);
  assert.equal(context.state.statusCode, 200);

  const report = JSON.parse(context.state.body);
  assert.equal(report.agents.length, 1);
  assert.equal(report.agents[0].turns, 1);
});
