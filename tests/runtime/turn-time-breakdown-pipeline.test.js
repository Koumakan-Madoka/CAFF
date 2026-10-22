const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createTurnTimeBreakdownPipeline } = require('../../build/server/domain/runtime/turn-time-breakdown-pipeline');
const {
  JEV_SERVICE_TYPE,
  createJevEnabledResolver,
  readJevClientMaterial,
} = require('../../build/server/domain/runtime/jev-service-config');
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

test('firstWriteMs counts repo writes only: sandbox scratch never advances it (storage round-trip)', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  let nowMs = 70_000;
  const pipeline = createPipeline(store, { now: () => nowMs });

  // Sandbox probe edit at +1s relative to turn start, repo edit at +60s.
  // Without write_scope persistence the metric would read 1000ms.
  pipeline.enqueueStep({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1', step: step({
    stepKey: 'call-scratch',
    toolCallId: 'call-scratch',
    toolName: 'edit',
    args: { path: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/role-x/private/probe.mts' },
    output: '',
    startedAtMs: 2_000,
    endedAtMs: 3_000,
  }) });
  pipeline.enqueueStep({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1', step: step({
    stepKey: 'call-repo',
    toolCallId: 'call-repo',
    toolName: 'edit',
    args: { path: 'server/index.ts' },
    output: '',
    startedAtMs: 61_000,
    endedAtMs: 62_000,
  }) });
  await pipeline.flushForTests();

  // The scope must be real stored data, not just an in-memory pass value.
  const byKey = Object.fromEntries(repo.listSteps('task-1').map((row) => [row.step_key, row]));

  assert.equal(byKey['call-scratch'].write_scope, 'sandbox');
  assert.equal(byKey['call-repo'].write_scope, 'repo');

  pipeline.completeTask({ taskId: 'task-1', messageId: 'msg-1', conversationId: 'conv-1' });
  await pipeline.flushForTests();

  const done = repo.getSummary('msg-1');

  assert.equal(done.metrics.firstWriteMs, 59_000);
});

test('a turn whose only writes land in the sandbox reports firstWriteMs null', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  const pipeline = createPipeline(store, { now: () => 10_000 });

  pipeline.enqueueStep({ taskId: 'task-2', messageId: 'msg-2', conversationId: 'conv-1', step: step({
    stepKey: 'call-scratch',
    toolCallId: 'call-scratch',
    toolName: 'edit',
    args: { path: '.pi-sandbox/agent-sandboxes/role-x/private/probe.mts' },
    output: '',
    startedAtMs: 2_000,
    endedAtMs: 3_000,
  }) });
  pipeline.completeTask({ taskId: 'task-2', messageId: 'msg-2', conversationId: 'conv-1' });
  await pipeline.flushForTests();

  const done = repo.getSummary('msg-2');

  assert.equal(done.metrics.firstWriteMs ?? null, null);
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

test('single-point resolver: DB toggle on but no stored API key lands as disabled, never pending', async (t) => {
  // Production wiring regression (contract §6): the UI can reach
  // toggle-on + key-missing with one click. The resolver must include
  // the key gate, or rows would be written 'pending' while no
  // classifier exists to ever resolve them (the status card would say
  // api_key_missing at the same time).
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;

  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);

  let clientBuilt = 0;
  const pipeline = createPipeline(store, {
    resolveJevEnabled: createJevEnabledResolver({ store }),
    createJevClient: () => {
      clientBuilt += 1;
      return null;
    },
  });

  pipeline.enqueueStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    step: step({ stepKey: 'call-1', toolCallId: 'call-1', args: { command: 'python scripts/run_suite.py' } }),
  });
  await pipeline.flushForTests();

  const row = repo.listSteps('task-1')[0];

  assert.equal(row.category, 'unclassified');
  assert.equal(row.jev_status, 'disabled');
  assert.equal(clientBuilt, 0);
});

