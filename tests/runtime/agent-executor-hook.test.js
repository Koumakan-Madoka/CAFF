const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { withTempDir } = require('../helpers/temp-dir');

function createRunHandle(reply, resultOverrides = {}) {
  const handle = new EventEmitter();
  handle.runId = 'run-hook-await';
  handle.sessionPath = '';
  handle.resultPromise = Promise.resolve({
    reply,
    runId: handle.runId,
    usage: null,
    heartbeatCount: 0,
    sessionPath: '',
    ...resultOverrides,
  });
  return handle;
}

function createObservableRunHandle(runIndex = 1) {
  const handle = new EventEmitter();
  handle.runId = `run-observability-live-${runIndex}`;
  handle.sessionPath = '';
  const usageCall = {
    key: `live-call-${runIndex}`,
    responseId: `live-response-${runIndex}`,
    stopReason: 'toolUse',
    timestamp: 101,
    usage: { input: 120, output: 30, cacheRead: 0, totalTokens: 150 },
  };
  handle.resultPromise = new Promise((resolve) => {
    setImmediate(() => {
      handle.emit('assistant_message', {
        messageKey: usageCall.key,
        message: {
          role: 'assistant',
          responseId: usageCall.responseId,
          stopReason: usageCall.stopReason,
          timestamp: usageCall.timestamp,
          usage: usageCall.usage,
          content: [
            { type: 'thinking', thinking: 'hidden-live-reasoning' },
            { type: 'text', text: 'visible but not part of observability SSE' },
          ],
        },
        text: 'visible but not part of observability SSE',
      });
      setImmediate(() => resolve({
        reply: 'Done.',
        runId: handle.runId,
        usage: usageCall.usage,
        usageCalls: [usageCall],
        heartbeatCount: 0,
        sessionPath: '',
        assistantErrors: [],
      }));
    });
  });
  return handle;
}

function createRecoveryRunHandle(reply) {
  const handle = new EventEmitter();
  handle.runId = 'run-recovery';
  handle.sessionPath = '';
  handle.resultPromise = new Promise((resolve) => {
    setTimeout(() => resolve({
      reply,
      runId: handle.runId,
      usage: null,
      heartbeatCount: 0,
      sessionPath: '',
    }), 20);
  });
  setTimeout(() => {
    handle.emit('run_recovering', {
      reason: { type: 'progress_timeout', message: 'tool stalled' },
      attempt: 1,
      toolName: 'bash',
    });
    handle.emit('run_recovery_started', {
      reason: { type: 'progress_timeout', message: 'tool stalled' },
      attempt: 1,
      toolName: 'bash',
    });
  }, 0);
  return handle;
}

function createFailedRunHandle(error) {
  const handle = new EventEmitter();
  handle.runId = 'run-structured-failure';
  handle.sessionPath = '';
  handle.resultPromise = Promise.reject(error);
  return handle;
}

function createUserCancelledRunHandle() {
  const handle = new EventEmitter();
  handle.runId = 'run-user-cancelled';
  handle.sessionPath = '';
  handle.resultPromise = new Promise((_resolve, reject) => {
    handle.cancel = (reason) => {
      const error = new Error(String(reason || 'Stopped by user'));
      error.runId = handle.runId;
      error.terminationReason = {
        type: 'cancelled',
        message: String(reason || 'Stopped by user'),
      };
      reject(error);
    };
  });
  return handle;
}

function createCompletableRunHandle() {
  const handle = new EventEmitter();
  handle.runId = 'run-bridge-auto-final';
  handle.sessionPath = '';
  handle.completeCalled = false;
  handle.completeReason = '';
  handle.resultPromise = new Promise((resolve) => {
    handle.complete = (reason) => {
      handle.completeCalled = true;
      handle.completeReason = String(reason || '').trim();
      resolve({
        reply: '',
        runId: handle.runId,
        usage: null,
        heartbeatCount: 0,
        sessionPath: '',
      });
      return handle;
    };
  });
  return handle;
}

