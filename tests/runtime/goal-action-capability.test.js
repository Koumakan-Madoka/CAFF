const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');
const { applySessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
const { withTempDir } = require('../helpers/temp-dir');

const actions = ['pause', 'resume', 'complete', 'clear', 'accept', 'reject'];
async function loadTool() {
  const extension = await import(pathToFileURL(path.resolve('lib/pi-extensions/caff-capabilities.mjs')).href);
  const tools = [];
  extension.default({ registerTool: tool => tools.push(tool) });
  const tool = tools.find(tool => tool.name === 'goal_action');
  assert.ok(tool, 'goal_action must be registered');
  return tool;
}

function fixture(t, options = {}) {
  const root = withTempDir('caff-goal-action-');
  const store = createChatAppStore({ agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') });
  t.after(() => store.close());
  const worker = store.saveCustomRoleConfig({ id: 'goal-worker', name: 'Worker', personaPrompt: 'Implement.' });
  const verifier = store.saveCustomRoleConfig({ id: 'goal-verifier', name: 'Verifier', personaPrompt: 'Review.' });
  const third = store.saveCustomRoleConfig({ id: 'goal-third', name: 'Third', personaPrompt: 'Observe.' });
  const room = store.createConversation({ title: 'Goal capability fixture', projectScopeId: 'goal-project', participants: [worker.id, verifier.id, third.id] });
  const result = applySessionGoalAction(store, room.id, {
    action: 'set', objective: 'Deliver a structured action', ownerAgentId: worker.id,
    acceptanceCriteria: [{ id: 'c1', statement: 'Action returns a result', verifyBy: 'Bridge regression', status: 'passed', evidenceRefs: ['e1'] }],
    workItems: [{ id: 'w1', text: 'Implement', status: 'done' }],
    evidence: [{ id: 'e1', criterionIds: ['c1'], kind: 'test', summary: 'Synthetic passing evidence' }],
  });
  if (options.paused) applySessionGoalAction(store, room.id, { action: 'pause' });
  if (options.binding) store.updateConversation(room.id, { metadata: {
    ...store.getConversation(room.id).metadata,
    dagNodeGoalBinding: { planId: 'plan1', nodeId: 'n1', workerId: worker.id, verifierId: verifier.id },
  } });
  if (options.planner) store.updateConversation(room.id, { metadata: {
    ...store.getConversation(room.id).metadata,
    sessionGoalPlannerBinding: { goalId: result.goal.goalId, plannerId: 'local-planner', plannerName: 'Planner', boundAt: result.goal.updatedAt },
  } });
  const events = [];
  const bridge = createAgentToolBridge({ store, broadcastEvent: (name, payload) => events.push({ name, payload }) });
  const auth = agent => {
    const context = bridge.registerInvocation(bridge.createInvocationContext({
      conversationId: room.id, agentId: agent.id, agentName: agent.name,
      conversationAgents: store.getConversation(room.id).agents, stage: { status: 'running' },
    }));
    return { invocationId: context.invocationId, callbackToken: context.callbackToken };
  };
  const workerAuth = auth(worker), verifierAuth = auth(verifier), thirdAuth = auth(third);
  const invoke = (action, reason = 'Synthetic reason', credentials = workerAuth, extra = {}) => bridge.handlePiCapability('goal_action', {
    ...credentials, arguments: { action, reason, ...extra },
  });
  return { store, room, bridge, events, worker, verifier, workerAuth, verifierAuth, thirdAuth, invoke };
}

test('goal_action publishes only action and required reason with the 1000-character contract', async () => {
  const tool = await loadTool();
  assert.deepEqual(Object.keys(tool.parameters.properties), ['action', 'reason']);
  assert.deepEqual(tool.parameters.required, ['action', 'reason']);
  assert.deepEqual(tool.parameters.properties.action.enum, actions);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.reason.maxLength, 1000);
  assert.equal(tool.parameters.properties.reason.minLength, 1);
  assert.match(tool.parameters.properties.reason.description, /trim.*UTF-16/);
});

test('goal_action parameter preparation rejects invalid or overlong UTF-16 before HTTP; 1000 passes', async t => {
  const tool = await loadTool();
  let requests = 0;
  t.mock.method(global, 'fetch', async (_url, options) => {
    requests++;
    const args = JSON.parse(options.body).arguments;
    return new Response(JSON.stringify({ ok: true, result: { ok: true, proposal: args } }));
  });
  for (const [name, value] of Object.entries({ CAFF_CHAT_API_URL: 'http://127.0.0.1:39999', CAFF_CHAT_INVOCATION_ID: 'test-invocation', CAFF_CHAT_CALLBACK_TOKEN: 'test-callback' })) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  for (const args of [
    { action: 'pause', reason: 'x'.repeat(1001) },
    { action: 'pause', reason: '😀'.repeat(501) },
    { action: 'pause', reason: '   ' }, { action: 'pause' },
    { action: 'set', reason: 'Short' }, { action: 'pause', reason: 1 },
    { action: 'pause', reason: 'Short', goal: {} },
  ]) {
    assert.throws(() => tool.prepareArguments(args), /goal_action|reason|action/);
    await assert.rejects(tool.execute('bad', args), /goal_action|reason|action/);
  }
  assert.equal(requests, 0);
  for (const reason of ['x'.repeat(1000), '😀'.repeat(500), '  ' + 'x'.repeat(1000) + '\n']) {
    const args = tool.prepareArguments({ action: 'pause', reason });
    assert.equal(args.reason.length, 1000);
    const result = await tool.execute('good', args);
    assert.equal(result.details.proposal.reason, reason.trim());
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  }
  assert.equal(requests, 3);
});

for (const action of actions.slice(0, 4)) test(`goal_action ${action} enters the original proposal service`, async t => {
  const h = fixture(t, { paused: action === 'resume' });
  const result = await h.invoke(action);
  assert.equal(result.ok, true);
  assert.equal(result.proposal.action, action);
  assert.equal(result.proposal.reason, 'Synthetic reason');
  assert.deepEqual(result.goal, h.store.getConversation(h.room.id).metadata.sessionGoal);
  assert.equal(h.events.some(e => e.name === 'conversation_goal_proposal_updated'), true);
  assert.equal(result.proposal.proposedBy.agentId, h.worker.id);
});

for (const action of ['accept', 'reject']) test(`goal_action DAG ${action} preserves worker/verifier and durable ruling rules`, async t => {
  const h = fixture(t, { binding: true });
  await h.invoke('complete');
  await assert.rejects(h.invoke(action), e => e.statusCode === 403 && /self_review/.test(e.message));
  await assert.rejects(h.invoke(action, 'Third cannot rule', h.thirdAuth), e => e.statusCode === 403 && /dag_verifier_only/.test(e.message));
  const result = await h.invoke(action, 'Reviewed', h.verifierAuth);
  assert.equal(result.outcome, action === 'accept' ? 'accepted' : 'rejected');
  assert.equal(result.proposal, null);
  const metadata = h.store.getConversation(h.room.id).metadata;
  assert.equal(metadata.sessionGoal.status, action === 'accept' ? 'complete' : 'active');
  assert.equal(metadata.sessionGoalRuling.ruledBy.agentId, h.verifier.id);
  assert.equal(metadata.sessionGoalRuling.reason, 'Reviewed');
});

test('goal_action keeps planner authority, pending-proposal conflict and invocation authentication', async t => {
  const h = fixture(t, { planner: true });
  await assert.rejects(h.invoke('pause', 'Short', { ...h.workerAuth, callbackToken: 'wrong' }), e => e.statusCode === 401);
  const initial = await h.invoke('pause');
  // Original service allows technical draft replacement; it does not grant ruling authority.
  const replaced = await h.invoke('clear', 'Replacement proposal', h.verifierAuth);
  assert.notEqual(initial.proposal.id, replaced.proposal.id);
  assert.equal(h.store.getConversation(h.room.id).metadata.sessionGoalRuling.outcome, 'superseded');
  await assert.rejects(h.invoke('accept', 'Agent cannot replace planner', h.workerAuth), e => e.statusCode === 403 && /planner/i.test(e.message));
  assert.equal(h.store.getConversation(h.room.id).metadata.sessionGoalProposal.action, 'clear');
});

test('goal_action preserves stale pending-proposal revision conflicts', async t => {
  const h = fixture(t);
  await h.invoke('pause');
  const current = h.store.getConversation(h.room.id).metadata.sessionGoal;
  applySessionGoalAction(h.store, h.room.id, { ...current, action: 'update-delivery' });
  await assert.rejects(h.invoke('accept', 'Stale proposal', h.verifierAuth), e => e.statusCode === 409 && e.code === 'goal_revision_conflict');
  assert.equal(h.store.getConversation(h.room.id).metadata.sessionGoal.status, 'active');
});

test('goal_action validates direct HTTP arguments too, without mutating the Goal', async t => {
  const h = fixture(t);
  for (const args of [
    { action: 'pause', reason: 'x'.repeat(1001) }, { action: 'pause', reason: '😀'.repeat(501) },
    { action: 'pause', reason: '' }, { action: 'pause' }, { action: 'pause', reason: 'Short', goal: {} },
    { action: 'revise', reason: 'Short' }, { action: ['pause'], reason: 'Short' },
  ]) await assert.rejects(h.bridge.handlePiCapability('goal_action', { ...h.workerAuth, arguments: args }), e => e.statusCode === 400);
  assert.equal(h.store.getConversation(h.room.id).metadata.sessionGoalProposal, undefined);
  const result = await h.invoke('pause', ' ' + '😀'.repeat(500) + ' ');
  assert.equal(result.proposal.reason.length, 1000);
});

test('installed Pi preflight rejects overlong reasons before execute and lets a fake model retry short', async t => {
  const tool = await loadTool(), codingRoot = path.resolve('node_modules/@earendil-works/pi-coding-agent');
  const { Agent } = await import(pathToFileURL(path.join(codingRoot, 'node_modules/@earendil-works/pi-agent-core/dist/agent.js')).href);
  const { createAssistantMessageEventStream } = await import(pathToFileURL(path.join(codingRoot, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')).href);
  const { wrapToolDefinition } = await import(pathToFileURL(path.join(codingRoot, 'dist/core/tools/tool-definition-wrapper.js')).href);
  let executions = 0, modelCalls = 0;
  const calls = [
    { type: 'toolCall', id: 'too-long', name: 'goal_action', arguments: { action: 'pause', reason: 'x'.repeat(1001) } },
    { type: 'toolCall', id: 'surrogates', name: 'goal_action', arguments: { action: 'pause', reason: '😀'.repeat(501) } },
    { type: 'toolCall', id: 'retry-short', name: 'goal_action', arguments: { action: 'pause', reason: ' Short retry ' } },
  ];
  const agent = new Agent({
    initialState: {
      systemPrompt: 'Synthetic local parameter validation fixture.',
      model: { id: 'fake', provider: 'fake', api: 'openai-responses', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      thinkingLevel: 'off', messages: [],
      tools: [wrapToolDefinition({ ...tool, async execute(_id, args) {
        executions++; assert.equal(args.reason, 'Short retry');
        return { content: [{ type: 'text', text: 'Proposed' }], details: {} };
      } })],
    },
    getApiKey: () => 'synthetic-not-a-real-key',
    streamFn(_model, context) {
      if (modelCalls) {
        const last = context.messages.at(-1);
        assert.equal(last.role, 'toolResult');
        assert.equal(last.isError, modelCalls < 3);
        if (last.isError) assert.match(last.content[0].text, /1000.*UTF-16/);
      }
      const block = calls[modelCalls++];
      const message = { role: 'assistant', content: block ? [block] : [{ type: 'text', text: 'Finished' }], api: 'openai-responses', provider: 'fake', model: 'fake',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: block ? 'toolUse' : 'stop', timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); });
      return stream;
    },
  });
  await agent.prompt('Exercise local rejection and recovery; no real model.');
  assert.equal(modelCalls, 4);
  assert.equal(executions, 1);
});

test('goal_action returns facade HTTP errors to the model without retrying', async t => {
  const tool = await loadTool();
  for (const [name, value] of Object.entries({ CAFF_CHAT_API_URL: 'http://127.0.0.1:39999', CAFF_CHAT_INVOCATION_ID: 'test-invocation', CAFF_CHAT_CALLBACK_TOKEN: 'test-callback' })) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  let requests = 0;
  t.mock.method(global, 'fetch', async url => {
    requests++;
    assert.equal(String(url), 'http://127.0.0.1:39999/api/agent-tools/capabilities/goal_action');
    return new Response(JSON.stringify({ error: 'goal_proposal_self_review: denied' }), { status: 403 });
  });
  await assert.rejects(tool.execute('call', { action: 'accept', reason: 'Review' }), /goal_proposal_self_review/);
  assert.equal(requests, 1);
});
