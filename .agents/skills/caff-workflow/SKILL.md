---
name: caff-workflow
description: "Mandatory CAFF workflow for any task that may change repository files, configuration, data, processes, deployments, or external systems. Clarifies requirements, selects Direct/Goal/DAG mode, assigns an isolated room branch/worktree, enforces environment separation, and governs review, acceptance, release, and cleanup."
---

# CAFF Workflow

Use this skill before the first state-changing action. It is a procedural guardrail, not a technical security boundary. Never claim branch protection, port leases, or environment isolation unless verified.

## Non-negotiable gates

1. Do not change state until the user confirms shared understanding from the project-owned `grill-with-docs` protocol below.
2. Do not edit tracked files until the conversation owns one unique branch and worktree. Never implement in `main` or `develop`.
3. Do not start an instance until its port, `PI_SQLITE_PATH`, logs, credentials, and side effects are isolated.
4. Do not merge without checks, evidence, and a reviewer other than the author.
5. Do not publish anything except the exact user-accepted commit SHA.
6. Stop on conflicts, dirty or foreign worktrees, missing authorization, secrets, destructive cleanup, or unverifiable assumptions.

## Classify the room

- **Discussion**: read-only research or advice. No branch is required. Any requested write first transitions to Change with explicit user approval.
- **Change**: modifies tracked files, code, documentation, templates, or schemas. It requires a unique `room/<conversation-id-short>-<slug>` branch and worktree.
- **Operations**: only starts, stops, or observes an existing production or acceptance instance. Use its persistent worktree; do not modify tracked files. Confirm local ignored configuration before writing it. Any implementation work transitions to Change.

## Clarify with docs and choose execution mode

Run this project-owned `grill-with-docs` protocol; it is always available from this tracked Skill and does not depend on a local sandbox Skill:

1. Research repository/environment facts yourself; do not ask the user for facts you can inspect.
2. Build a design tree. In each round, ask the whole currently unblocked frontier, number every decision, and include a recommended answer with tradeoffs.
3. Establish the goal, non-goals, constraints, acceptance evidence, terminology, and unresolved decisions. Challenge vague terms and verify claims against code.
4. Recompute the frontier after each answer. Do not implement while any decision required for safe execution remains open.
5. Capture a glossary or ADR only when requested or genuinely useful; creating either is itself repository state change and waits for workspace binding.
6. Summarize the resulting shared understanding and obtain explicit user confirmation before the first state-changing action.

If an installed `grill-with-docs` Skill is discoverable, load it for richer guidance, but never stop merely because that optional local Skill is absent. A clear atomic request may close after one confirmation round; do not ask questions merely to increase the count.

Declare the mode and reason publicly:

- **Direct** only when the delivery is atomic, low-risk, sequential, has no open design choice or sensitive contract, and can be verified immediately.
- **Goal** when work needs persistent multi-step tracking, spans layers or acceptance items, is risky, or follows a complex root-cause chain but remains one sequential workflow. Get explicit user approval before creating the Goal.
- **DAG** when two or more worthwhile independent workflows have real dependency or merge edges, or separate workers/verifiers must produce an integrated result. Get explicit user approval before creating the DAG; each writable node owns a distinct branch/worktree.

Pause and obtain approval before `Direct -> Goal -> DAG` escalation. Explain any downgrade and preserve all accepted criteria.

## Execute the lifecycle

1. **Prepare**: read [references/git-and-worktrees.md](references/git-and-worktrees.md), inspect branch/worktree/status, then allocate the workspace. Ordinary rooms start from current `develop`; production hotfixes start from `main`.
2. **Implement**: load applicable project skills/specs. Keep the scope confirmed by the user. For bugs: reproduce, inspect logs and call chain, confirm root cause, create red evidence, then fix.
3. **Verify**: run applicable lint, type, test, build, and manual checks. Record commands and results; never describe an unrun check as passed.
4. **Review and integrate**: follow [references/checklists.md](references/checklists.md). Use PR or an explicitly recorded equivalent, independent review, and `--no-ff` merge from `room/*` to `develop`. No squash or rebase-merge.
5. **Accept**: read [references/environments.md](references/environments.md). Validate `develop@candidate_sha` in the isolated acceptance instance. Only the user's explicit approval promotes it to `accepted_sha`; later commits invalidate that conclusion for the new SHA.
6. **Release**: create an immutable `release/*` pointer at `accepted_sha`, then PR it to `main`. Release timing remains the user's choice. Tag the published commit and synchronize `main` back into `develop`.
7. **Clean up**: keep the room worktree through acceptance. It may be removed after `accepted_sha`; retain the branch until release reaches `main`. Require user confirmation for abandoned work and never force-delete dirty, unpushed, or mounted work.

## Acceptance failures and hotfixes

Fix acceptance bugs on the original room branch and merge again to produce a new candidate. Restore a mistakenly removed room worktree instead of inventing a new lineage. Revert the room merge from `develop` if it blocks other acceptance work.

A production incident uses `hotfix/<conversation-id-short>-<slug>` from `main`, with isolated worktree, tests, and independent review. Merge it to `main`, release it, then synchronize it into `develop`. Never label an acceptance bug as a hotfix.

Use the templates and stop conditions in [references/checklists.md](references/checklists.md) for every handoff, acceptance, and release.
