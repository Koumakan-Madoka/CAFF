const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  createCrossConversationDeliveryService,
  createCrossConversationDeliveryWorker,
} = require('../../build/server/domain/conversation/cross-conversation-delivery');

// Regression contract for the cross-conversation delivery lease bug:
// a fixed 30s claim lease with no renewal is judged `failed_unknown_outcome`
// by the sweeper while the target invocation is still running, and the
// completion transition plus the request response are then lost.
//
// These tests pin the fixed behavior:
// - a lease heartbeat renews the claim from claim time until processing ends
// - every claim carries a unique claim token; stale claims cannot write
// - the sweeper re-verifies expiry and claim identity atomically
// - started-then-lost deliveries stay unknown (no replay) but a trusted,
//   invocation-matching late reply is recovered exactly once

const BASE_TIME = new Date('2026-08-05T00:00:00.000Z').getTime();

function isoAt(seconds) {
  return new Date(BASE_TIME + seconds * 1000).toISOString();
}

function bindProjectScope(store, conversationId, projectScopeId) {
  store.db.prepare(`
    UPDATE chat_conversations
    SET project_scope_id = ?
    WHERE id = ?
  `).run(projectScopeId, conversationId);
}

function createFixture(options = {}) {
  const store = createChatAppStore({
    agentDir: options.agentDir || process.cwd(),
    sqlitePath: options.sqlitePath || ':memory:',
  });
  const sourceAgent = store.saveCustomRoleConfig({
    id: 'lease-source-agent',
    name: 'Source Agent',
    personaPrompt: 'Send bounded requests.',
  });
  const targetAgent = store.saveCustomRoleConfig({
    id: 'lease-target-agent',
    name: 'Target Agent',
    personaPrompt: 'Handle bounded requests.',
  });
  const sourceConversation = store.createConversation({
    id: 'lease-source-conversation',
    title: 'Source Conversation',
    participants: [sourceAgent.id],
  });
  const targetConversation = store.createConversation({
    id: 'lease-target-conversation',
    title: 'Target Conversation',
    participants: [targetAgent.id],
  });
  bindProjectScope(store, sourceConversation.id, 'project-1');
  bindProjectScope(store, targetConversation.id, 'project-1');
  const sourceMessage = store.createMessage({
    id: 'lease-source-message',
    conversationId: sourceConversation.id,
    turnId: 'lease-source-turn',
    role: 'assistant',
    agentId: sourceAgent.id,
    senderName: sourceAgent.name,
    content: 'Preparing a cross-conversation request.',
  });

  return { store, sourceAgent, targetAgent, sourceConversation, targetConversation, sourceMessage };
}

function createPrincipal(fixture, overrides = {}) {
  return {
    kind: 'agent',
    sourceConversationId: fixture.sourceConversation.id,
    sourceMessageId: fixture.sourceMessage.id,
    sourceTurnId: fixture.sourceMessage.turnId,
    sourceInvocationId: 'lease-source-invocation',
    sourceAgentId: fixture.sourceAgent.id,
    sourceAgentName: fixture.sourceAgent.name,
    incomingDeliveryId: null,
    ...overrides,
  };
}

function submitRequest(service, fixture, overrides = {}, principalOverrides = {}) {
  return service.submitFromAgent(createPrincipal(fixture, principalOverrides), {
    kind: 'request',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Long-running cross-conversation request.',
    idempotencyKey: `lease-${Math.random().toString(36).slice(2)}`,
    deadlineSeconds: 3600,
    ...overrides,
  });
}

function createGate() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createManualScheduler() {
  const handles = new Map();
  let nextId = 1;
  return {
    setInterval(fn, ms) {
      const id = nextId++;
      handles.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      handles.delete(id);
    },
    tickAll() {
      for (const handle of Array.from(handles.values())) {
        handle.fn();
      }
    },
    activeCount() {
      return handles.size;
    },
  };
}

function reopenStore(tmpDir, sqlitePath) {
  return { store: createChatAppStore({ agentDir: tmpDir, sqlitePath }) };
}

