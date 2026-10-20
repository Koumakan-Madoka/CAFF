const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

function openStore(t) {
  const tempDir = withTempDir('caff-turn-time-store-');
  const store = createChatAppStore({
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'chat.sqlite'),
  });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return store;
}

function stepRow(overrides = {}) {
  return {
    taskId: 'task-1',
    messageId: 'msg-1',
    stepKey: 'call-1',
    toolName: 'bash',
    category: 'test',
    subcategory: null,
    classifiedBy: 'rules',
    jevStatus: null,
    confidence: null,
    startedAt: '2026-10-20T10:00:00.000Z',
    endedAt: '2026-10-20T10:00:05.000Z',
    durationMs: 5000,
    runKind: 'full-regression',
    runFailed: false,
    testRunCounts: { full: 1, targeted: 0 },
    ...overrides,
  };
}

test('migration creates the three turn time breakdown tables', (t) => {
  const store = openStore(t);
  const tables = store.db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%turn_time%' OR name = 'jev_classification_cache'`)
    .all()
    .map((row) => row.name)
    .sort();

  assert.deepEqual(tables, ['chat_turn_time_steps', 'chat_turn_time_summaries', 'jev_classification_cache'].sort());

  const stepColumns = store.db.prepare(`PRAGMA table_info(chat_turn_time_steps)`).all().map((row) => row.name);

  for (const column of ['task_id', 'step_key', 'category', 'classified_by', 'jev_status', 'run_kind', 'run_count_full', 'run_count_targeted', 'payload_json']) {
    assert.ok(stepColumns.includes(column), `missing column ${column}`);
  }
});

test('step upsert is idempotent on (task_id, step_key) and updates in place', (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;

  repo.upsertStep(stepRow());
  repo.upsertStep(stepRow({ category: 'read', subcategory: 'cold-start-reread', runKind: null, testRunCounts: null }));

  const rows = repo.listSteps('task-1');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'read');
  assert.equal(rows[0].subcategory, 'cold-start-reread');
  assert.equal(rows[0].run_kind, null);
});

test('summary lifecycle: live insert then terminal update preserves task link', (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;

  repo.upsertSummary({
    messageId: 'msg-1',
    taskId: 'task-1',
    conversationId: 'conv-1',
    status: 'live',
    turnStartedAt: '2026-10-20T10:00:00.000Z',
    turnEndedAt: null,
    categoryMs: { test: 5000 },
    metrics: { fullRunCount: 1 },
    parseOffset: 1234,
  });

  const live = repo.getSummary('msg-1');

  assert.equal(live.status, 'live');
  assert.equal(live.parseOffset, 1234);
  assert.deepEqual(live.categoryMs, { test: 5000 });

  repo.upsertSummary({
    messageId: 'msg-1',
    taskId: 'task-1',
    conversationId: 'conv-1',
    status: 'complete',
    turnStartedAt: '2026-10-20T10:00:00.000Z',
    turnEndedAt: '2026-10-20T10:01:00.000Z',
    categoryMs: { test: 5000, thinking: 55000 },
    metrics: { fullRunCount: 1, firstWriteMs: 30000 },
    parseOffset: 2000,
  });

  const done = repo.getSummary('msg-1');

  assert.equal(done.status, 'complete');
  assert.equal(done.taskId, 'task-1');
  assert.equal(done.parseOffset, 2000);
  assert.equal(done.metrics.fullRunCount, 1);
  assert.equal(done.metrics.firstWriteMs, 30000);

  const count = store.db.prepare(`SELECT COUNT(*) AS n FROM chat_turn_time_summaries WHERE message_id = 'msg-1'`).get();

  assert.equal(count.n, 1);
});

test('jev cache adapter returns the exact camelCase entry shape and survives runKind', (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;

  assert.equal(repo.getJevCacheEntry('missing-key'), null);

  repo.setJevCacheEntry('key-1', { category: 'test', subcategory: null, runKind: 'full-regression', confidence: 0.91 });

  const entry = repo.getJevCacheEntry('key-1');

  // Explicit shape lock (contract §6 adapter): snake_case columns must be
  // translated, and runKind must not silently drop on a cache hit.
  assert.deepEqual(Object.keys(entry).sort(), ['category', 'confidence', 'runKind', 'subcategory']);
  assert.equal(entry.category, 'test');
  assert.equal(entry.runKind, 'full-regression');
  assert.equal(entry.subcategory, null);
  assert.equal(entry.confidence, 0.91);

  // confidence is nullable (JEV may omit the field).
  repo.setJevCacheEntry('key-2', { category: 'read', subcategory: null, runKind: null, confidence: null });
  assert.equal(repo.getJevCacheEntry('key-2').confidence, null);
});

test('open-step lookup and JEV retry listing support the backfill merge', (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;

  repo.upsertStep(stepRow({ stepKey: 'call-open', endedAt: null, durationMs: null }));
  repo.upsertStep(stepRow({ stepKey: 'call-done' }));
  repo.upsertStep(stepRow({
    stepKey: 'call-jev',
    category: 'unclassified',
    classifiedBy: 'unclassified',
    jevStatus: 'timeout',
    runKind: null,
    testRunCounts: null,
    payloadJson: JSON.stringify({ args: { command: 'bash scripts/x.sh' }, output: '…' }),
  }));

  assert.equal(repo.findOpenStep('task-1', 'call-open').step_key, 'call-open');
  assert.equal(repo.findOpenStep('task-1', 'call-done'), null);
  assert.equal(repo.getStep('task-1', 'call-done').step_key, 'call-done');
  assert.equal(repo.getStep('task-1', 'nope'), null);

  const retries = repo.listJevRetrySteps('task-1');

  assert.equal(retries.length, 1);
  assert.equal(retries[0].step_key, 'call-jev');
  assert.equal(JSON.parse(retries[0].payload_json).args.command, 'bash scripts/x.sh');
});
