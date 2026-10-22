const assert = require('node:assert/strict');
const test = require('node:test');
const { createInterruptedFixture } = require('../helpers/interrupted-runs');

function snapshot(db) {
  return ['chat_messages', 'runs', 'a2a_tasks'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}

for (const reason of ['服务重启中断', '服务关闭中断']) {
  test(`interrupted reconciliation atomically fails active records, preserves terminal rows and is idempotent: ${reason}`, t => {
    const f = createInterruptedFixture(t);
    const active = ['queued', 'running', 'streaming'].map(status => f.seed(status));
    const partial = f.seed('streaming', { content: 'Partial answer' });
    active.push(partial);
    const user = f.store.createMessage({ conversationId: f.room.id, role: 'user', content: 'Queued user input', status: 'queued' });
    const terminal = ['completed', 'failed'].map(status => {
      const record = f.seed(status);
      f.runs.finishRun(record.runId, { status: status === 'completed' ? 'succeeded' : 'failed', errorMessage: 'original' });
      f.runs.updateTask(record.taskId, { status: status === 'completed' ? 'succeeded' : 'failed', endedAt: '2026-01-01T00:00:00.000Z' });
      return { ...record, message: f.store.getMessage(record.message.id), run: f.runs.getRun(record.runId), task: f.runs.getTask(record.taskId) };
    });
    const before = Date.now();
    f.store.reconcileInterruptedRuns(reason);
    for (const record of active) {
      const message = f.store.getMessage(record.message.id);
      const run = f.runs.getRun(record.runId);
      const task = f.runs.getTask(record.taskId);
      assert.equal(message.status, 'failed');
      assert.equal(message.content, record === partial ? 'Partial answer' : '');
      assert.equal(message.errorMessage, reason);
      assert.equal(message.metadata.failure, true);
      assert.equal(message.metadata.streaming, false);
      assert.equal(message.metadata.recoveredAfterRestart, true);
      assert.equal(message.metadata.sentinel, 'preserve');
      assert.equal(run.status, 'failed');
      assert.equal(task.status, 'failed');
      assert.equal(run.error_message, reason);
      assert.equal(task.error_message, reason);
      assert.ok(Date.parse(run.ended_at) >= before);
      assert.equal(task.ended_at, run.ended_at, 'one transaction uses one interruption timestamp');
    }
    assert.deepEqual(f.store.getMessage(user.id), user);
    for (const record of terminal) {
      assert.deepEqual(f.store.getMessage(record.message.id), record.message);
      assert.deepEqual(f.runs.getRun(record.runId), record.run);
      assert.deepEqual(f.runs.getTask(record.taskId), record.task);
    }
    const after = snapshot(f.store.db);
    f.store.reconcileInterruptedRuns(reason);
    assert.deepEqual(snapshot(f.store.db), after);
  });
}

test('interrupted reconciliation covers unmessaged runs and linked parent tasks without changing terminal tasks', t => {
  const f = createInterruptedFixture(t);
  const parent = f.runs.createTask({ taskId: 'root-task', kind: 'conversation_turn', status: 'running' });
  const child = f.seed();
  f.store.db.prepare('UPDATE a2a_tasks SET parent_task_id = ? WHERE id = ?').run(parent.id, child.taskId);
  const terminalTask = f.runs.createTask({ taskId: 'terminal-task', kind: 'test', status: 'succeeded' });
  const run = f.runs.startRun({ taskId: terminalTask.id, prompt: 'No message yet', cwd: f.dir });
  f.runs.updateTask(terminalTask.id, { runId: run.runId });
  const before = f.runs.getTask(terminalTask.id);
  f.store.reconcileInterruptedRuns('服务重启中断');
  assert.equal(f.runs.getTask(parent.id).status, 'failed');
  assert.equal(f.runs.getRun(run.runId).status, 'failed');
  assert.equal(f.runs.getRun(run.runId).error_message, '服务重启中断');
  assert.deepEqual(f.runs.getTask(terminalTask.id), before);
});

test('interrupted reconciliation rolls back messages and runs when a linked task cannot be updated', t => {
  const f = createInterruptedFixture(t);
  f.seed();
  f.store.db.exec(`CREATE TRIGGER reject_interruption BEFORE UPDATE OF status ON a2a_tasks
    WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'synthetic task failure'); END`);
  const before = snapshot(f.store.db);
  assert.throws(() => f.store.reconcileInterruptedRuns('服务重启中断'), /synthetic task failure/);
  assert.deepEqual(snapshot(f.store.db), before);
});
