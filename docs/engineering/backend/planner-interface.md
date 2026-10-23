# External Planner Interface (P1)

## Scope and delivery status

This is the P1 contract for [ADR 0002](../../decisions/0002-external-planner-drives-caff.md).
It covers planner attribution, mutation guards, Goal control, durable attention,
and bounded monitoring. It does not introduce a CLI, MCP, a review/verdict
protocol, different implementer prompts, or new DAG/delegation/Feishu behavior.

**M1 review candidate, not shipped behavior.** This document is written before
implementation and ships with it, not independently. M2–M5 must implement and
verify it before integration into `develop`. Sections marked **review decision**
are recommendations, not permission to implement an unresolved choice.

Related implemented contracts: [Session Goal](session-goal.md),
[DAG execution, D28](dag-execution.md), [controller patterns](controller-patterns.md),
[conversation titles](conversation-title.md),
[session reuse](../runtime/agent-session-reuse.md), and
[ADR 0001](../../decisions/0001-goal-driven-workflow.md).

## 1. Principals and credential

### Principal model

The server derives the principal before invoking a mutation. JSON fields such
as `ruledBy`, `senderName`, `source`, `kind`, or a claimed name cannot authenticate
or override it.

```ts
type Principal =
  | { kind: 'user' }
  | { kind: 'planner'; plannerId: string; plannerName: string }
  | { kind: 'agent'; agentId: string; agentName: string }
  | { kind: 'system' }; // internal/legacy, never a user-only gate bypass
```

P1 supports one configured local planner identity per server instance:
`plannerId = 'local-planner'`, `plannerName = 'External Planner'` by default.
The deployment may configure the name (`CAFF_PLANNER_NAME`); requests cannot.
The ID is stable across credential rotation. A planner is not a Room participant,
cannot own a Goal, and consumes no model slot. Multiple independent planner
identities and credential administration are not P1 features.

### Credential file (review decision: retain the provisional approach)

- Generate 32 cryptographically random bytes, base64url-encoded, on each server
  start. Compare the supplied value without timing-dependent string comparison.
- Write `{ version: 1, plannerId, plannerName, token, issuedAt }` atomically to
  `<agentDir>/runtime/planner.json`, where `agentDir` is this instance's resolved
  `PI_CODING_AGENT_DIR`. This is runtime state, never a repository file.
- The directory/file must be owner-only: directory `0700` and file `0600` on
  POSIX; an owner-only Windows DACL with inherited broad access removed on
  Windows. A chmod call alone is not evidence of Windows confidentiality.
  Reject symlink/reparse-point destinations and unsafe existing permissions.
- Verify permissions before publishing the credential. If secure creation or
  verification fails, disable planner authentication and log a non-secret
  diagnostic; the browser console remains usable. Never publish an insecure
  token or fall back to treating a planner as the user.
- Isolated instances must have different agent directories, databases and
  credential files. Shared-account agents may still read the file: this is
  attribution/gating, **not** an OS sandbox boundary.
- Rotation invalidates the previous token. A client receiving 401 may re-read
  its locally configured file; it must not retry as a browser/user principal.
  No token in bootstrap, URLs, messages, SQLite records, errors, logs or SSE.

### Planner intent and authentication

Planner clients send `Authorization: Bearer <token>`. On ordinary API routes,
`X-CAFF-Principal: planner` explicitly declares planner intent even if the
Authorization header was accidentally omitted. All `/api/planner/*` paths
implicitly declare planner intent. Any Authorization header on an ordinary
browser API route also declares intent; unsupported schemes, duplicate or
malformed headers, empty/wrong tokens and missing credentials for declared
intent return **401 `planner_credential_invalid`**, with no writes or scheduling.
A valid browser CSRF token does not rescue a failed planner claim.

A request with no planner indication follows the browser guards; it is not an
unauthenticated REST backdoor. Clients must not omit both indications on retry.
Planner-only reads require the credential too. GET/HEAD alone do not grant a
planner identity. CORS does not allow third-party origins or bearer access.

Agent callbacks and the exact Feishu webhook route are separate trust domains:
they always use their existing authentication, never acquire user/planner
powers through this exemption, and cannot use a bearer to replace callback or
webhook validation. `X-CAFF-Principal: planner` on those routes is rejected with
401; their native headers are not reinterpreted as planner credentials.

