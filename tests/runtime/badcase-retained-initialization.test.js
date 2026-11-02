const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const { acquireProjectWriteLease } = require('../../build/server/domain/runtime/badcase-capture/project-write-lock');
const { createReplayRunReferenceStore } = require('../../build/server/domain/runtime/badcase-capture/run-references');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function rewrite(h, change) {
  const e = JSON.parse(fs.readFileSync(h.source)); change(e.record.checkpoint);
  e.checksum = hash(JSON.stringify(e.record)); fs.writeFileSync(h.source, JSON.stringify(e));
}
test('fresh/resume capsule freezes all retained bytes and protects the exact closure without live reads', t => {
  for (const mode of ['fresh', 'resume']) {
    const h = fixture(t, mode);
    fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
    const result = prepareRetainedInitializationCapsule(h.request);
    const data = JSON.parse(result.capsule);
    assert.equal(result.capsuleHash, hash(result.capsule));
    assert.equal(result.capsuleBytes, Buffer.byteLength(result.capsule));
    assert.equal(data.kind, 'retained-initialization-inputs');
    assert.deepEqual(data.checkpoint, h.cp);
    const retained = JSON.parse(fs.readFileSync(h.source)).record;
    assert.deepEqual(data.blobs.map(b => b.sha256), retained.blobHashes);
    for (const b of data.blobs) assert.deepEqual(Buffer.from(b.base64, 'base64'), fs.readFileSync(h.blobPath(b.sha256)));
    const ref = createReplayRunReferenceStore({ captureStore: h.store }).get({ projectId: 'p1', replayRunId: 'init-run',
      checkpointId: 'cp1', conversationId: 'c1', turnId: 't1', agentId: 'a1', referenceId: retained.referenceId });
    assert.equal(ref.checkpointChecksum, hash(JSON.stringify(h.cp)));
    assert.deepEqual(ref.blobHashes, retained.blobHashes);
    assert.equal(result.provenance.checkpointChecksum, ref.checkpointChecksum);
    assert.equal(result.provenance.referenceId, retained.referenceId);
    assert.equal(result.provenance.deliveryMode, mode);
    for (const k of ['launchAuthorized', 'runnable', 'reproduced', 'evaluable', 'strictEvalEligible']) assert.equal(result.provenance[k], false);
    assert.deepEqual(prepareRetainedInitializationCapsule(h.request), result);
    assert.equal(fs.readdirSync(h.runDir).length, 1);
    const frozen = result.capsule;
    fs.writeFileSync(h.blobPath(h.r.promptBlobHash), 'later source corruption');
    assert.equal(result.capsule, frozen);
    assert.throws(() => prepareRetainedInitializationCapsule(h.request), { code: 'replay_blob_corrupt' });
    assert.equal(fs.readdirSync(h.runDir).length, 1); // never unpin on failed retry
  }
});
test('missing case or retention is not rebuilt and creates no reference', t => {
  for (const which of ['case', 'retention']) {
    const h = fixture(t);
    const dest = which === 'retention' ? h.source : path.join(h.root, 'projects/p1/cases', hash('msg1') + '.json');
    fs.unlinkSync(dest);
    assert.throws(() => prepareRetainedInitializationCapsule(h.request), { code: which === 'case' ? 'replay_case_missing' : 'replay_source_missing' });
    assert.equal(fs.existsSync(dest), false); assert.equal(fs.existsSync(h.runDir), false);
  }
});
test('parent lease blocks even same-process preparation; release permits retry', t => {
  const h = fixture(t), lease = acquireProjectWriteLease(h.root, 'p1');
  try {
    assert.throws(() => prepareRetainedInitializationCapsule(h.request), { code: 'capture_writer_busy' });
    assert.equal(fs.existsSync(h.runDir), false);
  } finally { lease.release(); }
  assert.ok(prepareRetainedInitializationCapsule(h.request).capsuleHash);
});
test('missing resume, gaps and corrupted non-file inputs reject before protection', t => {
  for (const kind of ['session', 'gap', 'corrupt']) {
    const h = fixture(t, 'resume', ({ r, cp }) => {
      if (kind === 'session') r.sessionBlobHash = '';
      if (kind === 'gap') cp.uncaptured = [{ path: 'missing' }];
    });
    if (kind === 'corrupt') fs.writeFileSync(h.blobPath(h.r.harness.configSnapshotHash), 'bad');
    assert.throws(() => prepareRetainedInitializationCapsule(h.request), { code: { session: 'replay_session_missing', gap: 'replay_inputs_incomplete', corrupt: 'replay_blob_corrupt' }[kind] });
    assert.equal(fs.existsSync(h.runDir), false);
  }
});
test('file path, size, parent conflict and deletion conflicts reject before protection', t => {
  for (const change of [
    cp => { cp.files['../escape'] = cp.files['source.txt']; delete cp.files['source.txt']; },
    cp => { cp.files['source.txt'].size++; },
    cp => { cp.files['source.txt/child'] = cp.files['source.txt']; },
    cp => { cp.deletions.push('source.txt'); },
    cp => { cp.deletions.push('deleted.txt'); },
    cp => { cp.deletions = ['/absolute']; },
  ]) {
    const h = fixture(t); rewrite(h, change);
    assert.throws(() => prepareRetainedInitializationCapsule(h.request), { code: 'initialization_files_invalid' });
    assert.equal(fs.existsSync(h.runDir), false);
  }
});
test('serialized capsule budget rejects before creating permanent protection', t => {
  const h = fixture(t, 'fresh', ({ cp, put }) => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 'x');
    cp.files['large.bin'] = { type: 'file', size: bytes.length, hash: put(bytes) };
  });
  assert.throws(() => prepareRetainedInitializationCapsule(h.request), { code: 'initialization_capsule_limit' });
  assert.equal(fs.existsSync(h.runDir), false);
});
test('consumer blob ceiling is enforced before publication (independent retention-read stub)', t => {
  const h = fixture(t), retention = require('../../build/server/domain/runtime/badcase-capture/checkpoint-retention');
  const original = retention.createCheckpointRetentionStore; let reads = 0;
  retention.createCheckpointRetentionStore = options => {
    const store = original(options), get = store.get;
    store.get = input => { const r = get(input); if (++reads === 2) return { ...r, blobHashes: Array(8193).fill(r.blobHashes[0]) }; return r; };
    return store;
  };
  try { assert.throws(() => prepareRetainedInitializationCapsule(h.request), { code: 'initialization_capsule_limit' }); }
  finally { retention.createCheckpointRetentionStore = original; }
  assert.equal(reads, 2); assert.equal(fs.existsSync(h.runDir), false);
});
test('every blob read and reference publication stays inside the shared lock', t => {
  const h = fixture(t, 'resume');
  const capture = require('../../build/server/domain/runtime/badcase-capture/capture-store');
  const refs = require('../../build/server/domain/runtime/badcase-capture/run-references');
  const originalStore = capture.createCaptureStore, originalRefs = refs.createReplayRunReferenceStore;
  let reads = 0, publications = 0;
  function locked() { assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/.writer-lock')), true); }
  capture.createCaptureStore = options => {
    const store = originalStore(options), read = store.readBlob;
    store.readBlob = (...args) => { locked(); reads++; return read(...args); };
    return store;
  };
  refs.createReplayRunReferenceStore = options => {
    const store = originalRefs(options), protect = store.protect;
    store.protect = input => { locked(); publications++; return protect(input); };
    return store;
  };
  try { prepareRetainedInitializationCapsule(h.request); }
  finally { capture.createCaptureStore = originalStore; refs.createReplayRunReferenceStore = originalRefs; }
  assert.ok(reads > 0); assert.equal(publications, 1);
  assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/.writer-lock')), false);
});
test('bytes changed after preflight cannot enter a capsule or create protection', t => {
  const h = fixture(t), capture = require('../../build/server/domain/runtime/badcase-capture/capture-store');
  const original = capture.createCaptureStore; let reads = 0;
  capture.createCaptureStore = options => {
    const store = original(options), read = store.readBlob;
    store.readBlob = (...args) => {
      const bytes = read(...args);
      if (args[1] === h.r.promptBlobHash && ++reads === 2) return Buffer.from('changed after inspection');
      return bytes;
    };
    return store;
  };
  try { assert.throws(() => prepareRetainedInitializationCapsule(h.request), { code: 'initialization_blob_changed' }); }
  finally { capture.createCaptureStore = original; }
  assert.equal(reads, 2); assert.equal(fs.existsSync(h.runDir), false);
});
test('unknown options and invalid run IDs are refused before any lock or reference', t => {
  const h = fixture(t);
  for (const extra of [{ replayRunId: '../other' }, { launchAuthorized: true }, { image: {} }]) {
    assert.throws(() => prepareRetainedInitializationCapsule({ ...h.request, ...extra }), { code: 'initialization_input_invalid' });
    assert.equal(fs.existsSync(h.runDir), false);
    assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/.writer-lock')), false);
  }
});
