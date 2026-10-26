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
const fields = ['objective', 'decisions', 'acceptanceCriteria', 'workItems', 'evidence'];
const baseline = {
  objective: 'Preserve partial delivery state',
  decisions: { committed: [{ id: 'd', statement: 'Use recorded proof' }], provisional: [{ id: 'p', statement: 'Keep sessions fresh', changeConditions: 'Separate design' }],
    openQuestions: [{ id: 'q', question: 'What next?' }], nonGoals: [{ id: 'n', statement: 'No release' }], rejectedOptions: [{ id: 'r', option: 'Silent proof transfer', reason: 'Unsafe' }] },
  acceptanceCriteria: [
    { id: 'c1', statement: 'Proof retained', verifyBy: 'Synthetic test', risk: 'high', status: 'passed', evidenceRefs: ['e1'] },
    { id: 'c2', statement: 'Waiver retained', verifyBy: 'Review', status: 'waived', waiver: { reason: 'Not applicable', waivedBy: 'user', waivedAt: '2026-01-01T00:00:00.000Z' } },
  ],
  workItems: [{ id: 'w1', text: 'Completed step', status: 'done', completedAt: '2026-01-01T00:00:00.000Z' }, { id: 'w2', text: 'Current step', status: 'in_progress' }],
  evidence: [{ id: 'e1', criterionIds: ['c1'], kind: 'test', summary: 'Synthetic proof', reference: 'test-result', recordedBy: 'author', recordedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'e2', criterionIds: [], kind: 'artifact', summary: 'Extra evidence' }],
};
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-goal-merge-'));
  const token = randomBytes(32).toString('base64url');
  const app = createTestServerApp({ host: '127.0.0.1', port: 0, agentDir: root, sqlitePath: path.join(root, 'chat.sqlite'), projectDir: root,
    uploadsDir: path.join(root, 'uploads'), plannerCredential: createInMemoryPlannerCredential({ token }),
    modelCatalog: { getOptions: () => [{ provider: 'openai', model: 'gpt-5', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] }] },
    executeConversationAgent: async () => ({ stopTurn: true, terminationReason: 'synthetic' }) });
  t.after(async () => { await new Promise(resolve => app.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  for (const id of ['author', 'reviewer']) app.store.saveCustomRoleConfig({ id, name: id, personaPrompt: 'Synthetic', provider: 'openai', model: 'gpt-5' });
  const room = app.store.createConversation({ title: 'Merge test', participants: [{ agentId: 'author' }, { agentId: 'reviewer' }] });
  await new Promise(resolve => app.start(resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const invocations = Object.fromEntries(['author', 'reviewer'].map(id => [id, app.agentToolBridge.registerInvocation(app.agentToolBridge.createInvocationContext({
    conversationId: room.id, turnId: id + '-turn', agentId: id, agentName: id, conversationAgents: [app.store.getAgent('author'), app.store.getAgent('reviewer')],
  }))]));
  const snapshot = () => structuredClone(app.store.getConversationWithoutMessages(room.id).metadata);
  const goal = () => getSessionGoal(app.store.getConversationWithoutMessages(room.id));
  function seed() {
    applySessionGoalAction(app.store, room.id, { ...structuredClone(baseline), action: 'set', status: 'paused', owner: { agentId: 'author' }, ruledBy: { kind: 'user' } });
    return goal();
  }
  async function call(command, caller = 'planner', endpoint) {
    const g = goal();
    const response = await fetch(base + (endpoint || `/api/conversations/${room.id}/goal`), { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(caller === 'planner' ? { Authorization: 'Bearer ' + token }
        : caller === 'user' ? { Origin: base, 'X-CAFF-CSRF-Token': bootstrap.apiSecurity.csrfToken } : {}) },
      body: JSON.stringify(endpoint ? { invocationId: invocations[caller].invocationId, callbackToken: invocations[caller].callbackToken, ...command }
        : { goalId: g.goalId, goalRevision: g.revision, ...command }) });
    return { status: response.status, body: await response.json() };
  }
  return { app, room, seed, call, goal, snapshot };
}
function sameDelivery(a, b) { for (const field of fields) assert.deepEqual(a[field], b[field], field); }

for (const action of ['revise', 'update-delivery']) {
  for (const omitted of fields) {
    test(`${action} omission preserves ${omitted} including statuses/proof/timestamps`, async t => {
      const f = await fixture(t), old = f.seed();
      const patch = Object.fromEntries(fields.filter(field => field !== omitted).map(field => [field, old[field]]));
      const result = await f.call({ ...patch, action });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      sameDelivery(result.body.goal, old);
      assert.equal(result.body.goal.goalId, old.goalId);
      assert.equal(result.body.goal.revision, old.revision + 1);
      assert.deepEqual(result.body.goal.owner, old.owner);
      assert.equal(result.body.goal.status, 'paused');
    });
  }
  test(`${action} known IDs merge omitted record fields and partial decision groups`, async t => {
    const f = await fixture(t), old = f.seed();
    const result = await f.call({ action, decisions: { committed: old.decisions.committed }, acceptanceCriteria: [{ id: 'c1' }, { id: 'c2' }],
      workItems: [{ id: 'w1' }, { id: 'w2', status: 'done' }], evidence: [{ id: 'e1' }, { id: 'e2', summary: 'Replacement summary' }] });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.goal.decisions, old.decisions);
    assert.deepEqual(result.body.goal.acceptanceCriteria, old.acceptanceCriteria);
    assert.deepEqual(result.body.goal.workItems[0], old.workItems[0]);
    assert.equal(result.body.goal.workItems[1].status, 'done');
    assert.equal(result.body.goal.workItems[1].text, old.workItems[1].text);
    assert.deepEqual(result.body.goal.evidence[0], old.evidence[0]);
    assert.deepEqual(result.body.goal.evidence[1], { ...old.evidence[1], summary: 'Replacement summary' });
  });
  test(`${action} explicit empty collections replace, not union; validation still applies`, async t => {
    const f = await fixture(t), old = f.seed();
    const replacement = await f.call({ action, evidence: [{ id: 'e1' }] });
    assert.equal(replacement.status, 200);
    assert.deepEqual(replacement.body.goal.evidence, [old.evidence[0]]);
    const before = f.snapshot();
    const broken = await f.call({ action, evidence: [] });
    assert.equal(broken.status, 400);
    assert.deepEqual(f.snapshot(), before);
    const empty = await f.call({ action, evidence: [], acceptanceCriteria: [{ id: 'c1', status: 'pending', evidenceRefs: [] }, { id: 'c2' }] });
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.goal.evidence, []);
    const clearWork = await f.call({ action, workItems: [] }, 'user');
    assert.equal(clearWork.status, action === 'revise' ? 200 : 409);
    assert.equal(clearWork.body.code, action === 'revise' ? undefined : 'goal_structural_review_required');
  });
  test(`${action} rejects explicit null, malformed types and blank required patch text without writes`, async t => {
    const f = await fixture(t); f.seed();
    const bad = [ ...fields.flatMap(field => [{ [field]: null }, { [field]: 42 }]), { objective: '' }, { objective: '   ' },
      { decisions: [] }, { decisions: { committed: null } }, { decisions: { provisional: {} } },
      { acceptanceCriteria: {} }, { acceptanceCriteria: [null] }, { acceptanceCriteria: [{ id: 'c1', statement: '' }] },
      { acceptanceCriteria: [{ id: 'c1', verifyBy: '' }] }, { acceptanceCriteria: [{ id: 'c1', evidenceRefs: null }] },
      { acceptanceCriteria: [{ id: 'c2', waiver: null }] }, { workItems: [{ id: 'w1', text: '' }] }, { evidence: [{ id: 'e1', summary: '' }] },
      { evidence: [{ id: 'e1', criterionIds: null }] } ];
    for (const patch of bad) {
      const before = f.snapshot(), result = await f.call({ action, ...patch }, 'user');
      assert.equal(result.status, 400, JSON.stringify({ patch, result }));
      assert.deepEqual(f.snapshot(), before);
    }
  });
  test(`${action} canonical and legacy aliases merge before normalizing`, async t => {
    const f = await fixture(t), old = f.seed();
    const result = await f.call({ action, acceptance_criteria: [{ id: 'c1', verify_by: old.acceptanceCriteria[0].verifyBy }, { id: 'c2' }],
      checklist: old.workItems, decisions: {} });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    sameDelivery(result.body.goal, old);
    const canonicalWins = await f.call({ action, acceptanceCriteria: [{ id: 'c1' }, { id: 'c2' }], acceptance_criteria: null,
      workItems: old.workItems, checklist: null });
    assert.equal(canonicalWins.status, 200, JSON.stringify(canonicalWins.body));
    sameDelivery(canonicalWins.body.goal, old);
  });
}

test('revise accepts partial objective/decision edits without losing status, waivers or evidence', async t => {
  const f = await fixture(t), old = f.seed();
  const result = await f.call({ action: 'revise', objective: 'Only objective changed', decisions: { openQuestions: [] } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  sameDelivery(result.body.goal, { ...old, objective: 'Only objective changed', decisions: { ...old.decisions, openQuestions: [] } });
});

test('changed criterion definitions cannot silently inherit passing/waived proof', async t => {
  const f = await fixture(t); f.seed();
  for (const patch of [
    { acceptanceCriteria: [{ id: 'c1', statement: 'Different behavior' }, { id: 'c2' }] },
    { acceptanceCriteria: [{ id: 'c1', verifyBy: 'Different check', status: 'passed' }, { id: 'c2' }] },
    { acceptanceCriteria: [{ id: 'c1' }, { id: 'c2', statement: 'Different waived behavior', status: 'waived' }] },
  ]) {
    const before = f.snapshot(), result = await f.call({ action: 'revise', ...patch }, 'user');
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'goal_acceptance_state_required');
    assert.deepEqual(f.snapshot(), before);
  }
  const factual = await f.call({ action: 'update-delivery', acceptanceCriteria: [{ id: 'c1', statement: 'Different behavior' }, { id: 'c2' }] }, 'user');
  assert.equal(factual.status, 409);
  assert.equal(factual.body.code, 'goal_structural_review_required');
  const allowed = await f.call({ action: 'revise', acceptanceCriteria: [{ id: 'c1', statement: 'Different behavior', status: 'pending', evidenceRefs: [] }, { id: 'c2' }] }, 'user');
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.goal.acceptanceCriteria[0].status, 'pending');
  assert.deepEqual(allowed.body.goal.acceptanceCriteria[0].evidenceRefs, []);
});

test('agent partial revise proposal freezes merged state and user acceptance preserves omitted fields', async t => {
  const f = await fixture(t), old = f.seed();
  const result = await f.call({ action: 'revise', goal: { goalRevision: old.revision, objective: 'Reviewed partial objective', decisions: {} }, reason: 'Review partial change' }, 'author', '/api/agent-tools/goal/suggest');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const proposal = getSessionGoalProposal(f.app.store.getConversationWithoutMessages(f.room.id));
  sameDelivery(proposal, { ...old, objective: 'Reviewed partial objective' });
  const accepted = await f.call({ action: 'accept-proposal', proposalId: proposal.id }, 'user');
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  sameDelivery(accepted.body.goal, { ...old, objective: 'Reviewed partial objective' });
});

test('agent omission-only revise proposal preserves objective; explicit blank is rejected', async t => {
  const f = await fixture(t), old = f.seed();
  const result = await f.call({ action: 'revise', goal: { goalRevision: old.revision, workItems: [{ id: 'w1' }, { id: 'w2' }] } }, 'author', '/api/agent-tools/goal/suggest');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  sameDelivery(result.body.proposal, old);
  const before = f.snapshot();
  const blank = await f.call({ action: 'revise', goal: { goalRevision: old.revision, objective: '' } }, 'author', '/api/agent-tools/goal/suggest');
  assert.equal(blank.status, 400);
  assert.deepEqual(f.snapshot(), before);
});

test('agent partial factual update preserves pending proposal, ruling and runner counters', async t => {
  const f = await fixture(t); f.seed();
  proposeSessionGoalAction(f.app.store, f.room.id, { action: 'pause' }, { agentId: 'author', agentName: 'author' });
  applySessionGoalAction(f.app.store, f.room.id, { action: 'dismiss-proposal', ruledBy: { kind: 'user' } });
  const old = f.goal();
  f.app.store.updateConversationWithoutMessages(f.room.id, { metadata: { ...f.snapshot(), sessionGoalRunner: { goalUpdatedAt: old.updatedAt, iteration: 7, maxIterations: 20, consecutiveFailureCount: 2 } } });
  proposeSessionGoalAction(f.app.store, f.room.id, { action: 'pause', reason: 'Keep pending decision' }, { agentId: 'author', agentName: 'author' });
  const before = f.snapshot();
  const result = await f.call({ goal: { goalRevision: old.revision, workItems: [{ id: 'w1' }, { id: 'w2', status: 'done' }] } }, 'author', '/api/agent-tools/goal/update');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.goal.workItems[1].status, 'done');
  assert.deepEqual(f.snapshot().sessionGoalProposal, before.sessionGoalProposal);
  assert.deepEqual(f.snapshot().sessionGoalRuling, before.sessionGoalRuling);
  assert.equal(f.snapshot().sessionGoalRunner.iteration, 7);
  assert.equal(f.snapshot().sessionGoalRunner.consecutiveFailureCount, 2);
  assert.equal(f.snapshot().sessionGoalRunner.goalUpdatedAt, result.body.goal.updatedAt);
});

