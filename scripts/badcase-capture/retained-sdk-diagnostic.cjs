// Trusted offline SDK initialization diagnostic, NOT a replay/model launcher.
// The host copies trusted build/npm files statically; captured content is capsule.json only.
const fs = require('node:fs');
const path = require('node:path');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const { planRetainedSdkDiagnostic, diagnosticReceipt } = require('../../build/server/domain/runtime/badcase-capture/retained-sdk-diagnostic');
const { prepareProbeFiles, manifestFor } = require('./pi-probe-materials.cjs');
const { readRuntimeArchive } = require('./runtime-archive.cjs');
const { runProbe, verifyProbeImage } = require('./verify-pi-initialization.cjs');
function stageDiagnostic(capsule, expected, image, runtimeArchive) {
  const repo = path.resolve(__dirname, '../..');
  // Explicit archive selection (including null/undefined) MUST NOT fall back to installed packages.
  // Omitting the fourth argument retains the older installed-distribution experiment only.
  const files = arguments.length >= 4 ? readRuntimeArchive(runtimeArchive)
    : prepareProbeFiles(repo, 'fresh').filter(f => f.path.startsWith('runtime/'));
  const add = (name, bytes) => files.push({ path: name, bytes: Buffer.from(bytes) });
  add('pi-probe-guards.cjs', fs.readFileSync(path.join(__dirname, 'pi-probe-guards.cjs')));
  add('probe.cjs', fs.readFileSync(path.join(__dirname, 'retained-sdk-container.cjs')));
  for (const name of ['retained-sdk-diagnostic', 'capsule-materialization', 'secrets']) {
    add(name + '.js', fs.readFileSync(path.join(repo, 'build/server/domain/runtime/badcase-capture', name + '.js')));
  }
  add('capsule.json', capsule); add('expected.json', JSON.stringify(expected)); add('environment.json', JSON.stringify(image));
  manifestFor(files); return files;
}
async function runRetainedSdkDiagnostic(request, image, options = {}) {
  const p = prepareRetainedInitializationCapsule(request);
  const expected = { capsuleHash: p.capsuleHash, checkpointChecksum: p.provenance.checkpointChecksum };
  const plan = planRetainedSdkDiagnostic(p.capsule, expected);
  const files = Object.hasOwn(options, 'runtimeArchive')
    ? stageDiagnostic(p.capsule, expected, image, options.runtimeArchive) : stageDiagnostic(p.capsule, expected, image);
  const manifest = manifestFor(files);
  // No pull, host fallback or floating tag. Injected transport is tests-only.
  const transport = options.runProbe || (async (i, f) => { await verifyProbeImage(i); return runProbe(i, f); });
  const r = await transport(image, files);
  const receipt = { ...diagnosticReceipt(plan), inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash };
  // runProbe resolves only after verified owner cleanup; errors propagate, never unpin.
  if (!r || !r.result || r.result.code !== 0 || r.result.failure || r.result.stderr !== ''
    || r.result.stdout !== JSON.stringify(receipt) + '\n' || r.manifest?.inputHash !== manifest.inputHash
    || r.manifest?.runtimeHash !== manifest.runtimeHash || !/^[a-f0-9]{64}$/.test(r.containerId)) {
    throw Object.assign(Error('sdk_diagnostic_failed'), { code: 'sdk_diagnostic_failed' });
  }
  return { ...receipt, containerId: r.containerId, cleaned: true, provenance: p.provenance };
}
module.exports = { stageDiagnostic, runRetainedSdkDiagnostic };
