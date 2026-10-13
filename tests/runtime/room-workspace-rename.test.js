const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  bindAndPersistRoomWorkspace,
  bindRoomWorkspace,
  previewRoomWorkspace,
  previewRoomWorkspaceRename,
  renameAndPersistRoomWorkspace,
} = require('../../build/server/domain/conversation/room-workspace');
const { previewFingerprint } = require('../../build/server/domain/conversation/room-workspace-authorization');

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-room-workspace-rename-'));
  git(root, ['init']);
  git(root, ['config', 'user.name', 'CAFF Test']);
  git(root, ['config', 'user.email', 'caff-test@example.invalid']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['branch', 'develop']);
  return root;
}

function cleanupRepo(repoRoot, worktreePaths = []) {
  for (const worktreePath of worktreePaths) {
    try { git(repoRoot, ['worktree', 'remove', '--force', worktreePath]); } catch {}
  }
  try { fs.rmSync(path.join(path.dirname(repoRoot), 'worktrees'), { recursive: true, force: true }); } catch {}
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

function createConversation(overrides = {}) {
  return {
    id: randomUUID(),
    title: 'Rename Contract',
    projectScopeId: 'project-1',
    branch: null,
    worktreePath: null,
    workspaceBaseSha: null,
    ...overrides,
  };
}

function bindCustomConversation(repoRoot, branchName = 'feature/custom-name') {
  const project = { id: 'project-1', path: repoRoot };
  const conversation = createConversation();
  const binding = bindRoomWorkspace({ conversation, project, branchName });
  const bound = {
    ...conversation,
    branch: binding.branch,
    worktreePath: binding.worktreePath,
    workspaceBaseSha: binding.baseSha,
  };
  return { project, conversation: bound, binding };
}

function createStubStore(conversation, overrides = {}) {
  return {
    conversation,
    calls: [],
    getConversationWithoutMessages() {
      return this.conversation;
    },
    renameConversationWorkspaceBranch(conversationId, { oldBranch, newBranch, updatedAt }) {
      this.calls.push({ conversationId, oldBranch, newBranch, updatedAt });
      if (overrides.failPersistence) {
        const error = new Error('database write failed');
        error.code = 'room_workspace_persistence_failed';
        throw error;
      }
      if (String(this.conversation.branch || '') !== String(oldBranch || '')) {
        const error = new Error('Room workspace binding changed concurrently');
        error.code = 'room_workspace_binding_conflict';
        throw error;
      }
      this.conversation = { ...this.conversation, branch: newBranch, updatedAt };
      return this.conversation;
    },
  };
}

function assertWorkspaceError(error, code) {
  return error && error.code === code;
}

test('custom full branch name is used verbatim and the directory uses the stable room key', () => {
  const repoRoot = initRepo();
  const conversation = createConversation();
  const project = { id: 'project-1', path: repoRoot };
  let worktreePath = null;
  try {
    const beforeBranches = git(repoRoot, ['branch', '--format=%(refname:short)']);
    const preview = previewRoomWorkspace({ conversation, project, branchName: 'feature/custom-name' });
    assert.equal(preview.kind, 'bind');
    assert.equal(preview.branch, 'feature/custom-name');
    const stableSegment = conversation.id.replace(/[^a-z0-9]/giu, '').toLowerCase().slice(0, 8);
    assert.equal(path.basename(preview.worktreePath), stableSegment);
    assert.equal(preview.alreadyBound, false);
    // Read-only: no branch, no directory.
    assert.equal(git(repoRoot, ['branch', '--format=%(refname:short)']), beforeBranches);
    assert.equal(fs.existsSync(preview.worktreePath), false);

    const created = bindRoomWorkspace({ conversation, project, branchName: 'feature/custom-name' });
    worktreePath = created.worktreePath;
    assert.equal(created.branch, 'feature/custom-name');
    assert.equal(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/custom-name');
    assert.equal(git(worktreePath, ['rev-parse', 'HEAD']), preview.baseSha);
  } finally {
    cleanupRepo(repoRoot, worktreePath ? [worktreePath] : []);
  }
});

test('omitting branchName keeps the automatic naming and branch-suffix path', () => {
  const repoRoot = initRepo();
  const conversation = createConversation({ title: 'Auto Name' });
  const project = { id: 'project-1', path: repoRoot };
  try {
    const key = conversation.id.replace(/[^a-z0-9]/giu, '').toLowerCase().slice(0, 8);
    const preview = previewRoomWorkspace({ conversation, project });
    assert.equal(preview.branch, `room/${key}-auto-name`);
    assert.equal(path.basename(preview.worktreePath), `${key}-auto-name`);
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('invalid branch names and name conflicts fail without side effects', () => {
  const repoRoot = initRepo();
  const project = { id: 'project-1', path: repoRoot };
  const conversation = createConversation();
  const createdPaths = [];
  try {
    for (const branchName of ['bad..name', 'name with space', '', '   ', '-leading-dash']) {
      assert.throws(
        () => previewRoomWorkspace({ conversation, project, branchName }),
        (error) => assertWorkspaceError(error, 'room_workspace_branch_name_invalid')
          || assertWorkspaceError(error, 'room_workspace_branch_name_required')
      );
    }
    assert.equal(fs.existsSync(path.join(path.dirname(repoRoot), 'worktrees')), false);

    git(repoRoot, ['branch', 'feature/taken', 'develop']);
    assert.throws(
      () => bindRoomWorkspace({ conversation, project, branchName: 'feature/taken' }),
      (error) => assertWorkspaceError(error, 'room_workspace_branch_exists')
    );

    // A remote-tracking ref with the same name is also a conflict; never attach or overwrite.
    const sha = git(repoRoot, ['rev-parse', 'develop']);
    git(repoRoot, ['update-ref', 'refs/remotes/origin/feature/remote-taken', sha]);
    assert.throws(
      () => bindRoomWorkspace({ conversation, project, branchName: 'feature/remote-taken' }),
      (error) => assertWorkspaceError(error, 'room_workspace_branch_exists')
    );
  } finally {
    cleanupRepo(repoRoot, createdPaths);
  }
});

test('an already bound room rejects a different branchName on the bind preview', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot);
  try {
    assert.throws(
      () => previewRoomWorkspace({ conversation, project, branchName: 'feature/other' }),
      (error) => assertWorkspaceError(error, 'room_workspace_already_bound')
    );
    const echo = previewRoomWorkspace({ conversation, project, branchName: conversation.branch });
    assert.equal(echo.alreadyBound, true);
    assert.equal(echo.branch, binding.branch);
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
  }
});

test('rename keeps worktree directory, HEAD, files and baseline while updating git and the store', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/before-rename');
  try {
    fs.writeFileSync(path.join(binding.worktreePath, 'notes.txt'), 'important\n');
    const headBefore = git(binding.worktreePath, ['rev-parse', 'HEAD']);

    const preview = previewRoomWorkspaceRename({
      conversation,
      project,
      branchName: 'feature/after-rename',
    });
    assert.equal(preview.kind, 'rename');
    assert.equal(preview.branch, 'feature/before-rename');
    assert.equal(preview.newBranch, 'feature/after-rename');
    assert.equal(preview.worktreePath, binding.worktreePath);
    // Preview is read-only.
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/before-rename');

    const store = createStubStore(conversation);
    const result = renameAndPersistRoomWorkspace({
      store,
      conversation,
      project,
      branchName: 'feature/after-rename',
    });
    assert.equal(result.workspace.renamed, true);
    assert.equal(result.recovered, false);
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/after-rename');
    assert.equal(git(binding.worktreePath, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(fs.readFileSync(path.join(binding.worktreePath, 'notes.txt'), 'utf8'), 'important\n');
    assert.equal(fs.existsSync(binding.worktreePath), true);
    assert.equal(result.conversation.branch, 'feature/after-rename');
    assert.equal(result.conversation.worktreePath, conversation.worktreePath);
    assert.equal(result.conversation.workspaceBaseSha, conversation.workspaceBaseSha);
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
  }
});

test('rename rejects unchanged names, existing targets and unbound rooms without side effects', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot);
  try {
    assert.throws(
      () => previewRoomWorkspaceRename({ conversation, project, branchName: conversation.branch }),
      (error) => assertWorkspaceError(error, 'room_workspace_branch_name_unchanged')
    );
    git(repoRoot, ['branch', 'feature/existing-target', 'develop']);
    assert.throws(
      () => previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/existing-target' }),
      (error) => assertWorkspaceError(error, 'room_workspace_branch_exists')
    );
    assert.throws(
      () => previewRoomWorkspaceRename({ conversation: createConversation(), project, branchName: 'feature/x' }),
      (error) => assertWorkspaceError(error, 'room_workspace_not_bound')
    );
    // No side effects from any of the failures.
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), conversation.branch);
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
  }
});

