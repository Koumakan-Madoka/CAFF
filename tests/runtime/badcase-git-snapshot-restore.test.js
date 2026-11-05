// Real temporary Git repositories only; never live worktrees, SDKs or models.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t, extra = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-restore-')), root = path.join(temp, 'repo');
  fs.mkdirSync(root); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0' });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => { git(root, 'add', '-A'); git(root, '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'fixture'); };
  git(root, 'init', '-q'); git(root, 'config', 'core.autocrlf', 'false');
  for (const [name, text] of Object.entries({ '.gitignore': 'ignored\n', 'base.txt': 'clean base\n', 'dirty.txt': 'old\n', 'staged.txt': 'old\n', 'deleted.txt': 'gone\n' })) fs.writeFileSync(path.join(root, name), text);
  commit(); const head = git(root, 'rev-parse', 'HEAD');
  const service = createBadcaseCaptureService({ captureRoot: path.join(temp, 'capture'), agentDir: path.join(temp, 'agent'),
    getProject: id => id === 'p' ? { id, path: root } : null, getKnownKeyValues: () => [], ...extra });
  service.store.savePolicy({ projectId: 'p', status: 'enabled', authorizedDirs: [root] });
  const capture = (cwd = root, extra = {}) => service.captureTurnCheckpoint({ projectId: 'p', targetDir: cwd, conversationId: 'c', turnId: 't', agentId: 'a',
    deliveryMode: 'fresh', prompt: 'inert', runConfig: { provider: 'test', model: 'test', promptVersion: 'test' }, projectSkillPaths: [], ...extra });
  const restore = (cp, targetDir = path.join(temp, 'restored'), extra = {}) => service.restoreCheckpoint({ projectId: 'p', checkpointId: cp.checkpointId, targetDir, ...extra });
  const tree = directory => {
    const files = {}; function walk(dir, prefix = '') { for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.git') continue; const p = path.join(dir, name), st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, prefix + name + '/'); else if (st.isFile()) files[prefix + name] = hash(fs.readFileSync(p));
    } } walk(directory); return files;
  };
  return { temp, root, git, commit, head, service, capture, restore, tree };
}

test('v2 restores recorded HEAD plus binary/staged/unstaged/delete/untracked state, never the later source tree', async t => {
  const h = fixture(t), root = h.root;
  fs.writeFileSync(path.join(root, 'dirty.txt'), Buffer.from([0, 255, 1, 2]));
  fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n'); h.git(root, 'add', 'staged.txt'); fs.appendFileSync(path.join(root, 'staged.txt'), 'unstaged\n');
  fs.unlinkSync(path.join(root, 'deleted.txt')); fs.writeFileSync(path.join(root, 'untracked.bin'), Buffer.from([0, 3, 254]));
  fs.writeFileSync(path.join(root, 'staged-new.txt'), 'new staged\n'); h.git(root, 'add', 'staged-new.txt'); fs.appendFileSync(path.join(root, 'staged-new.txt'), 'then unstaged\n');
  const expected = h.tree(root), captured = await h.capture(); assert.equal(captured.captured, true, captured.reason);
  const checkpointBytes = JSON.stringify(h.service.store.loadCheckpoint('p', captured.checkpointId));
  // Advance source HEAD and change its dirty files AFTER capture. Only objects
  // at the captured HEAD may supply the base; source working files are not read.
  fs.writeFileSync(path.join(root, 'base.txt'), 'later base\n'); h.commit(); fs.writeFileSync(path.join(root, 'dirty.txt'), 'later live dirt');
  const before = { head: h.git(root, 'rev-parse', 'HEAD'), status: h.git(root, 'status', '--porcelain=v1', '-uall'),
    index: fs.readFileSync(path.join(root, '.git/index')), config: fs.readFileSync(path.join(root, '.git/config')) };
  for (const label of ['first', 'second']) {
    const target = path.join(h.temp, label), result = h.restore(captured.checkpoint, target);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.sourceHead, h.head);
    assert.deepEqual(h.tree(target), expected); assert.equal(fs.existsSync(path.join(target, '.git')), false);
    assert.equal(result.restoredFiles['base.txt'], expected['base.txt']); assert.deepEqual(result.uncapturedInScope, []);
  }
  assert.equal(h.git(root, 'rev-parse', 'HEAD'), before.head); assert.equal(h.git(root, 'status', '--porcelain=v1', '-uall'), before.status);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), before.index); assert.deepEqual(fs.readFileSync(path.join(root, '.git/config')), before.config);
  assert.equal(JSON.stringify(h.service.store.loadCheckpoint('p', captured.checkpointId)), checkpointBytes);
});

