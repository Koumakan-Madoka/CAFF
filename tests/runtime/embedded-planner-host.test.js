const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { buildPlannerEnvironment } = require('../../build/server/domain/runtime/embedded-planner-env');
const { resolvePlannerCli, probePlannerCli } = require('../../build/server/domain/runtime/embedded-planner-cli');
const { createEmbeddedPlannerHost } = require('../../build/server/domain/runtime/embedded-planner-host');
const { EmbeddedPlannerRepository } = require('../../build/storage/chat/embedded-planner.repository');
const { createChatAppStore } = require('../../build/lib/chat-app-store');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-host-'));
  const store = createChatAppStore({ agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') });
  const repository = new EmbeddedPlannerRepository(store);
  const agent = store.saveCustomRoleConfig({ id: 'synthetic', name: 'Synthetic', personaPrompt: 'test', provider: 'test', model: 'test' });
  const room = store.createConversation({ title: 'Synthetic planner room', projectScopeId: 'project-test', participants: [{ agentId: agent.id }] });
  const children = [];
  const timers = new Map();
  const host = createEmbeddedPlannerHost({ repository, resolveRoom: id => {
    const r = store.getConversationWithoutMessages(id);
    if (!r) throw new Error('missing');
    return { room: r, cwd: root, branch: null, projectId: r.projectScopeId };
  }, baseUrl: 'http://127.0.0.1:45678', env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot },
    cli: { file: process.execPath, prefix: ['fake.js'] },
    launch: config => {
      const child = new EventEmitter();
      child.config = config; child.writes = []; child.sizes = [];
      child.write = data => child.writes.push(data);
      child.resize = (cols, rows) => { child.sizes.push([cols, rows]); child.emit('data', 'repaint'); };
      child.stop = () => { child.stopped = true; if (!child.hang) child.emit('exit', { exitCode: child.stopExitCode ?? 0 }); };
      children.push(child); return child;
    }, setTimer: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id), ...overrides });
  t.after(async () => { for (const c of children) { c.hang = false; c.emit('exit', { exitCode: 0 }); } await host.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const attach = id => host.attach(id || room.id, { cols: 120, rows: 30 }, () => {});
  return { root, store, repository, room, children, timers, host, attach };
}

test('child environment is an allowlist on POSIX, with proxies but without inherited credentials/session preferences', () => {
  const env = buildPlannerEnvironment({ platform: 'linux', source: { PATH: '/bin', HOME: '/synthetic', XDG_STATE_HOME: '/state', TMPDIR: '/tmp', HTTP_PROXY: 'http://u:p@proxy.invalid', http_proxy: 'http://lower.invalid', NO_PROXY: 'localhost', https_proxy: 'https://lower.invalid', ALL_PROXY: 'socks://proxy.invalid', all_proxy: 'socks://lower.invalid', HTTPS_PROXY: 'https://proxy.invalid', no_proxy: '127.0.0.1', ANTHROPIC_API_KEY: 'sentinel', ANTHROPIC_AUTH_TOKEN: 'sentinel', CAFF_CHAT_TOKEN: 'sentinel', NODE_OPTIONS: 'sentinel', CLAUDE_CODE_SESSION_ID: 'sentinel', CLAUDE_CODE_MODEL: 'sentinel', CAFF_CLAUDE_CLI: 'sentinel', TERM: 'wrong', COLORTERM: 'wrong' }, baseUrl: 'http://127.0.0.1:45678', roomId: 'room-test', credentialPath: '/synthetic/credential.json', interactive: true });
  assert.deepEqual(Object.keys(env).sort(), ['PATH','HOME','XDG_STATE_HOME','TMPDIR','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','DISABLE_AUTOUPDATER','CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT','CLAUDE_CODE_NO_FLICKER','TERM','COLORTERM','CAFF_BASE_URL','CAFF_ROOM_ID','CAFF_PLANNER_CREDENTIAL_FILE'].sort());
  assert.equal(env.HTTP_PROXY, 'http://u:p@proxy.invalid'); assert.equal(env.http_proxy, 'http://lower.invalid');
  assert.equal(env.COLORTERM, 'truecolor'); assert.equal(env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT, '1');
});

for (const platform of ['linux', 'win32']) {
  for (const interactive of [true, false, undefined]) {
    test(`${platform} ${interactive === true ? 'interactive PTY pins fullscreen' : `noninteractive (${interactive}) omits renderer pin`} without inheriting renderer preferences`, () => {
      for (const inherited of ['0', '1', 'unexpected']) {
        const source = Object.freeze({ PATH: '/bin', HOME: '/synthetic', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\synthetic',
          CLAUDE_CODE_NO_FLICKER: inherited, claude_code_no_flicker: 'lowercase-sentinel',
          CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1', claude_code_disable_alternate_screen: 'lowercase-sentinel',
          CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '0', TERM: 'wrong', COLORTERM: 'wrong' });
        const env = buildPlannerEnvironment({ platform, source, interactive, baseUrl: 'http://127.0.0.1:45678' });
        assert.equal(env.CLAUDE_CODE_NO_FLICKER, interactive === true ? '1' : undefined);
        assert.equal(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, undefined);
        assert.equal(env.TERM, interactive === true ? 'xterm-256color' : undefined);
        assert.equal(env.COLORTERM, interactive === true ? 'truecolor' : undefined);
        assert.equal(env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT, '1');
        assert.deepEqual(Object.keys(env).filter(k => /^claude_code_/i.test(k)).sort(),
          ['CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT', ...(interactive === true ? ['CLAUDE_CODE_NO_FLICKER'] : [])]);
      }
    });
  }
}

test('Windows normalizes path/proxy case collisions and requires user configuration paths', () => {
  const env = buildPlannerEnvironment({ platform: 'win32', source: { Path: 'C:\\bin', SYSTEMROOT: 'C:\\Windows', userprofile: 'C:\\synthetic', HTTP_PROXY: 'upper', http_proxy: 'lower', claude_code_session_id: 'sentinel', anthropic_api_key: 'sentinel' }, baseUrl: 'http://localhost:45678', interactive: false });
  assert.equal(env.PATH, 'C:\\bin'); assert.equal(env.HTTP_PROXY, 'upper'); assert.equal(env.USERPROFILE, 'C:\\synthetic');
  assert.equal(env.TERM, undefined); assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.throws(() => buildPlannerEnvironment({ platform: 'linux', source: { PATH: '/bin' }, baseUrl: 'http://localhost:1' }), /planner_environment_invalid/);
});

test('headless preflight receives the exact spawn environment before a lease is claimed', async t => {
  const f = fixture(t), claim = f.repository.claim(f.room.id); f.repository.release(f.room.id, claim.leaseId);
  let inspected, spawned = false;
  await assert.rejects(f.host.startHeadless(f.room.id, () => { spawned = true; }, (_room, env) => {
    inspected = env; assert.equal(env.HOME, f.root); assert.equal(env.CAFF_ROOM_ID, f.room.id);
    assert.equal(f.repository.hasLease(f.room.id), false);
    throw Object.assign(new Error('blocked'), { code: 'planner_wakeup_settings_unsafe' });
  }), { code: 'planner_wakeup_settings_unsafe' });
  assert.equal(spawned, false); assert.equal(f.host.state(f.room.id), 'absent');
  const child = new EventEmitter(); child.stop = () => child.emit('exit', { exitCode: 0 });
  await f.host.startHeadless(f.room.id, launch => { assert.strictEqual(launch.env, inspected); return child; }, (_room, env) => { inspected = env; });
  child.stop();
});

test('first launch persists one UUID before spawn; detach, reattach/repaint and exit/resume never replay', async t => {
  const f = fixture(t); const first = await f.attach();
  const meta = f.store.getConversationWithoutMessages(f.room.id).metadata.embeddedPlanner;
  assert.equal(meta.launchAttempted, true); assert.equal(meta.wakeupsEnabled, false);
  assert.match(meta.sessionId, /^[0-9a-f-]{36}$/); assert.equal(first.sessionId, meta.sessionId);
  assert.deepEqual(f.children[0].config.args.slice(0, 2), ['--session-id', meta.sessionId]);
  assert.equal(f.children[0].config.cwd, f.root); assert.match(f.children[0].config.args[3], /Reading and planning only/);
  assert.match(f.children[0].config.args[3], /Never edit or commit/);
  first.detach(); assert.equal([...f.timers.values()][0].ms, 30 * 60 * 1000);
  const output = []; const second = await f.host.attach(f.room.id, { cols: 120, rows: 30 }, e => output.push(e));
  assert.equal(second.resumed, true); assert.equal(f.children.length, 1); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.children[0].sizes, [[121, 30], [120, 30]]); assert.deepEqual(output, [{ type: 'output', data: 'repaint' }, { type: 'output', data: 'repaint' }]);
  f.children[0].emit('exit', { exitCode: 0 }); const third = await f.attach();
  assert.equal(third.sessionId, first.sessionId); assert.equal(third.resumed, true);
  assert.deepEqual(f.children[1].config.args.slice(0, 2), ['--resume', meta.sessionId]);
});

