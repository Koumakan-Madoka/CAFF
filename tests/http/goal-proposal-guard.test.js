const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { createTestServerApp } = require('../helpers/server-app');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { applySessionGoalAction, getSessionGoal, getSessionGoalProposal, proposeSessionGoalAction, recordSessionGoalContinuationOutcome } = require('../../build/server/domain/conversation/session-goal');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
isolateExternalIntegrations();
const contract = { objective: 'Record every proposal ruling', status: 'paused',
  acceptanceCriteria: [{ id: 'c', statement: 'Auditable supersession', verifyBy: 'Synthetic regression', status: 'passed', evidenceRefs: ['e'] }],
  evidence: [{ id: 'e', criterionIds: ['c'], kind: 'test', summary: 'Synthetic proof' }] };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-goal-guard-'));
  const token = randomBytes(32).toString('base64url'), calls = [];
  const sqlitePath = path.join(root, 'chat.sqlite');
  const app = createTestServerApp({ host: '127.0.0.1', port: 0, agentDir: root, sqlitePath, projectDir: root, uploadsDir: path.join(root, 'uploads'),
    plannerCredential: createInMemoryPlannerCredential({ token, plannerName: 'Guard Planner' }),
    modelCatalog: { getOptions: () => [{ provider: 'openai', model: 'gpt-5', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] }] },
    executeConversationAgent: async () => { calls.push('execute'); return { stopTurn: true, terminationReason: 'synthetic' }; } });
  t.after(async () => { await new Promise(resolve => app.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  app.store.saveCustomRoleConfig({ id: 'author', name: 'Author', personaPrompt: 'Synthetic', provider: 'openai', model: 'gpt-5' });
  const room = app.store.createConversation({ title: 'Proposal guard', participants: [{ agentId: 'author' }] });
  await new Promise(resolve => app.start(resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const snapshot = () => structuredClone(app.store.getConversationWithoutMessages(room.id).metadata);
  const goal = () => getSessionGoal(app.store.getConversationWithoutMessages(room.id));
  const proposal = () => getSessionGoalProposal(app.store.getConversationWithoutMessages(room.id));
  const history = () => app.store.listSessionGoalRulings(room.id);
  function seed() {
    applySessionGoalAction(app.store, room.id, { ...contract, action: 'set', ruledBy: { kind: 'user' } });
    proposeSessionGoalAction(app.store, room.id, { action: 'pause', reason: 'Review before further work' }, { agentId: 'author', agentName: 'Author' });
    return { goal: goal(), proposal: proposal() };
  }
  async function call(command, user = false) {
    const g = goal(), p = proposal();
    const response = await fetch(`${base}/api/conversations/${room.id}/goal`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(user ? { Origin: base, 'X-CAFF-CSRF-Token': bootstrap.apiSecurity.csrfToken } : { Authorization: 'Bearer ' + token }) },
      body: JSON.stringify({ goalId: g?.goalId ?? null, goalRevision: g?.revision ?? 0, proposalId: p?.id, ...command }) });
    return { status: response.status, body: await response.json() };
  }
  return { app, room, seed, call, snapshot, goal, proposal, history, root, sqlitePath, calls };
}

for (const action of ['set', 'revise', 'pause', 'resume', 'complete']) {
  test(`${action} rejects pending proposal without literal confirmation; supersede archives full snapshot/principal/context`, async t => {
    const f = await fixture(t), old = f.seed();
    const command = action === 'set' ? { ...contract, action } : { action };
    for (const supersedeProposal of [undefined, false, 'true', 1]) {
      const before = f.snapshot();
      const blocked = await f.call({ ...command, supersedeProposal });
      assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
      assert.equal(blocked.body.code, 'goal_proposal_pending');
      assert.deepEqual(f.snapshot(), before);
    }
    const result = await f.call({ ...command, supersedeProposal: true, reason: 'Explicitly supersede reviewed proposal' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.proposal, null);
    const ruling = result.body.ruling;
    assert.equal(ruling.outcome, 'superseded');
    assert.equal(ruling.proposalId, old.proposal.id);
    assert.deepEqual(ruling.proposalSnapshot, old.proposal);
    assert.deepEqual(ruling.ruledBy, { kind: 'planner', plannerId: 'local-planner', plannerName: 'Guard Planner' });
    assert.equal(ruling.goalId, old.goal.goalId);
    assert.equal(ruling.goalRevision, old.goal.revision);
    assert.equal(ruling.supersedingAction, action);
    assert.equal(ruling.reason, 'Explicitly supersede reviewed proposal');
    assert.equal(f.history().length, 1);
    assert.deepEqual(f.history()[0], ruling);
  });
}

test('missing/mismatching planner supersession ID cannot discard a proposal; browser matching confirmation works', async t => {
  const f = await fixture(t); f.seed();
  for (const proposalId of [undefined, null, 'other']) {
    const before = f.snapshot(), blocked = await f.call({ action: 'pause', supersedeProposal: true, proposalId });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'goal_proposal_conflict');
    assert.deepEqual(f.snapshot(), before);
  }
  const result = await f.call({ action: 'pause', supersedeProposal: true, reason: 'Browser confirmed' }, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.ruling.ruledBy, { kind: 'user' });
});

test('a failed superseding mutation records no ruling and leaves proposal/Goal unchanged', async t => {
  const f = await fixture(t); f.seed();
  for (const command of [ { action: 'set', objective: '' }, { action: 'set', ...contract, owner: { agentId: 'removed' } },
    { action: 'revise', goalRevision: 999 }, { action: 'revise', evidence: [] } ]) {
    const before = f.snapshot(), result = await f.call({ ...command, supersedeProposal: true });
    assert.ok([400, 409].includes(result.status));
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.history(), []);
  }
});

test('SQLite failure on history append or metadata update rolls back the entire supersession', async t => {
  const f = await fixture(t); f.seed();
  // Both insertion-before-update and failure-after-insertion must roll back.
  for (const [table, operation] of [['chat_goal_rulings', 'INSERT'], ['chat_conversations', 'UPDATE']]) {
    f.app.store.db.exec(`CREATE TRIGGER reject_guard_test BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END`);
    const before = f.snapshot(), result = await f.call({ action: 'pause', supersedeProposal: true });
    assert.equal(result.status, 500);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.history(), []);
    f.app.store.db.exec('DROP TRIGGER reject_guard_test');
  }
});

