const assert = require('node:assert/strict');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  createCrossConversationDeliveryService,
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
