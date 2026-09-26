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


function submitRequestForStorage(fixture) {
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
    kind: 'request',
    targetConversationId: fixture.targetConversation.id,
    targetAgentId: fixture.targetAgent.id,
    content: 'Storage atomicity probe request.',
    idempotencyKey: `lease-store-${Math.random().toString(36).slice(2)}`,
    deadlineSeconds: 3600,
  });
}

function driveToUnknownOutcome(fixture, deliveryId, options = {}) {
  const claimToken = options.claimToken || `claim-${Math.random().toString(36).slice(2)}`;
  const claimed = fixture.store.claimNextCrossConversationDelivery({
    owner: 'lease-store-worker',
    now: isoAt(0),
    claimExpiresAt: isoAt(30),
    claimToken,
  });
  assert.equal(claimed.id, deliveryId);
  const started = fixture.store.markCrossConversationDispatchStarted(deliveryId, {
    claimOwner: 'lease-store-worker',
    claimToken,
    targetInvocationId: options.invocationId || 'inv-1',
    startedAt: isoAt(1),
    updatedAt: isoAt(1),
  });
  assert.ok(started);
  const failed = fixture.store.failCrossConversationDeliveryUnknownOutcome(deliveryId, {
    claimOwner: 'lease-store-worker',
    claimToken,
    errorCode: options.errorCode || 'recovered_started_unknown_outcome',
    errorMessage: options.errorMessage || 'lease lost',
    failedAt: options.failedAt || isoAt(31),
  });
  assert.ok(failed);
  return failed;
}

test('outcome verification completes an unknown-outcome dispatch only with the exact invocation', () => {
  const fixture = createFixture();

  try {
    const submitted = submitNotify(fixture);
    driveToUnknownOutcome(fixture, submitted.delivery.id, { invocationId: 'inv-verify-1' });

    assert.equal(fixture.store.verifyCrossConversationOutcomeCompleted(submitted.delivery.id, {
      targetInvocationId: 'inv-other',
      verifiedAt: isoAt(40),
    }), null, 'a mismatched invocation id must not verify the outcome');

    const verified = fixture.store.verifyCrossConversationOutcomeCompleted(submitted.delivery.id, {
      targetInvocationId: 'inv-verify-1',
      verifiedAt: isoAt(40),
    });
    assert.ok(verified);
    assert.equal(verified.dispatchStatus, 'completed');
    assert.equal(verified.lastErrorCode, null);
    assert.equal(verified.lastErrorMessage, null);
    assert.equal(verified.terminalAt, isoAt(40), 'notify verification is immediately terminal');

    // Idempotent: the state no longer reads as an unknown outcome.
    assert.equal(fixture.store.verifyCrossConversationOutcomeCompleted(submitted.delivery.id, {
      targetInvocationId: 'inv-verify-1',
      verifiedAt: isoAt(50),
    }), null);
    assert.equal(fixture.store.verifyCrossConversationOutcomeFailed(submitted.delivery.id, {
      targetInvocationId: 'inv-verify-1',
      errorMessage: 'late failure',
      verifiedAt: isoAt(50),
    }), null);

    // A cancelled delivery that did start is never rewritten by verification.
    const cancelledSubmit = submitNotify(fixture);
    const claimToken = 'claim-cancelled-1';
    const cancelledClaim = fixture.store.claimNextCrossConversationDelivery({
      owner: 'lease-store-worker',
      now: isoAt(60),
      claimExpiresAt: isoAt(90),
      claimToken,
    });
    assert.equal(cancelledClaim.id, cancelledSubmit.delivery.id);
    fixture.store.markCrossConversationDispatchStarted(cancelledSubmit.delivery.id, {
      claimOwner: 'lease-store-worker',
      claimToken,
      targetInvocationId: 'inv-cancelled-1',
      startedAt: isoAt(61),
      updatedAt: isoAt(61),
    });
    fixture.store.requestRunningCrossConversationDeliveryCancel(cancelledSubmit.delivery.id, {
      reason: 'operator stop',
      requestedAt: isoAt(62),
    });
    const cancelled = fixture.store.markRunningCrossConversationDeliveryCancelled(cancelledSubmit.delivery.id, {
      claimOwner: 'lease-store-worker',
      claimToken,
      reason: 'operator stop',
      cancelledAt: isoAt(63),
    });
    assert.equal(cancelled.dispatchStatus, 'cancelled');
    assert.equal(fixture.store.verifyCrossConversationOutcomeCompleted(cancelledSubmit.delivery.id, {
      targetInvocationId: 'inv-cancelled-1',
      verifiedAt: isoAt(70),
    }), null, 'cancellation must never be overwritten by outcome verification');
    assert.equal(fixture.store.verifyCrossConversationOutcomeFailed(cancelledSubmit.delivery.id, {
      targetInvocationId: 'inv-cancelled-1',
      errorMessage: 'late failure',
      verifiedAt: isoAt(70),
    }), null);
    assert.equal(fixture.store.getCrossConversationDelivery(cancelledSubmit.delivery.id).dispatchStatus, 'cancelled');

    // A pre-start failure (never invoked) cannot be verified either.
    const preStart = submitNotify(fixture);
    const preStartClaim = fixture.store.claimNextCrossConversationDelivery({
      owner: 'lease-store-worker',
      now: isoAt(80),
      claimExpiresAt: isoAt(110),
      claimToken: 'claim-pre-start-1',
    });
    assert.equal(preStartClaim.id, preStart.delivery.id);
    const preStartFailed = fixture.store.failCrossConversationDeliveryBeforeStart(preStart.delivery.id, {
      claimOwner: 'lease-store-worker',
      claimToken: 'claim-pre-start-1',
      errorCode: 'dispatch_pre_start_exhausted',
      errorMessage: 'no budget left',
      failedAt: isoAt(81),
    });
    assert.equal(preStartFailed.dispatchStatus, 'failed');
    assert.equal(fixture.store.verifyCrossConversationOutcomeCompleted(preStart.delivery.id, {
      targetInvocationId: 'inv-verify-1',
      verifiedAt: isoAt(90),
    }), null);
  } finally {
    fixture.store.close();
  }
});