### Attribution and authority

- Planner messages retain transport `role: 'user'` for routing compatibility,
  but persist `senderName: plannerName`, `metadata.source: 'planner'` and
  `metadata.principal: { kind: 'planner', plannerId, plannerName }` server-side.
  They are displayed as the planner, not You / web-ui. This preserves the
  existing message role vocabulary without equating role with authority.
- Browser messages remain You / web-ui. Agent callbacks retain their invocation
  identity. No client-submitted principal is trusted.
- Planner proposal rulings persist `ruledBy.kind = 'planner'`, ID and name in
  the durable ruling and cleared-event payload. User rulings remain `user`.
- Only `kind === 'user'` may waive a high-risk criterion or change/remove a
  committed decision linked by `adrPath`. All other kinds return 403, including
  planner REST direct actions, proposal acceptance, and replacement paths that
  would otherwise bypass the same check. Failure leaves all state unchanged.
- Normal waivers still require reviewed `revise`, evidence/reason validation,
  and independent review. `update-delivery` cannot introduce a waiver.
- ADR 0002's other reserved approvals remain planner-attested, not an invented
  server-verifiable delegation policy. The planner records where and when the
  user approved in the Goal action/ruling `reason`, or in a preceding attributed
  public planner message for operations without a reason field. Such a claim
  never satisfies either of the two server-enforced user gates.

## 2. Write-interface hardening

Apply guards centrally **before body parsing, persistence, dispatch or external
side effects** to every `/api/*` method except GET, HEAD and OPTIONS. A POST
whose action happens to be `get` is still a write request. OPTIONS is not a
write capability and does not receive permissive CORS headers.

| Caller / route | Required validation |
| --- | --- |
| Browser, ordinary API write | Exact configured Host authority, same-origin Origin, JSON Content-Type, CSRF header |
| Browser `POST /api/conversations/:id/images` | Same Host, Origin and CSRF; `multipart/form-data` with valid boundary instead of JSON |
| Authenticated planner, ordinary API write | Host and the route's Content-Type; bearer replaces Origin and CSRF, not other validation |
| `/api/agent-tools/*` | Existing invocationId + callbackToken and invocation-scope checks; no browser CSRF/Origin or new Host requirement |
| `POST /api/integrations/feishu/webhook` | Existing webhook verification/challenge handling; no browser CSRF/Origin or new Host requirement |

Host means the configured listening authority, with the actual bound port
(including a port allocated from `0`), not an authority reconstructed from the
untrusted Host header. Do not trust forwarded headers. Origin must equal the
server's own HTTP origin, including port; missing, `null`, different hostname or
scheme is rejected. Existing local-only admin routes keep their additional
loopback bind/peer restrictions, including for planner requests; general Room
routes do not gain a new loopback-only restriction.

JSON means `application/json`, optionally with parameters such as charset.
Even bodyless DELETE/POST clients send this Content-Type (`{}` when needed).
Only the exact image-upload route has the multipart exception; keep all image
size/count/MIME/dimension checks. Other form/text Content-Types return 415.

CSRF uses `X-CAFF-CSRF-Token`. Expose the per-process random CSRF token through
same-origin bootstrap as `apiSecurity: { csrfToken }`, never the planner token.
Preserve existing `localAdmin.*.csrfToken` bootstrap aliases during migration.
Shared `fetchJson` and `fetchFormDataJson`, plus any direct mutation fetches,
attach it. Fetch a token before the first write on every page (chat, personas,
projects, skills, metrics/admin). Do not set multipart Content-Type manually.
A stale token after restart requires bootstrap refresh; do not automatically
replay a possibly committed non-idempotent write.

## 3. HTTP surface and retry contract

All JSON responses use UTF-8, `Cache-Control: no-store`, and the existing error
shape `{ error: string, code?: string, issues?: Array<object> }`. Errors contain
no request credentials. Existing browser response envelopes remain compatible.
IDs below are server-issued, not names to be resolved heuristically.