test('rename blocks an active execution', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot);
  try {
    assert.throws(
      () => previewRoomWorkspaceRename({
        conversation,
        project,
        branchName: 'feature/while-running',
        hasActiveExecution: true,
      }),
      (error) => assertWorkspaceError(error, 'room_workspace_execution_active')
    );
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), conversation.branch);
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
  }
});

test('rename refuses a branch with an upstream', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/published-upstream');
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-room-workspace-remote-'));
  try {
    git(remoteRoot, ['init', '--bare']);
    git(repoRoot, ['remote', 'add', 'origin', remoteRoot]);
    git(repoRoot, ['push', '-u', 'origin', 'feature/published-upstream']);
    assert.throws(
      () => previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/renamed-anyway' }),
      (error) => assertWorkspaceError(error, 'room_workspace_branch_published')
    );
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/published-upstream');
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
    fs.rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('rename refuses a branch with a remote-tracking ref even without an upstream', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/tracked');
  try {
    const sha = git(repoRoot, ['rev-parse', 'feature/tracked']);
    git(repoRoot, ['update-ref', 'refs/remotes/origin/feature/tracked', sha]);
    // No upstream is configured for the branch.
    assert.throws(
      () => git(binding.worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
      /./u
    );
    assert.throws(
      () => previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/untracked-name' }),
      (error) => assertWorkspaceError(error, 'room_workspace_branch_published')
    );
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/tracked');
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
  }
});

test('rename blocks when the remote state cannot be verified and never modifies the remote', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/unverifiable');
  const missingRemote = path.join(os.tmpdir(), `caff-missing-remote-${randomUUID()}`);
  try {
    git(repoRoot, ['remote', 'add', 'origin', missingRemote]);
    assert.throws(
      () => previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/blocked' }),
      (error) => assertWorkspaceError(error, 'room_workspace_remote_state_unknown')
    );
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/unverifiable');
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
  }
});

test('rename allows a verifiably unpublished branch when a reachable remote lacks it', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/local-only');
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-room-workspace-remote-'));
  try {
    git(remoteRoot, ['init', '--bare']);
    git(repoRoot, ['remote', 'add', 'origin', remoteRoot]);
    git(repoRoot, ['push', 'origin', 'develop']);
    const store = createStubStore(conversation);
    const result = renameAndPersistRoomWorkspace({
      store,
      conversation,
      project,
      branchName: 'feature/still-local',
    });
    assert.equal(result.conversation.branch, 'feature/still-local');
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/still-local');
    // The remote was not modified.
    assert.equal(git(remoteRoot, ['branch', '--format=%(refname:short)']), 'develop');
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
    fs.rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('a persistence failure compensates the git rename so no half-finished state remains', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/before-failure');
  try {
    const store = createStubStore(conversation, { failPersistence: true });
    assert.throws(
      () => renameAndPersistRoomWorkspace({ store, conversation, project, branchName: 'feature/after-failure' }),
      (error) => assertWorkspaceError(error, 'room_workspace_persistence_failed')
    );
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/before-failure');
    assert.equal(store.conversation.branch, 'feature/before-failure');
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
  }
});

test('a lost compare-and-swap update compensates the git rename', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/cas-before');
  try {
    // Simulate a concurrent writer winning the conditional update after the git rename.
    const store = createStubStore(conversation);
    store.renameConversationWorkspaceBranch = function renameConflict() {
      const error = new Error('Room workspace binding changed concurrently');
      error.code = 'room_workspace_binding_conflict';
      throw error;
    };
    assert.throws(
      () => renameAndPersistRoomWorkspace({ store, conversation, project, branchName: 'feature/cas-after' }),
      (error) => assertWorkspaceError(error, 'room_workspace_binding_conflict')
    );
    // The git rename was rolled back; no half-finished state remains.
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/cas-before');
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
  }
});

test('an interrupted rename is reconciled on the next rename attempt', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/crash-before');
  try {
    // Simulate a crash after the git rename but before the database update.
    git(binding.worktreePath, ['branch', '-m', 'feature/crash-before', 'feature/crash-after']);
    const store = createStubStore(conversation);
    const result = renameAndPersistRoomWorkspace({
      store,
      conversation,
      project,
      branchName: 'feature/final-name',
    });
    assert.equal(result.recovered, true);
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/final-name');
    assert.equal(result.conversation.branch, 'feature/final-name');
    assert.equal(result.conversation.worktreePath, conversation.worktreePath);
    // The healing call adopted the actual branch before the requested rename.
    assert.deepEqual(
      store.calls.map((call) => [call.oldBranch, call.newBranch]),
      [['feature/crash-before', 'feature/crash-after'], ['feature/crash-after', 'feature/final-name']]
    );
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
  }
});

