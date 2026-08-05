const assert = require('node:assert/strict');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  createCrossConversationDeliveryService,
  createCrossConversationDeliveryWorker,
} = require('../../build/server/domain/conversation/cross-conversation-delivery');
const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');

function bindProjectScope(store, conversationId, projectScopeId) {
  store.db.prepare(`
    UPDATE chat_conversations
    SET project_scope_id = ?
    WHERE id = ?
  `).run(projectScopeId, conversationId);
}

function createFixture() {
  const store = createChatAppStore({ agentDir: process.cwd(), sqlitePath: ':memory:' });
  const sourceAgent = store.saveCustomRoleConfig({
    id: 'delivery-source-agent',
    name: 'Source Agent',
    personaPrompt: 'Send bounded requests.',
  });
  const targetAgent = store.saveCustomRoleConfig({
    id: 'delivery-target-agent',
    name: 'Target Agent',
    personaPrompt: 'Handle bounded requests.',
  });
  const otherAgent = store.saveCustomRoleConfig({
    id: 'delivery-other-agent',
    name: 'Other Agent',
    personaPrompt: 'Handle follow-up requests.',
  });
  const sourceConversation = store.createConversation({
    id: 'delivery-source-conversation',
    title: 'Source Conversation',
    participants: [sourceAgent.id],
  });
  const targetConversation = store.createConversation({
    id: 'delivery-target-conversation',
    title: 'Target Conversation',
    participants: [targetAgent.id],
  });
  const otherConversation = store.createConversation({
    id: 'delivery-other-conversation',
    title: 'Other Conversation',
    participants: [otherAgent.id],
  });
  bindProjectScope(store, sourceConversation.id, 'project-1');
  bindProjectScope(store, targetConversation.id, 'project-1');
  bindProjectScope(store, otherConversation.id, 'project-1');
  const sourceMessage = store.createMessage({
    id: 'delivery-source-message',
    conversationId: sourceConversation.id,
    turnId: 'delivery-source-turn',
    role: 'assistant',
    agentId: sourceAgent.id,
    senderName: sourceAgent.name,
    content: 'Preparing a cross-conversation request.',
  });
  const targetSourceMessage = store.createMessage({
    id: 'delivery-target-source-message',
    conversationId: targetConversation.id,
    turnId: 'delivery-target-turn',
    role: 'assistant',
    agentId: targetAgent.id,
    senderName: targetAgent.name,
    content: 'Preparing a follow-up request.',
  });

  return {
    store,
    sourceAgent,
    targetAgent,
    otherAgent,
    sourceConversation,
    targetConversation,
    otherConversation,
    sourceMessage,
    targetSourceMessage,
  };
}

function createPrincipal(fixture, overrides = {}) {
  return {
    kind: 'agent',
    sourceConversationId: fixture.sourceConversation.id,
    sourceMessageId: fixture.sourceMessage.id,
    sourceTurnId: fixture.sourceMessage.turnId,
    sourceInvocationId: 'source-invocation-1',
    sourceAgentId: fixture.sourceAgent.id,
    sourceAgentName: fixture.sourceAgent.name,
    incomingDeliveryId: null,
    ...overrides,
  };
}

function submitRequest(service, fixture, overrides = {}, principalOverrides = {}) {
  return service.submitFromAgent(
    createPrincipal(fixture, principalOverrides),
    {
      kind: 'request',
      targetConversationId: fixture.targetConversation.id,
      targetAgentId: fixture.targetAgent.id,
      content: 'Please inspect this and do not execute @delivery-other-agent as a local handoff.',
      idempotencyKey: 'request-1',
      deadlineSeconds: 60,
      ...overrides,
    }
  );
}

function assertDeliveryError(code, statusCode) {
  return (error) => error && error.code === code && error.statusCode === statusCode;
}

