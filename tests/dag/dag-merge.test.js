const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  computeUpstreamLca,
  prepareMergeNodeWorktree,
  verifyMergeOutcome,
} = require('../../build/lib/dag-merge');
const { removeDagWorktree } = require('../../build/lib/dag-worktree');
const { withTempDir } = require('../helpers/temp-dir');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Repo layout:
 *   main (base commit A)
 *   ├── dag/a  (A + a1)
 *   └── dag/b  (A + b1)
 */
function createTempRepoWithBranches(t, prefix = 'caff-dag-merge-') {
  const repoRoot = withTempDir(prefix);
  git(['init', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 'test@example.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'hello\n');
  git(['add', 'README.md'], repoRoot);
  git(['commit', '-m', 'init'], repoRoot);
  const baseSha = git(['rev-parse', 'HEAD'], repoRoot);

  git(['checkout', '-b', 'dag/a'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'a1\n');
  git(['add', 'a.txt'], repoRoot);
  git(['commit', '-m', 'a1'], repoRoot);

  git(['checkout', 'main'], repoRoot);
  git(['checkout', '-b', 'dag/b'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'b.txt'), 'b1\n');
  git(['add', 'b.txt'], repoRoot);
  git(['commit', '-m', 'b1'], repoRoot);
  git(['checkout', 'main'], repoRoot);

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
  return { repoRoot, baseSha, createdWorktrees };
}

test('computeUpstreamLca returns the common ancestor of two branches', (t) => {
  const { repoRoot, baseSha } = createTempRepoWithBranches(t);
  const result = computeUpstreamLca(repoRoot, ['dag/a', 'dag/b']);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.lca, baseSha);
});

test('computeUpstreamLca resolves a single branch to its tip and rejects unsafe/unknown refs', (t) => {
  const { repoRoot } = createTempRepoWithBranches(t);
  const single = computeUpstreamLca(repoRoot, ['dag/a']);
  assert.equal(single.ok, true, single.reason);
  assert.equal(single.lca, git(['rev-parse', 'dag/a^{commit}'], repoRoot));

  assert.equal(computeUpstreamLca(repoRoot, []).ok, false);
  assert.equal(computeUpstreamLca(repoRoot, ['../evil']).ok, false);
  assert.equal(computeUpstreamLca(repoRoot, ['-d']).ok, false);
  const missing = computeUpstreamLca(repoRoot, ['dag/a', 'dag/missing']);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'dag_merge_no_common_ancestor');
});

test('prepareMergeNodeWorktree creates the integration branch from the upstream LCA (D11)', (t) => {
  const { repoRoot, baseSha, createdWorktrees } = createTempRepoWithBranches(t);
  const result = prepareMergeNodeWorktree({
    repoRoot,
    planId: 'plan-0001',
    node: { id: 'm1', branch: 'dag/m1-integration' },
    upstreamBranches: ['dag/a', 'dag/b'],
  });
  assert.equal(result.ok, true, result.reason);
  createdWorktrees.push(result.path);
  // Integration branch must start at the LCA, not at an upstream tip (D11).
  assert.equal(git(['rev-parse', 'dag/m1-integration^{commit}'], repoRoot), baseSha);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], result.path), 'dag/m1-integration');
});

test('prepareMergeNodeWorktree honors an explicit base_branch over the LCA', (t) => {
  const { repoRoot, createdWorktrees } = createTempRepoWithBranches(t);
  const result = prepareMergeNodeWorktree({
    repoRoot,
    planId: 'plan-0002',
    node: { id: 'm1', branch: 'dag/m1-integration', base_branch: 'dag/a' },
    upstreamBranches: ['dag/a', 'dag/b'],
  });
  assert.equal(result.ok, true, result.reason);
  createdWorktrees.push(result.path);
  assert.equal(git(['rev-parse', 'dag/m1-integration^{commit}'], repoRoot), git(['rev-parse', 'dag/a^{commit}'], repoRoot));
});

