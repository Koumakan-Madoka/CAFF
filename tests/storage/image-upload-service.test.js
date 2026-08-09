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

test('stores uploaded files with canonical image extension and magic-byte mime, ignoring client extension', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-xss', [
    { fieldName: 'files', fileName: 'payload.html', mimeType: 'image/png', content: pngBuffer(100, 50) },
  ]);

  assert.equal(outcome.kind, 'ok');

  const batch = ctx.store.getImageUploadBatchByKey(ctx.conversationId, 'req-xss');
  const children = ctx.store.listImageUploadsByBatch(batch.batchId);
  assert.equal(children.length, 1);
  assert.equal(children[0].mimeType, 'image/png');
  assert.match(children[0].storedPath, /\.png$/u);
  assert.doesNotMatch(children[0].storedPath, /\.html$/u);
  assert.match(children[0].fileName, /\.png$/u);

  const finalFiles = fs.readdirSync(path.join(ctx.uploadsDir, batch.batchId));
  assert.equal(finalFiles.length, 1);
  assert.match(finalFiles[0], /\.png$/u);
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

  const gif = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'fixtures', 'real-animated.gif'));

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

test('temp dir is lease_token-isolated and removed after success', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-iso', [pngCandidate()]);
  assert.equal(outcome.kind, 'ok');

  const batch = ctx.store.getImageUploadBatchByKey(ctx.conversationId, 'req-iso');
  const tmpRoot = path.join(ctx.uploadsDir, '.tmp', batch.batchId);

  let residue = [];

  if (fs.existsSync(tmpRoot)) {
    residue = fs.readdirSync(tmpRoot, { recursive: true });
  }

  assert.equal(residue.length, 0, 'token attempt must not leave residue after success');

  const finalDir = path.join(ctx.uploadsDir, batch.batchId);
  assert.ok(fs.existsSync(finalDir), 'final batch dir must exist');
});

test('STORAGE_FAILURE keeps batch pending (retryable) and removes own attempt', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const batch = ctx.store.createImageUploadBatch({
    conversationId: ctx.conversationId,
    clientRequestId: 'req-storage',
    requestFingerprint: ctx.service.computeRequestFingerprint([pngCandidate()]),
    expectedCount: 1,
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const originalMkdir = fs.mkdirSync;

  try {
    fs.mkdirSync = (dirPath, options) => {
      if (typeof dirPath === 'string' && dirPath.includes('.tmp') && dirPath.includes(batch.batchId)) {
        throw new Error('simulated disk write failure');
      }

      return originalMkdir(dirPath, options);
    };

    const outcome = await ctx.service.upload(ctx.conversationId, 'req-storage', [pngCandidate()]);
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.code, 'STORAGE_FAILURE');
  } finally {
    fs.mkdirSync = originalMkdir;
  }

  const after = ctx.store.getImageUploadBatch(batch.batchId);
  assert.equal(after.status, 'pending', 'storage failure must keep batch pending, not rejected');
  assert.ok(after.leaseToken, 'pending batch keeps lease for retry');

  let residue = [];

  if (fs.existsSync(path.join(ctx.uploadsDir, '.tmp', batch.batchId))) {
    residue = fs.readdirSync(path.join(ctx.uploadsDir, '.tmp', batch.batchId), { recursive: true });
  }

  assert.equal(residue.length, 0, 'own token attempt must be cleaned on storage failure');
});

test('reconcile completes a pending batch whose final dir is already fully written', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const batch = ctx.store.createImageUploadBatch({
    conversationId: ctx.conversationId,
    clientRequestId: 'req-final',
    requestFingerprint: ctx.service.computeRequestFingerprint([pngCandidate()]),
    expectedCount: 1,
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const finalDir = path.join(ctx.uploadsDir, batch.batchId);
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, '0-final.png'), pngBuffer(80, 60));

  ctx.service.reconcilePendingBatches();

  const after = ctx.store.getImageUploadBatch(batch.batchId);
  assert.equal(after.status, 'complete', 'fully-written final dir must be committed via fenced reconcile');
  assert.ok(after.completedAt);
  assert.equal(ctx.store.countImageUploadsByBatch(batch.batchId), 1);
});

test('reconcile cleans an incomplete pending final dir and keeps batch pending', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const batch = ctx.store.createImageUploadBatch({
    conversationId: ctx.conversationId,
    clientRequestId: 'req-incomplete',
    requestFingerprint: ctx.service.computeRequestFingerprint([pngCandidate(), pngCandidate()]),
    expectedCount: 2,
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const finalDir = path.join(ctx.uploadsDir, batch.batchId);
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, '0-only.png'), pngBuffer(80, 60));

  ctx.service.reconcilePendingBatches();

  assert.equal(fs.existsSync(finalDir), false, 'incomplete final dir must be cleaned');

  const after = ctx.store.getImageUploadBatch(batch.batchId);
  assert.equal(after.status, 'pending', 'batch stays pending for retry');
  assert.equal(ctx.store.countImageUploadsByBatch(batch.batchId), 0);
});

