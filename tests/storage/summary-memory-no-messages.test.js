const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  backfillConversationDigestSummarySegments,
} = require('../../build/server/domain/conversation/conversation-digest');
const { withTempDir } = require('../helpers/temp-dir');

const TEST_CONVERSATION_PARTICIPANTS = ['role-family-gpt'];
const POISON_MESSAGE = 'red-test: summary memory paths must not read message history (listMessages is forbidden)';

function createHarness(t, name) {
  const tempDir = withTempDir(`caff-summary-memory-no-messages-${name}-`);
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return store;
}

function poisonListMessages(store) {
  store.listMessages = () => {
    throw new Error(POISON_MESSAGE);
  };
}

function digestFixture(overrides = {}) {
  return {
    id: 'digest-fixture',
    kind: 'entry',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    createdBy: 'test',
    triggerReason: 'manual',
    messageRange: { fromMessageId: 'm1', toMessageId: 'm2', messageCount: 2 },
    summary: 'summary memory no-messages fixture digest summary.',
    facts: [],
    decisions: [],
    openQuestions: [],
    nextActions: [],
    artifacts: [],
    ...overrides,
  };
}

function seedConversations(store) {
  const digestConversation = store.createConversation({
    id: 'no-messages-digest-conversation',
    title: 'No Messages Digest Conversation',
    participants: TEST_CONVERSATION_PARTICIPANTS,
    metadata: {
      conversationDigests: [
        digestFixture({
          id: 'digest-no-messages-1',
          summary: 'first digest summary for the no-messages red test.',
        }),
        digestFixture({
          id: 'digest-no-messages-invalid',
          summary: '',
        }),
      ],
    },
  });
  const otherDigestConversation = store.createConversation({
    id: 'no-messages-other-conversation',
    title: 'No Messages Other Conversation',
    participants: TEST_CONVERSATION_PARTICIPANTS,
    metadata: {
      conversationDigests: [
        digestFixture({
          id: 'digest-no-messages-2',
          summary: 'second digest summary for the no-messages red test.',
        }),
      ],
    },
  });
  const plainConversation = store.createConversation({
    id: 'no-messages-plain-conversation',
    title: 'No Messages Plain Conversation',
    participants: TEST_CONVERSATION_PARTICIPANTS,
  });

  return { digestConversation, otherDigestConversation, plainConversation };
}

test('global summary memory health never reads message history', (t) => {
  const store = createHarness(t, 'global-health');
  seedConversations(store);
  poisonListMessages(store);

  const health = store.getSummaryMemoryHealth();

  assert.equal(health.ok, true);
  assert.equal(health.status, 'needs_backfill');
  assert.equal(health.search.available, true);
  assert.equal(health.backfill.conversationCount, 2);
  assert.equal(health.backfill.digestCount, 3);
  assert.equal(health.backfill.unsyncedDigestCount, 3);
  // listConversations() orders by COALESCE(last_message_at, updated_at, created_at)
  // DESC, so the most recently created digest conversation is reported first.
  assert.deepEqual(health.backfill.unsyncedDigests.map((entry) => entry.digestId), [
    'digest-no-messages-2',
    'digest-no-messages-1',
    'digest-no-messages-invalid',
  ]);
  assert.equal(health.backfill.unsyncedDigests[0].conversationId, 'no-messages-other-conversation');
  assert.equal(health.backfill.unsyncedDigests[0].conversationTitle, 'No Messages Other Conversation');
  assert.equal(health.backfill.unsyncedDigests[0].reason, 'missing_segment');
  assert.deepEqual(health.diagnostics, []);
});

test('scoped summary memory health never reads message history', (t) => {
  const store = createHarness(t, 'scoped-health');
  seedConversations(store);
  poisonListMessages(store);

  const health = store.getSummaryMemoryHealth({ conversationId: 'no-messages-digest-conversation' });

  assert.equal(health.ok, true);
  assert.equal(health.status, 'needs_backfill');
  assert.equal(health.backfill.conversationCount, 1);
  assert.equal(health.backfill.digestCount, 2);
  assert.equal(health.backfill.unsyncedDigestCount, 2);
  assert.deepEqual(health.backfill.unsyncedDigests.map((entry) => entry.digestId), [
    'digest-no-messages-1',
    'digest-no-messages-invalid',
  ]);
  assert.deepEqual(health.diagnostics, []);
});

