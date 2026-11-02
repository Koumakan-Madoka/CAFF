const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { createCheckpointRetentionStore } = require('../../build/server/domain/runtime/badcase-capture/checkpoint-retention');
const { createReplayRunReferenceStore } = require('../../build/server/domain/runtime/badcase-capture/run-references');
const { acquireProjectWriteLease } = require('../../build/server/domain/runtime/badcase-capture/project-write-lock');
const { inspectOrphanBlobs, collectOrphanBlobs } = require('../../build/server/domain/runtime/badcase-capture/orphan-gc');
const code = wanted => e => e.code === wanted;
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-orphan-gc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root });
  const blob = text => { const bytes = Buffer.from(text), hash = sha256Hex(bytes); store.writeBlob('p1', hash, bytes); return hash; };
  const kept = blob('kept file'), prompt = blob('kept prompt'), orphan = blob('unreferenced capture attempt');
  const scope = { projectId: 'p1', checkpointId: 'cp1', conversationId: 'c1', turnId: 't1', agentId: 'a1', referenceId: 'flag-one' };
  const checkpoint = { schemaVersion: 1, projectId: 'p1', checkpointId: 'cp1', conversationId: 'c1', turnId: 't1', agentId: 'a1',
    files: { 'one.txt': { type: 'file', hash: kept, size: 9 } }, replayInput: { complete: false, deliveryMode: 'fresh', incompleteReasons: [], promptBlobHash: prompt, harness: { skillSnapshots: [] } } };
  store.saveCheckpoint('p1', checkpoint);
  const q = { captureRoot: root, projectId: 'p1' }, dir = path.join(root, 'projects/p1');
  const file = hash => path.join(dir, 'blobs', hash.slice(0, 2), hash);
  const retain = () => createCheckpointRetentionStore({ captureStore: store }).retain(scope);
  const run = () => createReplayRunReferenceStore({ captureStore: store }).protect({ ...scope, replayRunId: 'run-one' });
  return { root, dir, store, blob, kept, prompt, orphan, scope, checkpoint, q, file, retain, run };
}
function tree(root) {
  const result = {};
  function walk(dir) { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name), stat = fs.lstatSync(file); if (stat.isDirectory()) walk(file); else result[path.relative(root, file)] = stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString('hex'); } }
  walk(root); return result;
}
const collect = (h, plan = inspectOrphanBlobs(h.q)) => collectOrphanBlobs(h.q, { confirmed: true, expected: plan.planHash });
test('preview is nondeleting and explicit collection removes only unreferenced CAS bytes', t => {
  const h = setup(t), before = tree(h.root), usage = h.store.computeUsage('p1');
  const plan = inspectOrphanBlobs(h.q);
  assert.deepEqual(tree(h.root), before); assert.equal(plan.deletionAuthorized, false);
  assert.deepEqual(plan.candidates, [{ hash: h.orphan, bytes: Buffer.byteLength('unreferenced capture attempt') }]);
  assert.equal(plan.protectedBlobCount, 2); assert.equal(plan.candidateBytes, plan.candidates[0].bytes);
  assert.deepEqual(inspectOrphanBlobs(h.q), plan);
  const result = collect(h, plan);
  assert.deepEqual(result, { planHash: plan.planHash, deletedBlobCount: 1, reclaimedBytes: plan.candidateBytes });
  assert.ok(fs.existsSync(h.file(h.kept))); assert.ok(fs.existsSync(h.file(h.prompt))); assert.equal(fs.existsSync(h.file(h.orphan)), false);
  assert.equal(h.store.computeUsage('p1').totalBytes, usage.totalBytes - plan.candidateBytes);
  assert.equal(inspectOrphanBlobs(h.q).candidates.length, 0);
  assert.throws(() => collect(h, plan), code('orphan_gc_plan_changed'));
});
test('retained and run closures survive changed/deleted live manifests and failed/completed run guesses', t => {
  const h = setup(t); h.retain(); h.run();
  const before = tree(path.join(h.dir, 'retention')), runs = tree(path.join(h.dir, 'runReferences'));
  fs.unlinkSync(path.join(h.dir, 'checkpoints/cp1.json'));
  collect(h);
  assert.deepEqual(tree(path.join(h.dir, 'retention')), before); assert.deepEqual(tree(path.join(h.dir, 'runReferences')), runs);
  assert.ok(fs.existsSync(h.file(h.kept))); assert.ok(fs.existsSync(h.file(h.prompt)));
  assert.throws(() => collectOrphanBlobs(h.q, { confirmed: true, expected: inspectOrphanBlobs(h.q).planHash, completed: true }), code('orphan_gc_invalid'));
});
test('shared CAS, session/config/skill and conservative unknown hash fields remain protected', t => {
  const h = setup(t);
  h.checkpoint.replayInput.sessionBlobHash = h.blob('session');
  h.checkpoint.replayInput.harness.configSnapshotHash = h.blob('config');
  const skill = h.blob('skill'); h.checkpoint.replayInput.harness.skillSnapshots = [{ sha256: skill, blobHash: skill }];
  h.checkpoint.futureMetadata = { potentialReference: h.orphan }; // overprotect rather than guess
  h.store.saveCheckpoint('p1', h.checkpoint);
  h.store.saveCheckpoint('p1', { ...h.checkpoint, checkpointId: 'cp2' });
  const p = inspectOrphanBlobs(h.q); assert.equal(p.protectedBlobCount, 6); assert.equal(p.candidates.length, 0);
  assert.equal(collect(h, p).deletedBlobCount, 0);
});
test('preview is not permission: new checkpoint or retained reference invalidates expected plan before any unlink', t => {
  for (const change of ['checkpoint', 'pin', 'new-orphan', 'replace']) {
    const h = setup(t), p = inspectOrphanBlobs(h.q);
    if (change === 'checkpoint') h.store.saveCheckpoint('p1', { ...h.checkpoint, checkpointId: 'cp2', extraHash: h.orphan });
    if (change === 'pin') h.retain();
    if (change === 'new-orphan') h.blob('another orphan');
    if (change === 'replace') { fs.unlinkSync(h.file(h.orphan)); fs.writeFileSync(h.file(h.orphan), 'replacement'); }
    const before = tree(h.root);
    assert.throws(() => collect(h, p), code('orphan_gc_plan_changed')); assert.deepEqual(tree(h.root), before);
  }
});
test('malformed/unknown/partial inventories, missing referenced objects and stage leftovers block without deletion', t => {
  for (const change of ['checkpoint-json', 'checkpoint-schema', 'retention', 'run', 'partial', 'stage', 'unknown', 'missing', 'latest', 'case']) {
    const h = setup(t); h.retain(); h.run();
    if (change === 'checkpoint-json') fs.writeFileSync(path.join(h.dir, 'checkpoints/cp1.json'), '{');
    if (change === 'checkpoint-schema') h.store.saveCheckpoint('p1', { ...h.checkpoint, schemaVersion: 2 });
    if (change === 'retention') fs.writeFileSync(path.join(h.dir, 'retention', sha256Hex(h.scope.referenceId) + '.json'), '{}');
    if (change === 'run') fs.writeFileSync(path.join(h.dir, 'runReferences', sha256Hex('run-one') + '.json'), '{}');
    if (change === 'partial') fs.writeFileSync(h.file(h.orphan) + '.tmp-left', 'keep');
    if (change === 'stage') { fs.mkdirSync(path.join(h.dir, 'staging')); fs.writeFileSync(path.join(h.dir, 'staging/unfinished'), 'keep'); }
    if (change === 'unknown') fs.mkdirSync(path.join(h.dir, 'futureReferences'));
    if (change === 'missing') fs.unlinkSync(h.file(h.kept));
    if (change === 'latest') h.store.saveLatestCheckpointId('p1', h.root, 'missing');
    if (change === 'case') { fs.mkdirSync(path.join(h.dir, 'cases')); fs.writeFileSync(path.join(h.dir, 'cases', 'a'.repeat(64) + '.json'), '{}'); }
    const before = tree(h.root);
    assert.throws(() => inspectOrphanBlobs(h.q), code('orphan_gc_inventory_invalid'));
    assert.throws(() => collectOrphanBlobs(h.q, { confirmed: true, expected: 'a'.repeat(64) }), code('orphan_gc_inventory_invalid'));
    assert.deepEqual(tree(h.root), before);
  }
});
test('malformed flags refuse collection', t => {
  for (const value of [{}, { schemaVersion: 1, record: { schemaVersion: 2 } }]) {
    const h = setup(t); fs.mkdirSync(path.join(h.dir, 'flags'));
    fs.writeFileSync(path.join(h.dir, 'flags', sha256Hex('m1') + '.json'), JSON.stringify(value));
    const before = tree(h.root);
    assert.throws(() => inspectOrphanBlobs(h.q), code('orphan_gc_inventory_invalid'));
    assert.deepEqual(tree(h.root), before);
  }
});
test('real sealed-case and marked associations preserve their retained blobs with no live checkpoint', t => {
  const h = setup(t);
  const { createBadcaseFlagService } = require('../../build/server/domain/runtime/badcase-capture/badcase-flags');
  const { saveSealedCase } = require('../../build/server/domain/runtime/badcase-capture/sealed-case');
  const association = { projectId: 'p1', conversationId: 'c1', messageId: 'm1', turnId: 't1', agentId: 'a1', taskId: 'task1', checkpointId: 'cp1', runId: 1 };
  const flags = createBadcaseFlagService({ captureRoot: h.root, captureStore: h.store, chatStore: {
    getConversationWithoutMessages: () => ({ projectScopeId: 'p1' }),
    getMessage: () => ({ id: 'm1', ...association, role: 'assistant', status: 'completed', metadata: { badcaseCheckpointId: 'cp1' } }),
  } });
  const flag = flags.mark({ projectId: 'p1', conversationId: 'c1', messageId: 'm1', actual: 'bad', expected: 'good' }).flag;
  saveSealedCase({ captureRoot: h.root, association, flagId: flag.flagId });
  h.store.saveLatestCheckpointId('p1', h.root, 'cp1');
  fs.unlinkSync(path.join(h.dir, 'checkpoints/cp1.json'));
  const before = tree(h.root), p = inspectOrphanBlobs(h.q); collect(h, p);
  const after = tree(h.root); delete before[path.relative(h.root, h.file(h.orphan))]; assert.deepEqual(after, before);
  fs.unlinkSync(path.join(h.dir, 'retention', sha256Hex(flag.flagId) + '.json'));
  assert.throws(() => inspectOrphanBlobs(h.q), code('orphan_gc_inventory_invalid'));
});
test('missing root, relative root, path traversal and unconfirmed requests cannot create storage', t => {
  const h = setup(t), before = tree(h.root);
  for (const q of [{ ...h.q, projectId: '../p1' }, { ...h.q, captureRoot: 'relative' }, { ...h.q, extra: true }]) assert.throws(() => inspectOrphanBlobs(q), code('orphan_gc_invalid'));
  assert.throws(() => inspectOrphanBlobs({ captureRoot: path.join(h.root, 'missing'), projectId: 'p1' }), code('orphan_gc_inventory_invalid'));
  for (const options of [{}, { confirmed: false, expected: 'a'.repeat(64) }, { confirmed: true, expected: '' }]) assert.throws(() => collectOrphanBlobs(h.q, options), code('orphan_gc_invalid'));
  assert.deepEqual(tree(h.root), before);
});
test('same-process and real child writers cannot race the GC lease; failed lock acquisition leaves bytes intact', t => {
  const h = setup(t), before = tree(h.root), p = inspectOrphanBlobs(h.q);
  const lease = acquireProjectWriteLease(h.root, 'p1');
  try {
    assert.throws(() => inspectOrphanBlobs(h.q), code('capture_writer_busy'));
    assert.throws(() => collect(h, p), code('capture_writer_busy'));
    const script = `const {collectOrphanBlobs}=require(${JSON.stringify(require.resolve('../../build/server/domain/runtime/badcase-capture/orphan-gc'))});try{collectOrphanBlobs(${JSON.stringify(h.q)},${JSON.stringify({ confirmed: true, expected: p.planHash })});process.exit(9)}catch(e){process.stdout.write(e.code)}`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0); assert.equal(child.stdout, 'capture_writer_busy');
  } finally { lease.release(); }
  assert.deepEqual(tree(h.root), before);
  const unlink = fs.unlinkSync; let checked = false;
  try {
    fs.unlinkSync = file => {
      if (file === h.file(h.orphan)) {
        checked = true; assert.throws(() => h.run(), code('capture_writer_busy'));
        const script = `const {createCaptureStore}=require(${JSON.stringify(require.resolve('../../build/server/domain/runtime/badcase-capture/capture-store'))});const {createReplayRunReferenceStore}=require(${JSON.stringify(require.resolve('../../build/server/domain/runtime/badcase-capture/run-references'))});try{createReplayRunReferenceStore({captureStore:createCaptureStore({captureRoot:${JSON.stringify(h.root)}})}).protect(${JSON.stringify({ ...h.scope, replayRunId: 'child' })});process.exit(9)}catch(e){process.stdout.write(e.code)}`;
        const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
        assert.equal(child.status, 0); assert.equal(child.stdout, 'capture_writer_busy');
      }
      return unlink(file);
    };
    // Direct retention is a lower-level API whose caller must hold the lease;
    // test cooperation via the locked run publisher instead.
    h.retain(); collect(h);
  } finally { fs.unlinkSync = unlink; }
  assert.equal(checked, true);
});
test('unlink failure reports exact partial progress, never drops pins, and explicit re-preview can finish', t => {
  const h = setup(t); h.blob('second orphan'); h.retain(); h.run();
  const p = inspectOrphanBlobs(h.q), original = fs.unlinkSync; let deletes = 0;
  try {
    fs.unlinkSync = file => {
      if (p.candidates.some(c => file === h.file(c.hash)) && ++deletes === 2) throw Object.assign(Error('private path'), { code: 'EACCES' });
      return original(file);
    };
    assert.throws(() => collect(h, p), e => e.code === 'orphan_gc_delete_failed' && e.message === e.code
      && e.deletedBlobCount === 1 && e.reclaimedBytes === p.candidates[0].bytes);
  } finally { fs.unlinkSync = original; }
  assert.equal(inspectOrphanBlobs(h.q).candidates.length, 1); assert.equal(collect(h).deletedBlobCount, 1);
  assert.ok(fs.existsSync(h.file(h.kept))); assert.ok(fs.existsSync(h.file(h.prompt)));
});
test('metadata bound and lstat/open identity changes fail before deletion', t => {
  const h = setup(t), file = path.join(h.dir, 'checkpoints/cp1.json'), original = fs.openSync;
  let replaced = false;
  try {
    fs.openSync = (name, ...args) => {
      if (name === file && !replaced) { replaced = true; const bytes = fs.readFileSync(file); fs.renameSync(file, file + '.old'); fs.writeFileSync(file, bytes); }
      return original(name, ...args);
    };
    assert.throws(() => inspectOrphanBlobs(h.q), code('orphan_gc_inventory_invalid'));
  } finally { fs.openSync = original; }
  assert.equal(replaced, true); assert.ok(fs.existsSync(h.file(h.orphan)));
  fs.unlinkSync(file + '.old'); fs.writeFileSync(file, JSON.stringify({ ...h.checkpoint, padding: 'x'.repeat(16 * 1024 * 1024) }));
  assert.throws(() => inspectOrphanBlobs(h.q), code('orphan_gc_inventory_invalid'));
});
test('last-moment candidate replacement is not deleted and lease release failure is not success', t => {
  const h = setup(t), p = inspectOrphanBlobs(h.q), stat = fs.lstatSync; let visits = 0;
  try {
    fs.lstatSync = (file, ...args) => {
      if (file === h.file(h.orphan) && ++visits === 2) { fs.unlinkSync(file); fs.writeFileSync(file, 'replacement outside snapshot'); }
      return stat(file, ...args);
    };
    assert.throws(() => collect(h, p), e => e.code === 'orphan_gc_delete_failed' && e.deletedBlobCount === 0);
  } finally { fs.lstatSync = stat; }
  assert.equal(fs.readFileSync(h.file(h.orphan), 'utf8'), 'replacement outside snapshot');
  const next = inspectOrphanBlobs(h.q), unlink = fs.unlinkSync;
  try {
    fs.unlinkSync = file => { if (file === path.join(h.dir, '.writer-lock/owner')) throw Error('private detail'); return unlink(file); };
    assert.throws(() => collect(h, next), e => e.code === 'orphan_gc_lock_release_failed' && e.deletedBlobCount === 1 && e.reclaimedBytes === next.candidateBytes);
  } finally { fs.unlinkSync = unlink; }
  assert.throws(() => inspectOrphanBlobs(h.q), code('capture_writer_busy'));
});
test('abrupt GC process death keeps pins and a fail-closed lease, with no automatic recovery', t => {
  const h = setup(t); h.blob('second orphan'); h.retain(); h.run();
  const p = inspectOrphanBlobs(h.q);
  const script = `const fs=require('node:fs');const {collectOrphanBlobs}=require(${JSON.stringify(require.resolve('../../build/server/domain/runtime/badcase-capture/orphan-gc'))});const unlink=fs.unlinkSync;fs.unlinkSync=f=>{unlink(f);process.exit(23)};collectOrphanBlobs(${JSON.stringify(h.q)},${JSON.stringify({ confirmed: true, expected: p.planHash })});`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 23); assert.equal(fs.existsSync(h.file(p.candidates[0].hash)), false);
  assert.ok(fs.existsSync(h.file(p.candidates[1].hash))); assert.ok(fs.existsSync(h.file(h.kept))); assert.ok(fs.existsSync(h.file(h.prompt)));
  assert.ok(fs.existsSync(path.join(h.dir, '.writer-lock/owner')));
  assert.throws(() => inspectOrphanBlobs(h.q), code('capture_writer_busy'));
});
test('Linux real collector checkpoints survive orphan collection and restore identical bytes', { skip: process.platform !== 'linux', timeout: 30000 }, t => {
  const h = setup(t), target = path.join(h.root, 'source'); fs.mkdirSync(target);
  require('node:child_process').execFileSync('git', ['init', '-q', target]); fs.writeFileSync(path.join(target, 'file.txt'), 'original source');
  const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture/index');
  const { restoreCheckpoint } = require('../../build/server/domain/runtime/badcase-capture/restore');
  const service = createBadcaseCaptureService({ captureRoot: path.join(h.root, 'actual-cas') });
  service.savePolicy('p1', { status: 'enabled', authorizedDirs: [target] }); service.authorizeProject('p1');
  const q = { captureRoot: service.captureRoot, projectId: 'p1' };
  const result = service.captureTurnCheckpoint({ projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1', targetDir: target,
    deliveryMode: 'fresh', prompt: 'synthetic task', images: [], runConfig: { model: 'test', provider: 'test', promptVersion: 'v1' },
    harness: { serverVersion: 'test', configSnapshot: { agentPromptVersion: 'v1', toolBridgeEnabled: true, piVersion: '0.85.1', deliveryMode: 'fresh', agentName: 'test' }, skillSnapshots: [] } });
  assert.equal(result.captured, true, result.reason);
  const scope = { ...h.scope, checkpointId: result.checkpointId };
  createCheckpointRetentionStore({ captureStore: service.store }).retain(scope);
  createReplayRunReferenceStore({ captureStore: service.store }).protect({ ...scope, replayRunId: 'actual-run' });
  const bytes = Buffer.from('failed attempt orphan'), hash = sha256Hex(bytes); service.store.writeBlob('p1', hash, bytes);
  const plan = inspectOrphanBlobs(q); assert.deepEqual(plan.candidates, [{ hash, bytes: bytes.length }]);
  const before = service.store.computeUsage('p1');
  assert.equal(collectOrphanBlobs(q, { confirmed: true, expected: plan.planHash }).reclaimedBytes, bytes.length);
  assert.equal(service.store.computeUsage('p1').totalBytes, before.totalBytes - bytes.length);
  for (const i of [1, 2]) {
    const restored = path.join(h.root, 'restore-' + i);
    assert.equal(restoreCheckpoint({ store: service.store, projectId: 'p1', checkpointId: result.checkpointId, targetDir: restored }).ok, true);
    assert.equal(fs.readFileSync(path.join(restored, 'file.txt'), 'utf8'), 'original source');
  }
});
test('operator CLI previews, requires explicit confirmation and never echoes invalid input', t => {
  const h = setup(t), cli = path.resolve(__dirname, '../../scripts/badcase-capture/collect-orphan-blobs.cjs');
  const args = ['--capture-root', h.root, '--project', 'p1'];
  const invoke = extra => spawnSync(process.execPath, [cli, ...extra], { encoding: 'utf8', timeout: 10000 });
  const preview = invoke(args); assert.equal(preview.status, 0); const p = JSON.parse(preview.stdout).result;
  assert.deepEqual(p, inspectOrphanBlobs(h.q)); assert.ok(fs.existsSync(h.file(h.orphan)));
  const bad = invoke([...args, '--collect', p.planHash]); assert.equal(bad.status, 1); assert.equal(bad.stdout, '');
  assert.deepEqual(JSON.parse(bad.stderr), { ok: false, code: 'orphan_gc_invalid' });
  const invalid = invoke(['--capture-root', 'PRIVATE-PATH', '--project', '../invalid']);
  assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stderr, /PRIVATE|invalid\//);
  const result = invoke([...args, '--collect', p.planHash, '--confirm']); assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).result.deletedBlobCount, 1); assert.ok(fs.existsSync(h.file(h.kept)));
  const repeat = invoke([...args, '--collect', p.planHash, '--confirm']); assert.equal(repeat.status, 1);
  assert.equal(JSON.parse(repeat.stderr).code, 'orphan_gc_plan_changed');
});
test('static root/category/file links are refused without touching their targets', { skip: process.platform === 'win32' }, t => {
  for (const category of ['blobs', 'retention', 'checkpoints/cp1.json']) {
    const h = setup(t); h.retain(); const target = path.join(h.dir, category), moved = path.join(h.root, 'outside');
    fs.renameSync(target, moved); fs.symlinkSync(moved, target, category.endsWith('.json') ? 'file' : 'dir');
    assert.throws(() => inspectOrphanBlobs(h.q), code('orphan_gc_inventory_invalid'));
    assert.ok(fs.existsSync(h.file(h.orphan))); assert.ok(fs.lstatSync(target).isSymbolicLink());
  }
  const h = setup(t), alias = path.join(h.root, 'alias'); fs.symlinkSync(h.root, alias, 'dir');
  assert.throws(() => inspectOrphanBlobs({ ...h.q, captureRoot: alias }), code('orphan_gc_inventory_invalid'));
  const moved = path.join(h.root, 'outside'); fs.renameSync(h.dir, moved); fs.symlinkSync(moved, h.dir, 'dir');
  assert.throws(() => inspectOrphanBlobs(h.q), code('orphan_gc_inventory_invalid'));
});