test('agent request atomically persists one delivery, low-authority target message, source receipt, and redacted event', () => {
  const fixture = createFixture();
  const service = createCrossConversationDeliveryService({ store: fixture.store });

  try {
    const result = submitRequest(service, fixture);
    assert.equal(result.duplicate, false);
    assert.equal(result.delivery.kind, 'request');
    assert.equal(result.delivery.messageStatus, 'persisted');
    assert.equal(result.delivery.dispatchStatus, 'queued');
    assert.equal(result.delivery.responseStatus, 'waiting');
    assert.equal(result.delivery.sourceConversationId, fixture.sourceConversation.id);
    assert.equal(result.delivery.sourceAgentId, fixture.sourceAgent.id);
    assert.equal(result.delivery.targetConversationId, fixture.targetConversation.id);
    assert.equal(result.delivery.targetAgentId, fixture.targetAgent.id);
    assert.equal(result.targetMessage.role, 'external_agent');
    assert.equal(result.targetMessage.content.includes('@delivery-other-agent'), true);
    assert.equal(result.targetMessage.metadata.crossConversation.deliveryId, result.delivery.id);
    assert.equal(result.targetMessage.metadata.crossConversation.authority, 'external_agent');
    assert.equal(result.targetMessage.metadata.crossConversation.allowHandoffs, false);
    assert.equal(result.sourceReceipt.role, 'system');
    assert.equal(result.sourceReceipt.content, '');
    assert.equal(result.sourceReceipt.metadata.kind, 'cross_conversation_receipt');
    assert.equal(result.sourceReceipt.metadata.crossConversation.deliveryId, result.delivery.id);

    const targetMessages = fixture.store.listMessages(fixture.targetConversation.id);
    const sourceMessages = fixture.store.listMessages(fixture.sourceConversation.id);
    assert.equal(targetMessages.filter((message) => message.id === result.targetMessage.id).length, 1);
    assert.equal(sourceMessages.filter((message) => message.id === result.sourceReceipt.id).length, 1);
    const events = fixture.store.listCrossConversationDeliveryEvents(result.delivery.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'persisted');
    assert.equal(events[0].event.content, undefined);
    assert.equal(events[0].event.credential, undefined);
  } finally {
    fixture.store.close();
  }
});

test('delivery submit publishes canonical projections only after the transaction commits', () => {
  const fixture = createFixture();
  const published = [];
  const service = createCrossConversationDeliveryService({
    store: fixture.store,
    onDeliveryPersisted(result) {
      published.push({
        result,
        storedDelivery: fixture.store.getCrossConversationDelivery(result.delivery.id),
        storedTargetMessage: fixture.store.getMessage(result.targetMessage.id),
        storedSourceReceipt: fixture.store.getMessage(result.sourceReceipt.id),
      });
    },
  });

  try {
    const result = submitRequest(service, fixture, {
      idempotencyKey: 'post-commit-publish',
    });

    assert.equal(published.length, 1);
    assert.equal(published[0].result.delivery.id, result.delivery.id);
    assert.equal(published[0].storedDelivery.messageStatus, 'persisted');
    assert.equal(published[0].storedTargetMessage.id, result.targetMessage.id);
    assert.equal(published[0].storedSourceReceipt.id, result.sourceReceipt.id);
  } finally {
    fixture.store.close();
  }
});

test('same invocation/facade/idempotency key returns canonical projections without duplicate rows', () => {
  const fixture = createFixture();
  const service = createCrossConversationDeliveryService({ store: fixture.store });

  try {
    const first = submitRequest(service, fixture);
    const second = submitRequest(service, fixture, { content: 'A retried transport body must not replace truth.' });
    assert.equal(second.duplicate, true);
    assert.equal(second.delivery.id, first.delivery.id);
    assert.equal(second.targetMessage.id, first.targetMessage.id);
    assert.equal(second.targetMessage.content, first.targetMessage.content);
    assert.equal(second.sourceReceipt.id, first.sourceReceipt.id);
    assert.equal(
      fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_cross_conversation_deliveries').get().count,
      1
    );
    assert.equal(
      fixture.store.listMessages(fixture.targetConversation.id).filter((message) => message.role === 'external_agent').length,
      1
    );
    assert.equal(
      fixture.store.listMessages(fixture.sourceConversation.id)
        .filter((message) => message.metadata && message.metadata.kind === 'cross_conversation_receipt').length,
      1
    );
  } finally {
    fixture.store.close();
  }
});

