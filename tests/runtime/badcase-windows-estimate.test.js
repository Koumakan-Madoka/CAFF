const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
const { encodeWindowsHelperRequest: encode, parseWindowsHelperResponse: parse } = require('../../build/server/domain/runtime/badcase-capture/windows-helper');
const native = { skip: process.platform !== 'win32' ? 'real Windows NTFS required' : false };
const identity = { volumeSerial: '1', fileId: 'a'.repeat(32), creationTime: '2' };
const request = { version: 1, op: 'estimate', root: 'C:/worktree', expected: identity, excluded: [] };

test('Windows estimate wire is metadata-only and requires a pin; never accepts paths or body', () => {
  assert.deepEqual(JSON.parse(encode(request)), request);
  for (const bad of [{ ...request, paths: [] }, { ...request, expected: null }, { ...request, excluded: ['**'] }]) {
    assert.equal(encode(bad), null);
  }
  const header = { version: 1, ok: true, identity, entries: [{ path: 'a', type: 'file', size: '9007199254740993',
    identity, lastWriteTime: '0', changeTime: '0' }], files: [] };
  const bytes = Buffer.from(JSON.stringify(header) + '\n');
  assert.equal(parse(bytes, request).ok, true);
  assert.equal(parse(Buffer.concat([bytes, Buffer.from('PRIVATE_SENTINEL')]), request).ok, false);
  assert.equal(parse(Buffer.from(JSON.stringify({ ...header, files: [{ path: 'a' }] }) + '\n'), request).ok, false);
});

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-winestimate-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'worktree'), captureRoot = path.join(base, 'storage');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'one'), Buffer.from([0, 255, 10]));
  fs.writeFileSync(path.join(root, 'empty'), '');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', '中文😀'), 'hello');
  const service = createBadcaseCaptureService({ captureRoot });
  service.savePolicy('p', { status: 'disabled', authorizedDirs: [root], authorizedInputDirs: [], excludedPatterns: [] });
  return { base, root, captureRoot, service };
}

test('Windows native sync/async capacity preview uses persistent pin, zero checkpoints, counts exact bytes', native, async t => {
  const { root, captureRoot, service } = setup(t);
  assert.equal((await service.estimateDirectoryAsync('p', root)).ok, false);
  service.authorizeProject('p');
  const restarted = createBadcaseCaptureService({ captureRoot });
  const before = restarted.loadPolicy('p');
  for (const result of [restarted.estimateDirectory('p', root), await restarted.estimateDirectoryAsync('p', root)]) {
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.fileCount, 3); assert.equal(result.totalBytes, 8);
    assert.equal(result.includesIgnored, true); assert.equal(result.complete, true);
    assert.equal(result.captureAvailable, false);
    assert.ok(result.limitations.includes('no_atomic_snapshot'));
    assert.equal(result.exclusionPolicy, 'windows-metadata-v1');
    t.diagnostic(JSON.stringify({ fileCount: result.fileCount, bytes: result.totalBytes, durationMs: result.durationMs,
      scope: 'self-created Windows NTFS metadata only; no session/image/blob cost' }));
  }
  assert.deepEqual(restarted.loadPolicy('p'), before);
  assert.equal(restarted.store.listCheckpoints('p').length, 0);
  assert.equal(restarted.computeUsage('p').bytesByKind.blobs, 0);
  const other = path.join(root, 'nested');
  assert.equal((await restarted.estimateDirectoryAsync('p', other)).ok, false, 'subtree has no independent root pin');
  const renamed = path.join(path.dirname(root), 'old'); fs.renameSync(root, renamed); fs.mkdirSync(root);
  assert.equal((await restarted.estimateDirectoryAsync('p', root)).ok, false, 'same path must not re-pin replacement');
});

