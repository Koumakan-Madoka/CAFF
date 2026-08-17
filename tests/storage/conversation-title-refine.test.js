const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { maybeAutoCreateConversationDigest } = require('../../build/server/domain/conversation/conversation-digest');
const { withTempDir } = require('../helpers/temp-dir');

function createStore(t, prefix = 'caff-title-refine-') {
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

function appendPublicMessages(store, conversationId, startIndex, count) {
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset;
    store.createMessage({
      id: `title-refine-message-${conversationId}-${index}`,
      conversationId,
      turnId: `title-refine-turn-${conversationId}-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      senderName: index % 2 === 0 ? 'User' : 'Builder',
      content: `标题精炼消息 ${index}：讨论 DAG 工作流自动标题生成方案。`,
    });
  }
}

function digestOptions(runner, overrides = {}) {
  return {
    autoCreate: true,
    autoCreateMessageBudget: 2,
    autoCreateIdleMs: 0,
    autoCreateCooldownMs: 0,
    summaryMode: 'extractive',
    digestModelRunner: runner,
    ...overrides,
  };
}

test('first auto digest refines the title once and writes titleSource auto_llm', async (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  const runnerCalls = [];
  const runner = async (context) => {
    runnerCalls.push(context);
    return 'DAG 自动标题方案';
  };

  appendPublicMessages(store, conversation.id, 1, 2);
  const result = await maybeAutoCreateConversationDigest(store, conversation.id, digestOptions(runner));

  assert.equal(result.digestChanged, true);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].purpose, 'title_refine');
  assert.match(runnerCalls[0].prompt, /标题精炼消息 1/u);

  const updated = store.getConversation(conversation.id);
  assert.equal(updated.title, 'DAG 自动标题方案');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_llm');
  assert.ok(updated.metadata.titleRefinedAt);
  assert.equal(updated.metadata.conversationDigests.length, 1);
  assert.equal(result.conversation.title, 'DAG 自动标题方案');

  // 第二次 digest：不再是首次摘要，且 titleSource 已是 auto_llm —— 不再触发。
  appendPublicMessages(store, conversation.id, 3, 2);
  const second = await maybeAutoCreateConversationDigest(store, conversation.id, digestOptions(runner));
  assert.equal(second.digestChanged, true);
  assert.equal(runnerCalls.length, 1);
  assert.equal(store.getConversation(conversation.id).title, 'DAG 自动标题方案');
});

test('auto_first_message title is upgraded to auto_llm by refine', async (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, { title: '首条消息标题', titleSource: 'auto_first_message' });

  const runnerCalls = [];
  appendPublicMessages(store, conversation.id, 1, 2);
  await maybeAutoCreateConversationDigest(store, conversation.id, digestOptions(async (context) => {
    runnerCalls.push(context);
    return '精炼后的标题';
  }));

  assert.equal(runnerCalls.length, 1);
  const updated = store.getConversation(conversation.id);
  assert.equal(updated.title, '精炼后的标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_llm');
});

test('model failure keeps the existing title and does not block the digest', async (t) => {
  const store = createStore(t);
  const conversation = createConversation(store, '原始标题');
  store.updateConversation(conversation.id, { title: '原始标题', titleSource: 'auto_first_message' });
  const runnerCalls = [];
  const runner = async (context) => {
    runnerCalls.push(context);
    throw new Error('simulated title model failure');
  };

  appendPublicMessages(store, conversation.id, 1, 2);
  const result = await maybeAutoCreateConversationDigest(store, conversation.id, digestOptions(runner));

  assert.equal(result.digestChanged, true);
  assert.equal(runnerCalls.length, 1);
  const updated = store.getConversation(conversation.id);
  assert.equal(updated.title, '原始标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_first_message');
  assert.equal(updated.metadata.titleRefinedAt, undefined);
  assert.equal(updated.metadata.conversationDigests.length, 1);
});

test('blank or over-long model output falls back to the existing title', async (t) => {
  const store = createStore(t);

  const blankConversation = createConversation(store, 'Blank Title');
  store.updateConversation(blankConversation.id, { title: 'Blank Title', titleSource: 'auto_first_message' });
  appendPublicMessages(store, blankConversation.id, 1, 2);
  const blankResult = await maybeAutoCreateConversationDigest(store, blankConversation.id, digestOptions(async () => '  ""  '));
  assert.equal(blankResult.digestChanged, true);
  assert.equal(store.getConversation(blankConversation.id).title, 'Blank Title');
  assert.equal(store.getConversationTitleSource(blankConversation.id), 'auto_first_message');

  const longConversation = createConversation(store, 'Long Title');
  appendPublicMessages(store, longConversation.id, 11, 2);
  await maybeAutoCreateConversationDigest(store, longConversation.id, digestOptions(async () => '这是一个非常非常长的模型生成标题超出了上限'));
  const longUpdated = store.getConversation(longConversation.id);
  assert.equal(longUpdated.title.length <= 15, true);
  assert.equal(store.getConversationTitleSource(longConversation.id), 'auto_llm');
});

test('manual title is never refined', async (t) => {
  const store = createStore(t);
  const conversation = createConversation(store, '原始标题');
  store.updateConversation(conversation.id, { title: '用户手动命名' });
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');

  const runnerCalls = [];
  appendPublicMessages(store, conversation.id, 1, 2);
  const result = await maybeAutoCreateConversationDigest(store, conversation.id, digestOptions(async (context) => {
    runnerCalls.push(context);
    return '不应出现的标题';
  }));

  assert.equal(result.digestChanged, true);
  assert.equal(runnerCalls.length, 0);
  assert.equal(store.getConversation(conversation.id).title, '用户手动命名');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('manual rename during the title model call wins the write-time race', async (t) => {
  const store = createStore(t, 'caff-title-refine-race-');
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, {
    title: '首条消息标题',
    titleSource: 'auto_first_message',
  });

  let runnerCalls = 0;
  appendPublicMessages(store, conversation.id, 1, 2);
  const result = await maybeAutoCreateConversationDigest(store, conversation.id, digestOptions(async () => {
    runnerCalls += 1;
    store.updateConversation(conversation.id, { title: '模型运行期间手动改名' });
    return '迟到的模型标题';
  }));

  assert.equal(result.digestChanged, true);
  assert.equal(runnerCalls, 1);
  const updated = store.getConversation(conversation.id);
  assert.equal(updated.title, '模型运行期间手动改名');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
  assert.equal(updated.metadata.titleRefinedAt, undefined);
});

test('autoTitleRefine: false disables the refine call', async (t) => {
  const store = createStore(t);
  const conversation = createConversation(store, '保留标题');
  store.updateConversation(conversation.id, { title: '保留标题', titleSource: 'auto_first_message' });
  const runnerCalls = [];

  appendPublicMessages(store, conversation.id, 1, 2);
  const result = await maybeAutoCreateConversationDigest(
    store,
    conversation.id,
    digestOptions(async (context) => {
      runnerCalls.push(context);
      return '不应触发';
    }, { autoTitleRefine: false })
  );

  assert.equal(result.digestChanged, true);
  assert.equal(runnerCalls.length, 0);
  assert.equal(store.getConversation(conversation.id).title, '保留标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_first_message');
});

test('metadata-only digest writes do not flip titleSource to manual', async (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  // below_budget 路径也会写 digest state metadata；来源必须保持 default。
  appendPublicMessages(store, conversation.id, 1, 1);
  await maybeAutoCreateConversationDigest(store, conversation.id, digestOptions(async () => '不应触发', {
    autoCreateMessageBudget: 10,
  }));
  assert.equal(store.getConversationTitleSource(conversation.id), 'default');
});

