// Independently authorized fixed Git input reads, not external Git classification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const transport = require(base + 'windows-helper');
const identity = { volumeSerial: '1', fileId: 'a'.repeat(32), creationTime: '2' };
const request = { version: 1, op: 'gitInput', root: 'C:/repo/.git', expected: identity, path: 'index' };
const bytes = Buffer.from([0x44, 0x49, 0x52, 0x43, 0xff, 0, 13, 10]);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const header = { version: 1, ok: true, identity, file: { path: 'index', identity, size: String(bytes.length), sha256: sha(bytes) } };
const wire = (h = header, b = bytes) => Buffer.concat([Buffer.from(JSON.stringify(h) + '\n'), b]);
function load(name, mocks = {}, extra = {}) {
  const filename = require.resolve(base + name), exports = {};
  require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, Buffer, structuredClone,
    process: { platform: 'win32', env: {} }, setTimeout, clearTimeout,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : require(require.resolve(id, { paths: [path.dirname(filename)] })), ...extra }, { filename });
  return exports;
}
function options() { return { metadataRoot: 'C:/repo/.git', metadataPath: 'index', captureRoot: 'C:/capture',
  policy: { authorizedInputDirs: ['C:/repo/.git'], authorizedInputPins: {
    'c:\\repo\\.git': { realpath: 'C:/repo/.git', identity: { ...identity } } } } }; }
function adapter({ helper = async () => ({ ok: true, file: { content: bytes } }), realpath = p => path.win32.resolve(p), clock, extra } = {}) {
  let calls = 0, paths = 0;
  const api = load('windows-git-input', { 'node:fs': { realpathSync: { native: p => { paths++; return realpath(p); } } },
    './windows-helper': { ...transport, invokeWindowsGitInputHelper: async (...args) => { calls++; return helper(...args); } },
    ...(clock ? { 'node:perf_hooks': { performance: clock } } : {}) }, extra);
  return { api, calls: () => calls, paths: () => paths };
}

test('Git input schema permits only fixed classification names, never pointer expansion or arbitrary selection', () => {
  for (const name of ['config', 'index', 'commondir', 'gitdir', 'config.worktree', 'info/exclude']) {
    assert.ok(transport.encodeWindowsHelperRequest({ ...request, path: name }), name);
  }
  for (const delta of [{ path: '../config' }, { path: 'objects/a' }, { path: 'hooks/pre-commit' }, { path: 'HEAD' },
    { path: 'INDEX' }, { path: 'worktrees/other/index' }, { path: '.git/config' }, { path: 'turn.jsonl' },
    { paths: ['index'] }, { excluded: [] }, { expected: null }, { root: '\\\\host\\share' }, { _canonical: false }]) {
    assert.equal(transport.encodeWindowsHelperRequest({ ...request, ...delta }), null, JSON.stringify(delta));
  }
  assert.equal(transport.encodeWindowsHelperRequest({ ...request, op: 'sessionInput' }), null);
});

test('Git input wire revalidates exact body, root/leaf identity and closed fields for binary index', () => {
  const result = transport.parseWindowsHelperResponse(wire(), request);
  assert.equal(result.ok, true); assert.deepEqual(result.file.content, bytes);
  for (const h of [{ ...header, entries: [] }, { ...header, identity: { ...identity, fileId: 'b'.repeat(32) } },
    { ...header, file: { ...header.file, path: 'config' } }, { ...header, file: { ...header.file, size: '67108865' } },
    { ...header, file: { ...header.file, identity: { ...identity, volumeSerial: '2' } } },
    { ...header, file: { ...header.file, sha256: '0'.repeat(64) } }, { ...header, file: { ...header.file, extra: 1 } }]) {
    assert.equal(transport.parseWindowsHelperResponse(wire(h), request).ok, false);
  }
  for (const b of [Buffer.alloc(0), Buffer.concat([bytes, Buffer.from('!')]), Buffer.alloc(bytes.length)]) {
    assert.equal(transport.parseWindowsHelperResponse(wire(header, b), request).ok, false);
  }
});