// An asynchronous console observer sees only the last size in a same-tick
// resize pair. This models libuv/ConPTY sampling, not synchronous resize echo.
async function retainedFixture(t, options = {}) {
  const f = fixture(t, { repaintTimeoutMs: 500, ...options });
  const first = await f.attach(), child = f.children[0];
  child.resize = (cols, rows) => { child.sizes.push([cols, rows]); };
  first.detach();
  return { ...f, child, first };
}

test('B1 retained nudge stays observable until asynchronous first output; latest size wins', async t => {
  const f = await retainedFixture(t), output = [];
  const a = await f.host.attach(f.room.id, { cols: 120, rows: 30 }, e => {
    if (e.type === 'output') assert.deepEqual(f.child.sizes, [[121, 30]], 'forward first output before restoring');
    output.push(e);
  });
  assert.deepEqual(f.child.sizes, [[121, 30]], 'no restore in the nudge tick');
  assert.equal([...f.timers.values()][0].ms, 500);
  a.resize(140, 42);
  assert.deepEqual(f.child.sizes, [[121, 30]], 'defer new size until output or cap');
  await new Promise(resolve => setImmediate(resolve));
  // A fake CLI polling after the tick observes a changed size, so it repaints.
  assert.deepEqual(f.child.sizes.at(-1), [121, 30]);
  f.child.emit('data', 'observed changed size');
  assert.deepEqual(output, [{ type: 'output', data: 'observed changed size' }]);
  assert.deepEqual(f.child.sizes, [[121, 30], [140, 42]]);
  assert.equal(f.timers.size, 0);
});

