const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');

const { createServerApp } = require('../../build/server/app/create-server');
const { withTempDir } = require('../helpers/temp-dir');
const { pngBuffer } = require('../storage/image-buffers');

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

async function startApp(t, options = {}) {
  const tempDir = withTempDir('caff-img-http-');
  const sqlitePath = path.join(tempDir, 'store.sqlite');
  const port = await findFreePort();
  const app = createServerApp({
    host: '127.0.0.1',
    port,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
    uploadsDir: path.join(tempDir, 'uploads'),
    executeConversationAgent: options.executeConversationAgent,
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

  return { app, baseUrl: `http://127.0.0.1:${port}` };
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

  const agent = app.store.saveCustomRoleConfig({ id: 'agent-msg', name: 'A', personaPrompt: 'p' });
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
