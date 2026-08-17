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
    deliverVerificationRequest?, resolveWorktreePathForNode?, maxConcurrency?,
    logger? })`
  - `scheduler.handleEvent('conversation_plan_updated' | 'agent_slot_finished'
    | 'conversation_goal_proposal_updated' | 'conversation_goal_proposal_cleared', payload)`
  - `scheduler.dispatchReadyNodes(ownerConversationId)` — manual flush (tests).
  - `scheduler.reconcileOnStartup()` — D25 restart recovery scan.
  - `scheduler.resolveConversationWorkdir(conversation)` — cwd hook backing
    `getProjectDir`: spawned children resolve to their node worktree.
- Store internal channel (`lib/chat-app-store.ts`):
  - `writePlanNodeExecution(conversationId, [{ nodeId, status, result?, spawnedConversationId? }], { reason? })`
    — system actor; may bind `spawned_conversation_id` (REST/tool cannot);
    same D16/D18 standards as user writes.
- Agent tool bridge (`server/domain/runtime/agent-tool-bridge.ts`):
  - `suggest-goal --action accept|reject` (D28) rules on the PENDING proposal
    instead of creating one; broadcasts `conversation_goal_proposal_cleared`
    with `{ outcome, reason, ruledBy, proposal }` (the pre-clear snapshot).
    The proposer can never rule on their own proposal → 403
    `goal_proposal_self_review`.
  - **D28 binding enforcement** (review hardening): when the conversation
    metadata carries `dagNodeGoalBinding` (written by the scheduler at
    dispatch, see `server/domain/conversation/dag-goal-binding.ts`), the
    bridge additionally fails closed:
    - `complete` proposals from any agent ≠ `binding.workerId` → 403
      `dag_completion_worker_only` (only the node worker declares done);
    - `accept`/`reject` from any agent ≠ `binding.verifierId` → 403
      `dag_verifier_only` (a third participant cannot hijack the ruling;
      "not the proposer" alone is NOT sufficient);
    - ANY other agent proposal action (`set`/`pause`/`resume`/`clear`) on a
      bound conversation → 403 `dag_goal_mutation_forbidden` — agents may
      only drive the completion protocol, never mutate the goal itself.
  - **Binding-authoritative routing**: `getDagNodeExecutionContext(store,
    conversationId)` resolves the live doing-node context (active plan +
    node doing + spawned id match); `isDagBoundGoalMutationAllowed(action)`
    is the shared whitelist (`get`, `update-checklist`, `accept-proposal`,
    `dismiss-proposal`). The scheduler routes/verifies against the
    persisted binding (not participant-order recomputation), so the bridge
    and scheduler can never disagree after a participant rearrange.
  - **Durable ruling identity**: `sessionGoalRuling.proposalId` must be
    present and exactly equal `sessionGoalRuling.proposalSnapshot.id`;
    malformed/mismatched records normalize to `null`, so scheduler settle and
    reconcile fail closed instead of accepting an unrelated proposal snapshot.
    Checklist-only goal updates preserve this ruling record; replacing or
    clearing the goal starts a new epoch and removes stale ruling evidence.
- Goal REST API (`server/api/conversations-controller.ts`): while
  `getDagNodeExecutionContext` reports a doing node, POST actions outside
  the whitelist → 403 `dag_goal_mutation_forbidden` (direct complete/clear/
  set/pause/resume would bypass the worker→verifier protocol). User
  accept/dismiss broadcasts `conversation_goal_proposal_cleared` with the
  pre-clear proposal snapshot (`clearedProposal`), `outcome`, and
  `ruledBy: { kind: 'user' }` — the scheduler derives the node result from
  the snapshot and treats an explicit user ruling as a legitimate manual
  verification path.

### 3. Contracts
- **Event-driven only (D21)**: the scheduler subscribes to
  `conversation_plan_updated` (activate / writes) and `agent_slot_finished`
  (child terminal). No polling, no standalone watcher. Per-owner write
  operations serialize on a promise chain; event re-entry converges
  idempotently.
- **Dispatch pipeline** per ready node (`pending` + all transitive upstreams
  `done`, subject to the concurrency cap):
  0. **verifier resolution (D28, before ANY side effect)** — explicit
     `node.verifier` must be a root-conversation participant and ≠ the worker
     (first participant); invalid → `blocked` `dag_verifier_invalid`,
     self-review → `blocked` `dag_verifier_self_review`. Unspecified → first
     participant ≠ worker; single-agent owner → no verifier (auto-accept).
  1. `prepareNodeWorktree` — dirty/mismatched/occupied → node `blocked` with
     the git reason (D22 fail-closed, never cleans user data);
  2. `spawnNodeConversation` — child hangs flat under the ROOT conversation
     (D13); `clientRequestId` idempotency key embeds `activatedAt` so a crash
     retry reuses the same child instead of double-spawning;
  3. **session goal set (D27)** — lightweight goal on the child BEFORE the
     doing binding: objective = node goal + completion protocol, explicit
     EMPTY checklist (the heavy session-level default checklist is never
     inherited). Re-dispatch never clobbers an existing goal. Init failure →
     `blocked` `dag_goal_init_failed` (fail-closed: no goal = no sustained
     drive, no completion protocol);
  3.5 **goal binding written (D28 enforcement anchor)** —
     `metadata.dagNodeGoalBinding = { planId, nodeId, workerId, verifierId }`
     on the child conversation (idempotent, first write wins; also repaired
     on re-dispatch after a crash window). The bridge reads this binding to
     403 non-worker completions and non-verifier rulings. Write failure →
     `blocked` `dag_goal_binding_failed`;
  4. bind `doing + spawned_conversation_id` via `writePlanNodeExecution`;
  5. **post-bind settle**: immediately re-check the child's goal state
     (shared predicate with reconcile). Closes the spawn→bind race where the
     goal reached a terminal state before the binding existed.
- **Initial message** (D23/D26): goal + upstream `result` summaries; merge
  nodes additionally get the ordered source branch list (`depends_on` order,
  D11), the verify command, and the D12 bounded-retry / `merge --abort`
  instructions.
- **Completion protocol (D27/D28)**: a finished turn NEVER completes a
  goal-driven node. The worker announces completion via
  `suggest-goal --action complete --reason "<result summary>"`; the
  scheduler observes `conversation_goal_proposal_updated` and routes the
  pending proposal:
  - verifier present → verification request delivered to the verifier
    participant (idempotent per proposal: node goal + result summary +
    worktree path + verify command + git diff guidance); verifier rules via
    `suggest-goal --action accept|reject` (bridge blocks self-ruling, 403);
  - accept → goal complete → `done + result` (reason string, ≤2000 chars,
    D23), merge nodes still pass `verifyNodeCompletion` first;
  - reject → proposal dismissed, verifier feedback delivered back to the
    worker, goal stays active and continuation re-drives — unbounded rounds
    (goal budget + conversation depth are the backstop);
  - no verifier (single-agent owner) → scheduler auto-accepts in-store and
    settles immediately;
  - goal-runner budget pause proposal → `blocked`
    `dag_goal_budget_exhausted`;
  - **ruling identity is machine-checked, not prompt-checked**: the bridge
    enforces worker-only completion and verifier-only rulings against the
    dispatch-time binding (403 pre-mutation); the scheduler re-verifies
    `ruledBy` on the cleared event — BOTH accepts and rejects — via
    `resolveRulingAuthority` (binding-authoritative, participant-order
    fallback for legacy children) + `isCompletionRulingAllowed`. Bound node
    with a verifier: only that verifier agent or the user. Bound exempt
    node (`verifierId: null`): NO agent ruling is accepted — only the
    scheduler auto-accept marker (`ruledBy.agentId==='dag-scheduler'`,
    accept path) or the user (`ruledBy.kind==='user'`); a principal-less
    or third-agent event is ignored as forged. Legacy (no binding) keeps
    the tolerant contract. The user accepting/dismissing in the UI is a
    legitimate manual ruling and the node result is taken from the cleared
    proposal snapshot.
  - verification-request / rejection-feedback idempotency keys are stamped
    with `proposal.id` (`prop_${randomUUID()}`, unique per proposal and
    preserved by normalization); `createdAt` has only millisecond resolution
    and two proposals in the same ms would collide and dedup-suppress the
    round-2 verification request.
- **Failure write-back**: `agent_slot_finished` with a failed status still
  flips `blocked` + reason; a COMPLETED slot only settles children with NO
  binding and no goal (legacy pre-D27 fallback) — with a goal active it
  defers to the goal state, and a bound child whose goal vanished fails
  closed `blocked` `dag_goal_missing` (the completion protocol is
  unrecoverable; never fall back to the verifier-bypassing legacy path).
  Only scheduler-injected source messages count; stray side dispatches are
  ignored.
- **Scheduler-delivery terminal-failure guard**: subscribes to
  `cross_conversation_delivery_updated`; a scheduler delivery reaching
  terminal `dispatchStatus` `failed` OR `cancelled` → `blocked`
  `dag_delivery_failed`. Trust boundary (the idempotency key is
  model-controllable for agent submissions, so the key alone proves
  nothing):
  - ownership requires the persisted authoritative fields:
    `principalKind === 'operator'`, exact scheduler scope
    (`operator:<owner>:conversation_spawn` or
    `system:<owner>:conversation_notify`), `sourceConversationId` = plan
    owner, `targetConversationId` = the node's current spawned child;
  - the key must equal one of the node's CURRENT-cycle keys: spawn/resume
    keys embed `activatedAt`; verification-request keys embed the pending
    complete-proposal stamp; rejection-feedback keys (namespace
    `dag-verify:<plan>:<node>:feedback:<stamp>`) outlive their cleared
    proposal and are current only while they are the LATEST persisted
    `dag_verify_feedback` message (`dagDeliveryKey` metadata) AND no newer
    complete proposal is pending (a re-announcement supersedes the
    feedback). Stale activations / earlier proposal rounds never block the
    current execution;
  - synchronous persist/validation failures of verification requests and
    rejection feedback also fail closed to `blocked` `dag_delivery_failed`
    (an unpersisted delivery has no retry path and would idle the node);
  - the direct-dispatch wiring (`isDagSchedulerDelivery` in
    `create-server.ts`) applies the same principal check, so a forged
    agent delivery with a `dag-*` key falls back to the serial drain
    instead of hijacking the parallel path.
- **Merge gating (D11/D19 fail-closed)**: merge nodes must pass
  `verifyNodeCompletion` BEFORE `done` is written; failure or exception →
  `blocked` with `dag_merge_verify_failed: <reason>`, downstream stays
  `pending` (D16). Work nodes never invoke the hook.
- **Concurrency (D24)**: global in-flight `doing` nodes ≤
  `CAFF_DAG_MAX_CONCURRENCY` (default 3). Surplus ready nodes stay `pending`
  (no `queued` enum, D17); freed slots refill FIFO in doc declaration order.
- **Restart reconcile (D25)**: `reconcileOnStartup()` scans active plans —
  - goal state is the source of truth for goal-driven children: goal
    complete → `done`; budget-exhausted pause proposal → `blocked`; pending
    complete proposal → verification (re-)routed idempotently;
  - goal-less child finished while down → legacy terminal-reply write-back
    and propagate;
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
| dispatch | explicit verifier not a participant / == worker | `blocked` `dag_verifier_invalid` / `dag_verifier_self_review`, zero side effects |
| dispatch | session goal init throws | `blocked` `dag_goal_init_failed` (spawned id bound for forensics) |
| completion | slot event with unknown conversation / non-DAG source | ignored entirely |
| completion | completed slot, goal active, no proposal | no-op — continuation drives on (D27) |
| completion | goal-runner budget pause proposal | `blocked` `dag_goal_budget_exhausted` |
| completion | complete proposal proposedBy ≠ worker | `blocked` `dag_completion_wrong_proposer` (bridge 403s at creation; scheduler defense-in-depth) |
| completion | accepted ruling by agent ≠ verifier | ignored (forged event); only `ruledBy.kind==='user'` / `dag-scheduler` auto-accept / designated verifier (binding-authoritative) may settle |
| completion | accepted ruling with NO principal on a bound exempt (`verifierId: null`) node | ignored — exempt nodes settle only via scheduler auto-accept or user ruling |
| completion | durable ruling `proposalId` missing or ≠ `proposalSnapshot.id` | ruling rejected; bound complete goal → blocked `dag_goal_completion_unverified` |
| completion | rejected ruling by agent ≠ verifier (or any agent on a bound exempt node) | ignored — no bogus feedback injected; only the designated verifier or the user may reject |
| completion | bound child conversation lost its session goal | `blocked` `dag_goal_missing` — legacy terminal-reply fallback is binding-gated, never verifier-bypassing |
| delivery | scheduler delivery reaches terminal `failed`/`cancelled` with authoritative ownership fields + current-cycle key | `blocked` `dag_delivery_failed` — never strands a node `doing` |
| delivery | agent-principal delivery with forged `dag-*` key / wrong scope / wrong target / stale activation or proposal round | ignored entirely |
| delivery | verification request / rejection feedback persist throws synchronously | `blocked` `dag_delivery_failed` (no retry path exists for unpersisted deliveries) |
| verification | verifier routing but no delivery channel wired | `blocked` `dag_verify_unavailable` |
| goal REST | DAG-bound doing node: POST `complete`/`clear`/`set`/`pause`/`resume` | 403 `dag_goal_mutation_forbidden`; only `get`/`update-checklist`/`accept-proposal`/`dismiss-proposal` allowed |
| goal REST | binding present but node not doing (done/blocked) | unrestricted — post-execution cleanup stays possible |
| bridge | proposer accepts/rejects own proposal | 403 `goal_proposal_self_review` |
| bridge | DAG-bound goal: non-worker proposes complete | 403 `dag_completion_worker_only` |
| bridge | DAG-bound goal: non-verifier accepts/rejects | 403 `dag_verifier_only` |
| bridge | DAG-bound goal: agent proposes set/pause/resume/clear | 403 `dag_goal_mutation_forbidden` (worker and verifier alike) |
| bridge | accept/reject with no pending proposal | 404 |
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
- `tests/dag/dag-scheduler.test.js` (46): dispatch+bind, D24 cap+FIFO refill,
  result propagation, spawn→bind race settle, failure→blocked+D16, dirty
  worktree fail-closed, spawn failure, stray events ignored, all D25
  reconcile branches, cwd hook, D26 instruction contents, merge gating
  pass/fail/throw, D27 lightweight goal (empty checklist, objective teaches
  the completion protocol, budget→blocked), D28 verifier flow
  (routing/accept/reject feedback/default resolution/self-review & invalid
  verifier fail-closed/wrong-proposer blocked/forged accept ignored/user
  manual accept with snapshot result), binding write failure, delivery
  guard (terminal failed+cancelled → blocked, forged agent principal /
  wrong scope / wrong target / stale activation / stale proposal round
  ignored, current-cycle feedback failure blocked, sync persist failure
  blocked), `dag_goal_missing` fail-closed.
- `tests/http/conversation-goal-dag-guard.test.js` (3): REST goal mutation
  lock for DAG-bound doing nodes (403 matrix), proposal ruling + checklist
  whitelist with user ruledBy snapshot, post-execution unrestricted
  cleanup.
- `tests/dag/dag-execution-baseline.test.js` (3): PRD §5 baselines 2–6
  end-to-end with REAL git (baseline 1 stays in
  `tests/ui/dag-planning-demo.test.js`); completion driven by D27 goal
  proposals (single-agent owner → auto-accept path).
- Assertion points: history lines (`pending->doing:dag_dispatch`,
  `doing->done:dag_goal_completed`, `doing->blocked:<reason>`), resume
  targets the original conversation id, verify hook call count, downstream
  status while upstream blocked, verifier delivery `targetAgentId`,
  rejection feedback re-entering the worker.

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
