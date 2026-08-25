# Session Goal

## Scenario: Conversation Session Goal

### 1. Scope / Trigger
- Trigger: implementing or modifying `/goal` behavior for CAFF conversations.
- Applies when changes touch conversation metadata, `/api/conversations/:id/goal`, prompt assembly, SSE refresh, or chat composer slash handling.
- Goal: keep a lightweight user-defined completion target available to the UI and agents, with bounded automatic continuation for active goals.

### 2. Signatures
- `GET /api/conversations/:conversationId/goal`
  - Response: `{ conversation, goal, cleared, summary, conversations }`
- `POST /api/conversations/:conversationId/goal`
  - Request: `{ action: 'set', objective: string, checklistText?: string, checklist?: SessionGoalChecklistItem[] } | { action: 'set-owner', ownerAgentId: string | '' } | { action: 'update-checklist', checklistText?: string, checklist?: SessionGoalChecklistItem[] } | { action: 'pause' | 'resume' | 'complete' | 'clear' | 'get' | 'accept-proposal' | 'dismiss-proposal' }`
  - Response: `{ conversation, goal, proposal, cleared, autoContinuation?, summary, conversations }`
- Agent bridge command:
  - `suggest-goal --action set|pause|resume|complete|clear [--objective "..."] [--reason "..."] [--checklist-stdin]`
  - Writes a pending proposal only; it never mutates `sessionGoal` directly.
  - A `set` proposal always freezes a normalized checklist at proposal creation: explicit checklist input wins, otherwise the default Trellis checklist is stored.
  - Proposal schema: `{ id, action, status:'pending', objective?, checklist?, reason?, proposedBy:{agentId,agentName}, createdAt, updatedAt }` — `id` (`prop_*`) is unique per proposal and survives normalization; consumers deriving idempotency keys (e.g. the DAG scheduler's verify/feedback deliveries) must stamp with `id` (createdAt has only ms resolution and same-ms proposals would collide).
  - `update-goal-checklist --content-stdin` writes factual checklist progress lines such as `[ ] todo`, `[~] doing`, and `[x] done`. While a pending `set` proposal exists, it updates that proposal checklist without activating the goal; otherwise it updates the active goal checklist.
- Conversation metadata field:
  - `conversation.metadata.sessionGoal?: { objective: string, status: 'active' | 'paused' | 'complete', createdAt: string, updatedAt: string, completedAt?: string, owner?: { agentId: string, agentName: string }, checklist?: { id: string, text: string, status: 'todo' | 'in_progress' | 'done', createdAt: string, updatedAt: string, completedAt?: string }[] }`
  - `conversation.metadata.sessionGoalProposal?: { id: string, action: 'set' | 'pause' | 'resume' | 'complete' | 'clear', status:'pending', objective?: string, checklist?: SessionGoalChecklistItem[], reason?: string, proposedBy:{ agentId:string, agentName:string }, createdAt:string, updatedAt:string }`
  - `conversation.metadata.sessionGoalRuling?: { id:string, proposalId:string, action:string, outcome:'accepted'|'rejected', reason?:string, ruledBy:{ kind:'user'|'agent'|'system', agentId?:string, agentName?:string }, proposalSnapshot:SessionGoalProposal, ruledAt:string }`
  - `conversation.metadata.sessionGoalRunner?: { status: 'running' | 'budget_limited' | 'error_paused' | string, goalUpdatedAt: string, iteration: number, maxIterations: number, updatedAt: string, lastContinuedAt?: string, consecutiveModelFailureCount: number, failureThreshold: number, failureStreakStartedAt?: string, lastFailureAt?: string, lastFailureKind?: 'provider'|'timeout'|'process_exit', lastFailureCode?: string, lastFailureSummary?: string, pauseReason?: string, errorPausedAt?: string }`
- Goal Runner failure guard configuration:
  - `CAFF_SESSION_GOAL_FAILURE_THRESHOLD` defaults to `3` and is clamped to at least `2`.
  - `CAFF_SESSION_GOAL_FAST_FAILURE_MS` defaults to `60000`.
  - `CAFF_SESSION_GOAL_FAILURE_WINDOW_MS` defaults to `300000` and cannot be lower than the per-turn fast-failure threshold.
- Domain signature: `recordSessionGoalContinuationOutcome(store, conversationId, { sourceMessages, turn, replies, failures, failureThreshold, fastFailureMs, failureWindowMs }) -> { changed, paused, reason, conversation, goal, runner }`.
- Domain signature: `pauseSessionGoalForRemovedOwner(store, conversationId, owner) -> { changed, paused?, reason: 'owner_removed', conversation, goal, runner: null, proposal }` — one atomic metadata write pauses an active goal; when no proposal is pending it also creates a pending `resume` proposal whose `proposedBy` is `goal-runner` and whose reason names the removed owner; an already-pending user proposal is preserved, and the paused goal itself blocks auto-continuation.
- Browser slash commands:
  - `/goal` reads the selected conversation metadata and displays current status.
  - `/goal <objective>` sends `action: 'set'`.
  - `/goal pause|resume|complete|clear` sends the matching action.
- Browser goal management panel:
  - `public/chat/session-goal-panel.js` renders the selected conversation goal, checklist progress, and pending proposal from metadata.
  - Save sends `{ action: 'set', objective, checklistText }`; empty new-goal forms prefill the Trellis long-task checklist and expose a one-click preset restore button.
  - Pause/resume/complete/clear buttons send the same lifecycle actions as slash commands.
  - DAG execution lock (D27/D28): when the conversation metadata carries `dagNodeGoalBinding` and the goal is active/paused (node doing), the set/pause/resume/complete/clear buttons are disabled up front — the server enforces the same boundary with 403 `dag_goal_mutation_forbidden` (see `dag-execution.md`); proposal ruling buttons stay enabled (user manual verification).
  - Confirm/ignore proposal buttons send `{ action: 'accept-proposal' }` or `{ action: 'dismiss-proposal' }`.
  - Goal owner select (D1/D4): the drawer renders a 主理人 dropdown defaulting to `未设置` with options from the conversation roster; changing it submits `{ action: 'set-owner', ownerAgentId }`. When the stored owner is no longer on the roster, the select keeps a `XX（已不在会话）` option instead of silently resetting; options are rebuilt only when conversation/roster/owner changes so an in-progress selection is not clobbered. Under the DAG execution lock (`dagNodeGoalBinding`) the select is disabled with the other lifecycle controls.

### 3. Contracts
- Goal reads and metadata-only writes are message-free. `claimSessionGoalAutoContinue`, `recordSessionGoalContinuationOutcome`, `applySessionGoalAction`, `proposeSessionGoalAction`, and `pauseSessionGoalForRemovedOwner` read `getConversationWithoutMessages()`; their metadata write helper uses `updateConversationWithoutMessages()`. The orchestrator's continuation eligibility, owner-removal, pending-proposal, budget-proposal, and Goal SSE fallback paths use the same header projection.
- A production `ChatAppStore`, recognized by its bounded-projection marker or class identity, fails closed with `501 Bounded conversation projection is unavailable` when either Goal projection is missing. It never falls back to `getConversation()` or parses message metadata. Plain-object legacy test fixtures may retain compatibility fallback; production `ChatAppStore` cannot.
- Goal API/SSE responses may therefore carry `conversation.messages=[]`. Goal consumers use normalized Goal/runner/proposal and conversation summary/header fields; message pagination and message SSE remain the timeline authority.
- Store the goal under `conversation.metadata.sessionGoal`; do not add a dedicated table unless the feature grows beyond one current goal per conversation.
- Keep controllers thin: route parsing belongs in `server/api/conversations-controller.ts`; lifecycle rules belong in `server/domain/conversation/session-goal.ts`.
- `set` must trim and validate `objective`, create an `active` goal, preserve `createdAt` when replacing an existing goal, refresh `updatedAt`, remove stale `completedAt`, and normalize optional checklist lines/items.
- `set` without explicit checklist input must seed a Trellis long-task checklist covering multi-agent brainstorm, Trellis task/PRD creation, Trellis/spec validation, `before-dev`, implementation, tests, quality checks, `update-spec`, `finish-work`, and Trellis archive/session recording.
- Goal owner (D1): a goal may carry `owner?: { agentId, agentName }`. Accepting a pending `set` proposal stamps `proposedBy` as the goal owner — only on the `accept-proposal` path, so a client-supplied `proposedBy` in a direct `set` body can never forge an owner. A directly created goal (`POST set` without proposal) has no owner.
- `set-owner` requires an existing goal. A non-empty `ownerAgentId` must reference a current conversation participant (`400` otherwise); an empty value removes `owner` while keeping the rest of the goal. It is a factual owner change inside the current goal epoch: it must not erase a pending proposal, the durable ruling, or runner state, and it does not schedule auto-continuation by itself. Empty owner keeps the pre-existing routing behavior unchanged (D2). Because the write refreshes `goal.updatedAt` (the runner epoch key), a same-epoch runner is atomically migrated to the new key in the same metadata write so `iteration` and the failure streak survive the owner change; a stale (different-epoch) runner is never revived. Without this migration an owner change would silently reset the continuation budget.
- Continuation routing (D3-adjacent): when scheduling a `Goal Runner` message for a goal with an owner, the orchestrator stamps `metadata.initialAgentIds = [ownerAgentId]` on that message and the queue's batch branch collects `initialAgentIds` from batch-message metadata as an explicit target that outranks `default_last_agent`. A goal without an owner is not stamped and keeps `default_last_agent` routing.
- Fail-closed owner removal (D3): when the stored owner is no longer a conversation participant, the goal is paused and a pending `resume` proposal is created in one atomic metadata write (`pauseSessionGoalForRemovedOwner`); it must never silently fall back to default routing. Detection happens lazily before each continuation scheduling in `turn-orchestrator` (covers agent-role retirement, including retirement of the owner as the last custom role leaving `agents` empty — the owner-removed check runs before the empty-roster `missing_conversation_or_agents` gate) and eagerly after `PUT /api/conversations/:id` roster updates (response carries `goalOwnerRemoved: true`). In the lazy scheduler the owner-removed check runs BEFORE the pending-proposal gate, so a removed owner pauses the goal even while another proposal is pending; in that case the existing pending proposal is preserved (never silently replaced) because the user already has an unresolved decision — the paused goal blocks continuation either way, and a later accepted `resume` whose owner is still gone re-triggers the pause. The pending proposal additionally blocks future auto-continuation. `pause/resume/complete/update-checklist` preserve the stored owner.
- `pause`, `resume`, and `complete` require an existing goal; `complete` adds `completedAt`, while `pause`/`resume` remove stale `completedAt`.
- Accepting or dismissing a proposal writes `sessionGoalRuling` atomically in the same conversation-metadata update that clears the proposal (and, for accept, mutates the goal). The durable record is the restart-safe proof of the verdict; `proposalId` must be non-empty and exactly equal `proposalSnapshot.id`, otherwise normalization rejects the record.
- `update-checklist` changes the pending `set` proposal checklist when one exists; otherwise it changes only the current goal checklist. It preserves other pending proposal/ruling metadata and never activates a proposal by itself.
- `clear` removes `sessionGoal`, stale `sessionGoalProposal`, stale `sessionGoalRuling`, and stale `sessionGoalRunner` from metadata instead of leaving empty objects.
- Setting or resuming an active goal may schedule bounded automatic continuation through transparent `Goal Runner` user messages.
- Automatic continuation must not run while a conversation is busy, while user messages are queued, while the goal is paused/complete/cleared, or while any proposal is pending.
- The runner increments `sessionGoalRunner.iteration` per automatic continuation and creates a pending pause proposal when `maxIterations` is reached; default max is 20 unless `CAFF_SESSION_GOAL_AUTO_CONTINUE_MAX_TURNS` overrides it.
- After an automatic-continuation batch returns normally, the queue evaluates its structured turn result before scheduling another continuation. A qualifying result has zero completed replies, at least one failure, every failure carries `invocationFailure.eligible=true` with kind `provider|timeout|process_exit`, the turn duration is at most 60 seconds by default, and the first-to-current failure span is at most 5 minutes by default.
- Three consecutive qualifying failures directly update one metadata snapshot: Goal status becomes `paused`, runner status becomes `error_paused`, `goalUpdatedAt` matches the paused Goal's `updatedAt`, and bounded failure context is persisted. No pause proposal/ruling is fabricated; the inactive Goal prevents a fourth continuation.
- A completed reply, a non-Goal user-authored main-lane batch, or a non-qualifying Goal Runner failure resets the streak. User stop/cancel is neutral. Goal `set` and `resume` remove stale runner metadata before continuation scheduling.
- `claimSessionGoalAutoContinue` preserves same-epoch streak fields while advancing `iteration`; otherwise the second claim would erase the first failure before it could become consecutive.
- `conversation_goal_updated` broadcasts the normalized Goal, runner, conversation summary, and a bounded `autoPauseReason`; the reason and `lastFailureSummary` are redacted before persistence/SSE.
- Agents may propose lifecycle changes via `suggest-goal`; the proposal is stored as `sessionGoalProposal` and must wait for user confirmation.
- Accepting a proposal applies the proposed action through the same domain state machine and clears `sessionGoalProposal`; dismissing only clears the proposal.
- Prompt assembly injects a `Session goal:` section when metadata contains a valid objective or pending proposal, including checklist progress when present.
- Frontend slash handling must intercept `/goal...` before optimistic user-message rendering so slash commands are not persisted as chat messages.
- Frontend UI management must reuse shared `public/shared/session-goal.js` helpers for goal lookup, labels, and objective text so the composer, metadata line, and drawer do not drift.
- The goal panel must show the pending `set` proposal objective and normalized checklist as read-only approval content; agents may update that checklist through the bridge, but only approval promotes it to the active goal.
- `POST` updates should broadcast `conversation_goal_updated` or `conversation_goal_cleared` plus `conversation_summary_updated` so other clients can refresh.
- Checklist-only updates should broadcast `conversation_goal_updated` but must not schedule another auto-continuation by themselves.
- Proposal writes/clears should broadcast `conversation_goal_proposal_updated` or `conversation_goal_proposal_cleared` plus `conversation_summary_updated`.

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| Goal read/write/continuation | large conversation and full-message APIs are poisoned | behavior unchanged; zero `getConversation()` / `listMessages()` calls |
| Goal read/write | required header or header-write projection missing on production store | `501`, no fallback and no partial metadata mutation |
| `GET /goal` | conversation exists without goal | `200`, `goal: null`, `cleared: false` |
| `POST /goal set` | objective is empty after trim | `400 Goal objective is required` |
| `POST /goal set` | objective is longer than 2000 chars | `400 Goal objective must be 2000 characters or fewer` |
| `POST /goal set` | checklist is omitted | `200`, goal stores the default Trellis long-task checklist |
| `POST /goal pause` | no existing goal | `404 No session goal is set` |
| `POST /goal resume` | existing paused/complete goal | `200`, goal status becomes `active`, stale `completedAt` is removed |
| `POST /goal complete` | existing goal | `200`, goal status becomes `complete`, `completedAt` is set |
| `POST /goal clear` | no existing goal | `200`, metadata still has no `sessionGoal` |
| `POST /goal unknown` | unsupported action | `400 Unsupported goal action` |
| `POST /goal set-owner` | no existing goal | `404 No session goal is set` |
| `POST /goal set-owner` | `ownerAgentId` not a current participant | `400 Goal owner must be a current conversation participant` |
| `POST /goal set-owner` | empty `ownerAgentId` | `200`, owner removed, pending proposal/ruling/runner preserved |
| `POST /goal accept-proposal` | pending `set` proposal | goal becomes active and `owner` equals the proposal's `proposedBy` |
| `POST /goal set` (direct, no proposal) | valid objective | goal stored with no `owner` field |
| auto continuation | active goal with owner B, Agent A has the more recent qualifying public reply | continuation message carries `initialAgentIds=[B]` and the batch executes B (explicit target outranks `default_last_agent`) |
| auto continuation | active goal with no owner | no `initialAgentIds` stamped; latest qualifying public reply executes (unchanged `default_last_agent`) |
| auto continuation | stored owner missing from roster (lazy check) | `scheduled=false`, `reason='owner_removed'`, goal paused + pending `resume` proposal in one write (existing pending proposal preserved), zero agents executed |
| auto continuation | stored owner missing and roster is empty (owner was the last agent) | same as above: `reason='owner_removed'` wins over `missing_conversation_or_agents` |
| `PUT /api/conversations/:id` | roster update removes the active goal's owner | `200` with `goalOwnerRemoved: true`, goal paused + pending `resume` proposal, `conversation_summary_updated` broadcast |
| `PUT /api/conversations/:id` | roster update keeps the owner, or goal has no owner | response and goal behavior identical to before the change |
| `POST /goal update-checklist` | pending `set` proposal, with or without an existing active goal | `200`, proposal stores normalized checklist, active goal remains unchanged, proposal remains pending |
| `POST /goal update-checklist` | existing goal and no pending `set` proposal | `200`, goal keeps lifecycle status, stores normalized checklist items, and preserves proposal/ruling metadata |
| ruling normalization | `proposalId` absent or differs from `proposalSnapshot.id` | ruling normalizes to `null`; DAG completion cannot use it as proof |
| `suggest-goal complete` | existing active goal | proposal is persisted with a `prop_<uuid>` id, goal remains unchanged until accepted |
| `POST /goal accept-proposal` | pending complete proposal | goal status becomes `complete`, proposal metadata is removed |
| `POST /goal dismiss-proposal` | pending proposal | proposal metadata is removed, goal remains unchanged |
| auto continuation | active goal, idle conversation, no pending proposal | creates a `Goal Runner` user message and drains the main turn queue |
| auto continuation | max runner iterations reached without an error pause | creates pending `pause` proposal by `Goal Runner`, goal remains active until user confirms |
| auto continuation | 3 pure model-invocation failures, each ≤60s and first-to-third span ≤5m | third result atomically writes Goal `paused` + runner `error_paused`; no fourth continuation and no proposal |
| auto continuation | two qualifying failures then a completed reply or ordinary user batch | streak resets to zero; Goal stays active |
| auto continuation | user stop/cancel | streak is unchanged and not incremented |
| auto continuation | tool/application/unknown failure or duration > fast threshold | streak is broken/reset; Goal stays active |
| service restart | durable streak count is 2 in the current `goalUpdatedAt` epoch | next qualifying claim preserves the streak and third failure pauses |
| set/resume | stale error streak or `error_paused` runner exists | runner metadata is removed before a new continuation is claimed |
| runner normalization | malformed fields or `goalUpdatedAt` differs from the Goal epoch | malformed values normalize safely; stale streak cannot contribute to the current Goal |

### 5. Good / Base / Bad Cases
- Good: three immediate provider failures produce one durable `error_paused` state with a redacted reason, and restart/reload shows the same state without a fourth invocation.
- Good: `/goal Implement X` updates conversation metadata, summary metadata, and future prompts include `Session goal` with `Status: active` plus the default Trellis long-task checklist.
- Good: `/goal pause` keeps the objective visible but prompt guidance says not to actively drive new work until resumed.
- Good: `/goal clear` removes the metadata key and future prompts omit the entire session goal section.
- Base: `/goal` with no argument reads local selected-conversation metadata and shows a toast/status without creating a message.
- Base: the right-side goal panel reads the same selected-conversation metadata and offers mouse-driven lifecycle controls without adding new storage.
- Base: a completed goal remains visible as completed context but should not instruct agents to continue work.
- Base: an agent can suggest `complete` when it believes work is done, but the UI must show it as pending until the user confirms.
- Base: a newly set active goal starts bounded auto-continuation when the conversation is idle and agents exist.
- Base: prompt assembly for a goal with an owner includes an `Owner: <agentName>` line so the owner knows it is responsible for driving the goal.
- Base: auto-continuation stops when any proposal is pending so the user remains in control.
- Bad: allowing `/goal pause` to be sent through `POST /messages`, because it pollutes history and can trigger agents.
- Bad: making the drawer write metadata locally without the goal API, because other clients and summaries will not receive SSE refreshes.
- Bad: letting `suggest-goal` directly apply `complete`, `clear`, or `set`, because the user loses confirmation control.
- Bad: treating `failedReplies` as a thrown queue failure; routing intentionally returns failed Agent replies normally, so Goal streak evaluation must inspect the returned structured result.
- Bad: matching provider-specific billing text in the Goal layer or persisting raw assistant errors; classification belongs at the invocation boundary and only a redacted summary crosses SSE/UI.
- Bad: letting a direct `POST /goal set` body set `owner` or `proposedBy`, because ownership would be forgeable without a user-confirmed proposal.
- Bad: silently falling back to `default_last_agent` when the owner was removed from the roster, because the goal would continue under an agent the user never chose (fail-closed pause + proposal instead).
- Bad: letting `set-owner` clear a pending proposal or durable ruling, because an owner change must not erase how the current lifecycle state was reached.
- Bad: auto-continuing without a max iteration cap or while a pending proposal exists, because it can create runaway turns.
- Bad: leaving `metadata.sessionGoal = {}` on clear, because prompt/UI consumers may diverge on empty-object handling.

### 6. Tests Required
- `tests/smoke/server-smoke.test.js`
  - Set/pause/resume/complete/clear lifecycle persists expected metadata.
  - Invalid set and missing-goal state actions reject with explicit errors.
  - Goal updates broadcast goal and summary events.
  - Pending proposal accept/dismiss behavior updates metadata and broadcasts proposal events.
- `tests/runtime/agent-tool-bridge.test.js`
  - `suggest-goal` persists a pending proposal without mutating the active goal.
- `tests/runtime/agent-chat-tools.test.js`
  - CLI forwards `suggest-goal` action/reason/objective payloads to the agent tool endpoint.
- `tests/storage/turn-runtime-no-full-hydration.test.js`
  - Real SQLite poisons full public/private hydration while Goal continuation and direct Goal actions remain compatible.
  - Exact baseline fails at the old Goal hydration entries; the bounded implementation passes and returns header-only conversations.
- `tests/runtime/turn-orchestrator.test.js`
  - Prompt includes `Session goal` and objective for active goals.
  - Prompt includes status-specific guidance for paused and complete goals.
  - Prompt omits the section when the goal is cleared/missing.
  - Auto-continuation schedules bounded `Goal Runner` messages and creates a pending pause proposal at the safety budget.
  - Three fast structured model failures pause on the third invocation, reset rules are enforced, and a fourth continuation is never claimed.
  - Goal-owner routing: owner B executes even when A replied more recently; removed owner pauses fail-closed with a proposal and zero executions; empty owner keeps `default_last_agent`.
- `tests/runtime/session-goal-owner.test.js`
  - Owner normalization/persistence, accept-proposal stamping of `proposedBy`, `set-owner` validation (missing goal, non-participant, empty clear), direct-set stays ownerless, prompt `Owner` line, set-owner epoch migration (claim → set/clear owner → claim keeps `iteration` and streak), owner-removed pause preserving an existing pending proposal.
- `tests/http/conversation-goal-owner-roster.test.js`
  - `PUT /api/conversations/:id` removing the owner pauses the goal, raises the resume proposal, and reports `goalOwnerRemoved`; keeper/no-owner roster updates are unchanged.
- `tests/ui/session-goal-owner.test.js`
  - Goal drawer owner select rendering, `set-owner` submission, removed-owner display, and DAG-lock disabling.
- `tests/runtime/session-goal-auto-pause.test.js`
  - Covers provider/timeout/process classification, redaction, 60-second/5-minute windows, success/user/cancel resets, malformed/stale epochs, configurable threshold, `set`/`resume`, and real SQLite close/reopen persistence.
- Manual browser validation:
  - Open the goal drawer with the chat-header `目标 ▸` button.
  - Save, pause, resume, complete, and clear a goal; verify the drawer, conversation metadata line, composer status, and toast stay in sync.
- Validation commands:
  - `npm run build`
  - `npm run check`
  - `npm run typecheck`

### 7. Wrong vs Correct
#### Wrong
```ts
await baseRunConversationTurn(conversationId, { batchMessageIds });
markConversationQueueBatchConsumed(conversationId, batchEndMessageId);
// A failed Agent reply returned normally, so the loop immediately claims again.
```

#### Correct
```ts
const result = await baseRunConversationTurn(conversationId, { batchMessageIds });
const outcome = recordSessionGoalContinuationOutcome(store, conversationId, {
  sourceMessages: batchMessages,
  turn: result.turn,
  replies: result.replies,
  failures: result.failures,
});
broadcastGoalUpdateResult(conversationId, outcome);
markConversationQueueBatchConsumed(conversationId, batchEndMessageId);
```

#### Wrong
```js
// Browser submit path treats slash commands as normal chat.
applyOptimisticUserMessage(conversationId, content, clientRequestId);
await fetchJson(`/api/conversations/${conversationId}/messages`, {
  method: 'POST',
  body: { content, clientRequestId },
});
```
- This persists `/goal ...` in conversation history and may start an agent turn.

#### Correct
```js
const goalCommand = parseGoalCommand(content);
if (goalCommand) {
  await submitGoalCommand(conversationId, goalCommand);
  return;
}
```
- Intercept goal commands before optimistic rendering and before `POST /messages`.

#### Wrong
```ts
metadata.sessionGoal = {};
```
- Empty objects force every consumer to guess whether a goal exists.

#### Correct
```ts
const { sessionGoal, ...remainingMetadata } = metadata;
return remainingMetadata;
```
- Clearing removes the metadata key and keeps prompt/UI checks consistent.
