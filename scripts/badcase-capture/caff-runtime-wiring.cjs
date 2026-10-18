// Trusted synthetic production-runtime wiring. NOT a captured-case/model launcher.
// Static staging only on host: never import SDK, native addon or extension here.
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareBridgeFiles, readTrustedDistributionFile } = require('./evaluation-bridge-launcher.cjs');
const { prepareRuntimeFiles, manifestFor } = require('./pi-probe-materials.cjs');
const { runProbe, verifyProbeImage } = require('./verify-pi-initialization.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(Error(code), { code });
function prepareCaffRuntimeFiles(repoRoot, dependencyRoot, image, mode) {
  try {
    if (!['fresh', 'resume'].includes(mode)) throw Error();
    // Roots and fixed bridge distribution are validated by the existing stage.
    const files = prepareBridgeFiles(repoRoot, dependencyRoot, image).filter(f => f.path !== 'probe.cjs');
    // This trusted installed SDK copier is the existing archived-runtime path;
    // ancestors/install remain TCB, not a captured-source or package installer.
    const runtime = prepareRuntimeFiles(path.resolve(repoRoot));
    files.push(...runtime);
    const copy = (source, destination) => {
      const remaining = 16 * 1024 * 1024 - files.reduce((n, f) => n + f.bytes.length, 0);
      files.push({ path: destination, bytes: readTrustedDistributionFile(path.resolve(repoRoot), source, remaining) });
    };
    // The shipped bundle lazily requires jiti only when real extensions load.
    // Its virtual/alias resolution already supplies the SDK's original typebox;
    // do not rewrite extension imports or duplicate a different root installation.
    for (const name of ['package.json', 'lib/jiti.cjs', 'dist/jiti.cjs', 'dist/babel.cjs']) {
      copy('node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/' + name, 'runtime/node_modules/jiti/' + name);
    }
    const jiti = JSON.parse(files.find(f => f.path === 'runtime/node_modules/jiti/package.json').bytes);
    if (jiti.name !== 'jiti' || jiti.version !== '2.7.0') throw Error();
    for (const name of ['pi-sdk-host.mjs', 'proxy-routing.mjs', 'pi-extensions/caff-capabilities.mjs', 'pi-extensions/caff-stream-read-retry.mjs']) {
      copy('lib/' + name, 'build/lib/' + name);
    }
    copy('scripts/badcase-capture/caff-runtime-container.cjs', 'probe.cjs');
    files.push({ path: 'mode.txt', bytes: Buffer.from(mode) });
    manifestFor(files); return files;
  } catch { throw fail('caff_runtime_stage_failed'); }
}
function wiringReceipt(manifest, image, mode) {
  return { kind: 'caff-runtime-wiring-diagnostic-v1', deliveryMode: mode,
    productionRuntimeFactory: true, sdkInitialized: true, extensionsVerified: true,
    projectContextVerified: true, projectSkillVerified: true, contractSkillVerified: true, retiredSkillExcluded: true,
    fileToolsVerified: true, shellToolVerified: true, bridgeCliVerified: true, capabilityRouteDenied: true,
    historyMessages: mode === 'resume' ? 1 : 0, archivedSessionUnchanged: mode === 'resume' ? true : null,
    modelCalls: 0, externalFetchCalls: 0, invocationSubmitted: false,
    runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false,
    nodeVersion: image.nodeVersion, architecture: image.architecture, inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash,
    dependencyHash: hash(JSON.stringify(manifest.files.filter(f => f.path.startsWith('node_modules/')))) };
}
async function runCaffRuntimeWiring(repoRoot, dependencyRoot, image, mode, options = {}) {
  image = structuredClone(image);
  const files = prepareCaffRuntimeFiles(repoRoot, dependencyRoot, image, mode), manifest = manifestFor(files);
  const expected = wiringReceipt(manifest, image, mode);
  const transport = options.runProbe || (async (i, f) => { await verifyProbeImage(i); return runProbe(i, f, { executableWork: true }); });
  const r = await transport(image, files);
  if (!r || !r.result || r.result.code !== 0 || r.result.failure || r.result.stderr !== ''
    || r.result.stdout !== JSON.stringify(expected) + '\n' || !/^[a-f0-9]{64}$/.test(r.containerId)
    || JSON.stringify(r.manifest) !== JSON.stringify(manifest)) throw fail('caff_runtime_wiring_failed');
  return { ...expected, containerId: r.containerId, cleaned: true };
}
module.exports = { prepareCaffRuntimeFiles, runCaffRuntimeWiring, wiringReceipt };