test('partial decision changes still require agent proposal reason/impact', async t => {
  const f = await fixture(t), old = f.seed();
  const bad = await f.call({ action: 'revise', goal: { goalRevision: old.revision, decisions: { provisional: [] } } }, 'author', '/api/agent-tools/goal/suggest');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'goal_provisional_change_context_required');
  const accepted = await f.call({ action: 'revise', goal: { goalRevision: old.revision, decisions: { provisional: [] }, impact: 'Scope changes' }, reason: 'New evidence' }, 'author', '/api/agent-tools/goal/suggest');
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body.proposal.decisions.committed, old.decisions.committed);
});

test('whole legacy payload matches the existing normalizer result', async t => {
  const { normalizeGoalDelivery } = require('../../build/server/domain/conversation/goal-contract');
  for (const action of ['revise', 'update-delivery']) {
    const f = await fixture(t), old = f.seed();
    const result = await f.call({ ...old, action });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    sameDelivery(result.body.goal, { objective: old.objective, ...normalizeGoalDelivery(old, result.body.goal.updatedAt) });
  }
});

test('explicit criterion/work/evidence removal and invalid duplicate IDs obey ordinary validation', async t => {
  const f = await fixture(t); f.seed();
  for (const patch of [ { acceptanceCriteria: [] }, { acceptanceCriteria: [{ id: 'c1' }, { id: 'c1' }] },
    { workItems: [{ id: 'w1' }, { id: 'w1' }] }, { evidence: [{ id: 'e1' }, { id: 'e1' }] } ]) {
    const before = f.snapshot(), result = await f.call({ action: 'revise', ...patch }, 'user');
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.deepEqual(f.snapshot(), before);
  }
  const factualDelete = await f.call({ action: 'update-delivery', acceptanceCriteria: [{ id: 'c1' }] });
  assert.equal(factualDelete.status, 409);
  assert.equal(factualDelete.body.code, 'goal_structural_review_required');
  const structuralDelete = await f.call({ action: 'revise', acceptanceCriteria: [{ id: 'c1' }], workItems: [] });
  assert.equal(structuralDelete.status, 200, JSON.stringify(structuralDelete.body));
  assert.equal(structuralDelete.body.goal.acceptanceCriteria.length, 1);
  assert.deepEqual(structuralDelete.body.goal.workItems, []);
});

