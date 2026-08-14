const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  createConversationsController,
} = require('../../build/server/api/conversations-controller');

async function invoke(controller, options = {}) {
  const pathname = options.pathname || '/api/conversations/source-conversation/spawn';
  const req = new PassThrough();
  req.method = options.method || 'POST';
  req.headers = { 'content-type': 'application/json' };
  const state = { body: '', statusCode: 0 };
  const res = {
    writeHead(statusCode) {
      state.statusCode = statusCode;
    },
    end(chunk = '') {
      state.body = String(chunk || '');
    },
  };
  const requestUrl = new URL(`http://127.0.0.1${pathname}`);
  const handledPromise = controller({ req, res, pathname: requestUrl.pathname, requestUrl });
  req.end(JSON.stringify(options.body || {}));
  const handled = await handledPromise;

  return {
    handled,
    statusCode: state.statusCode,
    json: state.body ? JSON.parse(state.body) : {},
  };
}

function requestBody(overrides = {}) {
  return {
    title: 'Spawned Child',
    projectScopeId: 'project-1',
    participants: [{ agentId: 'primary-agent' }, { agentId: 'observer-agent' }],
    primaryAgentId: 'primary-agent',
    initialMessage: 'Complete public handoff message.',
    sourceMessageId: 'source-message',
    clientRequestId: 'spawn-controller-request',
    ...overrides,
  };
}

test('spawn route delegates the exact source/body and returns canonical child, summaries, and bootstrap delivery', async () => {
  const calls = [];
  const conversation = {
    id: 'child-conversation',
    title: 'Spawned Child',
    parentConversationId: 'source-conversation',
    originConversationId: 'source-conversation',
    originMessageId: 'source-message',
    treeDepth: 1,
    agents: [{ id: 'primary-agent' }, { id: 'observer-agent' }],
    messages: [{ id: 'initial-message' }],
    metadata: {},
  };
  const result = {
    duplicate: false,
    conversation,
    initialMessage: { id: 'initial-message', role: 'user' },
    sourceReceipt: { id: 'source-receipt', role: 'system' },
    delivery: { id: 'bootstrap-delivery', kind: 'bootstrap', dispatchStatus: 'queued' },
  };
  const controller = createConversationsController({
    store: {
      listConversationTree() {
        return [{ id: 'source-conversation' }, { id: 'child-conversation', parentConversationId: 'source-conversation' }];
      },
    },
    conversationSpawnService: {
      spawn(sourceConversationId, body) {
        calls.push({ sourceConversationId, body });
        return result;
      },
    },
  });

  const response = await invoke(controller, { body: requestBody() });

  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls, [{ sourceConversationId: 'source-conversation', body: requestBody() }]);
  assert.equal(response.json.conversation.id, conversation.id);
  assert.equal(response.json.summary.parentConversationId, 'source-conversation');
  assert.equal(response.json.initialMessage.id, 'initial-message');
  assert.equal(response.json.sourceReceipt.id, 'source-receipt');
  assert.equal(response.json.delivery.id, 'bootstrap-delivery');
  assert.equal(response.json.conversations.length, 2);
});

test('spawn route rejects unknown fields before domain execution', async () => {
  let callCount = 0;
  const controller = createConversationsController({
    store: { listConversationTree: () => [] },
    conversationSpawnService: {
      spawn() {
        callCount += 1;
        return null;
      },
    },
  });

  await assert.rejects(
    () => invoke(controller, {
      body: requestBody({
        metadata: { copiedFromParent: true },
        sourceConversationId: 'spoofed-source',
      }),
    }),
    (error) => error && error.statusCode === 400
      && error.issues[0].code === 'conversation_spawn_unknown_field'
  );
  assert.equal(callCount, 0);
});

test('conversation list route returns the paged activity-ordered directory when supported', async () => {
  const controller = createConversationsController({
    store: {
      listConversations() {
        return [{ id: 'activity-child' }, { id: 'root' }];
      },
      listConversationTree() {
        return [{ id: 'root' }, { id: 'activity-child', parentConversationId: 'root' }];
      },
      listConversationDirectoryPage(options) {
        assert.deepEqual(options, { limit: 50, query: '', before: null });
        return {
          items: [{ id: 'activity-child' }, { id: 'root' }],
          nextCursor: null,
          hasMore: false,
        };
      },
    },
  });

  const response = await invoke(controller, {
    pathname: '/api/conversations',
    method: 'GET',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json.conversations.map((conversation) => conversation.id), ['activity-child', 'root']);
  assert.equal(response.json.hasMore, false);
});
