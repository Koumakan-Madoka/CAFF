// Host tests stay inert at SDK/tool boundaries. Real agents/tools run only Docker.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fixture = require('../helpers/badcase-caff-bridge-fixture.cjs');
const repo = path.resolve(__dirname, '../..'), hash = b => crypto.createHash('sha256').update(b).digest('hex');
const inventory = require('../../scripts/badcase-capture/evaluation-bridge-files.json');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const image = { imageId: 'sha256:' + 'a'.repeat(64), repositoryDigest: 'test.invalid/base@sha256:' + 'b'.repeat(64),
  architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
const api = () => require('../../scripts/badcase-capture/retained-caff-bridge.cjs');
function dependencies(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-bridge-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of inventory.dependencies) {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    let b = fs.readFileSync(path.join(repo, name));
    if (name.endsWith('better_sqlite3.node')) { b = Buffer.alloc(64); b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); b.writeUInt16LE(3, 16); b.writeUInt16LE(62, 18); }
    fs.writeFileSync(target, b);
  }
  return root;
}
test('sealed bridge plan requires a separately supplied exact association and original bridge-enabled full config', t => {
  for (const mode of ['fresh', 'resume']) {
    const v = fixture(t, mode, 'win32'), before = JSON.stringify(v), p = api().planBridge(v);
    assert.equal(p.callback.callbackInput.trace, JSON.stringify(v.trace));
    assert.deepEqual(p.callback.callbackInput.association, v.association);
    assert.equal(p.start.config.resume, mode === 'resume'); assert.equal(JSON.stringify(v), before);
    for (const key of Object.keys(v.association)) assert.throws(() => api().planBridge({ ...v, association: { ...v.association, [key]: 'wrong' } }));
    assert.throws(() => api().planBridge({ ...v, association: undefined }));
  }
  assert.throws(() => api().planBridge(fixture(t, 'fresh', 'linux', ({ config }) => { config.toolBridgeEnabled = false; })), /replay_bridge_disabled/);
  const old = require('../helpers/badcase-caff-replay-fixture.cjs')(t);
  assert.throws(() => api().planBridge({ ...old, association: fixture(t).association }), /callback_input_missing/);
});
test('invalid bridge input rejects before filesystem/transport, without seed fallback', async t => {
  let calls = 0; const v = fixture(t); v.association.agentId = 'other';
  await assert.rejects(api().runRetainedCaffBridge('/missing', '/missing', image, v, { runProbe: async () => { calls++; } }));
  assert.equal(calls, 0);
});
test('bridge staging retains original capsule/config and original initialization entry, supplies closed callback dependencies', t => {
  const v = fixture(t, 'resume'), root = dependencies(t), before = JSON.stringify(v);
  const files = api().prepareRetainedCaffBridgeFiles(repo, root, image, v);
  assert.equal(JSON.stringify(v), before); assert.ok(manifestFor(files).runtimeBytes > 0);
  assert.equal(files.find(f => f.path === 'capsule.json').bytes.toString(), v.capsule);
  assert.equal(files.find(f => f.path === 'bridge-association.json').bytes.toString(), JSON.stringify(v.association));
  assert.deepEqual(files.find(f => f.path === 'retained-caff-runtime.cjs').bytes, fs.readFileSync(path.join(repo, 'scripts/badcase-capture/retained-caff-container.cjs')));
  assert.match(files.find(f => f.path === 'probe.cjs').bytes.toString(), /runRetainedCaffContainer\(undefined, true\)/);
  for (const name of ['retained-callback-input', 'evaluation-callback', 'evaluation-trace', 'callback-input'])
    assert.equal(files.filter(f => f.path === 'build/server/domain/runtime/badcase-capture/' + name + '.js').length, 1);
});
test('bridge transport validates exact receipt/manifest/bounded observations and pins the executable-work Docker path', async t => {
  const a = api(), root = dependencies(t), v = fixture(t, 'resume');
  const transport = async (i, files) => { const manifest = manifestFor(files), p = a.planBridge(v);
    const observation = { historyHash: hash('history'), historyMessages: 3, systemPromptHash: hash('role'), toolsHash: hash('tools') };
    return { containerId: 'c'.repeat(64), manifest, result: { code: 0, stderr: '', stdout: JSON.stringify({ ...a.bridgeReceipt(manifest, i, p), observation }) + '\n' } }; };
  const r = await a.runRetainedCaffBridge(repo, root, image, v, { runProbe: transport });
  assert.equal(r.cleaned, true); assert.equal(r.callbackWired, true); assert.equal(r.callbackClosed, true);
  assert.equal(r.invocationSubmitted, false); assert.equal(r.runnable, false); assert.equal(r.modelCalls, 0);
  for (const change of [r => { r.manifest.files.pop(); }, r => { r.containerId = 'bad'; }, r => { r.result.stderr = 'private'; },
    r => { r.result.failure = 'timeout'; }, r => { r.result.code = 1; }, r => { r.result.stdout += ' '; },
    r => { const p = JSON.parse(r.result.stdout); p.callbackClosed = false; r.result.stdout = JSON.stringify(p) + '\n'; },
    r => { const p = JSON.parse(r.result.stdout); p.observation.historyHash = 'private'; r.result.stdout = JSON.stringify(p) + '\n'; }])
    await assert.rejects(a.runRetainedCaffBridge(repo, root, image, v, { runProbe: async (...args) => { const r = await transport(...args); change(r); return r; } }), /retained_caff_bridge_failed/);
  const Module = require('node:module'), filename = path.join(repo, 'scripts/badcase-capture/retained-caff-bridge.cjs');
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = m.require.bind(m), calls = [];
  m.require = name => name === './verify-pi-initialization.cjs' ? {
    verifyProbeImage: async i => { assert.deepEqual(i, image); calls.push('verify'); },
    runProbe: async (i, f, o) => { assert.deepEqual(calls, ['verify']); assert.deepEqual(o, { executableWork: true }); calls.push('run'); throw Error('inert'); },
  } : original(name);
  m._compile(fs.readFileSync(filename, 'utf8'), filename);
  await assert.rejects(m.exports.runRetainedCaffBridge(repo, root, image, v), /retained_caff_bridge_failed/);
  assert.deepEqual(calls, ['verify', 'run']);
});
test('bridge container wrapper refuses host execution before SDK/native/callback access', () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts/badcase-capture/retained-caff-bridge-container.cjs')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'retained_caff_bridge_failed\n');
});
