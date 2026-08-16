const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');
const { proposePlan } = require('../../build/lib/agent-chat-tools');

const { withTempDir } = require('../helpers/temp-dir');

function createInvocationFixture(store, suffix) {
  const agent = store.saveCustomRoleConfig({
    id: `plan-agent-${suffix}`,
    name: `Plan Agent ${suffix}`,
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: `plan-conversation-${suffix}`,
    title: `Plan Conversation ${suffix}`,
    participants: [agent.id],
  });
  const assistantMessage = store.createMessage({
    id: `plan-message-${suffix}`,
    conversationId: conversation.id,
    turnId: `plan-turn-${suffix}`,
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Planning...',
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

  return { agent, conversation: fullConversation, assistantMessage, turnState, stage };
}

function registerPlanInvocation(bridge, fixture) {
  return bridge.registerInvocation(
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
}

function samplePlanDoc(status = 'pending') {
  return {
    nodes: [
      { id: 'n1', title: 'Storage', goal: 'plans table', status, depends_on: [], kind: 'work', branch: 'feat/plan-storage' },
      { id: 'n2', title: 'API', goal: 'plan API', status: 'pending', depends_on: ['n1'], kind: 'work', branch: 'feat/plan-api' },
      { id: 'n3', title: 'Merge', goal: 'merge branches', status: 'pending', depends_on: ['n1', 'n2'], kind: 'merge' },
    ],
  };
}

test('propose-plan bridge handler creates a draft plan and broadcasts the update', (t) => {
  const tempDir = withTempDir('caff-propose-plan-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'plan.sqlite') });
  const events = [];
  const bridge = createAgentToolBridge({ store, broadcastEvent: (type, payload) => events.push({ type, payload }) });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createInvocationFixture(store, 'create');
  const context = registerPlanInvocation(bridge, fixture);

  const result = bridge.handleProposePlan({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    doc: samplePlanDoc(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ownerConversationId, fixture.conversation.id);
  assert.equal(result.plan.status, 'draft');
  assert.equal(result.plan.version, 1);
  assert.equal(result.plan.doc.nodes.length, 3);

  const planEvent = events.find((event) => event.type === 'conversation_plan_updated');
  assert.ok(planEvent, 'expected conversation_plan_updated broadcast');
  assert.equal(planEvent.payload.conversationId, fixture.conversation.id);
  assert.equal(planEvent.payload.plan.id, result.plan.id);
});

test('propose-plan bridge handler surfaces validation issues for self-repair', (t) => {
  const tempDir = withTempDir('caff-propose-plan-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'plan.sqlite') });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createInvocationFixture(store, 'invalid');
  const context = registerPlanInvocation(bridge, fixture);

  assert.throws(
    () =>
      bridge.handleProposePlan({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        doc: {
          nodes: [
            { id: 'a', depends_on: ['b'] },
            { id: 'b', depends_on: ['a'] },
          ],
        },
      }),
    (error) =>
      error
      && error.statusCode === 422
      && Array.isArray(error.issues)
      && error.issues.some((issue) => issue.code === 'plan_cycle')
  );

  assert.throws(
    () =>
      bridge.handleProposePlan({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        doc: null,
      }),
    (error) => error && error.statusCode === 400
  );

  // nothing persisted after failed attempts
  assert.equal(store.getPlanForConversation(fixture.conversation.id).plan, null);
});

test('propose-plan bridge handler enforces optimistic concurrency and active structural lock', (t) => {
  const tempDir = withTempDir('caff-propose-plan-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'plan.sqlite') });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createInvocationFixture(store, 'lifecycle');
  const context = registerPlanInvocation(bridge, fixture);

  const created = bridge.handleProposePlan({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    doc: samplePlanDoc(),
  });

  assert.throws(
    () =>
      bridge.handleProposePlan({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        doc: samplePlanDoc(),
        version: created.plan.version + 5,
      }),
    (error) => error && error.statusCode === 409
  );

  store.activatePlanForConversation(fixture.conversation.id);

  // status-only update is allowed while active
  const statusUpdate = bridge.handleProposePlan({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    doc: samplePlanDoc('doing'),
    version: 2,
  });
  assert.equal(statusUpdate.plan.status, 'active');
  assert.equal(statusUpdate.plan.doc.nodes[0].status, 'doing');

  // structural change is rejected
  const structuralDoc = samplePlanDoc('doing');
  structuralDoc.nodes[1].goal = 'rewritten goal';
  assert.throws(
    () =>
      bridge.handleProposePlan({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        doc: structuralDoc,
        version: 3,
      }),
    (error) =>
      error
      && error.statusCode === 409
      && Array.isArray(error.issues)
      && error.issues.some((issue) => issue.code === 'plan_locked_field_changed')
  );
});

test('propose-plan CLI helper posts the parsed doc to the agent-tools route', async (t) => {
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(String(options.body)) });
    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, plan: { id: 'plan-1', version: 1 } });
      },
    };
  });

  const config = {
    apiUrl: 'http://127.0.0.1:3100',
    invocationId: 'invocation-plan',
    callbackToken: 'token-plan',
  };

  const stream = new PassThrough();
  stream.end(JSON.stringify(samplePlanDoc()));

  await proposePlan(config, { 'content-stdin': true, version: '3' }, { stream });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:3100/api/agent-tools/propose-plan');
  assert.equal(requests[0].body.invocationId, 'invocation-plan');
  assert.equal(requests[0].body.callbackToken, 'token-plan');
  assert.equal(requests[0].body.version, 3);
  assert.equal(requests[0].body.doc.nodes.length, 3);
});

test('propose-plan CLI helper rejects empty and malformed docs', async () => {
  const config = {
    apiUrl: 'http://127.0.0.1:3100',
    invocationId: 'invocation-plan',
    callbackToken: 'token-plan',
  };

  await assert.rejects(() => proposePlan(config, {}, {}), /requires --content/);

  const badJson = new PassThrough();
  badJson.end('{not json');
  await assert.rejects(() => proposePlan(config, { 'content-stdin': true }, { stream: badJson }), /valid JSON/);

  const arrayDoc = new PassThrough();
  arrayDoc.end('[1,2]');
  await assert.rejects(() => proposePlan(config, { 'content-stdin': true }, { stream: arrayDoc }), /JSON object/);

  const goodDoc = new PassThrough();
  goodDoc.end('{}');
  await assert.rejects(
    () => proposePlan(config, { 'content-stdin': true, version: 'abc' }, { stream: goodDoc }),
    /positive integer/
  );
});
