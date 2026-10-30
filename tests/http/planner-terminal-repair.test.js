const assert = require('node:assert/strict');
const test = require('node:test');
const { once, EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { fixture, rejected } = require('../helpers/planner-terminal');
const { EmbeddedPlannerRepository } = require('../../build/storage/chat/embedded-planner.repository');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { createEmbeddedPlannerController } = require('../../build/server/api/embedded-planner-controller');

function repair(f, body, options = {}) {
  return fetch(f.base + `/api/conversations/${f.room.id}/planner/terminal/repair` + (options.suffix || ''), {
    method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json', 'X-CAFF-CSRF-Token': f.auth.token, ...options.headers },
    body: options.raw ?? JSON.stringify(body),
  });
}
async function attach(f) {
  const ws = f.connect(); await once(ws, 'open'); const result = once(ws, 'message'); ws.send(JSON.stringify(f.auth));
  const ready = JSON.parse((await result)[0]); assert.equal(ready.type, 'ready'); return { ws, ready };
}

test('repair requires a browser user, correct local guards and exactly one true confirmation; rejection preserves lease/session', { timeout: 30000 }, async t => {
  const token = randomBytes(32).toString('base64url');
  const f = await fixture(t, { plannerCredential: createInMemoryPlannerCredential({ token }) });
  const repository = new EmbeddedPlannerRepository(f.app.store), claim = repository.claim(f.room.id);
  const before = repository.read(f.room.id);
  for (const [body, options, expected] of [
    [{ confirm: true }, { headers: { 'X-CAFF-CSRF-Token': '' } }, 403],
    [{ confirm: true }, { headers: { Origin: 'http://evil.invalid' } }, 403],
    [{ confirm: true }, { headers: { Origin: '' } }, 403],
    [{ confirm: true }, { headers: { 'Content-Type': 'text/plain' } }, 415],
    [{ confirm: true }, { headers: { Authorization: 'Bearer ' + token } }, 403],
    [{ confirm: true }, { headers: { 'X-CAFF-Principal': 'agent' } }, 401],
    [{}, {}, 400], [{ confirm: false }, {}, 400], [{ confirm: 'true' }, {}, 400], [null, {}, 400],
    [[{ confirm: true }], {}, 400], [{ confirm: true, roomId: 'other' }, {}, 400],
    [{ confirm: true }, { raw: '{"confirm":false,"confirm":true}' }, 400],
    [{ confirm: true }, { raw: '\u000b{"confirm":true}' }, 400],
    [{ confirm: true }, { raw: ' '.repeat(1025) }, 413],
    [{ confirm: true }, { suffix: '?room=other' }, 400],
  ]) {
    assert.equal((await repair(f, body, options)).status, expected);
    assert.equal(repository.hasLease(f.room.id), true); assert.deepEqual(repository.read(f.room.id), before);
  }
  assert.equal(f.app.store.db.prepare('SELECT lease_id FROM chat_embedded_planner_leases WHERE conversation_id=?').get(f.room.id).lease_id, claim.leaseId);
});

test('repair releases only the selected room lease and preserves UUID, then attach resumes that same session', { timeout: 30000 }, async t => {
  const f = await fixture(t, { authTimeoutMs: 5000 }), repository = new EmbeddedPlannerRepository(f.app.store);
  const claim = repository.claim(f.room.id), before = repository.read(f.room.id);
  repository.recordGuardian(f.room.id, claim.leaseId, process.pid); // explicit user repair never kills this PID
  const other = f.app.store.createConversation({ title: 'Other', participants: [{ agentId: 'synthetic' }] }); repository.claim(other.id);
  const ws = f.connect(); await once(ws, 'open'); const message = once(ws, 'message'); const end = once(ws, 'close'); ws.send(JSON.stringify(f.auth));
  assert.equal(JSON.parse((await message)[0]).code, 'planner_process_exit_unconfirmed'); await end;
  const response = await repair(f, { confirm: true }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { repaired: true });
  assert.equal(repository.hasLease(f.room.id), false); assert.equal(repository.hasLease(other.id), true);
  assert.deepEqual(repository.read(f.room.id), before);
  assert.deepEqual(await (await repair(f, { confirm: true })).json(), { repaired: false });
  const missing = await fetch(f.base + '/api/conversations/missing-room/planner/terminal/repair', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json', 'X-CAFF-CSRF-Token': f.auth.token }, body: '{"confirm":true}' });
  assert.equal(missing.status, 404);
  const attached = await attach(f); assert.equal(attached.ready.resumed, true); assert.equal(attached.ready.sessionId, before.sessionId);
  const lease = f.app.store.db.prepare('SELECT guardian_pid FROM chat_embedded_planner_leases WHERE conversation_id=?').get(f.room.id);
  assert.ok(Number.isSafeInteger(lease.guardian_pid) && lease.guardian_pid > 0 && lease.guardian_pid !== process.pid);
});

test('repair refuses all in-memory ownership, including pending spawn and retained PTYs', { timeout: 30000 }, async t => {
  let started, resolve;
  const launching = new Promise(r => { started = r; });
  const child = new EventEmitter(); child.write = () => {}; child.resize = () => {}; child.stop = () => child.emit('exit', { exitCode: 0 });
  t.after(() => { resolve?.(child); child.emit('exit', { exitCode: 0 }); });
  const f = await fixture(t, { authTimeoutMs: 5000, launch: () => { started(); return new Promise(r => { resolve = r; }); } });
  const ws = f.connect(); await once(ws, 'open'); const ready = once(ws, 'message'); ws.send(JSON.stringify(f.auth)); await launching;
  assert.equal((await repair(f, { confirm: true })).status, 409);
  resolve(child); await ready;
  assert.equal((await repair(f, { confirm: true })).status, 409);
  const end = once(ws, 'close'); ws.close(); await end;
  assert.equal((await repair(f, { confirm: true })).status, 409);
});

test('repair controller rejects an agent principal before parsing the body or touching the runtime', async () => {
  let repairs = 0;
  const handler = createEmbeddedPlannerController({ host: '127.0.0.1', csrfToken: 'synthetic', getAuthority: () => '127.0.0.1:45678',
    runtime: { capability: () => ({ enabled: true }), repair: () => { repairs++; } } });
  await assert.rejects(handler({ req: { method: 'POST' }, principal: { kind: 'agent', agentId: 'synthetic' }, pathname: '/api/conversations/room-test/planner/terminal/repair', requestUrl: new URL('http://127.0.0.1:45678/api/conversations/room-test/planner/terminal/repair') }), error => error.statusCode === 403);
  assert.equal(repairs, 0);
});

test('repair endpoint remains absent when feature is off', { timeout: 30000 }, async t => {
  const f = await fixture(t, { enabled: false }); assert.equal((await repair(f, { confirm: true })).status, 404);
  assert.equal(await rejected(f.connect()), 404);
});
