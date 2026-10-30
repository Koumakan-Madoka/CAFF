const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { once } = require('node:events');
const { launchPlannerPty } = require('../../build/server/domain/runtime/embedded-planner-pty');
const { buildPlannerEnvironment } = require('../../build/server/domain/runtime/embedded-planner-env');
const { fork, execFileSync } = require('node:child_process');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Exercise the actual compiled guardian without spawning or changing packages.
function workerFixture(platform = 'win32', missing = '') {
  const proc = new EventEmitter(), messages = [], spawns = [], checks = [];
  Object.assign(proc, { platform, arch: 'arm64', env: {}, connected: true,
    send: (message, done) => { messages.push(message); done?.(); }, disconnect: () => { proc.connected = false; } });
  const terminal = { onData() {}, onExit() {} }, module = { exports: {} };
  const nativeDir = path.join(os.tmpdir(), 'synthetic-node-pty', 'prebuilds', platform + '-arm64');
  const mocks = {
    'node-pty': { spawn: (...args) => { spawns.push(args); return terminal; } },
    'node-pty/lib/utils': { loadNativeModule: () => ({ module: {}, dir: nativeDir }) },
    'node:fs': { constants: fs.constants, statSync: file => { checks.push(file); if (path.basename(file) === missing) throw new Error('synthetic missing'); return { isFile: () => missing !== 'directory' }; }, accessSync() {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../build/server/domain/runtime/embedded-planner-pty-worker.js'), 'utf8'), {
    require: Object.assign(name => mocks[name] || require(name), { resolve: require.resolve }), exports: module.exports, module, process: proc, Buffer, setTimeout, clearTimeout,
  });
  module.exports.runPlannerPtyWorker();
  proc.emit('message', { type: 'start', config: { cli: { file: 'synthetic', prefix: [] }, args: [], cwd: os.tmpdir(), env: {}, cols: 59, rows: 24 } });
  return { messages, spawns, checks, nativeDir };
}

test('Windows guardian always uses bundled ConPTY and checks files next to the loaded native module (including arm64)', () => {
  const f = workerFixture();
  assert.equal(f.spawns.length, 1); assert.equal(f.spawns[0][2].useConpty, true); assert.equal(f.spawns[0][2].useConptyDll, true);
  for (const name of ['conpty.dll', 'OpenConsole.exe']) assert.ok(f.checks.includes(path.join(f.nativeDir, 'conpty', name)));
});
for (const missing of ['conpty.dll', 'OpenConsole.exe', 'directory']) {
  test(`missing bundled ConPTY file (${missing}) fails closed without spawn or system fallback`, () => {
    const f = workerFixture('win32', missing);
    assert.equal(f.spawns.length, 0);
    assert.equal(f.messages[0]?.type, 'spawn_failed'); assert.equal(f.messages[0]?.code, 'planner_conpty_unavailable');
  });
}
test('POSIX guardian does not load or require Windows ConPTY files/options', () => {
  const f = workerFixture('linux', 'conpty.dll');
  assert.equal(f.spawns.length, 1); assert.equal(f.checks.length, 0);
  assert.equal(f.spawns[0][2].useConptyDll, undefined);
});

function openConsoles() {
  if (process.platform !== 'win32') return [];
  const packageRoot = fs.realpathSync(path.dirname(require.resolve('node-pty/package.json'))).toLowerCase() + path.sep;
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const started = performance.now();
  let output;
  try {
    output = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', '@(Get-Process -Name OpenConsole -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ ProcessId = $_.Id; ExecutablePath = $_.Path } }) | ConvertTo-Json -Compress'],
      { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { SystemRoot: process.env.SystemRoot,
        PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } }).trim();
  } finally { console.info(`OpenConsole query: ${Math.round(performance.now() - started)} ms`); }
  const rows = output ? JSON.parse(output) : [];
  return (Array.isArray(rows) ? rows : [rows]).filter(p => p.ExecutablePath?.toLowerCase().startsWith(packageRoot)).map(p => p.ProcessId);
}
test('OpenConsole query avoids WMI, bounds module discovery, allows 60s and always logs timing', () => {
  const source = openConsoles.toString();
  for (const fails of [false, true]) {
    const calls = [], logs = [], synthetic = { platform: 'win32', env: { SystemRoot: 'C:\\Windows', PSModulePath: 'untrusted-module-path' } };
    const invoke = vm.runInNewContext(source + ';openConsoles', {
      fs, path, require, process: synthetic, console: { info: text => logs.push(text) }, performance,
      execFileSync: (...args) => { calls.push(args); if (fails) throw new Error('synthetic timeout'); return '[]'; },
    });
    if (fails) assert.throws(invoke, /synthetic timeout/); else assert.equal(invoke().length, 0);
    const [, args, options] = calls[0];
    assert.ok(args.at(-1).includes('Get-Process -Name OpenConsole')); assert.ok(!args.at(-1).includes('Get-CimInstance'));
    assert.equal(options.timeout, 60000);
    assert.deepEqual({ ...options.env }, { SystemRoot: 'C:\\Windows', PSModulePath: path.join('C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules') });
    assert.ok(logs.some(text => /OpenConsole query.*ms/.test(text)));
  }
});
function consoleGuard() {
  const before = new Set(openConsoles());
  return {
    assertStarted() { if (process.platform === 'win32') assert.ok(openConsoles().some(pid => !before.has(pid)), 'bundled OpenConsole must actually run'); },
    async assertStopped() { await waitFor(() => openConsoles().every(pid => before.has(pid))); },
  };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitFor(check, deadlineMs = 10000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > deadlineMs) throw new Error('Synthetic process cleanup timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-pty-tree-'));
  const script = path.join(root, 'fake tree 中文.cjs');
  fs.writeFileSync(script, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));
