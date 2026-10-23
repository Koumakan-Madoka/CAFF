const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { applySessionGoalAction, proposeSessionGoalAction, claimSessionGoalAutoContinue,
  recordSessionGoalContinuationOutcome, pauseSessionGoalForRemovedOwner } = require('../../build/server/domain/conversation/session-goal');
const proposer = { agentId: 'role-family-gpt', agentName: 'GPT' };
const pending = [{ id: 'c', statement: 'Observe notifications', verifyBy: 'Storage assertions', status: 'pending' }];
const passed = { acceptanceCriteria: [{ ...pending[0], status: 'passed', evidenceRefs: ['e'] }],
  evidence: [{ id: 'e', criterionIds: ['c'], kind: 'test', summary: 'Synthetic verification' }] };
function fixture(t, input = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-attention-sources-'));
  const options = { agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') };
  const f = { store: createChatAppStore(options), options };
  t.after(() => { try { f.store?.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  f.store.saveCustomRoleConfig({ id: 'helper', name: 'Helper', personaPrompt: 'Synthetic', provider: 'openai', model: 'gpt-5' });
  f.room = f.store.createConversation({ title: 'Source fixture', participants: [proposer.agentId, 'helper'] });
  f.read = () => f.store.getConversationWithoutMessages(f.room.id);
  f.action = payload => applySessionGoalAction(f.store, f.room.id, { ...payload, ruledBy: { kind: 'user' } });
  f.propose = (action = 'pause') => proposeSessionGoalAction(f.store, f.room.id, { action, reason: 'Synthetic proposal' }, proposer);
  f.items = kind => f.store.listPlannerAttention({ conversationId: f.room.id }).items.filter(i => !kind || i.kind === kind);
  f.restart = () => { f.store.close(); f.store = null; f.store = createChatAppStore(options); };
  f.claim = (maxIterations = 2) => claimSessionGoalAutoContinue(f.store, f.room.id, { maxIterations });
  f.action({ action: 'set', objective: 'Synthetic notifications', acceptanceCriteria: pending, ...input });
  return f;
}
function fail(f, n) {
  return recordSessionGoalContinuationOutcome(f.store, f.room.id, {
    sourceMessages: [{ metadata: { source: 'goal-runner', goalAutoContinue: true } }],
    turn: { endedAt: new Date(Date.now() + n * 1000).toISOString(), completedCount: 0, failedCount: 1 },
    failures: [{ invocationFailure: { kind: 'provider', code: 'synthetic_failure', mode: 'provider:network', eligible: true,
      summary: 'Synthetic provider failure' } }], failureThreshold: 2,
  });
}
function resume(f) {
  return f.action({ action: 'resume', supersedeProposal: true, proposalId: f.read().metadata.sessionGoalProposal?.id });
}

test('exhausted runner creates one durable budget item even with another pending proposal', t => {
  const f = fixture(t);
  assert.equal(f.claim().claimed, true); assert.equal(f.items('budget_exhausted').length, 0);
  assert.equal(f.claim().claimed, true);
  const [item] = f.items('budget_exhausted'); assert.ok(item);
  assert.equal(item.goalId, f.read().metadata.sessionGoal.goalId);
  f.propose();
  assert.equal(f.claim().reason, 'pending_proposal');
  assert.deepEqual(f.items('budget_exhausted'), [item]);
  f.restart(); assert.deepEqual(f.items('budget_exhausted'), [item]);
  f.action({ action: 'pause', supersedeProposal: true });
  assert.equal(f.items('budget_exhausted')[0].resolvedAt, null, 'ordinary pause cannot hide budget exhaustion');
  resume(f);
  assert.ok(f.items('budget_exhausted')[0].resolvedAt);
  assert.equal(f.claim().claimed, true); assert.equal(f.claim().claimed, true);
  assert.equal(f.items('budget_exhausted').length, 2);
  assert.notEqual(f.items('budget_exhausted')[1].sourceId, item.sourceId);
});

test('owner/factual revision migration does not create another budget incident or reset its counter', t => {
  const f = fixture(t); f.claim(1); const [item] = f.items('budget_exhausted');
  f.action({ action: 'set-owner', ownerAgentId: 'helper' });
  f.action({ action: 'update-delivery', goalRevision: f.read().metadata.sessionGoal.revision });
  assert.deepEqual(f.items('budget_exhausted'), [item]);
  assert.equal(f.read().metadata.sessionGoalRunner.iteration, 1);
  assert.equal(f.claim(1).reason, 'budget_limited');
  assert.deepEqual(f.items('budget_exhausted'), [item]);
});

test('failure pause produces a separate durable incident while preserving an existing proposal', t => {
  const f = fixture(t); f.claim(20); const proposal = f.propose().proposal;
  fail(f, 1); assert.equal(f.items('failure_paused').length, 0);
  assert.equal(fail(f, 2).paused, true);
  const [item] = f.items('failure_paused'); assert.ok(item);
  assert.equal(f.read().metadata.sessionGoalProposal.id, proposal.id);
  assert.equal(item.goalRevision, f.read().metadata.sessionGoal.revision);
  f.restart(); assert.deepEqual(f.items('failure_paused'), [item]);
  resume(f);
  assert.ok(f.items('failure_paused')[0].resolvedAt);
  f.claim(20); fail(f, 3); fail(f, 4);
  assert.equal(f.items('failure_paused').length, 2);
  assert.notEqual(f.items('failure_paused')[1].sourceId, item.sourceId);
});

test('eager roster removal and lazy owner pause share one incident, restored/re-removed owner gets a new one', t => {
  const f = fixture(t, { owner: { agentId: proposer.agentId } }); f.propose();
  f.store.updateConversationWithoutMessages(f.room.id, { participants: ['helper'] });
  const [item] = f.items('owner_removed'); assert.ok(item);
  pauseSessionGoalForRemovedOwner(f.store, f.room.id, { ...proposer });
  assert.deepEqual(f.items('owner_removed'), [item]);
  f.restart(); assert.deepEqual(f.items('owner_removed'), [item]);
  f.store.updateConversationWithoutMessages(f.room.id, { participants: [proposer.agentId, 'helper'] });
  assert.ok(f.items('owner_removed')[0].resolvedAt);
  f.store.updateConversationWithoutMessages(f.room.id, { participants: ['helper'] });
  assert.equal(f.items('owner_removed').length, 2);
  assert.notEqual(f.items('owner_removed')[1].sourceId, item.sourceId);
  f.action({ action: 'set-owner', ownerAgentId: 'helper' });
  assert.ok(f.items('owner_removed')[1].resolvedAt);
});

test('lazy unavailable owner is not silently resolved by unrelated writes or restart; validated reassignment handles it', t => {
  const f = fixture(t, { owner: { agentId: proposer.agentId } });
  pauseSessionGoalForRemovedOwner(f.store, f.room.id, proposer);
  const [item] = f.items('owner_removed'); assert.ok(item);
  f.store.updateConversationWithoutMessages(f.room.id, { title: 'Unrelated change' });
  f.restart(); assert.deepEqual(f.items('owner_removed'), [item]);
  f.action({ action: 'set-owner', ownerAgentId: proposer.agentId });
  assert.ok(f.items('owner_removed')[0].resolvedAt);
});

test('retiring a custom owner records removal in the same roster deletion transaction', t => {
  const f = fixture(t, { owner: { agentId: 'helper' } });
  f.store.retireRoleConfig('helper', 'Synthetic retirement');
  const [item] = f.items('owner_removed'); assert.ok(item);
  assert.equal(item.resolvedAt, null);
  assert.ok(!f.read().agents.some(a => a.id === 'helper'));
  f.restart(); assert.deepEqual(f.items('owner_removed'), [item]);
});

for (const accepted of [false, true]) {
  test(`${accepted ? 'accepted' : 'direct'} completion creates an ack-required occurrence, not one per factual update/read/restart`, t => {
    const f = fixture(t, passed);
    if (accepted) { f.propose('complete'); f.action({ action: 'accept-proposal' }); }
    else f.action({ action: 'complete' });
    const [item] = f.items('goal_completed'); assert.ok(item);
    assert.equal(item.resolvedAt, null);
    f.store.updateConversationWithoutMessages(f.room.id, { title: 'Completed Room rename' });
    f.action({ action: 'update-delivery', goalRevision: f.read().metadata.sessionGoal.revision });
    f.restart(); assert.deepEqual(f.items('goal_completed'), [item]);
    const ack = f.store.resolvePlannerAttention(item.sequence, { reason: 'Reviewed', principal: { kind: 'planner', plannerId: 'local-planner', plannerName: 'Synthetic' } });
    f.restart(); assert.deepEqual(f.items('goal_completed'), [ack]);
    resume(f); f.action({ action: 'complete' });
    assert.equal(f.items('goal_completed').length, 2);
    assert.notEqual(f.items('goal_completed')[1].sourceId, item.sourceId);
    f.action({ action: 'clear' });
    assert.ok(f.items('goal_completed').every(i => i.resolvedAt));
  });
}

test('custom-owner retirement rolls back role identity/history/roster when its attention insert fails', t => {
  const f = fixture(t, { owner: { agentId: 'helper' } }), before = f.read();
  f.store.db.exec("CREATE TRIGGER reject_retired_owner BEFORE INSERT ON chat_planner_attention WHEN NEW.kind='owner_removed' BEGIN SELECT RAISE(ABORT, 'synthetic retirement failure'); END");
  assert.throws(() => f.store.retireRoleConfig('helper', 'Synthetic retirement'), /synthetic retirement failure/);
  assert.ok(f.store.getAgent('helper'));
  assert.deepEqual(f.read().agents.map(a => a.id), before.agents.map(a => a.id));
  assert.deepEqual(f.items(), []);
});

test('completion resolves budget/failure/owner incidents without acknowledging the completion itself', t => {
  const f = fixture(t, { ...passed, owner: { agentId: proposer.agentId } }); f.claim(1);
  f.store.updateConversationWithoutMessages(f.room.id, { participants: ['helper'] });
  fail(f, 1); fail(f, 2);
  assert.ok(['budget_exhausted', 'owner_removed', 'failure_paused'].every(k => f.items(k).length === 1));
  f.action({ action: 'complete' });
  assert.ok(f.items().filter(i => i.kind !== 'goal_completed').every(i => i.resolvedAt));
  assert.equal(f.items('goal_completed')[0].resolvedAt, null);
});

for (const kind of ['budget_exhausted', 'failure_paused', 'owner_removed', 'goal_completed']) {
  test(`source ${kind} insertion failure rolls back its owning state transition`, t => {
    const f = fixture(t, { ...passed, owner: { agentId: proposer.agentId } });
    if (kind === 'failure_paused') { f.claim(20); fail(f, 1); }
    const before = f.read(), items = f.items();
    f.store.db.exec(`CREATE TRIGGER reject_source BEFORE INSERT ON chat_planner_attention WHEN NEW.kind='${kind}'
      BEGIN SELECT RAISE(ABORT, 'synthetic source failure'); END`);
    assert.throws(() => {
      if (kind === 'budget_exhausted') f.claim(1);
      else if (kind === 'failure_paused') fail(f, 2);
      else if (kind === 'owner_removed') f.store.updateConversationWithoutMessages(f.room.id, { participants: ['helper'] });
      else f.action({ action: 'complete' });
    }, /synthetic source failure/);
    assert.deepEqual(f.read().metadata, before.metadata);
    assert.deepEqual(f.read().agents.map(a => a.id), before.agents.map(a => a.id));
    assert.deepEqual(f.items(), items);
  });
}

test('resume resolution failure rolls back Goal/runner/proposal/ruling and current-condition mapping', t => {
  const f = fixture(t); f.claim(1); f.propose(); f.action({ action: 'pause', supersedeProposal: true });
  const before = f.read(), items = f.items(), history = f.store.listSessionGoalRulings(f.room.id);
  const conditions = f.store.db.prepare('SELECT * FROM chat_planner_attention_conditions ORDER BY kind').all();
  f.store.db.exec("CREATE TRIGGER reject_resolution BEFORE UPDATE ON chat_planner_attention WHEN OLD.kind='budget_exhausted' BEGIN SELECT RAISE(ABORT, 'synthetic resolution failure'); END");
  assert.throws(() => resume(f), /synthetic resolution failure/);
  assert.deepEqual(f.read().metadata, before.metadata);
  assert.deepEqual(f.items(), items);
  assert.deepEqual(f.store.listSessionGoalRulings(f.room.id), history);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM chat_planner_attention_conditions ORDER BY kind').all(), conditions);
});

for (const kind of ['budget_exhausted', 'failure_paused', 'owner_removed', 'goal_completed']) {
  test(`startup repairs current ${kind} without historical turn/message replay or duplication`, t => {
    const f = fixture(t, { ...passed, owner: { agentId: proposer.agentId } });
    if (kind === 'budget_exhausted') { f.claim(1); f.propose(); }
    else if (kind === 'failure_paused') { f.claim(20); fail(f, 1); fail(f, 2); }
    else if (kind === 'owner_removed') f.store.updateConversationWithoutMessages(f.room.id, { participants: ['helper'] });
    else f.action({ action: 'complete' });
    f.store.db.transaction(() => {
      f.store.db.prepare('DELETE FROM chat_planner_attention WHERE conversation_id=?').run(f.room.id);
      f.store.db.prepare('DELETE FROM chat_planner_attention_conditions WHERE conversation_id=?').run(f.room.id);
    })();
    f.restart(); const [item] = f.items(kind); assert.ok(item);
    const all = f.items(); f.restart(); assert.deepEqual(f.items(), all);
    assert.equal(f.items('turn_failed').length, 0, 'startup must not invent old turn failures');
  });
}
