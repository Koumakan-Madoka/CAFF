const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createTurnOrchestrator } = require('../../build/server/domain/conversation/turn-orchestrator');
const {
  resolveInitialTurnTargets,
} = require('../../build/server/domain/conversation/turn/initial-target-resolution');

const { withTempDir } = require('../helpers/temp-dir');

async function waitForCondition(check, timeoutMs = 5000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await check();

    if (result) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Condition was not met in time');
}

function assistantMessage(agentId, createdAt) {
  return {
    id: `assistant-${agentId}-${createdAt}`,
    role: 'assistant',
    agentId,
    senderName: agentId,
    content: `${agentId} public reply`,
    status: 'completed',
    metadata: {},
    createdAt,
  };
}

function createHarness(t, options = {}) {
  const tempDir = withTempDir('caff-routing-preview-');
  const sqlitePath = path.join(tempDir, 'routing-preview.sqlite');
  const conversation = {
    id: 'conversation-routing-preview',
    title: 'Routing Preview',
    type: 'standard',
    metadata: {},
    agents: [
      { id: 'agent-a', name: 'Alpha' },
      { id: 'agent-b', name: 'Beta' },
      { id: 'agent-c', name: 'Gamma' },
    ],
    messages: Array.isArray(options.messages) ? [...options.messages] : [],
  };
  let messageCounter = 0;

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = {
    databasePath: sqlitePath,
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      return [{
        id: conversation.id,
        title: conversation.title,
        type: conversation.type,
        metadata: {},
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:00.000Z',
        lastMessageAt: null,
        messageCount: conversation.messages.length,
        agentCount: conversation.agents.length,
        lastMessagePreview: '',
      }];
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:01:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
    updateMessage(messageId, updates) {
      const message = conversation.messages.find((item) => item.id === messageId);
      if (!message) {
        return null;
      }
      if (updates.metadata !== undefined) {
        message.metadata = updates.metadata;
      }
      return message;
    },
    updateConversation(conversationId, updates) {
      assert.equal(conversationId, conversation.id);
      conversation.metadata = updates.metadata;
      return conversation;
    },
  };

  const orchestrator = createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: options.executeConversationAgent || (async ({ completedReplies, agent }) => {
      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    }),
  });

  return { conversation, orchestrator, store };
}

test('routing preview matches resolveInitialTurnTargets for the same input and conversation state', (t) => {
  const { conversation, orchestrator } = createHarness(t, {
    messages: [assistantMessage('agent-b', '2026-04-10T00:00:01.000Z')],
  });

  const drafts = [
    'plain follow-up question',
    '@Beta please review this',
    'please compare\n@Alpha @Beta',
    '@Alpha @Beta #ideate brainstorm options',
    '@Alpha @Beta #execute run the suite',
    '#execute ship it',
    '```\n@Beta\n```\nplain text',
  ];

  for (const content of drafts) {
    const preview = orchestrator.previewRouting(conversation.id, { content });
    const expected = resolveInitialTurnTargets(
      { content, cleanedContent: content, initialAgentIds: [] },
      conversation
    );

    assert.deepEqual(
      {
        agentIds: preview.agentIds,
        strategy: preview.strategy,
        executionMode: preview.executionMode,
        explicitIntent: preview.explicitIntent,
      },
      {
        agentIds: expected.agentIds,
        strategy: expected.strategy,
        executionMode: expected.executionMode,
        explicitIntent: expected.explicitIntent,
      },
      `preview diverged from resolveInitialTurnTargets for draft: ${JSON.stringify(content)}`
    );
    assert.equal(preview.conversationId, conversation.id);
  }
});