| Method / path | Request and successful response |
| --- | --- |
| `POST /api/conversations` | Existing `{ title?, projectScopeId, modeId, participants }`; 201. A nonblank explicit title is manual at creation. Planner response is `{ conversationId, title, titleSource, projectScopeId, modeId }`, no Room directory/messages. |
| `POST /api/conversations/:id/messages` | `{ content, imageIds?, clientRequestId? }`; 200 `{ conversationId, acceptedMessage: { id, senderName, role, metadata }, dispatch, dispatchLane, dispatchTargetAgentId }` for planners; no message/history echo. Existing routing and quick acknowledgement stay unchanged. |
| `GET /api/conversations/:id/goal` | Existing complete normalized Goal/proposal/ruling projection; use when the full delivery contract or proposal snapshot is needed. Keep the browser envelope; do not hydrate message bodies for this route. |
| `POST /api/conversations/:id/goal` | Action object described below; planner 200 `{ conversationId, goal, proposal, ruling, cleared, autoContinuation }` without conversation/messages/directory. These are complete contract records, unlike the monitoring summaries. Browser keeps its existing envelope. |
| `GET /api/planner/conversations/:id/state` | Credential required; bounded `GoalState` in §7. 404 for missing Room; null Goal permitted. |
| `GET /api/planner/portfolio` | Credential required; `{ items: PortfolioItem[], observedAt }`, all Rooms with a Goal or pending set proposal. |
| `GET /api/planner/attention` | Credential required; cursor page in §6. |
| `GET /api/planner/attention/wait` | Credential required; same page, after arrival or timeout. |
| `POST /api/planner/attention/:sequence/resolve` | Credential required; `{ reason }`; 200 `{ item }`. Only explicit acknowledgements allowed by §5; never hides a still-active blocking condition. |

Other routes retain their current endpoints and domain validation. Authentication
is not authorization to push, bind workspaces, add agents, restart or delete
without the user's approval. There is no planner-specific execution bypass.

### Goal concurrency

For every authenticated planner Goal write:

- Supply `goalId` and `goalRevision` from the last complete read. All actions,
  including lifecycle, owner change, replacement, clearing and rulings, check
  them before mutation. First `set` with no Goal uses `goalId: null` and
  `goalRevision: 0`; only this creation case accepts revision zero.
- Missing/invalid preconditions return 400 `goal_revision_required`; a different
  Goal ID or revision returns 409 `goal_revision_conflict`. Read again, inspect
  the change, and use a new request key; do not blindly force a stale write.
- Rulings additionally require `proposalId`, exactly matching the pending
  proposal, or 409 `goal_proposal_conflict`. This protects proposals created or
  replaced without a Goal revision change. No pending proposal returns 404.
- Browser and agent compatibility remains: existing required revision checks
  for revise/update-delivery and proposal baseRevision are retained. They may
  supply the stronger preconditions too; they are not newly required on old
  lifecycle callers. The UI sends proposalId when confirming a supersession.

### Idempotency

Planner Room creation, message submission, Goal writes and attention resolution
require `Idempotency-Key` (nonblank opaque string, at most 200 characters).
Missing/invalid keys return 400 `idempotency_key_required`. `clientRequestId`
remains available to old clients; planner clients reuse the same value on a
message retry, but it does not replace this header.

Persist successful operation receipts in SQLite scoped by planner ID, method,
canonical path and key. Store a digest of the semantic JSON request, the result
and resulting record IDs, **not** the credential. Receipt and domain writes
commit atomically. Identical retries return the original status and result,
with `Idempotency-Replayed: true`, before re-checking now-stale Goal preconditions;
no second message/Room/ruling/attention item or continuation is created. Different
payload under the same key returns 409 `idempotency_key_conflict`. Concurrent
identical submissions serialize; failed precondition/auth/domain validation
creates no successful receipt. Receipts survive restart and credential rotation.
Keep them for the lifetime of their Room (server-level receipts until explicit
maintenance); no automatic short TTL that could duplicate an old retry.

A crash after commit but before dispatch/broadcast must not lose accepted work:
use the existing durable message queue and runner recovery. Publishing SSE and
waking waiters happen after commit. Do not claim exactly-once model execution;
the existing execution/reconciliation contract remains authoritative. Other
mutation routes retain their existing operation journals/idempotency rules; a
planner must not automatically retry them merely because it supplied this key.

## 4. Goal actions, ownership and binding

