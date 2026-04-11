const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const {
  buildAssistantMessageToolTrace,
  createLiveBridgeToolStep,
  createLiveSessionToolStep,
} = require('../../build/server/domain/runtime/message-tool-trace');
const { withTempDir } = require('../helpers/temp-dir');

function createDomElementStub() {
  return {
    textContent: '',
    value: '',
    dataset: {},
    style: {},
    addEventListener() {},
    removeEventListener() {},
  };
}

function loadPublicAppHarness() {
  const sourcePath = path.join(__dirname, '../../public/app.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const instrumented = source.replace(
    /\ninit\(\);\s*$/,
    `

globalThis.__testExports = {
  state,
  connectEventStream,
  createEmptyToolTraceData,
  getMessageToolTraceState,
  toolTraceStateForMessage,
  setOverrides(overrides = {}) {
    renderConversationPane = overrides.renderConversationPane || renderConversationPane;
    renderConversationList = overrides.renderConversationList || renderConversationList;
    renderRuntime = overrides.renderRuntime || renderRuntime;
    refreshConversationFromEvent = overrides.refreshConversationFromEvent || refreshConversationFromEvent;
  },
};
`
  );

  assert.notEqual(instrumented, source, 'expected public/app.js test instrumentation to replace init()');

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = FakeEventSource.OPEN;
      this.listeners = new Map();
      FakeEventSource.instance = this;
    }

    addEventListener(type, handler) {
      this.listeners.set(type, (this.listeners.get(type) || []).concat(handler));
    }

    close() {
      this.readyState = FakeEventSource.CLOSED;
    }

    dispatch(type, payload) {
      (this.listeners.get(type) || []).forEach((handler) => handler({ data: JSON.stringify(payload) }));
    }
  }

  FakeEventSource.OPEN = 1;
  FakeEventSource.CLOSED = 2;
  FakeEventSource.instance = null;

  const document = {
    body: createDomElementStub(),
    getElementById: createDomElementStub,
    createElement: createDomElementStub,
  };
  const window = {
    CaffShared: {},
    CaffChat: {},
    document,
    EventSource: FakeEventSource,
    navigator: { clipboard: null },
    confirm() {
      return true;
    },
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
  };
  const context = {
    window,
    document,
    navigator: window.navigator,
    EventSource: FakeEventSource,
    console,
    Intl,
    URL,
    Map,
    Set,
    Date,
    JSON,
    Array,
    String,
    Number,
    Object,
    Promise,
    RegExp,
    Math,
    parseInt,
    parseFloat,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
  };

  context.globalThis = context;
  context.global = context;
  context.self = window;

  vm.runInNewContext(instrumented, context, { filename: sourcePath });

  const app = context.__testExports;
  app.setOverrides({
    renderConversationPane() {},
    renderConversationList() {},
    renderRuntime() {},
    refreshConversationFromEvent: async () => {},
  });

  return { app, FakeEventSource };
}

