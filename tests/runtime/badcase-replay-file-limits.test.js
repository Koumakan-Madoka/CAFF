// Inert inputs and disposable repositories only: no Docker, SDK, model or live data.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const { prepareDirectReplayInput } = require('../../scripts/badcase-capture/direct-docker.cjs');
const { dependencyRecipe } = require('../../scripts/badcase-capture/replay-dependencies.cjs');
const { prepareReplayGit } = require('../../scripts/badcase-capture/replay-git.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const image = { imageId: 'sha256:' + '1'.repeat(64), nodeVersion: process.version, architecture: 'amd64' };
const record = (name, text = 'x') => ({ path: name, base64: Buffer.from(text).toString('base64'), sha256: hash(text), mode: 0o100644 });
function input(count) {
  const pkg = { name: 'inert-file-limit', version: '1.0.0' };
  const files = [record('package.json', JSON.stringify(pkg)), record('package-lock.json', JSON.stringify({
    name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg },
  }))];
  while (files.length < count) files.push(record('src/file-' + files.length + '.txt'));
  return { kind: 'prepared-caff-turn-v1', prompt: 'Not executed.', files, deletions: [], sessionText: null, settings: null, systemPrompt: null, callback: null };
}
function loadVm(name, extra) {
  const module = { exports: {} };
  const context = { module, Buffer, require, process, ...extra };
  vm.runInNewContext(fs.readFileSync(path.resolve('scripts/badcase-capture', name), 'utf8'), context, { filename: name });
  return module.exports;
}
const linux = env => ({ platform: 'linux', getuid: () => 65534, cwd: () => '/work', version: process.version, arch: 'x64', env });

for (const count of [1115, 8192, 8193]) {
  test(`direct host staging file limit: ${count}`, () => {
    const prepared = input(count);
    if (count > 8192) assert.throws(() => prepareDirectReplayInput(prepared));
    else {
      const staged = prepareDirectReplayInput(prepared), wire = JSON.parse(staged.find(f => f.path === 'replay-input.json').bytes);
      assert.equal(wire.files.length, count); assert.equal(wire.workspace, 'replay-workspace');
      assert.equal(staged.filter(f => f.path.startsWith('replay-workspace/')).length, count);
      assert.equal(wire.files[0].base64, undefined);
    }
  });
  test(`direct container file guard (inert VM, stops before restoration): ${count}`, async () => {
    const prepared = input(count), reachedRestoration = Error('inert-restore-marker'); let restoreStarted = false;
    const worker = loadVm('direct-sdk-container.cjs', {
      process: linux({ CAFF_BADCASE_MODEL_KEY: 'inert' }),
      require(name) {
        if (name === 'node:fs') return { existsSync: () => true,
          readFileSync: p => JSON.stringify(p.endsWith('evaluation-profile.json') ? 'inert' : prepared),
          mkdirSync() { restoreStarted = true; throw reachedRestoration; } };
        if (name === '/work/direct-model.cjs') return { KEY_ENV: 'CAFF_BADCASE_MODEL_KEY', validKey: v => v, modelProfile: () => ({}) };
        if (name === '/work/caff-runtime-bootstrap.cjs') return { verifyCaffRuntimeStage: () => ({ manifest: {} }) };
        return require(name);
      },
    });
    await assert.rejects(worker.main(), count <= 8192 ? e => e === reachedRestoration : e => e.code === 'ERR_ASSERTION');
    assert.equal(restoreStarted, count <= 8192);
  });
  test(`dependency recipe file limit: ${count}`, () => {
    const prepared = input(count), baseline = dependencyRecipe(input(2), image);
    if (count > 8192) assert.throws(() => dependencyRecipe(prepared, image), /evaluation_dependencies_unsupported/);
    else assert.equal(dependencyRecipe(prepared, image).cacheKey, baseline.cacheKey, 'unrelated source count does not alter two-file cache identity');
  });
}

function gitFixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-file-limits-')), sourceRoot = path.join(temp, 'source');
  fs.mkdirSync(sourceRoot); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0' });
  const git = (...args) => execFileSync('git', ['-C', sourceRoot, ...args], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), 'BASELINE_FIXTURE_VALUE'); git('add', '.');
  git('-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'inert baseline');
  return { sourceRoot, git, head: git('rev-parse', 'HEAD') };
}
for (const fallback of [false, true]) test(`Git recipe admits 1115/8192 and rejects 8193 (${fallback ? 'sanitized fallback' : 'preserved history'})`, t => {
  const f = gitFixture(t), recipe = { sourceRoot: f.sourceRoot, head: f.head };
  const before = { status: f.git('status', '--porcelain=v1'), index: fs.readFileSync(path.join(f.sourceRoot, '.git/index')),
    config: fs.readFileSync(path.join(f.sourceRoot, '.git/config')) };
  for (const count of [1115, 8192, 8193]) {
    const work = () => prepareReplayGit(recipe, input(count), { knownValues: fallback ? ['BASELINE_FIXTURE_VALUE'] : [] });
    if (count > 8192) assert.throws(work, /evaluation_repository_unavailable_or_invalid/);
    else {
      const result = work(); assert.equal(result.report.historyIncluded, !fallback);
      assert.equal(result.report.headIdenticalToSource, !fallback); assert.ok(result.gitFiles.length >= 5 && result.gitFiles.length <= 45);
    }
  }
  assert.equal(f.git('rev-parse', 'HEAD'), f.head); assert.equal(f.git('status', '--porcelain=v1'), before.status);
  assert.deepEqual(fs.readFileSync(path.join(f.sourceRoot, '.git/index')), before.index);
  assert.deepEqual(fs.readFileSync(path.join(f.sourceRoot, '.git/config')), before.config);
});