Goal fields, evidence validation, completion requirements and IDs are those in
`session-goal.md`, with the following changes.

| Action | Inputs / semantics |
| --- | --- |
| `set` | Required objective and nonempty acceptanceCriteria; optional decisions/workItems/evidence. Optional `owner: { agentId }` and `status: 'active' \| 'paused'` (default active). Creates a new goalId at revision 1. |
| `revise` | Partial structural delivery contract, merged as below; reason/impact remain required when changing provisional decisions. Does not replace the Goal ID or owner. |
| `update-delivery` | Partial factual delivery state; merges omissions, preserves pending proposal/ruling and same-Goal runner counters. Structural definitions and new waivers remain forbidden. |
| `set-owner` | Existing `ownerAgentId`, plus reason for planner reassignment; current routable participant required. Does not reset runner budget/failure counters or discard proposal/ruling. Legacy user clear-owner behavior is unchanged. |
| `pause`, `resume`, `complete` | Existing lifecycle behavior, now guarded against proposal loss. Completion still needs all criteria passed or validly waived. Resume starts the existing fresh runner cycle; P1 does not change budgets. |
| `accept-proposal`, `dismiss-proposal` | Rule on the identified pending proposal with reason and server-derived principal; accepted proposal baseRevision must still match. |
| `clear` | Destructive, explicit user approval required by ADR 0002; preserve audit before clearing the live Goal/binding/proposal. |

Server resolves owner names from the current routable Room roster. An unknown,
removed, retired/unavailable or platform-only system actor returns 400
`goal_owner_invalid`; a supplied name cannot make an ID routable. An omitted
owner on legacy direct `set` preserves default routing; accepting an agent's
set proposal still defaults to its proposer. A supplied owner overrides that
default after validation. A paused initial Goal must enqueue **zero** continuation
messages. An active Goal's first continuation must target the persisted owner,
not participant order. `status` is initial set state, not a revise/update shortcut.

### Merge semantics

Merge **before** normalization and validation, for REST direct revise, agent
revise proposals and factual updates alike:

- Absent objective, decisions, acceptanceCriteria, workItems and evidence keep
  their exact previous values. Absent decision groups keep their old arrays.
- An explicitly supplied array replaces that collection, not an append/union.
  `[]` clears it, subject to existing validation (for example a revised Goal
  still needs at least one criterion; referenced evidence cannot disappear).
- For a supplied criterion/work item/evidence record with a known ID, omitted
  properties retain their old values, including status, risk, timestamps,
  evidenceRefs, waiver and criterionIds. New records use existing defaults.
  Removing an item from a supplied collection removes it; list omission does not.
- Changing a criterion's definition cannot inherit a passing result for the old
  definition. Preserve existing UI replacement-ID/proof-link safety. Changed
  definitions require explicit valid new acceptance state, never silent proof
  transfer. Factual updates that change definitions return 409.
- `null`, wrong collection types and blank required text return 400; they are
  not implicit clear commands. `decisions: {}` preserves every group.
- An old client sending the entire current Goal keeps replacement semantics for
  its explicitly supplied collections. A fully supplied, valid old payload has
  the same normalized result as before, apart from the documented corrections.

Example factual write (other fields remain byte-for-byte equivalent in the
normalized Goal; `c1` already exists):

```json
{
  "action": "update-delivery",
  "goalId": "goal_example",
  "goalRevision": 7,
  "workItems": [{ "id": "w1", "status": "done" }],
  "acceptanceCriteria": [{ "id": "c1", "status": "passed", "evidenceRefs": ["e1"] }],
  "evidence": [{ "id": "e1", "criterionIds": ["c1"], "kind": "test", "summary": "Targeted regression passed" }]
}
```

Here the supplied arrays replace their collections: callers must include every
item they wish to retain in those arrays. A client changing just evidence can
omit workItems and acceptanceCriteria entirely.

### Proposal-loss guard and ruling history

`set`, `revise`, `pause`, `resume` and `complete` with a pending proposal return
409 `goal_proposal_pending` with no changes. Only literal
`supersedeProposal: true` authorizes discarding it. Planners must also send the
current proposalId; UI confirmation does too. A mismatched supplied ID returns
409 rather than discarding a newly arrived proposal.