test('Windows preview prunes known private/credential names at every depth and user exclusions before junction open', native, async t => {
  const { base, root, service } = setup(t);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret'), 'PRIVATE_SENTINEL');
  const names = ['.PI', '.Pi-Sandbox', '.SSH', '.aws', '.azure', '.gnupg', '.git', '.env', '.ENV.local', 'auth.json', 'credentials.json'];
  const aliases = [];
  for (const parent of [root, path.join(root, 'nested')]) for (const name of names) {
    const alias = path.join(parent, name); fs.symlinkSync(outside, alias, 'junction'); aliases.push(alias);
  }
  const alias = path.join(root, 'EXCLUDED'); fs.symlinkSync(outside, alias, 'junction'); aliases.push(alias);
  t.after(() => { for (const name of aliases) if (fs.existsSync(name)) fs.rmdirSync(name); });
  service.savePolicy('p', { ...service.loadPolicy('p'), excludedPatterns: ['excluded/**'], includedIgnoredPatterns: ['.pi/**'] });
  service.authorizeProject('p');
  const result = await service.estimateDirectoryAsync('p', root);
  assert.equal(result.ok, true, result.reason); assert.equal(result.totalBytes, 8); assert.equal(result.fileCount, 3);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|outside/);
  const unsafe = path.join(root, 'not-excluded'); fs.symlinkSync(outside, unsafe, 'junction');
  try { assert.equal((await service.estimateDirectoryAsync('p', root)).ok, false); }
  finally { fs.rmdirSync(unsafe); }
});

test('Windows preview refuses private roots, policy wildcards, unpinned input and missing installed helper', native, async t => {
  const { base, root, captureRoot, service } = setup(t);
  service.authorizeProject('p');
  service.savePolicy('p', { ...service.loadPolicy('p'), excludedPatterns: ['**/private'] });
  assert.equal((await service.estimateDirectoryAsync('p', root)).reason, 'windows_estimate_policy_invalid');
  const sensitive = path.join(base, '.ssh'); fs.mkdirSync(sensitive);
  service.savePolicy('p', { ...service.loadPolicy('p'), authorizedDirs: [sensitive], excludedPatterns: [] });
  service.authorizeProject('p');
  assert.equal((await service.estimateDirectoryAsync('p', sensitive)).ok, false);
  service.savePolicy('p', { ...service.loadPolicy('p'), authorizedDirs: [root] });
  assert.equal((await service.estimateDirectoryAsync('p', root)).ok, false, 'ordinary save does not create pin');
  service.authorizeProject('p');
  const helperDir = path.join(captureRoot, 'windows-authorization-helper');
  const helper = fs.readdirSync(helperDir).find(n => n.endsWith('.py')); fs.unlinkSync(path.join(helperDir, helper));
  assert.equal((await service.estimateDirectoryAsync('p', root)).ok, false, 'estimate must not silently install/re-authorize');
});

test('Windows preview excludes a private-directory alias into the worktree, and refuses a private ancestor', native, async t => {
  const { base, root, service } = setup(t);
  const alias = path.join(base, 'custom-private-alias');
  fs.symlinkSync(path.join(root, 'nested'), alias, 'junction');
  const previous = process.env.PI_AGENT_PRIVATE_DIR;
  try {
    process.env.PI_AGENT_PRIVATE_DIR = alias;
    service.authorizeProject('p');
    const result = await service.estimateDirectoryAsync('p', root);
    assert.equal(result.ok, true, result.reason); assert.equal(result.totalBytes, 3); assert.equal(result.fileCount, 2);
    process.env.PI_AGENT_PRIVATE_DIR = base;
    assert.equal((await service.estimateDirectoryAsync('p', root)).reason, 'estimate_scope_rejected');
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_PRIVATE_DIR; else process.env.PI_AGENT_PRIVATE_DIR = previous;
    fs.rmdirSync(alias);
  }
});

function isolated(moduleName, { child, helper, disk, clock, timers, replace = s => s, env = {} } = {}) {
  const file = path.join(__dirname, `../../build/server/domain/runtime/badcase-capture/${moduleName}.js`);
  const local = require('node:module').createRequire(file), exports = {};
  require('node:vm').runInNewContext(replace(fs.readFileSync(file, 'utf8')), {
    exports, module: { exports }, Buffer, setTimeout: timers?.setTimeout || setTimeout, clearTimeout: timers?.clearTimeout || clearTimeout,
    process: { platform: 'win32', env },
    require: name => name === 'node:child_process' && child ? child
      : name === './windows-helper' && helper ? helper : name === 'node:fs' && disk ? disk
        : name === 'node:perf_hooks' && clock ? { performance: clock } : local(name),
  }, { filename: file });
  return exports;
}

