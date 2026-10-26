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
const contract = { objective: 'Concurrent Goal writes', status: 'paused', acceptanceCriteria: [{ id: 'c', statement: 'Tracked revision', verifyBy: 'Synthetic verification', status: 'passed', evidenceRefs: ['e'] }], evidence: [{ id: 'e', criterionIds: ['c'], summary: 'Synthetic proof' }] };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-goal-concurrency-')), token = randomBytes(32).toString('base64url');
  const sqlitePath = path.join(root, 'chat.sqlite');
  const app = createTestServerApp({ host: '127.0.0.1', port: 0, agentDir: root, sqlitePath, projectDir: root, uploadsDir: path.join(root, 'uploads'),
    plannerCredential: createInMemoryPlannerCredential({ token }), modelCatalog: { getOptions: () => [{ provider: 'openai', model: 'gpt-5', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] }] },
    executeConversationAgent: async () => ({ stopTurn: true, terminationReason: 'synthetic' }) });
  t.after(async () => { await new Promise(resolve => app.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  for (const id of ['author', 'other']) app.store.saveCustomRoleConfig({ id, name: id, personaPrompt: 'Synthetic', provider: 'openai', model: 'gpt-5' });
  const room = app.store.createConversation({ title: 'Concurrency', participants: [{ agentId: 'author' }, { agentId: 'other' }] });
  await new Promise(resolve => app.start(resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const invocations = Object.fromEntries(['author', 'other'].map(id => [id, app.agentToolBridge.registerInvocation(app.agentToolBridge.createInvocationContext({
    conversationId: room.id, turnId: id + '-turn', agentId: id, agentName: id, conversationAgents: [app.store.getAgent('author'), app.store.getAgent('other')] }))]));
  const snapshot = () => structuredClone(app.store.getConversationWithoutMessages(room.id).metadata);
  const history = () => app.store.listSessionGoalRulings(room.id);
  const seed = () => applySessionGoalAction(app.store, room.id, { ...contract, action: 'set', ruledBy: { kind: 'user' } }).goal;
  async function call(body, caller = 'planner') {
    const agent = ['author', 'other'].includes(caller);
    const response = await fetch(base + (agent ? '/api/agent-tools/goal/suggest' : `/api/conversations/${room.id}/goal`), { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(agent ? {} : caller === 'planner' ? { Authorization: 'Bearer ' + token } : { Origin: base, 'X-CAFF-CSRF-Token': bootstrap.apiSecurity.csrfToken }) },
      body: JSON.stringify(agent ? { invocationId: invocations[caller].invocationId, callbackToken: invocations[caller].callbackToken, ...body } : body) });
    return { status: response.status, body: await response.json() };
  }
  return { app, room, call, seed, snapshot, history, root, sqlitePath };
}
for (const action of ['set', 'revise', 'update-delivery', 'set-owner', 'pause', 'resume', 'complete', 'clear', 'accept-proposal', 'dismiss-proposal']) {
  test(`planner ${action} requires valid ID/revision and rejects stale epoch before any mutation`, async t => {
    const f = await fixture(t), g = f.seed();
    const p = proposeSessionGoalAction(f.app.store, f.room.id, { action: 'pause' }, { agentId: 'author', agentName: 'author' }).proposal;
    const command = { ...contract, action, ownerAgentId: 'author', supersedeProposal: true, proposalId: p.id };
    for (const [preconditions, status, code] of [
      [{}, 400, 'goal_revision_required'], [{ goalId: g.goalId }, 400, 'goal_revision_required'], [{ goalRevision: g.revision }, 400, 'goal_revision_required'],
      [{ goalId: g.goalId, goalRevision: 0 }, 400, 'goal_revision_required'], [{ goalId: g.goalId, goalRevision: '1' }, 400, 'goal_revision_required'],
      [{ goalId: 'other', goalRevision: g.revision }, 409, 'goal_revision_conflict'], [{ goalId: g.goalId, goalRevision: 999 }, 409, 'goal_revision_conflict'],
    ]) {
      const before = f.snapshot(), history = f.history();
      const result = await f.call({ ...command, ...preconditions });
      assert.equal(result.status, status, JSON.stringify({ action, preconditions, result }));
      assert.equal(result.body.code, code);
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(f.history(), history);
    }
  });
}
for (const action of ['accept-proposal', 'dismiss-proposal', 'clear', 'set']) {
  test(`absent Goal ${action} accepts null/0 and matching initial set proposal ID; missing ID is rejected`, async t => {
    const f = await fixture(t);
    const p = proposeSessionGoalAction(f.app.store, f.room.id, { ...contract, action: 'set', owner: { agentId: 'author' } }, { agentId: 'author', agentName: 'author' }).proposal;
    const command = { ...(action === 'set' ? contract : {}), action, goalId: null, goalRevision: 0,
      ...(['clear', 'set'].includes(action) ? { supersedeProposal: true } : {}) };
    for (const proposalId of [undefined, null, 'wrong']) {
      const before = f.snapshot(), result = await f.call({ ...command, proposalId });
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal(result.body.code, 'goal_proposal_conflict');
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(f.history(), []);
    }
    const result = await f.call({ ...command, proposalId: p.id });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.history().length, 1);
    assert.equal(f.history()[0].proposalId, p.id);
    if (['accept-proposal', 'set'].includes(action)) assert.equal(result.body.goal.status, 'paused');
    else assert.equal(result.body.goal, null);
    // Replay cannot consume a different/new proposal or rerun initial set.
    if (action === 'set') {
      const replay = await f.call({ ...command, proposalId: p.id });
      assert.notEqual(replay.status, 200);
    }
  });
}

test('planner first set requires explicit null/0; legacy browser writes remain usable', async t => {
  const f = await fixture(t);
  const missing = await f.call({ ...contract, action: 'set' });
  assert.equal(missing.status, 400);
  assert.equal((await f.call({ ...contract, action: 'set', goalId: null, goalRevision: 0 })).status, 200);
  assert.equal((await f.call({ action: 'pause' }, 'user')).status, 200);
});

test('same/different agent draft replacement archives full old snapshot and new ID atomically, without changing Goal revision', async t => {
  const f = await fixture(t), g = f.seed();
  let previous = (await f.call({ action: 'pause', reason: 'First draft' }, 'author')).body.proposal;
  assert.deepEqual(f.history(), []);
  for (const caller of ['author', 'other']) {
    const result = await f.call({ action: 'pause', reason: 'Revised draft by ' + caller, ruledBy: { kind: 'user' } }, caller);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const ruling = f.history().at(-1);
    assert.equal(ruling.outcome, 'superseded');
    assert.deepEqual(ruling.proposalSnapshot, previous);
    assert.equal(ruling.supersedingProposalId, result.body.proposal.id);
    assert.deepEqual(ruling.ruledBy, { kind: 'agent', agentId: caller, agentName: caller });
    assert.equal(result.body.goal.revision, g.revision);
    const before = f.snapshot(), count = f.history().length;
    const staleRuling = await f.call({ action: 'accept-proposal', goalId: g.goalId, goalRevision: g.revision, proposalId: previous.id });
    assert.equal(staleRuling.status, 409);
    assert.equal(staleRuling.body.code, 'goal_proposal_conflict');
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.history().length, count);
    previous = result.body.proposal;
  }
  const reopened = createChatAppStore({ agentDir: f.root, sqlitePath: f.sqlitePath });
  try { assert.deepEqual(reopened.listSessionGoalRulings(f.room.id), f.history()); } finally { reopened.close(); }
});

test('draft replacement history/persistence failures roll back both old and new proposal state', async t => {
  const f = await fixture(t); f.seed();
  assert.equal((await f.call({ action: 'pause' }, 'author')).status, 200);
  for (const [table, operation] of [['chat_goal_rulings', 'INSERT'], ['chat_conversations', 'UPDATE']]) {
    f.app.store.db.exec(`CREATE TRIGGER reject_replacement BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    const before = f.snapshot(), result = await f.call({ action: 'pause', reason: 'Replacement' }, 'other');
    assert.equal(result.status, 500);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.history(), []);
    f.app.store.db.exec('DROP TRIGGER reject_replacement');
  }
});
