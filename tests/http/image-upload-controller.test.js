const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');

const { createServerApp } = require('../../build/server/app/create-server');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
const { withTempDir } = require('../helpers/temp-dir');
const { pngBuffer } = require('../storage/image-buffers');

isolateExternalIntegrations();

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function buildMultipartBody(fields, boundary = '----testboundary7f9a') {
  const parts = [];
  const delim = `--${boundary}`;

  for (const field of fields) {
    const headerLines = [`Content-Disposition: form-data; name="${field.name}"`];
    if (field.filename) {
      headerLines[0] += `; filename="${field.filename}"`;
    }
    if (field.type) {
      headerLines.push(`Content-Type: ${field.type}`);
    }
    parts.push(Buffer.from(delim));
    parts.push(Buffer.from(headerLines.join('\r\n')));
    parts.push(Buffer.from('\r\n\r\n'));
    parts.push(Buffer.isBuffer(field.value) ? field.value : Buffer.from(String(field.value)));
    parts.push(Buffer.from('\r\n'));
  }

  parts.push(Buffer.from(`${delim}--`));
  parts.push(Buffer.from('\r\n'));

  return Buffer.concat(parts);
}

function multipartHeaders(boundary = '----testboundary7f9a') {
  return {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  };
}

function visionModelCatalog() {
  return {
    getOptions() {
      return [
        { provider: 'openai', model: 'gpt-5', input: ['text', 'image'] },
      ];
    },
  };
}

function visionAgent(id) {
  return {
    id,
    name: 'Vision Agent',
    personaPrompt: 'p',
    provider: 'openai',
    model: 'gpt-5',
  };
}

