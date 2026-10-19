// Captured capsule -> effective production SDK config planning. NO SDK execution.
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const api = () => require('../../build/server/domain/runtime/badcase-capture/caff-replay-start');
function inputs(t, mode = 'fresh', platform = 'linux') {
  const root = platform === 'win32' ? 'C:\\source\\project' : '/source/project', sep = platform === 'win32' ? '\\' : '/';
  const ext = platform === 'win32' ? 'C:\\installed\\lib\\pi-extensions\\caff-capabilities.mjs' : '/installed/lib/pi-extensions/caff-capabilities.mjs';
  const h = fixture(t, mode, ({ cp, r, config, session, put }) => {
    cp.targetDir = root; cp.files['source.txt'].mode = 0o100644;
    for (const [name, content] of [['.agent/settings.json', '{"compaction":{"enabled":true},"retry":{"enabled":true,"maxRetries":7}}'],
      ['.agent/SYSTEM.md', 'Archived role instructions'], ['skills/contract/SKILL.md', '# Archived contract skill']]) {
      cp.files[name] = { type: 'file', mode: 0o100600, size: Buffer.byteLength(content), hash: put(content) };
    }
    config.toolBridgeEnabled = true;
    config.sdkStartConfig = { provider: r.runConfig.provider, model: r.runConfig.model, thinking: 'high', agentDir: root + sep + '.agent',
      cwd: root, resume: mode === 'resume', sessionPath: mode === 'resume' ? root + sep + 'old.jsonl' : '', heartbeatIntervalMs: 0,
      extensionPaths: [ext], additionalSkillPaths: [root + sep + 'skills' + sep + 'contract'], retireUserScopeSkills: true };
    r.harness.configSnapshotHash = put(JSON.stringify(config));
    r.promptBlobHash = r.normalizedPromptHash = put('Inspect ' + root);
    if (mode === 'resume') { session[0].cwd = root; r.sessionBlobHash = put(session.map(e => JSON.stringify(e)).join('\r\n') + '\r\n'); }
  });
  const p = prepareRetainedInitializationCapsule(h.request), expected = { capsuleHash: p.capsuleHash, checkpointChecksum: p.provenance.checkpointChecksum };
  const worktree = { schemaVersion: 1, sourcePlatform: platform, sourceRoot: root, mappings: [
    { input: 'prompt', start: 8, end: 8 + root.length, sourcePath: root },
    ...(mode === 'resume' ? [{ input: 'session', line: 0, pointer: '/cwd', start: 0, end: root.length, sourcePath: root }] : []),
  ] };
  const config = JSON.parse(h.store.readBlob('p1', h.r.harness.configSnapshotHash)).sdkStartConfig;
  const bindings = [['/cwd', config.cwd, '/work/restored/snapshot'], ['/agentDir', config.agentDir, '/work/restored/snapshot/.agent'],
    ['/extensionPaths/0', ext, '/work/build/lib/pi-extensions/caff-capabilities.mjs'],
    ['/additionalSkillPaths/0', config.additionalSkillPaths[0], '/work/restored/snapshot/skills/contract'],
    ...(mode === 'resume' ? [['/sessionPath', config.sessionPath, '/work/restored/working-inputs/session.jsonl']] : [])]
    .map(([pointer, sourcePath, targetPath]) => ({ pointer, sourcePath, targetPath }));
  return { capsule: p.capsule, expected, worktree, declaration: { schemaVersion: 1, sdkConfigHash: hash(JSON.stringify(config)), bindings } };
}
function run(v) { return api().planRetainedCaffStart(v.capsule, v.expected, v.worktree, v.declaration); }
// Mutate a VERIFIED in-memory capsule; rehash the complete closure. No store I/O.
function change(v, mutate) {
  const d = JSON.parse(v.capsule), r = d.checkpoint.replayInput;
  const blob = d.blobs.find(b => b.sha256 === r.harness.configSnapshotHash), config = JSON.parse(Buffer.from(blob.base64, 'base64'));
  mutate(config, d.checkpoint, d);
  const content = JSON.stringify(config), old = blob.sha256; blob.sha256 = hash(content); blob.base64 = Buffer.from(content).toString('base64');
  r.harness.configSnapshotHash = blob.sha256;
  // Other fixture blobs are not shared with the config blob.
  assert.notEqual(old, blob.sha256);
  v.capsule = JSON.stringify(d); v.expected = { capsuleHash: hash(v.capsule), checkpointChecksum: hash(JSON.stringify(d.checkpoint)) };
  v.declaration.sdkConfigHash = hash(JSON.stringify(config.sdkStartConfig));
}
function rejected(v, code = 'replay_sdk_config_invalid') { assert.throws(() => run(v), { code }); }