test('an ambiguous mismatch where both refs exist requires manual reconciliation', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/ambiguous-before');
  try {
    git(binding.worktreePath, ['branch', '-m', 'feature/ambiguous-before', 'feature/ambiguous-after']);
    git(repoRoot, ['branch', 'feature/ambiguous-before', 'develop']);
    const store = createStubStore(conversation);
    assert.throws(
      () => renameAndPersistRoomWorkspace({ store, conversation, project, branchName: 'feature/ambiguous-final' }),
      (error) => assertWorkspaceError(error, 'room_workspace_state_mismatch')
    );
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/ambiguous-after');
    assert.equal(store.conversation.branch, 'feature/ambiguous-before');
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
  }
});

test('an accepted authorization with a stale fingerprint changes nothing', () => {
  const repoRoot = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/fingerprint-before');
  try {
    const store = createStubStore(conversation);
    assert.throws(
      () => renameAndPersistRoomWorkspace({
        store,
        conversation,
        project,
        branchName: 'feature/fingerprint-after',
        expectedFingerprint: 'stale-fingerprint',
        fingerprintOf: previewFingerprint,
      }),
      (error) => assertWorkspaceError(error, 'room_workspace_authorization_stale')
    );
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/fingerprint-before');
    assert.equal(store.calls.length, 0);

    const preview = previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/fingerprint-after' });
    const result = renameAndPersistRoomWorkspace({
      store,
      conversation,
      project,
      branchName: 'feature/fingerprint-after',
      expectedFingerprint: previewFingerprint(preview),
      fingerprintOf: previewFingerprint,
    });
    assert.equal(result.conversation.branch, 'feature/fingerprint-after');
  } finally {
    cleanupRepo(repoRoot, [binding.worktreePath]);
  }
});