function createFakeStore(conversation) {
  let nextMessageIndex = 1;
  const messages = [];
  conversation.messages = messages;
  const integrityWrites = [];
  const messageWrites = { creates: [], updates: [] };

  return {
    integrityWrites,
    messageWrites,
    createMessage(input) {
      messageWrites.creates.push(input);
      const message = {
        id: input.id || `message-${nextMessageIndex++}`,
        createdAt: new Date().toISOString(),
        ...input,
      };
      messages.push(message);
      return message;
    },
    updateMessage(messageId, patch) {
      messageWrites.updates.push({ messageId, patch });
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
    getMessage(messageId) {
      return messages.find((item) => item.id === messageId) || null;
    },
    markImageUploadIntegrityFailure(imageId, integrityError) {
      integrityWrites.push({ imageId, integrityError });
      return 1;
    },
    listImageUploadsByIds(imageIds) {
      return (Array.isArray(imageIds) ? imageIds : []).map((imageId) => ({
        imageId,
        batchId: 'batch-1',
        mimeType: 'image/png',
      }));
    },
  };
}

function createFakeRunStore(events = []) {
  return {
    createTask() {},
    updateTask() {},
    appendTaskEvent(_taskId, eventName, payload) {
      events.push({ eventName, payload });
    },
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

test('agent executor persists structured provider failure metadata on failed replies', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-structured-failure-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  const invocationError = new Error('model invocation failed');
  invocationError.assistantErrors = ['insufficient balance'];
  invocationError.assistantErrorHistory = Array.from({ length: 4 }, () => 'insufficient balance');
  invocationError.usageCalls = Array.from({ length: 4 }, (_, index) => ({
    key: `failed-call-${index + 1}`,
    responseId: `failed-response-${index + 1}`,
    usage: { input: index + 1, output: 1, totalTokens: index + 2 },
  }));
  let nextRunHandle = createFailedRunHandle(invocationError);

  minimalPi.startRun = () => nextRunHandle;
  delete require.cache[agentExecutorPath];

  t.after(() => {
    minimalPi.startRun = originalStartRun;
    delete require.cache[agentExecutorPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createAgentExecutor } = require(agentExecutorPath);
  const { createTurnState } = require(turnStatePath);
  const agent = {
    id: 'agent-structured-failure',
    name: 'Structured Failure',
    description: 'Tests provider failure projection.',
    personaPrompt: 'Be brief.',
  };
  const conversation = {
    id: 'conversation-structured-failure',
    title: 'Structured failure',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
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
  const turnState = createTurnState(conversation, 'turn-structured-failure');
  const failedReplies = [];

  await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-structured-failure',
    conversation,
    promptMessages: [{ role: 'user', content: 'Continue the Goal.' }],
    promptUserMessage: { id: 'goal-user-message', role: 'user', content: 'Continue the Goal.' },
    queueItem: { triggerType: 'user', enqueueReason: 'goal_runner' },
    agent,
    turnState,
    completedReplies: [],
    failedReplies,
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 1,
    enqueueAgent() {},
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: tempDir,
  });

  assert.equal(failedReplies.length, 1);
  assert.deepEqual(failedReplies[0].metadata.invocationFailure, {
    kind: 'provider',
    code: 'assistant_error',
    eligible: true,
    terminationType: '',
    summary: 'insufficient balance',
  });
  const failedWrite = store.messageWrites.updates.find(({ patch }) => patch.status === 'failed');
  assert.ok(failedWrite);
  assert.ok(Array.isArray(failedWrite.patch.contextSnapshot.sections));
  assert.equal(Object.hasOwn(failedWrite.patch.metadata.agentContextSnapshot, 'sections'), false);
  assert.equal(JSON.stringify(failedWrite.patch.metadata).includes('displayContent'), false);
  assert.equal(failedWrite.patch.modelUsage.calls.length, 4);
  assert.equal(Object.hasOwn(failedWrite.patch.metadata, 'modelUsage'), true);
  assert.equal(failedWrite.patch.metadata.modelUsage.modelCallCount, 4);
  assert.equal(Object.hasOwn(failedWrite.patch.metadata.modelUsage, 'calls'), false);

  nextRunHandle = createRunHandle('', {
    assistantErrors: ['402: insufficient quota'],
    completionStopReason: 'error',
  });
  const resolvedFailureTurnState = createTurnState(conversation, 'turn-resolved-structured-failure');
  const resolvedFailureReplies = [];

  await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: resolvedFailureTurnState.turnId,
    rootTaskId: 'root-task-resolved-structured-failure',
    conversation,
    promptMessages: [{ role: 'user', content: 'Continue the Goal again.' }],
    promptUserMessage: { id: 'goal-user-message-2', role: 'user', content: 'Continue the Goal again.' },
    queueItem: { triggerType: 'user', enqueueReason: 'goal_runner' },
    agent,
    turnState: resolvedFailureTurnState,
    completedReplies: [],
    failedReplies: resolvedFailureReplies,
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 1,
    enqueueAgent() {},
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: tempDir,
  });

  assert.equal(resolvedFailureReplies.length, 1);
  assert.deepEqual(resolvedFailureReplies[0].metadata.invocationFailure, {
    kind: 'provider',
    code: 'assistant_error',
    eligible: true,
    terminationType: '',
    summary: '402: insufficient quota',
  });
});

test('agent executor persists the structured message and task evidence for a user stop', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-user-stop-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const turnStopPath = require.resolve('../../build/server/domain/conversation/turn/turn-stop');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  const handle = createUserCancelledRunHandle();

  minimalPi.startRun = () => handle;
  delete require.cache[agentExecutorPath];

  t.after(() => {
    minimalPi.startRun = originalStartRun;
    delete require.cache[agentExecutorPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createAgentExecutor } = require(agentExecutorPath);
  const { createTurnState } = require(turnStatePath);
  const { createTurnStopper } = require(turnStopPath);
  const agent = {
    id: 'agent-user-stop',
    name: 'User Stop',
    description: 'Tests user-stop evidence.',
    personaPrompt: 'Be brief.',
  };
  const conversation = {
    id: 'conversation-user-stop',
    title: 'User stop',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
  const taskUpdates = [];
  const runStore = {
    ...createFakeRunStore(),
    updateTask(taskId, updates) {
      taskUpdates.push({ taskId, updates });
    },
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
  const turnState = createTurnState(conversation, 'turn-user-stop');
  const stopTurn = createTurnStopper({
    activeTurns: new Map([[conversation.id, turnState]]),
  });

  const execution = executor.executeConversationAgent({
    runStore,
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-user-stop',
    conversation,
    promptMessages: [{ role: 'user', content: 'Start work, then stop.' }],
    promptUserMessage: { id: 'user-message-stop', role: 'user', content: 'Start work, then stop.' },
    queueItem: { triggerType: 'user', enqueueReason: 'user_mentions' },
    agent,
    turnState,
    completedReplies: [],
    failedReplies: [],
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 0,
    enqueueAgent() {},
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: tempDir,
  });

  await new Promise((resolve) => setImmediate(resolve));
  stopTurn(conversation.id, 'Stopped by user');
  const result = await execution;

  assert.equal(result.stopTurn, true);
  assert.equal(result.terminationReason, 'stopped_by_user');
  const failedMessage = store.messageWrites.updates.find(({ patch }) => patch.status === 'failed');
  assert.ok(failedMessage);
  assert.equal(failedMessage.patch.metadata.cancelled, true);
  assert.deepEqual(failedMessage.patch.metadata.invocationFailure, {
    kind: 'cancelled',
    code: 'cancelled',
    eligible: false,
    terminationType: 'cancelled',
    summary: 'Stopped by user',
  });
  const terminalTask = taskUpdates.find(({ updates }) => updates.status === 'cancelled');
  assert.ok(terminalTask);
  assert.equal(terminalTask.updates.runId, 'run-user-cancelled');
});

test('agent executor keeps the stage running while a stuck tool is recovered', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-tool-recovery-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  const progressSnapshots = [];
  const taskEvents = [];
  let capturedOptions = null;

  minimalPi.startRun = (_provider, _model, _prompt, options) => {
    capturedOptions = options;
    return createRecoveryRunHandle('Recovered.');
  };
  delete require.cache[agentExecutorPath];

  t.after(() => {
    minimalPi.startRun = originalStartRun;
    delete require.cache[agentExecutorPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createAgentExecutor } = require(agentExecutorPath);
  const { createTurnState } = require(turnStatePath);
  const agent = { id: 'agent-recovery', name: 'Recovery', description: 'Tests recovery.', personaPrompt: 'Be brief.' };
  const conversation = {
    id: 'conversation-recovery',
    title: 'Tool Recovery',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
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
    emitTurnProgress(turnState) {
      progressSnapshots.push({
        status: turnState.agents[0].status,
        errorMessage: turnState.agents[0].errorMessage,
      });
    },
  });
  const turnState = createTurnState(conversation, 'turn-recovery');

  await executor.executeConversationAgent({
    runStore: createFakeRunStore(taskEvents),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-recovery',
    conversation,
    promptMessages: [{ role: 'user', content: 'Recover the stuck tool.' }],
    promptUserMessage: { id: 'user-message-recovery', role: 'user', content: 'hello' },
    queueItem: { triggerType: 'user', enqueueReason: 'user_mentions' },
    agent,
    turnState,
    completedReplies: [],
    failedReplies: [],
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 0,
    enqueueAgent() {},
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: tempDir,
  });

  const recoveringIndex = taskEvents.findIndex((event) => event.eventName === 'agent_reply_recovering');
  const recoveredIndex = taskEvents.findIndex((event) => event.eventName === 'agent_reply_recovery_started');
  assert.equal(capturedOptions.toolProgressRecovery, true);
  assert.ok(recoveringIndex >= 0);
  assert.ok(recoveredIndex > recoveringIndex);
  assert.equal(taskEvents[recoveringIndex].payload.toolName, 'bash');
  assert.ok(progressSnapshots.some((snapshot) => snapshot.status === 'running' && snapshot.errorMessage === 'tool stalled'));
  assert.ok(!progressSnapshots.some((snapshot) => snapshot.status === 'terminating'));
  assert.equal(turnState.agents[0].status, 'completed');
});

test('conversation digest uses direct no-tools completion instead of Agent tool recovery', () => {
  const digestSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'server', 'domain', 'conversation', 'conversation-digest.ts'),
    'utf8'
  );

  assert.doesNotMatch(digestSource, /\bstartRun\s*\(/u, 'system digest/title calls must not create Agent runs');
  assert.match(digestSource, /completeDigestModel\(directCompletion, directModel/u);
  assert.match(digestSource, /maxTokens:\s*outputBudget/u);
  assert.doesNotMatch(
    digestSource,
    /toolProgressRecovery/u,
    'digest model calls must keep hard timeout/fallback semantics instead of receiving agent recovery prompts'
  );
});

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

test('agent executor sends the prevalidated runtime config without env fallback or family Persona leakage', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-runtime-config-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  const previousTimeoutEnv = {
    heartbeat: process.env.PI_HEARTBEAT_TIMEOUT_MS,
    progress: process.env.PI_PROGRESS_TIMEOUT_MS,
    total: process.env.PI_TIMEOUT_MS,
  };
  process.env.PI_HEARTBEAT_TIMEOUT_MS = '11000';
  process.env.PI_PROGRESS_TIMEOUT_MS = '22000';
  process.env.PI_TIMEOUT_MS = '33000';
  let captured = null;

  minimalPi.startRun = (provider, model, prompt, options) => {
    captured = { provider, model, prompt, options };
    return createRunHandle('Done.');
  };
  delete require.cache[agentExecutorPath];

  t.after(() => {
    minimalPi.startRun = originalStartRun;
    delete require.cache[agentExecutorPath];

    for (const [name, value] of [
      ['PI_HEARTBEAT_TIMEOUT_MS', previousTimeoutEnv.heartbeat],
      ['PI_PROGRESS_TIMEOUT_MS', previousTimeoutEnv.progress],
      ['PI_TIMEOUT_MS', previousTimeoutEnv.total],
    ]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createAgentExecutor } = require(agentExecutorPath);
  const { createTurnState } = require(turnStatePath);
  const agent = {
    id: 'role-family-gpt',
    name: 'GPT',
    description: 'GPT model-family collaborator.',
    roleKind: 'model_family',
    modelFamily: 'gpt',
    personaPrompt: 'Contaminated family Persona.',
    skillIds: ['contaminated-family-skill'],
    runtimeConfig: {
      profileId: 'max-effort',
      profileName: 'Max effort',
      provider: 'openai-runtime',
      model: 'gpt-runtime',
      thinking: 'max',
      personaPrompt: '',
      skillIds: [],
    },
  };
  const conversation = {
    id: 'conversation-runtime-config',
    title: 'Runtime Config',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
  const piCapabilityExtensionPath = path.join(tempDir, 'caff-capabilities.mjs');
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
    piCapabilityExtensionPath,
  });
  const turnState = createTurnState(conversation, 'turn-runtime-config');

  await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-runtime-config',
    conversation,
    promptMessages: [{ role: 'user', content: 'Use the exact runtime configuration.' }],
    promptUserMessage: { id: 'user-message-runtime-config', role: 'user', content: 'hello' },
    queueItem: { triggerType: 'user', enqueueReason: 'user_mentions' },
    agent,
    turnState,
    completedReplies: [],
    failedReplies: [],
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 0,
    enqueueAgent() {},
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: tempDir,
  });

  assert.equal(captured.provider, 'openai-runtime');
  assert.equal(captured.model, 'gpt-runtime');
  assert.equal(captured.options.thinking, 'max');
  assert.equal(captured.options.heartbeatTimeoutMs, 11000);
  assert.equal(captured.options.progressTimeoutMs, 22000);
  assert.equal(captured.options.timeoutMs, 33000);
  assert.equal(captured.options.toolProgressRecovery, true);
  assert.deepEqual(captured.options.extensionPaths, [piCapabilityExtensionPath]);
  assert.doesNotMatch(captured.prompt, /Contaminated family Persona|contaminated-family-skill/u);
  assert.match(captured.prompt, /This is a model-family identity, not a fictional persona\./u);
});

test('agent executor completes the run after a successful public bridge post', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-bridge-auto-final-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  const runHandle = createCompletableRunHandle();
  let registeredContext = null;

  minimalPi.startRun = () => runHandle;
  delete require.cache[agentExecutorPath];

  t.after(() => {
    minimalPi.startRun = originalStartRun;
    delete require.cache[agentExecutorPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createAgentExecutor } = require(agentExecutorPath);
  const { createTurnState } = require(turnStatePath);
  const agent = {
    id: 'agent-bridge-auto-final',
    name: 'Bridge Auto Final',
    description: 'Tests bridge auto completion.',
    personaPrompt: 'Be brief.',
  };
  const conversation = {
    id: 'conversation-bridge-auto-final',
    title: 'Bridge Auto Final',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
  const bridge = {
    createInvocationContext(input) {
      return input;
    },
    registerInvocation(context) {
      registeredContext = {
        ...context,
        invocationId: 'invocation-bridge-auto-final',
        callbackToken: 'callback-bridge-auto-final',
        publicToolUsed: false,
        publicPostCount: 0,
        privatePostCount: 0,
        privateHandoffCount: 0,
        lastPublicContent: '',
      };
      process.nextTick(() => {
        registeredContext.publicToolUsed = true;
        registeredContext.publicPostCount = 1;
        registeredContext.lastPublicContent = 'Sent through bridge.';
        registeredContext.onPublicPostCompleted({ publicPostCount: 1, publicPostMode: 'replace' });
      });
      return registeredContext;
    },
    unregisterInvocation() {},
  };
  const executor = createAgentExecutor({
    store,
    skillRegistry: { resolveSkills: () => [] },
    modeStore: { get: () => null },
    agentToolBridge: bridge,
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'chat.sqlite'),
    toolBaseUrl: 'http://127.0.0.1:3100',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });
  const turnState = createTurnState(conversation, 'turn-bridge-auto-final');
  const completedReplies = [];

  const result = await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-bridge-auto-final',
    conversation,
    promptMessages: [{ role: 'user', content: 'Use the bridge.' }],
    promptUserMessage: { id: 'user-message-bridge-auto-final', role: 'user', content: 'hello' },
    queueItem: { triggerType: 'user', enqueueReason: 'user_mentions' },
    agent,
    turnState,
    completedReplies,
    failedReplies: [],
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 1,
    enqueueAgent() {},
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: tempDir,
  });

  assert.equal(runHandle.completeCalled, true);
  assert.match(runHandle.completeReason, /Chat bridge public reply posted/u);
  assert.equal(registeredContext.autoCompleteOnPublicPost, true);
  assert.equal(completedReplies[0].content, 'Sent through bridge.');
  assert.equal(completedReplies[0].metadata.publicToolUsed, true);
  assert.equal(result.stopTurn, true);
});

test('agent executor publishes a bounded safe model-call event while the assistant run is still active', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-live-model-event-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  const runHandle = createObservableRunHandle();

  minimalPi.startRun = () => runHandle;
  delete require.cache[agentExecutorPath];

  t.after(() => {
    minimalPi.startRun = originalStartRun;
    delete require.cache[agentExecutorPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createAgentExecutor } = require(agentExecutorPath);
  const { createTurnState } = require(turnStatePath);
  const agent = {
    id: 'agent-live-model-event',
    name: 'Live Model Event',
    description: 'Tests running observability.',
    personaPrompt: 'Be brief.',
  };
  const conversation = {
    id: 'conversation-live-model-event',
    title: 'Live Model Event',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
  const broadcastEvents = [];
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
      broadcastEvents.push({ eventName, payload });
    },
  });
  const turnState = createTurnState(conversation, 'turn-live-model-event');

  await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-live-model-event',
    conversation,
    promptMessages: [{ role: 'user', content: 'Run for a while.' }],
    promptUserMessage: { id: 'user-message-live-model-event', role: 'user', content: 'Run for a while.' },
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

  const modelEvents = broadcastEvents.filter((event) => event.eventName === 'conversation_model_event');
  assert.equal(modelEvents.length, 1, 'message_end should update the open timeline without waiting for terminal message refresh');
  assert.equal(modelEvents[0].payload.event.eventType, 'model_call');
  assert.equal(modelEvents[0].payload.event.eventId, 'model-call:live-response-1');
  assert.equal(modelEvents[0].payload.event.timelineSequence, 1);
  assert.equal(modelEvents[0].payload.event.modelCallSequence, 1);
  assert.equal(modelEvents[0].payload.event.tokenUsage.totalTokens, 150);
  assert.equal(JSON.stringify(modelEvents[0].payload).includes('hidden-live-reasoning'), false);
  assert.equal(JSON.stringify(modelEvents[0].payload).includes('visible but not part of observability SSE'), false);
});

