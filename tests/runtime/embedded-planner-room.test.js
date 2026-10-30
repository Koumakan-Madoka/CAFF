const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolvePlannerRoom, plannerAppendPrompt } = require('../../build/server/domain/runtime/embedded-planner-room');

test('cwd follows owning project and verifies registered branch/worktree, failing closed for partial/foreign/missing bindings', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-workspace-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root'), worktree = path.join(temp, 'bound 中文'); fs.mkdirSync(root);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  git(['init','-b','develop']); git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','-m','synthetic']);
  const sha = git(['rev-parse','HEAD']).trim(); git(['worktree','add','-b','room/synthetic',worktree]);
  let room = { id: 'room-test', title: 'Room', projectScopeId: 'own-project', metadata: {} }, foreign = [];
  const store = { getConversationWithoutMessages: () => room, db: { prepare: () => ({ all: () => foreign }) } };
  const projects = { listProjects: () => [{ id: 'other-project', path: '/not-the-active-project' }, { id: 'own-project', path: root }] };
  assert.equal(resolvePlannerRoom(store, projects, room.id).cwd, fs.realpathSync.native(root));
  assert.match(plannerAppendPrompt(resolvePlannerRoom(store, projects, room.id)), /Reading and planning only/);
  room = { ...room, branch: 'room/synthetic', worktreePath: worktree, workspaceBaseSha: sha };
  const bound = resolvePlannerRoom(store, projects, room.id);
  assert.equal(bound.cwd, fs.realpathSync.native(worktree)); assert.equal(bound.branch, 'room/synthetic');
  assert.doesNotMatch(plannerAppendPrompt(bound), /Reading and planning only/);
  for (const patch of [{ workspaceBaseSha: null }, { worktreePath: temp }, { worktreePath: path.join(temp,'missing') }, { branch: 'room/foreign' }, { projectScopeId: 'missing-project' }]) {
    const original = room; room = { ...room, ...patch };
    assert.throws(() => resolvePlannerRoom(store, projects, room.id), /planner_workspace_invalid/); room = original;
  }
  foreign = [{ worktree_path: worktree }]; assert.throws(() => resolvePlannerRoom(store, projects, room.id), /planner_workspace_invalid/);
});

function workspaceFixture(t) {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-long-workspace-directory-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project-long-directory-name');
  const worktree = path.join(temp, 'worktree-long-directory-name');
  fs.mkdirSync(root);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  git(['init', '-b', 'develop']);
  git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'synthetic']);
  const sha = git(['rev-parse', 'HEAD']).trim();
  git(['worktree', 'add', '-b', 'room/synthetic', worktree]);
  const room = { id: 'room-test', title: 'Room', projectScopeId: 'own-project', metadata: {},
    branch: 'room/synthetic', worktreePath: worktree, workspaceBaseSha: sha };
  const project = { id: 'own-project', path: root };
  const foreign = [];
  return { root, worktree, temp, room, project, foreign,
    store: { getConversationWithoutMessages: () => room, db: { prepare: () => ({ all: () => foreign }) } },
    projects: { listProjects: () => [project] } };
}

function shortPathOrSkip(t, directory) {
  const short = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$fso = New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder($env:CAFF_TEST_LONG_PATH).ShortPath'],
  { encoding: 'utf8', env: { ...process.env, CAFF_TEST_LONG_PATH: directory }, timeout: 15000 }).trim();
  if (path.basename(short).toLowerCase() === path.basename(directory).toLowerCase()) {
    t.skip('This volume does not generate an 8.3 short name for the long-name fixture directory');
    return null;
  }
  assert.equal(fs.realpathSync.native(short).toLowerCase(), fs.realpathSync.native(directory).toLowerCase());
  return short;
}

const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows 8.3 path regression' : false };

test('Windows short project path resolves both unbound root and bound room', windowsOnly, t => {
  const f = workspaceFixture(t);
  const short = shortPathOrSkip(t, f.root); if (!short) return;
  f.project.path = short;
  const binding = { branch: f.room.branch, worktreePath: f.room.worktreePath, workspaceBaseSha: f.room.workspaceBaseSha };
  Object.assign(f.room, { branch: null, worktreePath: null, workspaceBaseSha: null });
  assert.equal(resolvePlannerRoom(f.store, f.projects, f.room.id).cwd, fs.realpathSync.native(f.root));
  Object.assign(f.room, binding);
  assert.equal(resolvePlannerRoom(f.store, f.projects, f.room.id).cwd, fs.realpathSync.native(f.worktree));
});

test('Windows short worktree path matches the long path reported by git', windowsOnly, t => {
  const f = workspaceFixture(t);
  const short = shortPathOrSkip(t, f.worktree); if (!short) return;
  f.room.worktreePath = short;
  const resolved = resolvePlannerRoom(f.store, f.projects, f.room.id);
  assert.equal(resolved.cwd, fs.realpathSync.native(f.worktree));
  assert.equal(resolved.branch, f.room.branch);
});

test('Windows short stored foreign path cannot bypass exclusive room binding', windowsOnly, t => {
  const f = workspaceFixture(t);
  const short = shortPathOrSkip(t, f.worktree); if (!short) return;
  f.foreign.push({ worktree_path: short });
  assert.throws(() => resolvePlannerRoom(f.store, f.projects, f.room.id), /planner_workspace_invalid/);
});

test('stored foreign symlink or junction cannot bypass exclusive binding; missing paths do not block', t => {
  const f = workspaceFixture(t);
  f.foreign.push({ worktree_path: path.join(f.temp, 'missing-worktree') });
  assert.equal(resolvePlannerRoom(f.store, f.projects, f.room.id).cwd, fs.realpathSync.native(f.worktree));
  const alias = path.join(f.temp, 'worktree-alias');
  fs.symlinkSync(f.worktree, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.foreign.push({ worktree_path: alias });
  assert.throws(() => resolvePlannerRoom(f.store, f.projects, f.room.id), /planner_workspace_invalid/);
});

test('append prompt bounds untrusted title/objective, keeps policy/identities and never copies history, settings or evidence', () => {
  const context = { cwd: '/synthetic', projectId: 'project-test', branch: null,
    room: { id: 'room-test', title: '😀'.repeat(5000), messages: ['private-sentinel'], metadata: { sessionGoal: {
      goalId: 'goal-test', revision: 2, status: 'active', owner: { agentId: 'author' }, objective: '中'.repeat(5000), evidence: ['private-sentinel'] } } } };
  const prompt = plannerAppendPrompt(context);
  assert.ok(Buffer.byteLength(prompt) < 16384); assert.match(prompt, /truncated/); assert.match(prompt, /goal-test/);
  assert.match(prompt, /Never edit or commit/); assert.doesNotMatch(prompt, /private-sentinel/);
  context.room.id = 'x'.repeat(201); assert.throws(() => plannerAppendPrompt(context), /planner_session_unavailable/);
});
