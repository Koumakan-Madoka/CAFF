# Conversation Turn Queue

## Bounded Conversation Hydration

### Scope And Signatures

Persistent Goal/turn execution must not materialize a conversation's complete public or private message history. Production `ChatAppStore` exposes these purpose-specific projections:

- `getConversationWithoutMessages(conversationId)` and `updateConversationWithoutMessages(conversationId, updates)` for header/metadata/roster reads and writes.
- `inferLastConsumedUserMessageId(conversationId)` and `listPendingMainUserMessages(conversationId, afterMessageId, { limit? })` for restart inference and cursor-scoped main-lane discovery; queue drain supplies the 256-row runtime projection limit so each successful batch advances only across rows it hydrated.
- `findPreviousUserMessageId(conversationId, { createdAt, id })` for deletion reconciliation.
- `findLatestPublicCompletedAssistantReplyAgentId(conversationId, participantAgentIds)` for default routing without parsing a reply row in JavaScript.
- `listMessagesByIds(conversationId, messageIds)` for bounded batch hydration.
- `listPromptMessages(conversationId, { historyLimit=24, currentTurnId?, requiredMessageIds?, before? })` for the canonical prompt/final union.
- `listSideDispatchRecoveryMessages()` and `listAssistantRepliesForSourceMessage(conversationId, sourceMessageId)` for restart-safe side-lane recovery.
- `listPrivateMessagesForAgent(conversationId, agentId, { limit })` for authorized bounded mailbox projection.

Every message projection is ordered by `(createdAt, id)` ascending. Runtime message-id inputs are deduplicated and capped at 256; prompt history accepts `0..100`, defaults to 24, and production callers use 24. The authorized private mailbox defaults to 24 rows and caps an explicit limit at 100. No schema or migration is required: the existing `(conversation_id, created_at, id)`, `turn_id`, and primary-key indexes support these reads.

### Runtime Contracts

- A real `ChatAppStore` is recognized by its bounded-projection marker or class identity. If any required projection is absent, Goal/turn execution fails with `501 Bounded conversation projection is unavailable`; it must never fall back to `getConversation()` or unbounded `listMessages()`. Legacy plain-object test doubles may retain their compatibility path, while new compatibility fixtures should implement the bounded methods directly.
- Turn start freezes `promptSnapshotMessageIds` from the latest 24 ordinary history rows plus every claimed batch/source row. Later hops re-read only those ids plus rows with the current `turnId`; they do not recompute the recent-24 window, so current replies cannot evict turn-start history.
- Prompt injection, Agent Context Inspector capture, and the final returned conversation projection consume the same bounded union. Current-turn and explicit rows survive even when older than the recent window; union duplicates are removed and canonical order is preserved.
- Main queue startup prefers the durable `conversationTurnQueue.lastConsumedUserMessageId`, including explicit empty string. Missing durable metadata uses targeted legacy inference. Pending discovery excludes persisted `dispatchLane='side'` rows and still honors the in-memory side-id set.
- Successful main batches persist the consumed user id; failed batches leave both cursors unchanged. More than 256 pending user rows are selected in stable SQL-limited batches, and the durable cursor advances only to the last row of each successful batch before the next batch is selected. Deleting the consumed row reads only the previous surviving user id and persists the reconciled cursor. Assistant-only deletion still persists the unchanged cursor through the existing deletion service contract.
- Default routing priority remains explicit `initialAgentIds` > actionable user mention > latest qualifying public completed current-participant reply > first participant. The SQL projection excludes failed/incomplete/empty/private/removed-Agent rows and uses `(createdAt,id)` for ties.
- Side submission/recovery stores a bounded snapshot id set through the source message. Slot grant rehydrates current content for exactly those ids plus its current turn; later ids remain invisible. Restart discovers only unresolved persisted side sources instead of hydrating every conversation.
- Private mailbox SQL applies authorization before its row limit. Public history never gains private-message repository rows, and old public `privateOnly` rows keep the existing prompt visibility filter.
- `POST /messages`, Goal event payloads, and turn results may carry a bounded/header-only `conversation.messages` projection. Browser consumers must continue treating message pagination/SSE as authoritative for full timeline navigation.

### Validation Matrix

| Case | Required result |
| --- | --- |
| exact baseline `75deccd8` with `getConversation` / `listMessages` poison | independent restart, queue, Goal, routing, side, private, and deletion tests fail at old hydration entrypoints |
| current implementation with the same poison | all scenarios pass; forbidden call count stays zero |
| >24 history plus old explicit source and a current reply | prompt has 24 + source once; final union adds current reply once; canonical order |
| 300 pending main-lane user rows | drain executes 256 then 44; each batch contains all rows its cursor crosses and persists that batch endpoint only after success |
| imported nullable `turn_id` history plus a current turn | recent history retains the latest 24 nullable rows and unions the current-turn rows |
| side source followed by a later persisted row | recovered prompt contains 24-before + source; later row absent |
| required production method removed | fail closed with 501 before a run-store/active-turn side effect |
| 15,052-message production-shape gate | six scenarios pass pinned heap/RSS/latency/cardinality budgets and SQLite integrity check |

