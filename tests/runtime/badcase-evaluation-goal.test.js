// Real loopback HTTP + production handlers, synthetic production-shaped trace.
// No model, production store, provider credential or archived command execution.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');
const { buildErrorJsonPayload } = require('../../build/server/http/response');
const { SYSTEM_MODEL_FAMILY_ROLES } = require('../../build/server/domain/roles/system-role-catalog');
const hash = v => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const family = SYSTEM_MODEL_FAMILY_ROLES.find(a => a.id === 'role-family-gpt');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-eval-goal-')), services = [];
  t.after(async () => { for (const s of services) await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const association = { projectId: 'project-goal', conversationId: 'room-goal', turnId: 'turn-goal', agentId: family.id, userMessageId: 'user-goal', assistantMessageId: 'assistant-goal' };
  const trace = JSON.stringify({ schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association,
    assistantCreatedAt: '2026-01-01T00:00:01.000Z', conversation: { title: 'Synthetic marked-badcase', type: 'standard', metadata: {} },
    participants: [{ id: family.id, name: family.name, description: family.description }], publicMessages: [{ id: association.userMessageId, turnId: association.turnId,
      role: 'user', agentId: null, senderName: 'User', content: 'Frozen task', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] }], privateMessages: [], pendingDelegations: [] });
  const input = { trace, association, expectedTraceHash: hash(trace), lifetimeMs: 30000 };
  async function start(name = 'run', goalTools) {
    const service = await require('../../build/server/domain/runtime/badcase-capture/evaluation-callback').startEvaluationCallback({ ...input, directory: path.join(root, name), ...(goalTools === undefined ? {} : { goalTools }) });
    services.push(service); return service;
  }
  return { root, input, start };
}
async function request(s, route, params, credentials = s.credentials) {
  const url = new URL(s.apiUrl + '/api/agent-tools/' + route);
  if (params === undefined) for (const [k, v] of Object.entries(credentials)) url.searchParams.set(k, v);
  const r = await fetch(url, { method: params === undefined ? 'GET' : 'POST', headers: { Connection: 'close', ...(params === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(params === undefined ? {} : { body: JSON.stringify({ ...credentials, ...params }) }) });
  const text = await r.text(); return { status: r.status, text, value: JSON.parse(text) };
}
function reference(t, s, association) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-eval-goal-ref-'));
  const store = createChatAppStore({ agentDir: dir, sqlitePath: path.join(dir, 'ref.sqlite') });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.createConversation({ id: association.conversationId, title: 'Synthetic marked-badcase', type: 'standard', participants: [family.id], metadata: {} });
  store.createMessage({ id: association.assistantMessageId, conversationId: association.conversationId, turnId: association.turnId,
    role: 'assistant', agentId: family.id, senderName: family.name, content: 'Thinking...', status: 'streaming' });
  if (s.readGoalEvidence().seed) store.db.prepare('UPDATE chat_conversations SET metadata_json=? WHERE id=?').run(JSON.stringify({ sessionGoal: s.readGoalEvidence().seed }), association.conversationId);
  const bridge = createAgentToolBridge({ store, agentDir: dir });
  const ctx = bridge.registerInvocation(bridge.createInvocationContext({ invocationId: 'reference-invocation', callbackToken: 'reference-auth', ...association,
    agentName: family.name, conversationAgents: store.getConversation(association.conversationId).agents, stage: { status: 'running' }, allowHandoffs: false }));
  t.after(() => bridge.unregisterInvocation(ctx.invocationId));
  return (route, params) => {
    try { return { status: 200, value: bridge[route === 'goal/suggest' ? 'handleSuggestGoal' : 'handleUpdateGoal']({ ...params, invocationId: ctx.invocationId, callbackToken: ctx.callbackToken }) }; }
    catch (e) { return { status: e.statusCode, value: buildErrorJsonPayload(e) }; }
  };
}
// Date is fixed in the parity test. Only independently generated proposal and
// supersession-ruling IDs differ between the two handler executions.
function generated(v) { return JSON.parse(JSON.stringify(v).replace(/prop_[a-f0-9-]{36}/g, 'prop_ID').replace(/ruling_[a-f0-9-]{36}/g, 'ruling_ID')); }

test('Goal handlers match production errors/order and successful proposal transitions on the same explicit seed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T00:00:00.000Z') });
  const f = fixture(t), s = await f.start(), ref = reference(t, s, f.input.association);
  for (const [route, params, expected] of [
    ['goal/suggest', { action: 'pause', reason: 'x'.repeat(1001) }, 400],
    ['goal/suggest', { action: 'complete', reason: 'x'.repeat(1001) }, 409],
    ['goal/update', {}, 400], ['goal/update', { goal: { action: 'pause' } }, 400],
    ['goal/suggest', { action: 'bind-planner' }, 403],
    ['goal/suggest', { action: 'pause', reason: 'x'.repeat(1000) }, 200],
    ['goal/suggest', { action: 'pause', reason: 'replacement' }, 200],
    ['goal/suggest', { action: 'accept' }, 403],
  ]) {
    const actual = await request(s, route, params), expectedResult = ref(route, params);
    assert.equal(actual.status, expected); assert.equal(actual.status, expectedResult.status);
    assert.deepEqual(generated(actual.value), generated(expectedResult.value));
    if (expected === 400 && route === 'goal/suggest') { assert.equal(Object.hasOwn(actual.value, 'code'), false); assert.equal(Object.hasOwn(actual.value, 'goal'), false); }
  }
  const initial = s.readGoalEvidence();
  const update = structuredClone(initial.seed); update.workItems[0].status = 'in_progress';
  const a = await request(s, 'goal/update', { goal: update }), b = ref('goal/update', { goal: update });
  assert.equal(a.status, 200); assert.deepEqual(generated(a.value), generated(b.value));
  assert.equal(a.value.goal.workItems[0].status, 'in_progress');
});

