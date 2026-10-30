const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { fixture } = require('../helpers/planner-terminal');
const { EmbeddedPlannerRepository } = require('../../build/storage/chat/embedded-planner.repository');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { createEmbeddedPlannerController } = require('../../build/server/api/embedded-planner-controller');

const suffix = '/planner/terminal/session/reinitialize';
function reinitialize(f, body = { confirm: true }, options = {}) {
  const data = options.raw ?? JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(f.base + `/api/conversations/${options.roomId || f.room.id}` + suffix + (options.query || ''), {
      method: options.method || 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json',
        'X-CAFF-CSRF-Token': f.auth.token, 'Content-Length': Buffer.byteLength(data), ...options.headers },
    }, res => {
      const chunks = []; res.on('data', x => chunks.push(x));
      res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(data);
  });
}
async function state(f) {
  return (await fetch(f.base + `/api/conversations/${f.room.id}/planner/state`, { headers: { 'X-CAFF-CSRF-Token': f.auth.token } })).json();
}
async function terminal(f) {
  const ws = f.connect(), events = [];
  ws.on('message', data => events.push(JSON.parse(data)));
  const ended = once(ws, 'close');
  await once(ws, 'open'); ws.send(JSON.stringify(f.auth));
  async function wait(predicate) {
    while (!predicate(events)) {
      assert.ok(ws.readyState < 2, 'terminal closed before expected event: ' + JSON.stringify(events));
      await once(ws, 'message');
    }
  }
  await wait(e => e.some(x => x.type === 'ready'));
  return { ws, events, ended, wait, ready: events.find(e => e.type === 'ready') };
}
function argv(f) { return JSON.parse(fs.readFileSync(path.join(f.root, 'fake-launch.json'), 'utf8')).argv.slice(0, 2); }

const invalidRequests = f => [
  [{ confirm: true }, { headers: { 'X-CAFF-CSRF-Token': '' } }, 403],
  [{ confirm: true }, { headers: { Origin: '' } }, 403],
  [{ confirm: true }, { headers: { Origin: 'http://evil.invalid' } }, 403],
  [{ confirm: true }, { headers: { Origin: 'http://localhost:' + f.port } }, 403],
  [{ confirm: true }, { headers: { Origin: [f.base, f.base] } }, 403],
  [{ confirm: true }, { headers: { Host: 'evil.invalid' } }, 403],
  [{ confirm: true }, { headers: { Host: '127.0.0.1:1' } }, 403],
  [{ confirm: true }, { headers: { 'Content-Type': 'text/plain' } }, 415],
  [{ confirm: true }, { headers: { Authorization: 'Bearer ' + f.plannerToken } }, 403],
  [{ confirm: true }, { headers: { 'X-CAFF-Principal': 'agent' } }, 401],
  [{}, {}, 400], [{ confirm: false }, {}, 400], [{ confirm: 'true' }, {}, 400], [null, {}, 400],
  [[{ confirm: true }], {}, 400], [{ confirm: true, sessionId: 'forged' }, {}, 400],
  [{ confirm: true }, { raw: '{"confirm":false,"confirm":true}' }, 400],
  [{ confirm: true }, { raw: '{"confirm":true,"confirm":true}' }, 400],
  [{ confirm: true }, { raw: '{"\\u0063onfirm":true}' }, 400],
  [{ confirm: true }, { raw: '\u000b{"confirm":true}' }, 400],
  [{ confirm: true }, { raw: '{' }, 400],
  [{ confirm: true }, { raw: ' '.repeat(1025) }, 413],
  [{ confirm: true }, { query: '?confirm=true' }, 400],
];
test('session reinitialization requires browser user/local guards/exact confirmation; all rejections preserve session and lease', { timeout: 30000 }, async t => {
  const plannerToken = randomBytes(32).toString('base64url');
  const f = await fixture(t, { plannerCredential: createInMemoryPlannerCredential({ token: plannerToken }) }); f.plannerToken = plannerToken;
  const repository = new EmbeddedPlannerRepository(f.app.store); repository.claim(f.room.id);
  const before = repository.read(f.room.id);
  for (const [body, options, expected] of invalidRequests(f)) {
    const response = await reinitialize(f, body, options);
    assert.equal(response.status, expected, JSON.stringify({ body, options: { ...options, headers: Object.keys(options.headers || {}) } }));
    assert.deepEqual(repository.read(f.room.id), before); assert.equal(repository.hasLease(f.room.id), true);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'fake-launch.json')), false);
});

