const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

function createStore(t, prefix = 'caff-rename-guard-') {
  const tempDir = withTempDir(prefix);
  const store = createChatAppStore({ dbPath: path.join(tempDir, 'chat.sqlite') });
  t.after(() => store.close());
  return store;
}

function createConversation(store, title = 'New Conversation') {
  return store.createConversation({
    title,
    participants: ['role-family-gpt'],
  });
}

test('manual rename via updateConversation marks titleSource as manual', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  const renamed = store.updateConversation(conversation.id, {
    title: '我的专属标题',
    titleSource: 'manual',
  });

  assert.equal(renamed.title, '我的专属标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('title write without explicit titleSource defaults to manual (legacy UI rename semantics)', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  const renamed = store.updateConversation(conversation.id, { title: 'Legacy Rename' });

  assert.equal(renamed.title, 'Legacy Rename');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('after manual rename, simulated first-message truncate write is rejected and title stays unchanged', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, { title: '手动锁定标题', titleSource: 'manual' });

  // 模拟 first-msg-truncate 节点逻辑：首条用户消息到达后截取标题并尝试写回
  const attempted = store.updateConversation(conversation.id, {
    title: '首条消息截断出的标题',
    titleSource: 'auto_first_message',
  });

  assert.equal(attempted.title, '手动锁定标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
  const persisted = store.getConversationWithoutMessages(conversation.id);
  assert.equal(persisted.title, '手动锁定标题');
});

test('after manual rename, simulated llm-refine write is rejected and title stays unchanged', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, { title: '手动锁定标题', titleSource: 'manual' });

  // 模拟 llm-refine-title 节点逻辑：首次摘要生成后精炼标题并尝试写回
  const attempted = store.updateConversation(conversation.id, {
    title: '精炼后的标题',
    titleSource: 'auto_llm',
  });

  assert.equal(attempted.title, '手动锁定标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
  const persisted = store.getConversationWithoutMessages(conversation.id);
  assert.equal(persisted.title, '手动锁定标题');
});

test('after manual rename, full simulated flow: truncate then llm-refine, both skipped', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, { title: '最终标题', titleSource: 'manual' });

  store.updateConversation(conversation.id, { title: 'truncate 结果', titleSource: 'auto_first_message' });
  store.updateConversation(conversation.id, { title: 'llm 精炼结果', titleSource: 'auto_llm' });

  const persisted = store.getConversationWithoutMessages(conversation.id);
  assert.equal(persisted.title, '最终标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('manual title is not sticky before any rename: auto_first_message and auto_llm still apply', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  const afterTruncate = store.updateConversation(conversation.id, {
    title: '首条消息截断',
    titleSource: 'auto_first_message',
  });
  assert.equal(afterTruncate.title, '首条消息截断');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_first_message');

  const afterRefine = store.updateConversation(conversation.id, {
    title: '精炼标题',
    titleSource: 'auto_llm',
  });
  assert.equal(afterRefine.title, '精炼标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_llm');
});

test('manual rename can be applied repeatedly (user may rename again)', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, { title: '第一次改名', titleSource: 'manual' });

  const renamed = store.updateConversation(conversation.id, { title: '第二次改名', titleSource: 'manual' });

  assert.equal(renamed.title, '第二次改名');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('participants-only settings save after manual rename keeps title and titleSource untouched', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, { title: '锁定标题', titleSource: 'manual' });

  // 模拟会话设置保存：只提交 participants，不回写标题
  const updated = store.updateConversation(conversation.id, {
    participants: ['role-family-gpt'],
  });

  assert.equal(updated.title, '锁定标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('participants-only settings save on a fresh conversation does not accidentally mark manual', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  store.updateConversation(conversation.id, { participants: ['role-family-gpt'] });

  assert.equal(store.getConversationTitleSource(conversation.id), 'default');

  // 自动标题流程仍可进行
  const afterTruncate = store.updateConversation(conversation.id, {
    title: '自动标题',
    titleSource: 'auto_first_message',
  });
  assert.equal(afterTruncate.title, '自动标题');
});
