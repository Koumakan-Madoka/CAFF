const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  createConversationsController,
} = require('../../build/server/api/conversations-controller');
const { withTempDir } = require('../helpers/temp-dir');

function createStore(t, prefix = 'caff-rename-guard-http-') {
  const tempDir = withTempDir(prefix);
  const store = createChatAppStore({ dbPath: path.join(tempDir, 'chat.sqlite') });
  t.after(() => store.close());
  return store;
}

async function invokePut(controller, conversationId, body) {
  const req = new PassThrough();
  req.method = 'PUT';
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
  const pathname = `/api/conversations/${encodeURIComponent(conversationId)}`;
  const requestUrl = new URL(`http://127.0.0.1${pathname}`);
  const handledPromise = controller({ req, res, pathname: requestUrl.pathname, requestUrl });
  req.end(JSON.stringify(body));
  const handled = await handledPromise;

  return {
    handled,
    statusCode: state.statusCode,
    json: state.body ? JSON.parse(state.body) : {},
  };
}

test('PUT rename with explicit titleSource manual marks the conversation as manual', async (t) => {
  const store = createStore(t);
  const conversation = store.createConversation({
    title: 'New Conversation',
    participants: ['role-family-gpt'],
  });
  const controller = createConversationsController({ store });

  const response = await invokePut(controller, conversation.id, {
    title: '手动命名',
    titleSource: 'manual',
  });

  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.conversation.title, '手动命名');
  assert.equal(response.json.conversation.metadata.titleSource, 'manual');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('PUT rename without titleSource defaults to manual', async (t) => {
  const store = createStore(t);
  const conversation = store.createConversation({
    title: 'New Conversation',
    participants: ['role-family-gpt'],
  });
  const controller = createConversationsController({ store });

  const response = await invokePut(controller, conversation.id, { title: '隐式手动改名' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.conversation.title, '隐式手动改名');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('after manual rename via API, simulated truncate and llm-refine writes keep the title unchanged', async (t) => {
  const store = createStore(t);
  const conversation = store.createConversation({
    title: 'New Conversation',
    participants: ['role-family-gpt'],
  });
  const controller = createConversationsController({ store });

  await invokePut(controller, conversation.id, { title: '锁定标题', titleSource: 'manual' });

  // 模拟 first-msg-truncate：首条消息截断写回
  const truncateAttempt = await invokePut(controller, conversation.id, {
    title: '首条消息截断标题',
    titleSource: 'auto_first_message',
  });
  assert.equal(truncateAttempt.statusCode, 200);
  assert.equal(truncateAttempt.json.conversation.title, '锁定标题');

  // 模拟 llm-refine-title：首次摘要后精炼写回
  const refineAttempt = await invokePut(controller, conversation.id, {
    title: 'LLM 精炼标题',
    titleSource: 'auto_llm',
  });
  assert.equal(refineAttempt.statusCode, 200);
  assert.equal(refineAttempt.json.conversation.title, '锁定标题');

  const persisted = store.getConversationWithoutMessages(conversation.id);
  assert.equal(persisted.title, '锁定标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('auto-title chain still applies before any manual rename', async (t) => {
  const store = createStore(t);
  const conversation = store.createConversation({
    title: 'New Conversation',
    participants: ['role-family-gpt'],
  });
  const controller = createConversationsController({ store });

  const truncateResult = await invokePut(controller, conversation.id, {
    title: '截断标题',
    titleSource: 'auto_first_message',
  });
  assert.equal(truncateResult.json.conversation.title, '截断标题');

  const refineResult = await invokePut(controller, conversation.id, {
    title: '精炼标题',
    titleSource: 'auto_llm',
  });
  assert.equal(refineResult.json.conversation.title, '精炼标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_llm');
});

test('metadata 旁路注入 titleSource 无法绕过 manual 终态保护（经 API）', async (t) => {
  const store = createStore(t);
  const conversation = store.createConversation({
    title: 'New Conversation',
    participants: ['role-family-gpt'],
  });
  const controller = createConversationsController({ store });

  await invokePut(controller, conversation.id, { title: '锁定标题', titleSource: 'manual' });

  // 不写标题、只在 metadata 中夹带 titleSource 尝试降级：状态机独占维护，注入被覆盖
  const bypassAttempt = await invokePut(controller, conversation.id, {
    metadata: { titleSource: 'default' },
  });
  assert.equal(bypassAttempt.statusCode, 200);
  assert.equal(bypassAttempt.json.conversation.title, '锁定标题');
  assert.equal(bypassAttempt.json.conversation.metadata.titleSource, 'manual');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});