test('B1 quiet retained nudge restores at timeout exactly once, including 500-column boundary', async t => {
  const f = await retainedFixture(t, { repaintTimeoutMs: 17 });
  const a = await f.host.attach(f.room.id, { cols: 500, rows: 30 }, () => {});
  assert.deepEqual(f.child.sizes, [[499, 30]]);
  a.resize(99, 22);
  const timeout = [...f.timers.values()][0]; assert.equal(timeout.ms, 17); timeout.fn();
  assert.deepEqual(f.child.sizes, [[499, 30], [99, 22]]);
  f.child.emit('data', 'late repaint'); timeout.fn();
  assert.equal(f.child.sizes.length, 2); assert.equal(f.timers.size, 0);
});

for (const race of ['exit', 'uncertain', 'terminate', 'shutdown', 'disconnect', 'replace', 'new-process']) {
  test(`B1 ${race} cancels old nudge; stale callbacks cannot resize invalid ownership`, async t => {
    const f = await retainedFixture(t);
    const old = await f.host.attach(f.room.id, { cols: 120, rows: 30 }, () => {});
    assert.deepEqual(f.child.sizes, [[121, 30]]);
    const stale = [...f.timers.values()][0];
    if (race === 'exit' || race === 'new-process') f.child.emit('exit', { exitCode: 0 });
    else if (race === 'uncertain') f.child.emit('uncertain');
    else if (race === 'terminate') old.terminate();
    else if (race === 'shutdown') await f.host.close();
    else old.detach();
    if (race === 'replace') {
      const next = await f.host.attach(f.room.id, { cols: 80, rows: 20 }, () => {});
      old.detach(); stale.fn();
      assert.deepEqual(f.child.sizes, [[121, 30], [81, 20]]);
      next.resize(90, 25); f.child.emit('data', 'new owner repaint');
      assert.deepEqual(f.child.sizes.at(-1), [90, 25]);
    } else {
      if (race === 'new-process') await f.attach();
      stale.fn(); f.child.emit('data', 'late old output');
      assert.deepEqual(f.child.sizes, [[121, 30]]);
    }
  });
}

