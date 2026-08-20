# Conversation Message Deletion

## 1. Scope / Trigger

Use this contract when changing hard deletion of public conversation messages, deletion eligibility, digest coverage, conversation mutation locking, image cleanup, message pagination projection, deletion SSE, or timeline selection controls.

The feature intentionally supports only unsummarized history in an idle conversation. Existing digest provenance and cross-conversation delivery references are stronger than an operator deletion request.

## 2. Signatures

### HTTP

- `POST /api/conversations/:conversationId/messages/delete`
- Request: `{ messageIds: string[] }`
  - exactly one known field
  - 1 to 100 non-empty, unique IDs
- Success:
  - `{ conversationId, deletedMessageIds, attachmentCleanup }`
  - `attachmentCleanup: { requestedBatchCount, warning }`
  - `warning` is `null` or `{ code: 'attachment_cleanup_incomplete', batchIds: string[] }`
  - response never echoes message content
- `GET /api/conversations/:conversationId/messages`
  - retains `{ items, nextCursor, hasMore }`
  - adds `deletionState: { available, blockedReasonCode, runtime }`
  - each public item adds `deletionEligibility: { eligible, reasonCode, reason }`

### Domain and runtime

- `createConversationMessageDeletionService(options)` exposes:
  - `projectMessages(conversationId, pageItems)`
  - `deleteMessages(conversationId, { messageIds })`
- `createConversationMutationCoordinator()` exposes:
  - `tryAcquire(conversationId, 'auto_digest' | 'manual_digest' | 'message_delete')`
  - `describe(conversationId)`
  - `markDigestScheduled(conversationId)` / `clearDigestScheduled(conversationId)`
- `turnOrchestrator.getConversationMutationState(conversationId)` returns:
  - `{ active, dispatching, activeTurnCount, activeAgentSlotCount, queuedUserCount, queuedAgentSlotCount, busy }`
- `turnOrchestrator.reconcileConversationQueueAfterMessageDeletion(conversationId, deletedMessages)`:
  - moves a deleted `lastConsumedUserMessageId` cursor to the previous surviving consumed user message
  - leaves the cursor unchanged when the deleted batch does not contain it
- `ChatAppStore.deleteConversationMessages(conversationId, messageIds)` returns:
  - `{ deletedMessageIds, attachmentBatchIds, lastMessageAt }`

### SSE

- `conversation_messages_deleted`: `{ conversationId, deletedMessageIds }`
- Existing `conversation_summary_updated` refreshes sidebar summary state.
- `conversation_digest_updated` with `digest: null` is emitted only when pending digest state materially changes.

## 3. Contracts

### Eligibility

- Deletable roles are public `user` and terminal `assistant` only.
- Terminal assistant status is `completed` or `failed`.
- `system`, `external_agent`, private, queued assistant, and streaming assistant messages are not deletable.
- A message at or before the latest retained digest `messageRange.toMessageId` is summarized and cannot be deleted.
- Pagination eligibility compares `(createdAt, id)` to the stored boundary message without hydrating the full conversation. Only when the boundary row is missing may it use the digest timestamp fallback.
- Any message referenced as a cross-conversation `source_message_id`, `target_message_id`, or `source_receipt_message_id` is rejected. Cross-conversation metadata is rejected before the relational fallback.

### Atomic deletion

- The service revalidates runtime, digest mutation, existence, ownership, role/status, digest coverage, and cross-conversation references immediately before the synchronous SQLite transaction.
- Any invalid selected ID rejects the whole batch and returns per-ID `issues`; no selected row is removed.
- The transaction deletes attached image rows and their dedicated batch rows before deleting messages, then recomputes `chat_conversations.last_message_at` from the newest remaining `(created_at, id)`.
- SQLite `ON DELETE RESTRICT` remains the final cross-conversation and attachment safety net; do not weaken those foreign keys.
- FTS deletion follows the existing `chat_messages_search_ad` trigger.

### Runtime and digest exclusion

- Deletion is allowed only when `getConversationMutationState(...).busy === false`.
- Busy includes active/dispatching main turns, queued main messages, active Agent slots, and queued side-lane dispatches.
- Auto digest, manual digest, and message deletion use the same conversation-scoped mutation coordinator.
- A scheduled auto digest or running mutation causes immediate `409`; deletion never holds an HTTP request while waiting for a model digest.
- Idle validation and the SQLite transaction contain no `await`, so another JavaScript dispatch callback cannot enter between them.
- After commit, deletion must reconcile the in-memory main-queue cursor before returning. If the deleted batch contains `lastConsumedUserMessageId`, move it to the previous surviving user message by `(createdAt, id)` order; otherwise older consumed user messages can be misclassified as pending and replayed.

### Attachment cleanup

- Image database rows and batch rows are deleted in the same message transaction.
- Dedicated upload directories are removed only after commit.
- A filesystem failure cannot roll back the already-committed message deletion and must not be reported as if nothing was deleted. Return `attachment_cleanup_incomplete`, log opaque batch IDs, and keep content out of logs/events.

