const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { createCheckpointRetentionStore } = require('../../build/server/domain/runtime/badcase-capture/checkpoint-retention');
const rejected = code => error => error.code === code;
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root });
  const blob = text => { const content = Buffer.from(text), hash = sha256Hex(content); store.writeBlob('p1', hash, content); return hash; };
  const hashes = ['file bytes', 'prompt', 'session', 'config', 'skill'].map(blob);
  const input = { projectId: 'p1', checkpointId: 'cp1', referenceId: 'flag-one', conversationId: 'c1', turnId: 't1', agentId: 'a1' };
  const checkpoint = { schemaVersion: 1, checkpointId: 'cp1', projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1', status: 'staged',
    files: { 'a.txt': { type: 'file', hash: hashes[0], size: 10 }, 'duplicate.txt': { type: 'file', hash: hashes[0], size: 10 } }, deletions: ['deleted.txt'],
    replayInput: { deliveryMode: 'resume', complete: false, incompleteReasons: ['fixture_not_real_turn'], promptBlobHash: hashes[1], sessionBlobHash: hashes[2],
      harness: { configSnapshotHash: hashes[3], skillSnapshots: [{ id: 'skill', blobHash: hashes[4], sha256: hashes[4] }] } }, strictEvalEligible: false };
  store.saveCheckpoint('p1', checkpoint);
  const options = { captureStore: store };
  const retention = createCheckpointRetentionStore(options);
  const directory = path.join(root, 'projects/p1/retention');
  return { root, store, options, retention, input, checkpoint, hashes, blob, directory,
    records: () => fs.existsSync(directory) ? fs.readdirSync(directory).filter(n => n.endsWith('.json')) : [],
    save: () => store.saveCheckpoint('p1', checkpoint),
    blobPath: hash => path.join(root, 'projects/p1/blobs', hash.slice(0, 2), hash) };
}
test('retains full blob closure once, immutable snapshot survives source changes and service reconstruction', t => {
  const h = setup(t), first = h.retention.retain(h.input);
  assert.equal(first.created, true); assert.deepEqual(first.reference.blobHashes, [...h.hashes].sort());
  assert.deepEqual(first.reference.checkpoint, h.checkpoint); assert.equal(first.reference.checkpoint.strictEvalEligible, false);
  assert.equal(first.reference.kind, 'checkpoint-retention'); assert.equal('captured' in first.reference, false);
  h.checkpoint.deletions.push('later.txt'); h.save();
  const rebuilt = createCheckpointRetentionStore(h.options), retry = rebuilt.retain(h.input);
  assert.equal(retry.created, false); assert.deepEqual(retry.reference, first.reference); assert.equal(h.records().length, 1);
  fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
  assert.deepEqual(rebuilt.get(h.input), first.reference);
  assert.deepEqual(rebuilt.retain(h.input).reference, first.reference);
  assert.deepEqual(rebuilt.protectedObjects('p1').checkpointIds, ['cp1']);
});
test('distinct references share blobs without duplicating CAS, but same reference cannot change association', t => {
  const h = setup(t); h.retention.retain(h.input);
  const before = h.store.computeUsage('p1');
  h.retention.retain({ ...h.input, referenceId: 'flag-two' });
  const after = h.store.computeUsage('p1');
  const protectedSet = h.retention.protectedObjects('p1');
  assert.equal(after.blobCount, before.blobCount);
  assert.equal(after.bytesByKind.blobs, before.bytesByKind.blobs);
  assert.equal(after.bytesByKind.retention, protectedSet.metadataBytes);
  assert.ok(after.totalBytes > before.totalBytes);
  assert.equal(after.totalBytes - before.totalBytes, after.bytesByKind.retention - before.bytesByKind.retention);
  h.retention.retain({ ...h.input, referenceId: 'flag-two' });
  assert.deepEqual(h.store.computeUsage('p1'), after);
  assert.equal(protectedSet.referenceCount, 2); assert.deepEqual(protectedSet.blobHashes, [...h.hashes].sort());
  assert.deepEqual(protectedSet.checkpointIds, ['cp1']); assert.ok(protectedSet.metadataBytes > 0);
  for (const field of ['checkpointId', 'conversationId', 'turnId', 'agentId']) {
    assert.throws(() => h.retention.retain({ ...h.input, [field]: 'other' }), rejected('retention_conflict'));
  }
  assert.equal(h.records().length, 2);
});
test('every known checkpoint identity must match and missing associations cannot retain', t => {
  for (const field of ['projectId', 'checkpointId', 'conversationId', 'turnId', 'agentId']) {
    const h = setup(t); h.checkpoint[field] = 'other'; h.store.saveCheckpoint('p1', { ...h.checkpoint, checkpointId: 'cp1' });
    if (field === 'checkpointId') h.store.loadCheckpoint = () => h.checkpoint;
    assert.throws(() => h.retention.retain(h.input), rejected('retention_checkpoint_mismatch'));
    assert.equal(h.records().length, 0);
  }
  const h = setup(t);
  for (const value of ['', '..', '../p1', ' p1', 'a/b']) {
    assert.throws(() => h.retention.retain({ ...h.input, projectId: value }), rejected('retention_invalid_input'));
  }
  assert.throws(() => h.retention.retain({ ...h.input, captured: true }), rejected('retention_invalid_input'));
});
test('missing manifest and malformed schema fail without publishing a reference', t => {
  for (const checkpoint of [null, { schemaVersion: 2 }, { schemaVersion: 1, files: [] }]) {
    const h = setup(t); h.store.loadCheckpoint = () => checkpoint;
    assert.throws(() => h.retention.retain(h.input)); assert.equal(h.records().length, 0);
  }
});
test('malformed replay input is a coded manifest error before any retained blob access', t => {
  for (const replay of [undefined, null, [], 'invalid']) {
    const h = setup(t); h.checkpoint.replayInput = replay; h.save();
    let reads = 0; h.store.readBlob = () => { reads++; throw Error('must not read'); };
    assert.throws(() => h.retention.retain(h.input), { code: 'retention_manifest_invalid' });
    assert.equal(reads, 0); assert.equal(h.records().length, 0);
  }
});
test('missing or same-size corrupted file/prompt/session/config/skill blob rejects retention', t => {
  for (const index of [0, 1, 2, 3, 4]) for (const mode of ['missing', 'corrupt']) {
    const h = setup(t), file = h.blobPath(h.hashes[index]);
    if (mode === 'missing') fs.unlinkSync(file); else fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 120));
    assert.throws(() => h.retention.retain(h.input), rejected(mode === 'missing' ? 'retention_blob_missing' : 'retention_blob_corrupt'));
    assert.equal(h.records().length, 0);
  }
});
test('unsafe hash never reaches blob reader; invalid skill hash and missing file hash fail closed', t => {
  for (const mutate of [c => { c.files['a.txt'].hash = '../escape'; }, c => { delete c.files['a.txt'].hash; },
    c => { c.replayInput.harness.skillSnapshots[0].sha256 = '0'.repeat(64); },
    c => { c.replayInput.harness.skillSnapshots = {}; }, c => { c.files['a.txt'].type = 'future-attachment'; }]) {
    const h = setup(t); mutate(h.checkpoint); h.save(); let reads = 0;
    h.store.readBlob = () => { reads++; throw new Error('should not read'); };
    assert.throws(() => h.retention.retain(h.input), rejected('retention_manifest_invalid'));
    assert.equal(reads, 0); assert.equal(h.records().length, 0);
  }
});
test('excluded files and missing resume input retain honest incomplete metadata, never invent missing blobs', t => {
  const h = setup(t);
  h.checkpoint.files['secret.txt'] = { type: 'file', secretExcluded: true, hash: '', size: 1 };
  h.checkpoint.files.link = { type: 'symlink', linkTarget: 'a.txt', escapes: false };
  h.checkpoint.replayInput.sessionBlobHash = '';
  h.checkpoint.replayInput.incompleteReasons.push('session_missing'); h.save();
  const { reference } = h.retention.retain(h.input);
  assert.equal(reference.checkpoint.replayInput.deliveryMode, 'resume');
  assert.equal(reference.checkpoint.replayInput.complete, false);
  assert.ok(reference.checkpoint.replayInput.incompleteReasons.includes('session_missing'));
  assert.equal(reference.blobHashes.includes(h.hashes[2]), false);
  assert.equal('runnable' in reference, false);
});
test('corrupt inventory is not silently skipped, and cannot be overwritten by retry', t => {
  const h = setup(t); h.retention.retain(h.input);
  const target = path.join(h.directory, h.records()[0]); fs.writeFileSync(target, '{broken');
  assert.throws(() => h.retention.get(h.input), rejected('retention_record_invalid'));
  assert.throws(() => h.retention.retain(h.input), rejected('retention_record_invalid'));
  assert.throws(() => h.retention.protectedObjects('p1'), rejected('retention_record_invalid'));
  assert.equal(fs.readFileSync(target, 'utf8'), '{broken');
});
test('valid JSON with a bad checksum cannot be read, inventoried or replaced', t => {
  const h = setup(t); h.retention.retain(h.input);
  const target = path.join(h.directory, h.records()[0]), envelope = JSON.parse(fs.readFileSync(target));
  envelope.record.checkpoint.deletions.push('tampered.txt');
  fs.writeFileSync(target, JSON.stringify(envelope));
  for (const read of [() => h.retention.get(h.input), () => h.retention.retain(h.input), () => h.retention.protectedObjects('p1')]) {
    assert.throws(read, rejected('retention_record_invalid'));
  }
  assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify(envelope));
});
test('checksum-valid but omitted closure or foreign association blocks protection inventory', t => {
  for (const mutate of [r => { r.blobHashes.pop(); }, r => { r.checkpoint.projectId = 'p2'; }, r => { r.checkpoint.schemaVersion = 2; }]) {
    const h = setup(t); h.retention.retain(h.input);
    const target = path.join(h.directory, h.records()[0]), envelope = JSON.parse(fs.readFileSync(target));
    mutate(envelope.record); envelope.checksum = sha256Hex(JSON.stringify(envelope.record));
    fs.writeFileSync(target, JSON.stringify(envelope));
    assert.throws(() => h.retention.protectedObjects('p1'), rejected('retention_record_invalid'));
  }
});
test('checksum-valid unknown record fields are rejected without rewriting the record', t => {
  const h = setup(t); h.retention.retain(h.input);
  const target = path.join(h.directory, h.records()[0]), envelope = JSON.parse(fs.readFileSync(target));
  envelope.record.unrecognizedField = true;
  envelope.checksum = sha256Hex(JSON.stringify(envelope.record));
  const bytes = JSON.stringify(envelope); fs.writeFileSync(target, bytes);
  for (const read of [() => h.retention.get(h.input), () => h.retention.retain(h.input), () => h.retention.protectedObjects('p1')]) {
    assert.throws(read, rejected('retention_record_invalid'));
    assert.equal(fs.readFileSync(target, 'utf8'), bytes);
  }
});
test('static symlink to an otherwise valid record is rejected by get, retry and inventory', { skip: process.platform === 'win32' }, t => {
  const h = setup(t), first = h.retention.retain(h.input);
  const target = path.join(h.directory, h.records()[0]), outside = path.join(h.root, 'record-outside-retention.json');
  fs.renameSync(target, outside);
  const bytes = fs.readFileSync(outside);
  fs.symlinkSync(outside, target);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  for (const read of [() => h.retention.get(h.input), () => h.retention.retain(h.input), () => h.retention.protectedObjects('p1')]) {
    assert.throws(read, rejected('retention_record_invalid'));
    assert.deepEqual(fs.readFileSync(outside), bytes);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  }
  // Positive control: identical bytes at a regular path remain readable.
  fs.unlinkSync(target); fs.renameSync(outside, target);
  assert.deepEqual(h.retention.get(h.input), first.reference);
});
test('publication fails closed on disk/link error, cleans own temp and permits retry', t => {
  const h = setup(t), original = fs.linkSync;
  try { fs.linkSync = () => { throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' }); };
    assert.throws(() => h.retention.retain(h.input), rejected('retention_write_failed'));
  } finally { fs.linkSync = original; }
  assert.equal(h.records().length, 0); assert.deepEqual(fs.readdirSync(h.directory), []);
  assert.equal(h.retention.retain(h.input).created, true);
});
test('interleaved same-reference publication converges without overwriting winner', t => {
  const h = setup(t), original = fs.linkSync; let winner;
  try { fs.linkSync = (...args) => {
    fs.linkSync = original;
    winner = createCheckpointRetentionStore(h.options).retain(h.input);
    return original(...args);
  };
    const loser = h.retention.retain(h.input);
    assert.equal(winner.created, true); assert.equal(loser.created, false); assert.deepEqual(loser.reference, winner.reference);
  } finally { fs.linkSync = original; }
  assert.equal(h.records().length, 1); assert.equal(fs.readdirSync(h.directory).length, 1);
});
test('losing publisher verifies the different winner closure after publication, then retry recovers', t => {
  const h = setup(t), original = fs.linkSync;
  const winnerBytes = Buffer.from('concurrent winner prompt'), winnerHash = h.blob(winnerBytes);
  let winner, intercepted = 0;
  try {
    fs.linkSync = (...args) => {
      intercepted++;
      fs.linkSync = original;
      // The outer publisher already verified its old prompt; a separate writer
      // freezes a new prompt under the same association before it can publish.
      h.checkpoint.replayInput.promptBlobHash = winnerHash; h.save();
      winner = createCheckpointRetentionStore(h.options).retain(h.input);
      fs.unlinkSync(h.blobPath(winnerHash));
      return original(...args); // EEXIST: outer writer must verify the winner.
    };
    assert.throws(() => h.retention.retain(h.input), rejected('retention_blob_missing'));
  } finally { fs.linkSync = original; }
  assert.equal(fs.linkSync, original); assert.equal(intercepted, 1);
  assert.equal(winner.created, true);
  assert.ok(winner.reference.blobHashes.includes(winnerHash));
  assert.equal(winner.reference.blobHashes.includes(h.hashes[1]), false);
  assert.equal(h.records().length, 1); assert.equal(fs.readdirSync(h.directory).length, 1);
  const target = path.join(h.directory, h.records()[0]), persistedBytes = fs.readFileSync(target);
  assert.deepEqual(h.retention.get(h.input), winner.reference); // Metadata, not a blob integrity claim.
  assert.throws(() => h.retention.retain(h.input), rejected('retention_blob_missing'));
  h.store.writeBlob('p1', winnerHash, winnerBytes);
  const retry = createCheckpointRetentionStore(h.options).retain(h.input);
  assert.equal(retry.created, false); assert.deepEqual(retry.reference, winner.reference);
  assert.deepEqual(fs.readFileSync(target), persistedBytes);
});
test('retry rechecks retained blob integrity without trusting a modified live checkpoint', t => {
  const h = setup(t); h.retention.retain(h.input);
  h.checkpoint.replayInput.promptBlobHash = h.blob('new prompt'); h.save();
  fs.unlinkSync(h.blobPath(h.hashes[1]));
  assert.throws(() => h.retention.retain(h.input), rejected('retention_blob_missing'));
  // Inventory still protects the original reference, even when its bytes are
  // missing: inventory is not an integrity claim or permission to delete.
  assert.ok(h.retention.protectedObjects('p1').blobHashes.includes(h.hashes[1]));
  assert.equal(h.records().length, 1);
});
test('fresh input and absent optional hashes preserve mode and do not invent a session reference', t => {
  const h = setup(t); h.checkpoint.replayInput.deliveryMode = 'fresh';
  h.checkpoint.replayInput.sessionBlobHash = ''; h.save();
  const { reference } = h.retention.retain(h.input);
  assert.equal(reference.checkpoint.replayInput.deliveryMode, 'fresh');
  assert.equal(reference.blobHashes.includes(h.hashes[2]), false);
});
test('inventory fails closed on unknown entries, directories, and in-progress temp publication', t => {
  for (const name of ['unknown.json', '0'.repeat(64) + '.json', '0'.repeat(64) + '.json.tmp-in-flight']) {
    const h = setup(t); h.retention.retain(h.input);
    const target = path.join(h.directory, name);
    if (name.endsWith('.tmp-in-flight')) fs.writeFileSync(target, 'partial'); else fs.mkdirSync(target);
    assert.throws(() => h.retention.protectedObjects('p1'), rejected(name.endsWith('.tmp-in-flight') ? 'retention_inventory_busy' : 'retention_record_invalid'));
  }
  const h = setup(t); assert.deepEqual(h.retention.protectedObjects('p1'), { checkpointIds: [], blobHashes: [], referenceCount: 0, metadataBytes: 0 });
});
test('fsync failure and unreadable blob cannot publish a reference', t => {
  const h = setup(t), original = fs.fsyncSync;
  try { fs.fsyncSync = () => { throw new Error('synthetic flush failure'); };
    assert.throws(() => h.retention.retain(h.input), rejected('retention_write_failed'));
  } finally { fs.fsyncSync = original; }
  assert.equal(h.records().length, 0); assert.deepEqual(fs.readdirSync(h.directory), []);
  h.store.readBlob = () => { throw new Error('synthetic read denied'); };
  assert.throws(() => h.retention.retain(h.input), rejected('retention_blob_unreadable'));
});
test('secret sentinel in a correctly addressed blob blocks retention', t => {
  const h = setup(t); h.checkpoint.replayInput.promptBlobHash = h.blob('sk-' + 'x'.repeat(48)); h.save();
  assert.throws(() => h.retention.retain(h.input), rejected('retention_contains_secret'));
  assert.equal(h.records().length, 0);
});
test('real concurrent processes converge or conflict with one immutable winner', { timeout: 20000 }, async t => {
  const { spawn } = require('node:child_process');
  for (const conflicting of [false, true]) {
    const h = setup(t);
    h.store.saveCheckpoint('p1', { ...h.checkpoint, checkpointId: 'cp2' });
    const program = `const {createCaptureStore}=require(process.argv[1]);
      const {createCheckpointRetentionStore}=require(process.argv[2]);
      try { const r=createCheckpointRetentionStore({captureStore:createCaptureStore({captureRoot:process.argv[3]})}).retain(JSON.parse(process.argv[4]));
        console.log(JSON.stringify({created:r.created,reference:r.reference})); }
      catch(e) { console.log(JSON.stringify({error:e.code})); }`;
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
      const input = { ...h.input, checkpointId: conflicting && index % 2 ? 'cp2' : 'cp1' };
      const child = spawn(process.execPath, ['-e', program, require.resolve('../../build/server/domain/runtime/badcase-capture/capture-store'),
        require.resolve('../../build/server/domain/runtime/badcase-capture/checkpoint-retention'), h.root, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      let out = ''; child.stdout.on('data', bytes => { out += bytes; }); child.stderr.resume();
      child.on('error', reject); child.on('close', code => {
        try { assert.equal(code, 0); resolve(JSON.parse(out)); } catch (error) { reject(error); }
      });
    })));
    const winner = results.find(r => r.created);
    assert.ok(winner); assert.equal(results.filter(r => r.created).length, 1);
    assert.equal(results.filter(r => r.error === 'retention_conflict').length, conflicting ? 4 : 0);
    for (const result of results.filter(r => !r.error)) assert.deepEqual(result.reference, winner.reference);
    assert.equal(h.records().length, 1); assert.equal(fs.readdirSync(h.directory).length, 1);
    const target = path.join(h.directory, h.records()[0]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  }
});
test('real Linux collector manifests can be retained and restored twice after source manifest deletion', { skip: process.platform !== 'linux', timeout: 20000 }, t => {
  const { createLegacyNativeCaptureService: createBadcaseCaptureService } = require('../helpers/legacy-native-capture');
  const { restoreCheckpoint } = require('../../build/server/domain/runtime/badcase-capture/restore');
  const { execFileSync } = require('node:child_process');
  const h = setup(t), target = path.join(h.root, 'source'); fs.mkdirSync(target);
  execFileSync('git', ['init', '-q', target]); fs.writeFileSync(path.join(target, 'dirty.txt'), 'retained bytes');
  const service = createBadcaseCaptureService({ captureRoot: path.join(h.root, 'real-cas') });
  service.savePolicy('p1', { status: 'enabled', authorizedDirs: [target] }); service.authorizeProject('p1');
  for (const deliveryMode of ['fresh', 'resume']) {
    const result = service.captureTurnCheckpoint({ projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1', targetDir: target,
      deliveryMode, prompt: 'synthetic prompt', images: [], runConfig: { model: 'test', provider: 'test', promptVersion: 'v1' },
      harness: { serverVersion: 'test', configSnapshot: { agentPromptVersion: 'v1', toolBridgeEnabled: true, piVersion: '0.85.1', deliveryMode, agentName: 'test' }, skillSnapshots: [] } });
    assert.equal(result.captured, true, result.reason);
    const retention = createCheckpointRetentionStore({ captureStore: service.store });
    const { reference } = retention.retain({ ...h.input, checkpointId: result.checkpointId, referenceId: deliveryMode });
    assert.equal(reference.checkpoint.replayInput.deliveryMode, deliveryMode);
    if (deliveryMode === 'resume') { assert.equal(reference.checkpoint.replayInput.complete, false); assert.ok(reference.checkpoint.replayInput.incompleteReasons.includes('session_missing')); }
    fs.unlinkSync(path.join(service.captureRoot, 'projects/p1/checkpoints', result.checkpointId + '.json'));
    const view = { ...service.store, loadCheckpoint: () => reference.checkpoint };
    for (const attempt of [1, 2]) {
      const restored = path.join(h.root, `restore-${deliveryMode}-${attempt}`);
      assert.equal(restoreCheckpoint({ store: view, projectId: 'p1', checkpointId: result.checkpointId, targetDir: restored }).ok, true);
      assert.deepEqual(fs.readdirSync(restored), ['dirty.txt']); assert.equal(fs.readFileSync(path.join(restored, 'dirty.txt'), 'utf8'), 'retained bytes');
    }
  }
});
test('secret sentinel in a retained manifest is rejected without copying it', t => {
  const h = setup(t); h.checkpoint.environment = { text: 'sk-' + 'x'.repeat(48) }; h.save();
  assert.throws(() => h.retention.retain(h.input), rejected('retention_contains_secret'));
  assert.equal(h.records().length, 0);
});
