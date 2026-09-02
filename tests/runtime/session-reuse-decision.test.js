const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAgentTurnPromptSections,
  buildSessionReuseDeltaPrompt,
  formatAgentTurnPromptSections,
} = require('../../build/server/domain/conversation/turn/agent-prompt');
const {
  buildSessionReuseCursorSnapshot,
  evaluateSessionReuse,
  extractLastCallInputTokens,
  isSessionReuseBusyStale,
  partitionMessagesAtCursor,
  resolveSessionReuseConfig,
  resolveSessionReuseContextWindow,
  verifySessionReuseCursor,
} = require('../../build/server/domain/conversation/turn/session-reuse');

const NOW = '2026-09-02T12:00:00.000Z';

function message(id, overrides = {}) {
  return {
    id,
    role: 'user',
    content: `content of ${id}`,
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    ...overrides,
  };
}

function reusableRow(overrides = {}) {
  return {
    state: 'reusable',
    sessionName: 'chat-conv-1-turn-1-agent-1',
    sessionPath: '/tmp/named-sessions/chat-conv-1-turn-1-agent-1.jsonl',
    staticSegmentHash: 'hash-a',
    cursorMessageId: 'm-2',
    cursorMessageCount: 2,
    cursorFirstMessageId: 'm-1',
    cursorMaxUpdatedAt: '2026-09-02T10:00:00.000Z',
    usageRatio: 0.3,
    lastReplyAt: '2026-09-02T11:30:00.000Z',
    updatedAt: '2026-09-02T11:30:00.000Z',
    ...overrides,
  };
}

function decisionInput(overrides = {}) {
  const messages = [message('m-1'), message('m-2', { role: 'assistant', agentId: 'agent-1' }), message('m-3')];
  return {
    row: reusableRow(),
    staticSegmentHash: 'hash-a',
    config: resolveSessionReuseConfig({ PI_CHAT_SESSION_REUSE_ENABLED: '1' }),
    now: NOW,
    messages,
    ...overrides,
  };
}

test('session reuse config defaults to enabled with 50% ratio and 1h idle window (Phase 2)', () => {
  const config = resolveSessionReuseConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.maxUsageRatio, 0.5);
  assert.equal(config.maxIdleMs, 3600000);
  assert.ok(config.busyStaleMs > config.maxIdleMs);

  // The env flag remains the global kill switch: an explicit off wins over the
  // Phase 2 default-on.
  const killed = resolveSessionReuseConfig({ PI_CHAT_SESSION_REUSE_ENABLED: '0' });
  assert.equal(killed.enabled, false);
  assert.equal(resolveSessionReuseConfig({ PI_CHAT_SESSION_REUSE_ENABLED: 'false' }).enabled, false);

  const enabled = resolveSessionReuseConfig({
    PI_CHAT_SESSION_REUSE_ENABLED: 'true',
    PI_CHAT_SESSION_REUSE_MAX_USAGE_RATIO: '0.25',
    PI_CHAT_SESSION_REUSE_MAX_IDLE_MS: '60000',
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.maxUsageRatio, 0.25);
  assert.equal(enabled.maxIdleMs, 60000);

  // Invalid overrides fall back to defaults instead of disabling safety bounds.
  const invalid = resolveSessionReuseConfig({
    PI_CHAT_SESSION_REUSE_ENABLED: '1',
    PI_CHAT_SESSION_REUSE_MAX_USAGE_RATIO: '7',
    PI_CHAT_SESSION_REUSE_MAX_IDLE_MS: '-5',
  });
  assert.equal(invalid.maxUsageRatio, 0.5);
  assert.equal(invalid.maxIdleMs, 3600000);
});

test('context window resolves from catalog options and stays null when unknown', () => {
  const catalog = {
    getOptions: () => [
      { provider: 'moonshot', model: 'kimi-k2', contextWindow: 262144 },
      { provider: 'openai', model: 'gpt-5', contextWindow: 400000 },
    ],
  };
  assert.equal(resolveSessionReuseContextWindow(catalog, 'moonshot', 'kimi-k2'), 262144);
  assert.equal(resolveSessionReuseContextWindow(catalog, 'moonshot', 'missing'), null);
  assert.equal(resolveSessionReuseContextWindow(catalog, '', 'kimi-k2'), null);
  assert.equal(resolveSessionReuseContextWindow(null, 'moonshot', 'kimi-k2'), null);
  assert.equal(
    resolveSessionReuseContextWindow([{ provider: 'p', model: 'm', contextWindow: 'unknown' }], 'p', 'm'),
    null
  );
});