Successful supersession atomically records a ruling with a server-issued ID,
`outcome: 'superseded'`, original proposalId/action/full snapshot, principal,
reason, time, old goalId/revision and superseding action, then performs the
requested action and resolves the proposal's attention item. The ordinary
`sessionGoalRuling` remains the latest ruling projection; append-only SQLite
ruling history retains all previous accepted/rejected/superseded rulings across
lifecycle mutations and Goal replacement/clear. Do not grow unbounded Room
metadata or erase the last ruling on pause/resume/revise. A rejected or failed
superseding operation must not create a superseded ruling. Explicit clear also
archives any pending proposal as superseded before clearing live metadata.
Deleting a Room may delete its history as part of that separately approved
operation; there is no background history pruning in P1.

The browser displays the pending proposal before sending a conflicting action;
a 409 caused by a race also offers confirmation. Only an explicit user confirm
retries with supersedeProposal and the displayed proposalId; cancellation has
zero writes. Normal agents still propose lifecycle/structural changes rather
than acquiring direct mutation powers.

### Planner-driven binding

A planner direct `set` or planner acceptance of an agent's `set` writes
`metadata.sessionGoalPlannerBinding = { goalId, plannerId, plannerName, boundAt }`
in the same transaction. A user may explicitly request `plannerDriven: true`
when setting/accepting a set, binding the configured local planner. Existing
unbound Goals are not silently rebound merely by a planner read or factual write.

The binding is scoped to that Goal ID, survives credential rotation, lifecycle,
owner changes and restarts, and is removed on clear or a user replacement set
unless explicitly reselected. A malformed binding fails closed for agent
rulings rather than normalizing to unbound. Both accept and reject by **any**
in-room agent return 403 `goal_planner_ruling_required`, before mutation, even
when the agent is not the proposer. The matching planner and the user may rule;
self-review checks remain for agent paths on unbound Goals.

DAG node bindings take precedence: planner binding cannot be added to a DAG
child, and a planner is not the DAG verifier or a user manual-verification path.
A planner attempt to rule on a bound DAG node returns 403
`dag_verifier_only`; native worker/verifier, exempt-node scheduler and user paths
are unchanged. A conflicting planner/DAG binding fails closed. Do not broaden
D28's `kind === 'user'` check to include planner.

## 5. Durable attention lifecycle

SQLite stores attention separately from Room metadata. Each item has:

```ts
{
  sequence: number;              // positive global monotonic SQLite sequence
  conversationId: string;
  goalId: string;
  goalRevision: number;          // occurrence revision, not a mutable cursor
  kind: 'proposal_pending' | 'budget_exhausted' | 'failure_paused'
      | 'owner_removed' | 'goal_completed' | 'turn_failed';
  sourceId: string;              // proposal, runner-cycle, owner incident or turn ID
  summary: string;               // sanitized, at most 500 Unicode code points
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;     // e.g. proposal_accepted, goal_resumed, acknowledged
  resolvedBy?: Principal;        // automatic resolutions use system
}
```

Unique occurrence keys prevent duplicate items during retry, event re-entry and
restart reconciliation. Sequence allocation never reuses a committed sequence
within the same database; restoring a different/older database requires client
cursor reset. Source identity is not a raw timestamp or arbitrary error text.

| Source | Creation / deduplication | Resolution |
| --- | --- | --- |
| New pending proposal | Once per proposalId, including system pause/resume proposals | Accepted, rejected or durably superseded |
| Runner budget reached | Once per Goal + existing runner cycle, **even if another proposal is already pending** | Explicit resume/new cycle, Goal completed/replaced/cleared |
| Failure circuit-breaker pause | Once per error-paused runner incident | Explicit resume, or Goal completed/replaced/cleared |
| Owner removed/unroutable | Once per removed-owner incident, eager roster path and lazy runner path share key | Valid owner assigned/restored, or Goal completed/replaced/cleared |
| Goal complete | Once per Goal's transition to complete (including accepted complete proposal) | Planner acknowledgement or replacement/clear; mere reads do not resolve it |
| Terminal turn failure | Once per final failed turn ID associated with a Goal | A later successful turn, explicit resume, acknowledgement, or Goal completed/replaced/cleared |

