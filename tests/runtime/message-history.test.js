const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadMessageHistory() {
  const sourcePath = path.join(__dirname, '../../public/chat/message-history.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const context = { window: { CaffChat: {} } };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return context.window.CaffChat.messageHistory;
}

function message(id, createdAt, content = id) {
  return { id, createdAt, content };
}

test('message history merges pages in stable order and lets incoming rows update existing ids', () => {
  const history = loadMessageHistory();
  const existing = [
    message('b', '2026-07-28T00:00:00.000Z', 'stale-b'),
    message('d', '2026-07-28T00:02:00.000Z'),
  ];
  const incoming = [
    message('a', '2026-07-28T00:00:00.000Z'),
    message('b', '2026-07-28T00:00:00.000Z', 'fresh-b'),
    message('c', '2026-07-28T00:01:00.000Z'),
  ];

  const merged = history.mergeMessages(existing, incoming);

  assert.deepEqual(Array.from(merged, (item) => item.id), ['a', 'b', 'c', 'd']);
  assert.equal(merged[1].content, 'fresh-b');
});

test('message history owns the older cursor while live latest pages merge independently', () => {
  const history = loadMessageHistory();
  const state = history.createState();
  const generation = history.reset(state, 'conversation-a');

  let messages = history.applyInitialPage(state, {
    items: [message('c', '2026-07-28T00:02:00.000Z'), message('d', '2026-07-28T00:03:00.000Z')],
    nextCursor: 'cursor-c',
    hasMore: true,
  });
  messages = history.applyLatestPage(state, messages, {
    items: [message('d', '2026-07-28T00:03:00.000Z', 'updated-d'), message('e', '2026-07-28T00:04:00.000Z')],
    nextCursor: 'must-not-replace-cursor-c',
    hasMore: true,
  });

  assert.equal(state.nextCursor, 'cursor-c');
  assert.equal(state.hasMore, true);
  assert.deepEqual(Array.from(messages, (item) => item.id), ['c', 'd', 'e']);

  const olderRequest = history.beginOlderRequest(state);
  assert.deepEqual(
    { conversationId: olderRequest.conversationId, generation: olderRequest.generation, before: olderRequest.before },
    { conversationId: 'conversation-a', generation, before: 'cursor-c' }
  );
  messages = history.applyOlderPage(state, messages, {
    items: [message('a', '2026-07-28T00:00:00.000Z'), message('b', '2026-07-28T00:01:00.000Z')],
    nextCursor: null,
    hasMore: false,
  });

  assert.deepEqual(Array.from(messages, (item) => item.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(new Set(messages.map((item) => item.id)).size, messages.length);
  assert.equal(state.hasMore, false);
  assert.equal(state.loading, false);
});

test('message history rejects stale conversation and latest-refresh responses', () => {
  const history = loadMessageHistory();
  const state = history.createState();
  history.reset(state, 'conversation-a');
  const firstLatest = history.beginLatestRequest(state);
  const secondLatest = history.beginLatestRequest(state);

  assert.equal(history.isLatestRequestCurrent(state, firstLatest), false);
  assert.equal(history.isLatestRequestCurrent(state, secondLatest), true);

  history.reset(state, 'conversation-b');
  assert.equal(history.isRequestCurrent(state, secondLatest), false);
});

test('message history restores the viewport after older rows increase scroll height', () => {
  const history = loadMessageHistory();
  const scroller = { scrollHeight: 1200, scrollTop: 480 };
  const anchor = history.captureScrollAnchor(scroller);
  scroller.scrollHeight = 1680;

  history.restoreScrollAnchor(scroller, anchor);

  assert.equal(scroller.scrollTop, 960);
});

test('message history exposes hidden, partial, loading, and retry control states', () => {
  const history = loadMessageHistory();
  const state = history.createState();
  history.reset(state, 'conversation-a');

  assert.equal(history.controlView(state).hidden, true);

  history.applyInitialPage(state, { items: [message('a', '2026-07-28T00:00:00.000Z')], nextCursor: 'cursor-a', hasMore: true });
  assert.deepEqual({ ...history.controlView(state) }, {
    hidden: false,
    disabled: false,
    label: '加载更早消息',
    status: '',
  });

  history.beginOlderRequest(state);
  assert.equal(history.controlView(state).disabled, true);
  assert.equal(history.controlView(state).label, '正在加载...');

  history.failOlderRequest(state, new Error('network down'));
  assert.equal(history.controlView(state).label, '重试加载');
  assert.equal(history.controlView(state).status, '更早的消息加载失败');

  history.applyOlderPage(state, [], { items: [], nextCursor: null, hasMore: false });
  assert.equal(history.controlView(state).hidden, true);
});
