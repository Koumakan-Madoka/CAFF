# Conversation Turn Queue

## Scenario: Chat Workbench Continuous Send

### 1. Scope / Trigger
- Trigger: touching `server/api/conversations-controller.ts`, `server/domain/conversation/turn-orchestrator.ts`, `server/domain/conversation/turn/routing-executor.ts`, `server/domain/conversation/turn/turn-state.ts`, `server/domain/conversation/turn/turn-runtime-payload.ts`, `public/app.js`, or `public/chat/conversation-pane.js`.
- Goal: decouple **message acceptance** from **turn execution** so the user can keep sending while one turn is already running.
- Constraint: one conversation still has at most one active run at a time. This spec does **not** authorize same-conversation multi-run parallel execution.
- Related runtime feature: `mention_parallel` still applies only inside one already-started turn when the routing mode explicitly chooses parallel speaker execution.

### 2. Signatures
- `POST /api/conversations/:conversationId/messages`
  - Request: `{ content: string }`
  - Success response:
    - `acceptedMessage`: persisted user message that was accepted immediately
    - `conversation`: latest stored conversation snapshot
    - `conversations`: updated conversation summaries
    - `dispatch`: `'started' | 'queued'`
    - `runtime`: latest runtime payload from `buildRuntimePayload()`
- `POST /api/conversations/:conversationId/stop`
  - Success response: `{ conversationId, turn, runtime }`
- `DELETE /api/conversations/:conversationId`
  - Default behavior rejects active/dispatching/queued conversations with `409`
  - `?force=1` may delete an idle conversation whose queued batch already failed and is still pending
- `turnOrchestrator.submitConversationMessage(conversationId, input)`
  - Persists the message, triggers queue drain, returns the same payload shape as the HTTP route
- `turnOrchestrator.getConversationQueueDepth(conversationId)`
  - Returns pending user-message count for the next batch
- `runConversationTurn(conversationId, { batchMessageIds })`
  - Starts a new turn from already-persisted queued user messages
- Runtime payload additions from `buildRuntimePayload()`:
  - `dispatchingConversationIds: string[]`
  - `conversationQueueDepths: Record<string, number>`
  - `conversationQueueFailures: Record<string, { failedBatchCount: number, lastFailureAt: string, lastFailureMessage: string }>`
  - `activeTurns[].batchStartMessageId`
  - `activeTurns[].batchEndMessageId`
  - `activeTurns[].consumedUpToMessageId`
  - `activeTurns[].inputMessageCount`
  - `activeTurns[].queueDepth`

### 3. Contracts
- `POST /messages` must not wait for the full agent turn to finish. It acknowledges accepted work immediately and relies on SSE/runtime updates for the long-running state.
- New user messages are always stored first, then scheduled:
  - no active/dispatching run → `dispatch = 'started'`
  - already active/dispatching run → `dispatch = 'queued'`
- Same-conversation concurrency stays serialized:
  - at most one conversation turn may be active
  - later user messages become the next batch instead of opening a second run
- Queue consumption is anchored by `lastConsumedUserMessageId`:
  - only successful batch completion advances the boundary
  - failed batches stay pending for a later drain/retry
  - queue failure state (`failedBatchCount`, `lastFailureAt`, `lastFailureMessage`) stays observable in runtime payload until a later drain succeeds or the conversation is force-deleted
- Batch metadata semantics:
  - `batchStartMessageId`: first queued user message consumed by this run
  - `batchEndMessageId`: last queued user message consumed by this run
  - `consumedUpToMessageId`: current consumed boundary for the run, normally equal to `batchEndMessageId`
  - `inputMessageCount`: number of stored user messages included in the batch
  - `queueDepth`: how many user messages are still waiting behind the active run
- Prompt snapshot semantics:
  - `promptSnapshotMessageIds` freezes the conversation messages visible at dispatch time
  - later user messages must **not** hot-insert into the active prompt
  - messages created by the current turn may still remain visible via `currentTurnId`
- Queued-batch prompt construction rules:
  - reuse the original stored user messages from `batchMessageIds`
  - preserve original message order in prompt history
  - do not replace the whole queued range with one synthetic history item
  - `inputText` for task metadata may be joined text, but `promptMessages` must still preserve stored history ordering
