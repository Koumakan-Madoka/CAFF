const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { WebSocket } = require('ws');
const { fixture, rejected } = require('../helpers/planner-terminal');

async function withLimit(value, run) {
  const previous = process.env.CAFF_PLANNER_MAX_PROCESSES;
  if (value === undefined) delete process.env.CAFF_PLANNER_MAX_PROCESSES;
  else process.env.CAFF_PLANNER_MAX_PROCESSES = value;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.CAFF_PLANNER_MAX_PROCESSES;
    else process.env.CAFF_PLANNER_MAX_PROCESSES = previous;
  }
}

for (const value of ['', '   ', '0', '-2', '1.5', '01', '1e2', '9007199254740992', 'private-value-sentinel']) {
  test(`invalid process limit ${JSON.stringify(value)} stays visible with a bounded reason and launches nothing`, async t => {
    const f = await withLimit(value, () => fixture(t));
    assert.equal(f.boot.plannerTerminal.enabled, true);
    assert.equal(f.boot.plannerTerminal.available, false);
    assert.equal(f.boot.plannerTerminal.reasonCode, 'planner_process_limit_invalid');
    const response = await fetch(f.base + `/api/conversations/${f.room.id}/planner/state`, { headers: { 'X-CAFF-CSRF-Token': f.auth.token } });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.available, false); assert.equal(state.reasonCode, 'planner_process_limit_invalid');
    assert.equal(state.wakeupAvailable, false); assert.equal(state.wakeupReasonCode, 'planner_process_limit_invalid');
    assert.equal(state.quota.used, 0); assert.equal(state.processState, 'absent');
    assert.equal(await rejected(f.connect()), 503);
    assert.equal(fs.existsSync(path.join(f.root, 'fake-probe.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'fake-launch.json')), false);
    assert.equal(f.app.store.getConversationWithoutMessages(f.room.id).metadata.embeddedPlanner, undefined);
    assert.ok(!JSON.stringify([f.boot, state]).includes('private-value-sentinel'));
    const normalRoute = await fetch(f.base + '/api/projects');
    assert.equal(normalRoute.status, 200); await normalRoute.json();
  });
}

for (const options of [{ enabled: false }, { bindHost: '0.0.0.0' }]) {
  test('invalid limit cannot override feature-off or local-only restrictions', async t => {
    const f = await withLimit('0', () => fixture(t, options));
    assert.equal(f.boot.plannerTerminal.enabled, false);
    assert.equal(f.boot.plannerTerminal.reasonCode, options.enabled === false ? 'planner_terminal_disabled' : 'planner_terminal_local_only');
    assert.equal(fs.existsSync(path.join(f.root, 'fake-probe.json')), false);
    assert.equal(await rejected(f.connect()), 404);
  });
}

test('custom startup cap reaches authenticated WS admission; closing a pane retains its slot', async t => {
  const children = [];
  const f = await withLimit('2', () => fixture(t, { authTimeoutMs: 5000, launch: () => {
    const child = new EventEmitter(); child.write = () => {}; child.resize = () => {};
    child.stop = () => { child.stopped = true; child.emit('exit', { exitCode: 0 }); };
    children.push(child); return child;
  } }));
  assert.equal(f.boot.plannerTerminal.available, true);
  function connect(id) {
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/conversations/${id}/planner/terminal`, { headers: { Origin: f.base } });
    t.after(() => ws.terminate()); return ws;
  }
  async function auth(id) {
    const ws = connect(id); await once(ws, 'open');
    const message = once(ws, 'message'); ws.send(JSON.stringify(f.auth));
    return { ws, message: JSON.parse((await message)[0]) };
  }
  const first = await auth(f.room.id); assert.equal(first.message.type, 'ready');
  const end = once(first.ws, 'close'); first.ws.send(JSON.stringify({ type: 'detach' })); await end;
  const room = () => f.app.store.createConversation({ title: 'Synthetic cap room', projectScopeId: f.room.projectScopeId, participants: ['synthetic'] }).id;
  assert.equal((await auth(room())).message.type, 'ready');
  const last = connect(room()); await once(last, 'open');
  const failure = once(last, 'message'), close = once(last, 'close'); last.send(JSON.stringify(f.auth));
  assert.equal(JSON.parse((await failure)[0]).code, 'planner_process_limit');
  assert.equal((await close)[0], 1013);
  assert.equal(children.length, 2); assert.ok(children.every(child => !child.stopped));
});
