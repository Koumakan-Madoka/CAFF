const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { publishPreparedCheckpoint } = require('../../build/server/domain/runtime/badcase-capture/checkpoint-publication');
const { withAsyncProjectWriteLease } = require('../../build/server/domain/runtime/badcase-capture/project-write-lock');
const { inspectOrphanBlobs, collectOrphanBlobs } = require('../../build/server/domain/runtime/badcase-capture/orphan-gc');
const { restoreCheckpoint } = require('../../build/server/domain/runtime/badcase-capture/restore');
const latch = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-publication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root });
  // Synthetic store only: no service management enable and no real target reads.
  store.savePolicy({ ...store.loadPolicy('p1'), status: 'enabled', stagingQuotaBytes: 1024 * 1024 });
  const bytes = Buffer.from('safe file bytes'), hash = sha256Hex(bytes), prompt = Buffer.from('synthetic prompt'), promptHash = sha256Hex(prompt);
  const checkpoint = { schemaVersion: 1, checkpointId: 'cp1', projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1',
    createdAt: new Date().toISOString(), status: 'staged', targetDir: path.join(root, 'synthetic-target'),
    files: { 'file.txt': { type: 'file', hash, size: bytes.length, mode: 0o100644 },
      'duplicate.txt': { type: 'file', hash, size: bytes.length, mode: 0o100644 } }, deletions: ['deleted.txt'],
    strictEvalEligible: false, strictEvalBlockedReason: 'no_independent_consistency_evidence',
    replayInput: { complete: false, deliveryMode: 'resume', incompleteReasons: ['session_missing'], promptBlobHash: promptHash,
      harness: { skillSnapshots: [] } }, stats: { fixture: true } };
  const blobs = new Map([[hash, bytes], [promptHash, prompt]]);
  const publish = (extra = {}) => publishPreparedCheckpoint({ store, checkpoint, blobs, ...extra });
  const project = path.join(root, 'projects', 'p1');
  return { root, store, checkpoint, blobs, bytes, hash, prompt, promptHash, publish, project };
}
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value, null, 2) + '\n');
function empty(h) {
  assert.equal(h.store.listCheckpoints('p1').length, 0);
  assert.equal(h.store.computeUsage('p1').blobCount, 0);
  assert.equal(fs.existsSync(path.join(h.project, 'staging')), false);
  assert.equal(fs.existsSync(path.join(h.project, '.writer-lock')), false);
}

test('prepared publication deduplicates all file/input references, counts exact committed deltas and restores incomplete resume twice', t => {
  const h = setup(t), before = h.store.computeUsage('p1').totalBytes, original = JSON.stringify(h.checkpoint);
  const result = h.publish();
  assert.equal(result.captured, true, result.reason); assert.equal(result.checkpointId, 'cp1');
  const cp = h.store.loadCheckpoint('p1', 'cp1'), usage = h.store.computeUsage('p1');
  assert.deepEqual(result.checkpoint, cp); assert.equal(h.store.loadLatestCheckpoint('p1', cp.targetDir).checkpointId, 'cp1');
  assert.equal(cp.stats.newBlobBytes, h.bytes.length + h.prompt.length); assert.equal(usage.blobCount, 2);
  assert.equal(cp.stats.newManifestBytes, jsonBytes(cp) + h.store.latestPointerSize('p1', cp.targetDir));
  assert.equal(cp.stats.totalNewBytes, usage.totalBytes - before); assert.equal(cp.stats.fixture, true);
  assert.equal(JSON.stringify(h.checkpoint), original, 'caller manifest not mutated');
  assert.equal(cp.replayInput.deliveryMode, 'resume'); assert.equal(cp.replayInput.complete, false); assert.equal(cp.strictEvalEligible, false);
  assert.equal(inspectOrphanBlobs({ captureRoot: h.root, projectId: 'p1' }).candidates.length, 0);
  const lists = [];
  for (const n of [1, 2]) {
    const targetDir = path.join(h.root, `restore-${n}`);
    const restored = restoreCheckpoint({ store: h.store, projectId: 'p1', checkpointId: 'cp1', targetDir });
    assert.equal(restored.ok, true, restored.reason); assert.equal(restored.replayInputComplete, false);
    assert.equal(restored.strictEvalEligible, false);
    assert.equal(fs.readFileSync(path.join(targetDir, 'file.txt'), 'utf8'), h.bytes.toString());
    assert.equal(fs.existsSync(path.join(targetDir, 'deleted.txt')), false); lists.push(restored.restoredFiles);
  }
  assert.deepEqual(lists[0], lists[1]); assert.deepEqual(cp.deletions, ['deleted.txt']);
  assert.equal(fs.existsSync(path.join(h.project, 'staging')), false);
});

