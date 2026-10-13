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

// Each test gets an exclusive outer directory: the repository lives in <outer>/repo
// and derived worktrees in <outer>/worktrees, so cleanup only ever removes the
// test's own directory tree.
function initRepo() {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-room-workspace-rename-'));
  const root = path.join(outer, 'repo');
  fs.mkdirSync(root);
  git(root, ['init']);
  git(root, ['config', 'user.name', 'CAFF Test']);
  git(root, ['config', 'user.email', 'caff-test@example.invalid']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['branch', 'develop']);
  return { outer, root };
}

function cleanup(outer) {
  fs.rmSync(outer, { recursive: true, force: true });
}

function initBareRemote() {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-room-workspace-remote-'));
  git(outer, ['init', '--bare']);
  return outer;
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
    operations: [],
    getConversationWithoutMessages() {
      return this.conversation;
    },
    createWorkspaceOperation(operation) {
      const record = {
        id: operation.id || randomUUID(),
        conversationId: operation.conversationId,
        kind: operation.kind,
        oldBranch: operation.oldBranch,
        newBranch: operation.newBranch,
        fingerprint: operation.fingerprint || null,
        status: 'pending',
      };
      this.operations.push(record);
      return record;
    },
    getPendingWorkspaceOperation() {
      return this.operations.filter((operation) => operation.status === 'pending').pop() || null;
    },
    completeWorkspaceOperation(id) {
      const operation = this.operations.find((candidate) => candidate.id === id);
      if (operation) operation.status = 'completed';
    },
    failWorkspaceOperation(id, errorCode) {
      const operation = this.operations.find((candidate) => candidate.id === id);
      if (operation) {
        operation.status = 'failed';
        operation.errorCode = errorCode || null;
      }
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
  const { outer, root: repoRoot } = initRepo();
  const conversation = createConversation();
  const project = { id: 'project-1', path: repoRoot };
  try {
    const beforeBranches = git(repoRoot, ['branch', '--format=%(refname:short)']);
    const preview = previewRoomWorkspace({ conversation, project, branchName: 'feature/custom-name' });
    assert.equal(preview.kind, 'bind');
    assert.equal(preview.branch, 'feature/custom-name');
    assert.equal(preview.requestedBranchName, 'feature/custom-name');
    const stableSegment = conversation.id.replace(/[^a-z0-9]/giu, '').toLowerCase().slice(0, 8);
    assert.equal(path.basename(preview.worktreePath), stableSegment);
    assert.equal(preview.alreadyBound, false);
    // Read-only: no branch, no directory.
    assert.equal(git(repoRoot, ['branch', '--format=%(refname:short)']), beforeBranches);
    assert.equal(fs.existsSync(preview.worktreePath), false);

    const created = bindRoomWorkspace({ conversation, project, branchName: 'feature/custom-name' });
    assert.equal(created.branch, 'feature/custom-name');
    assert.equal(git(created.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/custom-name');
    assert.equal(git(created.worktreePath, ['rev-parse', 'HEAD']), preview.baseSha);
  } finally {
    cleanup(outer);
  }
});

test('omitting branchName keeps the automatic naming, branch-suffix path and null requestedBranchName', () => {
  const { outer, root: repoRoot } = initRepo();
  const conversation = createConversation({ title: 'Auto Name' });
  const project = { id: 'project-1', path: repoRoot };
  try {
    const key = conversation.id.replace(/[^a-z0-9]/giu, '').toLowerCase().slice(0, 8);
    const preview = previewRoomWorkspace({ conversation, project });
    assert.equal(preview.branch, `room/${key}-auto-name`);
    assert.equal(path.basename(preview.worktreePath), `${key}-auto-name`);
    assert.equal(preview.requestedBranchName, null);
  } finally {
    cleanup(outer);
  }
});

test('invalid branch names and name conflicts fail without side effects', () => {
  const { outer, root: repoRoot } = initRepo();
  const project = { id: 'project-1', path: repoRoot };
  const conversation = createConversation();
  try {
    for (const branchName of ['bad..name', 'name with space', '', '   ', '-leading-dash']) {
      assert.throws(
        () => previewRoomWorkspace({ conversation, project, branchName }),
        (error) => assertWorkspaceError(error, 'room_workspace_branch_name_invalid')
          || assertWorkspaceError(error, 'room_workspace_branch_name_required')
      );
    }
    assert.equal(fs.existsSync(path.join(outer, 'worktrees')), false);

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
    cleanup(outer);
  }
});

test('an already bound room rejects a different branchName on the bind preview', () => {
  const { outer, root: repoRoot } = initRepo();
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
    cleanup(outer);
  }
});

test('rename keeps worktree directory, HEAD, files and baseline while updating git and the store', () => {
  const { outer, root: repoRoot } = initRepo();
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
    assert.equal(preview.resume, false);
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
    // The write-ahead operation record was closed.
    assert.equal(store.operations.length, 1);
    assert.equal(store.operations[0].status, 'completed');
  } finally {
    cleanup(outer);
  }
});