function countSourceReplies(fixture, deliveryId) {
  const sourceConversationId = fixture.sourceConversation
    ? fixture.sourceConversation.id
    : 'lease-source-conversation';
  return fixture.store.listMessages(sourceConversationId)
    .filter((message) => message.metadata && message.metadata.crossConversation
      && message.metadata.crossConversation.replyToDeliveryId === deliveryId).length;
}

function createReplyMessage(fixture, delivery, overrides = {}) {
  return fixture.store.createMessage({
    id: overrides.id || `reply-${Math.random().toString(36).slice(2)}`,
    conversationId: fixture.targetConversation.id,
    turnId: overrides.turnId || 'lease-target-reply-turn',
    role: 'assistant',
    agentId: fixture.targetAgent.id,
    senderName: fixture.targetAgent.name,
    content: overrides.content || 'Late but verified answer.',
    metadata: {
      crossConversationDeliveryId: delivery.id,
      ...(overrides.invocationId
        ? { crossConversationInvocationId: overrides.invocationId }
        : {}),
    },
    createdAt: overrides.createdAt,
  });
}

test('lease heartbeat keeps a running dispatch alive across multiple lease periods and cleans up', async () => {
  const fixture = createFixture();
  let currentTime = new Date(BASE_TIME);
  const service = createCrossConversationDeliveryService({
    store: fixture.store,
    now: () => currentTime,
  });
  const request = submitRequest(service, fixture, { idempotencyKey: 'lease-heartbeat-running' });
  const scheduler = createManualScheduler();
  const dispatchGate = createGate();
  const dispatchEntered = createGate();
  let dispatchCount = 0;
  const worker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'lease-worker-running',
    now: () => currentTime,
    leaseMs: 30_000,
    leaseRenewIntervalMs: 10_000,
    setIntervalFn: scheduler.setInterval,
    clearIntervalFn: scheduler.clearInterval,
    async dispatchTarget(input) {
      dispatchCount += 1;
      input.onInvocationStarting({ invocationId: 'long-turn-invocation' });
      dispatchEntered.resolve();
      return dispatchGate.promise;
    },
  });

  try {
    const flight = worker.processNext();
    await dispatchEntered.promise;
    assert.equal(dispatchCount, 1);

    // Heartbeat ticks keep the lease ahead of the sweeper.
    for (const seconds of [10, 20, 30]) {
      currentTime = new Date(BASE_TIME + seconds * 1000);
      scheduler.tickAll();
    }

    currentTime = new Date(BASE_TIME + 31_000);
    const recovered = worker.recoverExpiredClaims();
    assert.deepEqual(recovered.failedUnknownDeliveryIds, []);
    assert.deepEqual(recovered.requeuedDeliveryIds, []);
    assert.equal(
      fixture.store.getCrossConversationDelivery(request.delivery.id).dispatchStatus,
      'running'
    );

    currentTime = new Date(BASE_TIME + 40_000);
    scheduler.tickAll();
    currentTime = new Date(BASE_TIME + 45_000);
    const replyMessage = createReplyMessage(fixture, request.delivery, {
      invocationId: 'long-turn-invocation',
      createdAt: currentTime.toISOString(),
    });
    dispatchGate.resolve({ replyMessage });

    const outcome = await flight;
    assert.equal(outcome.status, 'completed');
    assert.equal(dispatchCount, 1);
    const delivered = fixture.store.getCrossConversationDelivery(request.delivery.id);
    assert.equal(delivered.dispatchStatus, 'completed');
    assert.equal(delivered.responseStatus, 'received');
    assert.equal(delivered.targetInvocationId, 'long-turn-invocation');
    assert.equal(countSourceReplies(fixture, request.delivery.id), 1);
    assert.equal(scheduler.activeCount(), 0, 'heartbeat must be cleared after completion');
  } finally {
    fixture.store.close();
  }
});