test('exact quota boundary succeeds, one byte below rejects before staging and suspends', t => {
  const a = setup(t), b = setup(t);
  // Reuse exactly the same prepared manifest/target in independent stores so
  // serialized path length is identical. No real target directory is read.
  assert.equal(a.publish().captured, true);
  const needed = a.store.computeUsage('p1').totalBytes;
  const cp = a.checkpoint; // independent second store with identical manifest/target
  b.store.savePolicy({ ...b.store.loadPolicy('p1'), stagingQuotaBytes: needed });
  assert.equal(b.publish({ checkpoint: cp }).captured, true);
  const c = setup(t); c.store.savePolicy({ ...c.store.loadPolicy('p1'), stagingQuotaBytes: needed - 1 });
  let stages = 0; const stage = c.store.stageBlob; c.store.stageBlob = (...args) => { stages++; return stage(...args); };
  assert.equal(c.publish({ checkpoint: cp }).reason, 'quota_exceeded'); assert.equal(stages, 0); empty(c);
  assert.equal(c.store.loadPolicy('p1').status, 'suspended'); assert.equal(c.store.loadPolicy('p1').suspendReason, 'quota_exceeded');
});

test('existing valid CAS reused without plans, same-target latest delta and stats stay exact', t => {
  const h = setup(t); assert.equal(h.publish().captured, true);
  const before = h.store.computeUsage('p1').totalBytes;
  const cp = { ...h.checkpoint, checkpointId: 'cp2' };
  const result = h.publish({ checkpoint: cp, blobs: new Map() });
  assert.equal(result.captured, true, result.reason); assert.equal(result.checkpoint.stats.newBlobBytes, 0);
  assert.equal(result.checkpoint.stats.totalNewBytes, h.store.computeUsage('p1').totalBytes - before);
  assert.equal(result.checkpoint.stats.newManifestBytes, jsonBytes(result.checkpoint));
});

for (const mode of ['missing', 'bad-plan-hash', 'extra-plan', 'size', 'secret-plan', 'secret-manifest', 'strict', 'bad-id', 'corrupt-cas']) {
  test(`material validation ${mode} refuses before any staging/checkpoint and never emits private exception/body`, t => {
    const h = setup(t);
    if (mode === 'missing') h.blobs.delete(h.hash);
    if (mode === 'bad-plan-hash') h.blobs.set(h.hash, Buffer.alloc(h.bytes.length, 0x58));
    if (mode === 'extra-plan') h.blobs.set(sha256Hex('unused'), Buffer.from('unused'));
    if (mode === 'size') h.checkpoint.files['file.txt'].size++;
    if (mode === 'secret-plan') {
      const bytes = Buffer.from('sk-SENTINELabcdefghijk'), hash = sha256Hex(bytes);
      h.blobs.delete(h.hash); h.blobs.set(hash, bytes);
      for (const e of Object.values(h.checkpoint.files)) { e.hash = hash; e.size = bytes.length; }
    }
    if (mode === 'secret-manifest') h.checkpoint.environment = { value: 'sk-SENTINELabcdefghijk' };
    if (mode === 'strict') h.checkpoint.strictEvalEligible = true;
    if (mode === 'bad-id') h.checkpoint.checkpointId = '../escape';
    if (mode === 'corrupt-cas') {
      h.store.writeBlob('p1', h.hash, Buffer.alloc(h.bytes.length, 0x58)); h.blobs.delete(h.hash);
    }
    let stages = 0; h.store.stageBlob = () => { stages++; throw Error('PRIVATE_SENTINEL'); };
    const result = h.publish();
    assert.equal(result.captured, false); assert.equal(result.checkpointId, '');
    assert.equal(result.reason, 'checkpoint_material_invalid'); assert.equal(stages, 0);
    assert.equal(h.store.listCheckpoints('p1').length, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|sk-SENTINEL/);
    assert.equal(h.store.loadPolicy('p1').status, 'enabled');
  });
}