test('accepted/rejected/superseded history survives lifecycle, replacement, clear and restart', async t => {
  const f = await fixture(t); f.seed();
  assert.equal((await f.call({ action: 'dismiss-proposal', reason: 'Reject pause' })).status, 200);
  const first = f.snapshot().sessionGoalRuling;
  assert.equal(first.outcome, 'rejected');
  assert.equal((await f.call({ action: 'revise', objective: 'Keep ruling during revision' })).status, 200);
  assert.deepEqual(f.snapshot().sessionGoalRuling, first);
  assert.equal((await f.call({ action: 'pause' })).status, 200);
  assert.deepEqual(f.snapshot().sessionGoalRuling, first);
  proposeSessionGoalAction(f.app.store, f.room.id, { action: 'pause' }, { agentId: 'author', agentName: 'Author' });
  assert.equal((await f.call({ action: 'accept-proposal' })).status, 200);
  assert.equal(f.history().length, 2);
  proposeSessionGoalAction(f.app.store, f.room.id, { action: 'pause' }, { agentId: 'author', agentName: 'Author' });
  assert.equal((await f.call({ ...contract, action: 'set', supersedeProposal: true })).status, 200);
  assert.equal(f.history().length, 3);
  const history = f.history();
  assert.equal((await f.call({ action: 'clear' }, true)).status, 200);
  assert.deepEqual(f.history(), history);
  const reopened = createChatAppStore({ agentDir: f.root, sqlitePath: f.sqlitePath });
  try { assert.deepEqual(reopened.listSessionGoalRulings(f.room.id), history); } finally { reopened.close(); }
});

test('explicit clear archives pending proposal; accepted clear archives acceptance and still enforces no self-review', async t => {
  const f = await fixture(t); f.seed();
  const old = f.proposal();
  assert.equal((await f.call({ action: 'clear', reason: 'Explicit user cleanup' }, true)).status, 200);
  assert.equal(f.history()[0].outcome, 'superseded');
  assert.equal(f.history()[0].supersedingAction, 'clear');
  assert.deepEqual(f.history()[0].proposalSnapshot, old);
  f.seed();
  applySessionGoalAction(f.app.store, f.room.id, { action: 'dismiss-proposal', ruledBy: { kind: 'user' } });
  proposeSessionGoalAction(f.app.store, f.room.id, { action: 'clear' }, { agentId: 'author', agentName: 'Author' });
  const before = f.snapshot(), count = f.history().length;
  assert.throws(() => applySessionGoalAction(f.app.store, f.room.id, { action: 'accept-proposal', ruledBy: { kind: 'agent', agentId: 'author', agentName: 'Author' } }), error => error.statusCode === 403 && error.code === 'goal_proposal_self_review');
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.history().length, count);
  assert.equal((await f.call({ action: 'accept-proposal' }, true)).status, 200);
  const last = f.history().at(-1);
  assert.equal(last.action, 'clear');
  assert.equal(last.outcome, 'accepted');
  assert.equal(f.goal(), null);
});