### UI

- Eligible public messages expose a native checkbox and repository-owned `trash` icon button.
- Controls are disabled with a reason when the message is summarized, cross-conversation, non-terminal, or the conversation is busy.
- Checkbox and delete targets are at least 44px and remain visible on touch layouts.
- Selecting any checkbox opens the viewport-owned batch toolbar. Cancel clears selection.
- Confirmation states exact count, permanent deletion, attachment deletion, and that files/commits/Goal/DAG/external side effects are not rolled back.
- A `409` keeps all selected checkboxes and explains that zero messages were deleted.
- A successful response removes selected messages locally and schedules the normal SSE/page refresh.
- Request settlement must re-enable every remaining statically eligible checkbox/delete button, including cards rebuilt by the optimistic render while `deleteInFlight` was true.

## 4. Validation & Error Matrix

| Condition | Status/code | Result |
| --- | --- | --- |
| Empty, duplicate, over-100 IDs, unknown body field | `400 conversation_message_delete_invalid_request` | no mutation |
| Conversation missing | `404 conversation_not_found` | no mutation |
| Any ID missing or from another conversation | `409 conversation_message_delete_rejected`, issue `message_not_found` | whole batch preserved |
| Summarized message | issue `message_summarized` | whole batch preserved |
| System/external/private role | issue `message_role_not_deletable` | whole batch preserved |
| Queued/streaming assistant | issue `message_status_not_deletable` | whole batch preserved |
| Cross-conversation metadata or FK reference | issue/code `message_cross_conversation` | whole batch preserved |
| Active/queued main or side work | `409 conversation_message_delete_busy` | whole batch preserved |
| Digest scheduled | `409 conversation_digest_scheduled` | whole batch preserved |
| Digest/history mutation running | `409 conversation_digest_running` | whole batch preserved |
| Eligible idle batch | `200` | selected messages and owned image DB rows deleted |
| Post-commit disk cleanup failure | `200`, cleanup warning | DB deletion remains durable |

## 5. Good / Base / Bad Cases

- Good: delete two unsummarized completed public messages in an idle room; one SQLite transaction removes both, pending digest state decreases, and SSE carries IDs only.
- Good: a message page with 50 items projects eligibility by reading one digest boundary row, not all 50,000 conversation messages.
- Base: a deleted newest message makes `last_message_at` fall back to the previous message; deleting the last message sets it to `null`.
- Base: a disk directory is already missing; return a cleanup warning without restoring the chat rows.
- Bad: hiding the delete icon for summarized messages while allowing the endpoint to delete them.
- Bad: checking only `activeTurns` and forgetting queued side dispatches.
- Bad: deleting a message before image rows or weakening `ON DELETE RESTRICT` to make the SQL pass.
- Bad: waiting several minutes for a digest lock or returning HTTP 500 after a post-commit cleanup failure.

## 6. Tests Required

- `tests/storage/message-deletion.test.js`
  - atomic batch deletion, `last_message_at` fallback, restart persistence
  - image row/batch removal
  - mixed-conversation rollback
  - cross-conversation FK preflight before SQLite restrict
- `tests/runtime/conversation-message-deletion.test.js`
  - exact digest boundary and terminal status projection
  - whole-batch summarized rejection
  - busy main/side state, scheduled digest, and running mutation rejection
  - cleanup warning after durable commit
  - pending digest state and content-free deletion event
- `tests/http/conversation-message-deletion.test.js`
  - request schema, response shape, page projection
  - pagination projection does not call full `listMessages`
  - manual digest honors the shared mutation lock
- `tests/runtime/turn-orchestrator.test.js`
  - queued side dispatch increments `queuedAgentSlotCount`
  - deleting the consumed-user cursor falls back without making older messages pending
- `tests/ui/message-deletion.test.js`
  - 44px/touch controls, single confirmation, multi-select/cancel
  - successful optimistic re-render restores remaining controls
  - atomic rejection retains selection
  - summarized/busy controls are disabled with reasons
- Keep digest, cross-conversation, message pagination, image, AppShell, and theme/icon suites green.

## 7. Wrong vs Correct

### Wrong

```ts
if (!runtime.activeTurns.length) {
  store.messageRepository.deleteByIdsForConversation(conversationId, messageIds);
}
```

This misses dispatching work, queued main messages, side slots, side queues, digest races, cross-conversation references, attachments, and atomic validation.

### Correct

```ts
const lease = mutationCoordinator.tryAcquire(conversationId, 'message_delete');
if (!lease.acquired || turnOrchestrator.getConversationMutationState(conversationId).busy) {
  throw createHttpError(409, 'Conversation is busy');
}
try {
  validateEverySelectedMessage();
  return store.deleteConversationMessages(conversationId, messageIds);
} finally {
  lease.release();
}
```

The service owns policy and synchronization; the store owns the synchronous all-or-nothing database transaction.
