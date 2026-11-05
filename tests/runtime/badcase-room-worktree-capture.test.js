// Native Windows regression: project consent is inherited only by the actual
// bound Room cwd. All repositories, policy and external metadata are disposable.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
const { createWindowsCaptureEnvironment } = require('../../build/server/domain/runtime/badcase-capture/windows-git-environment');
const native = { skip: process.platform !== 'win32' };
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-room-capture-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'), captureRoot = path.join(temp, 'capture'), rooms = new Map();
  fs.mkdirSync(root);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true,
    env: createWindowsCaptureEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-q'); git(root, 'config', 'core.ignorecase', 'false');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'fixture');
  const head = git(root, 'rev-parse', 'HEAD'), project = { id: 'p', path: root };
  const chatStore = { getConversationWithoutMessages: id => rooms.get(id), getConversation: () => assert.fail('must not hydrate message bodies') };
  const service = createBadcaseCaptureService({ captureRoot, agentDir: path.join(temp, 'agent'), privateDirs: [path.join(temp, 'blocked')], chatStore,
    getProject: id => id === project.id ? project : null });
  const add = (id, relative = id) => {
    const cwd = path.join(temp, relative); git(root, 'worktree', 'add', '-qb', `room/${id}`, cwd);
    assert.ok(git(root, 'worktree', 'list', '--porcelain').replaceAll('\\', '/').includes(`worktree ${cwd.replaceAll('\\', '/')}`));
    rooms.set(id, { id, type: 'standard', projectScopeId: 'p', branch: `room/${id}`, worktreePath: cwd, workspaceBaseSha: head, metadata: {} });
    return cwd;
  };
  const enable = () => {
    service.savePolicy('p', { authorizedDirs: [root], excludedPatterns: ['node_modules'] }); const policy = service.authorizeProject('p');
    // Offline test status only. M2 exercises the real management enable flow.
    service.store.savePolicy({ ...policy, status: 'enabled' });
  };
  const capture = (id, targetDir = rooms.get(id)?.worktreePath, extra = {}) => service.captureTurnCheckpoint({
    projectId: 'p', conversationId: id, targetDir, turnId: 'turn', agentId: 'agent', deliveryMode: 'fresh', prompt: 'question',
    runConfig: { provider: 'test', model: 'test', promptVersion: 'test' }, ...extra,
  });
  return { temp, root, rooms, chatStore, service, git, head, project, add, enable, capture };
}
test('one project grant captures existing and later-created Room worktrees without persisting per-Room grants', native, async t => {
  const h = fixture(t), existing = h.add('existing'); h.enable(); const saved = h.service.loadPolicy('p');
  fs.writeFileSync(path.join(existing, 'tracked.txt'), 'dirty');
  fs.writeFileSync(path.join(existing, 'new.txt'), 'untracked'); fs.writeFileSync(path.join(existing, 'ignored.txt'), 'not collected');
  fs.mkdirSync(path.join(existing, 'node_modules')); fs.writeFileSync(path.join(existing, 'node_modules/hidden'), 'not collected');
  fs.writeFileSync(path.join(existing, 'secret.txt'), 'sk-SENTINELabcdefghijk');
  for (const id of ['existing', 'later']) {
    if (id === 'later') h.add(id);
    const result = await h.capture(id); assert.equal(result.captured, true, result.reason);
    const cp = h.service.store.loadCheckpoint('p', result.checkpointId);
    assert.equal(cp.projectId, 'p'); assert.equal(cp.targetDir, h.rooms.get(id).worktreePath);
    assert.equal(cp.gitMetadata, 'bounded_external_git_subset_v1');
    assert.equal(cp.roomWorktree.repositoryRoot, h.root); assert.equal(cp.roomWorktree.head, h.head);
    assert.ok(cp.roomWorktree.metadataRoot.startsWith(path.join(h.root, '.git', 'worktrees') + path.sep));
    assert.equal(cp.roomWorktree.commonRoot, path.join(h.root, '.git'));
    assert.equal(cp.files['.git'], undefined); assert.equal(cp.files['ignored.txt'], undefined); assert.equal(cp.files['node_modules/hidden'], undefined);
    if (id === 'existing') {
      assert.equal(h.service.store.readBlob('p', cp.files['tracked.txt'].hash).toString(), 'dirty');
      assert.equal(cp.files['secret.txt'].secretRedacted, true);
    }
    assert.deepEqual(h.service.loadPolicy('p'), saved);
  }
  h.service.savePolicy('p', { ...saved, status: 'disabled' });
  h.chatStore.getConversationWithoutMessages = () => assert.fail('disabled policy must not even inspect Room metadata');
  for (const id of ['existing', 'later']) assert.equal((await h.capture(id)).reason, 'policy_not_enabled');
});

