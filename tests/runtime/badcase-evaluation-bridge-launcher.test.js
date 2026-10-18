// Trusted fixed distribution staging + injected Docker transport, NOT native/Docker evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const inventory = require('../../scripts/badcase-capture/evaluation-bridge-files.json');
const repo = path.resolve(__dirname, '../..');
const image = { imageId: 'sha256:' + 'a'.repeat(64), repositoryDigest: 'test.invalid/base@sha256:' + 'b'.repeat(64),
  architecture: 'amd64', nodeVersion: 'v22.22.0', pythonVersion: 'Python 3.11.2' };
const native = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
function api() { return require('../../scripts/badcase-capture/evaluation-bridge-launcher.cjs'); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-bridge-distribution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of [...inventory.build, ...inventory.dependencies]) {
    const dest = path.join(root, name); fs.mkdirSync(path.dirname(dest), { recursive: true });
    let bytes = fs.readFileSync(path.join(repo, name));
    if (name === native) { // structural ELF only; NEVER imported/executed
      bytes = Buffer.alloc(64); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18);
    }
    fs.writeFileSync(dest, bytes);
  }
  return root;
}
// Execute the actual staged entry with inert filesystem/native/bridge doubles.
// No host native loading, SDK, Docker or model execution is permitted by this harness.
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function entryHarness(files, options = {}) {
  const manifest = structuredClone(manifestFor(files));
  const bytes = new Map(files.map(f => ['/work/' + f.path, Buffer.from(f.bytes)]));
  const environment = structuredClone(image);
  const r = api().bridgeReceipt(manifest, environment);
  if (options.manifest) options.manifest(manifest);
  if (options.resign) manifest.inputHash = digest(JSON.stringify(manifest.files));
  if (options.environment) options.environment(environment);
  if (options.bytes) options.bytes(bytes);
  const reads = [], imports = [], events = [], stdout = [], stderr = [];
  const proc = { platform: 'linux', getuid: () => 65534, cwd: () => '/work', env: {},
    version: image.nodeVersion, arch: 'x64', stderr: { write: s => stderr.push(s) }, ...options.process };
  const fakeFs = {
    existsSync: p => p === '/.dockerenv' && options.marker !== false,
    readFileSync: p => {
      reads.push(p);
      if (p === 'manifest.json') return Buffer.from(JSON.stringify(manifest));
      if (p === 'environment.json') return Buffer.from(JSON.stringify(environment));
      assert.ok(bytes.has(p), 'only staged files may be read'); return bytes.get(p);
    },
    lstatSync: p => {
      assert.ok(bytes.has(p), 'only staged files may be statted');
      const st = { size: bytes.get(p).length, isFile: () => true, isSymbolicLink: () => false };
      return options.stat ? options.stat(p, st) : st;
    },
  };
  const code = files.find(f => f.path === 'probe.cjs').bytes.toString('utf8');
  const result = vm.runInNewContext(code, { process: proc, console: { log: s => stdout.push(s) }, require: name => {
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:crypto') return crypto;
    imports.push(name);
    if (name === '/work/node_modules/better-sqlite3') {
      if (options.loadFailure) throw Error('private loader detail');
      return class Database {
        constructor(name) { assert.equal(name, ':memory:'); events.push('open'); }
        prepare(sql) { assert.equal(sql, 'select sqlite_version() as version'); events.push('query');
          return { get: () => { if (options.queryFailure) throw Error('private query detail');
            return { version: options.sqliteVersion ?? '3.50.0' }; } }; }
        close() { events.push('close'); if (options.closeFailure) throw Error('private close detail'); }
      };
    }
    assert.equal(name, '/work/evaluation-bridge-container.cjs');
    assert.deepEqual(events, ['open', 'query', 'close'], 'native verification must settle before bridge import');
    return { runContainerBridgeDiagnostic: async () => { events.push('bridge'); return r; } };
  } }, { timeout: 1000 });
  await result;
  return { manifest, reads, imports, events, stdout, stderr, exitCode: proc.exitCode };
}
function refused(h, beforeNative = true) {
  assert.equal(h.exitCode, 1); assert.deepEqual(h.stdout, []);
  assert.deepEqual(h.stderr, ['evaluation_bridge_container_failed\n']);
  if (beforeNative) { assert.deepEqual(h.imports, []); assert.deepEqual(h.events, []); }
}
test('entry executes full staged verification before native query/close and bridge import', async t => {
  const root = fixture(t), files = api().prepareBridgeFiles(repo, root, image);
  const h = await entryHarness(files);
  assert.equal(h.exitCode, undefined); assert.deepEqual(h.stderr, []);
  assert.deepEqual(h.events, ['open', 'query', 'close', 'bridge']);
  assert.deepEqual(h.imports, ['/work/node_modules/better-sqlite3', '/work/evaluation-bridge-container.cjs']);
  assert.deepEqual(h.reads, ['manifest.json', 'environment.json', ...h.manifest.files.map(f => '/work/' + f.path)]);
  assert.deepEqual(h.stdout, [JSON.stringify(api().bridgeReceipt(h.manifest, image))]);
});
test('entry environment gate rejects before staged reads or native/CAFF import including LD hooks', async t => {
  const root = fixture(t), files = api().prepareBridgeFiles(repo, root, image);
  const cases = [{ marker: false }, { process: { platform: 'win32' } }, { process: { getuid: () => 0 } },
    { process: { getuid: undefined } }, { process: { cwd: () => '/elsewhere' } },
    ...['CAFF_X', 'PI_X', 'OPENAI_X', 'ANTHROPIC_X', 'AWS_X', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH']
      .map(key => ({ process: { env: { [key]: 'private forbidden value' } } }))];
  for (const options of cases) { const h = await entryHarness(files, options); refused(h); assert.deepEqual(h.reads, []); }
  const h = await entryHarness(files, { process: { env: { HARMLESS_AMBIENT: 'allowed by environment gate only' } } });
  assert.equal(h.exitCode, undefined); assert.equal(h.events.at(-1), 'bridge');
});
test('entry rejects manifest schema/hash/count and runtime identity mismatches before native import', async t => {
  const root = fixture(t), files = api().prepareBridgeFiles(repo, root, image);
  const cases = [{ manifest: m => { m.schemaVersion = 2; } }, { manifest: m => { m.files = {}; } },
    { manifest: m => { m.inputHash = '0'.repeat(64); } },
    { manifest: m => { m.files = Array.from({ length: 4097 }, (_, i) => ({ path: 'extra-' + i, size: 0, sha256: digest('') })); },
      bytes: map => { for (let i = 0; i < 4097; i++) map.set('/work/extra-' + i, Buffer.alloc(0)); }, resign: true },
    { process: { version: 'v0.0.0' } }, { process: { arch: 'arm64' } }];
  for (const options of cases) refused(await entryHarness(files, options));
});
test('entry independently rejects resigned invalid paths, duplicates, type/size/hash drift and aggregate overflow', async t => {
  const root = fixture(t), files = api().prepareBridgeFiles(repo, root, image);
  for (const invalid of ['/escape', '../escape', 'build/../escape', 'build//x', 'build/./x', 'bad name', 'C:/escape']) {
    refused(await entryHarness(files, {
      manifest: m => { m.files[0].path = invalid; },
      bytes: map => { map.set('/work/' + invalid, files.find(f => f.path === manifestFor(files).files[0].path).bytes); }, resign: true,
    }));
  }
  const cases = [{ manifest: m => { m.files.push({ ...m.files[0] }); }, resign: true },
    { stat: (p, st) => ({ ...st, isFile: () => false }) },
    { stat: (p, st) => ({ ...st, size: st.size + 1 }) },
    { manifest: m => { m.files[0].sha256 = '0'.repeat(64); }, resign: true },
    { bytes: map => { const name = map.keys().next().value, b = map.get(name); const changed = Buffer.from(b); changed[0] ^= 1; map.set(name, changed); } }];
  for (const options of cases) refused(await entryHarness(files, options));
  const large = Buffer.alloc(6 * 1024 * 1024);
  refused(await entryHarness(files, {
    manifest: m => { m.files = ['large-a', 'large-b', 'large-c'].map(name => ({ path: name, size: large.length, sha256: digest(large) })); },
    bytes: map => { for (const name of ['large-a', 'large-b', 'large-c']) map.set('/work/' + name, large); }, resign: true,
  }));
});
test('entry native load/query/close failures never import bridge or return raw diagnostics', async t => {
  const root = fixture(t), files = api().prepareBridgeFiles(repo, root, image);
  for (const options of [{ loadFailure: true }, { queryFailure: true }, { sqliteVersion: 'not-a-version' }, { closeFailure: true }]) {
    const h = await entryHarness(files, options); refused(h, false);
    assert.deepEqual(h.imports, ['/work/node_modules/better-sqlite3']);
    assert.deepEqual(h.events, options.loadFailure ? [] : ['open', 'query', 'close']);
  }
});
test('fixed distribution stages only allowlisted files with byte identity; native is data on host', t => {
  const root = fixture(t), { prepareBridgeFiles } = api();
  fs.writeFileSync(path.join(root, 'node_modules/do-not-read-auth.json'), 'unrelated source must not be read');
  const a = prepareBridgeFiles(repo, root, image), b = prepareBridgeFiles(repo, root, image);
  assert.deepEqual(manifestFor(a), manifestFor(b));
  assert.equal(a.length, inventory.build.length + inventory.dependencies.length + 3);
  assert.equal(a.some(f => f.path.includes('do-not-read')), false);
  for (const name of inventory.build) assert.deepEqual(a.find(f => f.path === name).bytes, fs.readFileSync(path.join(repo, name)));
  assert.deepEqual(a.find(f => f.path === native).bytes, fs.readFileSync(path.join(root, native)));
  assert.equal(a.some(f => /(^|\/)(auth|session|models)\.json$/.test(f.path)), false);
});
test('explicit dependency root, fixed versions and ELF architecture required; no automatic host fallback', t => {
  const root = fixture(t), { prepareBridgeFiles } = api();
  for (const deps of [undefined, null, '', 'relative']) assert.throws(() => prepareBridgeFiles(repo, deps, image), /evaluation_bridge_stage_failed/);
  const file = path.join(root, native), original = fs.readFileSync(file);
  const headerOnly = [0, 4, 5, 6].map(index => { const b = Buffer.from(original); b[index] = 0; return b; });
  const executable = Buffer.from(original); executable.writeUInt16LE(2, 16);
  for (const bytes of [Buffer.from('MZwindows-native'), Buffer.alloc(64), ...headerOnly, executable,
    (() => { const b = Buffer.from(original); b.writeUInt16LE(183, 18); return b; })()]) {
    fs.writeFileSync(file, bytes); assert.throws(() => prepareBridgeFiles(repo, root, image), /evaluation_bridge_stage_failed/);
  }
  fs.writeFileSync(file, original);
  assert.throws(() => prepareBridgeFiles(repo, root, { ...image, architecture: 'arm64' }), /evaluation_bridge_stage_failed/);
  const meta = path.join(root, 'node_modules/better-sqlite3/package.json'); fs.writeFileSync(meta, JSON.stringify({ name: 'better-sqlite3', version: '999.0.0' }));
  assert.throws(() => prepareBridgeFiles(repo, root, image), /evaluation_bridge_stage_failed/);
});
test('missing files, oversized input and symlink ancestors reject without importing packages', t => {
  const root = fixture(t), { prepareBridgeFiles } = api();
  const file = path.join(root, native), original = fs.readFileSync(file);
  fs.unlinkSync(file); assert.throws(() => prepareBridgeFiles(repo, root, image), /evaluation_bridge_stage_failed/);
  fs.writeFileSync(file, Buffer.alloc(9 * 1024 * 1024)); assert.throws(() => prepareBridgeFiles(repo, root, image), /evaluation_bridge_stage_failed/);
  fs.writeFileSync(file, original);
  const lib = path.join(root, 'node_modules/bindings'), moved = path.join(root, 'original-bindings');
  fs.renameSync(lib, moved); fs.symlinkSync(moved, lib, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareBridgeFiles(repo, root, image), /evaluation_bridge_stage_failed/);
});
test('aggregate size rejects before opening the next file rather than retaining all inputs first', t => {
  const root = fixture(t), { prepareBridgeFiles } = api();
  const [a, b] = inventory.dependencies;
  fs.writeFileSync(path.join(root, a), Buffer.alloc(8 * 1024 * 1024));
  fs.writeFileSync(path.join(root, b), Buffer.alloc(8 * 1024 * 1024));
  const open = fs.openSync; let opened = false;
  try {
    fs.openSync = function (file, ...args) { if (file === path.join(root, b)) opened = true; return open.call(this, file, ...args); };
    assert.throws(() => prepareBridgeFiles(repo, root, image), /evaluation_bridge_stage_failed/);
  } finally { fs.openSync = open; }
  assert.equal(opened, false);
});
test('launcher binds exact receipt and manifest to successful owned-cleaned transport; never exports raw output', async t => {
  const root = fixture(t), { runBridgeDiagnostic, bridgeReceipt } = api(); let calls = 0;
  const r = await runBridgeDiagnostic(repo, root, image, { runProbe: async (i, files) => {
    calls++; assert.deepEqual(i, image);
    const manifest = manifestFor(files);
    assert.match(files.find(f => f.path === 'probe.cjs').bytes.toString(), /new Database\(':memory:'\)/);
    return { result: { code: 0, stdout: JSON.stringify(bridgeReceipt(manifest, image)) + '\n', stderr: '' }, manifest, containerId: 'c'.repeat(64) };
  } });
  assert.equal(calls, 1); assert.equal(r.nativeSqliteVerified, true); assert.equal(r.cleaned, true);
  assert.equal(r.piExecuted, false); assert.equal(r.runnable, false); assert.equal(r.strictEvalEligible, false);
  assert.equal(Object.hasOwn(r, 'stdout'), false); assert.equal(Object.hasOwn(r, 'stderr'), false);
});
test('default launcher verifies image before transport and explicitly selects native-executable work only', async t => {
  const root = fixture(t), Module = require('node:module');
  const filename = path.join(repo, 'scripts/badcase-capture/evaluation-bridge-launcher.cjs');
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = m.require.bind(m), calls = [];
  m.require = name => name === './verify-pi-initialization.cjs' ? {
    verifyProbeImage: async i => { assert.deepEqual(i, image); calls.push('verify'); },
    runProbe: async (i, files, options) => {
      assert.deepEqual(calls, ['verify']); calls.push('run'); assert.deepEqual(options, { executableWork: true });
      const manifest = manifestFor(files);
      return { result: { code: 0, stdout: JSON.stringify(m.exports.bridgeReceipt(manifest, i)) + '\n', stderr: '' }, manifest, containerId: 'c'.repeat(64) };
    },
  } : original(name);
  m._compile(fs.readFileSync(filename, 'utf8'), filename);
  await m.exports.runBridgeDiagnostic(repo, root, image);
  assert.deepEqual(calls, ['verify', 'run']);
});
test('all transport mismatches fail closed, with no retry; staging errors prevent launch', async t => {
  const root = fixture(t), { runBridgeDiagnostic, bridgeReceipt } = api();
  for (const change of [r => { r.result.stderr = 'private error'; }, r => { r.result.stdout += ' '; },
    r => { r.result.code = 1; }, r => { r.result.failure = 'timeout'; }, r => { r.containerId = 'not-an-id'; },
    r => { r.manifest.inputHash = 'd'.repeat(64); }, r => { r.manifest.files.pop(); }]) {
    let calls = 0;
    await assert.rejects(runBridgeDiagnostic(repo, root, image, { runProbe: async (i, files) => {
      calls++; const manifest = manifestFor(files), r = { result: { code: 0, stdout: JSON.stringify(bridgeReceipt(manifest, image)) + '\n', stderr: '' }, manifest, containerId: 'c'.repeat(64) };
      change(r); return r;
    } }), /evaluation_bridge_launch_failed/);
    assert.equal(calls, 1);
  }
  let calls = 0; fs.unlinkSync(path.join(root, native));
  await assert.rejects(runBridgeDiagnostic(repo, root, image, { runProbe: async () => { calls++; } }), /evaluation_bridge_stage_failed/);
  assert.equal(calls, 0);
});
