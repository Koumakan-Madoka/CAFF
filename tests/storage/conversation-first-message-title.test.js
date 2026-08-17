const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS,
  deriveTitleFromFirstMessage,
  normalizeFirstMessageTitleText,
} = require('../../build/lib/conversation-first-message-title');
const { withTempDir } = require('../helpers/temp-dir');

function createStore(t, prefix = 'caff-first-msg-title-') {
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

// ---------- 纯函数：normalizeFirstMessageTitleText ----------

test('normalizeFirstMessageTitleText strips newlines and collapses whitespace', () => {
  assert.equal(normalizeFirstMessageTitleText('hello\nworld'), 'hello world');
  assert.equal(normalizeFirstMessageTitleText('a\r\nb\rc'), 'a b c');
  assert.equal(normalizeFirstMessageTitleText('  多  个\t空格   折叠  '), '多 个 空格 折叠');
  assert.equal(normalizeFirstMessageTitleText(' 不间断空格 '), '不间断空格');
});

test('normalizeFirstMessageTitleText handles nullish input', () => {
  assert.equal(normalizeFirstMessageTitleText(undefined), '');
  assert.equal(normalizeFirstMessageTitleText(null), '');
  assert.equal(normalizeFirstMessageTitleText(42), '42');
});

// ---------- 纯函数：deriveTitleFromFirstMessage ----------

test('deriveTitleFromFirstMessage returns null for empty or whitespace-only content', () => {
  assert.equal(deriveTitleFromFirstMessage(''), null);
  assert.equal(deriveTitleFromFirstMessage('   '), null);
  assert.equal(deriveTitleFromFirstMessage('\n\t \r\n'), null);
  assert.equal(deriveTitleFromFirstMessage(undefined), null);
  assert.equal(deriveTitleFromFirstMessage(null), null);
});

test('deriveTitleFromFirstMessage keeps short Chinese / English content intact', () => {
  assert.equal(deriveTitleFromFirstMessage('帮我查一下明天的天气'), '帮我查一下明天的天气');
  assert.equal(deriveTitleFromFirstMessage('Hello world'), 'Hello world');
});

test('deriveTitleFromFirstMessage strips newlines and folds whitespace', () => {
  assert.equal(
    deriveTitleFromFirstMessage('第一行\n第二行\n\n  第三行'),
    '第一行 第二行 第三行'
  );
});

test('deriveTitleFromFirstMessage truncates超长 Chinese content at code-point limit with ellipsis', () => {
  const long = '这是一段非常非常长的中文消息内容它一定会超过四十个字符的标题长度上限所以应该被截断处理掉';
  const title = deriveTitleFromFirstMessage(long);
  const chars = Array.from(title);
  assert.equal(chars.length, AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS + 1);
  assert.equal(chars[chars.length - 1], '…');
  assert.equal(chars.slice(0, AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS).join(''), Array.from(long).slice(0, AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS).join(''));
});

test('deriveTitleFromFirstMessage truncates超长 English content with ellipsis', () => {
  const long = 'word '.repeat(20).trim();
  const title = deriveTitleFromFirstMessage(long);
  assert.ok(title.endsWith('…'));
  assert.equal(Array.from(title).length, AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS + 1);
});

test('deriveTitleFromFirstMessage boundary: exactly at limit keeps no ellipsis', () => {
  const exact = '字'.repeat(AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS);
  assert.equal(deriveTitleFromFirstMessage(exact), exact);

  const over = '字'.repeat(AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS + 1);
  assert.equal(
    deriveTitleFromFirstMessage(over),
    '字'.repeat(AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS) + '…'
  );
});

test('deriveTitleFromFirstMessage does not split emoji surrogate pairs when truncating', () => {
  // 构造：39 个 ASCII + 若干 emoji，截断点落在 emoji 中间
  const content = 'a'.repeat(AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS - 1) + '🚀🎉🔥';
  const title = deriveTitleFromFirstMessage(content);
  const chars = Array.from(title);
  // 截断应保留完整 emoji（第 40 个码点是 🚀），末尾加省略号
  assert.equal(chars[AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS - 1], '🚀');
  assert.ok(title.endsWith('…'));
  assert.equal(chars.length, AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS + 1);

  // 短内容含 emoji 原样保留
  assert.equal(deriveTitleFromFirstMessage('帮我看看 🚀 这个'), '帮我看看 🚀 这个');
});

// ---------- store 集成：首条用户消息自动写标题 ----------

test('first user message sets title and flips titleSource to auto_first_message', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  store.createMessage({
    conversationId: conversation.id,
    role: 'user',
    content: '你好\n  帮我总结一下   这份文档',
  });

  const updated = store.getConversationWithoutMessages(conversation.id);
  assert.equal(updated.title, '你好 帮我总结一下 这份文档');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_first_message');
});