test('B2 retained first frame restores only tracked modes before nudge, including output received while detached', async t => {
  const f = await retainedFixture(t), events = [];
  f.child.emit('data', 'private screen text\x1b[?2004;1004;1049h\x1b[?25l\x1b[?9999h');
  let nudged = false;
  f.child.resize = (cols, rows) => { nudged = true; f.child.sizes.push([cols, rows]); };
  await f.host.attach(f.room.id, { cols: 120, rows: 30 }, e => {
    if (!events.length) assert.equal(nudged, false); events.push(e);
  });
  assert.deepEqual(events, [{ type: 'output', data: '\x1b[?1049h\x1b[?25l\x1b[?1004h\x1b[?2004h' }]);
  assert.equal(nudged, true);
});

test('B2 mode parsing crosses host 8-KiB chunks and data events, with latest off and reset', async t => {
  const f = fixture(t); const a = await f.attach(), child = f.children[0];
  child.emit('data', 'x'.repeat(8190) + '\x1b[?20'); child.emit('data', '04;1049h');
  child.emit('data', '\x1b[?2004l'); a.detach();
  const events = []; const b = await f.host.attach(f.room.id, { cols: 120, rows: 30 }, e => events.push(e));
  assert.equal(events[0].data, '\x1b[?1049h\x1b[?2004l');
  b.detach(); child.emit('data', '\x1bc');
  events.length = 0; await f.host.attach(f.room.id, { cols: 120, rows: 30 }, e => events.push(e));
  assert.ok(events.every(e => e.data === 'repaint'), 'reset leaves no stale modes or screen text');
});

test('live output chunks fit both UTF-8 data and complete JSON frame budgets, including dense terminal controls', async t => {
  const f = fixture(t), events = [];
  await f.host.attach(f.room.id, { cols: 120, rows: 30 }, e => events.push(e));
  f.children[0].emit('data', '\u0000'.repeat(40000) + '😀'.repeat(10000));
  assert.ok(events.length > 1);
  for (const event of events) {
    assert.ok(Buffer.byteLength(event.data) <= 16384);
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 65536);
  }
  assert.equal(events.map(e => e.data).join(''), '\u0000'.repeat(40000) + '😀'.repeat(10000));
});

test('room lock rejects parallel pages, retained PTY blocks headless admission; cap never evicts', async t => {
  const f = fixture(t, { maxProcesses: 2 }); const a = await f.attach();
  await assert.rejects(f.attach(), /planner_terminal_in_use/);
  assert.equal(f.host.canWake(f.room.id), false); a.detach(); assert.equal(f.host.canWake(f.room.id), false);
  const room2 = f.store.createConversation({ title: 'second', projectScopeId: 'project-test', participants: [{ agentId: 'synthetic' }] });
  await f.attach(room2.id);
  const room3 = f.store.createConversation({ title: 'third', projectScopeId: 'project-test', participants: [{ agentId: 'synthetic' }] });
  await assert.rejects(f.attach(room3.id), /planner_process_limit/);
  assert.equal(f.children.length, 2); assert.equal(f.children[0].stopped, undefined);
});

