// Explicit Linux/Docker native-SDK transport conformance. Synthetic supplier,
// original CAFF factory/SDK/loader/extensions/tools; never an acceptance launcher.
// Static trusted staging ONLY on host. No SDK/native import, credential or model.
const path = require('node:path'), assert = require('node:assert/strict');
const { prepareCaffRuntimeFiles } = require('./caff-runtime-wiring.cjs');
const { readTrustedDistributionFile } = require('./evaluation-bridge-launcher.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { verifyProbeImage, runProbe } = require('./verify-pi-initialization.cjs');
function prepareSdkModelGatewayFiles(repoRoot, dependencyRoot, image) {
  const files = prepareCaffRuntimeFiles(repoRoot, dependencyRoot, image, 'fresh');
  files.find(f => f.path === 'probe.cjs').path = 'caff-runtime-bootstrap.cjs';
  const names = ['tests/helpers/badcase-sdk-model-gateway-container.cjs', 'scripts/badcase-capture/sdk-model-gateway.cjs',
    ...['chat-completions-protocol', 'model-egress', 'model-identifier'].map(n => 'build/server/domain/runtime/badcase-capture/' + n + '.js')];
  for (const name of names) {
    files.push({ path: name.startsWith('tests/') ? 'probe.cjs' : name,
      bytes: readTrustedDistributionFile(path.resolve(repoRoot), name, 16 * 1024 * 1024 - files.reduce((n, f) => n + f.bytes.length, 0)) });
  }
  manifestFor(files); return files;
}
async function verifySdkModelGateway(repoRoot, dependencyRoot, image) {
  await verifyProbeImage(image);
  const files = prepareSdkModelGatewayFiles(repoRoot, dependencyRoot, image), manifest = manifestFor(files);
  const r = await runProbe(image, files, { executableWork: true });
  if (r.result.code !== 0 || r.result.failure || r.result.stderr) throw Error('sdk_gateway_conformance_failed');
  const expected = { kind: 'synthetic-native-sdk-gateway-v1', inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash,
    nodeVersion: image.nodeVersion, architecture: image.architecture, fullCaffFactory: true, originalSdkTransport: true,
    loaderExtensionsAndSkillVerified: true, nativeToolExecuted: 'write', tools: 10,
    syntheticModelRequests: 2, supplierRequests: 0, externalFetches: 0, realCapture: false, acceptance: false };
  assert.equal(r.result.stdout, JSON.stringify(expected) + '\n');
  assert.deepEqual(r.manifest, manifest);
  return { ...expected, containerId: r.containerId, cleaned: true };
}
if (require.main === module) Promise.resolve().then(async () => {
  const args = process.argv.slice(2);
  const arg = name => { const i = args.indexOf('--' + name); if (i < 0 || !args[i + 1]) throw Error(); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'),
    nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  console.log(JSON.stringify(await verifySdkModelGateway(process.cwd(), process.cwd(), image)));
}).catch(() => { process.stderr.write('sdk_gateway_conformance_failed\n'); process.exitCode = 1; });
module.exports = { prepareSdkModelGatewayFiles, verifySdkModelGateway };