test('extractLastCallInputTokens uses the last call with usage, not an aggregate', () => {
  assert.equal(
    extractLastCallInputTokens([
      { usage: { input_tokens: 100 } },
      { usage: { input_tokens: 4500, cache_read_tokens: 500 } },
      { usage: null },
    ]),
    5000
  );
  assert.equal(extractLastCallInputTokens([]), null);
  assert.equal(extractLastCallInputTokens([{ usage: null }]), null);
  assert.equal(extractLastCallInputTokens(null), null);
});

test('cursor snapshot covers count, first id, and max(updated_at)', () => {
  const snapshot = buildSessionReuseCursorSnapshot([
    message('m-1', { updatedAt: '2026-09-02T10:00:00.000Z' }),
    message('m-2', { updatedAt: '2026-09-02T10:05:00.000Z' }),
    message('m-3', { updatedAt: '2026-09-02T10:02:00.000Z' }),
  ]);
  assert.deepEqual(snapshot, {
    cursorMessageId: 'm-3',
    cursorMessageCount: 3,
    cursorFirstMessageId: 'm-1',
    cursorMaxUpdatedAt: '2026-09-02T10:05:00.000Z',
  });
  assert.equal(buildSessionReuseCursorSnapshot([]), null);
});

test('cursor verification detects edits, deletions, and a missing cursor message', () => {
  const row = reusableRow();

  // Edit of an already-injected message moves max(updated_at) past the snapshot.
  const edited = verifySessionReuseCursor(row, [
    message('m-1'),
    message('m-2', { updatedAt: '2026-09-02T11:00:00.000Z' }),
    message('m-3'),
  ]);
  assert.equal(edited.ok, false);
  assert.equal(edited.reason, 'cursor_history_mutated');

  // Deletion of an already-injected message shrinks the prefix count.
  const deleted = verifySessionReuseCursor(row, [message('m-2'), message('m-3')]);
  assert.equal(deleted.ok, false);
  assert.equal(deleted.reason, 'cursor_count_mismatch');

  // A different first message means the prefix content shifted.
  const shifted = verifySessionReuseCursor({ ...row, cursorMessageCount: 2 }, [
    message('m-0'),
    message('m-2'),
    message('m-3'),
  ]);
  assert.equal(shifted.ok, false);
  assert.equal(shifted.reason, 'cursor_first_message_mismatch');

  // Cursor id not found at all (e.g., the cursor message itself was deleted).
  const missing = verifySessionReuseCursor(row, [message('m-1'), message('m-3')]);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'cursor_message_missing');

  const clean = verifySessionReuseCursor(row, [message('m-1'), message('m-2'), message('m-3'), message('m-4')]);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.delta.map((item) => item.id), ['m-3', 'm-4']);
});

test('partitionMessagesAtCursor splits history into injected prefix and delta', () => {
  const partition = partitionMessagesAtCursor([message('m-1'), message('m-2'), message('m-3')], 'm-2');
  assert.deepEqual(partition.upToCursor.map((item) => item.id), ['m-1', 'm-2']);
  assert.deepEqual(partition.delta.map((item) => item.id), ['m-3']);
  assert.equal(partitionMessagesAtCursor([message('m-1')], 'missing'), null);
  assert.equal(partitionMessagesAtCursor([message('m-1')], ''), null);
});

test('evaluateSessionReuse happy path returns the delta for tail injection', () => {
  const decision = evaluateSessionReuse(decisionInput());
  assert.equal(decision.reuse, true);
  assert.equal(decision.reason, 'reused');
  assert.deepEqual(decision.delta.map((item) => item.id), ['m-3']);
});