- UI/runtime ownership:
  - `state.sending` only means the browser is waiting for the `POST /messages` HTTP response
  - conversation busy/queued/stopping state must come from runtime payload fields (`activeTurns`, `activeConversationIds`, `dispatchingConversationIds`, `conversationQueueDepths`, `conversationQueueFailures`)
  - normal conversations keep composer input/send enabled while a turn is running
  - stop stays enabled only when a real `activeTurn` exists
  - delete stays blocked while the conversation is active, dispatching, queued, or already stopping
  - if an idle queued batch already failed, the UI may surface a guarded force-delete affordance that explicitly discards the pending queued messages
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
| `runConversationTurn(..., { batchMessageIds })` | no queued user messages resolved | `400 No queued user messages are available for this batch` |
| `POST /stop` | no active turn | `409 This conversation is not processing a turn` |
| `DELETE /conversation` | active or dispatching conversation | `409 当前会话正在处理消息，请先停止并等待当前回合结束后再删除` |
| `DELETE /conversation` | queued conversation without `force=1` recovery path | `409 当前会话仍有待处理消息，请等待自动续跑完成后再删除` |
| `DELETE /conversation?force=1` | idle queued conversation with recorded queue failure | delete succeeds and drops the queued messages with the conversation |
| queue drain loop | `runConversationTurn()` throws | log the failure, keep queue pending, do not advance `lastConsumedUserMessageId`, and expose queue failure metadata |

### 5. Good / Base / Bad Cases
- Good: idle conversation accepts a user message, returns `dispatch = 'started'`, creates one active turn, and shows queue depth `0`.
- Good: while the first turn is running, a second user message still persists immediately, returns `dispatch = 'queued'`, increments `queueDepth`, and becomes the next batch after the active turn ends.
- Good: when queued batch dispatch starts, any assistant messages that already existed in stored history before dispatch remain visible in the next prompt snapshot.
- Base: user presses Stop during an active turn; the turn becomes `stopRequested`, stops at a safe boundary, and the next queued batch starts afterward.
- Base: queue drain fails once; the failed batch remains pending and a later drain can retry it without message loss.
- Base: queued drain is stuck after a failure; the UI shows the failure state and the user can explicitly force-delete the conversation to discard the stuck queued messages.
- Bad: rejecting a second user message with `409` only because the conversation already has an active turn.
- Bad: advancing `lastConsumedUserMessageId` when `runConversationTurn()` failed.
- Bad: enabling Stop during a dispatching-only window where there is no `activeTurn` yet.
- Bad: allowing deletion while runtime still reports active/dispatching work or queued user messages.
- Bad: rebuilding queued history as one synthetic user message and dropping interleaving assistant context.

### 6. Tests Required
- `tests/runtime/turn-orchestrator.test.js`
  - queued batch excludes late user messages from the active prompt snapshot
  - queued batch preserves context that already existed before dispatch
  - user messages queue behind the active run and drain serially
  - stop request yields to the next queued batch
  - failed batch remains pending and can be retried later
- `tests/smoke/server-smoke.test.js`
  - `POST /messages` returns accepted payload immediately
  - assistant completion is later observed asynchronously through normal conversation polling/SSE flow
  - direct conversation delete rejects queued runtime work, not only active/dispatching work
  - explicit force delete succeeds for idle queued conversations that are stuck after a recorded drain failure
- Validation commands for closeout:
  - `npm run check`
  - `npm run typecheck`
  - `npm test`

### 7. Wrong vs Correct
#### Wrong
```ts
const result = await turnOrchestrator.runConversationTurn(conversationId, body.content);
sendJson(res, 200, result);
```
- This ties the HTTP lifetime to the full turn lifetime.
- It prevents continuous send because the browser cannot distinguish “message accepted” from “turn finished”.

#### Correct
```ts
const result = turnOrchestrator.submitConversationMessage(conversationId, {
  content: body.content,
});
sendJson(res, 200, result);
```
- Persist first.
- Return accepted/queued/started state immediately.
- Let runtime events drive the rest of the UX.

#### Wrong
```ts
try {
  await runConversationTurn(conversationId, { batchMessageIds });
} finally {
  queueState.lastConsumedUserMessageId = batchEndMessageId;
}
```
- Failed batches disappear from the queue.
- Later retries lose context and user trust.

#### Correct
```ts
let batchSucceeded = false;

try {
  await runConversationTurn(conversationId, { batchMessageIds });
  batchSucceeded = true;
} finally {
  if (batchSucceeded) {
    queueState.lastConsumedUserMessageId = batchEndMessageId;
  }
}
```
- Only successful batches advance the consumed boundary.
- Failures remain observable and retryable.