test('empty overlay still restores all HEAD files; source export-ignore/subst and filters do not change baseline bytes', async t => {
  const h = fixture(t); fs.writeFileSync(path.join(h.root, '.gitattributes'), 'base.txt export-ignore\ndirty.txt filter=trap\n'); h.commit();
  h.git(h.root, 'config', 'filter.trap.smudge', 'printf SHOULD_NOT_EXECUTE');
  const captured = await h.capture(), target = path.join(h.temp, 'restored');
  assert.deepEqual(captured.checkpoint.files, {}); const result = h.restore(captured.checkpoint, target);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(h.tree(target), h.tree(h.root));
  assert.equal(fs.readFileSync(path.join(target, 'dirty.txt'), 'utf8'), 'old\n');
});

test('ordinary Unicode, spaces and dot-prefixed names round-trip without ASCII-only replay assumptions', async t => {
  const h = fixture(t);
  for (const name of ['中文 name.txt', '..notes']) fs.writeFileSync(path.join(h.root, name), name);
  h.commit(); const captured = await h.capture(), target = path.join(h.temp, 'restored'), result = h.restore(captured.checkpoint, target);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(h.tree(target), h.tree(h.root));
});

test('CRLF clean files and dirty text round-trip without assuming every Windows file has CRLF', async t => {
  const h = fixture(t); h.git(h.root, 'config', 'core.autocrlf', 'true');
  fs.writeFileSync(path.join(h.root, 'base.txt'), 'clean base\r\n'); fs.writeFileSync(path.join(h.root, 'dirty.txt'), 'changed\r\n');
  const expected = h.tree(h.root), captured = await h.capture(), target = path.join(h.temp, 'restored');
  assert.equal(h.git(h.root, 'diff', '--name-only', 'HEAD', '--', 'base.txt'), '');
  const result = h.restore(captured.checkpoint, target); assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.tree(target), expected); assert.equal(fs.readFileSync(path.join(target, 'staged.txt'), 'utf8'), 'old\n');
});

test('mixed EOL positions survive Git normalization through a full archived overlay', async t => {
  const h = fixture(t); fs.writeFileSync(path.join(h.root, 'base.txt'), 'one\ntwo\n'); h.commit(); h.git(h.root, 'config', 'core.autocrlf', 'true');
  fs.writeFileSync(path.join(h.root, 'base.txt'), 'one\r\ntwo\n');
  assert.equal(h.git(h.root, 'diff', '--name-only', 'HEAD', '--', 'base.txt'), '');
  const captured = await h.capture(), target = path.join(h.temp, 'restored'), result = h.restore(captured.checkpoint, target);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(captured.checkpoint.files['base.txt'].origin, 'mixed-eol-tracked');
  assert.deepEqual(fs.readFileSync(path.join(target, 'base.txt')), Buffer.from('one\r\ntwo\n'));
});

test('known values in unchanged HEAD and captured overlays are replaced, while fake token-like examples remain', async t => {
  const known = 'snapshot-inert-known-value', h = fixture(t, { getKnownKeyValues: () => [known] });
  fs.writeFileSync(path.join(h.root, 'base.txt'), known + '\n'); h.commit();
  fs.writeFileSync(path.join(h.root, 'dirty.txt'), known + ' and sk-FAKE_EXAMPLE_ONLY\n');
  const captured = await h.capture(), target = path.join(h.temp, 'restored'), result = h.restore(captured.checkpoint, target);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(target, 'base.txt'), 'utf8'), '[*]\n');
  assert.equal(fs.readFileSync(path.join(target, 'dirty.txt'), 'utf8'), '[*] and sk-FAKE_EXAMPLE_ONLY\n');
  assert.ok(result.redactedFiles.some(f => f.path === 'base.txt' && f.byteIdenticalToSource === false));
  assert.ok(result.redactedFiles.some(f => f.path === 'dirty.txt' && f.byteIdenticalToSource === false));
});

