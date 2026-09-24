# Session Goal

## Scope

This contract applies to Goal metadata, `/api/conversations/:id/goal`, Goal prompt
projection, Agent Goal tools, Goal Runner continuation, the Goal drawer, and DAG
child Goal bindings.

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

## Delivery Rules

- Goal creation requires at least one observable acceptance criterion.
- Every criterion requires a non-empty `verifyBy` description.
- Work-item completion reports progress only. It never proves acceptance.
- Evidence is the current proof set, not a history log. Replace superseded entries,
  keep summaries concise, and keep criterion references valid.
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

## Review And Decision Gates

Agent-proposed `set` and `revise` actions remain pending until the user or one
participant other than the proposer rules on them. The proposer cannot review
its own proposal. The durable ruling and proposal snapshot are written in the
same metadata mutation as acceptance or rejection.

A normal-risk waiver requires a reviewed revision. A high-risk waiver involving
security, data, external side effects, or core behavior can only be accepted by
the user. Changing or removing a committed decision with `adrPath` also requires
the user.

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
  `pause`, `resume`, `complete`, `clear`, `set-owner`, `update-delivery`,
  `accept-proposal`, and `dismiss-proposal`.
- The REST ruling endpoint stamps `ruledBy: { kind: 'user' }` server-side and
  ignores any client-supplied ruling identity.
- `suggest-goal` creates or rules on a pending proposal. It does not silently
  mutate structural Goal content.
- `update-goal` submits factual delivery state and must include `goalRevision`
  (or `revision`) in its Goal JSON.
- `propose-plan` owns DAG planning. Goal tools do not create ticket or task
  intermediates.

Production stores must use bounded conversation header reads and metadata-only
writes. Missing bounded projections fail closed with `501`; production code
must not fall back to full conversation hydration.

## Goal Runner

Active Goals may auto-continue only while the conversation is idle, no user work
is queued, no delegation or proposal is pending, and the owner remains a current
participant. Owner removal pauses fail closed instead of routing to another
Agent.

Runner state is stored in `sessionGoalRunner`. Same-revision factual updates
migrate the runner epoch key in the same metadata write, preserving iteration
and failure streak state.

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
- `tests/smoke/server-smoke.test.js`: REST persistence and event broadcasts.
- UI tests cover contract rendering, proposal review, responsive layout, and
  restart/reload projection.

Run `npm run check`, `npm run typecheck`, `npm run build`, and the affected
runtime, smoke, DAG, and UI suites before review.
