const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createTurnTimeBreakdownPipeline } = require('../../build/server/domain/runtime/turn-time-breakdown-pipeline');
const { TypeSafeClientError } = require('../../build/server/domain/integrations/typesafe/typesafe-client');
const { withTempDir } = require('../helpers/temp-dir');

function openStore(t) {
  const tempDir = withTempDir('caff-turn-time-pipeline-');
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

function step(overrides = {}) {
  return {
    stepKey: 'call-1',
    toolCallId: 'call-1',
    toolName: 'bash',
    args: { command: 'npm test' },
    output: '# pass 42\n# fail 0',
    isError: false,
    startedAtMs: 1000,
    endedAtMs: 5000,
    ...overrides,
  };
}

function createPipeline(store, options = {}) {
  return createTurnTimeBreakdownPipeline({
    repository: store.turnTimeBreakdownRepository,
    resolveJevEnabled: () => false,
    ...options,
  });
}

test('enqueue never touches storage synchronously; the worker drains asynchronously', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  let syncWrites = 0;
  const originalUpsert = repo.upsertStep.bind(repo);

  repo.upsertStep = (...args) => {
    syncWrites += 1;
    return originalUpsert(...args);
  };

  const pipeline = createPipeline(store);
  const accepted = pipeline.enqueueStep({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1', step: step() });

  assert.equal(accepted, true);
  // AC2: the turn path only pushes onto the queue — zero classification or
  // sqlite work has happened at this point.
  assert.equal(syncWrites, 0);
  assert.equal(repo.listSteps('task-1').length, 0);

  await pipeline.flushForTests();

  assert.equal(syncWrites, 1);
  const rows = repo.listSteps('task-1');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'test');
  assert.equal(rows[0].run_kind, 'full-regression');
  assert.equal(rows[0].classified_by, 'rules');
});

test('summary goes live on the first step and seals complete on task completion', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  let nowMs = 10_000;
  const pipeline = createPipeline(store, { now: () => nowMs });

  pipeline.enqueueStep({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1', step: step() });
  await pipeline.flushForTests();

  const live = repo.getSummary('msg-1');

  assert.equal(live.status, 'live');
  assert.equal(live.taskId, 'task-1');
  assert.equal(live.categoryMs.test, 4000);
  assert.equal(live.metrics.fullRunCount, 1);

  nowMs = 20_000;
  pipeline.completeTask({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    sessionReused: true,
    sessionReuseReason: 'reused',
  });
  await pipeline.flushForTests();

  const done = repo.getSummary('msg-1');

  assert.equal(done.status, 'complete');
  assert.equal(done.turnEndedAt, new Date(20_000).toISOString());
  assert.equal(done.metrics.sessionReused, true);
  assert.equal(done.metrics.sessionReuseReason, 'reused');
  // thinking = span (1000→20000) minus the 4s test interval.
  assert.equal(done.categoryMs.thinking, 15_000);
});

test('duplicate toolCallId upserts one row (pi + bridge double-source dedup)', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  const pipeline = createPipeline(store);

  pipeline.enqueueStep({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1', step: step() });
  pipeline.enqueueStep({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1', step: step({ endedAtMs: 7000 }) });
  await pipeline.flushForTests();

  const rows = repo.listSteps('task-1');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].duration_ms, 6000);
});

test('JEV path: pending row first, then async resolution updates in place and writes cache', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  const calls = [];
  const pipeline = createPipeline(store, {
    resolveJevEnabled: () => true,
    createJevClient: () => ({
      ask: async (input) => {
        calls.push(input);

        return {
          answers: {
            category: { choice: 'test', confidence: 0.92 },
            run_kind: { choice: 'full-regression', confidence: 0.88 },
          },
        };
      },
    }),
  });
  const opaque = step({
    stepKey: 'call-opaque',
    toolCallId: 'call-opaque',
    args: { command: 'python scripts/run_suite.py' },
    output: '12 passed in 3.4s',
  });

  pipeline.enqueueStep({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1', step: opaque });

  // The JEV call is async: right after the drain the row exists as
  // unclassified/pending; flushForTests settles the in-flight resolution.
  await pipeline.flushForTests();

  const rows = repo.listSteps('task-1');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'test');
  assert.equal(rows[0].classified_by, 'jev');
  assert.equal(rows[0].run_kind, 'full-regression');
  assert.equal(rows[0].jev_status, 'ok');
  assert.equal(calls.length, 1);

  // The retry payload was stored so a later pass can reclassify without a
  // session re-parse.
  assert.ok(rows[0].payload_json);

  // A second identical command hits the cache — zero additional JEV calls.
  pipeline.enqueueStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    step: step({ stepKey: 'call-opaque-2', toolCallId: 'call-opaque-2', args: { command: 'python scripts/run_suite.py' }, output: '12 passed in 3.4s' }),
  });
  await pipeline.flushForTests();

  const after = repo.listSteps('task-1');

  assert.equal(after.length, 2);
  assert.equal(after[1].classified_by, 'jev-cache');
  assert.equal(after[1].run_kind, 'full-regression');
  assert.equal(calls.length, 1);
});

test('JEV timeout and error degrade to unclassified with honest status, never rejecting', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  const pipeline = createPipeline(store, {
    resolveJevEnabled: () => true,
    createJevClient: () => ({
      ask: async () => {
        throw new TypeSafeClientError('typesafe_timeout', 'deadline exceeded');
      },
    }),
  });

  pipeline.enqueueStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    step: step({ stepKey: 'call-x', toolCallId: 'call-x', args: { command: 'python scripts/x.py' } }),
  });
  await pipeline.flushForTests();

  const row = repo.listSteps('task-1')[0];

  assert.equal(row.category, 'unclassified');
  assert.equal(row.jev_status, 'timeout');
});