test('real disposable Room checkpoints persist invalid-name gaps without reading them or losing safe files', native, async t => {
  const h = fixture(t), cwd = h.add('room'); h.enable();
  fs.appendFileSync(path.join(cwd, '.gitignore'), 'NUL\nnul.txt\ntail.\n');
  const paths = ['NUL', 'nul.txt', 'tail.'].map(name => path.toNamespacedPath(path.join(cwd, name)));
  // Registered after fixture cleanup: remove files here in finally, not a later
  // after hook (Node runs after hooks in registration order).
  try {
    for (const filename of paths) fs.writeFileSync(filename, 'INVALID_NAME_CONTENT_MUST_NOT_BE_READ');
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'dirty');
    const result = await h.capture('room'); assert.equal(result.captured, true, result.reason);
    const cp = h.service.store.loadCheckpoint('p', result.checkpointId);
    assert.deepEqual(cp.uncaptured, ['NUL', 'nul.txt', 'tail.'].map(path => ({ path, reason: 'windows_reserved_or_invalid_name' })));
    assert.equal(cp.stats.skippedCount, 3);
    assert.equal(cp.roomWorktree.head, h.head); assert.equal(cp.gitMetadata, 'bounded_external_git_subset_v1');
    assert.deepEqual(Object.keys(cp.files).sort(), ['.gitignore', 'tracked.txt']);
    assert.equal(h.service.store.readBlob('p', cp.files['tracked.txt'].hash).toString(), 'dirty');
    assert.equal(cp.replayInput.complete, false); assert.ok(cp.replayInput.incompleteReasons.includes('files_uncaptured'));
    assert.equal(cp.strictEvalEligible, false);
  } finally { for (const filename of paths) if (fs.existsSync(filename)) fs.unlinkSync(filename); }
});

test('Room checkpoints skip junctions with explicit gaps; restore never recreates links or prior children', native, async t => {
  const h = fixture(t), cwd = h.add('room'); h.enable();
  const outside = path.join(h.temp, 'outside'), nested = path.join(cwd, 'nested');
  fs.mkdirSync(outside); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(outside, 'private.txt'), 'OUTSIDE_LINK_TARGET_MUST_NOT_BE_READ');
  // Prove a formerly tracked child under a later junction is a gap, not a deletion.
  fs.mkdirSync(path.join(cwd, 'replaced'));
  fs.writeFileSync(path.join(cwd, 'replaced', 'old.txt'), 'old tracked');
  h.git(cwd, 'add', 'replaced/old.txt');
  const baseline = await h.capture('room'); assert.equal(baseline.captured, true, baseline.reason);
  fs.unlinkSync(path.join(cwd, 'replaced', 'old.txt')); fs.rmdirSync(path.join(cwd, 'replaced'));
  const linked = ['junction', 'nested/link', 'replaced'];
  try {
    for (const relative of linked) execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(cwd, relative), outside],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const gaps = linked.map(path => ({ path, reason: 'reparse_point_skipped' }));
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'dirty');
    const result = await h.capture('room'); assert.equal(result.captured, true, result.reason);
    const cp = h.service.store.loadCheckpoint('p', result.checkpointId);
    assert.deepEqual(cp.uncaptured, gaps); assert.equal(cp.stats.skippedCount, linked.length);
    assert.deepEqual(Object.keys(cp.files).sort(), ['.gitignore', 'tracked.txt']);
    assert.equal(cp.deletions.includes('replaced/old.txt'), false);
    assert.equal(cp.roomWorktree.head, h.head); assert.equal(cp.gitMetadata, 'bounded_external_git_subset_v1');
    assert.equal(cp.replayInput.complete, false); assert.ok(cp.replayInput.incompleteReasons.includes('files_uncaptured'));
    assert.equal(cp.strictEvalEligible, false);
    const sentinelHash = require('node:crypto').createHash('sha256').update('OUTSIDE_LINK_TARGET_MUST_NOT_BE_READ').digest('hex');
    assert.equal(h.service.store.hasBlob('p', sentinelHash), false);
    const dest = path.join(h.temp, 'restored');
    const restored = h.service.restoreCheckpoint({ projectId: 'p', checkpointId: cp.checkpointId, targetDir: dest });
    assert.equal(restored.ok, true, restored.reason); assert.equal(restored.replayInputComplete, false);
    assert.equal(fs.readFileSync(path.join(dest, 'tracked.txt'), 'utf8'), 'dirty');
    for (const relative of linked) assert.equal(fs.existsSync(path.join(dest, relative)), false, relative);
    assert.equal(fs.existsSync(path.join(dest, 'replaced', 'old.txt')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'OUTSIDE_LINK_TARGET_MUST_NOT_BE_READ');
  } finally {
    for (const relative of linked) {
      const p = path.join(cwd, relative);
      if (fs.existsSync(p)) fs.rmdirSync(p);  // unlink fixture junction only
    }
  }
});