test('explicit unseeded Goal store returns the real production 404, without fallback', async t => {
  const f = fixture(t), s = await f.start('none', { initialState: 'none', executionId: crypto.randomUUID() });
  const actual = await request(s, 'goal/suggest', { action: 'pause', reason: 'x'.repeat(1001) });
  const expected = reference(t, s, f.input.association)('goal/suggest', { action: 'pause', reason: 'x'.repeat(1001) });
  assert.equal(actual.status, 404); assert.deepEqual(actual.value, expected.value); assert.equal(s.readGoalEvidence().seed, null);
});

test('minimal seed/immutable call ledger is execution-bound, append-only and durable; caller mutation cannot alter it', async t => {
  const f = fixture(t), executionId = crypto.randomUUID(), s = await f.start('ledger', { initialState: 'minimal', executionId });
  const before = s.readGoalEvidence();
  assert.equal(before.executionId, executionId); assert.equal(before.goalState, 'approximate-minimal-v1');
  assert.equal(before.seedHash, hash(before.seed)); assert.equal(before.seed.status, 'active'); assert.equal(before.seed.revision, 1);
  assert.equal(before.seed.owner.agentId, family.id); assert.equal(before.seed.acceptanceCriteria.length, 1);
  assert.equal(before.seed.acceptanceCriteria[0].status, 'pending'); assert.equal(before.seed.workItems.length, 1); assert.equal(before.seed.workItems[0].status, 'todo'); assert.deepEqual(before.seed.evidence, []);
  const rejected = await request(s, 'goal/suggest', { action: 'pause', reason: 'x'.repeat(1001) });
  const succeeded = await request(s, 'goal/suggest', { action: 'pause', reason: 'literal parsed reason' });
  const evidence = s.readGoalEvidence(); assert.equal(evidence.calls.length, 2);
  for (const [i, response] of [rejected, succeeded].entries()) {
    const c = evidence.calls[i]; assert.equal(c.executionId, executionId); assert.equal(c.sequence, i + 1); assert.equal(c.endpoint, 'goal/suggest');
    assert.equal(c.statusCode, response.status); assert.equal(c.errorCode, null); assert.deepEqual(c.response, response.value);
    assert.equal(Object.hasOwn(c.parameters, 'callbackToken'), false); assert.equal(Object.hasOwn(c.parameters, 'invocationId'), false);
  }
  assert.equal(evidence.calls[1].parameters.reason, 'literal parsed reason');
  const original = JSON.stringify(evidence); evidence.calls[0].parameters.reason = 'mutated'; evidence.seed.status = 'completed';
  assert.equal(JSON.stringify(s.readGoalEvidence()), original);
  await s.stop();
  const store = createChatAppStore({ agentDir: path.dirname(s.goalDatabasePath), sqlitePath: s.goalDatabasePath });
  try {
    assert.throws(() => store.db.prepare('UPDATE evaluation_goal_calls SET record_json=?').run('{}'), /immutable/);
    assert.throws(() => store.db.prepare('DELETE FROM evaluation_goal_calls').run(), /immutable/);
    assert.throws(() => store.db.prepare('UPDATE evaluation_goal_seed SET record_json=?').run('{}'), /immutable/);
    assert.equal(store.db.prepare('SELECT record_json FROM evaluation_goal_calls ORDER BY sequence').all().length, 2);
    const publicStore = createChatAppStore({ agentDir: path.dirname(s.databasePath), sqlitePath: s.databasePath });
    try { assert.equal(Object.hasOwn(publicStore.getConversation(f.input.association.conversationId).metadata, 'sessionGoal'), false); } finally { publicStore.close(); }
  } finally { store.close(); }
});

