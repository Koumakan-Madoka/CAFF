// Trusted offline SDK initialization diagnostic, NOT a replay/model launcher.
// The host copies trusted build/npm files statically; captured content is capsule.json only.
const path = require('node:path');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const { planRetainedSdkDiagnostic, diagnosticReceipt } = require('../../build/server/domain/runtime/badcase-capture/retained-sdk-diagnostic');
const { prepareRuntimeFiles, manifestFor } = require('./pi-probe-materials.cjs');
const { readRuntimeArchive } = require('./runtime-archive.cjs');
const { prepareHarnessFiles, readHarnessArchive } = require('./harness-archive.cjs');
const { runProbe, verifyProbeImage } = require('./verify-pi-initialization.cjs');
function stageDiagnostic(capsule, expected, image, sources = {}) {
  const repo = path.resolve(__dirname, '../..');
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)
    || Object.keys(sources).some(k => !['runtimeArchive', 'harnessArchive'].includes(k))) {
    throw Object.assign(Error('diagnostic_sources_invalid'), { code: 'diagnostic_sources_invalid' });
  }
  // Own properties select archives explicitly, including null/undefined (fail closed).
  // Omitted properties retain current-install/build experiments, NOT archived replay.
  const files = Object.hasOwn(sources, 'runtimeArchive') ? readRuntimeArchive(sources.runtimeArchive) : prepareRuntimeFiles(repo);
  files.push(...(Object.hasOwn(sources, 'harnessArchive') ? readHarnessArchive(sources.harnessArchive) : prepareHarnessFiles(repo)));
  const add = (name, bytes) => files.push({ path: name, bytes: Buffer.from(bytes) });
  add('capsule.json', capsule); add('expected.json', JSON.stringify(expected)); add('environment.json', JSON.stringify(image));
  manifestFor(files); return files;
}
async function runRetainedSdkDiagnostic(request, image, options = {}) {
  const p = prepareRetainedInitializationCapsule(request);
  const expected = { capsuleHash: p.capsuleHash, checkpointChecksum: p.provenance.checkpointChecksum };
  const plan = planRetainedSdkDiagnostic(p.capsule, expected);
  const sources = Object.fromEntries(['runtimeArchive', 'harnessArchive'].filter(k => Object.hasOwn(options, k)).map(k => [k, options[k]]));
  const files = stageDiagnostic(p.capsule, expected, image, sources);
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
