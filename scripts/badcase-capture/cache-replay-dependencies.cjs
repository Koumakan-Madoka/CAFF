// Trusted Linux or explicit Windows/WSL operator entry. Explicit Git safety
// sources may be read in memory. Never authenticates/submits a model request,
// marks a case or rewrites a sealed checkpoint.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { prepareComparison } = require('./direct-comparison.cjs');
const { cacheReplayDependencies, dependencyRecipe } = require('./replay-dependencies.cjs');
const { withDependencyProxy } = require('./dependency-proxy.cjs');
const { validateWslDockerBackend, createWslDockerRunner } = require('./wsl-docker.cjs');
const { withWslDependencyProxy } = require('./wsl-dependency-proxy.cjs');
async function main(args = process.argv.slice(2), options = {}) {
  if (args.length !== 2 || args.some(p => !path.isAbsolute(p))) throw Error('evaluation_dependency_cli_invalid');
  const stat = fs.lstatSync(args[0]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error('evaluation_config_invalid');
  return cacheDependencies(JSON.parse(fs.readFileSync(args[0])), args[1], options);
}
// Shared trusted installer kernel. The runtime-distribution preparation entry
// supplies fixed package/lock input here; JSON cannot select a prepare hook.
async function cacheDependencies(value, cacheRoot, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !path.isAbsolute(cacheRoot || '')) throw Error('evaluation_config_invalid');
  const config = structuredClone(value), platform = options.platform ?? process.platform;
  // Resolve the explicit host/backend before prepareComparison may read any
  // sealed or known-value sources. Runner construction never starts WSL.
  let backend, runDocker;
  if (config.dockerBackend !== undefined) {
    backend = validateWslDockerBackend(config.dockerBackend);
    if (platform !== 'win32') throw Error('evaluation_wsl_host_required');
    runDocker = (options.createWslDockerRunner || createWslDockerRunner)(backend);
  } else if (platform !== 'linux') throw Error(platform === 'win32' ? 'evaluation_wsl_backend_required' : 'evaluation_linux_required');
  if (config.dependencies !== undefined && (!config.dependencies || typeof config.dependencies !== 'object' || Array.isArray(config.dependencies)
    || Object.keys(config.dependencies).sort().join(',') !== 'cacheRoot,kind'
    || config.dependencies.kind !== 'npm-ci-linux-v1' || !path.isAbsolute(config.dependencies.cacheRoot || '')
    || path.resolve(config.dependencies.cacheRoot) !== path.resolve(cacheRoot))) throw Error('evaluation_config_invalid');
  delete config.dependencies;
  const plan = (options.prepare || prepareComparison)(config);
  if (!plan.supported) throw Error('evaluation_dependencies_replay_materials_required');
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const recipe = dependencyRecipe(plan.inputs.original, config.image);
  const build = proxyUrl => cacheReplayDependencies(plan.inputs.original, config.image, cacheRoot, {
    ...(proxyUrl ? { proxyUrl } : {}), ...(runDocker ? { runDocker } : {}), ...(options.runBuild ? { runBuild: options.runBuild } : {}) });
  // A validated hit never starts WSL, binds a proxy or invokes npm. A corrupt
  // hit remains an error; do not bypass it by rebuilding silently.
  let result;
  if (fs.existsSync(path.join(cacheRoot, recipe.cacheKey))) result = await build();
  else if (backend) result = await (options.withWslDependencyProxy || withWslDependencyProxy)(backend, build);
  else {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const network = JSON.parse(cp.execFileSync('docker', ['--context', 'default', 'network', 'inspect', 'bridge'], { env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
    const gateway = network[0]?.IPAM?.Config?.find(c => c.Gateway)?.Gateway;
    result = await withDependencyProxy(gateway, build);
  }
  return { ...result, ...(backend ? { dockerBackend: backend } : {}) };
}
if (require.main === module) main().then(r => console.log(JSON.stringify(r))).catch(e => {
  // Only stable local codes. No raw npm/proxy/Docker/provider stderr.
  const code = e?.code || e?.message;
  console.error(/^evaluation_[a-z_]+$/.test(code) ? code : 'evaluation_dependency_install_failed'); process.exitCode = 1;
});
module.exports = { main, cacheDependencies };
