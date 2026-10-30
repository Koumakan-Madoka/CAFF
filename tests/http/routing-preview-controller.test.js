const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  createConversationsController,
} = require('../../build/server/api/conversations-controller');
const { createHttpError } = require('../../build/server/http/http-errors');

async function invoke(controller, options = {}) {
  const method = options.method || 'POST';
  const pathname = options.pathname || '/api/conversations/conversation-1/routing-preview';
  const req = new PassThrough();
  req.method = method;
  req.headers = options.body === undefined ? {} : { 'content-type': 'application/json' };
  const state = { body: '', headers: {}, statusCode: 0 };
  const res = {
    writeHead(statusCode, headers) {
      state.statusCode = statusCode;
      state.headers = headers || {};
    },
    end(chunk = '') {
      state.body = String(chunk || '');
    },
  };
  const requestUrl = new URL(`http://127.0.0.1${pathname}`);
  const handledPromise = controller({ req, res, pathname: requestUrl.pathname, requestUrl });
  req.end(options.body === undefined ? '' : JSON.stringify(options.body));
  const handled = await handledPromise;

  return {
    handled,
    statusCode: state.statusCode,
    json: state.body ? JSON.parse(state.body) : {},
  };
}

function createController(previewRouting) {
  return createConversationsController({
    store: {},
    turnOrchestrator: {
      previewRouting,
    },
  });
}

test('routing-preview route forwards the draft content and returns the orchestrator preview', async () => {
  const calls = [];
  const preview = {
    conversationId: 'conversation-1',
    agentIds: ['agent-b'],
    agents: [{ id: 'agent-b', name: 'Beta' }],
    strategy: 'user_mentions',
    executionMode: 'serial',
    explicitIntent: '',
  };
  const controller = createController((conversationId, input) => {
    calls.push({ conversationId, input });
    return preview;
  });

  const result = await invoke(controller, { body: { content: '@Beta hello' } });

  assert.equal(result.handled, true);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json, preview);
  assert.deepEqual(calls, [{ conversationId: 'conversation-1', input: { content: '@Beta hello' } }]);
});

test('routing-preview route rejects malformed bodies and unknown fields', async () => {
  const controller = createController(() => {
    throw new Error('previewRouting must not be called for invalid requests');
  });

  await assert.rejects(
    invoke(controller, { body: { content: 'hi', extra: true } }),
    (error) => error && error.statusCode === 400
  );
  await assert.rejects(
    invoke(controller, { body: { content: 42 } }),
    (error) => error && error.statusCode === 400
  );
  await assert.rejects(
    invoke(controller, { body: ['not-an-object'] }),
    (error) => error && error.statusCode === 400
  );
});

test('routing-preview route only handles POST and reports unavailable orchestrator support', async () => {
  const controller = createController(() => ({}));

  const getResult = await invoke(controller, { method: 'GET', body: undefined });
  assert.equal(getResult.handled, false);

  const unsupported = createConversationsController({ store: {}, turnOrchestrator: {} });
  await assert.rejects(
    invoke(unsupported, { body: { content: 'hi' } }),
    (error) => error && error.statusCode === 501
  );
});

test('routing-preview route surfaces orchestrator rejection for unknown conversations', async () => {
  const controller = createController(() => {
    throw createHttpError(404, 'Conversation not found');
  });

  await assert.rejects(
    invoke(controller, { body: { content: 'hi' } }),
    (error) => error && error.statusCode === 404
  );
});
