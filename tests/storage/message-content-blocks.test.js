const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

function createStore() {
  const tempDir = withTempDir('caff-msg-image-');
  const store = createChatAppStore({ sqlitePath: path.join(tempDir, 'store.sqlite') });
  store.__tempDir = tempDir;
  return store;
}

function createConversation(store) {
  const agent = store.saveCustomRoleConfig({
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    name: 'A',
    personaPrompt: 'p',
  });
  const conversation = store.createConversation({
    title: 'T',
    participants: [{ agentId: agent.id }],
  });
  return conversation.id;
}

function createStagedImage(store, conversationId, imageId, clientRequestId = 'req-1') {
  const batch = store.createImageUploadBatch({
    conversationId,
    clientRequestId,
    requestFingerprint: `fp-${imageId}`,
    expectedCount: 1,
  });
  store.insertImageUpload({
    imageId,
    batchId: batch.batchId,
    slot: 0,
    storedPath: `/uploads/${batch.batchId}/0-${imageId}.png`,
  });
  return { batch, imageId };
}

test('createMessage derives contentBlocks with text + projected image url', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const { imageId } = createStagedImage(store, conversationId, 'img-1');

  const message = store.createMessage({
    conversationId,
    role: 'user',
    senderName: 'You',
    content: 'look at this',
    imageIds: [imageId],
  });

  const blocks = message.metadata.contentBlocks;
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: 'text', text: 'look at this' });
  assert.equal(blocks[1].type, 'image');
  assert.equal(blocks[1].imageId, imageId);
  assert.ok(blocks[1].url.startsWith('/uploads/'));

  assert.equal(message.content, 'look at this', 'content remains canonical text source');
});

test('image-only message derives no empty text block', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const { imageId } = createStagedImage(store, conversationId, 'img-only');

  const message = store.createMessage({
    conversationId,
    role: 'user',
    senderName: 'You',
    content: '',
    imageIds: [imageId],
  });

  assert.equal(message.content, '');
  const blocks = message.metadata.contentBlocks;
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].imageId, imageId);
});

test('createMessage rejects client-submitted contentBlocks', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);

  assert.throws(
    () => {
      store.createMessage({
        conversationId,
        role: 'user',
        senderName: 'You',
        content: 'x',
        metadata: { contentBlocks: [{ type: 'text', text: 'x' }] },
      });
    },
    (error) => {
      assert.equal(error.code, 'TEXT_BLOCK_FROM_CLIENT_REJECTED');
      assert.equal(error.statusCode, 400);
      return true;
    }
  );
});

test('createMessage attaches images in same transaction (atomic)', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const { imageId } = createStagedImage(store, conversationId, 'img-atomic');

  const message = store.createMessage({
    conversationId,
    role: 'user',
    senderName: 'You',
    content: 'with image',
    imageIds: [imageId],
  });

  const after = store.listImageUploadsByIds([imageId]);
  assert.equal(after[0].status, 'attached');
  assert.equal(after[0].attachedMessageId, message.id);
});

test('createMessage with same clientRequestId + imageIds returns canonical message (lost-response retry)', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const { imageId } = createStagedImage(store, conversationId, 'img-idem', 'req-upload');

  const first = store.createMessage({
    conversationId,
    role: 'user',
    senderName: 'You',
    content: 'first',
    imageIds: [imageId],
    metadata: { clientRequestId: 'msg-req-1' },
  });

  const retry = store.createMessage({
    conversationId,
    role: 'user',
    senderName: 'You',
    content: 'first',
    imageIds: [imageId],
    metadata: { clientRequestId: 'msg-req-1' },
  });

  assert.equal(retry.id, first.id);
  assert.equal(retry.content, 'first');

  const images = store.listImageUploadsByIds([imageId]);
  assert.equal(images.length, 1);
  assert.equal(images[0].status, 'attached');
  assert.equal(images[0].attachedMessageId, first.id);
});

test('createMessage with same clientRequestId but different content returns the original canonical message', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const { imageId } = createStagedImage(store, conversationId, 'img-idem2', 'req-upload2');

  const first = store.createMessage({
    conversationId,
    role: 'user',
    senderName: 'You',
    content: 'original',
    imageIds: [imageId],
    metadata: { clientRequestId: 'msg-req-2' },
  });

  const retry = store.createMessage({
    conversationId,
    role: 'user',
    senderName: 'You',
    content: 'changed',
    imageIds: [imageId],
    metadata: { clientRequestId: 'msg-req-2' },
  });

  assert.equal(retry.id, first.id);
  assert.equal(retry.content, 'original');
});