test('fresh/resume and Windows/Linux source capsules preserve all non-path SDK settings and original materials', t => {
  for (const mode of ['fresh', 'resume']) for (const platform of ['linux', 'win32']) {
    const v = inputs(t, mode, platform), before = JSON.stringify(v), p = run(v);
    assert.equal(p.config.cwd, '/work/restored/snapshot'); assert.equal(p.config.agentDir, '/work/restored/snapshot/.agent');
    assert.equal(p.config.resume, mode === 'resume'); assert.equal(p.config.sessionPath, mode === 'resume' ? '/work/restored/working-inputs/session.jsonl' : '');
    assert.equal(p.config.thinking, 'high'); assert.equal(p.config.heartbeatIntervalMs, 0); assert.equal(p.config.retireUserScopeSkills, true);
    assert.equal(p.config.model, p.archivedHarness.sdkStartConfig.model); assert.equal(p.config.provider, p.archivedHarness.sdkStartConfig.provider);
    assert.deepEqual(p.config.additionalSkillPaths, ['/work/restored/snapshot/skills/contract']);
    assert.deepEqual(p.config.extensionPaths, ['/work/build/lib/pi-extensions/caff-capabilities.mjs']);
    assert.equal(p.invocation, 'Inspect /work/restored/snapshot');
    if (mode === 'resume') { assert.ok(p.sessionText.endsWith('\r\n')); assert.equal(JSON.parse(p.sessionText.split('\n')[0]).cwd, p.config.cwd); }
    else assert.equal(p.sessionText, null);
    assert.equal(p.receipt.effectiveConfigHash, hash(JSON.stringify(p.config)));
    for (const key of ['sdkInitialized', 'invocationSubmitted', 'launchAuthorized', 'runnable', 'reproduced', 'evaluable', 'strictEvalEligible']) assert.equal(p.receipt[key], false);
    assert.equal(JSON.stringify(v), before); p.archivedHarness.sdkStartConfig.thinking = 'changed'; assert.equal(run(v).archivedHarness.sdkStartConfig.thinking, 'high');
  }
});
test('planning never inspects any source path or writes material; path strings are only declarations', t => {
  const fs = require('node:fs'), v = inputs(t, 'resume'); api();
  const methods = ['readFileSync', 'openSync', 'lstatSync', 'realpathSync', 'mkdirSync', 'writeFileSync'], old = new Map();
  let touches = 0, result, error;
  try {
    for (const key of methods) { old.set(key, fs[key]); fs[key] = () => { touches++; throw Error('source_io_forbidden'); }; }
    try { result = run(v); } catch (e) { error = e; }
  } finally { for (const [key, value] of old) fs[key] = value; }
  assert.equal(error, undefined); assert.equal(touches, 0); assert.equal(result.receipt.deliveryMode, 'resume');
});

test('legacy summary, unknown SDK keys, mismatched model/mode/version and absent settings never turn into defaults', t => {
  for (const mutate of [h => { delete h.sdkStartConfig; }, h => { h.sdkStartConfig.unknown = true; }, h => { h.sdkStartConfig.model = 'different'; },
    h => { h.sdkStartConfig.resume = true; }, h => { h.piVersion = '9'; }, h => { h.sdkStartConfig.thinking = 'guess'; },
    h => { h.sdkStartConfig.heartbeatIntervalMs = -1; }, h => { h.sdkStartConfig.heartbeatIntervalMs = '0'; },
    h => { h.sdkStartConfig.retireUserScopeSkills = 'true'; }, h => { h.sdkStartConfig.cwd += '/other'; },
    h => { h.sdkStartConfig.sessionPath = '/historical/nonempty-fresh.jsonl'; }]) {
    const v = inputs(t); const d = JSON.parse(v.capsule), blob = d.blobs.find(b => b.sha256 === d.checkpoint.replayInput.harness.configSnapshotHash);
    const h = JSON.parse(Buffer.from(blob.base64, 'base64')); mutate(h);
    const c = JSON.stringify(h); blob.sha256 = hash(c); blob.base64 = Buffer.from(c).toString('base64'); d.checkpoint.replayInput.harness.configSnapshotHash = blob.sha256;
    v.capsule = JSON.stringify(d); v.expected = { capsuleHash: hash(v.capsule), checkpointChecksum: hash(JSON.stringify(d.checkpoint)) };
    assert.throws(() => run(v), /replay_sdk_config_(missing|invalid)/);
  }
});
test('all bindings are explicit, hash-bound, unique and closed; arbitrary destinations cannot escape the restored worktree', t => {
  for (const mutate of [v => { v.declaration.sdkConfigHash = '0'.repeat(64); }, v => { v.declaration.bindings.pop(); },
    v => { v.declaration.bindings.push(v.declaration.bindings[0]); }, v => { v.declaration.bindings[0].sourcePath += 'x'; },
    v => { v.declaration.bindings[0].targetPath = '/production'; }, v => { v.declaration.extra = true; },
    v => { v.declaration.bindings[0].pointer = '/thinking'; }, v => { v.declaration.bindings[0].extra = true; }]) {
    const v = inputs(t, 'resume'); mutate(v); rejected(v, 'replay_sdk_bindings_invalid');
  }
});
test('distinct source extensions cannot collapse to one destination and change host deduplication semantics', t => {
  const v = inputs(t), second = '/other/lib/pi-extensions/caff-capabilities.mjs';
  change(v, h => { h.sdkStartConfig.extensionPaths.push(second); });
  v.declaration.bindings.push({ pointer: '/extensionPaths/1', sourcePath: second, targetPath: '/work/build/lib/pi-extensions/caff-capabilities.mjs' });
  rejected(v, 'replay_sdk_bindings_invalid');
});

