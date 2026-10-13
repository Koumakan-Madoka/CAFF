import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE_BRANCH = 'develop';
const MAX_SLUG_LENGTH = 48;
const MAX_BRANCH_NAME_LENGTH = 200;
const REMOTE_CHECK_TIMEOUT_MS = 15_000;

function workspaceError(code: string, message: string, statusCode = 409) {
  const error: any = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.issues = [{ code, message }];
  return error;
}

function git(repoRoot: string, args: string[], options: any = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (cause: any) {
    const message = String(cause && (cause.stderr || cause.message) || cause).trim();
    throw workspaceError('room_workspace_git_failed', message.slice(0, 500) || 'Git command failed');
  }
}

function gitRefExists(repoRoot: string, ref: string) {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', ref], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function asciiSlug(value: unknown) {
  const slug = String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'room';
}

function conversationKey(value: unknown) {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  if (key.length < 4) {
    throw workspaceError('room_workspace_conversation_id_invalid', 'Conversation id cannot produce a safe room branch', 400);
  }
  return key;
}

function repositoryRoot(project: any) {
  const configured = String(project && project.path || '').trim();
  if (!configured) {
    throw workspaceError('room_workspace_project_invalid', 'Project repository path is required', 400);
  }
  const resolved = path.resolve(configured);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw workspaceError('room_workspace_repository_invalid', 'Project repository path is not a directory');
  }
  try {
    const topLevel = git(resolved, ['rev-parse', '--show-toplevel']);
    return path.resolve(topLevel);
  } catch {
    throw workspaceError('room_workspace_repository_invalid', 'Project path is not a Git worktree');
  }
}

export function validateWorkspaceBranchName(repoRoot: string, name: unknown) {
  const branch = String(name === null || name === undefined ? '' : name).trim();
  if (!branch) {
    throw workspaceError('room_workspace_branch_name_required', 'Branch name is required', 400);
  }
  if (branch.length > MAX_BRANCH_NAME_LENGTH) {
    throw workspaceError(
      'room_workspace_branch_name_invalid',
      `Branch name must be at most ${MAX_BRANCH_NAME_LENGTH} characters`,
      400
    );
  }
  try {
    execFileSync('git', ['check-ref-format', '--branch', branch], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw workspaceError('room_workspace_branch_name_invalid', `Branch name ${branch} is not a valid Git branch name`, 400);
  }
  return branch;
}

function samePath(left: string, right: string) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function worktreeHeadBranch(worktreePath: string) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (cause: any) {
    const message = String(cause && (cause.stderr || cause.message) || cause).trim();
    throw workspaceError('room_workspace_state_unknown', `Cannot read the worktree Git state: ${message.slice(0, 300)}`);
  }
}

function assertWorktreeRegistered(repoRoot: string, worktreePath: string) {
  let listing = '';
  try {
    listing = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause: any) {
    const message = String(cause && (cause.stderr || cause.message) || cause).trim();
    throw workspaceError('room_workspace_git_failed', message.slice(0, 500) || 'Git command failed');
  }
  const registered = listing
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => samePath(line.slice('worktree '.length).trim(), worktreePath));
  if (!registered) {
    throw workspaceError(
      'room_workspace_worktree_mismatch',
      `Worktree ${worktreePath} is not registered in repository ${repoRoot}`
    );
  }
}

function gitConfigValue(repoRoot: string, key: string) {
  try {
    return {
      ok: true,
      value: execFileSync('git', ['config', '--get', key], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    };
  } catch (cause: any) {
    // `git config --get` exits 1 when the key is simply unset; anything else is a query failure.
    if (cause && cause.status === 1) {
      return { ok: true, value: '' };
    }
    return { ok: false, value: '' };
  }
}

// An upstream association exists whenever the branch config records one, even if the
// corresponding remote-tracking ref is missing locally. Only a fully absent config
// counts as "no upstream".
function branchUpstream(repoRoot: string, branch: string) {
  const merge = gitConfigValue(repoRoot, `branch.${branch}.merge`);
  const remote = gitConfigValue(repoRoot, `branch.${branch}.remote`);
  if (!merge.ok || !remote.ok) {
    throw workspaceError(
      'room_workspace_remote_state_unknown',
      `Cannot read the upstream configuration of branch ${branch}; rename is blocked.`
    );
  }
  if (merge.value && remote.value) {
    return `${remote.value}/${merge.value.replace(/^refs\/heads\//u, '')}`;
  }
  if (merge.value || remote.value) {
    throw workspaceError(
      'room_workspace_remote_state_unknown',
      `Branch ${branch} has a partial upstream configuration (remote=${remote.value || 'unset'}, merge=${merge.value || 'unset'}); rename is blocked.`
    );
  }
  return null;
}

function remoteBranchRefs(repoRoot: string, branch: string) {
  let listing = '';
  try {
    listing = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/remotes'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw workspaceError(
      'room_workspace_remote_state_unknown',
      'Cannot enumerate remote-tracking refs; rename is blocked.'
    );
  }
  const suffix = `/${branch}`;
  return listing
    .split('\n')
    .map((ref) => ref.trim())
    .filter((ref) => ref && (ref === `refs/remotes/${branch}` || ref.endsWith(suffix)));
}