test('verified failure keeps the failed dispatch state with a queryable verified error', () => {
  const fixture = createFixture();

  try {
    const submitted = submitRequestForStorage(fixture);
    driveToUnknownOutcome(fixture, submitted.delivery.id, {
      invocationId: 'inv-verify-failed-1',
      errorCode: 'dispatch_unknown_outcome',
      errorMessage: 'worker lost contact',
    });

    assert.equal(fixture.store.verifyCrossConversationOutcomeFailed(submitted.delivery.id, {
      targetInvocationId: 'inv-other',
      errorMessage: 'wrong invocation failure',
      verifiedAt: isoAt(40),
    }), null);

    const verified = fixture.store.verifyCrossConversationOutcomeFailed(submitted.delivery.id, {
      targetInvocationId: 'inv-verify-failed-1',
      errorMessage: 'target model exploded',
      verifiedAt: isoAt(40),
    });
    assert.ok(verified);
    assert.equal(verified.dispatchStatus, 'failed', 'verified failure keeps the failed dispatch state');
    assert.equal(verified.lastErrorCode, 'dispatch_failed_verified');
    assert.equal(verified.lastErrorMessage, 'target model exploded');
    assert.equal(verified.terminalAt, isoAt(31), 'the original terminal timestamp is preserved');
    assert.equal(verified.responseStatus, 'cancelled', 'no response is expected from a failed invocation');

    assert.equal(fixture.store.verifyCrossConversationOutcomeFailed(submitted.delivery.id, {
      targetInvocationId: 'inv-verify-failed-1',
      errorMessage: 'duplicate verification',
      verifiedAt: isoAt(50),
    }), null, 'verification is idempotent');
  } finally {
    fixture.store.close();
  }
});

