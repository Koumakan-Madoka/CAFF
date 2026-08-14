const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../../public/chat/conversation-directory.js'),
  'utf8'
);

function loadDirectory() {
  const context = {
    URLSearchParams,
    window: { CaffChat: {} },
  };
  vm.runInNewContext(SOURCE, context, { filename: 'conversation-directory.js' });
  return context.window.CaffChat.conversationDirectory;
}

test('conversation directory merges paged items without losing order or duplicating ids', () => {
  const directory = loadDirectory();
  const state = directory.createState();
  directory.applyBootstrap(state, {
    conversations: [{ id: 'new', title: 'New' }, { id: 'shared', title: 'Old shared' }],
    conversationsNextCursor: 'cursor-1',
    conversationsHasMore: true,
  });

  const request = directory.beginRequest(state, '', true);
  assert.equal(request.before, 'cursor-1');
  assert.equal(directory.applyPage(state, {
    conversations: [{ id: 'shared', title: 'Updated shared' }, { id: 'older', title: 'Older' }],
    nextCursor: null,
    hasMore: false,
    query: '',
  }, request), true);
  assert.deepEqual(Array.from(state.items, (item) => item.id), ['new', 'shared', 'older']);
  assert.equal(state.items[1].title, 'Updated shared');
  assert.equal(state.hasMore, false);
});

test('conversation directory search resets the cursor and binds request URLs to the query', () => {
  const directory = loadDirectory();
  const state = directory.createState();
  directory.applyBootstrap(state, {
    conversations: [{ id: 'old' }],
    conversationsNextCursor: 'stale-cursor',
    conversationsHasMore: true,
  });

  const request = directory.beginRequest(state, '  image   upload  ', false);
  assert.equal(request.before, null);
  assert.deepEqual(Array.from(state.items, (item) => item.id), ['old'], 'search keeps the current page visible while loading');
  assert.equal(directory.buildUrl(state, request), '/api/conversations?limit=50&q=image+upload');
  assert.equal(directory.applyPage(state, {
    conversations: [{ id: 'match' }],
    nextCursor: 'search-cursor',
    hasMore: true,
    query: 'image upload',
  }, request), true);
  assert.deepEqual(Array.from(state.items, (item) => item.id), ['match']);
  assert.equal(state.nextCursor, 'search-cursor');
});

test('conversation directory exposes retryable errors and ignores stale responses', () => {
  const directory = loadDirectory();
  const state = directory.createState();
  const first = directory.beginRequest(state, 'first', false);
  const second = directory.beginRequest(state, 'second', false);
  assert.ok(second, 'a newer search must supersede an in-flight search');
  assert.equal(directory.failRequest(state, first, new Error('stale network')), false);
  assert.equal(directory.failRequest(state, second, new Error('network')), true);
  assert.equal(state.error, 'network');
  const retry = directory.beginRequest(state, 'second', false);
  assert.equal(directory.applyPage(state, { conversations: [{ id: 'fresh' }] }, first), false);
  assert.equal(directory.applyPage(state, { conversations: [{ id: 'fresh' }] }, retry), true);
  assert.equal(state.error, '');
});
