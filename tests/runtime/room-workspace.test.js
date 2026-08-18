const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-room-workspace-'));
  git(root, ['init']);
  git(root, ['config', 'user.name', 'CAFF Test']);
  git(root, ['config', 'user.email', 'caff-test@example.invalid']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['branch', 'develop']);
  return root;
}

test('room workspace preview is deterministic and read-only, then confirmation creates one worktree', () => {
  const {
    previewRoomWorkspace,
    bindRoomWorkspace,
  } = require('../../build/server/domain/conversation/room-workspace');
  const repoRoot = initRepo();
  const conversationId = randomUUID();
  const conversation = {
    id: conversationId,
    title: 'Workspace Contract',
    projectScopeId: 'project-1',
  };

  try {
    const beforeBranches = git(repoRoot, ['branch', '--format=%(refname:short)']).split(/\r?\n/u);
    const preview = previewRoomWorkspace({ conversation, project: { id: 'project-1', path: repoRoot } });
    assert.equal(preview.branch, `room/${conversationId.slice(0, 8)}-workspace-contract`);
    assert.equal(preview.baseBranch, 'develop');
    assert.match(preview.baseSha, /^[0-9a-f]{40}$/u);
    assert.equal(fs.existsSync(preview.worktreePath), false);
    assert.deepEqual(git(repoRoot, ['branch', '--format=%(refname:short)']).split(/\r?\n/u), beforeBranches);

    const created = bindRoomWorkspace({ conversation, project: { id: 'project-1', path: repoRoot } });
    assert.equal(created.reused, false);
    assert.equal(created.branch, preview.branch);
    assert.equal(created.worktreePath, preview.worktreePath);
    assert.equal(git(created.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), preview.branch);
    assert.equal(git(created.worktreePath, ['rev-parse', 'HEAD']), preview.baseSha);
  } finally {
    const worktreePath = previewRoomWorkspace({ conversation, project: { id: 'project-1', path: repoRoot } }).worktreePath;
    try { git(repoRoot, ['worktree', 'remove', '--force', worktreePath]); } catch {}
    try { fs.rmSync(path.join(path.dirname(repoRoot), 'worktrees'), { recursive: true, force: true }); } catch {}
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('room workspace rejects an existing branch instead of attaching it', () => {
  const { bindRoomWorkspace } = require('../../build/server/domain/conversation/room-workspace');
  const repoRoot = initRepo();
  const conversationId = randomUUID();
  const conversation = {
    id: conversationId,
    title: 'Conflict',
    projectScopeId: 'project-1',
  };

  try {
    git(repoRoot, ['branch', `room/${conversationId.slice(0, 8)}-conflict`, 'develop']);
    assert.throws(
      () => bindRoomWorkspace({ conversation, project: { id: 'project-1', path: repoRoot } }),
      (error) => error && error.code === 'room_workspace_branch_exists'
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
