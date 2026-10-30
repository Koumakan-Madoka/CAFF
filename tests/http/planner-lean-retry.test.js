const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), test = require('node:test');
const { randomBytes } = require('node:crypto');
const { createTestServerApp: createServerApp } = require('../helpers/server-app');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { applySessionGoalAction, proposeSessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
isolateExternalIntegrations();
const model = { key: 'openai\u001fgpt-5', provider: 'openai', model: 'gpt-5', family: 'gpt', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] };
const criteria = [{ id: 'c', statement: 'Complete authoritative record', verifyBy: 'HTTP assertions' }];
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-lean-retry-'));
  const token = randomBytes(32).toString('base64url'); let release;
  const gate = new Promise(resolve => { release = resolve; }); const executions = [];
  const app = createServerApp({ host: '127.0.0.1', port: 0, agentDir: root, sqlitePath: path.join(root, 'chat.sqlite'), projectDir: root, uploadsDir: path.join(root, 'uploads'),
    plannerCredential: createInMemoryPlannerCredential({ token, plannerName: 'Retry Planner' }), modelCatalog: { getOptions: () => [model], invalidate() {} },
    executeConversationAgent: async input => { executions.push(input.turnState.executionLane || 'main'); await gate; return { stopTurn: true }; } });
  t.after(async () => { release(); await new Promise(resolve => app.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  app.store.saveCustomRoleConfig({ id: 'author', name: 'Author', personaPrompt: 'Synthetic only', provider: model.provider, model: model.model });
  const room = app.store.createConversation({ title: 'Lean retry', participants: ['author'] });
  await new Promise(resolve => app.start(resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const f = { app, room, base, token, executions, release };
  f.request = async (suffix, body, browser = false) => {
    const r = await fetch(base + '/api/conversations/' + room.id + '/' + suffix, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(browser ? { Origin: base, 'X-CAFF-CSRF-Token': bootstrap.apiSecurity.csrfToken } : { Authorization: 'Bearer ' + token }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await r.text();
    return { status: r.status, body: JSON.parse(text), text };
  };
  f.post = (body, browser = false) => f.request('messages', body, browser);
  return f;
}
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('synthetic condition did not become observable');
}
const countMessages = f => f.app.store.db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id=? AND role='user'").get(f.room.id).n;

// This is the concrete regression: createMessage already deduplicated storage,
// but submitConversationMessage rerouted its returned canonical row into side.
test('retry of an active main message acknowledges duplicate without enqueuing side work or rebroadcasting creation', async t => {
  const f = await fixture(t); const input = { content: '@Author synthetic main', clientRequestId: 'main-key' };
  const first = await f.post(input); assert.equal(first.status, 200); assert.equal(first.body.dispatchLane, 'main');
  await waitFor(() => f.executions.length === 1);
  let creates = 0; const create = f.app.store.createMessage.bind(f.app.store);
  f.app.store.createMessage = (...args) => { creates++; return create(...args); };
  const retries = await Promise.all(Array.from({ length: 5 }, () => f.post({ ...input, content: '  ' + input.content + '  ' })));
  assert.ok(retries.every(r => r.status === 200 && r.body.acceptedMessage.id === first.body.acceptedMessage.id));
  assert.equal(f.app.turnOrchestrator.getConversationMutationState(f.room.id).queuedAgentSlotCount, 0);
  assert.equal(creates, 0, 'duplicate is read-only; creation/broadcast path must not run'); assert.equal(countMessages(f), 1);
  for (const r of retries) { assert.equal(r.body.dispatch, 'duplicate'); assert.equal(r.body.dispatchLane, 'main'); assert.equal(r.body.dispatchTargetAgentId, null); }
});

test('retry of an independently queued side message preserves side identity and never adds a second waiter', async t => {
  const f = await fixture(t);
  await f.post({ content: '@Author occupy main', clientRequestId: 'main' }); await waitFor(() => f.executions.length === 1);
  const sideInput = { content: '@Author actual side', clientRequestId: 'side' };
  const side = await f.post(sideInput); assert.equal(side.body.dispatchLane, 'side');
  assert.equal(f.app.turnOrchestrator.getConversationMutationState(f.room.id).queuedAgentSlotCount, 1);
  const retry = await f.post(sideInput); assert.equal(retry.status, 200); assert.equal(retry.body.dispatch, 'duplicate');
  assert.equal(retry.body.dispatchLane, 'side'); assert.equal(retry.body.dispatchTargetAgentId, 'author');
  assert.equal(retry.body.acceptedMessage.id, side.body.acceptedMessage.id);
  assert.equal(f.app.turnOrchestrator.getConversationMutationState(f.room.id).queuedAgentSlotCount, 1); assert.equal(countMessages(f), 2);
});

test('planner response skips browser directory construction; browser write response is unchanged', async t => {
  const f = await fixture(t);
  const browser = await f.post({ content: '@Author browser', clientRequestId: 'browser' }, true);
  assert.equal(browser.status, 200); assert.ok(browser.body.conversation); assert.ok(browser.body.conversations); assert.ok(browser.body.runtime);
  f.app.store.listConversations = () => assert.fail('planner built UI response directory');
  f.app.store.listConversationTree = () => assert.fail('planner built UI tree');
  const r = await f.post({ content: '@Author planner', clientRequestId: 'planner' }); assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['conversationId', 'acceptedMessage', 'dispatch', 'dispatchLane', 'dispatchTargetAgentId'].sort());
  assert.equal(r.body.acceptedMessage.metadata.source, 'planner'); assert.equal(r.body.acceptedMessage.senderName, 'Retry Planner');
  assert.equal(r.body.acceptedMessage.content, undefined); assert.equal(r.text.includes('@Author planner'), false);
});

test('matching persistent retry bypasses current role/image preflight and strips embedded text, image paths and tool metadata', async t => {
  const f = await fixture(t), s = f.app.store;
  const message = s.createMessage({ conversationId: f.room.id, role: 'user', content: 'ORIGINAL_BODY', senderName: 'Original Planner', status: 'completed',
    metadata: { clientRequestId: 'persisted', source: 'planner', principal: { kind: 'planner', plannerId: 'local-planner', plannerName: 'Original Planner' } } });
  s.updateMessage(message.id, { metadata: { ...message.metadata, contentBlocks: [{ type: 'text', text: 'ORIGINAL_BODY' }, { type: 'image', imageId: 'prior-image', localPath: 'PRIVATE_PATH' }],
    toolTrace: { text: 'TOOL_BODY' }, routing: { agentIds: ['author'], strategy: 'explicit_mentions', executionMode: 'queue', extra: 'ROUTING_BODY' } } });
  s.retireRoleConfig('author');
  const before = countMessages(f);
  const r = await f.post({ content: 'ORIGINAL_BODY', imageIds: ['prior-image'], clientRequestId: 'persisted' });
  assert.equal(r.status, 200); assert.equal(r.body.dispatch, 'duplicate'); assert.equal(r.body.acceptedMessage.id, message.id);
  assert.equal(r.body.acceptedMessage.senderName, 'Original Planner'); assert.equal(countMessages(f), before);
  for (const marker of ['ORIGINAL_BODY', 'PRIVATE_PATH', 'TOOL_BODY', 'ROUTING_BODY', 'contentBlocks']) assert.equal(r.text.includes(marker), false);
  assert.equal(s.getMessage(message.id).metadata.contentBlocks[0].text, 'ORIGINAL_BODY', 'do not rewrite canonical content/metadata');
  for (const changed of [{ content: 'changed', imageIds: ['prior-image'] }, { content: 'ORIGINAL_BODY', imageIds: [] }]) {
    const rejected = await f.post({ ...changed, clientRequestId: 'persisted' });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'MESSAGE_IDEMPOTENCY_CONFLICT'); assert.equal(countMessages(f), before);
  }
});

test('a retry after a completed main turn never starts another terminal root', async t => {
  const f = await fixture(t), input = { content: '@Author complete before retry', clientRequestId: 'done' };
  const first = await f.post(input); f.release();
  await waitFor(() => f.app.turnOrchestrator.listTurnSummaries({ conversationId: f.room.id }).length === 0);
  const roots = () => f.app.store.db.prepare("SELECT COUNT(*) AS n FROM a2a_tasks WHERE kind IN ('conversation_turn','conversation_side_dispatch')").get().n;
  const before = roots(), r = await f.post(input); assert.equal(r.status, 200); assert.equal(r.body.dispatch, 'duplicate');
  assert.equal(r.body.acceptedMessage.id, first.body.acceptedMessage.id); assert.equal(roots(), before); assert.equal(f.executions.length, 1);
});

test('transactional planner acceptance returns duplicate status without changing the old row and rolls back failed writes', async t => {
  const f = await fixture(t), s = f.app.store;
  const payload = { conversationId: f.room.id, role: 'user', content: 'Atomic acceptance', status: 'completed', metadata: { clientRequestId: 'atomic', source: 'planner' } };
  const first = s.acceptPlannerMessage(payload); assert.equal(first.duplicate, false);
  const again = s.acceptPlannerMessage(payload); assert.equal(again.duplicate, true); assert.deepEqual(again.message, first.message);
  assert.throws(() => s.acceptPlannerMessage({ ...payload, content: 'different' }), e => e.code === 'MESSAGE_IDEMPOTENCY_CONFLICT');
  s.db.exec("CREATE TRIGGER fail_planner_message BEFORE INSERT ON chat_messages BEGIN SELECT RAISE(ABORT, 'synthetic message failure'); END");
  assert.throws(() => s.acceptPlannerMessage({ ...payload, metadata: { clientRequestId: 'failure' } }), /synthetic message failure/);
  assert.equal(countMessages(f), 1);
});

test('Goal GET returns full delivery records but never hydrates message bodies or previews, for planner and browser', async t => {
  const f = await fixture(t), s = f.app.store;
  applySessionGoalAction(s, f.room.id, { action: 'set', objective: 'Authoritative Goal', status: 'paused', acceptanceCriteria: criteria,
    decisions: { provisional: [{ id: 'decision', statement: 'Keep full definition' }] } });
  proposeSessionGoalAction(s, f.room.id, { action: 'pause', reason: 'Full proposal reason' }, { agentId: 'author', agentName: 'Author' });
  s.createMessage({ conversationId: f.room.id, role: 'assistant', content: 'HISTORY_BODY' + 'x'.repeat(100000), status: 'completed' });
  for (const name of ['getConversation', 'getConversationWithoutMessages', 'listConversations', 'listConversationTree', 'listMessages']) s[name] = () => assert.fail('Goal read hydrated ' + name);
  for (const browser of [false, true]) {
    const r = await f.request('goal', undefined, browser); assert.equal(r.status, 200);
    assert.equal(r.body.goal.acceptanceCriteria[0].statement, criteria[0].statement);
    assert.equal(r.body.goal.decisions.provisional[0].statement, 'Keep full definition'); assert.equal(r.body.proposal.reason, 'Full proposal reason');
    assert.equal(r.text.includes('HISTORY_BODY'), false);
    if (browser) { assert.deepEqual(r.body.conversation.messages, []); assert.equal(r.body.conversation.lastMessagePreview, '');
      assert.ok(r.body.conversations.every(c => !c.lastMessagePreview)); }
    else { assert.equal(r.body.conversation, undefined); assert.equal(r.body.conversations, undefined); }
  }
});

test('planner Goal autoContinuation contains correlation/owner but no repeated Goal, message body or global runtime', async t => {
  const f = await fixture(t);
  const r = await f.request('goal', { action: 'set', goalId: null, goalRevision: 0, objective: 'ACTIVE_GOAL_BODY', acceptanceCriteria: criteria, owner: { agentId: 'author' } });
  assert.equal(r.status, 200); const ack = r.body.autoContinuation; assert.equal(ack.scheduled, true);
  assert.deepEqual(ack.message.metadata.initialAgentIds, ['author']); assert.ok(ack.message.id);
  for (const field of ['runtime', 'goal', 'runner']) assert.equal(ack[field], undefined, field);
  assert.equal(ack.message.content, undefined); assert.equal(JSON.stringify(ack).includes('ACTIVE_GOAL_BODY'), false);
});

for (const capability of ['findMessageRetry', 'acceptPlannerMessage', 'getConversationGoalProjection', 'listConversationGoalHeaders']) {
  test('required lean capability fails closed: ' + capability, async t => {
    const f = await fixture(t); f.app.store[capability] = undefined;
    const goalRead = capability.includes('Goal');
    const r = goalRead ? await f.request('goal', undefined, true) : await f.post({ content: 'No write', clientRequestId: 'missing-capability' });
    assert.equal(r.status, 501); assert.equal(r.body.code, 'planner_projection_unavailable'); assert.equal(countMessages(f), 0);
  });
}