test('merged factual updates cannot waive criteria or change objective, even with forged principal', async t => {
  const f = await fixture(t); f.seed();
  const reset = await f.call({ action: 'update-delivery', acceptanceCriteria: [{ id: 'c1', status: 'pending', evidenceRefs: [] }, { id: 'c2' }] });
  assert.equal(reset.status, 200);
  for (const [patch, status, code] of [
    [{ acceptanceCriteria: [{ id: 'c1', status: 'waived', waiver: { reason: 'Forged' } }, { id: 'c2' }] }, 403, 'goal_high_risk_waiver_user_required'],
    [{ acceptanceCriteria: [{ id: 'c1', risk: 'normal' }, { id: 'c2' }] }, 403, 'goal_high_risk_change_user_required'],
    [{ acceptanceCriteria: [{ id: 'c1' }, { id: 'c2', status: 'pending' }] }, 200, undefined],
    [{ objective: 'Factual structural shortcut' }, 409, 'goal_structural_review_required'],
  ]) {
    const before = f.snapshot(), result = await f.call({ goal: { ...patch, goalRevision: f.goal().revision, ruledBy: { kind: 'user' } } }, 'author', '/api/agent-tools/goal/update');
    assert.equal(result.status, status, JSON.stringify(result.body));
    if (code) assert.equal(result.body.code || result.body.error?.code, code);
    if (status !== 200) assert.deepEqual(f.snapshot(), before);
  }
  const normalWaiver = await f.call({ action: 'update-delivery', acceptanceCriteria: [{ id: 'c1' }, { id: 'c2', status: 'waived', waiver: { reason: 'Normal waiver needs review' } }] });
  assert.equal(normalWaiver.status, 409);
  assert.equal(normalWaiver.body.code, 'goal_waiver_review_required');
});

