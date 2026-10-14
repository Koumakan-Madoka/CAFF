// Explicit SYNTHETIC-only real Docker evidence: protected capsule -> container data restoration.
// Never consumes user cases, calls SDK/model, enables capture, builds/pulls an image or mounts host paths.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const fixture = require('../../tests/helpers/badcase-initialization-fixture.cjs');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const { runOfflineDockerTask } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const { runRetainedInputProbe, taskFor } = require('./retained-input-probe.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
  if (process.platform !== 'linux') throw Error('linux_required');
  const args = process.argv.slice(2);
  const arg = name => { const i = args.indexOf('--' + name); if (i < 0 || !args[i + 1]) throw Error('arguments_required'); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  const cleanup = [], reports = [], ids = [];
  try {
    for (const mode of ['fresh', 'resume']) {
      const h = fixture({ after: fn => cleanup.push(fn) }, mode, ({ cp, put }) => {
        const text = 'throw Error("captured extension must never execute")';
        cp.files['.pi/extensions/trap.js'] = { type: 'file', size: Buffer.byteLength(text), hash: put(text) };
      });
      fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
      const a = await runRetainedInputProbe(h.request, image);
      const b = await runRetainedInputProbe({ ...h.request, replayRunId: 'copy-b' }, image);
      assert.notEqual(a.containerId, b.containerId);
      for (const k of ['capsuleHash', 'checkpointChecksum', 'materializedHash', 'inputHash']) assert.equal(a[k], b[k]);
      assert.equal(a.deliveryMode, mode); assert.equal(a.fileCount, 2);
      assert.equal(fs.readdirSync(h.runDir).length, 2);
      const p = prepareRetainedInitializationCapsule(h.request);
      for (const blob of JSON.parse(p.capsule).blobs) assert.equal(hash(h.store.readBlob('p1', blob.sha256)), blob.sha256);
      ids.push(a.containerId, b.containerId);
      reports.push({ mode, capsuleHash: a.capsuleHash, materializedHash: a.materializedHash, inputHash: a.inputHash, fileCount: a.fileCount, blobCount: a.blobCount, protectedReferences: 2 });
      if (mode === 'resume') {
        for (const scenario of ['wrong-capsule-hash', 'corrupt-blob', 'unsafe-path', 'missing-resume']) {
          const data = JSON.parse(p.capsule);
          if (scenario === 'corrupt-blob') data.blobs[0].base64 = Buffer.from('corrupt').toString('base64');
          if (scenario === 'unsafe-path') data.checkpoint.files['../escape'] = data.checkpoint.files['source.txt'];
          if (scenario === 'missing-resume') data.checkpoint.replayInput.sessionBlobHash = '';
          const capsule = JSON.stringify(data);
          const expected = { capsuleHash: scenario === 'wrong-capsule-hash' ? '0'.repeat(64) : hash(capsule), checkpointChecksum: hash(JSON.stringify(data.checkpoint)) };
          // Only this synthetic in-memory transport is fault-injected; source CAS is unchanged.
          const r = await runOfflineDockerTask(taskFor(capsule, expected, image));
          assert.equal(r.state, 'failed'); assert.equal(r.exitCode, 1); assert.equal(r.cleaned, true);
          assert.equal(r.stdout, ''); assert.equal(r.stderr, 'capsule_materialization_failed\n');
          assert.equal(fs.readdirSync(h.runDir).length, 2);
          ids.push(r.containerId); reports.push({ scenario, blockedInContainer: true });
        }
      }
    }
    assert.equal(new Set(ids).size, 8);
    console.log(JSON.stringify({ ok: true, image, reports, cleanedContainerIds: ids, piExecuted: false, modelInvocations: 0,
      imageArchived: false, fileModePreserved: false, acceptance: false }, null, 2));
  } finally { for (const fn of cleanup.reverse()) fn(); } // only owned synthetic temporary stores
}
if (require.main === module) main().catch(() => { console.error(JSON.stringify({ ok: false, code: 'retained_inputs_verification_failed' })); process.exitCode = 1; });