test('assistant message tool trace summarizes session calls and redacts sensitive tool data', (t) => {
  const tempDir = withTempDir('caff-message-tool-trace-');
  const sqlitePath = path.join(tempDir, 'trace.sqlite');
  const sessionsDir = path.join(tempDir, 'named-sessions');
  const projectDir = path.join(tempDir, 'project');
  const sessionPath = path.join(sessionsDir, 'trace-session.jsonl');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const runStore = createSqliteRunStore({ agentDir: tempDir, sqlitePath });

  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  t.after(() => {
    try {
      runStore.close();
    } catch {}
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveAgent({
    id: 'trace-agent',
    name: 'Trace Agent',
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: 'trace-conversation',
    title: 'Trace Conversation',
    participants: [agent.id],
  });

  const taskId = 'trace-task-1';
  const assistantMessage = store.createMessage({
    id: 'trace-message-1',
    conversationId: conversation.id,
    turnId: 'trace-turn-1',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Done',
    status: 'completed',
    taskId,
    metadata: {
      sessionPath,
      sessionName: 'trace-session',
    },
  });

  fs.writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'demo-provider',
          model: 'demo-model',
          stopReason: 'end_turn',
          content: [
            {
              type: 'toolCall',
              name: 'read',
              id: 'session-tool-1',
              arguments: {
                path: path.join(projectDir, '.trellis', 'spec', 'frontend', 'index.md'),
              },
            },
            {
              type: 'text',
              text: 'done',
            },
          ],
        },
      }),
      '',
    ].join('\n'),
    'utf8'
  );

  runStore.createTask({
    taskId,
    kind: 'conversation_agent_reply',
    title: 'Trace Task',
    status: 'failed',
    sessionPath,
    errorMessage: 'Authorization: Bearer super-secret-token',
    metadata: {
      projectDir,
      sessionPath,
    },
  });
  runStore.appendTaskEvent(taskId, 'agent_tool_call', {
    toolCallId: 'bridge-tool-1',
    tool: 'send-public',
    status: 'failed',
    durationMs: 1250,
    assistantMessageId: assistantMessage.id,
    request: {
      contentLength: 24,
      command: `cat ${path.join(projectDir, 'private', 'notes.txt')}`,
      Authorization: 'Bearer abc123',
    },
    error: {
      message: `Authorization: Bearer hidden-token at ${path.join(projectDir, 'private', 'notes.txt')}`,
    },
  });

  const trace = buildAssistantMessageToolTrace({
    db: store.db,
    agentDir: tempDir,
    message: assistantMessage,
    resolvedSessionPath: sessionPath,
  });

  assert.equal(trace.message.id, assistantMessage.id);
  assert.equal(trace.summary.totalSteps, 2);
  assert.equal(trace.summary.sessionToolCount, 1);
  assert.equal(trace.summary.bridgeToolCount, 1);
  assert.equal(trace.summary.failedSteps, 1);
  assert.equal(trace.summary.status, 'failed');
  assert.equal(trace.session.provider, 'demo-provider');
  assert.equal(trace.sessionToolCalls[0].toolName, 'read');
  assert.equal(trace.bridgeToolEvents[0].toolName, 'send-public');
  assert.equal(trace.bridgeToolEvents[0].status, 'failed');
  assert.equal(trace.bridgeToolEvents[0].durationMs, 1250);
  assert.equal(trace.failureContext.hasFailure, true);
  assert.equal(trace.failureContext.toolName, 'send-public');

  const serializedSessionRequest = JSON.stringify(trace.sessionToolCalls[0].requestSummary);
  const serializedBridgeRequest = JSON.stringify(trace.bridgeToolEvents[0].requestSummary);
  const serializedBridgeError = JSON.stringify(trace.bridgeToolEvents[0].errorSummary);
  const serializedTask = JSON.stringify(trace.task);
  const serializedFailureContext = JSON.stringify(trace.failureContext);

  assert.equal(serializedSessionRequest.includes(projectDir), false);
  assert.equal(serializedBridgeRequest.includes(projectDir), false);
  assert.equal(serializedBridgeError.includes(projectDir), false);
  assert.equal(serializedBridgeRequest.includes('abc123'), false);
  assert.equal(serializedBridgeError.includes('hidden-token'), false);
  assert.equal(serializedTask.includes('super-secret-token'), false);
  assert.equal(serializedFailureContext.includes(projectDir), false);
  assert.equal(serializedFailureContext.includes('hidden-token'), false);
  assert.equal(serializedFailureContext.includes('super-secret-token'), false);
});

