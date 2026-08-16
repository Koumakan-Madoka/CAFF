# DAG Execution (Backend): Scheduler / Worktree / Merge Executor

## Scenario: DAG 执行层（第二阶段）

### 1. Scope / Trigger
- Trigger: implementing or modifying plan execution — node dispatch, child
  conversation spawn, per-node worktrees, merge execution, completion
  write-back, or restart reconcile.
- Applies when changes touch `server/domain/dag/dag-scheduler.ts`,
  `lib/dag-worktree.ts`, `lib/dag-merge.ts`, the DAG wiring block in
  `server/app/create-server.ts`, or `store.writePlanNodeExecution` /
  `cross-conversation-delivery.submitFromSystem`.
- PRD of record: `.trellis/tasks/dag-execution/prd.md` (decisions D21–D26,
  inheriting D10–D20 from dag-planning). Planning-side contracts (schema,
  lifecycle, actor model) live in `dag-planning.md`.
- Goal: activate a plan → in-degree-0 nodes dispatch into real per-node
  worktrees as child conversations → completion writes back `done + result`
  → downstream readiness propagates → merge nodes integrate source branches
  with fail-closed verification. All failure modes fail closed to `blocked`
  with a recorded reason.

### 2. Signatures
- `lib/dag-worktree.ts` (sync, shelling out to `git`):
  - `resolveDagWorktreePath(repoRoot, planId, nodeId) → string | null` —
    `.worktrees/dag/<plan-id前8位>/<node-id>/`; rejects empty/`..`/slash ids.
  - `prepareNodeWorktree({ repoRoot, planId, nodeId, branch, baseRef? }) →
    { ok: true, path, reused, branch } | { ok: false, code, error?/reason? }`
  - `isWorktreeDirty(worktreePath) → boolean` (untracked or modified files).
  - `removeDagWorktree(repoRoot, worktreePath, force?)`.
- `lib/dag-merge.ts`:
  - `computeUpstreamLca(repoRoot, branches[]) → { ok, lca?/code?, reason? }` —
    progressive `git merge-base` (b1∧b2∧b3…); single branch resolves to its tip.
  - `prepareMergeNodeWorktree({ repoRoot, planId, node:{id,branch,base_branch?}, upstreamBranches[] })`
    — integration branch checked out from explicit `base_branch` or the LCA.
  - `verifyMergeOutcome({ worktreePath, sourceBranches[], verifyCommand?, timeoutMs? })`
    — every source must be `merge-base --is-ancestor` of HEAD, then the verify
    command runs inside the worktree.
- `server/domain/dag/dag-scheduler.ts`:
  - `createDagScheduler({ store, broadcastEvent, prepareNodeWorktree,
    spawnNodeConversation, resumeNodeConversation, verifyNodeCompletion?,
    resolveWorktreePathForNode?, maxConcurrency?, logger? })`
  - `scheduler.handleEvent('conversation_plan_updated' | 'agent_slot_finished', payload)`
  - `scheduler.dispatchReadyNodes(ownerConversationId)` — manual flush (tests).
  - `scheduler.reconcileOnStartup()` — D25 restart recovery scan.
  - `scheduler.resolveConversationWorkdir(conversation)` — cwd hook backing
    `getProjectDir`: spawned children resolve to their node worktree.
- Store internal channel (`lib/chat-app-store.ts`):
  - `writePlanNodeExecution(conversationId, [{ nodeId, status, result?, spawnedConversationId? }], { reason? })`
    — system actor; may bind `spawned_conversation_id` (REST/tool cannot);
    same D16/D18 standards as user writes.

### 3. Contracts
- **Event-driven only (D21)**: the scheduler subscribes to
  `conversation_plan_updated` (activate / writes) and `agent_slot_finished`
  (child terminal). No polling, no standalone watcher. Per-owner write
  operations serialize on a promise chain; event re-entry converges
  idempotently.