console.log('FAKE_TREE_READY'); process.stdin.resume(); setInterval(()=>{},1000);`);
  const config = { cli: { file: process.execPath, prefix: [script] }, args: [], cwd: root, cols: 120, rows: 30,
    env: buildPlannerEnvironment({ source: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot }, baseUrl: 'http://127.0.0.1:45678', interactive: true }) };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, config };
}

test('native PTY adapter preserves the fixed ConPTY failure after confirmed guardian exit', async () => {
  const worker = new EventEmitter(); worker.connected = true;
  let guardianOptions;
  worker.send = message => {
    if (message.type === 'start') queueMicrotask(() => { worker.emit('message', { type: 'spawn_failed', code: 'planner_conpty_unavailable' }); worker.emit('exit', 0); });
    return true;
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../build/server/domain/runtime/embedded-planner-pty.js'), 'utf8'), {
    require: name => name === 'node:child_process' ? { fork: (_file, _args, options) => { guardianOptions = options; return worker; } } : name === './embedded-planner-env' ? require('../../build/server/domain/runtime/embedded-planner-env') : require(name),
    exports: module.exports, module, __dirname, Buffer, process, queueMicrotask, setTimeout, clearTimeout,
  });
  await assert.rejects(module.exports.launchPlannerPty({ env: {}, cwd: os.tmpdir() }), { code: 'planner_conpty_unavailable' });
  assert.equal(guardianOptions.cwd, process.platform === 'win32' ? path.dirname(process.execPath) : os.tmpdir());
});

test('real node-pty fake CLI cleanup covers descendants on explicit stop', async t => {
  const consoles = consoleGuard(), f = fixture(t), child = await launchPlannerPty(f.config);
  t.after(() => child.stop());
  await waitFor(() => fs.existsSync(path.join(f.root, 'pids.json')));
  const pids = JSON.parse(fs.readFileSync(path.join(f.root, 'pids.json')));
  consoles.assertStarted();
  const end = once(child, 'exit'); child.stop(); await end;
  await waitFor(() => pids.every(pid => !alive(pid)));
  // No retry/delay: a transient OpenConsole must not pin the CLI's worktree.
  fs.rmSync(f.root, { recursive: true, force: true });
  await consoles.assertStopped();
});

for (const cause of ['retention', 'shutdown']) {
  test(`real bundled PTY ${cause} stops fake CLI descendants and OpenConsole`, async t => {
    const consoles = consoleGuard(), f = fixture(t);
    const { createEmbeddedPlannerHost } = require('../../build/server/domain/runtime/embedded-planner-host');
    let lease = false, expiry;
    const host = createEmbeddedPlannerHost({
      repository: { hasLease: () => lease, leaseCount: () => Number(lease), recordGuardian() {}, release: () => { lease = false; }, claim: () => { lease = true; return { first: true, leaseId: 'synthetic', metadata: { sessionId: 'synthetic' } }; } },
      resolveRoom: () => ({ room: { id: 'synthetic', title: 'Synthetic', metadata: {} }, cwd: f.root, branch: null, projectId: 'synthetic' }),
      cli: f.config.cli, env: f.config.env, baseUrl: 'http://127.0.0.1:45678', setTimer: fn => { expiry = fn; return {}; }, clearTimer() {},
    });
    t.after(() => host.close());
    const session = await host.attach('synthetic', { cols: 59, rows: 24 }, () => {});
    await waitFor(() => fs.existsSync(path.join(f.root, 'pids.json')));
    const pids = JSON.parse(fs.readFileSync(path.join(f.root, 'pids.json'))); consoles.assertStarted();
    if (cause === 'retention') { session.detach(); expiry(); } else await host.close();
    await waitFor(() => host.state('synthetic') === 'absent' && pids.every(pid => !alive(pid)));
    fs.rmSync(f.root, { recursive: true, force: true });
    await consoles.assertStopped(); assert.equal(lease, false);
  });
}

test('guardian IPC parent death stops the fake CLI and its descendants', async t => {
  const consoles = consoleGuard(), f = fixture(t);
  const parentScript = path.join(f.root, 'parent.cjs');
  const adapter = path.resolve(__dirname, '../../build/server/domain/runtime/embedded-planner-pty');
  fs.writeFileSync(parentScript, `require(${JSON.stringify(adapter)}).launchPlannerPty(${JSON.stringify(f.config)}).then(child=>process.send({guardianPid:child.guardianPid}));`);
  const parent = fork(parentScript, [], { env: f.config.env, execArgv: [], stdio: ['ignore','ignore','ignore','ipc'] });
  t.after(() => parent.kill());
  const [{ guardianPid }] = await once(parent, 'message'); await waitFor(() => fs.existsSync(path.join(f.root, 'pids.json')));
  const pids = JSON.parse(fs.readFileSync(path.join(f.root, 'pids.json')));
  assert.ok(Number.isSafeInteger(guardianPid) && guardianPid > 0 && !pids.includes(guardianPid));
  consoles.assertStarted();
  const end = once(parent, 'exit'); parent.kill(); await end;
  await waitFor(() => [...pids, guardianPid].every(pid => !alive(pid)));
  await consoles.assertStopped();
});
