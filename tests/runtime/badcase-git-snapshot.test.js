// Disposable real repositories only. New turns use Git, never native helpers/pins.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
function fixture(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-git-snapshot-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = temp;
  t.after(() => { if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling; });
  const root = path.join(temp, 'repo'); fs.mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key];
  const gitBytes = (cwd, args, input) => execFileSync('git', ['-C', cwd, ...args], { env, input, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const git = (cwd, ...args) => gitBytes(cwd, args).toString('utf8').trim();
  git(root, 'init', '-q'); git(root, 'config', 'core.autocrlf', 'false');
  for (const [name, text] of Object.entries({ '.gitignore': 'ignored.txt\n', 'tracked.txt': 'base\n', 'deleted.txt': 'delete me\n', 'staged.txt': 'base\n' })) fs.writeFileSync(path.join(root, name), text);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'base');
  const project = { id: 'p', path: root };
  const service = createBadcaseCaptureService({ captureRoot: path.join(temp, 'capture'), agentDir: path.join(temp, 'agent'),
    getProject: id => id === 'p' ? project : null, ...options });
  const enable = () => service.store.savePolicy({ projectId: 'p', status: 'enabled', authorizedDirs: [root] });
  const room = (id, relative = id) => { const dir = path.join(temp, relative); git(root, 'worktree', 'add', '-qb', 'room/' + id, dir); return dir; };
  const capture = (targetDir = root, extra = {}) => service.captureTurnCheckpoint({ projectId: 'p', targetDir, conversationId: 'room', turnId: 'turn', agentId: 'agent',
    deliveryMode: 'fresh', prompt: 'question', runConfig: { provider: 'test', model: 'test', promptVersion: 'test' }, ...extra });
  return { temp, root, project, service, git, gitBytes, enable, room, capture };
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

test('new coverage is common-dir based even for a DAG-style worktree with no Room binding record', async t => {
  const h = fixture(t), cwd = h.room('dag-node', 'repo/.worktrees/dag/plan/node'); h.enable();
  const result = await h.capture(cwd); assert.equal(result.captured, true, result.reason);
  assert.equal(result.checkpoint.gitSnapshot.commonDir, path.join(h.root, '.git'));
  assert.equal(result.checkpoint.schemaVersion, 2);
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

for (const inventory of ['head', 'eol', 'changed', 'fallback', 'untracked']) {
  test(`invalid UTF-8 names in ${inventory} inventory are per-path gaps, never replacement-character aliases`, async t => {
    const h = fixture(t), { collectGitSnapshot, readSnapshotGit } = require('../../build/server/domain/runtime/badcase-capture/git-snapshot');
    const invalid = [0xff, 0xfe].map(byte => Buffer.concat([Buffer.from('alias-'), Buffer.from([byte]), Buffer.from('.txt')]));
    const valid = ['alias-\ufffd.txt', '\ufeffbom.txt', '中文.txt'];
    for (const name of valid) fs.writeFileSync(path.join(h.root, name), 'valid base\n');
    h.git(h.root, 'add', '.'); h.git(h.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'valid names');
    for (const name of [...valid, 'tracked.txt']) fs.writeFileSync(path.join(h.root, name), 'valid dirty\n');
    fs.writeFileSync(path.join(h.root, 'safe-new.txt'), 'safe sibling');
    const oid = h.git(h.root, 'rev-parse', 'HEAD:tracked.txt');
    const result = await collectGitSnapshot({ targetDir: h.root, knownKeyValues: [], projectSkillPaths: [], async readGit(cwd, args, budget) {
      if (inventory === 'fallback' && args.includes('--name-only')) throw Error('fixture fallback');
      const hit = inventory === 'head' ? args[0] === 'ls-tree' : inventory === 'eol' ? args.includes('--eol')
        : inventory === 'changed' ? args.includes('--name-only') : inventory === 'fallback' ? args.includes('--cached') : args.includes('--others');
      const bytes = await readSnapshotGit(cwd, args, budget);
      const prefix = inventory === 'head' ? `100644 blob ${oid}\t` : inventory === 'eol' ? 'i/lf    w/mixed attr/\t' : '';
      return hit ? Buffer.concat([bytes, ...invalid.map(name => Buffer.concat([Buffer.from(prefix), name, Buffer.from([0])]))]) : bytes;
    } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.uncaptured.filter(g => g.reason === 'invalid_utf8_name').map(g => g.path).sort(), invalid.map(name => 'invalid-utf8:' + name.toString('hex')).sort());
    assert.equal(result.uncaptured.length, 2, 'only raw invalid paths are gaps; valid U+FFFD/BOM/Unicode names remain supported');
    assert.equal(result.blobs.get(result.files['safe-new.txt'].hash).toString(), 'safe sibling');
    const patch = result.blobs.get(result.gitSnapshot.patchBlobHash), dest = path.join(h.temp, 'apply');
    h.git(h.temp, 'clone', '-q', '--no-local', h.root, dest);
    h.gitBytes(dest, ['apply', '--binary', '-'], patch);
    for (const name of valid) assert.equal(fs.readFileSync(path.join(dest, name), 'utf8'), 'valid dirty\n', name);
  });
}

test('raw non-UTF-8 repository filenames mark capture incomplete while preserving valid siblings', async t => {
  const h = fixture(t); h.enable();
  const names = ['clean', 'dirty', 'deleted', 'untracked'].map(prefix => Buffer.concat([Buffer.from(prefix + '-'), Buffer.from([0xff]), Buffer.from('.txt')]));
  const oid = h.git(h.root, 'rev-parse', 'HEAD:tracked.txt');
  const tree = h.gitBytes(h.root, ['mktree', '-z'], Buffer.concat([h.gitBytes(h.root, ['ls-tree', '-z', 'HEAD']),
    ...names.slice(0, 3).map(name => Buffer.concat([Buffer.from(`100644 blob ${oid}\t`), name, Buffer.from([0])]))])).toString().trim();
  const head = h.gitBytes(h.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit-tree', tree, '-p', 'HEAD'], Buffer.from('raw names\n')).toString().trim();
  h.git(h.root, 'update-ref', 'HEAD', head);
  if (process.platform !== 'win32') {
    // POSIX accepts Buffer paths verbatim. Exercise actual HEAD/dirty/delete/
    // untracked Git output, not a decoded string or a fabricated filename.
    h.git(h.root, 'read-tree', 'HEAD');
    for (const [i, name] of names.entries()) if (i !== 2) fs.writeFileSync(Buffer.concat([Buffer.from(h.root + '/'), name]), i === 0 ? 'base\n' : 'RAW_INVALID_NAME_CONTENT');
  } else t.diagnostic('Windows exercises raw HEAD tree objects; inventory byte seams cover names unavailable in its filesystem');
  fs.writeFileSync(path.join(h.root, 'valid-\ufffd.txt'), 'valid sibling');
  const before = h.gitBytes(h.root, ['status', '--porcelain=v1', '-z', '-uall']), index = fs.readFileSync(path.join(h.root, '.git/index'));
  const captured = await h.capture(); assert.equal(captured.captured, true, captured.reason);
  const cp = captured.checkpoint, expected = process.platform === 'win32' ? names.slice(0, 3) : names;
  assert.deepEqual(cp.uncaptured.map(g => [g.path, g.reason]).sort(), expected.map(name => ['invalid-utf8:' + name.toString('hex'), 'invalid_utf8_name']).sort());
  assert.equal(cp.stats.skippedCount, expected.length); assert.equal(cp.replayInput.complete, false);
  assert.ok(cp.replayInput.incompleteReasons.includes('files_uncaptured')); assert.deepEqual(cp.deletions, []);
  assert.deepEqual(Object.keys(cp.files), ['valid-\ufffd.txt']); assert.equal(cp.gitSnapshot.patchBytes, 0);
  assert.equal(h.service.store.readBlob('p', cp.files['valid-\ufffd.txt'].hash).toString(), 'valid sibling');
  assert.deepEqual(h.gitBytes(h.root, ['status', '--porcelain=v1', '-z', '-uall']), before);
  assert.deepEqual(fs.readFileSync(path.join(h.root, '.git/index')), index);
});

test('index assume-unchanged and skip-worktree flags are disclosed gaps, never silently restored as clean HEAD bytes', async t => {
  const h = fixture(t); h.enable();
  h.git(h.root, 'update-index', '--assume-unchanged', '--', 'tracked.txt');
  h.git(h.root, 'update-index', '--skip-worktree', '--', 'staged.txt');
  fs.writeFileSync(path.join(h.root, 'tracked.txt'), 'hidden dirty');
  fs.writeFileSync(path.join(h.root, 'staged.txt'), 'hidden sparse dirty');
  const index = fs.readFileSync(path.join(h.root, '.git/index'));
  const captured = await h.capture(); assert.equal(captured.captured, true);
  assert.deepEqual(captured.checkpoint.uncaptured.map(g => [g.path, g.reason]).sort(), [['staged.txt', 'index_skip_worktree'], ['tracked.txt', 'index_assume_unchanged']]);
  assert.ok(captured.checkpoint.replayInput.incompleteReasons.includes('files_uncaptured'));
  const restored = require('../../build/server/domain/runtime/badcase-capture/git-snapshot-materialization').materializeGitSnapshot({ checkpoint: captured.checkpoint, store: h.service.store, knownKeyValues: [] });
  assert.equal(restored.files['tracked.txt'], undefined); assert.equal(restored.files['staged.txt'], undefined);
  assert.ok(restored.files['deleted.txt']); assert.deepEqual(fs.readFileSync(path.join(h.root, '.git/index')), index);
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

test('latest result follows room checkpoints, survives restart and serves counters without reading snapshot blobs', async t => {
  const h = fixture(t); h.enable(); const cwd = h.room('metrics-room');
  fs.writeFileSync(path.join(cwd, 'safe.txt'), 'safe');
  fs.writeFileSync(path.toNamespacedPath(path.join(cwd, 'nul.txt')), 'skip');
  let result;
  try { result = await h.capture(cwd); }
  finally { fs.unlinkSync(path.toNamespacedPath(path.join(cwd, 'nul.txt'))); }
  assert.equal(result.captured, true, result.reason);
  const summary = h.service.latestCaptureMetrics('p');
  assert.ok(summary, 'project-root-only latest lookup loses room checkpoint results');
  assert.equal(summary.checkpointId, result.checkpointId); assert.equal(summary.targetDir, cwd);
  assert.equal(summary.captured, true); assert.equal(summary.status, 'partial'); assert.equal(summary.skippedCount, 1);
  assert.equal(summary.totalNewBytes, result.checkpoint.stats.totalNewBytes);
  const restarted = createBadcaseCaptureService({ captureRoot: h.service.captureRoot });
  restarted.store.readBlob = () => assert.fail('status reads must not read any blob');
  restarted.store.loadCheckpoint = () => assert.fail('persisted status is a small independent projection');
  assert.deepEqual(restarted.latestCaptureMetrics('p'), summary);
  assert.doesNotMatch(JSON.stringify(summary), /patchBlobHash|promptBlobHash|safe\.txt|"uncaptured"|"files"\s*:\s*\{/);
});

test('readable-HEAD failure is recorded, but disabled and out-of-scope invocations never replace the last real attempt', async t => {
  const h = fixture(t); h.enable(); const first = await h.capture();
  const summary = h.service.latestCaptureMetrics('p'); assert.equal(summary?.checkpointId, first.checkpointId);
  const other = path.join(h.temp, 'other'); h.git(h.temp, 'clone', '-q', '--no-local', h.root, other);
  const plain = path.join(h.temp, 'plain'), sub = path.join(h.root, 'sub'); fs.mkdirSync(plain); fs.mkdirSync(sub);
  for (const dir of [other, plain, sub]) { await h.capture(dir); assert.deepEqual(h.service.latestCaptureMetrics('p'), summary); }
  const branch = h.git(h.root, 'symbolic-ref', 'HEAD'); h.git(h.root, 'symbolic-ref', 'HEAD', 'refs/heads/absent');
  const result = await h.capture(); assert.equal(result.reason, 'head_unreadable');
  const failed = h.service.latestCaptureMetrics('p');
  assert.equal(failed.status, 'failed'); assert.equal(failed.captured, false); assert.equal(failed.reason, 'head_unreadable');
  assert.equal(failed.checkpointId, ''); assert.equal(failed.totalNewBytes, null);
  assert.equal(h.service.store.listCheckpoints('p').length, 1, 'failure is not a fabricated checkpoint');
  h.git(h.root, 'symbolic-ref', 'HEAD', branch);
  h.service.savePolicy('p', { ...h.service.loadPolicy('p'), status: 'disabled' }); await h.capture();
  assert.deepEqual(h.service.latestCaptureMetrics('p'), failed);
  h.enable(); const next = await h.capture(); assert.equal(h.service.latestCaptureMetrics('p').checkpointId, next.checkpointId);
});

test('status storage errors do not discard a published room checkpoint or expose private exception details', async t => {
  const h = fixture(t); h.enable(); const cwd = h.room('status-error-room');
  h.service.store.saveCaptureResult = () => { throw Error('PRIVATE_STATUS_WRITE_FAILURE'); };
  const result = await h.capture(cwd); assert.equal(result.captured, true, result.reason);
  assert.ok(h.service.store.loadCheckpoint('p', result.checkpointId));
  assert.equal(h.service.latestCaptureMetrics('p'), null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STATUS_WRITE_FAILURE/);
});

test('snapshot Git honors normal user ignore rules but cannot be redirected by inherited repository variables', async t => {
  const h = fixture(t, { getKnownKeyValues: () => [] }); h.enable();
  const other = path.join(h.temp, 'other'); h.git(h.temp, 'clone', '-q', '--no-local', h.root, other);
  const ignore = path.join(h.temp, 'global-ignore'), config = path.join(h.temp, 'global-config');
  fs.writeFileSync(ignore, 'global-only.txt\n');
  fs.writeFileSync(config, '[core]\nexcludesFile = ' + ignore.replaceAll('\\', '/') + '\n');
  fs.writeFileSync(path.join(h.root, 'global-only.txt'), 'ignored by Git'); fs.writeFileSync(path.join(h.root, 'ordinary.txt'), 'ordinary');
  const index = fs.readFileSync(path.join(h.root, '.git', 'index'));
  const updates = { GIT_DIR: path.join(other, '.git'), GIT_COMMON_DIR: path.join(other, '.git'), GIT_WORK_TREE: other,
    GIT_INDEX_FILE: path.join(h.temp, 'absent-index'), GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
  const previous = Object.fromEntries(Object.keys(updates).map(k => [k, process.env[k]]));
  Object.assign(process.env, updates);
  try {
    const before = JSON.stringify(process.env), result = await h.capture(); assert.equal(result.captured, true, result.reason);
    assert.deepEqual(Object.keys(result.checkpoint.files), ['ordinary.txt']);
    assert.equal(result.checkpoint.gitSnapshot.sourceRepository, h.root);
    assert.equal(JSON.stringify(process.env), before, 'only Git child environments change');
    assert.deepEqual(fs.readFileSync(path.join(h.root, '.git', 'index')), index);
    assert.equal(fs.existsSync(updates.GIT_INDEX_FILE), false);
    assert.equal(fs.readFileSync(ignore, 'utf8'), 'global-only.txt\n');
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('parallel project turns each publish a checkpoint instead of failing busy during read-only Git work', async t => {
  const h = fixture(t); h.enable(); const cwd = h.room('parallel-room');
  const results = await Promise.all([h.capture(h.root, { turnId: 'one' }), h.capture(cwd, { turnId: 'two' }), h.capture(cwd, { turnId: 'three' })]);
  assert.deepEqual(results.map(r => r.captured), [true, true, true], results.map(r => r.reason).join(','));
  assert.equal(new Set(results.map(r => r.checkpointId)).size, 3);
  assert.equal(h.service.store.listCheckpoints('p').length, 3);
  assert.equal(fs.existsSync(path.join(h.service.captureRoot, 'projects', 'p', '.writer-lock')), false);
});

test('disable while Git snapshot is reading succeeds immediately and prevents checkpoint publication', async t => {
  const h = fixture(t); h.enable(); const filename = path.join(h.root, 'pause-point'); fs.writeFileSync(filename, 'fixture');
  const original = fs.readFileSync; let disabled = false;
  fs.readFileSync = function(file, ...args) {
    if (String(file) === filename && !disabled) {
      h.service.savePolicy('p', { ...h.service.loadPolicy('p'), status: 'disabled' }); disabled = true;
    }
    return original.call(this, file, ...args);
  };
  let result; try { result = await h.capture(); } finally { fs.readFileSync = original; }
  assert.equal(disabled, true, 'a long read-only phase must not lock out the project switch');
  assert.equal(result.captured, false); assert.equal(result.reason, 'policy_not_enabled');
  assert.equal(h.service.store.listCheckpoints('p').length, 0); assert.equal(h.service.computeUsage('p').blobCount, 0);
});

test('one 15-second budget stops file scanning, publishes a partial checkpoint and releases the caller', async t => {
  let now = 0;
  const h = fixture(t, { captureNow: () => now }); h.enable();
  for (const name of ['a-safe.txt', 'b-slow.txt', 'c-not-read.txt']) fs.writeFileSync(path.join(h.root, name), name);
  const session = path.join(h.temp, 'do-not-read-session.jsonl'); fs.writeFileSync(session, 'not read');
  const read = fs.readFileSync, reads = []; let sessionReads = 0;
  fs.readFileSync = function(filename, ...args) {
    if (String(filename) === session) sessionReads++;
    if (path.dirname(String(filename)) === h.root) reads.push(path.basename(String(filename)));
    const bytes = read.call(this, filename, ...args);
    if (String(filename) === path.join(h.root, 'b-slow.txt')) now += 16000;
    return bytes;
  };
  let result; try { result = await h.capture(h.root, { deliveryMode: 'resume', sessionPath: session }); } finally { fs.readFileSync = read; }
  assert.equal(result.captured, true, result.reason);
  assert.ok(result.checkpoint.uncaptured.some(g => g.reason === 'capture_time_limit'));
  assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('capture_time_limit'));
  assert.equal(result.checkpoint.replayInput.complete, false);
  assert.ok(!reads.includes('c-not-read.txt'), 'no more source reads once the shared budget is exhausted');
  assert.equal(sessionReads, 0, 'do not start session IO after the capture budget expires');
  assert.deepEqual(Object.keys(result.checkpoint.files), ['a-safe.txt'], 'keep the already-archived prefix');
  assert.equal(h.service.store.readBlob('p', result.checkpoint.files['a-safe.txt'].hash).toString(), 'a-safe.txt');
  assert.equal(h.service.latestCaptureMetrics('p').status, 'partial');
  assert.equal(h.service.loadPolicy('p').status, 'enabled', 'timeout is not a suspension');
});

test('failed name-only diff fallback stops its per-file Git work at the overall budget, not at N command timeouts', async t => {
  const h = fixture(t), { collectGitSnapshot, readSnapshotGit } = require('../../build/server/domain/runtime/badcase-capture/git-snapshot');
  let now = 0; const calls = [];
  const result = await collectGitSnapshot({ targetDir: h.root, knownKeyValues: ['nonmatching-fixture-value'], captureNow: () => now,
    readGit: async (cwd, args, budget) => {
      calls.push(args);
      if (args.includes('--name-only')) throw Error('fixture name-only failure');
      if (args[0] === 'show') now += 8000;
      return readSnapshotGit(cwd, args, budget);
    } });
  assert.equal(result.ok, true);
  assert.ok(calls.some(args => args.includes('--cached')), 'exercise the expensive fallback');
  assert.equal(calls.filter(args => args[0] === 'show').length, 2, 'stop the fallback before all tracked paths');
  assert.ok(result.uncaptured.some(g => g.reason === 'capture_time_limit'));
  assert.ok(!calls.some(args => args.includes('--others')), 'do not start a new phase after timeout');
});

test('timeout before repository/HEAD is known records failure without inventing a restorable checkpoint', async t => {
  const h = fixture(t, { captureTimeLimitMs: 0 }); h.enable();
  const result = await h.capture();
  assert.equal(result.captured, false); assert.equal(result.reason, 'capture_time_limit');
  assert.equal(h.service.store.listCheckpoints('p').length, 0);
  assert.equal(h.service.latestCaptureMetrics('p').reason, 'capture_time_limit');
  assert.equal(h.service.loadPolicy('p').status, 'enabled');
  const { collectGitSnapshot } = require('../../build/server/domain/runtime/badcase-capture/git-snapshot');
  assert.deepEqual(await collectGitSnapshot({ targetDir: h.root, captureTimeLimitMs: 0 }), { ok: false, reason: 'capture_time_limit' });
});

test('an in-flight Git process gets only the remaining time and its timeout cannot become a fallback scan', async () => {
  const childProcess = require('node:child_process'), { promisify } = require('node:util');
  const filename = require.resolve('../../build/server/domain/runtime/badcase-capture/git-snapshot');
  const cached = require.cache[filename], exec = childProcess.execFile;
  const { createCaptureTimeBudget } = require('../../build/server/domain/runtime/badcase-capture/capture-time-budget');
  let now = 0, calls = 0;
  const budget = createCaptureTimeBudget({ captureNow: () => now }); now = 14000;
  const fake = () => assert.fail('use promisified execution');
  fake[promisify.custom] = async (_file, _args, options) => {
    calls++; assert.equal(options.timeout, 1000, 'not another 15/25 seconds per child');
    throw Object.assign(Error('fixture timeout'), { killed: true, signal: 'SIGTERM' });
  };
  try {
    childProcess.execFile = fake; delete require.cache[filename];
    const { readSnapshotGit } = require(filename);
    await assert.rejects(readSnapshotGit('.', ['diff'], budget), { code: 'capture_time_limit' });
    assert.equal(budget.remainingMs(), 0);
    await assert.rejects(readSnapshotGit('.', ['ls-files', '--cached'], budget), { code: 'capture_time_limit' });
    assert.equal(calls, 1, 'expired capture must not launch another Git command');
  } finally { childProcess.execFile = exec; require.cache[filename] = cached; }
});

test('snapshot Git never executes a configured fsmonitor hook', async t => {
  const h = fixture(t); h.enable();
  const marker = path.join(h.temp, 'fsmonitor-ran'), hook = path.join(h.root, '.git', 'fixture-fsmonitor');
  fs.writeFileSync(hook, '#!/bin/sh\nprintf ran > "' + marker.replaceAll('\\', '/') + '"\nprintf "fixture-token\\0/\\0"\n', { mode: 0o755 });
  h.git(h.root, 'config', 'core.fsmonitor', hook.replaceAll('\\', '/'));
  h.git(h.root, 'status', '--porcelain');
  assert.equal(fs.existsSync(marker), true, 'positive control: Git really executes this fixture hook');
  fs.unlinkSync(marker);
  const index = fs.readFileSync(path.join(h.root, '.git', 'index'));
  const result = await h.capture(); assert.equal(result.captured, true, result.reason);
  assert.equal(fs.existsSync(marker), false, 'read-only capture must disable executable fsmonitor');
  assert.deepEqual(fs.readFileSync(path.join(h.root, '.git', 'index')), index);
});

test('snapshot Git overrides ambient lazy fetching for every child without changing the parent environment', async () => {
  const childProcess = require('node:child_process'), { promisify } = require('node:util');
  const filename = require.resolve('../../build/server/domain/runtime/badcase-capture/git-snapshot');
  const cached = require.cache[filename], original = childProcess.execFile, previous = process.env.GIT_NO_LAZY_FETCH;
  const calls = [], fake = () => assert.fail('use promisified execution');
  fake[promisify.custom] = async (_file, args, options) => { calls.push({ args, env: options.env }); return { stdout: Buffer.from('inert') }; };
  try {
    process.env.GIT_NO_LAZY_FETCH = '0'; childProcess.execFile = fake; delete require.cache[filename];
    const { readSnapshotGit } = require(filename);
    for (const args of [['rev-parse', 'HEAD'], ['show', 'HEAD:missing.txt'], ['diff', '--binary', 'HEAD']]) await readSnapshotGit('.', args);
    assert.equal(calls.length, 3);
    for (const call of calls) assert.equal(call.env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(process.env.GIT_NO_LAZY_FETCH, '0');
  } finally {
    childProcess.execFile = original; require.cache[filename] = cached;
    if (previous === undefined) delete process.env.GIT_NO_LAZY_FETCH; else process.env.GIT_NO_LAZY_FETCH = previous;
  }
});

test('a missing tracked Git object is a per-file gap, not a failed capture or lost safe sibling', async t => {
  const h = fixture(t), { collectGitSnapshot, readSnapshotGit } = require('../../build/server/domain/runtime/badcase-capture/git-snapshot');
  fs.writeFileSync(path.join(h.root, 'tracked.txt'), 'dirty\n'); fs.writeFileSync(path.join(h.root, 'safe-new'), 'safe');
  const result = await collectGitSnapshot({ targetDir: h.root, knownKeyValues: [], projectSkillPaths: [], readGit(cwd, args, budget) {
    if (args.includes('--binary')) throw Error('fixture missing object');
    return readSnapshotGit(cwd, args, budget);
  } });
  assert.equal(result.ok, true); assert.deepEqual(result.uncaptured, [{ path: 'tracked.txt', reason: 'git_diff_unavailable' }]);
  assert.equal(result.blobs.get(result.files['safe-new'].hash).toString(), 'safe');
});

for (const kind of ['outside', 'sibling-prefix', 'file-link', 'directory-link', 'internal-directory-link', 'root-link']) {
  test(`resume session refuses ${kind} without reading or archiving its bytes`, async t => {
    const h = fixture(t); h.enable();
    const agent = path.join(h.temp, 'agent'), sessions = path.join(agent, 'named-sessions'); fs.mkdirSync(sessions, { recursive: true });
    const text = [{ type: 'session', version: 3, id: 'fixture-session', cwd: h.root },
      { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'OUTSIDE_SESSION_BYTES', timestamp: 1 } }].map(v => JSON.stringify(v)).join('\n') + '\n';
    const outside = path.join(h.temp, 'other-sessions'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'turn.jsonl'), text);
    let session = path.join(outside, 'turn.jsonl'), simulatedLink = false;
    if (kind === 'sibling-prefix') { fs.mkdirSync(sessions + '-other'); session = path.join(sessions + '-other', 'turn.jsonl'); fs.writeFileSync(session, text); }
    if (kind === 'file-link') {
      session = path.join(sessions, 'linked.jsonl');
      try { fs.symlinkSync(path.join(outside, 'turn.jsonl'), session, 'file'); }
      catch (e) { if (process.platform !== 'win32' || e.code !== 'EPERM') throw e; simulatedLink = true; fs.writeFileSync(session, text); t.diagnostic('Windows file-link metadata seam; native directory junction cases still run'); }
    }
    if (kind === 'directory-link' || kind === 'internal-directory-link') {
      let destination = outside;
      if (kind === 'internal-directory-link') { destination = path.join(sessions, 'real'); fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'turn.jsonl'), text); }
      fs.symlinkSync(destination, path.join(sessions, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); session = path.join(sessions, 'alias/turn.jsonl');
    }
    if (kind === 'root-link') { fs.rmdirSync(sessions); fs.symlinkSync(outside, sessions, process.platform === 'win32' ? 'junction' : 'dir'); session = path.join(sessions, 'turn.jsonl'); }
    const read = fs.readFileSync, lstat = fs.lstatSync; let reads = 0;
    fs.readFileSync = function(file, ...args) { if (String(file) === session) reads++; return read.call(this, file, ...args); };
    if (simulatedLink) fs.lstatSync = function(file, ...args) { const stat = lstat.call(this, file, ...args); if (String(file) === session) stat.isSymbolicLink = () => true; return stat; };
    let result;
    try { result = await h.capture(h.root, { deliveryMode: 'resume', sessionPath: session }); }
    finally { fs.readFileSync = read; fs.lstatSync = lstat; }
    assert.equal(result.captured, true, result.reason); assert.equal(result.checkpoint.replayInput.sessionBlobHash, '');
    assert.ok(result.checkpoint.replayInput.incompleteReasons.includes('session_outside_named_sessions'));
    assert.equal(result.checkpoint.replayInput.complete, false); assert.equal(reads, 0);
    const digest = require('node:crypto').createHash('sha256').update(text).digest('hex'); assert.equal(h.service.store.hasBlob('p', digest), false);
  });
}

test('resume accepts an ordinary in-root named session and archives its exact bytes', async t => {
  const h = fixture(t); h.enable(); const sessions = path.join(h.temp, 'agent/named-sessions'); fs.mkdirSync(sessions, { recursive: true });
  const session = path.join(sessions, 'turn.jsonl'), text = [{ type: 'session', version: 3, id: 'ordinary', cwd: h.root },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'ordinary history', timestamp: 1 } }].map(v => JSON.stringify(v)).join('\n') + '\n'; fs.writeFileSync(session, text);
  const result = await h.capture(h.root, { deliveryMode: 'resume', sessionPath: session }); assert.equal(result.captured, true, result.reason);
  assert.ok(result.checkpoint.replayInput.sessionBlobHash); assert.deepEqual(h.service.store.readBlob('p', result.checkpoint.replayInput.sessionBlobHash), Buffer.from(text));
});

test('detached HEAD works; repositories with no readable HEAD fail without blocking callers', async t => {
  const h = fixture(t); h.enable(); h.git(h.root, 'checkout', '--detach', '-q');
  const result = await h.capture(); assert.equal(result.captured, true, result.reason); assert.equal(result.checkpoint.gitSnapshot.branch, '');
  const empty = path.join(h.temp, 'empty'); fs.mkdirSync(empty); h.git(empty, 'init', '-q'); h.project.path = empty;
  const noHead = await h.capture(empty); assert.equal(noHead.captured, false); assert.equal(noHead.reason, 'head_unreadable');
});
