const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

function createConversation(store, id = 'contract-conversation') {
  return store.createConversation({
    id,
    title: 'P2C Contract',
    type: 'standard',
    projectScopeId: 'project-1',
    participants: ['role-family-gpt'],
  });
}

function createSnapshot(messageId, marker = messageId) {
  const displayContent = `contract full display content ${marker} ${'x'.repeat(4096)}`;
  return {
    schemaVersion: 1,
    snapshotId: `snapshot-${marker}`,
    capturedAt: '2026-08-25T08:00:00.000Z',
    conversationId: 'contract-conversation',
    turnId: `turn-${messageId}`,
    messageId,
    agentId: 'role-family-gpt',
    agentName: 'GPT',
    promptVersion: 'contract-test',
    immutable: true,
    totalApproxTokens: 1024,
    totalByteSize: Buffer.byteLength(displayContent, 'utf8'),
    sections: [{
      sectionKey: 'conversation_history',
      title: 'Conversation History',
      displayTitle: 'Conversation History',
      source: 'conversation/messages',
      visibility: 'full',
      contentHash: `content-${marker}`,
      displayContentHash: `display-${marker}`,
      approxTokens: 1024,
      byteSize: Buffer.byteLength(displayContent, 'utf8'),
      truncated: false,
      truncationNote: '',
      redacted: false,
      policyNote: '',
      contentPreview: displayContent.slice(0, 180),
      displayContent,
    }],
  };
}

