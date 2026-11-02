// Trusted Linux/WSL operator entry. Plans/caches only; never reads a model key,
// marks a case, rewrites a sealed checkpoint or submits a model request.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { prepareComparison } = require('./direct-comparison.cjs');
const { cacheReplayDependencies, dependencyRecipe } = require('./replay-dependencies.cjs');
const { withDependencyProxy } = require('./dependency-proxy.cjs');
async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'linux' || args.length !== 2 || args.some(p => !path.isAbsolute(p))) throw Error('usage: cache-replay-dependencies.cjs <comparison-config.json> <cache-directory>');
  const config = JSON.parse(fs.readFileSync(args[0])), cacheRoot = args[1];
  if (config.dependencies && (config.dependencies.kind !== 'npm-ci-linux-v1' || path.resolve(config.dependencies.cacheRoot) !== path.resolve(cacheRoot))) throw Error('evaluation_config_invalid');
  delete config.dependencies;
  const plan = prepareComparison(config);
  if (!plan.supported) throw Error('evaluation_dependencies_replay_materials_required');
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const recipe = dependencyRecipe(plan.inputs.original, config.image);
  if (fs.existsSync(path.join(cacheRoot, recipe.cacheKey))) return cacheReplayDependencies(plan.inputs.original, config.image, cacheRoot);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const network = JSON.parse(cp.execFileSync('docker', ['--context', 'default', 'network', 'inspect', 'bridge'], { env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const gateway = network[0]?.IPAM?.Config?.find(c => c.Gateway)?.Gateway;
  return withDependencyProxy(gateway, proxyUrl => cacheReplayDependencies(plan.inputs.original, config.image, cacheRoot, { proxyUrl }));
}
if (require.main === module) main().then(r => console.log(JSON.stringify(r))).catch(e => {
  // Only stable local codes. No raw npm/proxy/Docker/provider stderr.
  const code = e?.code || e?.message;
  console.error(/^evaluation_[a-z_]+$/.test(code) ? code : 'evaluation_dependency_install_failed'); process.exitCode = 1;
});
module.exports = { main };
