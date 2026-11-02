// Offline synthetic diagnostic: independently archived runtime + five-file container harness.
// Host scheduler remains current trusted code. No model, image export/load/pull, or production resources.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { archiveRuntime, readRuntimeArchive } = require('./runtime-archive.cjs');
const { archiveHarness, readHarnessArchive } = require('./harness-archive.cjs');
const { runRetainedSdkDiagnostic } = require('./retained-sdk-diagnostic.cjs');
const { verifyProbeImage } = require('./verify-pi-initialization.cjs');
const fixture = require('../../tests/helpers/badcase-initialization-fixture.cjs');
async function main() {
  if (process.platform !== 'linux') throw Error('linux_required');
  const args = process.argv.slice(2);
  const arg = name => { const i = args.indexOf('--' + name); if (i < 0 || !args[i + 1]) throw Error('arguments_required'); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  await verifyProbeImage(image);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-harness-proof-')), cleanup = [], reports = [], ids = [];
  const originals = Object.fromEntries(['readFileSync', 'lstatSync', 'readdirSync', 'openSync'].map(k => [k, fs[k]]));
  const repo = path.resolve(__dirname, '../..');
  const blocked = ['scripts/badcase-capture/pi-probe-guards.cjs', 'scripts/badcase-capture/retained-sdk-container.cjs',
    ...['retained-sdk-diagnostic', 'capsule-materialization', 'secrets'].map(n => `build/server/domain/runtime/badcase-capture/${n}.js`)]
    .map(p => path.join(repo, p));
  let sourceAccesses = 0;
  try {
    let start = performance.now();
    const runtime = archiveRuntime(repo, path.join(root, 'runtime')), runtimeArchiveMs = performance.now() - start;
    start = performance.now();
    const harness = archiveHarness(repo, path.join(root, 'harness')), harnessArchiveMs = performance.now() - start;
    // No deletion of shared sources. Deny future source reads only, not already loaded host modules.
    for (const [key, original] of Object.entries(originals)) fs[key] = (p, ...rest) => {
      if (typeof p === 'string' && (path.resolve(p).startsWith(path.join(repo, 'node_modules') + path.sep) || blocked.includes(path.resolve(p)))) {
        sourceAccesses++; throw Error('archived_sources_unavailable');
      }
      return original(p, ...rest);
    };
    assert.throws(() => fs.lstatSync(blocked[0]), /archived_sources_unavailable/);
    assert.throws(() => fs.readFileSync(path.join(repo, 'node_modules/synthetic-sentinel')), /archived_sources_unavailable/);
    sourceAccesses = 0;
    start = performance.now(); const beforeRuntime = readRuntimeArchive(runtime), runtimeReadMs = performance.now() - start;
    start = performance.now(); const beforeHarness = readHarnessArchive(harness), harnessReadMs = performance.now() - start;
    for (const mode of ['fresh', 'resume']) {
      const h = fixture({ after: fn => cleanup.push(fn) }, mode);
      fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
      const options = { runtimeArchive: runtime, harnessArchive: harness };
      const a = await runRetainedSdkDiagnostic(h.request, image, options);
      const b = await runRetainedSdkDiagnostic({ ...h.request, replayRunId: 'harness-copy' }, image, options);
      for (const k of ['capsuleHash', 'inputHash', 'runtimeHash', 'historyHash', 'invocationHash']) assert.equal(a[k], b[k]);
      assert.equal(a.runtimeHash, runtime.runtimeHash); assert.equal(a.deliveryMode, mode);
      assert.equal(a.modelCalls, 0); assert.equal(a.networkCalls, 0); assert.equal(a.runnable, false);
      assert.notEqual(a.containerId, b.containerId); ids.push(a.containerId, b.containerId);
      assert.equal(fs.readdirSync(h.runDir).length, 2);
      reports.push({ mode, inputHash: a.inputHash, runtimeHash: a.runtimeHash, harnessHash: harness.harnessHash, protectedReferences: 2 });
      let calls = 0;
      await assert.rejects(runRetainedSdkDiagnostic(h.request, image, { ...options, harnessArchive: { ...harness, archiveHash: '0'.repeat(64) },
        runProbe: async () => { calls++; } }), { code: 'harness_archive_invalid' });
      assert.equal(calls, 0);
    }
    assert.equal(sourceAccesses, 0); assert.equal(new Set(ids).size, 4);
    assert.deepEqual(readRuntimeArchive(runtime), beforeRuntime); assert.deepEqual(readHarnessArchive(harness), beforeHarness);
    fs.unlinkSync(path.join(harness.directory, 'harness.json'));
    assert.throws(() => readHarnessArchive(harness), { code: 'harness_archive_invalid' });
    console.log(JSON.stringify({ ok: true, image,
      runtime: { archiveHash: runtime.archiveHash, archiveBytes: runtime.archiveBytes, contentHash: runtime.runtimeHash, contentBytes: runtime.runtimeBytes, archiveMs: runtimeArchiveMs, readMs: runtimeReadMs },
      harness: { archiveHash: harness.archiveHash, archiveBytes: harness.archiveBytes, contentHash: harness.harnessHash, contentBytes: harness.harnessBytes, archiveMs: harnessArchiveMs, readMs: harnessReadMs },
      sourceAvailability: 'filesystem-shim-denied-after-archive', sourceAccesses, reports, cleanedContainerIds: ids,
      modelInvocations: 0, imageArchived: false, containerHarnessArchived: true, hostSchedulerArchived: false,
      artifactsRetainedAfterExperiment: false, acceptance: false }, null, 2));
  } finally {
    for (const [k, original] of Object.entries(originals)) fs[k] = original;
    for (const fn of cleanup.reverse()) fn();
    fs.rmSync(root, { recursive: true, force: true }); // only this experiment's temp artifacts
  }
}
if (require.main === module) main().catch(e => { console.error(JSON.stringify({ ok: false, code: 'harness_archive_verification_failed', containerName: e.containerName || null })); process.exitCode = 1; });
