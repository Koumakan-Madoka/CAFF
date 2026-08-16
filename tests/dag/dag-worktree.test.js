const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  resolveDagWorktreePath,
  prepareNodeWorktree,
  isWorktreeDirty,
  removeDagWorktree,
} = require('../../build/lib/dag-worktree');
const { withTempDir } = require('../helpers/temp-dir');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createTempRepo(t, prefix = 'caff-dag-worktree-') {
  const repoRoot = withTempDir(prefix);
  git(['init', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 'test@example.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'hello\n');
  git(['add', 'README.md'], repoRoot);
  git(['commit', '-m', 'init'], repoRoot);

  const createdWorktrees = [];
  t.after(() => {
    for (const worktreePath of createdWorktrees) {
      try {
        removeDagWorktree(repoRoot, worktreePath, true);
      } catch {}
    }
    try {
      git(['worktree', 'prune'], repoRoot);
    } catch {}
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  return { repoRoot, createdWorktrees };
}

test('resolveDagWorktreePath uses .worktrees/dag/<plan8>/<nodeId> and rejects unsafe ids', () => {
  const p = resolveDagWorktreePath('/repo', 'plan-abcdef-1234', 'n1');
  assert.equal(p, path.join('/repo', '.worktrees', 'dag', 'plan-abc', 'n1'));
  assert.equal(resolveDagWorktreePath('/repo', 'plan-abcdef', '../escape'), null);
  assert.equal(resolveDagWorktreePath('/repo', 'plan-abcdef', 'a/b'), null);
  assert.equal(resolveDagWorktreePath('/repo', '', 'n1'), null);
});

test('prepareNodeWorktree creates a worktree on a new branch from HEAD', (t) => {
  const { repoRoot, createdWorktrees } = createTempRepo(t);
  const result = prepareNodeWorktree({ repoRoot, planId: 'plan-0001', nodeId: 'n1', branch: 'dag/n1' });
  assert.equal(result.ok, true, result.reason);
  createdWorktrees.push(result.path);
  assert.equal(result.reused, false);
  assert.equal(result.branch, 'dag/n1');
  assert.ok(fs.existsSync(path.join(result.path, 'README.md')));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], result.path), 'dag/n1');
  assert.equal(isWorktreeDirty(result.path), false);
});

test('prepareNodeWorktree reuses a clean worktree on the right branch', (t) => {
  const { repoRoot, createdWorktrees } = createTempRepo(t);
  const first = prepareNodeWorktree({ repoRoot, planId: 'plan-0002', nodeId: 'n1', branch: 'dag/n1' });
  assert.equal(first.ok, true, first.reason);
  createdWorktrees.push(first.path);
  const second = prepareNodeWorktree({ repoRoot, planId: 'plan-0002', nodeId: 'n1', branch: 'dag/n1' });
  assert.equal(second.ok, true, second.reason);
  assert.equal(second.reused, true);
  assert.equal(second.path, first.path);
});

test('prepareNodeWorktree refuses a dirty worktree without touching it (D22)', (t) => {
  const { repoRoot, createdWorktrees } = createTempRepo(t);
  const first = prepareNodeWorktree({ repoRoot, planId: 'plan-0003', nodeId: 'n1', branch: 'dag/n1' });
  assert.equal(first.ok, true, first.reason);
  createdWorktrees.push(first.path);
  fs.writeFileSync(path.join(first.path, 'dirty.txt'), 'uncommitted\n');

  const result = prepareNodeWorktree({ repoRoot, planId: 'plan-0003', nodeId: 'n1', branch: 'dag/n1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dag_worktree_dirty');
  assert.match(result.reason, /uncommitted changes/);
  // fail-closed: the dirty file must still be there afterwards
  assert.ok(fs.existsSync(path.join(first.path, 'dirty.txt')));
});

test('prepareNodeWorktree rejects a worktree checked out on the wrong branch', (t) => {
  const { repoRoot, createdWorktrees } = createTempRepo(t);
  const first = prepareNodeWorktree({ repoRoot, planId: 'plan-0004', nodeId: 'n1', branch: 'dag/n1' });
  assert.equal(first.ok, true, first.reason);
  createdWorktrees.push(first.path);

  const result = prepareNodeWorktree({ repoRoot, planId: 'plan-0004', nodeId: 'n1', branch: 'dag/other' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dag_worktree_branch_mismatch');
  assert.match(result.reason, /dag\/n1/);
});

test('prepareNodeWorktree refuses a path occupied by a non-worktree directory', (t) => {
  const { repoRoot } = createTempRepo(t);
  const occupied = resolveDagWorktreePath(repoRoot, 'plan-0005', 'n1');
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, 'random.txt'), 'not a worktree\n');

  const result = prepareNodeWorktree({ repoRoot, planId: 'plan-0005', nodeId: 'n1', branch: 'dag/n1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dag_worktree_path_occupied');
  assert.ok(fs.existsSync(path.join(occupied, 'random.txt')));
});

test('prepareNodeWorktree reports failure when the branch is checked out elsewhere', (t) => {
  const { repoRoot, createdWorktrees } = createTempRepo(t);
  const other = prepareNodeWorktree({ repoRoot, planId: 'plan-0006', nodeId: 'n1', branch: 'dag/shared' });
  assert.equal(other.ok, true, other.reason);
  createdWorktrees.push(other.path);

  // same branch, different node id → git refuses (branch already checked out)
  const result = prepareNodeWorktree({ repoRoot, planId: 'plan-0006', nodeId: 'n2', branch: 'dag/shared' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dag_worktree_add_failed');
  assert.match(result.reason, /git worktree add failed/);
});

test('prepareNodeWorktree rejects unsafe ids and branch names before touching git', (t) => {
  const { repoRoot } = createTempRepo(t);
  const badNode = prepareNodeWorktree({ repoRoot, planId: 'plan-0007', nodeId: '../x', branch: 'dag/n1' });
  assert.equal(badNode.ok, false);
  assert.equal(badNode.code, 'dag_worktree_invalid_id');

  const badBranch = prepareNodeWorktree({ repoRoot, planId: 'plan-0007', nodeId: 'n1', branch: '-d evil' });
  assert.equal(badBranch.ok, false);
  assert.equal(badBranch.code, 'dag_worktree_invalid_branch');

  const emptyBranch = prepareNodeWorktree({ repoRoot, planId: 'plan-0007', nodeId: 'n1', branch: '  ' });
  assert.equal(emptyBranch.ok, false);
  assert.equal(emptyBranch.code, 'dag_worktree_invalid_branch');
});