test('permission validation rejects self, unbound, cross-project, tree-related cross-project, and non-participant targets', () => {
  const fixture = createFixture();
  const service = createCrossConversationDeliveryService({ store: fixture.store });

  try {
    assert.throws(
      () => submitRequest(service, fixture, {
        targetConversationId: fixture.sourceConversation.id,
        targetAgentId: fixture.sourceAgent.id,
      }),
      assertDeliveryError('cross_conversation_self_delivery', 409)
    );

    bindProjectScope(fixture.store, fixture.sourceConversation.id, null);
    assert.throws(
      () => submitRequest(service, fixture),
      assertDeliveryError('cross_conversation_source_unbound', 409)
    );
    bindProjectScope(fixture.store, fixture.sourceConversation.id, 'project-1');

    bindProjectScope(fixture.store, fixture.targetConversation.id, null);
    assert.throws(
      () => submitRequest(service, fixture),
      assertDeliveryError('cross_conversation_target_unbound', 409)
    );
    bindProjectScope(fixture.store, fixture.targetConversation.id, 'project-2');
    assert.throws(
      () => submitRequest(service, fixture),
      assertDeliveryError('cross_conversation_project_mismatch', 403)
    );

    fixture.store.db.prepare(`
      UPDATE chat_conversations
      SET parent_conversation_id = ?, origin_conversation_id = ?, tree_depth = 1
      WHERE id = ?
    `).run(
      fixture.sourceConversation.id,
      fixture.sourceConversation.id,
      fixture.targetConversation.id
    );
    assert.throws(
      () => submitRequest(service, fixture),
      assertDeliveryError('cross_conversation_project_mismatch', 403)
    );

    bindProjectScope(fixture.store, fixture.targetConversation.id, 'project-1');
    assert.throws(
      () => submitRequest(service, fixture, { targetAgentId: fixture.otherAgent.id }),
      assertDeliveryError('cross_conversation_target_not_participant', 403)
    );
    assert.equal(
      fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_cross_conversation_deliveries').get().count,
      0
    );
  } finally {
    fixture.store.close();
  }
});

test('delivery transaction rolls back the intent and both message projections on an injected second-message failure', () => {
  const fixture = createFixture();
  const service = createCrossConversationDeliveryService({ store: fixture.store });
  const originalCreate = fixture.store.messageRepository.create.bind(fixture.store.messageRepository);
  let createCount = 0;
  fixture.store.messageRepository.create = (payload) => {
    createCount += 1;
    if (createCount === 2) {
      throw new Error('synthetic source receipt write failure');
    }
    return originalCreate(payload);
  };

  try {
    assert.throws(() => submitRequest(service, fixture), /synthetic source receipt write failure/);
    assert.equal(
      fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_cross_conversation_deliveries').get().count,
      0
    );
    assert.equal(
      fixture.store.listMessages(fixture.targetConversation.id).some((message) => message.role === 'external_agent'),
      false
    );
    assert.equal(
      fixture.store.listMessages(fixture.sourceConversation.id)
        .some((message) => message.metadata && message.metadata.kind === 'cross_conversation_receipt'),
      false
    );
  } finally {
    fixture.store.close();
  }
});