test('retention expiry stops only the room; stopping keeps admission until confirmed exit', async t => {
  const f = fixture(t); const a = await f.attach(); f.children[0].hang = true;
  a.detach(); [...f.timers.values()][0].fn();
  assert.equal(f.children[0].stopped, true); assert.equal(f.host.state(f.room.id), 'stopping');
  await assert.rejects(f.attach(), /planner_room_busy/);
  f.children[0].emit('exit', { exitCode: 0 }); assert.equal(f.host.state(f.room.id), 'absent');
});

for (const cause of ['terminate', 'retention', 'shutdown']) {
  for (const exitCode of [0, -1073741510]) {
    test(`CAFF ${cause} of a resumed session is an intentional stop (exit ${exitCode}), not session unavailability`, async t => {
      const f = fixture(t); await f.attach(); f.children[0].emit('exit', { exitCode: 0 });
      const events = [];
      const resumed = await f.host.attach(f.room.id, { cols: 120, rows: 30 }, e => events.push(e));
      assert.equal(resumed.resumed, true); const child = f.children[1]; child.stopExitCode = exitCode;
      if (cause === 'retention') {
        resumed.detach(); const expiry = [...f.timers.values()][0]; expiry.fn();
        // A detached pane has no listener: expiry must stop without sending it anything.
        assert.deepEqual(events, []);
      } else {
        if (cause === 'shutdown') await f.host.close(); else resumed.terminate();
        assert.equal(events.at(-1).reasonCode, 'planner_process_stopped');
        assert.equal(events.at(-1).exitCode, exitCode);
      }
      assert.equal(child.stopped, true); assert.equal(f.host.state(f.room.id), 'absent');
      assert.equal(f.repository.hasLease(f.room.id), false);
    });
  }
}

for (const exitCode of [0, 1, -1073741510]) {
  test(`unsolicited resumed exit ${exitCode} keeps the nonzero session-unavailable heuristic`, async t => {
    const f = fixture(t); await f.attach(); f.children[0].emit('exit', { exitCode: 0 });
    const events = []; await f.host.attach(f.room.id, { cols: 120, rows: 30 }, e => events.push(e));
    f.children[1].emit('exit', { exitCode });
    assert.equal(events.at(-1).reasonCode, exitCode === 0 ? 'planner_process_exited' : 'planner_session_unavailable');
  });
}

test('uncertain exit observation is not itself a CAFF-requested stop', async t => {
  const f = fixture(t); await f.attach(); f.children[0].emit('exit', { exitCode: 0 });
  const events = []; await f.host.attach(f.room.id, { cols: 120, rows: 30 }, e => events.push(e));
  f.children[1].emit('uncertain'); f.children[1].emit('exit', { exitCode: 1 });
  assert.equal(events.at(-1).reasonCode, 'planner_session_unavailable');
});

test('bundled ConPTY failure reaches the pane as a fixed reason and releases the unstarted room', async t => {
  const f = fixture(t, { launch: () => { throw Object.assign(new Error('private sentinel'), { code: 'planner_conpty_unavailable' }); } });
  await assert.rejects(f.attach(), { code: 'planner_conpty_unavailable' });
  assert.equal(f.host.state(f.room.id), 'absent'); assert.equal(f.repository.leaseCount(), 0);
});

test('ambiguous launch never reuses --session-id; persisted lease fails closed after restart', async t => {
  const f = fixture(t, { launch: () => { throw new Error('synthetic spawn failure with private data'); } });
  await assert.rejects(f.attach(), /planner_process_spawn_failed/);
  assert.equal(f.store.getConversationWithoutMessages(f.room.id).metadata.embeddedPlanner.launchAttempted, true);
  assert.equal(f.repository.leaseCount(), 0);
  f.repository.claim(f.room.id);
  await assert.rejects(f.attach(), /planner_process_exit_unconfirmed/);
});

test('PID persistence failure after spawn stops the child but fences admission until its observed exit', async t => {
  const child = new EventEmitter(); child.guardianPid = process.pid;
  child.write = () => {}; child.resize = () => {}; child.stop = () => { child.stopped = true; };
  const f = fixture(t, { launch: () => child }); f.children.push(child);
  f.repository.recordGuardian = () => { throw new Error('synthetic persistence failure'); };
  await assert.rejects(f.attach(), /planner_process_exit_unconfirmed/);
  assert.equal(child.stopped, true); assert.equal(f.repository.hasLease(f.room.id), true);
  assert.equal(f.host.hasEntry(f.room.id), true); await assert.rejects(f.attach(), /planner_room_busy/);
  child.emit('exit', { exitCode: 0 }); assert.equal(f.repository.hasLease(f.room.id), false);
});