test('agent executor isolates observability sequences across repeated runs by the same agent in one turn', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-observability-isolation-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  let nextRunIndex = 0;

  minimalPi.startRun = () => createObservableRunHandle(++nextRunIndex);
  delete require.cache[agentExecutorPath];

  t.after(() => {
    minimalPi.startRun = originalStartRun;
    delete require.cache[agentExecutorPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createAgentExecutor } = require(agentExecutorPath);
  const { createTurnState } = require(turnStatePath);
  const agent = {
    id: 'agent-observability-isolation',
    name: 'Observability Isolation',
    description: 'Runs twice in one turn.',
    personaPrompt: 'Be brief.',
  };
  const conversation = {
    id: 'conversation-observability-isolation',
    title: 'Observability Isolation',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
  const broadcastEvents = [];
  const invocationTimelineStates = [];
  const bridge = {
    createInvocationContext(input) {
      return input;
    },
    registerInvocation(context) {
      invocationTimelineStates.push(context.observabilityTimelineState);
      return {
        ...context,
        invocationId: `invocation-observability-isolation-${invocationTimelineStates.length}`,
        callbackToken: `callback-observability-isolation-${invocationTimelineStates.length}`,
        publicToolUsed: false,
        publicPostCount: 0,
        privatePostCount: 0,
        privateHandoffCount: 0,
        lastPublicContent: '',
      };
    },
    unregisterInvocation() {},
  };
  const executor = createAgentExecutor({
    store,
    skillRegistry: { resolveSkills: () => [] },
    modeStore: { get: () => null },
    agentToolBridge: bridge,
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'chat.sqlite'),
    toolBaseUrl: 'http://127.0.0.1:3100',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    agentToolRelativePath: './lib/agent-chat-tools.js',
    broadcastEvent(eventName, payload) {
      broadcastEvents.push({ eventName, payload });
    },
  });
  const turnState = createTurnState(conversation, 'turn-observability-isolation');
  const completedReplies = [];

  for (let runIndex = 1; runIndex <= 2; runIndex += 1) {
    await executor.executeConversationAgent({
      runStore: createFakeRunStore(),
      conversationId: conversation.id,
      turnId: turnState.turnId,
      rootTaskId: 'root-task-observability-isolation',
      conversation,
      promptMessages: [{ role: 'user', content: `Run ${runIndex}.` }],
      promptUserMessage: {
        id: `user-message-observability-isolation-${runIndex}`,
        role: 'user',
        content: `Run ${runIndex}.`,
      },
      queueItem: { triggerType: runIndex === 1 ? 'user' : 'agent', enqueueReason: 'test_repeat' },
      agent,
      turnState,
      completedReplies,
      failedReplies: [],
      routingMode: 'mention_queue',
      hop: runIndex,
      remainingSlots: 1,
      enqueueAgent() {},
      allowHandoffs: true,
      finalStopsTurn: false,
      projectDir: tempDir,
    });
  }

  const modelEvents = broadcastEvents.filter((event) => event.eventName === 'conversation_model_event');
  assert.equal(modelEvents.length, 2);
  assert.notEqual(modelEvents[0].payload.messageId, modelEvents[1].payload.messageId);
  assert.deepEqual(modelEvents.map((item) => item.payload.event.timelineSequence), [1, 1]);
  assert.deepEqual(modelEvents.map((item) => item.payload.event.modelCallSequence), [1, 1]);
  assert.deepEqual(modelEvents.map((item) => item.payload.timelineWindow.totalEventCount), [1, 1]);
  assert.equal(invocationTimelineStates.length, 2);
  assert.ok(invocationTimelineStates[0]);
  assert.ok(invocationTimelineStates[1]);
  assert.notEqual(invocationTimelineStates[0], invocationTimelineStates[1]);
  assert.equal(completedReplies.length, 2);
  assert.deepEqual(completedReplies.map((message) => message.observabilityTimeline.totalEventCount), [1, 1]);
  assert.deepEqual(
    completedReplies.map((message) => message.observabilityTimeline.events[0].timelineSequence),
    [1, 1]
  );
  assert.deepEqual(completedReplies.map((message) => message.metadata.modelUsage.modelCallCount), [1, 1]);
});

test('assistant completion hook broadcasts final message before blocking routing', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-hook-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;

  minimalPi.startRun = () => createRunHandle('Done. @Next', {
    assistantErrors: [],
    assistantErrorHistory: ['connection error: stream_read_error'],
    usage: { input: 10, output: 2, totalTokens: 12 },
    usageCalls: [
      { key: 'call-1', responseId: 'response-1', usage: { input: 10, output: 2, totalTokens: 12 } },
      { key: 'call-2', responseId: 'response-2', usage: { input: 4, output: 1, totalTokens: 5, cacheRead: 0 } },
    ],
  });
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
  let routedInput = null;
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
      routedInput = input;
      events.push(`enqueue:${Array.isArray(input && input.agentIds) ? input.agentIds.join(',') : ''}`);
      return input.agentIds;
    },
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: tempDir,
  });

  assert.equal(result.stopTurn, false);
  assert.deepEqual(events, ['broadcast:streaming', 'broadcast:completed', 'hook:start', 'hook:end', 'enqueue:agent-hook-next']);
  assert.equal(routedInput.triggerType, 'agent');
  assert.equal(routedInput.triggeredByAgentId, agent.id);
  assert.equal(routedInput.parentRunId, 'run-hook-await');
  assert.deepEqual(routedInput.agentIds, [nextAgent.id]);

  assert.equal(store.messageWrites.creates.length, 1);
  const queuedWrite = store.messageWrites.creates[0];
  assert.ok(Array.isArray(queuedWrite.contextSnapshot.sections));
  assert.equal(Object.hasOwn(queuedWrite.metadata.agentContextSnapshot, 'sections'), false);
  assert.equal(queuedWrite.metadata.agentContextSnapshot.sectionCount > 0, true);

  const streamingWrite = store.messageWrites.updates.find(({ patch }) => patch.status === 'streaming');
  const completedWrite = store.messageWrites.updates.find(({ patch }) => patch.status === 'completed');
  assert.ok(streamingWrite);
  assert.ok(Array.isArray(streamingWrite.patch.contextSnapshot.sections));
  assert.equal(Object.hasOwn(streamingWrite.patch.metadata.agentContextSnapshot, 'sections'), false);
  assert.ok(completedWrite);
  assert.ok(Array.isArray(completedWrite.patch.contextSnapshot.sections));
  assert.equal(completedWrite.patch.modelUsage.calls.length, 2);
  assert.equal(completedWrite.patch.metadata.modelUsage.modelCallCount, 2);
  assert.equal(Object.hasOwn(completedWrite.patch.metadata.modelUsage, 'calls'), false);
  assert.equal(JSON.stringify(completedWrite.patch.metadata).includes('displayContent'), false);

  assert.ok(
    turnProgresses.some((turn) => {
      const stage = Array.isArray(turn && turn.agents) ? turn.agents[0] : null;
      return stage && stage.status === 'completed' && stage.finalContent === 'Done. @Next';
    }),
    'completed turn progress should carry full final content while the hook is blocking routing'
  );
});