test('routing preview resolves strategy, targets, and execution mode per routing rules', (t) => {
  const withReply = createHarness(t, {
    messages: [assistantMessage('agent-b', '2026-04-10T00:00:01.000Z')],
  });
  const withoutReply = createHarness(t);

  assert.deepEqual(
    withoutReply.orchestrator.previewRouting(withoutReply.conversation.id, { content: 'plain question' }),
    {
      conversationId: withoutReply.conversation.id,
      agentIds: ['agent-a'],
      agents: [{ id: 'agent-a', name: 'Alpha' }],
      strategy: 'default_first_agent',
      executionMode: 'serial',
      explicitIntent: '',
    }
  );

  const lastAgentPreview = withReply.orchestrator.previewRouting(withReply.conversation.id, { content: 'plain question' });
  assert.deepEqual(lastAgentPreview.agentIds, ['agent-b']);
  assert.equal(lastAgentPreview.strategy, 'default_last_agent');
  assert.deepEqual(lastAgentPreview.agents, [{ id: 'agent-b', name: 'Beta' }]);

  const mentionPreview = withReply.orchestrator.previewRouting(withReply.conversation.id, { content: '@Beta hello' });
  assert.deepEqual(mentionPreview.agentIds, ['agent-b']);
  assert.equal(mentionPreview.strategy, 'user_mentions');
  assert.equal(mentionPreview.executionMode, 'serial');

  const multiPreview = withReply.orchestrator.previewRouting(withReply.conversation.id, { content: '@Alpha @Beta compare this' });
  assert.deepEqual(multiPreview.agentIds, ['agent-a', 'agent-b']);
  assert.equal(multiPreview.strategy, 'user_mentions');
  assert.equal(multiPreview.executionMode, 'parallel');

  const ideatePreview = withReply.orchestrator.previewRouting(withReply.conversation.id, { content: '@Alpha @Beta #ideate brainstorm' });
  assert.equal(ideatePreview.executionMode, 'parallel');
  assert.equal(ideatePreview.explicitIntent, 'ideate');

  const executePreview = withReply.orchestrator.previewRouting(withReply.conversation.id, { content: '@Alpha @Beta #execute run it' });
  assert.equal(executePreview.executionMode, 'serial');
  assert.equal(executePreview.explicitIntent, 'execute');
});

test('routing preview rejects unknown conversations and conversations without agents', (t) => {
  const { orchestrator } = createHarness(t);

  assert.throws(
    () => orchestrator.previewRouting('missing-conversation', { content: 'hello' }),
    (error) => error && error.statusCode === 404
  );

  const emptyHarness = createHarness(t);
  emptyHarness.conversation.agents = [];

  assert.throws(
    () => emptyHarness.orchestrator.previewRouting(emptyHarness.conversation.id, { content: 'hello' }),
    (error) => error && error.statusCode === 400
  );
});

test('submitted user messages persist the accept-time routing resolution in metadata.routing', async (t) => {
  const { conversation, orchestrator } = createHarness(t, {
    messages: [assistantMessage('agent-b', '2026-04-10T00:00:01.000Z')],
  });

  const result = orchestrator.submitConversationMessage(conversation.id, { content: '@Gamma please take this' });
  const acceptedMetadata = JSON.parse(JSON.stringify(result.acceptedMessage.metadata || {}));
  const routing = acceptedMetadata.routing;

  assert.deepEqual(routing, {
    agentIds: ['agent-c'],
    strategy: 'user_mentions',
    executionMode: 'serial',
    explicitIntent: '',
  });
  // Immediate main-lane dispatch starts synchronously inside submit, so by the time
  // submit returns the executor may already have flipped the status to dispatched.
  assert.ok(acceptedMetadata.routingRecordedAt);
  assert.ok(acceptedMetadata.routingStatus === 'accepted' || acceptedMetadata.routingStatus === 'dispatched');
  assert.equal(acceptedMetadata.dispatchLane, undefined);

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0);

  const persisted = conversation.messages.find((message) => message.id === result.acceptedMessage.id);
  assert.equal(persisted.metadata.routingStatus, 'dispatched');
  assert.deepEqual(persisted.metadata.routing, routing);
  assert.deepEqual(persisted.metadata.acceptedRouting, routing);
});