test('JEV disabled stores unclassified/disabled and never constructs a client', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  let clientBuilt = 0;
  const pipeline = createPipeline(store, {
    resolveJevEnabled: () => false,
    createJevClient: () => {
      clientBuilt += 1;
      return { ask: async () => ({ answers: {} }) };
    },
  });

  pipeline.enqueueStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    step: step({ stepKey: 'call-x', toolCallId: 'call-x', args: { command: 'python scripts/x.py' } }),
  });
  await pipeline.flushForTests();

  const row = repo.listSteps('task-1')[0];

  assert.equal(row.category, 'unclassified');
  assert.equal(row.jev_status, 'disabled');
  assert.equal(clientBuilt, 0);
});

test('queue overflow drops classification with a counter, never throwing', async (t) => {
  const store = openStore(t);
  const pipeline = createPipeline(store, { queueCap: 1 });

  assert.equal(pipeline.enqueueStep({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'c', step: step() }), true);
  assert.equal(pipeline.enqueueStep({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'c', step: step({ stepKey: 'call-2', toolCallId: 'call-2' }) }), false);
  assert.equal(pipeline.getStats().droppedCount, 1);

  await pipeline.flushForTests();
});

test('model error events land in exception-retry alongside tool time', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  let nowMs = 10_000;
  const pipeline = createPipeline(store, { now: () => nowMs });

  pipeline.enqueueStep({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1', step: step({ startedAtMs: 1000, endedAtMs: 2000 }) });
  pipeline.enqueueErrorEvent({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1', timestampMs: 5000 });
  nowMs = 6000;
  pipeline.completeTask({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1' });
  await pipeline.flushForTests();

  const summary = repo.getSummary('msg-1');

  assert.equal(summary.status, 'complete');
  assert.equal(summary.categoryMs.test, 1000);
  assert.equal(summary.categoryMs['exception-retry'], 3000); // 2000 → 5000
  assert.equal(summary.categoryMs.thinking, 1000); // 5000 → 6000
});

test('a worker item failure is logged and swallowed; later items still process', async (t) => {
  const store = openStore(t);
  const warnings = [];
  const pipeline = createPipeline(store, {
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });

  // A step whose shape breaks classification (circular args) must not kill
  // the drain loop.
  const circular = {};

  circular.self = circular;
  pipeline.enqueueStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    step: step({ stepKey: 'call-bad', toolCallId: 'call-bad', args: circular }),
  });
  pipeline.enqueueStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    step: step({ stepKey: 'call-good', toolCallId: 'call-good' }),
  });
  await pipeline.flushForTests();

  const rows = store.turnTimeBreakdownRepository.listSteps('task-1');

  assert.ok(rows.some((row) => row.step_key === 'call-good'));
});

test('turn-start marker anchors the span at the first trace event, not the first tool step', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  let nowMs = 10_000;
  const pipeline = createPipeline(store, { now: () => nowMs });

  // First pi event of the turn at t=1000; the first tool step only starts
  // at t=2000 — the gap is model thinking and must not be eaten.
  pipeline.enqueueTurnStart({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1', startedAtMs: 1000 });
  await pipeline.flushForTests();

  const early = repo.getSummary('msg-1');

  assert.equal(early.status, 'live');
  assert.equal(early.turnStartedAt, new Date(1000).toISOString());
  assert.equal(early.categoryMs.thinking, 9000); // 1000 → now(10000), no steps yet

  pipeline.enqueueStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    step: step({ startedAtMs: 2000, endedAtMs: 3000 }),
  });
  await pipeline.flushForTests();

  const later = repo.getSummary('msg-1');

  assert.equal(later.turnStartedAt, new Date(1000).toISOString(), 'span start must not jump to the first step');
  assert.equal(later.categoryMs.test, 1000);
  assert.equal(later.categoryMs.thinking, 8000); // 1000→2000 + 3000→10000
});

test('completeTask seals failed/cancelled turns as partial-interrupted at the given end', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  let nowMs = 10_000;
  const pipeline = createPipeline(store, { now: () => nowMs });

  pipeline.enqueueStep({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1', step: step() });
  await pipeline.flushForTests();

  // The turn fails at t=9000 (stage.endedAt); "now" keeps running.
  nowMs = 400_000;
  pipeline.completeTask({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    status: 'partial-interrupted',
    endedAtMs: 9000,
  });
  await pipeline.flushForTests();

  const sealed = repo.getSummary('msg-1');

  assert.equal(sealed.status, 'partial-interrupted');
  assert.equal(sealed.turnEndedAt, new Date(9000).toISOString(), 'sealed at the stage end, not at "now"');
  // span 1000→9000 = 8000; test interval 1000→5000 = 4000; thinking = 4000.
  assert.equal(sealed.categoryMs.thinking, 4000, 'thinking must not stretch to "now" after sealing');
});

test('anonymous steps without a toolCallId get distinct keys and never overwrite', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  const pipeline = createPipeline(store);

  pipeline.enqueueStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    step: step({ stepKey: '', toolCallId: '', startedAtMs: 1000, endedAtMs: 2000 }),
  });
  pipeline.enqueueStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    step: step({ stepKey: '', toolCallId: '', startedAtMs: 3000, endedAtMs: 4000 }),
  });
  await pipeline.flushForTests();

  const rows = repo.listSteps('task-1');

  assert.equal(rows.length, 2, 'contract §7 fallback is toolName + ordinal — anonymous steps must not collapse');
  assert.notEqual(rows[0].step_key, rows[1].step_key);
});
