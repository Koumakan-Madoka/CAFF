const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { prepareDirectReplayInput } = require('../../scripts/badcase-capture/direct-docker.cjs');
const { dependencyRecipe } = require('../../scripts/badcase-capture/replay-dependencies.cjs');
const { prepareReplayGit } = require('../../scripts/badcase-capture/replay-git.cjs');
const restoreVm = require('../helpers/badcase-direct-restore-vm.cjs');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const record = (name, text = 'safe') => ({ path: name, base64: Buffer.from(text).toString('base64'), sha256: hash(text) });
const input = files => ({ kind: 'prepared-caff-turn-v1', files, deletions: [], prompt: 'inert', sessionText: null, callback: null, settings: null, systemPrompt: null });
const image = { imageId: 'sha256:' + '1'.repeat(64), nodeVersion: 'v24.21.0', architecture: 'amd64' };
const packageFiles = [record('package.json', '{"name":"paths","version":"1.0.0"}'), record('package-lock.json', '{"name":"paths","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"paths","version":"1.0.0"}}}')];
const good = ['资料目录/HEAD 中文 空格.txt', ' new leading.txt', 'emoji-😀/é́.txt', 'at@name/plus+hash#quote\'.txt', '\ufeffbom/valid-\ufffd.txt'];
const bad = ['', '/', '/tmp/x', 'C:/x', 'C:x', 'a\\b', '//host/x', 'a//b', './a', 'a/./b', '../a', 'a/../b', 'a/', '.git/config', 'a/.GIT/config', 'node_modules/a', 'a/node_modules/b', 'a\0b', 'a\nb', 'a\tb', 'a\x7fb', 'a\x85b', 'nul', 'dir/COM1.txt', 'a/LPT9', 'con.txt', 'aux/x', 'a/CONIN$', 'tail.', 'tail ', 'a./x', 'a /x', 'a:b', 'a?b', 'a*b', 'a<b', 'a>b', 'a|b', 'a"b', 'unpaired-\ud800'];
test('one shared grammar keeps data and distribution namespaces separate without normalizing names', () => {
  const policy = require('../../scripts/badcase-capture/replay-path.cjs');
  assert.equal(policy.isSafeRelativePath, require('../../build/server/domain/runtime/badcase-capture/replay-path').isSafeRelativePath);
  for (const name of good) assert.equal(policy.isSafeRelativePath(name), true, name);
  for (const name of bad) assert.equal(policy.isSafeRelativePath(name), false, JSON.stringify(name));
  for (const name of ['runtime/node_modules/pkg/中文 空格.txt', 'replay-workspace/.git/config']) {
    assert.equal(policy.isSafeRelativePath(name), false); assert.equal(policy.isSafeDistributionPath(name), true);
  }
  for (const name of ['../x', '/x', 'x//y', 'x/../y', 'x\\\\y', 'x/NUL', 'x/tail.']) assert.equal(policy.isSafeDistributionPath(name), false, name);
});
test('host staging and actual container restore code accept Unicode and spaces without changing names', async t => {
  const prepared = input(good.map(name => record(name, 'bytes ' + name)));
  const stage = prepareDirectReplayInput(prepared);
  for (const name of good) assert.equal(stage.find(f => f.path === 'replay-workspace/' + name).bytes.toString(), 'bytes ' + name);
  const vm = await restoreVm(t, prepared); await assert.rejects(vm.run(), e => e === vm.marker); assert.equal(vm.boundary(), true);
  for (const name of good) assert.equal(vm.file(name).toString(), 'bytes ' + name);
});
test('all dangerous relative paths remain rejected on both host and container before file writes', async t => {
  for (const name of bad) {
    const prepared = input([record(name)]); assert.throws(() => prepareDirectReplayInput(prepared), undefined, JSON.stringify(name));
    const vm = await restoreVm(t, prepared); await assert.rejects(vm.run(), e => e.code === 'ERR_ASSERTION', JSON.stringify(name));
    assert.equal(vm.boundary(), false); assert.deepEqual(vm.writes, []);
  }
});
test('dependency recipe permits unrelated Unicode/space paths but retains package-name policy and cache identity', () => {
  const baseline = dependencyRecipe(input(packageFiles), image);
  assert.equal(dependencyRecipe(input([...packageFiles, ...good.map(p => record(p))]), image).cacheKey, baseline.cacheKey);
  for (const name of [...bad, '.npmrc', '目录/yarn.lock', '目录/pnpm-lock.yaml', '目录/npm-shrinkwrap.json']) {
    assert.throws(() => dependencyRecipe(input([...packageFiles, record(name)]), image), /evaluation_dependencies_unsupported/, JSON.stringify(name));
  }
});
for (const fallback of [false, true]) test(`Git preparation/writing handles Unicode names (${fallback ? 'sanitized' : 'preserved'})`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-replay-path-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-q'); git(root, 'config', 'core.autocrlf', 'false');
  for (const name of good) { const dest = path.join(root, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'BASE_KNOWN_LITERAL'); }
  git(root, 'add', '.'); git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), 'commit', '-qm', 'Unicode paths');
  const head = git(root, 'rev-parse', 'HEAD'), before = fs.readFileSync(path.join(root, '.git/index'));
  const prepared = input(good.map(name => record(name, 'captured'))), result = prepareReplayGit({ sourceRoot: root, head }, prepared, { knownValues: fallback ? ['BASE_KNOWN_LITERAL'] : [] });
  assert.equal(result.report.historyIncluded, !fallback); assert.equal(result.report.baselineFileCount, good.length);
  const dest = fs.mkdtempSync(path.join(root, 'detached-'));
  for (const file of result.gitFiles) { const target = path.join(dest, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, Buffer.from(file.base64, 'base64')); }
  const listing = execFileSync('git', ['-C', dest, 'ls-tree', '-rz', '--name-only', 'HEAD'], { env }).toString('utf8').split('\0').filter(Boolean);
  assert.deepEqual(listing.sort(), [...good].sort());
  for (const name of good) assert.equal(git(dest, 'show', 'HEAD:' + name), fallback ? '[*]' : 'BASE_KNOWN_LITERAL');
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), before);
});
