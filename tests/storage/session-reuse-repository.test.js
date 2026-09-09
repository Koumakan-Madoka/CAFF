const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

function createStore() {
  const tempDir = withTempDir('caff-session-reuse-repo-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  const conversation = store.createConversation({
    id: 'conv-reuse',
    title: 'Reuse Room',
    type: 'standard',
    projectScopeId: 'project-1',
    participants: ['role-family-kimi', 'role-family-glm'],
  });
  store.createMessage({
    id: 'm-1',
    conversationId: conversation.id,
    turnId: 'turn-1',
    role: 'user',
    senderName: 'User',
    content: 'first message',
    createdAt: '2026-09-02T09:59:00.000Z',
  });
  store.createMessage({
    id: 'm-2',
    conversationId: conversation.id,
    turnId: 'turn-1',
    role: 'user',
    senderName: 'User',
    content: 'second message',
    createdAt: '2026-09-02T10:00:00.000Z',
  });
  return { store, conversation };
}

function reusablePayload(overrides = {}) {
  return {
    conversationId: 'conv-reuse',
    agentId: 'agent-1',
    profileId: 'default',
    sessionName: 'chat-conv-reuse-turn-1-agent-1',
    sessionPath: '/tmp/named-sessions/chat-conv-reuse-turn-1-agent-1.jsonl',
    staticSegmentHash: 'hash-a',
    cursorMessageId: 'm-2',
    cursorMessageCount: 2,
    cursorFirstMessageId: 'm-1',
    cursorMaxUpdatedAt: '2026-09-02T10:00:00.000Z',
    lastRunId: 7,
    lastAssistantMessageId: 'm-2',
    usageInputTokens: 40000,
    usageContextWindow: 128000,
    usageRatio: 0.3125,
    goalId: 'goal-a',
    goalRevision: 3,
    privateCursorMessageId: 'private-2',
    privateCursorMessageCreatedAt: '2026-09-02T10:00:30.000Z',
    privateCursorInitialized: true,
    lastReplyAt: '2026-09-02T10:00:00.000Z',
    now: '2026-09-02T10:00:01.000Z',
    ...overrides,
  };
}

function claimPayload(overrides = {}) {
  return {
    conversationId: 'conv-reuse',
    agentId: 'agent-1',
    profileId: 'default',
    expectedHash: 'hash-a',
    expectedGoalId: 'goal-a',
    expectedGoalRevision: 3,
    expectedPrivateCursorMessageId: 'private-2',
    expectedPrivateCursorMessageCreatedAt: '2026-09-02T10:00:30.000Z',
    expectedPrivateCursorInitialized: true,
    expectedCursorMessageId: 'm-2',
    expectedCursorMessageCount: 2,
    expectedCursorFirstMessageId: 'm-1',
    expectedCursorMaxUpdatedAt: '2026-09-02T10:00:00.000Z',
    now: '2026-09-02T10:05:00.000Z',
    ...overrides,
  };
}