test('evaluateSessionReuse refuses with explicit reasons for every failure class', () => {
  assert.equal(evaluateSessionReuse(decisionInput({ row: null })).reason, 'no_prior_session');
  assert.equal(
    evaluateSessionReuse(decisionInput({ row: reusableRow({ state: 'poisoned' }) })).reason,
    'poisoned'
  );
  assert.equal(evaluateSessionReuse(decisionInput({ row: reusableRow({ state: 'busy' }) })).reason, 'busy');
  assert.equal(
    evaluateSessionReuse(decisionInput({ row: reusableRow({ sessionPath: null }) })).reason,
    'session_reference_missing'
  );
  assert.equal(
    evaluateSessionReuse(decisionInput({ staticSegmentHash: 'hash-b' })).reason,
    'static_hash_mismatch'
  );
  assert.equal(
    evaluateSessionReuse(decisionInput({ row: reusableRow({ usageRatio: null }) })).reason,
    'usage_snapshot_missing'
  );
  assert.equal(
    evaluateSessionReuse(decisionInput({ row: reusableRow({ usageRatio: 0.5 }) })).reason,
    'usage_ratio_above_threshold'
  );
  // 30 minutes idle is fine, 61 minutes is not.
  assert.equal(
    evaluateSessionReuse(decisionInput({ row: reusableRow({ lastReplyAt: '2026-09-02T11:30:00.000Z' }) })).reuse,
    true
  );
  assert.equal(
    evaluateSessionReuse(decisionInput({ row: reusableRow({ lastReplyAt: '2026-09-02T10:58:00.000Z' }) })).reason,
    'idle_timeout'
  );
  // No new room messages since the cursor: nothing to inject, so run fresh.
  const noDelta = evaluateSessionReuse(decisionInput({ messages: [message('m-1'), message('m-2')] }));
  assert.equal(noDelta.reuse, false);
  assert.equal(noDelta.reason, 'no_delta_messages');
});

test('evaluateSessionReuse flags cursor inconsistencies for poisoning', () => {
  const decision = evaluateSessionReuse(
    decisionInput({
      messages: [message('m-1'), message('m-2', { updatedAt: '2026-09-02T11:00:00.000Z' }), message('m-3')],
    })
  );
  assert.equal(decision.reuse, false);
  assert.equal(decision.reason, 'cursor_history_mutated');
  assert.equal(decision.poison, true);
});

test('isSessionReuseBusyStale only fires for busy rows past the stale window', () => {
  const config = resolveSessionReuseConfig({ PI_CHAT_SESSION_REUSE_BUSY_STALE_MS: '60000' });
  assert.equal(
    isSessionReuseBusyStale({ state: 'busy', updatedAt: '2026-09-02T11:00:00.000Z' }, config, NOW),
    true
  );
  assert.equal(
    isSessionReuseBusyStale({ state: 'busy', updatedAt: '2026-09-02T11:59:30.000Z' }, config, NOW),
    false
  );
  assert.equal(
    isSessionReuseBusyStale({ state: 'reusable', updatedAt: '2026-09-02T10:00:00.000Z' }, config, NOW),
    false
  );
});

test('delta prompt renders messages through the same formatHistory path as full history', () => {
  const agents = [
    { id: 'agent-1', name: 'Kimi' },
    { id: 'agent-2', name: 'GPT' },
  ];
  const delta = [
    { id: 'm-3', role: 'user', content: 'follow-up question' },
    { id: 'm-4', role: 'assistant', agentId: 'agent-2', senderName: 'GPT', content: 'other agent reply' },
  ];

  const deltaPrompt = buildSessionReuseDeltaPrompt(delta, agents);
  assert.ok(deltaPrompt.startsWith('New messages since your last reply:\n'));
  assert.ok(deltaPrompt.includes('User: follow-up question'));
  assert.ok(deltaPrompt.includes('GPT: other agent reply'));

  // The same messages rendered inside a full prompt's conversation_history
  // section must produce identical message lines (no format drift between modes).
  const fullPrompt = formatAgentTurnPromptSections(
    buildAgentTurnPromptSections({
      conversation: { id: 'conv-1', title: 'Reuse Test', type: 'standard' },
      agent: { id: 'agent-1', name: 'Kimi' },
      agentConfig: {},
      resolvedPersonaSkills: [],
      resolvedConversationSkills: [],
      sandbox: { sandboxDir: '/tmp/sandbox', privateDir: '/tmp/private' },
      projectDir: '',
      agents,
      messages: delta,
      privateMessages: [],
      relatedMemorySegments: [],
      trigger: null,
      remainingSlots: 3,
      routingMode: 'mention',
      agentToolRelativePath: './build/lib/agent-chat-tools.js',
    })
  );
  for (const line of deltaPrompt.split('\n').slice(1)) {
    assert.ok(fullPrompt.includes(line), `full prompt missing delta line: ${line}`);
  }
});
