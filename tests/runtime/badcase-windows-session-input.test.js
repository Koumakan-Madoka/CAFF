// Session input primitive/adapter tests, not turn capture or resume replay proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const base = '../../build/server/domain/runtime/badcase-capture/';
const transport = require(base + 'windows-helper');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const identity = { volumeSerial: '9007199254740993', fileId: 'a'.repeat(32), creationTime: '1' };
const request = { version: 1, op: 'sessionInput', root: 'C:/sessions', expected: identity, path: 'sub/turn.jsonl' };
const content = Buffer.from('{}\n');
const header = { version: 1, ok: true, identity, file: { path: request.path, size: '3', sha256: sha(content), identity } };
const wire = (h = header, body = content) => Buffer.concat([Buffer.from(JSON.stringify(h) + '\n'), body]);
function load(name, mocks = {}, extra = {}) {
  const filename = require.resolve(base + name), exports = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports, require: id => Object.hasOwn(mocks, id) ? mocks[id] : require(require.resolve(id, { paths: [path.dirname(filename)] })),
    process: { platform: 'win32', env: {} }, Buffer, setTimeout, clearTimeout, ...extra,
  }, { filename });
  return exports;
}
function options() {
  return { captureRoot: 'C:/capture', inputPath: 'C:/sessions/sub/turn.jsonl',
    policy: { authorizedInputDirs: ['C:/sessions'],
      authorizedInputPins: { 'c:\\sessions': { realpath: 'C:/sessions', identity } } } };
}
function adapter(helper = async () => ({ ok: true, identity, file: { ...header.file, content } }), realpath = p => path.win32.resolve(p), extra = {}) {
  let calls = 0;
  const api = load('windows-session-input', {
    'node:fs': { realpathSync: { native: realpath } },
    './windows-helper': { ...transport, invokeWindowsSessionHelper: async (...args) => { calls++; return helper(...args); } },
    ...extra,
  });
  return { api, count: () => calls };
}

test('session reader shares an earlier outer deadline, never extends 25s, rejects invalid/expired before metadata', async () => {
  let now = 100, realpaths = 0;
  const a = adapter(async (_p, _h, _r, deadline) => { assert.equal(deadline, 150); now = 150;
    return { get ok() { assert.fail('late response consumed'); } }; }, p => { realpaths++; return path.win32.resolve(p); },
    { 'node:perf_hooks': { performance: { now: () => now } } });
  assert.equal((await a.api.readWindowsSessionInput({ ...options(), deadline: 150 })).reason, 'session_input_timeout');
  const before = realpaths;
  for (const deadline of [100, -1, NaN, Infinity, '150']) {
    now = 100; assert.equal((await a.api.readWindowsSessionInput({ ...options(), deadline })).ok, false);
  }
  assert.equal(a.count(), 1); assert.equal(realpaths, before);
  const capped = adapter(async (_p, _h, _r, deadline) => { assert.equal(deadline, 25100); return { ok: true, file: { content } }; },
    p => path.win32.resolve(p), { 'node:perf_hooks': { performance: { now: () => 100 } } });
  assert.equal((await capped.api.readWindowsSessionInput({ ...options(), deadline: 100000 })).ok, true);
});

test('session wire is an exact single JSONL file schema, never a snapshot selection', () => {
  assert.deepEqual(JSON.parse(transport.encodeWindowsHelperRequest(request)), request);
  for (const change of [{ path: '../turn.jsonl' }, { path: 'turn.txt' }, { path: 'TURN.JSONL' },
    { path: Array(65).fill('x').join('/') + '.jsonl' }, { excluded: [] }, { paths: [] },
    { expected: null }, { _canonical: false }, { root: '\\\\host\\share' }]) {
    assert.equal(transport.encodeWindowsHelperRequest({ ...request, ...change }), null, JSON.stringify(change));
  }
  assert.ok(transport.encodeWindowsHelperRequest({ ...request, path: '空/😀.jsonl' }));
});

