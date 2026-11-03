// Inert host staging and container-boundary tests. Never import the SDK on host.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fixture = require('../helpers/badcase-caff-replay-fixture.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const inventory = require('../../scripts/badcase-capture/evaluation-bridge-files.json');
const repo = path.resolve(__dirname, '../..');
const image = { imageId: 'sha256:' + 'a'.repeat(64), repositoryDigest: 'test.invalid/base@sha256:' + 'b'.repeat(64),
  architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const api = () => require('../../scripts/badcase-capture/retained-caff-initialization.cjs');
const planner = v => require('../../build/server/domain/runtime/badcase-capture/caff-replay-start')
  .planRetainedCaffInitialization(v.capsule, v.expected, v.worktree, v.bindings);
function dependencies(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-caff-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of inventory.dependencies) {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    let b = fs.readFileSync(path.join(repo, name));
    if (name.endsWith('better_sqlite3.node')) { b = Buffer.alloc(64); b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); b.writeUInt16LE(3, 16); b.writeUInt16LE(62, 18); }
    fs.writeFileSync(target, b);
  }
  return root;
}
function resign(v, change) {
  const d = JSON.parse(v.capsule); change(d); v.capsule = JSON.stringify(d);
  v.expected = { capsuleHash: hash(v.capsule), checkpointChecksum: hash(JSON.stringify(d.checkpoint)) };
}
test('initialization planning preserves full config and CRLF/assistant/custom-message history without replacing it', t => {
  for (const mode of ['fresh', 'resume']) for (const platform of ['linux', 'win32']) {
    const v = fixture(t, mode, platform), p = planner(v);
    assert.equal(p.config.thinking, 'off'); assert.equal(p.config.resume, mode === 'resume');
    assert.equal(p.config.retireUserScopeSkills, true); assert.equal(p.config.heartbeatIntervalMs, 0);
    assert.equal(p.sessionEntries.length, mode === 'resume' ? 5 : 0);
    if (mode === 'resume') { assert.equal(p.sessionEntries.at(-1).type, 'custom_message'); assert.ok(p.sessionText.endsWith('\r\n')); }
    assert.equal(p.receipt.sdkInitialized, false); assert.equal(p.receipt.runnable, false);
  }
});
test('unapplied variables and corrupt resume trees refuse before any installed-source read or transport', async t => {
  const cases = [v => { v.expected.capsuleHash = '0'.repeat(64); },
    v => resign(v, d => { d.checkpoint.replayInput.controlledReplacements.push({ field: 'missing' }); }),
    v => resign(v, d => { const r = d.checkpoint.replayInput, b = d.blobs.find(b => b.sha256 === r.sessionBlobHash);
      const entries = Buffer.from(b.base64, 'base64').toString().trim().split('\n').map(JSON.parse); entries[3].parentId = 'absent';
      const text = entries.map(JSON.stringify).join('\n') + '\n'; b.base64 = Buffer.from(text).toString('base64'); b.sha256 = hash(text); r.sessionBlobHash = b.sha256; }),
    v => resign(v, d => { const r = d.checkpoint.replayInput, b = d.blobs.find(b => b.sha256 === r.promptBlobHash);
      const text = '{{UNRESOLVED}}'; b.base64 = Buffer.from(text).toString('base64'); b.sha256 = hash(text); r.promptBlobHash = r.normalizedPromptHash = b.sha256; v.worktree.mappings = v.worktree.mappings.filter(m => m.input !== 'prompt'); })];
  for (const change of cases) {
    const v = fixture(t, 'resume'); change(v); let calls = 0;
    await assert.rejects(api().runRetainedCaffInitialization('/missing', '/missing', image, v, { runProbe: async () => { calls++; } }), /capsule_|replay_/);
    assert.equal(calls, 0);
  }
});
test('frozen read/bash/unknown historical calls remain context in retained initialization, not current execution dependencies', t => {
  for (const name of ['read', 'bash', 'retired-tool']) {
    const v = fixture(t, 'resume'), call = { type: 'toolCall', id: 'c', name, arguments: { path: '/old/context-only', command: 'historical-command-never-run' } };
    resign(v, d => { const r = d.checkpoint.replayInput, b = d.blobs.find(b => b.sha256 === r.sessionBlobHash);
      const entries = Buffer.from(b.base64, 'base64').toString().trim().split('\n').map(JSON.parse);
      entries[3].message.content = [call];
      const text = entries.map(JSON.stringify).join('\n') + '\n'; b.base64 = Buffer.from(text).toString('base64'); b.sha256 = hash(text); r.sessionBlobHash = b.sha256; });
    const p = planner(v);
    assert.deepEqual(p.sessionEntries[3].message.content, [call]);
    assert.equal(p.receipt.runnable, false); assert.equal(p.receipt.sdkInitialized, false);
  }
});
test('forged complete flags cannot bypass original session structure/extension checks', t => {
  for (const change of [entries => { delete entries[3].message.usage; }, entries => { entries[4].type = 'custom'; entries[4].data = { private: true }; },
    entries => { entries[3].id = entries[0].id; }, entries => { entries[2].timestamp = ''; }]) {
    const v = fixture(t, 'resume');
    resign(v, d => { const r = d.checkpoint.replayInput, b = d.blobs.find(b => b.sha256 === r.sessionBlobHash);
      const entries = Buffer.from(b.base64, 'base64').toString().trim().split('\n').map(JSON.parse); change(entries);
      const text = entries.map(JSON.stringify).join('\n') + '\n'; b.base64 = Buffer.from(text).toString('base64'); b.sha256 = hash(text); r.sessionBlobHash = b.sha256; });
    assert.throws(() => planner(v), /replay_sdk_session_(invalid|unverified)/);
  }
});
test('staging binds capsule/declarations, production host, restoration closure and new entry without executing them', t => {
  const root = dependencies(t), v = fixture(t, 'resume', 'win32'), before = JSON.stringify(v);
  const files = api().prepareRetainedCaffFiles(repo, root, image, v), m = manifestFor(files);
  assert.equal(files.filter(f => f.path === 'build/server/domain/runtime/badcase-capture/session-validator.js').length, 1, 'shared runtime already stages session validator');
  assert.ok(m.runtimeBytes > 0); assert.equal(JSON.stringify(v), before);
  for (const [name, value] of [['capsule.json', v.capsule], ['expected.json', JSON.stringify(v.expected)],
    ['worktree.json', JSON.stringify(v.worktree)], ['bindings.json', JSON.stringify(v.bindings)]]) {
    assert.equal(files.find(f => f.path === name).bytes.toString(), value);
  }
  for (const name of ['capsule-materialization', 'worktree-replay-inputs', 'worktree-replay-materialization', 'caff-replay-start', 'session-validator']) {
    assert.deepEqual(files.find(f => f.path === 'build/server/domain/runtime/badcase-capture/' + name + '.js').bytes,
      fs.readFileSync(path.join(repo, 'build/server/domain/runtime/badcase-capture/' + name + '.js')));
  }
  assert.deepEqual(files.find(f => f.path === 'caff-runtime-bootstrap.cjs').bytes, fs.readFileSync(path.join(repo, 'scripts/badcase-capture/caff-runtime-container.cjs')));
  const entry = files.find(f => f.path === 'probe.cjs').bytes.toString();
  assert.match(entry, /materializeWorktreeReplayInputs/); assert.match(entry, /createSdkRuntime/);
  assert.doesNotMatch(entry, /session\.prompt\(|SettingsManager\.inMemory|resourceLoader\s*:/);
});
test('local rg derivative stages with the same strict base image schema and rejects unknown recipes', t => {
  const root = dependencies(t), v = fixture(t);
  const files = api().prepareRetainedCaffFiles(repo, root, { ...image, localBuild: 'wikiskill-rg13-v1' }, v);
  assert.equal(JSON.parse(files.find(f => f.path === 'environment.json').bytes).localBuild, 'wikiskill-rg13-v1');
  assert.throws(() => api().prepareRetainedCaffFiles(repo, root, { ...image, localBuild: 'unknown' }, v));
});
test('transport checks exact manifest and bounded observed hashes, never raw material output or silent mode fallback', async t => {
  const root = dependencies(t), a = api();
  for (const mode of ['fresh', 'resume']) {
    const v = fixture(t, mode), p = planner(v); let calls = 0;
    const runProbe = async (i, files) => { calls++; const manifest = manifestFor(files);
      const observation = { historyHash: hash('[]'), historyMessages: mode === 'fresh' ? 0 : 3, systemPromptHash: hash('role'), toolsHash: hash('tools') };
      return { manifest, containerId: 'c'.repeat(64), result: { code: 0, stderr: '', stdout: JSON.stringify({ ...a.initializationReceipt(manifest, i, p), observation }) + '\n' } }; };
    const r = await a.runRetainedCaffInitialization(repo, root, image, v, { runProbe });
    assert.equal(r.cleaned, true); assert.equal(r.deliveryMode, mode); assert.equal(r.sdkInitialized, true);
    assert.equal(r.invocationSubmitted, false); assert.equal(r.callbackWired, false); assert.equal(r.runnable, false); assert.equal(calls, 1);
    for (const mutate of [r => { r.manifest.files.pop(); }, r => { r.containerId = 'bad'; }, r => { r.result.stderr = 'private'; },
      r => { r.result.failure = 'timeout'; }, r => { r.result.code = 1; }, r => { r.result.stdout += ' '; },
      r => { const d = JSON.parse(r.result.stdout); d.observation.systemPromptHash = 'private'; r.result.stdout = JSON.stringify(d) + '\n'; },
      r => { const d = JSON.parse(r.result.stdout); d.runnable = true; r.result.stdout = JSON.stringify(d) + '\n'; }]) {
      calls = 0;
      await assert.rejects(a.runRetainedCaffInitialization(repo, root, image, v, { runProbe: async (...args) => { const r = await runProbe(...args); mutate(r); return r; } }), /retained_caff_initialization_failed/);
      assert.equal(calls, 1);
    }
  }
});
test('default transport pins image and exec-work option; staging errors stop before transport', async t => {
  const root = dependencies(t), v = fixture(t), Module = require('node:module');
  const filename = path.join(repo, 'scripts/badcase-capture/retained-caff-initialization.cjs');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod), calls = [];
  mod.require = name => name === './verify-pi-initialization.cjs' ? {
    verifyProbeImage: async i => { assert.deepEqual(i, image); calls.push('verify'); },
    runProbe: async (i, f, options) => { assert.deepEqual(calls, ['verify']); assert.deepEqual(options, { executableWork: true }); calls.push('run'); throw Error('inert_transport'); },
  } : original(name);
  mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  await assert.rejects(mod.exports.runRetainedCaffInitialization(repo, root, image, v), /retained_caff_initialization_failed/);
  assert.deepEqual(calls, ['verify', 'run']);
});
test('actual container entry restores capsule before original factory and verifies both mode histories, with disposal before success', async t => {
  const harness = require('../helpers/badcase-retained-caff-vm.cjs');
  for (const mode of ['fresh', 'resume']) {
    const h = harness(fixture(t, mode), image), r = await h.run();
    assert.equal(r.deliveryMode, mode); assert.equal(r.sdkInitialized, true); assert.equal(r.observation.historyMessages, mode === 'resume' ? 3 : 0);
    assert.equal(r.historyVerified, true); assert.equal(r.archivedResourcesVerified, true); assert.equal(r.modelGuardBeforeFactory, true);
    assert.equal(r.callbackWired, false); assert.equal(r.modelCalls, 0); assert.equal(r.externalFetchCalls, 0);
    assert.equal(r.runnable, false); assert.equal(r.invocationSubmitted, false); assert.equal(h.disposals(), 1);
    assert.ok(h.events.indexOf('restore') < h.events.indexOf('load:/work/runtime/dist/bundle/index.js'));
    assert.ok(h.events.indexOf('load:/work/build/lib/pi-sdk-host.mjs') < h.events.indexOf('factory'));
    assert.equal(h.events.at(-1), 'dispose'); assert.equal(h.context.fetch, h.originalFetch); assert.deepEqual(h.context.process.env, {});
  }
});
test('container rejects missing session/config drift/invalid history and loader/model/archive errors; cleanup failure cannot succeed', async t => {
  const harness = require('../helpers/badcase-retained-caff-vm.cjs');
  for (const options of [{ guardFailure: true }, { wrongMode: true }, { restoreFailure: true }, { missingSession: true },
    { importFailure: true }, { configDrift: true }, { wrongHistory: true }, { wrongId: true }, { loaderError: true },
    { extensionError: true }, { fallback: true }, { wrongModel: true }, { archiveTamper: true }, { modelAttempt: true },
    { networkAttempt: true }, { disposeFailure: true }]) {
    const h = harness(fixture(t, 'resume'), image, options); await assert.rejects(h.run());
    const factoryCalled = h.events.includes('factory'); assert.equal(h.disposals(), factoryCalled ? 1 : 0);
    if (options.guardFailure) assert.deepEqual(h.reads, []);
    if (options.missingSession || options.restoreFailure || options.wrongMode || options.guardFailure) assert.deepEqual(h.loads, []);
    assert.equal(h.context.fetch, h.originalFetch); assert.deepEqual(h.context.process.env, {});
  }
});
test('valid custom session state with unverified dimensions hits the dedicated guard, not structural rejection', t => {
  const v = fixture(t, 'resume');
  resign(v, d => { const r = d.checkpoint.replayInput, b = d.blobs.find(b => b.sha256 === r.sessionBlobHash);
    const entries = Buffer.from(b.base64, 'base64').toString().trim().split('\n').map(JSON.parse);
    entries.push({ type: 'custom', id: 'private-state', parentId: 'm3', timestamp: '2026-01-01T00:00:00.004Z', customType: 'private-extension', data: { count: 1 } });
    const text = entries.map(JSON.stringify).join('\n') + '\n';
    const checked = require('../../build/server/domain/runtime/badcase-capture/session-validator').validateSessionV2(text, { authorizedRoot: '' });
    assert.equal(checked.ok, true); assert.ok(checked.unverifiedDimensions.some(s => s.startsWith('extension_state_unverified:')));
    b.base64 = Buffer.from(text).toString('base64'); b.sha256 = hash(text); r.sessionBlobHash = b.sha256;
  });
  assert.throws(() => planner(v), { code: 'replay_sdk_session_unverified' });
});
test('named fresh refuses existing or dangling destinations before SDK loading and verifies the exact opened file', async t => {
  const harness = require('../helpers/badcase-retained-caff-vm.cjs');
  for (const options of [{ existingFresh: true }, { danglingFresh: true }]) {
    const h = harness(fixture(t), image, options); await assert.rejects(h.run());
    assert.deepEqual(h.loads, []); assert.equal(h.disposals(), 0); assert.equal(h.modelGuardRestored(), true);
  }
  const h = harness(fixture(t), image, { wrongSessionFile: true }); await assert.rejects(h.run()); assert.equal(h.disposals(), 1);
});
test('archived role bytes and settings are observed in actual factory resources, not merely present on disk', async t => {
  const harness = require('../helpers/badcase-retained-caff-vm.cjs');
  for (const options of [{ wrongRole: true }, { wrongLoadedRole: true }, { wrongComposedRole: true }, { wrongRoleSource: true }, { wrongSettings: true }]) {
    const h = harness(fixture(t), image, options); await assert.rejects(h.run());
    assert.equal(h.disposals(), 1); assert.equal(h.modelGuardRestored(), true);
  }
});
test('all pinned ModelRuntime request methods are guarded before the factory and restored on success and failure', async t => {
  const harness = require('../helpers/badcase-retained-caff-vm.cjs');
  for (const name of ['stream', 'complete', 'streamSimple', 'completeSimple', 'streamDeferred', 'fetchDeferred', 'cancelDeferred']) {
    const h = harness(fixture(t), image, { modelDuringFactory: name }); await assert.rejects(h.run());
    assert.equal(h.events.some(e => e.startsWith('unguarded-model:')), false); assert.equal(h.modelGuardRestored(), true);
  }
  const h = harness(fixture(t), image), r = await h.run(); assert.equal(r.modelCalls, 0); assert.equal(h.modelGuardRestored(), true);
});

test('retained container entry rejects host execution before capsule restoration or SDK import', () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts/badcase-capture/retained-caff-container.cjs')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'retained_caff_initialization_failed\n');
});