test('env TYPESAPE_* fully set but no DB credential: pipeline stays disabled and never builds a client', async (t) => {
  // Contract §6 (user-ruled 2026-10-22): the classification pipeline
  // NEVER reads the environment — the panel is the only switch and the
  // DB row the only key source. A leftover env key must not silently
  // drive classification.
  const prevEnabled = process.env.TYPESAFE_ENABLED;
  const prevKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_ENABLED = 'true';
  process.env.TYPESAFE_API_KEY = 'sk-leftover-env-key';
  t.after(() => {
    if (prevEnabled === undefined) { delete process.env.TYPESAFE_ENABLED; } else { process.env.TYPESAFE_ENABLED = prevEnabled; }
    if (prevKey === undefined) { delete process.env.TYPESAFE_API_KEY; } else { process.env.TYPESAFE_API_KEY = prevKey; }
  });

  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);

  let clientBuilt = 0;
  const pipeline = createPipeline(store, {
    // Production-shaped wiring: the resolver and the client factory both
    // read ONLY the DB (createJevClient here mimics create-server, which
    // returns null when readJevClientMaterial finds no stored key).
    resolveJevEnabled: createJevEnabledResolver({ store }),
    getJevClientFingerprint: () => {
      const material = readJevClientMaterial(store);
      return material ? material.fingerprint : 'none';
    },
    createJevClient: () => {
      clientBuilt += 1;
      return readJevClientMaterial(store)
        ? { ask: async () => ({ answers: { category: { choice: 'test', confidence: 0.9 } } }) }
        : null;
    },
  });

  pipeline.enqueueStep({
    taskId: 'task-env',
    messageId: 'msg-env',
    conversationId: 'conv-1',
    step: step({ stepKey: 'call-1', toolCallId: 'call-1', args: { command: 'python scripts/run_suite.py' } }),
  });
  await pipeline.flushForTests();

  const row = repo.listSteps('task-env')[0];
  assert.equal(row.jev_status, 'disabled');
  assert.equal(clientBuilt, 0, 'no client may be constructed without a stored key, env be damned');

  // Storing a key through the credential path flips it on in the same
  // process — no restart, no pipeline rebuild.
  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { setApiKey: 'sk-db-key' });
  pipeline.enqueueStep({
    taskId: 'task-db',
    messageId: 'msg-db',
    conversationId: 'conv-1',
    step: step({ stepKey: 'call-2', toolCallId: 'call-2', args: { command: 'python scripts/run_suite.py' } }),
  });
  await pipeline.flushForTests();

  assert.equal(clientBuilt, 1);
  const dbRow = repo.listSteps('task-db')[0];
  assert.equal(dbRow.category, 'test');
  assert.equal(dbRow.jev_status, 'ok');
});

test('fingerprint-keyed client cache: rotation rebuilds, unchanged material reuses, clearing disables', async (t) => {
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);
  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { setApiKey: 'sk-key-v1' });

  let clientBuilt = 0;
  const pipeline = createPipeline(store, {
    resolveJevEnabled: createJevEnabledResolver({ store }),
    getJevClientFingerprint: () => {
      const material = readJevClientMaterial(store);
      return material ? material.fingerprint : 'none';
    },
    createJevClient: () => {
      clientBuilt += 1;
      return {
        ask: async () => ({ answers: { category: { choice: 'test', confidence: 0.9 } } }),
      };
    },
  });
  const opaque = (stepKey) => step({
    stepKey,
    toolCallId: stepKey,
    args: { command: `python scripts/run_suite_${stepKey}.py` },
    output: '12 passed in 3.4s',
  });

  pipeline.enqueueStep({ taskId: 'task-v1', messageId: 'm1', conversationId: 'c', step: opaque('call-v1') });
  await pipeline.flushForTests();
  assert.equal(clientBuilt, 1);

  // Same material → the cached client is reused (no rebuild per step).
  pipeline.enqueueStep({ taskId: 'task-v1b', messageId: 'm2', conversationId: 'c', step: opaque('call-v1b') });
  await pipeline.flushForTests();
  assert.equal(clientBuilt, 1);

  // Key rotation → fingerprint changes → the client is rebuilt in-process.
  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { setApiKey: 'sk-key-v2' });
  pipeline.enqueueStep({ taskId: 'task-v2', messageId: 'm3', conversationId: 'c', step: opaque('call-v2') });
  await pipeline.flushForTests();
  assert.equal(clientBuilt, 2);

  // Clearing the key → the resolver fails closed: new steps land as
  // disabled and no zombie pending rows appear.
  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { clearApiKey: true });
  pipeline.enqueueStep({ taskId: 'task-cleared', messageId: 'm4', conversationId: 'c', step: opaque('call-cleared') });
  await pipeline.flushForTests();
  const clearedRow = repo.listSteps('task-cleared')[0];
  assert.equal(clearedRow.jev_status, 'disabled');
  assert.equal(repo.listJevRetrySteps('task-cleared').length, 0);
});

