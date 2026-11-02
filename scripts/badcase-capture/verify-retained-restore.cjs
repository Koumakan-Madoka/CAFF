// Explicit real-Docker verification of SYNTHETIC sealed materials only.
// No real capture, production DB, SDK, model, network, mount, image pull/build.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { saveSealedCase } = require('../../build/server/domain/runtime/badcase-capture/sealed-case');
const { createReplayRunReferenceStore } = require('../../build/server/domain/runtime/badcase-capture/run-references');
const { runRetainedRestoreProbe } = require('../../build/server/domain/runtime/badcase-capture/retained-restore');
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf('--' + name); if (i < 0 || !args[i + 1]) throw Error('Missing --' + name); return args[i + 1]; }
const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
if (process.platform !== 'linux') throw Error('Linux required; no automatic WSL fallback');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-real-retained-'));
  try {
    const store = createCaptureStore({ captureRoot: root });
    const association = { projectId: 'p1', conversationId: 'c1', messageId: 'm1', turnId: 't1', agentId: 'a1', taskId: 'task1', checkpointId: 'cp1', runId: 1 };
    const flagId = 'flag-' + sha256Hex('p1\0m1');
    const files = {};
    for (const [name, text] of Object.entries({ 'tracked.txt': 'committed bytes', 'dirty.txt': 'dirty bytes', 'untracked.txt': 'untracked bytes', 'authorized-ignored.txt': 'included ignored bytes', 'nested/task.cjs': 'throw Error("captured program must never execute")', 'package.json': '{"type":"module","scripts":{"preinstall":"false"}}' })) {
      const content = Buffer.from(text), hash = sha256Hex(content); store.writeBlob('p1', hash, content);
      files[name] = { type: 'file', hash, size: content.length, mode: 0o100755 };
    }
    const cp = { schemaVersion: 1, projectId: 'p1', checkpointId: 'cp1', conversationId: 'c1', turnId: 't1', agentId: 'a1', files, deletions: ['deleted.txt'], uncaptured: [],
      replayInput: { deliveryMode: 'resume', complete: false, incompleteReasons: ['session_missing'], harness: { skillSnapshots: [] } } };
    store.saveCheckpoint('p1', cp); saveSealedCase({ captureRoot: root, association, flagId });
    fs.unlinkSync(path.join(root, 'projects/p1/checkpoints/cp1.json')); // prove there is no live fallback
    const input = { captureRoot: root, association, flagId, image, timeoutMs: 15000, replayRunId: 'probe-first' };
    const first = await runRetainedRestoreProbe(input);
    const second = await runRetainedRestoreProbe({ ...input, replayRunId: 'probe-second' });
    for (const r of [first, second]) {
      assert.equal(r.filesVerified, true); assert.equal(r.execution.cleaned, true);
      assert.equal(r.provenance.deliveryMode, 'resume'); assert.equal(r.provenance.runnable, false);
      assert.equal(r.provenance.fileModePreserved, false);
    }
    assert.notEqual(first.execution.containerId, second.execution.containerId);
    assert.equal(first.snapshotHash, second.snapshotHash); assert.equal(first.execution.inputHash, second.execution.inputHash);
    const refs = createReplayRunReferenceStore({ captureStore: store }).protectedObjects('p1');
    assert.equal(refs.referenceCount, 2); assert.equal(refs.deletionAuthorized, false);
    for (const f of Object.values(files)) assert.equal(sha256Hex(store.readBlob('p1', f.hash)), f.hash, 'container edits cannot change CAS');
    const f = files['dirty.txt']; fs.writeFileSync(path.join(root, 'projects/p1/blobs', f.hash.slice(0, 2), f.hash), 'damage');
    await assert.rejects(runRetainedRestoreProbe({ ...input, replayRunId: 'probe-blocked' }), /restore_blob_corrupt/);
    assert.equal(fs.readdirSync(path.join(root, 'projects/p1/runReferences')).length, 2);
    console.log(JSON.stringify({ ok: true, image, snapshotHash: first.snapshotHash, inputHash: first.execution.inputHash,
      isolatedCopies: 2, fileCount: Object.keys(files).length, deletionCount: 1, protectedReferences: 2,
      cleanedContainerIds: [first.execution.containerId, second.execution.containerId], corruptedBlob: 'blocked_before_docker',
      deliveryMode: first.provenance.deliveryMode, modePreserved: false, source: 'synthetic_sealed_case',
      modelInvocations: 0, piExecuted: false, replayAcceptance: false }, null, 2));
  } finally { fs.rmSync(root, { recursive: true, force: true }); } // only this synthetic temporary store
})().catch(e => { console.error(JSON.stringify({ ok: false, code: e.code || e.message, containerId: e.containerId || null, containerName: e.containerName || null })); process.exitCode = 1; });
