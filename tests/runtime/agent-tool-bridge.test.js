const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../lib/chat-app-store');
const { createAgentToolBridge } = require('../../server/domain/runtime/agent-tool-bridge');

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