test('enabled policy with only the previous helper SHA survives upgrade without reauthorization or pin changes', native, async t => {
  const h = fixture(t); h.add('room'); h.enable();
  const saved = h.service.loadPolicy('p');
  const { WINDOWS_HELPER_SOURCE, WINDOWS_HELPER_SOURCE_SHA256 } = require('../../build/server/domain/runtime/badcase-capture/windows-helper-source');
  const crypto = require('node:crypto');
  // Simulate the prior release's different content address. Never execute it;
  // the upgrade must install the trusted current source, not use old protocol.
  const oldSource = `${WINDOWS_HELPER_SOURCE}\n# previous release\n`;
  const oldSha = crypto.createHash('sha256').update(oldSource).digest('hex');
  assert.notEqual(oldSha, WINDOWS_HELPER_SOURCE_SHA256);
  const dir = path.join(h.service.captureRoot, 'windows-authorization-helper');
  const current = path.join(dir, `windows_read.${WINDOWS_HELPER_SOURCE_SHA256}.py`);
  const previous = path.join(dir, `windows_read.${oldSha}.py`);
  fs.writeFileSync(previous, oldSource, { flag: 'wx' }); fs.unlinkSync(current);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(previous)], 'only the old release is installed');
  const oldMtime = fs.statSync(previous).mtimeMs;
  const result = await h.capture('room');
  assert.equal(result.captured, true, result.reason);
  assert.equal(fs.readFileSync(current, 'utf8'), WINDOWS_HELPER_SOURCE);
  assert.equal(fs.readFileSync(previous, 'utf8'), oldSource);
  assert.equal(fs.statSync(previous).mtimeMs, oldMtime);
  const mtime = fs.statSync(current).mtimeMs;
  assert.equal((await h.capture('room')).captured, true);
  assert.equal(fs.statSync(current).mtimeMs, mtime, 'verified helper reused without rewrite');
  assert.deepEqual(h.service.loadPolicy('p'), saved, 'enabled state, consent and every pin unchanged');
  fs.appendFileSync(current, '\n# tampered\n');
  const corrupt = fs.readFileSync(current);
  assert.equal((await h.capture('room')).captured, false, 'never repair an existing untrusted file');
  assert.deepEqual(fs.readFileSync(current), corrupt);
  assert.deepEqual(h.service.loadPolicy('p'), saved);
});