test('side-dispatched messages persist metadata.routing alongside the actual dispatch lane and target', async (t) => {
  let releaseFirstTurn = null;
  const firstTurnGate = new Promise((resolve) => {
    releaseFirstTurn = resolve;
  });
  let executionCount = 0;

  const { conversation, orchestrator } = createHarness(t, {
    executeConversationAgent: async ({ completedReplies, agent }) => {
      executionCount += 1;
      if (executionCount === 1) {
        await firstTurnGate;
      }
      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  const firstResult = orchestrator.submitConversationMessage(conversation.id, { content: 'first main-lane message' });
  assert.equal(firstResult.dispatch, 'started');

  const secondResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Beta side question' });
  assert.equal(secondResult.dispatchLane, 'side');
  assert.equal(secondResult.dispatchTargetAgentId, 'agent-b');

  const metadata = secondResult.acceptedMessage.metadata;
  assert.equal(metadata.dispatchLane, 'side');
  assert.equal(metadata.dispatchTargetAgentId, 'agent-b');
  assert.deepEqual(metadata.routing, {
    agentIds: ['agent-b'],
    strategy: 'user_mentions',
    executionMode: 'serial',
    explicitIntent: '',
  });
  assert.equal(metadata.routingStatus, 'dispatched');
  assert.ok(metadata.routingDispatchedAt);

  releaseFirstTurn();
  await waitForCondition(() => (
    orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0
    && orchestrator.listAgentSlotSummaries({ conversationId: conversation.id }).length === 0
  ));
});

test('queued default routing is re-persisted with the execution-time target when the latest replier changes', async (t) => {
  let releaseBetaTurn = null;
  const betaTurnGate = new Promise((resolve) => {
    releaseBetaTurn = resolve;
  });
  let executionCount = 0;

  const { conversation, orchestrator, store } = createHarness(t, {
    executeConversationAgent: async ({ completedReplies, agent }) => {
      executionCount += 1;
      if (executionCount === 1) {
        await betaTurnGate;
      }
      // Mirror production: agent-executor persists the public assistant reply to
      // the store, which is what default_last_agent re-resolution reads at drain time.
      completedReplies.push(store.createMessage({
        conversationId: conversation.id,
        role: 'assistant',
        agentId: agent.id,
        senderName: agent.name,
        content: `${agent.name} completed`,
        status: 'completed',
        metadata: {},
      }));
      return { stopTurn: false };
    },
  });

  const mentionResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Beta hold the room' });
  assert.equal(mentionResult.dispatch, 'started');

  const queuedResult = orchestrator.submitConversationMessage(conversation.id, { content: 'unmentioned follow-up' });
  assert.equal(queuedResult.dispatch, 'queued');
  const acceptedMetadata = JSON.parse(JSON.stringify(queuedResult.acceptedMessage.metadata || {}));
  assert.deepEqual(acceptedMetadata.routing, {
    agentIds: ['agent-a'],
    strategy: 'default_first_agent',
    executionMode: 'serial',
    explicitIntent: '',
  });
  assert.equal(acceptedMetadata.routingStatus, 'accepted');

  releaseBetaTurn();
  await waitForCondition(() => {
    const persisted = conversation.messages.find((message) => message.id === queuedResult.acceptedMessage.id);
    return persisted
      && persisted.metadata
      && persisted.metadata.routingStatus === 'dispatched'
      && orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0;
  });

  const persisted = conversation.messages.find((message) => message.id === queuedResult.acceptedMessage.id);
  assert.deepEqual(persisted.metadata.routing, {
    agentIds: ['agent-b'],
    strategy: 'default_last_agent',
    executionMode: 'serial',
    explicitIntent: '',
  });
  assert.deepEqual(persisted.metadata.acceptedRouting, acceptedMetadata.routing);
});

test('every user message in a merged queued batch receives the same execution-time routing metadata', async (t) => {
  let releaseBetaTurn = null;
  const betaTurnGate = new Promise((resolve) => {
    releaseBetaTurn = resolve;
  });
  let executionCount = 0;

  const { conversation, orchestrator, store } = createHarness(t, {
    executeConversationAgent: async ({ completedReplies, agent }) => {
      executionCount += 1;
      if (executionCount === 1) {
        await betaTurnGate;
      }
      completedReplies.push(store.createMessage({
        conversationId: conversation.id,
        role: 'assistant',
        agentId: agent.id,
        senderName: agent.name,
        content: `${agent.name} completed`,
        status: 'completed',
        metadata: {},
      }));
      return { stopTurn: false };
    },
  });

  orchestrator.submitConversationMessage(conversation.id, { content: '@Beta hold the room' });
  const firstQueued = orchestrator.submitConversationMessage(conversation.id, { content: 'queued follow-up one' });
  const secondQueued = orchestrator.submitConversationMessage(conversation.id, { content: 'queued follow-up two' });
  assert.equal(firstQueued.dispatch, 'queued');
  assert.equal(secondQueued.dispatch, 'queued');

  releaseBetaTurn();
  await waitForCondition(() => {
    const queuedMessages = [firstQueued.acceptedMessage.id, secondQueued.acceptedMessage.id]
      .map((messageId) => conversation.messages.find((message) => message.id === messageId));
    return queuedMessages.every((message) => message && message.metadata && message.metadata.routingStatus === 'dispatched')
      && orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0;
  });

  for (const messageId of [firstQueued.acceptedMessage.id, secondQueued.acceptedMessage.id]) {
    const persisted = conversation.messages.find((message) => message.id === messageId);
    assert.deepEqual(persisted.metadata.routing, {
      agentIds: ['agent-b'],
      strategy: 'default_last_agent',
      executionMode: 'serial',
      explicitIntent: '',
    });
    assert.deepEqual(persisted.metadata.acceptedRouting, {
      agentIds: ['agent-a'],
      strategy: 'default_first_agent',
      executionMode: 'serial',
      explicitIntent: '',
    });
  }
});