test('room replay restores archived external project skills in an explicit isolated mirror with original path mappings', async t => {
  const h = fixture(t), room = path.join(h.temp, 'room'); h.git(h.root, 'worktree', 'add', '-qb', 'room/inert', room);
  const skill = path.join(h.root, '.agents/skills/selected'), rootMd = path.join(h.root, '.agents/skills/root.md');
  fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), 'archived skill'); fs.writeFileSync(path.join(skill, 'reference.txt'), 'archived reference');
  fs.writeFileSync(rootMd, 'single Markdown skill');
  const captured = await h.capture(room, { projectSkillPaths: [skill, rootMd] });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'later source skill'); fs.writeFileSync(rootMd, 'later root Markdown');
  const target = path.join(h.temp, 'restored'), mirror = path.join(h.temp, 'skill-mirror');
  assert.equal(h.restore(captured.checkpoint, target).reason, 'project_skills_target_required');
  assert.equal(fs.existsSync(target), false, 'missing explicit external destination must be caught before writes');
  const result = h.restore(captured.checkpoint, target, { projectSkillsDir: mirror }); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.projectSkills.length, 2);
  for (const entry of result.projectSkills) {
    assert.ok(path.relative(mirror, entry.restoredPath) && !path.relative(mirror, entry.restoredPath).startsWith('..'));
    if (entry.originalPath === skill) {
      assert.equal(fs.readFileSync(path.join(entry.restoredPath, 'SKILL.md'), 'utf8'), 'archived skill');
      assert.equal(fs.readFileSync(path.join(entry.restoredPath, 'reference.txt'), 'utf8'), 'archived reference');
    } else { assert.equal(entry.originalPath, rootMd); assert.equal(fs.readFileSync(entry.restoredPath, 'utf8'), 'single Markdown skill'); }
  }
  assert.equal(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), 'later source skill');
  assert.equal(fs.readFileSync(rootMd, 'utf8'), 'later root Markdown');
  assert.deepEqual(h.tree(target), h.tree(room));
});

test('an unreadable external root Markdown skill remains absent instead of failing the partial restore', async t => {
  const h = fixture(t), room = path.join(h.temp, 'room'); h.git(h.root, 'worktree', 'add', '-qb', 'room/partial-skill', room);
  const rootMd = path.join(h.root, 'root-skill.md'); fs.writeFileSync(rootMd, 'source skill');
  const originalRead = fs.readFileSync; let captured;
  fs.readFileSync = (name, ...args) => { if (name === rootMd) throw Object.assign(Error('inert denied read'), { code: 'EACCES' }); return originalRead(name, ...args); };
  try { captured = await h.capture(room, { projectSkillPaths: [rootMd] }); } finally { fs.readFileSync = originalRead; }
  assert.ok(captured.checkpoint.uncaptured.some(g => g.scope === rootMd && g.reason === 'file_unreadable'));
  const result = h.restore(captured.checkpoint, path.join(h.temp, 'restored'), { projectSkillsDir: path.join(h.temp, 'skill-mirror') });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.projectSkills[0].fileCount, 0);
  assert.equal(fs.existsSync(result.projectSkills[0].restoredPath), false); assert.equal(result.replayInputComplete, false);
});

test('removing a clean room worktree does not lose replay while its recorded common object database survives', async t => {
  const h = fixture(t), room = path.join(h.temp, 'room'); h.git(h.root, 'worktree', 'add', '-qb', 'room/removed', room);
  const captured = await h.capture(room), expected = h.tree(room); h.git(h.root, 'worktree', 'remove', room);
  const target = path.join(h.temp, 'restored'), result = h.restore(captured.checkpoint, target);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.sourceHead, h.head); assert.deepEqual(h.tree(target), expected);
});

test('in-cwd project skill bytes overlay HEAD at their original relative paths, not an extra replay directory', async t => {
  const h = fixture(t), skill = path.join(h.root, '.agents/skills/local'); fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'old skill'); h.commit();
  const captured = await h.capture(h.root, { projectSkillPaths: [skill] });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'later source');
  const target = path.join(h.temp, 'restored'), result = h.restore(captured.checkpoint, target);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.projectSkills[0].restoredPath, path.join(target, '.agents/skills/local'));
  assert.equal(fs.readFileSync(path.join(target, '.agents/skills/local/SKILL.md'), 'utf8'), 'old skill');
});

test('a skipped in-cwd skill resource is absent, not silently copied back from HEAD', async t => {
  const h = fixture(t), skill = path.join(h.root, '.agents/skills/local'), reference = path.join(skill, 'reference.txt');
  fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), 'skill'); fs.writeFileSync(reference, 'HEAD resource'); h.commit();
  const originalRead = fs.readFileSync; let captured;
  fs.readFileSync = (name, ...args) => { if (name === reference) throw Object.assign(Error('inert denied read'), { code: 'EACCES' }); return originalRead(name, ...args); };
  try { captured = await h.capture(h.root, { projectSkillPaths: [skill] }); } finally { fs.readFileSync = originalRead; }
  assert.ok(captured.checkpoint.uncaptured.some(g => g.scope === skill && g.reason === 'file_unreadable'));
  const target = path.join(h.temp, 'restored'), result = h.restore(captured.checkpoint, target);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(fs.existsSync(path.join(target, '.agents/skills/local/reference.txt')), false);
  assert.equal(fs.readFileSync(path.join(target, '.agents/skills/local/SKILL.md'), 'utf8'), 'skill');
});

