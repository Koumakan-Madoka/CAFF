const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const { createConversationsController } = require('../../build/server/api/conversations-controller');
const { withTempDir } = require('../helpers/temp-dir');

const BASE = Date.parse('2026-10-20T10:00:00.000Z');

function assistantLine(timestamp, toolCalls, extra = {}) {
  return JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      timestamp,
      content: toolCalls.map((call) => ({
        type: 'toolCall',
        id: call.id,
        name: call.name,
        arguments: call.arguments || {},
      })),
      ...extra,
    },
  });
}

function toolResultLine(timestamp, toolCallId, toolName, text, isError = false) {
  return JSON.stringify({
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName,
      content: [{ type: 'text', text }],
      isError,
      timestamp,
    },
  });
}

function writeSession(agentDir, name, lines) {
  const dir = path.join(agentDir, 'named-sessions');

  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, name);

  fs.writeFileSync(filePath, lines.join('\n') + '\n');

  return filePath;
}

function createFixture(t, name) {
  const tempDir = withTempDir(`caff-turn-time-http-${name}-`);
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  // Run schema (a2a_tasks) shares the same database file in production.
  const runStore = createSqliteRunStore({ agentDir: tempDir, sqlitePath });

  try { runStore.close(); } catch {}

  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const conversation = store.createConversation({
    id: `conv-${name}`,
    title: `Breakdown ${name}`,
    type: 'standard',
    projectScopeId: 'project-breakdown',
    participants: ['role-family-kimi'],
  });
  const handler = createConversationsController({
    store,
    turnOrchestrator: {
      resolveAssistantMessageSessionPath() { return ''; },
    },
    buildBootstrapPayload() { return {}; },
  });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { store, conversation, handler, tempDir, sqlitePath };
}

function createTaskRow(store, { taskId, sessionPath, assistantStartIndex = 0 }) {
  const now = new Date().toISOString();

  store.db.prepare(`
    INSERT INTO a2a_tasks (id, kind, status, session_path, metadata_json, created_at, updated_at)
    VALUES (@taskId, 'agent', 'completed', @sessionPath, @metadataJson, @now, @now)
  `).run({
    taskId,
    sessionPath,
    metadataJson: JSON.stringify({ sessionAssistantStartIndex: assistantStartIndex }),
    now,
  });
}

function createAssistantMessage(store, conversationId, messageId, options = {}) {
  return store.createMessage({
    id: messageId,
    conversationId,
    turnId: `turn-${messageId}`,
    role: 'assistant',
    agentId: 'role-family-kimi',
    senderName: 'Kimi',
    content: 'reply',
    status: options.status || 'completed',
    taskId: options.taskId || null,
    metadata: {
      sessionAssistantStartIndex: 0,
      sessionReused: options.sessionReused === true,
      sessionReuseReason: options.sessionReused === true ? 'reused' : 'no_prior_session',
      tokenUsage: { totalTokens: 42 },
    },
    createdAt: options.createdAt || '2026-10-20T10:05:00.000Z',
  });
}

async function invoke(handler, pathname) {
  const requestUrl = new URL(pathname, 'http://127.0.0.1');
  const req = new PassThrough();

  req.method = 'GET';
  req.url = `${requestUrl.pathname}${requestUrl.search}`;
  req.headers = {};

  const response = { statusCode: 0, headers: {}, body: '' };
  const res = {
    writeHead(statusCode, headers) {
      response.statusCode = statusCode;
      response.headers = headers;
    },
    end(chunk = '') {
      response.body = String(chunk || '');
    },
  };
  const handledPromise = handler({ req, res, pathname: requestUrl.pathname, requestUrl }).catch((error) => {
    // The production server wraps handlers and maps HttpError to a JSON
    // response; the bare harness surfaces it the same way.
    response.statusCode = Number(error && error.statusCode) || 500;
    response.headers['Content-Type'] = 'application/json; charset=utf-8';
    response.body = JSON.stringify({ error: String(error && error.message || error) });
    return true;
  });

  req.end();
  response.handled = await handledPromise;

  const contentType = String(response.headers['Content-Type'] || response.headers['content-type'] || '');

  response.json = response.body && contentType.includes('application/json') ? JSON.parse(response.body) : {};

  return response;
}