test('prepareMergeNodeWorktree fails closed when upstreams share no common ancestor', (t) => {
  const { repoRoot, createdWorktrees } = createTempRepoWithBranches(t);
  // Orphan branch with unrelated history.
  git(['checkout', '--orphan', 'dag/orphan'], repoRoot);
  git(['rm', '-rf', '.'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'orphan.txt'), 'orphan\n');
  git(['add', 'orphan.txt'], repoRoot);
  git(['commit', '-m', 'orphan'], repoRoot);
  git(['checkout', 'main'], repoRoot);

  const result = prepareMergeNodeWorktree({
    repoRoot,
    planId: 'plan-0003',
    node: { id: 'm1', branch: 'dag/m1-integration' },
    upstreamBranches: ['dag/a', 'dag/orphan'],
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /merge base resolution failed/);
  assert.ok(!fs.existsSync(path.join(repoRoot, '.worktrees', 'dag', 'plan-000', 'm1')));
  void createdWorktrees;
});

test('verifyMergeOutcome passes when every source branch is merged and verify exits 0', (t) => {
  const { repoRoot, createdWorktrees } = createTempRepoWithBranches(t);
  const prepared = prepareMergeNodeWorktree({
    repoRoot,
    planId: 'plan-0004',
    node: { id: 'm1', branch: 'dag/m1-integration' },
    upstreamBranches: ['dag/a', 'dag/b'],
  });
  assert.equal(prepared.ok, true, prepared.reason);
  createdWorktrees.push(prepared.path);
  git(['merge', '--no-ff', 'dag/a', '-m', 'merge a'], prepared.path);
  git(['merge', '--no-ff', 'dag/b', '-m', 'merge b'], prepared.path);
  fs.writeFileSync(path.join(prepared.path, 'verify-ok.txt'), 'ok\n');

  const verdict = verifyMergeOutcome({
    worktreePath: prepared.path,
    sourceBranches: ['dag/a', 'dag/b'],
    verifyCommand: 'git diff --quiet',
  });
  // git diff --quiet fails because verify-ok.txt is untracked? No — untracked files don't affect git diff.
  assert.equal(verdict.ok, true, verdict.reason);
});

test('verifyMergeOutcome fails when a source branch is not merged (D11 fail-closed)', (t) => {
  const { repoRoot, createdWorktrees } = createTempRepoWithBranches(t);
  const prepared = prepareMergeNodeWorktree({
    repoRoot,
    planId: 'plan-0005',
    node: { id: 'm1', branch: 'dag/m1-integration' },
    upstreamBranches: ['dag/a', 'dag/b'],
  });
  assert.equal(prepared.ok, true, prepared.reason);
  createdWorktrees.push(prepared.path);
  git(['merge', '--no-ff', 'dag/a', '-m', 'merge a'], prepared.path);
  // dag/b deliberately NOT merged.

  const verdict = verifyMergeOutcome({ worktreePath: prepared.path, sourceBranches: ['dag/a', 'dag/b'] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /dag\/b.*not merged/);
});

test('verifyMergeOutcome runs the node verify command and reports its failure output (D19)', (t) => {
  const { repoRoot, createdWorktrees } = createTempRepoWithBranches(t);
  const prepared = prepareMergeNodeWorktree({
    repoRoot,
    planId: 'plan-0006',
    node: { id: 'm1', branch: 'dag/m1-integration' },
    upstreamBranches: ['dag/a', 'dag/b'],
  });
  assert.equal(prepared.ok, true, prepared.reason);
  createdWorktrees.push(prepared.path);
  git(['merge', '--no-ff', 'dag/a', '-m', 'merge a'], prepared.path);
  git(['merge', '--no-ff', 'dag/b', '-m', 'merge b'], prepared.path);

  const failing = verifyMergeOutcome({
    worktreePath: prepared.path,
    sourceBranches: ['dag/a', 'dag/b'],
    verifyCommand: 'echo verify-boom 1>&2 && exit 1',
  });
  assert.equal(failing.ok, false);
  assert.match(failing.reason, /verify command failed/);
  assert.match(failing.reason, /verify-boom/);
});
