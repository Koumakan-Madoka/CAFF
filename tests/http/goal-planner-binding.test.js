const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { createTestServerApp } = require('../helpers/server-app');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { applySessionGoalAction, proposeSessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
isolateExternalIntegrations();
const contract = { objective: 'Planner-owned review authority', status: 'paused', acceptanceCriteria: [{ id: 'c', statement: 'Binding enforced', verifyBy: 'Synthetic test', status: 'pending' }], workItems: [{ id: 'w', text: 'Implement', status: 'in_progress' }] };
const key = 'sessionGoalPlannerBinding';
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-goal-binding-')), token = randomBytes(32).toString('base64url'), sqlitePath = path.join(root, 'chat.sqlite'), calls = [];
  const app = createTestServerApp({ host: '127.0.0.1', port: 0, agentDir: root, sqlitePath, projectDir: root, uploadsDir: path.join(root, 'uploads'),
    plannerCredential: createInMemoryPlannerCredential({ token, plannerName: 'Binding Planner' }),
    modelCatalog: { getOptions: () => [{ provider: 'openai', model: 'gpt-5', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] }] },
    executeConversationAgent: async () => { calls.push('execute'); return { stopTurn: true, terminationReason: 'synthetic' }; } });
  t.after(async () => { await new Promise(resolve => app.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  for (const id of ['author', 'reviewer']) app.store.saveCustomRoleConfig({ id, name: id, personaPrompt: 'Synthetic', provider: 'openai', model: 'gpt-5' });
  const room = app.store.createConversation({ title: 'Binding', participants: [{ agentId: 'author' }, { agentId: 'reviewer' }] });
  await new Promise(resolve => app.start(resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const invocations = Object.fromEntries(['author', 'reviewer'].map(id => [id, app.agentToolBridge.registerInvocation(app.agentToolBridge.createInvocationContext({
    conversationId: room.id, turnId: id + '-turn', agentId: id, agentName: id, conversationAgents: [app.store.getAgent('author'), app.store.getAgent('reviewer')] }))]));
  const snapshot = () => structuredClone(app.store.getConversationWithoutMessages(room.id).metadata);
  const seed = () => applySessionGoalAction(app.store, room.id, { ...contract, action: 'set', owner: { agentId: 'author' }, ruledBy: { kind: 'user' } }).goal;
  const propose = () => proposeSessionGoalAction(app.store, room.id, { action: 'pause', reason: 'Milestone review' }, { agentId: 'author', agentName: 'author' }).proposal;
  async function call(command, caller = 'planner') {
    const agent = ['author', 'reviewer'].includes(caller), m = snapshot();
    const body = agent ? { invocationId: invocations[caller].invocationId, callbackToken: invocations[caller].callbackToken, ...command }
      : { goalId: m.sessionGoal?.goalId ?? null, goalRevision: m.sessionGoal?.revision ?? 0, proposalId: m.sessionGoalProposal?.id, ...command };
    const response = await fetch(base + (agent ? '/api/agent-tools/goal/suggest' : `/api/conversations/${room.id}/goal`), { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(agent ? {} : caller === 'planner' ? { Authorization: 'Bearer ' + token } : { Origin: base, 'X-CAFF-CSRF-Token': bootstrap.apiSecurity.csrfToken }) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { app, room, call, seed, propose, snapshot, root, sqlitePath, calls };
}

for (const creation of ['direct', 'accepted-set']) {
  test(`planner ${creation} binds atomically; both agents cannot rule but planner/user can`, async t => {
    const f = await fixture(t);
    if (creation === 'direct') assert.equal((await f.call({ ...contract, action: 'set' })).status, 200);
    else {
      proposeSessionGoalAction(f.app.store, f.room.id, { ...contract, action: 'set' }, { agentId: 'author', agentName: 'author' });
      assert.equal((await f.call({ action: 'accept-proposal' })).status, 200);
    }
    const binding = f.snapshot()[key];
    assert.equal(binding?.goalId, f.snapshot().sessionGoal.goalId);
    assert.equal(binding.plannerId, 'local-planner');
    assert.equal(binding.plannerName, 'Binding Planner');
    for (const action of ['accept', 'reject']) for (const agent of ['author', 'reviewer']) {
      if (!f.snapshot().sessionGoalProposal) f.propose();
      const before = f.snapshot();
      const result = await f.call({ action, goal: { ruledBy: { kind: 'user' } } }, agent);
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.equal(result.body.code || result.body.error?.code, 'goal_planner_ruling_required');
      assert.deepEqual(f.snapshot(), before);
    }
    assert.equal((await f.call({ action: 'accept-proposal' })).status, 200);
    f.propose();
    assert.equal((await f.call({ action: 'dismiss-proposal' }, 'user')).status, 200);
    assert.deepEqual(f.snapshot()[key], binding);
  });
}

test('user set/accept can explicitly opt in; ordinary set, planner factual write or read never adopts implicitly', async t => {
  const f = await fixture(t); f.seed();
  assert.equal((await f.call({ action: 'update-delivery', workItems: [{ id: 'w', status: 'done' }] })).status, 200);
  assert.equal(f.snapshot()[key], undefined);
  assert.equal((await f.call({ ...contract, action: 'set', plannerDriven: true }, 'user')).status, 200);
  assert.equal(f.snapshot()[key].plannerName, 'Binding Planner');
  assert.equal((await f.call({ ...contract, action: 'set' }, 'user')).status, 200);
  assert.equal(f.snapshot()[key], undefined);
  proposeSessionGoalAction(f.app.store, f.room.id, { ...contract, action: 'set' }, { agentId: 'author', agentName: 'author' });
  assert.equal((await f.call({ action: 'accept-proposal', plannerDriven: true }, 'user')).status, 200);
  assert.equal(f.snapshot()[key].plannerId, 'local-planner');
  assert.equal((await f.call({ action: 'clear' }, 'user')).status, 200);
  assert.equal(f.snapshot()[key], undefined);
});

test('unbound agent independent acceptance/rejection stays allowed; own proposals still fail self-review', async t => {
  const f = await fixture(t); f.seed();
  for (const action of ['accept', 'reject']) {
    f.propose();
    const self = await f.call({ action }, 'author');
    assert.equal(self.status, 403);
    assert.equal((await f.call({ action }, 'reviewer')).status, 200);
  }
});

test('user bind-planner preserves full Goal/ruling/owner/status/counters and never enqueues a cycle', async t => {
  const f = await fixture(t), initial = f.seed();
  f.propose(); assert.equal((await f.call({ action: 'dismiss-proposal' }, 'user')).status, 200);
  const m = f.snapshot();
  f.app.store.updateConversationWithoutMessages(f.room.id, { metadata: { ...m, sessionGoal: { ...initial, status: 'active' },
    sessionGoalRunner: { goalUpdatedAt: initial.updatedAt, status: 'budget_limited', iteration: 12, maxIterations: 20, consecutiveFailureCount: 4 } } });
  const before = f.snapshot();
  const result = await f.call({ action: 'bind-planner', reason: 'User explicitly adopts planner review', plannerName: 'Forged name' }, 'user');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const after = f.snapshot();
  assert.deepEqual(after.sessionGoal, { ...before.sessionGoal, revision: initial.revision + 1, updatedAt: after.sessionGoal.updatedAt });
  assert.deepEqual(after.sessionGoalRuling, before.sessionGoalRuling);
  assert.deepEqual(after.sessionGoalRunner, { ...before.sessionGoalRunner, goalUpdatedAt: after.sessionGoal.updatedAt });
  assert.deepEqual(after[key].adoption, { boundBy: { kind: 'user' }, reason: 'User explicitly adopts planner review' });
  assert.equal(after[key].plannerName, 'Binding Planner');
  assert.equal(result.body.autoContinuation, null);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.app.store.getConversation(f.room.id).messages, []);
  const reopened = createChatAppStore({ agentDir: f.root, sqlitePath: f.sqlitePath });
  try { assert.deepEqual(reopened.getConversationWithoutMessages(f.room.id).metadata[key], after[key]); } finally { reopened.close(); }
});

test('bind-planner rejects non-user, missing/stale preconditions, blank reason, pending proposal and existing binding unchanged', async t => {
  const f = await fixture(t), g = f.seed();
  for (const [command, caller, status, code] of [
    [{}, 'planner', 403, 'goal_planner_binding_user_required'],
    [{}, 'reviewer', 403, 'goal_planner_binding_user_required'],
    [{ goalId: undefined }, 'user', 400, 'goal_revision_required'],
    [{ goalRevision: undefined }, 'user', 400, 'goal_revision_required'],
    [{ goalId: 'old' }, 'user', 409, 'goal_revision_conflict'],
    [{ goalRevision: g.revision + 1 }, 'user', 409, 'goal_revision_conflict'],
    [{ reason: '' }, 'user', 400, 'goal_planner_binding_reason_required'],
  ]) {
    const before = f.snapshot(), result = await f.call({ action: 'bind-planner', reason: 'Adopt', ...command }, caller);
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.code || result.body.error?.code, code);
    assert.deepEqual(f.snapshot(), before);
  }
  f.propose();
  const before = f.snapshot(), pending = await f.call({ action: 'bind-planner', reason: 'Adopt', supersedeProposal: true }, 'user');
  assert.equal(pending.status, 409);
  assert.equal(pending.body.code, 'goal_proposal_pending');
  assert.deepEqual(f.snapshot(), before);
  assert.equal((await f.call({ action: 'dismiss-proposal' }, 'user')).status, 200);
  assert.equal((await f.call({ action: 'bind-planner', reason: 'Adopt' }, 'user')).status, 200);
  const bound = f.snapshot(), again = await f.call({ action: 'bind-planner', reason: 'Adopt again' }, 'user');
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'goal_planner_binding_conflict');
  assert.deepEqual(f.snapshot(), bound);
});

for (const malformed of [null, {}, { goalId: 'other', plannerId: 'local-planner', plannerName: 'Binding Planner', boundAt: '2026-01-01' }]) {
  test(`malformed/stale planner binding fails closed for all agent rulings (${JSON.stringify(malformed)})`, async t => {
    const f = await fixture(t); f.seed(); f.propose();
    f.app.store.updateConversationWithoutMessages(f.room.id, { metadata: { ...f.snapshot(), [key]: malformed } });
    const before = f.snapshot();
    for (const action of ['accept', 'reject']) {
      const result = await f.call({ action }, 'reviewer');
      assert.equal(result.status, 403);
      assert.equal(result.body.code || result.body.error?.code, 'goal_planner_ruling_required');
      assert.deepEqual(f.snapshot(), before);
    }
  });
}

test('DAG binding forbids adoption/implicit planner binding; native verifier and user paths remain', async t => {
  const f = await fixture(t); f.seed();
  f.app.store.updateConversationWithoutMessages(f.room.id, { metadata: { ...f.snapshot(), dagNodeGoalBinding: { planId: 'plan', nodeId: 'n', workerId: 'author', verifierId: 'reviewer' } } });
  for (const [command, caller] of [[{ action: 'bind-planner', reason: 'Adopt' }, 'user'], [{ ...contract, action: 'set' }, 'planner'], [{ ...contract, action: 'set', plannerDriven: true }, 'user']]) {
    const before = f.snapshot(), result = await f.call(command, caller);
    assert.equal(result.status, 403);
    assert.deepEqual(f.snapshot(), before);
  }
  f.propose();
  assert.equal((await f.call({ action: 'accept-proposal' })).status, 403);
  assert.equal((await f.call({ action: 'accept' }, 'reviewer')).status, 200);
  f.propose();
  assert.equal((await f.call({ action: 'dismiss-proposal' }, 'user')).status, 200);
});

test('wrong planner identity and conflicting DAG/planner anchors fail closed for non-user rulings', async t => {
  const f = await fixture(t), g = f.seed(); f.propose();
  const binding = { goalId: g.goalId, plannerId: 'different-planner', plannerName: 'Other', boundAt: '2026-01-01' };
  f.app.store.updateConversationWithoutMessages(f.room.id, { metadata: { ...f.snapshot(), [key]: binding } });
  const before = f.snapshot(), mismatch = await f.call({ action: 'accept-proposal' });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.body.code, 'goal_planner_ruling_required');
  assert.deepEqual(f.snapshot(), before);
  f.app.store.updateConversationWithoutMessages(f.room.id, { metadata: { ...f.snapshot(), dagNodeGoalBinding: { planId: 'p', nodeId: 'n', workerId: 'author', verifierId: 'reviewer' } } });
  const conflict = f.snapshot();
  assert.equal((await f.call({ action: 'accept-proposal' })).status, 403);
  assert.equal((await f.call({ action: 'accept' }, 'reviewer')).status, 403);
  assert.deepEqual(f.snapshot(), conflict);
  assert.equal((await f.call({ action: 'dismiss-proposal' }, 'user')).status, 200);
});

test('planner adoption rolls back on persistence failure and creates no proposal ruling', async t => {
  const f = await fixture(t); f.seed();
  const before = f.snapshot();
  f.app.store.db.exec("CREATE TRIGGER reject_adoption BEFORE UPDATE ON chat_conversations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  const result = await f.call({ action: 'bind-planner', reason: 'Adopt' }, 'user');
  assert.equal(result.status, 500);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.app.store.listSessionGoalRulings(f.room.id), []);
  f.app.store.db.exec('DROP TRIGGER reject_adoption');
});

test('planner owner reassignment requires a reason and currently routable target; user clear-owner remains compatible', async t => {
  const f = await fixture(t); f.seed();
  for (const command of [{ ownerAgentId: 'reviewer' }, { ownerAgentId: 'removed', reason: 'Owner removed' }, { ownerAgentId: '', reason: 'Cannot implicitly clear' }]) {
    const before = f.snapshot(), result = await f.call({ action: 'set-owner', ...command });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.deepEqual(f.snapshot(), before);
  }
  const assigned = await f.call({ action: 'set-owner', ownerAgentId: 'reviewer', reason: 'Explicit reassignment' });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.goal.owner.agentId, 'reviewer');
  assert.equal(assigned.body.goal.changeNotices.at(-1).type, 'owner_changed');
  assert.equal(assigned.body.goal.changeNotices.at(-1).reason, 'Explicit reassignment');
  assert.equal(assigned.body.goal.changeNotices.at(-1).reviewer.kind, 'planner');
  f.app.store.saveCustomRoleConfig({ ...f.app.store.getAgent('reviewer'), modelProfiles: [{ id: 'bad', name: 'Unavailable', provider: 'missing', model: 'unconfigured' }] });
  f.app.store.updateConversation(f.room.id, { participants: [{ agentId: 'author' }, { agentId: 'reviewer', modelProfileId: 'bad' }] });
  const before = f.snapshot(), invalid = await f.call({ action: 'set-owner', ownerAgentId: 'reviewer', reason: 'Unavailable runtime profile' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'goal_owner_invalid');
  assert.deepEqual(f.snapshot(), before);
  assert.equal((await f.call({ action: 'set-owner', ownerAgentId: '' }, 'user')).status, 200);
  assert.equal(f.snapshot().sessionGoal.owner, undefined);
});

test('direct partial revision requires provisional-decision reason/impact just like an agent proposal', async t => {
  const f = await fixture(t);
  applySessionGoalAction(f.app.store, f.room.id, { ...contract, action: 'set', decisions: { provisional: [{ id: 'p', statement: 'Provisional choice' }] }, ruledBy: { kind: 'user' } });
  for (const context of [{}, { reason: 'Changed evidence' }, { impact: 'Changes work' }]) {
    const before = f.snapshot(), result = await f.call({ action: 'revise', decisions: { provisional: [] }, ...context });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, 'goal_provisional_change_context_required');
    assert.deepEqual(f.snapshot(), before);
  }
  const success = await f.call({ action: 'revise', decisions: { provisional: [] }, reason: 'Changed evidence', impact: 'Changes work' });
  assert.equal(success.status, 200);
  assert.deepEqual(success.body.goal.decisions.provisional, []);
  assert.equal(success.body.goal.changeNotices.at(-1).reason, 'Changed evidence');
  assert.equal(success.body.goal.changeNotices.at(-1).reviewer.kind, 'planner');
});

test('planner-bound technical draft replacement stays auditable but never grants the replacing agent a verdict', async t => {
  const f = await fixture(t);
  assert.equal((await f.call({ ...contract, action: 'set' })).status, 200);
  const old = f.propose();
  const replacement = await f.call({ action: 'pause', reason: 'Reworked draft' }, 'reviewer');
  assert.equal(replacement.status, 200);
  assert.equal(f.snapshot().sessionGoalRuling.supersedingProposalId, replacement.body.proposal.id);
  assert.equal(f.snapshot().sessionGoalRuling.proposalId, old.id);
  assert.equal((await f.call({ action: 'accept' }, 'reviewer')).status, 403);
  assert.equal((await f.call({ action: 'dismiss-proposal' })).status, 200);
});