test('createMessage rejects already-attached image', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const { imageId } = createStagedImage(store, conversationId, 'img-double');

  store.createMessage({
    conversationId,
    role: 'user',
    senderName: 'You',
    content: 'first',
    imageIds: [imageId],
  });

  assert.throws(
    () => {
      store.createMessage({
        conversationId,
        role: 'user',
        senderName: 'You',
        content: 'second',
        imageIds: [imageId],
      });
    },
    (error) => {
      assert.equal(error.code, 'IMAGE_ALREADY_ATTACHED');
      return true;
    }
  );
});

test('createMessage rejects image not belonging to conversation', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);
  const otherConversationId = createConversation(store);
  const { imageId } = createStagedImage(store, otherConversationId, 'img-other');

  assert.throws(
    () => {
      store.createMessage({
        conversationId,
        role: 'user',
        senderName: 'You',
        content: 'stolen',
        imageIds: [imageId],
      });
    },
    (error) => {
      assert.equal(error.code, 'IMAGE_NOT_FOUND');
      return true;
    }
  );
});

test('createMessage rejects more than MAX_IMAGES_PER_MESSAGE images', (t) => {
  const store = createStore();
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(store.__tempDir, { recursive: true, force: true });
  });

  const conversationId = createConversation(store);

  assert.throws(
    () => {
      store.createMessage({
        conversationId,
        role: 'user',
        senderName: 'You',
        content: 'many',
        imageIds: ['a', 'b', 'c', 'd', 'e', 'f'],
      });
    },
    (error) => {
      assert.equal(error.code, 'IMAGE_COUNT_EXCEEDED');
      return true;
    }
  );
});

test('createMessage rejects partial batch attach (must reference all staged children)', (t) => {
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
    clientRequestId: 'req-2up',
    requestFingerprint: 'fp-2up',
    expectedCount: 2,
  });
  store.insertImageUpload({
    imageId: 'img-a',
    batchId: batch.batchId,
    slot: 0,
    storedPath: `/uploads/${batch.batchId}/0-a.png`,
  });
  store.insertImageUpload({
    imageId: 'img-b',
    batchId: batch.batchId,
    slot: 1,
    storedPath: `/uploads/${batch.batchId}/1-b.png`,
  });

  assert.throws(
    () => {
      store.createMessage({
        conversationId,
        role: 'user',
        senderName: 'You',
        content: 'partial',
        imageIds: ['img-a'],
      });
    },
    (error) => {
      assert.equal(error.code, 'IMAGE_PARTIAL_BATCH_ATTACH_REJECTED');
      return true;
    }
  );

  const after = store.listImageUploadsByIds(['img-a', 'img-b']);
  assert.ok(after.every((row) => row.status === 'staged'), 'rejected partial attach must not consume any image');
});

test('createMessage whole-batch attach marks batch consumed', (t) => {
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
    clientRequestId: 'req-full',
    requestFingerprint: 'fp-full',
    expectedCount: 2,
  });
  store.insertImageUpload({
    imageId: 'img-1',
    batchId: batch.batchId,
    slot: 0,
    storedPath: `/uploads/${batch.batchId}/0-1.png`,
  });
  store.insertImageUpload({
    imageId: 'img-2',
    batchId: batch.batchId,
    slot: 1,
    storedPath: `/uploads/${batch.batchId}/1-2.png`,
  });
  store.completeImageUploadBatch(batch.batchId, batch.leaseToken, new Date().toISOString());

  const message = store.createMessage({
    conversationId,
    role: 'user',
    senderName: 'You',
    content: 'full',
    imageIds: ['img-1', 'img-2'],
  });

  assert.ok(message.id);

  const after = store.getImageUploadBatch(batch.batchId);
  assert.ok(after.consumedAt, 'fully attached batch must be marked consumed');

  const children = store.listImageUploadsByIds(['img-1', 'img-2']);
  assert.ok(children.every((row) => row.status === 'attached'));
  assert.ok(children.every((row) => row.attachedMessageId === message.id));
});
