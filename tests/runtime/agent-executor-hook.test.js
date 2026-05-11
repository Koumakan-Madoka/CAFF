const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { withTempDir } = require('../helpers/temp-dir');

function createRunHandle(reply) {
  const handle = new EventEmitter();
  handle.runId = 'run-hook-await';
  handle.sessionPath = '';
  handle.resultPromise = Promise.resolve({
    reply,
    runId: handle.runId,
    usage: null,
    heartbeatCount: 0,
    sessionPath: '',
  });
  return handle;
}

function createFakeStore(conversation) {
  let nextMessageIndex = 1;
  const messages = [];
  conversation.messages = messages;

  return {
    createMessage(input) {
      const message = {
        id: input.id || `message-${nextMessageIndex++}`,
        createdAt: new Date().toISOString(),
        ...input,
      };
      messages.push(message);
      return message;
    },
    updateMessage(messageId, patch) {
      const message = messages.find((item) => item.id === messageId);
      assert.ok(message, `message ${messageId} should exist`);
      Object.assign(message, patch);
      return { ...message };
    },
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    updateConversation(conversationId, patch) {
      assert.equal(conversationId, conversation.id);
      Object.assign(conversation, patch);
      return conversation;
    },
    listMessages(conversationId) {
      return conversationId === conversation.id ? messages.slice() : [];
    },
    listPrivateMessagesForAgent() {
      return [];
    },
    listVisibleMemoryCards() {
      return [];
    },
  };
}

function createFakeRunStore() {
  return {
    createTask() {},
    updateTask() {},
    appendTaskEvent() {},
    addArtifact() {},
  };
}

function createFakeAgentToolBridge() {
  return {
    createInvocationContext(input) {
      return input;
    },
    registerInvocation(context) {
      return {
        ...context,
        invocationId: 'invocation-hook-await',
        callbackToken: 'callback-hook-await',
        publicToolUsed: false,
        publicPostCount: 0,
        privatePostCount: 0,
        privateHandoffCount: 0,
        lastPublicContent: '',
      };
    },
    unregisterInvocation() {},
  };
}

test('agent executor does not auto-inject long-term memory by default', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-no-auto-memory-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  let capturedPrompt = '';

  minimalPi.startRun = (_provider, _model, prompt) => {
    capturedPrompt = String(prompt || '');
    return createRunHandle('Done.');
  };
  delete require.cache[agentExecutorPath];

  t.after(() => {
    minimalPi.startRun = originalStartRun;
    delete require.cache[agentExecutorPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createAgentExecutor } = require(agentExecutorPath);
  const { createTurnState } = require(turnStatePath);
  const agent = {
    id: 'agent-no-auto-memory',
    name: 'No Auto Memory',
    description: 'Tests prompt memory defaults.',
    personaPrompt: 'Be brief.',
  };
  const conversation = {
    id: 'conversation-no-auto-memory',
    title: 'Long-Term Memory Review',
    type: 'standard',
    agents: [agent],
    metadata: {
      sessionGoal: {
        objective: 'Review whether long-term memory should be auto-injected.',
      },
    },
  };
  const store = createFakeStore(conversation);
  let searchCallCount = 0;
  store.searchSummarySegments = () => {
    searchCallCount += 1;
    throw new Error('automatic summary memory search should stay disabled by default');
  };
  const executor = createAgentExecutor({
    store,
    skillRegistry: { resolveSkills: () => [] },
    modeStore: { get: () => null },
    agentToolBridge: createFakeAgentToolBridge(),
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'chat.sqlite'),
    toolBaseUrl: 'http://127.0.0.1:3100',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });
  const turnState = createTurnState(conversation, 'turn-no-auto-memory');

  await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-no-auto-memory',
    conversation,
    promptMessages: [{ role: 'user', content: 'Why did retrieved long-term memory appear here?' }],
    promptUserMessage: { id: 'user-message-no-auto-memory', role: 'user', content: 'hello' },
    queueItem: { triggerType: 'user', enqueueReason: 'user_mentions' },
    agent,
    turnState,
    completedReplies: [],
    failedReplies: [],
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 1,
    enqueueAgent() {},
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: tempDir,
  });

  assert.equal(searchCallCount, 0);
  assert.doesNotMatch(capturedPrompt, /Retrieved Long-Term Memory|Retrieved long-term experience memory/u);
  assert.match(capturedPrompt, /Do not assume long-term memory is automatically injected/u);
  assert.match(capturedPrompt, /上次.*之前.*还记得吗.*回忆一下/u);
});

test('assistant completion hook broadcasts final message before blocking routing', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-hook-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;

  minimalPi.startRun = () => createRunHandle('Done. @Next');
  delete require.cache[agentExecutorPath];

  t.after(() => {
    minimalPi.startRun = originalStartRun;
    delete require.cache[agentExecutorPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createAgentExecutor } = require(agentExecutorPath);
  const { createTurnState } = require(turnStatePath);

  const agent = {
    id: 'agent-hook-await',
    name: 'Hook Awaiter',
    description: 'Tests completion hooks.',
    personaPrompt: 'Be brief.',
  };
  const nextAgent = {
    id: 'agent-hook-next',
    name: 'Next',
    description: 'Receives routed handoffs after the hook.',
    personaPrompt: 'Be brief.',
  };
  const conversation = {
    id: 'conversation-hook-await',
    title: 'Hook Await Conversation',
    type: 'standard',
    agents: [agent, nextAgent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
  const events = [];
  const turnProgresses = [];
  const executor = createAgentExecutor({
    store,
    skillRegistry: { resolveSkills: () => [] },
    modeStore: { get: () => null },
    agentToolBridge: createFakeAgentToolBridge(),
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'chat.sqlite'),
    toolBaseUrl: 'http://127.0.0.1:3100',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    agentToolRelativePath: './lib/agent-chat-tools.js',
    broadcastEvent(eventName, payload) {
      if (eventName === 'conversation_message_updated') {
        events.push(`broadcast:${payload.message.status}`);
      }
    },
    broadcastConversationSummary() {},
    emitTurnProgress(turn) {
      turnProgresses.push(JSON.parse(JSON.stringify(turn)));
    },
    async onAssistantMessageCompleted() {
      events.push('hook:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('hook:end');
    },
  });
  const turnState = createTurnState(conversation, 'turn-hook-await');

  const result = await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-hook-await',
    conversation,
    promptMessages: [],
    promptUserMessage: { id: 'user-message-hook-await', role: 'user', content: 'hello' },
    queueItem: { triggerType: 'user', enqueueReason: 'user_mentions' },
    agent,
    turnState,
    completedReplies: [],
    failedReplies: [],
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 1,
    enqueueAgent(input) {
      events.push(`enqueue:${Array.isArray(input && input.agentIds) ? input.agentIds.join(',') : ''}`);
      return input.agentIds;
    },
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: tempDir,
  });

  assert.equal(result.stopTurn, false);
  assert.deepEqual(events, ['broadcast:streaming', 'broadcast:completed', 'hook:start', 'hook:end', 'enqueue:agent-hook-next']);
  assert.ok(
    turnProgresses.some((turn) => {
      const stage = Array.isArray(turn && turn.agents) ? turn.agents[0] : null;
      return stage && stage.status === 'completed' && stage.finalContent === 'Done. @Next';
    }),
    'completed turn progress should carry full final content while the hook is blocking routing'
  );
});