test('Windows estimate compiles persisted exclusions and private boundaries before transport; exact sum refuses overflow', async () => {
  let calls = 0, last;
  const sourceHelper = require('../../build/server/domain/runtime/badcase-capture/windows-helper');
  const helper = { ...sourceHelper, invokeWindowsHelper(python, file, req) {
    calls++; last = req;
    assert.equal(python, 'python');
    return { ok: true, entries: [{ type: 'file', size: '9007199254740993' }] };
  } };
  helper.invokeWindowsEstimateHelper = helper.invokeWindowsHelper;
  const api = isolated('windows-estimate', { helper, disk: { realpathSync: { native: p => p } },
    env: { PI_AGENT_PRIVATE_DIR: 'C:/worktree/custom-private' } });
  const policy = { authorizedDirs: ['C:/worktree'], authorizedDirPins: {
    ['c:\\worktree']: { realpath: 'C:/worktree', identity } }, excludedPatterns: ['build/**'] };
  const options = { policy, targetDir: 'C:/worktree', captureRoot: 'C:/worktree/storage' };
  assert.equal((await api.estimateWindowsDirectoryAsync(options)).reason, 'estimate_size_overflow');
  assert.deepEqual(Array.from(last.excluded), ['build', 'storage', 'custom-private']);
  for (const bad of [
    { ...options, targetDir: 'C:/worktree/nested' },
    { ...options, targetDir: 'C:/other' },
    { ...options, policy: { ...policy, authorizedDirPins: {} } },
    { ...options, policy: { ...policy, excludedPatterns: ['**/private'] } },
    { ...options, policy: { ...policy, excludedPatterns: ['../escape'] } },
    { ...options, captureRoot: 'C:/' },
    { ...options, captureRoot: 'C:/worktree' },
    { ...options, captureRoot: 'relative' },
  ]) assert.equal((await api.estimateWindowsDirectoryAsync(bad)).ok, false);
  assert.equal(calls, 1, 'count outside production catch, invalid plans never invoke helper');
  const aliasApi = isolated('windows-estimate', { helper, disk: { realpathSync: { native: () => 'C:/other' } } });
  assert.equal((await aliasApi.estimateWindowsDirectoryAsync(options)).reason, 'estimate_scope_rejected');
  assert.equal(calls, 1, 'canonical-name mismatch never reaches target helper');
  const observedPaths = [];
  const remoteApi = isolated('windows-estimate', { helper, env: { PI_AGENT_PRIVATE_DIR: '\\\\host\\share' },
    disk: { realpathSync: { native: p => { observedPaths.push(p); return p; } } } });
  assert.equal((await remoteApi.estimateWindowsDirectoryAsync(options)).reason, 'windows_estimate_policy_invalid');
  assert.equal(observedPaths.some(p => p.startsWith('\\\\')), false, 'never resolve a protected UNC path');
  assert.equal(calls, 1);
});

function syntheticChild(behavior) {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = 0;
  child.kill = signal => { assert.equal(signal, 'SIGKILL'); child.kills++; queueMicrotask(() => child.emit('close', null)); return true; };
  child.stdin.on('finish', () => behavior(child));
  return child;
}
const emptyWire = Buffer.from(JSON.stringify({ version: 1, ok: true, identity, entries: [], files: [] }) + '\n');

