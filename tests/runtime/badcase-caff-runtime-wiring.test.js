// Synthetic production-host wiring only. No SDK/native import or agent on host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const inventory = require('../../scripts/badcase-capture/evaluation-bridge-files.json');
const repo = path.resolve(__dirname, '../..');
const image = { imageId: 'sha256:' + 'a'.repeat(64), repositoryDigest: 'test.invalid/base@sha256:' + 'b'.repeat(64),
  architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
const native = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
function api() { return require('../../scripts/badcase-capture/caff-runtime-wiring.cjs'); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-runtime-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of inventory.dependencies) {
    const dest = path.join(root, name); fs.mkdirSync(path.dirname(dest), { recursive: true });
    let bytes = fs.readFileSync(path.join(repo, name));
    if (name === native) { bytes = Buffer.alloc(64); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); }
    fs.writeFileSync(dest, bytes);
  }
  return root;
}
// Actual container bootstrap with inert memory fs; stop at the SDK import
// boundary. This is control-flow coverage, NOT SDK/Docker/native evidence.
function bootstrap(options = {}) {
  const bytes = new Map([['runtime/x', Buffer.from('x')], ['environment.json', Buffer.from(JSON.stringify(image))],
    ['mode.txt', Buffer.from(options.mode || 'fresh')]]);
  if (options.largeWorkspace) bytes.set('replay-workspace/large.txt', Buffer.alloc(25 * 1024 * 1024, 0x61));
  let m = manifestFor([...bytes].map(([path, bytes]) => ({ path, bytes })), { replayWorkspace: !!options.largeWorkspace });
  if (options.manifest) options.manifest(m, bytes);
  if (options.resign) m.inputHash = crypto.createHash('sha256').update(JSON.stringify(m.files)).digest('hex');
  const store = new Map([...bytes].map(([name, value]) => ['/work/' + name, value]));
  store.set('/work/manifest.json', Buffer.from(JSON.stringify(m)));
  if (options.bytes) options.bytes(store);
  const dirs = new Set(['/work']); if (options.existingProject) dirs.add('/work/project');
  const reads = [], imports = [], loads = [];
  let starts = 0, stops = 0;
  const absolute = p => p.startsWith('/') ? p : '/work/' + p;
  const fakeFs = {
    existsSync: p => p === '/.dockerenv' ? options.marker !== false : store.has(absolute(p)) || dirs.has(absolute(p)),
    lstatSync: p => { const b = store.get(absolute(p)); assert.ok(b); const st = { size: b.length, isFile: () => true, isSymbolicLink: () => false };
      return options.stat ? options.stat(p, st) : st; },
    readFileSync: (p, encoding) => { reads.push(p); const b = store.get(absolute(p)); assert.ok(b); return encoding ? b.toString(encoding) : b; },
    openSync: p => ({ path: absolute(p), offset: 0 }), closeSync: () => {},
    readSync: (fd, block, offset, length) => { reads.push(fd.path); const b = store.get(fd.path); assert.ok(b); const n = b.copy(block, offset, fd.offset, fd.offset + length); fd.offset += n; return n; },
    mkdirSync: (p, cfg = {}) => { if (dirs.has(p) && !cfg.recursive) throw Error('EEXIST'); dirs.add(p); },
    writeFileSync: (p, b, cfg) => { assert.equal(cfg.flag, 'wx'); assert.equal(cfg.mode, 0o600); assert.equal(store.has(p), false); store.set(p, Buffer.from(b)); },
  };
  const mod = { exports: {} }, proc = { platform: 'linux', getuid: () => 65534, cwd: () => '/work', env: {},
    version: image.nodeVersion, arch: 'x64', ...options.process };
  const req = name => {
    if (name === './replay-path.cjs') return require('../../scripts/badcase-capture/replay-path.cjs');
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:crypto') return crypto;
    if (name === 'node:assert/strict') return assert;
    imports.push(name); assert.equal(name, '/work/build/server/domain/runtime/badcase-capture/evaluation-callback');
    return { startEvaluationCallback: async () => { starts++; return { apiUrl: 'http://127.0.0.1:12345',
      credentials: { invocationId: 'inert-id', callbackToken: 'inert-identity' }, stop: async () => { stops++; } }; } };
  };
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'scripts/badcase-capture/caff-runtime-container.cjs'), 'utf8'), {
    require: req, module: mod, process: proc, Buffer, URL, AbortSignal, fetch: async () => assert.fail('no network in inert bootstrap'),
    console: { log: () => assert.fail('no output from imported container module') },
  }, { timeout: 1000 });
  return { run: () => mod.exports.runCaffRuntimeContainer(async name => { loads.push(name); throw Error('inert_sdk_boundary'); }),
    verifyReplay: () => mod.exports.verifyCaffRuntimeStage({ replayWorkspace: true }),
    store, reads, imports, loads, starts: () => starts, stops: () => stops };
}
test('container bootstrap consumes valid material before its SDK boundary and closes owned callback on import failure', async () => {
  const h = bootstrap(); await assert.rejects(h.run(), /inert_sdk_boundary/);
  assert.deepEqual(h.loads, ['/work/runtime/dist/bundle/index.js']); assert.equal(h.starts(), 1); assert.equal(h.stops(), 1);
});
test('direct replay verification allows large workspace bytes only with explicit opt-in, still checks every digest', async () => {
  const h = bootstrap({ largeWorkspace: true });
  await assert.rejects(h.run(), 'static wiring path must retain its existing byte limit');
  assert.ok(h.verifyReplay().manifest.files.some(f => f.path === 'replay-workspace/large.txt'));
  const bad = bootstrap({ largeWorkspace: true, bytes: map => map.set('/work/replay-workspace/large.txt', Buffer.from('tampered')) });
  assert.throws(() => bad.verifyReplay()); assert.equal(bad.starts(), 0); assert.deepEqual(bad.loads, []);
});
test('container bootstrap gates environment before reads, callbacks or SDK imports', async () => {
  for (const options of [{ marker: false }, { process: { platform: 'win32' } }, { process: { getuid: () => 0 } },
    { process: { cwd: () => '/outside' } }, ...['CAFF_X', 'PI_X', 'OPENAI_X', 'ANTHROPIC_X', 'AWS_X', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].map(k => ({ process: { env: { [k]: 'inert' } } }))]) {
    const h = bootstrap(options); await assert.rejects(h.run()); assert.deepEqual(h.reads, []); assert.deepEqual(h.imports, []); assert.deepEqual(h.loads, []);
  }
});
test('container bootstrap rejects tampering and unsupported modes/identity before callback or SDK import', async () => {
  const cases = [{ mode: 'continue' }, { existingProject: true }, { process: { version: 'v0.0.0' } }, { process: { arch: 'arm64' } },
    { manifest: m => { m.schemaVersion = 2; } }, { manifest: m => { m.inputHash = '0'.repeat(64); } },
    { manifest: m => { m.runtimeHash = '0'.repeat(64); } },
    { manifest: m => { m.files.push({ ...m.files[0] }); }, resign: true },
    { stat: (p, st) => ({ ...st, isFile: () => false }) }, { stat: (p, st) => ({ ...st, size: st.size + 1 }) },
    { bytes: map => { map.set('/work/runtime/x', Buffer.from('y')); } },
    { manifest: (m, bytes) => { m.files = Array.from({ length: 4097 }, (_, i) => ({ path: 'item-' + i, size: 0, sha256: crypto.createHash('sha256').update('').digest('hex') }));
      for (const f of m.files) bytes.set(f.path, Buffer.alloc(0)); m.runtimeHash = crypto.createHash('sha256').update('[]').digest('hex'); }, resign: true }];
  for (const invalid of ['/outside', '../outside', 'runtime/./x', 'runtime//x', 'bad name.']) cases.push({
    manifest: (m, bytes) => { const f = m.files.find(f => f.path === 'runtime/x'); bytes.set(invalid, bytes.get(f.path)); f.path = invalid;
      m.runtimeHash = crypto.createHash('sha256').update(JSON.stringify(m.files.filter(f => f.path.startsWith('runtime/')))).digest('hex'); }, resign: true,
  });
  const large = Buffer.alloc(6 * 1024 * 1024);
  cases.push({ manifest: (m, bytes) => { m.files = ['large-a', 'large-b', 'large-c'].map(path => ({ path, size: large.length, sha256: crypto.createHash('sha256').update(large).digest('hex') }));
    for (const f of m.files) bytes.set(f.path, large); m.runtimeHash = crypto.createHash('sha256').update('[]').digest('hex'); }, resign: true });
  for (const options of cases) { const h = bootstrap(options); await assert.rejects(h.run()); assert.equal(h.starts(), 0); assert.deepEqual(h.imports, []); assert.deepEqual(h.loads, []); }
});
test('bootstrap fresh has no resume copy; resume keeps separate exact archive/working bytes before SDK import', async () => {
  for (const mode of ['fresh', 'resume']) {
    const h = bootstrap({ mode }); await assert.rejects(h.run(), /inert_sdk_boundary/);
    assert.equal(h.store.has('/work/archived-session.jsonl'), mode === 'resume');
    assert.equal(h.store.has('/work/working-session.jsonl'), mode === 'resume');
    if (mode === 'resume') assert.deepEqual(h.store.get('/work/archived-session.jsonl'), h.store.get('/work/working-session.jsonl'));
  }
});
test('stages unchanged production host with its imported Fast module and actual SDK distribution; mode is explicit', t => {
  const root = fixture(t), a = api();
  for (const mode of ['fresh', 'resume']) {
    const files = a.prepareCaffRuntimeFiles(repo, root, image, mode), m = manifestFor(files);
    assert.ok(m.runtimeBytes > 0); assert.equal(files.find(f => f.path === 'mode.txt').bytes.toString(), mode);
    for (const name of ['pi-sdk-host.mjs', 'proxy-routing.mjs', 'pi-extensions/caff-capabilities.mjs', 'pi-extensions/caff-stream-read-retry.mjs', 'pi-extensions/caff-fast-mode.mjs']) {
      assert.deepEqual(files.find(f => f.path === 'build/lib/' + name).bytes, fs.readFileSync(path.join(repo, 'lib', name)));
    }
    for (const name of ['package.json', 'lib/jiti.cjs', 'dist/jiti.cjs', 'dist/babel.cjs']) {
      assert.deepEqual(files.find(f => f.path === 'runtime/node_modules/jiti/' + name)?.bytes,
        fs.readFileSync(path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/node_modules/jiti', name)));
    }
    const entry = files.find(f => f.path === 'probe.cjs').bytes.toString();
    assert.match(entry, /createSdkRuntime/); assert.doesNotMatch(entry, /session\.prompt\(/);
    assert.equal(files.filter(f => f.path === 'probe.cjs').length, 1);
    assert.deepEqual(manifestFor(a.prepareCaffRuntimeFiles(repo, root, image, mode)), m);
  }
});
test('direct staging separates a large workspace from the actual fixed SDK/runtime distribution', t => {
  const root = fixture(t), bytes = Buffer.alloc(25 * 1024 * 1024, 0x61);
  const input = { kind: 'prepared-caff-turn-v1', prompt: 'Inspect.', files: [{ path: 'large.txt',
    base64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') }], sessionText: null };
  const { prepareDirectTurnFiles } = require('../../scripts/badcase-capture/direct-docker.cjs');
  const staged = prepareDirectTurnFiles(repo, root, image, input), m = manifestFor(staged, { replayWorkspace: true });
  assert.ok(m.runtimeBytes > 0); assert.equal(staged.filter(f => f.path === 'probe.cjs').length, 1);
  assert.ok(staged.find(f => f.path === 'replay-input.json').bytes.length < 4096);
  assert.deepEqual(staged.find(f => f.path === 'replay-workspace/large.txt').bytes, bytes);
  assert.equal(m.runtimeHash, manifestFor(staged.filter(f => !f.path.startsWith('replay-workspace/'))).runtimeHash);
});
test('explicit native limits enter hashed stage control only; default stage and sealed inputs stay unchanged', t => {
  const root = fixture(t), input = { kind: 'prepared-caff-turn-v1', prompt: 'Inspect.', files: [], sessionText: null };
  const { prepareDirectTurnFiles } = require('../../scripts/badcase-capture/direct-docker.cjs');
  const profile = 'openai-codex/gpt-6.1-sol', before = JSON.stringify(input);
  const legacy = prepareDirectTurnFiles(repo, root, image, input, profile);
  assert.equal(legacy.some(f => f.path === 'evaluation-limits.json'), false);
  const explicit = prepareDirectTurnFiles(repo, root, image, input, profile, 64);
  assert.deepEqual(JSON.parse(explicit.find(f => f.path === 'evaluation-limits.json').bytes), { maxRequests: 64 });
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(manifestFor(legacy).inputHash, manifestFor(explicit).inputHash);
  assert.deepEqual(explicit.filter(f => f.path !== 'evaluation-limits.json'), legacy);
  assert.deepEqual(prepareDirectTurnFiles(repo, root, image, input, profile), legacy);
  assert.throws(() => prepareDirectTurnFiles('/missing', '/missing', image, input, profile, 65), /evaluation_codex_mailbox_limits_invalid/);
});
test('invalid modes refuse before any source reads and never downgrade resume to fresh', () => {
  const a = api(), original = fs.lstatSync; let reads = 0;
  try {
    fs.lstatSync = function (...args) { reads++; return original.apply(this, args); };
    for (const mode of [undefined, null, '', 'FRESH', 'continue', {}, true]) {
      assert.throws(() => a.prepareCaffRuntimeFiles('/missing', '/missing', image, mode), /caff_runtime_stage_failed/);
    }
  } finally { fs.lstatSync = original; }
  assert.equal(reads, 0);
});
test('missing production extension is a fixed staging failure, never dropped or substituted', async t => {
  const root = fixture(t), a = api(), open = fs.openSync; let calls = 0;
  try {
    fs.openSync = function (file, ...args) {
      if (file === path.join(repo, 'lib/pi-extensions/caff-capabilities.mjs')) throw Error('private source detail');
      return open.call(this, file, ...args);
    };
    await assert.rejects(a.runCaffRuntimeWiring(repo, root, image, 'resume', { runProbe: async () => { calls++; } }), /caff_runtime_stage_failed/);
  } finally { fs.openSync = open; }
  assert.equal(calls, 0);
});
test('wiring wrapper binds entire manifest, runtime identity, mode and false replay qualification; no raw output', async t => {
  const root = fixture(t), a = api();
  for (const mode of ['fresh', 'resume']) {
    let calls = 0;
    const r = await a.runCaffRuntimeWiring(repo, root, image, mode, { runProbe: async (i, files) => {
      calls++; assert.deepEqual(i, image); const manifest = manifestFor(files);
      return { result: { code: 0, stdout: JSON.stringify(a.wiringReceipt(manifest, i, mode)) + '\n', stderr: '' }, manifest, containerId: 'c'.repeat(64) };
    } });
    assert.equal(calls, 1); assert.equal(r.cleaned, true); assert.equal(r.deliveryMode, mode);
    assert.equal(r.invocationSubmitted, false); assert.equal(r.runnable, false); assert.equal(r.strictEvalEligible, false);
    assert.equal(Object.hasOwn(r, 'stdout'), false); assert.equal(Object.hasOwn(r, 'stderr'), false);
  }
});
test('jiti version is pinned and default transport verifies the image before exec-work launch', async t => {
  const root = fixture(t), Module = require('node:module');
  const filename = path.join(repo, 'scripts/badcase-capture/caff-runtime-wiring.cjs');
  for (const badVersion of [true, false]) {
    const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    const original = mod.require.bind(mod), calls = [];
    mod.require = name => {
      if (name === './evaluation-bridge-launcher.cjs' && badVersion) {
        const base = original(name);
        return { ...base, readTrustedDistributionFile: (root, source, remaining) => source.endsWith('/jiti/package.json')
          ? Buffer.from(JSON.stringify({ name: 'jiti', version: '0.0.0' })) : base.readTrustedDistributionFile(root, source, remaining) };
      }
      if (name === './verify-pi-initialization.cjs') return {
        verifyProbeImage: async i => { assert.deepEqual(i, image); calls.push('verify'); },
        runProbe: async (i, files, options) => {
          assert.deepEqual(calls, ['verify']); calls.push('run'); assert.deepEqual(options, { executableWork: true });
          const manifest = manifestFor(files);
          return { result: { code: 0, stdout: JSON.stringify(mod.exports.wiringReceipt(manifest, i, 'fresh')) + '\n', stderr: '' }, manifest, containerId: 'c'.repeat(64) };
        },
      };
      return original(name);
    };
    mod._compile(fs.readFileSync(filename, 'utf8'), filename);
    if (badVersion) { assert.throws(() => mod.exports.prepareCaffRuntimeFiles(repo, root, image, 'fresh'), /caff_runtime_stage_failed/); assert.deepEqual(calls, []); }
    else { await mod.exports.runCaffRuntimeWiring(repo, root, image, 'fresh'); assert.deepEqual(calls, ['verify', 'run']); }
  }
});
test('transport mismatch and timeout fail without retries or leaking output', async t => {
  const root = fixture(t), a = api();
  for (const change of [r => { r.result.stdout += ' '; }, r => { r.result.stderr = 'private detail'; },
    r => { r.result.code = 1; }, r => { r.result.failure = 'timeout'; }, r => { r.manifest.files.pop(); },
    r => { r.containerId = 'bad'; }, r => { r.result.stdout = r.result.stdout.replace('"deliveryMode":"resume"', '"deliveryMode":"fresh"'); }]) {
    let calls = 0;
    await assert.rejects(a.runCaffRuntimeWiring(repo, root, image, 'resume', { runProbe: async (i, files) => {
      calls++; const manifest = manifestFor(files), r = { result: { code: 0, stdout: JSON.stringify(a.wiringReceipt(manifest, i, 'resume')) + '\n', stderr: '' }, manifest, containerId: 'c'.repeat(64) };
      change(r); return r;
    } }), /caff_runtime_wiring_failed/);
    assert.equal(calls, 1);
  }
});
test('container runtime entry refuses host execution before SDK/native imports', () => {
  const filename = path.join(repo, 'scripts/badcase-capture/caff-runtime-container.cjs');
  const r = spawnSync(process.execPath, [filename], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'caff_runtime_container_failed\n');
});