### Good / Base / Bad Cases

- Good: a 3,044-message conversation starts from one old explicit batch row; the Agent sees that row once, the fixed latest 24 rows, and current-turn replies, while full hydration poison remains untouched.
- Good: restart discovers one unresolved side source through SQL and rehydrates its 25 snapshotted ids; a later persisted row stays invisible.
- Base: a short conversation has fewer than 24 ordinary rows, so the prompt contains fewer rows; 24 is a maximum window, not padding.
- Base: more than 256 pending user rows drain in stable bounded id batches and advance the durable cursor after each successful batch.
- Bad: recomputing latest 24 on every hop, because current replies evict turn-start history and make Agent prompts inconsistent within one turn.
- Bad: catching a missing projection and calling `getConversation()`, because one wiring error restores conversation-size-dependent memory.

### Required Tests And Gate

- `tests/storage/turn-runtime-no-full-hydration.test.js`: real SQLite poison, baseline red/current green, routing exclusions/ties, explicit/current union, side snapshot, private visibility, Goal actions, fail-closed, and deletion reconciliation.
- Existing `turn-orchestrator`, session Goal, message deletion, image preflight, agent executor/bridge, and server smoke suites remain compatibility gates.
- `scripts/p2ab-bounded-hydration-gate.js` uses `scripts/p2ab-bounded-hydration/{synthetic-seed.js,gate-child.js}` to run `main-turn`, `goal-300`, `concurrent-turns`, `restart-recovery`, `side-snapshot`, and `deletion-reconcile`. It records every projection's selected rows, enforces `historyLimit + current-turn rows + required ids`, poisons full hydration, samples heap/RSS in process and RSS externally, and uses only synthetic isolated data.

### Wrong Vs Correct

#### Wrong
```ts
const conversation = store.getConversation(conversationId);
const promptMessages = conversation.messages.slice(-24);
```
This parses every historical metadata row before clipping the JavaScript array and loses explicit rows outside the window.

#### Correct
```ts
const promptMessages = store.listPromptMessages(conversationId, {
  historyLimit: 24,
  currentTurnId: turnId,
  requiredMessageIds: promptSnapshotMessageIds,
});
```
SQLite selects the bounded union first, then the runtime applies visibility and prompt-user replacement to that canonical set.

## Default Initial Agent Resolution

### 1. Scope / Trigger

- Trigger: a main-lane user message has no explicit initial target, or image capability preflight must identify the same initial target that text routing will execute.
- Owner: `server/domain/conversation/turn/initial-target-resolution.ts`.
- Consumers: `routing-executor.ts` for authoritative main-lane execution and `image-preflight.ts` for capability validation. Side-lane explicit single-mention dispatch keeps its existing target resolver.

### 2. Signatures

- `resolveMostRecentPublicReplyAgentId(conversation) -> string` returns a current participant Agent id or `''`.
- `resolveInitialTurnTargets(turnInput, conversation) -> { agentIds, strategy, executionMode, explicitIntent, privateOnly, cleanedUserText }`.
- `resolveInitialTargetAgentIds(turnInput, conversation) -> string[]` is the image-preflight compatibility projection of the shared result.
- `assertImagePreflightForTargets(turnInput, conversation, { modelCatalog, targetResolution? })` accepts a precomputed shared resolution so validation and execution cannot select different targets.

### 3. Contracts

- Initial target priority is valid explicit `initialAgentIds`, actionable user mentions, most recent qualifying public-reply Agent, then the first participant.
- A qualifying public reply has `role='assistant'`, `status='completed'`, non-empty trimmed content, a current participant `agentId`, and no private projection (`!Boolean(metadata.privateOnly)`, `message.visibility !== 'private'`, and `metadata.visibility !== 'private'`). Private-message repository rows never enter the public conversation message list.
- The latest qualifying reply is selected by persisted `(createdAt, id)` ascending order. Equal timestamps use the message id as the deterministic tie-breaker, matching `ChatMessageRepository.listByConversationId`; missing timestamps in synthetic inputs fall back to array order.
- Strategies are observable: `user_mentions`, `default_last_agent`, or `default_first_agent`. Explicit initial targets preserve their caller-supplied `entryStrategy`, execution mode, cleaned text, private-only flag, and explicit-intent projection.
- `routing-executor` resolves after a main-lane batch is claimed. A queued unmentioned message therefore sees public replies completed before its batch actually starts, including state reloaded from SQLite after restart.
- Batch-message metadata may carry explicit per-message targets: when rebuilding the turn input for a claimed batch, `routing-executor` collects `initialAgentIds` from each batch message's `metadata.initialAgentIds` and passes them as the explicit target (same priority as caller-supplied ids, above `default_last_agent`). The goal-owner continuation path stamps `metadata.initialAgentIds = [ownerAgentId]` on the `Goal Runner` message this way; messages without the stamp keep default resolution.
- Submission-time image preflight remains a fast-fail for idle messages and stable explicit targets. When a busy conversation accepts an unmentioned default-routed image message, submission defers that check; `routing-executor` re-resolves the execution-time target and performs the authoritative preflight from canonical `metadata.contentBlocks` before launching any Agent.
- An authoritative queued-image preflight failure uses the existing queue-failure path: no Agent launches, the failed batch remains pending, and runtime queue failure metadata stays visible. Do not freeze a default Agent at user-message creation just to preserve pre-persistence rejection.

