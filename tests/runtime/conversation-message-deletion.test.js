const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  createConversationMessageDeletionService,
} = require('../../build/server/domain/conversation/message-deletion');
const {
  createConversationMutationCoordinator,
} = require('../../build/server/domain/conversation/conversation-mutation-coordinator');
const { withTempDir } = require('../helpers/temp-dir');

function createHarness(t, options = {}) {
  const tempDir = withTempDir('caff-message-delete-domain-');
  const store = createChatAppStore({ sqlitePath: path.join(tempDir, 'chat.sqlite') });
  const agent = store.saveCustomRoleConfig({
    id: 'delete-domain-agent',
    name: 'Delete Domain Agent',
    personaPrompt: 'Test deletion.',
  });
  const conversation = store.createConversation({
    id: options.conversationId || 'delete-domain-conversation',
    title: 'Delete domain',
    participants: [{ agentId: agent.id }],
  });
  const mutationCoordinator = options.mutationCoordinator || createConversationMutationCoordinator();
  const runtimeState = options.runtimeState || {
    active: false,
    dispatching: false,
    activeTurnCount: 0,
    activeAgentSlotCount: 0,
    queuedUserCount: 0,
    queuedAgentSlotCount: 0,
    busy: false,
  };
  const events = [];
  const removedBatchIds = [];
  const queueReconciliations = [];
  const service = createConversationMessageDeletionService({
    store,
    mutationCoordinator,
    turnOrchestrator: {
      getConversationMutationState() {
        return runtimeState;
      },
      reconcileConversationQueueAfterMessageDeletion(conversationId, deletedMessages) {
        queueReconciliations.push({ conversationId, deletedMessages });
      },
    },
    uploadService: options.uploadService || {
      removeBatchDirectories(batchIds) {
        removedBatchIds.push(...batchIds);
        return batchIds.length;
      },
    },
    broadcastEvent(eventName, payload) {
      events.push({ eventName, payload });
    },
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    store,
    conversation,
    mutationCoordinator,
    runtimeState,
    service,
    events,
    removedBatchIds,
    queueReconciliations,
  };
}

function createMessage(store, conversationId, payload = {}) {
  return store.createMessage({
    conversationId,
    role: payload.role || 'user',
    senderName: payload.senderName || (payload.role === 'assistant' ? 'Delete Domain Agent' : 'You'),
    content: payload.content || 'message',
    status: payload.status || 'completed',
    metadata: payload.metadata,
    createdAt: payload.createdAt,
    imageIds: payload.imageIds || [],
  });
}

function coverThrough(store, conversationId, messageId, timestamp = '2026-08-20T10:02:00.000Z') {
  const conversation = store.getConversationWithoutMessages(conversationId);
  store.updateConversation(conversationId, {
    metadata: {
      ...(conversation.metadata || {}),
      conversationDigests: [{
        id: 'digest-1',
        kind: 'entry',
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: 'test',
        messageRange: { fromMessageId: messageId, toMessageId: messageId, messageCount: 1 },
        summary: 'covered',
        facts: [],
        decisions: [],
        openQuestions: [],
        nextActions: [],
        artifacts: [],
      }],
    },
  });
}

test('deletion fails closed when runtime or mutation coordination is unavailable', (t) => {
  const { store, conversation } = createHarness(t);
  const message = createMessage(store, conversation.id);
  const unsafeService = createConversationMessageDeletionService({ store });

  assert.equal(unsafeService.projectMessages(conversation.id, [message]).deletionState.available, false);
  assert.throws(
    () => unsafeService.deleteMessages(conversation.id, { messageIds: [message.id] }),
    (error) => error && error.statusCode === 409
  );
  assert.ok(store.getMessage(message.id));
});

test('deletion projection marks summarized and non-terminal messages ineligible', (t) => {
  const { store, conversation, service } = createHarness(t);
  const covered = createMessage(store, conversation.id, {
    content: 'covered',
    createdAt: '2026-08-20T10:00:00.000Z',
  });
  const streaming = createMessage(store, conversation.id, {
    role: 'assistant',
    content: 'partial',
    status: 'streaming',
    createdAt: '2026-08-20T10:01:00.000Z',
  });
  const eligible = createMessage(store, conversation.id, {
    role: 'assistant',
    content: 'done',
    status: 'completed',
    createdAt: '2026-08-20T10:03:00.000Z',
  });
  coverThrough(store, conversation.id, covered.id);

  const projection = service.projectMessages(conversation.id, [covered, streaming, eligible]);
  const byId = new Map(projection.items.map((message) => [message.id, message.deletionEligibility]));

  assert.equal(byId.get(covered.id).eligible, false);
  assert.equal(byId.get(covered.id).reasonCode, 'message_summarized');
  assert.equal(byId.get(streaming.id).reasonCode, 'message_status_not_deletable');
  assert.equal(byId.get(eligible.id).eligible, true);
});

test('a summarized member rejects the whole batch and preserves every selected row', (t) => {
  const { store, conversation, service } = createHarness(t);
  const covered = createMessage(store, conversation.id, {
    content: 'covered',
    createdAt: '2026-08-20T10:00:00.000Z',
  });
  const eligible = createMessage(store, conversation.id, {
    content: 'eligible',
    createdAt: '2026-08-20T10:03:00.000Z',
  });
  coverThrough(store, conversation.id, covered.id);

  assert.throws(
    () => service.deleteMessages(conversation.id, { messageIds: [covered.id, eligible.id] }),
    (error) => error && error.statusCode === 409 && error.code === 'conversation_message_delete_rejected'
  );
  assert.ok(store.getMessage(covered.id));
  assert.ok(store.getMessage(eligible.id));
});

test('active or queued runtime work rejects deletion before the database transaction', (t) => {
  const { store, conversation, service, runtimeState } = createHarness(t);
  const message = createMessage(store, conversation.id);
  runtimeState.queuedAgentSlotCount = 1;
  runtimeState.busy = true;

  assert.throws(
    () => service.deleteMessages(conversation.id, { messageIds: [message.id] }),
    (error) => error && error.statusCode === 409 && error.code === 'conversation_message_delete_busy'
  );
  assert.ok(store.getMessage(message.id));
});

test('running or scheduled digest mutation rejects deletion without waiting', (t) => {
  const running = createHarness(t, { conversationId: 'digest-running-conversation' });
  const runningMessage = createMessage(running.store, running.conversation.id);
  const lease = running.mutationCoordinator.tryAcquire(running.conversation.id, 'manual_digest');
  assert.equal(lease.acquired, true);
  assert.throws(
    () => running.service.deleteMessages(running.conversation.id, { messageIds: [runningMessage.id] }),
    (error) => error && error.statusCode === 409 && error.code === 'conversation_digest_running'
  );
  lease.release();

  const scheduled = createHarness(t, { conversationId: 'digest-scheduled-conversation' });
  const scheduledMessage = createMessage(scheduled.store, scheduled.conversation.id);
  scheduled.mutationCoordinator.markDigestScheduled(scheduled.conversation.id);
  assert.throws(
    () => scheduled.service.deleteMessages(scheduled.conversation.id, { messageIds: [scheduledMessage.id] }),
    (error) => error && error.statusCode === 409 && error.code === 'conversation_digest_scheduled'
  );
});

test('attachment cleanup failure is reported after the durable message deletion', (t) => {
  const context = createHarness(t, {
    conversationId: 'attachment-cleanup-warning-conversation',
    uploadService: {
      removeBatchDirectories() {
        throw new Error('synthetic disk cleanup failure');
      },
    },
  });
  const batch = context.store.createImageUploadBatch({
    conversationId: context.conversation.id,
    clientRequestId: 'cleanup-warning-request',
    requestFingerprint: 'cleanup-warning-fingerprint',
    expectedCount: 1,
  });
  context.store.insertImageUpload({
    imageId: 'cleanup-warning-image',
    batchId: batch.batchId,
    slot: 0,
    storedPath: `/uploads/${batch.batchId}/cleanup-warning-image.png`,
  });
  const message = createMessage(context.store, context.conversation.id, {
    content: 'delete despite cleanup warning',
    imageIds: ['cleanup-warning-image'],
  });

  const result = context.service.deleteMessages(context.conversation.id, { messageIds: [message.id] });

  assert.equal(context.store.getMessage(message.id), null);
  assert.equal(result.attachmentCleanup.warning.code, 'attachment_cleanup_incomplete');
  assert.deepEqual(result.attachmentCleanup.warning.batchIds, [batch.batchId]);
});

test('successful deletion refreshes runtime queue and digest state, then emits content-free events', (t) => {
  const { store, conversation, service, events, queueReconciliations } = createHarness(t);
  const deleted = createMessage(store, conversation.id, { content: 'secret delete me' });

  const result = service.deleteMessages(conversation.id, { messageIds: [deleted.id] });

  assert.deepEqual(result.deletedMessageIds, [deleted.id]);
  assert.equal(store.getMessage(deleted.id), null);
  assert.equal(queueReconciliations.length, 1);
  assert.equal(queueReconciliations[0].conversationId, conversation.id);
  assert.deepEqual(queueReconciliations[0].deletedMessages.map((message) => message.id), [deleted.id]);
  const deletionEvent = events.find((event) => event.eventName === 'conversation_messages_deleted');
  assert.deepEqual(deletionEvent.payload.deletedMessageIds, [deleted.id]);
  assert.equal(JSON.stringify(deletionEvent).includes('secret delete me'), false);
  assert.ok(events.some((event) => event.eventName === 'conversation_summary_updated'));
  assert.equal(store.getConversationWithoutMessages(conversation.id).metadata.conversationDigestState.pendingPublicMessageCount, 0);
});