for (const kind of ['unbound', 'foreign-project', 'dag', 'dag-worktree', 'cwd-mismatch', 'subdir', 'other-repo', 'other-repo-worktree',
  'forged-gitdir', 'forged-commondir', 'forged-backlink', 'unregistered', 'project-not-root']) {
  test(`Room inheritance rejects ${kind} without publishing a checkpoint`, native, async t => {
    const h = fixture(t), cwd = h.add('room'); h.enable(); let target = cwd;
    const room = h.rooms.get('room');
    if (kind === 'unbound') delete room.worktreePath;
    if (kind === 'foreign-project') room.projectScopeId = 'other';
    if (kind === 'dag') room.metadata.dagNodeGoalBinding = { nodeId: 'n1' };
    if (kind === 'dag-worktree') { target = h.add('node', 'repo/.worktrees/dag/plan/node'); room.worktreePath = target; }
    if (kind === 'other-repo-worktree') {
      const other = path.join(h.temp, 'other'); h.git(h.temp, 'clone', '--no-local', '-q', h.root, other);
      target = path.join(h.temp, 'foreign-room'); h.git(other, 'worktree', 'add', '-qb', 'room/foreign', target); room.worktreePath = target;
    }
    if (kind === 'cwd-mismatch') target = h.add('another');
    if (kind === 'subdir') { target = path.join(h.root, 'sub'); fs.mkdirSync(target); room.worktreePath = target; }
    if (kind === 'other-repo') { target = path.join(h.temp, 'other'); fs.mkdirSync(target); h.git(target, 'init', '-q'); room.worktreePath = target; }
    if (kind === 'forged-gitdir') {
      const other = path.join(h.temp, 'other'); fs.mkdirSync(other); h.git(other, 'init', '-q');
      fs.unlinkSync(path.join(cwd, '.git'));
      fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${path.join(other, '.git').replaceAll('\\', '/')}\n`);
    }
    if (kind === 'forged-commondir' || kind === 'forged-backlink') {
      fs.writeFileSync(path.join(h.root, '.git/worktrees/room', kind === 'forged-commondir' ? 'commondir' : 'gitdir'), `${h.temp.replaceAll('\\', '/')}/outside\n`);
    }
    if (kind === 'unregistered') fs.renameSync(path.join(h.root, '.git/worktrees/room'), path.join(h.temp, 'removed-registration'));
    if (kind === 'project-not-root') h.project.path = cwd;
    const result = await h.capture('room', target, { // Never trust invocation-supplied grants/binding.
      roomWorktree: { repositoryRoot: h.root, worktreePath: target }, policy: { authorizedDirs: [target] },
      externalGit: { metadataRoot: path.join(h.root, '.git/worktrees/room'), commonRoot: path.join(h.root, '.git') },
    });
    assert.equal(result.captured, false); assert.match(result.reason, /^room_worktree_/);
    assert.equal(h.service.store.loadLatestCheckpoint('p', target), null);
  });
}

for (const mode of ['detached', 'packed']) test(`inherited Room records the actual ${mode} HEAD without executing Git in the capture path`, native, async t => {
  const h = fixture(t), cwd = h.add('room'); h.enable();
  if (mode === 'detached') h.git(cwd, 'checkout', '--detach', '-q'); else h.git(h.root, 'pack-refs', '--all', '--prune');
  const result = await h.capture('room'); assert.equal(result.captured, true, result.reason);
  assert.equal(result.checkpoint.roomWorktree.head, h.git(cwd, 'rev-parse', 'HEAD'));
});

for (const relative of ['blocked/room', 'agent/room']) test(`project consent never overrides private host boundary ${relative}`, native, async t => {
  const h = fixture(t); h.add('room', relative); h.enable();
  const result = await h.capture('room'); assert.equal(result.captured, false); assert.match(result.reason, /^room_worktree_/);
  assert.equal(h.service.computeUsage('p').blobCount, 0);
});

test('unbinding during collection is rechecked before any CAS or checkpoint publication', native, async t => {
  const h = fixture(t); h.add('room'); h.enable(); let lookups = 0;
  h.chatStore.getConversationWithoutMessages = id => { if (++lookups === 2) h.rooms.delete(id); return h.rooms.get(id); };
  const result = await h.capture('room'); assert.equal(result.captured, false); assert.equal(result.reason, 'room_worktree_scope_changed');
  assert.equal(lookups, 2); assert.equal(h.service.computeUsage('p').blobCount, 0);
});

test('project root must retain its original native authorization identity; deleted worktrees cease to inherit', native, async t => {
  const h = fixture(t), cwd = h.add('room'); h.enable();
  const policy = h.service.loadPolicy('p'), key = h.root.toLowerCase();
  h.service.store.savePolicy({ ...policy, authorizedDirPins: { [key]: { ...policy.authorizedDirPins[key],
    identity: { ...policy.authorizedDirPins[key].identity, fileId: '0'.repeat(32) } } } });
  assert.equal((await h.capture('room')).captured, false);
  h.service.store.savePolicy(policy); h.git(h.root, 'worktree', 'remove', cwd);
  assert.equal((await h.capture('room')).captured, false);
});
