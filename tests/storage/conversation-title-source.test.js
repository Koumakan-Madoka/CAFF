const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  CONVERSATION_TITLE_SOURCES,
  normalizeConversationTitleSource,
  readConversationTitleSource,
  canApplyConversationTitleSource,
  resolveConversationTitleTransition,
} = require('../../build/lib/conversation-title-source');
const { withTempDir } = require('../helpers/temp-dir');

const RANK = {
  default: 0,
  auto_first_message: 1,
  auto_llm: 2,
  manual: 3,
};

function createStore(t, prefix = 'caff-title-source-') {
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

test('normalizeConversationTitleSource falls back to default for missing or invalid values', () => {
  assert.equal(normalizeConversationTitleSource(undefined), 'default');
  assert.equal(normalizeConversationTitleSource(null), 'default');
  assert.equal(normalizeConversationTitleSource(''), 'default');
  assert.equal(normalizeConversationTitleSource('bogus'), 'default');
  assert.equal(normalizeConversationTitleSource(42), 'default');
  for (const source of CONVERSATION_TITLE_SOURCES) {
    assert.equal(normalizeConversationTitleSource(source), source);
  }
});

test('readConversationTitleSource normalizes metadata payloads', () => {
  assert.equal(readConversationTitleSource(undefined), 'default');
  assert.equal(readConversationTitleSource({}), 'default');
  assert.equal(readConversationTitleSource({ titleSource: 'manual' }), 'manual');
  assert.equal(readConversationTitleSource({ titleSource: 'junk' }), 'default');
});

test('canApplyConversationTitleSource covers the full 4x4 transition matrix', () => {
  for (const current of CONVERSATION_TITLE_SOURCES) {
    for (const incoming of CONVERSATION_TITLE_SOURCES) {
      const expected = RANK[incoming] >= RANK[current];
      assert.equal(
        canApplyConversationTitleSource(current, incoming),
        expected,
        `${current} -> ${incoming} should be ${expected ? 'allowed' : 'rejected'}`
      );
    }
  }
  // manual 终态：所有自动来源一律不得覆盖
  for (const autoSource of ['default', 'auto_first_message', 'auto_llm']) {
    assert.equal(canApplyConversationTitleSource('manual', autoSource), false);
  }
  // default / auto_first_message 可被升级
  assert.equal(canApplyConversationTitleSource('default', 'auto_first_message'), true);
  assert.equal(canApplyConversationTitleSource('default', 'auto_llm'), true);
  assert.equal(canApplyConversationTitleSource('default', 'manual'), true);
  assert.equal(canApplyConversationTitleSource('auto_first_message', 'auto_llm'), true);
  assert.equal(canApplyConversationTitleSource('auto_first_message', 'manual'), true);
});

test('resolveConversationTitleTransition keeps current source when rejected', () => {
  assert.deepEqual(resolveConversationTitleTransition('manual', 'auto_llm'), {
    applied: false,
    titleSource: 'manual',
  });
  assert.deepEqual(resolveConversationTitleTransition('auto_llm', 'auto_first_message'), {
    applied: false,
    titleSource: 'auto_llm',
  });
  assert.deepEqual(resolveConversationTitleTransition('auto_first_message', 'auto_llm'), {
    applied: true,
    titleSource: 'auto_llm',
  });
});

test('store: new conversation reads back default titleSource', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  assert.equal(store.getConversationTitleSource(conversation.id), 'default');
  assert.equal(readConversationTitleSource(conversation.metadata), 'default');
});

test('store: getConversationTitleSource returns null for unknown conversation', (t) => {
  const store = createStore(t);
  assert.equal(store.getConversationTitleSource('missing-id'), null);
});

