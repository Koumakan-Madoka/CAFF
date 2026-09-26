const assert = require('node:assert/strict');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  createCrossConversationDeliveryService,
} = require('../../build/server/domain/conversation/cross-conversation-delivery');

// Storage-level atomicity contract for the delivery lease fix. Every claim
// carries a unique claim token; all claim-guarded transitions require the
// token; the sweeper's recovery transitions re-verify that the claim is
// still expired at update time.

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

function createFixture() {
  const store = createChatAppStore({ agentDir: process.cwd(), sqlitePath: ':memory:' });
  const sourceAgent = store.saveCustomRoleConfig({
    id: 'lease-store-source-agent',
    name: 'Source Agent',
    personaPrompt: 'Send bounded requests.',
  });
  const targetAgent = store.saveCustomRoleConfig({
    id: 'lease-store-target-agent',
    name: 'Target Agent',
    personaPrompt: 'Handle bounded requests.',
  });
  const sourceConversation = store.createConversation({
    id: 'lease-store-source-conversation',
    title: 'Source Conversation',
    participants: [sourceAgent.id],
  });
  const targetConversation = store.createConversation({
    id: 'lease-store-target-conversation',
    title: 'Target Conversation',
    participants: [targetAgent.id],
  });
  bindProjectScope(store, sourceConversation.id, 'project-1');
  bindProjectScope(store, targetConversation.id, 'project-1');
  const sourceMessage = store.createMessage({
    id: 'lease-store-source-message',
    conversationId: sourceConversation.id,
    turnId: 'lease-store-source-turn',
    role: 'assistant',
    agentId: sourceAgent.id,
    senderName: sourceAgent.name,
    content: 'Preparing a cross-conversation request.',
  });
  return { store, sourceAgent, targetAgent, sourceConversation, targetConversation, sourceMessage };
}

function submitNotify(fixture) {
  const service = createCrossConversationDeliveryService({
    store: fixture.store,
    now: () => new Date(BASE_TIME),
  });
  return service.submitFromAgent({
    kind: 'agent',
    sourceConversationId: fixture.sourceConversation.id,
    sourceMessageId: fixture.sourceMessage.id,
    sourceTurnId: fixture.sourceMessage.turnId,
    sourceInvocationId: `lease-store-${Math.random().toString(36).slice(2)}`,
    sourceAgentId: fixture.sourceAgent.id,
    sourceAgentName: fixture.sourceAgent.name,
    incomingDeliveryId: null,
  }, {
    kind: 'notify',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Storage atomicity probe.',
    idempotencyKey: `lease-store-${Math.random().toString(36).slice(2)}`,
  });
}

test('each claim carries a unique claim token, distinct across reclaim by the same worker', () => {
  const fixture = createFixture();

  try {
    const first = submitNotify(fixture);
    const claimed1 = fixture.store.claimNextCrossConversationDelivery({
      owner: 'lease-store-worker',
      now: isoAt(0),
      claimExpiresAt: isoAt(30),
      claimToken: 'claim-token-1',
    });
    assert.equal(claimed1.id, first.delivery.id);
    assert.equal(claimed1.claimToken, 'claim-token-1');

    fixture.store.releaseCrossConversationDeliveryForRetry(claimed1.id, {
      claimOwner: 'lease-store-worker',
      claimToken: 'claim-token-1',
      nextAttemptAt: isoAt(31),
      errorCode: 'probe',
      errorMessage: 'probe',
      updatedAt: isoAt(31),
    });

    const claimed2 = fixture.store.claimNextCrossConversationDelivery({
      owner: 'lease-store-worker',
      now: isoAt(32),
      claimExpiresAt: isoAt(62),
      claimToken: 'claim-token-2',
    });
    assert.equal(claimed2.id, first.delivery.id);
    assert.equal(claimed2.claimToken, 'claim-token-2');
    assert.notEqual(claimed2.claimToken, claimed1.claimToken);
  } finally {
    fixture.store.close();
  }
});

test('renew extends the claim lease only for the matching owner and token', () => {
  const fixture = createFixture();

  try {
    const submitted = submitNotify(fixture);
    const claimed = fixture.store.claimNextCrossConversationDelivery({
      owner: 'lease-store-worker',
      now: isoAt(0),
      claimExpiresAt: isoAt(30),
      claimToken: 'claim-token-1',
    });
    assert.equal(claimed.id, submitted.delivery.id);

    const forged = fixture.store.renewCrossConversationDeliveryClaim(claimed.id, {
      claimOwner: 'lease-store-worker',
      claimToken: 'claim-token-forged',
      renewedAt: isoAt(10),
      claimExpiresAt: isoAt(70),
    });
    assert.equal(forged, null, 'renewal with a foreign token must be rejected');
    assert.equal(fixture.store.getCrossConversationDelivery(claimed.id).claimExpiresAt, isoAt(30));

    const wrongOwner = fixture.store.renewCrossConversationDeliveryClaim(claimed.id, {
      claimOwner: 'lease-store-other-worker',
      claimToken: 'claim-token-1',
      renewedAt: isoAt(10),
      claimExpiresAt: isoAt(70),
    });
    assert.equal(wrongOwner, null, 'renewal by another worker must be rejected');

    const renewed = fixture.store.renewCrossConversationDeliveryClaim(claimed.id, {
      claimOwner: 'lease-store-worker',
      claimToken: 'claim-token-1',
      renewedAt: isoAt(10),
      claimExpiresAt: isoAt(70),
    });
    assert.equal(renewed.claimExpiresAt, isoAt(70));
    assert.equal(renewed.claimOwner, 'lease-store-worker');
  } finally {
    fixture.store.close();
  }
});

