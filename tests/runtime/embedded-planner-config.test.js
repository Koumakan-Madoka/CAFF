const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { EmbeddedPlannerRepository } = require('../../build/storage/chat/embedded-planner.repository');
const { createEmbeddedPlannerRuntime } = require('../../build/server/domain/runtime/embedded-planner-runtime');

function withLimit(value, run) {
  const previous = process.env.CAFF_PLANNER_MAX_PROCESSES;
  if (value === undefined) delete process.env.CAFF_PLANNER_MAX_PROCESSES;
  else process.env.CAFF_PLANNER_MAX_PROCESSES = value;
  try { return run(); }
  finally {
    if (previous === undefined) delete process.env.CAFF_PLANNER_MAX_PROCESSES;
    else process.env.CAFF_PLANNER_MAX_PROCESSES = previous;
  }
}
function fixture(t, value, extra = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-limit-')));
  const cli = path.join(root, 'synthetic.cjs');
  fs.copyFileSync(path.join(__dirname, '../fixtures/fake-planner-cli.cjs'), cli);
  const store = createChatAppStore({ agentDir: root, sqlitePath: path.join(root, 'test.sqlite') });
  store.saveCustomRoleConfig({ id: 'synthetic', name: 'Synthetic', personaPrompt: 'Test', provider: 'test', model: 'test' });
  const repository = new EmbeddedPlannerRepository(store), children = [];
  function launch(config) {
    const child = new EventEmitter();
    child.config = config; child.write = () => {}; child.resize = () => {};
    child.stop = () => { child.stopped = true; if (!child.hang) child.emit('exit', { exitCode: 0 }); };
    children.push(child); return child;
  }
  const runtime = withLimit(value, () => createEmbeddedPlannerRuntime({ host: '127.0.0.1', store,
    projectManager: { listProjects: () => [{ id: 'project-test', path: root }] },
    config: { enabled: true, cliPath: cli, launch,
      env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot,
        CAFF_PLANNER_MAX_PROCESSES: '99' }, ...extra } }));
  t.after(async () => {
    for (const child of children) { child.hang = false; child.emit('exit', { exitCode: 0 }); }
    await runtime.close(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const room = () => store.createConversation({ title: 'Synthetic', projectScopeId: 'project-test', participants: ['synthetic'] }).id;
  const attach = id => runtime.getHost().attach(id, { cols: 120, rows: 30 }, () => {});
  return { root, store, repository, children, runtime, room, attach, launch,
    start: () => runtime.start('http://127.0.0.1:45678', null) };
}

test('startup process limit reaches the host instead of the hard-coded default', async t => {
  const f = fixture(t, '1'); await f.start();
  await f.attach(f.room());
  await assert.rejects(f.attach(f.room()), { code: 'planner_process_limit' });
  assert.equal(f.children.length, 1);
});

test('process limit parser accepts only trimmed canonical positive decimal safe integers', () => {
  const { parsePlannerMaxProcesses } = require('../../build/server/domain/runtime/embedded-planner-config');
  for (const [text, expected] of [[undefined, 4], ['1', 1], ['2', 2], ['6', 6], [' 12\t', 12], ['9007199254740991', Number.MAX_SAFE_INTEGER]]) {
    assert.equal(parsePlannerMaxProcesses(text), expected);
  }
  for (const text of ['', '   ', '0', '-1', '+1', '01', '1.0', '1.5', '1e2', '0x10', 'Infinity', 'NaN',
    '9007199254740992', '9'.repeat(400), '2 private-value', '1\n2', '1_000', '１']) {
    assert.throws(() => parsePlannerMaxProcesses(text), error => {
      assert.equal(error.code, 'planner_process_limit_invalid');
      assert.equal(error.message, 'planner_process_limit_invalid'); return true;
    });
  }
});

for (const [label, value, expected] of [['unset', undefined, 4], ['trimmed', ' 2 ', 2], ['above default', '6', 6]]) {
  test(`${label} startup limit admits exactly ${expected} processes without eviction or child env leakage`, async t => {
    const f = fixture(t, value); await f.start();
    assert.equal(f.runtime.capability().available, true);
    for (let i = 0; i < expected; i++) await f.attach(f.room());
    await assert.rejects(f.attach(f.room()), { code: 'planner_process_limit' });
    assert.equal(f.children.length, expected);
    assert.ok(f.children.every(child => !child.stopped && child.config.env.CAFF_PLANNER_MAX_PROCESSES === undefined));
  });
}

test('only construction reads the limit: changes before start/after start require a new runtime', async t => {
  const f = fixture(t, '2');
  await withLimit('invalid-after-construction', () => f.start());
  await withLimit('1', () => f.attach(f.room()));
  await withLimit('1', () => f.attach(f.room()));
  await assert.rejects(withLimit('9', () => f.attach(f.room())), { code: 'planner_process_limit' });
  const next = fixture(t, '1'); await next.start(); await next.attach(next.room());
  await assert.rejects(next.attach(next.room()), { code: 'planner_process_limit' });
  const invalid = fixture(t, '0'); await withLimit('2', () => invalid.start());
  assert.equal(invalid.runtime.capability().reasonCode, 'planner_process_limit_invalid');
  assert.equal(invalid.runtime.getHost(), null);
});

test('invalid startup limit performs no probe, lease reconciliation, host creation or room launch', async t => {
  let probes = 0;
  const f = fixture(t, 'private-value-sentinel', { probeGuardian: () => { probes++; return false; } });
  const id = f.room(), claim = f.repository.claim(id);
  f.repository.recordGuardian(id, claim.leaseId, process.pid);
  await f.start();
  assert.equal(f.runtime.getHost(), null); assert.equal(probes, 0);
  assert.equal(f.repository.hasLease(id), true); assert.equal(f.children.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'fake-probe.json')), false);
  assert.equal(f.runtime.capability().reasonCode, 'planner_process_limit_invalid');
});