test('session response pins root and leaf, exact body/hash/closed fields and no tree', () => {
  const result = transport.parseWindowsHelperResponse(wire(), request);
  assert.equal(result.ok, true); assert.deepEqual(result.file.content, content);
  assert.equal(result.identity.volumeSerial, '9007199254740993');
  const empty = { ...header, file: { ...header.file, size: '0', sha256: sha(Buffer.alloc(0)) } };
  assert.equal(transport.parseWindowsHelperResponse(wire(empty, Buffer.alloc(0)), request).ok, true);
  for (const h of [{ ...header, entries: [] }, { ...header, identity: { ...identity, fileId: 'b'.repeat(32) } },
    { ...header, file: { ...header.file, path: 'other.jsonl' } }, { ...header, file: { ...header.file, size: 3 } },
    { ...header, file: { ...header.file, size: '67108865' } }, { ...header, file: { ...header.file, sha256: '0'.repeat(64) } },
    { ...header, file: { ...header.file, identity: { ...identity, volumeSerial: '1' } } },
    { ...header, file: { ...header.file, extra: true } }, { ...header, file: null }]) {
    assert.deepEqual(transport.parseWindowsHelperResponse(wire(h), request), { ok: false, reason: 'helper_output_invalid' });
  }
  for (const bytes of [wire(header, Buffer.from('BAD')), wire(header, Buffer.from('{}\n!')), wire(header, Buffer.alloc(0))]) {
    assert.equal(transport.parseWindowsHelperResponse(bytes, request).ok, false);
  }
});

