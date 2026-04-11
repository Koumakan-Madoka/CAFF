# Conversation Turn Queue

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
  - Request: `{ content: string }`
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
  - `activeAgentSlots[]` with `slotId`, `conversationId`, `turnId`, `sourceMessageId`, `agentId`, `agentName`, `status`, `turnStatus`, `assistantMessageId`, `taskId`, `runId`, `replyLength`, `preview`, `errorMessage`, `currentTool*`, and stop fields

### 3. Contracts
- `POST /messages` must not wait for the full agent turn to finish. It acknowledges accepted work immediately and relies on SSE/runtime updates for the long-running state.
- New user messages are always stored first, then scheduled:
  - no active/dispatching work → main lane `dispatch = 'started'`, `dispatchLane = 'main'`
  - explicit single `@Agent` while the conversation already has active/dispatching work → side lane `dispatchLane = 'side'`
  - if that target agent's slot is idle → side lane `dispatch = 'started'`
  - if that target agent's slot is busy → side lane `dispatch = 'queued'` and `agentSlotQueueDepths[conversationId][agentId]` increments
  - anything else (broadcast, multi-mention, no explicit single mention) stays on the main lane and uses queued main-batch semantics
- Main-lane serialization rules:
  - at most one main turn may be active/dispatching per conversation
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
  - main-lane queue discovery must filter persisted side-lane messages by metadata instead of relying only on in-memory bookkeeping
- Prompt snapshot semantics:
  - main-lane `promptSnapshotMessageIds` still freezes visibility at dispatch time
  - side-lane submission stores snapshot message ids, not a frozen cloned transcript
  - when a queued side slot is finally granted, prompt history is rehydrated from current store messages for those ids so already-visible messages can carry their latest persisted content
  - later messages whose ids were not in the snapshot remain invisible to that side run
  - the side prompt user message may replace the stored content with the cleaned single-mention text, but keeps the same message id
- Stop / delete / recovery:
  - `POST /stop` must stop the active main turn, mark active side slots as `stopRequested`, and cancel queued side waiters before they acquire a slot
  - delete stays blocked while runtime reports active/dispatching main work, active side slots, queued main batches, or queued side-slot work
  - force delete remains only for idle failed main-lane queued batches; it must not discard queued side-slot work through the same override
- UI / timeline ownership:
  - `state.sending` only means the browser is waiting for the `POST /messages` HTTP response
  - busy / stop / delete / live-stage UI must combine `activeTurns`, `dispatchingConversationIds`, `conversationQueueDepths`, `conversationQueueFailures`, `activeAgentSlots`, and `agentSlotQueueDepths`
  - live message stages may come from either the main turn or an active side slot; timeline rendering must follow both
- Game exception:
  - who-is-undercover / werewolf automatic-host phases still reject manual chat sends with `409`

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| `POST /messages` | conversation missing | `404 Conversation not found` / localized equivalent from controller |
| `POST /messages` | empty content after trim | `400 Message content is required` |
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

### 5. Good / Base / Bad Cases
- Good: idle conversation accepts a user message, returns `dispatch = 'started'`, creates one active main turn, and shows main queue depth `0`.
- Good: while the main turn is running, an explicit single `@Beta` message with idle target returns `dispatch = 'started'`, `dispatchLane = 'side'`, and runtime shows one `activeTurn` plus one `activeAgentSlot`.
- Good: when the same target agent is already busy, a second explicit single mention returns `dispatch = 'queued'`, increments `agentSlotQueueDepths`, and runs after the first slot releases.
- Good: side-lane user messages persist `metadata.dispatchLane = 'side'`, so main queue drain never consumes them as normal queued user batches after restart or retry.
- Base: the main turn ends while a side slot still runs; direct `runConversationTurn()` remains blocked until the side slot finishes.
- Base: user presses Stop during an active main turn with queued side waiters; the main turn stops at a safe boundary and queued side waiters are cancelled before they auto-start.
- Base: a queued side waiter stores snapshot ids at submission time and rehydrates the latest persisted content for those ids when the slot is granted.
- Bad: allowing an explicit single-mention side message to fall into `conversationQueueDepths` main-batch consumption.
- Bad: cloning the entire side prompt transcript at submit time so a queued side run misses already-persisted updates from snapshotted messages.
- Bad: allowing delete just because main queue depth is zero while a side slot is still active or queued.

### 6. Tests Required
- `tests/runtime/turn-orchestrator.test.js`
  - idle target side-dispatch starts concurrently with the main lane
  - direct main turns are blocked while a side slot is active
  - busy target side-dispatch queues per agent slot and later runs
  - stop cancels queued side waiters before they start
  - queued side-dispatch rehydrates snapshot content on grant
  - main queue still excludes late messages from the active prompt snapshot and drains serially
- `tests/smoke/server-smoke.test.js`
  - `POST /messages` still accepts immediately and exposes lane/runtime fields
  - delete rejects active side slots
  - delete rejects queued side-slot work
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
