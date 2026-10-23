const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), test = require('node:test');
const { randomBytes } = require('node:crypto');
const { createServerApp } = require('../../build/server/app/create-server');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { applySessionGoalAction, proposeSessionGoalAction, getSessionGoal } = require('../../build/server/domain/conversation/session-goal');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
isolateExternalIntegrations();
const agent = { agentId: 'role-family-gpt', agentName: 'GPT' };
const criteria = [{ id: 'c', statement: 'Monitor safely', verifyBy: 'HTTP tests' }];
async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-state-'));
  const token = randomBytes(32).toString('base64url');
  const options = { agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') };
  const app = createServerApp({ ...options, host: '127.0.0.1', port: 0, projectDir: root, uploadsDir: path.join(root, 'uploads'),
    plannerCredential: createInMemoryPlannerCredential({ token }),
    modelCatalog: { getOptions: () => [{ key: 'openai\u001fgpt-5', provider: 'openai', model: 'gpt-5', family: 'gpt', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] }] },
    executeConversationAgent: async () => ({ stopTurn: true, terminationReason: 'synthetic' }), ...overrides });
  const cleanups = [];
  t.after(async () => { for (const close of cleanups) close(); await new Promise(resolve => app.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.start(resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  app.store.saveSystemRoleConfig({ id: agent.agentId, provider: 'openai', model: 'gpt-5', thinking: 'off' });
  const room = app.store.createConversation({ title: 'Monitor', participants: ['role-family-gpt'] });
  const statePath = '/api/planner/conversations/' + room.id + '/state';
  const get = async (url = statePath, headers = { Authorization: 'Bearer ' + token }) => {
    const r = await fetch(base + url, { headers }); const text = await r.text();
    return { status: r.status, body: JSON.parse(text), text, headers: r.headers };
  };
  const set = (id = room.id) => applySessionGoalAction(app.store, id,
    { action: 'set', status: 'paused', objective: 'Bounded monitoring', acceptanceCriteria: criteria, owner: { agentId: agent.agentId } });
  const metadata = value => app.store.db.prepare('UPDATE chat_conversations SET metadata_json=? WHERE id=?').run(JSON.stringify(value), room.id);
  return { app, options, token, room, statePath, get, set, metadata, cleanups };
}
function forbidHydration(store) {
  for (const name of ['getConversation', 'getConversationWithoutMessages', 'listConversations', 'listConversationTree',
    'listMessages', 'listConversationAgents', 'listConversationDirectoryPage', 'listPrivateMessages', 'listPendingMainUserMessages']) {
    store[name] = () => assert.fail('monitoring hydrated via ' + name);
  }
}

test('state and portfolio require valid planner credentials with no browser fallback', async t => {
  const f = await fixture(t);
  for (const url of [f.statePath, '/api/planner/portfolio']) {
    for (const headers of [{}, { 'X-CAFF-Principal': 'planner' }, { Authorization: 'Bearer wrong' }, { Authorization: 'Basic wrong' }]) {
      const r = await f.get(url, headers); assert.equal(r.status, 401); assert.equal(r.body.code, 'planner_credential_invalid');
    }
    const r = await f.get(url); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.text.includes(f.token), false);
  }
});

test('empty Room state is explicit null projections; missing Room is 404', async t => {
  const f = await fixture(t); forbidHydration(f.app.store);
  const runSchema = () => f.app.store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'a2a_%' ORDER BY name").all();
  const before = runSchema();
  const r = await f.get(); assert.equal(r.status, 200);
  assert.deepEqual(r.body, { conversationId: f.room.id, goal: null, proposal: null, ruling: null, runner: null, busy: false, lastTurn: null });
  assert.equal((await f.get('/api/planner/conversations/absent/state')).status, 404);
  assert.deepEqual((await f.get('/api/planner/portfolio')).body.items, []);
  assert.deepEqual(runSchema(), before, 'monitoring must not create run tables');
});

test('state summarizes normalized Goal counts and allowlisted proposal/ruling/binding, not delivery bodies', async t => {
  const f = await fixture(t), s = f.app.store;
  f.set(); const initial = s.getConversationWithoutMessages(f.room.id);
  const goal = getSessionGoal(initial);
  f.metadata({ ...initial.metadata, unrelated: 'DO_NOT_EXPOSE', sessionGoal: { ...goal,
    decisions: { committed: [{ statement: 'DECISION_BODY', adrPath: 'PRIVATE_PATH' }], provisional: ['PROVISIONAL_BODY'],
      openQuestions: [{ question: 'QUESTION_BODY' }], nonGoals: ['NON_GOAL_BODY'], rejectedOptions: ['REJECTED_BODY'] },
    acceptanceCriteria: [{ statement: 'CRITERION_BODY', status: 'pending' }, { statement: 'OTHER_BODY', status: 'failed', risk: 'high' },
      { statement: 'PASSED_BODY', status: 'passed' }, { statement: 'WAIVED_BODY', status: 'waived' }],
    workItems: [{ text: 'WORK_BODY', status: 'todo' }, { text: 'DOING_BODY', status: 'in_progress' }, { text: 'DONE_BODY', status: 'done' }],
    evidence: [{ summary: 'EVIDENCE_BODY', reference: 'PRIVATE_EVIDENCE_PATH' }] },
    sessionGoalProposal: { id: 'p', action: 'pause', baseRevision: 1, proposedBy: agent, reason: 'Review',
      createdAt: goal.createdAt, updatedAt: goal.updatedAt, arbitrary: 'PROPOSAL_EXTRA' },
    sessionGoalRuling: { id: 'r', proposalId: 'old-p', action: 'pause', outcome: 'rejected', ruledBy: { kind: 'planner', plannerId: 'local-planner', plannerName: 'External Planner', private: 'PRINCIPAL_EXTRA' },
      reason: 'Not yet', ruledAt: goal.updatedAt, proposalSnapshot: { id: 'old-p', action: 'pause', reason: 'SNAPSHOT_BODY' } },
    sessionGoalPlannerBinding: { goalId: goal.goalId, plannerId: 'local-planner', plannerName: 'External Planner', boundAt: goal.createdAt,
      adoption: { boundBy: { kind: 'user', extra: 'ADOPTION_EXTRA' }, reason: 'Explicit adoption', extra: 'ADOPTION_EXTRA' }, extra: 'BINDING_EXTRA' },
    sessionGoalRunner: { status: 'error_paused', iteration: 2, maxIterations: 20, updatedAt: goal.updatedAt,
      lastFailureSummary: 'token=synthetic-value', extension: 'RUNNER_EXTRA' } });
  forbidHydration(s);
  const r = await f.get(); assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['conversationId', 'goal', 'proposal', 'ruling', 'runner', 'busy', 'lastTurn'].sort());
  assert.equal(r.body.goal.goalId, goal.goalId); assert.equal(r.body.goal.revision, goal.revision);
  assert.deepEqual(r.body.goal.owner, agent);
  assert.deepEqual(r.body.goal.decisionCounts, { committed: 1, provisional: 1, openQuestions: 1, nonGoals: 1, rejectedOptions: 1 });
  assert.deepEqual(r.body.goal.acceptanceCounts, { pending: 1, passed: 1, failed: 1, waived: 1, highRisk: 1 });
  assert.deepEqual(r.body.goal.workItemCounts, { todo: 1, in_progress: 1, done: 1 });
  assert.equal(r.body.goal.evidenceCount, 1);
  assert.deepEqual(r.body.proposal, { id: 'p', action: 'pause', baseRevision: 1, proposedBy: agent, reason: 'Review', createdAt: goal.createdAt, updatedAt: goal.updatedAt });
  assert.deepEqual(Object.keys(r.body.ruling).sort(), ['id', 'proposalId', 'action', 'outcome', 'ruledBy', 'reason', 'ruledAt'].sort());
  assert.deepEqual(r.body.goal.plannerBinding.adoption, { boundBy: { kind: 'user' }, reason: 'Explicit adoption' });
  assert.equal(r.body.runner.iteration, 2); assert.equal(r.body.runner.lastFailureSummary.includes('synthetic-value'), false);
  for (const marker of ['_BODY', 'PRIVATE_', '_EXTRA', 'DO_NOT_EXPOSE']) assert.equal(r.text.includes(marker), false, marker);
});

test('legacy ruling without a stored ID does not invent a new monitoring identity', async t => {
  const f = await fixture(t);
  f.metadata({ sessionGoalRuling: { proposalId: 'p', action: 'pause', outcome: 'accepted',
    proposalSnapshot: { id: 'p', action: 'pause' }, ruledAt: '2026-01-01', ruledBy: { kind: 'system' } } });
  forbidHydration(f.app.store);
  for (let i = 0; i < 2; i++) { const r = await f.get(); assert.equal(r.status, 200); assert.equal(r.body.ruling.id, null); }
});

test('legacy aliases and normalizer collection limits produce the same counts without exposing text', async t => {
  const f = await fixture(t);
  const raw = { objective: '\u00a0\nLegacy objective\u2003', created_at: '2026-01-01T00:00:00.000Z',
    decisions: { committed: [...Array.from({ length: 40 }, () => 'decision'), 'ignored'] },
    acceptance_criteria: [{ text: 'a', status: 'PASSED', risk: 'HIGH' }, { statement: '', status: 'failed' }, 'plain criterion', { statement: '\u2003' }],
    checklist: [{ text: 'legacy work', status: 'completed' }], evidence: [{ summary: 'proof' }, {}] };
  f.metadata({ sessionGoal: raw }); const normalized = getSessionGoal({ metadata: { sessionGoal: raw } });
  forbidHydration(f.app.store);
  const r = await f.get(); assert.equal(r.status, 200); assert.equal(r.body.goal.goalId, normalized.goalId);
  assert.equal(r.body.goal.decisionCounts.committed, normalized.decisions.committed.length);
  assert.deepEqual(r.body.goal.acceptanceCounts, { pending: 1, passed: 1, failed: 0, waived: 0, highRisk: 1 });
  assert.deepEqual(r.body.goal.workItemCounts, { todo: 0, in_progress: 0, done: 1 });
  assert.equal(r.body.goal.evidenceCount, 1);
});

test('legacy markdown checklist counts are normalized without transferring its body', async t => {
  const f = await fixture(t);
  const raw = { objective: 'Legacy checklist', createdAt: '2026-01-01', checklist: '- [x] FINISHED_BODY\n* [~] DOING_BODY\n[ ] TODO_BODY\n\n' };
  f.metadata({ sessionGoal: raw }); forbidHydration(f.app.store);
  const r = await f.get(); assert.equal(r.status, 200);
  assert.deepEqual(r.body.goal.workItemCounts, { todo: 1, in_progress: 1, done: 1 });
  assert.equal(r.text.includes('_BODY'), false);
});

test('portfolio includes active, paused, complete and no-Goal set proposals with one grouped unresolved-count read', async t => {
  const f = await fixture(t), s = f.app.store; f.set();
  const active = s.createConversation({ title: 'Active', participants: [agent.agentId] }); f.set(active.id);
  applySessionGoalAction(s, active.id, { action: 'resume' });
  const completed = s.createConversation({ title: 'Complete', participants: [agent.agentId] }); f.set(completed.id);
  const old = s.getConversationWithoutMessages(completed.id);
  s.updateConversationWithoutMessages(completed.id, { metadata: { ...old.metadata, sessionGoal: { ...old.metadata.sessionGoal, status: 'complete' } } });
  const pending = s.createConversation({ title: 'Pending', participants: [agent.agentId] });
  proposeSessionGoalAction(s, pending.id, { action: 'set', objective: 'Pending set', acceptanceCriteria: criteria }, agent);
  const irrelevant = s.createConversation({ title: 'No Goal', participants: [agent.agentId] });
  proposeSessionGoalAction(s, f.room.id, { action: 'pause', reason: 'Review' }, agent);
  let countCalls = 0; const count = s.countUnresolvedPlannerAttention.bind(s);
  s.countUnresolvedPlannerAttention = () => { countCalls++; return count(); };
  forbidHydration(s);
  const r = await f.get('/api/planner/portfolio'); assert.equal(r.status, 200); assert.ok(Date.parse(r.body.observedAt));
  assert.equal(countCalls, 1);
  assert.deepEqual(new Set(r.body.items.map(i => i.conversationId)), new Set([f.room.id, active.id, completed.id, pending.id]));
  assert.equal(r.body.items.some(i => i.conversationId === irrelevant.id), false);
  const p = r.body.items.find(i => i.conversationId === pending.id);
  assert.equal(p.state.goal, null); assert.equal(p.state.proposal.action, 'set'); assert.equal(p.unresolvedAttentionCount, 1);
  assert.equal(r.body.items.find(i => i.conversationId === completed.id).unresolvedAttentionCount, 1);
  for (const i of r.body.items) assert.deepEqual(Object.keys(i).sort(), ['conversationId', 'title', 'projectScopeId', 'state', 'unresolvedAttentionCount'].sort());
});

test('portfolio count lookup does not treat inherited object properties as counts', async t => {
  const f = await fixture(t);
  const room = f.app.store.createConversation({ id: 'constructor', title: 'Legacy identifier', participants: [agent.agentId] });
  f.set(room.id); forbidHydration(f.app.store);
  const r = await f.get('/api/planner/portfolio'); assert.equal(r.status, 200);
  assert.equal(r.body.items.find(i => i.conversationId === room.id).unresolvedAttentionCount, 0);
});

test('lastTurn uses indexed terminal main/side headers, never reply children, live roots or raw errors/outputs', async t => {
  const f = await fixture(t); f.set(); const run = createSqliteRunStore(f.options); f.cleanups.push(() => run.close());
  const add = (id, kind, status, at, parentTaskId = null) => {
    run.createTask({ taskId: id, parentTaskId, kind, status: 'running', metadata: { conversationId: f.room.id, turnId: 'turn-' + id }, inputText: 'INPUT_BODY' });
    run.updateTask(id, { status, startedAt: at, endedAt: at, outputText: 'OUTPUT_BODY', errorMessage: 'RAW_ERROR token=do-not-read' });
  };
  add('main', 'conversation_turn', 'failed', '2026-01-01T00:00:00.000Z');
  const failed = await f.get(); assert.equal(failed.body.lastTurn.summary, 'Turn failed');
  assert.equal(failed.body.lastTurn.failureKind, undefined); assert.equal(failed.body.lastTurn.failureCode, undefined);
  assert.equal(failed.text.includes('RAW_ERROR'), false);
  add('side', 'conversation_side_dispatch', 'succeeded', '2026-01-02T00:00:00.000Z');
  add('child', 'agent_reply', 'failed', '2099-01-01T00:00:00.000Z', 'main');
  add('nested-root', 'conversation_turn', 'failed', '2099-01-01T00:00:00.000Z', 'main');
  add('live', 'conversation_turn', 'running', '2099-01-01T00:00:00.000Z');
  forbidHydration(f.app.store);
  const r = await f.get(); assert.equal(r.status, 200);
  assert.deepEqual(r.body.lastTurn, { id: 'turn-side', status: 'succeeded', startedAt: '2026-01-02T00:00:00.000Z', finishedAt: '2026-01-02T00:00:00.000Z', summary: 'Turn succeeded' });
  for (const text of ['INPUT_BODY', 'OUTPUT_BODY', 'RAW_ERROR', 'do-not-read']) assert.equal(r.text.includes(text), false);
  const index = f.app.store.db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_a2a_tasks_planner_terminal'").get();
  assert.ok(index, 'indexed Room/terminal header read must be migrated');
  const { PLANNER_ROOM_EXPRESSION, PLANNER_TERMINAL_FILTER } = require('../../build/storage/run/planner-terminal-projection');
  const plan = f.app.store.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM a2a_tasks WHERE ${PLANNER_TERMINAL_FILTER}
    AND ${PLANNER_ROOM_EXPRESSION}=? ORDER BY COALESCE(ended_at, updated_at) DESC, id DESC LIMIT 1`).all(f.room.id);
  assert.ok(plan.some(p => /SEARCH.*idx_a2a_tasks_planner_terminal/.test(p.detail)), JSON.stringify(plan));
  assert.equal(plan.some(p => /TEMP B-TREE/.test(p.detail)), false);
  add('stopped', 'conversation_side_dispatch', 'cancelled', '2026-01-03T00:00:00.000Z');
  assert.equal((await f.get()).body.lastTurn.summary, 'Turn cancelled');
});

test('controller obtains only a bounded boolean runtime projection per Room', async t => {
  const f = await fixture(t); f.set(); forbidHydration(f.app.store);
  const probes = [];
  for (const busy of [true, false]) {
    f.app.turnOrchestrator.getPlannerBusyState = id => { probes.push(id); return busy; };
    assert.equal((await f.get()).body.busy, busy);
    assert.equal((await f.get('/api/planner/portfolio')).body.items[0].state.busy, busy);
  }
  assert.ok(probes.every(id => id === f.room.id));
});

test('busy sees durable pending main work and persisted cursors without queue initialization or message bodies', async t => {
  const f = await fixture(t); f.set(); const s = f.app.store;
  const first = s.createMessage({ conversationId: f.room.id, role: 'user', status: 'completed', content: 'QUEUED_BODY' });
  const old = s.getConversationWithoutMessages(f.room.id);
  const before = f.app.turnOrchestrator.getRuntimeStats();
  forbidHydration(s);
  assert.equal((await f.get()).body.busy, true);
  assert.deepEqual(f.app.turnOrchestrator.getRuntimeStats(), before, 'monitoring must not create in-memory queue state');
  f.metadata({ ...old.metadata, conversationTurnQueue: { lastConsumedUserMessageId: first.id } });
  assert.equal((await f.get()).body.busy, false);
  s.db.prepare("UPDATE chat_conversations SET metadata_json=json_set(metadata_json,'$.conversationTurnQueue.lastConsumedUserMessageId','absent') WHERE id=?").run(f.room.id);
  assert.equal((await f.get()).body.busy, true, 'missing cursor uses the same pending semantics as the queue');
});

test('busy covers actual main and queued side work using synthetic blocked execution', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let started = false;
  const f = await fixture(t, { executeConversationAgent: async () => { started = true; await gate; return { stopTurn: true }; } });
  f.cleanups.push(release); f.set();
  const first = f.app.turnOrchestrator.submitConversationMessage(f.room.id, { content: '@GPT synthetic main' });
  assert.equal(first.dispatchLane, 'main');
  for (let i = 0; i < 200 && !started; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(started, true); assert.equal((await f.get()).body.busy, true);
  const second = f.app.turnOrchestrator.submitConversationMessage(f.room.id, { content: '@GPT synthetic queued side' });
  assert.equal(second.dispatchLane, 'side'); assert.equal(second.dispatch, 'queued');
  assert.equal((await f.get()).body.busy, true);
  assert.equal((await f.get('/api/planner/portfolio')).body.items[0].state.busy, true);
  release();
});

test('huge public/private histories, metadata and Unicode text stay within UTF-8 budgets without hydration', async t => {
  const f = await fixture(t); f.set(); const s = f.app.store, old = s.getConversationWithoutMessages(f.room.id);
  const huge = '\u{1f9ea}'.repeat(80000);
  s.createMessage({ conversationId: f.room.id, role: 'user', content: 'PUBLIC_BODY' + huge, status: 'completed' });
  s.createMessage({ conversationId: f.room.id, role: 'assistant', content: 'PRIVATE_BODY' + huge, status: 'completed', metadata: { privateOnly: true } });
  for (let i = 0; i < 100; i++) s.createMessage({ conversationId: f.room.id, role: 'user', status: 'completed', content: 'HISTORY_BODY' + i + 'x'.repeat(10000) });
  f.metadata({ ...old.metadata, private: huge, sessionGoal: { ...old.metadata.sessionGoal, objective: huge,
    evidence: [{ summary: huge, reference: 'PRIVATE_REFERENCE' }] },
    sessionGoalProposal: { id: 'p', action: 'pause', reason: huge, proposedBy: agent },
    sessionGoalRuling: { id: 'r', action: 'pause', proposalId: 'old', outcome: 'rejected', reason: huge,
      ruledBy: { kind: 'user' }, proposalSnapshot: { id: 'old', action: 'pause', private: huge } } });
  s.db.prepare('UPDATE chat_conversations SET title=? WHERE id=?').run(huge, f.room.id);
  forbidHydration(s);
  const r = await f.get(); assert.equal(r.status, 200); assert.ok(Buffer.byteLength(r.text, 'utf8') <= 65536);
  assert.equal(Array.from(r.body.goal.objective).length, 2000);
  assert.equal(Array.from(r.body.proposal.reason).length, 500); assert.equal(Array.from(r.body.ruling.reason).length, 500);
  assert.equal(r.body.goal.evidenceCount, 1);
  const p = await f.get('/api/planner/portfolio'); assert.equal(p.status, 200);
  assert.equal(Array.from(p.body.items[0].title).length, 120);
  assert.ok(Buffer.byteLength(JSON.stringify(p.body.items[0]), 'utf8') <= 65536 + 1024);
  for (const marker of ['PUBLIC_BODY', 'PRIVATE_BODY', 'PRIVATE_REFERENCE', 'HISTORY_BODY']) assert.equal(r.text.includes(marker), false);
});

test('chat-only projection creates no run schema, and startup upgrades the terminal index on an older run database', t => {
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-projection-storage-'));
  const options = { agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') };
  let store = createChatAppStore(options), run;
  t.after(() => { run?.close(); store?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const room = store.createConversation({ title: 'Chat only', participants: [agent.agentId] });
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='a2a_tasks'").get(), undefined);
  assert.equal(store.getPlannerConversationState(room.id).state.lastTurn, null);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='a2a_tasks'").get(), undefined);
  run = createSqliteRunStore(options); run.close(); run = null;
  store.db.exec('DROP INDEX idx_a2a_tasks_planner_terminal');
  store.close(); store = null;
  store = createChatAppStore(options);
  assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_a2a_tasks_planner_terminal'").get());
  assert.equal(store.getPlannerConversationState(room.id).state.lastTurn, null);
});

for (const capability of ['getPlannerConversationState', 'listPlannerGoalStates', 'countUnresolvedPlannerAttention']) {
  test('missing bounded capability fails closed without fallback: ' + capability, async t => {
    const f = await fixture(t); f.set(); f.app.store[capability] = undefined; forbidHydration(f.app.store);
    const r = await f.get(capability === 'getPlannerConversationState' ? f.statePath : '/api/planner/portfolio');
    assert.equal(r.status, 501); assert.equal(r.body.code, 'planner_projection_unavailable');
  });
}

for (const capability of ['getPlannerBusyState', 'hasPendingPlannerMainWork']) {
  test('missing bounded runtime capability fails closed: ' + capability, async t => {
    const f = await fixture(t); f.set();
    (capability === 'getPlannerBusyState' ? f.app.turnOrchestrator : f.app.store)[capability] = undefined;
    forbidHydration(f.app.store);
    for (const url of [f.statePath, '/api/planner/portfolio']) {
      const r = await f.get(url); assert.equal(r.status, 501); assert.equal(r.body.code, 'planner_projection_unavailable');
    }
  });
}

test('oversized identities fail closed rather than returning truncated identities or full hydration', async t => {
  const f = await fixture(t); f.set(); const old = f.app.store.getConversationWithoutMessages(f.room.id);
  f.metadata({ ...old.metadata, sessionGoal: { ...old.metadata.sessionGoal, goalId: 'x'.repeat(10000) } });
  forbidHydration(f.app.store);
  for (const url of [f.statePath, '/api/planner/portfolio']) {
    const r = await f.get(url); assert.equal(r.status, 501); assert.equal(r.body.code, 'planner_projection_unavailable');
  }
});