function createModelUsage(callCount) {
  const calls = Array.from({ length: callCount }, (_, index) => ({
    sequence: index + 1,
    responseId: `response-${index + 1}`,
    stopReason: 'stop',
    timestamp: index + 1,
    coldStart: index === 0,
    isColdStart: index === 0,
    providerMiss: index > 0 && index % 7 === 0,
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

function expectedSnapshotReference(snapshot) {
  return {
    schemaVersion: 1,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    conversationId: snapshot.conversationId,
    turnId: snapshot.turnId,
    messageId: snapshot.messageId,
    agentId: snapshot.agentId,
    agentName: snapshot.agentName,
    promptVersion: snapshot.promptVersion,
    immutable: true,
    totalApproxTokens: snapshot.totalApproxTokens,
    totalByteSize: snapshot.totalByteSize,
    sectionCount: snapshot.sections.length,
  };
}

function expectedUsageSummary(modelUsage) {
  const retainedCallCount = Math.min(modelUsage.calls.length, 64);
  const droppedCallCount = modelUsage.calls.length - retainedCallCount;
  return {
    modelCallCount: modelUsage.modelCallCount,
    coldStartModelCallCount: modelUsage.coldStartModelCallCount,
    postColdModelCallCount: modelUsage.postColdModelCallCount,
    providerMissCount: modelUsage.providerMissCount,
    callsTruncated: droppedCallCount > 0,
    retainedCallCount,
    droppedCallCount,
  };
}

test('Contract assistant writes keep full details in tables and serialize only lightweight metadata', (t) => {
  const tempDir = withTempDir('caff-message-detail-contract-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  const conversation = createConversation(store);
  const historicalSnapshot = createSnapshot('historical-message');
  const historicalMetadataJson = JSON.stringify({
    marker: 'historical-expand-row',
    agentContextSnapshot: historicalSnapshot,
    modelUsage: createModelUsage(2),
  });
  store.db.prepare(`
    INSERT INTO chat_messages (
      id, conversation_id, turn_id, role, agent_id, sender_name,
      content, status, metadata_json, created_at
    ) VALUES (?, ?, ?, 'assistant', 'role-family-gpt', 'GPT', 'historical', 'completed', ?, ?)
  `).run(
    'historical-message',
    conversation.id,
    'turn-historical-message',
    historicalMetadataJson,
    '2026-08-25T07:59:59.000Z'
  );

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const messageId = 'contract-message';
  const snapshot = createSnapshot(messageId);
  const usage = createModelUsage(65);
  const queued = store.createMessage({
    id: messageId,
    conversationId: conversation.id,
    turnId: `turn-${messageId}`,
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Thinking...',
    status: 'queued',
    metadata: {
      phase: 'queued',
      agentContextSnapshot: snapshot,
    },
    contextSnapshot: snapshot,
  });

  assert.deepEqual(queued.metadata.agentContextSnapshot, expectedSnapshotReference(snapshot));
  assert.equal(Object.hasOwn(queued.metadata.agentContextSnapshot, 'sections'), false);
  assert.equal(JSON.stringify(queued.metadata).includes('displayContent'), false);
  assert.deepEqual(store.getMessageContextSnapshot(messageId), snapshot);
  const queuedSnapshotRow = store.db.prepare(`
    SELECT snapshot_json, updated_at FROM chat_message_context_snapshots WHERE message_id = ?
  `).get(messageId);

  const streaming = store.updateMessage(messageId, {
    status: 'streaming',
    metadata: { ...queued.metadata, phase: 'streaming', toolBridge: { enabled: true } },
    contextSnapshot: snapshot,
  });
  assert.equal(JSON.stringify(streaming.metadata).includes('displayContent'), false);
  const streamingSnapshotRow = store.db.prepare(`
    SELECT snapshot_json, updated_at FROM chat_message_context_snapshots WHERE message_id = ?
  `).get(messageId);
  assert.deepEqual(streamingSnapshotRow, queuedSnapshotRow, 'immutable snapshot must not be rewritten');

  const completed = store.updateMessage(messageId, {
    content: 'done',
    status: 'completed',
    metadata: {
      ...queued.metadata,
      phase: 'completed',
      agentContextSnapshot: snapshot,
      modelUsage: usage,
      tokenUsage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    },
    contextSnapshot: snapshot,
    modelUsage: usage,
  });

  assert.deepEqual(completed.metadata.agentContextSnapshot, expectedSnapshotReference(snapshot));
  assert.deepEqual(completed.metadata.modelUsage, expectedUsageSummary(usage));
  assert.equal(Object.hasOwn(completed.metadata.modelUsage, 'calls'), false);
  assert.equal(JSON.stringify(completed.metadata).includes('displayContent'), false);

  const tableSnapshot = store.getMessageContextSnapshot(messageId);
  assert.equal(tableSnapshot.sections[0].displayContent, snapshot.sections[0].displayContent);
  const tableUsage = store.getMessageModelUsage(messageId);
  assert.deepEqual(tableUsage.calls.map((call) => call.sequence), [1, ...Array.from({ length: 63 }, (_, index) => index + 3)]);
  assert.equal(tableUsage.modelCallCount, 65);
  assert.equal(tableUsage.droppedCallCount, 1);

  const row = store.db.prepare('SELECT metadata_json FROM chat_messages WHERE id = ?').get(messageId);
  assert.equal(row.metadata_json.includes('displayContent'), false);
  assert.equal(row.metadata_json.includes('"calls"'), false);
  assert.ok(
    Buffer.byteLength(row.metadata_json, 'utf8') < Buffer.byteLength(JSON.stringify({ agentContextSnapshot: snapshot, modelUsage: usage }), 'utf8') / 4,
    'Contract metadata should be materially smaller than the full Expand metadata'
  );

  const failedSnapshot = createSnapshot('failed-message');
  const failedUsage = createModelUsage(3);
  store.createMessage({
    id: 'failed-message',
    conversationId: conversation.id,
    turnId: 'turn-failed-message',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Thinking...',
    status: 'queued',
    metadata: { phase: 'queued' },
    contextSnapshot: failedSnapshot,
  });
  const failed = store.updateMessage('failed-message', {
    content: '',
    status: 'failed',
    errorMessage: 'provider failed',
    metadata: { failure: true, invocationFailure: { kind: 'provider' } },
    contextSnapshot: failedSnapshot,
    modelUsage: failedUsage,
  });
  assert.deepEqual(failed.metadata.agentContextSnapshot, expectedSnapshotReference(failedSnapshot));
  assert.deepEqual(failed.metadata.modelUsage, expectedUsageSummary(failedUsage));
  assert.equal(JSON.stringify(failed.metadata).includes('displayContent'), false);
  assert.equal(JSON.stringify(failed.metadata).includes('"calls"'), false);
  assert.equal(store.getMessageModelUsage('failed-message').calls.length, 3);

  const nullUsageSnapshot = createSnapshot('null-usage-message');
  store.createMessage({
    id: 'null-usage-message',
    conversationId: conversation.id,
    turnId: 'turn-null-usage-message',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Thinking...',
    status: 'queued',
    metadata: { phase: 'queued' },
    contextSnapshot: nullUsageSnapshot,
  });
  const nullUsage = store.updateMessage('null-usage-message', {
    content: 'done without usage',
    status: 'completed',
    metadata: { phase: 'completed', modelUsage: null },
    contextSnapshot: nullUsageSnapshot,
    modelUsage: null,
  });
  assert.equal(Object.hasOwn(nullUsage.metadata, 'modelUsage'), false);
  assert.equal(store.getMessageModelUsage('null-usage-message'), null);

  assert.equal(
    store.db.prepare('SELECT metadata_json FROM chat_messages WHERE id = ?').get('historical-message').metadata_json,
    historicalMetadataJson,
    'Contract writes must not mutate historical Expand metadata bytes'
  );
});

test('Contract explicit detail failures roll back queued create and completed update', (t) => {
  const tempDir = withTempDir('caff-message-detail-contract-rollback-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  const conversation = createConversation(store);

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const createSnapshotValue = createSnapshot('rollback-create');
  const originalSnapshotUpsert = store.messageDetailRepository.upsertContextSnapshot;
  store.messageDetailRepository.upsertContextSnapshot = () => {
    throw new Error('contract snapshot write failed');
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
    metadata: { phase: 'queued' },
    contextSnapshot: createSnapshotValue,
  }), /contract snapshot write failed/u);
  assert.equal(store.getMessage('rollback-create'), null);
  store.messageDetailRepository.upsertContextSnapshot = originalSnapshotUpsert;

  const updateSnapshotValue = createSnapshot('rollback-update');
  store.createMessage({
    id: 'rollback-update',
    conversationId: conversation.id,
    turnId: 'turn-rollback-update',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Thinking...',
    status: 'queued',
    metadata: { phase: 'queued', agentContextSnapshot: updateSnapshotValue },
  });
  const originalUsageUpsert = store.messageDetailRepository.upsertModelUsage;
  store.messageDetailRepository.upsertModelUsage = () => {
    throw new Error('contract usage write failed');
  };
  const usage = createModelUsage(3);
  assert.throws(() => store.updateMessage('rollback-update', {
    content: 'must roll back',
    status: 'completed',
    metadata: { phase: 'completed' },
    contextSnapshot: updateSnapshotValue,
    modelUsage: usage,
  }), /contract usage write failed/u);
  const after = store.getMessage('rollback-update');
  assert.equal(after.content, 'Thinking...');
  assert.equal(after.status, 'queued');
  assert.deepEqual(after.metadata, { phase: 'queued', agentContextSnapshot: updateSnapshotValue });
  store.messageDetailRepository.upsertModelUsage = originalUsageUpsert;
});