test('assistant message tool trace builds one merged timeline for session and bridge steps', (t) => {
  const tempDir = withTempDir('caff-message-tool-trace-merged-');
  const sqlitePath = path.join(tempDir, 'trace.sqlite');
  const sessionsDir = path.join(tempDir, 'named-sessions');
  const sessionPath = path.join(sessionsDir, 'trace-session.jsonl');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const runStore = createSqliteRunStore({ agentDir: tempDir, sqlitePath });

  fs.mkdirSync(sessionsDir, { recursive: true });

  t.after(() => {
    try {
      runStore.close();
    } catch {}
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveAgent({
    id: 'trace-agent-merged',
    name: 'Trace Agent',
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: 'trace-conversation-merged',
    title: 'Trace Conversation',
    participants: [agent.id],
  });

  const taskId = 'trace-task-merged-1';
  const assistantMessage = store.createMessage({
    id: 'trace-message-merged-1',
    conversationId: conversation.id,
    turnId: 'trace-turn-merged-1',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Done',
    status: 'completed',
    taskId,
    metadata: {
      sessionPath,
      sessionName: 'trace-session-merged',
    },
  });

  fs.writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'demo-provider',
          model: 'demo-model',
          stopReason: 'end_turn',
          content: [
            {
              type: 'toolCall',
              name: 'read',
              id: 'session-tool-read',
              arguments: {
                path: '.trellis/spec/frontend/index.md',
              },
            },
            {
              type: 'toolCall',
              name: 'bash',
              id: 'session-tool-bash',
              arguments: {
                command: 'node ./build/lib/agent-chat-tools.js send-public --content "hi"',
              },
            },
            {
              type: 'text',
              text: 'done',
            },
          ],
        },
      }),
      '',
    ].join('\n'),
    'utf8'
  );

  runStore.createTask({
    taskId,
    kind: 'conversation_agent_reply',
    title: 'Trace Task',
    status: 'completed',
    sessionPath,
    metadata: {
      sessionPath,
    },
  });
  runStore.appendTaskEvent(taskId, 'agent_tool_call', {
    toolCallId: 'bridge-tool-send-public',
    tool: 'send-public',
    status: 'succeeded',
    durationMs: 280,
    assistantMessageId: assistantMessage.id,
    request: {
      visibility: 'public',
      contentLength: 2,
    },
    result: {
      publicPostCount: 1,
    },
  });

  const trace = buildAssistantMessageToolTrace({
    db: store.db,
    agentDir: tempDir,
    message: assistantMessage,
    resolvedSessionPath: sessionPath,
  });

  assert.ok(Array.isArray(trace.steps));
  assert.equal(trace.steps.length, 3);
  assert.equal(trace.steps[0].toolName, 'read');
  assert.equal(trace.steps[0].kind, 'session');
  assert.equal(trace.steps[1].toolName, 'bash');
  assert.equal(trace.steps[1].kind, 'session');
  assert.equal(trace.steps[1].bridgeToolHint, 'send-public');
  assert.equal(trace.steps[2].toolName, 'send-public');
  assert.equal(trace.steps[2].kind, 'bridge');
  assert.equal(trace.steps[2].linkedFromStepId, trace.steps[1].stepId);
  assert.equal(trace.failureContext.hasFailure, false);
  assert.equal(trace.failureContext.text, '');
});