test('rename rejects unchanged names, existing targets and unbound rooms without side effects', () => {
  const { outer, root: repoRoot } = initRepo();
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
    cleanup(outer);
  }
});

test('read-only rename preview is allowed during an active execution; execution is not', () => {
  const { outer, root: repoRoot } = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot);
  try {
    // The caller's own turn (or any other active execution) never blocks the read-only preview.
    const preview = previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/later' });
    assert.equal(preview.newBranch, 'feature/later');

    const store = createStubStore(conversation);
    assert.throws(
      () => renameAndPersistRoomWorkspace({
        store,
        conversation,
        project,
        branchName: 'feature/later',
        hasActiveExecution: true,
      }),
      (error) => assertWorkspaceError(error, 'room_workspace_execution_active')
    );
    // Blocked before any Git or DB mutation, and no operation record was created.
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), conversation.branch);
    assert.equal(store.calls.length, 0);
    assert.equal(store.operations.length, 0);
  } finally {
    cleanup(outer);
  }
});

test('rename refuses a branch with an upstream', () => {
  const { outer, root: repoRoot } = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/published-upstream');
  const remoteRoot = initBareRemote();
  try {
    git(repoRoot, ['remote', 'add', 'origin', remoteRoot]);
    git(repoRoot, ['push', '-u', 'origin', 'feature/published-upstream']);
    assert.throws(
      () => previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/renamed-anyway' }),
      (error) => assertWorkspaceError(error, 'room_workspace_branch_published')
    );
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/published-upstream');
  } finally {
    cleanup(outer);
    cleanup(remoteRoot);
  }
});

test('rename refuses a branch whose upstream is configured even when the tracking ref is missing', () => {
  const { outer, root: repoRoot } = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/configured-upstream');
  const remoteRoot = initBareRemote();
  try {
    git(repoRoot, ['remote', 'add', 'origin', remoteRoot]);
    // Upstream association exists in config, but no remote-tracking ref was ever fetched.
    git(repoRoot, ['config', 'branch.feature/configured-upstream.remote', 'origin']);
    git(repoRoot, ['config', 'branch.feature/configured-upstream.merge', 'refs/heads/feature/configured-upstream']);
    assert.throws(
      () => previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/bypass' }),
      (error) => assertWorkspaceError(error, 'room_workspace_branch_published')
    );
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/configured-upstream');

    // A partial upstream configuration is treated as unknown and also blocks.
    git(repoRoot, ['config', '--unset', 'branch.feature/configured-upstream.merge']);
    assert.throws(
      () => previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/bypass' }),
      (error) => assertWorkspaceError(error, 'room_workspace_remote_state_unknown')
    );
  } finally {
    cleanup(outer);
    cleanup(remoteRoot);
  }
});

test('rename refuses a branch with a remote-tracking ref even without an upstream', () => {
  const { outer, root: repoRoot } = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/tracked');
  try {
    const sha = git(repoRoot, ['rev-parse', 'feature/tracked']);
    git(repoRoot, ['update-ref', 'refs/remotes/origin/feature/tracked', sha]);
    assert.throws(
      () => previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/untracked-name' }),
      (error) => assertWorkspaceError(error, 'room_workspace_branch_published')
    );
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/tracked');
  } finally {
    cleanup(outer);
  }
});

test('rename blocks when the remote state cannot be verified and never modifies the remote', () => {
  const { outer, root: repoRoot } = initRepo();
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
    cleanup(outer);
  }
});

test('rename allows a verifiably unpublished branch when a reachable remote lacks it', () => {
  const { outer, root: repoRoot } = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/local-only');
  const remoteRoot = initBareRemote();
  try {
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
    cleanup(outer);
    cleanup(remoteRoot);
  }
});

test('a persistence failure compensates the git rename and fails the operation record', () => {
  const { outer, root: repoRoot } = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/before-failure');
  try {
    const store = createStubStore(conversation, { failPersistence: true });
    assert.throws(
      () => renameAndPersistRoomWorkspace({ store, conversation, project, branchName: 'feature/after-failure' }),
      (error) => assertWorkspaceError(error, 'room_workspace_persistence_failed')
    );
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/before-failure');
    assert.equal(store.conversation.branch, 'feature/before-failure');
    assert.equal(store.operations.length, 1);
    assert.equal(store.operations[0].status, 'failed');
  } finally {
    cleanup(outer);
  }
});

test('a lost compare-and-swap update compensates the git rename', () => {
  const { outer, root: repoRoot } = initRepo();
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
    cleanup(outer);
  }
});

