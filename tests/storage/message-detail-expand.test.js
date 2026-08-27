const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { retainModelUsageCalls } = require('../../build/lib/message-detail-contract');
const { withTempDir } = require('../helpers/temp-dir');

function createConversation(store, id = 'detail-conversation') {
  return store.createConversation({
    id,
    title: 'Message Detail Expand',
    type: 'standard',
    projectScopeId: 'project-1',
    participants: ['role-family-gpt'],
  });
}

function createSnapshot(messageId, marker = messageId) {
  const displayContent = `safe snapshot content ${marker}`;
  return {
    schemaVersion: 1,
    snapshotId: `snapshot-${marker}`,
    capturedAt: '2026-08-25T00:00:00.000Z',
    conversationId: 'detail-conversation',
    turnId: `turn-${messageId}`,
    messageId,
    agentId: 'role-family-gpt',
    agentName: 'GPT',
    promptVersion: 'test',
    immutable: true,
    totalApproxTokens: 12,
    totalByteSize: Buffer.byteLength(displayContent, 'utf8'),
    sections: [{
      sectionKey: 'conversation_history',
      title: 'Conversation History',
      displayTitle: 'Conversation History',
      source: 'conversation/messages',
      visibility: 'full',
      contentHash: `content-${marker}`,
      displayContentHash: `display-${marker}`,
      approxTokens: 12,
      byteSize: Buffer.byteLength(displayContent, 'utf8'),
      truncated: false,
      truncationNote: '',
      redacted: false,
      policyNote: '',
      contentPreview: displayContent,
      displayContent,
    }],
  };
}

function createModelUsage(callCount) {
  const calls = Array.from({ length: callCount }, (_, index) => ({
    index,
    sequence: index + 1,
    key: `call-${index + 1}`,
    responseId: `response-${index + 1}`,
    stopReason: 'stop',
    timestamp: index + 1,
    coldStart: index === 0,
    isColdStart: index === 0,
    providerMiss: index > 0 && index % 5 === 0,
    tokenUsage: {
      inputTokens: 100 + index,
      uncachedInputTokens: 10 + index,
      outputTokens: 20 + index,
      totalTokens: 120 + (index * 2),
      cacheReadTokens: index === 0 ? 0 : 90,
      cacheWriteTokens: 0,
      inputCostUsd: null,
      outputCostUsd: null,
      cacheReadCostUsd: null,
      cacheWriteCostUsd: null,
      totalCostUsd: null,
    },
  }));

  return {
    modelCallCount: callCount,
    coldStartModelCallCount: callCount > 0 ? 1 : 0,
    postColdModelCallCount: Math.max(0, callCount - 1),
    providerMissCount: calls.filter((call) => call.providerMiss).length,
    calls,
  };
}

function rawInsertMessage(store, input) {
  store.db.prepare(`
    INSERT INTO chat_messages (
      id, conversation_id, turn_id, role, agent_id, sender_name,
      content, status, task_id, run_id, error_message, metadata_json,
      client_request_id, created_at
    ) VALUES (?, ?, ?, 'assistant', 'role-family-gpt', 'GPT', ?, ?, NULL, NULL, NULL, ?, NULL, ?)
  `).run(
    input.id,
    input.conversationId,
    `turn-${input.id}`,
    input.content || input.id,
    input.status || 'completed',
    JSON.stringify(input.metadata || {}),
    input.createdAt
  );
}

function queryCount(store, tableName) {
  return Number(store.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count);
}