test('custom shared cap fences concurrent interactive/headless starts, retained and stopping children until observed exit', async t => {
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const f = fixture(t, '2', { launch: config => gate.then(() => f.launch(config)) });
  await f.start();
  const interactive = f.room(), wake = f.room(), extra = f.room();
  const claim = f.repository.claim(wake); f.repository.release(wake, claim.leaseId);
  const first = f.attach(interactive);
  const second = f.runtime.getHost().startHeadless(wake, config => gate.then(() => f.launch(config)));
  try {
    assert.equal(f.runtime.getHost().state(interactive), 'starting');
    assert.equal(f.runtime.getHost().state(wake), 'starting');
    await assert.rejects(f.attach(extra), { code: 'planner_process_limit' });
  } finally { unblock(); }
  const [attached, headless] = await Promise.all([first, second]);
  assert.equal(f.children.length, 2); attached.detach();
  assert.equal(f.runtime.getHost().state(interactive), 'interactive-retained');
  await assert.rejects(f.attach(extra), { code: 'planner_process_limit' });
  const retained = f.children.find(child => child.config.env.CAFF_ROOM_ID === interactive);
  assert.equal(retained.stopped, undefined);
  const running = f.children.find(child => child.config.env.CAFF_ROOM_ID === wake);
  running.hang = true; headless.stop();
  assert.equal(f.runtime.getHost().state(wake), 'stopping');
  await assert.rejects(f.attach(extra), { code: 'planner_process_limit' });
  running.emit('exit', { exitCode: 0 }); await headless.finished;
  await f.attach(extra); assert.equal(f.children.length, 3);
  assert.equal(retained.stopped, undefined);
});

test('unknown durable lease counts toward configured instance cap and is not silently reclaimed', async t => {
  const f = fixture(t, '1'), unknown = f.room(), other = f.room();
  const claim = f.repository.claim(unknown);
  await f.start();
  assert.equal(f.runtime.roomState(unknown).processState, 'uncertain');
  await assert.rejects(f.attach(unknown), { code: 'planner_process_exit_unconfirmed' });
  await assert.rejects(f.attach(other), { code: 'planner_process_limit' });
  assert.equal(f.children.length, 0); assert.equal(f.repository.hasLease(unknown), true);
  f.repository.release(unknown, claim.leaseId); // Synthetic proof of confirmed exit.
  await f.attach(other); assert.equal(f.children.length, 1);
});

// Each environment override is restored by the fixture; no real CLI/models.

