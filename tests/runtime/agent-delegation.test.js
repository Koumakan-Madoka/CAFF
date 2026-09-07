const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');
const { createAgentDelegationRuntime } = require('../../build/server/domain/conversation/agent-delegation-runtime');
const { withTempDir } = require('../helpers/temp-dir');

function createFixture(suffix) {
  const tempDir = withTempDir(`caff-agent-delegation-red-${suffix}-`);
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  const agent = store.saveCustomRoleConfig({
    id: `delegation-red-agent-${suffix}`,
    name: `Delegation Red Agent ${suffix}`,
    personaPrompt: 'Test delegation lifecycle.',
  });
  const recipient = store.saveCustomRoleConfig({
    id: `delegation-red-recipient-${suffix}`,
    name: `Delegation Red Recipient ${suffix}`,
    personaPrompt: 'Receive delegation lifecycle tests.',
  });
  const conversation = store.createConversation({
    id: `delegation-red-conversation-${suffix}`,
    title: `Delegation red ${suffix}`,
    participants: [agent.id, recipient.id],
  });
  const assistantMessage = store.createMessage({
    id: `delegation-red-message-${suffix}`,
    conversationId: conversation.id,
    turnId: `delegation-red-turn-${suffix}`,
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Thinking...',
    status: 'streaming',
  });
  const bridge = createAgentToolBridge({ store });
  const context = bridge.registerInvocation(bridge.createInvocationContext({
    conversationId: conversation.id,
    turnId: assistantMessage.turnId,
    agentId: agent.id,
    agentName: agent.name,
    assistantMessageId: assistantMessage.id,
    stage: { status: 'running', runId: `delegation-red-run-${suffix}` },
    turnState: { conversationId: conversation.id, turnId: assistantMessage.turnId, stopRequested: false },
  }));

  return {
    agent,
    recipient,
    tempDir,
    store,
    bridge,
    context,
    cleanup() {
      try {
        store.close();
      } catch {}
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test('regression: repeated read-context exposes a stable revision and short-circuits unchanged reads', (t) => {
  const fixture = createFixture('read');
  t.after(() => fixture.cleanup());

  const requestUrl = new URL('http://127.0.0.1/agent-tools/context');
  requestUrl.searchParams.set('invocationId', fixture.context.invocationId);
  requestUrl.searchParams.set('callbackToken', fixture.context.callbackToken);

  const first = fixture.bridge.handleReadContext(requestUrl);
  const second = fixture.bridge.handleReadContext(requestUrl);

  assert.equal(Number.isInteger(first.revision), true);
  assert.equal(first.hasChanges, true);
  assert.equal(Array.isArray(first.pendingDelegations), true);
  assert.equal(second.hasChanges, false);
  assert.equal(second.shortCircuited, true);
});

test('regression: authenticated bridge exposes structured delegation creation and await/yield return', (t) => {
  const fixture = createFixture('create');
  t.after(() => fixture.cleanup());

  assert.equal(typeof fixture.bridge.handleCreateDelegation, 'function');
  assert.equal(typeof fixture.bridge.handleAwaitDelegation, 'function');
});

test('awaited all delegation wakes exactly once when its children settle through runtime', (t) => {
  const fixture = createFixture('await-runtime');
  t.after(() => fixture.cleanup());
  fixture.context.enqueueAgent = () => ({ enqueuedAgentIds: [fixture.recipient.id], dispatch: [] });

  const created = fixture.bridge.handleCreateDelegation({
    invocationId: fixture.context.invocationId,
    callbackToken: fixture.context.callbackToken,
    recipientAgentIds: [fixture.recipient.id],
    content: 'Settle through the child runtime path.',
    idempotencyKey: 'await-runtime-key',
  });
  const waiting = fixture.bridge.handleAwaitDelegation({
    invocationId: fixture.context.invocationId,
    callbackToken: fixture.context.callbackToken,
    delegationId: created.delegationId,
  });
  assert.equal(waiting.delegation.status, 'awaiting');

  const completions = [];
  const runtime = createAgentDelegationRuntime({
    store: fixture.store,
    onCompletion(input) { completions.push(input); },
  });
  const settled = runtime.settleRecipient({
    delegationId: created.childDelegationIds[0],
    status: 'succeeded',
    result: { text: 'done' },
    at: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(settled.parent.status, 'succeeded');
  assert.equal(fixture.store.getAgentDelegation(created.delegationId).status, 'succeeded');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].completion.status, 'succeeded');
});
test('delegation runtime settles concurrent all children once and records late results', (t) => {
  const fixture = createFixture('all');
  t.after(() => fixture.cleanup());
  const secondRecipient = fixture.store.saveCustomRoleConfig({
    id: 'delegation-red-recipient-all-2',
    name: 'Delegation Red Recipient all 2',
    personaPrompt: 'Receive a second delegation.',
  });
  const conversation = fixture.store.getConversation(fixture.context.conversationId);
  fixture.store.updateConversation(conversation.id, { participants: [fixture.agent.id, fixture.recipient.id, secondRecipient.id] });
  fixture.context.enqueueAgent = (input) => ({
    enqueuedAgentIds: input.agentIds.slice(),
    dispatch: input.agentIds.map((agentId) => ({ agentId, outcome: 'queued' })),
  });

  const created = fixture.bridge.handleCreateDelegation({
    invocationId: fixture.context.invocationId,
    callbackToken: fixture.context.callbackToken,
    recipientAgentIds: [fixture.recipient.id, secondRecipient.id],
    aggregation: 'all',
    content: 'Run both independent checks.',
    idempotencyKey: 'all-key',
  });
  assert.equal(created.childDelegationIds.length, 2);

  const completions = [];
  const runtime = createAgentDelegationRuntime({
    store: fixture.store,
    onCompletion(input) { completions.push(input); },
  });
  const first = runtime.settleRecipient({ delegationId: created.childDelegationIds[0], status: 'succeeded', result: { text: 'one' } });
  assert.equal(first.parent.status, 'running');
  const second = runtime.settleRecipient({ delegationId: created.childDelegationIds[1], status: 'succeeded', result: { text: 'two' } });
  assert.equal(second.parent.status, 'succeeded');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].completion.delegationId, created.delegationId);
  assert.equal(completions[0].completion.result.childResults.length, 2);

  const late = runtime.settleRecipient({ delegationId: created.childDelegationIds[0], status: 'failed', result: { message: 'late' } });
  assert.equal(late.late, true);
  assert.equal(fixture.store.getAgentDelegation(created.childDelegationIds[0]).lateResultCount, 1);
  assert.equal(completions.length, 1);
});

test('delegation runtime propagates cancellation and deadline timeout without rewriting late results', (t) => {
  const fixture = createFixture('timeout');
  t.after(() => fixture.cleanup());
  fixture.context.enqueueAgent = () => ({ enqueuedAgentIds: [fixture.recipient.id], dispatch: [] });
  const created = fixture.bridge.handleCreateDelegation({
    invocationId: fixture.context.invocationId,
    callbackToken: fixture.context.callbackToken,
    recipientAgentIds: [fixture.recipient.id],
    content: 'Timeout this request.',
    idempotencyKey: 'timeout-key',
  });
  const childId = fixture.store.db.prepare('SELECT id FROM chat_agent_delegations WHERE parent_id = ?').get(created.delegationId).id;
  fixture.store.db.prepare('UPDATE chat_agent_delegations SET deadline_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', childId);
  const runtime = createAgentDelegationRuntime({
    store: fixture.store,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  const scanned = runtime.scanDeadlines();
  assert.equal(scanned.length > 0, true);
  assert.equal(fixture.store.getAgentDelegation(childId).status, 'timed_out');
  const late = runtime.settleRecipient({ delegationId: childId, status: 'succeeded', result: { text: 'too late' } });
  assert.equal(late.late, true);
  assert.equal(fixture.store.getAgentDelegation(childId).status, 'timed_out');
  assert.equal(fixture.store.getAgentDelegation(childId).lateResultCount, 1);
});

test('delegation creation is durable, idempotent, awaitable, and returns structured completion', (t) => {
  const fixture = createFixture('lifecycle');
  t.after(() => fixture.cleanup());
  const enqueueCalls = [];
  fixture.context.enqueueAgent = (input) => {
    enqueueCalls.push(input);
    return { enqueuedAgentIds: input.agentIds.slice(), dispatch: input.agentIds.map((agentId) => ({ agentId, outcome: 'queued' })) };
  };

  const created = fixture.bridge.handleCreateDelegation({
    invocationId: fixture.context.invocationId,
    callbackToken: fixture.context.callbackToken,
    recipientAgentIds: [fixture.recipient.id],
    content: 'Inspect the current implementation.',
    idempotencyKey: 'lifecycle-key',
  });

  assert.equal(created.ok, true);
  assert.equal(created.duplicate, false);
  assert.match(created.delegationId, /^[0-9a-f-]{36}$/u);
  assert.equal(created.delegation.status, 'running');
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].triggerType, 'delegation');

  const duplicate = fixture.bridge.handleCreateDelegation({
    invocationId: fixture.context.invocationId,
    callbackToken: fixture.context.callbackToken,
    recipientAgentIds: [fixture.recipient.id],
    content: 'This must not create another task.',
    idempotencyKey: 'lifecycle-key',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.delegationId, created.delegationId);
  assert.equal(enqueueCalls.length, 1);

  const waiting = fixture.bridge.handleAwaitDelegation({
    invocationId: fixture.context.invocationId,
    callbackToken: fixture.context.callbackToken,
    delegationId: created.delegationId,
  });
  assert.equal(waiting.yielded, true);
  assert.equal(waiting.delegation.status, 'awaiting');
  assert.equal(waiting.completion.schemaVersion, 1);

  const completedAt = new Date().toISOString();
  const completed = fixture.store.settleAgentDelegation(created.delegationId, 'succeeded', {
    childResults: [{ status: 'succeeded', text: 'Reviewed.' }],
  }, completedAt);
  assert.equal(completed.status, 'succeeded');
  const completion = fixture.bridge.handleAwaitDelegation({
    invocationId: fixture.context.invocationId,
    callbackToken: fixture.context.callbackToken,
    delegationId: created.delegationId,
  });
  assert.equal(completion.yielded, false);
  assert.equal(completion.completion.status, 'succeeded');
  assert.equal(completion.completion.result.childResults[0].text, 'Reviewed.');

  const childCount = fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_agent_delegations WHERE parent_id = ?').get(created.delegationId).count;
  assert.equal(childCount, 1);
});
