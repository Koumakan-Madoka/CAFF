const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const { withTempDir } = require('../helpers/temp-dir');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function createChatMessagesTable(db) {
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
}

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

  createChatMessagesTable(db);

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

  createChatMessagesTable(db);
  db.exec(`
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

test('server agent eval report includes the selected until day for date-only filters', (t) => {
  const { buildAgentEvalReport } = require('../../build/server/domain/metrics/agent-eval-report');
  const tempDir = withTempDir('caff-agent-eval-report-server-until-date-');
  const sqlitePath = path.join(tempDir, 'report.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  createChatMessagesTable(db);

  insertAssistantMessage(db, {
    id: 'message-in-range',
    taskId: 'task-in-range',
    createdAt: '2026-03-30T12:00:00.000Z',
    metadata: { publicToolUsed: true, publicPostCount: 1 },
  });
  insertAssistantMessage(db, {
    id: 'message-next-day',
    taskId: 'task-next-day',
    createdAt: '2026-03-31T12:00:00.000Z',
    metadata: { publicToolUsed: true, publicPostCount: 1 },
  });

  const report = buildAgentEvalReport(db, {
    since: '2026-03-30',
    until: '2026-03-30',
  });

  assert.equal(report.since, '2026-03-30');
  assert.equal(report.until, '2026-03-30');
  assert.equal(report.agents.length, 1);
  assert.equal(report.agents[0].turns, 1);
  assert.equal(report.agents[0].publicPostCount, 1);
});

const RAW_COLUMN_POISON_MARKER = `RAW_COLUMN_POISON_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const RAW_COLUMN_POISON_MESSAGE =
  'red-test: agent eval report must not materialize raw unbounded metadata_json/event_json columns';

function poisonRawJsonColumns(db) {
  const originalPrepare = db.prepare.bind(db);

  db.prepare = (sql) => {
    const statement = originalPrepare(sql);

    return {
      all: (...args) => {
        const rows = statement.all(...args);

        if (!Array.isArray(rows)) {
          return rows;
        }

        for (const row of rows) {
          for (const [key, value] of Object.entries(row)) {
            if (typeof value === 'string' && value.includes(RAW_COLUMN_POISON_MARKER)) {
              Object.defineProperty(row, key, {
                get() {
                  throw new Error(`${RAW_COLUMN_POISON_MESSAGE} (column: ${key})`);
                },
                configurable: true,
              });
            }
          }
        }

        return rows;
      },
      get: (...args) => statement.get(...args),
      run: (...args) => statement.run(...args),
    };
  };
}

test('server agent eval report never materializes raw metadata_json or event_json columns', (t) => {
  const { buildAgentEvalReport } = require('../../build/server/domain/metrics/agent-eval-report');
  const tempDir = withTempDir('caff-agent-eval-report-no-raw-columns-');
  const sqlitePath = path.join(tempDir, 'report.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  createChatMessagesTable(db);
  db.exec(`
    CREATE TABLE a2a_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      event_type TEXT,
      event_json TEXT,
      created_at TEXT
    );
  `);

  insertAssistantMessage(db, {
    id: 'message-poisoned',
    taskId: 'task-poisoned',
    createdAt: '2026-03-30T12:00:00.000Z',
    metadata: {
      publicToolUsed: true,
      publicPostCount: 2,
      privatePostCount: 1,
      privateHandoffCount: 1,
      filler: RAW_COLUMN_POISON_MARKER,
    },
  });

  const insertEvent = db.prepare(
    `
    INSERT INTO a2a_task_events (task_id, event_type, event_json, created_at)
    VALUES (@taskId, @eventType, @eventJson, @createdAt)
  `
  );

  insertEvent.run({
    taskId: 'task-poisoned',
    eventType: 'agent_expectations',
    eventJson: JSON.stringify({
      expectations: {
        'send-public': 'required',
        'send-private': 'forbidden',
      },
      filler: RAW_COLUMN_POISON_MARKER,
    }),
    createdAt: '2026-03-30T12:00:01.000Z',
  });
  insertEvent.run({
    taskId: 'task-poisoned',
    eventType: 'agent_tool_call',
    eventJson: JSON.stringify({
      tool: 'send-public',
      status: 'succeeded',
      durationMs: 25,
      filler: RAW_COLUMN_POISON_MARKER,
    }),
    createdAt: '2026-03-30T12:00:02.000Z',
  });

  poisonRawJsonColumns(db);

  const expectations = [
    ['bounded window', { since: '2026-03-01', until: '2026-03-31' }],
    ['explicit unbounded (CLI mode)', {}],
  ];

  for (const [label, options] of expectations) {
    const report = buildAgentEvalReport(db, options);

    assert.equal(report.agents.length, 1, `${label}: one agent bucket`);
    assert.equal(report.agents[0].turns, 1, `${label}: turns counted`);
    assert.equal(report.agents[0].publicPostCount, 2, `${label}: publicPostCount from extracted metadata`);
    assert.equal(report.agents[0].privatePostCount, 1, `${label}: privatePostCount from extracted metadata`);
    assert.equal(report.agents[0].privateHandoffCount, 1, `${label}: privateHandoffCount from extracted metadata`);
    assert.equal(report.agents[0].sendPublic.required, 1, `${label}: send-public expectation applied`);
    assert.equal(report.agents[0].sendPrivate.forbidden, 1, `${label}: send-private expectation applied`);
    assert.equal(report.tools.length, 1, `${label}: tool rows aggregated`);
    assert.equal(report.tools[0].tool, 'send-public');
    assert.equal(report.tools[0].calls, 1);
    assert.equal(report.tools[0].succeeded, 1);
  }
});

test('server agent eval report keeps baseline semantics for malformed and scalar JSON payloads', (t) => {
  const { buildAgentEvalReport } = require('../../build/server/domain/metrics/agent-eval-report');
  const tempDir = withTempDir('caff-agent-eval-report-edge-semantics-');
  const sqlitePath = path.join(tempDir, 'report.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  createChatMessagesTable(db);
  db.exec(`
    CREATE TABLE a2a_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      event_type TEXT,
      event_json TEXT,
      created_at TEXT
    );
  `);

  const insertMessage = db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, turn_id, role, agent_id, sender_name, status, task_id, metadata_json, created_at)
    VALUES (@id, 'conversation-1', @turnId, 'assistant', 'agent-1', 'Agent 1', 'completed', @taskId, @metadataJson, @createdAt)
  `);

  // Malformed metadata_json must degrade to defaults instead of failing the request.
  insertMessage.run({
    id: 'message-malformed-metadata',
    turnId: 'turn-malformed',
    taskId: 'task-malformed',
    metadataJson: '{not valid json',
    createdAt: '2026-03-30T00:00:00.000Z',
  });
  // JSON null root must also degrade to defaults.
  insertMessage.run({
    id: 'message-null-metadata',
    turnId: 'turn-null',
    taskId: 'task-null',
    metadataJson: 'null',
    createdAt: '2026-03-30T00:01:00.000Z',
  });
  // Valid object metadata without tool fields.
  insertMessage.run({
    id: 'message-object-metadata',
    turnId: 'turn-object',
    taskId: 'task-object',
    metadataJson: JSON.stringify({}),
    createdAt: '2026-03-30T00:02:00.000Z',
  });

  const insertEvent = db.prepare(`
    INSERT INTO a2a_task_events (task_id, event_type, event_json, created_at)
    VALUES (@taskId, @eventType, @eventJson, @createdAt)
  `);

  // Malformed expectations event must be skipped entirely (missing expectations).
  insertEvent.run({
    taskId: 'task-malformed',
    eventType: 'agent_expectations',
    eventJson: '{oops',
    createdAt: '2026-03-30T00:00:01.000Z',
  });
  // Expectations payload whose expectations field is not an object counts as missing.
  insertEvent.run({
    taskId: 'task-null',
    eventType: 'agent_expectations',
    eventJson: JSON.stringify({ expectations: 'send-public: required' }),
    createdAt: '2026-03-30T00:01:01.000Z',
  });
  // A later valid expectations event overwrites an earlier one; a malformed one does not clear it.
  insertEvent.run({
    taskId: 'task-object',
    eventType: 'agent_expectations',
    eventJson: JSON.stringify({ expectations: { 'send-public': 'forbidden' } }),
    createdAt: '2026-03-30T00:02:01.000Z',
  });
  insertEvent.run({
    taskId: 'task-object',
    eventType: 'agent_expectations',
    eventJson: '{later malformed',
    createdAt: '2026-03-30T00:02:02.000Z',
  });
  // Falsy-root tool event must be skipped entirely, not counted as an unknown tool.
  insertEvent.run({
    taskId: 'task-object',
    eventType: 'agent_tool_call',
    eventJson: '0',
    createdAt: '2026-03-30T00:02:03.000Z',
  });
  // Object tool event without a tool name counts as the unknown tool.
  insertEvent.run({
    taskId: 'task-object',
    eventType: 'agent_tool_call',
    eventJson: JSON.stringify({ status: 'succeeded' }),
    createdAt: '2026-03-30T00:02:04.000Z',
  });

  const report = buildAgentEvalReport(db, {});

  assert.equal(report.agents.length, 1);
  const agent = report.agents[0];
  assert.equal(agent.turns, 3);
  assert.equal(agent.missingExpectations, 2);
  assert.equal(agent.sendPublic.forbidden, 1);
  assert.equal(agent.sendPublic.tn, 1);
  assert.equal(agent.tools.length, 1);
  assert.equal(report.tools[0].tool, 'unknown');
  assert.equal(report.tools[0].calls, 1);
  assert.equal(report.tools[0].succeeded, 1);
});

test('agent eval report CLI retains explicit unbounded mode without since or until', (t) => {
  const tempDir = withTempDir('caff-agent-eval-report-cli-unbounded-');
  const sqlitePath = path.join(tempDir, 'report.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  createChatMessagesTable(db);

  insertAssistantMessage(db, {
    id: 'message-early',
    taskId: 'task-early',
    createdAt: '2026-01-05T12:00:00.000Z',
    metadata: { publicToolUsed: true, publicPostCount: 1 },
  });
  insertAssistantMessage(db, {
    id: 'message-late',
    taskId: 'task-late',
    createdAt: '2026-09-05T12:00:00.000Z',
    metadata: { publicToolUsed: true, publicPostCount: 1 },
  });

  const report = JSON.parse(
    execFileSync('node', [path.join('scripts', 'agent-eval-report.js'), '--db-path', sqlitePath, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
  );

  assert.equal(report.since, null);
  assert.equal(report.until, null);
  assert.equal(report.agents.length, 1);
  assert.equal(report.agents[0].turns, 2);
  assert.equal(report.agents[0].publicPostCount, 2);
});

test('agent eval report CLI includes the selected until day for date-only filters', (t) => {
  const tempDir = withTempDir('caff-agent-eval-report-cli-until-date-');
  const sqlitePath = path.join(tempDir, 'report.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  createChatMessagesTable(db);

  insertAssistantMessage(db, {
    id: 'message-in-range',
    taskId: 'task-in-range',
    createdAt: '2026-03-30T12:00:00.000Z',
    metadata: { publicToolUsed: true, publicPostCount: 1 },
  });
  insertAssistantMessage(db, {
    id: 'message-next-day',
    taskId: 'task-next-day',
    createdAt: '2026-03-31T12:00:00.000Z',
    metadata: { publicToolUsed: true, publicPostCount: 1 },
  });

  const report = JSON.parse(
    execFileSync(
      'node',
      [path.join('scripts', 'agent-eval-report.js'), '--db-path', sqlitePath, '--since', '2026-03-30', '--until', '2026-03-30', '--json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }
    )
  );

  assert.equal(report.since, '2026-03-30');
  assert.equal(report.until, '2026-03-30');
  assert.equal(report.agents.length, 1);
  assert.equal(report.agents[0].turns, 1);
  assert.equal(report.agents[0].publicPostCount, 1);
});

test('server agent eval report keeps baseline JS type semantics for projected JSON values', (t) => {
  const { buildAgentEvalReport } = require('../../build/server/domain/metrics/agent-eval-report');
  const tempDir = withTempDir('caff-agent-eval-report-type-semantics-');
  const sqlitePath = path.join(tempDir, 'report.sqlite');
  const db = new Database(sqlitePath);

  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  createChatMessagesTable(db);
  db.exec(`
    CREATE TABLE a2a_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      event_type TEXT,
      event_json TEXT,
      created_at TEXT
    );
  `);

  const insertMessage = db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, turn_id, role, agent_id, sender_name, status, task_id, metadata_json, created_at)
    VALUES (@id, 'conversation-1', @turnId, 'assistant', 'agent-1', 'Agent 1', 'completed', @taskId, @metadataJson, @createdAt)
  `);

  // Baseline: Number.isInteger(JSON.parse(...)) — JSON booleans are NOT integers,
  // even though SQLite json_extract folds true/false into 1/0.
  insertMessage.run({
    id: 'message-boolean-counts',
    turnId: 'turn-boolean-counts',
    taskId: 'task-boolean-counts',
    metadataJson: '{"publicPostCount":true,"privatePostCount":true,"privateHandoffCount":true}',
    createdAt: '2026-03-30T00:00:00.000Z',
  });
  // JSON false and 0 counts stay 0 under both semantics (lock).
  insertMessage.run({
    id: 'message-false-counts',
    turnId: 'turn-false-counts',
    taskId: 'task-false-counts',
    metadataJson: '{"publicPostCount":false,"privatePostCount":0,"privateHandoffCount":null}',
    createdAt: '2026-03-30T00:01:00.000Z',
  });
  // JSON reals with integral value ARE integers in JS (Number.isInteger(2) is
  // true); fractional reals and numeric strings are not (lock).
  insertMessage.run({
    id: 'message-real-counts',
    turnId: 'turn-real-counts',
    taskId: 'task-real-counts',
    metadataJson: '{"publicPostCount":2.0}',
    createdAt: '2026-03-30T00:02:00.000Z',
  });
  insertMessage.run({
    id: 'message-fractional-counts',
    turnId: 'turn-fractional-counts',
    taskId: 'task-fractional-counts',
    metadataJson: '{"publicPostCount":2.5,"privatePostCount":"3"}',
    createdAt: '2026-03-30T00:03:00.000Z',
  });

  const insertEvent = db.prepare(`
    INSERT INTO a2a_task_events (task_id, event_type, event_json, created_at)
    VALUES (@taskId, @eventType, @eventJson, @createdAt)
  `);

  // Baseline: Number.isFinite(event.durationMs) — JSON true is not finite,
  // even though SQLite folds it to 1.
  insertEvent.run({
    taskId: 'task-boolean-counts',
    eventType: 'agent_tool_call',
    eventJson: '{"tool":"send-public","status":"succeeded","durationMs":true}',
    createdAt: '2026-03-30T00:00:01.000Z',
  });
  // Baseline: tool bucket names use String(event.tool) — objects stringify to
  // '[object Object]', arrays to their join(','), true to 'true'.
  insertEvent.run({
    taskId: 'task-false-counts',
    eventType: 'agent_tool_call',
    eventJson: '{"tool":{"kind":"shell"},"status":"succeeded","durationMs":5}',
    createdAt: '2026-03-30T00:01:01.000Z',
  });
  insertEvent.run({
    taskId: 'task-real-counts',
    eventType: 'agent_tool_call',
    eventJson: '{"tool":["shell","run"],"status":["succeeded"],"durationMs":7}',
    createdAt: '2026-03-30T00:02:01.000Z',
  });
  insertEvent.run({
    taskId: 'task-fractional-counts',
    eventType: 'agent_tool_call',
    eventJson: '{"tool":true,"status":"succeeded","durationMs":9}',
    createdAt: '2026-03-30T00:03:01.000Z',
  });
  // Baseline: String(expectation['send-public'] || '') — a single-element array
  // stringifies to its element, so ['required'] matches the required contract.
  insertEvent.run({
    taskId: 'task-boolean-counts',
    eventType: 'agent_expectations',
    eventJson: '{"expectations":{"send-public":["required"]}}',
    createdAt: '2026-03-30T00:00:02.000Z',
  });
  insertEvent.run({
    taskId: 'task-fractional-counts',
    eventType: 'agent_expectations',
    eventJson: '{"expectations":{"send-public":"required"}}',
    createdAt: '2026-03-30T00:03:02.000Z',
  });

  const report = buildAgentEvalReport(db, {});
  const agent = report.agents[0];

  assert.equal(agent.turns, 4);
  // Boolean counts must stay 0 (baseline Number.isInteger(true) === false).
  assert.equal(agent.publicPostCount, 2, 'true and 2.0 must contribute 0 + 2, not 1 + 2');
  assert.equal(agent.privatePostCount, 0, 'true must not count as 1');
  assert.equal(agent.privateHandoffCount, 0, 'true must not count as 1');

  // ['required'] stringifies to 'required' and must match the required contract.
  assert.equal(agent.sendPublic.required, 2);
  assert.equal(agent.missingExpectations, 2);

  const toolsByName = new Map(report.tools.map((tool) => [tool.tool, tool]));
  const objectTool = toolsByName.get('[object Object]');
  assert.ok(objectTool, 'object tool must bucket as [object Object] (baseline String semantics)');
  assert.equal(objectTool.succeeded, 1);

  const arrayTool = toolsByName.get('shell,run');
  assert.ok(arrayTool, 'array tool must bucket as its join (baseline String semantics)');
  assert.equal(arrayTool.succeeded, 1, "['succeeded'] status must stringify to 'succeeded' and count");

  const trueTool = toolsByName.get('true');
  assert.ok(trueTool, 'boolean true tool must bucket as ' + "'true' (baseline String semantics)");
  assert.equal(trueTool.calls, 1);

  const sendPublicTool = toolsByName.get('send-public');
  assert.ok(sendPublicTool, 'string tool names keep their identity bucket');
  // durationMs: true must be excluded from latency percentiles (baseline
  // Number.isFinite(true) === false), leaving no durations at all.
  assert.equal(sendPublicTool.calls, 1);
  assert.equal(sendPublicTool.p50Ms, null);
  assert.equal(sendPublicTool.p95Ms, null);
});