function breakdownUrl(conversationId, messageId) {
  return `/api/conversations/${conversationId}/messages/${messageId}/time-breakdown`;
}

test('lazy backfill: no stored rows → parse session, classify, persist, return breakdown', async (t) => {
  const { store, conversation, handler, tempDir } = createFixture(t, 'backfill');
  const sessionPath = writeSession(tempDir, 's1.jsonl', [
    assistantLine(BASE + 1_000, [{ id: 'c1', name: 'read', arguments: { path: 'server/app.ts' } }]),
    toolResultLine(BASE + 3_000, 'c1', 'read', 'file content'),
    assistantLine(BASE + 4_000, [{ id: 'c2', name: 'bash', arguments: { command: 'npm test' } }]),
    toolResultLine(BASE + 14_000, 'c2', 'bash', '# pass 100\n# fail 0'),
  ]);
  const taskId = 'task-backfill-1';

  createTaskRow(store, { taskId, sessionPath });
  createAssistantMessage(store, conversation.id, 'msg-1', { taskId, createdAt: '2026-10-20T10:05:00.000Z' });

  const response = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));

  assert.equal(response.statusCode, 200);
  const breakdown = response.json.breakdown;

  assert.equal(breakdown.status, 'complete');
  assert.equal(breakdown.steps.length, 2);
  assert.equal(breakdown.steps[0].category, 'read');
  assert.equal(breakdown.steps[0].subcategory, 'cold-start-reread');
  assert.equal(breakdown.steps[1].category, 'test');
  assert.equal(breakdown.steps[1].runKind, 'full-regression');
  assert.equal(breakdown.steps[1].durationMs, 10_000);
  assert.equal(breakdown.categoryMs.test, 10_000);
  assert.equal(breakdown.categoryMs.read, 2000);
  assert.equal(breakdown.metrics.fullRunCount, 1);
  assert.equal(breakdown.metrics.fullRunFailCount, 0);
  assert.equal(breakdown.metrics.sessionReused, false);
  assert.equal(breakdown.metrics.sessionReuseReason, 'no_prior_session');
  assert.equal(breakdown.tokenUsage.totalTokens, 42);

  // Persisted for the cached path.
  const summary = store.turnTimeBreakdownRepository.getSummary('msg-1');

  assert.equal(summary.status, 'complete');
  assert.ok(summary.parseOffset > 0);

  // Cached path: the session file is gone, the stored summary still serves.
  fs.rmSync(sessionPath);

  const cached = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));

  assert.equal(cached.statusCode, 200);
  assert.equal(cached.json.breakdown.status, 'complete');
  assert.equal(cached.json.breakdown.steps.length, 2);
});

test('firstWriteMs metric reflects the first repo write of the turn', async (t) => {
  const { store, conversation, handler, tempDir } = createFixture(t, 'firstwrite');
  const sessionPath = writeSession(tempDir, 's2.jsonl', [
    assistantLine(BASE + 1_000, [{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }]),
    toolResultLine(BASE + 2_000, 'c1', 'read', 'x'),
    assistantLine(BASE + 5_000, [{ id: 'c2', name: 'edit', arguments: { path: 'server/a.ts' } }]),
    toolResultLine(BASE + 6_000, 'c2', 'edit', 'ok'),
  ]);
  const taskId = 'task-firstwrite-1';

  createTaskRow(store, { taskId, sessionPath });
  createAssistantMessage(store, conversation.id, 'msg-1', { taskId });

  const response = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));
  const breakdown = response.json.breakdown;

  assert.equal(breakdown.metrics.firstWriteMs, 4000); // 1000 → 5000
  assert.equal(breakdown.steps[1].category, 'write');
  assert.equal(breakdown.steps[1].subcategory, 'product-code');
});