test('classifier vanished with jevEnabled still true: pending rows are downgraded to disabled, never zombie', async (t) => {
  // Drift guard (contract §6): if the client factory ever fails while
  // the resolver still says enabled (factory throw caught to null, or a
  // future gate drift), the early-return branch must flip the just-
  // written 'pending' row to 'disabled' — otherwise it lingers forever
  // and every click re-collects it via listJevRetrySteps.
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  const pipeline = createPipeline(store, {
    resolveJevEnabled: () => true,
    createJevClient: () => null,
  });

  pipeline.enqueueStep({
    taskId: 'task-1',
    messageId: 'msg-1',
    conversationId: 'conv-1',
    step: step({ stepKey: 'call-1', toolCallId: 'call-1', args: { command: 'python scripts/run_suite.py' } }),
  });
  await pipeline.flushForTests();

  const row = repo.listSteps('task-1')[0];

  assert.equal(row.category, 'unclassified');
  assert.equal(row.jev_status, 'disabled');
  assert.equal(repo.listJevRetrySteps('task-1').length, 0);
});

test('full chain: real DB toggle + credential + real resolver drives JEV on/off in the same process', async (t) => {
  // Contract §6 acceptance chain: DB toggle ON + stored key → opaque
  // steps actually go through JEV; toggle OFF → new steps land as
  // jev_status='disabled'. Both flips without rebuilding the pipeline.
  const store = openStore(t);
  const repo = store.turnTimeBreakdownRepository;
  store.updateSystemServiceCredential(JEV_SERVICE_TYPE, { setApiKey: 'sk-test-key' });
  const calls = [];
  const pipeline = createPipeline(store, {
    resolveJevEnabled: createJevEnabledResolver({ store }),
    createJevClient: () => ({
      ask: async (input) => {
        calls.push(input);
        return { answers: { category: { choice: 'test', confidence: 0.9 } } };
      },
    }),
  });
  const opaque = (stepKey) => step({
    stepKey,
    toolCallId: stepKey,
    args: { command: 'python scripts/run_suite.py' },
    output: '12 passed in 3.4s',
  });

  // Toggle ON → the opaque step is classified by JEV in place.
  store.setSystemServiceToggle(JEV_SERVICE_TYPE, true);
  pipeline.enqueueStep({ taskId: 'task-on', messageId: 'msg-on', conversationId: 'c', step: opaque('call-on') });
  await pipeline.flushForTests();

  const onRow = repo.listSteps('task-on')[0];

  assert.equal(onRow.category, 'test');
  assert.equal(onRow.classified_by, 'jev');
  assert.equal(onRow.jev_status, 'ok');
  assert.equal(calls.length, 1);

  // Toggle OFF in the same process → the next step never touches JEV.
  store.setSystemServiceToggle(JEV_SERVICE_TYPE, false);
  pipeline.enqueueStep({ taskId: 'task-off', messageId: 'msg-off', conversationId: 'c', step: opaque('call-off') });
  await pipeline.flushForTests();

  const offRow = repo.listSteps('task-off')[0];

  assert.equal(offRow.category, 'unclassified');
  assert.equal(offRow.jev_status, 'disabled');
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
