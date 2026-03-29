const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
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