test('session reinitialization rejects busy in-memory ownership and persistent leases with distinct codes', { timeout: 30000 }, async t => {
  let started, resolve;
  const launching = new Promise(r => { started = r; });
  const child = new EventEmitter(); child.write = () => {}; child.resize = () => {}; child.stop = () => child.emit('exit', { exitCode: 0 });
  t.after(() => { resolve?.(child); child.emit('exit', { exitCode: 0 }); });
  const f = await fixture(t, { authTimeoutMs: 5000, launch: () => { started(); return new Promise(r => { resolve = r; }); } });
  const repository = new EmbeddedPlannerRepository(f.app.store), claim = repository.claim(f.room.id), before = repository.read(f.room.id);
  let response = await reinitialize(f); assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'planner_process_exit_unconfirmed'); assert.deepEqual(repository.read(f.room.id), before);
  repository.release(f.room.id, claim.leaseId);
  const pending = terminal(f); await launching;
  response = await reinitialize(f); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'planner_room_busy');
  resolve(child); const attached = await pending;
  response = await reinitialize(f); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'planner_room_busy');
  attached.ws.close(); await attached.ended;
  response = await reinitialize(f); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'planner_room_busy');
  assert.deepEqual(repository.read(f.room.id), before);
});

test('session reinitialization is idempotent, isolated to one room, updates state and logs only a fixed diagnostic', { timeout: 30000 }, async t => {
  const logs = [], f = await fixture(t, { log: entry => logs.push(entry) }), repository = new EmbeddedPlannerRepository(f.app.store);
  const empty = await reinitialize(f); assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), { reinitialized: false });
  assert.equal(repository.read(f.room.id), null);
  assert.equal((await reinitialize(f, { confirm: true }, { roomId: 'missing-room' })).status, 404);
  const claim = repository.claim(f.room.id); repository.release(f.room.id, claim.leaseId);
  const other = f.app.store.createConversation({ title: 'Other', participants: [{ agentId: 'synthetic' }] }); repository.claim(other.id);
  const otherBefore = repository.read(other.id);
  const response = await reinitialize(f, { confirm: true }, { raw: ' '.repeat(1024 - 16) + '{"confirm":true}' });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { reinitialized: true });
  assert.equal(repository.read(f.room.id).sessionId, claim.metadata.sessionId);
  assert.equal((await state(f)).sessionInitialized, false);
  assert.deepEqual(repository.read(other.id), otherBefore); assert.equal(repository.hasLease(other.id), true);
  assert.deepEqual(await (await reinitialize(f)).json(), { reinitialized: false });
  assert.deepEqual(logs, [{ event: 'planner_session_reinitialized', conversationId: f.room.id, reasonCode: 'planner_session_reinitialized' }]);
  assert.equal(fs.existsSync(path.join(f.root, 'fake-launch.json')), false);
});

test('session reinitialization controller rejects agents, non-loopback binds/peers and duplicate Host before runtime access', async () => {
  let calls = 0;
  const base = 'http://127.0.0.1:45678', pathname = '/api/conversations/test' + suffix;
  for (const variation of [{ principal: { kind: 'agent' } }, { host: '0.0.0.0' }, { remoteAddress: '192.0.2.1' },
    { rawHeaders: ['Host', '127.0.0.1:45678', 'Host', 'localhost:45678'] }]) {
    const handler = createEmbeddedPlannerController({ host: variation.host || '127.0.0.1', csrfToken: 'synthetic', getAuthority: () => '127.0.0.1:45678',
      runtime: { capability: () => ({ enabled: true }), reinitializeSession: () => { calls++; } } });
    const req = { method: 'POST', socket: { remoteAddress: variation.remoteAddress || '127.0.0.1' }, headers: { host: '127.0.0.1:45678', origin: base,
      'content-type': 'application/json', 'x-caff-csrf-token': 'synthetic' }, rawHeaders: variation.rawHeaders };
    await assert.rejects(handler({ req, principal: variation.principal || { kind: 'user' }, pathname, requestUrl: new URL(base + pathname) }), e => e.statusCode === 403);
  }
  assert.equal(calls, 0);
});