test('partial planner risk downgrade/removal returns 403 before proof-state validation', async t => {
  const f = await fixture(t); f.seed();
  for (const action of ['revise', 'update-delivery']) for (const acceptanceCriteria of [ [{ id: 'c1', risk: 'normal' }, { id: 'c2' }], [{ id: 'c2' }] ]) {
    const before = f.snapshot(), result = await f.call({ action, acceptanceCriteria });
    assert.equal(result.status, 403, JSON.stringify(result.body));
    assert.equal(result.body.code, 'goal_high_risk_change_user_required');
    assert.deepEqual(f.snapshot(), before);
  }
});

test('merge is non-mutating and partial proposal is a frozen snapshot, not a live patch', async t => {
  const { mergeGoalPatch } = require('../../build/server/domain/conversation/goal-patch');
  const f = await fixture(t), old = f.seed();
  const input = { acceptanceCriteria: [{ id: 'c1' }, { id: 'c2' }], evidence: [{ id: 'e1', summary: 'Next summary' }, { id: 'e2' }] };
  const oldCopy = structuredClone(old), inputCopy = structuredClone(input);
  mergeGoalPatch(old, input);
  assert.deepEqual(old, oldCopy);
  assert.deepEqual(input, inputCopy);
  const proposal = await f.call({ action: 'revise', goal: { goalRevision: old.revision, objective: 'Frozen proposal' } }, 'author', '/api/agent-tools/goal/suggest');
  assert.equal(proposal.status, 200);
  const updated = await f.call({ action: 'update-delivery', evidence: [{ id: 'e1', summary: 'Subsequent evidence' }, { id: 'e2' }] });
  assert.equal(updated.status, 200);
  const before = f.snapshot();
  assert.equal(before.sessionGoalProposal.evidence[0].summary, old.evidence[0].summary);
  const stale = await f.call({ action: 'accept-proposal', proposalId: proposal.body.proposal.id }, 'user');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'goal_revision_conflict');
  assert.deepEqual(f.snapshot(), before);
});