test('external agent/skill paths are blocked rather than dropped, while extra archive config remains intact', t => {
  for (const key of ['agentDir', 'additionalSkillPaths']) {
    const v = inputs(t); change(v, h => { if (key === 'agentDir') h.sdkStartConfig.agentDir = '/outside/agent'; else h.sdkStartConfig.additionalSkillPaths[0] = '/outside/skill'; });
    const b = v.declaration.bindings.find(b => b.pointer === (key === 'agentDir' ? '/agentDir' : '/additionalSkillPaths/0'));
    b.sourcePath = key === 'agentDir' ? '/outside/agent' : '/outside/skill'; rejected(v, 'replay_sdk_external_dependency');
  }
  const v = inputs(t); change(v, h => { h.futureHarness = { preserved: [1, 2] }; }); assert.deepEqual(run(v).archivedHarness.futureHarness, { preserved: [1, 2] });
});
test('missing role/settings and credential files cannot be replaced by synthetic agent defaults', t => {
  for (const name of ['.agent/SYSTEM.md', '.agent/settings.json']) {
    const v = inputs(t); change(v, (h, cp, data) => {
      h.fixtureChange = name; const old = cp.files[name].hash; delete cp.files[name];
      data.blobs = data.blobs.filter(b => b.sha256 !== old);
    });
    rejected(v, 'replay_sdk_dependency_missing');
  }
  const v = inputs(t); change(v, (h, cp, data) => {
    h.fixtureChange = 'auth'; const content = '{}', sha = hash(content);
    cp.files['.agent/Auth.json'] = { type: 'file', mode: 0o100600, size: 2, hash: sha };
    data.blobs.push({ sha256: sha, base64: Buffer.from(content).toString('base64') });
  }); rejected(v, 'replay_sdk_auth_forbidden');
});
test('external extension bindings reject aliases and wrong distribution modules, not just arbitrary target paths', t => {
  for (const ext of ['/installed/../installed/lib/pi-extensions/caff-capabilities.mjs',
    '/installed/lib/pi-extensions/other.mjs', 'relative/lib/pi-extensions/caff-capabilities.mjs']) {
    const v = inputs(t); change(v, h => { h.sdkStartConfig.extensionPaths[0] = ext; });
    v.declaration.bindings.find(b => b.pointer === '/extensionPaths/0').sourcePath = ext;
    rejected(v, 'replay_sdk_bindings_invalid');
  }
});
test('resume stays resume, missing session/mapping fails and cannot be silently opened fresh', t => {
  const v = inputs(t, 'resume'); v.declaration.bindings = v.declaration.bindings.filter(b => b.pointer !== '/sessionPath'); rejected(v, 'replay_sdk_bindings_invalid');
  const w = inputs(t, 'resume'); change(w, h => { h.sdkStartConfig.sessionPath = ''; }); rejected(w);
  const x = inputs(t, 'resume'); x.worktree.mappings = x.worktree.mappings.filter(m => m.input !== 'session');
  assert.throws(() => run(x), { code: 'replay_worktree_mapping_invalid' });
});