function listRemotes(repoRoot: string) {
  try {
    return execFileSync('git', ['remote'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .map((remote) => remote.trim())
      .filter(Boolean);
  } catch {
    throw workspaceError(
      'room_workspace_remote_state_unknown',
      'Cannot enumerate Git remotes; rename is blocked.'
    );
  }
}

function assertRemoteLacksBranch(repoRoot: string, remote: string, branch: string) {
  let output = '';
  try {
    output = execFileSync('git', ['ls-remote', '--heads', remote, branch], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: REMOTE_CHECK_TIMEOUT_MS,
    }).trim();
  } catch {
    throw workspaceError(
      'room_workspace_remote_state_unknown',
      `Cannot verify whether branch ${branch} exists on remote ${remote}; rename is blocked. ` +
        'Ensure the remote is reachable, or remove the remote association, then retry. The remote is never modified by this operation.'
    );
  }
  if (output) {
    throw workspaceError(
      'room_workspace_branch_published',
      `Branch ${branch} exists on remote ${remote}; only unpublished local branches can be renamed. The remote is never modified by this operation.`
    );
  }
}

export function assertBranchUnpublished(repoRoot: string, branch: string) {
  const upstream = branchUpstream(repoRoot, branch);
  if (upstream) {
    throw workspaceError(
      'room_workspace_branch_published',
      `Branch ${branch} has upstream ${upstream}; only unpublished local branches can be renamed. The remote is never modified by this operation.`
    );
  }
  const trackedRefs = remoteBranchRefs(repoRoot, branch);
  if (trackedRefs.length > 0) {
    throw workspaceError(
      'room_workspace_branch_published',
      `Branch ${branch} already has remote-tracking ref(s): ${trackedRefs.join(', ')}; ` +
        'only unpublished local branches can be renamed. The remote is never modified by this operation.'
    );
  }
  for (const remote of listRemotes(repoRoot)) {
    assertRemoteLacksBranch(repoRoot, remote, branch);
  }
}

export function deriveRoomWorkspaceIdentity(conversation: any, project: any, options: any = {}) {
  const repoRoot = repositoryRoot(project);
  const key = conversationKey(conversation && conversation.id);
  const requested = options && Object.prototype.hasOwnProperty.call(options, 'branchName') && options.branchName !== null && options.branchName !== undefined
    ? validateWorkspaceBranchName(repoRoot, options.branchName)
    : null;
  const branch = requested || `room/${key}-${asciiSlug(conversation && conversation.title)}`;
  // A custom branch name gets a path derived from the stable conversation key so the
  // directory never depends on the (changeable) branch name. The default naming keeps
  // the historical branch-suffix path for backward compatibility.
  const pathSegment = requested ? key : branch.slice('room/'.length);
  const worktreePath = path.join(path.dirname(repoRoot), 'worktrees', 'room', pathSegment);
  return { repoRoot, branch, worktreePath };
}

function requireCompleteBinding(conversation: any) {
  if (!conversation || !conversation.branch || !conversation.worktreePath || !conversation.workspaceBaseSha) {
    throw workspaceError('room_workspace_binding_incomplete', 'Room workspace binding is incomplete');
  }
}

export function previewRoomWorkspace({ conversation, project, branchName }: any) {
  if (!conversation || !String(conversation.projectScopeId || '').trim()) {
    throw workspaceError('room_workspace_project_required', 'Room must have an immutable Project before workspace binding', 400);
  }
  if (String(project && project.id || '').trim() !== String(conversation.projectScopeId || '').trim()) {
    throw workspaceError('room_workspace_project_mismatch', 'Room Project does not match the workspace Project', 409);
  }
  const hasAnyBinding = Boolean(conversation.branch || conversation.worktreePath || conversation.workspaceBaseSha);
  if (hasAnyBinding) {
    requireCompleteBinding(conversation);
    const requested = branchName === null || branchName === undefined ? null : String(branchName).trim();
    if (requested && requested !== String(conversation.branch).trim()) {
      throw workspaceError(
        'room_workspace_already_bound',
        `Room is already bound to branch ${conversation.branch}; use the rename capability to change it`,
        409
      );
    }
    return {
      kind: 'bind',
      conversationId: conversation.id,
      projectScopeId: conversation.projectScopeId,
      repositoryPath: repositoryRoot(project),
      baseBranch: BASE_BRANCH,
      baseSha: conversation.workspaceBaseSha,
      branch: conversation.branch,
      requestedBranchName: null,
      worktreePath: path.resolve(conversation.worktreePath),
      alreadyBound: true,
    };
  }
  const { repoRoot, branch, worktreePath } = deriveRoomWorkspaceIdentity(conversation, project, { branchName });
  if (!gitRefExists(repoRoot, `refs/heads/${BASE_BRANCH}`)) {
    throw workspaceError('room_workspace_base_missing', `Local ${BASE_BRANCH} branch does not exist`);
  }
  const baseSha = git(repoRoot, ['rev-parse', BASE_BRANCH]);
  const requested = branchName === null || branchName === undefined ? null : String(branchName).trim();
  return {
    kind: 'bind',
    conversationId: conversation.id,
    projectScopeId: conversation.projectScopeId,
    repositoryPath: repoRoot,
    baseBranch: BASE_BRANCH,
    baseSha,
    branch,
    requestedBranchName: requested || null,
    worktreePath,
    alreadyBound: false,
  };
}

// Read-only rename preview. Active executions never block a preview; the idle check
// only happens at execution time inside renameAndPersistRoomWorkspace.
export function previewRoomWorkspaceRename({ conversation, project, branchName, pendingOperation = null }: any) {
  if (!conversation || !String(conversation.projectScopeId || '').trim()) {
    throw workspaceError('room_workspace_project_required', 'Room must have an immutable Project before workspace rename', 400);
  }
  if (String(project && project.id || '').trim() !== String(conversation.projectScopeId || '').trim()) {
    throw workspaceError('room_workspace_project_mismatch', 'Room Project does not match the workspace Project', 409);
  }
  if (!conversation.branch && !conversation.worktreePath && !conversation.workspaceBaseSha) {
    throw workspaceError('room_workspace_not_bound', 'Room has no workspace binding to rename', 409);
  }
  requireCompleteBinding(conversation);
  const repoRoot = repositoryRoot(project);
  const currentBranch = String(conversation.branch).trim();
  const newBranch = validateWorkspaceBranchName(repoRoot, branchName);
  if (newBranch === currentBranch) {
    throw workspaceError('room_workspace_branch_name_unchanged', 'New branch name must differ from the current branch', 400);
  }
  const worktreePath = path.resolve(String(conversation.worktreePath));
  if (!fs.existsSync(worktreePath)) {
    throw workspaceError('room_workspace_worktree_missing', `Worktree ${worktreePath} does not exist`);
  }
  assertWorktreeRegistered(repoRoot, worktreePath);
  const actualBranch = worktreeHeadBranch(worktreePath);
  if (actualBranch !== currentBranch) {
    // An interrupted rename can only resume through the recorded, previously
    // authorized operation; arbitrary external checkouts never auto-heal.
    const resume = pendingOperation
      && pendingOperation.kind === 'rename'
      && String(pendingOperation.oldBranch || '') === currentBranch
      && String(pendingOperation.newBranch || '') === actualBranch
      && newBranch === actualBranch;
    if (!resume) {
      throw workspaceError(
        'room_workspace_state_mismatch',
        `Worktree is on Git branch ${actualBranch} but the Room binding records ${currentBranch}; ` +
          'no matching recorded rename operation exists, so the state must be reconciled manually'
      );
    }
    return {
      kind: 'rename',
      conversationId: conversation.id,
      projectScopeId: conversation.projectScopeId,
      repositoryPath: repoRoot,
      baseBranch: BASE_BRANCH,
      baseSha: conversation.workspaceBaseSha,
      branch: currentBranch,
      newBranch,
      worktreePath,
      alreadyBound: true,
      resume: true,
    };
  }
  if (gitRefExists(repoRoot, `refs/heads/${newBranch}`)) {
    throw workspaceError('room_workspace_branch_exists', `Branch ${newBranch} already exists`);
  }
  const remoteTargetRefs = remoteBranchRefs(repoRoot, newBranch);
  if (remoteTargetRefs.length > 0) {
    throw workspaceError(
      'room_workspace_branch_exists',
      `Branch ${newBranch} already exists as remote-tracking ref(s): ${remoteTargetRefs.join(', ')}`
    );
  }
  assertBranchUnpublished(repoRoot, currentBranch);
  return {
    kind: 'rename',
    conversationId: conversation.id,
    projectScopeId: conversation.projectScopeId,
    repositoryPath: repoRoot,
    baseBranch: BASE_BRANCH,
    baseSha: conversation.workspaceBaseSha,
    branch: currentBranch,
    newBranch,
    worktreePath,
    alreadyBound: true,
    resume: false,
  };
}

export function bindRoomWorkspace({ conversation, project, branchName }: any) {
  const preview = previewRoomWorkspace({ conversation, project, branchName });
  if (preview.alreadyBound) {
    return { ...preview, reused: true };
  }
  if (gitRefExists(preview.repositoryPath, `refs/heads/${preview.branch}`)) {
    throw workspaceError('room_workspace_branch_exists', `Branch ${preview.branch} already exists`);
  }
  const remoteRefs = remoteBranchRefs(preview.repositoryPath, preview.branch);
  if (remoteRefs.length > 0) {
    throw workspaceError(
      'room_workspace_branch_exists',
      `Branch ${preview.branch} already exists as remote-tracking ref(s): ${remoteRefs.join(', ')}`
    );
  }
  if (fs.existsSync(preview.worktreePath)) {
    throw workspaceError('room_workspace_path_occupied', `Worktree path ${preview.worktreePath} is occupied`);
  }
  fs.mkdirSync(path.dirname(preview.worktreePath), { recursive: true });
  try {
    git(preview.repositoryPath, [
      'worktree',
      'add',
      '-b',
      preview.branch,
      preview.worktreePath,
      preview.baseSha,
    ]);
  } catch (error: any) {
    if (fs.existsSync(preview.worktreePath)) {
      try { fs.rmSync(preview.worktreePath, { recursive: true, force: true }); } catch {}
    }
    throw workspaceError('room_workspace_create_failed', String(error && error.message || error));
  }
  return { ...preview, reused: false, alreadyBound: true };
}

export function bindAndPersistRoomWorkspace({ store, conversation, project, branchName, workspaceBoundAt }: any) {
  if (conversation.branch || conversation.worktreePath || conversation.workspaceBaseSha) {
    return {
      conversation,
      workspace: { ...previewRoomWorkspace({ conversation, project, branchName }), reused: true },
      created: false,
    };
  }

  const binding = bindRoomWorkspace({ conversation, project, branchName });
  if (binding.reused) {
    return { conversation, workspace: binding, created: false };
  }
  try {
    const bound = store.bindConversationWorkspace(conversation.id, {
      branch: binding.branch,
      worktreePath: binding.worktreePath,
      workspaceBaseSha: binding.baseSha,
      workspaceBoundAt,
    });
    return { conversation: bound, workspace: binding, created: true };
  } catch (error) {
    rollbackCreatedRoomWorkspace(binding);
    throw error;
  }
}

function loadPendingRenameOperation(store: any, conversationId: any) {
  if (!store || typeof store.getPendingWorkspaceOperation !== 'function') {
    throw workspaceError(
      'room_workspace_operation_store_required',
      'Workspace rename requires a store with durable operation records',
      500
    );
  }
  const pending = store.getPendingWorkspaceOperation(conversationId);
  return pending && pending.kind === 'rename' ? pending : null;
}

function assertIdleForRename(hasActiveExecution: boolean) {
  if (hasActiveExecution) {
    throw workspaceError(
      'room_workspace_execution_active',
      'Room has an active execution; rename is blocked until the current execution finishes'
    );
  }
}

// The branch CAS and the write-ahead close-out commit in one store transaction.
// Stores without the combined method (test doubles) fall back to the sequential pair.
function renameBranchAndCloseOperation(store: any, conversationId: any, rename: any, operationId: any) {
  if (typeof store.renameConversationWorkspaceBranchAndCompleteOperation === 'function') {
    return store.renameConversationWorkspaceBranchAndCompleteOperation(conversationId, rename, operationId);
  }
  const updated = store.renameConversationWorkspaceBranch(conversationId, rename);
  store.completeWorkspaceOperation(operationId);
  return updated;
}

// Recording a new write-ahead operation atomically supersedes any stale pending
// records. This only runs AFTER every rejection condition has passed.
function recordWorkspaceOperation(store: any, conversationId: any, operation: any) {
  if (typeof store.replacePendingWorkspaceOperation === 'function') {
    return store.replacePendingWorkspaceOperation({ conversationId, ...operation }, 'superseded_by_consistent_state');
  }
  const stale = store.getPendingWorkspaceOperation(conversationId);
  if (stale) {
    store.failWorkspaceOperation(stale.id, 'superseded_by_consistent_state');
  }
  return store.createWorkspaceOperation({ conversationId, ...operation });
}

export function renameAndPersistRoomWorkspace({
  store,
  conversation,
  project,
  branchName,
  hasActiveExecution = false,
  expectedFingerprint = null,
  fingerprintOf = null,
}: any) {
  const conversationId = conversation && conversation.id;
  const current = (store && typeof store.getConversationWithoutMessages === 'function'
    ? store.getConversationWithoutMessages(conversationId)
    : null) || conversation;
  if (!current || !current.branch || !current.worktreePath) {
    throw workspaceError('room_workspace_not_bound', 'Room has no workspace binding to rename', 409);
  }
  const repoRoot = repositoryRoot(project);
  const worktreePath = path.resolve(String(current.worktreePath));
  if (!fs.existsSync(worktreePath)) {
    throw workspaceError('room_workspace_worktree_missing', `Worktree ${worktreePath} does not exist`);
  }
  // Ownership first: never interpret the state of a worktree that is not the
  // registered binding of this Room.
  assertWorktreeRegistered(repoRoot, worktreePath);
  const actualBranch = worktreeHeadBranch(worktreePath);
  const recordedBranch = String(current.branch).trim();
  const requestedName = validateWorkspaceBranchName(repoRoot, branchName);
  const pending = loadPendingRenameOperation(store, conversationId);

  if (actualBranch !== recordedBranch) {
    // Interrupted state (crash between the Git rename and the DB commit). Only the
    // recorded, previously authorized operation may resume. Every rejection
    // condition runs BEFORE any DB write.
    if (
      !pending
      || String(pending.oldBranch || '') !== recordedBranch
      || String(pending.newBranch || '') !== actualBranch
    ) {
      throw workspaceError(
        'room_workspace_state_mismatch',
        `Room binding records ${recordedBranch} but the worktree is on ${actualBranch}; ` +
          'no matching recorded rename operation exists, so the state must be reconciled manually'
      );
    }
    if (requestedName !== String(pending.newBranch)) {
      throw workspaceError(
        'room_workspace_operation_pending',
        `A recorded rename to ${pending.newBranch} is still pending; retry with that exact branchName to complete it`,
        409
      );
    }
    if (expectedFingerprint) {
      // Re-authorization protocol for recovery: the pending operation record
      // proves the operation itself was authorized once; completing it through an
      // authorization card additionally requires the card fingerprint to match a
      // FRESH resume preview recomputed from the current state. This works for
      // card-originated operations (the fingerprint is stable while the plan is
      // unchanged) and for fallback-originated records whose stored fingerprint is
      // null: the agent re-previews after the restart and the user approves the
      // freshly issued resume card.
      if (typeof fingerprintOf !== 'function') {
        throw new Error('A fingerprint function is required to authorize a workspace rename');
      }
      const resumePreview = previewRoomWorkspaceRename({
        conversation: current,
        project,
        branchName: requestedName,
        pendingOperation: pending,
      });
      if (fingerprintOf(resumePreview) !== String(expectedFingerprint)) {
        throw workspaceError(
          'room_workspace_authorization_stale',
          'Workspace preview changed; request a new authorization card',
          409
        );
      }
    }
    assertIdleForRename(Boolean(hasActiveExecution));
    // The Git side of the recorded operation already happened; complete the DB
    // side. The CAS and the operation close-out commit atomically.
    let updated = null;
    try {
      updated = renameBranchAndCloseOperation(store, conversationId, {
        oldBranch: recordedBranch,
        newBranch: actualBranch,
        updatedAt: new Date().toISOString(),
      }, pending.id);
    } catch (error) {
      const reread = typeof store.getConversationWithoutMessages === 'function'
        ? store.getConversationWithoutMessages(conversationId)
        : null;
      const operationAfter = typeof store.getWorkspaceOperation === 'function'
        ? store.getWorkspaceOperation(pending.id)
        : null;
      if (
        !reread
        || String(reread.branch || '') !== actualBranch
        || (operationAfter && operationAfter.status !== 'completed')
      ) {
        throw error;
      }
      updated = reread;
    }
    if (!updated || String(updated.branch || '') !== actualBranch) {
      throw workspaceError('room_workspace_binding_conflict', 'Room workspace binding changed concurrently');
    }
    return {
      conversation: updated,
      workspace: {
        kind: 'rename',
        conversationId,
        projectScopeId: current.projectScopeId,
        repositoryPath: repoRoot,
        baseBranch: BASE_BRANCH,
        baseSha: current.workspaceBaseSha,
        branch: recordedBranch,
        newBranch: actualBranch,
        worktreePath,
        alreadyBound: true,
        renamed: true,
        resume: true,
      },
      recovered: true,
    };
  }

  // Consistent state. ALL rejection conditions run before ANY state change: a
  // stale pending record (write-ahead journal whose Git side never happened) must
  // never be mutated by a rejected request.
  if (requestedName === recordedBranch) {
    throw workspaceError('room_workspace_branch_name_unchanged', 'New branch name must differ from the current branch', 400);
  }
  const preview = previewRoomWorkspaceRename({ conversation: current, project, branchName: requestedName });
  if (expectedFingerprint) {
    if (typeof fingerprintOf !== 'function') {
      throw new Error('A fingerprint function is required to authorize a workspace rename');
    }
    if (fingerprintOf(preview) !== String(expectedFingerprint)) {
      throw workspaceError(
        'room_workspace_authorization_stale',
        'Workspace preview changed; request a new authorization card',
        409
      );
    }
  }
  assertIdleForRename(Boolean(hasActiveExecution));

  // Write-ahead operation record: recovery can only resume an operation that was
  // durably recorded. Recording supersedes any stale pending journal row.
  const operation = recordWorkspaceOperation(store, conversationId, {
    kind: 'rename',
    oldBranch: preview.branch,
    newBranch: preview.newBranch,
    fingerprint: expectedFingerprint ? String(expectedFingerprint) : null,
  });
  try {
    // Rename the branch inside its own worktree: renaming a branch checked out in a
    // linked worktree from that worktree is always allowed and keeps HEAD, files and
    // the worktree directory untouched.
    git(preview.repositoryPath, ['-C', preview.worktreePath, 'branch', '-m', preview.branch, preview.newBranch]);
    const updated = renameBranchAndCloseOperation(store, conversationId, {
      oldBranch: preview.branch,
      newBranch: preview.newBranch,
      updatedAt: new Date().toISOString(),
    }, operation.id);
    return {
      conversation: updated,
      workspace: { ...preview, renamed: true },
      recovered: false,
    };
  } catch (error: any) {
    // Stage-aware compensation. The DB transaction is atomic, so any failure means
    // the database was NOT updated; only the Git side may need a rollback.
    let headAfter: string | null = null;
    try {
      headAfter = worktreeHeadBranch(preview.worktreePath);
    } catch {
      headAfter = null;
    }
    if (headAfter === preview.newBranch) {
      try {
        git(preview.repositoryPath, ['-C', preview.worktreePath, 'branch', '-m', preview.newBranch, preview.branch]);
        store.failWorkspaceOperation(operation.id, error && error.code);
      } catch {
        // The rollback itself failed: Git says the new name while the DB still
        // records the old one. Keep the operation record PENDING — it is exactly
        // the recovery handle the preview/authorization flow needs to finish the
        // operation later. Never mark it failed and lose that handle.
        throw workspaceError(
          'room_workspace_compensation_failed',
          `Rename to ${preview.newBranch} could not be persisted and the Git rollback also failed; ` +
            'the recorded operation stays pending and can be resumed through a new rename preview',
          500
        );
      }
    } else if (headAfter === preview.branch) {
      // The Git rename never took effect; close the write-ahead record as failed.
      store.failWorkspaceOperation(operation.id, error && error.code);
    }
    // Unknown Git state: keep the record pending for recorded recovery/manual checks.
    throw error;
  }
}

export function rollbackCreatedRoomWorkspace(binding: any) {
  if (!binding || binding.reused || !binding.repositoryPath || !binding.worktreePath || !binding.branch) {
    return;
  }
  try {
    execFileSync('git', ['worktree', 'remove', binding.worktreePath], {
      cwd: binding.repositoryPath,
      stdio: 'ignore',
    });
  } catch {}
  try {
    execFileSync('git', ['branch', '-D', binding.branch], {
      cwd: binding.repositoryPath,
      stdio: 'ignore',
    });
  } catch {}
}
