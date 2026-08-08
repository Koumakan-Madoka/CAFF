const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

function createStore() {
  const tempDir = withTempDir('caff-image-store-');
  const sqlitePath = path.join(tempDir, 'store.sqlite');
  const store = createChatAppStore({ sqlitePath });
  store.__tempDir = tempDir;
  return store;
}

function createConversation(store) {
  const agent = store.saveCustomRoleConfig({
    id: `agent-test-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Agent',
    personaPrompt: 'You are a test agent.',
  });
  const conversation = store.createConversation({
    title: 'Image Test',
    participants: [{ agentId: agent.id, modelProfileId: null, conversationSkills: [] }],
  });
  return conversation.id;
}

function createMessage(store, conversationId, messageId) {
  return store.createMessage({
    id: messageId,
    conversationId,
    role: 'user',
    senderName: 'You',
    content: 'hello',
  });
}

test('store creates pending batch with fenced lease token', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-abc',
    expectedCount: 2,
  });

  assert.ok(batch);
  assert.equal(batch.status, 'pending');
  assert.ok(batch.leaseToken);
  assert.ok(batch.leaseExpiresAt);
  assert.equal(batch.clientRequestId, 'req-1');
  assert.equal(batch.conversationId, conversationId);

  const same = store.getImageUploadBatchByKey(conversationId, 'req-1');
  assert.equal(same.batchId, batch.batchId);
});

test('same (conversation, client_request_id) second batch rejected by UNIQUE', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 1,
  });

  assert.throws(() => {
    store.createImageUploadBatch({
      conversationId,
      clientRequestId: 'req-1',
      requestFingerprint: 'fp-2',
      expectedCount: 1,
    });
  });
});

test('fenced lease takeover succeeds only when lease expired (CAS)', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const nowIso = () => new Date().toISOString();
  const validExpiry = new Date(Date.now() + 60_000).toISOString();

  const activeBatch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-active',
    requestFingerprint: 'fp-active',
    expectedCount: 1,
    leaseExpiresAt: validExpiry,
  });

  const takeoverWhileValid = store.takeoverImageUploadLease(activeBatch.batchId, 'new-token', validExpiry, nowIso());
  assert.equal(takeoverWhileValid, false, 'non-expired lease must not be taken over');

  const expiredExpiry = new Date(Date.now() - 60_000).toISOString();
  const expiredBatch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-expired',
    requestFingerprint: 'fp-expired',
    expectedCount: 1,
    leaseExpiresAt: expiredExpiry,
  });

  const takeoverAfterExpiry = store.takeoverImageUploadLease(
    expiredBatch.batchId,
    'new-token',
    validExpiry,
    nowIso()
  );
  assert.equal(takeoverAfterExpiry, true, 'expired lease must be taken over');

  const batchAfter = store.getImageUploadBatch(expiredBatch.batchId);
  assert.equal(batchAfter.leaseToken, 'new-token');
});

test('complete batch requires owner lease token (stale worker fenced off)', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 1,
  });

  const staleComplete = store.completeImageUploadBatch(batch.batchId, 'stale-token', new Date().toISOString());
  assert.equal(staleComplete, false, 'stale worker must not complete');

  const ownerComplete = store.completeImageUploadBatch(batch.batchId, batch.leaseToken, new Date().toISOString());
  assert.equal(ownerComplete, true, 'owner completes');

  const after = store.getImageUploadBatch(batch.batchId);
  assert.equal(after.status, 'complete');
  assert.ok(after.completedAt);
  assert.equal(after.leaseToken, null);
});

test('batch complete requires child rows count to match expected_count', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 2,
  });

  store.insertImageUpload({ imageId: 'i1', batchId: batch.batchId, slot: 0, storedPath: '/uploads/i1.png' });
  store.insertImageUpload({ imageId: 'i2', batchId: batch.batchId, slot: 1, storedPath: '/uploads/i2.png' });

  assert.equal(store.countImageUploadsByBatch(batch.batchId), 2);
  const children = store.listImageUploadsByBatch(batch.batchId);
  assert.equal(children.length, 2);
  assert.equal(children[0].slot, 0);
  assert.equal(children[1].slot, 1);
  assert.equal(children[0].status, 'staged');
});

test('reject batch persists rejected_reason as terminal state', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 1,
  });

  store.rejectImageUploadBatch(batch.batchId, 'ANIMATED_GIF_REJECTED', new Date().toISOString());
  const after = store.getImageUploadBatch(batch.batchId);
  assert.equal(after.status, 'rejected');
  assert.equal(after.rejectedReason, 'ANIMATED_GIF_REJECTED');
});

test('attach image uploads requires staged status and conversation ownership', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 1,
  });
  store.insertImageUpload({ imageId: 'i1', batchId: batch.batchId, slot: 0, storedPath: '/uploads/i1.png' });

  const messageId = 'msg-1';
  createMessage(store, conversationId, messageId);
  const changed = store.attachImageUploads(['i1'], conversationId, messageId);
  assert.equal(changed, 1);

  const after = store.listImageUploadsByIds(['i1']);
  assert.equal(after[0].status, 'attached');
  assert.equal(after[0].attachedMessageId, 'msg-1');
  assert.ok(after[0].attachedAt);

  const secondAttach = store.attachImageUploads(['i1'], conversationId, messageId);
  assert.equal(secondAttach, 0, 'already-attached image must not be re-attached');
});

test('attach rejects image from another conversation', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const otherConversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 1,
  });
  store.insertImageUpload({ imageId: 'i1', batchId: batch.batchId, slot: 0, storedPath: '/uploads/i1.png' });

  const changed = store.attachImageUploads(['i1'], otherConversationId, 'msg-other');
  assert.equal(changed, 0, 'cross-conversation attach must not change any row');
});

test('recycle attached uploads on message delete sets ttl and clears attachment', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 1,
  });
  store.insertImageUpload({ imageId: 'i1', batchId: batch.batchId, slot: 0, storedPath: '/uploads/i1.png' });
  createMessage(store, conversationId, 'msg-1');
  store.attachImageUploads(['i1'], conversationId, 'msg-1');

  store.recycleImageUploadsByMessage('msg-1');
  const after = store.listImageUploadsByIds(['i1']);
  assert.equal(after[0].status, 'recycled');
  assert.equal(after[0].attachedMessageId, null);
  assert.ok(after[0].ttlExpiresAt);
});

test('conversation delete purges all image rows + batches before conversation (no FK error)', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 1,
  });
  store.insertImageUpload({ imageId: 'i1', batchId: batch.batchId, slot: 0, storedPath: '/uploads/i1.png' });

  store.deleteConversation(conversationId);

  assert.equal(store.getConversation(conversationId), null);
  assert.equal(store.getImageUploadBatch(batch.batchId), null);
  assert.equal(store.listImageUploadsByConversation(conversationId).length, 0);
});

test('conversation delete with attached images does not violate RESTRICT FK', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 1,
  });
  store.insertImageUpload({ imageId: 'i1', batchId: batch.batchId, slot: 0, storedPath: '/uploads/i1.png' });

  const accepted = store.createMessage({
    conversationId,
    role: 'user',
    senderName: 'You',
    content: 'hello',
    metadata: { clientRequestId: 'm-1' },
  });
  store.attachImageUploads(['i1'], conversationId, accepted.id);

  assert.doesNotThrow(() => {
    store.deleteConversation(conversationId);
  });

  assert.equal(store.listImageUploadsByConversation(conversationId).length, 0);
});

test('staged expired uploads are listed for GC', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 1,
  });
  store.insertImageUpload({
    imageId: 'i1',
    batchId: batch.batchId,
    slot: 0,
    storedPath: '/uploads/i1.png',
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  });

  const now = new Date().toISOString();
  const expiredStaged = store.listStagedImageUploadsExpired(now);
  assert.equal(expiredStaged.length, 1, 'staged upload older than TTL must be listed for GC');

  const freshThreshold = new Date().toISOString();
  const fresh = store.insertImageUpload({
    imageId: 'i2',
    batchId: batch.batchId,
    slot: 1,
    storedPath: '/uploads/i2.png',
    createdAt: freshThreshold,
  });
  assert.ok(fresh);
  const notExpired = store.listStagedImageUploadsExpired(freshThreshold);
  assert.equal(notExpired.some((row) => row.imageId === 'i2'), false, 'fresh staged upload must not be GC-listed');
});

test('finalizeImageUploadBatch is single-transaction: stale worker rollback leaves no child rows', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 2,
  });

  assert.throws(() => {
    store.finalizeImageUploadBatch({
      batchId: batch.batchId,
      leaseToken: 'stale-token',
      completedAt: new Date().toISOString(),
      children: [
        { imageId: 'i1', slot: 0, storedPath: '/uploads/i1.png' },
        { imageId: 'i2', slot: 1, storedPath: '/uploads/i2.png' },
      ],
    });
  }, (error) => error && error.code === 'IMAGE_BATCH_FENCED');

  assert.equal(
    store.countImageUploadsByBatch(batch.batchId),
    0,
    'stale worker commit must roll back child rows in the same transaction'
  );

  const after = store.getImageUploadBatch(batch.batchId);
  assert.equal(after.status, 'pending', 'batch must remain pending after fenced commit rollback');
});

test('finalizeImageUploadBatch completes with owner lease token', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: 'fp-1',
    expectedCount: 2,
  });

  const finalized = store.finalizeImageUploadBatch({
    batchId: batch.batchId,
    leaseToken: batch.leaseToken,
    completedAt: new Date().toISOString(),
    children: [
      { imageId: 'i1', slot: 0, storedPath: '/uploads/i1.png' },
      { imageId: 'i2', slot: 1, storedPath: '/uploads/i2.png' },
    ],
  });

  assert.equal(finalized.status, 'complete');
  assert.ok(finalized.completedAt);
  assert.equal(finalized.leaseToken, null);
  assert.equal(store.countImageUploadsByBatch(batch.batchId), 2);
});

test('markImageUploadBatchConsumed only marks complete batches', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const pending = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-pending',
    requestFingerprint: 'fp-p',
    expectedCount: 1,
  });

  const marked = store.markImageUploadBatchConsumed(pending.batchId, new Date().toISOString());
  assert.equal(marked, false, 'pending batch must not be marked consumed');

  const complete = store.createImageUploadBatch({
    conversationId,
    clientRequestId: 'req-complete',
    requestFingerprint: 'fp-c',
    expectedCount: 1,
  });
  store.completeImageUploadBatch(complete.batchId, complete.leaseToken, new Date().toISOString());

  const consumedAt = new Date().toISOString();
  const markedComplete = store.markImageUploadBatchConsumed(complete.batchId, consumedAt);
  assert.equal(markedComplete, true, 'complete batch can be marked consumed');

  const after = store.getImageUploadBatch(complete.batchId);
  assert.equal(after.consumedAt, consumedAt);
});