for (const status of ['disabled', 'suspended']) test(`current policy ${status} blocks publication and never re-enables`, t => {
  const h = setup(t); h.store.savePolicy({ ...h.store.loadPolicy('p1'), status });
  assert.equal(h.publish().reason, 'policy_not_enabled'); empty(h); assert.equal(h.store.loadPolicy('p1').status, status);
});

test('same checkpoint ID, including corrupt JSON, never overwrites existing evidence or latest', t => {
  const h = setup(t); assert.equal(h.publish().captured, true);
  const filename = path.join(h.project, 'checkpoints', 'cp1.json'), pointer = fs.readFileSync(path.join(h.project, 'latest', fs.readdirSync(path.join(h.project, 'latest'))[0]));
  for (const text of [fs.readFileSync(filename, 'utf8'), '{broken-json']) {
    fs.writeFileSync(filename, text); const before = fs.readFileSync(filename);
    assert.equal(h.publish().reason, 'checkpoint_conflict'); assert.deepEqual(fs.readFileSync(filename), before);
    assert.deepEqual(fs.readFileSync(path.join(h.project, 'latest', fs.readdirSync(path.join(h.project, 'latest'))[0])), pointer);
  }
});

for (const phase of ['stageBlob', 'commitStaging', 'saveCheckpoint', 'saveLatestCheckpointId', 'computeUsage']) {
  test(`disk failure at ${phase} reports no capture/association, suspends, clears staging and never deletes committed references`, t => {
    const h = setup(t), original = h.store[phase]; let calls = 0;
    h.store[phase] = (...args) => { calls++; if (phase === 'stageBlob' && calls === 1) return original(...args); throw Error('PRIVATE_SENTINEL'); };
    const result = h.publish(); h.store[phase] = original;
    assert.equal(result.captured, false); assert.equal(result.checkpointId, ''); assert.equal(result.reason, 'checkpoint_write_failed');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
    assert.equal(h.store.loadPolicy('p1').status, 'suspended');
    assert.equal(fs.existsSync(path.join(h.project, 'staging')), false);
    assert.equal(fs.existsSync(path.join(h.project, '.writer-lock')), false);
    if (phase === 'saveLatestCheckpointId') {
      assert.ok(h.store.loadCheckpoint('p1', 'cp1')); // Visible staged manifest remains protected; not falsely associated.
      assert.equal(inspectOrphanBlobs({ captureRoot: h.root, projectId: 'p1' }).candidates.length, 0);
      assert.equal(h.store.loadLatestCheckpoint('p1', h.checkpoint.targetDir), null);
    } else assert.equal(h.store.loadCheckpoint('p1', 'cp1'), null);
  });
}

test('async lease owns wait→quota→CAS→manifest→latest; competing publication/GC busy, old GC plan invalid after publish', async t => {
  const h = setup(t); h.store.writeBlob('p1', h.hash, h.bytes); h.blobs.delete(h.hash);
  const q = { captureRoot: h.root, projectId: 'p1' }, old = inspectOrphanBlobs(q), entered = latch(), done = latch();
  const run = withAsyncProjectWriteLease(h.root, 'p1', async commit => { entered.resolve(); await done.promise; return commit(() => h.publish()); });
  try {
    await entered.promise;
    assert.equal(h.publish().reason, 'capture_writer_busy');
    assert.throws(() => inspectOrphanBlobs(q), e => e.code === 'capture_writer_busy');
    assert.throws(() => collectOrphanBlobs(q, { confirmed: true, expected: old.planHash }), e => e.code === 'capture_writer_busy');
    assert.equal(h.store.loadCheckpoint('p1', 'cp1'), null);
  } finally { done.resolve(); }
  assert.equal((await run).captured, true);
  assert.throws(() => collectOrphanBlobs(q, { confirmed: true, expected: old.planHash }), e => e.code === 'orphan_gc_plan_changed');
  assert.deepEqual(h.store.readBlob('p1', h.hash), h.bytes);
});

