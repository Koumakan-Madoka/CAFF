// Trusted host cache of Linux npm-ci output. No account/auth discovery; no host
// npm or project code execution. Inputs and installer bytes bind cache identity.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { prepareDirectReplayInput, runDependencyDockerTask } = require('./direct-docker.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const fail = code => Object.assign(Error(code), { code });
const INSTALL = 'npm ci --include=dev --no-audit --no-fund';
function dependencyRecipe(input, image) {
  try {
    if (input?.kind !== 'prepared-caff-turn-v1' || !Array.isArray(input.files) || input.files.length > 1024
      || !/^sha256:[a-f0-9]{64}$/.test(image?.imageId) || !/^v24\.\d+\.\d+$/.test(image.nodeVersion)
      || !['amd64', 'arm64'].includes(image.architecture)) throw Error();
    const byName = new Map();
    for (const f of input.files) {
      if (!/^[A-Za-z0-9_.@/-]+$/.test(f.path) || f.path.split('/').some(p => !p || p === '.' || p === '..' || p === '.git' || p === 'node_modules')
        || byName.has(f.path) || /(?:^|\/)(?:\.npmrc|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/.test(f.path)) throw Error();
      const bytes = Buffer.from(f.base64, 'base64');
      if (bytes.toString('base64') !== f.base64 || hash(bytes) !== f.sha256) throw Error();
      byName.set(f.path, bytes);
    }
    const pkg = JSON.parse(byName.get('package.json')), lock = JSON.parse(byName.get('package-lock.json'));
    if (!pkg || ![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']
      || pkg.name !== lock.name || pkg.version !== lock.version || pkg.packageManager && !/^npm@/.test(pkg.packageManager)) throw Error();
    const integrity = s => typeof s === 'string' && /^sha(?:512|256|1)-[A-Za-z0-9+/=]+$/.test(s);
    let resolvedWithoutIntegrity = 0;
    for (const item of Object.values(lock.packages)) {
      if (item.resolved) {
        if (item.resolved.startsWith('file:')) {
          const name = item.resolved.slice(5);
          if (!/^[A-Za-z0-9_.@/-]+$/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')
            || !byName.has(name + '/package.json')) throw Error();
        } else {
          const u = new URL(item.resolved);
          if (u.protocol !== 'https:' || u.hostname !== 'registry.npmjs.org' || u.port || u.username || u.password || u.search || u.hash
            || item.integrity !== undefined && !integrity(item.integrity)) throw Error();
          // npm shrinkwrap can omit a nested integrity field. Preserve the
          // recorded lock semantics, disclose the gap, then pin the actual
          // installed archive hash; do not invent a missing checksum.
          if (item.integrity === undefined) resolvedWithoutIntegrity++;
        }
      }
    }
    const recipe = { kind: 'npm-ci-linux-v1', lockHash: hash(byName.get('package-lock.json')), packageHash: hash(byName.get('package.json')),
      imageId: image.imageId, architecture: image.architecture, nodeVersion: image.nodeVersion, installCommand: INSTALL, resolvedWithoutIntegrity,
      installerHash: hash(fs.readFileSync(path.join(__dirname, 'npm-dependencies-container.cjs'))),
      fileHashes: [...input.files, ...(input.gitFiles || [])].map(f => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    return { ...recipe, cacheKey: hash(JSON.stringify(recipe)) };
  } catch { throw fail('evaluation_dependencies_unsupported'); }
}
function cacheDirectory(root) {
  if (!path.isAbsolute(root || '')) throw fail('evaluation_dependency_cache_invalid');
  const st = fs.lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(root) !== path.resolve(root)) throw fail('evaluation_dependency_cache_invalid');
  return root;
}
function readCache(root, recipe) {
  try {
    const dir = path.join(cacheDirectory(root), recipe.cacheKey);
    if (!fs.existsSync(dir)) throw Error();
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw Error();
    for (const name of ['receipt.json', 'node_modules.tar.gz']) {
      const s = fs.lstatSync(path.join(dir, name)); if (!s.isFile() || s.isSymbolicLink() || !s.size) throw Error();
    }
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'))), bytes = fs.readFileSync(path.join(dir, 'node_modules.tar.gz'));
    if (JSON.stringify(record.recipe) !== JSON.stringify(recipe) || record.receipt?.kind !== 'npm-replay-dependencies-v1'
      || record.receipt.nodeVersion !== recipe.nodeVersion || record.receipt.installCommand !== INSTALL || record.receipt.modelCalls !== 0
      || !record.receipt.npmVersion || record.receipt.archiveHash !== hash(bytes)) throw Error();
    return { bytes, receipt: record.receipt };
  } catch { throw fail('evaluation_dependency_cache_invalid'); }
}
function prepareReplayDependencies(input, image, root) {
  const recipe = dependencyRecipe(input, image), { bytes, receipt } = readCache(root, recipe), { fileHashes: omitted, ...identity } = recipe;
  return { dependencies: { ...identity, archiveHash: receipt.archiveHash, npmVersion: receipt.npmVersion },
    dependencyArchive: { base64: bytes.toString('base64'), sha256: receipt.archiveHash } };
}
async function cacheReplayDependencies(input, image, root, options = {}) {
  const recipe = dependencyRecipe(input, image); cacheDirectory(root);
  if (fs.existsSync(path.join(root, recipe.cacheKey))) { const hit = readCache(root, recipe); return { cacheHit: true, cacheKey: recipe.cacheKey, ...hit.receipt }; }
  const temporary = fs.mkdtempSync(path.join(root, '.install-'));
  try {
    const files = prepareDirectReplayInput(input);
    files.push({ path: 'probe.cjs', bytes: fs.readFileSync(path.join(__dirname, 'npm-dependencies-container.cjs')) },
      { path: 'caff-runtime-bootstrap.cjs', bytes: fs.readFileSync(path.join(__dirname, 'caff-runtime-container.cjs')) },
      { path: 'environment.json', bytes: Buffer.from(JSON.stringify(image)) }, { path: 'mode.txt', bytes: Buffer.from('fresh') },
      { path: 'dependency-install.json', bytes: Buffer.from(JSON.stringify({ proxyUrl: options.proxyUrl ?? null, network: options.network ?? 'bridge' })) });
    const result = await (options.runBuild || runDependencyDockerTask)(image, files, {
      outputFile: path.join(temporary, 'node_modules.tar.gz'), network: options.network ?? 'bridge', timeoutMs: 900000 });
    if (result?.code !== 0 || result.failed || result.cleaned !== true) throw Error();
    const bytes = fs.readFileSync(path.join(temporary, 'node_modules.tar.gz')), r = result.receipt;
    if (r?.kind !== 'npm-replay-dependencies-v1' || r.nodeVersion !== recipe.nodeVersion || r.installCommand !== INSTALL
      || r.modelCalls !== 0 || typeof r.npmVersion !== 'string' || !bytes.length || hash(bytes) !== r.archiveHash) throw Error();
    // Persist only the explicit non-secret projection, never raw process output,
    // environment, runtime inspect or a caller's arbitrary receipt properties.
    const receipt = { kind: r.kind, nodeVersion: r.nodeVersion, npmVersion: r.npmVersion, installCommand: INSTALL, archiveHash: r.archiveHash, modelCalls: 0 };
    fs.writeFileSync(path.join(temporary, 'receipt.json'), JSON.stringify({ recipe, receipt }), { flag: 'wx', mode: 0o600 });
    try { fs.renameSync(temporary, path.join(root, recipe.cacheKey)); }
    catch (e) { if (!fs.existsSync(path.join(root, recipe.cacheKey))) throw e; readCache(root, recipe); }
    return { cacheHit: false, cacheKey: recipe.cacheKey, ...receipt };
  } catch { throw fail('evaluation_dependency_install_failed'); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { dependencyRecipe, cacheReplayDependencies, prepareReplayDependencies };