test('trace guard rejects agent-created reverse/repeated edges and maxHop overflow while allowing a new directed edge', () => {
  const fixture = createFixture();
  const service = createCrossConversationDeliveryService({ store: fixture.store });

  try {
    const root = submitRequest(service, fixture, { idempotencyKey: 'root-request' });
    const targetPrincipal = createPrincipal(fixture, {
      sourceConversationId: fixture.targetConversation.id,
      sourceMessageId: fixture.targetSourceMessage.id,
      sourceTurnId: fixture.targetSourceMessage.turnId,
      sourceInvocationId: 'target-invocation-1',
      sourceAgentId: fixture.targetAgent.id,
      sourceAgentName: fixture.targetAgent.name,
      incomingDeliveryId: root.delivery.id,
    });
    const child = service.submitFromAgent(targetPrincipal, {
      kind: 'notify',
      targetConversationId: fixture.otherConversation.id,
      targetAgentId: fixture.otherAgent.id,
      content: 'A new directed edge is allowed.',
      idempotencyKey: 'child-notify',
    });
    assert.equal(child.delivery.traceId, root.delivery.traceId);
    assert.equal(child.delivery.parentDeliveryId, root.delivery.id);
    assert.equal(child.delivery.hopCount, 1);
    const childRetry = service.submitFromAgent(targetPrincipal, {
      kind: 'notify',
      targetConversationId: fixture.otherConversation.id,
      targetAgentId: fixture.otherAgent.id,
      content: 'A transport retry must return the canonical child.',
      idempotencyKey: 'child-notify',
    });
    assert.equal(childRetry.duplicate, true);
    assert.equal(childRetry.delivery.id, child.delivery.id);

    assert.throws(
      () => service.submitFromAgent(targetPrincipal, {
        kind: 'notify',
        targetConversationId: fixture.otherConversation.id,
        targetAgentId: fixture.otherAgent.id,
        content: 'Repeated edge.',
        idempotencyKey: 'child-notify-repeat',
      }),
      assertDeliveryError('cross_conversation_trace_edge_repeated', 409)
    );
    assert.throws(
      () => service.submitFromAgent(targetPrincipal, {
        kind: 'notify',
        targetConversationId: fixture.sourceConversation.id,
        targetAgentId: fixture.sourceAgent.id,
        content: 'Agent-created reverse edge.',
        idempotencyKey: 'child-notify-reverse',
      }),
      assertDeliveryError('cross_conversation_trace_reverse_reserved', 409)
    );

    const rawMaxHopId = 'delivery-max-hop-parent';
    fixture.store.crossConversationDeliveryRepository.create({
      id: rawMaxHopId,
      kind: 'notify',
      idempotencyScope: 'test:max-hop',
      idempotencyKey: 'max-hop',
      principalKind: 'agent',
      sourceConversationId: fixture.sourceConversation.id,
      sourceMessageId: fixture.sourceMessage.id,
      sourceTurnId: fixture.sourceMessage.turnId,
      sourceInvocationId: 'max-hop-source',
      sourceAgentId: fixture.sourceAgent.id,
      sourceAgentName: fixture.sourceAgent.name,
      sourceProjectScopeId: 'project-1',
      targetConversationId: fixture.targetConversation.id,
      targetAgentId: fixture.targetAgent.id,
      targetMessageId: null,
      sourceReceiptMessageId: null,
      targetProjectScopeId: 'project-1',
      traceId: 'trace-max-hop',
      rootDeliveryId: rawMaxHopId,
      parentDeliveryId: null,
      replyToDeliveryId: null,
      hopCount: 8,
      messageStatus: 'pending',
      dispatchStatus: 'queued',
      responseStatus: 'not_expected',
      attemptCount: 0,
      deadlineAt: null,
      cancelRequestedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      claimOwner: null,
      claimExpiresAt: null,
      nextAttemptAt: '2026-08-05T00:00:00.000Z',
      targetInvocationId: null,
      deliveredAt: null,
      startedAt: null,
      completedAt: null,
      respondedAt: null,
      terminalAt: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    });
    assert.throws(
      () => service.submitFromAgent({
        ...targetPrincipal,
        incomingDeliveryId: rawMaxHopId,
        sourceInvocationId: 'target-invocation-max-hop',
      }, {
        kind: 'notify',
        targetConversationId: fixture.otherConversation.id,
        targetAgentId: fixture.otherAgent.id,
        content: 'Too deep.',
        idempotencyKey: 'max-hop-child',
      }),
      assertDeliveryError('cross_conversation_max_hop_exceeded', 409)
    );
  } finally {
    fixture.store.close();
  }
});

test('agent bridge derives source principal, rejects spoofed fields, and rejects stale invocation credentials', () => {
  const fixture = createFixture();
  const service = createCrossConversationDeliveryService({ store: fixture.store });
  const bridge = createAgentToolBridge({
    store: fixture.store,
    crossConversationDeliveryService: service,
  });
  const stage = { status: 'running' };
  const turnState = { stopRequested: false };
  const context = bridge.registerInvocation(bridge.createInvocationContext({
    invocationId: 'bridge-delivery-invocation',
    callbackToken: 'bridge-delivery-token',
    conversationId: fixture.sourceConversation.id,
    turnId: fixture.sourceMessage.turnId,
    agentId: fixture.sourceAgent.id,
    agentName: fixture.sourceAgent.name,
    assistantMessageId: fixture.sourceMessage.id,
    conversationAgents: [fixture.sourceAgent],
    stage,
    turnState,
  }));

  try {
    assert.throws(
      () => bridge.handleConversationNotify({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        sourceConversationId: fixture.otherConversation.id,
        targetConversationId: fixture.targetConversation.id,
        targetAgentId: fixture.targetAgent.id,
        content: 'Spoofed source.',
        idempotencyKey: 'bridge-spoof',
      }),
      assertDeliveryError('cross_conversation_unknown_field', 400)
    );

    const result = bridge.handleConversationNotify({
      invocationId: context.invocationId,
      callbackToken: context.callbackToken,
      targetConversationId: fixture.targetConversation.id,
      targetAgentId: fixture.targetAgent.id,
      content: 'Trusted source.',
      idempotencyKey: 'bridge-notify',
    });
    assert.equal(result.ok, true);
    assert.equal(result.delivery.sourceConversationId, fixture.sourceConversation.id);
    assert.equal(result.delivery.sourceAgentId, fixture.sourceAgent.id);
    assert.equal(result.delivery.kind, 'notify');

    stage.status = 'completed';
    assert.throws(
      () => bridge.handleConversationRequest({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        targetConversationId: fixture.targetConversation.id,
        targetAgentId: fixture.targetAgent.id,
        content: 'Too late.',
        idempotencyKey: 'bridge-stale',
        deadlineSeconds: 60,
      }),
      (error) => error && error.statusCode === 409
    );
  } finally {
    fixture.store.close();
  }
});