test('claim-guarded transitions reject a stale token even when the owner name matches', () => {
  const fixture = createFixture();

  try {
    const submitted = submitNotify(fixture);
    const claimed = fixture.store.claimNextCrossConversationDelivery({
      owner: 'lease-store-worker',
      now: isoAt(0),
      claimExpiresAt: isoAt(30),
      claimToken: 'claim-token-1',
    });

    // The claim is superseded by a fresh claim carrying a new token.
    fixture.store.releaseCrossConversationDeliveryForRetry(claimed.id, {
      claimOwner: 'lease-store-worker',
      claimToken: 'claim-token-1',
      nextAttemptAt: isoAt(31),
      errorCode: 'probe',
      errorMessage: 'probe',
      updatedAt: isoAt(31),
    });
    const reclaimed = fixture.store.claimNextCrossConversationDelivery({
      owner: 'lease-store-worker',
      now: isoAt(32),
      claimExpiresAt: isoAt(62),
      claimToken: 'claim-token-2',
    });
    assert.equal(reclaimed.claimToken, 'claim-token-2');

    const staleStart = fixture.store.markCrossConversationDispatchStarted(submitted.delivery.id, {
      claimOwner: 'lease-store-worker',
      claimToken: 'claim-token-1',
      targetInvocationId: 'stale-invocation',
      startedAt: isoAt(33),
      updatedAt: isoAt(33),
    });
    assert.equal(staleStart, null, 'stale token must not mark dispatch start');

    const freshStart = fixture.store.markCrossConversationDispatchStarted(submitted.delivery.id, {
      claimOwner: 'lease-store-worker',
      claimToken: 'claim-token-2',
      targetInvocationId: 'fresh-invocation',
      startedAt: isoAt(34),
      updatedAt: isoAt(34),
    });
    assert.equal(freshStart.targetInvocationId, 'fresh-invocation');

    const staleComplete = fixture.store.markCrossConversationDispatchCompleted(submitted.delivery.id, {
      claimOwner: 'lease-store-worker',
      claimToken: 'claim-token-1',
      completedAt: isoAt(35),
      terminalAt: isoAt(35),
      updatedAt: isoAt(35),
    });
    assert.equal(staleComplete, null, 'stale token must not complete the dispatch');

    const freshComplete = fixture.store.markCrossConversationDispatchCompleted(submitted.delivery.id, {
      claimOwner: 'lease-store-worker',
      claimToken: 'claim-token-2',
      completedAt: isoAt(36),
      terminalAt: isoAt(36),
      updatedAt: isoAt(36),
    });
    assert.equal(freshComplete.dispatchStatus, 'completed');
  } finally {
    fixture.store.close();
  }
});

test('recovery transitions re-verify that the claim is still expired at update time', () => {
  const fixture = createFixture();

  try {
    const submitted = submitNotify(fixture);
    const claimed = fixture.store.claimNextCrossConversationDelivery({
      owner: 'lease-store-worker',
      now: isoAt(0),
      claimExpiresAt: isoAt(30),
      claimToken: 'claim-token-1',
    });
    fixture.store.markCrossConversationDispatchStarted(claimed.id, {
      claimOwner: 'lease-store-worker',
      claimToken: 'claim-token-1',
      targetInvocationId: 'recovery-race-invocation',
      startedAt: isoAt(1),
      updatedAt: isoAt(1),
    });

    // A renewal lands after the sweeper snapshot: the lease is no longer
    // expired at update time, so the unknown-outcome transition must no-op.
    fixture.store.db.prepare(`
      UPDATE chat_cross_conversation_deliveries
      SET claim_expires_at = ?
      WHERE id = ?
    `).run(isoAt(90), claimed.id);

    const swept = fixture.store.failCrossConversationDeliveryUnknownOutcome(claimed.id, {
      claimOwner: 'lease-store-worker',
      claimToken: 'claim-token-1',
      expiredAsOf: isoAt(33),
      errorCode: 'recovered_started_unknown_outcome',
      errorMessage: 'stale sweep snapshot',
      failedAt: isoAt(33),
    });
    assert.equal(swept, null, 'sweep must re-verify expiry and refuse a renewed claim');
    const delivered = fixture.store.getCrossConversationDelivery(claimed.id);
    assert.equal(delivered.dispatchStatus, 'running');
    assert.equal(delivered.claimExpiresAt, isoAt(90));
  } finally {
    fixture.store.close();
  }
});