test('agent executor downgrades historical images for a non-vision invocation and calls startRun', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-image-block-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  let startRunCalled = false;
  let capturedPrompt = '';
  let capturedImages = null;

  minimalPi.startRun = (_provider, _model, prompt, options) => {
    startRunCalled = true;
    capturedPrompt = String(prompt || '');
    capturedImages = options && options.images;
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
    id: 'agent-text-only',
    name: 'Text Only',
    description: 'Non-vision model.',
    personaPrompt: 'Be brief.',
    runtimeConfig: { provider: 'deepseek', model: 'deepseek-v3', thinking: 'off', personaPrompt: '', skillIds: [] },
  };
  const conversation = {
    id: 'conversation-image-block',
    title: 'Image Block',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
  const failedReplies = [];
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
    modelCatalog: {
      getOptions() {
        return [{ provider: 'deepseek', model: 'deepseek-v3', input: ['text'] }];
      },
    },
  });
  const turnState = createTurnState(conversation, 'turn-image-block');

  const result = await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-image-block',
    conversation,
    promptMessages: [{
      id: 'user-message-with-image',
      role: 'user',
      content: 'what is this image',
      metadata: {
        contentBlocks: [
          { type: 'text', text: 'what is this image' },
          { type: 'image', imageId: 'img-1', url: '/uploads/batch-1/0-photo.png' },
        ],
      },
    }],
    promptUserMessage: { id: 'user-message-with-image', role: 'user', content: 'what is this image' },
    queueItem: { triggerType: 'user', enqueueReason: 'user_mentions' },
    agent,
    turnState,
    completedReplies: [],
    failedReplies,
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 1,
    enqueueAgent() {},
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: tempDir,
  });

  assert.equal(startRunCalled, true, 'text-only history images should be projected, not block the invocation');
  assert.deepEqual(capturedImages, []);
  assert.match(capturedPrompt, /what is this image[\s\S]*\[一张图片，但是你没有读取图片的能力\]/u);
  assert.equal(result.stopTurn, true, 'a successful final reply completes the turn normally');
  assert.equal(failedReplies.length, 0);
});

