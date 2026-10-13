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

function branchUpstream(repoRoot: string, branch: string) {
  try {
    const upstream = execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return upstream || null;
  } catch {
    return null;
  }
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
    return [];
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
    return [];
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
      worktreePath: path.resolve(conversation.worktreePath),
      alreadyBound: true,
    };
  }
  const { repoRoot, branch, worktreePath } = deriveRoomWorkspaceIdentity(conversation, project, { branchName });
  if (!gitRefExists(repoRoot, `refs/heads/${BASE_BRANCH}`)) {
    throw workspaceError('room_workspace_base_missing', `Local ${BASE_BRANCH} branch does not exist`);
  }
  const baseSha = git(repoRoot, ['rev-parse', BASE_BRANCH]);
  return {
    kind: 'bind',
    conversationId: conversation.id,
    projectScopeId: conversation.projectScopeId,
    repositoryPath: repoRoot,
    baseBranch: BASE_BRANCH,
    baseSha,
    branch,
    worktreePath,
    alreadyBound: false,
  };
}

export function previewRoomWorkspaceRename({ conversation, project, branchName, hasActiveExecution = false }: any) {
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
    throw workspaceError(
      'room_workspace_state_mismatch',
      `Worktree is on Git branch ${actualBranch} but the Room binding records ${currentBranch}; ` +
        'retry the rename so the binding can be reconciled, or restore consistency manually'
    );
  }
  if (hasActiveExecution) {
    throw workspaceError(
      'room_workspace_execution_active',
      'Room has an active execution; rename is blocked until the current execution finishes'
    );
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

export function reconcileConversationWorkspaceBranch({ store, conversationId, project }: any) {
  const conversation = store.getConversationWithoutMessages(conversationId);
  if (!conversation || !conversation.branch || !conversation.worktreePath) {
    return { conversation, recovered: false };
  }
  const repoRoot = repositoryRoot(project);
  const worktreePath = path.resolve(String(conversation.worktreePath));
  if (!fs.existsSync(worktreePath)) {
    return { conversation, recovered: false };
  }
  let actualBranch = null;
  try {
    actualBranch = worktreeHeadBranch(worktreePath);
  } catch {
    return { conversation, recovered: false };
  }
  const recordedBranch = String(conversation.branch).trim();
  if (!actualBranch || actualBranch === recordedBranch) {
    return { conversation, recovered: false };
  }
  if (gitRefExists(repoRoot, `refs/heads/${recordedBranch}`)) {
    throw workspaceError(
      'room_workspace_state_mismatch',
      `Room binding records ${recordedBranch} but the worktree is on ${actualBranch}; ` +
        'both branch refs exist, so the state cannot be reconciled automatically. Reconcile it manually.'
    );
  }
  // A previous rename crashed between the Git rename and the database update: the
  // recorded branch ref is gone and the worktree already sits on the actual branch.
  // Heal the binding record with a conditional update so no half-finished state persists.
  const recovered = store.renameConversationWorkspaceBranch(conversationId, {
    oldBranch: recordedBranch,
    newBranch: actualBranch,
    updatedAt: new Date().toISOString(),
  });
  return { conversation: recovered, recovered: true };
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
  const reconciled = reconcileConversationWorkspaceBranch({
    store,
    conversationId: conversation && conversation.id,
    project,
  });
  const current = reconciled.conversation || conversation;
  const preview = previewRoomWorkspaceRename({
    conversation: current,
    project,
    branchName,
    hasActiveExecution,
  });
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
  // Rename the branch inside its own worktree: renaming a branch checked out in a
  // linked worktree from that worktree is always allowed and keeps HEAD, files and
  // the worktree directory untouched.
  git(preview.repositoryPath, ['-C', preview.worktreePath, 'branch', '-m', preview.branch, preview.newBranch]);
  try {
    const updated = store.renameConversationWorkspaceBranch(current.id, {
      oldBranch: preview.branch,
      newBranch: preview.newBranch,
      updatedAt: new Date().toISOString(),
    });
    return {
      conversation: updated,
      workspace: { ...preview, renamed: true },
      recovered: reconciled.recovered === true,
    };
  } catch (error) {
    // Compensate the Git rename so a persistence failure never leaves a
    // half-finished Git/database state behind.
    try {
      git(preview.repositoryPath, ['-C', preview.worktreePath, 'branch', '-m', preview.newBranch, preview.branch]);
    } catch {}
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