**Review decision — failure frequency:** recommend every terminal failed turn,
not only a streak threshold. This includes failed queued turns while a Goal is
present, but excludes user cancellation, provider-internal retry attempts and
multiple failed reply slots inside the same turn. It is an attention notification,
not a new pause/retry policy. The existing same-mode/total-streak guards alone
decide automatic failure pauses. This prevents a first failed round from being
invisible; one item per turn bounds duplication. The planner can batch reads.

Acknowledgement accepts a nonblank reason only for goal_completed/turn_failed.
It cannot hide a pending proposal or unresolved budget/failure/owner condition
(409 `attention_condition_active`). Already-resolved items return the same item
without another transition. Missing items return 404 `attention_not_found`.
No new Room UI for acknowledgements is required; the user can still handle the
underlying Goal/proposal in the current UI.

Goal/proposal/runner transitions, ruling archive, attention insert/resolution and
operation receipt belong in the same SQLite transaction. This applies to REST,
agent tools, owner-removal checks and system runner transitions, not only planner
requests. Roll back on persistence failure. Notify only after commit. Queue
production uses durable transitions, never SSE as its source of truth.

Startup reconciles current proposal, budget-limited runner, failure pause,
missing owner and completion from bounded metadata and stable occurrence keys.
Repair missing rows idempotently before serving attention reads; do not replay
all historical messages or fabricate old turn failures. New turn-failure rows
commit with terminal turn persistence. Existing resolved rows are never reopened
just because a process restarted. Replacement/clear resolves outstanding items
from the retired Goal with an explicit resolution, retaining them for replay.
Room deletion may remove its items, but never resets the global sequence.

Review requests in ADR 0002 are represented in P1 by the milestone's pending
pause/complete proposal and its attention row. No heuristic extraction of public
text and no structured review-request source are introduced; the latter is P2.

## 6. Cursor list and long polling

Both list and wait accept:

- `after`: exclusive creation sequence, default `0`, nonnegative safe integer.
- `limit`: default 100, range 1–500; ascending sequence order.
- `conversationId`: optional exact Room filter.
- `status`: `all` (default), `unresolved`, or `resolved`.
- Wait only: `timeoutSeconds`, default 60, integer range 1–300.

**Review decision:** retain the provisional 60/300-second defaults. Invalid
parameters return 400 `attention_query_invalid`; do not silently clamp a cursor.

```json
{
  "items": [],
  "nextCursor": 42,
  "highWatermark": 42,
  "hasMore": false,
  "timedOut": true
}
```

`highWatermark` is the database's committed attention creation sequence at the
query snapshot. If another matching row remains in that snapshot, nextCursor is
the last returned sequence and hasMore is true; otherwise nextCursor advances to
at least the snapshot watermark (and never below the input cursor). Gaps and
nonmatching items are safe to skip. Unfiltered `status=all` is the durable replay
mode: an item resolved while offline is still returned, with its resolution.
Rows are not dequeued on read. No automatic retention/pruning in P1.

The cursor tracks **creation**, not status-update events. Resolving an old item
does not assign it a new sequence; re-list unresolved items from after=0 or use
the portfolio count to refresh current workload. Do not promise a change-data
stream of every resolution. Clients must keep separate cursors for different
filters; advancing one filtered cursor does not consume another feed.

Wait runs the same query first: available rows return immediately with
`timedOut: false`. Otherwise register a waiter and re-check the DB to close the
read/subscribe race. Wake/re-query on committed changes until matching rows
exist or the deadline expires; unrelated Room events must not cause a false
nonempty result. Timeout is 200 with items=[], timedOut=true and a safe cursor,
not an error. Client disconnect removes listeners/timers; server shutdown ends
waits without fabricating items. Reconnect with the last successfully received
cursor. If the response was lost, re-reading may repeat rows but cannot lose
them. Clients deduplicate by sequence. SSE remains optional, non-replayable UI
transport and is not required for this protocol.

## 7. Bounded state and portfolio

`GoalState` has exactly these monitoring projections (null when absent):

