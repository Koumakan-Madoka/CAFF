import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE_BRANCH = 'develop';
const MAX_SLUG_LENGTH = 48;

function workspaceError(code: string, message: string, statusCode = 409) {
  const error: any = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.issues = [{ code, message }];
  return error;
}

function git(repoRoot: string, args: string[]) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
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

export function deriveRoomWorkspaceIdentity(conversation: any, project: any) {
  const repoRoot = repositoryRoot(project);
  const branch = `room/${conversationKey(conversation && conversation.id)}-${asciiSlug(conversation && conversation.title)}`;
  const worktreePath = path.join(path.dirname(repoRoot), 'worktrees', 'room', branch.slice('room/'.length));
  return { repoRoot, branch, worktreePath };
}

export function previewRoomWorkspace({ conversation, project }: any) {
  if (!conversation || !String(conversation.projectScopeId || '').trim()) {
    throw workspaceError('room_workspace_project_required', 'Room must have an immutable Project before workspace binding', 400);
  }
  if (String(project && project.id || '').trim() !== String(conversation.projectScopeId || '').trim()) {
    throw workspaceError('room_workspace_project_mismatch', 'Room Project does not match the workspace Project', 409);
  }
  const { repoRoot, branch, worktreePath } = deriveRoomWorkspaceIdentity(conversation, project);
  const hasAnyBinding = Boolean(conversation.branch || conversation.worktreePath || conversation.workspaceBaseSha);
  if (hasAnyBinding) {
    if (!conversation.branch || !conversation.worktreePath || !conversation.workspaceBaseSha) {
      throw workspaceError('room_workspace_binding_incomplete', 'Room workspace binding is incomplete');
    }
    return {
      conversationId: conversation.id,
      projectScopeId: conversation.projectScopeId,
      repositoryPath: repoRoot,
      baseBranch: BASE_BRANCH,
      baseSha: conversation.workspaceBaseSha,
      branch: conversation.branch,
      worktreePath: path.resolve(conversation.worktreePath),
      alreadyBound: true,
    };
  }
  if (!gitRefExists(repoRoot, `refs/heads/${BASE_BRANCH}`)) {
    throw workspaceError('room_workspace_base_missing', `Local ${BASE_BRANCH} branch does not exist`);
  }
  const baseSha = git(repoRoot, ['rev-parse', BASE_BRANCH]);
  return {
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

export function bindRoomWorkspace({ conversation, project }: any) {
  const preview = previewRoomWorkspace({ conversation, project });
  if (preview.alreadyBound) {
    return { ...preview, reused: true };
  }
  if (gitRefExists(preview.repositoryPath, `refs/heads/${preview.branch}`)) {
    throw workspaceError('room_workspace_branch_exists', `Branch ${preview.branch} already exists`);
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

export function bindAndPersistRoomWorkspace({ store, conversation, project, workspaceBoundAt }: any) {
  if (conversation.branch || conversation.worktreePath || conversation.workspaceBaseSha) {
    return {
      conversation,
      workspace: { ...previewRoomWorkspace({ conversation, project }), reused: true },
      created: false,
    };
  }

  const binding = bindRoomWorkspace({ conversation, project });
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
