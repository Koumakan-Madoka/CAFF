// Inert installer/export seams only: no host native/SDK execution or Docker.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const inventory = require('../../scripts/badcase-capture/evaluation-bridge-files.json');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const repo = path.resolve(__dirname, '../..'), native = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
const image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-dependencies-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = inventory.dependencies.map(name => {
    let bytes = fs.readFileSync(path.join(repo, name));
    if (name === native) { bytes = Buffer.alloc(64); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); }
    return { path: name, bytes };
  });
  const artifact = () => Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'fixed-linux-runtime-files-v1', files: files.map(f => ({ path: f.path,
    base64: f.bytes.toString('base64'), size: f.bytes.length, sha256: hash(f.bytes) })) }));
  const calls = { installs: 0, exports: 0, proxies: 0, wsl: 0 };
  const options = { platform: 'win32', createWslDockerRunner: () => { calls.wsl++; return () => assert.fail(); },
    withWslDependencyProxy: async (_backend, work) => { calls.proxies++; return work('http://172.20.0.1:12345'); },
    runBuild: async (_image, _files, settings) => { calls.installs++; const bytes = Buffer.from('inert npm archive'); fs.writeFileSync(settings.outputFile, bytes);
      return { code: 0, cleaned: true, receipt: { kind: 'npm-replay-dependencies-v1', nodeVersion: image.nodeVersion, npmVersion: '11.11.1',
        installCommand: 'npm ci --include=dev --no-audit --no-fund', archiveHash: hash(bytes), modelCalls: 0 } }; },
    runExport: async (_image, staged, settings) => {
      calls.exports++; assert.equal(settings.network, 'none'); assert.equal(settings.key, undefined); assert.equal(typeof settings.runDocker, 'function');
      assert.ok(staged.some(f => f.path === 'runtime-dependency-inventory.json'));
      assert.ok(staged.some(f => f.path === 'replay-dependencies.tar.gz'));
      const bytes = artifact(); fs.writeFileSync(settings.outputFile, bytes);
      return { code: 0, cleaned: true, receipt: { kind: 'fixed-linux-runtime-export-v1', nodeVersion: image.nodeVersion, architecture: image.architecture,
        nativeSqliteVerified: true, nativeSqliteVersion: '3.51.2', filesHash: manifestFor(files).inputHash, artifactHash: hash(bytes), modelCalls: 0,
        untrustedExtra: 'not persisted' } };
    } };
  return { root, files, artifact, options, calls, config: { image, dockerBackend: { kind: 'windows-wsl-v1', distribution: 'Debian' } } };
}
test('runtime preparation uses only the fixed trusted distribution package/lock and rejects backend/config before installing', async t => {
  const api = require('../../scripts/badcase-capture/runtime-dependencies.cjs'), f = fixture(t);
  const input = api.runtimePackageInput(repo);
  assert.deepEqual(input.files.map(f => f.path), ['package.json', 'package-lock.json']);
  assert.equal(input.gitFiles, undefined); assert.equal(input.sessionText, null);
  for (const file of input.files) assert.equal(file.sha256, hash(fs.readFileSync(path.join(repo, file.path))));
  await assert.rejects(api.cacheRuntimeDependencies({ ...f.config, repoRoot: '/untrusted' }, f.root, f.options), /evaluation_runtime_config_invalid/);
  await assert.rejects(api.cacheRuntimeDependencies({ image }, f.root, f.options), /evaluation_wsl_backend_required/);
  await assert.rejects(api.cacheRuntimeDependencies(f.config, f.root, { ...f.options, platform: 'linux' }), /evaluation_wsl_host_required/);
  assert.equal(f.calls.installs, 0); assert.equal(f.calls.exports, 0);
});
test('fixed Linux bytes publish atomically only after offline SQLite/export checks; cache hits revalidate without host loading/install/export', async t => {
  const { cacheRuntimeDependencies } = require('../../scripts/badcase-capture/runtime-dependencies.cjs'), f = fixture(t);
  const before = JSON.stringify(f.config), one = await cacheRuntimeDependencies(f.config, f.root, f.options);
  assert.equal(JSON.stringify(f.config), before); assert.equal(one.cacheHit, false); assert.equal(one.nativeSqliteVerified, true);
  assert.equal(one.fileCount, inventory.dependencies.length); assert.ok(path.isAbsolute(one.dependencyRoot));
  assert.deepEqual(f.calls, { installs: 1, exports: 1, proxies: 1, wsl: 2 });
  const two = await cacheRuntimeDependencies(f.config, f.root, f.options);
  assert.equal(two.cacheHit, true); assert.equal(two.dependencyRoot, one.dependencyRoot); assert.equal(two.filesHash, one.filesHash);
  assert.equal(f.calls.installs, 1); assert.equal(f.calls.exports, 1); assert.equal(f.calls.proxies, 1);
  assert.equal(fs.existsSync(path.join(one.dependencyRoot, native)), true);
  const receipt = fs.readFileSync(path.join(one.dependencyRoot, '../receipt.json'), 'utf8');
  assert.ok(!receipt.includes('not persisted')); assert.ok(!receipt.includes('172.20.0.1')); assert.ok(!receipt.includes('Debian'));
  fs.writeFileSync(path.join(one.dependencyRoot, native), 'Windows or corrupt native bytes');
  await assert.rejects(cacheRuntimeDependencies(f.config, f.root, f.options), /evaluation_runtime_cache_invalid/);
  assert.equal(f.calls.installs, 1); assert.equal(f.calls.exports, 1);
});
test('missing/extra/traversal/duplicate/package-version/ELF/hash drift and false native/cleanup claims cannot publish a runtime root', async t => {
  const { cacheRuntimeDependencies } = require('../../scripts/badcase-capture/runtime-dependencies.cjs');
  for (const kind of ['missing', 'extra', 'traversal', 'duplicate', 'package', 'elf', 'hash', 'native', 'cleanup']) {
    const f = fixture(t), run = f.options.runExport;
    f.options.runExport = async (...args) => {
      const result = await run(...args), file = args[2].outputFile, data = JSON.parse(fs.readFileSync(file));
      if (kind === 'missing') data.files.pop();
      if (kind === 'extra' || kind === 'duplicate') data.files.push({ ...data.files[0], ...(kind === 'extra' ? { path: 'node_modules/unlisted.js' } : {}) });
      if (kind === 'traversal') data.files[0].path = '../escape';
      const item = kind === 'package' ? data.files.find(f => f.path === 'node_modules/better-sqlite3/package.json') : data.files.find(f => f.path === native);
      if (kind === 'package' || kind === 'elf') {
        const bytes = Buffer.from(kind === 'package' ? '{"name":"better-sqlite3","version":"0.0.0"}' : 'not ELF');
        item.base64 = bytes.toString('base64'); item.size = bytes.length; item.sha256 = hash(bytes);
        // Resign the bytes too: rejection must come from independent fixed
        // package/ELF validation, not merely the unchanged manifest hash.
        result.receipt.filesHash = manifestFor(data.files.map(f => ({ path: f.path, bytes: Buffer.from(f.base64, 'base64') }))).inputHash;
      }
      if (kind === 'hash') data.files[0].sha256 = '0'.repeat(64);
      if (kind === 'native') result.receipt.nativeSqliteVerified = false;
      if (kind === 'cleanup') result.cleaned = false;
      const bytes = Buffer.from(JSON.stringify(data)); fs.writeFileSync(file, bytes); result.receipt.artifactHash = hash(bytes);
      return result;
    };
    await assert.rejects(cacheRuntimeDependencies(f.config, f.root, f.options), /evaluation_runtime_export_failed/, kind);
    assert.ok(fs.readdirSync(f.root).every(name => name === 'npm'), kind + ': no temporary or final runtime root');
    assert.equal(fs.existsSync(path.join(f.root, 'escape')), false);
  }
});
test('actual exporter body verifies stage/restore before native query/close; failures never write an artifact (inert VM)', t => {
  const f = fixture(t), source = fs.readFileSync(path.join(repo, 'scripts/badcase-capture/runtime-dependencies-container.cjs'), 'utf8');
  for (const failure of ['', 'guard', 'restore', 'query', 'close']) {
    const events = [], writes = [], module = { exports: {} }, bytes = new Map(f.files.map(f => ['/work/restored/' + f.path, f.bytes]));
    const failAt = name => { events.push(name); if (failure === name) throw Error('synthetic-' + name); };
    const fakeFs = { renameSync: () => {}, readFileSync: name => name === '/work/runtime-dependency-inventory.json' ? JSON.stringify(inventory)
      : name === '/work/replay-input.json' ? '{"dependencies":{}}' : bytes.get(name),
      lstatSync: name => ({ isFile: () => bytes.has(name), isDirectory: () => !bytes.has(name), isSymbolicLink: () => false, size: bytes.get(name)?.length || 0 }),
      writeFileSync: (name, value, settings) => { assert.equal(name, '/work/runtime-files.json'); assert.equal(settings.flag, 'wx'); writes.push(value); } };
    require('node:vm').runInNewContext(source, { module, Buffer, process: { version: image.nodeVersion }, require: name => {
      if (name === 'node:fs') return fakeFs;
      if (name === '/work/caff-runtime-bootstrap.cjs') return { verifyCaffRuntimeStage: options => { assert.equal(options.replayWorkspace, true); failAt('guard'); return { image }; } };
      if (name === '/work/restore-replay-dependencies.cjs') return { restoreReplayDependencies: () => failAt('restore') };
      if (name === '/work/restored/node_modules/better-sqlite3') { failAt('native'); return class Database {
        constructor(name) { assert.equal(name, ':memory:'); }
        prepare(sql) { assert.equal(sql, 'select sqlite_version() as version'); return { get: () => { failAt('query'); return { version: '3.51.2' }; } }; }
        close() { failAt('close'); }
      }; }
      if (name === './replay-path.cjs') return require('../../scripts/badcase-capture/replay-path.cjs');
      return require(name);
    } });
    if (failure) {
      assert.throws(() => module.exports.main(), new RegExp('synthetic-' + failure)); assert.equal(writes.length, 0);
      assert.deepEqual(events, failure === 'guard' ? ['guard'] : failure === 'restore' ? ['guard', 'restore'] : ['guard', 'restore', 'native', 'query', 'close']);
    } else {
      const receipt = module.exports.main(); assert.equal(receipt.nativeSqliteVerified, true); assert.equal(receipt.filesHash, manifestFor(f.files).inputHash);
      assert.equal(receipt.artifactHash, hash(writes[0])); assert.deepEqual(events, ['guard', 'restore', 'native', 'query', 'close']);
    }
  }
});