- **Dispatch pipeline** per ready node (`pending` + all transitive upstreams
  `done`, subject to the concurrency cap):
  1. `prepareNodeWorktree` — dirty/mismatched/occupied → node `blocked` with
     the git reason (D22 fail-closed, never cleans user data);
  2. `spawnNodeConversation` — child hangs flat under the ROOT conversation
     (D13); `clientRequestId` idempotency key embeds `activatedAt` so a crash
     retry reuses the same child instead of double-spawning;
  3. bind `doing + spawned_conversation_id` via `writePlanNodeExecution`;
  4. **post-bind settle**: immediately re-check the child for a terminal DAG
     reply (shared predicate with reconcile). Closes the spawn→bind race where
     `agent_slot_finished` fired before the binding existed — without this the
     node would stick `doing` forever.
- **Initial message** (D23/D26): goal + upstream `result` summaries; merge
  nodes additionally get the ordered source branch list (`depends_on` order,
  D11), the verify command, and the D12 bounded-retry / `merge --abort`
  instructions.
- **Completion write-back**: only terminal assistant replies whose
  `metadata.triggeredByMessageId` references a scheduler-injected source
  message (`kind: 'conversation_spawn_initial_message'` or `dagResume: true`)
  settle a node — stray side-dispatches are ignored. Completed →
  `done + result` (≤2000 chars, D23); failed → `blocked` + reason.
- **Merge gating (D11/D19 fail-closed)**: merge nodes must pass
  `verifyNodeCompletion` BEFORE `done` is written; failure or exception →
  `blocked` with `dag_merge_verify_failed: <reason>`, downstream stays
  `pending` (D16). Work nodes never invoke the hook.
- **Concurrency (D24)**: global in-flight `doing` nodes ≤
  `CAFF_DAG_MAX_CONCURRENCY` (default 3). Surplus ready nodes stay `pending`
  (no `queued` enum, D17); freed slots refill FIFO in doc declaration order.
- **Restart reconcile (D25)**: `reconcileOnStartup()` scans active plans —
  - child finished while down → write back `done`/`blocked` and propagate;
  - child interrupted → resume by injecting into the ORIGINAL child
    conversation (no new spawn, context preserved), exactly once — the
    persisted `dag_resume` marker message is the durable attempt counter;
  - resume budget exhausted / orphan `doing` (no spawned conversation) /
    missing conversation / in-flight delivery pending → `blocked` with
    `dag_reconcile_*` reason (in-flight deliveries are skipped, not blocked).
- **Env keys**: `CAFF_DAG_MAX_CONCURRENCY` (default 3),
  `CAFF_DAG_VERIFY_TIMEOUT_MS` (verify command timeout, default 120000).
- **Repo root**: worktree/merge operations resolve against the owner
  conversation's project dir (`resolveProjectDirForScope`), never cwd.
- **Activate preflight**: draft→active is rejected with 409
  `plan_owner_project_unbound` when the owner conversation has no project
  scope binding — dispatch resolves the repo from it, so an unbound owner
  would otherwise fail-closed block every node with `dag_spawn_failed`.
  Revert is unaffected; the check lives in `transitionPlanStatus` keyed on
  `markActivatedAt`.
- `.worktrees/` is gitignored; registered-worktree detection uses the `.git`
  pointer file + `rev-parse` — `git -C <subdir>` alone would resolve to the
  parent repo for in-repo worktrees and cause false positives.

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| prepare | path absent, branch absent | `git worktree add -b` from baseRef/HEAD, `reused: false` |
| prepare | path absent, branch exists | `git worktree add` onto existing branch |
| prepare | registered worktree, clean, branch matches | reuse, `reused: true`, nothing touched |
| prepare | registered worktree dirty | `{ ok:false, code:'dag_worktree_dirty' }`, node → blocked, zero bytes touched |
| prepare | branch mismatch / path occupied by plain dir | `dag_worktree_branch_mismatch` / `dag_worktree_path_occupied` |
| prepare | branch checked out elsewhere | `dag_worktree_add_failed` (git stderr clipped to 500 chars) |
| activate | owner conversation not bound to a project | 409 `plan_owner_project_unbound`, plan stays `draft` |
| dispatch | node ready but cap reached | stays `pending`; refilled FIFO when a slot frees |
| spawn | spawn throws | node → `blocked`, reason `dag_spawn_failed: <msg>` |
| completion | slot event with unknown conversation / non-DAG source | ignored entirely |
| completion | merge node, verify verdict fail/throw | `blocked` + `dag_merge_verify_failed`, no `result` written |
| merge prepare | any upstream lacks `branch` | dispatch refused `dag_merge_missing_upstream_branch` |
| merge LCA | upstreams share no ancestor / unknown ref | fail closed, no worktree mutation |
| verify | source branch not ancestor of HEAD | `{ ok:false }` naming the branch |
| verify | verify command non-zero / timeout | `{ ok:false, reason }` with output clipped to 500 chars |
| reconcile | interrupted child, first attempt | resume into original conversation, marker persisted |
| reconcile | interrupted child, marker already present | `blocked` `dag_reconcile_resume_exhausted` (D25 once-only) |