test('lease heartbeat covers the pre-start execution-slot wait without double dispatch', async () => {
  const fixture = createFixture();
  let currentTime = new Date(BASE_TIME);
  const service = createCrossConversationDeliveryService({
    store: fixture.store,
    now: () => currentTime,
  });
  const submitted = service.submitFromAgent(createPrincipal(fixture), {
    kind: 'notify',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Wait for an execution slot longer than one lease.',
    idempotencyKey: 'lease-heartbeat-slot-wait',
  });
  const scheduler = createManualScheduler();
  const slotGate = createGate();
  const dispatchEntered = createGate();
  let dispatchCount = 0;
  const worker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'lease-worker-slot',
    now: () => currentTime,
    leaseMs: 30_000,
    leaseRenewIntervalMs: 10_000,
    setIntervalFn: scheduler.setInterval,
    clearIntervalFn: scheduler.clearInterval,
    async dispatchTarget(input) {
      dispatchCount += 1;
      dispatchEntered.resolve();
      await slotGate.promise;
      input.onInvocationStarting({ invocationId: 'slot-start-invocation' });
      return { replyMessage: null };
    },
  });

  try {
    const flight = worker.processNext();
    await dispatchEntered.promise;

    // The target room is busy; the dispatch waits for a slot across one lease.
    for (const seconds of [10, 20, 30]) {
      currentTime = new Date(BASE_TIME + seconds * 1000);
      scheduler.tickAll();
    }
    currentTime = new Date(BASE_TIME + 31_000);
    const recovered = worker.recoverExpiredClaims();
    assert.deepEqual(recovered.requeuedDeliveryIds, []);
    assert.deepEqual(recovered.failedUnknownDeliveryIds, []);

    // Slot becomes available; the original dispatch starts and completes.
    currentTime = new Date(BASE_TIME + 40_000);
    scheduler.tickAll();
    slotGate.resolve();
    const outcome = await flight;
    assert.equal(outcome.status, 'completed');

    const delivered = fixture.store.getCrossConversationDelivery(submitted.delivery.id);
    assert.equal(delivered.dispatchStatus, 'completed');
    assert.equal(delivered.targetInvocationId, 'slot-start-invocation');
    assert.equal(delivered.attemptCount, 1);
    assert.equal(dispatchCount, 1, 'the pre-start wait must not cause a redispatch');
    assert.equal(await worker.processNext(), null);
    assert.equal(dispatchCount, 1);
    assert.equal(scheduler.activeCount(), 0, 'heartbeat must be cleared after completion');
  } finally {
    fixture.store.close();
  }
});

test('a stale claim that lost its lease cannot start or complete after the delivery is reclaimed', async () => {
  const fixture = createFixture();
  let currentTime = new Date(BASE_TIME);
  const service = createCrossConversationDeliveryService({
    store: fixture.store,
    now: () => currentTime,
  });
  const submitted = service.submitFromAgent(createPrincipal(fixture), {
    kind: 'notify',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Reclaimed while the stale worker is still in flight.',
    idempotencyKey: 'lease-stale-claim',
  });
  const scheduler = createManualScheduler();
  const contexts = [];
  const gates = [createGate(), createGate()];
  let dispatchCount = 0;
  const worker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'lease-worker-stale',
    now: () => currentTime,
    leaseMs: 30_000,
    leaseRenewIntervalMs: 10_000,
    setIntervalFn: scheduler.setInterval,
    clearIntervalFn: scheduler.clearInterval,
    async dispatchTarget(input) {
      const index = dispatchCount;
      dispatchCount += 1;
      contexts.push(input);
      await gates[index].promise;
      return { replyMessage: null };
    },
  });

  try {
    const flight1 = worker.processNext();
    while (contexts.length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // First flight wedges without renewing; the lease expires and the
    // sweeper legitimately requeues the never-started delivery.
    currentTime = new Date(BASE_TIME + 31_000);
    const recovered = worker.recoverExpiredClaims();
    assert.deepEqual(recovered.requeuedDeliveryIds, [submitted.delivery.id]);

    const flight2 = worker.processNext();
    while (contexts.length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(dispatchCount, 2);

    // The stale flight wakes up and tries to mark its own invocation start.
    // It holds a superseded claim, so the write must be rejected.
    assert.throws(
      () => contexts[0].onInvocationStarting({ invocationId: 'stale-invocation' }),
      /stale|claim/i
    );
    gates[0].resolve();
    const outcome1 = await flight1;
    assert.equal(outcome1.status, 'claim_lost');
    assert.equal(
      fixture.store.getCrossConversationDelivery(submitted.delivery.id).targetInvocationId,
      null,
      'stale flight must not stamp its invocation'
    );

    // The fresh claim proceeds normally.
    contexts[1].onInvocationStarting({ invocationId: 'fresh-invocation' });
    gates[1].resolve();
    const outcome2 = await flight2;
    assert.equal(outcome2.status, 'completed');

    const delivered = fixture.store.getCrossConversationDelivery(submitted.delivery.id);
    assert.equal(delivered.dispatchStatus, 'completed');
    assert.equal(delivered.targetInvocationId, 'fresh-invocation');
    assert.equal(delivered.attemptCount, 2);
    const startedEvents = fixture.store.listCrossConversationDeliveryEvents(submitted.delivery.id)
      .filter((event) => event.eventType === 'dispatch_started');
    assert.equal(startedEvents.length, 1);
    assert.equal(startedEvents[0].event.targetInvocationId, 'fresh-invocation');
    assert.equal(scheduler.activeCount(), 0, 'both flights must clear their heartbeats');
  } finally {
    fixture.store.close();
  }
});