async function startApp(t, options = {}) {
  const tempDir = withTempDir('caff-img-http-');
  const sqlitePath = path.join(tempDir, 'store.sqlite');
  const port = await findFreePort();
  const uploadsDir = options.uploadsDir || path.join(tempDir, 'uploads');
  const app = createServerApp({
    host: '127.0.0.1',
    port,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
    uploadsDir,
    executeConversationAgent: options.executeConversationAgent,
    modelCatalog: options.modelCatalog || visionModelCatalog(),
  });

  await new Promise((resolve, reject) => {
    app.start((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  t.after(async () => {
    try {
      await new Promise((resolve) => app.close(resolve));
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { app, baseUrl: `http://127.0.0.1:${port}`, uploadsDir };
}

test('GET /api/image-upload/config exposes single-truth constants', async (t) => {
  const { app, baseUrl } = await startApp(t);

  const agent = app.store.saveCustomRoleConfig({ id: 'agent-cfg', name: 'A', personaPrompt: 'p' });
  const conversation = app.store.createConversation({
    title: 'Cfg',
    participants: [{ agentId: agent.id }],
  });
  assert.ok(conversation.id);

  const response = await fetch(`${baseUrl}/api/image-upload/config`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.maxImageBytes, 10_485_760);
  assert.equal(body.maxImagesPerUpload, 5);
  assert.equal(body.maxImagesPerMessage, 5);
  assert.deepEqual(
    Array.from(body.allowedMimeTypes).sort(),
    ['image/gif', 'image/jpeg', 'image/png', 'image/webp']
  );
});

test('POST /api/conversations/:id/images uploads a batch and serves the file from /uploads/', async (t) => {
  const { app, baseUrl } = await startApp(t);

  const agent = app.store.saveCustomRoleConfig({ id: 'agent-u', name: 'A', personaPrompt: 'p' });
  const conversation = app.store.createConversation({
    title: 'Upload',
    participants: [{ agentId: agent.id }],
  });

  const body = buildMultipartBody([
    { name: 'client_request_id', value: 'req-1' },
    { name: 'files', filename: 'photo.png', type: 'image/png', value: pngBuffer(120, 80) },
  ]);

  const uploadResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}/images`, {
    method: 'POST',
    headers: multipartHeaders(),
    body,
  });
  assert.equal(uploadResponse.status, 200);
  const uploadBody = await uploadResponse.json();
  assert.ok(Array.isArray(uploadBody.images));
  assert.equal(uploadBody.images.length, 1);

  const imageId = uploadBody.images[0].imageId;
  assert.ok(imageId);

  const batch = app.store.getImageUploadBatchByKey(conversation.id, 'req-1');
  assert.equal(batch.status, 'complete');

  const children = app.store.listImageUploadsByIds([imageId]);
  assert.equal(children.length, 1);
  assert.equal(children[0].status, 'staged');
  assert.ok(children[0].storedPath.startsWith('/uploads/'));

  const fileResponse = await fetch(`${baseUrl}${children[0].storedPath}`);
  assert.equal(fileResponse.status, 200);
  assert.match(fileResponse.headers.get('content-type') || '', /image\/png/);
});

test('POST upload rejects non-whitelisted magic bytes with structured error', async (t) => {
  const { app, baseUrl } = await startApp(t);

  const agent = app.store.saveCustomRoleConfig({ id: 'agent-bad', name: 'A', personaPrompt: 'p' });
  const conversation = app.store.createConversation({
    title: 'Bad',
    participants: [{ agentId: agent.id }],
  });

  const body = buildMultipartBody([
    { name: 'client_request_id', value: 'req-2' },
    { name: 'files', filename: 'x.png', type: 'image/png', value: 'GARBAGE_NOT_A_PNG' },
  ]);

  const uploadResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}/images`, {
    method: 'POST',
    headers: multipartHeaders(),
    body,
  });
  assert.equal(uploadResponse.status, 400);
  const uploadBody = await uploadResponse.json();
  assert.ok(uploadBody.error);
  assert.ok(uploadBody.error.code);
});

function stubAgentExecutor() {
  return async (input) => {
    const reply = {
      id: `stub-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId: input.conversationId,
      turnId: input.turnId,
      role: 'assistant',
      agentId: input.agent.id,
      senderName: input.agent.name,
      content: 'Stub reply.',
      status: 'completed',
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    input.completedReplies.push(reply);
    return { stopTurn: false, terminationReason: '' };
  };
}

test('upload then send message with imageIds persists contentBlocks and attaches image', async (t) => {
  const { app, baseUrl } = await startApp(t, {
    executeConversationAgent: stubAgentExecutor(),
  });

  const agent = app.store.saveCustomRoleConfig(visionAgent('agent-msg'));
  const conversation = app.store.createConversation({
    title: 'Msg',
    participants: [{ agentId: agent.id }],
  });

  const uploadBody = buildMultipartBody([
    { name: 'client_request_id', value: 'req-msg' },
    { name: 'files', filename: 'photo.png', type: 'image/png', value: pngBuffer(120, 80) },
  ]);
  const uploadResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}/images`, {
    method: 'POST',
    headers: multipartHeaders(),
    body: uploadBody,
  });
  assert.equal(uploadResponse.status, 200);
  const uploadResult = await uploadResponse.json();
  const imageId = uploadResult.images[0].imageId;

  const messageResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'with image',
      imageIds: [imageId],
      clientRequestId: 'msg-1',
    }),
  });
  assert.equal(messageResponse.status, 200);
  const messageResult = await messageResponse.json();
  const acceptedMessage = messageResult.acceptedMessage;

  assert.equal(acceptedMessage.content, 'with image');
  const blocks = acceptedMessage.metadata.contentBlocks;
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: 'text', text: 'with image' });
  assert.equal(blocks[1].type, 'image');
  assert.equal(blocks[1].imageId, imageId);
  assert.ok(blocks[1].url.startsWith('/uploads/'));

  const stored = app.store.listImageUploadsByIds([imageId]);
  assert.equal(stored[0].status, 'attached');
  assert.equal(stored[0].attachedMessageId, acceptedMessage.id);
});

test('sending message with client-submitted contentBlocks is rejected', async (t) => {
  const { app, baseUrl } = await startApp(t);

  const agent = app.store.saveCustomRoleConfig({ id: 'agent-reject', name: 'A', personaPrompt: 'p' });
  const conversation = app.store.createConversation({
    title: 'Reject',
    participants: [{ agentId: agent.id }],
  });

  const messageResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'x',
      metadata: { contentBlocks: [{ type: 'text', text: 'x' }] },
    }),
  });
  assert.equal(messageResponse.status, 400);
  const body = await messageResponse.json();
  assert.equal(body.code, 'TEXT_BLOCK_FROM_CLIENT_REJECTED');
});