test('PTY and headless launches share the same synchronous admission path and initialized session', async t => {
  const f = fixture(t);
  let starts = 0;
  const launch = config => {
    starts++;
    assert.deepEqual(config.args.slice(0, 2), ['--resume', f.repository.read(f.room.id).sessionId]);
    const child = new EventEmitter(); child.guardianPid = process.pid; child.stop = () => child.emit('exit', { exitCode: 0 });
    child.write = () => {}; child.resize = () => {}; f.children.push(child); return child;
  };
  await assert.rejects(f.host.startHeadless(f.room.id, launch), /session_uninitialized/);
  const pty = await f.attach();
  await assert.rejects(f.host.startHeadless(f.room.id, launch), /planner_room_busy/);
  pty.detach(); await assert.rejects(f.host.startHeadless(f.room.id, launch), /planner_room_busy/);
  f.children[0].emit('exit', { exitCode: 0 });
  const headless = await f.host.startHeadless(f.room.id, launch);
  assert.equal(starts, 1); assert.equal(f.host.state(f.room.id), 'headless-running');
  assert.equal(f.store.db.prepare('SELECT guardian_pid FROM chat_embedded_planner_leases WHERE conversation_id=?').get(f.room.id).guardian_pid, process.pid);
  await assert.rejects(f.attach(), /planner_room_busy/);
  await assert.rejects(f.host.startHeadless(f.room.id, launch), /planner_room_busy/);
  headless.stop(); assert.equal(f.host.state(f.room.id), 'absent');
});

test('session reinitialization defers headless admission as session_uninitialized without launching', async t => {
  const f = fixture(t); await f.attach();
  f.children[0].emit('exit', { exitCode: 0 });
  assert.equal(f.repository.reinitializeSession(f.room.id), true);
  await assert.rejects(f.host.startHeadless(f.room.id, () => { throw new Error('must not launch'); }), /session_uninitialized/);
  assert.equal(f.host.hasEntry(f.room.id), false); assert.equal(f.repository.hasLease(f.room.id), false);
  assert.equal(f.children.length, 1);
});

test('CLI fake version floor, invalid output, literal path with spaces and no shell shims', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'fake 中文 cli.cjs');
  fs.writeFileSync(script, 'console.log("2.1.310 (Claude Code)")');
  const cli = resolvePlannerCli({ override: script, env: {} });
  assert.equal(cli.file, process.execPath); assert.deepEqual(cli.prefix, [script]);
  const env = buildPlannerEnvironment({ source: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot }, baseUrl: 'http://127.0.0.1:45678' });
  assert.equal(await probePlannerCli(cli, env), '2.1.310');
  for (const [value, code] of [['2.1.309', 'unsupported'], ['2.1.310-beta', 'invalid'], ['private arbitrary output', 'invalid']]) {
    fs.writeFileSync(script, `console.log(${JSON.stringify(value)})`);
    await assert.rejects(probePlannerCli(cli, env), new RegExp('planner_cli_version_' + code));
  }
  fs.writeFileSync(script, 'setInterval(()=>{},1000)');
  await assert.rejects(probePlannerCli(cli, env, { timeoutMs: 50 }), /planner_cli_probe_timeout/);
  fs.writeFileSync(script, 'console.log("x".repeat(9000))');
  await assert.rejects(probePlannerCli(cli, env), /planner_cli_version_invalid/);
  assert.throws(() => resolvePlannerCli({ override: path.join(root, 'fake.cmd'), env: {} }), /planner_cli_/);
});


