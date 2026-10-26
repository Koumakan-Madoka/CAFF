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
  assert.equal(resolvePlannerRoom(store, projects, room.id).cwd, fs.realpathSync(root));
  assert.match(plannerAppendPrompt(resolvePlannerRoom(store, projects, room.id)), /Reading and planning only/);
  room = { ...room, branch: 'room/synthetic', worktreePath: worktree, workspaceBaseSha: sha };
  const bound = resolvePlannerRoom(store, projects, room.id);
  assert.equal(bound.cwd, fs.realpathSync(worktree)); assert.equal(bound.branch, 'room/synthetic');
  assert.doesNotMatch(plannerAppendPrompt(bound), /Reading and planning only/);
  for (const patch of [{ workspaceBaseSha: null }, { worktreePath: temp }, { worktreePath: path.join(temp,'missing') }, { branch: 'room/foreign' }, { projectScopeId: 'missing-project' }]) {
    const original = room; room = { ...room, ...patch };
    assert.throws(() => resolvePlannerRoom(store, projects, room.id), /planner_workspace_invalid/); room = original;
  }
  foreign = [{ worktree_path: worktree }]; assert.throws(() => resolvePlannerRoom(store, projects, room.id), /planner_workspace_invalid/);
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