test('conversation delete removes uploaded batch directories after DB purge', async (t) => {
  const tempDir = withTempDir('caff-img-delete-');
  const sqlitePath = path.join(tempDir, 'store.sqlite');
  const uploadsDir = path.join(tempDir, 'uploads');
  const port = await findFreePort();
  const app = createServerApp({
    host: '127.0.0.1',
    port,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
    uploadsDir,
  });

  await new Promise((resolve, reject) => {
    app.start((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  t.after(async () => {
    try {
      await new Promise((resolve) => app.close(resolve));
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const agent = app.store.saveCustomRoleConfig({ id: 'agent-del', name: 'A', personaPrompt: 'p' });
  const conversation = app.store.createConversation({
    title: 'Del',
    participants: [{ agentId: agent.id }],
  });

  const body = buildMultipartBody([
    { name: 'client_request_id', value: 'req-del' },
    { name: 'files', filename: 'photo.png', type: 'image/png', value: pngBuffer(120, 80) },
  ]);
  const uploadResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}/images`, {
    method: 'POST',
    headers: multipartHeaders(),
    body,
  });
  assert.equal(uploadResponse.status, 200);
  const uploadResult = await uploadResponse.json();
  const imageId = uploadResult.images[0].imageId;

  const batch = app.store.getImageUploadBatchByKey(conversation.id, 'req-del');
  const batchDir = path.join(uploadsDir, batch.batchId);
  assert.ok(fs.existsSync(batchDir), 'uploaded batch dir must exist before delete');

  const deleteResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}`, {
    method: 'DELETE',
  });
  assert.equal(deleteResponse.status, 200);

  assert.equal(app.store.listImageUploadsByIds([imageId]).length, 0, 'child rows purged');
  assert.equal(app.store.getImageUploadBatch(batch.batchId), null, 'batch rows purged');
  assert.equal(fs.existsSync(batchDir), false, 'batch directory must be removed after conversation delete');
});

test('conversation delete removes .tmp staging dir of a pending batch without children', async (t) => {
  const tempDir = withTempDir('caff-img-delete-tmp-');
  const sqlitePath = path.join(tempDir, 'store.sqlite');
  const uploadsDir = path.join(tempDir, 'uploads');
  const port = await findFreePort();
  const app = createServerApp({
    host: '127.0.0.1',
    port,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
    uploadsDir,
  });

  await new Promise((resolve, reject) => {
    app.start((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  t.after(async () => {
    try {
      await new Promise((resolve) => app.close(resolve));
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const agent = app.store.saveCustomRoleConfig({ id: 'agent-del-tmp', name: 'A', personaPrompt: 'p' });
  const conversation = app.store.createConversation({
    title: 'DelTmp',
    participants: [{ agentId: agent.id }],
  });

  const pendingBatch = app.store.createImageUploadBatch({
    conversationId: conversation.id,
    clientRequestId: 'req-pending',
    requestFingerprint: 'fp-pending',
    expectedCount: 1,
  });
  const pendingTmpDir = path.join(uploadsDir, '.tmp', pendingBatch.batchId, pendingBatch.leaseToken);
  fs.mkdirSync(pendingTmpDir, { recursive: true });
  fs.writeFileSync(path.join(pendingTmpDir, '0-image.png'), pngBuffer(40, 40));
  assert.ok(fs.existsSync(pendingTmpDir), 'pending .tmp staging dir must exist before delete');

  const deleteResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}`, {
    method: 'DELETE',
  });
  assert.equal(deleteResponse.status, 200);

  assert.equal(
    fs.existsSync(path.join(uploadsDir, '.tmp', pendingBatch.batchId)),
    false,
    'pending batch .tmp staging dir must be removed after conversation delete'
  );
});

test('GET /uploads/ rejects path traversal outside the controlled upload dir', async (t) => {
  const { baseUrl } = await startApp(t);

  const traversalResponses = await Promise.all([
    fetch(`${baseUrl}/uploads/..%2F..%2Fstore.sqlite`),
    fetch(`${baseUrl}/uploads/../../../etc/passwd`),
  ]);

  for (const response of traversalResponses) {
    assert.ok(
      response.status === 403 || response.status === 404,
      `path traversal must be blocked (got ${response.status})`
    );
  }
});

test('uploads served with isUpload never emit text/html or image/svg+xml content types', async (t) => {
  const { app, baseUrl, uploadsDir } = await startApp(t);

  const agent = app.store.saveCustomRoleConfig({ id: 'agent-ctype', name: 'A', personaPrompt: 'p' });
  const conversation = app.store.createConversation({
    title: 'CType',
    participants: [{ agentId: agent.id }],
  });

  const body = buildMultipartBody([
    { name: 'client_request_id', value: 'req-ctype' },
    { name: 'files', filename: 'photo.png', type: 'image/png', value: pngBuffer(120, 80) },
  ]);
  const uploadResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}/images`, {
    method: 'POST',
    headers: multipartHeaders(),
    body,
  });
  assert.equal(uploadResponse.status, 200);
  const uploadResult = await uploadResponse.json();
  const imageId = uploadResult.images[0].imageId;

  const child = app.store.listImageUploadsByIds([imageId])[0];
  assert.ok(child.storedPath);

  const batchId = child.storedPath.split('/')[2];
  const batchDir = path.join(uploadsDir, batchId);
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, 'evil.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(batchDir, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  for (const hostileName of ['evil.html', 'evil.svg']) {
    const hostilePath = child.storedPath.replace(/\/0-image\.png$/u, `/${hostileName}`);
    const hostileResponse = await fetch(`${baseUrl}${hostilePath}`);
    assert.equal(hostileResponse.status, 200, `hostile ${hostileName} file must exist on disk`);
    const hostileContentType = String(hostileResponse.headers.get('content-type') || '').toLowerCase();
    assert.ok(
      !hostileContentType.includes('text/html') && !hostileContentType.includes('image/svg+xml'),
      `uploads must not serve active content types, got ${hostileContentType}`
    );
    assert.match(hostileContentType, /application\/octet-stream/u, 'isUpload branch must serve unknown extensions as octet-stream');
  }
});

test('POST upload rejects oversized single file with FILE_TOO_LARGE', async (t) => {
  const { app, baseUrl } = await startApp(t);

  const agent = app.store.saveCustomRoleConfig({ id: 'agent-big', name: 'A', personaPrompt: 'p' });
  const conversation = app.store.createConversation({
    title: 'Big',
    participants: [{ agentId: agent.id }],
  });

  const body = buildMultipartBody([
    { name: 'client_request_id', value: 'req-big' },
    {
      name: 'files',
      filename: 'big.png',
      type: 'image/png',
      value: Buffer.concat([pngBuffer(100, 50), Buffer.alloc(10 * 1024 * 1024)]),
    },
  ]);

  const uploadResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}/images`, {
    method: 'POST',
    headers: multipartHeaders(),
    body,
  });
  assert.equal(uploadResponse.status, 400);
  const uploadBody = await uploadResponse.json();
  assert.equal(uploadBody.error.code, 'FILE_TOO_LARGE');
});

test('restart fixture: image reference and message replay survive process restart', async (t) => {
  const tempDir = withTempDir('caff-img-restart-');
  const sqlitePath = path.join(tempDir, 'store.sqlite');
  const uploadsDir = path.join(tempDir, 'uploads');

  async function startInstance() {
    const port = await findFreePort();
    const instance = createServerApp({
      host: '127.0.0.1',
      port,
      agentDir: tempDir,
      sqlitePath,
      projectDir: tempDir,
      uploadsDir,
      executeConversationAgent: stubAgentExecutor(),
      modelCatalog: visionModelCatalog(),
    });

    await new Promise((resolve, reject) => {
      instance.start((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    return { instance, baseUrl: `http://127.0.0.1:${port}` };
  }

  async function closeInstance(instance) {
    await new Promise((resolve) => instance.close(resolve));
  }

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const first = await startInstance();
  const agent = first.instance.store.saveCustomRoleConfig({
    ...visionAgent(`agent-restart-${Math.random().toString(36).slice(2, 8)}`),
    name: 'A',
  });
  const conversation = first.instance.store.createConversation({
    title: 'Restart',
    participants: [{ agentId: agent.id }],
  });

  let acceptedMessage;
  let imageId;

  try {
    const uploadBody = buildMultipartBody([
      { name: 'client_request_id', value: 'req-restart' },
      { name: 'files', filename: 'photo.png', type: 'image/png', value: pngBuffer(120, 80) },
    ]);
    const uploadResponse = await fetch(`${first.baseUrl}/api/conversations/${conversation.id}/images`, {
      method: 'POST',
      headers: multipartHeaders(),
      body: uploadBody,
    });
    assert.equal(uploadResponse.status, 200);
    const uploadResult = await uploadResponse.json();
    imageId = uploadResult.images[0].imageId;

    const messageResponse = await fetch(`${first.baseUrl}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'survives restart', imageIds: [imageId], clientRequestId: 'msg-restart' }),
    });
    assert.equal(messageResponse.status, 200);
    const messageResult = await messageResponse.json();
    acceptedMessage = messageResult.acceptedMessage;
  } finally {
    await closeInstance(first.instance);
  }

  const second = await startInstance();
  try {
    const stored = second.instance.store.listImageUploadsByIds([imageId]);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, 'attached');
    assert.ok(stored[0].storedPath.startsWith('/uploads/'));

    const replayed = second.instance.store.getMessage(acceptedMessage.id);
    assert.equal(replayed.content, 'survives restart');
    const blocks = replayed.metadata.contentBlocks;
    assert.ok(Array.isArray(blocks));
    const imageBlock = blocks.find((block) => block.type === 'image');
    assert.ok(imageBlock, 'image block must survive restart');
    assert.equal(imageBlock.imageId, imageId);

    const fileResponse = await fetch(`${second.baseUrl}${stored[0].storedPath}`);
    assert.equal(fileResponse.status, 200, 'image must remain reachable from static route after restart');
    assert.match(fileResponse.headers.get('content-type') || '', /image\/png/);
  } finally {
    await closeInstance(second.instance);
  }
});