### 4. Validation And Error Matrix

| Case | Expected result |
| --- | --- |
| valid explicit `initialAgentIds` plus user mention | explicit ids win and keep explicit entry settings |
| actionable mention without explicit ids | mentioned ids and existing serial/parallel intent behavior |
| unmentioned message after B completed a non-empty public reply | B, `strategy='default_last_agent'` |
| newer failed, queued, streaming, empty, private-only, or private-visibility reply | skip it and use the prior qualifying current participant |
| newest qualifying reply belongs to a removed Agent | skip it; use the next qualifying current participant or first fallback |
| no qualifying public reply | first participant, `strategy='default_first_agent'` |
| equal persisted timestamps | lexically greater message id is later and wins deterministically after restart |
| busy main lane accepts unmentioned image while current default is A; B replies before batch start | defer submission check; execute-time resolution and preflight both target B |
| explicit single mention while busy | existing side lane and submission-time image preflight remain unchanged |
| execution-time target cannot read images | `MODEL_NO_IMAGE_INPUT`; no Agent invocation; queued batch remains pending |
| queued batch message carries `metadata.initialAgentIds=[B]` while B did not reply last | B executes; stamped target outranks `default_last_agent` |

### 5. Good / Base / Bad Cases

- Good: A conversation lists A first, but B most recently completed a public reply. Plain text and image preflight both select B; task metadata records `default_last_agent`.
- Base: a new conversation has no completed public reply, so the first participant remains the default and existing first-message behavior is unchanged.
- Bad: image preflight independently falls back to `agents[0]` while routing uses the last reply; the image can be rejected for the wrong model or passed to a model that cannot read it.
- Bad: resolving a queued default target when the user message is created; this ignores public replies completed before the serialized batch begins.

### 6. Tests Required

- `tests/runtime/initial-target-resolution.test.js`: priority chain, every exclusion, removed participant, `(createdAt,id)` tie-break, first fallback, and close/reopen SQLite persistence.
- `tests/runtime/image-preflight.test.js`: image target projection selects the same latest public Agent and validates that Agent's model capability.
- `tests/runtime/turn-orchestrator.test.js`: actual executed Agent and `enqueueReason='default_last_agent'`; busy queued image defers submission preflight, re-resolves after the prior reply, and executes the same vision-capable Agent.
- Full turn-orchestrator regressions cover side lane, Goal continuation, Stop, handoff, queue recovery, explicit mention, and image-only persistence.

### 7. Wrong Vs Correct

#### Wrong
```ts
const targetIds = mentionedAgentIds.length > 0
  ? mentionedAgentIds
  : conversation.agents[0] ? [conversation.agents[0].id] : [];
```
- This duplicates target policy and cannot observe the most recent qualifying public reply.

#### Correct
```ts
const targetResolution = resolveInitialTurnTargets(turnInput, conversation);
assertImagePreflightForTargets(turnInput, conversation, {
  modelCatalog,
  targetResolution,
});
```
- One domain resolver owns priority, filtering, ordering, strategy, and cleaned-text behavior; consumers project or validate the same result.

## Immediate Private Handoff Scheduling

### 1. Scope / Trigger

- Trigger: an Agent uses `send-private` with handoff enabled during its source run, or its completed public reply contains an actionable Agent mention.
- Owner: the `createRoutingExecutor()` turn-local scheduler in `server/domain/conversation/turn/routing-executor.ts`.
- Non-owners: user side-lane dispatch, cross-conversation delivery, and Pi session/runtime code do not consult this ledger.

### 2. Signatures And Identity

- `enqueueAgent({ agentIds, triggerType, triggeredByAgentId, parentRunId, triggeredByMessageId, enqueueReason }) -> { enqueuedAgentIds, dispatch }`.
- `triggerType='private'` comes from `agent-tool-bridge`: source identity is `context.agentId` plus `context.stage.runId`.
- `triggerType='agent'` comes from completed public reply routing in `agent-executor`: source identity is `agent.id` plus `result.runId || handle.runId`.
- The cross-channel key is `JSON.stringify([sourceAgentId, sourceRunId || turnId, recipientAgentId])`.
- `dispatch[]` entries contain only `{ agentId, outcome, detail }`; outcomes remain `launched`, `duplicate`, `already_running`, `queued`, or `capacity_limited`.