test('assistant message tool trace infers the current tool while a task is still running', (t) => {
  const tempDir = withTempDir('caff-message-tool-trace-running-');
  const sqlitePath = path.join(tempDir, 'trace.sqlite');
  const sessionsDir = path.join(tempDir, 'named-sessions');
  const sessionPath = path.join(sessionsDir, 'trace-session-running.jsonl');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const runStore = createSqliteRunStore({ agentDir: tempDir, sqlitePath });

  fs.mkdirSync(sessionsDir, { recursive: true });

  t.after(() => {
    try {
      runStore.close();
    } catch {}
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveAgent({
    id: 'trace-agent-running',
    name: 'Trace Agent',
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: 'trace-conversation-running',
    title: 'Trace Conversation',
    participants: [agent.id],
  });

  const taskId = 'trace-task-running-1';
  const assistantMessage = store.createMessage({
    id: 'trace-message-running-1',
    conversationId: conversation.id,
    turnId: 'trace-turn-running-1',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Working...',
    status: 'streaming',
    taskId,
    metadata: {
      sessionPath,
      sessionName: 'trace-session-running',
    },
  });

  fs.writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'demo-provider',
          model: 'demo-model',
          stopReason: 'tool_call',
          content: [
            {
              type: 'toolCall',
              name: 'bash',
              id: 'session-tool-bash-running',
              arguments: {
                command: 'node ./build/lib/agent-chat-tools.js send-public --content "hi"',
              },
            },
          ],
        },
      }),
      '',
    ].join('\n'),
    'utf8'
  );

  runStore.createTask({
    taskId,
    kind: 'conversation_agent_reply',
    title: 'Trace Task',
    status: 'running',
    sessionPath,
    metadata: {
      sessionPath,
    },
  });

  const trace = buildAssistantMessageToolTrace({
    db: store.db,
    agentDir: tempDir,
    message: assistantMessage,
    resolvedSessionPath: sessionPath,
  });

  assert.equal(trace.summary.status, 'running');
  assert.equal(trace.activity.hasCurrentTool, true);
  assert.equal(trace.activity.currentToolName, 'send-public');
  assert.equal(trace.activity.currentStepKind, 'bridge');
  assert.equal(trace.activity.inferred, true);
  assert.equal(trace.activity.label.includes('send-public'), true);
});

