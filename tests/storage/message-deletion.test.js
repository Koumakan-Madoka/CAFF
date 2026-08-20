const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

function createHarness(t) {
  const tempDir = withTempDir('caff-message-delete-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ sqlitePath });
  const agent = store.saveCustomRoleConfig({
    id: 'message-delete-agent',
    name: 'Delete Agent',
    personaPrompt: 'Test message deletion.',
  });
  const conversation = store.createConversation({
    id: 'message-delete-conversation',
    title: 'Delete messages',
    participants: [{ agentId: agent.id }],
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { tempDir, sqlitePath, store, conversation };
}

function createMessage(store, conversationId, payload = {}) {
  return store.createMessage({
    conversationId,
    role: payload.role || 'user',
    senderName: payload.senderName || (payload.role === 'assistant' ? 'Delete Agent' : 'You'),
    content: payload.content || 'message',
    status: payload.status || 'completed',
    createdAt: payload.createdAt,
    imageIds: payload.imageIds || [],
  });
}

test('deleteConversationMessages atomically deletes selected rows and recomputes latest activity', (t) => {
  const { store, conversation } = createHarness(t);
  const first = createMessage(store, conversation.id, {
    content: 'first',
    createdAt: '2026-08-20T10:00:00.000Z',
  });
  const second = createMessage(store, conversation.id, {
    content: 'second',
    createdAt: '2026-08-20T10:01:00.000Z',
  });

  assert.equal(typeof store.deleteConversationMessages, 'function');
  const result = store.deleteConversationMessages(conversation.id, [second.id]);

  assert.deepEqual(result.deletedMessageIds, [second.id]);
  assert.deepEqual(store.listMessages(conversation.id).map((message) => message.id), [first.id]);
  assert.equal(store.getConversationWithoutMessages(conversation.id).lastMessageAt, first.createdAt);
});

test('deleting a cursor message keeps older pagination continuous', (t) => {
  const { store, conversation } = createHarness(t);
  const messages = [0, 1, 2, 3].map((index) => createMessage(store, conversation.id, {
    content: `page-${index}`,
    createdAt: `2026-08-20T10:0${index}:00.000Z`,
  }));
  const firstPage = store.listMessagePage(conversation.id, { limit: 2 });

  assert.deepEqual(firstPage.items.map((message) => message.id), [messages[2].id, messages[3].id]);
  store.deleteConversationMessages(conversation.id, [messages[2].id]);
  const olderPage = store.listMessagePage(conversation.id, {
    limit: 2,
    before: firstPage.nextBefore,
  });

  assert.deepEqual(olderPage.items.map((message) => message.id), [messages[0].id, messages[1].id]);
});

test('deleted messages remain absent after reopening the SQLite store', (t) => {
  const { store, sqlitePath, conversation } = createHarness(t);
  const message = createMessage(store, conversation.id, { content: 'persistent delete' });
  store.deleteConversationMessages(conversation.id, [message.id]);
  store.close();

  const reopened = createChatAppStore({ sqlitePath });
  try {
    assert.equal(reopened.getMessage(message.id), null);
    assert.equal(reopened.listMessages(conversation.id).length, 0);
  } finally {
    reopened.close();
  }
});

test('deleteConversationMessages removes attached image rows and batch records in the same transaction', (t) => {
  const { store, conversation } = createHarness(t);
  const batch = store.createImageUploadBatch({
    conversationId: conversation.id,
    clientRequestId: 'delete-image-request',
    requestFingerprint: 'delete-image-fingerprint',
    expectedCount: 1,
  });
  store.insertImageUpload({
    imageId: 'delete-image-1',
    batchId: batch.batchId,
    slot: 0,
    storedPath: `/uploads/${batch.batchId}/0-delete-image-1.png`,
  });
  const message = createMessage(store, conversation.id, {
    content: 'image message',
    imageIds: ['delete-image-1'],
  });

  assert.equal(typeof store.deleteConversationMessages, 'function');
  const result = store.deleteConversationMessages(conversation.id, [message.id]);

  assert.deepEqual(result.attachmentBatchIds, [batch.batchId]);
  assert.equal(store.getMessage(message.id), null);
  assert.equal(store.listImageUploadsByBatch(batch.batchId).length, 0);
  assert.equal(store.getImageUploadBatch(batch.batchId), null);
});

test('deleteConversationMessages rejects a cross-conversation FK reference before SQLite restricts it', (t) => {
  const { store, conversation } = createHarness(t);
  const target = store.createConversation({
    id: 'message-delete-target-conversation',
    title: 'Target',
    participants: [{ agentId: 'message-delete-agent' }],
  });
  const sourceMessage = createMessage(store, conversation.id, { content: 'delivery source' });
  store.crossConversationDeliveryRepository.create({
    id: 'message-delete-delivery',
    kind: 'notify',
    idempotencyScope: 'test:message-delete',
    idempotencyKey: 'delivery-1',
    principalKind: 'operator',
    sourceConversationId: conversation.id,
    sourceMessageId: sourceMessage.id,
    sourceTurnId: null,
    sourceInvocationId: null,
    sourceAgentId: null,
    sourceAgentName: 'Operator',
    sourceProjectScopeId: 'project-1',
    targetConversationId: target.id,
    targetAgentId: 'message-delete-agent',
    targetMessageId: null,
    sourceReceiptMessageId: null,
    targetProjectScopeId: 'project-1',
    traceId: 'message-delete-trace',
    rootDeliveryId: 'message-delete-delivery',
    parentDeliveryId: null,
    replyToDeliveryId: null,
    hopCount: 0,
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
    nextAttemptAt: '2026-08-20T10:00:00.000Z',
    targetInvocationId: null,
    deliveredAt: null,
    startedAt: null,
    completedAt: null,
    respondedAt: null,
    terminalAt: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
  });

  assert.throws(
    () => store.deleteConversationMessages(conversation.id, [sourceMessage.id]),
    (error) => error && error.code === 'conversation_message_cross_conversation'
  );
  assert.ok(store.getMessage(sourceMessage.id));
});

test('deleteConversationMessages rejects a mixed-conversation batch without deleting any row', (t) => {
  const { store, conversation } = createHarness(t);
  const other = store.createConversation({
    id: 'other-message-delete-conversation',
    title: 'Other',
    participants: [{ agentId: 'message-delete-agent' }],
  });
  const local = createMessage(store, conversation.id, { content: 'local' });
  const foreign = createMessage(store, other.id, { content: 'foreign' });

  assert.equal(typeof store.deleteConversationMessages, 'function');
  assert.throws(
    () => store.deleteConversationMessages(conversation.id, [local.id, foreign.id]),
    (error) => error && error.code === 'conversation_message_delete_conflict'
  );
  assert.ok(store.getMessage(local.id));
  assert.ok(store.getMessage(foreign.id));
});