### 3. Contracts

- A private message is persisted before dispatch. An eligible idle recipient launches immediately, reserves one hop, and is tracked until settlement. Self-private notes and `--no-handoff` remain persistence-only.
- Successful dispatch is deduplicated across private handoff and ordinary public mention by `(sourceAgentId, sourceRunId, recipientAgentId)`. A duplicate message remains durable and visible to its intended audience but creates no model run and consumes no hop.
- Keep two distinct ledgers. Private-private attempt deduplication records before busy/capacity checks to prevent polling. The shared cross-channel ledger records only `launched` private outcomes and accepted ordinary queue entries. Do not use private attempt keys as proof that a run started.
- A private `already_running` or `capacity_limited` result does not suppress a later public mention. That mention remains subject to ordinary queue, stop, capacity, and hop limits.
- `turn_finished`, root task settlement, active-turn cleanup, and Goal continuation wait until all immediately launched private recipients settle. A sender final cannot orphan an in-flight recipient.
- Stop applies to every registered sender/recipient handle and prevents late launches. Concurrent prompt construction excludes other Agents' incomplete assistant placeholders.
- Agent guidance requires one complete private message per recipient per trace, no polling/P2 wait, and commit-pinned formal review. After a formal review request, the author freezes repository writes for the remainder of that trace.

### 4. Validation And Error Matrix

| Case | Expected behavior |
| --- | --- |
| Idle recipient and capacity available | Persist and launch immediately; `dispatch.outcome='launched'`. |
| Same source trace repeats private recipient | Persist only; `duplicate`; current recipient run may not see later content. |
| Private launch succeeds, then same source run publicly mentions recipient | Keep public message visible; `duplicate`; no queue entry or hop, whether private run is active or completed. |
| Private launch to B, then same source run publicly mentions B and C | Suppress only B; queue C normally. |
| Recipient already running for another trace | Private result is `already_running`; do not mark cross-channel success; later public mention remains eligible. |
| Parallel/hop capacity exhausted | Private result is `capacity_limited`; do not mark cross-channel success; later public mention uses ordinary limits. |
| `--no-handoff` private message, then public mention | Private message is persistence-only; public mention dispatches normally. |
| Different source Agent, source run, or recipient | Distinct key; dispatch remains eligible. |
| Sender returns final before recipient | Wait for recipient, then emit exactly one terminal turn event. |
| User stops | Cancel registered executions/waits and prevent late launch. |

### 5. Good / Base / Bad Cases

- Good: A privately launches B, then publicly mentions B and C. B executes once, C executes once, and only three hops exist: A, B, C.
- Base: A's private attempt for B is capacity-limited, then A publicly mentions B. The public handoff may queue and execute under ordinary limits because no private run started.
- Bad: reusing `privateLaunchKeys` for public routing. That set records failed busy/capacity attempts and would silently suppress a legal public handoff.
- Bad: keying only by recipient. That would suppress another sender or a later source run.

### 6. Tests Required

- `tests/runtime/turn-orchestrator.test.js`: private plus same public recipient executes once while the recipient is running and after it completes; repeated private remains duplicate; a different public recipient executes; duplicate consumes no hop; capacity-limited private does not poison public eligibility; Stop prevents late launch.
- `tests/runtime/agent-tool-bridge.test.js`: handoff-enabled private dispatch passes `triggerType='private'`, sender id, stage run id, and recipient ids; self-private and `--no-handoff` never call `enqueueAgent`.
- `tests/runtime/agent-executor-hook.test.js`: actionable public mention passes `triggerType='agent'`, the same sender id, and completed Pi run id after completion hooks.

### 7. Wrong Vs Correct

#### Wrong
```ts
if (privateLaunchKeys.has(sourceTraceKey)) {
  return duplicate;
}
privateLaunchKeys.add(sourceTraceKey); // Also records capacity failures.
```

#### Correct
```ts
if (privateLaunchSucceeded) {
  dispatchedTraceRecipientKeys.add(sourceTraceKey);
}
if (triggerType === 'agent' && dispatchedTraceRecipientKeys.has(sourceTraceKey)) {
  return { enqueuedAgentIds: [], dispatch: [duplicate] };
}
```

## Message-History Mutation Idle Guard

