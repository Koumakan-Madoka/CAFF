const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { createCheckpointRetentionStore } = require('../../build/server/domain/runtime/badcase-capture/checkpoint-retention');
const { createReplayRunReferenceStore } = require('../../build/server/domain/runtime/badcase-capture/run-references');
const { acquireProjectWriteLease } = require('../../build/server/domain/runtime/badcase-capture/project-write-lock');
const { inspectCheckpointExpiry, expireCheckpoints, inspectOrphanBlobs, collectOrphanBlobs } = require('../../build/server/domain/runtime/badcase-capture/orphan-gc');
const rules = { asOf: '2026-01-10T00:00:00.000Z', retentionDays: 7, quotaBytes: 10 * 1024 ** 3 };
const code = c => e => e.code === c;
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root }), q = { captureRoot: root, projectId: 'p1' };
  const dir = path.join(root, 'projects/p1');
  const blob = text => { const hash = sha256Hex(text); store.writeBlob('p1', hash, Buffer.from(text)); return hash; };
  const shared = blob('shared');
  function cp(id, createdAt, extra = {}) {
    const value = { schemaVersion: 1, projectId: 'p1', checkpointId: id, conversationId: 'c1', turnId: 't1', agentId: 'a1',
      createdAt, status: 'staged', files: { 'shared.txt': { type: 'file', hash: shared } },
      replayInput: { complete: false, deliveryMode: 'fresh', incompleteReasons: [], promptBlobHash: blob(id), harness: { skillSnapshots: [] } }, ...extra };
    store.saveCheckpoint('p1', value); return value;
  }
  cp('old', '2026-01-01T00:00:00.000Z'); cp('boundary', '2026-01-03T00:00:00.000Z'); cp('recent', '2026-01-09T00:00:00.000Z');
  const file = id => path.join(dir, 'checkpoints', id + '.json');
  const scope = checkpointId => ({ projectId: 'p1', checkpointId, conversationId: 'c1', turnId: 't1', agentId: 'a1', referenceId: 'pin-' + checkpointId });
  return { root, dir, store, q, blob, shared, cp, file, scope };
}
function tree(root) {
  const out = {};
  const visit = dir => { for (const name of fs.readdirSync(dir).sort()) { const f = path.join(dir, name), s = fs.lstatSync(f); if (s.isDirectory()) visit(f); else out[path.relative(root, f)] = s.isSymbolicLink() ? fs.readlinkSync(f) : fs.readFileSync(f).toString('hex'); } };
  visit(root); return out;
}
const apply = (h, r = rules, p = inspectCheckpointExpiry(h.q, r)) => expireCheckpoints(h.q, r, { confirmed: true, writersStopped: true, expected: p.planHash });
test('TTL is inclusive, preview is nondeleting, expiry only removes manifests; separate GC matches projected bytes', t => {
  const h = setup(t), before = tree(h.root), p = inspectCheckpointExpiry(h.q, rules);
  assert.deepEqual(tree(h.root), before); assert.equal(p.deletionAuthorized, false);
  assert.deepEqual(p.candidates.map(c => [c.checkpointId, c.reason]), [['old', 'expired'], ['boundary', 'expired']]);
  const result = apply(h, rules, p); assert.equal(result.deletedCheckpointCount, 2);
  assert.equal(result.reclaimedManifestBytes, p.candidates.reduce((n, c) => n + c.bytes, 0));
  assert.equal(h.store.computeUsage('p1').blobCount, 4); assert.ok(fs.existsSync(h.file('recent')));
  const gc = inspectOrphanBlobs(h.q); assert.equal(gc.candidateBytes, p.projectedOrphanBytes);
  collectOrphanBlobs(h.q, { confirmed: true, expected: gc.planHash });
  assert.equal(h.store.computeUsage('p1').totalBytes, p.projectedUsageAfterGc);
  assert.ok(h.store.readBlob('p1', h.shared)); assert.equal(inspectCheckpointExpiry(h.q, rules).candidates.length, 0);
  assert.throws(() => apply(h, rules, p), code('checkpoint_expiry_plan_changed'));
});
test('latest, marked, retained, run-pinned, unknown state and unknown fields all stay', t => {
  const h = setup(t); h.store.saveLatestCheckpointId('p1', h.root, 'old');
  createCheckpointRetentionStore({ captureStore: h.store }).retain(h.scope('boundary'));
  createCheckpointRetentionStore({ captureStore: h.store }).retain(h.scope('recent'));
  createReplayRunReferenceStore({ captureStore: h.store }).protect({ ...h.scope('recent'), replayRunId: 'unresolved' });
  h.cp('unknown', '2026-01-01T00:00:00.000Z', { status: 'future-state' });
  h.cp('future', '2026-01-01T00:00:00.000Z', { futureReference: true });
  h.cp('marked', '2026-01-01T00:00:00.000Z');
  const { createBadcaseFlagService } = require('../../build/server/domain/runtime/badcase-capture/badcase-flags');
  createBadcaseFlagService({ captureRoot: h.root, captureStore: h.store, chatStore: {
    getConversationWithoutMessages: () => ({ projectScopeId: 'p1' }),
    getMessage: () => ({ id: 'm1', role: 'assistant', status: 'completed', conversationId: 'c1', metadata: { badcaseCheckpointId: 'marked' } }),
  } }).mark({ projectId: 'p1', conversationId: 'c1', messageId: 'm1', actual: 'bad', expected: 'good' });
  const before = tree(h.root), p = inspectCheckpointExpiry(h.q, { ...rules, quotaBytes: 1 });
  assert.equal(p.candidates.length, 0); assert.equal(p.protectedCheckpointCount, 6); assert.equal(p.quotaSatisfiedAfterGc, false);
  apply(h, { ...rules, quotaBytes: 1 }, p); assert.deepEqual(tree(h.root), before);
});
test('quota retires oldest eligible first and shared CAS is counted only once', t => {
  const h = setup(t), r = { ...rules, retentionDays: 30, quotaBytes: 1 };
  h.store.saveLatestCheckpointId('p1', h.root, 'recent');
  const p = inspectCheckpointExpiry(h.q, r);
  assert.deepEqual(p.candidates.map(c => [c.checkpointId, c.reason]), [['old', 'quota'], ['boundary', 'quota']]);
  assert.equal(p.quotaSatisfiedAfterGc, false); apply(h, r, p);
  const gc = inspectOrphanBlobs(h.q); collectOrphanBlobs(h.q, { confirmed: true, expected: gc.planHash });
  assert.equal(h.store.computeUsage('p1').totalBytes, p.projectedUsageAfterGc);
  assert.ok(h.store.readBlob('p1', h.shared));
});
test('quota stops at exact fit instead of retiring further recent manifests', t => {
  const h = setup(t), target = h.store.computeUsage('p1').totalBytes - fs.statSync(h.file('old')).size - Buffer.byteLength('old');
  const r = { ...rules, retentionDays: 30, quotaBytes: target }, p = inspectCheckpointExpiry(h.q, r);
  assert.deepEqual(p.candidates.map(c => c.checkpointId), ['old']); assert.equal(p.projectedUsageAfterGc, target);
  assert.equal(p.quotaSatisfiedAfterGc, true); apply(h, r, p);
  const gc = inspectOrphanBlobs(h.q); collectOrphanBlobs(h.q, { confirmed: true, expected: gc.planHash });
  assert.equal(h.store.computeUsage('p1').totalBytes, target); assert.ok(fs.existsSync(h.file('boundary')));
});
test('cross-checkpoint unknown references protect the referenced manifest too', t => {
  const h = setup(t); h.cp('recent', '2026-01-09T00:00:00.000Z', { futureReference: { checkpointId: 'old' } });
  const p = inspectCheckpointExpiry(h.q, rules); assert.deepEqual(p.candidates.map(c => c.checkpointId), ['boundary']);
  apply(h, rules, p); assert.ok(fs.existsSync(h.file('old')));
});
test('existing orphans can satisfy quota without retiring any fresh checkpoint', t => {
  const h = setup(t); h.blob('x'.repeat(10000));
  const total = h.store.computeUsage('p1').totalBytes;
  const r = { ...rules, retentionDays: 30, quotaBytes: total - 10000 };
  const p = inspectCheckpointExpiry(h.q, r); assert.equal(p.candidates.length, 0);
  assert.equal(p.projectedOrphanBytes, 10000); assert.equal(p.quotaSatisfiedAfterGc, true);
});
test('bad rules, future cutoff, missing timestamps, malformed inventory and no stopped-writer declaration fail closed', t => {
  const h = setup(t), before = tree(h.root);
  for (const r of [{ ...rules, retentionDays: 0 }, { ...rules, retentionDays: 1.2 }, { ...rules, quotaBytes: -1 }, { ...rules, quotaBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...rules, asOf: '2100-01-01T00:00:00.000Z' }, { ...rules, asOf: '2026-02-30T00:00:00.000Z' }, { ...rules, extra: true }]) {
    assert.throws(() => inspectCheckpointExpiry(h.q, r), code('checkpoint_expiry_invalid'));
  }
  const p = inspectCheckpointExpiry(h.q, rules);
  for (const opt of [{ confirmed: true, expected: p.planHash }, { confirmed: true, writersStopped: false, expected: p.planHash }, { confirmed: false, writersStopped: true, expected: p.planHash }]) {
    assert.throws(() => expireCheckpoints(h.q, rules, opt), code('checkpoint_expiry_invalid'));
  }
  assert.deepEqual(tree(h.root), before);
  for (const createdAt of [undefined, 'bad', '2026-01-11T00:00:00.000Z']) {
    h.cp('bad', createdAt); const bytes = tree(h.root);
    assert.throws(() => inspectCheckpointExpiry(h.q, rules), code('checkpoint_expiry_inventory_invalid')); assert.deepEqual(tree(h.root), bytes);
  }
  fs.unlinkSync(h.file('bad')); fs.writeFileSync(h.file('old'), '{');
  assert.throws(() => inspectCheckpointExpiry(h.q, rules), code('orphan_gc_inventory_invalid'));
});
test('new pin, changed rules, changed checkpoint and new latest invalidate preview before deletion', t => {
  for (const change of ['pin', 'run', 'latest', 'checkpoint', 'rules']) {
    const h = setup(t), p = inspectCheckpointExpiry(h.q, rules); let r = rules;
    if (change === 'pin') createCheckpointRetentionStore({ captureStore: h.store }).retain(h.scope('old'));
    if (change === 'run') {
      createCheckpointRetentionStore({ captureStore: h.store }).retain(h.scope('old'));
      createReplayRunReferenceStore({ captureStore: h.store }).protect({ ...h.scope('old'), replayRunId: 'new' });
    }
    if (change === 'latest') h.store.saveLatestCheckpointId('p1', h.root, 'old');
    if (change === 'checkpoint') h.cp('new', '2026-01-02T00:00:00.000Z');
    if (change === 'rules') r = { ...rules, quotaBytes: 1 };
    const before = tree(h.root); assert.throws(() => apply(h, r, p), code('checkpoint_expiry_plan_changed')); assert.deepEqual(tree(h.root), before);
  }
});
test('lease covers deletion and blocks real child publishers', { timeout: 15000 }, t => {
  const h = setup(t), p = inspectCheckpointExpiry(h.q, rules), lease = acquireProjectWriteLease(h.root, 'p1');
  try { assert.throws(() => inspectCheckpointExpiry(h.q, rules), code('capture_writer_busy')); assert.throws(() => apply(h, rules, p), code('capture_writer_busy')); }
  finally { lease.release(); }
  const unlink = fs.unlinkSync; let checked = false;
  try {
    fs.unlinkSync = file => {
      if (file === h.file('old')) {
        checked = true;
        const script = `const {acquireProjectWriteLease}=require(${JSON.stringify(require.resolve('../../build/server/domain/runtime/badcase-capture/project-write-lock'))});try{acquireProjectWriteLease(${JSON.stringify(h.root)},'p1');process.exit(9)}catch(e){process.stdout.write(e.code)}`;
        const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
        assert.equal(child.status, 0); assert.equal(child.stdout, 'capture_writer_busy');
      }
      return unlink(file);
    };
    apply(h, rules, p);
  } finally { fs.unlinkSync = unlink; }
  assert.equal(checked, true);
});
test('partial unlink failure reports accurate manifest progress, leaves all blobs, re-preview can finish', t => {
  const h = setup(t), p = inspectCheckpointExpiry(h.q, rules), unlink = fs.unlinkSync;
  try {
    fs.unlinkSync = file => { if (file === h.file('boundary')) throw Error('PRIVATE'); return unlink(file); };
    assert.throws(() => apply(h, rules, p), e => e.code === 'checkpoint_expiry_delete_failed' && e.deletedCheckpointCount === 1 && e.reclaimedManifestBytes === p.candidates[0].bytes && e.message === e.code);
  } finally { fs.unlinkSync = unlink; }
  assert.equal(h.store.computeUsage('p1').blobCount, 4); assert.equal(apply(h).deletedCheckpointCount, 1);
  assert.doesNotThrow(() => inspectOrphanBlobs(h.q));
});
test('replacement before unlink and lease release failure never report success', t => {
  const h = setup(t), p = inspectCheckpointExpiry(h.q, rules), lstat = fs.lstatSync; let visits = 0;
  try {
    fs.lstatSync = (f, ...args) => { if (f === h.file('old') && ++visits === 2) { fs.renameSync(f, f + '.old'); fs.writeFileSync(f, 'replacement'); } return lstat(f, ...args); };
    assert.throws(() => apply(h, rules, p), e => e.code === 'checkpoint_expiry_delete_failed' && e.deletedCheckpointCount === 0);
  } finally { fs.lstatSync = lstat; }
  assert.equal(fs.readFileSync(h.file('old'), 'utf8'), 'replacement');
  const h2 = setup(t), p2 = inspectCheckpointExpiry(h2.q, rules), unlink = fs.unlinkSync;
  try {
    fs.unlinkSync = f => { if (f === path.join(h2.dir, '.writer-lock/owner')) throw Error('PRIVATE'); return unlink(f); };
    assert.throws(() => apply(h2, rules, p2), e => e.code === 'checkpoint_expiry_lock_release_failed' && e.deletedCheckpointCount === 2);
  } finally { fs.unlinkSync = unlink; }
  assert.throws(() => inspectCheckpointExpiry(h2.q, rules), code('capture_writer_busy'));
});
test('process death after first retirement leaves fail-closed lock and all CAS, no automatic restart', t => {
  const h = setup(t), p = inspectCheckpointExpiry(h.q, rules);
  const script = `const fs=require('node:fs');const {expireCheckpoints}=require(${JSON.stringify(require.resolve('../../build/server/domain/runtime/badcase-capture/orphan-gc'))});const unlink=fs.unlinkSync;fs.unlinkSync=f=>{unlink(f);process.exit(23)};expireCheckpoints(${JSON.stringify(h.q)},${JSON.stringify(rules)},${JSON.stringify({ confirmed: true, writersStopped: true, expected: p.planHash })})`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 23); assert.equal(fs.existsSync(h.file('old')), false); assert.ok(fs.existsSync(h.file('boundary')));
  assert.equal(h.store.computeUsage('p1').blobCount, 4); assert.throws(() => inspectOrphanBlobs(h.q), code('capture_writer_busy'));
});
test('CLI requires exact rules, confirmation and stopped-writer declaration', t => {
  const h = setup(t), cli = path.resolve(__dirname, '../../scripts/badcase-capture/expire-checkpoints.cjs');
  const args = ['--capture-root', h.root, '--project', 'p1', '--as-of', rules.asOf, '--retention-days', '7', '--quota-bytes', String(rules.quotaBytes)];
  const run = extra => spawnSync(process.execPath, [cli, ...extra], { encoding: 'utf8', timeout: 10000 });
  const preview = run(args); assert.equal(preview.status, 0, preview.stderr); const p = JSON.parse(preview.stdout).result;
  assert.deepEqual(p, inspectCheckpointExpiry(h.q, rules));
  const bad = run([...args, '--expire', p.planHash, '--confirm']); assert.equal(bad.status, 1); assert.equal(bad.stdout, '');
  assert.equal(JSON.parse(bad.stderr).code, 'checkpoint_expiry_invalid');
  const ok = run([...args, '--expire', p.planHash, '--confirm', '--writers-stopped']); assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).result.deletedCheckpointCount, 2);
});
test('Linux collector: aged unmarked retires, retained and latest remain restorable after separate GC', { skip: process.platform !== 'linux', timeout: 30000 }, t => {
  const h = setup(t), source = path.join(h.root, 'source'); fs.mkdirSync(source);
  require('node:child_process').execFileSync('git', ['init', '-q', source]);
  const { createLegacyNativeCaptureService: createBadcaseCaptureService } = require('../helpers/legacy-native-capture');
  const { restoreCheckpoint } = require('../../build/server/domain/runtime/badcase-capture/restore');
  const service = createBadcaseCaptureService({ captureRoot: path.join(h.root, 'actual-cas') });
  service.savePolicy('p1', { status: 'enabled', authorizedDirs: [source] }); service.authorizeProject('p1');
  const saved = [];
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(source, 'file.txt'), 'source-' + i);
    const result = service.captureTurnCheckpoint({ projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1', targetDir: source,
      deliveryMode: 'fresh', prompt: 'synthetic task ' + i, images: [], runConfig: { model: 'test', provider: 'test', promptVersion: 'v1' },
      harness: { serverVersion: 'test', configSnapshot: { agentPromptVersion: 'v1', toolBridgeEnabled: true, piVersion: '0.85.1', deliveryMode: 'fresh', agentName: 'test' }, skillSnapshots: [] } });
    assert.equal(result.captured, true, result.reason);
    // Synthetic aging only; not a claim of seven days of live traffic.
    result.checkpoint.createdAt = '2026-01-01T00:00:00.000Z'; service.store.saveCheckpoint('p1', result.checkpoint); saved.push(result.checkpointId);
  }
  createCheckpointRetentionStore({ captureStore: service.store }).retain({ ...h.scope(saved[1]), referenceId: 'keep' });
  service.savePolicy('p1', { status: 'disabled' });
  const q = { captureRoot: service.captureRoot, projectId: 'p1' }, p = inspectCheckpointExpiry(q, rules);
  assert.deepEqual(p.candidates.map(c => c.checkpointId), [saved[0]]);
  expireCheckpoints(q, rules, { confirmed: true, writersStopped: true, expected: p.planHash });
  const gc = inspectOrphanBlobs(q); assert.equal(gc.candidateBytes, p.projectedOrphanBytes);
  collectOrphanBlobs(q, { confirmed: true, expected: gc.planHash });
  assert.equal(service.store.computeUsage('p1').totalBytes, p.projectedUsageAfterGc);
  for (const i of [1, 2]) for (const attempt of [1, 2]) {
    const dest = path.join(h.root, `restored-${i}-${attempt}`);
    assert.equal(restoreCheckpoint({ store: service.store, projectId: 'p1', checkpointId: saved[i], targetDir: dest }).ok, true);
    assert.equal(fs.readFileSync(path.join(dest, 'file.txt'), 'utf8'), 'source-' + i);
  }
});
test('static linked checkpoint is rejected without touching target', { skip: process.platform === 'win32' }, t => {
  const h = setup(t), outside = path.join(h.root, 'outside'); fs.renameSync(h.file('old'), outside); fs.symlinkSync(outside, h.file('old'));
  const before = tree(h.root); assert.throws(() => inspectCheckpointExpiry(h.q, rules), code('orphan_gc_inventory_invalid')); assert.deepEqual(tree(h.root), before);
});