test('bindAndPersistRoomWorkspace persists a custom branch name and rolls back on store failure', () => {
  const repoRoot = initRepo();
  const project = { id: 'project-1', path: repoRoot };
  const conversation = createConversation();
  const preview = previewRoomWorkspace({ conversation, project, branchName: 'feature/persist-custom' });
  try {
    const failingStore = {
      bindConversationWorkspace() {
        throw new Error('cas lost');
      },
    };
    assert.throws(
      () => bindAndPersistRoomWorkspace({
        store: failingStore,
        conversation,
        project,
        branchName: 'feature/persist-custom',
        workspaceBoundAt: new Date().toISOString(),
      }),
      /cas lost/u
    );
    // Rollback removed the branch and worktree created by the failed request.
    assert.equal(fs.existsSync(preview.worktreePath), false);
    const branches = git(repoRoot, ['branch', '--format=%(refname:short)']);
    assert.ok(!branches.split(/\r?\n/u).includes('feature/persist-custom'));

    const store = {
      record: null,
      bindConversationWorkspace(conversationId, workspace) {
        this.record = { conversationId, workspace };
        return { ...conversation, ...workspace };
      },
    };
    const result = bindAndPersistRoomWorkspace({
      store,
      conversation,
      project,
      branchName: 'feature/persist-custom',
      workspaceBoundAt: new Date().toISOString(),
    });
    assert.equal(result.created, true);
    assert.equal(result.conversation.branch, 'feature/persist-custom');
    assert.equal(git(result.workspace.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/persist-custom');
  } finally {
    cleanupRepo(repoRoot, [preview.worktreePath]);
  }
});
