const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { createTestServerApp } = require('../helpers/server-app');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { applySessionGoalAction, proposeSessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
const { maybeAutoCreateConversationDigest } = require('../../build/server/domain/conversation/conversation-digest');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
isolateExternalIntegrations();
const model = { provider: 'openai', model: 'gpt-5', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] };
const contract = { objective: 'Initial Goal control', acceptanceCriteria: [{ id: 'c', statement: 'Observable behavior', verifyBy: 'Synthetic test', status: 'pending', risk: 'normal' }], workItems: [], evidence: [] };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-goal-initial-'));
  const token = randomBytes(32).toString('base64url'), calls = [];
  const catalog = { getOptions: () => [model], invalidate() {} };
  const app = createTestServerApp({ host: '127.0.0.1', port: 0, agentDir: root, sqlitePath: path.join(root, 'chat.sqlite'), projectDir: root,
    uploadsDir: path.join(root, 'uploads'), plannerCredential: createInMemoryPlannerCredential({ token }), modelCatalog: catalog,
    executeConversationAgent: async input => { calls.push(input.agent.id); return { stopTurn: true, terminationReason: 'synthetic' }; } });
  t.after(async () => { await new Promise(resolve => app.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  for (const [id, name] of [['first', 'First'], ['owner', 'Persisted Owner']]) app.store.saveCustomRoleConfig({ id, name, personaPrompt: 'Synthetic', provider: model.provider, model: model.model });
  app.store.saveCustomRoleConfig({ id: 'unavailable', name: 'Unavailable', personaPrompt: 'Synthetic', provider: 'missing', model: 'not-configured' });
  const room = app.store.createConversation({ participants: [{ agentId: 'first' }, { agentId: 'owner' }, { agentId: 'unavailable' }] });
  await new Promise(resolve => app.start(resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const projects = await (await fetch(base + '/api/projects')).json();
  async function post(endpoint, body, browser = false) {
    const headers = { 'Content-Type': 'application/json', ...(browser ? { Origin: base, 'X-CAFF-CSRF-Token': bootstrap.apiSecurity.csrfToken } : { Authorization: 'Bearer ' + token }) };
    const response = await fetch(base + endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const goal = command => {
    const metadata = app.store.getConversationWithoutMessages(room.id).metadata;
    return post(`/api/conversations/${room.id}/goal`, { goalId: metadata.sessionGoal?.goalId ?? null,
      goalRevision: metadata.sessionGoal?.revision ?? 0, ...(metadata.sessionGoalProposal ? { proposalId: metadata.sessionGoalProposal.id } : {}), ...command });
  };
  return { app, room, calls, catalog, post, goal, bootstrap, projects };
}

test('initial paused set persists a validated owner and schedules no continuation or execution', async t => {
  const f = await fixture(t);
  const result = await f.goal({ ...contract, action: 'set', owner: { agentId: 'owner', agentName: 'Forged name' }, status: 'paused' });
  assert.equal(result.status, 200);
  assert.equal(result.body.goal.status, 'paused');
  assert.deepEqual(result.body.goal.owner, { agentId: 'owner', agentName: 'Persisted Owner' });
  assert.equal(result.body.autoContinuation, null);
  assert.deepEqual(f.app.store.getConversation(f.room.id).messages, []);
  assert.deepEqual(f.calls, []);
});

test('active set schedules its first continuation to the explicit owner rather than roster order', async t => {
  const f = await fixture(t);
  // Remove the deliberately unavailable participant; the owner is second.
  f.app.store.updateConversation(f.room.id, { participants: [{ agentId: 'first' }, { agentId: 'owner' }] });
  const result = await f.goal({ ...contract, action: 'set', owner: { agentId: 'owner' }, status: 'active' });
  assert.equal(result.status, 200);
  assert.equal(result.body.autoContinuation.scheduled, true);
  assert.deepEqual(result.body.autoContinuation.message.metadata.initialAgentIds, ['owner']);
  for (let attempt = 0; f.calls.length === 0 && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls[0], 'owner');
});

for (const owner of [{ agentId: 'missing' }, { agentId: 'unavailable' }, { agentId: 'recovery_scribe' }, {}, null, 'owner']) {
  test(`initial set rejects invalid/unroutable owner ${JSON.stringify(owner)} before persistence or dispatch`, async t => {
    const f = await fixture(t), before = structuredClone(f.app.store.getConversationWithoutMessages(f.room.id).metadata);
    const result = await f.goal({ ...contract, action: 'set', owner, status: 'paused' });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'goal_owner_invalid');
    assert.deepEqual(f.app.store.getConversationWithoutMessages(f.room.id).metadata, before);
    assert.deepEqual(f.calls, []);
  });
}

test('initial owner validation includes the selected Room runtime profile', async t => {
  const f = await fixture(t);
  f.app.store.saveCustomRoleConfig({ ...f.app.store.getAgent('owner'), modelProfiles: [{ id: 'unroutable-profile', name: 'Broken profile', provider: 'missing', model: 'not-configured' }] });
  f.app.store.updateConversation(f.room.id, { participants: [{ agentId: 'first' }, { agentId: 'owner', modelProfileId: 'unroutable-profile' }] });
  const result = await f.goal({ ...contract, action: 'set', owner: { agentId: 'owner' }, status: 'paused' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'goal_owner_invalid');
  assert.equal(f.app.store.getConversationWithoutMessages(f.room.id).metadata.sessionGoal, undefined);
  assert.deepEqual(f.calls, []);
});

test('initial set rejects a non-initial status instead of silently activating', async t => {
  const f = await fixture(t);
  for (const status of ['complete', 'unknown', null]) {
    const result = await f.goal({ ...contract, action: 'set', status });
    assert.equal(result.status, 400);
    assert.equal(f.app.store.getConversationWithoutMessages(f.room.id).metadata.sessionGoal, undefined);
  }
});

test('set proposal preserves initial paused/explicit owner and revalidates the current roster on acceptance', async t => {
  const f = await fixture(t);
  proposeSessionGoalAction(f.app.store, f.room.id, { ...contract, action: 'set', status: 'paused', owner: { agentId: 'owner', agentName: 'Forged' } }, { agentId: 'first', agentName: 'First' });
  const result = await f.goal({ action: 'accept-proposal' });
  assert.equal(result.status, 200);
  assert.equal(result.body.goal.status, 'paused');
  assert.deepEqual(result.body.goal.owner, { agentId: 'owner', agentName: 'Persisted Owner' });
  assert.deepEqual(f.calls, []);
  applySessionGoalAction(f.app.store, f.room.id, { action: 'clear', ruledBy: { kind: 'user' } });
  proposeSessionGoalAction(f.app.store, f.room.id, { ...contract, action: 'set', status: 'paused', owner: { agentId: 'owner' } }, { agentId: 'first', agentName: 'First' });
  f.app.store.updateConversation(f.room.id, { participants: [{ agentId: 'first' }] });
  const before = structuredClone(f.app.store.getConversationWithoutMessages(f.room.id).metadata);
  const rejected = await f.goal({ action: 'accept-proposal' });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, 'goal_owner_invalid');
  assert.deepEqual(f.app.store.getConversationWithoutMessages(f.room.id).metadata, before);
});

for (const explicit of [true, false]) {
  test(`HTTP ${explicit ? 'explicit' : 'omitted'} creation title ${explicit ? 'stays manual' : 'auto-names'} through first message and title refinement`, async t => {
    const f = await fixture(t);
    const created = await f.post('/api/conversations', { ...(explicit ? { title: 'Caller chosen title' } : {}), projectScopeId: f.projects.projects[0].id,
      modeId: f.bootstrap.modes[0].id, participants: [{ agentId: 'first' }] }, true);
    assert.equal(created.status, 201);
    const id = created.body.conversation.id;
    assert.equal(f.app.store.getConversationTitleSource(id), explicit ? 'manual' : 'default');
    const sent = await f.post(`/api/conversations/${id}/messages`, { content: 'First message auto title' });
    assert.equal(sent.status, 200);
    assert.equal(f.app.store.getConversationWithoutMessages(id).title, explicit ? 'Caller chosen title' : 'First message auto title');
    // Exercise the actual auto-digest/title-refinement path with a synthetic
    // model. No provider, network or real credentials are involved.
    f.app.store.createMessage({ conversationId: id, role: 'assistant', agentId: 'first', senderName: 'First', content: 'Synthetic response', status: 'completed' });
    f.app.store.saveSystemServiceConfig('recovery_scribe', { enabled: true, provider: model.provider, model: model.model, thinking: 'off', timeoutMs: 60000 });
    let refined = 0;
    await maybeAutoCreateConversationDigest(f.app.store, id, { autoCreate: true, autoCreateMessageBudget: 2, autoCreateIdleMs: 0, autoCreateCooldownMs: 0,
      summaryMode: 'extractive', modelCatalog: f.catalog, digestModelRunner: async () => { refined++; return 'Auto title'; } });
    assert.equal(refined, explicit ? 0 : 1);
    assert.equal(f.app.store.getConversationWithoutMessages(id).title, explicit ? 'Caller chosen title' : 'Auto title');
  });
}
