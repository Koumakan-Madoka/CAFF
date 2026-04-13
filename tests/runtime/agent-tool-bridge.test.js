const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');

const { withTempDir } = require('../helpers/temp-dir');

function createPublicInvocationFixture(store, suffix) {
  const agent = store.saveAgent({
    id: `bridge-agent-${suffix}`,
    name: `Bridge Agent ${suffix}`,
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: `bridge-conversation-${suffix}`,
    title: `Bridge Conversation ${suffix}`,
    participants: [agent.id],
  });
  const assistantMessage = store.createMessage({
    id: `bridge-message-${suffix}`,
    conversationId: conversation.id,
    turnId: `bridge-turn-${suffix}`,
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Thinking...',
    status: 'streaming',
  });
  const fullConversation = store.getConversation(conversation.id);
  const turnState = {
    conversationId: conversation.id,
    turnId: assistantMessage.turnId,
    stopRequested: false,
  };
  const stage = {
    status: 'running',
    replyLength: 0,
    preview: '',
    lastTextDeltaAt: null,
  };

  return {
    agent,
    conversation: fullConversation,
    assistantMessage,
    turnState,
    stage,
  };
}

test('agent tool bridge rejects stale invocations after a turn stops or completes', (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const stoppedFixture = createPublicInvocationFixture(store, 'stopped');
  const stoppedContext = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: stoppedFixture.conversation.id,
      turnId: stoppedFixture.assistantMessage.turnId,
      agentId: stoppedFixture.agent.id,
      agentName: stoppedFixture.agent.name,
      assistantMessageId: stoppedFixture.assistantMessage.id,
      conversationAgents: stoppedFixture.conversation.agents,
      stage: stoppedFixture.stage,
      turnState: stoppedFixture.turnState,
    })
  );

  const firstPost = bridge.handlePostMessage({
    invocationId: stoppedContext.invocationId,
    callbackToken: stoppedContext.callbackToken,
    visibility: 'public',
    content: 'First draft',
  });

  assert.equal(firstPost.ok, true);
  assert.equal(firstPost.message.content, 'First draft');
  assert.ok(firstPost.message.publicPostedAt);

  stoppedFixture.turnState.stopRequested = true;

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: stoppedContext.invocationId,
        callbackToken: stoppedContext.callbackToken,
        visibility: 'public',
        content: 'Late draft',
      }),
    (error) => error && error.statusCode === 409
  );

  const completedFixture = createPublicInvocationFixture(store, 'completed');
  const completedContext = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: completedFixture.conversation.id,
      turnId: completedFixture.assistantMessage.turnId,
      agentId: completedFixture.agent.id,
      agentName: completedFixture.agent.name,
      assistantMessageId: completedFixture.assistantMessage.id,
      conversationAgents: completedFixture.conversation.agents,
      stage: completedFixture.stage,
      turnState: completedFixture.turnState,
    })
  );

  completedFixture.stage.status = 'completed';

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: completedContext.invocationId,
        callbackToken: completedContext.callbackToken,
        visibility: 'public',
        content: 'Should be rejected',
      }),
    (error) => error && error.statusCode === 409
  );
});

test('agent tool bridge enforces skill-test run and case auth scope', (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-skill-test-auth-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'skill-test-auth');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      authScope: 'skill-test',
      caseId: 'case-1',
      runId: 'run-1',
      tokenTtlSec: 60,
      dryRun: true,
    })
  );

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        visibility: 'public',
        content: 'missing scope',
      }),
    (error) => error && error.statusCode === 403
  );

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        skillTestRunId: 'run-1',
        skillTestCaseId: 'case-2',
        visibility: 'public',
        content: 'wrong case',
      }),
    (error) => error && error.statusCode === 403
  );

  const okPost = bridge.handlePostMessage({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    skillTestRunId: 'run-1',
    skillTestCaseId: 'case-1',
    visibility: 'public',
    content: 'scoped ok',
  });

  assert.equal(okPost.ok, true);
  assert.equal(context.auth.validated, true);
  assert.equal(context.auth.validatedCount, 1);
  assert.deepEqual(
    context.auth.rejects.map((entry) => entry.reason),
    ['missing_case_binding', 'case_binding_mismatch']
  );
});