test('Goal enablement and mutation do not change frozen inputs or non-Goal response bytes on the same public store state', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T00:00:00.000Z') });
  const f = fixture(t), frozen = JSON.stringify(f.input), s = await f.start(), off = await f.start('disabled', false);
  // Exact same public state and request sequence, including context cursor and
  // public-post timestamps. Compare bytes, not a lossy normalized projection.
  for (const route of ['context', 'participants']) assert.equal((await request(s, route)).text, (await request(off, route)).text);
  assert.equal((await request(s, 'goal/suggest', { action: 'pause', reason: 'success' })).status, 200);
  for (const route of ['context', 'participants']) {
    const actual = await request(s, route), expected = await request(off, route);
    assert.equal(actual.text, expected.text); assert.equal(actual.text.includes('sessionGoal'), false);
  }
  const post = { visibility: 'public', content: 'Identical post', noFinalize: true };
  assert.equal((await request(s, 'post-message', post)).text, (await request(off, 'post-message', post)).text);
  for (const route of ['context', 'participants']) assert.equal((await request(s, route)).text, (await request(off, route)).text);
  assert.equal((await request(off, 'goal/suggest', { action: 'pause' })).status, 404);
  assert.equal(JSON.stringify(f.input), frozen); assert.equal(s.traceReceipt.traceHash, hash(f.input.trace)); assert.deepEqual(s.traceReceipt, off.traceReceipt);
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/badcase-capture/direct-sdk-container.cjs'), 'utf8');
  assert.match(source, /readGoalEvidence/); // real trace worker must retain the seed/records, not just unit-only callback support
});