```ts
{
  goal: null | {
    goalId, revision, status, objective, owner, createdAt, updatedAt, completedAt?,
    plannerBinding,
    decisionCounts,             // counts per decision group, not decision texts
    acceptanceCounts,          // pending/passed/failed/waived, highRisk
    workItemCounts,             // todo/in_progress/done
    evidenceCount
  };
  proposal: null | { id, action, baseRevision?, proposedBy, reason, createdAt, updatedAt };
  ruling: null | { id, proposalId, action, outcome, ruledBy, reason, ruledAt };
  runner: null | { /* existing normalized sessionGoalRunner, bounded summaries */ };
  busy: boolean;
  lastTurn: null | { id, status, startedAt, finishedAt, failureKind?, failureCode?, summary };
}
```

Objective is clipped to 2,000 Unicode code points; proposal/ruling reasons and
failure/turn summaries to 500. `plannerBinding` is the public binding, never a
credential. Last turn summary means status/error classification, **not** the
last message text, assistant output, reasoning or tool trace. No full proposal
snapshot, evidence bodies, arbitrary Room metadata, messages or private mailbox.
The complete authoritative contract remains available at the existing Goal read;
clients must not send this summary projection back as a replacement Goal.

State response is `{ conversationId, ...GoalState }`, at most **64 KiB of serialized
UTF-8 JSON**, independent of public/private message count or content length.
Counts are calculated from bounded Goal metadata. Use indexed terminal-run/header
reads for lastTurn and runtime lane state for busy (active/dispatching/queued main
or side work); do not fetch `listMessages()` to find the last round.

Portfolio returns every Room with a Goal (active, paused or complete), plus Rooms
with pending set proposals. Each item is
`{ conversationId, title, projectScopeId, state: GoalState, unresolvedAttentionCount }`.
Title is clipped to 120 code points. It is a server-side overview, not N client
requests or bootstrap hydration. Use bounded Room headers and grouped SQLite
unresolved counts. No message/history/profile/credential payloads. Per-item
budget remains 64 KiB plus 1 KiB of Room identity; total size is linear in Room
count (not a fixed global cap). `observedAt` marks the read; live busy state may
change immediately after it. Do not claim a transactional snapshot of OS runs.

Missing required bounded-store projections fail closed with 501
`planner_projection_unavailable`, never full-conversation fallback.

## 8. Errors and client recovery

| HTTP / code | Meaning and recovery |
| --- | --- |
| 400 `goal_revision_required` | Supply current ID/revision (0/null only for first set) |
| 400 `goal_owner_invalid` | Choose a currently routable Room participant |
| 400 `idempotency_key_required` | Supply a valid retry key |
| 400 `attention_query_invalid` | Correct cursor/filter/timeout |
| 400 existing Goal validation codes | Invalid definitions, missing verifyBy, evidence IDs/links or waiver reason; nothing written |
| 401 `planner_credential_invalid` | Missing/invalid declared planner credential; never downgrade to user |
| 403 `api_host_mismatch`, `api_origin_mismatch`, `api_csrf_invalid` | Browser/planner mutation guard failure, as applicable |
| 403 existing local-admin `*_local_only` | Existing local-only boundary remains |
| 403 `goal_high_risk_waiver_user_required`, `goal_accepted_adr_change_user_required` | Direct user ruling in CAFF required; attestation is insufficient |
| 403 `goal_planner_ruling_required` | Room agent cannot rule on a planner-driven Goal |
| 403 existing `goal_proposal_self_review`, DAG codes | Existing self-review/worker/verifier restrictions remain |
| 404 existing Room/Goal/proposal errors, `attention_not_found` | Read state again; do not invent an entity |
| 409 `goal_revision_conflict`, `goal_proposal_conflict` | Concurrent change; read again, inspect, use a new key |
| 409 `goal_proposal_pending` | Rule first, or explicitly confirm and identify supersession |
| 409 `goal_structural_review_required`, `goal_waiver_review_required`, `goal_acceptance_incomplete` | Use reviewed revision / finish acceptance, not a factual or lifecycle shortcut |
| 409 `idempotency_key_conflict` | Same key with different semantic request; do not retry it |
| 409 `attention_condition_active` | Handle the underlying blocking state |
| 415 `api_json_required`, `api_multipart_required` | Correct route Content-Type; never bypass CSRF |
| 501 `planner_projection_unavailable` | Required bounded store capability unavailable; no hydration fallback |