test('scoped summary memory health keeps conversation_not_found without message history', (t) => {
  const store = createHarness(t, 'scoped-health-missing');
  seedConversations(store);
  poisonListMessages(store);

  const health = store.getSummaryMemoryHealth({ conversationId: 'no-messages-missing-conversation' });

  assert.equal(health.ok, true);
  assert.equal(health.status, 'ok');
  assert.equal(health.backfill.conversationCount, 0);
  assert.equal(health.backfill.digestCount, 0);
  assert.equal(health.backfill.unsyncedDigestCount, 0);
  assert.deepEqual(health.backfill.unsyncedDigests, []);
  assert.equal(health.diagnostics.length, 1);
  assert.equal(health.diagnostics[0].code, 'conversation_not_found');
});

test('global digest backfill never reads message history and keeps the health/backfill normalization split', (t) => {
  const store = createHarness(t, 'global-backfill');
  seedConversations(store);
  poisonListMessages(store);

  const result = backfillConversationDigestSummarySegments(store, {});

  // Health counts id-bearing digests from conversation metadata (3), while
  // backfill normalizes digests and drops the empty-summary fixture entry.
  // This split is existing production semantics and must remain unchanged.
  assert.equal(result.conversationCount, 3);
  assert.equal(result.digestCount, 2);
  assert.equal(result.segmentCount, 2);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.failures, []);

  const health = store.getSummaryMemoryHealth();
  assert.equal(health.status, 'needs_backfill');
  assert.equal(health.backfill.unsyncedDigestCount, 1);
  assert.equal(health.backfill.unsyncedDigests[0].digestId, 'digest-no-messages-invalid');
});

test('global digest backfill keeps per-digest partial failure without message history', (t) => {
  const store = createHarness(t, 'global-backfill-partial');
  seedConversations(store);
  poisonListMessages(store);

  // Inject one digest write failure for the first processed conversation and
  // assert later conversations still backfill (continue-on-error contract).
  const originalSave = store.saveSummarySegmentFromDigest.bind(store);
  store.saveSummarySegmentFromDigest = (conversationId, digest, options) => {
    if (digest && digest.id === 'digest-no-messages-2') {
      throw new Error('injected digest sync failure');
    }
    return originalSave(conversationId, digest, options);
  };

  const result = backfillConversationDigestSummarySegments(store, {});

  assert.equal(result.conversationCount, 3);
  assert.equal(result.digestCount, 2);
  assert.equal(result.segmentCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].conversationId, 'no-messages-other-conversation');
  assert.equal(result.failures[0].conversationTitle, 'No Messages Other Conversation');
  assert.equal(result.failures[0].digestId, 'digest-no-messages-2');
  assert.equal(result.failures[0].reason, 'sync_failed');
  assert.match(result.failures[0].message, /injected digest sync failure/u);

  // The later conversation (processed after the injected failure) still
  // backfilled, and the failed digest remains unsynced in health.
  const health = store.getSummaryMemoryHealth();
  assert.equal(health.backfill.unsyncedDigestCount, 2);
  assert.deepEqual(health.backfill.unsyncedDigests.map((entry) => entry.digestId), [
    'digest-no-messages-2',
    'digest-no-messages-invalid',
  ]);
});

test('scoped digest backfill never reads message history', (t) => {
  const store = createHarness(t, 'scoped-backfill');
  seedConversations(store);
  poisonListMessages(store);

  const result = backfillConversationDigestSummarySegments(store, {
    conversationId: 'no-messages-digest-conversation',
  });

  assert.equal(result.conversationCount, 1);
  assert.equal(result.digestCount, 1);
  assert.equal(result.segmentCount, 1);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.failures, []);

  const health = store.getSummaryMemoryHealth({ conversationId: 'no-messages-digest-conversation' });
  assert.equal(health.backfill.unsyncedDigestCount, 1);
  assert.equal(health.backfill.unsyncedDigests[0].digestId, 'digest-no-messages-invalid');
});

test('scoped digest backfill keeps 404 for missing conversation without message history', (t) => {
  const store = createHarness(t, 'scoped-backfill-missing');
  seedConversations(store);
  poisonListMessages(store);

  assert.throws(
    () => backfillConversationDigestSummarySegments(store, { conversationId: 'no-messages-missing-conversation' }),
    (error) => error && error.statusCode === 404 && /Conversation not found/u.test(error.message)
  );
});