test('agent executor passes projected images to startRun for a vision model', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-image-pass-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  let capturedImages = null;
  let capturedPrompt = null;

  minimalPi.startRun = (_provider, _model, prompt, options) => {
    capturedImages = options && options.images;
    capturedPrompt = prompt;
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
    id: 'agent-vision',
    name: 'Vision',
    description: 'Vision model.',
    personaPrompt: 'Be brief.',
    runtimeConfig: { provider: 'openai', model: 'gpt-5', thinking: 'off', personaPrompt: '', skillIds: [] },
  };
  const conversation = {
    id: 'conversation-image-pass',
    title: 'Image Pass',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
  const uploadsDir = path.join(tempDir, 'uploads');
  fs.mkdirSync(path.join(uploadsDir, 'batch-1'), { recursive: true });
  fs.writeFileSync(
    path.join(uploadsDir, 'batch-1', '0-photo.png'),
    Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000320806000000', 'hex')
  );

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
    modelCatalog: {
      getOptions() {
        return [{ provider: 'openai', model: 'gpt-5', input: ['text', 'image'] }];
      },
    },
    uploadsDir,
  });
  const turnState = createTurnState(conversation, 'turn-image-pass');

  await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-image-pass',
    conversation,
    promptMessages: [{
      id: 'user-message-with-image',
      role: 'user',
      content: 'what is this image',
      metadata: {
        contentBlocks: [
          { type: 'text', text: 'what is this image' },
          { type: 'image', imageId: 'img-1', url: '/uploads/batch-1/0-photo.png' },
        ],
      },
    }, {
      id: 'failed-assistant-turn',
      role: 'assistant',
      senderName: 'Helper',
      status: 'failed',
      content: 'partial answer',
      metadata: {},
    }],
    promptUserMessage: { id: 'user-message-with-image', role: 'user', content: 'what is this image' },
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

  assert.equal(capturedImages.length, 1);
  assert.equal(capturedImages[0].type, 'image');
  assert.equal(capturedImages[0].mimeType, 'image/png');
  assert.ok(capturedImages[0].data.length > 0, 'image bytes are base64 encoded');

  assert.ok(capturedPrompt, 'startRun prompt must be captured');
  assert.match(String(capturedPrompt), /User: what is this image[\s\S]*\[image:0:0\]/u,
    'image message must keep speaker attribution and carry the image marker through the normal history formatter');
  assert.match(String(capturedPrompt), /Helper \[failed\][\s\S]*partial answer/u,
    'failed assistant status must survive the projected history');
});