test('first user message with empty or whitespace content does not trigger auto title', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store, 'Keep Me');

  store.createMessage({
    conversationId: conversation.id,
    role: 'user',
    content: '   \n\t  ',
  });

  const updated = store.getConversationWithoutMessages(conversation.id);
  assert.equal(updated.title, 'Keep Me');
  assert.equal(store.getConversationTitleSource(conversation.id), 'default');
});

test('second user message does not re-trigger auto title', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  store.createMessage({ conversationId: conversation.id, role: 'user', content: '第一条消息标题' });
  store.createMessage({ conversationId: conversation.id, role: 'user', content: '第二条不应该覆盖' });

  const updated = store.getConversationWithoutMessages(conversation.id);
  assert.equal(updated.title, '第一条消息标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_first_message');
});

test('assistant or system messages never trigger auto title', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store, 'Untouched');

  store.createMessage({ conversationId: conversation.id, role: 'assistant', content: '我是助手' });
  store.createMessage({ conversationId: conversation.id, role: 'system', content: '系统消息' });

  const updated = store.getConversationWithoutMessages(conversation.id);
  assert.equal(updated.title, 'Untouched');
  assert.equal(store.getConversationTitleSource(conversation.id), 'default');
});

test('manual title is not overwritten by first user message', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  // 用户手动改名 -> titleSource 进入 manual 终态
  store.updateConversation(conversation.id, { title: '我手动改的名字' });
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');

  store.createMessage({ conversationId: conversation.id, role: 'user', content: '这条消息不应该改标题' });

  const updated = store.getConversationWithoutMessages(conversation.id);
  assert.equal(updated.title, '我手动改的名字');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('auto_llm title is not overwritten by first user message (rank 降级拒绝)', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  store.updateConversation(conversation.id, { title: 'LLM 摘要标题', titleSource: 'auto_llm' });

  store.createMessage({ conversationId: conversation.id, role: 'user', content: '首条消息不能降级覆盖' });

  const updated = store.getConversationWithoutMessages(conversation.id);
  assert.equal(updated.title, 'LLM 摘要标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_llm');
});

test('long first user message stores truncated title with ellipsis', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  const long = '中'.repeat(60);

  store.createMessage({ conversationId: conversation.id, role: 'user', content: long });

  const updated = store.getConversationWithoutMessages(conversation.id);
  assert.equal(updated.title, '中'.repeat(AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS) + '…');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_first_message');
});

test('store truncation boundary preserves exactly 40 code points and clips the 41st', (t) => {
  const store = createStore(t, 'caff-first-msg-boundary-');
  const cases = [
    {
      content: '界'.repeat(AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS),
      expected: '界'.repeat(AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS),
    },
    {
      content: '界'.repeat(AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS + 1),
      expected: '界'.repeat(AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS) + '…',
    },
    {
      content: 'a'.repeat(AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS - 1) + '🚀x',
      expected: 'a'.repeat(AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS - 1) + '🚀…',
    },
  ];

  for (const { content, expected } of cases) {
    const conversation = createConversation(store);
    store.createMessage({ conversationId: conversation.id, role: 'user', content });

    const updated = store.getConversationWithoutMessages(conversation.id);
    assert.equal(updated.title, expected);
    assert.equal(store.getConversationTitleSource(conversation.id), 'auto_first_message');
  }
});

test('manual rename after auto title still upgrades rank (auto_first_message -> manual)', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  store.createMessage({ conversationId: conversation.id, role: 'user', content: '自动标题来源' });
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_first_message');

  store.updateConversation(conversation.id, { title: '最终还是手动改' });
  const updated = store.getConversationWithoutMessages(conversation.id);
  assert.equal(updated.title, '最终还是手动改');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});