test('an interrupted rename resumes only through its recorded operation', () => {
  const { outer, root: repoRoot } = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/crash-before');
  try {
    const store = createStubStore(conversation);
    const authorizedPreview = previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/crash-after' });
    const fingerprint = previewFingerprint(authorizedPreview);
    // Simulate a crash after the write-ahead record and the git rename, before the DB update.
    store.createWorkspaceOperation({
      conversationId: conversation.id,
      kind: 'rename',
      oldBranch: 'feature/crash-before',
      newBranch: 'feature/crash-after',
      fingerprint,
    });
    git(binding.worktreePath, ['branch', '-m', 'feature/crash-before', 'feature/crash-after']);

    // A stale fingerprint is rejected BEFORE any DB write.
    assert.throws(
      () => renameAndPersistRoomWorkspace({
        store,
        conversation,
        project,
        branchName: 'feature/crash-after',
        expectedFingerprint: 'stale-fingerprint',
        fingerprintOf: previewFingerprint,
      }),
      (error) => assertWorkspaceError(error, 'room_workspace_authorization_stale')
    );
    assert.equal(store.calls.length, 0);
    assert.equal(store.conversation.branch, 'feature/crash-before');

    // A different target name cannot hijack the recorded operation.
    assert.throws(
      () => renameAndPersistRoomWorkspace({
        store,
        conversation,
        project,
        branchName: 'feature/different-target',
        expectedFingerprint: fingerprint,
        fingerprintOf: previewFingerprint,
      }),
      (error) => assertWorkspaceError(error, 'room_workspace_operation_pending')
    );
    assert.equal(store.calls.length, 0);

    // The authorized resume completes the DB side and closes the operation.
    const result = renameAndPersistRoomWorkspace({
      store,
      conversation,
      project,
      branchName: 'feature/crash-after',
      expectedFingerprint: fingerprint,
      fingerprintOf: previewFingerprint,
    });
    assert.equal(result.recovered, true);
    assert.equal(result.conversation.branch, 'feature/crash-after');
    assert.equal(git(binding.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/crash-after');
    assert.equal(store.operations[0].status, 'completed');
  } finally {
    cleanup(outer);
  }
});

test('a consistent state closes a stale pending operation before validation', () => {
  const { outer, root: repoRoot } = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/idem-before');
  try {
    const store = createStubStore(conversation);
    store.createWorkspaceOperation({
      conversationId: conversation.id,
      kind: 'rename',
      oldBranch: 'feature/idem-before',
      newBranch: 'feature/idem-after',
      fingerprint: null,
    });
    // Crash after the DB CAS but before the operation was closed.
    git(binding.worktreePath, ['branch', '-m', 'feature/idem-before', 'feature/idem-after']);
    store.conversation = { ...store.conversation, branch: 'feature/idem-after' };
    // DB and git agree here, so this goes through the consistent-state path,
    // which closes the stale pending operation before proceeding.
    assert.throws(
      () => renameAndPersistRoomWorkspace({ store, conversation, project, branchName: 'feature/idem-after' }),
      (error) => assertWorkspaceError(error, 'room_workspace_branch_name_unchanged')
    );
    assert.equal(store.operations[0].status, 'failed');
    assert.equal(store.operations[0].errorCode, 'superseded_by_consistent_state');
  } finally {
    cleanup(outer);
  }
});

test('an external branch rename without a recorded operation requires manual reconciliation', () => {
  const { outer, root: repoRoot } = initRepo();
  const { project, conversation, binding } = bindCustomConversation(repoRoot, 'feature/external-before');
  try {
    git(binding.worktreePath, ['branch', '-m', 'feature/external-before', 'feature/external-after']);
    const store = createStubStore(conversation);
    // No recorded operation: arbitrary external state never auto-heals.
    assert.throws(
      () => renameAndPersistRoomWorkspace({ store, conversation, project, branchName: 'feature/external-after' }),
      (error) => assertWorkspaceError(error, 'room_workspace_state_mismatch')
    );
    assert.equal(store.calls.length, 0);
    assert.equal(store.conversation.branch, 'feature/external-before');
    // The read-only preview reports the same mismatch without a pending operation.
    assert.throws(
      () => previewRoomWorkspaceRename({ conversation, project, branchName: 'feature/external-after' }),
      (error) => assertWorkspaceError(error, 'room_workspace_state_mismatch')
    );
    // With the recorded operation, the read-only preview exposes the resumable plan.
    const pending = {
      kind: 'rename',
      oldBranch: 'feature/external-before',
      newBranch: 'feature/external-after',
    };
    const resume = previewRoomWorkspaceRename({
      conversation,
      project,
      branchName: 'feature/external-after',
      pendingOperation: pending,
    });
    assert.equal(resume.resume, true);
    assert.equal(resume.branch, 'feature/external-before');
    assert.equal(resume.newBranch, 'feature/external-after');
  } finally {
    cleanup(outer);
  }
});

test('an accepted authorization with a stale fingerprint changes nothing', () => {
  const { outer, root: repoRoot } = initRepo();
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
    assert.equal(store.operations.length, 0);

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
    cleanup(outer);
  }
});

test('bindAndPersistRoomWorkspace persists a custom branch name and rolls back on store failure', () => {
  const { outer, root: repoRoot } = initRepo();
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
    cleanup(outer);
  }
});
