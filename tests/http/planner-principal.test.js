const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { createServerApp } = require('../../build/server/app/create-server');
const { createInMemoryPlannerCredential, createPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { applySessionGoalAction, proposeSessionGoalAction, getSessionGoal, getSessionGoalProposal, getSessionGoalRuling } = require('../../build/server/domain/conversation/session-goal');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
isolateExternalIntegrations();

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-http-'));
  const token = randomBytes(32).toString('base64url');
  const credential = createInMemoryPlannerCredential({ token, plannerName: 'Test Planner' });
  const app = createServerApp({ host: '127.0.0.1', port: 0, agentDir: root, sqlitePath: path.join(root, 'chat.sqlite'),
    projectDir: root, uploadsDir: path.join(root, 'uploads'), plannerCredential: credential,
    modelCatalog: { getOptions: () => [{ provider: 'openai', model: 'gpt-5', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] }] },
    executeConversationAgent: async () => ({ stopTurn: true, terminationReason: 'synthetic' }), ...options });
  t.after(async () => { await new Promise(resolve => app.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.start(resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const csrfToken = bootstrap.apiSecurity?.csrfToken || bootstrap.localAdmin.systemServices.csrfToken;
  const author = app.store.saveCustomRoleConfig({ id: 'author', name: 'Author', personaPrompt: 'synthetic', provider: 'openai', model: 'gpt-5' });
  const room = app.store.createConversation({ title: 'Planner test', participants: [{ agentId: author.id }] });
  async function post(body, asPlanner = true, suffix = 'goal') {
    const response = await fetch(`${base}/api/conversations/${room.id}/${suffix}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(asPlanner ? { Authorization: 'Bearer ' + token } : { Origin: base, 'X-CAFF-CSRF-Token': csrfToken }) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { app, room, base, token, credential, post };
}
function criterion(overrides = {}) { return { id: 'c', statement: 'Observable outcome', verifyBy: 'synthetic test', status: 'pending', risk: 'normal', ...overrides }; }
function goalInput(overrides = {}) { return { objective: 'Planner principal', acceptanceCriteria: [criterion()], decisions: { committed: [], provisional: [], openQuestions: [], nonGoals: [], rejectedOptions: [] }, workItems: [], evidence: [], ...overrides }; }
function seed(f, overrides = {}) {
  applySessionGoalAction(f.app.store, f.room.id, { action: 'set', ...goalInput(overrides), ruledBy: { kind: 'user' } });
  applySessionGoalAction(f.app.store, f.room.id, { action: 'pause' });
  return getSessionGoal(f.app.store.getConversationWithoutMessages(f.room.id));
}
function propose(f, goal, overrides = {}) {
  return proposeSessionGoalAction(f.app.store, f.room.id, { ...goal, action: 'revise', reason: 'Independent ruling requested', ...overrides },
    { agentId: 'author', agentName: 'Author' });
}

test('CAFF initializes injected credentials after binding, never returns a token, and rejects invalid planner writes before parsing', async (t) => {
  const f = await fixture(t);
  assert.equal(f.credential.authenticate(f.token)?.kind, 'planner');
  const bootstrap = await (await fetch(f.base + '/api/bootstrap')).text();
  assert.equal(bootstrap.includes(f.token), false);
  const before = f.app.store.listConversations().length;
  for (const headers of [
    { 'X-CAFF-Principal': 'planner' }, { Authorization: 'Bearer ' + 'x'.repeat(43) }, { Authorization: 'Basic malformed' },
  ]) {
    const response = await fetch(f.base + '/api/conversations', { method: 'POST', headers, body: '{invalid-json' });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'planner_credential_invalid');
    assert.equal(f.app.store.listConversations().length, before);
  }
});

test('CAFF planner messages persist authenticated sender/source/principal; browser metadata cannot impersonate a planner', async (t) => {
  const f = await fixture(t);
  const result = await f.post({ content: 'Planner instruction', clientRequestId: 'planner-message', senderName: 'You',
    metadata: { source: 'web-ui', principal: { kind: 'user' } } }, true, 'messages');
  assert.equal(result.status, 200);
  const message = f.app.store.getMessage(result.body.acceptedMessage.id);
  assert.equal(message.role, 'user');
  assert.equal(message.senderName, 'Test Planner');
  assert.equal(message.metadata.source, 'planner');
  assert.deepEqual(message.metadata.principal, { kind: 'planner', plannerId: 'local-planner', plannerName: 'Test Planner' });
  assert.equal(result.body.acceptedMessage.content, undefined);
  assert.equal(result.body.conversation, undefined);
  const browser = await f.post({ content: 'Browser instruction', metadata: { source: 'planner', principal: { kind: 'planner' } }, senderName: 'Test Planner' }, false, 'messages');
  assert.equal(browser.status, 200);
  assert.equal(browser.body.acceptedMessage.senderName, 'You');
  assert.equal(browser.body.acceptedMessage.metadata.source, 'web-ui');
  assert.notEqual(browser.body.acceptedMessage.metadata.principal?.kind, 'planner');
});

test('CAFF planner rulings persist planner identity and ignore a forged user ruledBy', async (t) => {
  const f = await fixture(t);
  const current = seed(f);
  propose(f, current, { action: 'pause' });
  const result = await f.post({ action: 'accept-proposal', ruledBy: { kind: 'user' }, reason: 'Planner review' });
  assert.equal(result.status, 200);
  const ruling = getSessionGoalRuling(f.app.store.getConversationWithoutMessages(f.room.id));
  assert.deepEqual(ruling.ruledBy, { kind: 'planner', plannerId: 'local-planner', plannerName: 'Test Planner' });
  assert.deepEqual(result.body.ruling.ruledBy, ruling.ruledBy);
  assert.equal(result.body.conversation, undefined);
});

test('a planner never becomes a DAG verifier or user manual-verification path', async (t) => {
  const f = await fixture(t);
  const current = seed(f);
  propose(f, current, { action: 'pause' });
  const metadata = f.app.store.getConversationWithoutMessages(f.room.id).metadata;
  f.app.store.updateConversation(f.room.id, { metadata: { ...metadata,
    dagNodeGoalBinding: { planId: 'synthetic-plan', nodeId: 'node', workerId: 'author', verifierId: 'verifier' } } });
  const before = f.app.store.getConversationWithoutMessages(f.room.id).metadata;
  for (const action of ['accept-proposal', 'dismiss-proposal']) {
    const result = await f.post({ action, ruledBy: { kind: 'user' } });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'dag_verifier_only');
    assert.deepEqual(f.app.store.getConversationWithoutMessages(f.room.id).metadata, before);
  }
  assert.equal((await f.post({ action: 'accept-proposal' }, false)).status, 200);
  assert.equal(getSessionGoalRuling(f.app.store.getConversationWithoutMessages(f.room.id)).ruledBy.kind, 'user');
});

test('generic Room metadata writes cannot bypass Goal gates or erase server-owned Goal records', async (t) => {
  const f = await fixture(t);
  const current = seed(f, { decisions: { committed: [{ id: 'adr', statement: 'Keep contract', adrPath: 'docs/decisions/0001-goal-driven-workflow.md' }] } });
  const oldMetadata = f.app.store.getConversationWithoutMessages(f.room.id).metadata;
  f.app.store.updateConversation(f.room.id, { metadata: { ...oldMetadata,
    dagNodeGoalBinding: { planId: 'synthetic-plan', nodeId: 'node', workerId: 'author', verifierId: null } } });
  const before = f.app.store.getConversationWithoutMessages(f.room.id).metadata;
  const url = `${f.base}/api/conversations/${f.room.id}`;
  async function put(metadata) {
    const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.token }, body: JSON.stringify({ metadata }) });
    return { status: response.status, body: await response.json() };
  }
  for (const metadata of [
    { ...before, sessionGoal: { ...current, decisions: { committed: [] } } },
    { ...before, sessionGoalRuling: { ruledBy: { kind: 'user' }, outcome: 'accepted' } },
    { sessionGoal: null }, { dagNodeGoalBinding: null },
  ]) {
    assert.equal((await put(metadata)).status, 403);
    assert.deepEqual(f.app.store.getConversationWithoutMessages(f.room.id).metadata, before);
  }
  for (const metadata of [{ preference: 'unrelated' }, null, { ...before }]) {
    assert.equal((await put(metadata)).status, 200);
    const stored = f.app.store.getConversationWithoutMessages(f.room.id);
    assert.deepEqual(getSessionGoal(stored), current);
    assert.deepEqual(stored.metadata.dagNodeGoalBinding, before.dagNodeGoalBinding);
  }
});

test('CAFF disabled planner credentials do not downgrade bearer claims and leave browser reads usable', async (t) => {
  const logs = [];
  const disabled = createPlannerCredential({ env: { CAFF_PLANNER_CREDENTIAL_FILE: 'not-absolute' }, host: '127.0.0.1', getPort: () => 0, log: entry => logs.push(entry) });
  const f = await fixture(t, { plannerCredential: disabled });
  assert.ok(logs.some(entry => entry.event === 'planner_credentials_disabled'));
  assert.equal((await fetch(f.base + '/api/bootstrap')).status, 200);
  const result = await f.post({ action: 'set', ...goalInput() });
  assert.equal(result.status, 401);
  assert.equal(getSessionGoal(f.app.store.getConversationWithoutMessages(f.room.id)), null);
});

test('CAFF planner dismissals and normal-risk waiver reviews retain planner attribution', async (t) => {
  const f = await fixture(t);
  const current = seed(f);
  propose(f, current, { action: 'pause' });
  const dismissed = await f.post({ action: 'dismiss-proposal', reason: 'Not needed' });
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.ruling.outcome, 'rejected');
  assert.equal(dismissed.body.ruling.ruledBy.kind, 'planner');
  propose(f, current, { acceptanceCriteria: [criterion({ status: 'waived', waiver: { reason: 'Normal-risk reviewed exception' } })] });
  const reviewed = await f.post({ action: 'accept-proposal', reason: 'Independent planner review' });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.goal.acceptanceCriteria[0].waiver.waivedBy, 'Test Planner');
});

for (const kind of ['adr', 'high-risk']) {
  test(`CAFF ${kind} user gate rejects planner accept and direct revise/set without mutation; user acceptance succeeds`, async (t) => {
    const f = await fixture(t);
    const initial = kind === 'adr'
      ? { decisions: { committed: [{ id: 'adr', statement: 'Keep contract', adrPath: 'docs/decisions/0001-goal-driven-workflow.md' }] } }
      : { acceptanceCriteria: [criterion({ risk: 'high' })] };
    const current = seed(f, initial);
    const change = kind === 'adr' ? { decisions: { committed: [] } }
      : { acceptanceCriteria: [criterion({ risk: 'high', status: 'waived', waiver: { reason: 'User approval required' } })] };
    propose(f, current, change);
    const before = JSON.stringify(f.app.store.getConversationWithoutMessages(f.room.id).metadata);
    for (const input of [
      { action: 'accept-proposal' }, { ...current, ...change, action: 'revise' }, { ...goalInput(), ...change, action: 'set' },
      ...(kind === 'adr' ? [{ action: 'clear' }] : [{ ...current, ...change, action: 'update-delivery' },
        { ...current, action: 'set', acceptanceCriteria: [criterion({ risk: 'normal', status: 'waived', waiver: { reason: 'Cannot lower risk to bypass gate' } })] }]),
    ]) {
      const response = await f.post({ ...input, ...(['set', 'revise'].includes(input.action) ? {
        supersedeProposal: true, proposalId: getSessionGoalProposal(f.app.store.getConversationWithoutMessages(f.room.id)).id,
      } : {}) });
      assert.equal(response.status, 403);
      assert.equal(response.body.code, kind === 'adr' ? 'goal_accepted_adr_change_user_required' : 'goal_high_risk_waiver_user_required');
      assert.equal(JSON.stringify(f.app.store.getConversationWithoutMessages(f.room.id).metadata), before);
      assert.ok(getSessionGoalProposal(f.app.store.getConversationWithoutMessages(f.room.id)));
    }
    const user = await f.post({ action: 'accept-proposal', reason: 'Actual user ruling' }, false);
    assert.equal(user.status, 200);
    assert.equal(getSessionGoalRuling(f.app.store.getConversationWithoutMessages(f.room.id)).ruledBy.kind, 'user');
  });
}
