// CONTAINER ONLY. Authorized trusted project lifecycle scripts run here, not
// on the host or with an account credential. No SDK import/model invocation.
const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict');
function main() {
  require('/work/caff-runtime-bootstrap.cjs').verifyCaffRuntimeStage({ replayWorkspace: true });
  const config = JSON.parse(fs.readFileSync('/work/dependency-install.json'));
  assert.ok(['none', 'bridge'].includes(config.network));
  if (config.network === 'bridge') {
    const u = new URL(config.proxyUrl); assert.equal(u.protocol, 'http:'); assert.ok(u.hostname && u.port && !u.username && !u.password);
    assert.equal(u.pathname, '/'); assert.equal(u.search, ''); assert.equal(u.hash, '');
  } else assert.equal(config.proxyUrl, null);
  fs.renameSync('/work/replay-workspace', '/work/restored');
  fs.writeFileSync('/tmp/npm-user.conf', '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync('/tmp/npm-global.conf', '', { flag: 'wx', mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: '/tmp', TMPDIR: '/tmp', npm_config_cache: '/tmp/npm-cache',
    npm_config_userconfig: '/tmp/npm-user.conf', npm_config_globalconfig: '/tmp/npm-global.conf', npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '0', npm_config_fetch_timeout: '120000', npm_config_registry: 'https://registry.npmjs.org/',
    ...(config.network === 'none' ? { npm_config_offline: 'true' } : { npm_config_proxy: config.proxyUrl, npm_config_https_proxy: config.proxyUrl,
      HTTP_PROXY: config.proxyUrl, HTTPS_PROXY: config.proxyUrl, http_proxy: config.proxyUrl, https_proxy: config.proxyUrl, NO_PROXY: '', no_proxy: '' }) };
  const run = (program, args) => cp.execFileSync(program, args, { cwd: '/work/restored', env, timeout: 840000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund']);
  // Even a no-dependency project has a usable node_modules directory.
  fs.mkdirSync('/work/restored/node_modules', { recursive: true });
  run('tar', ['-czf', '/work/node_modules.tar.gz', 'node_modules']);
  return { kind: 'npm-replay-dependencies-v1', nodeVersion: process.version, npmVersion: run('npm', ['--version']).toString().trim(),
    installCommand: 'npm ci --include=dev --no-audit --no-fund', archiveHash: crypto.createHash('sha256').update(fs.readFileSync('/work/node_modules.tar.gz')).digest('hex'), modelCalls: 0 };
}
if (require.main === module) {
  try {
    console.log(JSON.stringify(main()));
    fs.createReadStream('/work/node_modules.tar.gz').on('error', () => { process.exitCode = 1; }).pipe(process.stdout);
  }
  catch { process.stderr.write('dependency_install_failed\n'); process.exitCode = 1; }
}
module.exports = { main };
