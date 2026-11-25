// The real one-switch path: disposable Git repositories, no native helper/pin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
const { createBadcaseCaptureController } = require('../../build/server/api/badcase-capture-controller');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-git-configure-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  // Harness temp directories may themselves be under a checkout. Do not let
  // non-Git fixtures discover an unrelated ancestor repository.
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = temp;
  t.after(() => { if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling; });
  const root = path.join(temp, 'repo'); fs.mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key];
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-q'); git(root, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n'); git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'base');
  const project = { id: 'p', path: root };
  const service = createBadcaseCaptureService({ captureRoot: path.join(temp, 'capture'), agentDir: path.join(temp, 'agent'), getProject: () => project });
  const controller = createBadcaseCaptureController({ service, projectManager: { listProjects: () => [project] },
    host: '127.0.0.1', port: 4313, csrfToken: 'fixture-csrf', sessionInputDir: path.join(temp, 'sessions') });
  const invoke = async body => {
    const req = new PassThrough(); req.method = 'POST'; req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = { host: '127.0.0.1:4313', origin: 'http://127.0.0.1:4313', 'content-type': 'application/json', 'x-caff-csrf-token': 'fixture-csrf' };
    let response;
    const res = { writeHead(status) { this.status = status; }, end(bytes) { response = { status: this.status, body: JSON.parse(bytes) }; } };
    const pending = controller({ req, res, pathname: '/api/projects/p/badcase-capture/configure' });
    req.end(JSON.stringify(body)); assert.equal(await pending, true); return response;
  };
  const room = id => { const dir = path.join(temp, id); git(root, 'worktree', 'add', '-qb', 'room/' + id, dir); return dir; };
  const capture = targetDir => service.captureTurnCheckpoint({ projectId: 'p', targetDir, conversationId: 'room', turnId: 'turn', agentId: 'agent',
    deliveryMode: 'fresh', prompt: 'question', runConfig: { provider: 'test', model: 'test' } });
  return { temp, root, project, service, invoke, git, room, capture };
}
const rejected = (fn, code, status = 409) => assert.rejects(fn, error => {
  assert.equal(error.statusCode, status); assert.equal(error.issues?.[0]?.code, code); return true;
});

// Query the actual filesystem alias; never guess an 8.3 spelling or change
// volume settings. This also works when the runner's TEMP already is short.
function shortTempOrSkip(t, temp) {
  const long = fs.realpathSync.native(temp);
  const short = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$fso = New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder($env:CAFF_TEST_LONG_PATH).ShortPath'],
  { encoding: 'utf8', env: { ...process.env, CAFF_TEST_LONG_PATH: long }, timeout: 15000, windowsHide: true }).trim();
  if (path.basename(short).toLowerCase() === path.basename(long).toLowerCase()) {
    t.skip('Fixture volume does not generate 8.3 short names'); return null;
  }
  assert.equal(fs.realpathSync.native(short).toLowerCase(), long.toLowerCase());
  return short;
}
const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows 8.3 path regression' : false };

test('Windows short project/worktree paths enable and capture the same Git repository', windowsOnly, async t => {
  const h = fixture(t), shortTemp = shortTempOrSkip(t, h.temp); if (!shortTemp) return;
  const root = fs.realpathSync.native(h.root), shortRoot = path.join(shortTemp, 'repo');
  const worktree = fs.realpathSync.native(h.room('existing')), shortWorktree = path.join(shortTemp, 'existing');
  h.project.path = shortRoot;
  assert.equal((await h.invoke({ confirmed: true, enabled: true })).body.policy.status, 'enabled');
  for (const target of [root, shortRoot, worktree, shortWorktree]) {
    const result = await h.capture(target);
    assert.equal(result.captured, true, result.reason);
    assert.equal(result.checkpoint.targetDir, target, 'keep the invocation spelling in the checkpoint');
    assert.equal(result.checkpoint.gitSnapshot.commonDir, path.join(root, '.git'));
  }
  h.project.path = shortWorktree;
  assert.equal((await h.invoke({ confirmed: true, enabled: true })).body.policy.status, 'enabled');
  assert.equal((await h.capture(shortRoot)).captured, true, 'worktree project still covers its common repository');
});