test('Git input adapter requires exact independent root authorization, literal root and persistent original pin', async () => {
  let observed;
  const a = adapter({ helper: async (...args) => { observed = args; return { ok: true, file: { content: bytes } }; } });
  const opts = options(), original = JSON.stringify(opts), result = await a.api.readWindowsGitMetadataInput(opts);
  assert.equal(result.ok, true); assert.deepEqual(result.content, bytes); assert.equal(a.calls(), 1);
  assert.equal(JSON.stringify(opts), original);
  assert.equal(observed[0], 'python'); assert.deepEqual(JSON.parse(JSON.stringify(observed[2])), { ...request, root: 'C:\\repo\\.git' });
  assert.equal(result.content.buffer.byteLength, bytes.length); assert.notEqual(result.content.buffer, bytes.buffer);
  assert.equal(Object.hasOwn(result, 'sha256'), false); assert.equal(Object.hasOwn(result, 'identity'), false);
  for (const change of [o => { o.policy.authorizedInputDirs = []; }, o => { o.policy.authorizedInputPins = {}; },
    o => { o.policy.authorizedDirs = ['C:/repo/.git']; o.policy.authorizedInputDirs = []; },
    o => { o.policy.authorizedInputDirs = ['C:/repo']; }, o => { o.policy.authorizedInputPins['c:\\repo\\.git'].realpath = 'C:/elsewhere'; },
    o => { delete o.policy.authorizedInputPins['c:\\repo\\.git'].identity; }, o => { o.metadataRoot = 'C:/repo/.git/worktrees/w'; },
    o => { o.metadataPath = 'objects/private'; }, o => { o.metadataRoot = '\\\\host\\share'; },
    o => { o.captureRoot = 'C:/repo'; }, o => { o.privateDirs = ['C:/repo']; }, o => { o.privateDirs = ['']; },
    o => { o.privateDirs = null; }, o => { o.privateDirs = ['\\\\host\\share']; }]) {
    const b = adapter(), input = options(); change(input);
    assert.equal((await b.api.readWindowsGitMetadataInput(input)).ok, false, change.toString()); assert.equal(b.calls(), 0);
  }
});

test('Git input latches the request pin and names across await without mutating caller policy', async () => {
  let release, observed;
  const a = adapter({ helper: async (_p, _h, req) => { observed = req; await new Promise(resolve => { release = resolve; });
    assert.deepEqual(JSON.parse(JSON.stringify(req.expected)), identity);
    assert.equal(req.path, 'index'); assert.equal(req.root, 'C:\\repo\\.git');
    return { ok: true, file: { content: bytes } }; } });
  const opts = options(), task = a.api.readWindowsGitMetadataInput(opts);
  assert.ok(release); assert.notEqual(observed.expected, opts.policy.authorizedInputPins['c:\\repo\\.git'].identity);
  // Do not mutate the shared test identity object.
  opts.policy.authorizedInputPins['c:\\repo\\.git'].identity.fileId = 'b'.repeat(32);
  opts.metadataRoot = 'C:/elsewhere'; opts.metadataPath = 'config'; release();
  assert.equal((await task).ok, true);
});

test('Git metadata aliases and protected storage/private roots fail before content helper', async () => {
  for (const realpath of [p => p === 'C:\\repo\\.git' ? 'C:\\elsewhere' : p,
    p => p === 'C:\\repo\\.git\\index' ? 'C:\\elsewhere\\index' : p,
    p => p === 'C:\\capture' ? 'C:\\repo' : p,
    () => { throw Object.assign(Error('PRIVATE_SENTINEL'), { code: 'EACCES' }); }]) {
    const a = adapter({ realpath }); const r = await a.api.readWindowsGitMetadataInput(options());
    assert.equal(r.ok, false); assert.equal(a.calls(), 0); assert.doesNotMatch(JSON.stringify(r), /PRIVATE_SENTINEL/);
  }
  for (const name of ['PI_AGENT_SANDBOX_DIR', 'PI_AGENT_PRIVATE_DIR']) {
    const a = adapter({ extra: { process: { platform: 'win32', env: { [name]: 'C:/repo' } } } });
    assert.equal((await a.api.readWindowsGitMetadataInput(options())).ok, false); assert.equal(a.calls(), 0);
  }
});