test('agent tool bridge expires invocation auth tokens', (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-auth-expiry-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'auth-expiry');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      authScope: 'skill-test',
      caseId: 'case-expired',
      runId: 'run-expired',
      expiresAt: '2000-01-01T00:00:00.000Z',
      dryRun: true,
    })
  );

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        skillTestRunId: 'run-expired',
        skillTestCaseId: 'case-expired',
        visibility: 'public',
        content: 'too late',
      }),
    (error) => error && error.statusCode === 401
  );

  assert.equal(context.auth.rejects.length, 1);
  assert.equal(context.auth.rejects[0].reason, 'token_expired');
});

test('agent tool bridge appends tool-call telemetry events when runStore + stage taskId are available', (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-telemetry-');
  const sqlitePath = path.join(tempDir, 'telemetry.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const runStore = createSqliteRunStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      runStore.close();
    } catch {}
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'telemetry');
  const taskId = 'task-tool-telemetry';
  fixture.stage.taskId = taskId;
  runStore.createTask({
    taskId,
    kind: 'conversation_agent_reply',
    title: 'Telemetry Task',
    status: 'running',
    metadata: { source: 'test' },
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      runStore,
    })
  );

  const okPost = bridge.handlePostMessage({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    visibility: 'public',
    content: 'Hello tool telemetry',
  });

  assert.equal(okPost.ok, true);

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        visibility: 'public',
        content: '',
      }),
    (error) => error && error.statusCode === 400
  );

  const events = runStore.listTaskEvents(taskId);
  const toolEvents = events.filter((event) => event && event.event_type === 'agent_tool_call');

  assert.ok(toolEvents.length >= 2);
  assert.ok(toolEvents.some((event) => event && event.payload && event.payload.tool === 'send-public' && event.payload.status === 'succeeded'));
  assert.ok(toolEvents.some((event) => event && event.payload && event.payload.tool === 'send-public' && event.payload.status === 'failed'));
});

test('agent tool bridge broadcasts live tool events for started and finished bridge steps', (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-live-events-');
  const sqlitePath = path.join(tempDir, 'bridge-live-events.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const liveEvents = [];
  const bridge = createAgentToolBridge({
    store,
    agentDir: tempDir,
    broadcastEvent(eventName, payload) {
      if (eventName === 'conversation_tool_event') {
        liveEvents.push({ eventName, payload });
      }
    },
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'live-events');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const response = bridge.handlePostMessage({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    visibility: 'public',
    content: 'Live bridge event test',
  });

  assert.equal(response.ok, true);
  assert.ok(liveEvents.length >= 2);
  assert.ok(
    liveEvents.some(
      (entry) =>
        entry &&
        entry.payload &&
        entry.payload.phase === 'started' &&
        entry.payload.step &&
        entry.payload.step.toolName === 'send-public' &&
        entry.payload.step.status === 'running' &&
        entry.payload.step.requestSummary &&
        entry.payload.step.requestSummary.visibility === 'public'
    )
  );
  assert.ok(
    liveEvents.some(
      (entry) =>
        entry &&
        entry.payload &&
        entry.payload.phase === 'updated' &&
        entry.payload.step &&
        entry.payload.step.toolName === 'send-public' &&
        entry.payload.step.status === 'succeeded'
    )
  );
});

test('agent tool trellis-init previews and applies a scaffold under the active project', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const preview = bridge.handleTrellisInit({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    taskName: 'demo',
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.applied, false);
  assert.equal(fs.existsSync(path.join(projectDir, '.trellis')), false);
  assert.ok(Array.isArray(preview.operations));
  assert.ok(preview.operations.length > 0);

  const applied = bridge.handleTrellisInit({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    taskName: 'demo',
    confirm: true,
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.ok(fs.existsSync(path.join(projectDir, '.trellis', 'workflow.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.trellis', 'tasks', 'demo', 'prd.md')));
});

test('agent tool trellis-init refuses to follow symlinks inside .trellis', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-init-symlink-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const trellisDir = path.join(projectDir, '.trellis');
  fs.mkdirSync(trellisDir, { recursive: true });

  const externalDir = path.join(tempDir, 'external-target');
  fs.mkdirSync(externalDir, { recursive: true });

  const tasksLink = path.join(trellisDir, 'tasks');

  try {
    fs.symlinkSync(externalDir, tasksLink, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`symlink creation not supported in this environment: ${error && error.message ? error.message : error}`);
    return;
  }

  const fixture = createPublicInvocationFixture(store, 'trellis-init-symlink');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisInit({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        taskName: 'demo',
        confirm: true,
      }),
    (err) => err && err.statusCode === 400
  );

  assert.equal(fs.existsSync(path.join(trellisDir, 'workflow.md')), false);
});

test('agent tool trellis-init rejects directory collisions before writing', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-init-dir-collision-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(path.join(projectDir, '.trellis', 'tasks', 'demo', 'prd.md'), { recursive: true });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-init-dir-collision');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.equal(fs.existsSync(path.join(projectDir, '.trellis', 'workflow.md')), false);

  assert.throws(
    () =>
      bridge.handleTrellisInit({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        taskName: 'demo',
        confirm: true,
        force: true,
      }),
    (error) => error && error.statusCode === 400
  );

  assert.equal(fs.existsSync(path.join(projectDir, '.trellis', 'workflow.md')), false);
  assert.equal(fs.existsSync(path.join(projectDir, '.trellis', '.gitignore')), false);
});

test('agent tool trellis-init rejects invocations without an active projectDir', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-init-missing-project-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-init-missing-project');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir: '',
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisInit({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        taskName: 'demo',
      }),
    (error) => error && error.statusCode === 409
  );
});

