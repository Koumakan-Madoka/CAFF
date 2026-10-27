const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { fixture, closed, rejected } = require('../helpers/planner-terminal');

test('terminal rejects invalid authorities/origins/queries before auth and leaves metadata untouched', async t => {
  const f = await fixture(t); assert.equal(f.boot.plannerTerminal.available, true);
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'https://127.0.0.1:' + f.port }, { Origin: 'http://evil.invalid' }, { Host: 'evil.invalid', Origin: 'http://evil.invalid' }, { Host: 'localhost:' + f.port, Origin: f.base }, { Host: '127.0.0.1:1', Origin: f.base }, { Origin: [f.base, f.base] }, { Host: ['127.0.0.1:' + f.port, 'localhost:' + f.port], Origin: f.base }]) {
    assert.equal(await rejected(f.connect(headers)), 403);
  }
  assert.equal(await rejected(f.connect({ Origin: f.base }, '?token=not-allowed')), 404);
  assert.equal(f.app.store.getConversationWithoutMessages(f.room.id).metadata.embeddedPlanner, undefined);
  assert.equal(fs.existsSync(path.join(f.root, 'fake-launch.json')), false);
});

test('first message policy rejects wrong token/types/schemas/binary/oversize and timeout with zero data/spawn', async t => {
  const f = await fixture(t);
  for (const payload of [JSON.stringify({ ...f.auth, token: 'wrong' }), JSON.stringify({ ...f.auth, extra: 1 }), JSON.stringify({ ...f.auth, version: 2 }), JSON.stringify({ ...f.auth, cols: 19 }), '{', JSON.stringify({ type: 'input', data: 'bad' }), Buffer.from(JSON.stringify(f.auth)), 'x'.repeat(65537)]) {
    const result = await closed(f.connect(), s => s.send(payload));
    assert.ok([1008, 1009].includes(result.code)); assert.deepEqual(result.messages, []);
  }
  assert.deepEqual(await closed(f.connect()), { code: 1008, messages: [] });
  assert.equal(f.app.store.getConversationWithoutMessages(f.room.id).metadata.embeddedPlanner, undefined);
  assert.equal(fs.existsSync(path.join(f.root, 'fake-launch.json')), false);
});

test('authenticated terminal has ready before live output, owns input/resize, rejects second page and reattaches', async t => {
  const f = await fixture(t, { authTimeoutMs: 5000 }); const ws = f.connect(); const events = [];
  ws.on('message', data => events.push(JSON.parse(data)));
  await once(ws, 'open'); ws.send(JSON.stringify(f.auth));
  while (!events.some(e => e.type === 'output' && e.data.includes('FAKE_READY'))) await once(ws, 'message');
  assert.equal(events[0].type, 'ready'); assert.equal(events[0].resumed, false); assert.equal(events[0].historyReplay, false);
  const launch = JSON.parse(fs.readFileSync(path.join(f.root, 'fake-launch.json')));
  assert.equal(launch.cwd, f.root); assert.equal(launch.env.ANTHROPIC_API_KEY, undefined); assert.equal(launch.env.CAFF_ROOM_ID, f.room.id);
  assert.equal(launch.env.COLORTERM, 'truecolor');
  const second = await closed(f.connect(), s => s.send(JSON.stringify(f.auth)));
  assert.equal(second.code, 1013); assert.equal(JSON.parse(second.messages[0]).code, 'planner_terminal_in_use');
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }));
  ws.send(JSON.stringify({ type: 'input', data: 'hello\r' }));
  while (!events.some(e => e.type === 'output' && e.data.includes('ECHO:hello'))) await once(ws, 'message');
  const done = once(ws, 'close'); ws.send(JSON.stringify({ type: 'detach' })); await done;
  const ws2 = f.connect(); await once(ws2, 'open'); const msg = once(ws2, 'message'); ws2.send(JSON.stringify(f.auth));
  assert.equal(JSON.parse((await msg)[0]).resumed, true);
  const exit = once(ws2, 'close'); ws2.send(JSON.stringify({ type: 'terminate' })); await exit;
});

