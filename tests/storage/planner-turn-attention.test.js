const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const { applySessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
const criteria = [{ id: 'c', statement: 'Observe terminal transitions', verifyBy: 'SQLite assertions', status: 'pending' }];
function fixture(t, goal = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-turn-attention-'));
  const options = { agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') };
  const f = { store: createChatAppStore(options), run: createSqliteRunStore(options), options, serial: 0 };
  t.after(() => { try { f.run?.close(); f.store?.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  f.room = f.store.createConversation({ title: 'Turn fixture', participants: ['role-family-gpt'] });
  f.action = input => applySessionGoalAction(f.store, f.room.id, { ...input, ruledBy: { kind: 'user' } });
  f.set = () => f.action({ action: 'set', objective: 'Synthetic terminal Goal', status: 'paused', acceptanceCriteria: criteria });
  if (goal) f.set();
  f.start = (kind = 'conversation_turn', metadata = {}) => {
    const id = `root-${++f.serial}`;
    return f.run.createTask({ taskId: id, kind, status: 'running', metadata: { conversationId: f.room.id, turnId: `turn-${id}`, ...metadata } });
  };
  f.finish = (task, status = 'failed', agents = ['agent-a']) => f.run.updateTask(task.id, { status,
    endedAt: new Date().toISOString(), artifactSummary: status === 'succeeded' ? { completedAgentIds: agents } : { failedAgentIds: agents } });
  f.items = () => f.store.listPlannerAttention().items.filter(i => i.kind === 'turn_failed');
  return f;
}

test('root creation captures server-derived Goal association; terminal occurrence uses current same-Goal revision', t => {
  const f = fixture(t), task = f.start('conversation_turn', { goalContext: { goalId: 'forged', revision: 999 } });
  const goal = f.store.getConversationWithoutMessages(f.room.id).metadata.sessionGoal;
  assert.deepEqual(task.metadata.goalContext, { goalId: goal.goalId, revision: goal.revision });
  f.action({ action: 'revise', goalRevision: goal.revision });
  f.finish(task);
  const [item] = f.items(); assert.ok(item);
  assert.equal(item.goalId, goal.goalId); assert.equal(item.goalRevision, goal.revision + 1);
  assert.equal(item.sourceId, task.metadata.turnId);
  assert.deepEqual(item.failedAgentIds, ['agent-a']); assert.equal(item.lane, 'main');
  f.finish(task); assert.deepEqual(f.items(), [item], 'repeated terminal updates cannot create a second occurrence');
});

for (const changed of ['absent-at-start', 'replaced', 'cleared']) {
  test(`task ${changed} never attaches failure to a later/different Goal`, t => {
    const f = fixture(t, changed !== 'absent-at-start'), task = f.start();
    if (changed === 'cleared') f.action({ action: 'clear' }); else f.set();
    f.finish(task); assert.deepEqual(f.items(), []);
  });
}

test('only root main/side failures count, not reply slots, retries, cancellation or legacy tasks without association', t => {
  const f = fixture(t);
  for (const kind of ['agent_reply', 'agent_run', 'task']) f.finish(f.start(kind));
  f.finish(f.start(), 'cancelled');
  const legacy = f.start();
  f.run.db.prepare('UPDATE a2a_tasks SET metadata_json=? WHERE id=?').run(JSON.stringify({ conversationId: f.room.id, turnId: 'legacy' }), legacy.id);
  f.finish(legacy);
  assert.deepEqual(f.items(), []);
  f.finish(f.start('conversation_side_dispatch'));
  assert.equal(f.items().length, 1); assert.equal(f.items()[0].lane, 'side');
});

test('automatic success resolution is restricted to same Goal, singleton actual agent and lane', t => {
  const f = fixture(t); f.finish(f.start()); const failed = f.items()[0];
  f.finish(f.start('conversation_side_dispatch'), 'succeeded', ['agent-a']);
  f.finish(f.start(), 'succeeded', ['agent-b']);
  f.finish(f.start(), 'succeeded', []);
  assert.deepEqual(f.items(), [failed]);
  f.finish(f.start(), 'succeeded', ['agent-a']);
  assert.equal(f.items()[0].resolution, 'turn_succeeded'); assert.ok(f.items()[0].resolvedAt);
  f.finish(f.start()); assert.equal(f.items()[1].resolvedAt, null, 'a later failure is not hidden by an earlier success');
});

test('terminal commit order, not start time, controls success resolution; cancellation has no effect', t => {
  const f = fixture(t), earlierStartedSuccess = f.start();
  f.finish(f.start()); const item = f.items()[0];
  f.finish(f.start(), 'cancelled'); assert.deepEqual(f.items(), [item]);
  f.finish(earlierStartedSuccess, 'succeeded'); assert.equal(f.items()[0].resolution, 'turn_succeeded');
});

test('lane and failed agent attribution are immutable occurrence fields', t => {
  const f = fixture(t); f.finish(f.start()); const item = f.items()[0];
  assert.throws(() => f.store.db.prepare('UPDATE chat_planner_attention SET lane=? WHERE sequence=?').run('side', item.sequence), /immutable/);
  assert.throws(() => f.store.db.prepare('UPDATE chat_planner_attention SET failed_agent_ids_json=? WHERE sequence=?').run('["other-agent"]', item.sequence), /immutable/);
  assert.deepEqual(f.items(), [item]);
});

test('multi-agent and unknown failures require explicit resolution; one successful agent cannot clear them', t => {
  const f = fixture(t); f.finish(f.start(), 'failed', ['agent-a', 'agent-b', 'agent-a']);
  const unknown = f.start(); f.run.updateTask(unknown.id, { status: 'failed', errorMessage: 'Synthetic root exception', endedAt: new Date().toISOString() });
  assert.deepEqual(f.items().map(i => i.failedAgentIds), [['agent-a', 'agent-b'], ['unknown']]);
  f.finish(f.start(), 'succeeded', ['agent-a', 'agent-b', 'unknown']);
  assert.ok(f.items().every(i => !i.resolvedAt));
  f.action({ action: 'resume' }); assert.ok(f.items().every(i => i.resolvedAt && i.resolution === 'goal_resumed'));
});

test('task metadata updates cannot rewrite the server-derived starting Goal context', t => {
  const f = fixture(t), task = f.start(), context = task.metadata.goalContext;
  f.run.updateTask(task.id, { metadata: { conversationId: f.room.id, turnId: task.metadata.turnId,
    goalContext: { goalId: 'forged-later', revision: 100 } } });
  assert.deepEqual(f.run.getTask(task.id).metadata.goalContext, context);
  f.finish(task); assert.equal(f.items().length, 1);
});

for (const operation of ['INSERT', 'UPDATE']) {
  test(`attention ${operation} failure rolls back terminal task persistence`, t => {
    const f = fixture(t);
    if (operation === 'UPDATE') f.finish(f.start());
    const task = f.start(), before = f.items();
    f.run.db.exec(`CREATE TRIGGER reject_turn_attention BEFORE ${operation} ON chat_planner_attention BEGIN SELECT RAISE(ABORT, 'synthetic terminal failure'); END`);
    assert.throws(() => f.finish(task, operation === 'INSERT' ? 'failed' : 'succeeded'), /synthetic terminal failure/);
    assert.equal(f.run.getTask(task.id).status, 'running'); assert.deepEqual(f.items(), before);
  });
}

test('new interrupted-root failure is committed with recovery; repeated recovery and historical failures are not replayed', t => {
  const f = fixture(t), task = f.start();
  const child = f.run.createTask({ taskId: 'reply-child', parentTaskId: task.id, kind: 'agent_reply', status: 'running' });
  f.store.createMessage({ conversationId: f.room.id, turnId: task.metadata.turnId, taskId: child.id,
    role: 'assistant', agentId: 'role-family-gpt', senderName: 'GPT', content: 'Thinking...', status: 'running' });
  f.store.reconcileInterruptedRuns('Synthetic restart');
  assert.equal(f.run.getTask(task.id).status, 'failed'); assert.equal(f.items().length, 1);
  assert.deepEqual(f.items()[0].failedAgentIds, ['unknown']);
  const before = f.items(); f.store.reconcileInterruptedRuns('Repeated restart'); assert.deepEqual(f.items(), before);
  f.store.close(); f.store = createChatAppStore(f.options); assert.deepEqual(f.items(), before);
});

test('recovery attention failure rolls back message/task terminal state', t => {
  const f = fixture(t), task = f.start();
  const child = f.run.createTask({ taskId: 'reply-child', parentTaskId: task.id, kind: 'agent_reply', status: 'running' });
  const message = f.store.createMessage({ conversationId: f.room.id, turnId: task.metadata.turnId, taskId: child.id,
    role: 'assistant', agentId: 'role-family-gpt', senderName: 'GPT', content: 'Thinking...', status: 'running' });
  f.store.db.exec("CREATE TRIGGER reject_recovery_attention BEFORE INSERT ON chat_planner_attention WHEN NEW.kind='turn_failed' BEGIN SELECT RAISE(ABORT, 'synthetic recovery failure'); END");
  assert.throws(() => f.store.reconcileInterruptedRuns('Synthetic restart'), /synthetic recovery failure/);
  assert.equal(f.store.getMessage(message.id).status, 'running'); assert.equal(f.run.getTask(task.id).status, 'running');
  assert.deepEqual(f.items(), []);
});