test('sweeper re-verifies expiry atomically so a renewed lease defeats a stale sweep snapshot', async () => {
  const fixture = createFixture();
  let currentTime = new Date(BASE_TIME);
  const service = createCrossConversationDeliveryService({
    store: fixture.store,
    now: () => currentTime,
  });
  const submitted = service.submitFromAgent(createPrincipal(fixture), {
    kind: 'notify',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Sweeper read an expired snapshot; renewal lands before the update.',
    idempotencyKey: 'lease-stale-sweep',
  });
  const scheduler = createManualScheduler();
  const dispatchGate = createGate();
  const dispatchEntered = createGate();
  const worker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'lease-worker-sweep',
    now: () => currentTime,
    leaseMs: 30_000,
    leaseRenewIntervalMs: 10_000,
    setIntervalFn: scheduler.setInterval,
    clearIntervalFn: scheduler.clearInterval,
    async dispatchTarget(input) {
      input.onInvocationStarting({ invocationId: 'sweep-race-invocation' });
      dispatchEntered.resolve();
      return dispatchGate.promise;
    },
  });

  try {
    const flight = worker.processNext();
    await dispatchEntered.promise;

    // The sweeper reads the expired-claims snapshot while the lease is expired.
    currentTime = new Date(BASE_TIME + 31_000);
    const staleSnapshot = fixture.store.listExpiredCrossConversationDeliveryClaims(isoAt(31));
    assert.equal(staleSnapshot.length, 1);

    // Before the sweeper writes, the worker's heartbeat renews the lease.
    currentTime = new Date(BASE_TIME + 32_000);
    scheduler.tickAll();
    assert.equal(
      fixture.store.getCrossConversationDelivery(submitted.delivery.id).claimExpiresAt > isoAt(33),
      true,
      'renewal must extend the lease past the sweep time'
    );

    // The sweeper now applies its stale snapshot; the update must re-verify.
    const realList = fixture.store.listExpiredCrossConversationDeliveryClaims.bind(fixture.store);
    fixture.store.listExpiredCrossConversationDeliveryClaims = () => staleSnapshot;
    let recovered;
    try {
      currentTime = new Date(BASE_TIME + 33_000);
      recovered = worker.recoverExpiredClaims();
    } finally {
      fixture.store.listExpiredCrossConversationDeliveryClaims = realList;
    }
    assert.deepEqual(recovered.failedUnknownDeliveryIds, []);
    assert.equal(
      fixture.store.getCrossConversationDelivery(submitted.delivery.id).dispatchStatus,
      'running',
      'a renewed lease must defeat the stale sweep snapshot'
    );

    currentTime = new Date(BASE_TIME + 40_000);
    dispatchGate.resolve({ replyMessage: null });
    const outcome = await flight;
    assert.equal(outcome.status, 'completed');
  } finally {
    fixture.store.close();
  }
});

