// Disposable real repositories only. New turns use Git, never native helpers/pins.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
function fixture(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-git-snapshot-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); fs.mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key];
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-q'); git(root, 'config', 'core.autocrlf', 'false');
  for (const [name, text] of Object.entries({ '.gitignore': 'ignored.txt\n', 'tracked.txt': 'base\n', 'deleted.txt': 'delete me\n', 'staged.txt': 'base\n' })) fs.writeFileSync(path.join(root, name), text);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'base');
  const project = { id: 'p', path: root };
  const service = createBadcaseCaptureService({ captureRoot: path.join(temp, 'capture'), agentDir: path.join(temp, 'agent'),
    getProject: id => id === 'p' ? project : null, ...options });
  const enable = () => service.store.savePolicy({ projectId: 'p', status: 'enabled', authorizedDirs: [root] });
  const room = id => { const dir = path.join(temp, id); git(root, 'worktree', 'add', '-qb', 'room/' + id, dir); return dir; };
  const capture = (targetDir = root, extra = {}) => service.captureTurnCheckpoint({ projectId: 'p', targetDir, conversationId: 'room', turnId: 'turn', agentId: 'agent',
    deliveryMode: 'fresh', prompt: 'question', runConfig: { provider: 'test', model: 'test', promptVersion: 'test' }, ...extra });
  return { temp, root, project, service, git, enable, room, capture };
}

test('project root, existing and new worktrees share one switch without native authorization or Room registration', async t => {
  const h = fixture(t), old = h.room('existing'); h.enable(); const saved = h.service.loadPolicy('p');
  for (const cwd of [h.root, old, h.room('new')]) {
    const before = h.git(cwd, 'status', '--porcelain=v1', '-uall');
    const result = await h.capture(cwd); assert.equal(result.captured, true, result.reason);
    const cp = h.service.store.loadCheckpoint('p', result.checkpointId);
    assert.equal(cp.schemaVersion, 2); assert.equal(cp.gitSnapshot.kind, 'git-snapshot-v1');
    assert.equal(cp.gitSnapshot.head, h.git(cwd, 'rev-parse', 'HEAD')); assert.equal(cp.targetDir, cwd);
    assert.equal(h.git(cwd, 'status', '--porcelain=v1', '-uall'), before);
    assert.deepEqual(h.service.loadPolicy('p'), saved, 'no per-room grant/pin writes');
  }
  h.service.savePolicy('p', { ...saved, status: 'disabled' });
  for (const cwd of [h.root, old]) assert.equal((await h.capture(cwd)).reason, 'policy_not_enabled');
});

test('unrelated repositories, non-Git paths and root subdirectories never publish snapshots', async t => {
  const h = fixture(t); h.enable();
  const other = path.join(h.temp, 'other'); h.git(h.temp, 'clone', '-q', '--no-local', h.root, other);
  const plain = path.join(h.temp, 'plain'), sub = path.join(h.root, 'sub'); fs.mkdirSync(plain); fs.mkdirSync(sub);
  for (const dir of [other, plain, sub]) {
    assert.equal((await h.capture(dir)).captured, false);
    assert.equal(h.service.store.loadLatestCheckpoint('p', dir), null);
  }
});

