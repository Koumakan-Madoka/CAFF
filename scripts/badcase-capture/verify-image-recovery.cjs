// Invoked only by verify-image-recovery.py after dedicated daemon namespace checks.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { archiveImage } = require('./image-archive.cjs');
const { restoreImageArchive } = require('./image-recovery.cjs');
const { archiveRuntime } = require('./runtime-archive.cjs');
const { archiveHarness } = require('./harness-archive.cjs');
const { runRetainedSdkDiagnostic } = require('./retained-sdk-diagnostic.cjs');
const fixture = require('../../tests/helpers/badcase-initialization-fixture.cjs');
async function main() {
  const args = process.argv.slice(2);
  const arg = n => { const i = args.indexOf('--' + n); assert.ok(i >= 0 && args[i + 1]); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  const target = { socket: arg('socket'), daemonId: arg('daemon-id'), dataRoot: arg('data-root') };
  const directory = target.socket.slice('unix://'.length, -'/docker.sock'.length);
  const root = path.join(directory, 'artifacts'); fs.mkdirSync(root, { mode: 0o700 });
  const cleanup = [], ids = [], reports = [];
  try {
    let start = performance.now();
    const ref = await archiveImage(image, path.join(root, 'image')), exportMs = performance.now() - start;
    let calls = 0;
    await assert.rejects(restoreImageArchive({ ...ref, archiveHash: '0'.repeat(64) }, target, { runDocker: async () => { calls++; } }));
    assert.equal(calls, 0);
    start = performance.now(); const restored = await restoreImageArchive(ref, target), restoreMs = performance.now() - start;
    const repo = path.resolve(__dirname, '../..');
    const runtimeArchive = archiveRuntime(repo, path.join(root, 'runtime'));
    const harnessArchive = archiveHarness(repo, path.join(root, 'harness'));
    for (const mode of ['fresh', 'resume']) {
      const h = fixture({ after: fn => cleanup.push(fn) }, mode);
      fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
      const options = { runtimeArchive, harnessArchive, runProbe: restored.runProbe };
      const a = await runRetainedSdkDiagnostic(h.request, image, options);
      const b = await runRetainedSdkDiagnostic({ ...h.request, replayRunId: 'recovered-copy' }, image, options);
      for (const key of ['capsuleHash', 'inputHash', 'runtimeHash', 'historyHash', 'invocationHash']) assert.equal(a[key], b[key]);
      for (const r of [a, b]) { assert.equal(r.modelCalls, 0); assert.equal(r.networkCalls, 0); assert.equal(r.runnable, false); assert.equal(r.cleaned, true); ids.push(r.containerId); }
      assert.equal(a.deliveryMode, mode); assert.equal(fs.readdirSync(h.runDir).length, 2);
      reports.push({ mode, inputHash: a.inputHash, runtimeHash: a.runtimeHash, protectedReferences: 2 });
      await assert.rejects(runRetainedSdkDiagnostic(h.request, image, { ...options, runtimeArchive: { ...runtimeArchive, archiveHash: '0'.repeat(64) } }), { code: 'runtime_archive_invalid' });
    }
    assert.equal(new Set(ids).size, 4);
    console.log(JSON.stringify({ ok: true, identity: restored.identity, archiveBytes: ref.archiveBytes, exportMs, restoreMs,
      reports, cleanedContainerIds: ids, badArchiveRejectedBeforeDocker: true, runtimeAndHarnessArchived: true,
      runtimeVersionsVerifiedInContainers: true, modelInvocations: 0, acceptance: false,
      faithfulReplay: false, artifactsRetainedAfterExperiment: false }));
  } finally { for (const fn of cleanup.reverse()) fn(); }
  // The owning Python lifecycle removes its own artifacts after daemon shutdown.
}
if (require.main === module) main().catch(() => { console.error('image_recovery_verification_failed'); process.exitCode = 1; });