- `turnOrchestrator.getConversationMutationState(conversationId)` is the authoritative synchronous deletion guard. It returns `{ active, dispatching, activeTurnCount, activeAgentSlotCount, queuedUserCount, queuedAgentSlotCount, busy }`.
- `queuedAgentSlotCount` comes from the tracked `queuedSideDispatches`, not only active slots or the runtime projection. Deletion must stay blocked while a side waiter can still acquire a slot.
- The delete service checks this state after acquiring the conversation mutation lease and immediately before its synchronous SQLite transaction. Do not insert an `await` between the idle check and transaction.
- Auto digest, manual digest, and message deletion share `createConversationMutationCoordinator`; a scheduled/running digest makes deletion return `409` instead of waiting.
- Message-page eligibility may display current busy state, but the server submit-time guard remains authoritative because UI/runtime snapshots can become stale.
- `conversation.metadata.conversationTurnQueue.lastConsumedUserMessageId` is the durable main-lane consumption cursor. Orchestrator initialization prefers this explicit value over the trailing-user heuristic; an explicit empty string is meaningful and must not be treated as absent.
- Every successfully settled main-lane batch persists its consumed user-message ID. A failed queued batch does not advance either the in-memory or durable cursor, so restart recovery can retry it.
- A successful deletion calls `reconcileConversationQueueAfterMessageDeletion(conversationId, deletedMessages)`. When the deleted batch contains `lastConsumedUserMessageId`, the cursor falls back to the previous surviving user message by `(createdAt, id)` order. The reconciled cursor is persisted after every deletion, including assistant-only deletion that leaves the current consumed user as the final row; otherwise restart would classify that trailing historical user as pending and may replay it.
- `tests/runtime/turn-orchestrator.test.js` asserts a busy target side-dispatch reports `queuedAgentSlotCount: 1`, successful queue drain persists the latest consumed cursor, and deletion reconciliation survives a fresh orchestrator without creating pending work; message deletion tests assert all busy dimensions reject without database changes.
- The complete API, validation, storage, attachment, SSE, and UI contract is in `../backend/conversation-message-deletion.md`.

## Scenario: Chat Workbench Continuous Send and Agent Side Dispatch

### 1. Scope / Trigger
- Trigger: touching `server/api/conversations-controller.ts`, `server/api/bootstrap-controller.ts`, `server/domain/conversation/turn-orchestrator.ts`, `server/domain/conversation/turn/routing-executor.ts`, `server/domain/conversation/turn/turn-events.ts`, `server/domain/conversation/turn/turn-state.ts`, `server/domain/conversation/turn/turn-runtime-payload.ts`, `public/app.js`, `public/chat/conversation-pane.js`, or `public/chat/message-timeline.js`.
- Goal: decouple **message acceptance** from **turn execution** so the user can keep sending while a conversation is already busy, while allowing a narrow same-conversation side-dispatch lane for explicit single-agent mentions.
- Constraints:
  - the main lane still allows only one active conversation turn at a time
  - same-conversation parallelism is limited to user-authored explicit single `@Agent` messages
  - multi-mention, no-mention/broadcast, and agent-to-agent handoff stay on the main lane in v1
  - each `(conversationId, agentId)` pair may have at most one active slot at a time

### 2. Signatures
- `POST /api/conversations/:conversationId/messages`
  - Request: `{ content: string, imageIds?: string[], clientRequestId?: string }`
  - Success response:
    - `acceptedMessage`: persisted user message that was accepted immediately
    - `conversation`: latest stored conversation snapshot
    - `conversations`: updated conversation summaries
    - `dispatch`: `'started' | 'queued'`
    - `dispatchLane`: `'main' | 'side'`
    - `dispatchTargetAgentId`: `string | null`
    - `runtime`: latest runtime payload from `buildRuntimePayload()`
- `POST /api/conversations/:conversationId/stop`
  - Success response: `{ conversationId, turn, agentSlots, runtime }`
  - Domain result from `turnOrchestrator.requestStopConversationExecution(...)` also tracks `cancelledQueuedSideDispatchCount`
- `DELETE /api/conversations/:conversationId`
  - Default behavior rejects active/dispatching/queued main-lane conversations and any active/queued side-slot work with `409`
  - `?force=1` may delete only an idle conversation whose queued main-lane batch already failed and is still pending
  - `force` does not override queued side-slot work
- `GET /api/events?conversationId=...`
  - Initial events must include `runtime_state`, existing `turn_progress`, and existing `agent_slot_progress` for that conversation
  - Side-slot streaming events use `agent_slot_progress` and terminal `agent_slot_finished`
- `turnOrchestrator.submitConversationMessage(conversationId, input)`
  - Persists the message first, dispatches to main lane or side lane, and returns the same payload shape as the HTTP route
- `turnOrchestrator.getConversationQueueDepth(conversationId)`
  - Returns pending main-lane user-message count for the next batch
- `turnOrchestrator.runConversationTurn(conversationId, { batchMessageIds? | content? })`
  - Starts a main-lane turn from stored queued messages or normalized input
  - Must reject with `409` when the conversation is already dispatching or any side slot is active
