const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createTurnOrchestrator,
} = require('../../build/server/domain/conversation/turn-orchestrator');
const {
  applySessionGoalAction,
  claimSessionGoalAutoContinue,
  getSessionGoal,
  pauseSessionGoalOnUserStop,
} = require('../../build/server/domain/conversation/session-goal');
const { withTempDir } = require('../helpers/temp-dir');

function waitForCondition(check, timeoutMs = 5000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      let passed = false;

      try {
        passed = Boolean(check());
      } catch (error) {
        reject(error);
        return;
      }

      if (passed) {
        resolve();
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }

      setTimeout(poll, 10);
    };

    poll();
  });
}

function createGate() {
  let resolveGate = null;
  let rejectGate = null;
  const promise = new Promise((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });

  return {
    promise,
    resolve: resolveGate,
    reject: rejectGate,
  };
}

function activeGoal(overrides = {}) {
  return {
    goalId: 'goal-stop-linkage',
    objective: 'Keep iterating until told to stop',
    status: 'active',
    revision: 1,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    owner: { agentId: 'agent-owner', agentName: 'Owner' },
    workItems: [],
    acceptanceCriteria: [],
    evidence: [],
    ...overrides,
  };
}

function createGoalConversation(overrides = {}) {
  return {
    id: 'conversation-stop-linkage',
    title: 'Stop linkage',
    type: 'standard',
    agents: [
      { id: 'agent-owner', name: 'Owner' },
      { id: 'agent-other', name: 'Other' },
    ],
    messages: [],
    metadata: {
      sessionGoal: activeGoal(),
      ...(overrides.metadata || {}),
    },
    ...overrides,
  };
}

