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
    content: overrides.content !== undefined ? overrides.content : 'Late but verified answer.',
    status: overrides.status || 'completed',
    errorMessage: overrides.errorMessage || '',
    metadata: {
      crossConversationDeliveryId: delivery.id,
      ...(overrides.invocationId
        ? { crossConversationInvocationId: overrides.invocationId }
        : {}),
    },
    createdAt: overrides.createdAt,
  });
}

function submitNotify(service, fixture, overrides = {}, principalOverrides = {}) {
  return service.submitFromAgent(createPrincipal(fixture, principalOverrides), {
    kind: 'notify',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Cross-conversation notify.',
    idempotencyKey: `lease-${Math.random().toString(36).slice(2)}`,
    ...overrides,
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
      assert.deepEqual(recovered.verifiedCompletedDeliveryIds, [deliveryId]);
      assert.deepEqual(recovered.projectedDeliveryIds, [deliveryId]);
      assert.deepEqual(recovered.verifiedFailedDeliveryIds, []);
      const delivered = fixture.store.getCrossConversationDelivery(deliveryId);
      assert.equal(delivered.dispatchStatus, 'completed',
        'trusted invocation evidence upgrades the unknown outcome to completed');
      assert.equal(delivered.lastErrorCode, null);
      assert.equal(delivered.responseStatus, 'late');
      assert.equal(countSourceReplies(fixture, deliveryId), 1);
      const eventTypes = fixture.store.listCrossConversationDeliveryEvents(deliveryId)
        .map((event) => event.eventType);
      assert.equal(eventTypes.includes('recovered_unknown_outcome'), true,
        'the original lease accident audit is preserved');
      assert.equal(eventTypes.includes('outcome_verified_completed'), true);

      // Recovery is idempotent across repeated scans.
      const again = worker.recoverPendingResponses();
      assert.deepEqual(again.projectedDeliveryIds, []);
      assert.deepEqual(again.verifiedCompletedDeliveryIds, []);
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
      assert.equal(recovered.projectedDeliveryIds.includes(deliveryIds.wrongInvocation), false,
        'a reply from a different invocation must not be projected');
      assert.equal(recovered.projectedDeliveryIds.includes(deliveryIds.missingInvocation), false,
        'a reply without invocation evidence must not be projected');
      assert.equal(recovered.verifiedCompletedDeliveryIds.length, 0);
      assert.equal(recovered.verifiedFailedDeliveryIds.length, 0);
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

test('restart recovery verifies a late failed invocation outcome without projecting a response', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-lease-verify-failed-'));
  const sqlitePath = path.join(tmpDir, 'chat.sqlite');
  let currentTime = new Date(BASE_TIME);

  let deliveryId = null;
  {
    const fixture = createFixture({ agentDir: tmpDir, sqlitePath });
    const service = createCrossConversationDeliveryService({
      store: fixture.store,
      now: () => currentTime,
    });
    const request = submitRequest(service, fixture, { idempotencyKey: 'lease-verify-failed' });
    deliveryId = request.delivery.id;
    const scheduler = createManualScheduler();
    const dispatchEntered = createGate();
    const worker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      workerId: 'lease-worker-verify-failed',
      now: () => currentTime,
      leaseMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      setIntervalFn: scheduler.setInterval,
      clearIntervalFn: scheduler.clearInterval,
      async dispatchTarget(input) {
        input.onInvocationStarting({ invocationId: 'verify-failed-invocation' });
        dispatchEntered.resolve();
        return createGate().promise; // worker "crashes": never resolves
      },
    });

    try {
      void worker.processNext();
      await dispatchEntered.promise;
      currentTime = new Date(BASE_TIME + 31_000);
      assert.deepEqual(worker.recoverExpiredClaims().failedUnknownDeliveryIds, [deliveryId]);

      // The target invocation actually failed after the crash; the failed
      // assistant message carries both the delivery id and invocation id.
      currentTime = new Date(BASE_TIME + 40_000);
      createReplyMessage(fixture, request.delivery, {
        invocationId: 'verify-failed-invocation',
        status: 'failed',
        content: '',
        errorMessage: 'target model exploded',
        createdAt: currentTime.toISOString(),
      });
    } finally {
      fixture.store.close();
    }
  }

  {
    const fixture = reopenStore(tmpDir, sqlitePath);
    const worker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      workerId: 'lease-worker-verify-failed-restarted',
      now: () => currentTime,
      leaseMs: 30_000,
      async dispatchTarget() {
        throw new Error('started deliveries must never be replayed');
      },
    });

    try {
      const recovered = worker.recoverPendingResponses();
      assert.deepEqual(recovered.verifiedFailedDeliveryIds, [deliveryId]);
      assert.deepEqual(recovered.verifiedCompletedDeliveryIds, []);
      assert.deepEqual(recovered.projectedDeliveryIds, []);

      const delivered = fixture.store.getCrossConversationDelivery(deliveryId);
      assert.equal(delivered.dispatchStatus, 'failed',
        'a verified failure keeps the failed dispatch state');
      assert.equal(delivered.lastErrorCode, 'dispatch_failed_verified',
        'the verified failure replaces the unknown outcome with a queryable result');
      assert.match(String(delivered.lastErrorMessage), /target model exploded/);
      assert.equal(delivered.responseStatus, 'cancelled', 'no response is projected for a failed invocation');
      assert.equal(countSourceReplies(fixture, deliveryId), 0);

      const eventTypes = fixture.store.listCrossConversationDeliveryEvents(deliveryId)
        .map((event) => event.eventType);
      assert.equal(eventTypes.includes('recovered_unknown_outcome'), true,
        'the original lease accident audit is preserved');
      assert.equal(eventTypes.includes('outcome_verified_failed'), true);

      // Idempotent: repeated scans record the verification exactly once.
      const again = worker.recoverPendingResponses();
      assert.deepEqual(again.verifiedFailedDeliveryIds, []);
      const verifyEvents = fixture.store.listCrossConversationDeliveryEvents(deliveryId)
        .filter((event) => event.eventType === 'outcome_verified_failed');
      assert.equal(verifyEvents.length, 1);

      // The started delivery is never claimed again for replay.
      assert.equal(await worker.processNext(), null);
    } finally {
      fixture.store.close();
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('restart recovery verifies late notify outcomes and rejects mismatched evidence', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-lease-notify-outcome-'));
  const sqlitePath = path.join(tmpDir, 'chat.sqlite');
  let currentTime = new Date(BASE_TIME);

  const deliveryIds = { completed: null, wrong: null, failed: null };
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
      workerId: 'lease-worker-notify-outcome',
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
      const completedNotify = submitNotify(service, fixture, { idempotencyKey: 'lease-notify-completed' });
      deliveryIds.completed = completedNotify.delivery.id;
      void worker.processNext();
      while (entered.length < 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      currentTime = new Date(BASE_TIME + 31_000);
      assert.deepEqual(worker.recoverExpiredClaims().failedUnknownDeliveryIds, [completedNotify.delivery.id]);
      createReplyMessage(fixture, completedNotify.delivery, {
        invocationId: `real-${completedNotify.delivery.id}`,
        createdAt: isoAt(40),
      });

      const wrongNotify = submitNotify(service, fixture, { idempotencyKey: 'lease-notify-wrong' }, {
        sourceInvocationId: 'source-notify-wrong',
      });
      deliveryIds.wrong = wrongNotify.delivery.id;
      void worker.processNext();
      while (entered.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      currentTime = new Date(BASE_TIME + 62_000);
      assert.deepEqual(worker.recoverExpiredClaims().failedUnknownDeliveryIds, [wrongNotify.delivery.id]);
      createReplyMessage(fixture, wrongNotify.delivery, {
        invocationId: 'some-other-invocation',
        createdAt: isoAt(70),
      });

      const failedNotify = submitNotify(service, fixture, { idempotencyKey: 'lease-notify-failed' }, {
        sourceInvocationId: 'source-notify-failed',
      });
      deliveryIds.failed = failedNotify.delivery.id;
      void worker.processNext();
      while (entered.length < 3) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      currentTime = new Date(BASE_TIME + 93_000);
      assert.deepEqual(worker.recoverExpiredClaims().failedUnknownDeliveryIds, [failedNotify.delivery.id]);
      createReplyMessage(fixture, failedNotify.delivery, {
        invocationId: `real-${failedNotify.delivery.id}`,
        status: 'failed',
        content: '',
        errorMessage: 'notify target crashed',
        createdAt: isoAt(100),
      });
    } finally {
      fixture.store.close();
    }
  }

  {
    const fixture = reopenStore(tmpDir, sqlitePath);
    const worker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      workerId: 'lease-worker-notify-outcome-restarted',
      now: () => currentTime,
      leaseMs: 30_000,
      async dispatchTarget() {
        throw new Error('must not replay');
      },
    });

    try {
      const recovered = worker.recoverPendingResponses();
      assert.deepEqual(recovered.verifiedCompletedDeliveryIds, [deliveryIds.completed]);
      assert.deepEqual(recovered.verifiedFailedDeliveryIds, [deliveryIds.failed]);
      assert.deepEqual(recovered.projectedDeliveryIds, [], 'notify deliveries never project responses');

      const completedRow = fixture.store.getCrossConversationDelivery(deliveryIds.completed);
      assert.equal(completedRow.dispatchStatus, 'completed');
      assert.equal(completedRow.lastErrorCode, null);
      assert.ok(completedRow.terminalAt, 'verified notify completion is terminal');
      assert.equal(fixture.store.listCrossConversationDeliveryEvents(deliveryIds.completed)
        .some((event) => event.eventType === 'outcome_verified_completed'), true);

      const wrongRow = fixture.store.getCrossConversationDelivery(deliveryIds.wrong);
      assert.equal(wrongRow.dispatchStatus, 'failed');
      assert.equal(wrongRow.lastErrorCode, 'recovered_started_unknown_outcome',
        'mismatched invocation evidence keeps the outcome unknown');

      const failedRow = fixture.store.getCrossConversationDelivery(deliveryIds.failed);
      assert.equal(failedRow.dispatchStatus, 'failed');
      assert.equal(failedRow.lastErrorCode, 'dispatch_failed_verified');
      assert.match(String(failedRow.lastErrorMessage), /notify target crashed/);

      const again = worker.recoverPendingResponses();
      assert.deepEqual(again.verifiedCompletedDeliveryIds, []);
      assert.deepEqual(again.verifiedFailedDeliveryIds, []);
      assert.equal(await worker.processNext(), null);
    } finally {
      fixture.store.close();
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('restart recovery skips mismatched evidence and verifies the exact later invocation message', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-lease-evidence-selection-'));
  const sqlitePath = path.join(tmpDir, 'chat.sqlite');
  let currentTime = new Date(BASE_TIME);

  const deliveryIds = { request: null, notify: null };
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
      workerId: 'lease-worker-evidence-selection',
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
      const request = submitRequest(service, fixture, { idempotencyKey: 'lease-evidence-selection-request' });
      deliveryIds.request = request.delivery.id;
      void worker.processNext();
      while (entered.length < 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      currentTime = new Date(BASE_TIME + 31_000);
      assert.deepEqual(worker.recoverExpiredClaims().failedUnknownDeliveryIds, [request.delivery.id]);
      // Wrong evidence arrives FIRST: same delivery id, different invocation.
      createReplyMessage(fixture, request.delivery, {
        invocationId: 'some-other-invocation',
        content: 'Evidence from a different invocation.',
        createdAt: isoAt(40),
      });
      // The exact evidence arrives LATER.
      createReplyMessage(fixture, request.delivery, {
        invocationId: `real-${request.delivery.id}`,
        content: 'Exact invocation evidence arriving late.',
        createdAt: isoAt(45),
      });

      const notify = submitNotify(service, fixture, { idempotencyKey: 'lease-evidence-selection-notify' }, {
        sourceInvocationId: 'source-evidence-selection-notify',
      });
      deliveryIds.notify = notify.delivery.id;
      void worker.processNext();
      while (entered.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      currentTime = new Date(BASE_TIME + 62_000);
      assert.deepEqual(worker.recoverExpiredClaims().failedUnknownDeliveryIds, [notify.delivery.id]);
      // Wrong evidence FIRST: delivery id only, no invocation marker.
      createReplyMessage(fixture, notify.delivery, {
        status: 'failed',
        content: '',
        errorMessage: 'unattributed failure',
        createdAt: isoAt(70),
      });
      // The exact failed outcome arrives LATER.
      createReplyMessage(fixture, notify.delivery, {
        invocationId: `real-${notify.delivery.id}`,
        status: 'failed',
        content: '',
        errorMessage: 'exact notify failure arriving late',
        createdAt: isoAt(75),
      });
    } finally {
      fixture.store.close();
    }
  }

  {
    const fixture = reopenStore(tmpDir, sqlitePath);
    const worker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      workerId: 'lease-worker-evidence-selection-restarted',
      now: () => currentTime,
      leaseMs: 30_000,
      async dispatchTarget() {
        throw new Error('must not replay');
      },
    });

    try {
      const recovered = worker.recoverPendingResponses();
      assert.deepEqual(recovered.verifiedCompletedDeliveryIds, [deliveryIds.request],
        'the exact later success evidence must verify the request outcome');
      assert.deepEqual(recovered.projectedDeliveryIds, [deliveryIds.request],
        'the exact later success evidence must be projected');
      assert.deepEqual(recovered.verifiedFailedDeliveryIds, [deliveryIds.notify],
        'the exact later failure evidence must verify the notify outcome');

      const requestRow = fixture.store.getCrossConversationDelivery(deliveryIds.request);
      assert.equal(requestRow.dispatchStatus, 'completed');
      assert.equal(requestRow.lastErrorCode, null);
      assert.equal(requestRow.responseStatus, 'late');
      const projectedReplies = fixture.store.listMessages('lease-source-conversation')
        .filter((message) => message.metadata && message.metadata.crossConversation
          && message.metadata.crossConversation.replyToDeliveryId === deliveryIds.request);
      assert.equal(projectedReplies.length, 1);
      assert.equal(projectedReplies[0].content, 'Exact invocation evidence arriving late.',
        'the projected reply must come from the exact invocation, not the earlier mismatch');

      const notifyRow = fixture.store.getCrossConversationDelivery(deliveryIds.notify);
      assert.equal(notifyRow.dispatchStatus, 'failed');
      assert.equal(notifyRow.lastErrorCode, 'dispatch_failed_verified');
      assert.match(String(notifyRow.lastErrorMessage), /exact notify failure arriving late/);

      // Repeated scans stay idempotent: mismatched evidence is never
      // reconsidered as truth, and the exact evidence is applied once.
      for (let scan = 0; scan < 3; scan += 1) {
        const again = worker.recoverPendingResponses();
        assert.deepEqual(again.verifiedCompletedDeliveryIds, []);
        assert.deepEqual(again.verifiedFailedDeliveryIds, []);
        assert.deepEqual(again.projectedDeliveryIds, []);
      }
      assert.equal(countSourceReplies(fixture, deliveryIds.request), 1);
      assert.equal(await worker.processNext(), null);
    } finally {
      fixture.store.close();
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('outcome recovery scans fairly: unrecoverable records never block later candidates', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-lease-fair-outcome-'));
  const sqlitePath = path.join(tmpDir, 'chat.sqlite');
  let currentTime = new Date(BASE_TIME);

  const stuckIds = [];
  let recoverableId = null;
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
      workerId: 'lease-worker-fair-outcome',
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
      // Four permanently unanswerable records (no reply ever persisted).
      for (let index = 1; index <= 4; index += 1) {
        const stuck = submitRequest(service, fixture, { idempotencyKey: `lease-fair-stuck-${index}` }, {
          sourceInvocationId: `lease-fair-stuck-src-${index}`,
        });
        stuckIds.push(stuck.delivery.id);
        void worker.processNext();
        while (entered.length < index) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        currentTime = new Date(BASE_TIME + 31_000 * index);
        assert.deepEqual(worker.recoverExpiredClaims().failedUnknownDeliveryIds, [stuck.delivery.id]);
      }

      // One recoverable record, updated LAST so it sorts behind the stuck rows.
      const recoverable = submitRequest(service, fixture, { idempotencyKey: 'lease-fair-recoverable' }, {
        sourceInvocationId: 'lease-fair-recoverable-src',
      });
      recoverableId = recoverable.delivery.id;
      void worker.processNext();
      while (entered.length < 5) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      currentTime = new Date(BASE_TIME + 31_000 * 5);
      assert.deepEqual(worker.recoverExpiredClaims().failedUnknownDeliveryIds, [recoverableId]);
      createReplyMessage(fixture, recoverable.delivery, {
        invocationId: `real-${recoverableId}`,
        createdAt: isoAt(31 * 5 + 5),
      });
    } finally {
      fixture.store.close();
    }
  }

  // Restart: the in-memory cursor resets, so the first scans re-walk the
  // stuck pages; the recoverable record is still reached within one page
  // turnover instead of being blocked forever.
  {
    const fixture = reopenStore(tmpDir, sqlitePath);
    const worker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      workerId: 'lease-worker-fair-outcome-restarted',
      now: () => currentTime,
      leaseMs: 30_000,
      recoveryScanPageSize: 3,
      async dispatchTarget() {
        throw new Error('must not replay');
      },
    });

    try {
      const first = worker.recoverPendingResponses();
      assert.deepEqual(first.verifiedCompletedDeliveryIds, []);
      assert.deepEqual(first.projectedDeliveryIds, []);

      const second = worker.recoverPendingResponses();
      assert.deepEqual(second.verifiedCompletedDeliveryIds, [recoverableId]);
      assert.deepEqual(second.projectedDeliveryIds, [recoverableId]);
      assert.equal(countSourceReplies(fixture, recoverableId), 1);

      // The scan wraps around and stays idempotent: no record is recovered
      // twice and the stuck records remain untouched.
      for (let scan = 0; scan < 4; scan += 1) {
        const next = worker.recoverPendingResponses();
        assert.deepEqual(next.verifiedCompletedDeliveryIds, []);
        assert.deepEqual(next.projectedDeliveryIds, []);
      }
      assert.equal(countSourceReplies(fixture, recoverableId), 1);
      assert.equal(fixture.store.listCrossConversationDeliveryEvents(recoverableId)
        .filter((event) => event.eventType === 'outcome_verified_completed').length, 1);
      for (const stuckId of stuckIds) {
        assert.equal(fixture.store.getCrossConversationDelivery(stuckId).lastErrorCode,
          'recovered_started_unknown_outcome');
      }
    } finally {
      fixture.store.close();
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('response projection recovery pages fairly past permanently unanswerable records', async () => {
  const fixture = createFixture();
  let currentTime = new Date(BASE_TIME);
  const service = createCrossConversationDeliveryService({
    store: fixture.store,
    now: () => currentTime,
  });
  const scheduler = createManualScheduler();
  const worker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'lease-worker-fair-projection',
    now: () => currentTime,
    leaseMs: 30_000,
    leaseRenewIntervalMs: 10_000,
    recoveryScanPageSize: 3,
    setIntervalFn: scheduler.setInterval,
    clearIntervalFn: scheduler.clearInterval,
    async dispatchTarget(input) {
      input.onInvocationStarting({ invocationId: 'late-projection-invocation' });
      return { replyMessage: null };
    },
  });

  try {
    // Four cancelled requests sit in the pending-response set forever.
    for (let index = 1; index <= 4; index += 1) {
      currentTime = new Date(BASE_TIME + index * 1000);
      const stuck = submitRequest(service, fixture, { idempotencyKey: `lease-fair-cancel-${index}` }, {
        sourceInvocationId: `lease-fair-cancel-src-${index}`,
      });
      await worker.cancel(stuck.delivery.id, 'operator cancels');
      assert.equal(fixture.store.getCrossConversationDelivery(stuck.delivery.id).dispatchStatus, 'cancelled');
    }

    // One request completes without a reply; the reply lands later and must
    // be reached even though the cancelled records sort first.
    currentTime = new Date(BASE_TIME + 40_000);
    const target = submitRequest(service, fixture, { idempotencyKey: 'lease-fair-project' }, {
      sourceInvocationId: 'lease-fair-project-src',
    });
    const outcome = await worker.processNext();
    assert.equal(outcome.status, 'completed');
    assert.equal(fixture.store.getCrossConversationDelivery(target.delivery.id).responseStatus, 'waiting');

    currentTime = new Date(BASE_TIME + 50_000);
    createReplyMessage(fixture, target.delivery, {
      invocationId: 'late-projection-invocation',
      createdAt: currentTime.toISOString(),
    });

    const first = worker.recoverPendingResponses();
    assert.deepEqual(first.projectedDeliveryIds, []);

    const second = worker.recoverPendingResponses();
    assert.deepEqual(second.projectedDeliveryIds, [target.delivery.id]);
    assert.equal(fixture.store.getCrossConversationDelivery(target.delivery.id).responseStatus, 'received');
    assert.equal(countSourceReplies(fixture, target.delivery.id), 1);

    // Wrap-around stays idempotent.
    for (let scan = 0; scan < 4; scan += 1) {
      assert.deepEqual(worker.recoverPendingResponses().projectedDeliveryIds, []);
    }
    assert.equal(countSourceReplies(fixture, target.delivery.id), 1);
  } finally {
    fixture.store.close();
  }
});