test('P2C Expand creates idempotent message detail schema without backfilling historical rows', (t) => {
  const tempDir = withTempDir('caff-message-detail-schema-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  let store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createConversation(store);
  const legacySnapshot = createSnapshot('legacy-message', 'legacy');
  const legacyUsage = createModelUsage(3);
  rawInsertMessage(store, {
    id: 'legacy-message',
    conversationId: conversation.id,
    createdAt: '2026-08-25T00:00:01.000Z',
    metadata: { agentContextSnapshot: legacySnapshot, modelUsage: legacyUsage },
  });
  const legacyMetadataJson = store.db.prepare('SELECT metadata_json FROM chat_messages WHERE id = ?').get('legacy-message').metadata_json;

  for (const tableName of ['chat_message_context_snapshots', 'chat_message_model_usage_calls']) {
    const table = store.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName);
    assert.ok(table && /message_id TEXT PRIMARY KEY/u.test(table.sql));
    assert.match(table.sql, /REFERENCES chat_messages\s*\(id\) ON DELETE CASCADE/iu);
    assert.equal(queryCount(store, tableName), 0, 'historical rows must not be backfilled');
    const columns = store.db.prepare(`PRAGMA table_info('${tableName}')`).all().map((row) => row.name);
    for (const associationColumn of ['message_id', 'conversation_id', 'turn_id', 'agent_id', 'created_at', 'updated_at']) {
      assert.ok(columns.includes(associationColumn), `${tableName} must include ${associationColumn}`);
    }
  }

  assert.throws(() => store.db.prepare(`
    INSERT INTO chat_message_model_usage_calls (
      message_id, conversation_id, turn_id, agent_id,
      model_call_count, cold_start_model_call_count, post_cold_model_call_count,
      provider_miss_count, calls_json, calls_truncated,
      retained_call_count, dropped_call_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 65, 1, 64, 0, ?, 0, 65, 0, ?, ?)
  `).run(
    'legacy-message',
    conversation.id,
    'turn-legacy-message',
    'role-family-gpt',
    JSON.stringify(Array.from({ length: 65 }, (_, index) => ({ sequence: index + 1 }))),
    '2026-08-25T00:00:01.000Z',
    '2026-08-25T00:00:01.000Z'
  ), /CHECK constraint/iu);

  const snapshotIndexes = store.db.prepare("PRAGMA index_list('chat_message_context_snapshots')").all();
  assert.ok(snapshotIndexes.some((row) => row.name === 'idx_chat_message_context_snapshots_conversation'));
  const usageIndexes = store.db.prepare("PRAGMA index_list('chat_message_model_usage_calls')").all();
  assert.ok(usageIndexes.some((row) => row.name === 'idx_chat_message_model_usage_calls_conversation'));
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);

  store.close();
  store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  assert.equal(queryCount(store, 'chat_message_context_snapshots'), 0);
  assert.equal(queryCount(store, 'chat_message_model_usage_calls'), 0);
  assert.equal(
    store.db.prepare('SELECT metadata_json FROM chat_messages WHERE id = ?').get('legacy-message').metadata_json,
    legacyMetadataJson,
    'schema startup must not rewrite historical metadata bytes'
  );
  assert.deepEqual(store.getMessage('legacy-message').metadata, {
    agentContextSnapshot: legacySnapshot,
    modelUsage: legacyUsage,
  });
});

test('model usage retention keeps first plus latest fifteen calls without recomputing aggregates', () => {
  for (const callCount of [15, 16, 17, 64, 100]) {
    const source = createModelUsage(callCount);
    source.modelCallCount = 777;
    const retained = retainModelUsageCalls(source);
    const expectedSequences = callCount <= 16
      ? Array.from({ length: callCount }, (_, index) => index + 1)
      : [1, ...Array.from({ length: 15 }, (_, index) => callCount - 14 + index)];

    assert.equal(retained.modelCallCount, 777);
    assert.deepEqual(retained.calls.map((call) => call.sequence), expectedSequences);
    assert.equal(retained.retainedCallCount, Math.min(callCount, 16));
    assert.equal(retained.droppedCallCount, Math.max(0, callCount - 16));
    assert.equal(retained.callsTruncated, callCount > 16);
  }
});

