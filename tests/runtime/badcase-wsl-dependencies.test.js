// All subprocess/network/installer seams below are inert; real Docker is a
// separate operator diagnostic, never a prerequisite for this unit suite.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const backend = { kind: 'windows-wsl-v1', distribution: 'Debian' };
const image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0' };
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-dependencies-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = { name: 'synthetic-cache', version: '1.0.0' };
  const file = (name, value) => { const bytes = Buffer.from(JSON.stringify(value)); return { path: name, base64: bytes.toString('base64'), sha256: hash(bytes) }; };
  return { root, file: path.join(root, 'config.json'), cache: path.join(root, 'cache'), input: { kind: 'prepared-caff-turn-v1', sessionText: null,
    files: [file('package.json', pkg), file('package-lock.json', { ...pkg, lockfileVersion: 3, packages: { '': pkg } })], deletions: [] } };
}
test('Windows cache CLI selects the explicit transport before any sealed/safety read, and never defaults a distro', async t => {
  const { main } = require('../../scripts/badcase-capture/cache-replay-dependencies.cjs'), f = fixture(t);
  let prepares = 0;
  const options = { platform: 'win32', prepare: () => { prepares++; assert.fail('must not open sealed/safety inputs'); }, createWslDockerRunner: () => assert.fail('must not spawn') };
  fs.writeFileSync(f.file, JSON.stringify({ image }));
  await assert.rejects(main([f.file, f.cache], options), /evaluation_wsl_backend_required/);
  fs.writeFileSync(f.file, JSON.stringify({ image, dockerBackend: { ...backend, distribution: 'Debian;sh' } }));
  await assert.rejects(main([f.file, f.cache], options), /evaluation_wsl_backend_invalid/);
  fs.writeFileSync(f.file, JSON.stringify({ image, dockerBackend: backend }));
  await assert.rejects(main([f.file, f.cache], { ...options, platform: 'linux' }), /evaluation_wsl_host_required/);
  assert.equal(prepares, 0); assert.equal(fs.existsSync(f.cache), false);
});
test('Windows CLI builds through the same credential-free Docker kernel, reuses cache without proxy, and returns only safe backend identity', async t => {
  const { main } = require('../../scripts/badcase-capture/cache-replay-dependencies.cjs'), f = fixture(t), calls = [];
  fs.writeFileSync(f.file, JSON.stringify({ image, dockerBackend: backend, dependencies: { kind: 'npm-ci-linux-v1', cacheRoot: f.cache } }));
  const runner = () => assert.fail('inert builder does not call Docker');
  let proxies = 0, builds = 0, prepares = 0;
  const options = { platform: 'win32', prepare: cfg => { prepares++; assert.equal(cfg.dependencies, undefined); return { supported: true, inputs: { original: f.input } }; },
    createWslDockerRunner: cfg => { assert.deepEqual(cfg, backend); return runner; },
    withWslDependencyProxy: async (cfg, work) => { assert.deepEqual(cfg, backend); proxies++; return work('http://172.20.0.1:12345'); },
    runBuild: async (_image, files, settings) => {
      builds++; assert.equal(settings.runDocker, runner); assert.equal(settings.key, undefined); assert.equal(settings.network, 'bridge');
      const config = JSON.parse(files.find(f => f.path === 'dependency-install.json').bytes);
      assert.deepEqual(config, { proxyUrl: 'http://172.20.0.1:12345', network: 'bridge' }); calls.push(files.map(f => f.path));
      const bytes = Buffer.from('inert archive'); fs.writeFileSync(settings.outputFile, bytes);
      return { code: 0, cleaned: true, receipt: { kind: 'npm-replay-dependencies-v1', nodeVersion: image.nodeVersion, npmVersion: '11.11.1',
        installCommand: 'npm ci --include=dev --no-audit --no-fund', archiveHash: hash(bytes), modelCalls: 0, untrustedExtra: 'never-persist' } };
    } };
  const first = await main([f.file, f.cache], options), second = await main([f.file, f.cache], options);
  assert.equal(first.cacheHit, false); assert.equal(second.cacheHit, true); assert.deepEqual(first.dockerBackend, backend);
  assert.equal(proxies, 1); assert.equal(builds, 1); assert.equal(prepares, 2); assert.equal(first.untrustedExtra, undefined);
  assert.equal(JSON.stringify(first).includes(f.root), false); assert.equal(calls.length, 1);
  const dir = path.join(f.cache, first.cacheKey), receipt = fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8');
  assert.ok(!receipt.includes('never-persist')); assert.ok(!receipt.includes('172.20.0.1')); assert.ok(!receipt.includes('Debian'));
  fs.writeFileSync(path.join(dir, 'node_modules.tar.gz'), 'corrupt');
  await assert.rejects(main([f.file, f.cache], options), /evaluation_dependency_cache_invalid/);
  assert.equal(proxies, 1); assert.equal(builds, 1);
});
test('Linux cache-hit entry remains native and does not construct a Windows runner or open a network relay', async t => {
  const { main } = require('../../scripts/badcase-capture/cache-replay-dependencies.cjs'), f = fixture(t);
  const { cacheReplayDependencies } = require('../../scripts/badcase-capture/replay-dependencies.cjs');
  fs.mkdirSync(f.cache);
  await cacheReplayDependencies(f.input, image, f.cache, { runBuild: async (_image, _files, settings) => {
    const bytes = Buffer.from('inert Linux cache'); fs.writeFileSync(settings.outputFile, bytes);
    return { code: 0, cleaned: true, receipt: { kind: 'npm-replay-dependencies-v1', nodeVersion: image.nodeVersion, npmVersion: '11.11.1',
      installCommand: 'npm ci --include=dev --no-audit --no-fund', archiveHash: hash(bytes), modelCalls: 0 } };
  } });
  fs.writeFileSync(f.file, JSON.stringify({ image }));
  const result = await main([f.file, f.cache], { platform: 'linux', prepare: () => ({ supported: true, inputs: { original: f.input } }),
    createWslDockerRunner: () => assert.fail(), withWslDependencyProxy: () => assert.fail(), runBuild: () => assert.fail() });
  assert.equal(result.cacheHit, true); assert.equal(result.dockerBackend, undefined);
});
test('missing sealed material, conflicting cache config, or proxy failure cannot invoke npm or leave an install directory', async t => {
  const { main } = require('../../scripts/badcase-capture/cache-replay-dependencies.cjs'), f = fixture(t);
  const options = { platform: 'win32', createWslDockerRunner: () => () => assert.fail(), prepare: () => ({ supported: false }),
    withWslDependencyProxy: async () => { throw Object.assign(Error('evaluation_dependency_proxy_unavailable'), { code: 'evaluation_dependency_proxy_unavailable' }); }, runBuild: () => assert.fail() };
  fs.writeFileSync(f.file, JSON.stringify({ image, dockerBackend: backend }));
  await assert.rejects(main([f.file, f.cache], options), /evaluation_dependencies_replay_materials_required/);
  assert.equal(fs.existsSync(f.cache), false);
  for (const dependencies of [null, [], { kind: 'npm-ci-linux-v1', cacheRoot: f.root }, { kind: 'npm-ci-linux-v1', cacheRoot: 'relative' },
    { kind: 'npm-ci-linux-v1', cacheRoot: f.cache, extra: true }]) {
    fs.writeFileSync(f.file, JSON.stringify({ image, dockerBackend: backend, dependencies }));
    await assert.rejects(main([f.file, f.cache], options), /evaluation_config_invalid/);
  }
  fs.writeFileSync(f.file, JSON.stringify({ image, dockerBackend: backend }));
  await assert.rejects(main([f.file, f.cache], { ...options, prepare: () => ({ supported: true, inputs: { original: f.input } }) }), /evaluation_dependency_proxy_unavailable/);
  assert.deepEqual(fs.readdirSync(f.cache), []);
});
test('WSL gateway inspection uses a fixed exec command, stripped environment, and a verified private Windows-owned address only', () => {
  const { inspectWslDependencyGateway } = require('../../scripts/badcase-capture/wsl-dependency-proxy.cjs');
  const calls = [], interfaces = () => ({ ethernet: [{ family: 'IPv4', address: '172.20.0.1', internal: false }] });
  const gateway = inspectWslDependencyGateway(backend, { platform: 'win32', env: { PATH: 'path', SystemRoot: 'root', WSLENV: 'PRIVATE/u', PRIVATE: 'synthetic-forbidden', HTTP_PROXY: 'synthetic-forbidden' },
    networkInterfaces: interfaces, execFileSync: (...args) => { calls.push(args); return 'default via 172.20.0.1 dev eth0 proto kernel\n'; } });
  assert.equal(gateway, '172.20.0.1'); const [program, args, options] = calls[0];
  assert.equal(program, 'wsl.exe'); assert.deepEqual(args.slice(0, 5), ['--distribution', 'Debian', '--exec', '/usr/bin/env', '-i']);
  assert.deepEqual(args.slice(-5), ['ip', '-4', 'route', 'show', 'default']);
  assert.ok(args.includes('HOME=/nonexistent')); assert.equal(options.shell, false); assert.equal(options.timeout, 15000);
  assert.equal(JSON.stringify(options).includes('synthetic-forbidden'), false); assert.equal(options.env.WSLENV, undefined);
});
test('ambiguous, public, loopback, unowned or unavailable WSL gateways stop without binding, credential reads or direct fallback', async () => {
  const { inspectWslDependencyGateway, withWslDependencyProxy } = require('../../scripts/badcase-capture/wsl-dependency-proxy.cjs');
  const interfaces = () => ({ eth: [{ family: 'IPv4', address: '172.20.0.1', internal: false }] });
  for (const text of ['default via 127.0.0.1 dev lo\n', 'default via 8.8.8.8 dev eth0\n', 'default via 172.20.0.2 dev eth0\n',
    'default dev eth0\n', 'default via 172.20.0.1 dev eth0\ndefault via 172.20.0.2 dev eth1\n', '', 'default via 172.20.0.1 dev eth0;sh\n']) {
    assert.throws(() => inspectWslDependencyGateway(backend, { platform: 'win32', networkInterfaces: interfaces, execFileSync: () => text }), /evaluation_dependency_proxy_unavailable/);
  }
  await assert.rejects(withWslDependencyProxy(backend, () => assert.fail(), { platform: 'win32', networkInterfaces: interfaces,
    execFileSync: () => { throw Error('raw synthetic sensitive stderr'); }, withDependencyProxy: () => assert.fail() }), /evaluation_dependency_proxy_unavailable/);
  let entered = 0;
  await assert.rejects(withWslDependencyProxy(backend, async () => { entered++; throw Error('synthetic-work-failed'); }, { platform: 'win32', networkInterfaces: interfaces,
    execFileSync: () => 'default via 172.20.0.1 dev eth0\n', withDependencyProxy: async (address, work) => { assert.equal(address, '172.20.0.1'); return work('http://172.20.0.1:123'); } }), /synthetic-work-failed/);
  assert.equal(entered, 1);
});