test('agent tool trellis-init rejects when .trellis exists as a file', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-init-root-file-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.trellis'), 'not a directory', 'utf8');

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-init-root-file');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisInit({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        taskName: 'demo',
        confirm: true,
      }),
    (error) => error && error.statusCode === 409
  );
});

test('agent tool trellis-write previews and writes files under .trellis', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-write-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-write');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const preview = bridge.handleTrellisWrite({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    relativePath: '.trellis/tasks/demo/prd.md',
    content: '# Hello\n\nFrom agent.\n',
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.applied, false);
  assert.equal(fs.existsSync(path.join(projectDir, '.trellis')), false);
  assert.ok(Array.isArray(preview.operations));
  assert.ok(preview.operations.some((op) => op.path === '.trellis/tasks/demo/prd.md'));

  const applied = bridge.handleTrellisWrite({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    relativePath: '.trellis/tasks/demo/prd.md',
    content: '# Hello\n\nFrom agent.\n',
    confirm: true,
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.ok(fs.existsSync(path.join(projectDir, '.trellis', 'tasks', 'demo', 'prd.md')));
  assert.equal(fs.readFileSync(path.join(projectDir, '.trellis', 'tasks', 'demo', 'prd.md'), 'utf8'), '# Hello\n\nFrom agent.\n');

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '../oops.txt',
        content: 'nope',
        confirm: true,
      }),
    (error) => error && error.statusCode === 400
  );

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        files: [
          { relativePath: '.trellis/tasks/demo/extra.md', content: 'ok' },
          { relativePath: '../oops.txt', content: 'nope' },
        ],
        confirm: true,
        force: true,
      }),
    (error) => error && error.statusCode === 400
  );

  assert.equal(fs.existsSync(path.join(projectDir, '.trellis', 'tasks', 'demo', 'extra.md')), false);

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '.trellis//',
        content: 'nope',
        confirm: true,
        force: true,
      }),
    (error) => error && error.statusCode === 400
  );

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '.trellis/.',
        content: 'nope',
        confirm: true,
        force: true,
      }),
    (error) => error && error.statusCode === 400
  );

  fs.mkdirSync(path.join(projectDir, '.trellis', 'spec'), { recursive: true });

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '.trellis/spec',
        content: 'nope',
        confirm: true,
        force: true,
      }),
    (error) => error && error.statusCode === 400
  );
});