test('restart recovery projects an invocation-verified late reply exactly once and never replays', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-lease-recovery-'));
  const sqlitePath = path.join(tmpDir, 'chat.sqlite');
  let currentTime = new Date(BASE_TIME);

  let deliveryId = null;
  {
    const fixture = createFixture({ agentDir: tmpDir, sqlitePath });
    const service = createCrossConversationDeliveryService({
      store: fixture.store,
      now: () => currentTime,
    });
    const request = submitRequest(service, fixture, { idempotencyKey: 'lease-restart-recovery' });
    deliveryId = request.delivery.id;
    const scheduler = createManualScheduler();
    const dispatchEntered = createGate();
    const worker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      workerId: 'lease-worker-crash',
      now: () => currentTime,
      leaseMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      setIntervalFn: scheduler.setInterval,
      clearIntervalFn: scheduler.clearInterval,
      async dispatchTarget(input) {
        input.onInvocationStarting({ invocationId: 'crash-invocation' });
        dispatchEntered.resolve();
        return createGate().promise; // worker "crashes": never resolves
      },
    });

    try {
      void worker.processNext();
      await dispatchEntered.promise;
      currentTime = new Date(BASE_TIME + 31_000);
      const recovered = worker.recoverExpiredClaims();
      assert.deepEqual(recovered.failedUnknownDeliveryIds, [deliveryId]);

      // The target invocation actually finished after the crash and left a
      // reply carrying both the delivery id and the invocation id evidence.
      currentTime = new Date(BASE_TIME + 40_000);
      createReplyMessage(fixture, request.delivery, {
        invocationId: 'crash-invocation',
        createdAt: currentTime.toISOString(),
      });
    } finally {
      fixture.store.close();
    }
  }

  // Restart: a fresh store and worker recover from the same database file.
  {
    const fixture = reopenStore(tmpDir, sqlitePath);
    const worker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      workerId: 'lease-worker-restarted',
      now: () => currentTime,
      leaseMs: 30_000,
      async dispatchTarget() {
        throw new Error('started deliveries must never be replayed');
      },
    });

    try {
      const recovered = worker.recoverPendingResponses();
      assert.deepEqual(recovered, [deliveryId]);
      const delivered = fixture.store.getCrossConversationDelivery(deliveryId);
      assert.equal(delivered.dispatchStatus, 'failed', 'recovery must not rewrite the unknown outcome to success');
      assert.equal(delivered.responseStatus, 'late');
      assert.equal(countSourceReplies(fixture, deliveryId), 1);

      // Recovery is idempotent across repeated scans.
      assert.deepEqual(worker.recoverPendingResponses(), []);
      assert.equal(countSourceReplies(fixture, deliveryId), 1);

      // The started delivery is never claimed again for replay.
      assert.equal(await worker.processNext(), null);
    } finally {
      fixture.store.close();
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('restart recovery rejects replies without matching invocation evidence', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-lease-evidence-'));
  const sqlitePath = path.join(tmpDir, 'chat.sqlite');
  let currentTime = new Date(BASE_TIME);

  const deliveryIds = { wrongInvocation: null, missingInvocation: null };
  {
    const fixture = createFixture({ agentDir: tmpDir, sqlitePath });
    const service = createCrossConversationDeliveryService({
      store: fixture.store,
      now: () => currentTime,
    });
    const scheduler = createManualScheduler();
    const entered = [];
    const worker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      workerId: 'lease-worker-evidence',
      now: () => currentTime,
      leaseMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      setIntervalFn: scheduler.setInterval,
      clearIntervalFn: scheduler.clearInterval,
      async dispatchTarget(input) {
        input.onInvocationStarting({ invocationId: `real-${input.delivery.id}` });
        entered.push(input.delivery.id);
        return createGate().promise;
      },
    });

    try {
      const wrong = submitRequest(service, fixture, { idempotencyKey: 'lease-wrong-invocation' }, {
        sourceInvocationId: 'source-wrong-invocation',
      });
      deliveryIds.wrongInvocation = wrong.delivery.id;
      void worker.processNext();
      while (entered.length < 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      currentTime = new Date(BASE_TIME + 31_000);
      assert.deepEqual(worker.recoverExpiredClaims().failedUnknownDeliveryIds, [wrong.delivery.id]);
      // A reply that carries the delivery id but a DIFFERENT invocation id.
      createReplyMessage(fixture, wrong.delivery, {
        invocationId: 'some-other-invocation',
        createdAt: isoAt(40),
      });

      const missing = submitRequest(service, fixture, { idempotencyKey: 'lease-missing-invocation' }, {
        sourceInvocationId: 'source-missing-invocation',
      });
      deliveryIds.missingInvocation = missing.delivery.id;
      void worker.processNext();
      while (entered.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      currentTime = new Date(BASE_TIME + 62_000);
      assert.deepEqual(worker.recoverExpiredClaims().failedUnknownDeliveryIds, [missing.delivery.id]);
      // A reply that carries only the delivery id; no invocation evidence.
      createReplyMessage(fixture, missing.delivery, {
        createdAt: isoAt(70),
      });
    } finally {
      fixture.store.close();
    }
  }

  {
    const fixture = reopenStore(tmpDir, sqlitePath);
    const worker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      workerId: 'lease-worker-evidence-restarted',
      now: () => currentTime,
      async dispatchTarget() {
        throw new Error('must not replay');
      },
    });

    try {
      const recovered = worker.recoverPendingResponses();
      assert.equal(recovered.includes(deliveryIds.wrongInvocation), false,
        'a reply from a different invocation must not be projected');
      assert.equal(recovered.includes(deliveryIds.missingInvocation), false,
        'a reply without invocation evidence must not be projected');
      assert.equal(countSourceReplies(fixture, deliveryIds.wrongInvocation), 0);
      assert.equal(countSourceReplies(fixture, deliveryIds.missingInvocation), 0);
      for (const id of Object.values(deliveryIds)) {
        const delivered = fixture.store.getCrossConversationDelivery(id);
        assert.equal(delivered.dispatchStatus, 'failed');
        assert.equal(delivered.responseStatus, 'cancelled', 'unverifiable replies keep the unknown outcome');
      }
    } finally {
      fixture.store.close();
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('heartbeat is cleared on pre-start failure and cancel paths', async () => {
  const fixture = createFixture();
  let currentTime = new Date(BASE_TIME);
  const service = createCrossConversationDeliveryService({
    store: fixture.store,
    now: () => currentTime,
  });
  const failing = service.submitFromAgent(createPrincipal(fixture), {
    kind: 'notify',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Fail before start.',
    idempotencyKey: 'lease-cleanup-failure',
  });
  const scheduler = createManualScheduler();
  const worker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'lease-worker-cleanup',
    now: () => currentTime,
    leaseMs: 30_000,
    leaseRenewIntervalMs: 10_000,
    maxAttempts: 1,
    setIntervalFn: scheduler.setInterval,
    clearIntervalFn: scheduler.clearInterval,
    async dispatchTarget() {
      throw new Error('synthetic pre-start failure');
    },
  });

  try {
    const failed = await worker.processNext();
    assert.equal(failed.status, 'failed');
    assert.equal(scheduler.activeCount(), 0, 'pre-start failure must clear the heartbeat');
    assert.equal(fixture.store.getCrossConversationDelivery(failing.delivery.id).dispatchStatus, 'failed');

    const cancellable = submitRequest(service, fixture, {
      idempotencyKey: 'lease-cleanup-cancel',
    }, {
      sourceInvocationId: 'source-cleanup-cancel',
    });
    const cancelScheduler = createManualScheduler();
    const dispatchGate = createGate();
    const dispatchEntered = createGate();
    const cancelWorker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      workerId: 'lease-worker-cleanup-cancel',
      now: () => currentTime,
      leaseMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      setIntervalFn: cancelScheduler.setInterval,
      clearIntervalFn: cancelScheduler.clearInterval,
      async dispatchTarget(input) {
        input.onInvocationStarting({ invocationId: 'cancel-cleanup-invocation' });
        dispatchEntered.resolve();
        return dispatchGate.promise;
      },
    });
    const flight = cancelWorker.processNext();
    await dispatchEntered.promise;
    assert.equal(cancelScheduler.activeCount() > 0, true, 'heartbeat runs while dispatch is in flight');
    await cancelWorker.cancel(cancellable.delivery.id, 'cleanup check');
    dispatchGate.resolve({ replyMessage: null });
    const outcome = await flight;
    assert.equal(outcome.status, 'cancelled');
    assert.equal(cancelScheduler.activeCount(), 0, 'cancel path must clear the heartbeat');
  } finally {
    fixture.store.close();
  }
});