for (const nextId of ['x', 'a-longer-checkpoint-id']) test(`latest pointer length change to ${nextId} uses signed actual delta and reserves pre-shrink peak`, t => {
  const h = setup(t); assert.equal(h.publish().captured, true);
  const before = h.store.computeUsage('p1').totalBytes, latestBefore = h.store.latestPointerSize('p1', h.checkpoint.targetDir);
  const result = h.publish({ checkpoint: { ...h.checkpoint, checkpointId: nextId }, blobs: new Map() });
  assert.equal(result.captured, true, result.reason);
  const delta = h.store.latestPointerSize('p1', h.checkpoint.targetDir) - latestBefore;
  assert.equal(result.checkpoint.stats.newManifestBytes, jsonBytes(result.checkpoint) + delta);
  assert.equal(result.checkpoint.stats.totalNewBytes, h.store.computeUsage('p1').totalBytes - before);
  if (delta < 0) {
    const other = setup(t); assert.equal(other.publish().captured, true);
    const otherBefore = other.store.computeUsage('p1').totalBytes;
    const requiredPeak = otherBefore + jsonBytes(result.checkpoint);
    other.store.savePolicy({ ...other.store.loadPolicy('p1'), stagingQuotaBytes: requiredPeak - 1 });
    assert.equal(other.publish({ checkpoint: { ...other.checkpoint, checkpointId: nextId }, blobs: new Map() }).reason, 'quota_exceeded');
    assert.equal(other.store.loadCheckpoint('p1', nextId), null);
    assert.equal(other.store.loadLatestCheckpoint('p1', other.checkpoint.targetDir).checkpointId, 'cp1');
  }
});

for (const phase of ['commitStaging', 'saveCheckpoint']) test(`failure after ${phase} already persisted retains CAS/manifest instead of unsafe deletion`, t => {
  const h = setup(t), original = h.store[phase];
  h.store[phase] = (...args) => { original(...args); throw Error('PRIVATE_SENTINEL'); };
  assert.equal(h.publish().reason, 'checkpoint_write_failed');
  assert.equal(h.store.loadLatestCheckpoint('p1', h.checkpoint.targetDir), null);
  assert.deepEqual(h.store.readBlob('p1', h.hash), h.bytes);
  assert.equal(fs.existsSync(path.join(h.project, 'staging')), false);
  const orphans = inspectOrphanBlobs({ captureRoot: h.root, projectId: 'p1' });
  if (phase === 'saveCheckpoint') { assert.ok(h.store.loadCheckpoint('p1', 'cp1')); assert.equal(orphans.candidates.length, 0); }
  else { assert.equal(h.store.loadCheckpoint('p1', 'cp1'), null); assert.equal(orphans.candidates.length, 2); }
});

test('final quota recheck rejects injected growth after CAS commit and leaves visible orphans, not a successful checkpoint', t => {
  const h = setup(t), original = h.store.computeUsage; let calls = 0;
  h.store.computeUsage = (...args) => { const usage = original(...args); calls++; return calls === 4 ? { ...usage, totalBytes: 1024 * 1024 } : usage; };
  assert.equal(h.publish().reason, 'quota_exceeded'); assert.equal(calls, 4);
  assert.equal(h.store.loadCheckpoint('p1', 'cp1'), null); assert.equal(h.store.loadPolicy('p1').status, 'suspended');
  assert.deepEqual(h.store.readBlob('p1', h.hash), h.bytes);
});

test('post-commit CAS corruption is caught before manifest publication even with matching size', t => {
  const h = setup(t), original = h.store.commitStaging;
  h.store.commitStaging = (...args) => {
    original(...args);
    fs.writeFileSync(path.join(h.project, 'blobs', h.hash.slice(0, 2), h.hash), Buffer.alloc(h.bytes.length, 0x58));
  };
  assert.equal(h.publish().reason, 'checkpoint_write_failed'); assert.equal(h.store.loadCheckpoint('p1', 'cp1'), null);
  assert.equal(h.store.loadPolicy('p1').status, 'suspended');
});