test('Git metadata accepts raw non-UTF8 but excludes secrets without hashes/identity or backing leakage', async () => {
  const secret = Buffer.from('sk-' + 'x'.repeat(40));
  const backing = Buffer.concat([bytes, secret]), safe = backing.subarray(0, bytes.length);
  const a = adapter({ helper: async () => ({ ok: true, file: { content: safe } }) });
  const result = await a.api.readWindowsGitMetadataInput(options()); assert.equal(result.ok, true);
  assert.equal(Buffer.from(result.content.buffer).includes(secret), false);
  for (const response of [{ ok: true, file: { content: secret } }, { ok: false, reason: 'PRIVATE_SENTINEL' }, { ok: true, file: {} }]) {
    const b = adapter({ helper: async () => response }); const r = await b.api.readWindowsGitMetadataInput(options());
    assert.equal(r.ok, false); assert.deepEqual(Object.keys(r).sort(), ['ok', 'reason']); assert.doesNotMatch(JSON.stringify(r), /PRIVATE_SENTINEL/);
    assert.equal(b.calls(), 1, 'no retries');
  }
});

test('Git metadata shares earlier observed deadline, drops late data before consumption, never extends cap', async () => {
  for (const phase of ['scope', 'helper', 'copy']) {
    let now = 100, checks = 0, reads = 0;
    const a = adapter({ clock: { now: () => phase === 'copy' && ++checks === 4 ? 150 : now },
      realpath: p => { if (phase === 'scope') now = 150; return p; },
      helper: async (_p, _h, _r, deadline) => { assert.equal(deadline, 150); if (phase === 'helper') now = 150;
        return { ok: true, file: { get content() { reads++; return bytes; } } }; } });
    assert.equal((await a.api.readWindowsGitMetadataInput({ ...options(), deadline: 150 })).reason, 'git_input_timeout');
    assert.equal(a.calls(), phase === 'scope' ? 0 : 1); if (phase === 'helper') assert.equal(reads, 0);
  }
  const a = adapter({ clock: { now: () => 100 } });
  for (const deadline of [100, -1, NaN, Infinity, '150']) assert.equal((await a.api.readWindowsGitMetadataInput({ ...options(), deadline })).ok, false);
  assert.equal(a.calls(), 0); assert.equal(a.paths(), 0);
  const capped = adapter({ clock: { now: () => 100 }, helper: async (_p, _h, _r, deadline) => {
    assert.equal(deadline, 25100); return { ok: true, file: { content: bytes } }; } });
  assert.equal((await capped.api.readWindowsGitMetadataInput({ ...options(), deadline: 100000 })).ok, true);
  const linux = adapter({ extra: { process: { platform: 'linux', env: {} } } });
  assert.equal((await linux.api.readWindowsGitMetadataInput(options())).reason, 'windows_required'); assert.equal(linux.paths(), 0);
});

