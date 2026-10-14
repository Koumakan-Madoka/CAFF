const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { createCheckpointRetentionStore } = require('../../build/server/domain/runtime/badcase-capture/checkpoint-retention');
const modulePath = path.resolve(__dirname, '../../build/server/domain/runtime/badcase-capture/run-references.js');
const { createReplayRunReferenceStore } = require(modulePath);
const rejects = code => e => e.code === code;
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-run-ref-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root });
  const data = Buffer.from('synthetic snapshot'), hash = sha256Hex(data);
  store.writeBlob('p1', hash, data);
  const scope = { projectId: 'p1', checkpointId: 'cp1', conversationId: 'c1', turnId: 't1', agentId: 'a1', referenceId: 'flag-one' };
  const checkpoint = { schemaVersion: 1, projectId: 'p1', checkpointId: 'cp1', conversationId: 'c1', turnId: 't1', agentId: 'a1', files: { 'x.txt': { type: 'file', hash, size: data.length } }, deletions: ['gone'], replayInput: { complete: false, deliveryMode: 'resume', incompleteReasons: ['session_missing'], harness: { skillSnapshots: [] } } };
  store.saveCheckpoint('p1', checkpoint);
  const retention = createCheckpointRetentionStore({ captureStore: store });
  retention.retain(scope);
  const runs = createReplayRunReferenceStore({ captureStore: store });
  const input = { ...scope, replayRunId: 'run-one' };
  const directory = path.join(root, 'projects/p1/runReferences');
  const target = path.join(directory, `${sha256Hex(input.replayRunId)}.json`);
  return { root, store, scope, checkpoint, retention, runs, input, directory, target, hash,
    blob: path.join(root, 'projects/p1/blobs', hash.slice(0, 2), hash),
    source: path.join(root, 'projects/p1/retention', `${sha256Hex(scope.referenceId)}.json`) };
}
test('protects the retained snapshot, not the changed live checkpoint; restart and retry are read-stable', t => {
  const h = setup(t), before = h.store.computeUsage('p1');
  h.checkpoint.files = {}; h.store.saveCheckpoint('p1', h.checkpoint);
  const first = h.runs.protect(h.input);
  assert.equal(first.created, true); assert.deepEqual(first.reference.blobHashes, [h.hash]);
  assert.equal(first.reference.checkpointChecksum, sha256Hex(JSON.stringify(h.retention.get(h.scope).checkpoint)));
  assert.equal('runnable' in first.reference, false); assert.equal('running' in first.reference, false);
  const after = h.store.computeUsage('p1');
  assert.equal(after.bytesByKind.runReferences, fs.statSync(h.target).size);
  assert.equal(after.bytesByKind.blobs, before.bytesByKind.blobs);
  fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
  const rebuilt = createReplayRunReferenceStore({ captureStore: h.store });
  assert.deepEqual(rebuilt.protect(h.input), { created: false, reference: first.reference });
  assert.deepEqual(rebuilt.get(h.input), first.reference);
  const usage = h.store.computeUsage('p1');
  assert.deepEqual(rebuilt.protectedObjects('p1'), { checkpointIds: ['cp1'], blobHashes: [h.hash], referenceCount: 1, deletionAuthorized: false });
  assert.deepEqual(h.store.computeUsage('p1'), usage);
  assert.equal(typeof rebuilt.release, 'undefined', 'no completion/PID/TTL path may unpin materials yet');
});
test('distinct baseline and candidate references share CAS; one run cannot be rebound', t => {
  const h = setup(t); h.runs.protect(h.input); const firstUsage = h.store.computeUsage('p1');
  h.runs.protect({ ...h.input, replayRunId: 'run-two' });
  assert.equal(h.runs.protectedObjects('p1').referenceCount, 2);
  assert.equal(h.store.computeUsage('p1').blobCount, firstUsage.blobCount);
  assert.throws(() => h.runs.protect({ ...h.input, referenceId: 'other' }), rejects('run_reference_conflict'));
  assert.throws(() => h.runs.get({ ...h.input, checkpointId: 'other' }), rejects('run_reference_conflict'));
});
test('missing retained source cannot be synthesized from live checkpoint; unsafe input never writes', t => {
  const h = setup(t); fs.unlinkSync(h.source);
  assert.throws(() => h.runs.protect(h.input), rejects('run_reference_source_missing'));
  assert.equal(fs.existsSync(h.directory), false); assert.equal(fs.existsSync(h.source), false);
  for (const patch of [{ replayRunId: '../escape' }, { projectId: '' }, { extra: true }, { referenceId: 42 }]) {
    assert.throws(() => h.runs.protect({ ...h.input, ...patch }), rejects('run_reference_invalid_input'));
  }
});
test('secret sentinel in a supplied run identifier is rejected before publication', t => {
  const h = setup(t);
  assert.throws(() => h.runs.protect({ ...h.input, replayRunId: 'sk-' + 'a'.repeat(48) }), rejects('run_reference_contains_secret'));
  assert.equal(fs.existsSync(h.directory), false);
});
test('missing/corrupt blobs reject new and repeated protection without dropping published reference', t => {
  for (const existing of [false, true]) for (const missing of [false, true]) {
    const h = setup(t); if (existing) h.runs.protect(h.input);
    if (missing) fs.unlinkSync(h.blob); else fs.writeFileSync(h.blob, 'corrupt');
    assert.throws(() => h.runs.protect(h.input), rejects(missing ? 'retention_blob_missing' : 'retention_blob_corrupt'));
    assert.equal(fs.existsSync(h.target), existing);
    if (existing) assert.deepEqual(h.runs.protectedObjects('p1').blobHashes, [h.hash]); // protects even missing blobs
  }
});
test('actual metadata bytes count toward quota; one byte below fails and exact fit succeeds', t => {
  const h = setup(t); h.runs.protect(h.input);
  const size = fs.statSync(h.target).size; fs.unlinkSync(h.target);
  const before = h.store.computeUsage('p1').totalBytes;
  h.store.savePolicy({ ...h.store.loadPolicy('p1'), stagingQuotaBytes: before + size - 1 });
  assert.throws(() => h.runs.protect(h.input), rejects('run_reference_quota_exceeded'));
  assert.equal(fs.existsSync(h.target), false);
  h.store.savePolicy({ ...h.store.loadPolicy('p1'), stagingQuotaBytes: before + size });
  assert.equal(h.runs.protect(h.input).created, true);
  assert.equal(h.store.computeUsage('p1').totalBytes, before + size);
});
test('unknown capacity fails closed without publishing or treating usage as zero', t => {
  const h = setup(t);
  h.store.computeUsage = () => { throw Object.assign(Error('capture_usage_unavailable'), { code: 'capture_usage_unavailable' }); };
  assert.throws(() => h.runs.protect(h.input), rejects('capture_usage_unavailable'));
  assert.equal(fs.existsSync(h.target), false); assert.ok(fs.existsSync(h.source));
});
test('disk publication error preserves source and permits explicit retry', t => {
  const h = setup(t), source = fs.readFileSync(h.source), original = fs.linkSync;
  try {
    fs.linkSync = () => { throw Object.assign(Error('private storage detail'), { code: 'ENOSPC' }); };
    assert.throws(() => h.runs.protect(h.input), rejects('run_reference_write_failed'));
  } finally { fs.linkSync = original; }
  assert.deepEqual(fs.readFileSync(h.source), source); assert.equal(fs.existsSync(h.target), false);
  assert.deepEqual(fs.readdirSync(h.directory), []);
  assert.equal(h.runs.protect(h.input).created, true);
});
test('unknown, partial, corrupt or source-mismatched inventories fail closed without deletion', t => {
  for (const mutation of ['unknown', 'partial', 'corrupt', 'closure', 'digest', 'field', 'source', 'source-changed']) {
    const h = setup(t); h.runs.protect(h.input);
    if (mutation === 'unknown') fs.writeFileSync(path.join(h.directory, 'unexpected'), 'keep');
    if (mutation === 'partial') fs.writeFileSync(`${h.target}.tmp-orphan`, 'keep');
    if (mutation === 'corrupt') fs.writeFileSync(h.target, '{broken');
    if (['closure', 'digest', 'field'].includes(mutation)) {
      const envelope = JSON.parse(fs.readFileSync(h.target));
      if (mutation === 'closure') envelope.record.blobHashes = [];
      if (mutation === 'digest') envelope.record.checkpointChecksum = '0'.repeat(64);
      if (mutation === 'field') envelope.record.runnable = true;
      envelope.checksum = sha256Hex(JSON.stringify(envelope.record)); fs.writeFileSync(h.target, JSON.stringify(envelope));
    }
    if (mutation === 'source') fs.unlinkSync(h.source);
    if (mutation === 'source-changed') {
      const envelope = JSON.parse(fs.readFileSync(h.source)); envelope.record.checkpoint.deletions.push('changed');
      envelope.checksum = sha256Hex(JSON.stringify(envelope.record)); fs.writeFileSync(h.source, JSON.stringify(envelope));
    }
    const names = fs.readdirSync(h.directory);
    assert.throws(() => h.runs.protectedObjects('p1'));
    assert.deepEqual(fs.readdirSync(h.directory), names);
  }
});
test('parent lease blocks reference publication in the same process; shared lock can be retried after release', t => {
  const h = setup(t);
  const { acquireProjectWriteLease, withProjectWriteLock } = require('../../build/server/domain/runtime/badcase-capture/project-write-lock');
  const lease = acquireProjectWriteLease(h.root, 'p1'); let ran = false;
  try {
    assert.throws(() => withProjectWriteLock(h.root, 'p1', () => { ran = true; }), rejects('capture_writer_busy'));
    assert.equal(ran, false);
    assert.throws(() => h.runs.protect(h.input), rejects('capture_writer_busy'));
    assert.equal(fs.existsSync(h.directory), false);
  } finally { lease.release(); }
  assert.equal(h.runs.protect(h.input).created, true);
});
test('another process cannot publish under the supervisor lease and succeeds only after release', t => {
  const h = setup(t);
  const { acquireProjectWriteLease } = require('../../build/server/domain/runtime/badcase-capture/project-write-lock');
  const script = `const {createCaptureStore}=require(${JSON.stringify(require.resolve('../../build/server/domain/runtime/badcase-capture/capture-store'))});const {createReplayRunReferenceStore}=require(${JSON.stringify(modulePath)});try{createReplayRunReferenceStore({captureStore:createCaptureStore({captureRoot:${JSON.stringify(h.root)}})}).protect(${JSON.stringify(h.input)});process.stdout.write('protected');}catch(e){process.stdout.write(e.code);process.exitCode=2;}`;
  const lease = acquireProjectWriteLease(h.root, 'p1');
  try {
    const blocked = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(blocked.status, 2); assert.equal(blocked.stdout, 'capture_writer_busy');
    assert.equal(fs.existsSync(h.target), false);
  } finally { lease.release(); }
  const retry = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(retry.status, 0); assert.equal(retry.stdout, 'protected'); assert.ok(h.runs.get(h.input));
});
test('published protection survives abrupt publisher death; residual lock is not guessed away', t => {
  const h = setup(t);
  const script = `const fs=require('node:fs');const {createCaptureStore}=require(${JSON.stringify(require.resolve('../../build/server/domain/runtime/badcase-capture/capture-store'))});const {createReplayRunReferenceStore}=require(${JSON.stringify(modulePath)});const original=fs.linkSync;fs.linkSync=(s,d)=>{original(s,d);process.exit(23);};createReplayRunReferenceStore({captureStore:createCaptureStore({captureRoot:${JSON.stringify(h.root)}})}).protect(${JSON.stringify(h.input)});`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 23); assert.ok(h.runs.get(h.input));
  assert.ok(fs.existsSync(path.join(h.root, 'projects/p1/.writer-lock')));
  assert.throws(() => h.runs.protect(h.input), rejects('capture_writer_busy'));
  assert.throws(() => h.runs.protectedObjects('p1'), rejects('run_reference_inventory_busy'));
  assert.ok(fs.existsSync(h.target)); assert.ok(fs.existsSync(h.source));
});
test('static linked record and directory are rejected without reading through them', { skip: process.platform === 'win32' }, t => {
  for (const directory of [false, true]) {
    const h = setup(t); h.runs.protect(h.input);
    const original = directory ? h.directory : h.target, outside = `${original}-outside`;
    fs.renameSync(original, outside); fs.symlinkSync(outside, original, directory ? 'dir' : 'file');
    assert.throws(() => h.runs.get(h.input)); assert.throws(() => h.runs.protectedObjects('p1'));
    assert.equal(fs.lstatSync(original).isSymbolicLink(), true); assert.ok(fs.existsSync(outside));
  }
});