test('opaque commands classify as unclassified/disabled when JEV is off (default)', async (t) => {
  const { store, conversation, handler, tempDir } = createFixture(t, 'jev-off');
  const sessionPath = writeSession(tempDir, 's3.jsonl', [
    assistantLine(BASE + 1_000, [{ id: 'c1', name: 'bash', arguments: { command: 'python scripts/run_suite.py' } }]),
    toolResultLine(BASE + 5_000, 'c1', 'bash', '12 passed'),
  ]);
  const taskId = 'task-jev-off-1';

  createTaskRow(store, { taskId, sessionPath });
  createAssistantMessage(store, conversation.id, 'msg-1', { taskId });

  const response = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));
  const breakdown = response.json.breakdown;

  assert.equal(breakdown.steps[0].category, 'unclassified');
  assert.equal(breakdown.steps[0].jevStatus, 'disabled');
});

test('corrupt middle lines flip status to partial-truncated', async (t) => {
  const { store, conversation, handler, tempDir } = createFixture(t, 'corrupt');
  const sessionPath = writeSession(tempDir, 's4.jsonl', [
    assistantLine(BASE + 1_000, [{ id: 'c1', name: 'bash', arguments: { command: 'npm test' } }]),
    '{not json',
    toolResultLine(BASE + 5_000, 'c1', 'bash', '# pass 1'),
  ]);
  const taskId = 'task-corrupt-1';

  createTaskRow(store, { taskId, sessionPath });
  createAssistantMessage(store, conversation.id, 'msg-1', { taskId });

  const response = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.breakdown.status, 'partial-truncated');
  assert.equal(response.json.breakdown.steps.length, 1);
});

test('a completed message with an open step reports partial-interrupted', async (t) => {
  const { store, conversation, handler, tempDir } = createFixture(t, 'interrupted');
  const sessionPath = writeSession(tempDir, 's5.jsonl', [
    assistantLine(BASE + 1_000, [{ id: 'c1', name: 'bash', arguments: { command: 'npm test' } }]),
    // no toolResult — the turn was interrupted mid-run
  ]);
  const taskId = 'task-interrupted-1';

  createTaskRow(store, { taskId, sessionPath });
  createAssistantMessage(store, conversation.id, 'msg-1', { taskId });

  const response = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));
  const breakdown = response.json.breakdown;

  assert.equal(breakdown.status, 'partial-interrupted');
  assert.equal(breakdown.steps[0].durationMs, null);
});

test('missing session and no stored summary → 404; non-assistant → 400; unknown message → 404', async (t) => {
  const { store, conversation, handler } = createFixture(t, 'errors');

  createAssistantMessage(store, conversation.id, 'msg-no-task', { taskId: null });

  const noTask = await invoke(handler, breakdownUrl(conversation.id, 'msg-no-task'));

  assert.equal(noTask.statusCode, 404);

  store.createMessage({
    id: 'msg-user',
    conversationId: conversation.id,
    turnId: 'turn-x',
    role: 'user',
    content: 'hi',
    status: 'completed',
    createdAt: '2026-10-20T10:00:00.000Z',
  });

  const userMessage = await invoke(handler, breakdownUrl(conversation.id, 'msg-user'));

  assert.equal(userMessage.statusCode, 400);

  const missing = await invoke(handler, breakdownUrl(conversation.id, 'msg-missing'));

  assert.equal(missing.statusCode, 404);
});