function createStubStore(conversation) {
  let messageCounter = 0;

  return {
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      return [{
        id: conversation.id,
        title: conversation.title,
        type: conversation.type,
        metadata: conversation.metadata,
        createdAt: '2026-08-21T00:00:00.000Z',
        updatedAt: lastMessage ? lastMessage.createdAt : '2026-08-21T00:00:00.000Z',
        lastMessageAt: lastMessage ? lastMessage.createdAt : null,
        messageCount: conversation.messages.length,
        agentCount: conversation.agents.length,
        lastMessagePreview: lastMessage ? lastMessage.content : '',
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
        createdAt: input.createdAt || `2026-08-21T00:00:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
    getMessage(messageId) {
      return conversation.messages.find((message) => message && message.id === messageId) || null;
    },
    updateMessage(messageId, updates) {
      const index = conversation.messages.findIndex((message) => message && message.id === messageId);

      if (index < 0) {
        return null;
      }

      conversation.messages[index] = { ...conversation.messages[index], ...updates };
      return conversation.messages[index];
    },
    updateConversation(conversationId, updates) {
      assert.equal(conversationId, conversation.id);

      if (updates && updates.metadata && typeof updates.metadata === 'object') {
        conversation.metadata = updates.metadata;
      }

      return conversation;
    },
  };
}

function createOrchestratorHarness(t, conversation, executeConversationAgent) {
  const tempDir = withTempDir('caff-stop-linkage-');
  const sqlitePath = path.join(tempDir, 'stop-linkage.sqlite');
  const store = createStubStore(conversation);

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

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
    executeConversationAgent,
    broadcastEvent() {},
  });

  return { orchestrator, store };
}

test('pauseSessionGoalOnUserStop pauses an active goal without touching proposals or runner', () => {
  const conversation = createGoalConversation();
  conversation.metadata.sessionGoalProposal = {
    id: 'proposal-1',
    action: 'revise',
    status: 'pending',
    reason: 'keep me',
    proposedBy: { agentId: 'agent-other', agentName: 'Other' },
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
  conversation.metadata.sessionGoalRunner = {
    status: 'running',
    goalUpdatedAt: conversation.metadata.sessionGoal.updatedAt,
    iteration: 2,
    maxIterations: 40,
    updatedAt: '2026-08-21T00:01:00.000Z',
  };
  const store = createStubStore(conversation);

  const result = pauseSessionGoalOnUserStop(store, conversation.id, { reason: 'stopped_by_user' });

  assert.equal(result.changed, true);
  assert.equal(result.paused, true);
  assert.equal(result.goal.status, 'paused');
  assert.equal(result.goal.revision, 2);
  assert.equal(getSessionGoal(conversation).status, 'paused');
  // Silent pause: pending proposal and runner are preserved untouched.
  assert.equal(conversation.metadata.sessionGoalProposal.id, 'proposal-1');
  assert.equal(conversation.metadata.sessionGoalRunner.iteration, 2);

  const claim = claimSessionGoalAutoContinue(store, conversation.id, { maxIterations: 40 });
  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, 'inactive_goal');
});

test('a stop-paused goal resumes via the existing resume action and can be claimed again', () => {
  const conversation = createGoalConversation();
  const store = createStubStore(conversation);

  const paused = pauseSessionGoalOnUserStop(store, conversation.id, { reason: 'stopped_by_user' });
  assert.equal(paused.paused, true);
  assert.equal(
    claimSessionGoalAutoContinue(store, conversation.id, { maxIterations: 40 }).claimed,
    false
  );

  // 复用现有 resume action（goal 面板恢复入口走的就是这条路）。
  const resumed = applySessionGoalAction(store, conversation.id, { action: 'resume' });
  assert.equal(resumed.goal.status, 'active');

  const claim = claimSessionGoalAutoContinue(store, conversation.id, { maxIterations: 40 });
  assert.equal(claim.claimed, true);
  assert.equal(claim.runner.iteration, 1);
});

test('pauseSessionGoalOnUserStop is a no-op for paused or missing goals', () => {
  const pausedConversation = createGoalConversation();
  pausedConversation.metadata.sessionGoal = activeGoal({ status: 'paused' });
  const pausedStore = createStubStore(pausedConversation);

  const pausedResult = pauseSessionGoalOnUserStop(pausedStore, pausedConversation.id, {});
  assert.equal(pausedResult.changed, false);
  assert.equal(pausedResult.goal.status, 'paused');

  const emptyConversation = createGoalConversation();
  delete emptyConversation.metadata.sessionGoal;
  const emptyStore = createStubStore(emptyConversation);

  const emptyResult = pauseSessionGoalOnUserStop(emptyStore, emptyConversation.id, {});
  assert.equal(emptyResult.changed, false);
  assert.equal(emptyResult.goal, null);
});

test('conversation stop with stopGoal pauses the active goal; legacy callers keep the goal running', async (t) => {
  const conversation = createGoalConversation();
  const gates = [];
  const { orchestrator, store } = createOrchestratorHarness(t, conversation, async ({ turnState, agent }) => {
    const gate = createGate();
    const handle = {
      turnStageAgentId: agent.id,
      cancel() {
        gate.resolve();
      },
    };
    turnState.runHandles.add(handle);
    await gate.promise;
    return { stopTurn: true, terminationReason: 'stopped_by_user' };
  });

  const turnPromise = orchestrator.runConversationTurn(conversation.id, {
    role: 'user',
    senderName: 'Goal Runner',
    content: 'continue the goal',
    metadata: { source: 'goal-runner', goalAutoContinue: true },
    initialAgentIds: ['agent-owner'],
  });
  void turnPromise.catch(() => {});

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 1);

  // Legacy compatibility: without stopGoal the goal must stay active.
  const legacyResult = orchestrator.requestStopConversationExecution(conversation.id, 'stop without goal pause');
  assert.equal(legacyResult.goal, null);
  assert.equal(getSessionGoal(conversation).status, 'active');

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0);

  // Re-arm a second turn, then stop with stopGoal: the goal is paused
  // synchronously when the stop request is accepted.
  const secondTurnPromise = orchestrator.runConversationTurn(conversation.id, {
    role: 'user',
    senderName: 'Goal Runner',
    content: 'continue the goal again',
    metadata: { source: 'goal-runner', goalAutoContinue: true },
    initialAgentIds: ['agent-owner'],
  });
  void secondTurnPromise.catch(() => {});

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 1);

  const stopResult = orchestrator.requestStopConversationExecution(conversation.id, 'stop everything', { stopGoal: true });
  assert.equal(stopResult.goal && stopResult.goal.status, 'paused');
  assert.equal(getSessionGoal(conversation).status, 'paused');

  const claim = claimSessionGoalAutoContinue(store, conversation.id, { maxIterations: 40 });
  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, 'inactive_goal');

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0);
});

test('stopping the goal owner stage of a goal-runner turn pauses the goal; non-owner stages do not', async (t) => {
  const conversation = createGoalConversation();
  const gates = new Map();
  const cancelCalls = [];
  const { orchestrator } = createOrchestratorHarness(t, conversation, async ({ turnState, agent }) => {
    const stage = turnState.agents.find((item) => item.agentId === agent.id);
    if (stage) {
      stage.status = 'running';
    }
    const gate = createGate();
    gates.set(agent.id, gate);
    const handle = {
      turnStageAgentId: agent.id,
      cancel() {
        cancelCalls.push(agent.id);
        gate.resolve();
      },
    };
    turnState.runHandles.add(handle);
    await gate.promise;
    return { stopTurn: false, terminationReason: '' };
  });

  const turnPromise = orchestrator.runConversationTurn(conversation.id, {
    role: 'user',
    senderName: 'Goal Runner',
    content: 'continue the goal',
    metadata: { source: 'goal-runner', goalAutoContinue: true },
    initialAgentIds: ['agent-owner', 'agent-other'],
    executionMode: 'parallel',
  });
  void turnPromise.catch(() => {});

  await waitForCondition(() => gates.has('agent-owner') && gates.has('agent-other'));

  // Non-owner stage first: goal must stay active, and only that stage's
  // handle is cancelled.
  const nonOwnerStop = orchestrator.requestStopConversationTrace(conversation.id, {
    kind: 'stage',
    agentId: 'agent-other',
  });
  assert.equal(nonOwnerStop.goal, null);
  assert.equal(getSessionGoal(conversation).status, 'active');
  assert.deepEqual(cancelCalls, ['agent-other']);

  const ownerTurnStillActive = orchestrator.listTurnSummaries({ conversationId: conversation.id });
  assert.equal(ownerTurnStillActive.length, 1);

  // Owner stage of a goal-runner turn: stop-acceptance pauses the goal
  // synchronously (no race window for the next goal-runner claim).
  const ownerStop = orchestrator.requestStopConversationTrace(conversation.id, {
    kind: 'stage',
    agentId: 'agent-owner',
  });
  assert.equal(ownerStop.goal && ownerStop.goal.status, 'paused');
  assert.equal(getSessionGoal(conversation).status, 'paused');
  assert.deepEqual(cancelCalls, ['agent-other', 'agent-owner']);

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0);
});

test('stopping a non-goal side slot or cancelling a queued side dispatch leaves the goal active', async (t) => {
  const conversation = createGoalConversation();
  const gates = new Map();
  const { orchestrator } = createOrchestratorHarness(t, conversation, async ({ turnState, agent }) => {
    const stage = turnState.agents.find((item) => item.agentId === agent.id);
    if (stage) {
      stage.status = 'running';
    }
    const gate = createGate();
    gates.set(`${turnState.executionLane || 'main'}:${agent.id}`, gate);
    turnState.runHandles.add({
      turnStageAgentId: agent.id,
      cancel() {
        gate.resolve();
      },
    });
    await gate.promise;
    return { stopTurn: false, terminationReason: '' };
  });

  const firstResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Owner 主任务' });
  assert.equal(firstResult.dispatch, 'started');

  await waitForCondition(() => gates.has('main:agent-owner'));

  // Side dispatch to the OTHER agent runs in parallel as a slot.
  const sideResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Other 旁路问题' });
  assert.equal(sideResult.dispatchLane, 'side');

  await waitForCondition(() => gates.has('side:agent-other'));

  const slots = orchestrator.listAgentSlotSummaries({ conversationId: conversation.id });
  assert.equal(slots.length, 1);

  const slotStop = orchestrator.requestStopConversationTrace(conversation.id, {
    kind: 'slot',
    slotId: slots[0].slotId,
  });
  assert.equal(slotStop.agentSlot.stopRequested, true);
  assert.equal(slotStop.goal, null);
  assert.equal(getSessionGoal(conversation).status, 'active');

  // Side dispatch to the OWNER while the owner slot is busy: it queues, and
  // cancelling the queue entry must not touch the goal either (GLM review:
  // side-@owner 的无关回答被停不动 goal).
  const queuedResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Owner 插队问题' });
  assert.equal(queuedResult.dispatchLane, 'side');

  await waitForCondition(() => {
    const depths = orchestrator.buildRuntimePayload().agentSlotQueueDepths;
    return Boolean(depths && depths[conversation.id] && depths[conversation.id]['agent-owner'] > 0);
  });

  const cancelQueued = orchestrator.requestStopConversationTrace(conversation.id, {
    kind: 'queued-side',
    agentId: 'agent-owner',
  });
  assert.equal(cancelQueued.cancelledQueuedSideDispatch, true);
  assert.equal(cancelQueued.goal, null);
  assert.equal(getSessionGoal(conversation).status, 'active');

  const cancelledSource = conversation.messages.find((message) => message.id === queuedResult.acceptedMessage.id);
  assert.equal(cancelledSource.metadata.dispatchCancelled, true);

  // Release the remaining executions so the test exits cleanly. stopGoal
  // pauses the goal; otherwise the drain loop immediately claims the next
  // goal-runner iteration and the stub would block forever.
  orchestrator.requestStopConversationExecution(conversation.id, 'test cleanup', { stopGoal: true });
  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0);
  await waitForCondition(() => orchestrator.listAgentSlotSummaries({ conversationId: conversation.id }).length === 0);
});