### 5. Good / Base / Bad Cases
- Good (happy diamond): activate → n1 dispatches (worktree on `dag/n1`) →
  completes with result → n2/n3 dispatch (branched from `dag/n1` tip via
  `base_branch`, upstream result embedded) → both complete → m1 dispatches
  (integration branch from LCA) → merger merges both sources → verify passes
  → `done`. See `tests/dag/dag-execution-baseline.test.js` test 1.
- Base: server restarts mid-execution → reconcile writes back children that
  finished while down, resumes interrupted children once, leaves healthy
  in-flight work untouched.
- Bad: merger agent reports "done" without actually merging a source branch →
  `verifyMergeOutcome` ancestry check fails → node `blocked`; the agent's
  claim is never trusted without the mechanical post-check.

### 6. Tests Required
- `tests/dag/dag-worktree.test.js` (8): real temp-repo git integration —
  create/reuse/dirty-refuse/branch-mismatch/path-occupied/branch-conflict/
  id-injection guards.
- `tests/dag/dag-merge.test.js` (8): LCA correctness, explicit `base_branch`
  priority, orphan-branch fail-closed, ancestry gate, verify command output
  passthrough.
- `tests/dag/dag-scheduler.test.js` (18): dispatch+bind, D24 cap+FIFO refill,
  result propagation, spawn→bind race settle, failure→blocked+D16, dirty
  worktree fail-closed, spawn failure, stray events ignored, all D25
  reconcile branches, cwd hook, D26 instruction contents, merge gating
  pass/fail/throw.
- `tests/dag/dag-execution-baseline.test.js` (3): PRD §5 baselines 2–6
  end-to-end with REAL git (baseline 1 stays in
  `tests/ui/dag-planning-demo.test.js`).
- Assertion points: history lines (`pending->doing:dag_dispatch`,
  `doing->done:dag_node_completed`, `doing->blocked:<reason>`), resume
  targets the original conversation id, verify hook call count, downstream
  status while upstream blocked.

### 7. Wrong vs Correct
#### Wrong
```typescript
// Merger agent's final message says "merged successfully" → scheduler
// writes done immediately and downstream starts building on nothing.
```
#### Correct
```typescript
// Merge completion is always gated by the mechanical post-check:
const verdict = verifyNodeCompletion({ ownerConversationId, plan, node });
if (!verdict.ok) {
  return writeExecution(owner, [{ nodeId, status: 'blocked' }],
    `dag_merge_verify_failed: ${verdict.error}`); // downstream stays pending (D16)
}
```

#### Wrong
```typescript
// resolveConversationWorkdir: git -C .worktrees/dag/<p>/<n> rev-parse
// to decide whether the path is a registered worktree — resolves to the
// PARENT repo for in-repo worktrees → false positive, dirty check skipped.
```
#### Correct
```typescript
// Check the .git pointer FILE inside the candidate path first, then
// rev-parse -C on that path to confirm the branch. (lib/dag-worktree.ts)
```

### Open Design Question (recorded, not yet decided)
- Work-node branches default to the repo HEAD unless `base_branch` is set;
  only direct `depends_on` branches are merged at the merge node. Deep chains
  therefore need explicit `base_branch` on each hop (as the baseline test
  does) or transitive work is silently absent from the integration branch.
  Auto-defaulting `baseRef` to a parent branch is a candidate follow-up.
