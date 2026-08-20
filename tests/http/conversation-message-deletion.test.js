const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createConversationsController } = require('../../build/server/api/conversations-controller');
const {
  createConversationMessageDeletionService,
} = require('../../build/server/domain/conversation/message-deletion');
const {
  createConversationMutationCoordinator,
} = require('../../build/server/domain/conversation/conversation-mutation-coordinator');
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
  const tempDir = withTempDir('caff-message-delete-http-');
  const store = createChatAppStore({ sqlitePath: path.join(tempDir, 'chat.sqlite') });
  const agent = store.saveCustomRoleConfig({
    id: 'delete-http-agent',
    name: 'Delete HTTP Agent',
    personaPrompt: 'Test deletion HTTP.',
  });
  const conversation = store.createConversation({
    id: 'delete-http-conversation',
    title: 'Delete HTTP',
    participants: [{ agentId: agent.id }],
  });
  const mutationCoordinator = createConversationMutationCoordinator();
  const turnOrchestrator = {
    getConversationMutationState() {
      return {
        active: false,
        dispatching: false,
        activeTurnCount: 0,
        activeAgentSlotCount: 0,
        queuedUserCount: 0,
        queuedAgentSlotCount: 0,
        busy: false,
      };
    },
  };
  const service = createConversationMessageDeletionService({
    store,
    mutationCoordinator,
    turnOrchestrator,
    uploadService: { removeBatchDirectories: () => 0 },
  });
  const handler = createConversationsController({
    store,
    turnOrchestrator,
    conversationMessageDeletionService: service,
    conversationMutationCoordinator: mutationCoordinator,
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { store, conversation, mutationCoordinator, handler };
}

test('message page projects deletion eligibility and batch endpoint deletes selected ids', async (t) => {
  const { store, conversation, handler } = createHarness(t);
  const message = store.createMessage({
    conversationId: conversation.id,
    role: 'user',
    senderName: 'You',
    content: 'delete through HTTP',
  });

  const originalListMessages = store.listMessages;
  store.listMessages = () => {
    throw new Error('message page eligibility must not hydrate the full conversation');
  };
  const page = await invoke(handler, 'GET', `/api/conversations/${conversation.id}/messages`);
  store.listMessages = originalListMessages;
  assert.equal(page.statusCode, 200);
  assert.equal(page.json.items[0].deletionEligibility.eligible, true);
  assert.equal(page.json.deletionState.available, true);

  const deleted = await invoke(handler, 'POST', `/api/conversations/${conversation.id}/messages/delete`, {
    messageIds: [message.id],
  });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json.deletedMessageIds, [message.id]);
  assert.equal(JSON.stringify(deleted.json).includes('delete through HTTP'), false);
  assert.equal(store.getMessage(message.id), null);
});

test('message deletion endpoint rejects unknown fields and manual digest honors the shared mutation lock', async (t) => {
  const { conversation, mutationCoordinator, handler } = createHarness(t);

  await assert.rejects(
    () => invoke(handler, 'POST', `/api/conversations/${conversation.id}/messages/delete`, {
      messageIds: ['message-1'],
      force: true,
    }),
    (error) => error && error.statusCode === 400 && error.code === 'conversation_message_delete_invalid_request'
  );

  const lease = mutationCoordinator.tryAcquire(conversation.id, 'message_delete');
  assert.equal(lease.acquired, true);
  await assert.rejects(
    () => invoke(handler, 'POST', `/api/conversations/${conversation.id}/digest`, { action: 'clear' }),
    (error) => error && error.statusCode === 409 && error.code === 'conversation_digest_running'
  );
  lease.release();
});