test('cross-chunk merge: a result parsed in a later pass joins the stored open row', async (t) => {
  const { store, conversation, handler, tempDir } = createFixture(t, 'merge');
  const sessionPath = writeSession(tempDir, 's6.jsonl', [
    assistantLine(BASE + 1_000, [{ id: 'c1', name: 'bash', arguments: { command: 'npm test' } }]),
  ]);
  const taskId = 'task-merge-1';

  createTaskRow(store, { taskId, sessionPath });
  // Message still in progress: first click parses an open step, status live.
  createAssistantMessage(store, conversation.id, 'msg-1', { taskId, status: 'streaming' });

  const first = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));

  assert.equal(first.json.breakdown.status, 'live');
  assert.equal(first.json.breakdown.steps.length, 1);
  assert.equal(first.json.breakdown.steps[0].durationMs, null);

  // The tool finishes; the session grows by the toolResult line.
  fs.appendFileSync(sessionPath, toolResultLine(BASE + 8_000, 'c1', 'bash', '# pass 5\n# fail 0') + '\n');

  const second = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));

  assert.equal(second.json.breakdown.steps.length, 1, 'orphan result must merge into the open row, not add a row');
  assert.equal(second.json.breakdown.steps[0].durationMs, 7000);
  assert.equal(second.json.breakdown.steps[0].category, 'test');
  assert.equal(second.json.breakdown.categoryMs.test, 7000);
});

test('orphan merge preserves write_scope; a sandbox write never moves firstWriteMs', async (t) => {
  const { store, conversation, handler, tempDir } = createFixture(t, 'merge-scope');
  // An earlier pass stored an open sandbox write (probe script); the
  // session slice now visible contains only the orphan toolResult (the
  // call line was lost to truncation — the AC5 truncation shape).
  const sessionPath = writeSession(tempDir, 's9.jsonl', [
    toolResultLine(BASE + 8_000, 'c9', 'edit', 'ok'),
  ]);
  const taskId = 'task-merge-scope-1';

  createTaskRow(store, { taskId, sessionPath });
  createAssistantMessage(store, conversation.id, 'msg-1', { taskId, status: 'streaming' });
  store.turnTimeBreakdownRepository.upsertStep({
    taskId,
    messageId: 'msg-1',
    stepKey: 'c9',
    toolName: 'edit',
    category: 'write',
    subcategory: 'product-code',
    classifiedBy: 'rules',
    writeScope: 'sandbox',
    startedAt: new Date(BASE + 1_000).toISOString(),
    endedAt: null,
  });

  const response = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));
  const breakdown = response.json.breakdown;

  assert.equal(breakdown.steps.length, 1, 'orphan result must merge into the stored open row');
  assert.equal(breakdown.steps[0].writeScope, 'sandbox', 'merge must not wash write_scope back to NULL');
  assert.equal(breakdown.steps[0].durationMs, 7000);
  assert.equal(breakdown.metrics.firstWriteMs, null, 'a sandbox write must not count as first repo write');

  const stored = store.turnTimeBreakdownRepository.getStep(taskId, 'c9');

  assert.equal(stored.write_scope, 'sandbox', 'the stored row keeps its scope through the merge upsert');
});

test('orphan merge re-anchors the span at the open row start: firstWriteMs never goes negative', async (t) => {
  const { store, conversation, handler, tempDir } = createFixture(t, 'merge-repo');
  const sessionPath = writeSession(tempDir, 's10.jsonl', [
    toolResultLine(BASE + 8_000, 'c9', 'edit', 'ok'),
  ]);
  const taskId = 'task-merge-repo-1';

  createTaskRow(store, { taskId, sessionPath });
  createAssistantMessage(store, conversation.id, 'msg-1', { taskId, status: 'streaming' });
  store.turnTimeBreakdownRepository.upsertStep({
    taskId,
    messageId: 'msg-1',
    stepKey: 'c9',
    toolName: 'edit',
    category: 'write',
    subcategory: 'product-code',
    classifiedBy: 'rules',
    writeScope: 'repo',
    startedAt: new Date(BASE + 1_000).toISOString(),
    endedAt: null,
  });

  const response = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));
  const breakdown = response.json.breakdown;

  assert.equal(breakdown.steps.length, 1);
  assert.equal(breakdown.steps[0].writeScope, 'repo');
  // Without the min re-anchor the span would start at the orphan result
  // (+8s) and firstWriteMs would read -7000.
  assert.equal(breakdown.metrics.firstWriteMs, 0, 'span re-anchors at the open row start (min of trace events)');
  assert.ok(breakdown.metrics.firstWriteMs >= 0, 'firstWriteMs must never go negative');
});