test('binary HEAD patch contains staged, unstaged and deleted changes; untracked bytes are CAS-only and deduplicated', async t => {
  const h = fixture(t); h.enable();
  fs.writeFileSync(path.join(h.root, 'tracked.txt'), Buffer.from([0, 1, 255, 4]));
  fs.writeFileSync(path.join(h.root, 'staged.txt'), 'staged\n'); h.git(h.root, 'add', 'staged.txt');
  fs.appendFileSync(path.join(h.root, 'staged.txt'), 'unstaged\n'); fs.unlinkSync(path.join(h.root, 'deleted.txt'));
  fs.writeFileSync(path.join(h.root, 'new.bin'), Buffer.from([0, 2, 254])); fs.writeFileSync(path.join(h.root, 'ignored.txt'), 'not included');
  fs.mkdirSync(path.join(h.root, 'node_modules')); fs.writeFileSync(path.join(h.root, 'node_modules', 'x'), 'not included');
  const before = h.git(h.root, 'status', '--porcelain=v1', '-uall'), index = fs.readFileSync(path.join(h.root, '.git', 'index'));
  const first = await h.capture(); assert.equal(first.captured, true, first.reason);
  const cp = first.checkpoint, patch = h.service.store.readBlob('p', cp.gitSnapshot.patchBlobHash);
  assert.match(patch.toString(), /GIT binary patch/); assert.match(patch.toString(), /\+staged/); assert.match(patch.toString(), /\+unstaged/);
  assert.deepEqual(cp.deletions, ['deleted.txt']); assert.deepEqual(Object.keys(cp.files), ['new.bin']);
  assert.deepEqual(h.service.store.readBlob('p', cp.files['new.bin'].hash), Buffer.from([0, 2, 254]));
  // Apply the recorded patch to an independent clone, not the captured source.
  const dest = path.join(h.temp, 'apply'); h.git(h.temp, 'clone', '-q', '--no-local', h.root, dest); h.git(dest, 'config', 'core.autocrlf', 'false');
  execFileSync('git', ['-C', dest, 'apply', '--binary', '-'], { input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.deepEqual(fs.readFileSync(path.join(dest, 'tracked.txt')), fs.readFileSync(path.join(h.root, 'tracked.txt')));
  assert.equal(fs.readFileSync(path.join(dest, 'staged.txt'), 'utf8'), 'staged\nunstaged\n'); assert.equal(fs.existsSync(path.join(dest, 'deleted.txt')), false);
  const second = await h.capture(); assert.equal(second.captured, true, second.reason); assert.equal(second.checkpoint.stats.newBlobBytes, 0);
  assert.equal(h.git(h.root, 'status', '--porcelain=v1', '-uall'), before); assert.deepEqual(fs.readFileSync(path.join(h.root, '.git', 'index')), index);
});

test('links, invalid Windows names and oversized untracked files are explicit gaps, not whole-capture failures', async t => {
  const h = fixture(t); h.enable();
  const outside = path.join(h.temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'hidden'), 'MUST_NOT_READ_TARGET');
  const link = path.join(h.root, 'junction'); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const names = ['NUL', 'nul.txt', 'tail.', 'tail '];
  try {
    for (const name of names) fs.writeFileSync(path.toNamespacedPath(path.join(h.root, name)), 'INVALID_NAME_MUST_NOT_BE_READ');
    fs.writeFileSync(path.join(h.root, 'large'), Buffer.alloc(10 * 1024 * 1024 + 1)); fs.writeFileSync(path.join(h.root, 'safe'), 'safe');
    const result = await h.capture(); assert.equal(result.captured, true, result.reason);
    assert.equal(result.checkpoint.stats.skippedCount, 6); assert.equal(result.checkpoint.replayInput.complete, false);
    for (const name of names) assert.ok(result.checkpoint.uncaptured.some(g => g.path === name && g.reason === 'windows_reserved_or_invalid_name'));
    assert.ok(result.checkpoint.uncaptured.some(g => g.path === 'junction' && g.reason === 'reparse_point_skipped'));
    assert.ok(result.checkpoint.uncaptured.some(g => g.path === 'large' && g.reason === 'file_size_limit'));
    assert.deepEqual(Object.keys(result.checkpoint.files), ['safe']);
    const { sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
    assert.equal(h.service.store.hasBlob('p', sha256Hex(Buffer.from('MUST_NOT_READ_TARGET'))), false);
  } finally {
    for (const name of names) { try { fs.unlinkSync(path.toNamespacedPath(path.join(h.root, name))); } catch {} }
  }
});

test('known-key literals alone are replaced, not token-like example text; project skill roots retain original paths and bytes', async t => {
  const known = 'local-known-value-12345', h = fixture(t, { getKnownKeyValues: () => [known] }); h.enable();
  const skills = path.join(h.root, '.agents', 'skills', 'local'); fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, 'SKILL.md'), '---\nname: local\ndescription: local\n---\nexample sk-FAKEabcdefgh and ' + known);
  fs.writeFileSync(path.join(skills, 'helper.txt'), 'resource');
  const cwd = h.room('skill-room');
  fs.writeFileSync(path.join(cwd, 'key.txt'), 'api_key=example-not-a-real-key ' + known);
  const result = await h.capture(cwd, { harness: { configSnapshot: { sdkStartConfig: { cwd, additionalSkillPaths: [skills] } } } });
  assert.equal(result.captured, true, result.reason);
  assert.equal(h.service.store.readBlob('p', result.checkpoint.files['key.txt'].hash).toString(), 'api_key=example-not-a-real-key [*]');
  const saved = result.checkpoint.gitSnapshot.projectSkills.find(s => s.originalPath === skills); assert.ok(saved);
  assert.deepEqual(Object.keys(saved.files).sort(), ['SKILL.md', 'helper.txt']);
  const skill = h.service.store.readBlob('p', saved.files['SKILL.md'].hash).toString(); assert.match(skill, /sk-FAKEabcdefgh/); assert.ok(!skill.includes(known));
  const { checkpointBlobHashes } = require('../../build/server/domain/runtime/badcase-capture/checkpoint-retention');
  const hashes = checkpointBlobHashes(result.checkpoint); assert.ok(hashes.includes(saved.files['SKILL.md'].hash));
  assert.ok(hashes.includes(result.checkpoint.gitSnapshot.patchBlobHash));
  const { createCheckpointRetentionStore } = require('../../build/server/domain/runtime/badcase-capture/checkpoint-retention');
  const retained = createCheckpointRetentionStore({ captureStore: h.service.store }).retain({ projectId: 'p', conversationId: 'room',
    turnId: 'turn', agentId: 'agent', checkpointId: result.checkpointId, referenceId: 'fixture' });
  assert.ok(retained.reference.blobHashes.includes(saved.files['SKILL.md'].hash), 'v2 skill resources survive retention');
});