- Runtime payload additions from `buildRuntimePayload()`:
  - `dispatchingConversationIds: string[]`
  - `conversationQueueDepths: Record<string, number>`
  - `conversationQueueFailures: Record<string, { failedBatchCount: number, lastFailureAt: string, lastFailureMessage: string }>`
  - `agentSlotQueueDepths: Record<string, Record<string, number>>`
  - `activeTurns[]` with `batchStartMessageId`, `batchEndMessageId`, `consumedUpToMessageId`, `inputMessageCount`, and `queueDepth`
  - `activeAgentSlots[]` with `slotId`, `conversationId`, `turnId`, `sourceMessageId`, `agentId`, `agentName`, `status`, `turnStatus`, `assistantMessageId`, `taskId`, `runId`, `replyLength`, `preview`, `finalContent`, `errorMessage`, `currentTool*`, and stop fields

### 3. Contracts
- `POST /messages` must not wait for the full agent turn to finish. It acknowledges accepted work immediately and relies on SSE/runtime updates for the long-running state.
- A message is non-empty when `content.trim()` is non-empty or `imageIds` contains at least one valid opaque upload id. Image-only messages persist `content = ''`; the store derives image blocks under `message.metadata.contentBlocks` and runtime consumers must read that canonical location.
- A persisted queued batch with no text remains executable when at least one batched user message has a canonical image block. Direct `runConversationTurn(..., { imageIds })` must pass those ids into `store.createMessage()` so ownership validation, upload attachment, and content-block derivation stay atomic; routing code must not synthesize a second content-block representation.
- Persisted-batch execution accepts image references only from the selected messages' canonical `metadata.contentBlocks`. A mixed internal payload containing both `batchMessageIds` and detached `imageIds` is invalid and must return `400` instead of silently ignoring either source.
- When the browser sends `clientRequestId`, the accepted persisted user message must echo it in `acceptedMessage.metadata.clientRequestId` so optimistic user-message rendering can reconcile without showing duplicates after SSE or refresh.
- New user messages are always stored first, then scheduled:
  - no active/dispatching work → main lane `dispatch = 'started'`, `dispatchLane = 'main'`
  - explicit single `@Agent` while the conversation already has active/dispatching work → side lane `dispatchLane = 'side'`
  - if that target agent's slot is idle → side lane `dispatch = 'started'`
  - if that target agent's slot is busy → side lane `dispatch = 'queued'` and `agentSlotQueueDepths[conversationId][agentId]` increments
  - anything else (broadcast, multi-mention, no explicit single mention) stays on the main lane and uses queued main-batch semantics
- Main-lane serialization rules:
  - at most one main turn may be active/dispatching per conversation
  - after `baseRunConversationTurn` returns and before the next loop claim, call `recordSessionGoalContinuationOutcome` with the exact batch source messages plus returned `turn/replies/failures`; Agent-level failures return normally and are not represented by the queue `catch`
  - persist/clear the Goal failure streak before marking the batch consumed; a third qualifying Goal Runner failure atomically pauses the Goal, so the next empty-queue continuation check observes `inactive_goal`
  - ordinary user batches and successful Goal Runner replies reset an existing streak; user stop is neutral; infrastructure throws keep the batch pending through the existing queue-failure path
  - later main-lane user messages become the next batch instead of opening a second main turn
  - direct `runConversationTurn()` calls must respect active side slots and reject instead of bypassing the gate
- Side-lane slot rules:
  - side dispatch uses a per-agent slot key `(conversationId, agentId)`
  - different agents in the same conversation may have side/main work concurrently
  - the same target agent cannot run two side invocations at once; later requests queue behind the slot
  - queued side waiters must be cancellable by conversation stop and cleared by conversation delete/reset
- Side message persistence rules:
  - accepted side-lane user messages must store `metadata.dispatchLane = 'side'`
  - accepted side-lane user messages must store `metadata.dispatchTargetAgentId = <agentId>`
  - stopped side-lane source messages must persist `metadata.dispatchCancelled = true` plus timestamp/reason so restart recovery does not replay intentionally cancelled work
  - main-lane queue discovery must filter persisted side-lane messages by metadata instead of relying only on in-memory bookkeeping
- Prompt snapshot semantics:
  - main-lane `promptSnapshotMessageIds` still freezes visibility at dispatch time
  - side-lane submission stores snapshot message ids, not a frozen cloned transcript
  - when a queued side slot is finally granted, prompt history is rehydrated from current store messages for those ids so already-visible messages can carry their latest persisted content
  - later messages whose ids were not in the snapshot remain invisible to that side run
  - the side prompt user message may replace the stored content with the cleaned single-mention text, but keeps the same message id
- Stop / delete / recovery:
  - `POST /stop` must stop the active main turn, mark active side slots as `stopRequested`, persist a cancellation marker on their source side messages, and cancel queued side waiters before they acquire a slot
  - queued side waiters cancelled by stop must also persist a cancellation marker on their source side messages
  - orchestrator startup must recover persisted side-lane user messages that have no cancellation marker and no terminal assistant reply; any stale queued/streaming assistant placeholder tied to that source message must be marked failed before the side run is rescheduled
  - orchestrator startup must also mark stale queued/streaming assistant placeholders failed for cancelled persisted side-lane user messages before skipping replay
  - delete stays blocked while runtime reports active/dispatching main work, active side slots, queued main batches, or queued side-slot work
  - force delete remains only for idle failed main-lane queued batches; it must not discard queued side-slot work through the same override