test('Git input transport has distinct op admission, shares session/Git permits until close, verifies source before spawn', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-git-input-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const helperPath = path.join(dir, 'helper.py'); fs.writeFileSync(helperPath, require(base + 'windows-helper-source').WINDOWS_HELPER_SOURCE);
  const children = [], EventEmitter = require('node:events'); let now = 0, timer, autoClose = true;
  const api = load('windows-helper', { 'node:perf_hooks': { performance: { now: () => now } },
    'node:child_process': { spawn() { const c = new EventEmitter(); c.stdin = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin.end = () => { if (autoClose) c.emit('close', 1); }; c.kill = () => { c.kills = (c.kills || 0) + 1; return true; }; children.push(c); return c; } } },
    { setTimeout: f => { timer = f; return 1; }, clearTimeout() {} });
  for (const op of ['sessionInput', 'gitMetadata', 'selectedSnapshot', 'capture', 'identity', 'estimate', 'snapshot']) {
    assert.equal((await api.invokeWindowsGitInputHelper('python', helperPath, { ...request, op, path: op === 'sessionInput' ? 'turn.jsonl' : request.path }, 25000)).reason, 'request_invalid');
  }
  assert.equal((await api.invokeWindowsGitHelper('python', helperPath, request, 25000)).reason, 'request_invalid');
  assert.equal((await api.invokeWindowsSessionHelper('python', helperPath, request, 25000)).reason, 'request_invalid');
  assert.equal(children.length, 0); autoClose = false;
  const one = api.invokeWindowsGitInputHelper('python', helperPath, request, 25000);
  const two = api.invokeWindowsSessionHelper('python', helperPath, { ...request, op: 'sessionInput', path: 'turn.jsonl' }, 25000);
  assert.equal((await api.invokeWindowsGitInputHelper('python', helperPath, request, 25000)).reason, 'git_capture_busy');
  timer(); assert.equal(children[1].kills, 1);
  assert.equal((await api.invokeWindowsGitInputHelper('python', helperPath, request, 25000)).reason, 'git_capture_busy');
  children[0].stdout.emit('data', wire()); children[0].emit('close', 0); assert.equal((await one).ok, true);
  children[1].emit('close', 0); assert.equal((await two).reason, 'git_capture_timeout');
  autoClose = true; fs.writeFileSync(helperPath, 'TAMPER');
  assert.equal((await api.invokeWindowsGitInputHelper('python', helperPath, request, 25000)).reason, 'helper_integrity_failed'); assert.equal(children.length, 2);
  now = 25000; assert.equal((await api.invokeWindowsGitInputHelper('python', helperPath, request, 25000)).reason, 'git_capture_timeout');
});

test('native independently authorized external Git roots read only fixed bytes, reject old pin/junction and never publish', { skip: process.platform !== 'win32' }, async t => {
  const { createBadcaseCaptureService } = require(base + 'index');
  const { readWindowsGitMetadataInput } = require(base + 'windows-git-input');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-external-git-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const root = path.join(dir, 'repo', '.git'), captureRoot = path.join(dir, 'capture'); fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'info')); fs.writeFileSync(path.join(root, 'info', 'exclude'), '*.tmp\r\n'); fs.writeFileSync(path.join(root, 'index'), bytes);
  const svc = createBadcaseCaptureService({ captureRoot }); svc.savePolicy('p', { authorizedDirs: [], authorizedInputDirs: [root] });
  const policy = svc.authorizeProject('p'), opts = { policy, captureRoot, metadataRoot: root, metadataPath: 'index' };
  assert.equal(policy.status, 'disabled');
  const result = await readWindowsGitMetadataInput(opts); assert.equal(result.ok, true, result.reason); assert.deepEqual(result.content, bytes);
  assert.deepEqual((await readWindowsGitMetadataInput({ ...opts, metadataPath: 'info/exclude' })).content, Buffer.from('*.tmp\r\n'));
  fs.writeFileSync(path.join(root, 'index'), 'sk-' + 'x'.repeat(40)); assert.equal((await readWindowsGitMetadataInput(opts)).reason, 'git_input_contains_secret');
  fs.renameSync(root, root + '-old'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'index'), bytes);
  assert.equal((await readWindowsGitMetadataInput(opts)).ok, false, 'original pin rejects replacement'); fs.rmSync(root, { recursive: true });
  require('node:child_process').execFileSync('cmd', ['/d', '/c', 'mklink', '/J', root, root + '-old']);
  try { assert.equal((await readWindowsGitMetadataInput(opts)).ok, false); } finally { fs.rmdirSync(root); }
  assert.equal(svc.store.computeUsage('p').bytesByKind.blobs, 0); assert.equal(svc.store.listCheckpoints('p').length, 0); assert.equal(svc.loadPolicy('p').status, 'disabled');
});
