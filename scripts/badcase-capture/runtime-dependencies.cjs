// Trusted runtime preparation only. Host reads/copies fixed distribution bytes;
// npm, native addons and export code execute only in credential-free containers.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { cacheDependencies } = require('./cache-replay-dependencies.cjs');
const { prepareReplayDependencies } = require('./replay-dependencies.cjs');
const { prepareDirectReplayInput, runDependencyDockerTask } = require('./direct-docker.cjs');
const { prepareBridgeFiles, readTrustedDistributionFile } = require('./evaluation-bridge-launcher.cjs');
const { validateWslDockerBackend, createWslDockerRunner } = require('./wsl-docker.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { prepareOfflineTask } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const inventory = require('./evaluation-bridge-files.json');
const repo = path.resolve(__dirname, '../..'), hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(Error(code), { code });
function runtimePackageInput(root = repo) {
  const files = ['package.json', 'package-lock.json'].map(name => {
    const bytes = readTrustedDistributionFile(root, name);
    if (containsSecretSentinel(bytes)) throw fail('evaluation_runtime_package_invalid');
    return { path: name, base64: bytes.toString('base64'), sha256: hash(bytes) };
  });
  return { kind: 'prepared-caff-turn-v1', files, deletions: [], sessionText: null };
}
function checkedRoot(root) {
  if (!path.isAbsolute(root || '')) throw Error();
  const st = fs.lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(root) !== path.resolve(root)) throw Error();
  return path.resolve(root);
}
function receiptProjection(r, image) {
  if (r?.kind !== 'fixed-linux-runtime-export-v1' || r.nodeVersion !== image.nodeVersion || r.architecture !== image.architecture
    || r.nativeSqliteVerified !== true || !/^\d+\.\d+\.\d+$/.test(r.nativeSqliteVersion || '') || r.modelCalls !== 0
    || !/^[a-f0-9]{64}$/.test(r.filesHash || '') || !/^[a-f0-9]{64}$/.test(r.artifactHash || '')) throw Error();
  return { kind: r.kind, nodeVersion: r.nodeVersion, architecture: r.architecture, nativeSqliteVerified: true,
    nativeSqliteVersion: r.nativeSqliteVersion, filesHash: r.filesHash, artifactHash: r.artifactHash, modelCalls: 0 };
}
function dependencyFiles(root, image) {
  // Reuse fixed package-version, ELF-architecture and safe distribution reads.
  // This function never imports/loads the addon or any SDK on the host.
  return prepareBridgeFiles(repo, root, image).filter(f => f.path.startsWith('node_modules/'));
}
function readRuntimeCache(directory, recipe, image) {
  try {
    const root = checkedRoot(directory), record = JSON.parse(readTrustedDistributionFile(root, 'receipt.json'));
    if (JSON.stringify(record.recipe) !== JSON.stringify(recipe)) throw Error();
    const receipt = receiptProjection(record.receipt, image), dependencyRoot = checkedRoot(path.join(root, 'root'));
    if (manifestFor(dependencyFiles(dependencyRoot, image)).inputHash !== receipt.filesHash) throw Error();
    return { dependencyRoot, ...receipt };
  } catch { throw fail('evaluation_runtime_cache_invalid'); }
}
function materializeArtifact(file, destination, receipt, image) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 24 * 1024 * 1024) throw Error();
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== receipt.artifactHash) throw Error();
  const artifact = JSON.parse(bytes);
  if (Object.keys(artifact).sort().join(',') !== 'files,kind,schemaVersion' || artifact.schemaVersion !== 1
    || artifact.kind !== 'fixed-linux-runtime-files-v1' || !Array.isArray(artifact.files)
    || artifact.files.length !== inventory.dependencies.length) throw Error();
  const files = artifact.files.map((f, index) => {
    if (!f || Object.keys(f).sort().join(',') !== 'base64,path,sha256,size' || f.path !== inventory.dependencies[index]
      || typeof f.base64 !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > 8 * 1024 * 1024) throw Error();
    const bytes = Buffer.from(f.base64, 'base64');
    if (bytes.toString('base64') !== f.base64 || bytes.length !== f.size || hash(bytes) !== f.sha256) throw Error();
    return { path: f.path, bytes };
  });
  if (manifestFor(files).inputHash !== receipt.filesHash) throw Error();
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const f of files) {
    const target = path.join(destination, f.path); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, f.bytes, { flag: 'wx', mode: 0o600 });
  }
  if (manifestFor(dependencyFiles(destination, image)).inputHash !== receipt.filesHash) throw Error();
}
async function cacheRuntimeDependencies(value, cacheRoot, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['image', 'dockerBackend'].includes(k))
    || !path.isAbsolute(cacheRoot || '')) throw fail('evaluation_runtime_config_invalid');
  const config = structuredClone(value), platform = options.platform ?? process.platform;
  let backend, runDocker;
  if (config.dockerBackend !== undefined) {
    backend = validateWslDockerBackend(config.dockerBackend);
    if (platform !== 'win32') throw fail('evaluation_wsl_host_required');
    runDocker = (options.createWslDockerRunner || createWslDockerRunner)(backend);
  } else if (platform !== 'linux') throw fail(platform === 'win32' ? 'evaluation_wsl_backend_required' : 'evaluation_linux_required');
  try { prepareOfflineTask({ image: config.image, entrypoint: 'x.cjs', timeoutMs: 1000, files: [{ path: 'x.cjs', base64: '', sha256: hash('') }] }); }
  catch { throw fail('evaluation_runtime_config_invalid'); }
  const input = runtimePackageInput();
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  try { checkedRoot(cacheRoot); } catch { throw fail('evaluation_runtime_cache_invalid'); }
  // Same installer/proxy/cache kernel as captured dependencies; only this
  // trusted program supplies a fixed distribution input instead of a case.
  const npmRoot = path.join(cacheRoot, 'npm');
  const installed = await cacheDependencies(config, npmRoot, { ...options, prepare: () => ({ supported: true, inputs: { original: input } }) });
  const sources = Object.fromEntries(['runtime-dependencies-container.cjs', 'restore-replay-dependencies.cjs', 'caff-runtime-container.cjs']
    .map(name => [name, fs.readFileSync(path.join(__dirname, name))]));
  const fixedInventory = Buffer.from(JSON.stringify({ dependencies: inventory.dependencies, packages: inventory.packages }));
  const recipe = { kind: 'fixed-linux-runtime-v1', imageId: config.image.imageId, architecture: config.image.architecture, nodeVersion: config.image.nodeVersion,
    packageHash: input.files[0].sha256, lockHash: input.files[1].sha256, npmCacheKey: installed.cacheKey, npmArchiveHash: installed.archiveHash,
    inventoryHash: hash(fixedInventory), sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, bytes]) => [name, hash(bytes)])) };
  const cacheKey = hash(JSON.stringify(recipe)), directory = path.join(cacheRoot, cacheKey);
  const summary = (cached, cacheHit) => ({ kind: recipe.kind, cacheKey, cacheHit, npmCacheHit: installed.cacheHit, fileCount: inventory.dependencies.length,
    dependencyRoot: cached.dependencyRoot, imageId: config.image.imageId, ...cached, ...(backend ? { dockerBackend: backend } : {}) });
  if (fs.existsSync(directory)) return summary(readRuntimeCache(directory, recipe, config.image), true);
  const temporary = fs.mkdtempSync(path.join(cacheRoot, '.runtime-'));
  try {
    const prepared = { ...input, ...prepareReplayDependencies(input, config.image, npmRoot) };
    const files = prepareDirectReplayInput(prepared);
    files.push({ path: 'probe.cjs', bytes: sources['runtime-dependencies-container.cjs'] },
      { path: 'restore-replay-dependencies.cjs', bytes: sources['restore-replay-dependencies.cjs'] },
      { path: 'caff-runtime-bootstrap.cjs', bytes: sources['caff-runtime-container.cjs'] },
      { path: 'runtime-dependency-inventory.json', bytes: fixedInventory },
      { path: 'environment.json', bytes: Buffer.from(JSON.stringify(config.image)) }, { path: 'mode.txt', bytes: Buffer.from('fresh') });
    const artifact = path.join(temporary, 'runtime-files.json');
    const result = await (options.runExport || runDependencyDockerTask)(config.image, files, { outputFile: artifact, network: 'none', timeoutMs: 120000,
      ...(runDocker ? { runDocker } : {}) });
    if (result?.code !== 0 || result.failed || result.cleaned !== true) throw Error();
    const receipt = receiptProjection(result.receipt, config.image);
    materializeArtifact(artifact, path.join(temporary, 'root'), receipt, config.image);
    if (JSON.stringify(runtimePackageInput()) !== JSON.stringify(input)) throw Error();
    fs.unlinkSync(artifact);
    fs.writeFileSync(path.join(temporary, 'receipt.json'), JSON.stringify({ recipe, receipt }), { flag: 'wx', mode: 0o600 });
    try { fs.renameSync(temporary, directory); }
    catch (e) { if (!fs.existsSync(directory)) throw e; readRuntimeCache(directory, recipe, config.image); }
    return summary(readRuntimeCache(directory, recipe, config.image), false);
  } catch { throw fail('evaluation_runtime_export_failed'); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { runtimePackageInput, cacheRuntimeDependencies };
