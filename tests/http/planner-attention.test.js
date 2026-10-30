const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), test = require('node:test');
const { randomBytes } = require('node:crypto');
const { createTestServerApp: createServerApp } = require('../helpers/server-app');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { proposeSessionGoalAction, applySessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
isolateExternalIntegrations();
const criteria = [{ id: 'c', statement: 'Observable queue', verifyBy: 'HTTP assertions', status: 'pending' }];
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-attention-http-'));
  const token = randomBytes(32).toString('base64url');
  const options = { agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') };
  const app = createServerApp({ ...options, host: '127.0.0.1', port: 0, projectDir: root, uploadsDir: path.join(root, 'uploads'),
    plannerCredential: createInMemoryPlannerCredential({ token }),
    modelCatalog: { getOptions: () => [{ provider: 'openai', model: 'gpt-5', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] }] },
    executeConversationAgent: async () => ({ stopTurn: true, terminationReason: 'synthetic' }) });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await new Promise(resolve => app.close(resolve)); } };
  t.after(async () => { await close(); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.start(resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const room = app.store.createConversation({ title: 'Attention', participants: ['role-family-gpt'] });
  const room2 = app.store.createConversation({ title: 'Other attention', participants: ['role-family-gpt'] });
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const get = async (suffix = '', extra = {}) => {
    const r = await fetch(base + '/api/planner/attention' + suffix, { headers, ...extra });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  const propose = (id = room.id) => proposeSessionGoalAction(app.store, id,
    { action: 'set', objective: 'Synthetic Goal', acceptanceCriteria: criteria, status: 'paused' }, { agentId: 'role-family-gpt', agentName: 'GPT' });
  return { app, root, options, token, base, headers, room, room2, get, propose, close };
}
const immediate = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('condition did not become observable');
}

test('planner attention reads require a valid credential and never fall back to browser authority', async t => {
  const f = await fixture(t); f.propose();
  for (const headers of [{}, { 'X-CAFF-Principal': 'planner' }, { Authorization: 'Bearer ' + 'x'.repeat(43) }, { Authorization: 'Basic wrong' }]) {
    const r = await f.get('', { headers }); assert.equal(r.status, 401); assert.equal(r.body.code, 'planner_credential_invalid');
  }
  const r = await f.get(); assert.equal(r.status, 200); assert.equal(r.body.items.length, 1);
  assert.equal(r.headers.get('Cache-Control'), 'no-store'); assert.equal(JSON.stringify(r.body).includes(f.token), false);
});

test('HTTP list pages and resolved-offline replay retain a safe cursor with exact filters', async t => {
  const f = await fixture(t); f.propose(); f.propose(); f.propose(f.room2.id);
  const first = await f.get('?limit=1'); assert.equal(first.body.hasMore, true);
  const rest = await f.get('?after=' + first.body.nextCursor);
  assert.equal(rest.body.items.length, 2); assert.equal(rest.body.hasMore, false);
  assert.equal(first.body.items[0].resolution, 'proposal_superseded');
  const filtered = await f.get('?status=unresolved&conversationId=' + f.room2.id);
  assert.equal(filtered.body.items.length, 1); assert.equal(filtered.body.nextCursor, rest.body.highWatermark);
  const immediateWait = await f.get('/wait?after=0&timeoutSeconds=1');
  assert.equal(immediateWait.body.timedOut, false); assert.ok(immediateWait.body.items.length);
});

for (const query of ['after=-1', 'after=1.5', 'after=9007199254740992', 'after=', 'after=0&after=1',
  'limit=0', 'limit=501', 'status=pending', 'conversationId=', 'timeoutSeconds=0', 'timeoutSeconds=301']) {
  test(`invalid attention wait query is rejected: ${query}`, async t => {
    const f = await fixture(t), r = await f.get('/wait?' + query);
    assert.equal(r.status, 400); assert.equal(r.body.code, 'attention_query_invalid');
  });
}

test('wait wakes on committed matching items, not unrelated Room events, and timeout returns an empty safe cursor', async t => {
  const f = await fixture(t);
  const pending = f.get('/wait?conversationId=' + f.room.id + '&timeoutSeconds=2');
  await waitFor(() => f.app.plannerAttentionWait.getStats().pending === 1);
  f.propose(f.room2.id); await immediate();
  assert.equal(f.app.plannerAttentionWait.getStats().pending, 1);
  f.propose(); const response = await pending;
  assert.equal(response.status, 200); assert.equal(response.body.timedOut, false);
  assert.ok(response.body.items.every(i => i.conversationId === f.room.id));
  assert.equal(f.app.plannerAttentionWait.getStats().pending, 0);
  const timeout = await f.get('/wait?after=' + response.body.highWatermark + '&timeoutSeconds=1');
  assert.equal(timeout.status, 200); assert.equal(timeout.body.timedOut, true); assert.deepEqual(timeout.body.items, []);
  assert.ok(timeout.body.nextCursor >= response.body.highWatermark);
});

test('turn attention committed through a separate run-store connection wakes HTTP wait', async t => {
  const f = await fixture(t);
  applySessionGoalAction(f.app.store, f.room.id, { action: 'set', objective: 'Observe failure', status: 'paused', acceptanceCriteria: criteria });
  const pending = f.get('/wait?timeoutSeconds=2');
  await waitFor(() => f.app.plannerAttentionWait.getStats().pending === 1);
  const run = createSqliteRunStore(f.options);
  try {
    run.createTask({ taskId: 'root', kind: 'conversation_turn', status: 'running', metadata: { conversationId: f.room.id, turnId: 'synthetic-turn' } });
    run.updateTask('root', { status: 'failed', artifactSummary: { failedAgentIds: ['role-family-gpt'] } });
  } finally { run.close(); }
  const r = await pending; assert.equal(r.body.timedOut, false); assert.equal(r.body.items[0].kind, 'turn_failed');
});

test('HTTP acknowledgement retains server principal/reason, is idempotent, and cannot hide a proposal', async t => {
  const f = await fixture(t); f.propose(); const item = (await f.get()).body.items[0];
  const post = (sequence, reason) => f.get('/' + sequence + '/resolve', { method: 'POST',
    body: JSON.stringify({ reason, principal: { kind: 'user' } }) });
  assert.equal((await post(item.sequence, 'Hide pending proposal')).status, 409);
  assert.equal((await post(item.sequence, '')).body.code, 'attention_reason_required');
  const ackable = f.app.store.plannerAttentionRepository.append({ conversationId: f.room.id, goalId: 'synthetic-goal', goalRevision: 1,
    kind: 'turn_failed', sourceId: 'synthetic-ack', summary: 'Synthetic failure', createdAt: new Date().toISOString() });
  const ack = await post(ackable.sequence, 'Reviewed'); assert.equal(ack.status, 200);
  assert.equal(ack.body.item.resolvedBy.kind, 'planner');
  assert.deepEqual((await post(ackable.sequence, 'Changed reason')).body.item, ack.body.item);
  assert.equal((await post(99999, 'Unknown')).body.code, 'attention_not_found');
});

test('disconnect removes waiter listeners/timers and shutdown finishes long waits without invented items', async t => {
  const f = await fixture(t);
  const request = http.get(f.base + '/api/planner/attention/wait?timeoutSeconds=300', { headers: f.headers });
  request.on('error', () => {});
  await waitFor(() => f.app.plannerAttentionWait.getStats().pending === 1);
  request.destroy(); await waitFor(() => f.app.plannerAttentionWait.getStats().pending === 0);
  const pending = f.get('/wait?timeoutSeconds=300');
  await waitFor(() => f.app.plannerAttentionWait.getStats().pending === 1);
  const closing = f.close(); const r = await pending; await closing;
  assert.equal(r.status, 503); assert.equal(r.body.code, 'planner_wait_closed'); assert.equal(r.body.items, undefined);
  assert.equal(f.app.plannerAttentionWait.getStats().pending, 0);
});
