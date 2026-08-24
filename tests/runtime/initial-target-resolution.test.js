const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  resolveInitialTurnTargets,
  resolveMostRecentPublicReplyAgentId,
} = require('../../build/server/domain/conversation/turn/initial-target-resolution');
const { withTempDir } = require('../helpers/temp-dir');

function agent(id) {
  return { id, name: id };
}

function assistantMessage(id, agentId, overrides = {}) {
  return {
    id,
    role: 'assistant',
    agentId,
    senderName: agentId,
    content: `${agentId} public reply`,
    status: 'completed',
    metadata: {},
    createdAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

function conversation(messages = []) {
  return {
    id: 'conversation-target-resolution',
    agents: [agent('agent-a'), agent('agent-b'), agent('agent-c')],
    messages,
  };
}

test('initial target priority is explicit ids, actionable mentions, last public reply, then first participant', () => {
  const state = conversation([
    assistantMessage('message-last', 'agent-b'),
  ]);

  assert.deepEqual(
    resolveInitialTurnTargets({
      content: '@agent-c hello',
      cleanedContent: '@agent-c hello',
      initialAgentIds: ['agent-a'],
      entryStrategy: 'directed',
      executionMode: 'queue',
    }, state),
    {
      agentIds: ['agent-a'],
      strategy: 'directed',
      executionMode: 'queue',
      explicitIntent: false,
      privateOnly: false,
      cleanedUserText: '@agent-c hello',
    }
  );

  const mentionResolution = resolveInitialTurnTargets({
    content: '@agent-c hello',
    cleanedContent: '@agent-c hello',
    initialAgentIds: [],
  }, state);
  assert.deepEqual(mentionResolution.agentIds, ['agent-c']);
  assert.equal(mentionResolution.strategy, 'user_mentions');

  const lastResolution = resolveInitialTurnTargets({
    content: 'plain message',
    cleanedContent: 'plain message',
    initialAgentIds: [],
  }, state);
  assert.deepEqual(lastResolution.agentIds, ['agent-b']);
  assert.equal(lastResolution.strategy, 'default_last_agent');

  const firstResolution = resolveInitialTurnTargets({
    content: 'first message',
    cleanedContent: 'first message',
    initialAgentIds: [],
  }, conversation());
  assert.deepEqual(firstResolution.agentIds, ['agent-a']);
  assert.equal(firstResolution.strategy, 'default_first_agent');
});

test('last public reply excludes failed, incomplete, empty, private-only, private visibility, and removed-agent messages', () => {
  const messages = [
    assistantMessage('message-valid-a', 'agent-a', { createdAt: '2026-08-24T00:00:00.000Z' }),
    assistantMessage('message-failed-b', 'agent-b', { status: 'failed', createdAt: '2026-08-24T00:00:01.000Z' }),
    assistantMessage('message-streaming-b', 'agent-b', { status: 'streaming', createdAt: '2026-08-24T00:00:02.000Z' }),
    assistantMessage('message-empty-b', 'agent-b', { content: '   ', createdAt: '2026-08-24T00:00:03.000Z' }),
    assistantMessage('message-private-only-b', 'agent-b', {
      metadata: { privateOnly: true },
      createdAt: '2026-08-24T00:00:04.000Z',
    }),
    assistantMessage('message-private-visibility-b', 'agent-b', {
      metadata: { visibility: 'private' },
      createdAt: '2026-08-24T00:00:05.000Z',
    }),
    assistantMessage('message-removed-agent', 'agent-removed', { createdAt: '2026-08-24T00:00:06.000Z' }),
  ];

  assert.equal(resolveMostRecentPublicReplyAgentId(conversation(messages)), 'agent-a');

  messages.push(assistantMessage('message-valid-b', 'agent-b', {
    createdAt: '2026-08-24T00:00:07.000Z',
  }));
  assert.equal(resolveMostRecentPublicReplyAgentId(conversation(messages)), 'agent-b');
});

test('last public reply uses persisted createdAt and id order instead of input array order', () => {
  const sameTimestamp = '2026-08-24T00:00:00.000Z';
  const state = conversation([
    assistantMessage('message-z', 'agent-b', { createdAt: sameTimestamp }),
    assistantMessage('message-a', 'agent-a', { createdAt: sameTimestamp }),
  ]);

  assert.equal(resolveMostRecentPublicReplyAgentId(state), 'agent-b');
});

test('last public reply selection survives a SQLite store restart with stable persisted order', { concurrency: false }, (t) => {
  const tempDir = withTempDir('caff-default-last-agent-restart-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  let store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const firstAgent = store.saveCustomRoleConfig({
    id: 'restart-agent-a',
    name: 'Restart Agent A',
    personaPrompt: 'A',
  });
  const secondAgent = store.saveCustomRoleConfig({
    id: 'restart-agent-b',
    name: 'Restart Agent B',
    personaPrompt: 'B',
  });
  const createdConversation = store.createConversation({
    id: 'restart-default-route-conversation',
    title: 'Restart default route',
    participants: [
      { agentId: firstAgent.id },
      { agentId: secondAgent.id },
    ],
  });
  const sameTimestamp = '2026-08-24T00:00:00.000Z';
  store.createMessage({
    id: 'restart-message-a',
    conversationId: createdConversation.id,
    role: 'assistant',
    agentId: firstAgent.id,
    senderName: firstAgent.name,
    content: 'Earlier by id',
    status: 'completed',
    createdAt: sameTimestamp,
  });
  store.createMessage({
    id: 'restart-message-z',
    conversationId: createdConversation.id,
    role: 'assistant',
    agentId: secondAgent.id,
    senderName: secondAgent.name,
    content: 'Later by id',
    status: 'completed',
    createdAt: sameTimestamp,
  });

  store.close();
  store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  const resolution = resolveInitialTurnTargets({
    content: 'continue after restart',
    cleanedContent: 'continue after restart',
    initialAgentIds: [],
  }, store.getConversation(createdConversation.id));

  assert.deepEqual(resolution.agentIds, [secondAgent.id]);
  assert.equal(resolution.strategy, 'default_last_agent');
});