test('delivery worker claims committed notify, marks invocation start before dispatch, and completes once', async () => {
  const fixture = createFixture();
  const service = createCrossConversationDeliveryService({ store: fixture.store });
  const submitted = service.submitFromAgent(createPrincipal(fixture), {
    kind: 'notify',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Run exactly one target-scoped dispatch.',
    idempotencyKey: 'worker-notify',
  });
  const calls = [];
  const deliveryChanges = [];
  const worker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'worker-one',
    onDeliveryChanged(change) {
      deliveryChanges.push({
        reason: change.reason,
        dispatchStatus: change.delivery.dispatchStatus,
      });
    },
    async dispatchTarget(input) {
      calls.push({
        deliveryId: input.delivery.id,
        targetConversationId: input.delivery.targetConversationId,
        targetAgentId: input.delivery.targetAgentId,
        targetMessageId: input.targetMessage.id,
      });
      input.onInvocationStarting({ invocationId: 'target-invocation-worker-one' });
      return { replyMessage: null };
    },
  });

  try {
    const outcome = await worker.processNext();
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(calls, [{
      deliveryId: submitted.delivery.id,
      targetConversationId: fixture.targetConversation.id,
      targetAgentId: fixture.targetAgent.id,
      targetMessageId: submitted.targetMessage.id,
    }]);
    const delivery = fixture.store.getCrossConversationDelivery(submitted.delivery.id);
    assert.equal(delivery.dispatchStatus, 'completed');
    assert.equal(delivery.targetInvocationId, 'target-invocation-worker-one');
    assert.equal(delivery.attemptCount, 1);
    assert.equal(delivery.claimOwner, null);
    assert.deepEqual(deliveryChanges, [
      { reason: 'dispatch_started', dispatchStatus: 'running' },
      { reason: 'dispatch_completed', dispatchStatus: 'completed' },
    ]);
    assert.equal((await worker.processNext()), null);
  } finally {
    fixture.store.close();
  }
});

test('delivery worker retries only pre-start failures and never automatically replays a started unknown outcome', async () => {
  const fixture = createFixture();
  let currentTime = new Date('2026-08-05T00:00:00.000Z');
  const service = createCrossConversationDeliveryService({
    store: fixture.store,
    now: () => currentTime,
  });
  const preStart = service.submitFromAgent(createPrincipal(fixture), {
    kind: 'notify',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Retry only before invocation starts.',
    idempotencyKey: 'worker-pre-start',
  });
  let dispatchCount = 0;
  const retryWorker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'worker-retry',
    now: () => currentTime,
    retryDelayMs: 1_000,
    maxAttempts: 2,
    async dispatchTarget(input) {
      dispatchCount += 1;
      if (dispatchCount === 1) {
        throw new Error('synthetic pre-start failure');
      }
      input.onInvocationStarting({ invocationId: 'retry-success-invocation' });
      return { replyMessage: null };
    },
  });

  try {
    const first = await retryWorker.processNext();
    assert.equal(first.status, 'retry_scheduled');
    assert.equal(fixture.store.getCrossConversationDelivery(preStart.delivery.id).dispatchStatus, 'queued');
    assert.equal(await retryWorker.processNext(), null);
    currentTime = new Date('2026-08-05T00:00:02.000Z');
    const second = await retryWorker.processNext();
    assert.equal(second.status, 'completed');
    assert.equal(dispatchCount, 2);

    const started = service.submitFromAgent(createPrincipal(fixture, {
      sourceInvocationId: 'source-invocation-started-failure',
    }), {
      kind: 'notify',
      targetConversationId: fixture.targetConversation.id,
      targetAgentId: fixture.targetAgent.id,
      content: 'Do not replay after start.',
      idempotencyKey: 'worker-started-failure',
    });
    let startedDispatchCount = 0;
    const noReplayWorker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      workerId: 'worker-no-replay',
      now: () => currentTime,
      async dispatchTarget(input) {
        startedDispatchCount += 1;
        input.onInvocationStarting({ invocationId: 'unknown-outcome-invocation' });
        throw new Error('synthetic post-start failure');
      },
    });
    const failed = await noReplayWorker.processNext();
    assert.equal(failed.status, 'failed_unknown_outcome');
    const failedDelivery = fixture.store.getCrossConversationDelivery(started.delivery.id);
    assert.equal(failedDelivery.dispatchStatus, 'failed');
    assert.equal(failedDelivery.lastErrorCode, 'dispatch_unknown_outcome');
    assert.equal(startedDispatchCount, 1);
    assert.equal(await noReplayWorker.processNext(), null);
    assert.equal(startedDispatchCount, 1);
  } finally {
    fixture.store.close();
  }
});