Guard failures are pre-write. Invalid planner intent is checked before the
ordinary browser guard; a mismatching Host with a valid planner is still 403.
Content-Type and browser Origin/CSRF are checked before consuming the body.
Domain conflicts occur only after caller authentication. A multi-fault browser
request need not report every invalid header. Preserve existing admin error code
aliases where old clients depend on them; new global guard codes are canonical.

## 9. Compatibility, migration and verification

- SQLite changes are additive: attention, ruling archive and operation receipts,
  with indexes for sequence/Room/unresolved counts and unique source keys. Keep
  existing Goal IDs, revisions, roster, evidence, runner counters and DAG binding.
- Legacy Goals stay unbound. Recognized old rulings remain readable; archive the
  current durable ruling idempotently on upgrade, without inventing a principal
  for previously unaudited actions. No historical planner attribution rewrite.
- User UI needs no planner credential. Updated shared clients cover **all**
  mutations, including image upload, bodyless deletion, workspace authorization
  and every management page. Preserve ordinary message dispatch and unbound Goal
  behavior apart from the explicit merge/409 corrections.
- Agent-tools remain invocation-authenticated. Feishu verification and webhook
  responses, native DAG completion, cross-Room delivery and delegation do not
  gain new features or weaken authentication.
- M5 synchronizes `session-goal.md`, the D28 section of `dag-execution.md`,
  `conversation-title.md`, controller/bootstrap/frontend guard contracts and any
  runtime documentation affected by the final implementation.

### Review decision: factual updates and session reuse

Current code always increments Goal revision on update-delivery. Goal Runner
reuse compares the trigger, current Goal and provider-known revision; resume
injects message delta only, not a fresh Goal section. Merely not bumping revision
or rewriting the provider-known revision would let the model act on unseen
criterion/evidence/ruling state. Accepting lifecycle or structural proposals is
not a factual-only change; even rejection changes review guidance.

**Recommendation for P1: retain current fresh-session behavior.** Batch factual
writes and rulings, but do not implement a reuse exception. A later optimization
would need a separately specified versioned Goal-delta delivery/acknowledgement,
provider-known contract revision versus delivery revision, atomic claim/race
checks, restart coverage and prompt parity tests. That is not safe to hide inside
this P1 interface change. Planner confirmation is required; no reuse code is
changed during contract drafting.

### Acceptance evidence required during implementation

1. Credential/attribution HTTP tests: valid planner message/ruling; missing,
   wrong and malformed credentials with zero writes; forged body identity;
   planner rejection and user success for both user-only gates, including direct
   actions and replacement bypass attempts; rotation and secure-file failure.
2. Mutation HTTP matrix: wrong Host, wrong/missing/null Origin, wrong/missing
   CSRF, non-JSON; image upload missing CSRF and cross-origin rejected; browser,
   planner, callback, webhook and multipart successes; existing local-only
   restrictions. UI/smoke cover chat, Goals, Room creation, workspace authorization,
   models/projects/skills management and image upload with the shared token.
3. Runtime/HTTP tests: owner invalid/paused/no enqueue/first target; manual title
   survives first message and refinement; each of five guarded actions' 409 and
   supersede paths with archived snapshot/identity; omission, explicit empty,
   item-field preservation, full old payload, stale revision/proposal and retry.
4. Bridge/HTTP/DAG tests: bound planner/user rulings allowed, every agent ruling
   rejected; unbound and DAG worker/verifier/scheduler/user behavior unchanged.
5. Storage/runtime tests: each attention source, deduplication, same-transaction
   rollback, restart recovery and resolution; budget item with another pending
   proposal. HTTP wait arrival, timeout, disconnect race, multi-page cursor
   replay (including resolved offline rows), acknowledgement restrictions.
6. HTTP/storage projection tests: exact summaries, no message/private/tool data,
   64-KiB state bound for huge Rooms, grouped portfolio unresolved counts and
   absent bounded-store capabilities fail closed.
7. Before each milestone review run the full applicable checks: typecheck,
   npm test (fast + smoke), test:dag-execution, git diff --check. Use temporary
   SQLite/agent directories, random ports and synthetic executors only; no
   3100/3200, real credentials, provider calls or Feishu side effects. Keep test
   logs/media in the system temporary directory. Integration additionally needs
   planner PASS at the exact SHA and separate user push/PR/merge authorization.
