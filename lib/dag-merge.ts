/**
 * dag-merge.ts — merge-node git mechanics for DAG execution (D11/D19).
 *
 * Responsibility split (dag-execution PRD):
 * - The MERGER AGENT performs the actual merges and conflict resolution
 *   inside its integration worktree (D10/D12/D26) — the scheduler spawns it
 *   with the branch order, verify command, and bounded-retry flow.
 * - THIS module provides the server-side mechanics around it:
 *   1. prepareMergeNodeWorktree — compute the upstream LCA and check out the
 *      integration branch (node.branch) from that LCA into the node's
 *      dedicated worktree (D11: LCA 检出， no octopus merges).
 *   2. verifyMergeOutcome — fail-closed post-check before a merge node may
 *      flip to done: every source branch must be an ancestor of the
 *      integration HEAD, and the node's verify command (D19) must pass.
 *
 * Like dag-worktree.ts this module is UI/store-free: it returns structured
 * results and lets the scheduler map failures onto node status.
 */

import { execFileSync, execSync } from 'node:child_process';
import { prepareNodeWorktree, type DagWorktreeResult } from './dag-worktree';

/** Same safety contract as dag-worktree: slashes allowed, no '..', no option-like args. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isSafeBranch(value: string): boolean {
  return SAFE_BRANCH.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/');
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

export type DagMergeLcaResult =
  | { ok: true; lca: string }
  | { ok: false; code: 'dag_merge_invalid_branch' | 'dag_merge_no_common_ancestor'; reason: string };

/**
 * Lowest common ancestor across ALL upstream branches (D11), computed
 * progressively: lca = merge-base(merge-base(b1, b2), b3)… For a single
 * branch the LCA is the branch tip itself.
 */
export function computeUpstreamLca(repoRoot: string, branches: string[]): DagMergeLcaResult {
  const normalized = branches.map((branch) => String(branch || '').trim()).filter(Boolean);
  if (normalized.length === 0) {
    return { ok: false, code: 'dag_merge_invalid_branch', reason: 'no upstream branches provided' };
  }
  for (const branch of normalized) {
    if (!isSafeBranch(branch)) {
      return { ok: false, code: 'dag_merge_invalid_branch', reason: `branch "${branch}" is empty or unsafe` };
    }
  }
  let lca = normalized[0];
  for (const branch of normalized.slice(1)) {
    try {
      lca = git(['merge-base', lca, branch], repoRoot);
    } catch {
      return {
        ok: false,
        code: 'dag_merge_no_common_ancestor',
        reason: `no common ancestor between "${lca}" and "${branch}" (unrelated histories or missing ref)`,
      };
    }
    if (!lca) {
      return {
        ok: false,
        code: 'dag_merge_no_common_ancestor',
        reason: `no common ancestor between upstream branches including "${branch}"`,
      };
    }
  }
  // Resolve to a concrete sha so later branch moves cannot shift the base.
  try {
    lca = git(['rev-parse', `${lca}^{commit}`], repoRoot);
  } catch {
    return { ok: false, code: 'dag_merge_invalid_branch', reason: `cannot resolve LCA ref "${lca}" to a commit` };
  }
  return { ok: true, lca };
}

export type PrepareMergeNodeWorktreeOptions = {
  repoRoot: string;
  planId: string;
  /** Merge node (needs id + branch; base_branch optionally overrides the LCA base). */
  node: { id: string; branch?: string; base_branch?: string };
  /** Upstream source branches in depends_on order. */
  upstreamBranches: string[];
};

/**
 * Prepare the integration worktree for a merge node: integration branch =
 * node.branch, created from the explicit base_branch when set, otherwise
 * from the upstream LCA (D11). Existing clean worktrees on the right branch
 * are reused (crash-retry safe); dirty/mismatched ones fail closed (D22).
 */
export function prepareMergeNodeWorktree(options: PrepareMergeNodeWorktreeOptions): DagWorktreeResult {
  const node = options.node || ({} as any);
  const branch = String(node.branch || '').trim();
  const explicitBase = String(node.base_branch || '').trim();
  let baseRef = explicitBase;
  if (!baseRef) {
    const lcaResult = computeUpstreamLca(options.repoRoot, options.upstreamBranches);
    if (!lcaResult.ok) {
      return { ok: false, code: 'dag_worktree_add_failed', reason: `merge base resolution failed: ${(lcaResult as { reason: string }).reason}` };
    }
    baseRef = lcaResult.lca;
  }
  return prepareNodeWorktree({
    repoRoot: options.repoRoot,
    planId: options.planId,
    nodeId: String(node.id || ''),
    branch,
    baseRef,
  });
}

export type VerifyMergeOutcomeOptions = {
  /** Integration worktree path (merge node cwd). */
  worktreePath: string;
  /** Source branches that must all be ancestors of the integration HEAD. */
  sourceBranches: string[];
  /** Optional verify command (D19), run via shell inside the worktree. */
  verifyCommand?: string;
  /** Verify command timeout in ms (default 120s, env CAFF_DAG_VERIFY_TIMEOUT_MS). */
  timeoutMs?: number;
};

export type VerifyMergeOutcomeResult = { ok: true } | { ok: false; reason: string };

/**
 * Fail-closed post-check for a completed merge node:
 * 1. every source branch must be fully merged into the integration HEAD
 *    (`git merge-base --is-ancestor`);
 * 2. the node verify command (when configured) must exit 0.
 */
export function verifyMergeOutcome(options: VerifyMergeOutcomeOptions): VerifyMergeOutcomeResult {
  const worktreePath = String(options.worktreePath || '').trim();
  if (!worktreePath) {
    return { ok: false, reason: 'no integration worktree path' };
  }
  for (const source of options.sourceBranches || []) {
    const branch = String(source || '').trim();
    if (!branch) {
      continue;
    }
    if (!isSafeBranch(branch)) {
      return { ok: false, reason: `source branch "${branch}" is unsafe to check` };
    }
    if (!gitOk(['merge-base', '--is-ancestor', branch, 'HEAD'], worktreePath)) {
      return { ok: false, reason: `source branch "${branch}" is not merged into the integration branch (D11)` };
    }
  }
  const verifyCommand = String(options.verifyCommand || '').trim();
  if (verifyCommand) {
    const timeoutMs = Number.isInteger(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? (options.timeoutMs as number)
      : Math.max(1000, Number.parseInt(String(process.env.CAFF_DAG_VERIFY_TIMEOUT_MS || '120000'), 10) || 120000);
    try {
      execSync(verifyCommand, { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    } catch (error: any) {
      const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
      return { ok: false, reason: `verify command failed (D19): ${detail.slice(0, 500) || 'non-zero exit'}` };
    }
  }
  return { ok: true };
}