test('live tool step helpers keep stable ids and redact sensitive payloads', () => {
  const tempDir = withTempDir('caff-message-tool-trace-live-step-');
  const projectDir = path.join(tempDir, 'project');

  fs.mkdirSync(projectDir, { recursive: true });

  const sessionStep = createLiveSessionToolStep(
    {
      id: 'session-tool-live-1',
      name: 'bash',
      arguments: {
        command: `cat ${path.join(projectDir, '.trellis', 'spec', 'frontend', 'index.md')}`,
      },
      partialJson: `{"path":"${path.join(projectDir, '.trellis', 'spec', 'frontend', 'index.md')}","apiKey":"sk-live-secret"}`,
    },
    {
      agentDir: tempDir,
      createdAt: '2026-04-10T00:00:00.000Z',
    }
  );
  const anonymousSessionStep = createLiveSessionToolStep(
    {
      name: 'read',
      arguments: {
        path: path.join(projectDir, '.trellis', 'spec', 'frontend', 'index.md'),
      },
      partialJson: '{"apiKey":"sk-live-fragment","password":"hunter2"',
    },
    {
      agentDir: tempDir,
      createdAt: '2026-04-10T00:00:00.500Z',
      index: 1,
    }
  );
  const nextAnonymousSessionStep = createLiveSessionToolStep(
    {
      name: 'bash',
      arguments: {
        command: 'echo ping',
      },
    },
    {
      agentDir: tempDir,
      createdAt: '2026-04-10T00:00:00.750Z',
      index: 2,
    }
  );
  const bridgeStep = createLiveBridgeToolStep(
    {
      toolCallId: 'bridge-tool-live-1',
      tool: 'send-public',
      status: 'failed',
      request: {
        Authorization: 'Bearer super-secret-token',
        path: path.join(projectDir, 'private', 'notes.txt'),
      },
      error: {
        message: `Bearer hidden-token at ${path.join(projectDir, 'private', 'notes.txt')}`,
      },
    },
    {
      agentDir: tempDir,
      createdAt: '2026-04-10T00:00:01.000Z',
    }
  );

  assert.equal(sessionStep.stepId, 'session-session-tool-live-1');
  assert.equal(sessionStep.createdAt, '2026-04-10T00:00:00.000Z');
  assert.equal(anonymousSessionStep.stepId, 'session-2');
  assert.equal(nextAnonymousSessionStep.stepId, 'session-3');
  assert.equal(bridgeStep.stepId, 'bridge-tool-live-1');
  assert.equal(bridgeStep.status, 'failed');
  assert.equal(JSON.stringify(sessionStep.requestSummary).includes(projectDir), false);
  assert.equal(JSON.stringify(sessionStep.partialJson).includes(projectDir), false);
  assert.equal(JSON.stringify(sessionStep.partialJson).includes('sk-live-secret'), false);
  assert.equal(JSON.stringify(anonymousSessionStep.partialJson).includes('sk-live-fragment'), false);
  assert.equal(JSON.stringify(anonymousSessionStep.partialJson).includes('hunter2'), false);
  assert.equal(String(anonymousSessionStep.partialJson).includes('[redacted]'), true);
  assert.equal(JSON.stringify(bridgeStep.requestSummary).includes(projectDir), false);
  assert.equal(JSON.stringify(bridgeStep.requestSummary).includes('super-secret-token'), false);
  assert.equal(JSON.stringify(bridgeStep.errorSummary).includes('hidden-token'), false);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('assistant message tool trace exposes failure context when task fails without failed tool events', (t) => {
  const tempDir = withTempDir('caff-message-tool-trace-task-failure-');
  const sqlitePath = path.join(tempDir, 'trace.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const runStore = createSqliteRunStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      runStore.close();
    } catch {}
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveAgent({
    id: 'trace-agent-task-failure',
    name: 'Trace Agent',
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: 'trace-conversation-task-failure',
    title: 'Trace Conversation',
    participants: [agent.id],
  });

  const taskId = 'trace-task-task-failure-1';
  const assistantMessage = store.createMessage({
    id: 'trace-message-task-failure-1',
    conversationId: conversation.id,
    turnId: 'trace-turn-task-failure-1',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Failed',
    status: 'failed',
    taskId,
  });

  runStore.createTask({
    taskId,
    kind: 'conversation_agent_reply',
    title: 'Trace Task',
    status: 'failed',
    errorMessage: `Authorization: Bearer super-secret-token at ${path.join(tempDir, 'private', 'notes.txt')}`,
    metadata: {
      projectDir: tempDir,
    },
  });

  const trace = buildAssistantMessageToolTrace({
    db: store.db,
    agentDir: tempDir,
    message: assistantMessage,
    resolvedSessionPath: '',
  });

  assert.equal(trace.summary.status, 'failed');
  assert.equal(trace.summary.failedSteps, 0);
  assert.equal(trace.failureContext.hasFailure, true);
  assert.equal(trace.failureContext.source, 'task');
  assert.equal(trace.failureContext.toolName, '');
  assert.equal(trace.failureContext.text.includes('trace-message-task-failure-1'), true);
  assert.equal(trace.failureContext.text.includes('super-secret-token'), false);
  assert.equal(trace.failureContext.text.includes(tempDir), false);
});

test('assistant message tool trace keeps the newest bridge events when the task has a long tool history', (t) => {
  const tempDir = withTempDir('caff-message-tool-trace-bridge-limit-');
  const sqlitePath = path.join(tempDir, 'trace.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const runStore = createSqliteRunStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      runStore.close();
    } catch {}
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveAgent({
    id: 'trace-agent-bridge-limit',
    name: 'Trace Agent',
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: 'trace-conversation-bridge-limit',
    title: 'Trace Conversation',
    participants: [agent.id],
  });

  const taskId = 'trace-task-bridge-limit-1';
  const assistantMessage = store.createMessage({
    id: 'trace-message-bridge-limit-1',
    conversationId: conversation.id,
    turnId: 'trace-turn-bridge-limit-1',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Done',
    status: 'completed',
    taskId,
  });

  runStore.createTask({
    taskId,
    kind: 'conversation_agent_reply',
    title: 'Trace Task',
    status: 'completed',
  });

  for (let index = 1; index <= 205; index += 1) {
    runStore.appendTaskEvent(taskId, 'agent_tool_call', {
      toolCallId: `bridge-tool-${index}`,
      tool: 'send-public',
      status: index === 205 ? 'failed' : 'succeeded',
      durationMs: index,
      assistantMessageId: assistantMessage.id,
      request: {
        contentLength: index,
      },
      error: index === 205 ? { message: 'latest step failed' } : undefined,
    });
  }

  const trace = buildAssistantMessageToolTrace({
    db: store.db,
    agentDir: tempDir,
    message: assistantMessage,
    resolvedSessionPath: '',
  });

  assert.equal(trace.bridgeToolEvents.length, 200);
  assert.equal(trace.bridgeToolEvents[0].toolCallId, 'bridge-tool-6');
  assert.equal(trace.bridgeToolEvents[199].toolCallId, 'bridge-tool-205');
  assert.equal(trace.summary.failedSteps, 1);
  assert.equal(trace.failureContext.hasFailure, true);
  assert.equal(trace.failureContext.toolName, 'send-public');
  assert.equal(trace.failureContext.text.includes('latest step failed'), true);
});

test('public app finalizes failed side-slot tool traces from the finished payload before removing the slot', () => {
  const { app, FakeEventSource } = loadPublicAppHarness();
  const messageId = 'side-trace-message-1';

  app.connectEventStream();
  const source = FakeEventSource.instance;
  assert.ok(source, 'expected EventSource instance');

  const traceState = app.getMessageToolTraceState(messageId);
  traceState.data = app.createEmptyToolTraceData(messageId);
  traceState.data.message = {
    id: messageId,
    status: 'streaming',
    taskId: null,
    runId: null,
    createdAt: '',
  };
  traceState.data.steps = [
    {
      stepId: 'side-tool-step-1',
      kind: 'bridge',
      toolName: 'send-public',
      status: 'running',
    },
  ];

  app.state.runtime = {
    activeAgentSlots: [
      {
        slotId: 'slot-1',
        conversationId: 'conversation-1',
        assistantMessageId: messageId,
        currentToolStepId: 'side-tool-step-1',
        currentToolName: 'send-public',
        status: 'running',
      },
    ],
  };

  source.dispatch('agent_slot_finished', {
    conversationId: 'conversation-1',
    slot: {
      slotId: 'slot-1',
      conversationId: 'conversation-1',
      assistantMessageId: messageId,
      currentToolStepId: '',
      currentToolName: '',
      status: 'failed',
    },
  });

  const updatedTrace = app.toolTraceStateForMessage(messageId);
  assert.equal(updatedTrace.data.steps[0].status, 'failed');
  assert.equal(app.state.runtime.activeAgentSlots.length, 0);
});

test('public app finalizes failed main-turn tool traces from the finished payload before removing the turn', () => {
  const { app, FakeEventSource } = loadPublicAppHarness();
  const messageId = 'main-trace-message-1';

  app.connectEventStream();
  const source = FakeEventSource.instance;
  assert.ok(source, 'expected EventSource instance');

  const traceState = app.getMessageToolTraceState(messageId);
  traceState.data = app.createEmptyToolTraceData(messageId);
  traceState.data.message = {
    id: messageId,
    status: 'streaming',
    taskId: null,
    runId: null,
    createdAt: '',
  };
  traceState.data.steps = [
    {
      stepId: 'main-tool-step-1',
      kind: 'bridge',
      toolName: 'send-public',
      status: 'running',
    },
  ];

  app.state.runtime = {
    activeTurns: [
      {
        conversationId: 'conversation-2',
        agents: [
          {
            agentId: 'agent-1',
            messageId,
            currentToolStepId: 'main-tool-step-1',
            currentToolName: 'send-public',
            status: 'running',
          },
        ],
      },
    ],
  };

  source.dispatch('turn_finished', {
    conversationId: 'conversation-2',
    turn: {
      conversationId: 'conversation-2',
      agents: [
        {
          agentId: 'agent-1',
          messageId,
          currentToolStepId: '',
          currentToolName: '',
          status: 'failed',
        },
      ],
    },
  });

  const updatedTrace = app.toolTraceStateForMessage(messageId);
  assert.equal(updatedTrace.data.steps[0].status, 'failed');
  assert.equal(app.state.runtime.activeTurns.length, 0);
});