test('store: title write upgrades default -> auto_first_message -> auto_llm -> manual', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  let updated = store.updateConversation(conversation.id, {
    title: '你好，世界',
    titleSource: 'auto_first_message',
  });
  assert.equal(updated.title, '你好，世界');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_first_message');

  updated = store.updateConversation(conversation.id, {
    title: '关于世界问候的讨论',
    titleSource: 'auto_llm',
  });
  assert.equal(updated.title, '关于世界问候的讨论');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_llm');

  updated = store.updateConversation(conversation.id, {
    title: '我的会话',
    titleSource: 'manual',
  });
  assert.equal(updated.title, '我的会话');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('store: persists the full 4x4 titleSource transition matrix', (t) => {
  const store = createStore(t, 'caff-title-source-matrix-');

  for (const current of CONVERSATION_TITLE_SOURCES) {
    for (const incoming of CONVERSATION_TITLE_SOURCES) {
      const conversation = createConversation(store);
      if (current !== 'default') {
        store.updateConversation(conversation.id, {
          title: `current:${current}`,
          titleSource: current,
        });
      }

      const existing = store.getConversationWithoutMessages(conversation.id);
      const attemptedTitle = `incoming:${incoming}`;
      const updated = store.updateConversation(conversation.id, {
        title: attemptedTitle,
        titleSource: incoming,
      });
      const expectedApplied = RANK[incoming] >= RANK[current];

      assert.equal(
        updated.title,
        expectedApplied ? attemptedTitle : existing.title,
        `${current} -> ${incoming} persisted title`
      );
      assert.equal(
        store.getConversationTitleSource(conversation.id),
        expectedApplied ? incoming : current,
        `${current} -> ${incoming} persisted source`
      );
    }
  }
});

test('store: manual is terminal — automatic title writes are rejected and preserve title', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, { title: '手动命名', titleSource: 'manual' });

  for (const autoSource of ['default', 'auto_first_message', 'auto_llm']) {
    const updated = store.updateConversation(conversation.id, {
      title: '自动标题不应生效',
      titleSource: autoSource,
    });
    assert.equal(updated.title, '手动命名', `${autoSource} must not overwrite manual title`);
    assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
  }
});

test('store: default and auto_first_message titles can be upgraded by later writes', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  let updated = store.updateConversation(conversation.id, {
    title: '首条消息标题',
    titleSource: 'auto_first_message',
  });
  assert.equal(updated.title, '首条消息标题');

  updated = store.updateConversation(conversation.id, {
    title: 'LLM 标题',
    titleSource: 'auto_llm',
  });
  assert.equal(updated.title, 'LLM 标题');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_llm');
});

test('store: lower-priority writes are rejected on auto_llm title', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, { title: 'LLM 标题', titleSource: 'auto_llm' });

  for (const lowerSource of ['default', 'auto_first_message']) {
    const updated = store.updateConversation(conversation.id, {
      title: '低优先级标题',
      titleSource: lowerSource,
    });
    assert.equal(updated.title, 'LLM 标题');
    assert.equal(store.getConversationTitleSource(conversation.id), 'auto_llm');
  }
});

test('store: title write without explicit titleSource is treated as manual', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, { title: 'LLM 标题', titleSource: 'auto_llm' });

  const updated = store.updateConversation(conversation.id, { title: 'UI 改名' });
  assert.equal(updated.title, 'UI 改名');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('store: same-source rewrite is idempotent (manual rename twice)', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  store.updateConversation(conversation.id, { title: '名字一', titleSource: 'manual' });
  const updated = store.updateConversation(conversation.id, { title: '名字二', titleSource: 'manual' });
  assert.equal(updated.title, '名字二');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');
});

test('store: updates without title leave titleSource untouched and sync it into metadata', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, { title: '首条消息标题', titleSource: 'auto_first_message' });

  const updated = store.updateConversation(conversation.id, { metadata: { pinned: true } });
  assert.equal(updated.title, '首条消息标题');
  assert.equal(updated.metadata.pinned, true);
  assert.equal(updated.metadata.titleSource, 'auto_first_message');
});

test('store: metadata-embedded titleSource cannot bypass the state machine', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);
  store.updateConversation(conversation.id, { title: '手动命名', titleSource: 'manual' });

  const updated = store.updateConversation(conversation.id, {
    metadata: { titleSource: 'default', pinned: true },
  });
  assert.equal(updated.metadata.pinned, true);
  assert.equal(updated.metadata.titleSource, 'manual');
});

test('store: updateConversationTitleSource upgrades and rejects downgrades', (t) => {
  const store = createStore(t);
  const conversation = createConversation(store);

  let updated = store.updateConversationTitleSource(conversation.id, 'auto_first_message');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_first_message');
  assert.equal(updated.title, 'New Conversation');

  updated = store.updateConversationTitleSource(conversation.id, 'default');
  assert.equal(store.getConversationTitleSource(conversation.id), 'auto_first_message', 'downgrade rejected');

  updated = store.updateConversationTitleSource(conversation.id, 'manual');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual');

  updated = store.updateConversationTitleSource(conversation.id, 'auto_llm');
  assert.equal(store.getConversationTitleSource(conversation.id), 'manual', 'manual is terminal');

  assert.equal(store.updateConversationTitleSource('missing-id', 'manual'), null);
});