test('delivery recovery reclaims expired unstarted leases but terminally fails expired started leases', () => {
  const fixture = createFixture();
  const service = createCrossConversationDeliveryService({
    store: fixture.store,
    now: () => new Date('2026-08-05T00:00:00.000Z'),
  });
  const unstarted = service.submitFromAgent(createPrincipal(fixture), {
    kind: 'notify',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Recover an unstarted lease.',
    idempotencyKey: 'recover-unstarted',
  });
  fixture.store.claimNextCrossConversationDelivery({
    owner: 'dead-worker-unstarted',
    now: '2026-08-05T00:00:00.000Z',
    claimExpiresAt: '2026-08-05T00:00:01.000Z',
  });
  const started = service.submitFromAgent(createPrincipal(fixture, {
    sourceInvocationId: 'recover-started-source-invocation',
  }), {
    kind: 'notify',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Fail a started stale lease.',
    idempotencyKey: 'recover-started',
  });
  fixture.store.claimNextCrossConversationDelivery({
    owner: 'dead-worker-started',
    now: '2026-08-05T00:00:00.000Z',
    claimExpiresAt: '2026-08-05T00:00:01.000Z',
  });
  fixture.store.markCrossConversationDispatchStarted(started.delivery.id, {
    claimOwner: 'dead-worker-started',
    targetInvocationId: 'stale-started-invocation',
    startedAt: '2026-08-05T00:00:00.500Z',
    updatedAt: '2026-08-05T00:00:00.500Z',
  });
  const worker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'recovery-worker',
    now: () => new Date('2026-08-05T00:00:02.000Z'),
    dispatchTarget: async () => ({ replyMessage: null }),
  });

  try {
    const result = worker.recoverExpiredClaims();
    assert.equal(result.requeuedDeliveryIds.includes(unstarted.delivery.id), true);
    assert.equal(result.failedUnknownDeliveryIds.includes(started.delivery.id), true);
    assert.equal(fixture.store.getCrossConversationDelivery(unstarted.delivery.id).dispatchStatus, 'queued');
    assert.equal(fixture.store.getCrossConversationDelivery(unstarted.delivery.id).claimOwner, null);
    assert.equal(fixture.store.getCrossConversationDelivery(started.delivery.id).dispatchStatus, 'failed');
    assert.equal(
      fixture.store.getCrossConversationDelivery(started.delivery.id).lastErrorCode,
      'recovered_started_unknown_outcome'
    );
  } finally {
    fixture.store.close();
  }
});

