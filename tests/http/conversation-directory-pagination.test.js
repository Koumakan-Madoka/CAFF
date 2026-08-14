const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createConversationsController } = require('../../build/server/api/conversations-controller');

async function invoke(controller, options = {}) {
  const req = new PassThrough();
  req.method = options.method || 'GET';
  req.headers = { host: '127.0.0.1:4312' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const result = { statusCode: 0, body: '' };
  const res = {
    writeHead(statusCode) {
      result.statusCode = statusCode;
    },
    end(body = '') {
      result.body = String(body);
    },
  };
  const pathname = options.pathname || '/api/conversations';
  const requestUrl = new URL(`http://127.0.0.1:4312${pathname}`);
  const handledPromise = controller({ req, res, pathname: requestUrl.pathname, requestUrl });
  req.end();
  const handled = await handledPromise;
  return { handled, statusCode: result.statusCode, json: result.body ? JSON.parse(result.body) : {} };
}

function createController() {
  return createConversationsController({
    store: {
      listConversationDirectoryPage() {
        return {
          items: [{ id: 'conversation-1', title: 'Conversation 1' }],
          nextCursor: null,
          hasMore: false,
        };
      },
    },
  });
}

function createPagedController() {
  return createConversationsController({
    store: {
      listConversationDirectoryPage(options) {
        if (!options.before) {
          return {
            items: [{ id: 'match-new' }],
            nextCursor: { activityAt: '2026-08-12T00:00:00.000Z', id: 'match-new' },
            hasMore: true,
          };
        }
        assert.deepEqual(options.before, { activityAt: '2026-08-12T00:00:00.000Z', id: 'match-new' });
        return { items: [{ id: 'match-old' }], nextCursor: null, hasMore: false };
      },
    },
  });
}

test('conversation directory GET returns a paged search contract', async () => {
  const response = await invoke(createController(), {
    pathname: '/api/conversations?limit=10&q=needle',
  });

  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, {
    conversations: [{ id: 'conversation-1', title: 'Conversation 1' }],
    nextCursor: null,
    hasMore: false,
    query: 'needle',
  });
});

test('conversation directory GET rejects malformed limits and query-bound cursors', async () => {
  await assert.rejects(
    () => invoke(createController(), { pathname: '/api/conversations?limit=0' }),
    (error) => error.statusCode === 400
  );

  const cursor = Buffer.from(JSON.stringify({
    v: 1,
    query: 'other-query',
    updatedAt: '2026-08-13T00:00:00.000Z',
    id: 'conversation-1',
  }), 'utf8').toString('base64url');
  await assert.rejects(
    () => invoke(createController(), { pathname: `/api/conversations?q=needle&before=${cursor}` }),
    (error) => error.statusCode === 400
  );
});

test('conversation directory pages search results with a stable query-bound cursor', async () => {
  const controller = createPagedController();
  const first = await invoke(controller, { pathname: '/api/conversations?limit=1&q=needle' });
  assert.deepEqual(first.json.conversations, [{ id: 'match-new' }]);
  assert.equal(first.json.hasMore, true);
  const second = await invoke(controller, {
    pathname: `/api/conversations?limit=1&q=needle&before=${encodeURIComponent(first.json.nextCursor)}`,
  });
  assert.deepEqual(second.json.conversations, [{ id: 'match-old' }]);
  assert.equal(second.json.hasMore, false);
});