test('sanitized fallback baseline supports 8192 actual tracked paths, not the old 1024+2048 row ceiling', t => {
  const f = gitFixture(t), prepared = input(8192);
  for (const file of prepared.files) {
    const dest = path.join(f.sourceRoot, file.path); fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (file.path !== 'package.json') fs.writeFileSync(dest, Buffer.from(file.base64, 'base64'));
  }
  f.git('add', '-A'); f.git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'large inert baseline');
  const head = f.git('rev-parse', 'HEAD'), cached = new Map();
  // Real Git/trees/index/pack and real files; memoize identical cat-file reads
  // only in this test so 8190 identical blobs do not start 8190 subprocesses.
  const api = loadVm('replay-git.cjs', { require(name) {
    if (name === 'node:child_process') return { execFileSync(program, args, options) {
      const i = args.indexOf('cat-file');
      if (i >= 0 && args[i + 1] === 'blob') {
        const oid = args[i + 2]; if (!cached.has(oid)) cached.set(oid, execFileSync(program, args, options)); return cached.get(oid);
      }
      return execFileSync(program, args, options);
    } };
    return name.startsWith('./') ? require(path.resolve('scripts/badcase-capture', name)) : require(name);
  } });
  const snapshot = api.prepareReplayGit({ sourceRoot: f.sourceRoot, head }, prepared, { knownValues: ['BASELINE_FIXTURE_VALUE'] });
  assert.equal(snapshot.report.kind, 'sanitized-root-git-v1'); assert.equal(snapshot.report.baselineFileCount, 8192);
  assert.equal(cached.size, 3); assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(f.git('status', '--porcelain=v1'), '');
});

// The directory transport also carries <=45 Git metadata files and one npm
// archive. Its total guard must not retain the old 1024+46 hidden ceiling.
function staged(count, staticCount = 1) {
  return [...Array.from({ length: count }, (_, i) => ({ path: 'replay-workspace/src/' + i, bytes: Buffer.from('x') })),
    ...Array.from({ length: 45 }, (_, i) => ({ path: 'replay-workspace/.git/meta-' + i, bytes: Buffer.from('x') })),
    { path: 'replay-dependencies.tar.gz', bytes: Buffer.from('x') },
    ...Array.from({ length: staticCount }, (_, i) => ({ path: 'static-' + i, bytes: Buffer.from('x') }))];
}
function stageVm(files, overrides = {}) {
  const rows = files.map(f => ({ path: f.path, size: f.bytes.length, sha256: hash(f.bytes) })).sort((a, b) => a.path < b.path ? -1 : 1);
  const m = { schemaVersion: 1, files: rows, inputHash: hash(JSON.stringify(rows)), runtimeHash: hash('[]') };
  const byName = new Map(files.map(f => ['/work/' + f.path, f.bytes])); let reads = 0;
  const guard = loadVm('caff-runtime-container.cjs', { process: linux({}), require(name) {
    if (name !== 'node:fs') return require(name);
    return { existsSync: () => true,
      readFileSync: p => p === 'manifest.json' ? JSON.stringify(m) : p === 'environment.json' ? JSON.stringify(image) : 'fresh',
      lstatSync: p => ({ size: byName.get(p).length, isFile: () => true, isSymbolicLink: () => false }),
      openSync: p => ({ bytes: byName.get(p), read: false }), closeSync() {},
      readSync(fd, buffer) { if (fd.read) return 0; fd.read = true; reads++; fd.bytes.copy(buffer); return fd.bytes.length; }, ...overrides };
  } });
  return { verify: () => guard.verifyCaffRuntimeStage({ replayWorkspace: true }), reads: () => reads };
}
for (const count of [1115, 8192, 8193]) {
  test(`host transport ceiling includes 45 Git files + dependency archive: ${count}`, () => {
    const files = staged(count, 4096);
    if (count > 8192) assert.throws(() => manifestFor(files, { replayWorkspace: true }), /probe_dependency_size/);
    else assert.equal(manifestFor(files, { replayWorkspace: true }).files.length, count + 46 + 4096);
  });
  test(`container immutable-stage ceiling includes 45 Git files + dependency archive: ${count}`, () => {
    const files = staged(count, 4096), worker = stageVm(files);
    if (count > 8192) assert.throws(worker.verify);
    else { assert.equal(worker.verify().manifest.files.length, count + 46 + 4096); assert.equal(worker.reads(), files.length); }
  });
}
test('larger workspace count leaves the static 4096-file and 16-MiB byte budgets unchanged', () => {
  const tooMany = staged(1, 4097);
  assert.throws(() => manifestFor(tooMany, { replayWorkspace: true }), /probe_dependency_size/);
  assert.throws(stageVm(tooMany).verify);
  const files = [{ path: 'static-runtime', bytes: Buffer.alloc(16 * 1024 * 1024) }];
  assert.equal(manifestFor(files).files.length, 1);
  files.push({ path: 'overflow', bytes: Buffer.from('x') });
  assert.throws(() => manifestFor(files, { replayWorkspace: true }), /probe_dependency_size/);
  const worker = stageVm([{ path: 'static-runtime', bytes: Buffer.from('x') }], {
    lstatSync: () => ({ size: 16 * 1024 * 1024 + 1, isFile: () => true, isSymbolicLink: () => false }),
  });
  assert.throws(worker.verify); assert.equal(worker.reads(), 0, 'over-budget static input rejected before content read');
});
