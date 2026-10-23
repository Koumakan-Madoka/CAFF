const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), test = require('node:test');
const { Worker } = require('node:worker_threads');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-room-store-'));
  const options = { agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') };
  const f = { options, store: createChatAppStore(options), workers: [] };
  t.after(async () => { await Promise.all(f.workers.map(w => w.terminate())); f.store?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  f.input = { title: 'Atomic Room', modeId: 'standard', projectScopeId: 'synthetic-project', metadata: { titleSource: 'manual' }, participants: ['role-family-gpt'] };
  f.retry = { plannerId: 'local-planner', key: 'opaque-key', digest: 'a'.repeat(64) };
  f.count = table => Number(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  return f;
}

test('planner-scoped keys keep immutable original creation snapshots across reopen and unrelated updates', t => {
  const f = fixture(t), before = f.count('chat_conversations');
  const one = f.store.createPlannerConversation(f.input, f.retry);
  assert.equal(one.replayed, false); assert.equal(one.response.titleSource, 'manual');
  f.store.updateConversationWithoutMessages(one.response.conversationId, { title: 'Changed title' });
  const other = f.store.createPlannerConversation(f.input, { ...f.retry, plannerId: 'another-planner' });
  assert.notEqual(other.response.conversationId, one.response.conversationId); assert.equal(f.count('chat_conversations'), before + 2);
  f.store.close(); f.store = createChatAppStore(f.options);
  assert.deepEqual(f.store.replayPlannerRoomCreation(f.retry), { replayed: true, response: one.response });
  assert.throws(() => f.store.replayPlannerRoomCreation({ ...f.retry, digest: 'b'.repeat(64) }), e => e.statusCode === 409 && e.code === 'idempotency_key_conflict');
});

test('mapping failure rolls back Room/participant/history writes rather than leaving an unkeyed Room', t => {
  const f = fixture(t);
  const tables = ['chat_conversations', 'chat_conversation_agents', 'chat_conversation_agent_history', 'chat_planner_room_creations'];
  const before = tables.map(f.count);
  f.store.db.exec("CREATE TRIGGER fail_creation_mapping BEFORE INSERT ON chat_planner_room_creations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  assert.throws(() => f.store.createPlannerConversation(f.input, f.retry), /synthetic failure/);
  assert.deepEqual(tables.map(f.count), before); assert.equal(f.store.replayPlannerRoomCreation(f.retry), null);
  f.store.db.exec('DROP TRIGGER fail_creation_mapping');
  assert.equal(f.store.createPlannerConversation(f.input, f.retry).replayed, false);
});

test('deletion and tombstone are atomic; a rolled-back deletion leaves the original replay live', t => {
  const f = fixture(t), created = f.store.createPlannerConversation(f.input, f.retry), id = created.response.conversationId;
  assert.throws(() => f.store.db.transaction(() => { f.store.db.prepare('DELETE FROM chat_conversations WHERE id=?').run(id); throw new Error('rollback deletion'); })(), /rollback deletion/);
  assert.deepEqual(f.store.replayPlannerRoomCreation(f.retry).response, created.response);
  f.store.db.prepare('DELETE FROM chat_conversations WHERE id=?').run(id);
  const entry = f.store.db.prepare('SELECT * FROM chat_planner_room_creations').get(); assert.ok(entry.deleted_at);
  f.store.createConversation({ ...f.input, id });
  assert.throws(() => f.store.replayPlannerRoomCreation(f.retry), e => e.statusCode === 410 && e.code === 'conversation_gone');
  assert.throws(() => f.store.replayPlannerRoomCreation({ ...f.retry, digest: 'b'.repeat(64) }), e => e.code === 'idempotency_key_conflict');
});

test('a missing Room fails gone even if an older/out-of-band delete omitted its tombstone', t => {
  const f = fixture(t), created = f.store.createPlannerConversation(f.input, f.retry);
  f.store.db.exec('DROP TRIGGER chat_planner_room_creation_deleted');
  f.store.db.prepare('DELETE FROM chat_conversations WHERE id=?').run(created.response.conversationId);
  assert.throws(() => f.store.replayPlannerRoomCreation(f.retry), e => e.statusCode === 410 && e.code === 'conversation_gone');
});

test('separate SQLite connections serialize competing creations under a write lock', { timeout: 20000 }, async t => {
  const f = fixture(t), before = f.count('chat_conversations');
  const gate = new SharedArrayBuffer(4), ready = [], results = [];
  const source = `const { parentPort, workerData } = require('node:worker_threads');
    const { createChatAppStore } = require(workerData.modulePath);
    const store = createChatAppStore(workerData.options);
    parentPort.postMessage({ kind: 'ready' });
    Atomics.wait(new Int32Array(workerData.gate), 0, 0);
    try { const result = store.createPlannerConversation(workerData.input, workerData.retry); store.close(); parentPort.postMessage({ kind: 'result', result }); }
    catch (error) { store.close(); throw error; }`;
  for (let i = 0; i < 2; i++) {
    const worker = new Worker(source, { eval: true, workerData: { gate, options: f.options, input: f.input, retry: f.retry,
      modulePath: path.resolve(__dirname, '../../build/lib/chat-app-store.js') } }); f.workers.push(worker);
    let readyResolve, readyReject, resultResolve, resultReject;
    ready.push(new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }));
    results.push(new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; }));
    worker.on('message', m => { if (m.kind === 'ready') readyResolve(); else if (m.kind === 'result') resultResolve(m.result); });
    worker.on('error', e => { readyReject(e); resultReject(e); });
  }
  await Promise.all(ready); Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2);
  const all = await Promise.all(results);
  assert.equal(new Set(all.map(r => r.response.conversationId)).size, 1); assert.equal(all.filter(r => r.replayed).length, 1);
  assert.equal(f.count('chat_conversations'), before + 1); assert.equal(f.count('chat_planner_room_creations'), 1);
});