test('cleanup failure revokes a provisional success and suspends without deleting published reference', t => {
  const h = setup(t); h.store.rollbackStaging = () => { throw Error('PRIVATE_SENTINEL'); };
  const result = h.publish(); assert.equal(result.captured, false); assert.equal(result.checkpointId, '');
  assert.equal(result.reason, 'checkpoint_cleanup_failed'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
  assert.equal(h.store.loadPolicy('p1').status, 'suspended'); assert.ok(h.store.loadCheckpoint('p1', 'cp1'));
  assert.equal(inspectOrphanBlobs({ captureRoot: h.root, projectId: 'p1' }).candidates.length, 0);
});

test('real Windows native async candidate enters the quota publisher and restores twice under one lease (synthetic source only)',
  { skip: process.platform !== 'win32' ? 'real Windows NTFS required' : false }, async t => {
  const h = setup(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-publish-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { execFileSync } = require('node:child_process');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'absent-global'), GIT_TEMPLATE_DIR: '' } });
  git('init', '-q'); git('config', 'core.ignorecase', 'false');
  fs.writeFileSync(path.join(root, 'tracked'), 'original'); git('add', 'tracked');
  fs.writeFileSync(path.join(root, 'tracked'), 'dirty'); fs.writeFileSync(path.join(root, 'new'), 'new bytes');
  fs.writeFileSync(path.join(root, 'secret'), 'sk-SENTINELabcdefghijk');
  const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
  const { readWindowsGitFileCandidateAsync } = require('../../build/server/domain/runtime/badcase-capture/windows-git-candidate');
  const service = createBadcaseCaptureService({ captureRoot: h.root });
  service.savePolicy('p1', { ...service.loadPolicy('p1'), authorizedDirs: [root], authorizedInputDirs: [], excludedPatterns: [] });
  service.authorizeProject('p1'); assert.equal(service.loadPolicy('p1').status, 'disabled');
  // Internal test policy, not management enable or authorization of a real project.
  h.store.savePolicy({ ...h.store.loadPolicy('p1'), status: 'enabled' });
  const policy = h.store.loadPolicy('p1');
  const result = await withAsyncProjectWriteLease(h.root, 'p1', async commit => {
    const candidate = await readWindowsGitFileCandidateAsync({ targetDir: root, captureRoot: h.root, policy });
    assert.equal(candidate.ok, true, candidate.reason); assert.equal(candidate.complete, false);
    const blobs = new Map(candidate.blobs); blobs.set(h.promptHash, h.prompt);
    return commit(() => h.publish({ checkpoint: { ...h.checkpoint, targetDir: root, files: candidate.files, limitations: candidate.limitations }, blobs }));
  });
  assert.equal(result.captured, true, result.reason); assert.equal(result.checkpoint.replayInput.deliveryMode, 'resume');
  assert.equal(result.checkpoint.replayInput.complete, false); assert.equal(result.checkpoint.strictEvalEligible, false);
  assert.equal(result.checkpoint.stats.totalNewBytes, h.store.computeUsage('p1').totalBytes);
  for (const n of [1, 2]) {
    const targetDir = path.join(h.root, `native-restore-${n}`);
    const restored = restoreCheckpoint({ store: h.store, projectId: 'p1', checkpointId: 'cp1', targetDir });
    assert.equal(restored.ok, true, restored.reason); assert.equal(restored.replayInputComplete, false);
    assert.equal(fs.readFileSync(path.join(targetDir, 'tracked'), 'utf8'), 'dirty');
    assert.equal(fs.readFileSync(path.join(targetDir, 'new'), 'utf8'), 'new bytes'); assert.equal(fs.existsSync(path.join(targetDir, 'secret')), false);
  }
  assert.equal(h.store.hasBlob('p1', sha256Hex('sk-SENTINELabcdefghijk')), false);
});
