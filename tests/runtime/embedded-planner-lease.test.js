const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { EmbeddedPlannerRepository } = require('../../build/storage/chat/embedded-planner.repository');
const { createEmbeddedPlannerRuntime } = require('../../build/server/domain/runtime/embedded-planner-runtime');

function fixture(t, legacy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-lease-'));
  const store = createChatAppStore({ agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  if (legacy) store.db.exec(`CREATE TABLE chat_embedded_planner_leases (
    conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL UNIQUE, lease_id TEXT NOT NULL UNIQUE)`);
  store.saveCustomRoleConfig({ id: 'synthetic', name: 'Synthetic', personaPrompt: 'test', provider: 'test', model: 'test' });
  const room = () => store.createConversation({ title: 'Synthetic lease', projectScopeId: 'project-test', participants: [{ agentId: 'synthetic' }] });
  return { root, store, room };
}

test('lease migration preserves old rows as unknown PID, and guardian PID updates are lease-fenced', t => {
  const f = fixture(t, true), room = f.room();
  f.store.db.prepare('INSERT INTO chat_embedded_planner_leases VALUES (?,?,?)').run(room.id, 'old-session', 'old-lease');
  const repository = new EmbeddedPlannerRepository(f.store);
  const old = f.store.db.prepare('SELECT * FROM chat_embedded_planner_leases WHERE conversation_id=?').get(room.id);
  assert.equal(old.guardian_pid, null); assert.equal(old.lease_id, 'old-lease');
  new EmbeddedPlannerRepository(f.store); // idempotent migration
  const next = f.room(), claim = repository.claim(next.id);
  repository.recordGuardian(next.id, claim.leaseId, 12345);
  assert.equal(f.store.db.prepare('SELECT guardian_pid FROM chat_embedded_planner_leases WHERE conversation_id=?').get(next.id).guardian_pid, 12345);
  assert.throws(() => repository.recordGuardian(next.id, 'stale-lease', 54321), /planner_process_exit_unconfirmed/);
  for (const pid of [-1, 0, 1.5, NaN, Infinity, 2 ** 40]) assert.throws(() => repository.recordGuardian(next.id, claim.leaseId, pid));
});

test('startup reconciliation releases only ESRCH guardians, preserves live/unknown/no-PID leases and never sends a kill signal', t => {
  const f = fixture(t), repository = new EmbeddedPlannerRepository(f.store), rooms = Array.from({ length: 5 }, () => f.room());
  for (const [index, room] of rooms.entries()) {
    const claim = repository.claim(room.id); if (index < 4) repository.recordGuardian(room.id, claim.leaseId, 10001 + index);
  }
  const before = rooms.map(r => repository.read(r.id)), calls = [], log = [];
  repository.reconcileLeases({ probe: (pid, signal) => {
    calls.push([pid, signal]);
    if (pid === 10001) throw Object.assign(new Error('private sentinel'), { code: 'ESRCH' });
    if (pid === 10003) throw Object.assign(new Error('private sentinel'), { code: 'EPERM' });
    if (pid === 10004) throw new Error('private sentinel');
  }, log: entry => log.push(entry) });
  assert.equal(repository.hasLease(rooms[0].id), false);
  for (const room of rooms.slice(1)) assert.equal(repository.hasLease(room.id), true);
  assert.deepEqual(calls.sort((a,b) => a[0] - b[0]), [[10001,0],[10002,0],[10003,0],[10004,0]]);
  assert.deepEqual(rooms.map(r => repository.read(r.id)), before);
  assert.equal(log.length, 1); assert.equal(log[0].reasonCode, 'planner_guardian_absent');
  assert.doesNotMatch(JSON.stringify(log), /private sentinel|old-session/);
});

test('session reinitialization changes only launchAttempted, preserves UUID/opt-in/unknown metadata and is idempotent', t => {
  const f = fixture(t), repository = new EmbeddedPlannerRepository(f.store), room = f.room();
  const claim = repository.claim(room.id); repository.release(room.id, claim.leaseId);
  const metadata = { ...f.store.getConversationWithoutMessages(room.id).metadata,
    synthetic: { keep: ['unchanged'] }, embeddedPlanner: { ...repository.read(room.id), wakeupsEnabled: true, future: { keep: true } } };
  f.store.updateConversationWithoutMessages(room.id, { metadata });
  const before = f.store.getConversationWithoutMessages(room.id).metadata;
  assert.equal(repository.reinitializeSession(room.id), true);
  assert.deepEqual(f.store.getConversationWithoutMessages(room.id).metadata,
    { ...before, embeddedPlanner: { ...before.embeddedPlanner, launchAttempted: false } });
  assert.equal(repository.read(room.id).launchAttempted, false); // JSON boolean, not numeric zero
  const after = f.store.db.prepare('SELECT metadata_json FROM chat_conversations WHERE id=?').get(room.id).metadata_json;
  assert.equal(repository.reinitializeSession(room.id), false);
  assert.equal(f.store.db.prepare('SELECT metadata_json FROM chat_conversations WHERE id=?').get(room.id).metadata_json, after);
  assert.equal(repository.leaseCount(), 0);
});

test('session reinitialization allocates nothing for absent metadata, rejects missing rooms and never releases a lease', t => {
  const f = fixture(t), repository = new EmbeddedPlannerRepository(f.store), room = f.room();
  const before = f.store.db.prepare('SELECT metadata_json FROM chat_conversations WHERE id=?').get(room.id).metadata_json;
  assert.equal(repository.reinitializeSession(room.id), false);
  assert.equal(f.store.db.prepare('SELECT metadata_json FROM chat_conversations WHERE id=?').get(room.id).metadata_json, before);
  assert.throws(() => repository.reinitializeSession('missing-room'), /planner_room_missing/);
  const claim = repository.claim(room.id), meta = repository.read(room.id);
  assert.throws(() => repository.reinitializeSession(room.id), /planner_process_exit_unconfirmed/);
  assert.deepEqual(repository.read(room.id), meta); assert.equal(repository.hasLease(room.id), true);
  assert.equal(f.store.db.prepare('SELECT lease_id FROM chat_embedded_planner_leases WHERE conversation_id=?').get(room.id).lease_id, claim.leaseId);
});

test('default signal-zero probe releases an actually exited synthetic PID and preserves the current PID', async t => {
  const f = fixture(t), repository = new EmbeddedPlannerRepository(f.store), dead = f.room(), live = f.room();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: {}, stdio: 'ignore' });
  await once(child, 'exit');
  const deadClaim = repository.claim(dead.id); repository.recordGuardian(dead.id, deadClaim.leaseId, child.pid);
  const liveClaim = repository.claim(live.id); repository.recordGuardian(live.id, liveClaim.leaseId, process.pid);
  const logs = []; repository.reconcileLeases({ log: entry => logs.push(entry) });
  assert.equal(repository.hasLease(dead.id), false); assert.equal(repository.hasLease(live.id), true); assert.equal(logs.length, 1);
});

