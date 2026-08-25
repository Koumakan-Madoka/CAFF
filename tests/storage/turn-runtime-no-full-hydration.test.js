const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createTurnOrchestrator } = require('../../build/server/domain/conversation/turn-orchestrator');
const { applySessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
const { withTempDir } = require('../helpers/temp-dir');

const FULL_HYDRATION_POISON = 'red-test: persistent turn paths must not hydrate the full conversation';
const UNBOUNDED_MESSAGES_POISON = 'red-test: persistent turn paths must not list unbounded messages';
const UNBOUNDED_PRIVATE_MESSAGES_POISON = 'red-test: agent prompts must not list unbounded private messages';

async function waitForCondition(check, timeoutMs = 5000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Condition was not met in time');
}

function createHarness(t, name) {
  const tempDir = withTempDir(`caff-turn-no-hydration-${name}-`);
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { tempDir, sqlitePath, store };
}

function saveAgent(store, id, name) {
  return store.saveCustomRoleConfig({
    id,
    name,
    personaPrompt: `${name} test persona`,
  });
}

function createOrchestrator(harness, options = {}) {
  return createTurnOrchestrator({
    store: harness.store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: harness.tempDir,
    sqlitePath: harness.sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(harness.tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async () => ({ stopTurn: false }),
    ...options,
  });
}

function poisonFullHydration(store) {
  store.getConversation = () => {
    throw new Error(FULL_HYDRATION_POISON);
  };
  store.listMessages = () => {
    throw new Error(UNBOUNDED_MESSAGES_POISON);
  };
  store.listPrivateMessages = () => {
    throw new Error(UNBOUNDED_PRIVATE_MESSAGES_POISON);
  };
}

function readHeader(store, conversationId) {
  const conversation = store.getConversationWithoutMessages(conversationId);
  assert.ok(conversation, `expected conversation header ${conversationId}`);
  return conversation;
}

function createConversation(store, input = {}) {
  return store.createConversation({
    id: input.id,
    title: input.title || input.id,
    participants: input.participants,
    metadata: input.metadata || {},
  });
}

function createMessage(store, conversationId, input) {
  return store.createMessage({
    conversationId,
    turnId: input.turnId || `turn-${input.id}`,
    role: input.role,
    agentId: input.agentId || null,
    senderName: input.senderName || (input.role === 'user' ? 'You' : 'Assistant'),
    content: input.content || '',
    status: input.status || 'completed',
    metadata: input.metadata || {},
    createdAt: input.createdAt,
    id: input.id,
  });
}

test('orchestrator restart recovery never hydrates full conversations', { concurrency: false }, (t) => {
  const harness = createHarness(t, 'restart');
  const agent = saveAgent(harness.store, 'restart-agent', 'Restart Agent');
  const conversation = createConversation(harness.store, {
    id: 'restart-no-hydration',
    participants: [{ agentId: agent.id }],
  });
  createMessage(harness.store, conversation.id, {
    id: 'restart-history-user',
    role: 'user',
    content: 'already consumed',
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  createMessage(harness.store, conversation.id, {
    id: 'restart-history-assistant',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'completed reply',
    createdAt: '2026-08-25T00:00:01.000Z',
  });

  poisonFullHydration(harness.store);

  const orchestrator = createOrchestrator(harness);
  assert.equal(orchestrator.getConversationQueueDepth(conversation.id), 0);
  assert.deepEqual(orchestrator.buildRuntimePayload().conversationQueueDepths, {});
});

test('restart cursor inference uses targeted queue projections without full hydration', { concurrency: false }, (t) => {
  const harness = createHarness(t, 'cursor-inference');
  const agent = saveAgent(harness.store, 'cursor-inference-agent', 'Cursor Inference Agent');
  const conversation = createConversation(harness.store, {
    id: 'cursor-inference-no-hydration',
    participants: [{ agentId: agent.id }],
  });
  createMessage(harness.store, conversation.id, {
    id: 'cursor-inference-pending-user',
    role: 'user',
    content: 'pending after restart',
    createdAt: '2026-08-25T00:00:00.000Z',
  });

  harness.store.listConversations = () => [];
  poisonFullHydration(harness.store);

  const orchestrator = createOrchestrator(harness);
  assert.equal(orchestrator.getConversationQueueDepth(conversation.id), 1);
});

test('pending queue depth after a durable cursor never hydrates full history', { concurrency: false }, (t) => {
  const harness = createHarness(t, 'pending-depth');
  const agent = saveAgent(harness.store, 'pending-depth-agent', 'Pending Depth Agent');
  const conversation = createConversation(harness.store, {
    id: 'pending-depth-no-hydration',
    participants: [{ agentId: agent.id }],
    metadata: {
      conversationTurnQueue: {
        lastConsumedUserMessageId: 'pending-depth-consumed',
      },
    },
  });
  createMessage(harness.store, conversation.id, {
    id: 'pending-depth-consumed',
    role: 'user',
    content: 'consumed',
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  createMessage(harness.store, conversation.id, {
    id: 'pending-depth-assistant',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'completed',
    createdAt: '2026-08-25T00:00:01.000Z',
  });

  const orchestrator = createOrchestrator(harness);
  createMessage(harness.store, conversation.id, {
    id: 'pending-depth-new-user',
    role: 'user',
    content: 'pending',
    createdAt: '2026-08-25T00:00:02.000Z',
  });
  poisonFullHydration(harness.store);

  assert.equal(orchestrator.getConversationQueueDepth(conversation.id), 1);
});

test('Goal continuation completes one bounded iteration without full hydration', { concurrency: false }, async (t) => {
  const harness = createHarness(t, 'goal');
  const agent = saveAgent(harness.store, 'goal-agent', 'Goal Agent');
  const conversation = createConversation(harness.store, {
    id: 'goal-no-hydration',
    participants: [{ agentId: agent.id }],
    metadata: {
      sessionGoal: {
        objective: 'Complete one bounded continuation',
        status: 'active',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
    },
  });
  let executionCount = 0;
  const orchestrator = createOrchestrator(harness, {
    sessionGoalAutoContinueMaxTurns: 1,
    async executeConversationAgent({ agent: executingAgent, completedReplies }) {
      executionCount += 1;
      completedReplies.push({
        id: 'bounded-goal-reply',
        agentId: executingAgent.id,
        senderName: executingAgent.name,
        content: 'bounded continuation completed',
        status: 'completed',
      });
      return { stopTurn: false, terminationReason: '' };
    },
  });

  poisonFullHydration(harness.store);

  const scheduled = orchestrator.scheduleGoalContinuation(conversation.id);
  assert.equal(scheduled.scheduled, true);
  assert.equal(scheduled.dispatch, 'started');

  await waitForCondition(() => {
    const header = readHeader(harness.store, conversation.id);
    return header.metadata && header.metadata.sessionGoalProposal;
  });

  const header = readHeader(harness.store, conversation.id);
  assert.equal(executionCount, 1);
  assert.equal(header.metadata.sessionGoalRunner.iteration, 1);
  assert.equal(header.metadata.sessionGoalRunner.status, 'budget_limited');
  assert.equal(header.metadata.sessionGoalProposal.action, 'pause');
});

test('default routing and prompt history stay bounded without full hydration', { concurrency: false }, async (t) => {
  const harness = createHarness(t, 'routing');
  const firstAgent = saveAgent(harness.store, 'routing-agent-a', 'Alpha');
  const secondAgent = saveAgent(harness.store, 'routing-agent-b', 'Beta');
  const conversation = createConversation(harness.store, {
    id: 'routing-no-hydration',
    participants: [{ agentId: firstAgent.id }, { agentId: secondAgent.id }],
  });

  for (let index = 0; index < 30; index += 1) {
    createMessage(harness.store, conversation.id, {
      id: `history-${String(index).padStart(2, '0')}`,
      turnId: `history-turn-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      agentId: index % 2 === 0 ? null : (index === 29 ? secondAgent.id : firstAgent.id),
      senderName: index % 2 === 0 ? 'You' : (index === 29 ? secondAgent.name : firstAgent.name),
      content: `historical message ${index}`,
      createdAt: `2026-08-25T00:00:${String(index).padStart(2, '0')}.000Z`,
    });
  }

  const executions = [];
  const orchestrator = createOrchestrator(harness, {
    async executeConversationAgent({ agent, promptMessages, completedReplies }) {
      executions.push({
        agentId: agent.id,
        promptMessages: promptMessages.map((message) => ({ id: message.id, content: message.content })),
      });
      completedReplies.push({
        id: 'bounded-routing-reply',
        agentId: agent.id,
        senderName: agent.name,
        content: 'done',
        status: 'completed',
      });
      return { stopTurn: true, terminationReason: 'agent_final' };
    },
  });

  poisonFullHydration(harness.store);

  const submitted = orchestrator.submitConversationMessage(conversation.id, {
    content: 'Continue without an explicit mention',
  });
  assert.equal(submitted.dispatch, 'started');

  await waitForCondition(() => executions.length === 1 && orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0);

  assert.equal(executions[0].agentId, secondAgent.id);
  assert.equal(executions[0].promptMessages.some((message) => message.content === 'Continue without an explicit mention'), true);
  assert.equal(executions[0].promptMessages.some((message) => message.content === 'historical message 29'), true);
  assert.equal(executions[0].promptMessages.some((message) => message.content === 'historical message 0'), false);
  assert.ok(executions[0].promptMessages.length <= 25, '24 historical rows plus the current user row');
});

test('bounded prompt union keeps an old explicit batch row and current-turn reply exactly once', { concurrency: false }, async (t) => {
  const harness = createHarness(t, 'prompt-union');
  const agent = saveAgent(harness.store, 'prompt-union-agent', 'Prompt Union Agent');
  const conversation = createConversation(harness.store, {
    id: 'prompt-union-no-hydration',
    participants: [{ agentId: agent.id }],
  });
  createMessage(harness.store, conversation.id, {
    id: 'prompt-explicit-old',
    turnId: 'prompt-explicit-old-turn',
    role: 'user',
    content: 'old explicit batch row',
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  for (let index = 1; index <= 30; index += 1) {
    createMessage(harness.store, conversation.id, {
      id: `prompt-history-${String(index).padStart(2, '0')}`,
      turnId: `prompt-history-turn-${index}`,
      role: index % 2 === 0 ? 'assistant' : 'user',
      agentId: index % 2 === 0 ? agent.id : null,
      senderName: index % 2 === 0 ? agent.name : 'You',
      content: `prompt history ${index}`,
      createdAt: `2026-08-25T00:00:${String(index).padStart(2, '0')}.000Z`,
    });
  }

  let injectedMessages = [];
  const orchestrator = createOrchestrator(harness, {
    async executeConversationAgent(input) {
      injectedMessages = input.promptMessages.map((message) => ({ id: message.id, content: message.content }));
      const reply = harness.store.createMessage({
        id: 'prompt-current-reply',
        conversationId: conversation.id,
        turnId: input.turnId,
        role: 'assistant',
        agentId: input.agent.id,
        senderName: input.agent.name,
        content: 'current turn reply',
        status: 'completed',
      });
      input.completedReplies.push(reply);
      return { stopTurn: true, terminationReason: 'agent_final' };
    },
  });
  poisonFullHydration(harness.store);

  const result = await orchestrator.runConversationTurn(conversation.id, {
    batchMessageIds: ['prompt-explicit-old'],
  });
  const promptIds = injectedMessages.map((message) => message.id);
  const finalIds = result.conversation.messages.map((message) => message.id);

  assert.equal(promptIds.filter((id) => id === 'prompt-explicit-old').length, 1);
  assert.equal(promptIds.includes('prompt-history-07'), true);
  assert.equal(promptIds.includes('prompt-history-06'), false);
  assert.equal(promptIds.length, 25, '24 ordinary history rows plus one old explicit row');
  assert.equal(finalIds.filter((id) => id === 'prompt-explicit-old').length, 1);
  assert.equal(finalIds.filter((id) => id === 'prompt-current-reply').length, 1);
  assert.equal(finalIds.length, 26, 'fixed prompt union plus one current-turn reply');
});

test('targeted default routing excludes ineligible replies and uses canonical id tie order', { concurrency: false }, (t) => {
  const harness = createHarness(t, 'routing-projection');
  const firstAgent = saveAgent(harness.store, 'projection-agent-a', 'Projection Alpha');
  const secondAgent = saveAgent(harness.store, 'projection-agent-b', 'Projection Beta');
  const removedAgent = saveAgent(harness.store, 'projection-agent-removed', 'Removed Agent');
  const conversation = createConversation(harness.store, {
    id: 'routing-projection-no-hydration',
    participants: [{ agentId: firstAgent.id }, { agentId: secondAgent.id }],
  });
  const timestamp = '2026-08-25T00:00:00.000Z';
  createMessage(harness.store, conversation.id, {
    id: 'routing-projection-a', role: 'assistant', agentId: firstAgent.id,
    senderName: firstAgent.name, content: 'eligible alpha', createdAt: timestamp,
  });
  createMessage(harness.store, conversation.id, {
    id: 'routing-projection-b', role: 'assistant', agentId: secondAgent.id,
    senderName: secondAgent.name, content: 'eligible beta wins tie', createdAt: timestamp,
  });
  createMessage(harness.store, conversation.id, {
    id: 'routing-projection-empty', role: 'assistant', agentId: secondAgent.id,
    senderName: secondAgent.name, content: '   ', createdAt: '2026-08-25T00:00:01.000Z',
  });
  createMessage(harness.store, conversation.id, {
    id: 'routing-projection-failed', role: 'assistant', agentId: secondAgent.id,
    senderName: secondAgent.name, content: 'failed', status: 'failed', createdAt: '2026-08-25T00:00:02.000Z',
  });
  createMessage(harness.store, conversation.id, {
    id: 'routing-projection-private', role: 'assistant', agentId: secondAgent.id,
    senderName: secondAgent.name, content: 'private', metadata: { privateOnly: true },
    createdAt: '2026-08-25T00:00:03.000Z',
  });
  createMessage(harness.store, conversation.id, {
    id: 'routing-projection-removed', role: 'assistant', agentId: removedAgent.id,
    senderName: removedAgent.name, content: 'removed', createdAt: '2026-08-25T00:00:04.000Z',
  });
  poisonFullHydration(harness.store);

  const latestAgentId = harness.store.findLatestPublicCompletedAssistantReplyAgentId(
    conversation.id,
    [firstAgent.id, secondAgent.id]
  );
  assert.equal(latestAgentId, secondAgent.id);
});

test('restart side dispatch rehydrates only the bounded snapshot ids', { concurrency: false }, async (t) => {
  const harness = createHarness(t, 'side-restart');
  const agent = saveAgent(harness.store, 'side-restart-agent', 'Side Restart Agent');
  const conversation = createConversation(harness.store, {
    id: 'side-restart-no-hydration',
    participants: [{ agentId: agent.id }],
  });
  for (let index = 0; index < 30; index += 1) {
    createMessage(harness.store, conversation.id, {
      id: `side-history-${String(index).padStart(2, '0')}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      agentId: index % 2 === 0 ? null : agent.id,
      senderName: index % 2 === 0 ? 'You' : agent.name,
      content: `side history ${index}`,
      createdAt: `2026-08-25T00:00:${String(index).padStart(2, '0')}.000Z`,
    });
  }
  createMessage(harness.store, conversation.id, {
    id: 'side-restart-source',
    role: 'user',
    content: '@Side Restart Agent recover this side request',
    metadata: {
      dispatchLane: 'side',
      dispatchTargetAgentId: agent.id,
    },
    createdAt: '2026-08-25T00:00:30.000Z',
  });
  createMessage(harness.store, conversation.id, {
    id: 'side-restart-late',
    role: 'system',
    senderName: 'System',
    content: 'must remain invisible to the recovered snapshot',
    createdAt: '2026-08-25T00:00:31.000Z',
  });

  let recoveredPrompt = null;
  poisonFullHydration(harness.store);
  createOrchestrator(harness, {
    async executeConversationAgent(input) {
      recoveredPrompt = input.promptMessages.map((message) => ({ id: message.id, content: message.content }));
      input.completedReplies.push({
        id: 'side-restart-reply',
        agentId: input.agent.id,
        senderName: input.agent.name,
        content: 'recovered',
        status: 'completed',
      });
      return { stopTurn: false, terminationReason: '' };
    },
  });

  await waitForCondition(() => recoveredPrompt);
  const recoveredIds = recoveredPrompt.map((message) => message.id);
  assert.equal(recoveredIds.includes('side-restart-source'), true);
  assert.equal(recoveredIds.includes('side-restart-late'), false);
  assert.equal(recoveredIds.includes('side-history-06'), true);
  assert.equal(recoveredIds.includes('side-history-05'), false);
  assert.equal(recoveredIds.length, 25, '24 history rows through the source plus the explicit side source');
});

test('private mailbox projection stays authorized, bounded, and canonical', { concurrency: false }, (t) => {
  const harness = createHarness(t, 'private-mailbox');
  const firstAgent = saveAgent(harness.store, 'private-agent-a', 'Private Alpha');
  const secondAgent = saveAgent(harness.store, 'private-agent-b', 'Private Beta');
  const conversation = createConversation(harness.store, {
    id: 'private-mailbox-no-hydration',
    participants: [{ agentId: firstAgent.id }, { agentId: secondAgent.id }],
  });
  for (let index = 0; index < 20; index += 1) {
    harness.store.createPrivateMessage({
      id: `private-visible-${String(index).padStart(2, '0')}`,
      conversationId: conversation.id,
      turnId: `private-turn-${index}`,
      senderAgentId: index % 2 === 0 ? firstAgent.id : secondAgent.id,
      senderName: index % 2 === 0 ? firstAgent.name : secondAgent.name,
      recipientAgentIds: [index % 2 === 0 ? secondAgent.id : firstAgent.id],
      content: `visible private ${index}`,
      createdAt: `2026-08-25T00:00:${String(index).padStart(2, '0')}.000Z`,
    });
  }
  harness.store.createPrivateMessage({
    id: 'private-hidden',
    conversationId: conversation.id,
    turnId: 'private-hidden-turn',
    senderAgentId: secondAgent.id,
    senderName: secondAgent.name,
    recipientAgentIds: [secondAgent.id],
    content: 'not visible to alpha',
    createdAt: '2026-08-25T00:00:30.000Z',
  });
  poisonFullHydration(harness.store);

  const visible = harness.store.listPrivateMessagesForAgent(conversation.id, firstAgent.id, { limit: 16 });
  assert.equal(visible.length, 16);
  assert.equal(visible.some((message) => message.id === 'private-hidden'), false);
  assert.deepEqual(
    visible.map((message) => message.id),
    Array.from({ length: 16 }, (_, offset) => `private-visible-${String(offset + 4).padStart(2, '0')}`)
  );
});

test('Goal actions use header-only reads and writes outside auto continuation', { concurrency: false }, (t) => {
  const harness = createHarness(t, 'goal-action');
  const agent = saveAgent(harness.store, 'goal-action-agent', 'Goal Action Agent');
  const conversation = createConversation(harness.store, {
    id: 'goal-action-no-hydration',
    participants: [{ agentId: agent.id }],
    metadata: {
      sessionGoal: {
        objective: 'Pause without hydrating history',
        status: 'active',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
    },
  });
  createMessage(harness.store, conversation.id, {
    id: 'goal-action-history', role: 'user', content: 'large history sentinel',
    createdAt: '2026-08-25T00:00:01.000Z',
  });
  poisonFullHydration(harness.store);

  const result = applySessionGoalAction(harness.store, conversation.id, { action: 'pause' });
  assert.equal(result.goal.status, 'paused');
  assert.deepEqual(result.conversation.messages, []);
});

test('production stores fail closed when a required bounded projection is missing', { concurrency: false }, async (t) => {
  const harness = createHarness(t, 'fail-closed');
  const agent = saveAgent(harness.store, 'fail-closed-agent', 'Fail Closed Agent');
  const conversation = createConversation(harness.store, {
    id: 'fail-closed-no-hydration',
    participants: [{ agentId: agent.id }],
  });
  createMessage(harness.store, conversation.id, {
    id: 'fail-closed-user', role: 'user', content: 'must remain bounded',
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  delete harness.store.boundedConversationProjections;
  const orchestrator = createOrchestrator(harness);
  poisonFullHydration(harness.store);
  harness.store.listPendingMainUserMessages = undefined;

  assert.throws(
    () => orchestrator.getConversationQueueDepth(conversation.id),
    (error) => error && error.statusCode === 501 && /listPendingMainUserMessages/.test(error.message)
  );

  harness.store.listPendingMainUserMessages = ChatAppStorePrototypeMethod(harness.store, 'listPendingMainUserMessages');
  harness.store.listPromptMessages = undefined;
  await assert.rejects(
    orchestrator.runConversationTurn(conversation.id, { batchMessageIds: ['fail-closed-user'] }),
    (error) => error && error.statusCode === 501 && /listPromptMessages/.test(error.message)
  );
  harness.store.listPromptMessages = ChatAppStorePrototypeMethod(harness.store, 'listPromptMessages');
  await new Promise((resolve) => setTimeout(resolve, 50));
});

function ChatAppStorePrototypeMethod(store, name) {
  let prototype = Object.getPrototypeOf(store);
  while (prototype && typeof prototype[name] !== 'function') {
    prototype = Object.getPrototypeOf(prototype);
  }
  return prototype ? prototype[name].bind(store) : undefined;
}

test('deletion cursor reconciliation uses the previous user projection without full hydration', { concurrency: false }, (t) => {
  const harness = createHarness(t, 'deletion-cursor');
  const agent = saveAgent(harness.store, 'cursor-agent', 'Cursor Agent');
  const conversation = createConversation(harness.store, {
    id: 'cursor-no-hydration',
    participants: [{ agentId: agent.id }],
    metadata: {
      conversationTurnQueue: {
        lastConsumedUserMessageId: 'cursor-user-latest',
      },
    },
  });
  createMessage(harness.store, conversation.id, {
    id: 'cursor-user-old',
    role: 'user',
    content: 'old user',
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  createMessage(harness.store, conversation.id, {
    id: 'cursor-assistant-old',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'old reply',
    createdAt: '2026-08-25T00:00:01.000Z',
  });
  createMessage(harness.store, conversation.id, {
    id: 'cursor-user-latest',
    role: 'user',
    content: 'latest user',
    createdAt: '2026-08-25T00:00:02.000Z',
  });
  createMessage(harness.store, conversation.id, {
    id: 'cursor-assistant-latest',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'latest reply',
    createdAt: '2026-08-25T00:00:03.000Z',
  });

  const orchestrator = createOrchestrator(harness);
  assert.equal(orchestrator.getConversationQueueDepth(conversation.id), 0);

  harness.store.db.prepare('DELETE FROM chat_messages WHERE id = ?').run('cursor-user-latest');
  poisonFullHydration(harness.store);

  orchestrator.reconcileConversationQueueAfterMessageDeletion(conversation.id, [{
    id: 'cursor-user-latest',
    role: 'user',
    createdAt: '2026-08-25T00:00:02.000Z',
  }]);

  const header = readHeader(harness.store, conversation.id);
  assert.equal(header.metadata.conversationTurnQueue.lastConsumedUserMessageId, 'cursor-user-old');
  assert.equal(orchestrator.getConversationQueueDepth(conversation.id), 0);
});
