const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { saveSealedCase } = require('../../build/server/domain/runtime/badcase-capture/sealed-case');
const { createReplayRunReferenceStore } = require('../../build/server/domain/runtime/badcase-capture/run-references');
const { prepareRetainedRestoreProbe, runRetainedRestoreProbe } = require('../../build/server/domain/runtime/badcase-capture/retained-restore');
const image = { imageId: 'sha256:' + 'a'.repeat(64), repositoryDigest: 'node@sha256:' + 'b'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
function fixture(t, change = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-retained-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root });
  const association = { projectId: 'p1', conversationId: 'c1', messageId: 'm1', turnId: 't1', agentId: 'a1', taskId: 'task1', checkpointId: 'cp1', runId: 1 };
  const flagId = 'flag-' + sha256Hex('p1\0m1');
  const content = Buffer.from('frozen dirty and untracked bytes\n'), blobHash = sha256Hex(content);
  store.writeBlob('p1', blobHash, content);
  const checkpoint = { schemaVersion: 1, projectId: 'p1', checkpointId: 'cp1', conversationId: 'c1', turnId: 't1', agentId: 'a1',
    targetDir: '/not-readable/live', files: { 'nested/data.txt': { type: 'file', hash: blobHash, size: content.length, mode: 0o100755 } },
    deletions: ['gone.txt'], uncaptured: [], replayInput: { deliveryMode: 'resume', complete: false, incompleteReasons: ['session_missing'], harness: { skillSnapshots: [] } } };
  change(checkpoint, store);
  store.saveCheckpoint('p1', checkpoint);
  const request = { captureRoot: root, association, flagId, replayRunId: 'probe-one', image, timeoutMs: 5000 };
  saveSealedCase({ captureRoot: root, association, flagId });
  const source = path.join(root, 'projects/p1/retention', sha256Hex(flagId) + '.json');
  const cases = path.join(root, 'projects/p1/cases', sha256Hex('m1') + '.json');
  const runDir = path.join(root, 'projects/p1/runReferences');
  const runFile = path.join(runDir, sha256Hex('probe-one') + '.json');
  const blob = path.join(root, 'projects/p1/blobs', blobHash.slice(0, 2), blobHash);
  return { root, store, checkpoint, request, source, cases, runDir, runFile, blob, blobHash, content };
}
function rewriteSource(h, change) {
  const envelope = JSON.parse(fs.readFileSync(h.source)); change(envelope.record);
  envelope.checksum = sha256Hex(JSON.stringify(envelope.record)); fs.writeFileSync(h.source, JSON.stringify(envelope));
}
test('frozen case is the only source; payload excludes host paths/prompt/session and protection precedes Docker', async t => {
  const h = fixture(t);
  h.checkpoint.files = {}; h.store.saveCheckpoint('p1', h.checkpoint);
  fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
  const p = prepareRetainedRestoreProbe(h.request);
  assert.ok(fs.existsSync(h.runFile)); assert.equal(p.provenance.deliveryMode, 'resume');
  assert.equal(p.provenance.fileModePreserved, false); assert.equal(p.provenance.replayInputComplete, false);
  assert.deepEqual(p.task.files.map(f => f.path).sort(), ['restore-plan.json', 'restore-probe.cjs', 'snapshot/nested/data.txt']);
  assert.equal(Buffer.from(p.task.files.find(f => f.path === 'snapshot/nested/data.txt').base64, 'base64').toString(), h.content.toString());
  assert.equal(JSON.stringify(p.task).includes('/not-readable/live'), false);
  const usage = h.store.computeUsage('p1'); const again = prepareRetainedRestoreProbe(h.request);
  assert.equal(p.inputHash, again.inputHash); assert.equal(p.snapshotHash, again.snapshotHash); assert.deepEqual(h.store.computeUsage('p1'), usage);
  const second = prepareRetainedRestoreProbe({ ...h.request, replayRunId: 'probe-two' });
  assert.equal(second.inputHash, p.inputHash); assert.equal(second.snapshotHash, p.snapshotHash);
  assert.equal(createReplayRunReferenceStore({ captureStore: h.store }).protectedObjects('p1').referenceCount, 2);
  let calls = 0;
  await assert.rejects(runRetainedRestoreProbe(h.request, { runDocker: async () => { calls++; assert.ok(fs.existsSync(h.runFile)); throw Error('synthetic daemon unavailable'); } }), /synthetic daemon unavailable/);
  assert.equal(calls, 1); assert.ok(fs.existsSync(h.runFile), 'failed start must not unprotect');
});
test('missing case or retained source refuses before Docker and never synthesizes from live', async t => {
  for (const which of ['cases', 'source']) {
    const h = fixture(t); fs.unlinkSync(h[which]); let calls = 0;
    await assert.rejects(runRetainedRestoreProbe(h.request, { runDocker: async () => { calls++; } }), /restore_(case|source)_missing/);
    assert.equal(calls, 0); assert.equal(fs.existsSync(h.runDir), false); assert.equal(fs.existsSync(h[which]), false);
  }
});
test('missing/corrupt blobs block new and repeated probes without unprotecting', async t => {
  for (const previous of [false, true]) for (const missing of [false, true]) {
    const h = fixture(t); if (previous) prepareRetainedRestoreProbe(h.request);
    if (missing) fs.unlinkSync(h.blob); else fs.writeFileSync(h.blob, 'damaged');
    let calls = 0;
    await assert.rejects(runRetainedRestoreProbe(h.request, { runDocker: async () => { calls++; } }), /restore_blob_(missing|corrupt)/);
    assert.equal(calls, 0); assert.equal(fs.existsSync(h.runFile), previous);
  }
});
test('unsafe paths, inconsistent size, links, excluded secrets and uncaptured gaps never become partial restore success', t => {
  const mutations = [
    c => { c.files['../outside'] = c.files['nested/data.txt']; },
    c => { c.files['/absolute'] = c.files['nested/data.txt']; },
    c => { c.files['nested'] = c.files['nested/data.txt']; },
    c => { c.files['nested/data.txt'].size++; },
    c => { c.files['linked'] = { type: 'symlink', linkTarget: 'nested/data.txt' }; },
    c => { c.files['excluded'] = { type: 'file', secretExcluded: true }; },
    c => { c.uncaptured = [{ path: 'missing', reason: 'unreadable' }]; },
    c => { c.deletions = ['../outside']; },
    c => { c.deletions = ['nested/data.txt']; },
    c => { c.deletions = ['nested']; },
    c => { c.deletions = ['gone.txt', 'gone.txt']; },
  ];
  for (const mutate of mutations) {
    const h = fixture(t, mutate);
    assert.throws(() => prepareRetainedRestoreProbe(h.request), /restore_|offline_input_invalid/);
    assert.equal(fs.existsSync(h.runDir), false);
  }
});
test('all referenced inputs are verified but never inserted into file-only probe', t => {
  const h = fixture(t, (c, store) => {
    const bytes = Buffer.from('synthetic authorized prompt, not to be executed'); const hash = sha256Hex(bytes);
    store.writeBlob('p1', hash, bytes); c.replayInput.promptBlobHash = hash;
  });
  const p = prepareRetainedRestoreProbe(h.request);
  assert.equal(JSON.stringify(p.task).includes('synthetic authorized prompt'), false);
  const envelope = JSON.parse(fs.readFileSync(h.source)); const hash = envelope.record.checkpoint.replayInput.promptBlobHash;
  fs.unlinkSync(path.join(h.root, 'projects/p1/blobs', hash.slice(0, 2), hash));
  assert.throws(() => prepareRetainedRestoreProbe(h.request), /retention_blob_missing/);
  assert.ok(fs.existsSync(h.runFile));
});
test('scope/config malformed, run reuse conflicts and changed retained source fail closed', t => {
  const h = fixture(t);
  for (const patch of [{ entrypoint: 'attacker.cjs' }, { replayRunId: '../x' }, { timeoutMs: 0 }, { image: { ...image, imageId: 'node:latest' } }, { association: { ...h.request.association, turnId: 'different' } }]) {
    assert.throws(() => prepareRetainedRestoreProbe({ ...h.request, ...patch }));
    assert.equal(fs.existsSync(h.runDir), false);
  }
  prepareRetainedRestoreProbe(h.request);
  rewriteSource(h, r => { r.checkpoint.deletions.push('new-deletion'); });
  assert.throws(() => prepareRetainedRestoreProbe(h.request), /run_reference_record_invalid/);
  assert.ok(fs.existsSync(h.runFile));
});
test('busy store and quota rejection happen before Docker, leaving case intact', async t => {
  for (const which of ['busy', 'quota']) {
    const h = fixture(t); const before = fs.readFileSync(h.cases);
    if (which === 'busy') fs.mkdirSync(path.join(h.root, 'projects/p1/.writer-lock'));
    else h.store.savePolicy({ ...h.store.loadPolicy('p1'), stagingQuotaBytes: h.store.computeUsage('p1').totalBytes });
    let calls = 0;
    await assert.rejects(runRetainedRestoreProbe(h.request, { runDocker: async () => { calls++; } }), which === 'busy' ? /capture_writer_busy/ : /run_reference_quota_exceeded/);
    assert.equal(calls, 0); assert.equal(fs.existsSync(h.runDir), false); assert.deepEqual(fs.readFileSync(h.cases), before);
  }
});
test('fixed receipt is checked after cleanup; fake runtime success alone cannot certify restoration', async t => {
  for (const which of ['valid', 'wrong', 'stderr', 'failed']) {
    const h = fixture(t); const plan = prepareRetainedRestoreProbe(h.request);
    const fake = require('../helpers/badcase-fake-docker.cjs')(image, { change(args, result) {
      if (args[0] === 'start') {
        assert.ok(fs.existsSync(h.runFile));
        result.stdout = which === 'wrong' ? '{}' : JSON.stringify(plan.expectedReceipt);
        if (which === 'stderr') result.stderr = 'unexpected';
        if (which === 'failed') result.code = 7;
      }
      if (which === 'failed' && args[0] === 'inspect') { const i = JSON.parse(result.stdout)[0]; i.State.ExitCode = 7; result.stdout = JSON.stringify([i]); }
    } });
    if (['wrong', 'stderr'].includes(which)) await assert.rejects(runRetainedRestoreProbe(h.request, { runDocker: fake.run }), /restore_probe_output_invalid/);
    else {
      const r = await runRetainedRestoreProbe(h.request, { runDocker: fake.run });
      assert.equal(r.filesVerified, which === 'valid'); assert.equal(r.execution.cleaned, true);
      assert.equal(r.provenance.runnable, false); assert.equal(r.provenance.deliveryMode, 'resume');
    }
    assert.ok(fake.calls.some(c => c.args[0] === 'rm')); assert.ok(fs.existsSync(h.runFile));
  }
});
test('completed execution still requires cleaned=true and matching input hash', async t => {
  const sandbox = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
  const original = sandbox.runOfflineDockerTask;
  t.after(() => { sandbox.runOfflineDockerTask = original; });
  const h = fixture(t), p = prepareRetainedRestoreProbe(h.request);
  for (const patch of [{ cleaned: false }, { inputHash: 'a'.repeat(64) }]) {
    sandbox.runOfflineDockerTask = async () => ({ state: 'completed', cleaned: true, inputHash: p.inputHash,
      stdout: JSON.stringify(p.expectedReceipt), stderr: '', ...patch });
    await assert.rejects(runRetainedRestoreProbe(h.request), { code: 'restore_probe_output_invalid' });
  }
});
test('4094 files fit the two-file probe overhead; 4095 reject before protection', t => {
  for (const count of [4094, 4095]) {
    const h = fixture(t, c => {
      const entry = c.files['nested/data.txt'];
      c.files = Object.fromEntries(Array.from({ length: count }, (_, i) => ['f' + i, { ...entry }]));
    });
    if (count === 4094) assert.equal(prepareRetainedRestoreProbe(h.request).task.files.length, 4096);
    else { assert.throws(() => prepareRetainedRestoreProbe(h.request), { code: 'restore_manifest_unsupported' }); assert.equal(fs.existsSync(h.runDir), false); }
  }
});
test('valid-hash secret blob cannot pass through retained restore', t => {
  const h = fixture(t), content = Buffer.from('sk-' + 'SYNTHETIC_ONLY_123456'), digest = sha256Hex(content);
  h.store.writeBlob('p1', digest, content);
  rewriteSource(h, r => {
    const file = r.checkpoint.files['nested/data.txt']; file.hash = digest; file.size = content.length;
    r.blobHashes = [digest];
  });
  assert.throws(() => prepareRetainedRestoreProbe(h.request), { code: 'restore_contains_secret' });
  assert.equal(fs.existsSync(h.runDir), false);
});
test('malformed retained delivery mode is rejected with a fixed code rather than TypeError', t => {
  for (const change of [c => { delete c.replayInput; }, c => { c.replayInput.deliveryMode = 'unknown'; }]) {
    const h = fixture(t); rewriteSource(h, r => change(r.checkpoint));
    assert.throws(() => prepareRetainedRestoreProbe(h.request), { code: 'retention_record_invalid' });
    assert.equal(fs.existsSync(h.runDir), false);
  }
});
test('empty file tree is a valid content-only restore plan; mode stays resume and never becomes runnable', t => {
  const h = fixture(t, c => { c.files = {}; });
  const p = prepareRetainedRestoreProbe(h.request);
  assert.equal(p.task.files.length, 2); assert.equal(p.expectedReceipt.fileCount, 0);
  assert.equal(p.provenance.deliveryMode, 'resume');
  for (const key of ['runnable', 'reproduced', 'evaluable', 'strictEvalEligible']) assert.equal(p.provenance[key], false);
});