test('corrupt planner metadata returns a fixed 409 recovery explanation, not an internal error', { timeout: 30000 }, async t => {
  const f = await fixture(t), repository = new EmbeddedPlannerRepository(f.app.store);
  const claim = repository.claim(f.room.id); repository.release(f.room.id, claim.leaseId);
  f.app.store.db.prepare("UPDATE chat_conversations SET metadata_json=json_set(metadata_json, '$.embeddedPlanner.sessionId', 'corrupt-sentinel') WHERE id=?").run(f.room.id);
  const response = await reinitialize(f); assert.equal(response.status, 409);
  const result = await response.json(); assert.equal(result.code, 'planner_session_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /corrupt-sentinel|UPDATE|SELECT/);
  const read = await fetch(f.base + `/api/conversations/${f.room.id}/planner/state`, { headers: { 'X-CAFF-CSRF-Token': f.auth.token } });
  assert.equal(read.status, 409); assert.equal((await read.json()).code, 'planner_session_unavailable');
});

test('session reinitialization is absent when disabled or non-loopback, and only accepts POST', { timeout: 30000 }, async t => {
  const off = await fixture(t, { enabled: false }); assert.equal((await reinitialize(off)).status, 404);
  const nonlocal = await fixture(t, { bindHost: '0.0.0.0' });
  assert.equal((await reinitialize(nonlocal, { confirm: true }, { headers: { Host: '0.0.0.0:' + nonlocal.port, Origin: 'http://0.0.0.0:' + nonlocal.port } })).status, 404);
  const f = await fixture(t); assert.equal((await reinitialize(f, {}, { method: 'PUT' })).status, 404);
});

test('fake CLI reproduces missing transcript; reinitialize uses same UUID/new-session argv, then later resume works', { timeout: 30000 }, async t => {
  const f = await fixture(t, { authTimeoutMs: 5000, cliFixture: path.join(__dirname, '../fixtures/fake-planner-session-cli.cjs') });
  const first = await terminal(f), sessionId = first.ready.sessionId;
  await first.wait(e => e.some(x => x.type === 'output' && x.data.includes('FAKE_SESSION_READY')));
  assert.deepEqual(argv(f), ['--session-id', sessionId]); first.ws.send(JSON.stringify({ type: 'input', data: '/exit\r' })); await first.ended;
  assert.equal(fs.existsSync(path.join(f.root, 'fake-saved-session.json')), false);
  const missing = await terminal(f); await missing.ended;
  assert.deepEqual(argv(f), ['--resume', sessionId]);
  assert.equal(missing.events.find(e => e.type === 'exit').reasonCode, 'planner_session_unavailable');
  assert.deepEqual(await (await reinitialize(f)).json(), { reinitialized: true });
  assert.equal((await state(f)).sessionInitialized, false);
  const retry = await terminal(f); await retry.wait(e => e.some(x => x.type === 'output' && x.data.includes('FAKE_SESSION_READY')));
  assert.equal(retry.ready.resumed, false); assert.equal(retry.ready.sessionId, sessionId); assert.deepEqual(argv(f), ['--session-id', sessionId]);
  assert.equal((await state(f)).sessionInitialized, true);
  retry.ws.send(JSON.stringify({ type: 'input', data: 'save\r' }));
  await retry.wait(e => e.some(x => x.type === 'output' && x.data.includes('FAKE_SESSION_SAVED')));
  retry.ws.send(JSON.stringify({ type: 'input', data: '/exit\r' })); await retry.ended;
  const resumed = await terminal(f); await resumed.wait(e => e.some(x => x.type === 'output' && x.data.includes('FAKE_SESSION_READY')));
  assert.equal(resumed.ready.resumed, true); assert.equal(resumed.ready.sessionId, sessionId); assert.deepEqual(argv(f), ['--resume', sessionId]);
  resumed.ws.send(JSON.stringify({ type: 'input', data: '/exit\r' })); await resumed.ended;
});

test('fake CLI rejects duplicate --session-id without changing transcript; next attach safely resumes', { timeout: 30000 }, async t => {
  const f = await fixture(t, { authTimeoutMs: 5000, cliFixture: path.join(__dirname, '../fixtures/fake-planner-session-cli.cjs') });
  const first = await terminal(f), sessionId = first.ready.sessionId;
  await first.wait(e => e.some(x => x.type === 'output' && x.data.includes('FAKE_SESSION_READY')));
  first.ws.send(JSON.stringify({ type: 'input', data: 'save\r' })); await first.wait(e => e.some(x => x.type === 'output' && x.data.includes('FAKE_SESSION_SAVED')));
  first.ws.send(JSON.stringify({ type: 'input', data: '/exit\r' })); await first.ended;
  const record = path.join(f.root, 'fake-saved-session.json'), before = fs.readFileSync(record, 'utf8');
  assert.deepEqual(await (await reinitialize(f)).json(), { reinitialized: true });
  const duplicate = await terminal(f); await duplicate.ended;
  assert.equal(duplicate.ready.resumed, false); assert.deepEqual(argv(f), ['--session-id', sessionId]);
  assert.equal(duplicate.events.find(e => e.type === 'exit').exitCode, 1);
  assert.match(duplicate.events.filter(e => e.type === 'output').map(e => e.data).join(''), /already in use/);
  assert.equal(fs.readFileSync(record, 'utf8'), before);
  const resumed = await terminal(f); await resumed.wait(e => e.some(x => x.type === 'output' && x.data.includes('FAKE_SESSION_READY')));
  assert.equal(resumed.ready.resumed, true); assert.deepEqual(argv(f), ['--resume', sessionId]);
  resumed.ws.send(JSON.stringify({ type: 'input', data: '/exit\r' })); await resumed.ended;
});