test('Windows async estimate transport rejects stderr/nonzero/oversize, caps concurrency, releases on close', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-winasync-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = require('../../build/server/domain/runtime/badcase-capture/windows-helper-source').WINDOWS_HELPER_SOURCE;
  const file = path.join(base, 'helper.py'); fs.writeFileSync(file, source);
  const children = [];
  let behavior = c => { c.stdout.emit('data', emptyWire); queueMicrotask(() => c.emit('close', 0)); };
  const api = isolated('windows-helper', { child: { spawn(python, args, options) {
    assert.equal(python, 'python'); assert.deepEqual(Array.from(args), ['-I', '-B', file]);
    assert.deepEqual(Array.from(options.stdio), ['pipe', 'pipe', 'pipe']);
    const c = syntheticChild(behavior); children.push(c); return c;
  } }, replace: s => s.replace('headerBytes: 32 * 1024 * 1024', 'headerBytes: 512') });
  const run = () => api.invokeWindowsEstimateHelper('python', file, request);
  assert.equal((await run()).ok, true);
  for (const [act, reason] of [
    [c => { c.stderr.emit('data', Buffer.from('PRIVATE_SENTINEL')); c.stdout.emit('data', emptyWire); c.emit('close', 0); }, 'helper_process_failed'],
    [c => { c.stdout.emit('data', Buffer.alloc(514)); }, 'estimate_output_limit'],
    [c => { c.stdout.emit('data', emptyWire); c.emit('close', 1); }, 'helper_process_failed'],
    [c => { c.emit('error', Error('PRIVATE_SENTINEL')); }, 'helper_process_failed'],
  ]) {
    behavior = act;
    const result = await run(); assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
  }
  behavior = () => {};
  const a = run(), b = run();
  assert.equal((await run()).reason, 'estimate_busy');
  const active = children.slice(-2);
  for (const c of active) { c.stdout.emit('data', emptyWire); c.emit('close', 0); }
  assert.equal((await a).ok, true); assert.equal((await b).ok, true);
  behavior = c => { c.stdout.emit('data', emptyWire); c.emit('close', 0); };
  assert.equal((await run()).ok, true, 'active capacity restored');
});

test('Windows async preview rejects late success even before timer callback, clears owned timer and latches timeout', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-win-deadline-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, 'helper.py');
  fs.writeFileSync(file, require('../../build/server/domain/runtime/badcase-capture/windows-helper-source').WINDOWS_HELPER_SOURCE);
  for (const mode of ['timely', 'late', 'timer']) {
    let time = 0, callback, clears = 0, child;
    const api = isolated('windows-helper', { clock: { now: () => time },
      timers: { setTimeout(fn, ms) { assert.equal(ms, 25000); callback = fn; return 'owned'; },
        clearTimeout(handle) { assert.equal(handle, 'owned'); clears++; } },
      child: { spawn() { child = syntheticChild(c => {
        if (mode === 'timer') callback();
        time = mode === 'late' ? 25000 : 1;
        c.stdout.emit('data', emptyWire); c.emit('close', 0);
      }); return child; } } });
    const result = await api.invokeWindowsEstimateHelper('python', file, request);
    assert.equal(result.ok, mode === 'timely');
    if (mode !== 'timely') assert.equal(result.reason, 'estimate_timeout');
    assert.ok(clears >= 1, 'timer cleared outside any production catch');
    assert.equal(child.kills, mode === 'timer' ? 1 : 0);
  }
});

test('Windows real HTTP stays responsive during a test-only sleeper; timeout kills direct child and waits for close', native, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-win-kill-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, 'helper.py');
  fs.writeFileSync(file, require('../../build/server/domain/runtime/badcase-capture/windows-helper-source').WINDOWS_HELPER_SOURCE);
  let child, closed = false, finished = false, started;
  const ready = new Promise(resolve => { started = resolve; });
  const server = require('node:http').createServer((_req, res) => res.end('healthy'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = isolated('windows-helper', { replace: s => s.replace('estimateTimeoutMs: 25000', 'estimateTimeoutMs: 1500'),
    child: { spawn() {
      child = require('node:child_process').spawn(process.execPath,
        ['-e', 'process.stdout.write("partial");setInterval(()=>{},1000)'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.once('close', () => { closed = true; });
      child.stdout.once('data', started);
      return child;
    } } });
  const running = api.invokeWindowsEstimateHelper('python', file, request).then(result => { finished = true; return result; });
  await ready;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(await response.text(), 'healthy'); assert.equal(finished, false);
  const result = await running;
  assert.equal(result.reason, 'estimate_timeout');
  assert.equal(closed, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'real direct child is terminated, not just abandoned');
  assert.doesNotMatch(JSON.stringify(result), /partial/);
});