test('untracked aggregate limit skips only excess files; unreadable entries do not lose safe siblings', async t => {
  const h = fixture(t);
  for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(h.root, name), '1234');
  const { collectGitSnapshot } = require('../../build/server/domain/runtime/badcase-capture/git-snapshot');
  const limited = await collectGitSnapshot({ targetDir: h.root, knownKeyValues: [], limits: { untrackedBytes: 8 } });
  assert.equal(limited.ok, true); assert.deepEqual(Object.keys(limited.files), ['a', 'b']);
  assert.deepEqual(limited.uncaptured, [{ path: 'c', reason: 'untracked_total_size_limit' }]);
  // Windows chmod cannot deny the owner. Inject only the fixture file's read
  // error; all repository/metadata reads still use real Git and filesystem IO.
  const original = fs.readFileSync;
  fs.readFileSync = function(filename, ...args) {
    if (String(filename) === path.join(h.root, 'b')) throw Object.assign(Error('fixture denied'), { code: 'EACCES' });
    return original.call(this, filename, ...args);
  };
  try {
    const partial = await collectGitSnapshot({ targetDir: h.root, knownKeyValues: [] });
    assert.equal(partial.ok, true); assert.deepEqual(Object.keys(partial.files), ['a', 'c']);
    assert.deepEqual(partial.uncaptured, [{ path: 'b', reason: 'file_unreadable' }]);
  } finally { fs.readFileSync = original; }
});

test('known keys in either side of a tracked diff use full sanitized overlays instead of a corrupted patch', async t => {
  const key = 'fixture-actual-value-45678', h = fixture(t, { getKnownKeyValues: () => [key] });
  fs.writeFileSync(path.join(h.root, 'tracked.txt'), 'base ' + key + '\n'); h.git(h.root, 'add', 'tracked.txt');
  h.git(h.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'key fixture'); h.enable();
  fs.writeFileSync(path.join(h.root, 'tracked.txt'), 'new ' + key + '\n');
  const result = await h.capture(); assert.equal(result.captured, true, result.reason);
  const cp = result.checkpoint;
  assert.equal(cp.files['tracked.txt'].origin, 'redacted-tracked');
  assert.equal(h.service.store.readBlob('p', cp.files['tracked.txt'].hash).toString(), 'new [*]\n');
  assert.equal(h.service.store.readBlob('p', cp.gitSnapshot.patchBlobHash).length, 0);
  assert.ok(!JSON.stringify(cp).includes(key));
});

test('detached HEAD works; repositories with no readable HEAD fail without blocking callers', async t => {
  const h = fixture(t); h.enable(); h.git(h.root, 'checkout', '--detach', '-q');
  const result = await h.capture(); assert.equal(result.captured, true, result.reason); assert.equal(result.checkpoint.gitSnapshot.branch, '');
  const empty = path.join(h.temp, 'empty'); fs.mkdirSync(empty); h.git(empty, 'init', '-q'); h.project.path = empty;
  const noHead = await h.capture(empty); assert.equal(noHead.captured, false); assert.equal(noHead.reason, 'head_unreadable');
});