- UI / timeline ownership:
  - `state.sending` only means the browser is waiting for the `POST /messages` HTTP response
  - busy / stop / delete / live-stage UI must combine `activeTurns`, `dispatchingConversationIds`, `conversationQueueDepths`, `conversationQueueFailures`, `activeAgentSlots`, and `agentSlotQueueDepths`
  - live message stages may come from either the main turn or an active side slot; timeline rendering must follow both
  - completed stages that are still waiting on blocking post-reply work may carry `finalContent` so the UI shows the full reply instead of clipped `preview` until the normal message refresh arrives
  - final completed message broadcasts should happen before awaited digest/side-effect hooks; same-turn handoff routing may still wait for those hooks so reusable experience is absorbed before the next agent runs
  - live-stage display must prefer `finalContent`, then already-populated non-placeholder message content, and only then clipped `preview`; bridge-updated assistant messages can contain full content while their stage is still marked running/finalizing
  - pending-experience and model-mode digest status should also appear as a temporary timeline card so users can see why routing is still waiting; model progress may include bounded `modelTrace.thinkingPreview` and `modelTrace.outputPreview` diagnostics from provider/pi events
  - one-shot active-tool progress recovery keeps the Agent stage `running`: `run_recovering` temporarily exposes the bounded watchdog message through existing turn-progress SSE, `run_recovery_started` clears it, and task history records `agent_reply_recovering` / `agent_reply_recovery_started`; only the later fail-closed `run_terminating` transition marks the stage terminating
  - recovery task/SSE projections may contain attempt number, bounded reason, and clipped tool name only; tool arguments and the injected recovery prompt remain runtime-private
  - `turn_finished` and `agent_slot_finished` UI handlers must pass the final `payload.turn` / `payload.slot` into tool-trace synchronization before removing active runtime state; passing `null` drops failed terminal status and can finalize a running bridge step as succeeded/observed
- Game exception:
  - who-is-undercover / werewolf automatic-host phases still reject manual chat sends with `409`

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| `POST /messages` | conversation missing | `404 Conversation not found` / localized equivalent from controller |
| `POST /messages` | empty content after trim and no `imageIds` | `400 Message content is required` |
| `POST /messages` | empty content with valid `imageIds` | `200`; persist an image-only message and execute it through the normal queue |
| queued batch drain | concatenated text is empty but canonical `metadata.contentBlocks` contains an image | execute the batch instead of rejecting it as empty |
| `POST /messages` | no agents selected | `400 Add at least one agent to the conversation first` |
| `POST /messages` | undercover auto-host phase | `409` and keep manual input blocked |
| `POST /messages` | werewolf auto-host phase | `409` and keep manual input blocked |
| `POST /messages` | explicit single `@Agent`, conversation busy, target idle | `200`, `dispatch = 'started'`, `dispatchLane = 'side'`, `dispatchTargetAgentId = <agentId>` |
| `POST /messages` | explicit single `@Agent`, conversation busy, target busy | `200`, `dispatch = 'queued'`, `dispatchLane = 'side'`, and slot queue depth increments |
| `runConversationTurn(..., { batchMessageIds })` | no queued user messages resolved | `400 No queued user messages are available for this batch` |
| `runConversationTurn(...)` | conversation dispatching or any side slot active | `409 This conversation is already processing another turn` |
| `POST /stop` | no active turn, no active side slot, and no queued side waiter | `409 This conversation is not processing a turn` |
| `DELETE /conversation` | active or dispatching main turn | `409 当前会话正在处理消息，请先停止并等待当前回合结束后再删除` |
| `DELETE /conversation` | active side slot | `409 当前会话正在处理消息，请先停止并等待当前回合结束后再删除` |
| `DELETE /conversation` | queued main-lane work without valid recovery override | `409 当前会话仍有待处理消息，请等待自动续跑完成后再删除` |
| `DELETE /conversation` | queued side-slot work | `409 当前会话仍有待处理消息，请等待自动续跑完成后再删除` |
| `DELETE /conversation?force=1` | idle queued main-lane failure | delete succeeds and drops the queued main-lane messages with the conversation |
| queue drain loop | `runConversationTurn()` throws | log the failure, keep queue pending, do not advance `lastConsumedUserMessageId`, and expose queue failure metadata |
| queue drain loop | Goal Runner turn returns zero replies + structured eligible failures in ≤60s | persist the same-epoch streak; on count 3 pause Goal before another continuation can be claimed |
| queue drain loop | Agent failed replies exist but the call did not throw | still consume the user message under existing semantics; evaluate Goal streak from the returned result instead of queue `catch` |
| queue drain loop | ordinary user batch follows a Goal failure streak | clear the streak without changing the Goal lifecycle status |