test('skill path mappings retain Windows drive identity and do not interpret another drive as cwd-relative', () => {
  const { snapshotSkillLocation } = require('../../build/server/domain/runtime/badcase-capture/git-snapshot-materialization');
  assert.deepEqual(snapshotSkillLocation('E:/work/room', 'E:/work/room/.agents/skills/local'), { internal: true, relativePath: '.agents/skills/local' });
  assert.deepEqual(snapshotSkillLocation('E:/work/room', 'E:/project/.agents/skills/local'), { internal: false, relativePath: 'windows/E/project/.agents/skills/local' });
  assert.deepEqual(snapshotSkillLocation('E:/work/room', 'D:/project/.agents/skills/local'), { internal: false, relativePath: 'windows/D/project/.agents/skills/local' });
});

test('v2 verification without HEAD materialization never accepts overlay-only success', () => {
  const { verifyRestoredDirectory } = require('../../build/server/domain/runtime/badcase-capture/restore');
  const result = verifyRestoredDirectory({ checkpoint: { schemaVersion: 2, files: {} } });
  assert.deepEqual(result.mismatches, [{ path: '.', reason: 'git_snapshot_requires_head_materialization' }]);
});

test('nonempty or source-overlapping destinations are rejected without modification', async t => {
  const h = fixture(t), captured = await h.capture(), target = path.join(h.temp, 'nonempty'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'keep');
  assert.equal(h.restore(captured.checkpoint, target).reason, 'target_dir_not_empty'); assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'keep');
  const inSource = path.join(h.root, 'new-empty-dir');
  assert.equal(h.restore(captured.checkpoint, inSource).reason, 'restore_target_overlaps_source'); assert.equal(fs.existsSync(inSource), false);
});

test('missing HEAD or corrupt/missing patch/overlay blobs fail explicitly before writing a target', async t => {
  const h = fixture(t); fs.writeFileSync(path.join(h.root, 'new.txt'), 'untracked'); const captured = await h.capture();
  const original = captured.checkpoint;
  for (const [label, change, reason] of [
    ['head', cp => { cp.gitSnapshot.head = '0'.repeat(40); }, 'git_snapshot_head_unavailable'],
    ['source', cp => { cp.gitSnapshot.sourceRepository = cp.gitSnapshot.commonDir = path.join(h.temp, 'missing-repository'); }, 'git_snapshot_source_unavailable'],
    ['patch', cp => { cp.gitSnapshot.patchBlobHash = '0'.repeat(64); }, 'git_snapshot_blob_missing'],
    ['overlay', cp => { cp.files['new.txt'].hash = '0'.repeat(64); }, 'git_snapshot_blob_missing'],
    ['invalid-patch', cp => { const bytes = Buffer.from('not a git patch\n'), digest = hash(bytes); h.service.store.writeBlob('p', digest, bytes); cp.gitSnapshot.patchBlobHash = digest; cp.gitSnapshot.patchBytes = bytes.length; }, 'git_snapshot_patch_invalid'],
  ]) {
    const cp = structuredClone(original), target = path.join(h.temp, label); change(cp); h.service.store.saveCheckpoint('p', cp);
    const result = h.restore(cp, target); assert.equal(result.ok, false, label); assert.equal(result.reason, reason, label); assert.equal(fs.existsSync(target), false, label);
  }
});

test('skipped repository paths stay absent and are disclosed, rather than silently returning stale HEAD bytes', async t => {
  const h = fixture(t); fs.writeFileSync(path.join(h.root, 'dirty.txt'), Buffer.alloc(10 * 1024 * 1024 + 1));
  fs.mkdirSync(path.join(h.root, 'node_modules')); fs.writeFileSync(path.join(h.root, 'node_modules/ignored'), 'ignored');
  const outside = path.join(h.temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'no-read'), 'not captured');
  fs.symlinkSync(outside, path.join(h.root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  const captured = await h.capture(), target = path.join(h.temp, 'restored'), result = h.restore(captured.checkpoint, target);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.replayInputComplete, false); assert.equal(result.strictEvalEligible, false);
  for (const name of ['dirty.txt', 'junction', 'node_modules']) assert.equal(fs.existsSync(path.join(target, name)), false, name);
  assert.ok(result.uncapturedInScope.some(g => g.path === 'dirty.txt' && g.reason === 'file_size_limit'));
  assert.ok(result.uncapturedInScope.some(g => g.path === 'junction' && g.reason === 'reparse_point_skipped'));
  assert.equal(fs.readFileSync(path.join(target, 'base.txt'), 'utf8'), 'clean base\n');
});