test('outcome evidence lookup selects the exact invocation association, not the earliest delivery match', () => {
  const fixture = createFixture();

  try {
    const submitted = submitNotify(fixture);
    driveToUnknownOutcome(fixture, submitted.delivery.id, { invocationId: 'inv-exact-1' });
    const delivery = fixture.store.getCrossConversationDelivery(submitted.delivery.id);

    const createOutcomeMessage = (overrides) => fixture.store.createMessage({
      id: overrides.id,
      conversationId: fixture.targetConversation.id,
      turnId: 'lease-store-evidence-turn',
      role: 'assistant',
      agentId: fixture.targetAgent.id,
      senderName: fixture.targetAgent.name,
      content: overrides.content || '',
      status: overrides.status || 'completed',
      errorMessage: overrides.errorMessage || '',
      metadata: overrides.metadata,
      createdAt: overrides.createdAt,
    });

    // Earliest: same delivery id, no invocation marker at all.
    createOutcomeMessage({
      id: 'evidence-missing-invocation',
      createdAt: isoAt(39),
      metadata: { crossConversationDeliveryId: delivery.id },
    });
    // Next: same delivery id, WRONG invocation id.
    createOutcomeMessage({
      id: 'evidence-wrong-invocation',
      createdAt: isoAt(40),
      metadata: {
        crossConversationDeliveryId: delivery.id,
        crossConversationInvocationId: 'inv-other',
      },
    });
    // Latest: exact delivery id AND exact invocation id.
    const exact = createOutcomeMessage({
      id: 'evidence-exact-invocation',
      createdAt: isoAt(45),
      status: 'failed',
      errorMessage: 'the exact late truth',
      metadata: {
        crossConversationDeliveryId: delivery.id,
        crossConversationInvocationId: 'inv-exact-1',
      },
    });

    const found = fixture.store.findCrossConversationOutcomeMessage(delivery);
    assert.equal(found && found.id, exact.id,
      'evidence selection must skip mismatched invocations instead of stopping at the earliest delivery match');
  } finally {
    fixture.store.close();
  }
});

test('pending-response and unknown-outcome scans paginate by keyset cursor', () => {
  const fixture = createFixture();

  try {
    const pendingIds = [];
    for (let index = 1; index <= 5; index += 1) {
      const submitted = submitRequestForStorage(fixture);
      const cancelled = fixture.store.cancelQueuedCrossConversationDelivery(submitted.delivery.id, {
        reason: 'operator cancels',
        cancelledAt: isoAt(index),
      });
      assert.equal(cancelled.dispatchStatus, 'cancelled');
      pendingIds.push(submitted.delivery.id);
    }

    const firstPage = fixture.store.listCrossConversationRequestsPendingResponse(2);
    assert.equal(firstPage.length, 2);
    const seen = [];
    let cursor = null;
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const page = fixture.store.listCrossConversationRequestsPendingResponse(2, cursor);
      if (page.length === 0) {
        break;
      }
      seen.push(...page.map((delivery) => delivery.id));
      const last = page[page.length - 1];
      cursor = { updatedAt: last.updatedAt, id: last.id };
    }
    assert.deepEqual([...seen].sort(), [...pendingIds].sort(),
      'keyset paging covers every pending record exactly once across pages');
    assert.equal(new Set(seen).size, pendingIds.length);

    const unknownIds = [];
    for (let index = 1; index <= 3; index += 1) {
      const submitted = submitNotify(fixture);
      driveToUnknownOutcome(fixture, submitted.delivery.id, {
        invocationId: `inv-unknown-${index}`,
        failedAt: isoAt(100 + index),
      });
      unknownIds.push(submitted.delivery.id);
    }

    const unknownSeen = [];
    let unknownCursor = null;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const page = fixture.store.listCrossConversationUnknownOutcomeDeliveries(2, unknownCursor);
      if (page.length === 0) {
        break;
      }
      unknownSeen.push(...page.map((delivery) => delivery.id));
      const last = page[page.length - 1];
      unknownCursor = { updatedAt: last.updatedAt, id: last.id };
    }
    assert.deepEqual([...unknownSeen].sort(), [...unknownIds].sort());
    assert.equal(new Set(unknownSeen).size, unknownIds.length);

    // Verified records leave the unknown-outcome scan.
    fixture.store.verifyCrossConversationOutcomeCompleted(unknownIds[0], {
      targetInvocationId: 'inv-unknown-1',
      verifiedAt: isoAt(200),
    });
    const remaining = fixture.store.listCrossConversationUnknownOutcomeDeliveries(100);
    assert.deepEqual(remaining.map((delivery) => delivery.id).sort(), unknownIds.slice(1).sort());
  } finally {
    fixture.store.close();
  }
});