test('request response is projected once to source without scheduling source work, and timeout converts later reply to late', async () => {
  const fixture = createFixture();
  let currentTime = new Date('2026-08-05T00:00:00.000Z');
  const service = createCrossConversationDeliveryService({
    store: fixture.store,
    now: () => currentTime,
  });
  const request = submitRequest(service, fixture, {
    idempotencyKey: 'worker-request-response',
    deadlineSeconds: 10,
  });
  let sourceScheduleCount = 0;
  const deliveryChanges = [];
  const worker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'worker-response',
    now: () => currentTime,
    onSourceWorkScheduled() {
      sourceScheduleCount += 1;
    },
    onDeliveryChanged(change) {
      deliveryChanges.push(change);
    },
    async dispatchTarget(input) {
      input.onInvocationStarting({ invocationId: 'request-target-invocation' });
      return {
        replyMessage: fixture.store.createMessage({
          id: 'target-request-reply',
          conversationId: fixture.targetConversation.id,
          turnId: 'target-request-reply-turn',
          role: 'assistant',
          agentId: fixture.targetAgent.id,
          senderName: fixture.targetAgent.name,
          content: 'The requested inspection is complete.',
          metadata: { crossConversationDeliveryId: request.delivery.id },
        }),
      };
    },
  });

  try {
    const outcome = await worker.processNext();
    assert.equal(outcome.status, 'completed');
    const received = fixture.store.getCrossConversationDelivery(request.delivery.id);
    assert.equal(received.responseStatus, 'received');
    const sourceReplies = fixture.store.listMessages(fixture.sourceConversation.id)
      .filter((message) => message.metadata && message.metadata.crossConversation
        && message.metadata.crossConversation.replyToDeliveryId === request.delivery.id);
    assert.equal(sourceReplies.length, 1);
    assert.equal(sourceReplies[0].role, 'external_agent');
    assert.equal(sourceReplies[0].content, 'The requested inspection is complete.');
    assert.equal(sourceScheduleCount, 0);
    const responseChange = deliveryChanges.find((change) => change.reason === 'response_persisted');
    assert.equal(responseChange.delivery.responseStatus, 'received');
    assert.equal(responseChange.response.responseMessage.id, sourceReplies[0].id);
    const duplicate = fixture.store.persistCrossConversationResponse({
      requestDeliveryId: request.delivery.id,
      assistantMessage: fixture.store.getMessage('target-request-reply'),
      createdAt: currentTime.toISOString(),
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(fixture.store.listMessages(fixture.sourceConversation.id)
      .filter((message) => message.metadata && message.metadata.crossConversation
        && message.metadata.crossConversation.replyToDeliveryId === request.delivery.id).length, 1);

    const lateRequest = submitRequest(service, fixture, {
      idempotencyKey: 'worker-request-late',
      deadlineSeconds: 1,
    }, {
      sourceInvocationId: 'source-invocation-late-request',
    });
    currentTime = new Date('2026-08-05T00:00:02.000Z');
    const expired = worker.expireRequestDeadlines();
    assert.equal(expired.includes(lateRequest.delivery.id), true);
    assert.equal(fixture.store.getCrossConversationDelivery(lateRequest.delivery.id).responseStatus, 'timed_out');
    const lateReply = fixture.store.createMessage({
      id: 'target-late-reply',
      conversationId: fixture.targetConversation.id,
      turnId: 'target-late-reply-turn',
      role: 'assistant',
      agentId: fixture.targetAgent.id,
      senderName: fixture.targetAgent.name,
      content: 'Late but durable.',
    });
    fixture.store.persistCrossConversationResponse({
      requestDeliveryId: lateRequest.delivery.id,
      assistantMessage: lateReply,
      createdAt: currentTime.toISOString(),
    });
    assert.equal(fixture.store.getCrossConversationDelivery(lateRequest.delivery.id).responseStatus, 'late');
  } finally {
    fixture.store.close();
  }
});

