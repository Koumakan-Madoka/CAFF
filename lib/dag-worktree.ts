/**
 * dag-worktree.ts — per-node git worktree management for DAG execution (D22).
 *
 * Contract (dag-execution PRD):
 * - Every plan node gets its own worktree at
 *   `.worktrees/dag/<plan-id first 8 chars>/<node-id>/` under the repo root.
 * - The node branch is checked out into that worktree; the spawned
 *   conversation agent uses it as cwd.
 * - Before spawn, if the worktree already exists and is dirty, or is
 *   checked out on the wrong branch, the caller must NOT clean it up —
 *   the node goes blocked with the reason recorded (fail-closed).
 *
 * This module is intentionally UI/store-free: it returns structured results
 * and lets the scheduler decide how to map failures onto node status.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Safe path/branch segment: no separators, no leading '-', no '..'. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Safe branch name: slashes allowed, no '..', no leading '-', no option-like args. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type DagWorktreeOk = {
  ok: true;
  /** Absolute path of the node worktree. */
  path: string;
  /** true when an existing clean worktree on the right branch was reused. */
  reused: boolean;
  branch: string;
};

export type DagWorktreeFailure = {
  ok: false;
  code:
    | 'dag_worktree_invalid_id'
    | 'dag_worktree_invalid_branch'
    | 'dag_worktree_path_occupied'
    | 'dag_worktree_branch_mismatch'
    | 'dag_worktree_dirty'
    | 'dag_worktree_add_failed';
  /** Human-readable reason, safe to persist into node history (D18). */
  reason: string;
  path?: string;
};

export type DagWorktreeResult = DagWorktreeOk | DagWorktreeFailure;

export type PrepareNodeWorktreeOptions = {
  /** Repo root the worktree belongs to (main checkout). */
  repoRoot: string;
  planId: string;
  nodeId: string;
  /** Branch the node works on. Created from baseRef when missing. */
  branch: string;
  /** Base ref for branch creation (default HEAD). Ignored when branch exists. */
  baseRef?: string;
};

function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && !value.includes('..');
}

/** `.worktrees/dag/<plan8>/<nodeId>` relative to repoRoot; null when ids are unsafe. */
export function resolveDagWorktreePath(repoRoot: string, planId: string, nodeId: string): string | null {
  const planKey = String(planId || '').slice(0, 8);
  if (!isSafeSegment(planKey) || !isSafeSegment(String(nodeId || ''))) return null;
  return path.join(repoRoot, '.worktrees', 'dag', planKey, nodeId);
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(args: string[], cwd: string): boolean {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

/** true when the worktree has uncommitted changes or untracked files. */
export function isWorktreeDirty(worktreePath: string): boolean {
  return git(['status', '--porcelain'], worktreePath) !== '';
}

/**
 * Ensure the node worktree exists, is on the expected branch, and is clean.
 * Existing dirty/mismatched/occupied paths are reported, never modified.
 */
export function prepareNodeWorktree(options: PrepareNodeWorktreeOptions): DagWorktreeResult {
  const { repoRoot, planId, nodeId } = options;
  const branch = String(options.branch || '').trim();
  const worktreePath = resolveDagWorktreePath(repoRoot, planId, nodeId);
  if (!worktreePath) {
    return {
      ok: false,
      code: 'dag_worktree_invalid_id',
      reason: `planId "${planId}" or nodeId "${nodeId}" is not safe for a worktree path`,
    };
  }
  if (!branch || !SAFE_BRANCH.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) {
    return {
      ok: false,
      code: 'dag_worktree_invalid_branch',
      reason: `branch "${options.branch}" is empty or unsafe`,
      path: worktreePath,
    };
  }

  if (fs.existsSync(worktreePath)) {
    // A registered git worktree always carries a `.git` *file* (gitdir pointer).
    // Plain subdirectories inside the parent repo must not be treated as reusable.
    if (!fs.existsSync(path.join(worktreePath, '.git')) || !gitOk(['rev-parse', '--is-inside-work-tree'], worktreePath)) {
      return {
        ok: false,
        code: 'dag_worktree_path_occupied',
        reason: `${worktreePath} exists but is not a git worktree; refusing to touch it`,
        path: worktreePath,
      };
    }
    const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    if (currentBranch !== branch) {
      return {
        ok: false,
        code: 'dag_worktree_branch_mismatch',
        reason: `worktree is on branch "${currentBranch}", expected "${branch}"`,
        path: worktreePath,
      };
    }
    if (isWorktreeDirty(worktreePath)) {
      return {
        ok: false,
        code: 'dag_worktree_dirty',
        reason: `worktree ${worktreePath} has uncommitted changes; not cleaning up automatically (D22)`,
        path: worktreePath,
      };
    }
    return { ok: true, path: worktreePath, reused: true, branch };
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const branchExists = gitOk(['show-ref', '--verify', `refs/heads/${branch}`], repoRoot);
  const args = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, options.baseRef || 'HEAD'];
  try {
    git(args, repoRoot);
  } catch (error: any) {
    const stderr = String(error?.stderr || error?.message || error);
    return {
      ok: false,
      code: 'dag_worktree_add_failed',
      reason: `git worktree add failed for branch "${branch}": ${stderr.slice(0, 500)}`,
      path: worktreePath,
    };
  }
  return { ok: true, path: worktreePath, reused: false, branch };
}

/** Remove a node worktree. Best-effort; returns false when git refuses. */
export function removeDagWorktree(repoRoot: string, worktreePath: string, force = false): boolean {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  return gitOk(args, repoRoot);
}