test('two executions isolate Goal proposals/records/IDs, and unsupported routes and cross-auth stay closed', async t => {
  const f = fixture(t), a = await f.start(), b = await f.start('second');
  assert.notEqual(a.goalDatabasePath, b.goalDatabasePath); assert.notEqual(a.readGoalEvidence().executionId, b.readGoalEvidence().executionId);
  assert.notEqual(a.readGoalEvidence().seed.goalId, b.readGoalEvidence().seed.goalId);
  assert.equal((await request(b, 'goal/suggest', { action: 'pause' }, a.credentials)).status, 401);
  assert.equal((await request(a, 'goal/suggest', { action: 'pause', reason: 'only A' })).status, 200);
  assert.equal(b.readGoalEvidence().calls.length, 0);
  for (const route of ['delegation/create', 'capabilities/room_workspace_bind', 'conversation-request', 'search-memory']) assert.equal((await request(a, route, {})).status, 404);
  assert.equal((await request(a, 'post-message', { visibility: 'private', content: 'no' })).status, 400);
  assert.equal((await request(a, 'post-message', { visibility: 'public', content: 'finished' })).status, 200);
  assert.equal((await request(a, 'goal/suggest', { action: 'pause' })).status, 409);
});

test('Goal ledger never stores callback auth, including malicious nested/embedded copies', async t => {
  const f = fixture(t), s = await f.start();
  for (const params of [{ action: 'pause', reason: s.credentials.callbackToken }, { action: 'set', goal: { reason: 'prefix ' + s.credentials.invocationId, callbackToken: s.credentials.callbackToken } }]) {
    assert.equal((await request(s, 'goal/suggest', params)).status, 400);
  }
  assert.equal(s.readGoalEvidence().calls.length, 2);
  await s.stop();
  for (const dir of [path.dirname(s.databasePath), path.dirname(s.goalDatabasePath)]) for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name); if (!fs.statSync(file).isFile()) continue;
    const bytes = fs.readFileSync(file); for (const value of Object.values(s.credentials)) assert.equal(bytes.includes(Buffer.from(value)), false, file);
  }
});

test('supported public callback calls also record their parsed parameters and exact responses, including rejections', async t => {
  const f = fixture(t), s = await f.start();
  const responses = [await request(s, 'context'), await request(s, 'participants'),
    await request(s, 'post-message', { visibility: 'public', content: 'literal stdin content', noFinalize: true }),
    await request(s, 'post-message', { visibility: 'private', content: 'unsupported' })];
  const evidence = s.readGoalEvidence(); assert.equal(evidence.calls.length, 4);
  assert.deepEqual(evidence.calls.map(c => c.endpoint), ['context', 'participants', 'post-message', 'post-message']);
  for (const [i, r] of responses.entries()) { assert.equal(evidence.calls[i].statusCode, r.status); assert.deepEqual(evidence.calls[i].response, r.value); }
  assert.equal(evidence.calls[2].parameters.content, 'literal stdin content'); assert.deepEqual(evidence.calls[0].parameters, {});
  const { validateEvaluationGoalEvidence } = require('../../build/server/domain/runtime/badcase-capture/evaluation-goal-evidence');
  assert.deepEqual(validateEvaluationGoalEvidence(evidence), evidence);
  for (const change of [v => v.seedHash = '0'.repeat(64), v => v.executionId = 'other', v => v.calls[0].sequence = 8,
    v => v.calls[0].executionId = crypto.randomUUID(), v => v.calls[0].parameters.callbackToken = 'not-allowed', v => v.calls[0].errorCode = 'forged',
    v => v.seed.acceptanceCriteria[0].status = 'passed']) {
    const v = structuredClone(evidence); change(v); assert.throws(() => validateEvaluationGoalEvidence(v), { code: 'evaluation_goal_evidence_invalid' });
  }
});

test('Goal marker projection validates identities/hashes and leaves absent legacy fields absent', async t => {
  const f = fixture(t), s = await f.start(), evidence = s.readGoalEvidence();
  const { evaluationGoalMarker, projectEvaluationGoalMarker } = require('../../build/server/domain/runtime/badcase-capture/evaluation-goal-evidence');
  const marker = evaluationGoalMarker(evidence);
  assert.deepEqual(projectEvaluationGoalMarker(marker), marker); assert.deepEqual(projectEvaluationGoalMarker({ status: 'pass' }), {});
  assert.throws(() => projectEvaluationGoalMarker({ ...marker, goalSeedHash: '' }));
});