test('response projection recovers from a post-dispatch persistence failure without replaying the target Agent', async () => {
  const fixture = createFixture();
  const service = createCrossConversationDeliveryService({ store: fixture.store });
  const request = submitRequest(service, fixture, {
    idempotencyKey: 'worker-response-projection-recovery',
  });
  const persistResponse = fixture.store.persistCrossConversationResponse.bind(fixture.store);
  let failResponseProjection = true;
  let dispatchCount = 0;
  fixture.store.persistCrossConversationResponse = (payload) => {
    if (failResponseProjection) {
      failResponseProjection = false;
      throw new Error('Synthetic response projection failure');
    }
    return persistResponse(payload);
  };
  const worker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'worker-response-recovery',
    async dispatchTarget(input) {
      dispatchCount += 1;
      input.onInvocationStarting({ invocationId: 'response-recovery-invocation' });
      return {
        replyMessage: fixture.store.createMessage({
          id: 'response-recovery-target-reply',
          conversationId: fixture.targetConversation.id,
          turnId: 'response-recovery-target-reply-turn',
          role: 'assistant',
          agentId: fixture.targetAgent.id,
          senderName: fixture.targetAgent.name,
          content: 'Durable target answer awaiting source projection.',
          metadata: { crossConversationDeliveryId: request.delivery.id },
        }),
      };
    },
  });

  try {
    const outcome = await worker.processNext();
    assert.equal(outcome.status, 'response_pending');
    assert.equal(dispatchCount, 1);
    const pending = fixture.store.getCrossConversationDelivery(request.delivery.id);
    assert.equal(pending.dispatchStatus, 'completed');
    assert.equal(pending.responseStatus, 'waiting');
    assert.equal(fixture.store.listMessages(fixture.sourceConversation.id)
      .filter((message) => message.metadata && message.metadata.crossConversation
        && message.metadata.crossConversation.replyToDeliveryId === request.delivery.id).length, 0);

    const recoveredIds = worker.recoverPendingResponses();
    assert.deepEqual(recoveredIds, [request.delivery.id]);
    assert.equal(dispatchCount, 1);
    assert.equal(fixture.store.getCrossConversationDelivery(request.delivery.id).responseStatus, 'received');
    assert.equal(fixture.store.listMessages(fixture.sourceConversation.id)
      .filter((message) => message.metadata && message.metadata.crossConversation
        && message.metadata.crossConversation.replyToDeliveryId === request.delivery.id).length, 1);
  } finally {
    fixture.store.close();
  }
});

test('queued cancel is terminal and running cancel records best-effort stop without deleting projections', async () => {
  const fixture = createFixture();
  const service = createCrossConversationDeliveryService({ store: fixture.store });
  const queued = service.submitFromAgent(createPrincipal(fixture), {
    kind: 'notify',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Cancel before dispatch.',
    idempotencyKey: 'cancel-queued',
  });
  let releaseDispatch;
  let invocationStarted;
  const startedPromise = new Promise((resolve) => {
    invocationStarted = resolve;
  });
  let stopCount = 0;
  const worker = createCrossConversationDeliveryWorker({
    store: fixture.store,
    workerId: 'worker-cancel',
    async stopTarget() {
      stopCount += 1;
      return true;
    },
    async dispatchTarget(input) {
      input.onInvocationStarting({ invocationId: 'cancel-running-invocation' });
      invocationStarted();
      return new Promise((resolve) => {
        releaseDispatch = resolve;
      });
    },
  });

  try {
    const queuedCancelled = await worker.cancel(queued.delivery.id, 'No longer needed');
    assert.equal(queuedCancelled.dispatchStatus, 'cancelled');
    assert.ok(fixture.store.getMessage(queued.delivery.targetMessageId));

    const running = service.submitFromAgent(createPrincipal(fixture, {
      sourceInvocationId: 'source-invocation-cancel-running',
    }), {
      kind: 'request',
      targetConversationId: fixture.targetConversation.id,
      targetAgentId: fixture.targetAgent.id,
      content: 'Cancel after dispatch starts.',
      idempotencyKey: 'cancel-running',
      deadlineSeconds: 60,
    });
    const processing = worker.processNext();
    await startedPromise;
    const runningCancelled = await worker.cancel(running.delivery.id, 'Stop this run');
    assert.equal(runningCancelled.dispatchStatus, 'cancel_requested');
    assert.equal(stopCount, 1);
    const replyMessage = fixture.store.createMessage({
      id: 'cancel-running-reply',
      conversationId: fixture.targetConversation.id,
      turnId: 'cancel-running-reply-turn',
      role: 'assistant',
      agentId: fixture.targetAgent.id,
      senderName: fixture.targetAgent.name,
      content: 'This completed after cancellation was requested.',
    });
    releaseDispatch({ replyMessage });
    const outcome = await processing;
    assert.equal(outcome.status, 'cancelled');
    const cancelledDelivery = fixture.store.getCrossConversationDelivery(running.delivery.id);
    assert.equal(cancelledDelivery.dispatchStatus, 'cancelled');
    assert.equal(cancelledDelivery.responseStatus, 'late');
    assert.equal(fixture.store.listMessages(fixture.sourceConversation.id)
      .filter((message) => message.metadata && message.metadata.crossConversation
        && message.metadata.crossConversation.replyToDeliveryId === running.delivery.id).length, 1);
  } finally {
    fixture.store.close();
  }
});