test('runtime startup reconciles durable leases before admission, and default probe preserves a live guardian PID', { timeout: 30000 }, async t => {
  const f = fixture(t), repository = new EmbeddedPlannerRepository(f.store), dead = f.room(), live = f.room();
  const deadPid = process.pid === 12345 ? 12346 : 12345;
  const deadClaim = repository.claim(dead.id); repository.recordGuardian(dead.id, deadClaim.leaseId, deadPid);
  const liveClaim = repository.claim(live.id); repository.recordGuardian(live.id, liveClaim.leaseId, process.pid);
  const session = repository.read(dead.id).sessionId, logs = [];
  const cliPath = path.join(f.root, 'fake-cli.cjs'); fs.writeFileSync(cliPath, 'console.log("2.1.310 (Claude Code)")');
  const runtime = createEmbeddedPlannerRuntime({ host: '127.0.0.1', store: f.store, projectManager: { listProjects: () => [{ id: 'project-test', path: f.root }] },
    config: { enabled: true, cliPath, env: { PATH: process.env.PATH, HOME: f.root, USERPROFILE: f.root, SystemRoot: process.env.SystemRoot },
      probeGuardian: (pid, signal) => { if (pid === deadPid) throw Object.assign(new Error('synthetic'), { code: 'ESRCH' }); process.kill(pid, signal); }, log: entry => logs.push(entry) } });
  t.after(() => runtime.close());
  await runtime.start('http://127.0.0.1:45678', null);
  assert.equal(runtime.capability().available, true); assert.equal(repository.hasLease(dead.id), false);
  assert.equal(repository.hasLease(live.id), true); assert.equal(repository.read(dead.id).sessionId, session);
  assert.equal(runtime.roomState(live.id).reasonCode, 'planner_process_exit_unconfirmed'); assert.equal(logs.length, 1);
});
