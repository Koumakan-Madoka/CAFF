// Additional wire/security cases use the shared, isolated synthetic fixture.
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter, once } = require('node:events');
const { fixture, closed, rejected } = require('../helpers/planner-terminal');
const { validPlannerUpgrade } = require('../../build/server/http/planner-terminal');

function fakeLaunch(children) {
  return () => {
    const child = new EventEmitter(); child.write = () => {}; child.resize = () => {};
    child.stop = () => child.emit('exit', { exitCode: 0 }); children.push(child); return child;
  };
}
async function attach(f, options) {
  const ws = f.connect({ Origin: f.base }, '', options);
  await once(ws, 'open'); const ready = once(ws, 'message'); ws.send(JSON.stringify(f.auth));
  assert.equal(JSON.parse((await ready)[0]).type, 'ready'); return ws;
}

test('loopback bind and peer are checked independently of untrusted forwarding headers', () => {
  const req = { headers: { host: 'localhost:45678', origin: 'http://localhost:45678', 'x-forwarded-host': 'evil.invalid' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(validPlannerUpgrade(req, '127.0.0.1', 45678), true);
  assert.equal(validPlannerUpgrade(req, '0.0.0.0', 45678), false);
  assert.equal(validPlannerUpgrade(req, '::', 45678), false);
  req.socket.remoteAddress = '192.0.2.1'; assert.equal(validPlannerUpgrade(req, '127.0.0.1', 45678), false);
});

test('wildcard binding keeps terminal unavailable without probing the configured executable', { timeout: 30000 }, async t => {
  const f = await fixture(t, { bindHost: '0.0.0.0', cliPath: '/missing' });
  assert.equal(f.boot.plannerTerminal.enabled, false); assert.equal(f.boot.plannerTerminal.reasonCode, 'planner_terminal_local_only');
  assert.equal(await rejected(f.connect()), 404);
});

test('fragmented aggregate limits and fixed auth deadline are not reset by fragments or control traffic', { timeout: 30000 }, async t => {
  const f = await fixture(t, { authTimeoutMs: 100 });
  const result = await closed(f.connect(), ws => { ws.send('x'.repeat(40000), { fin: false }); ws.send('y'.repeat(30000)); });
  assert.equal(result.code, 1009); assert.deepEqual(result.messages, []);
  const slow = await closed(f.connect(), ws => { ws.send('{', { fin: false }); ws.ping(); });
  assert.equal(slow.code, 1008); assert.deepEqual(slow.messages, []);
  assert.equal(f.app.store.getConversationWithoutMessages(f.room.id).metadata.embeddedPlanner, undefined);
});

test('idle and missed pong disconnect and retain the same room process', { timeout: 30000 }, async t => {
  for (const config of [{ idleMs: 60 }, { pingMs: 20, pongMs: 30, idleMs: 1000 }]) {
    const children = [], f = await fixture(t, { authTimeoutMs: 5000, launch: fakeLaunch(children), ...config });
    const ws = await attach(f, { autoPong: false }); await once(ws, 'close');
    const state = await (await fetch(f.base + `/api/conversations/${f.room.id}/planner/state`, { headers: { 'X-CAFF-CSRF-Token': f.auth.token } })).json();
    assert.equal(state.processState, 'interactive-retained'); assert.equal(children.length, 1);
  }
});

test('outbound buffering closes slow consumers without keeping a replay ring', { timeout: 30000 }, async t => {
  const children = [], f = await fixture(t, { authTimeoutMs: 5000, launch: fakeLaunch(children) });
  const ws = await attach(f); const end = once(ws, 'close');
  // Synchronously saturate the server socket without yielding to network drains.
  for (let i=0; i<2000; i++) children[0].emit('data', 'x'.repeat(16384));
  assert.equal((await end)[0], 1008);
  assert.equal(f.app.store.getConversationWithoutMessages(f.room.id).metadata.embeddedPlanner.launchAttempted, true);
  const reconnect = await attach(f); assert.equal(children.length, 1); reconnect.close();
});

test('P2 state reads require loopback authority and browser CSRF, allocate no session, and reserved metadata cannot be forged', { timeout: 30000 }, async t => {
  const f = await fixture(t), route = f.base + `/api/conversations/${f.room.id}/planner/state`;
  assert.equal((await fetch(route)).status, 403);
  assert.equal((await fetch(route, { headers: { 'X-CAFF-CSRF-Token': f.auth.token, Origin: 'http://evil.invalid' } })).status, 403);
  const wrongHost = await new Promise(resolve => {
    require('node:http').get(route, { headers: { 'X-CAFF-CSRF-Token': f.auth.token, Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(route, { headers: { 'X-CAFF-CSRF-Token': f.auth.token } })).status, 200);
  assert.equal(f.app.store.getConversationWithoutMessages(f.room.id).metadata.embeddedPlanner, undefined);
  const response = await fetch(f.base + `/api/conversations/${f.room.id}`, { method: 'PUT', headers: { Origin: f.base, 'Content-Type': 'application/json', 'X-CAFF-CSRF-Token': f.auth.token }, body: JSON.stringify({ metadata: { embeddedPlanner: { sessionId: 'forged' } } }) });
  assert.equal(response.status, 403);
});

test('server shutdown closes upgraded sockets and confirms PTY exit before store close', { timeout: 30000 }, async t => {
  const f = await fixture(t, { authTimeoutMs: 5000 });
  const ws = await attach(f); const end = once(ws, 'close');
  const closing = f.close(); assert.equal((await end)[0], 1001); await closing;
});