test('gcUnconsumedCompleteBatches purges expired unconsumed complete batch with children and files', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const oldCompletedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const batch = ctx.store.createImageUploadBatch({
    conversationId: ctx.conversationId,
    clientRequestId: 'req-gc',
    requestFingerprint: 'fp-gc',
    expectedCount: 1,
  });

  const finalDir = path.join(ctx.uploadsDir, batch.batchId);
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, '0-gc.png'), pngBuffer(80, 60));
  ctx.store.insertImageUpload({
    imageId: 'gc-1',
    batchId: batch.batchId,
    slot: 0,
    storedPath: `/uploads/${batch.batchId}/0-gc.png`,
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  });
  ctx.store.completeImageUploadBatch(batch.batchId, batch.leaseToken, oldCompletedAt);

  const removed = ctx.service.gcUnconsumedCompleteBatches();

  assert.equal(removed, 1);
  assert.equal(ctx.store.getImageUploadBatch(batch.batchId), null, 'expired unconsumed complete batch must be purged');
  assert.equal(ctx.store.countImageUploadsByBatch(batch.batchId), 0, 'child rows must be purged together');
  assert.equal(fs.existsSync(finalDir), false, 'files must be removed with the batch');
});

test('cleanupOrphanFiles removes upload dirs with no matching batch row', (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const orphanDir = path.join(ctx.uploadsDir, 'orphan-dir');
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(orphanDir, '0-x.png'), pngBuffer(40, 40));

  const batch = ctx.store.createImageUploadBatch({
    conversationId: ctx.conversationId,
    clientRequestId: 'req-keep',
    requestFingerprint: 'fp-keep',
    expectedCount: 1,
  });
  const keptDir = path.join(ctx.uploadsDir, batch.batchId);
  fs.mkdirSync(keptDir, { recursive: true });
  fs.writeFileSync(path.join(keptDir, '0-keep.png'), pngBuffer(40, 40));

  const removed = ctx.service.cleanupOrphanFiles();

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(orphanDir), false, 'orphan dir without batch row must be removed');
  assert.ok(fs.existsSync(keptDir), 'dir with a batch row must be kept');
});

test('rejects file larger than MAX_IMAGE_BYTES', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const oversized = Buffer.concat([pngBuffer(100, 50), Buffer.alloc(10 * 1024 * 1024)]);
  const outcome = await ctx.service.upload(ctx.conversationId, 'req-size', [
    { fieldName: 'files', fileName: 'big.png', mimeType: 'image/png', content: oversized },
  ]);

  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.code, 'FILE_TOO_LARGE');

  const batch = ctx.store.getImageUploadBatchByKey(ctx.conversationId, 'req-size');
  assert.equal(batch.status, 'rejected', 'deterministic size rejection must enter rejected terminal state');
});

test('rejects dimensions beyond MAX_IMAGE_WIDTH/HEIGHT', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-dim', [
    { fieldName: 'files', fileName: 'wide.png', mimeType: 'image/png', content: pngBuffer(5000, 10) },
  ]);

  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.code, 'DIMENSIONS_EXCEEDED');
});

test('rejects pixel count beyond MAX_IMAGE_PIXELS', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const outcome = await ctx.service.upload(ctx.conversationId, 'req-px', [
    { fieldName: 'files', fileName: 'big-px.png', mimeType: 'image/png', content: pngBuffer(4096, 4096) },
  ]);

  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.code, 'PIXEL_COUNT_EXCEEDED');
});

test('sanitizes path traversal file names and rejects invalid names', async (t) => {
  const ctx = setup();
  t.after(ctx.cleanup);

  const traversal = await ctx.service.upload(ctx.conversationId, 'req-traversal', [
    {
      fieldName: 'files',
      fileName: '../../../../etc/passwd',
      mimeType: 'image/png',
      content: pngBuffer(40, 40),
    },
  ]);

  assert.equal(traversal.kind, 'ok');
  const batch = ctx.store.getImageUploadBatchByKey(ctx.conversationId, 'req-traversal');
  const children = ctx.store.listImageUploadsByBatch(batch.batchId);
  assert.ok(
    children[0].storedPath.includes('etc_passwd') || !children[0].storedPath.includes('..'),
    'traversal name must be sanitized to a safe stored path'
  );

  const invalid = await ctx.service.upload(ctx.conversationId, 'req-invalid-name', [
    { fieldName: 'files', fileName: '', mimeType: 'image/png', content: pngBuffer(40, 40) },
  ]);

  assert.equal(invalid.kind, 'error');
  assert.equal(invalid.code, 'INVALID_FILE_NAME');
});
