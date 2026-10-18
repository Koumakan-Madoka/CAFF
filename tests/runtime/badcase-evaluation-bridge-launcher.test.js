// Trusted fixed distribution staging + injected Docker transport, NOT native/Docker evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
