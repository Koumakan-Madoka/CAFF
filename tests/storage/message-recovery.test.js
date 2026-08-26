const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

function createFixture(store) {
  const agent = store.saveCustomRoleConfig({
    id: 'recovery-agent',
    name: 'Recovery Agent',
    personaPrompt: 'test',
  });
  const conversation = store.createConversation({
    id: 'recovery-conversation',
    title: 'Recovery',
    participants: [agent.id],
  });
  const sourceMessage = store.createMessage({
    id: 'failed-source-message',
    conversationId: conversation.id,
    turnId: 'source-turn',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: '',
    status: 'failed',
    taskId: 'source-task',
    runId: 42,
    errorMessage: 'stream_read_error',
    metadata: { failure: true },
  });
  return { agent, conversation, sourceMessage };
}

test('message recovery schema provides durable source-message idempotency and cascades with the source', (t) => {
  const tempDir = withTempDir('caff-message-recovery-storage-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { conversation, sourceMessage } = createFixture(store);
  const table = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_message_recoveries'").get();
  assert.ok(table);
  assert.match(table.sql, /UNIQUE\s*\(source_message_id\)/iu);
  assert.match(table.sql, /status IN \('queued', 'running', 'completed', 'failed'\)/iu);

  const first = store.createMessageRecovery({
    id: 'recovery-1',
    conversationId: conversation.id,
    sourceMessageId: sourceMessage.id,
    sourceTaskId: 'source-task',
    sourceRunId: 42,
    recoveryTaskId: 'recovery-task-1',
  });
  assert.equal(first.created, true);
  assert.equal(first.recovery.status, 'queued');
  assert.equal(first.recovery.sourceMessageId, sourceMessage.id);
  assert.equal(first.recovery.sourceRunId, 42);

  const duplicate = store.createMessageRecovery({
    id: 'recovery-2',
    conversationId: conversation.id,
    sourceMessageId: sourceMessage.id,
    sourceTaskId: 'source-task',
    sourceRunId: 42,
    recoveryTaskId: 'recovery-task-2',
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.recovery.id, first.recovery.id);
  assert.equal(duplicate.recovery.recoveryTaskId, 'recovery-task-1');
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM chat_message_recoveries').get().count,
    1
  );

  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  store.deleteConversation(conversation.id);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM chat_message_recoveries').get().count,
    0
  );
});

test('message recovery transitions are compare-and-set and terminal states cannot be reopened', (t) => {
  const tempDir = withTempDir('caff-message-recovery-transition-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { conversation, sourceMessage } = createFixture(store);
  const created = store.createMessageRecovery({
    id: 'recovery-transition',
    conversationId: conversation.id,
    sourceMessageId: sourceMessage.id,
    sourceTaskId: 'source-task',
    sourceRunId: 42,
    recoveryTaskId: 'recovery-task-transition',
  }).recovery;

  const capsule = { version: 1, source: { messageId: sourceMessage.id, taskId: 'source-task', runId: 42 } };
  const running = store.transitionMessageRecovery(created.id, ['queued'], {
    status: 'running',
    recoveryRunId: 77,
    capsule,
    startedAt: '2026-08-26T00:00:01.000Z',
  });
  assert.equal(running.status, 'running');
  assert.equal(running.recoveryRunId, 77);
  assert.deepEqual(running.capsule, capsule);

  const recoveryMessage = store.createMessage({
    id: 'recovery-result-message',
    conversationId: conversation.id,
    turnId: 'recovery-turn',
    role: 'assistant',
    senderName: 'Recovery Scribe',
    content: 'summary',
    status: 'completed',
    metadata: { recoveryResult: true },
  });
  const completed = store.transitionMessageRecovery(created.id, ['running'], {
    status: 'completed',
    recoveryMessageId: recoveryMessage.id,
    modelOutput: 'summary',
    fallbackUsed: false,
    endedAt: '2026-08-26T00:00:02.000Z',
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.recoveryMessageId, recoveryMessage.id);
  assert.equal(completed.fallbackUsed, false);

  const rejected = store.transitionMessageRecovery(created.id, ['completed'], {
    status: 'running',
  });
  assert.equal(rejected, null, 'completed recovery must not transition back to running even when expected');
  const terminalMutation = store.transitionMessageRecovery(created.id, ['completed'], {
    errorMessage: 'must not mutate terminal state',
  });
  assert.equal(terminalMutation, null, 'completed recovery fields must remain immutable');
  assert.equal(store.getMessageRecoveryBySourceMessage(sourceMessage.id).status, 'completed');

  const projected = store.listMessageRecoveriesBySourceMessageIds([sourceMessage.id, 'missing']);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].id, created.id);
});