test('Windows short aliases do not admit subdirectories, unrelated repositories or junction ancestors', windowsOnly, async t => {
  const h = fixture(t), shortTemp = shortTempOrSkip(t, h.temp); if (!shortTemp) return;
  h.project.path = fs.realpathSync.native(h.root);
  await h.invoke({ confirmed: true, enabled: true });
  fs.mkdirSync(path.join(h.root, 'sub'));
  const other = path.join(h.temp, 'other'); h.git(h.temp, 'clone', '-q', '--no-local', h.root, other);
  assert.equal((await h.capture(path.join(shortTemp, 'repo', 'sub'))).reason, 'target_not_repository_root');
  assert.equal((await h.capture(path.join(shortTemp, 'other'))).reason, 'repository_not_covered');
  const link = path.join(h.temp, 'linked'); fs.symlinkSync(h.root, link, 'junction');
  const ancestor = path.join(h.temp, 'ancestor'); fs.symlinkSync(h.temp, ancestor, 'junction');
  t.after(() => { for (const name of [link, ancestor]) {
    try { fs.unlinkSync(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } });
  for (const target of [path.join(shortTemp, 'linked'), path.join(shortTemp, 'ancestor', 'repo')]) {
    assert.equal((await h.capture(target)).captured, false, 'short spelling must not hide a junction');
  }
  assert.equal(h.service.store.listCheckpoints('p').length, 0);
});

test('Windows short restore destinations cannot hide overlap with the captured source', windowsOnly, async t => {
  const h = fixture(t), shortTemp = shortTempOrSkip(t, h.temp); if (!shortTemp) return;
  const root = fs.realpathSync.native(h.root); h.project.path = root;
  await h.invoke({ confirmed: true, enabled: true });
  const captured = await h.capture(root); assert.equal(captured.captured, true, captured.reason);
  const targetDir = path.join(shortTemp, 'repo', 'must-not-be-created');
  const restored = h.service.restoreCheckpoint({ projectId: 'p', checkpointId: captured.checkpointId, targetDir });
  assert.equal(restored.reason, 'restore_target_overlaps_source');
  assert.equal(fs.existsSync(targetDir), false, 'reject before any source write');
  const destination = path.join(fs.realpathSync.native(h.temp), 'destination'); fs.mkdirSync(destination);
  const overlap = h.service.restoreCheckpoint({ projectId: 'p', checkpointId: captured.checkpointId,
    targetDir: destination, projectSkillsDir: path.join(shortTemp, 'destination', 'skills') });
  assert.equal(overlap.reason, 'restore_targets_overlap');
  assert.deepEqual(fs.readdirSync(destination), [], 'two writable roots must remain disjoint across aliases');
});

test('Windows short replay recipe roots keep HEAD and redaction rules without admitting junctions', windowsOnly, t => {
  const h = fixture(t), shortTemp = shortTempOrSkip(t, h.temp); if (!shortTemp) return;
  const { prepareReplayGit } = require('../../scripts/badcase-capture/replay-git.cjs');
  const head = h.git(h.root, 'rev-parse', 'HEAD'), sourceRoot = path.join(shortTemp, 'repo');
  const input = { files: [{ path: 'tracked.txt', base64: Buffer.from('base\n').toString('base64') }], deletions: [] };
  const preserved = prepareReplayGit({ sourceRoot, head }, input, { knownValues: [] });
  assert.equal(preserved.report.restoredHead, head);
  const redacted = prepareReplayGit({ sourceRoot, head }, input, { knownValues: ['base'] });
  assert.equal(redacted.report.fallbackReason, 'known_key_in_reachable_object');
  assert.notEqual(redacted.report.restoredHead, head);
  const sub = path.join(sourceRoot, 'sub'); fs.mkdirSync(sub);
  const linked = path.join(h.temp, 'linked'); fs.symlinkSync(h.root, linked, 'junction');
  for (const target of [sub, path.join(shortTemp, 'linked')]) {
    assert.throws(() => prepareReplayGit({ sourceRoot: target, head }, input),
      error => error.code === 'evaluation_repository_unavailable_or_invalid');
  }
});

test('one switch defaults to the registered project root; existing/new worktrees capture, disable stops all without scanning', async t => {
  const h = fixture(t), existing = h.room('existing');
  h.service.authorizeProject = () => { assert.fail('new configure must never install/use a native helper or pin'); };
  const beforeIndex = fs.readFileSync(path.join(h.root, '.git', 'index'));
  const enabled = await h.invoke({ confirmed: true, enabled: true });
  assert.equal(enabled.body.policy.status, 'enabled');
  assert.deepEqual(enabled.body.policy.authorizedDirs, [h.root]);
  assert.deepEqual(enabled.body.policy.authorizedDirPins, {});
  assert.deepEqual(enabled.body.policy.authorizedInputPins, {});
  assert.equal(enabled.body.policy.callbackInputAuthorized, true);
  assert.equal(h.service.store.listCheckpoints('p').length, 0, 'preview must not publish a checkpoint or CAS blobs');
  assert.equal(h.service.computeUsage('p').totalBytes, 0);
  assert.equal(fs.existsSync(path.join(h.service.captureRoot, 'windows-authorization-helper')), false);
  for (const dir of [h.root, existing, h.room('new')]) {
    const result = await h.capture(dir); assert.equal(result.captured, true, result.reason); assert.equal(result.checkpoint.schemaVersion, 2);
  }
  assert.deepEqual(fs.readFileSync(path.join(h.root, '.git', 'index')), beforeIndex);
  fs.renameSync(h.root, h.root + '-offline'); // disabling must not need a reachable repository
  h.service.estimateGitDirectoryAsync = () => { assert.fail('disable must not inspect the source'); };
  assert.equal((await h.invoke({ confirmed: true, enabled: false })).body.policy.status, 'disabled');
  for (const dir of [h.root, existing]) assert.equal((await h.capture(dir)).reason, 'policy_not_enabled');
});

test('registered project can itself be a Git worktree; configure no longer rejects a .git file', async t => {
  const h = fixture(t), worktree = h.room('project-worktree'); h.project.path = worktree;
  const response = await h.invoke({ confirmed: true, enabled: true, targetDir: worktree });
  assert.equal(response.body.policy.status, 'enabled'); assert.deepEqual(response.body.policy.authorizedDirs, [worktree]);
  assert.equal((await h.capture(worktree)).captured, true);
});

test('preview reports per-entry gaps and permits enabling/collection despite links, reserved names, unreadable or oversized files', async t => {
  const h = fixture(t), outside = path.join(h.temp, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'hidden'), 'LINK_TARGET_MUST_NOT_BE_READ');
  fs.symlinkSync(outside, path.join(h.root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  const reserved = path.toNamespacedPath(path.join(h.root, 'nul.txt'));
  fs.writeFileSync(reserved, 'RESERVED_MUST_NOT_BE_READ');
  t.after(() => { try { fs.unlinkSync(reserved); } catch {} });
  fs.writeFileSync(path.join(h.root, 'large'), Buffer.alloc(10 * 1024 * 1024 + 1));
  fs.writeFileSync(path.join(h.root, 'unreadable'), 'denied'); fs.writeFileSync(path.join(h.root, 'safe'), 'safe');
  const read = fs.readFileSync;
  fs.readFileSync = function(filename, ...args) {
    if (String(filename) === path.join(h.root, 'unreadable')) throw Object.assign(Error('fixture EACCES'), { code: 'EACCES' });
    if (String(filename).includes('junction') || String(filename) === path.join(h.root, 'nul.txt')) assert.fail('must skip without reading');
    return read.call(this, filename, ...args);
  };
  try {
    const preview = await h.service.estimateGitDirectoryAsync('p', h.root);
    assert.equal(preview.ok, true); assert.equal(preview.captureAvailable, true); assert.equal(preview.complete, false);
    assert.equal(preview.skippedCount, 4); assert.equal(preview.fileCount, 2); assert.equal(preview.totalBytes, 4);
    assert.deepEqual(preview.uncaptured.map(g => g.reason).sort(), ['file_size_limit', 'file_unreadable', 'reparse_point_skipped', 'windows_reserved_or_invalid_name']);
    assert.equal(h.service.computeUsage('p').totalBytes, 0);
    const response = await h.invoke({ confirmed: true, enabled: true }); assert.equal(response.body.policy.status, 'enabled');
    const result = await h.capture(h.root); assert.equal(result.captured, true, result.reason);
    assert.equal(result.checkpoint.stats.skippedCount, preview.skippedCount); assert.deepEqual(Object.keys(result.checkpoint.files), ['safe']);
  } finally { fs.readFileSync = read; }
});

test('invalid repositories/HEAD leave capture disabled; a different target cannot replace the registered project path', async t => {
  const h = fixture(t), other = path.join(h.temp, 'other');
  h.git(h.temp, 'clone', '-q', '--no-local', h.root, other);
  await rejected(() => h.invoke({ confirmed: true, enabled: true, targetDir: other }), 'badcase_capture_target_mismatch', 422);
  assert.deepEqual(h.service.loadPolicy('p').authorizedDirs, []);
  const plain = path.join(h.temp, 'plain'); fs.mkdirSync(plain); h.project.path = plain;
  await rejected(() => h.invoke({ confirmed: true, enabled: true }), 'not_git_repository');
  assert.equal(h.service.loadPolicy('p').status, 'disabled');
  h.git(plain, 'init', '-q');
  await rejected(() => h.invoke({ confirmed: true, enabled: true }), 'head_unreadable');
  assert.equal(h.service.loadPolicy('p').status, 'disabled');
  assert.equal(h.service.store.listCheckpoints('p').length, 0);
});

test('a concurrent disable wins over a pending configure even if its preview succeeded', async t => {
  const h = fixture(t);
  let resolvePreview, started;
  const reachedPreview = new Promise(resolve => { started = resolve; });
  h.service.estimateGitDirectoryAsync = () => { started(); return new Promise(resolve => { resolvePreview = resolve; }); };
  const pending = h.invoke({ confirmed: true, enabled: true }).then(value => ({ value }), error => ({ error }));
  try {
    await reachedPreview;
    await h.invoke({ confirmed: true, enabled: false });
    resolvePreview({ ok: true, captureAvailable: true, complete: false, skippedCount: 1 });
    const result = await pending; assert.equal(result.error?.issues?.[0]?.code, 'badcase_capture_operation_stale');
    assert.equal(h.service.loadPolicy('p').status, 'disabled');
  } finally { if (resolvePreview) resolvePreview({ ok: false }); await pending; }
});