test('resumed WS terminate reports intentional stop, while a missing saved session still reports unavailability', async t => {
  const f = await fixture(t, { authTimeoutMs: 5000, cliFixture: path.join(__dirname, '../fixtures/fake-planner-session-cli.cjs') });
  async function start() {
    const ws = f.connect(), events = [];
    ws.on('message', data => events.push(JSON.parse(data)));
    await once(ws, 'open'); ws.send(JSON.stringify(f.auth));
    return { ws, events, wait: async predicate => { while (!events.some(predicate)) await once(ws, 'message'); return events.find(predicate); } };
  }
  const first = await start(); await first.wait(e => e.type === 'output' && e.data.includes('FAKE_SESSION_READY'));
  first.ws.send(JSON.stringify({ type: 'input', data: 'save\r' }));
  await first.wait(e => e.type === 'output' && e.data.includes('FAKE_SESSION_SAVED'));
  const firstClosed = once(first.ws, 'close'); first.ws.send(JSON.stringify({ type: 'input', data: '/exit\r' }));
  await firstClosed; assert.equal(first.events.find(e => e.type === 'exit').reasonCode, 'planner_process_exited');
  const resumed = await start(); await resumed.wait(e => e.type === 'output' && e.data.includes('FAKE_SESSION_READY'));
  assert.equal(resumed.events[0].resumed, true);
  const stopped = once(resumed.ws, 'close'); resumed.ws.send(JSON.stringify({ type: 'terminate' })); await stopped;
  assert.equal(resumed.events.find(e => e.type === 'exit').reasonCode, 'planner_process_stopped');
  fs.unlinkSync(path.join(f.root, 'fake-saved-session.json'));
  const missing = await start(); const missingClosed = once(missing.ws, 'close'); await missingClosed;
  assert.equal(missing.events.find(e => e.type === 'exit').reasonCode, 'planner_session_unavailable');
});

test('bundled ConPTY attach failure has a fixed WS reason, no ready/output or retained lease', async t => {
  const f = await fixture(t, { authTimeoutMs: 5000, launch: () => { throw Object.assign(new Error('private sentinel'), { code: 'planner_conpty_unavailable' }); } });
  const result = await closed(f.connect(), s => s.send(JSON.stringify(f.auth)));
  assert.equal(result.code, 1011);
  assert.deepEqual(result.messages.map(JSON.parse), [{ type: 'error', code: 'planner_conpty_unavailable', message: 'Planner terminal is unavailable' }]);
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM chat_embedded_planner_leases').get().n, 0);
});

test('post-auth unknown messages and invalid input cause no PTY input', async t => {
  const f = await fixture(t, { authTimeoutMs: 5000 });
  for (const message of [{ type: 'input', data: 'x'.repeat(16385) }, { type: 'resize', cols: 501, rows: 30 }, { type: 'auth', ...f.auth }, { type: 'input', data: 'bad', cwd: 'evil' }]) {
    const ws = f.connect(); await once(ws, 'open'); const ready = once(ws, 'message'); ws.send(JSON.stringify(f.auth)); await ready;
    const end = once(ws, 'close'); ws.send(JSON.stringify(message)); assert.equal((await end)[0], 1008);
  }
});

test('feature-off exposes no endpoint/probe or capability entry; unsupported CLI leaves ordinary routes usable', { timeout: 30000 }, async t => {
  const off = await fixture(t, { enabled: false, cliPath: '/missing-cli' });
  assert.equal(off.boot.plannerTerminal.enabled, false); assert.equal(await rejected(off.connect()), 404);
  const bad = await fixture(t, { cliPath: '/missing-cli' });
  assert.equal(bad.boot.plannerTerminal.available, false); assert.equal(await rejected(bad.connect()), 503);
  assert.equal((await fetch(bad.base + '/api/bootstrap')).status, 200);
});