test('live refresh keeps the original turn span, firstWriteMs, and error intervals', async (t) => {
  const { store, conversation, handler, tempDir } = createFixture(t, 'live-refresh');
  const sessionPath = writeSession(tempDir, 's7.jsonl', [
    assistantLine(BASE + 1_000, [{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }]),
    toolResultLine(BASE + 2_000, 'c1', 'read', 'x'),
    assistantLine(BASE + 4_000, [{ id: 'c2', name: 'edit', arguments: { path: 'server/a.ts' } }]),
    toolResultLine(BASE + 5_000, 'c2', 'edit', 'ok'),
    // §2(b): a model-side error interval at +6s (previous step end +5s → 6s).
    assistantLine(BASE + 6_000, [], { stopReason: 'error' }),
  ]);
  const taskId = 'task-live-refresh-1';

  createTaskRow(store, { taskId, sessionPath });
  createAssistantMessage(store, conversation.id, 'msg-1', { taskId, status: 'streaming' });

  const first = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));

  assert.equal(first.statusCode, 200);
  assert.equal(first.json.breakdown.status, 'live');
  assert.equal(first.json.breakdown.metrics.firstWriteMs, 3000); // +1s → +4s
  const firstExceptionMs = first.json.breakdown.categoryMs['exception-retry'];

  assert.equal(firstExceptionMs, 1000); // +5s → +6s

  // The turn continues: a full regression runs much later.
  fs.appendFileSync(
    sessionPath,
    assistantLine(BASE + 20_000, [{ id: 'c3', name: 'bash', arguments: { command: 'npm test' } }]) + '\n'
      + toolResultLine(BASE + 25_000, 'c3', 'bash', '# pass 5\n# fail 0') + '\n'
  );

  const second = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));
  const breakdown = second.json.breakdown;

  // Regression guard: the refresh must not re-anchor the span at the
  // delta's first event (firstWriteMs went negative, exception-retry
  // vanished when only the delta was parsed).
  assert.equal(breakdown.metrics.firstWriteMs, 3000, 'firstWriteMs must stay anchored at the trace start');
  assert.ok(breakdown.metrics.firstWriteMs >= 0);
  assert.equal(breakdown.categoryMs['exception-retry'], firstExceptionMs, 'error intervals must not shrink on refresh');
  assert.equal(breakdown.categoryMs.test, 5000);
  assert.equal(breakdown.steps.length, 3);
});

test('a failed message seals partial-interrupted with a bounded span (AC5)', async (t) => {
  const { store, conversation, handler, tempDir } = createFixture(t, 'failed');
  const sessionPath = writeSession(tempDir, 's8.jsonl', [
    assistantLine(BASE + 1_000, [{ id: 'c1', name: 'bash', arguments: { command: 'npm test' } }]),
    toolResultLine(BASE + 30_000, 'c1', 'bash', '# pass 1\n# fail 0'),
  ]);
  const taskId = 'task-failed-1';

  createTaskRow(store, { taskId, sessionPath });
  createAssistantMessage(store, conversation.id, 'msg-1', {
    taskId,
    status: 'failed',
    createdAt: '2026-10-20T10:00:35.000Z',
  });

  const response = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));
  const breakdown = response.json.breakdown;

  assert.equal(response.statusCode, 200);
  assert.equal(breakdown.status, 'partial-interrupted', 'a failed turn must be honestly annotated, not live forever');
  assert.equal(breakdown.categoryMs.test, 29_000);
  // Span seals at message finalization (+35s), not at "now" — thinking is
  // bounded to 5s no matter when the view is opened.
  assert.equal(breakdown.categoryMs.thinking, 5000);

  // Terminal status → cached path serves the same sealed numbers.
  const cached = await invoke(handler, breakdownUrl(conversation.id, 'msg-1'));

  assert.equal(cached.json.breakdown.status, 'partial-interrupted');
  assert.equal(cached.json.breakdown.categoryMs.thinking, 5000);
});