test('session async transport is distinct from Git, uses the same bounded permit/deadline', async () => {
  assert.equal(typeof transport.invokeWindowsSessionHelper, 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-session-transport-'));
  try {
    const { WINDOWS_HELPER_SOURCE } = require(base + 'windows-helper-source');
    const helper = path.join(dir, 'helper.py'); fs.writeFileSync(helper, WINDOWS_HELPER_SOURCE);
    const EventEmitter = require('node:events'); let spawns = 0, now = 0, timer, clearCount = 0;
    const children = [];
    const api = load('windows-helper', {
      'node:perf_hooks': { performance: { now: () => now } },
      'node:child_process': { spawn() {
        spawns++; const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin.end = () => {}; child.kill = () => { child.kills = (child.kills || 0) + 1; return true; };
        children.push(child); return child;
      } },
    }, { setTimeout: f => { timer = f; return 1; }, clearTimeout: () => clearCount++ });
    assert.equal((await api.invokeWindowsGitHelper('python', helper, request, 25000)).reason, 'request_invalid');
    for (const op of ['gitMetadata', 'selectedSnapshot', 'capture', 'identity', 'estimate', 'snapshot']) {
      assert.equal((await api.invokeWindowsSessionHelper('python', helper, { ...request, op }, 25000)).reason, 'request_invalid');
    }
    for (const invalid of [0, -1, NaN, Infinity, 25001]) {
      assert.equal((await api.invokeWindowsSessionHelper('python', helper, request, invalid)).reason, 'git_capture_timeout');
    }
    const first = api.invokeWindowsSessionHelper('python', helper, request, 25000);
    const second = api.invokeWindowsSessionHelper('python', helper, request, 25000);
    assert.equal((await api.invokeWindowsSessionHelper('python', helper, request, 25000)).reason, 'git_capture_busy');
    assert.equal(spawns, 2);
    // Shared with Git: a session does not evade a saturated content-helper pool.
    assert.equal((await api.invokeWindowsGitHelper('python', helper, { version: 1, op: 'gitMetadata', root: request.root, expected: identity, excluded: [] }, 25000)).reason, 'git_capture_busy');
    children[0].stdout.emit('data', wire()); children[0].emit('close', 0);
    assert.equal((await first).ok, true);
    timer(); assert.equal(children[1].kills, 1);
    // Kill is not close: second still occupies its permit until close.
    const third = api.invokeWindowsSessionHelper('python', helper, request, 25000);
    assert.equal((await api.invokeWindowsSessionHelper('python', helper, request, 25000)).reason, 'git_capture_busy');
    children[1].emit('close', 0); assert.equal((await second).reason, 'git_capture_timeout');
    now = 25000; children[2].stdout.emit('data', wire()); children[2].emit('close', 0);
    assert.equal((await third).reason, 'git_capture_timeout'); assert.equal(clearCount, 3);
    fs.writeFileSync(helper, 'TAMPER'); now = 0;
    assert.equal((await api.invokeWindowsSessionHelper('python', helper, request, 25000)).reason, 'helper_integrity_failed');
    assert.equal(spawns, 3);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('session adapter uses independent input authorization, literal target and old pin without repinning', async () => {
  let observed;
  const value = adapter(async (...args) => { observed = args; return { ok: true, file: { ...header.file, content } }; });
  const input = options(), before = JSON.stringify(input);
  const result = await value.api.readWindowsSessionInput(input);
  assert.equal(result.ok, true); assert.deepEqual(result.content, content);
  assert.equal(result.content.buffer.byteLength, result.content.length, 'owned non-pooled bytes');
  assert.notEqual(result.content.buffer, content.buffer);
  assert.equal(Object.hasOwn(result, 'sha256'), false); assert.equal(Object.hasOwn(result, 'identity'), false);
  assert.equal(observed[0], 'python'); assert.deepEqual(JSON.parse(JSON.stringify(observed[2])), { ...request, root: 'C:\\sessions' });
  assert.equal(JSON.stringify(input), before);
  assert.equal(value.count(), 1);
});

test('session adapter rejects missing independent authorization, aliases, protected paths and helper failures before returning bytes', async () => {
  const variants = [o => { o.policy.authorizedInputDirs = []; }, o => { o.policy.authorizedInputPins = {}; },
    o => { delete o.policy.authorizedInputPins['c:\\sessions'].identity; },
    o => { o.policy.authorizedInputPins['c:\\sessions'].realpath = 'C:/elsewhere'; },
    o => { o.policy.authorizedDirs = ['C:/sessions']; o.policy.authorizedInputDirs = []; },
    o => { o.inputPath = 'C:/sessions2/turn.jsonl'; }, o => { o.inputPath = '\\\\host\\share\\turn.jsonl'; },
    o => { o.inputPath = 'relative.jsonl'; }, o => { o.inputPath = 'C:/sessions/sub/turn.txt'; },
    o => { o.captureRoot = 'C:/sessions/sub'; }, o => { o.privateDirs = ['C:/sessions/sub']; },
    o => { o.privateDirs = ['\\\\host\\share']; }];
  for (const change of variants) {
    const instance = adapter(); const opts = options(); change(opts);
    assert.equal((await instance.api.readWindowsSessionInput(opts)).ok, false, change.toString());
    assert.equal(instance.count(), 0, 'no helper/content before authorization rejection');
  }
  const alias = adapter(undefined, p => p === 'C:\\sessions\\sub\\turn.jsonl' ? 'C:\\other\\turn.jsonl' : p);
  assert.equal((await alias.api.readWindowsSessionInput(options())).ok, false); assert.equal(alias.count(), 0);
  const protectedAlias = adapter(undefined, p => p === 'C:\\capture' ? 'C:\\sessions\\sub' : p);
  assert.equal((await protectedAlias.api.readWindowsSessionInput(options())).ok, false); assert.equal(protectedAlias.count(), 0);
  for (const response of [{ ok: false, reason: 'root_identity_mismatch' }, { ok: false, reason: 'PRIVATE_SENTINEL' }]) {
    const instance = adapter(async () => response);
    const result = await instance.api.readWindowsSessionInput(options());
    assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
    assert.equal(instance.count(), 1, 'failure stops without retry/fallback');
  }
});

test('session adapter scope, helper and final-copy phases share one observed deadline', async () => {
  for (const phase of ['scope', 'helper', 'copy']) {
    let now = 0, checks = 0, reads = 0;
    const instance = adapter(async () => {
      if (phase === 'helper') now = 25000;
      return { ok: true, file: { get content() { reads++; return content; } } };
    }, p => { if (phase === 'scope') now = 25000; return p; }, {
      'node:perf_hooks': { performance: { now: () => {
        checks++;
        return phase === 'copy' && checks === 4 ? 25000 : now;
      } } },
    });
    const result = await instance.api.readWindowsSessionInput(options());
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, reason: 'session_input_timeout' }, phase);
    assert.equal(instance.count(), phase === 'scope' ? 0 : 1);
    if (phase === 'helper') assert.equal(reads, 0, 'late content not consumed');
  }
});

test('session adapter platform and injected private roots reject before content I/O', async () => {
  let calls = 0;
  const mocks = { './windows-helper': { ...transport, invokeWindowsSessionHelper: async () => { calls++; return { ok: true }; } } };
  const linux = load('windows-session-input', mocks, { process: { platform: 'linux', env: {} } });
  assert.equal((await linux.readWindowsSessionInput(options())).reason, 'windows_required');
  for (const name of ['PI_AGENT_SANDBOX_DIR', 'PI_AGENT_PRIVATE_DIR']) {
    const api = load('windows-session-input', { ...mocks, 'node:fs': { realpathSync: { native: p => p } } },
      { process: { platform: 'win32', env: { [name]: 'C:/sessions/sub' } } });
    assert.equal((await api.readWindowsSessionInput(options())).reason, 'session_input_scope_rejected');
  }
  assert.equal(calls, 0);
});

test('session adapter excludes secret bytes and refuses invalid UTF-8 instead of lossy decoding', async () => {
  for (const bytes of [Buffer.from('sk-' + 'x'.repeat(40)), Buffer.from([0xff, 0xfe])]) {
    const instance = adapter(async () => ({ ok: true, file: { ...header.file, content: bytes } }));
    const result = await instance.api.readWindowsSessionInput(options());
    assert.equal(result.ok, false); assert.equal(Object.hasOwn(result, 'content'), false);
    assert.equal(Object.hasOwn(result, 'sha256'), false); assert.equal(Object.hasOwn(result, 'identity'), false);
    assert.equal(instance.count(), 1);
  }
});

test('real Windows independently pinned session adapter reads exact bytes and refuses replacement/junction/secret', { skip: process.platform !== 'win32' }, async t => {
  const { createBadcaseCaptureService } = require(base + 'index');
  const { readWindowsSessionInput } = require(base + 'windows-session-input');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-session-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const sessions = path.join(dir, 'sessions'), captureRoot = path.join(dir, 'capture'); fs.mkdirSync(sessions);
  const inputPath = path.join(sessions, 'turn.jsonl'); fs.writeFileSync(inputPath, '{}\r\n');
  const svc = createBadcaseCaptureService({ captureRoot });
  svc.savePolicy('p', { authorizedDirs: [], authorizedInputDirs: [sessions] });
  const policy = svc.authorizeProject('p'); assert.equal(policy.status, 'disabled');
  const opts = { policy, captureRoot, inputPath };
  const result = await readWindowsSessionInput(opts);
  assert.equal(result.ok, true, result.reason); assert.deepEqual(result.content, Buffer.from('{}\r\n'));
  assert.equal(svc.store.computeUsage('p').bytesByKind.blobs, 0, 'primitive never publishes CAS');
  fs.writeFileSync(inputPath, 'sk-' + 'x'.repeat(40));
  assert.equal((await readWindowsSessionInput(opts)).reason, 'session_contains_secret');
  fs.renameSync(sessions, sessions + '-old'); fs.mkdirSync(sessions); fs.writeFileSync(inputPath, '{}\n');
  assert.equal((await readWindowsSessionInput(opts)).ok, false, 'original persisted pin cannot follow replacement');
  fs.rmSync(sessions, { recursive: true });
  require('node:child_process').execFileSync('cmd', ['/d', '/c', 'mklink', '/J', sessions, sessions + '-old']);
  try { assert.equal((await readWindowsSessionInput(opts)).ok, false); } finally { fs.rmdirSync(sessions); }
  assert.equal(svc.loadPolicy('p').status, 'disabled');
});