test('automatic failure pause preserves pending proposal and latest ruling without fabricating a verdict', async t => {
  const f = await fixture(t); f.seed();
  assert.equal((await f.call({ action: 'dismiss-proposal' })).status, 200);
  const active = f.goal();
  // Change only the fixture lifecycle directly, without scheduling a turn.
  f.app.store.updateConversationWithoutMessages(f.room.id, { metadata: { ...f.snapshot(), sessionGoal: { ...active, status: 'active' } } });
  proposeSessionGoalAction(f.app.store, f.room.id, { action: 'pause', reason: 'Keep review pending' }, { agentId: 'author', agentName: 'Author' });
  const before = f.snapshot(), history = f.history();
  for (let index = 0; index < 2; index++) recordSessionGoalContinuationOutcome(f.app.store, f.room.id, {
    sourceMessages: [{ metadata: { source: 'goal-runner', goalAutoContinue: true } }],
    turn: { completedCount: 0, failedCount: 1, endedAt: `2026-10-23T00:00:0${index}.000Z` },
    failureThreshold: 2, totalFailureThreshold: 5,
    failures: [{ errorMessage: 'Synthetic error', invocationFailure: { kind: 'provider', eligible: true, mode: 'provider:network', summary: 'Synthetic error' } }],
  });
  assert.equal(f.goal().status, 'paused');
  assert.deepEqual(f.snapshot().sessionGoalProposal, before.sessionGoalProposal);
  assert.deepEqual(f.snapshot().sessionGoalRuling, before.sessionGoalRuling);
  assert.deepEqual(f.history(), history);
});

test('archive is immutable/idempotent and grows outside bounded Room metadata only', async t => {
  const f = await fixture(t); f.seed();
  for (let index = 0; index < 105; index++) {
    if (!f.proposal()) proposeSessionGoalAction(f.app.store, f.room.id, { action: 'pause', reason: 'Review ' + index }, { agentId: 'author', agentName: 'Author' });
    applySessionGoalAction(f.app.store, f.room.id, { action: 'dismiss-proposal', ruledBy: { kind: 'user' } });
  }
  const history = f.app.store.listSessionGoalRulings(f.room.id, { limit: 500 });
  assert.equal(history.length, 105);
  assert.equal(f.history().length, 100, 'bounded history reads default to 100');
  assert.ok(JSON.stringify(f.snapshot()).length < 10000, 'only latest ruling lives in Room metadata');
  assert.throws(() => f.app.store.db.prepare('UPDATE chat_goal_rulings SET outcome = ? WHERE id = ?').run('accepted', history[0].id), /append-only/);
  const before = f.snapshot();
  assert.throws(() => f.app.store.updateConversationWithoutMessages(f.room.id, { metadata: { ...before,
    sessionGoalRuling: { ...before.sessionGoalRuling, reason: 'Cannot rewrite this ID' } } }), /cannot be overwritten/);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.app.store.listSessionGoalRulings(f.room.id, { limit: 500 }), history);
});

test('legacy ruling migration archives once without inventing a principal and Room deletion cascades history', async t => {
  const f = await fixture(t); f.seed();
  const legacy = { id: 'legacy-ruling', proposalId: f.proposal().id, action: 'pause', outcome: 'rejected', proposalSnapshot: f.proposal(), ruledAt: '2026-01-01T00:00:00.000Z' };
  // Simulate a pre-upgrade database row, bypassing the new write hook.
  f.app.store.db.prepare('UPDATE chat_conversations SET metadata_json = ? WHERE id = ?').run(JSON.stringify({ ...f.snapshot(), sessionGoalRuling: legacy }), f.room.id);
  for (let i = 0; i < 2; i++) {
    const reopened = createChatAppStore({ agentDir: f.root, sqlitePath: f.sqlitePath });
    try {
      const history = reopened.listSessionGoalRulings(f.room.id);
      assert.deepEqual(history, [legacy]);
      assert.equal(Object.hasOwn(history[0], 'ruledBy'), false);
    } finally { reopened.close(); }
  }
  f.app.store.deleteConversation(f.room.id);
  assert.deepEqual(f.history(), []);
});