### 5. Good / Base / Bad Cases
- Good: idle conversation accepts a user message, returns `dispatch = 'started'`, creates one active main turn, and shows main queue depth `0`.
- Good: an image-only message is accepted with empty `content`, persists canonical image blocks under metadata, and reaches multimodal invocation without losing its image ids during queue drain.
- Good: while the main turn is running, an explicit single `@Beta` message with idle target returns `dispatch = 'started'`, `dispatchLane = 'side'`, and runtime shows one `activeTurn` plus one `activeAgentSlot`.
- Good: when the same target agent is already busy, a second explicit single mention returns `dispatch = 'queued'`, increments `agentSlotQueueDepths`, and runs after the first slot releases.
- Good: side-lane user messages persist `metadata.dispatchLane = 'side'`, so main queue drain never consumes them as normal queued user batches after restart or retry.
- Base: the main turn ends while a side slot still runs; direct `runConversationTurn()` remains blocked until the side slot finishes.
- Base: user presses Stop during an active main turn with queued side waiters; the main turn stops at a safe boundary and queued side waiters are cancelled before they auto-start.
- Base: a queued side waiter stores snapshot ids at submission time and rehydrates the latest persisted content for those ids when the slot is granted.
- Base: after a restart, a persisted side-lane source message without a terminal reply is rescheduled, while stale `Thinking...` placeholders tied to it are marked failed and stopped side-lane source messages stay cancelled.
- Bad: allowing an explicit single-mention side message to fall into `conversationQueueDepths` main-batch consumption.
- Bad: cloning the entire side prompt transcript at submit time so a queued side run misses already-persisted updates from snapshotted messages.
- Bad: allowing delete just because main queue depth is zero while a side slot is still active or queued.

### 6. Tests Required
- `tests/runtime/turn-orchestrator.test.js`
  - persisted and direct image-only inputs retain canonical image blocks and reach agent execution
  - idle target side-dispatch starts concurrently with the main lane
  - direct main turns are blocked while a side slot is active
  - busy target side-dispatch queues per agent slot and later runs
  - stop cancels queued side waiters before they start and persists a cancellation marker on the source side message
  - queued side-dispatch rehydrates snapshot content on grant
  - persisted side-dispatch messages without terminal replies recover on orchestrator startup
  - cancelled persisted side-dispatch messages finalize stale assistant placeholders without replaying
  - main queue still excludes late messages from the active prompt snapshot and drains serially
  - three fast Goal Runner model failures stop at exactly three, while the existing 20-turn budget-proposal path remains unchanged for successful continuations
- `tests/smoke/server-smoke.test.js`
  - `POST /messages` still accepts immediately and exposes lane/runtime fields
  - delete rejects active side slots
  - delete rejects queued side-slot work
- `tests/runtime/message-tool-trace.test.js`
  - finished main-turn and side-slot SSE payloads finalize failed running tool steps before runtime state removal
- Validation commands for closeout:
  - `npm run check`
  - `npm run typecheck`
  - `npm test`

### 7. Wrong vs Correct
#### Wrong
```ts
function isSideDispatchMessage(conversationId, messageId) {
  return sideDispatchMessageIds.get(conversationId)?.has(messageId);
}
```
- This relies only on in-memory bookkeeping.
- After a restart, persisted side-lane user messages can be mistaken for normal queued main-lane input.

#### Correct
```ts
function isSideDispatchMessage(conversationId, messageId, message) {
  const dispatchLane =
    message && message.metadata && typeof message.metadata === 'object'
      ? String(message.metadata.dispatchLane || '').trim()
      : '';

  if (dispatchLane === 'side') {
    return true;
  }

  return sideDispatchMessageIds.get(conversationId)?.has(messageId) === true;
}
```
- Persist the dispatch lane on the message metadata.
- Use metadata as the durable filter and keep the in-memory set only as a fast-path helper.

#### Wrong
```ts
async function runConversationTurn(conversationId, input) {
  return baseRunConversationTurn(conversationId, input);
}
```
- This bypasses side-slot activity.
- Internal callers can start a new main turn while a side slot is still running.

#### Correct
```ts
async function runConversationTurn(conversationId, input) {
  const normalizedConversationId = String(conversationId || '').trim();

  if (
    normalizedConversationId
    && (dispatchingConversationIds.has(normalizedConversationId) || hasActiveAgentSlots(normalizedConversationId))
  ) {
    throw createHttpError(409, 'This conversation is already processing another turn');
  }

  return baseRunConversationTurn(conversationId, input);
}
```
- Main-lane entrypoints must respect side-lane activity.
- Orchestrator-level gating keeps controller and internal call paths aligned.
