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
    participants: ['role-family-kimi'],
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
    lastReplyAt: '2026-09-02T10:00:00.000Z',
    now: '2026-09-02T10:00:01.000Z',
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
    assert.equal(loaded.poisonReason, null);
  } finally {
    store.close();
  }
});

test('session reuse repository: claim flips reusable to busy atomically and rejects conflicting claims', () => {
  const { store } = createStore();
  try {
    store.markAgentSessionReuseReusable(reusablePayload());

    const claimed = store.claimAgentSessionReuse({
      conversationId: 'conv-reuse',
      agentId: 'agent-1',
      profileId: 'default',
      expectedHash: 'hash-a',
      now: '2026-09-02T10:05:00.000Z',
    });
    assert.ok(claimed);
    assert.equal(claimed.state, 'busy');

    // Second claim must fail: the row is busy now.
    const second = store.claimAgentSessionReuse({
      conversationId: 'conv-reuse',
      agentId: 'agent-1',
      profileId: 'default',
      expectedHash: 'hash-a',
      now: '2026-09-02T10:06:00.000Z',
    });
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

    const claimed = store.claimAgentSessionReuse({
      conversationId: 'conv-reuse',
      agentId: 'agent-1',
      profileId: 'default',
      expectedHash: 'hash-b',
      now: '2026-09-02T10:05:00.000Z',
    });
    assert.equal(claimed, null);
    assert.equal(store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default').state, 'reusable');
  } finally {
    store.close();
  }
});

test('session reuse repository: restoreReusable writes back the pre-claim snapshot', () => {
  const { store } = createStore();
  try {
    const reusable = store.markAgentSessionReuseReusable(reusablePayload());
    store.claimAgentSessionReuse({
      conversationId: 'conv-reuse',
      agentId: 'agent-1',
      profileId: 'default',
      expectedHash: 'hash-a',
      now: '2026-09-02T10:05:00.000Z',
    });
    assert.equal(store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default').state, 'busy');

    const restored = store.restoreAgentSessionReuse(reusable, '2026-09-02T10:07:00.000Z');
    assert.equal(restored.state, 'reusable');
    assert.equal(restored.sessionName, reusable.sessionName);
    assert.equal(restored.staticSegmentHash, reusable.staticSegmentHash);
    assert.equal(restored.cursorMessageId, reusable.cursorMessageId);
    assert.equal(restored.usageRatio, reusable.usageRatio);
  } finally {
    store.close();
  }
});

test('session reuse repository: markPoisoned records the reason and keeps audit fields', () => {
  const { store } = createStore();
  try {
    store.markAgentSessionReuseReusable(reusablePayload());
    store.claimAgentSessionReuse({
      conversationId: 'conv-reuse',
      agentId: 'agent-1',
      profileId: 'default',
      expectedHash: 'hash-a',
      now: '2026-09-02T10:05:00.000Z',
    });

    store.markAgentSessionReusePoisoned('conv-reuse', 'agent-1', 'default', 'run_failed: boom', '2026-09-02T10:09:00.000Z');
    const poisoned = store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default');
    assert.equal(poisoned.state, 'poisoned');
    assert.equal(poisoned.poisonReason, 'run_failed: boom');
    assert.equal(poisoned.sessionName, 'chat-conv-reuse-turn-1-agent-1');

    // A poisoned row can never be claimed again.
    const claimed = store.claimAgentSessionReuse({
      conversationId: 'conv-reuse',
      agentId: 'agent-1',
      profileId: 'default',
      expectedHash: 'hash-a',
      now: '2026-09-02T10:10:00.000Z',
    });
    assert.equal(claimed, null);
  } finally {
    store.close();
  }
});

test('session reuse repository: markReusable supersedes a poisoned row (fresh session recovery)', () => {
  const { store } = createStore();
  try {
    store.markAgentSessionReuseReusable(reusablePayload());
    store.markAgentSessionReusePoisoned('conv-reuse', 'agent-1', 'default', 'cursor_history_mutated', '2026-09-02T10:09:00.000Z');
    assert.equal(store.getAgentSessionReuse('conv-reuse', 'agent-1', 'default').state, 'poisoned');

    const recovered = store.markAgentSessionReuseReusable(
      reusablePayload({
        sessionName: 'chat-conv-reuse-turn-2-agent-1',
        sessionPath: '/tmp/named-sessions/chat-conv-reuse-turn-2-agent-1.jsonl',
        staticSegmentHash: 'hash-b',
        now: '2026-09-02T10:20:00.000Z',
      })
    );
    assert.equal(recovered.state, 'reusable');
    assert.equal(recovered.sessionName, 'chat-conv-reuse-turn-2-agent-1');
    assert.equal(recovered.poisonReason, null);
  } finally {
    store.close();
  }
});

test('session reuse repository: reusable rows reject incomplete snapshots at the schema level', () => {
  const { store } = createStore();
  try {
    assert.throws(() =>
      store.markAgentSessionReuseReusable(reusablePayload({ sessionPath: '' }))
    );
    assert.throws(() =>
      store.markAgentSessionReuseReusable(reusablePayload({ staticSegmentHash: '' }))
    );
  } finally {
    store.close();
  }
});
