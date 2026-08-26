const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createConversationsController } = require('../../build/server/api/conversations-controller');
const { withTempDir } = require('../helpers/temp-dir');

async function invoke(handler, method, requestUrl, body) {
  const url = new URL(requestUrl, 'http://localhost');
  const req = new PassThrough();
  req.method = method;
  req.url = url.pathname + url.search;
  req.headers = { host: 'localhost' };
  const response = { statusCode: 0, body: '' };
  const res = {
    writeHead(statusCode) {
      response.statusCode = statusCode;
    },
    end(chunk = '') {
      response.body = String(chunk || '');
    },
  };
  const handledPromise = handler({ req, res, pathname: url.pathname, requestUrl: url });
  req.end(body === undefined ? '' : JSON.stringify(body));
  const handled = await handledPromise;
  return {
    handled,
    statusCode: response.statusCode,
    json: response.body ? JSON.parse(response.body) : {},
  };
}

function createHarness(t) {
  const tempDir = withTempDir('caff-message-recovery-http-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  const agent = store.saveCustomRoleConfig({ id: 'http-agent', name: 'HTTP Agent', personaPrompt: 'test' });
  const conversation = store.createConversation({
    id: 'http-recovery-conversation',
    title: 'Recovery HTTP',
    participants: [agent.id],
  });
  const message = store.createMessage({
    id: 'http-failed-message',
    conversationId: conversation.id,
    turnId: 'http-turn',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: '',
    status: 'failed',
    taskId: 'http-source-task',
    runId: 101,
    errorMessage: 'stream_read_error',
    metadata: { failure: true },
  });
  const calls = [];
  const recovery = {
    id: 'http-recovery',
    sourceMessageId: message.id,
    sourceTaskId: message.taskId,
    sourceRunId: message.runId,
    recoveryTaskId: 'http-recovery-task',
    recoveryRunId: null,
    recoveryMessageId: null,
    status: 'queued',
    fallbackUsed: false,
  };
  const service = {
    requestRecovery(conversationId, messageId) {
      calls.push({ conversationId, messageId });
      return { recovery, duplicate: false };
    },
    projectMessages(messages) {
      return messages.map((item) => item.id === message.id ? { ...item, recovery } : item);
    },
  };
  const handler = createConversationsController({
    store,
    messageRecoveryService: service,
  });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { store, conversation, message, calls, handler };
}

test('manual recovery endpoint accepts only an empty object and returns durable acknowledgement', async (t) => {
  const { conversation, message, calls, handler } = createHarness(t);
  const accepted = await invoke(
    handler,
    'POST',
    `/api/conversations/${conversation.id}/messages/${message.id}/recovery`,
    {}
  );

  assert.equal(accepted.handled, true);
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json.duplicate, false);
  assert.equal(accepted.json.recovery.id, 'http-recovery');
  assert.deepEqual(calls, [{ conversationId: conversation.id, messageId: message.id }]);

  await assert.rejects(
    () => invoke(
      handler,
      'POST',
      `/api/conversations/${conversation.id}/messages/${message.id}/recovery`,
      { retry: true }
    ),
    (error) => error && error.statusCode === 400 && error.code === 'conversation_recovery_invalid_request'
  );
  assert.equal(calls.length, 1);
});

test('message page includes the canonical recovery projection on its failed source message', async (t) => {
  const { conversation, message, handler } = createHarness(t);
  const page = await invoke(handler, 'GET', `/api/conversations/${conversation.id}/messages`);

  assert.equal(page.statusCode, 200);
  const source = page.json.items.find((item) => item.id === message.id);
  assert.equal(source.status, 'failed');
  assert.equal(source.recovery.id, 'http-recovery');
  assert.equal(source.recovery.status, 'queued');
});