test('agent executor blocks IMAGE_MIME_MISMATCH when registry persisted MIME contradicts magic bytes', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-mime-mismatch-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  let startRunCalled = false;

  minimalPi.startRun = () => {
    startRunCalled = true;
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
    id: 'agent-vision',
    name: 'Vision',
    description: 'Vision model.',
    personaPrompt: 'Be brief.',
    runtimeConfig: { provider: 'openai', model: 'gpt-5', thinking: 'off', personaPrompt: '', skillIds: [] },
  };
  const conversation = {
    id: 'conversation-mime-mismatch',
    title: 'Mime Mismatch',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
  store.listImageUploadsByIds = (imageIds) =>
    (Array.isArray(imageIds) ? imageIds : []).map((imageId) => ({
      imageId,
      batchId: 'batch-1',
      mimeType: 'image/jpeg',
    }));
  const failedReplies = [];
  const uploadsDir = path.join(tempDir, 'uploads');
  fs.mkdirSync(path.join(uploadsDir, 'batch-1'), { recursive: true });
  fs.writeFileSync(
    path.join(uploadsDir, 'batch-1', '0-photo.png'),
    Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000320806000000', 'hex')
  );

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
    modelCatalog: {
      getOptions() {
        return [{ provider: 'openai', model: 'gpt-5', input: ['text', 'image'] }];
      },
    },
    uploadsDir,
  });
  const turnState = createTurnState(conversation, 'turn-mime-mismatch');

  const result = await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-mime-mismatch',
    conversation,
    promptMessages: [{
      id: 'user-message-with-image',
      role: 'user',
      content: 'what is this image',
      metadata: {
        contentBlocks: [
          { type: 'text', text: 'what is this image' },
          { type: 'image', imageId: 'img-1', url: '/uploads/batch-1/0-photo.png' },
        ],
      },
    }],
    promptUserMessage: { id: 'user-message-with-image', role: 'user', content: 'what is this image' },
    queueItem: { triggerType: 'user', enqueueReason: 'user_mentions' },
    agent,
    turnState,
    completedReplies: [],
    failedReplies,
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 1,
    enqueueAgent() {},
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: tempDir,
  });

  assert.equal(startRunCalled, false, 'startRun must not be called on persisted MIME mismatch');
  assert.equal(failedReplies.length, 1, 'invocation must fail with structured block');
  assert.equal(failedReplies[0].status, 'failed');
  assert.equal(failedReplies[0].metadata.invocationBlocks[0].code, 'IMAGE_MIME_MISMATCH');
});

