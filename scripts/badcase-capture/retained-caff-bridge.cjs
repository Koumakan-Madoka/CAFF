// Trusted static operator API: sealed callback input + full retained CAFF config
// -> original runtime/tool bridge inside isolated Docker. NO SDK import on host,
// live Room read, model prompt, provider credential, budget bypass or seed fallback.
const path = require('node:path'), crypto = require('node:crypto');
const { planRetainedCaffBridgeInitialization } = require('../../build/server/domain/runtime/badcase-capture/caff-replay-start');
const { planRetainedEvaluationCallback } = require('../../build/server/domain/runtime/badcase-capture/retained-callback-input');
const { prepareRetainedCaffFiles, initializationReceipt } = require('./retained-caff-initialization.cjs');
const { bridgeReplacementsHash } = require('./retained-caff-callback.cjs'); // constants only, no I/O on import
const { readTrustedDistributionFile } = require('./evaluation-bridge-launcher.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { verifyProbeImage, runProbe } = require('./verify-pi-initialization.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const fail = () => Object.assign(Error('retained_caff_bridge_failed'), { code: 'retained_caff_bridge_failed' });
function planBridge(v) {
  const start = planRetainedCaffBridgeInitialization(v.capsule, v.expected, v.worktree, v.bindings);
  if (start.archivedHarness.toolBridgeEnabled !== true) throw Object.assign(Error('replay_bridge_disabled'), { code: 'replay_bridge_disabled' });
  const callback = planRetainedEvaluationCallback(v.capsule, v.expected, v.association);
  return { start, callback };
}
function prepareRetainedCaffBridgeFiles(repoRoot, dependencyRoot, image, value) {
  const v = structuredClone(value); planBridge(v); // before installed-source reads
  const files = prepareRetainedCaffFiles(repoRoot, dependencyRoot, image, v, true);
  files.find(f => f.path === 'probe.cjs').path = 'retained-caff-runtime.cjs';
  const copy = (source, destination) => files.push({ path: destination, bytes: readTrustedDistributionFile(path.resolve(repoRoot), source,
    16 * 1024 * 1024 - files.reduce((n, f) => n + f.bytes.length, 0)) });
  copy('scripts/badcase-capture/retained-caff-bridge-container.cjs', 'probe.cjs');
  copy('scripts/badcase-capture/retained-caff-callback.cjs', 'retained-caff-callback.cjs');
  const module = 'build/server/domain/runtime/badcase-capture/retained-callback-input.js'; copy(module, module);
  files.push({ path: 'bridge-association.json', bytes: Buffer.from(JSON.stringify(v.association)) });
  manifestFor(files); return files;
}
function bridgeReceipt(manifest, image, plan) {
  return { ...initializationReceipt(manifest, image, plan.start), kind: 'retained-caff-bridge-probe-v1', initializationOnly: false,
    bridgeProbeOnly: true, callbackWired: true, callbackToolsVerified: true, callbackClosed: true, runtimeBridgeReplacementsApplied: true,
    callbackInputHash: plan.callback.receipt.callbackInputHash,
    callbackAssociationHash: hash(JSON.stringify(plan.callback.callbackInput.association)), runtimeBridgeReplacementsHash: bridgeReplacementsHash,
    controlledReplacementsApplied: true, controlledInputs: plan.start.controlledInputs };
}
async function runRetainedCaffBridge(repoRoot, dependencyRoot, image, value, options = {}) {
  image = structuredClone(image); const v = structuredClone(value), plan = planBridge(v);
  const files = prepareRetainedCaffBridgeFiles(repoRoot, dependencyRoot, image, v), manifest = manifestFor(files);
  try {
    const transport = options.runProbe || (async (i, f) => { await verifyProbeImage(i); return runProbe(i, f, { executableWork: true }); });
    const r = await transport(image, files), result = r?.result;
    if (!result || result.code !== 0 || result.failure || result.stderr !== '' || !/^[a-f0-9]{64}$/.test(r.containerId)
      || JSON.stringify(r.manifest) !== JSON.stringify(manifest) || typeof result.stdout !== 'string' || result.stdout.length > 8192) throw Error();
    const parsed = JSON.parse(result.stdout), o = parsed.observation;
    if (!o || Object.keys(o).sort().join('|') !== 'historyHash|historyMessages|systemPromptHash|toolsHash'
      || !['historyHash', 'systemPromptHash', 'toolsHash'].every(k => typeof o[k] === 'string' && /^[a-f0-9]{64}$/.test(o[k]))
      || !Number.isSafeInteger(o.historyMessages) || o.historyMessages < 0 || o.historyMessages > 100000
      || (!plan.start.config.resume && (o.historyMessages !== 0 || o.historyHash !== hash('[]')))) throw Error();
    const expected = { ...bridgeReceipt(manifest, image, plan), observation: o };
    if (result.stdout !== JSON.stringify(expected) + '\n') throw Error();
    return { ...expected, containerId: r.containerId, cleaned: true };
  } catch { throw fail(); }
}
module.exports = { planBridge, prepareRetainedCaffBridgeFiles, bridgeReceipt, runRetainedCaffBridge };