test('unified observability detail atomically stores first one plus latest fifteen mixed events', (t) => {
  const tempDir = withTempDir('caff-message-observability-detail-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const conversation = createConversation(store, 'observability-detail-conversation');
  store.createMessage({
    id: 'observability-detail-message',
    conversationId: conversation.id,
    turnId: 'observability-detail-turn',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Thinking...',
    status: 'streaming',
  });
  const events = Array.from({ length: 40 }, (_, index) => ({
    eventId: index % 2 === 0 ? `model-call:response-${index + 1}` : `tool:session:tool-${index + 1}`,
    eventType: index % 2 === 0 ? 'model_call' : 'tool_execution',
    timelineSequence: index + 1,
    ...(index % 2 === 0
      ? { modelCallSequence: Math.floor(index / 2) + 1, tokenUsage: { totalTokens: 10 } }
      : { stepId: `tool-${index + 1}`, kind: 'session', toolName: 'read', status: 'succeeded' }),
  }));
  store.updateMessage('observability-detail-message', {
    content: 'done',
    status: 'completed',
    observabilityTimeline: {
      events,
      totalEventCount: 40,
      modelCallCount: 20,
      coldStartModelCallCount: 1,
      postColdModelCallCount: 19,
      providerMissCount: 3,
      toolExecutionCount: 20,
      failedToolExecutionCount: 0,
      totalToolDurationMs: 250,
    },
  });

  const stored = store.getMessageObservabilityTimeline('observability-detail-message');
  assert.equal(stored.totalEventCount, 40);
  assert.equal(stored.retainedEventCount, 16);
  assert.equal(stored.droppedEventCount, 24);
  assert.equal(stored.toolExecutionCount, 20);
  assert.deepEqual(stored.events.map((event) => event.timelineSequence), [1, ...Array.from({ length: 15 }, (_, index) => index + 26)]);
  assert.equal(queryCount(store, 'chat_message_observability_timelines'), 1);
  store.db.prepare('DELETE FROM chat_messages WHERE id = ?').run('observability-detail-message');
  assert.equal(queryCount(store, 'chat_message_observability_timelines'), 0);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('queued, completed, and failed assistant states atomically dual-write details while preserving full metadata', (t) => {
  const tempDir = withTempDir('caff-message-detail-states-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  let store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createConversation(store);
  const queuedSnapshot = createSnapshot('state-message', 'queued');
  store.createMessage({
    id: 'state-message',
    conversationId: conversation.id,
    turnId: 'turn-state-message',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Thinking...',
    status: 'queued',
    metadata: { phase: 'queued', agentContextSnapshot: queuedSnapshot },
    createdAt: '2026-08-25T00:00:02.000Z',
  });

  assert.equal(queryCount(store, 'chat_message_context_snapshots'), 1);
  assert.deepEqual(store.getMessageContextSnapshot('state-message'), queuedSnapshot);
  assert.equal(store.getMessageModelUsage('state-message'), null);
  const snapshotUpdatedAt = store.db.prepare(`
    SELECT updated_at FROM chat_message_context_snapshots WHERE message_id = ?
  `).get('state-message').updated_at;
  store.updateMessage('state-message', {
    status: 'streaming',
    metadata: { phase: 'streaming', agentContextSnapshot: queuedSnapshot },
  });
  assert.equal(
    store.db.prepare('SELECT updated_at FROM chat_message_context_snapshots WHERE message_id = ?').get('state-message').updated_at,
    snapshotUpdatedAt,
    'the same immutable snapshot must not be rewritten during lifecycle updates'
  );

  const completedSnapshot = queuedSnapshot;
  const fullUsage = createModelUsage(70);
  const completed = store.updateMessage('state-message', {
    content: 'done',
    status: 'completed',
    metadata: {
      phase: 'completed',
      agentContextSnapshot: completedSnapshot,
      modelUsage: fullUsage,
    },
  });

  assert.equal(completed.metadata.modelUsage.calls.length, 70, 'legacy metadata remains complete');
  assert.deepEqual(completed.metadata.agentContextSnapshot, completedSnapshot);
  assert.deepEqual(store.getMessageContextSnapshot('state-message'), completedSnapshot);
  const retainedUsage = store.getMessageModelUsage('state-message');
  assert.equal(retainedUsage.modelCallCount, 70);
  assert.equal(retainedUsage.calls.length, 16);
  assert.deepEqual(retainedUsage.calls.map((call) => call.sequence), [1, ...Array.from({ length: 15 }, (_, index) => index + 56)]);
  assert.equal(retainedUsage.callsTruncated, true);
  assert.equal(retainedUsage.retainedCallCount, 16);
  assert.equal(retainedUsage.droppedCallCount, 54);

  const failedSnapshot = createSnapshot('failed-message', 'failed');
  const failedUsage = createModelUsage(2);
  store.createMessage({
    id: 'failed-message',
    conversationId: conversation.id,
    turnId: 'turn-failed-message',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Thinking...',
    status: 'queued',
    metadata: { agentContextSnapshot: failedSnapshot },
    createdAt: '2026-08-25T00:00:03.000Z',
  });
  store.updateMessage('failed-message', {
    content: '',
    status: 'failed',
    errorMessage: 'provider failed',
    metadata: {
      failure: true,
      agentContextSnapshot: failedSnapshot,
      modelUsage: failedUsage,
    },
  });

  assert.deepEqual(store.getMessageContextSnapshot('failed-message'), failedSnapshot);
  assert.deepEqual(store.getMessageModelUsage('failed-message').calls.map((call) => call.sequence), [1, 2]);

  store.close();
  store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  assert.equal(store.getMessage('state-message').metadata.modelUsage.calls.length, 70);
  assert.deepEqual(store.getMessageModelUsage('state-message').calls.map((call) => call.sequence), [1, ...Array.from({ length: 15 }, (_, index) => index + 56)]);
  assert.equal(store.getMessage('failed-message').status, 'failed');
});

test('detail write failures roll back matching message inserts and updates', (t) => {
  const tempDir = withTempDir('caff-message-detail-rollback-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createConversation(store);
  const snapshot = createSnapshot('rollback-create');
  const originalSnapshotUpsert = store.messageDetailRepository.upsertContextSnapshot.bind(store.messageDetailRepository);
  store.messageDetailRepository.upsertContextSnapshot = () => {
    throw new Error('injected snapshot detail failure');
  };

  assert.throws(() => store.createMessage({
    id: 'rollback-create',
    conversationId: conversation.id,
    turnId: 'turn-rollback-create',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Thinking...',
    status: 'queued',
    metadata: { agentContextSnapshot: snapshot },
  }), /injected snapshot detail failure/u);
  assert.equal(store.getMessage('rollback-create'), null);

  store.messageDetailRepository.upsertContextSnapshot = originalSnapshotUpsert;
  store.createMessage({
    id: 'rollback-update',
    conversationId: conversation.id,
    turnId: 'turn-rollback-update',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Thinking...',
    status: 'queued',
    metadata: { phase: 'queued', agentContextSnapshot: createSnapshot('rollback-update', 'queued') },
  });

  const before = store.getMessage('rollback-update');
  const originalUsageUpsert = store.messageDetailRepository.upsertModelUsage.bind(store.messageDetailRepository);
  store.messageDetailRepository.upsertModelUsage = () => {
    throw new Error('injected usage detail failure');
  };

  assert.throws(() => store.updateMessage('rollback-update', {
    content: 'must roll back',
    status: 'completed',
    metadata: {
      phase: 'completed',
      agentContextSnapshot: createSnapshot('rollback-update', 'completed'),
      modelUsage: createModelUsage(4),
    },
  }), /injected usage detail failure/u);

  assert.deepEqual(store.getMessage('rollback-update'), before);
  assert.equal(store.getMessageContextSnapshot('rollback-update').snapshotId, 'snapshot-queued');
  assert.equal(store.getMessageModelUsage('rollback-update'), null);
  store.messageDetailRepository.upsertModelUsage = originalUsageUpsert;
});

test('new detail rows win over metadata fallback and message deletion cascades both tables', (t) => {
  const tempDir = withTempDir('caff-message-detail-dual-read-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createConversation(store);
  const tableSnapshot = createSnapshot('dual-message', 'table');
  const tableUsage = createModelUsage(3);
  store.createMessage({
    id: 'dual-message',
    conversationId: conversation.id,
    turnId: 'turn-dual-message',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'done',
    status: 'completed',
    metadata: { agentContextSnapshot: tableSnapshot, modelUsage: tableUsage },
    createdAt: '2026-08-25T00:00:04.000Z',
  });

  const legacySnapshot = createSnapshot('dual-message', 'legacy-tampered');
  const legacyUsage = createModelUsage(1);
  store.db.prepare('UPDATE chat_messages SET metadata_json = ? WHERE id = ?').run(JSON.stringify({
    agentContextSnapshot: legacySnapshot,
    modelUsage: legacyUsage,
  }), 'dual-message');

  assert.equal(store.getMessageContextSnapshot('dual-message').snapshotId, 'snapshot-table');
  assert.equal(store.getMessageModelUsage('dual-message').modelCallCount, 3);

  rawInsertMessage(store, {
    id: 'legacy-only-message',
    conversationId: conversation.id,
    createdAt: '2026-08-25T00:00:05.000Z',
    metadata: {
      agentContextSnapshot: createSnapshot('legacy-only-message', 'legacy-only'),
      modelUsage: createModelUsage(2),
    },
  });
  assert.equal(store.getMessageContextSnapshot('legacy-only-message').snapshotId, 'snapshot-legacy-only');
  assert.deepEqual(store.getMessageModelUsage('legacy-only-message').calls.map((call) => call.sequence), [1, 2]);

  store.deleteConversationMessages(conversation.id, ['dual-message']);
  assert.equal(store.getMessage('dual-message'), null);
  assert.equal(queryCount(store, 'chat_message_context_snapshots'), 0);
  assert.equal(queryCount(store, 'chat_message_model_usage_calls'), 0);
  assert.equal(store.getMessageContextSnapshot('legacy-only-message').snapshotId, 'snapshot-legacy-only');

  const cascadeConversation = createConversation(store, 'detail-conversation-cascade');
  store.createMessage({
    id: 'conversation-cascade-message',
    conversationId: cascadeConversation.id,
    turnId: 'turn-conversation-cascade-message',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'done',
    status: 'completed',
    metadata: {
      agentContextSnapshot: createSnapshot('conversation-cascade-message', 'conversation-cascade'),
      modelUsage: createModelUsage(1),
    },
  });
  assert.equal(queryCount(store, 'chat_message_context_snapshots'), 1);
  assert.equal(queryCount(store, 'chat_message_model_usage_calls'), 1);
  store.deleteConversation(cascadeConversation.id);
  assert.equal(queryCount(store, 'chat_message_context_snapshots'), 0);
  assert.equal(queryCount(store, 'chat_message_model_usage_calls'), 0);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});
