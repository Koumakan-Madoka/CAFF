// Trusted operator API: sealed capsule -> isolated Docker SDK INITIALIZATION.
// No SDK/native import on host, model call, callback seed fabrication or live server.
const path = require('node:path');
const crypto = require('node:crypto');
const { planRetainedCaffInitialization, planRetainedCaffBridgeInitialization } = require('../../build/server/domain/runtime/badcase-capture/caff-replay-start');
const { prepareCaffRuntimeFiles } = require('./caff-runtime-wiring.cjs');
const { readTrustedDistributionFile } = require('./evaluation-bridge-launcher.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { verifyProbeImage, runProbe } = require('./verify-pi-initialization.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const fail = () => Object.assign(Error('retained_caff_initialization_failed'), { code: 'retained_caff_initialization_failed' });
function planFor(v) { return planRetainedCaffInitialization(v.capsule, v.expected, v.worktree, v.bindings); }
function prepareRetainedCaffFiles(repoRoot, dependencyRoot, image, value, bridge = false) {
  if (typeof bridge !== 'boolean') throw fail();
  const v = structuredClone(value), plan = bridge
    ? planRetainedCaffBridgeInitialization(v.capsule, v.expected, v.worktree, v.bindings) : planFor(v); // before source I/O
  const files = prepareCaffRuntimeFiles(repoRoot, dependencyRoot, image, plan.receipt.deliveryMode);
  files.find(f => f.path === 'probe.cjs').path = 'caff-runtime-bootstrap.cjs';
  const copy = (source, destination) => files.push({ path: destination, bytes: readTrustedDistributionFile(path.resolve(repoRoot), source,
    16 * 1024 * 1024 - files.reduce((n, f) => n + f.bytes.length, 0)) });
  copy('scripts/badcase-capture/retained-caff-container.cjs', 'probe.cjs');
  for (const name of ['capsule-materialization', 'worktree-replay-inputs', 'worktree-replay-materialization', 'caff-replay-start', 'controlled-bridge-inputs']) {
    const p = 'build/server/domain/runtime/badcase-capture/' + name + '.js'; copy(p, p);
  }
  for (const [name, text] of [['capsule.json', v.capsule], ['expected.json', JSON.stringify(v.expected)],
    ['worktree.json', JSON.stringify(v.worktree)], ['bindings.json', JSON.stringify(v.bindings)]]) files.push({ path: name, bytes: Buffer.from(text) });
  manifestFor(files); return files;
}
function initializationReceipt(manifest, image, plan) {
  return { ...plan.receipt, kind: 'retained-caff-initialization-v1', sdkInitialized: true,
    initializationOnly: true, productionRuntimeFactory: true, fileModePreserved: true,
    historyVerified: true, archivedMaterialsUnchanged: true, archivedResourcesVerified: true, modelGuardBeforeFactory: true,
    callbackWired: false, controlledReplacementsApplied: false,
    invocationSubmitted: false, modelCalls: 0, externalFetchCalls: 0,
    nodeVersion: image.nodeVersion, architecture: image.architecture,
    inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash,
    dependencyHash: hash(JSON.stringify(manifest.files.filter(f => f.path.startsWith('node_modules/')))) };
}
async function runRetainedCaffInitialization(repoRoot, dependencyRoot, image, value, options = {}) {
  image = structuredClone(image); const v = structuredClone(value), plan = planFor(v);
  const files = prepareRetainedCaffFiles(repoRoot, dependencyRoot, image, v), manifest = manifestFor(files);
  try {
    const transport = options.runProbe || (async (i, f) => { await verifyProbeImage(i); return runProbe(i, f, { executableWork: true }); });
    const r = await transport(image, files), result = r?.result;
    if (!result || result.code !== 0 || result.failure || result.stderr !== '' || !/^[a-f0-9]{64}$/.test(r.containerId)
      || JSON.stringify(r.manifest) !== JSON.stringify(manifest) || typeof result.stdout !== 'string' || result.stdout.length > 8192) throw Error();
    const parsed = JSON.parse(result.stdout), o = parsed.observation;
    if (!o || Object.keys(o).sort().join('|') !== 'historyHash|historyMessages|systemPromptHash|toolsHash'
      || !['historyHash', 'systemPromptHash', 'toolsHash'].every(k => typeof o[k] === 'string' && /^[a-f0-9]{64}$/.test(o[k]))
      || !Number.isSafeInteger(o.historyMessages) || o.historyMessages < 0 || o.historyMessages > 100000
      || (!plan.config.resume && (o.historyMessages !== 0 || o.historyHash !== hash('[]')))) throw Error();
    const expected = { ...initializationReceipt(manifest, image, plan), observation: o };
    if (result.stdout !== JSON.stringify(expected) + '\n') throw Error();
    return { ...expected, containerId: r.containerId, cleaned: true };
  } catch { throw fail(); }
}
module.exports = { prepareRetainedCaffFiles, runRetainedCaffInitialization, initializationReceipt };
