# Session Goal

## Scope

This contract applies to Goal metadata, `/api/conversations/:id/goal`, Goal prompt
projection, Agent Goal tools, Goal Runner continuation, the Goal drawer, DAG
child Goal bindings, and planner-driven Goals. The authenticated HTTP surface,
credential protection, attention lifecycle, retry rules and bounded monitoring
schemas are specified in [External Planner Interface](planner-interface.md)
([ADR 0002](../../decisions/0002-external-planner-drives-caff.md)).

A Goal is CAFF's durable delivery contract. It is not a checklist wrapper and it
does not depend on a PRD, ticket, task JSONL ledger, or project-local task
pointer.

## Data Model

`conversation.metadata.sessionGoal` contains:

```ts
{
  goalId: string;
  revision: number;
  objective: string;
  status: 'active' | 'paused' | 'complete';
  owner?: { agentId: string; agentName: string };
  decisions: {
    committed: Decision[];
    provisional: Decision[];
    openQuestions: Question[];
    nonGoals: Decision[];
    rejectedOptions: RejectedOption[];
  };
  acceptanceCriteria: Array<{
    id: string;
    statement: string;
    verifyBy: string;
    status: 'pending' | 'passed' | 'failed' | 'waived';
    risk: 'normal' | 'high';
    evidenceRefs: string[];
    waiver?: { reason: string; waivedBy?: string; waivedAt: string };
    createdAt: string;
    updatedAt: string;
  }>;
  workItems: Array<{
    id: string;
    text: string;
    status: 'todo' | 'in_progress' | 'done';
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
  }>;
  evidence: Array<{
    id: string;
    criterionIds: string[];
    kind: 'command' | 'test' | 'manual' | 'review' | 'artifact';
    summary: string;
    reference?: string;
    recordedBy?: string;
    recordedAt: string;
  }>;
  changeNotices?: GoalChangeNotice[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

Every Goal has a stable `goalId` and a positive integer `revision`. Factual and
lifecycle mutations retain the ID and increment the revision. A replacement
`set` creates a new ID at revision 1. Legacy checklist-only Goals normalize the
checklist into `workItems`; normalization never invents acceptance criteria.

Companion metadata holds `sessionGoalProposal`, `sessionGoalRuling` (the latest
ruling), `sessionGoalRunner`, and optional `sessionGoalPlannerBinding`. SQLite
`chat_goal_rulings` is the immutable, append-only ruling archive; attention is
stored separately, not as an ever-growing metadata array. Generic Room PUT
preserves server-owned `sessionGoal*` and `dagNodeGoalBinding` keys and rejects
explicit changes with `403 goal_metadata_reserved`.

## Delivery Rules

- Goal creation requires at least one observable acceptance criterion.
- Every criterion requires a non-empty `verifyBy` description.
- Work-item completion reports progress only. It never proves acceptance.
- Evidence is the proof behind criterion status, not a progress or history log.
  Add or replace an entry only when a criterion status changes or a milestone
  needs proof, and replace superseded entries instead of appending. Intermediate
  progress, test counts, and remaining-work lists belong in repository docs or
  replies. Keep summaries concise and criterion references valid.
- Independent code review follows milestones. Agents request one formal review
  when a work item is ready to be marked done or a change is ready to integrate,
  not for intermediate commits, unless the user explicitly asks. Blocking findings
  get a re-review of the fix only; non-blocking findings are recorded without
  another review round. Intermediate commits run targeted checks; the full
  applicable checks run once before the milestone review.
- A passed criterion must reference evidence which links back to that criterion.
- Evidence and criterion references must resolve, and IDs must be non-empty and
  unique within each collection.
- Completion is rejected until every criterion is `passed` or `waived`.
- A factual `update-delivery` and a direct user `revise` must carry the current
  Goal revision. Missing revisions return `400 goal_revision_required`; stale
  writes return `409 goal_revision_conflict` before metadata changes.
- Factual updates may change work status, criterion status, and evidence. They
  may not change the objective, decisions, criterion definitions, or work-item
  definitions; those require a reviewed `revise` proposal.

## Merge, Proposal Loss And Audit

`revise` and factual `update-delivery` merge before normalization. Omitted
objective, decision groups, criteria, work items and evidence retain their
previous values. An explicit array replaces that collection (`[]` clears it
only where validation permits); include every ID to retain. Known-ID records
preserve omitted properties, including status, risk, proof links and timestamps.
`null`, wrong types and blank required text return `400 goal_patch_invalid`.
Changed criterion definitions need explicit acceptance state/proof fields
(`400 goal_acceptance_state_required`); factual updates still cannot change
structural definitions or introduce waivers. Complete old-client payloads
retain their explicit collection-replacement behavior.

`set`, `revise`, `pause`, `resume` and `complete` encountering a pending proposal
return `409 goal_proposal_pending` without changes. Only literal
`supersedeProposal: true` authorizes supersession; supply the displayed
`proposalId` to protect against a replacement race. Explicit clear also archives
a pending proposal. A successful supersession writes its original full snapshot,
authenticated principal, reason, time, occurrence Goal identity and superseding
action as an `outcome: 'superseded'` ruling in the same transaction. Rejected or
failed operations produce no supersession audit. Agent technical draft
replacement also archives the previous proposal and the new proposal ID in that
transaction; it grants no accept/reject authority.

Lifecycle/factual updates preserve the latest ruling. Replacement set may clear
the old epoch's live ruling projection (not its archive); accepted/superseding
set installs its new ruling. Clear removes live metadata but retains history.
An unchanged projection is not re-appended during unrelated Room updates.
Legacy snapshot conflicts emit a sanitized `goal_ruling_legacy_conflict`
diagnostic and retain the immutable archive instead of freezing title/roster
updates or startup. New/changed ruling conflicts and SQLite failures remain
strict and roll back the whole write. Startup archives recognized old rulings
idempotently without inventing attribution. Room deletion may delete history;
there is no automatic pruning.

## Review And Decision Gates

On unbound Goals, agent-proposed actions remain pending until the user, an
authenticated planner, or a participant other than the proposer rules on them.
The proposer cannot review its own proposal. Planner-bound and DAG Goals narrow
this authority as described below. The durable ruling, proposal snapshot and
attention resolution are written in the same transaction as the Goal mutation.

A normal-risk waiver requires a reviewed revision. Only a server-derived
`kind: 'user'` may accept a high-risk waiver or change/remove a committed
decision with `adrPath`; planners, agents and legacy/system identities do not
pass either gate. Non-users also cannot downgrade/delete high-risk criteria or
drop them through replacement/clear while the previous Goal is unfinished
(`403 goal_high_risk_change_user_required`). Retiring an already complete Goal
with `set`/`clear` is exempt from that removal check, but not from the ADR gate
or new-waiver checks; `revise` remains protected. Planner-attested user approval
under ADR 0002 never substitutes for these direct-user gates.

Changing or removing a provisional decision requires a reason and impact before
the proposal can be created. Acceptance appends a durable
`provisional_decision_changed` notice containing the previous and next value,
reason, impact, affected work items, reviewer, and timestamp. The controller
broadcasts the notice as `conversation_goal_change_notice`.

Long-lived cross-task decisions are recorded under `docs/decisions/` after Goal
approval. Goal metadata remains the runtime delivery authority; ADRs preserve
accepted architecture rationale.

## API And Tools

- `GET /api/conversations/:conversationId/goal` returns normalized Goal,
  proposal, ruling, and runner projections without hydrating messages.
- `POST /api/conversations/:conversationId/goal` accepts `set`, `revise`,
  `pause`, `resume`, `complete`, `clear`, `set-owner`, `bind-planner`,
  `update-delivery`, `accept-proposal`, and `dismiss-proposal`.
- `set` accepts `owner: { agentId }` and initial `status: 'active' | 'paused'`
  (default active). Resolve the name from a currently routable Room participant
  and its selected runtime profile; invalid/unavailable owners return
  `400 goal_owner_invalid`. Paused creation schedules no continuation; active
  creation routes its first continuation to the persisted owner. Pending set
  proposals store `initialStatus` separately from their pending status and
  revalidate owner availability at acceptance. Legacy agent set proposals
  default owner to the proposer; direct set without owner keeps default routing.
- The REST endpoint derives identity from authentication, ignoring body claims:
  browser rulings are `ruledBy.kind: 'user'`; valid bearer rulings are
  `kind: 'planner'` with configured ID/name. Browser writes require Host,
  same-origin Origin, JSON Content-Type and CSRF. Invalid planner intent returns
  401, never user fallback; see [controller guards](controller-patterns.md).
- Every planner Goal write requires matching `goalId` and `goalRevision`.
  No live Goal permits null/0 for initial set and pending-proposal operations;
  rulings/supersession also require the matching `proposalId`. Missing/invalid
  revisions return 400; stale identity/revision or proposal returns 409. Read
  again before choosing a new action, never blindly replay at a fresh revision.
- Planner writes return lean `{ conversationId, goal, proposal, ruling, cleared,
  autoContinuation }`, not Room history/runtime. GET retains its compatible
  browser envelope with complete contract records but empty messages/previews;
  it never hydrates message bodies. Monitoring summaries are not complete Goals.
- `suggest-goal` creates or rules on a pending proposal. It does not silently
  mutate structural Goal content.
- `update-goal` submits factual delivery state and must include `goalRevision`
  (or `revision`) in its Goal JSON. Agents call it only when a work-item or
  criterion status changes or a milestone needs proof. Every accepted update
  increments the revision, so the next Goal Runner continuation cannot resume
  the previous provider session (`goal_revision_mismatch`; see
  [agent session reuse](../runtime/agent-session-reuse.md)).
- `propose-plan` owns DAG planning. Goal tools do not create ticket or task
  intermediates.

Production stores must use bounded conversation header reads and metadata-only
writes. Missing bounded projections fail closed with `501`; production code
must not fall back to full conversation hydration.

## Planner Binding

Planner direct set or planner acceptance of a set binds the new Goal using
`sessionGoalPlannerBinding = { goalId, plannerId, plannerName, boundAt }`.
A user can request `plannerDriven: true` on set/accept-set. Reads and factual
writes never implicitly adopt an existing Goal. Legacy Goals stay unbound.

User-only `bind-planner` adopts an existing unbound, non-DAG Goal with matching
ID/revision and a nonblank reason. It preserves content, owner, status, latest
ruling and runner counters, increments revision, and records the user's adoption
reason/time. It neither creates a new Goal nor enqueues/resets a runner cycle.
A pending proposal must be ruled on first (409, no supersede shortcut).

Binding presence is the enforcement anchor: malformed, stale or conflicting
bindings fail closed. Every in-room agent's accept/reject returns
`403 goal_planner_ruling_required` before self-review checks; the matching
planner and user may rule. Binding survives lifecycle/owner changes, restart and
credential rotation, and retires with its Goal. Native DAG binding takes
precedence: no planner adoption or planner-as-verifier/user bypass is allowed.

## Goal Runner

Active Goals may auto-continue only while the conversation is idle, no user work
is queued, no delegation or proposal is pending, and the owner remains a current
participant. Owner removal pauses fail closed instead of routing to another
Agent.

Runner state is stored in `sessionGoalRunner`. Factual updates for the same
Goal increment revision and migrate the runner epoch key in the same metadata
write, preserving iteration and failure streak state. P1 retains fresh-session
behavior on every revision change, even status-only updates or rulings; it adds
no Goal-delta/session-reuse exception.

### Dual failure circuit breakers

Each qualifying failure turn (a Goal auto-continuation whose reply failures are
all `eligible` provider, timeout, or process-exit invocation failures) carries a
bounded failure-mode label: structured network codes from an explicit whitelist
(`ECONNRESET`/`ECONNREFUSED`/`ETIMEDOUT`/`ENOTFOUND`/`EAI_AGAIN` plus the
connection-layer `UND_ERR_*` codes) and `fetch failed` map to
`provider:network`; anchored leading indicators of the redacted summary (only
the first 200 characters participate) map to rate-limited, auth, forbidden,
server-error, stream-read, or quota modes; timeouts split by code; known
termination signals group as `process_exit:signal`. Anything else maps to a
`*:other` label, which is never streak-eligible. The raw error text is never
stored in the mode, and `kind`/`code`/`eligible` semantics are unchanged.

Two persistent counters guard auto-continuation, with no duration or
time-window gates:

- **Same-mode streak**: pauses the Goal after
  `CAFF_SESSION_GOAL_FAILURE_THRESHOLD` (default 3, minimum 2) consecutive
  same-mode failure turns. A turn counts toward the streak only when every
  failure in it maps to one identical non-`:other` mode; a mode switch resets
  only this streak. Unknown or mixed turns break the streak.
- **Total streak**: pauses after `CAFF_SESSION_GOAL_TOTAL_FAILURE_THRESHOLD`
  (default 5, clamped to at least the same-mode threshold) consecutive
  qualifying failure turns regardless of mode, so alternating or
  unattributable failures cannot bypass the guard.

Successful replies and ordinary user turns reset both counters; user stop is
neutral. Counters survive restart and owner change inside the same Goal epoch;
an explicit resume starts a fresh cycle. Pausing only blocks the next
auto-continuation: in-flight calls, timeouts, retries, session reuse, and the
overall continuation budget are unaffected.

Upgrade notes: legacy `consecutiveModelFailureCount` values are not migrated
into the new counters, but runners already paused by the retired fast-failure
rule remain recognized as `error_paused` by the UI and DAG scheduler and are
not silently unpaused. `CAFF_SESSION_GOAL_FAST_FAILURE_MS` and
`CAFF_SESSION_GOAL_FAILURE_WINDOW_MS` are retired and no longer read; failure
duration never participates in the pause decision.

## Durable Attention And Monitoring

SQLite attention records pending proposals, exhausted budgets, failure pauses,
removed/unroutable owners, Goal completion and terminal failed turns. Goal,
proposal, ruling and related attention transitions commit together; notifications
are after commit, never the durable source. Startup reconciles current
conditions idempotently without replaying historical failures. Resolution never
rewrites the occurrence Goal ID/revision; initial set proposals may have null/0.

Root main/side tasks save their starting Goal association; only a still-matching
Goal at terminal time receives turn_failed, using its terminal revision. One
final failure creates one item, excluding cancellation, reply children and
internal retries. A later success auto-resolves only a clearly attributed
single-agent failure on the same Goal/agent/lane. Multi-agent/unknown failures
require explicit resume, acknowledgement or Goal retirement/completion.
Cancellation neither creates nor resolves items. These notifications do not
change failure thresholds, runner budget or retry policy.

Credential-only `/api/planner/attention` and `/attention/wait` provide creation
sequence replay, including already resolved rows. Wait defaults to 60s (max
300s); timeout returns an empty page, disconnect/shutdown cleans up waiters.
The cursor is not a resolution event feed. Acknowledgement resolves only
completion/turn-failure notices, not active blocking conditions.
`/api/planner/conversations/:id/state` is a <=64 KiB UTF-8 monitoring view;
`/api/planner/portfolio` includes every Goal Room and pending initial set Room
with grouped unresolved counts. Neither reads messages/private mail, evidence
bodies or proposal snapshots; missing bounded capabilities return 501.
Exact schemas, resolution rules and cursor semantics are in
[planner-interface.md](planner-interface.md#5-durable-attention-lifecycle).

## Compatibility

- Old Goals remain unbound, old message/ruling attribution is not rewritten,
  and the browser remains usable without planner credentials. Legacy full Goal
  payloads remain valid, subject to explicit merge/409/security corrections.
- **N10:** accepting an old set proposal now revalidates its default proposer
  owner against the current routable roster/runtime profile. A proposer who left
  the Room (or became unavailable) causes `400 goal_owner_invalid`; the proposal
  remains pending. Dismiss it, then submit a new set with an explicit valid
  owner (and fresh planner preconditions where applicable).
- Pending proposals are no longer silently discarded by lifecycle operations;
  clients must rule first or explicitly confirm supersession. Ruling history
  survives replacement/clear; malformed legacy snapshots cannot freeze unrelated
  updates. Existing DAG, Feishu, cross-Room delivery and delegation stay intact.

## DAG Binding

A doing DAG child allows Goal reads, factual `update-delivery`, and pending
proposal rulings. Direct set, revise, pause, resume, complete, clear, and owner
mutation are rejected with `403 dag_goal_mutation_forbidden` because they would
bypass the worker-to-verifier protocol.

Each DAG child Goal carries observable criteria and work items derived from its
node. The worker records evidence and proposes completion only after all criteria
are passed or waived. A distinct verifier accepts or rejects the proposal; a
single-Agent verification-exempt node uses the scheduler's explicit exemption.

## UI And Prompt

The Goal drawer separates objective, decision groups, acceptance criteria, work
items, and evidence. Pending proposals display the proposed contract as
read-only review content. Controls use the same REST actions and honor DAG locks.
Conflicting actions show the pending proposal and require explicit confirmation;
409 races refresh and permit only one confirmed retry with supersedeProposal and
the displayed proposal ID. Cancellation makes no writes. The minimal
“交给规划者” entry confirms user adoption with ID/revision/reason through the
browser CSRF path, never a planner bearer. Bound Goal agent restrictions are
server-owned, not just disabled UI controls.
Editing an existing Goal submits `revise` with `goalRevision`, never replacement
`set`. Exact unchanged decision/criterion/work-item records retain their IDs and
metadata, including evidence, risk and waiver details. Reordering does not change
identity, and a changed criterion cannot inherit an old passing status. Artifacts
are retained when a criterion is removed/replaced, but their `criterionIds` drop
references to criteria no longer present; no proof link is transferred to the
replacement criterion.

`E2E-GOAL-01` in `scripts/ui/verify-goal-contract.mjs` saves through the browser,
reloads, and verifies persisted identity, revision and evidence. `E2E-GOAL-02`
asserts that a stale HTTP revision returns 409 without modifying the stored Goal.
`E2E-GOAL-03` replaces a verified criterion and asserts that the new criterion is
pending while the existing artifact remains stored without a stale proof link.

Prompt projection includes Goal ID/revision, owner, decisions, criterion status
and verification method, work progress, evidence, pending review, and
status-specific guidance. It does not inject project PRDs, task JSONL files, or
`.current-task` state.

## Required Verification

- `tests/runtime/goal-contract.test.js`: creation validation, optimistic
  concurrency, completion, evidence, waivers, Provisional notices, and ADR gate.
- `tests/runtime/agent-tool-bridge.test.js`: structured Goal tools, review
  identity, and absence of retired project-file writers.
- `tests/runtime/agent-chat-tools.test.js`: structured CLI payload forwarding.
- `tests/runtime/session-goal-owner.test.js` and
  `tests/runtime/session-goal-auto-pause.test.js`: owner and runner durability.
- `tests/dag/dag-scheduler.test.js` and
  `tests/http/conversation-goal-dag-guard.test.js`: worker/verifier and DAG lock.
- `tests/http/goal-{set-owner-title,merge,proposal-guard,concurrency,planner-binding,high-risk-gate}.test.js`:
  initial owner/pause/title, omission/clear, audit/conflicts, principal/version
  gates and binding/DAG compatibility; associated `tests/ui/goal-*.test.js`
  cover confirmation/cancellation and adoption.
- `tests/storage/goal-ruling-resilience.test.js`: legacy conflicts, immutable
  history, unrelated updates/reopen and strict rollback for new rulings.
- `tests/storage/planner-{attention,attention-sources,turn-attention}.test.js`,
  `tests/http/planner-{attention,state,lean-retry}.test.js` and
  `tests/runtime/planner-attention-wait.test.js`: persistence, transaction and
  restart behavior, bounded reads and cursor/wait cleanup.
- `tests/smoke/server-smoke.test.js`: REST persistence and event broadcasts.
- UI tests cover contract rendering, proposal review, responsive layout, and
  restart/reload projection.

Run `npm run check`, `npm run typecheck`, `npm run build`, and the affected
runtime, smoke, DAG, and UI suites before review.