test('agent executor writes integrity_status=missing_file when attached image file is gone', async (t) => {
  const tempDir = withTempDir('caff-agent-executor-missing-image-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const turnStatePath = require.resolve('../../build/server/domain/conversation/turn/turn-state');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  let startRunCalled = false;

  minimalPi.startRun = () => {
    startRunCalled = true;
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
    id: 'agent-vision-missing',
    name: 'Vision Missing',
    description: 'Vision model.',
    personaPrompt: 'Be brief.',
    runtimeConfig: { provider: 'openai', model: 'gpt-5', thinking: 'off', personaPrompt: '', skillIds: [] },
  };
  const conversation = {
    id: 'conversation-missing-image',
    title: 'Missing Image',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
  const store = createFakeStore(conversation);
  const uploadsDir = path.join(tempDir, 'uploads');
  fs.mkdirSync(path.join(uploadsDir, 'batch-1'), { recursive: true });

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
    modelCatalog: {
      getOptions() {
        return [{ provider: 'openai', model: 'gpt-5', input: ['text', 'image'] }];
      },
    },
    uploadsDir,
  });
  const turnState = createTurnState(conversation, 'turn-missing-image');

  await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: 'root-task-missing-image',
    conversation,
    promptMessages: [{
      id: 'user-message-with-missing-image',
      role: 'user',
      content: 'what is this image',
      metadata: {
        contentBlocks: [
          { type: 'text', text: 'what is this image' },
          { type: 'image', imageId: 'img-missing', url: '/uploads/batch-1/0-photo.png' },
        ],
      },
    }],
    promptUserMessage: { id: 'user-message-with-missing-image', role: 'user', content: 'what is this image' },
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

  assert.equal(startRunCalled, false, 'startRun must not be called when the image file is missing');
  assert.equal(store.integrityWrites.length, 1, 'integrity failure must be written back');
  assert.equal(store.integrityWrites[0].imageId, 'img-missing');
  assert.match(store.integrityWrites[0].integrityError, /missing/u);
});