test('starting admission is synchronous across async validation and default four-slot cap', async t => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const f = fixture(t, { resolveRoom: id => pending.then(() => ({ room: f.store.getConversationWithoutMessages(id), cwd: f.root, branch: null, projectId: 'project-test' })) });
  const starts = [f.attach()];
  await assert.rejects(f.attach(), /planner_room_busy/);
  for (let i=0; i<3; i++) {
    const room = f.store.createConversation({ title: 'parallel', projectScopeId: 'project-test', participants: [{ agentId: 'synthetic' }] });
    starts.push(f.attach(room.id));
  }
  const extra = f.store.createConversation({ title: 'cap', projectScopeId: 'project-test', participants: [{ agentId: 'synthetic' }] });
  await assert.rejects(f.attach(extra.id), /planner_process_limit/);
  resolve(); await Promise.all(starts); assert.equal(f.children.length, 4);
});

test('B2 mode tracker parses multi-parameter, every sequence split, reset and only a closed allowlist', () => {
  const { createTerminalModeTracker } = require('../../build/server/domain/runtime/embedded-planner-modes');
  const all = [1,25,47,1047,1049,1000,1002,1003,1006,1015,1004,2004,2031,9001];
  const wire = '\x1b[?' + all.join(';') + 'h';
  for (let split = 0; split <= wire.length; split++) {
    const modes = createTerminalModeTracker(); modes.feed(wire.slice(0, split)); modes.feed(wire.slice(split));
    const restored = modes.restore(); assert.ok(restored.startsWith('\x1b[?1049h'));
    assert.deepEqual([...restored.matchAll(/\x1b\[\?(\d+)h/g)].map(m => +m[1]).sort((a,b) => a-b), [...all].sort((a,b) => a-b));
    modes.feed('\x1b[?25;2004l\x1b[?9999;2;3;52h');
    assert.match(modes.restore(), /\x1b\[\?2004l/); assert.doesNotMatch(modes.restore(), /9999|\?2h|\?3h|\?52h/);
    for (const reset of ['\x1bc', '\x1b[!p', '\x9b!p']) {
      modes.feed(wire); modes.feed(reset); assert.equal(modes.restore(), '');
    }
  }
});

test('B2 mode tracker ignores strings, malformed/oversized CSI and cancelled sequences without retaining screen content', () => {
  const { createTerminalModeTracker } = require('../../build/server/domain/runtime/embedded-planner-modes');
  const modes = createTerminalModeTracker();
  const sequences = ['\x1b]title\x1b[?2004h\x07', '\x1bPprivate\x1b[?1049h\x1b\\', '\x1b[?20😀04h', '\x1b[?2004:1h',
    '\x1b[?2004$h', '\x1b[?2004\x18h', '\x1b[?' + '1;'.repeat(100000) + '2004h'];
  for (const wire of sequences) { for (let i = 0; i < wire.length; i += 8192) modes.feed(wire.slice(i, i + 8192)); assert.equal(modes.restore(), ''); }
  modes.feed('screen secret sentinel'.repeat(10000) + '\x1b[?2004h\x1b[?2004l');
  assert.equal(modes.restore(), '\x1b[?2004l');
  modes.feed('\x1b'); modes.feed('c'); assert.equal(modes.restore(), '');
  modes.feed('\x1b[?1049h'); modes.feed('\x1b['); modes.feed('!'); modes.feed('p'); assert.equal(modes.restore(), '');
});

test('metadata claim preserves unrelated concurrent Goal state and a room changed after detach cannot attach', async t => {
  const f = fixture(t); f.store.updateConversationWithoutMessages(f.room.id, { metadata: { synthetic: { keep: true } } });
  const first = await f.attach();
  assert.deepEqual(f.store.getConversationWithoutMessages(f.room.id).metadata.synthetic, { keep: true });
  first.detach();
  // Rebinding/project mismatch must not silently reuse a live process's cwd.
  f.store.db.prepare('UPDATE chat_conversations SET project_scope_id=? WHERE id=?').run('foreign', f.room.id);
  await assert.rejects(f.attach(), /planner_workspace_invalid/);
  assert.equal(f.children.length, 1); assert.equal(f.host.state(f.room.id), 'interactive-retained');
});