test('empty store health and backfill stay healthy without message history', (t) => {
  const store = createHarness(t, 'empty-store');
  poisonListMessages(store);

  const health = store.getSummaryMemoryHealth();
  assert.equal(health.ok, true);
  assert.equal(health.status, 'ok');
  assert.equal(health.backfill.conversationCount, 0);
  assert.equal(health.backfill.digestCount, 0);
  assert.equal(health.backfill.unsyncedDigestCount, 0);
  assert.deepEqual(health.backfill.unsyncedDigests, []);
  assert.deepEqual(health.diagnostics, []);

  const result = backfillConversationDigestSummarySegments(store, {});
  assert.equal(result.conversationCount, 0);
  assert.equal(result.digestCount, 0);
  assert.equal(result.segmentCount, 0);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.failures, []);

  const snapshot = store.summarySegmentRepository.getHealthSnapshot();
  assert.equal(snapshot.segmentCount, 0);
});

test('repeat backfill is idempotent without duplicate rows and without message history', (t) => {
  const store = createHarness(t, 'repeat-backfill');
  seedConversations(store);
  poisonListMessages(store);

  const first = backfillConversationDigestSummarySegments(store, {});
  assert.equal(first.segmentCount, 2);
  assert.equal(first.failedCount, 0);

  const second = backfillConversationDigestSummarySegments(store, {});
  assert.equal(second.conversationCount, first.conversationCount);
  assert.equal(second.digestCount, first.digestCount);
  assert.equal(second.segmentCount, 2);
  assert.equal(second.failedCount, 0);
  assert.deepEqual(second.failures, []);

  // Upsert keyed on source_digest_id must keep exactly one row per digest.
  const snapshot = store.summarySegmentRepository.getHealthSnapshot();
  assert.equal(snapshot.segmentCount, 2);
  const segment = store.summarySegmentRepository.getBySourceDigestId('digest-no-messages-1');
  assert.ok(segment);
  assert.equal(segment.id, 'segment-digest-no-messages-1');

  const health = store.getSummaryMemoryHealth();
  assert.equal(health.backfill.unsyncedDigestCount, 1);
  assert.equal(health.backfill.unsyncedDigests[0].digestId, 'digest-no-messages-invalid');
});

test('backfill taskName attribution keeps explicit, resolver, and default behavior without message history', (t) => {
  const store = createHarness(t, 'task-name');
  seedConversations(store);
  poisonListMessages(store);

  const explicit = backfillConversationDigestSummarySegments(store, {
    conversationId: 'no-messages-digest-conversation',
    taskName: 'explicit-backfill-task',
  });
  assert.equal(explicit.segmentCount, 1);
  assert.equal(explicit.failedCount, 0);

  const explicitSegment = store.summarySegmentRepository.getBySourceDigestId('digest-no-messages-1');
  assert.equal(explicitSegment.task_name, 'explicit-backfill-task');
  const explicitMetadata = JSON.parse(explicitSegment.metadata_json);
  assert.equal(explicitMetadata.source, 'conversation_digest');
  assert.equal(explicitMetadata.trigger, 'metadata-backfill');

  const resolved = backfillConversationDigestSummarySegments(
    store,
    { conversationId: 'no-messages-other-conversation' },
    {
      resolveSummaryMemoryTaskName: ({ conversation }) => `resolved:${conversation && conversation.title}`,
    }
  );
  assert.equal(resolved.segmentCount, 1);
  assert.equal(resolved.failedCount, 0);

  const resolvedSegment = store.summarySegmentRepository.getBySourceDigestId('digest-no-messages-2');
  assert.equal(resolvedSegment.task_name, 'resolved:No Messages Other Conversation');

  const defaulted = backfillConversationDigestSummarySegments(store, {
    conversationId: 'no-messages-plain-conversation',
  });
  assert.equal(defaulted.conversationCount, 1);
  assert.equal(defaulted.digestCount, 0);
  assert.equal(defaulted.segmentCount, 0);
});

test('direct saveSummarySegmentFromDigest never reads message history', (t) => {
  const store = createHarness(t, 'direct-save');
  seedConversations(store);
  poisonListMessages(store);

  const segment = store.saveSummarySegmentFromDigest(
    'no-messages-other-conversation',
    digestFixture({
      id: 'digest-no-messages-direct-save',
      summary: 'direct save summary for the no-messages red test.',
    }),
    { taskName: 'no-messages-task' }
  );

  assert.equal(segment.sourceDigestId, 'digest-no-messages-direct-save');
  assert.equal(segment.conversationId, 'no-messages-other-conversation');
  assert.equal(segment.conversationTitle, 'No Messages Other Conversation');
  assert.equal(segment.taskName, 'no-messages-task');
});
