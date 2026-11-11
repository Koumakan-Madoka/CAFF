const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const deps = require('../../scripts/badcase-capture/replay-dependencies.cjs');
const { prepareDirectReplayInput, runDependencyDockerTask } = require('../../scripts/badcase-capture/direct-docker.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0' };
const file = (name, text) => ({ path: name, base64: Buffer.from(text).toString('base64'), sha256: hash(text) });
function input() {
  const pkg = { name: 'synthetic-replay', version: '1.0.0' };
  return { kind: 'prepared-caff-turn-v1', files: [file('package.json', JSON.stringify(pkg)),
    file('package-lock.json', JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } }))], deletions: [], sessionText: null };
}
function cache(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-replay-deps-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function builder(archive, calls) { return async (img, files, options) => {
  calls.push({ img, files, options }); fs.writeFileSync(options.outputFile, archive);
  return { code: 0, cleaned: true, receipt: { kind: 'npm-replay-dependencies-v1', nodeVersion: image.nodeVersion, npmVersion: '11.11.1', installCommand: 'npm ci --include=dev --no-audit --no-fund', archiveHash: hash(archive), modelCalls: 0 } };
}; }
test('dependency identity shares package/lock across different worktrees, but binds Linux image and installation policy', () => {
  const original = input(), before = JSON.stringify(original), a = deps.dependencyRecipe(original, image);
  assert.equal(a.kind, 'npm-ci-linux-v1'); assert.equal(a.lockHash, original.files[1].sha256);
  assert.equal(JSON.stringify(original), before);
  const changed = input(); changed.files.push(file('src/version.txt', 'changed'));
  assert.equal(deps.dependencyRecipe(changed, image).cacheKey, a.cacheKey);
  changed.gitFiles = [{ path: '.git/HEAD', sha256: hash('different git history') }];
  assert.equal(deps.dependencyRecipe(changed, image).cacheKey, a.cacheKey);
  const lockChanged = input(); lockChanged.files[1] = file('package-lock.json', Buffer.from(lockChanged.files[1].base64, 'base64').toString() + '\n');
  assert.notEqual(deps.dependencyRecipe(lockChanged, image).cacheKey, a.cacheKey);
  assert.notEqual(deps.dependencyRecipe(original, { ...image, imageId: 'sha256:' + '3'.repeat(64) }).cacheKey, a.cacheKey);
  assert.notEqual(deps.dependencyRecipe(original, { ...image, nodeVersion: 'v24.22.0' }).cacheKey, a.cacheKey);
});
test('missing/inconsistent lock, unsupported managers and escaping local dependencies fail before any install', () => {
  const a = input(); a.files.pop(); assert.throws(() => deps.dependencyRecipe(a, image), /dependencies_unsupported/);
  for (const lock of ['not-json', JSON.stringify({ lockfileVersion: 1 }), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/out': { resolved: 'file:../outside' } } })]) {
    const v = input(); v.files[1] = file('package-lock.json', lock); assert.throws(() => deps.dependencyRecipe(v, image), /dependencies_unsupported/);
  }
  for (const name of ['yarn.lock', 'pnpm-lock.yaml', '.npmrc']) {
    const v = input(); v.files.push(file(name, 'unsupported')); assert.throws(() => deps.dependencyRecipe(v, image), /dependencies_unsupported/);
  }
  const v = input(); v.files[0].sha256 = '0'.repeat(64); assert.throws(() => deps.dependencyRecipe(v, image), /dependencies_unsupported/);
});
test('npm shrinkwrapped/bundled lock entries may omit integrity; the gap is disclosed and malformed explicit checksums refused', () => {
  const v = input(), lock = JSON.parse(Buffer.from(v.files[1].base64, 'base64'));
  lock.packages['node_modules/parent'] = { resolved: 'https://registry.npmjs.org/parent/-/parent-1.0.0.tgz', integrity: 'sha512-YWJj', hasShrinkwrap: true };
  lock.packages['node_modules/parent/node_modules/child'] = { resolved: 'https://registry.npmjs.org/child/-/child-1.0.0.tgz', inBundle: true };
  v.files[1] = file('package-lock.json', JSON.stringify(lock));
  assert.doesNotThrow(() => deps.dependencyRecipe(v, image));
  delete lock.packages['node_modules/parent/node_modules/child'].inBundle;
  v.files[1] = file('package-lock.json', JSON.stringify(lock));
  assert.equal(deps.dependencyRecipe(v, image).resolvedWithoutIntegrity, 1);
  lock.packages['node_modules/parent/node_modules/child'].integrity = 'malformed';
  v.files[1] = file('package-lock.json', JSON.stringify(lock));
  assert.throws(() => deps.dependencyRecipe(v, image), /dependencies_unsupported/);
});
test('cache installs once without account credentials, validates content on every read, never repairs corruption silently', async t => {
  const root = cache(t), v = input(), archive = Buffer.from('synthetic archive bytes'), calls = [];
  v.files.push(file('src/not-an-install-input.js', 'first worktree'));
  const build = builder(archive, calls);
  const one = await deps.cacheReplayDependencies(v, image, root, { runBuild: build });
  assert.equal(one.cacheHit, false); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.key, undefined); assert.equal(calls[0].files.some(f => f.path === 'replay-workspace/package-lock.json'), true);
  const other = structuredClone(v); other.files.push(file('src/another-worktree.js', 'changed source'));
  other.gitFiles = [{ path: '.git/HEAD', sha256: hash('other history') }];
  const two = await deps.cacheReplayDependencies(other, image, root, { runBuild: build });
  assert.equal(two.cacheHit, true); assert.equal(two.cacheKey, one.cacheKey); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].files.filter(f => f.path.startsWith('replay-workspace/')).map(f => f.path).sort(),
    ['replay-workspace/package-lock.json', 'replay-workspace/package.json']);
  const changedLock = input(); changedLock.files[1] = file('package-lock.json', Buffer.from(changedLock.files[1].base64, 'base64').toString() + '\n');
  const miss = await deps.cacheReplayDependencies(changedLock, image, root, { runBuild: build });
  assert.equal(miss.cacheHit, false); assert.notEqual(miss.cacheKey, one.cacheKey); assert.equal(calls.length, 2);
  const read = deps.prepareReplayDependencies(v, image, root);
  assert.equal(read.dependencyArchive.base64, undefined);
  assert.deepEqual(fs.readFileSync(read.dependencyArchive.sourceFile), archive);
  const staged = prepareDirectReplayInput({ ...v, ...read });
  assert.equal(staged.find(f => f.path === 'replay-dependencies.tar.gz').bytes, undefined);
  assert.equal(staged.find(f => f.path === 'replay-dependencies.tar.gz').sourceFile, read.dependencyArchive.sourceFile);
  assert.equal(JSON.stringify(JSON.parse(staged.find(f => f.path === 'replay-input.json').bytes)).includes(root), false);
  assert.equal(read.dependencies.archiveHash, hash(archive)); assert.equal(read.dependencies.cacheKey, one.cacheKey);
  fs.writeFileSync(path.join(root, one.cacheKey, 'node_modules.tar.gz'), 'corrupt');
  assert.throws(() => deps.prepareReplayDependencies(v, image, root), /dependency_cache_invalid/);
  await assert.rejects(deps.cacheReplayDependencies(v, image, root, { runBuild: build }), /dependency_cache_invalid/);
  assert.equal(calls.length, 2);
});
test('failed install/cleanup or mismatched archive never publishes a reusable cache', async t => {
  const root = cache(t), v = input(), calls = [];
  for (const alteration of [{ failed: true, reason: 'worker_failed' }, { cleaned: false }, { receipt: { kind: 'bad', archiveHash: '0'.repeat(64) } }]) {
    await assert.rejects(deps.cacheReplayDependencies(v, image, root, { runBuild: async (...args) => ({ ...await builder(Buffer.from('data'), calls)(...args), ...alteration }) }), /dependency_install_failed/);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});
test('dependency archive is outside JSON and static byte ceilings, but fully hash-bound, with no host cache path in the worker', () => {
  const v = input(), bytes = Buffer.alloc(25 * 1024 * 1024, 0x61);
  v.dependencies = { kind: 'npm-ci-linux-v1', archiveHash: hash(bytes) };
  v.dependencyArchive = { base64: bytes.toString('base64'), sha256: hash(bytes) };
  const files = prepareDirectReplayInput(v), json = JSON.parse(files.find(f => f.path === 'replay-input.json').bytes);
  assert.equal(json.dependencyArchive, undefined); assert.equal(json.dependencies.archivePath, 'replay-dependencies.tar.gz');
  assert.deepEqual(files.find(f => f.path === 'replay-dependencies.tar.gz').bytes, bytes);
  const m = manifestFor(files, { replayWorkspace: true });
  assert.equal(m.files.find(f => f.path === 'replay-dependencies.tar.gz').sha256, hash(bytes));
  assert.throws(() => manifestFor(files), /probe_dependency_size/);
  const bad = structuredClone(v); bad.dependencyArchive.sha256 = '0'.repeat(64); assert.throws(() => prepareDirectReplayInput(bad));
});
test('comparison preflight requires a valid Linux cache and binds it to both variants; missing installed receipt blocks scoring', async t => {
  const root = cache(t), v = input(), calls = [], { prepareComparison, runComparison, expectedTreeHash } = require('../../scripts/badcase-capture/direct-comparison.cjs');
  const config = { request: {}, repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), image, repeats: 1,
    candidateRole: 'Verify.', dependencies: { kind: 'npm-ci-linux-v1', cacheRoot: root },
    rules: { kind: 'read-only-files-v1', readPaths: ['package.json'], absentPaths: [], requiredReplyFragments: ['literal result'] } };
  const prepare = (_q, candidate) => ({ supported: true, input: { ...v, prompt: candidate || 'original' }, provenance: { checkpointHash: 'fixed', commonInputHash: 'fixed' } });
  assert.throws(() => prepareComparison(config, { prepare }), /dependency_cache_invalid/);
  await deps.cacheReplayDependencies(v, image, root, { runBuild: builder(Buffer.from('synthetic archive'), calls) });
  const plan = prepareComparison(config, { prepare });
  assert.equal(plan.supported, true); assert.deepEqual(plan.inputs.original.dependencies, plan.inputs.candidate.dependencies);
  assert.equal(JSON.stringify(plan.summary).includes(root), false); assert.notEqual(plan.summary.commonInputHash, 'fixed');
  for (const change of ['none', 'missing', 'wrong-hash', 'not-installed']) {
    const result = await runComparison(config, { prepare, confirmed: true, readKey: () => 'inert-test-marker-not-a-real-key',
      stage: (_r, _d, _i, input) => [{ path: 'probe.cjs', bytes: Buffer.from('inert') }, ...prepareDirectReplayInput(input)],
      execute: async (_image, files) => {
        const m = manifestFor(files, { replayWorkspace: true }), wire = JSON.parse(files.find(f => f.path === 'replay-input.json').bytes);
        const dependencies = { ...wire.dependencies, installed: change !== 'not-installed' };
        if (change === 'wrong-hash') dependencies.archiveHash = '0'.repeat(64);
        return { code: 0, cleaned: true, receipt: { kind: 'direct-caff-turn-v1', success: true, inputHash: m.inputHash, runtimeHash: m.runtimeHash,
          beforeHash: expectedTreeHash(v), afterHash: expectedTreeHash(v), finalText: 'literal result', replySource: 'public',
          toolCalls: [{ name: 'read', isError: false, args: { path: 'package.json' } }],
          modelCalls: [{ model: 'opencode-go/deepseek-v4.1-flash', success: true, durationMs: 1 }], ...(change === 'missing' ? {} : { dependencies }) } };
      } });
    assert.equal(result.completed, change === 'none'); assert.equal(result.runs.length, change === 'none' ? 2 : 1);
    assert.equal(result.runs[0].status, change === 'none' ? 'pass' : 'error');
  }
});
test('dependency restoration verifies archive bytes and safe entries before extracting, never trusts a bare installed flag', () => {
  const vm = require('node:vm'), bytes = Buffer.from('archive'), module = { exports: {} }, extracted = [], removed = [];
  let listing = 'node_modules/\nnode_modules/synthetic/index.js\n';
  const deps = { kind: 'npm-ci-linux-v1', archivePath: 'replay-dependencies.tar.gz', archiveHash: hash(bytes), nodeVersion: process.version };
  vm.runInNewContext(fs.readFileSync(path.resolve('scripts/badcase-capture/restore-replay-dependencies.cjs'), 'utf8'), {
    module, process, require(name) {
      if (name === 'node:fs') return { existsSync: () => false, readFileSync: () => bytes,
        lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }), unlinkSync: p => removed.push(p) };
      if (name === '/work/caff-runtime-bootstrap.cjs') return { hashFile: () => hash(bytes) };
      if (name === 'node:child_process') return { execFileSync(_program, args) { if (args[0] === '-tzf') return Buffer.from(listing); extracted.push(args); return Buffer.alloc(0); } };
      return require(name);
    }
  });
  const restore = module.exports.restoreReplayDependencies;
  assert.equal(restore('/work/restored', deps).installed, true); assert.equal(extracted.length, 1); assert.equal(removed.length, 1);
  for (listing of ['../escape\n', '/absolute\n', 'node_modules/../../escape\n', 'outside/\n', '']) {
    assert.throws(() => restore('/work/restored', deps)); assert.equal(extracted.length, 1);
  }
  assert.throws(() => restore('/work/restored', { ...deps, archiveHash: '0'.repeat(64) }));
  assert.throws(() => restore('/work/restored', { ...deps, archivePath: '../outside.tar.gz' }));
});
test('npm installer uses distinct empty user/global config files, no ambient auth, and offline mode without proxy fallback', () => {
  const vm = require('node:vm'), module = { exports: {} }, executions = [], writes = [], archive = Buffer.from('archive');
  const context = { module, process: { version: 'v24.21.0', env: { PATH: '/usr/bin', CAFF_BADCASE_MODEL_KEY: 'inert-parent-marker' } },
    require(name) {
      if (name === '/work/caff-runtime-bootstrap.cjs') return { verifyCaffRuntimeStage: () => ({}) };
      if (name === 'node:fs') return { readFileSync: p => p.endsWith('dependency-install.json') ? JSON.stringify({ network: 'none', proxyUrl: null }) : archive,
        writeFileSync: (...args) => writes.push(args), renameSync: () => {}, mkdirSync: () => {} };
      if (name === 'node:child_process') return { execFileSync(program, args, options) {
        assert.notEqual(options.env.npm_config_userconfig, options.env.npm_config_globalconfig);
        assert.equal(options.env.CAFF_BADCASE_MODEL_KEY, undefined); assert.equal(options.env.npm_config_offline, 'true');
        assert.equal(options.env.HTTPS_PROXY, undefined); executions.push({ program, args, options }); return Buffer.from('11.11.1');
      } };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.resolve('scripts/badcase-capture/npm-dependencies-container.cjs'), 'utf8'), context);
  assert.equal(module.exports.main().archiveHash, hash(archive)); assert.equal(writes.length, 2);
  assert.ok(writes.every(([, content, opts]) => content === '' && opts.flag === 'wx'));
  assert.equal(executions[0].program, 'npm'); assert.deepEqual(Array.from(executions[0].args), ['ci', '--include=dev', '--no-audit', '--no-fund']);
});
test('keyless installer has a dedicated launcher, not a fake or inherited provider key', () => {
  assert.equal(typeof runDependencyDockerTask, 'function');
});
test('CLI discloses recorded npm lock entries with no integrity, rather than claiming full checksum coverage', () => {
  const { formatComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs');
  const text = formatComparison({ supported: true, model: 'synthetic', dependencies: {
    lockHash: 'fixed-lock-hash', nodeVersion: 'v24.21.0', resolvedWithoutIntegrity: 3 }, runs: [] });
  assert.match(text, /3条下载记录没有integrity/);
});
test('two-file installation rejects local package/workspace dependencies and root lifecycle scripts needing uncached source', () => {
  const v = input(), lock = JSON.parse(Buffer.from(v.files[1].base64, 'base64'));
  for (const resolved of ['https://user:inert@example.com/pkg.tgz', 'https://registry.npmjs.org/pkg.tgz?auth=inert',
    'http://registry.npmjs.org/pkg.tgz', 'https://example.com/pkg.tgz', 'file:../outside']) {
    lock.packages['node_modules/pkg'] = { resolved };
    v.files[1] = file('package-lock.json', JSON.stringify(lock));
    assert.throws(() => deps.dependencyRecipe(v, image), /dependencies_unsupported/);
  }
  lock.packages['node_modules/pkg'] = { resolved: 'file:packages/pkg' };
  v.files[1] = file('package-lock.json', JSON.stringify(lock));
  v.files.push(file('packages/pkg/package.json', JSON.stringify({ name: 'pkg', version: '1.0.0' })));
  assert.throws(() => deps.dependencyRecipe(v, image), /dependencies_unsupported/);
  for (const script of ['preinstall', 'install', 'postinstall', 'prepublish', 'prepare', 'preprepare', 'postprepare']) {
    const p = input(), pkg = JSON.parse(Buffer.from(p.files[0].base64, 'base64'));
    pkg.scripts = { [script]: 'node ./scripts/from-worktree.cjs' };
    p.files[0] = file('package.json', JSON.stringify(pkg));
    assert.throws(() => deps.dependencyRecipe(p, image), /dependencies_unsupported/);
  }
  const workspace = input(), pkg = JSON.parse(Buffer.from(workspace.files[0].base64, 'base64'));
  pkg.workspaces = ['packages/*']; workspace.files[0] = file('package.json', JSON.stringify(pkg));
  assert.throws(() => deps.dependencyRecipe(workspace, image), /dependencies_unsupported/);
});
test('temporary dependency relay only dials the approved loopback proxy and closes sockets/listener even when work fails', async () => {
  const vm = require('node:vm'), { EventEmitter } = require('node:events');
  for (const failWork of [false, true]) {
    const module = { exports: {} }, connects = [], sockets = []; let accept, closed = false, listenAddress;
    const socket = () => { const s = new EventEmitter(); s.setTimeout = () => {}; s.pipe = () => {}; s.destroy = () => { s.destroyed = true; }; sockets.push(s); return s; };
    const relay = new EventEmitter();
    relay.listen = (_port, address, done) => { listenAddress = address; relay.listening = true; done(); };
    relay.address = () => ({ port: 12345 });
    relay.close = done => { closed = true; relay.listening = false; done(); };
    vm.runInNewContext(fs.readFileSync(path.resolve('scripts/badcase-capture/dependency-proxy.cjs'), 'utf8'), {
      module, require(name) {
        if (name === './host-proxy.cjs') return require('../../scripts/badcase-capture/host-proxy.cjs');
        assert.equal(name, 'node:net'); return { isIPv4: require('node:net').isIPv4,
        createServer: callback => { accept = callback; return relay; }, connect: options => { connects.push(options); return socket(); } }; }
    });
    const work = module.exports.withDependencyProxy('172.18.0.1', async url => {
      assert.equal(url, 'http://172.18.0.1:12345'); accept(socket());
      if (failWork) throw Error('synthetic-work-failed'); return 'done';
    });
    if (failWork) await assert.rejects(work, /synthetic-work-failed/); else assert.equal(await work, 'done');
    assert.equal(listenAddress, '172.18.0.1'); assert.equal(closed, true); assert.ok(sockets.every(s => s.destroyed));
    const hostProxy = require('../../scripts/badcase-capture/host-proxy.cjs');
    assert.equal(connects.length, 1); assert.equal(connects[0].host, hostProxy.host); assert.equal(connects[0].port, hostProxy.port);
    await assert.rejects(module.exports.withDependencyProxy('0.0.0.0', async () => {}), /proxy_invalid/);
  }
});
