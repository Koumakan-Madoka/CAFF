// Explicit offline experiment: trusted runtime artifact -> existing Docker diagnostic.
// No real project capture, SDK execution on host, model calls, image export/load/pull or production resources.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { archiveRuntime, readRuntimeArchive } = require('./runtime-archive.cjs');
const { runRetainedSdkDiagnostic } = require('./retained-sdk-diagnostic.cjs');
const { verifyProbeImage } = require('./verify-pi-initialization.cjs');
const fixture = require('../../tests/helpers/badcase-initialization-fixture.cjs');
async function main() {
  if (process.platform !== 'linux') throw Error('linux_required');
  const args = process.argv.slice(2);
  const arg = name => { const i = args.indexOf('--' + name); if (i < 0 || !args[i + 1]) throw Error('arguments_required'); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  await verifyProbeImage(image);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-runtime-proof-')), cleanup = [], reports = [], ids = [];
  const originals = Object.fromEntries(['readFileSync', 'lstatSync', 'readdirSync'].map(k => [k, fs[k]]));
  let installedReads = 0;
  try {
    const start = performance.now();
    const reference = archiveRuntime(path.resolve(__dirname, '../..'), path.join(root, 'runtime'));
    const archiveMs = performance.now() - start;
    // Do not rename/remove the shared installed distribution. Simulate unavailability after archival.
    for (const [key, original] of Object.entries(originals)) fs[key] = (p, ...rest) => {
      if (typeof p === 'string' && p.replaceAll('\\', '/').includes('/node_modules/')) { installedReads++; throw Error('installed_distribution_unavailable'); }
      return original(p, ...rest);
    };
    assert.throws(() => fs.readFileSync('/synthetic/node_modules/forbidden'), /installed_distribution_unavailable/);
    installedReads = 0; // guard positive control above is not a launcher access
    const before = readRuntimeArchive(reference);
    for (const mode of ['fresh', 'resume']) {
      const h = fixture({ after: fn => cleanup.push(fn) }, mode);
      fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
      const a = await runRetainedSdkDiagnostic(h.request, image, { runtimeArchive: reference });
      const b = await runRetainedSdkDiagnostic({ ...h.request, replayRunId: 'archive-copy' }, image, { runtimeArchive: reference });
      for (const k of ['capsuleHash', 'inputHash', 'runtimeHash', 'historyHash', 'invocationHash']) assert.equal(a[k], b[k]);
      assert.equal(a.runtimeHash, reference.runtimeHash); assert.equal(a.deliveryMode, mode);
      assert.equal(a.modelCalls, 0); assert.equal(a.networkCalls, 0); assert.equal(a.runnable, false);
      assert.notEqual(a.containerId, b.containerId); ids.push(a.containerId, b.containerId);
      assert.equal(fs.readdirSync(h.runDir).length, 2);
      reports.push({ mode, inputHash: a.inputHash, runtimeHash: a.runtimeHash, protectedReferences: 2 });
      let calls = 0;
      await assert.rejects(runRetainedSdkDiagnostic(h.request, image, { runtimeArchive: { ...reference, archiveHash: '0'.repeat(64) },
        runProbe: async () => { calls++; } }), { code: 'runtime_archive_invalid' });
      assert.equal(calls, 0);
    }
    assert.equal(installedReads, 0); assert.equal(new Set(ids).size, 4);
    assert.deepEqual(readRuntimeArchive(reference), before);
    fs.unlinkSync(path.join(reference.directory, 'runtime.json'));
    assert.throws(() => readRuntimeArchive(reference), { code: 'runtime_archive_invalid' });
    console.log(JSON.stringify({ ok: true, image, archiveHash: reference.archiveHash, archiveBytes: reference.archiveBytes,
      runtimeHash: reference.runtimeHash, runtimeBytes: reference.runtimeBytes, archiveMs,
      installedSourceAvailability: 'filesystem-shim-denied-after-archive', installedReads,
      reports, cleanedContainerIds: ids, modelInvocations: 0, imageArchived: false,
      harnessArchived: false, artifactRetainedAfterExperiment: false, acceptance: false }, null, 2));
  } finally {
    for (const [k, original] of Object.entries(originals)) fs[k] = original;
    for (const fn of cleanup.reverse()) fn();
    fs.rmSync(root, { recursive: true, force: true }); // only this experiment's temp artifact
  }
}
if (require.main === module) main().catch(e => { console.error(JSON.stringify({ ok: false, code: 'runtime_archive_verification_failed', containerName: e.containerName || null })); process.exitCode = 1; });