test('agent tool trellis-write rejects when .trellis exists as a file', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-write-root-file-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.trellis'), 'not a directory', 'utf8');

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-write-root-file');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '.trellis/tasks/demo/prd.md',
        content: '# Hello\n',
        confirm: true,
      }),
    (error) => error && error.statusCode === 409
  );
});

test('agent tool trellis-write rejects invocations without an active projectDir', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-write-missing-project-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-write-missing-project');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir: '',
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '.trellis/tasks/demo/prd.md',
        content: '# Hello\n',
      }),
    (error) => error && error.statusCode === 409
  );
});

test('agent tool bridge no longer exposes read-skill compatibility handler', (t) => {
  const tempDir = withTempDir('caff-agent-tool-no-read-skill-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  assert.equal(typeof bridge.handleReadSkill, 'undefined');
});

test('agent tool read-context keeps the current turn user message visible', (t) => {
  const tempDir = withTempDir('caff-agent-tool-context-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'context');
  const baseTimestamp = Date.parse(fixture.assistantMessage.createdAt || Date.now());
  const userMessage = store.createMessage({
    id: 'bridge-user-message-context',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'user',
    senderName: 'You',
    content: '@BridgeAgent #execute 请继续这个方案',
    status: 'completed',
    createdAt: new Date(baseTimestamp + 1000).toISOString(),
  });

  store.updateMessage(fixture.assistantMessage.id, {
    content: '第一条中间回复',
    status: 'completed',
  });
  store.createMessage({
    id: 'bridge-extra-message-context-1',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'assistant',
    agentId: fixture.agent.id,
    senderName: fixture.agent.name,
    content: '第二条中间回复',
    status: 'completed',
    createdAt: new Date(baseTimestamp + 2000).toISOString(),
  });
  store.createMessage({
    id: 'bridge-extra-message-context-2',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'assistant',
    agentId: fixture.agent.id,
    senderName: fixture.agent.name,
    content: '第三条中间回复',
    status: 'completed',
    createdAt: new Date(baseTimestamp + 3000).toISOString(),
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      userMessageId: userMessage.id,
      promptUserMessage: {
        ...userMessage,
        content: '@BridgeAgent 请继续这个方案',
      },
      conversationAgents: store.getConversation(fixture.conversation.id).agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const requestUrl = new URL('http://127.0.0.1/api/agent-tools/context');
  requestUrl.searchParams.set('invocationId', context.invocationId);
  requestUrl.searchParams.set('callbackToken', context.callbackToken);
  requestUrl.searchParams.set('publicLimit', '2');

  const result = bridge.handleReadContext(requestUrl);

  assert.equal(result.ok, true);
  assert.equal(result.latestUserMessage.id, userMessage.id);
  assert.equal(result.latestUserMessage.content, '@BridgeAgent 请继续这个方案');
  assert.deepEqual(
    result.publicMessages.map((message) => message.id),
    [userMessage.id, 'bridge-extra-message-context-1', 'bridge-extra-message-context-2']
  );
  assert.equal(result.publicMessages[0].content, '@BridgeAgent 请继续这个方案');
});

test('agent tool search-messages returns scoped public recall results', (t) => {
  const tempDir = withTempDir('caff-agent-tool-search-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'search');
  const otherAgent = store.saveAgent({
    id: 'bridge-search-other-agent',
    name: 'Bridge Search Other Agent',
    personaPrompt: 'Reply briefly too.',
  });
  const otherConversation = store.createConversation({
    id: 'bridge-conversation-search-other',
    title: 'Bridge Search Other',
    participants: [fixture.agent.id],
  });

  store.createMessage({
    id: 'bridge-search-hit-1',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'user',
    senderName: 'You',
    content: 'Hermes memory retrieval is useful here.',
    status: 'completed',
  });
  store.createMessage({
    id: 'bridge-search-hit-2',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'assistant',
    agentId: fixture.agent.id,
    senderName: fixture.agent.name,
    content: 'Hermes recall should stay scoped.',
    status: 'completed',
  });
  store.createMessage({
    id: 'bridge-search-hit-cjk',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'user',
    senderName: 'You',
    content: 'Hermes 是一个开源项目。',
    status: 'completed',
  });
  store.createMessage({
    id: 'bridge-search-hit-other-agent',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'assistant',
    agentId: otherAgent.id,
    senderName: otherAgent.name,
    content: 'Hermes was mentioned by another agent here.',
    status: 'completed',
  });
  store.createMessage({
    id: 'bridge-search-miss-other',
    conversationId: otherConversation.id,
    turnId: 'bridge-search-turn-other',
    role: 'user',
    senderName: 'Other User',
    content: 'Hermes appears in another conversation.',
    status: 'completed',
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const result = bridge.handleSearchMessages({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    query: 'Hermes',
    limit: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.scope, 'conversation-public');
  assert.equal(result.query, 'Hermes');
  assert.equal(result.resultCount, 1);
  assert.ok(result.searchMode === 'fts5' || result.searchMode === 'like');
  assert.equal(Array.isArray(result.results), true);
  assert.equal(result.results[0].conversationId, fixture.conversation.id);
  assert.equal(result.results.some((entry) => entry.messageId === 'bridge-search-miss-other'), false);
  assert.match(result.results[0].snippet, /Hermes/u);

  const cjkResult = bridge.handleSearchMessages({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    query: 'Hermes 开源项目',
    limit: 5,
  });

  assert.equal(cjkResult.ok, true);
  assert.equal(cjkResult.scope, 'conversation-public');
  assert.equal(cjkResult.query, 'Hermes 开源项目');
  assert.equal(cjkResult.resultCount >= 1, true);
  assert.equal(cjkResult.results.some((entry) => entry.messageId === 'bridge-search-hit-cjk'), true);
  assert.equal(cjkResult.results.some((entry) => entry.messageId === 'bridge-search-miss-other'), false);
  if (cjkResult.searchMode === 'like') {
    assert.equal(cjkResult.diagnostics.some((entry) => entry && entry.code === 'fts5_no_match_fallback'), true);
  }

  const speakerResult = bridge.handleSearchMessages({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    speaker: fixture.agent.name,
    limit: 5,
  });

  assert.equal(speakerResult.ok, true);
  assert.equal(speakerResult.query, '');
  assert.equal(speakerResult.scope, 'conversation-public');
  assert.equal(speakerResult.filters.speaker, fixture.agent.name);
  assert.equal(speakerResult.searchMode, 'filtered');
  assert.equal(speakerResult.results.every((entry) => entry.senderName === fixture.agent.name), true);
  assert.equal(speakerResult.results.some((entry) => entry.messageId === 'bridge-search-hit-2'), true);
  assert.equal(speakerResult.results.some((entry) => entry.messageId === 'bridge-search-hit-other-agent'), false);

  const agentFilteredResult = bridge.handleSearchMessages({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    query: 'Hermes',
    agentId: otherAgent.id,
    limit: 5,
  });

  assert.equal(agentFilteredResult.ok, true);
  assert.equal(agentFilteredResult.filters.agentId, otherAgent.id);
  assert.equal(agentFilteredResult.resultCount, 1);
  assert.equal(agentFilteredResult.results[0].messageId, 'bridge-search-hit-other-agent');
});

test('agent tool memory cards save durable local-user scope and stay agent-scoped', (t) => {
  const tempDir = withTempDir('caff-agent-tool-memory-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'memory');
  const otherAgent = store.saveAgent({
    id: 'bridge-memory-other-agent',
    name: 'Other Memory Agent',
    personaPrompt: 'Stay scoped.',
  });
  const secondConversation = store.createConversation({
    id: 'bridge-memory-conversation-second',
    title: 'Bridge Memory Second',
    participants: [fixture.agent.id, otherAgent.id],
  });

  store.updateConversation(fixture.conversation.id, {
    participants: [fixture.agent.id, otherAgent.id],
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: store.getConversation(fixture.conversation.id).agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const saved = bridge.handleSaveMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    title: 'preference',
    content: 'User prefers retrieval-first experiments.',
    ttlDays: 14,
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.scope, 'local-user-agent');
  assert.equal(saved.card.title, 'preference');
  assert.equal(saved.card.agentId, fixture.agent.id);
  assert.equal(saved.card.scope, 'local-user-agent');
  assert.equal(saved.card.conversationId, null);
  assert.equal(saved.cardCount, 1);

  const memoriesUrl = new URL('http://127.0.0.1/api/agent-tools/memories');
  memoriesUrl.searchParams.set('invocationId', context.invocationId);
  memoriesUrl.searchParams.set('callbackToken', context.callbackToken);
  const listed = bridge.handleListMemories(memoriesUrl);

  assert.equal(listed.ok, true);
  assert.equal(listed.scope, 'agent-visible');
  assert.deepEqual(listed.scopes, ['conversation-agent', 'local-user-agent']);
  assert.equal(listed.cardCount, 1);
  assert.equal(listed.cards[0].title, 'preference');
  assert.equal(listed.cards[0].scope, 'local-user-agent');

  const secondAssistantMessage = store.createMessage({
    id: 'bridge-memory-second-assistant-message',
    conversationId: secondConversation.id,
    turnId: 'bridge-memory-second-turn',
    role: 'assistant',
    agentId: fixture.agent.id,
    senderName: fixture.agent.name,
    content: 'Continuing the durable memory check.',
    status: 'completed',
  });
  const secondContext = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: secondConversation.id,
      turnId: secondAssistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: secondAssistantMessage.id,
      conversationAgents: store.getConversation(secondConversation.id).agents,
      stage: fixture.stage,
      turnState: {
        ...fixture.turnState,
        conversationId: secondConversation.id,
        turnId: secondAssistantMessage.turnId,
      },
    })
  );
  const secondMemoriesUrl = new URL('http://127.0.0.1/api/agent-tools/memories');
  secondMemoriesUrl.searchParams.set('invocationId', secondContext.invocationId);
  secondMemoriesUrl.searchParams.set('callbackToken', secondContext.callbackToken);
  const crossConversationList = bridge.handleListMemories(secondMemoriesUrl);

  assert.equal(crossConversationList.cardCount, 1);
  assert.equal(crossConversationList.cards[0].scope, 'local-user-agent');
  assert.equal(crossConversationList.cards[0].title, 'preference');

  const otherCards = store.listVisibleMemoryCards(secondConversation.id, otherAgent.id);
  assert.equal(otherCards.length, 0);

  assert.throws(
    () =>
      bridge.handleSaveMemory({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        title: 'secret',
        content: 'API key is abc123',
      }),
    /Do not save secrets/u
  );
});

test('agent tool bridge keeps case-distinct overlay and durable memory titles visible', (t) => {
  const tempDir = withTempDir('caff-agent-tool-memory-case-visible-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'memory-case-visible');
  store.saveLocalUserMemoryCard(fixture.agent.id, {
    title: 'Preference',
    content: 'Durable uppercase preference.',
    ttlDays: 30,
  });
  store.saveConversationMemoryCard(fixture.conversation.id, fixture.agent.id, {
    title: 'preference',
    content: 'Conversation lowercase preference.',
    ttlDays: 7,
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const listUrl = new URL('http://127.0.0.1/api/agent-tools/memories');
  listUrl.searchParams.set('invocationId', context.invocationId);
  listUrl.searchParams.set('callbackToken', context.callbackToken);
  const listed = bridge.handleListMemories(listUrl);

  assert.equal(listed.ok, true);
  assert.equal(listed.cardCount, 2);
  assert.deepEqual(
    listed.cards.map((card) => ({ title: card.title, scope: card.scope })),
    [
      { title: 'preference', scope: 'conversation-agent' },
      { title: 'Preference', scope: 'local-user-agent' },
    ]
  );
});

test('agent tool memory cards update and forget durable local-user scope safely', (t) => {
  const tempDir = withTempDir('caff-agent-tool-memory-mutation-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'memory-mutation');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const saved = bridge.handleSaveMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    title: 'preference',
    content: 'User prefers retrieval-first rollouts.',
    ttlDays: 30,
  });

  const updated = bridge.handleUpdateMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    title: 'preference',
    content: 'User now prefers answer-first replies.',
    reason: 'User corrected this durable preference',
    expectedUpdatedAt: saved.card.updatedAt,
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.scope, 'local-user-agent');
  assert.equal(updated.action, 'update');
  assert.equal(updated.card.content, 'User now prefers answer-first replies.');
  assert.equal(updated.card.status, 'active');

  const listUrl = new URL('http://127.0.0.1/api/agent-tools/memories');
  listUrl.searchParams.set('invocationId', context.invocationId);
  listUrl.searchParams.set('callbackToken', context.callbackToken);
  const listedAfterUpdate = bridge.handleListMemories(listUrl);

  assert.equal(listedAfterUpdate.cardCount, 1);
  assert.equal(listedAfterUpdate.cards[0].content, 'User now prefers answer-first replies.');

  assert.throws(
    () =>
      bridge.handleUpdateMemory({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        title: 'preference',
        content: 'Stale overwrite should fail.',
        reason: 'Old snapshot',
        expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
      }),
    (error) => error && error.statusCode === 409
  );

  const forgotten = bridge.handleForgetMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    title: 'preference',
    reason: 'User said this should not persist',
    expectedUpdatedAt: updated.card.updatedAt,
  });

  assert.equal(forgotten.ok, true);
  assert.equal(forgotten.scope, 'local-user-agent');
  assert.equal(forgotten.action, 'forget');
  assert.equal(forgotten.card.status, 'deleted');
  assert.equal('content' in forgotten.card, false);

  const listedAfterForget = bridge.handleListMemories(listUrl);
  assert.equal(listedAfterForget.cardCount, 0);
});

test('agent tool bridge routes memory writes to invocation store overrides', (t) => {
  const liveDir = withTempDir('caff-agent-tool-live-store-');
  const isolatedDir = withTempDir('caff-agent-tool-isolated-store-');
  const liveStore = createChatAppStore({ agentDir: liveDir, sqlitePath: path.join(liveDir, 'live.sqlite') });
  const isolatedStore = createChatAppStore({ agentDir: isolatedDir, sqlitePath: path.join(isolatedDir, 'isolated.sqlite') });
  const bridge = createAgentToolBridge({ store: liveStore });

  t.after(() => {
    try {
      isolatedStore.close();
    } catch {}
    try {
      liveStore.close();
    } catch {}
    fs.rmSync(liveDir, { recursive: true, force: true });
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(liveStore, 'store-override');
  isolatedStore.saveAgent({
    id: fixture.agent.id,
    name: fixture.agent.name,
    personaPrompt: 'Reply briefly.',
  });
  isolatedStore.createConversation({
    id: fixture.conversation.id,
    title: fixture.conversation.title,
    participants: [fixture.agent.id],
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      store: isolatedStore,
      toolPolicy: { allowedTools: ['save-memory', 'list-memories'], rejects: [] },
    })
  );

  const saved = bridge.handleSaveMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    title: 'preference',
    content: 'User prefers isolated test worlds.',
    ttlDays: 30,
  });

  assert.equal(saved.ok, true);
  assert.equal(liveStore.listVisibleMemoryCards(fixture.conversation.id, fixture.agent.id, { limit: 6 }).length, 0);
  assert.equal(isolatedStore.listVisibleMemoryCards(fixture.conversation.id, fixture.agent.id, { limit: 6 }).length, 1);
});

test('agent tool bridge rejects blocked tools via invocation policy and records evidence', (t) => {
  const tempDir = withTempDir('caff-agent-tool-policy-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'policy');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir: tempDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      dryRun: true,
      toolPolicy: { allowedTools: ['read-context'], rejects: [] },
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        path: '.trellis/tasks/policy/prd.md',
        content: '# blocked',
      }),
    (error) => error && error.statusCode === 403
  );

  assert.equal(Array.isArray(context.policyRejects), true);
  assert.equal(context.policyRejects.length, 1);
  assert.equal(context.policyRejects[0].toolName, 'trellis-write');
});
