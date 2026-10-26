const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { createTestServerApp } = require('../helpers/server-app');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { applySessionGoalAction, getSessionGoal, getSessionGoalProposal, proposeSessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
isolateExternalIntegrations();

const criterion = (id, risk) => ({ id, risk, statement: 'Deliver ' + id, verifyBy: 'Synthetic verification', status: 'pending' });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-high-risk-http-'));
  const token = randomBytes(32).toString('base64url');
  const app = createTestServerApp({ host: '127.0.0.1', port: 0, agentDir: root, sqlitePath: path.join(root, 'chat.sqlite'), projectDir: root,
    uploadsDir: path.join(root, 'uploads'), plannerCredential: createInMemoryPlannerCredential({ token }),
    modelCatalog: { getOptions: () => [{ provider: 'openai', model: 'gpt-5', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] }] },
    executeConversationAgent: async () => ({ stopTurn: true, terminationReason: 'synthetic' }) });
  t.after(async () => { await new Promise(resolve => app.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const author = app.store.saveCustomRoleConfig({ id: 'author', name: 'Author', personaPrompt: 'Synthetic', provider: 'openai', model: 'gpt-5' });
  const reviewer = app.store.saveCustomRoleConfig({ id: 'reviewer', name: 'Reviewer', personaPrompt: 'Synthetic', provider: 'openai', model: 'gpt-5' });
  const room = app.store.createConversation({ title: 'High-risk gate', participants: [{ agentId: author.id }, { agentId: reviewer.id }] });
  await new Promise(resolve => app.start(resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const invocation = app.agentToolBridge.registerInvocation(app.agentToolBridge.createInvocationContext({ conversationId: room.id, turnId: 'review-turn',
    agentId: reviewer.id, agentName: reviewer.name, conversationAgents: [author, reviewer] }));
  async function call(command, caller = 'planner') {
    const agent = caller === 'agent';
    const endpoint = agent ? '/api/agent-tools/goal/suggest' : `/api/conversations/${room.id}/goal`;
    const goal = getSessionGoal(app.store.getConversationWithoutMessages(room.id));
    const proposal = getSessionGoalProposal(app.store.getConversationWithoutMessages(room.id));
    const headers = { 'Content-Type': 'application/json', ...(agent ? {} : caller === 'planner'
      ? { Authorization: 'Bearer ' + token } : { Origin: base, 'X-CAFF-CSRF-Token': bootstrap.apiSecurity.csrfToken }) };
    const response = await fetch(base + endpoint, { method: 'POST', headers, body: JSON.stringify(agent
      ? { invocationId: invocation.invocationId, callbackToken: invocation.callbackToken, ...command }
      : { goalId: goal.goalId, goalRevision: goal.revision, proposalId: proposal?.id, ...command }) });
    return { status: response.status, body: await response.json() };
  }
  function snapshot() { return structuredClone(app.store.getConversationWithoutMessages(room.id).metadata); }
  function seed(risk = 'high') {
    applySessionGoalAction(app.store, room.id, { action: 'set', objective: 'Keep acceptance boundaries',
      acceptanceCriteria: [criterion('protected', risk), criterion('retained', 'normal')], workItems: [], evidence: [], ruledBy: { kind: 'user' } });
    applySessionGoalAction(app.store, room.id, { action: 'pause', ruledBy: { kind: 'user' } });
    return getSessionGoal(app.store.getConversationWithoutMessages(room.id));
  }
  function finish() {
    const goal = getSessionGoal(app.store.getConversationWithoutMessages(room.id));
    applySessionGoalAction(app.store, room.id, { action: 'update-delivery', goalRevision: goal.revision,
      acceptanceCriteria: goal.acceptanceCriteria.map(item => ({ id: item.id, status: 'passed', evidenceRefs: ['completion-proof'] })),
      evidence: [{ id: 'completion-proof', criterionIds: goal.acceptanceCriteria.map(item => item.id), summary: 'Synthetic completed acceptance' }],
      ruledBy: { kind: 'user' } });
    applySessionGoalAction(app.store, room.id, { action: 'complete', ruledBy: { kind: 'user' } });
    return getSessionGoal(app.store.getConversationWithoutMessages(room.id));
  }
  return { app, room, author, call, seed, finish, snapshot };
}
function change(goal, operation) {
  const acceptanceCriteria = operation === 'downgrade'
    ? goal.acceptanceCriteria.map(item => item.id === 'protected' ? { ...item, risk: 'normal' } : item)
    : goal.acceptanceCriteria.filter(item => item.id !== 'protected');
  return { ...goal, acceptanceCriteria, action: operation === 'replace' ? 'set' : operation === 'clear' ? 'clear' : 'revise', status: 'paused' };
}

for (const operation of ['downgrade', 'delete', 'replace', 'clear']) {
  test(`R2 planner direct ${operation} of a high-risk criterion returns 403 unchanged; user succeeds`, async t => {
    const f = await fixture(t), goal = f.seed();
    const command = change(goal, operation), before = f.snapshot();
    const blocked = await f.call(command);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'goal_high_risk_change_user_required');
    assert.deepEqual(f.snapshot(), before);
    assert.equal((await f.call(command, 'user')).status, 200);
    if (operation !== 'clear') assert.notDeepEqual(getSessionGoal(f.app.store.getConversationWithoutMessages(f.room.id)).acceptanceCriteria, goal.acceptanceCriteria);
  });
  for (const caller of ['planner', 'agent']) {
    test(`R2 ${caller} cannot accept high-risk ${operation}; proposal/ruling survive and user acceptance succeeds`, async t => {
      const f = await fixture(t), goal = f.seed();
      proposeSessionGoalAction(f.app.store, f.room.id, { ...change(goal, operation), reason: 'User decision requested' }, { agentId: f.author.id, agentName: f.author.name });
      const before = f.snapshot();
      const blocked = await f.call({ action: caller === 'agent' ? 'accept' : 'accept-proposal' }, caller);
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.code || blocked.body.error?.code, 'goal_high_risk_change_user_required');
      assert.deepEqual(f.snapshot(), before);
      assert.equal((await f.call({ action: 'accept-proposal' }, 'user')).status, 200);
    });
    test(`R2 ${caller} normal-risk ${operation} acceptance stays allowed`, async t => {
      const f = await fixture(t), goal = f.seed('normal');
      const command = operation === 'downgrade' ? { ...goal, action: 'revise', acceptanceCriteria: goal.acceptanceCriteria.map(item => ({ ...item, statement: 'Updated ' + item.statement })) }
        : change(goal, operation);
      proposeSessionGoalAction(f.app.store, f.room.id, command, { agentId: f.author.id, agentName: f.author.name });
      assert.equal((await f.call({ action: caller === 'agent' ? 'accept' : 'accept-proposal' }, caller)).status, 200);
    });
  }
}

const nextGoal = () => ({ action: 'set', objective: 'Next Goal in the same Room', status: 'paused',
  acceptanceCriteria: [criterion('next', 'normal')], workItems: [], evidence: [] });
for (const action of ['set', 'clear']) {
  test(`N8 planner direct ${action} can retire a completed high-risk Goal`, async t => {
    const f = await fixture(t); f.seed(); const completed = f.finish();
    const result = await f.call(action === 'set' ? nextGoal() : { action });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (action === 'clear') assert.equal(result.body.goal, null);
    else {
      assert.notEqual(result.body.goal.goalId, completed.goalId);
      assert.equal(result.body.goal.status, 'paused');
      assert.equal(result.body.goal.acceptanceCriteria[0].id, 'next');
    }
  });
  for (const caller of ['planner', 'agent']) {
    test(`N8 ${caller} can accept ${action} retiring a completed high-risk Goal`, async t => {
      const f = await fixture(t); f.seed(); f.finish();
      proposeSessionGoalAction(f.app.store, f.room.id, action === 'set' ? nextGoal() : { action }, { agentId: f.author.id, agentName: f.author.name });
      const result = await f.call({ action: caller === 'agent' ? 'accept' : 'accept-proposal' }, caller);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(f.app.store.listSessionGoalRulings(f.room.id).at(-1).outcome, 'accepted');
    });
  }
  test(`N8 ${action} still protects an active high-risk Goal`, async t => {
    const f = await fixture(t); f.seed();
    applySessionGoalAction(f.app.store, f.room.id, { action: 'resume', ruledBy: { kind: 'user' } });
    const before = f.snapshot(), result = await f.call(action === 'set' ? nextGoal() : { action });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'goal_high_risk_change_user_required');
    assert.deepEqual(f.snapshot(), before);
  });
  test(`N8 completed ${action} cannot bypass the accepted-ADR gate`, async t => {
    const f = await fixture(t), g = f.seed();
    applySessionGoalAction(f.app.store, f.room.id, { action: 'revise', goalRevision: g.revision,
      decisions: { committed: [{ id: 'adr', statement: 'Protected decision', adrPath: 'docs/decisions/0001-goal-driven-workflow.md' }] }, ruledBy: { kind: 'user' } });
    f.finish(); const before = f.snapshot(), result = await f.call(action === 'set' ? nextGoal() : { action });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'goal_accepted_adr_change_user_required');
    assert.deepEqual(f.snapshot(), before);
  });
}

test('N8 retiring a completed Goal never authorizes a new high-risk waiver', async t => {
  const f = await fixture(t); f.seed(); f.finish();
  const before = f.snapshot(), command = { ...nextGoal(), acceptanceCriteria: [{ ...criterion('next-high', 'high'),
    status: 'waived', waiver: { reason: 'Synthetic claim cannot authorize a high-risk waiver' } }] };
  const result = await f.call(command);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'goal_high_risk_waiver_user_required');
  assert.deepEqual(f.snapshot(), before);
});

test('N8 completed Goal revise still cannot drop a high-risk criterion', async t => {
  const f = await fixture(t); f.seed(); f.finish();
  const before = f.snapshot(), result = await f.call({ action: 'revise', acceptanceCriteria: [{ id: 'retained' }],
    evidence: [{ id: 'completion-proof', criterionIds: ['retained'] }] });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'goal_high_risk_change_user_required');
  assert.deepEqual(f.snapshot(), before);
});
