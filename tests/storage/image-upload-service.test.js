const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { ImageUploadService } = require('../../build/lib/image-upload-service');
const { withTempDir } = require('../helpers/temp-dir');
const { pngBuffer, jpegBuffer } = require('./image-buffers');

function setup() {
  const tempDir = withTempDir('caff-upload-svc-');
  const uploadsDir = path.join(tempDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const store = createChatAppStore({ sqlitePath: path.join(tempDir, 'store.sqlite') });
  const service = new ImageUploadService({ store, uploadsDir });

  const agent = store.saveCustomRoleConfig({
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Agent',
    personaPrompt: 'p',
  });
  const conversation = store.createConversation({
    title: 'T',
    participants: [{ agentId: agent.id }],
  });

  return {
    store,
    service,
    uploadsDir,
    tempDir,
    conversationId: conversation.id,
    cleanup() {
      try {
        store.close();
      } catch {}
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function pngCandidate(fileName = 'a.png', width = 100, height = 50) {
  return {
    fieldName: 'files',
    fileName,
    mimeType: 'image/png',
    content: pngBuffer(width, height),
  };
}

test('upload returns ordered imageIds and persists staged rows', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-1', [
    pngCandidate('a.png', 100, 50),
    pngCandidate('b.png', 200, 80),
  ]);

  assert.equal(outcome.kind, 'ok');
  assert.equal(outcome.images.length, 2);

  const batch = ctx.store.getImageUploadBatchByKey(ctx.conversationId, 'req-1');
  assert.equal(batch.status, 'complete');
  assert.ok(batch.completedAt);
  assert.equal(batch.requestFingerprint, ctx.service.computeRequestFingerprint([
    pngCandidate('a.png', 100, 50),
    pngCandidate('b.png', 200, 80),
  ]));

  const children = ctx.store.listImageUploadsByBatch(batch.batchId);
  assert.equal(children.length, 2);
  assert.equal(children[0].slot, 0);
  assert.equal(children[0].status, 'staged');
  assert.ok(children[0].storedPath.startsWith(`/uploads/${batch.batchId}/`));

  const finalFiles = fs.readdirSync(path.join(ctx.uploadsDir, batch.batchId));
  assert.equal(finalFiles.length, 2);
});

test('same key + same fingerprint returns canonical result (idempotent retry)', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const first = await ctx.service.upload(ctx.conversationId, 'req-1', [pngCandidate()]);
  assert.equal(first.kind, 'ok');

  const second = await ctx.service.upload(ctx.conversationId, 'req-1', [pngCandidate()]);
  assert.equal(second.kind, 'ok');
  assert.deepEqual(second.images, first.images);

  const children = ctx.store.listImageUploadsByIds(first.images.map((i) => i.imageId));
  assert.equal(children.length, 1);
});

test('same key + different fingerprint returns UPLOAD_IDEMPOTENCY_CONFLICT', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const first = await ctx.service.upload(ctx.conversationId, 'req-1', [pngCandidate('a.png', 100, 50)]);
  assert.equal(first.kind, 'ok');

  const conflict = await ctx.service.upload(ctx.conversationId, 'req-1', [pngCandidate('a.png', 300, 200)]);
  assert.equal(conflict.kind, 'conflict');
  assert.equal(conflict.existingImages.length, 1);
});

test('rejects MIME outside whitelist via magic-byte', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-1', [
    { fieldName: 'files', fileName: 'evil.txt', mimeType: 'text/plain', content: Buffer.from('hello') },
  ]);

  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.code, 'MIME_NOT_ALLOWED');
});

test('rejects whitelisted MIME with bad magic bytes', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-magic', [
    { fieldName: 'files', fileName: 'x.png', mimeType: 'image/png', content: Buffer.from('not-a-png') },
  ]);

  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.code, 'UNSUPPORTED_MAGIC');
});

test('rejects truncated PNG structure header despite valid signature', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const truncated = Buffer.concat([pngBuffer(100, 50).subarray(0, 20)]);
  const outcome = await ctx.service.upload(ctx.conversationId, 'req-trunc', [
    { fieldName: 'files', fileName: 'x.png', mimeType: 'image/png', content: truncated },
  ]);

  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.code, 'PNG_HEADER_TRUNCATED');
});

test('rejects animated GIF', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const gif = Buffer.alloc(13);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(10, 6);
  gif.writeUInt16LE(10, 8);

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-1', [
    { fieldName: 'files', fileName: 'anim.gif', mimeType: 'image/gif', content: gif },
  ]);

  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.code, 'ANIMATED_GIF_REJECTED');
});

test('rejects too many files', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-1', [
    pngCandidate('a.png'),
    pngCandidate('b.png'),
    pngCandidate('c.png'),
    pngCandidate('d.png'),
    pngCandidate('e.png'),
    pngCandidate('f.png'),
  ]);

  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.code, 'TOO_MANY_FILES');
});

test('concurrent duplicate (same key) shares in-flight promise and does not double-insert', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const [a, b] = await Promise.all([
    ctx.service.upload(ctx.conversationId, 'req-1', [pngCandidate()]),
    ctx.service.upload(ctx.conversationId, 'req-1', [pngCandidate()]),
  ]);

  assert.equal(a.kind, 'ok');
  assert.equal(b.kind, 'ok');

  const batch = ctx.store.getImageUploadBatchByKey(ctx.conversationId, 'req-1');
  assert.equal(ctx.store.countImageUploadsByBatch(batch.batchId), 1);
});

test('lease expiry takeover lets a new worker complete a pending batch', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const batch = ctx.store.createImageUploadBatch({
    conversationId: ctx.conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: ctx.service.computeRequestFingerprint([pngCandidate()]),
    expectedCount: 1,
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-1', [pngCandidate()]);
  assert.equal(outcome.kind, 'ok');

  const after = ctx.store.getImageUploadBatch(batch.batchId);
  assert.equal(after.status, 'complete');
});

test('pending batch with active lease returns UPLOAD_IN_PROGRESS without touching files', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  ctx.store.createImageUploadBatch({
    conversationId: ctx.conversationId,
    clientRequestId: 'req-1',
    requestFingerprint: ctx.service.computeRequestFingerprint([pngCandidate()]),
    expectedCount: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-1', [pngCandidate()]);
  assert.equal(outcome.kind, 'in_progress');
  assert.ok(outcome.retryAfterMs > 0);
});

test('failed validation leaves batch rejected with structured reason and no canonical', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-1', [
    { fieldName: 'files', fileName: 'x.png', mimeType: 'image/png', content: Buffer.from('not-a-png') },
  ]);

  assert.equal(outcome.kind, 'error');
  assert.ok(outcome.code);

  const batch = ctx.store.getImageUploadBatchByKey(ctx.conversationId, 'req-1');
  assert.equal(batch.status, 'rejected');
  assert.ok(batch.rejectedReason);

  const uploadDir = path.join(ctx.uploadsDir, batch.batchId);
  assert.equal(fs.existsSync(uploadDir), false);
});