test('session reuse repository: get returns null for unknown keys', () => {
  const { store } = createStore();
  try {
    assert.equal(store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default'), null);
  } finally {
    store.close();
  }
});

test('session reuse repository: markReusable inserts a reusable row and reads back normalized', () => {
  const { store } = createStore();
  try {
    const saved = store.markAgentSessionReuseReusable(reusablePayload());
    assert.equal(saved.state, 'reusable');
    assert.equal(saved.sessionName, 'chat-conv-reuse-turn-1-agent-1');
    assert.equal(saved.staticSegmentHash, 'hash-a');
    assert.equal(saved.cursorMessageCount, 2);
    assert.equal(saved.usageRatio, 0.3125);

    const loaded = store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default');
    assert.equal(loaded.state, 'reusable');
    assert.equal(loaded.cursorMessageId, 'm-2');
    assert.equal(loaded.cursorFirstMessageId, 'm-1');
    assert.equal(loaded.cursorMaxUpdatedAt, '2026-09-02T10:00:00.000Z');
    assert.equal(loaded.lastRunId, 7);
    assert.equal(loaded.goalId, 'goal-a');
    assert.equal(loaded.goalRevision, 3);
    assert.equal(loaded.privateCursorMessageId, 'private-2');
    assert.equal(loaded.privateCursorMessageCreatedAt, '2026-09-02T10:00:30.000Z');
    assert.equal(loaded.privateCursorInitialized, true);
    assert.equal(loaded.poisonReason, null);
  } finally {
    store.close();
  }
});

test('session reuse repository: private mailbox cursor query returns only authorized messages after the boundary', () => {
  const { store } = createStore();
  try {
    store.createPrivateMessage({ id: 'private-1', conversationId: 'conv-reuse', turnId: 'turn-1', senderAgentId: 'role-family-glm', senderName: 'GLM', recipientAgentIds: ['role-family-kimi'], content: 'old', createdAt: '2026-09-02T10:00:30.000Z' });
    store.createPrivateMessage({ id: 'private-2', conversationId: 'conv-reuse', turnId: 'turn-2', senderAgentId: 'role-family-glm', senderName: 'GLM', recipientAgentIds: ['role-family-kimi'], content: 'new', createdAt: '2026-09-02T10:01:30.000Z' });
    store.createPrivateMessage({ id: 'private-3', conversationId: 'conv-reuse', turnId: 'turn-3', senderAgentId: 'role-family-glm', senderName: 'GLM', recipientAgentIds: ['role-family-glm'], content: 'hidden', createdAt: '2026-09-02T10:02:30.000Z' });
    const delta = store.listPrivateMessagesForAgentAfter('conv-reuse', 'role-family-kimi', { messageId: 'private-1', createdAt: '2026-09-02T10:00:30.000Z' });
    assert.deepEqual(delta.map((message) => message.id), ['private-2']);
  } finally {
    store.close();
  }
});

test('session reuse repository: non-Goal rows keep nullable Goal evidence and can be claimed', () => {
  const { store } = createStore();
  try {
    const saved = store.markAgentSessionReuseReusable(reusablePayload({ goalId: null, goalRevision: null, privateCursorMessageId: null, privateCursorMessageCreatedAt: null }));
    assert.equal(saved.goalId, null);
    assert.equal(saved.goalRevision, null);

    const claimed = store.claimAgentSessionReuse(claimPayload({ expectedGoalId: null, expectedGoalRevision: null, expectedPrivateCursorMessageId: null, expectedPrivateCursorMessageCreatedAt: null }));
    assert.ok(claimed);
    assert.equal(claimed.state, 'busy');
  } finally {
    store.close();
  }
});

test('session reuse repository: claim flips reusable to busy atomically and rejects conflicting claims', () => {
  const { store } = createStore();
  try {
    store.markAgentSessionReuseReusable(reusablePayload());
    store.createMessage({
      id: 'm-3', conversationId: 'conv-reuse', turnId: 'turn-2', role: 'user', senderName: 'User', content: 'new delta after the cursor', createdAt: '2026-09-02T10:01:00.000Z',
    });

    const claimed = store.claimAgentSessionReuse(claimPayload());
    assert.ok(claimed);
    assert.equal(claimed.state, 'busy');
    const second = store.claimAgentSessionReuse(claimPayload({ now: '2026-09-02T10:06:00.000Z' }));
    assert.equal(second, null);
    assert.equal(store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default').state, 'busy');
  } finally {
    store.close();
  }
});

test('session reuse repository: claim rejects a stale static segment hash without touching state', () => {
  const { store } = createStore();
  try {
    store.markAgentSessionReuseReusable(reusablePayload());
    assert.equal(store.claimAgentSessionReuse(claimPayload({ expectedHash: 'hash-b' })), null);
    assert.equal(store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default').state, 'reusable');
  } finally {
    store.close();
  }
});

test('session reuse repository: claim rejects stale Goal identity or revision without touching state', () => {
  const { store } = createStore();
  try {
    store.markAgentSessionReuseReusable(reusablePayload());
    assert.equal(store.claimAgentSessionReuse(claimPayload({ expectedGoalId: 'goal-b' })), null);
    assert.equal(store.claimAgentSessionReuse(claimPayload({ expectedGoalRevision: 2 })), null);
    assert.equal(store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default').state, 'reusable');
  } finally {
    store.close();
  }
});

test('session reuse repository: claim atomically rejects an edited cursor prefix', () => {
  const { store } = createStore();
  try {
    store.markAgentSessionReuseReusable(reusablePayload());
    store.db.prepare('UPDATE chat_messages SET content = ?, updated_at = ? WHERE id = ?').run('edited after reuse evaluation', '2026-09-02T10:01:00.000Z', 'm-1');
    assert.equal(store.claimAgentSessionReuse(claimPayload()), null);
    assert.equal(store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default').state, 'reusable');
  } finally {
    store.close();
  }
});

test('session reuse repository: claim atomically rejects a deleted cursor prefix', () => {
  const { store } = createStore();
  try {
    store.markAgentSessionReuseReusable(reusablePayload());
    store.db.prepare('DELETE FROM chat_messages WHERE id = ?').run('m-1');
    assert.equal(store.claimAgentSessionReuse(claimPayload()), null);
    assert.equal(store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default').state, 'reusable');
  } finally {
    store.close();
  }
});

test('session reuse repository: restoreReusable writes back the pre-claim snapshot', () => {
  const { store } = createStore();
  try {
    const reusable = store.markAgentSessionReuseReusable(reusablePayload());
    store.claimAgentSessionReuse(claimPayload());
    assert.equal(store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default').state, 'busy');
    const restored = store.restoreAgentSessionReuse(reusable, '2026-09-02T10:07:00.000Z');
    assert.equal(restored.state, 'reusable');
    assert.equal(restored.sessionName, reusable.sessionName);
    assert.equal(restored.staticSegmentHash, reusable.staticSegmentHash);
    assert.equal(restored.cursorMessageId, reusable.cursorMessageId);
    assert.equal(restored.usageRatio, reusable.usageRatio);
    assert.equal(restored.goalId, reusable.goalId);
    assert.equal(restored.goalRevision, reusable.goalRevision);
    assert.equal(restored.privateCursorMessageId, reusable.privateCursorMessageId);
  } finally {
    store.close();
  }
});

test('session reuse repository: markPoisoned records the reason and keeps audit fields', () => {
  const { store } = createStore();
  try {
    store.markAgentSessionReuseReusable(reusablePayload());
    store.claimAgentSessionReuse(claimPayload());
    store.markAgentSessionReusePoisoned('conv-reuse', 'agent-1', 'default', 'run_failed: boom', '2026-09-02T10:09:00.000Z');
    const poisoned = store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default');
    assert.equal(poisoned.state, 'poisoned');
    assert.equal(poisoned.poisonReason, 'run_failed: boom');
    assert.equal(poisoned.sessionName, 'chat-conv-reuse-turn-1-agent-1');
    assert.equal(store.claimAgentSessionReuse(claimPayload({ now: '2026-09-02T10:10:00.000Z' })), null);
  } finally {
    store.close();
  }
});

test('session reuse repository: markReusable supersedes a poisoned row (fresh session recovery)', () => {
  const { store } = createStore();
  try {
    store.markAgentSessionReuseReusable(reusablePayload());
    store.markAgentSessionReusePoisoned('conv-reuse', 'agent-1', 'default', 'cursor_history_mutated', '2026-09-02T10:09:00.000Z');
    const recovered = store.markAgentSessionReuseReusable(reusablePayload({ sessionName: 'chat-conv-reuse-turn-2-agent-1', sessionPath: '/tmp/named-sessions/chat-conv-reuse-turn-2-agent-1.jsonl', staticSegmentHash: 'hash-b', now: '2026-09-02T10:20:00.000Z' }));
    assert.equal(recovered.state, 'reusable');
    assert.equal(recovered.sessionName, 'chat-conv-reuse-turn-2-agent-1');
    assert.equal(recovered.poisonReason, null);
  } finally {
    store.close();
  }
});

test('session reuse repository: fresh completion cannot overwrite another run busy row', () => {
  const { store } = createStore();
  try {
    const original = reusablePayload({ sessionName: 'claimed-session', sessionPath: '/tmp/claimed-session.jsonl' });
    store.markAgentSessionReuseReusable(original);
    assert.equal(store.claimAgentSessionReuse(claimPayload()).state, 'busy');
    const result = store.markAgentSessionReuseReusable(reusablePayload({ sessionName: 'fresh-fallback-session', sessionPath: '/tmp/fresh-fallback-session.jsonl', now: '2026-09-02T10:11:00.000Z' }));
    assert.equal(result, null);
    const row = store.getAgentSessionReuse(original.conversationId, original.agentId, original.profileId);
    assert.equal(row.state, 'busy');
    assert.equal(row.sessionName, 'claimed-session');
  } finally {
    store.close();
  }
});

test('session reuse repository: reusable rows reject incomplete snapshots at the schema level', () => {
  const { store } = createStore();
  try {
    assert.throws(() => store.markAgentSessionReuseReusable(reusablePayload({ sessionPath: '' })));
    assert.throws(() => store.markAgentSessionReuseReusable(reusablePayload({ staticSegmentHash: '' })));
    assert.throws(() => store.markAgentSessionReuseReusable(reusablePayload({ goalRevision: null })));
    assert.throws(() => store.markAgentSessionReuseReusable(reusablePayload({ goalRevision: 0 })));
  } finally {
    store.close();
  }
});
