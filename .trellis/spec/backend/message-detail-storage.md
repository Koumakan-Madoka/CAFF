# Message Detail Expand Storage

## Scenario: Reversible Context Snapshot And Model Usage Expansion

### 1. Scope / Trigger

- Trigger: persisting or reading `metadata.agentContextSnapshot` or
  `metadata.modelUsage` for public assistant messages.
- Applies to `storage/sqlite/migrations.ts`,
  `storage/chat/message-detail.repository.ts`, `lib/chat-app-store.ts`,
  `server/domain/conversation/context-snapshot-pagination.ts`, and the context
  snapshot routes in `server/api/conversations-controller.ts`.
- P2C-Expand creates a rollback baseline. It does not slim message metadata,
  backfill historical rows, alter message pagination/SSE payloads, or rewrite
  existing data.

### 2. Signatures

#### SQLite tables

```sql
chat_message_context_snapshots(
  message_id PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  conversation_id, turn_id, agent_id, snapshot_id,
  snapshot_json, summary_json, created_at, updated_at
)

chat_message_model_usage_calls(
  message_id PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  conversation_id, turn_id, agent_id,
  model_call_count, cold_start_model_call_count,
  post_cold_model_call_count, provider_miss_count,
  calls_json, calls_truncated, retained_call_count, dropped_call_count,
  created_at, updated_at
)
```

Both tables also reference `chat_conversations(id) ON DELETE CASCADE`. Each has
one conversation cursor index on `(conversation_id, created_at DESC,
message_id DESC)`.

#### Store/repository APIs

```ts
ChatAppStore.getMessageContextSnapshot(messageId) -> snapshot | null
ChatAppStore.getMessageModelUsage(messageId) -> retainedModelUsage | null
ChatAppStore.listContextSnapshotPage(conversationId, { limit, before? })
  -> { items, nextBefore, hasMore }

ChatMessageDetailRepository.hasContextSnapshot(messageId, snapshotId) -> boolean
ChatMessageDetailRepository.upsertContextSnapshot(payload) -> void
ChatMessageDetailRepository.upsertModelUsage(payload) -> void
ChatMessageDetailRepository.getContextSnapshot(messageId) -> snapshot | null
ChatMessageDetailRepository.getModelUsage(messageId)
  -> { source: 'table' | 'metadata', modelUsage } | null
```

#### HTTP API

```text
GET /api/conversations/:conversationId/context-snapshots
  ?limit=<1..100>&before=<opaque cursor>

200 {
  conversationId,
  snapshots,
  pageInfo: { hasMore, nextCursor }
}
```

The default limit is 50 and the maximum is 100. Ordering is descending by
`(chat_messages.created_at, chat_messages.id)`.

### 3. Contracts

- `migrateChatSchema()` uses idempotent `CREATE TABLE/INDEX IF NOT EXISTS`.
  Startup creates empty detail tables and never synthesizes rows from historical
  metadata.
- `ChatAppStore.createMessageTransaction` writes the message and any queued
  context snapshot in one transaction. Image attachment and conversation touch
  remain in that same transaction.
- `ChatAppStore.updateMessageTransaction` writes the message plus completed or
  failed snapshot/model usage details in one transaction. Any detail error rolls
  back the matching message state/content/metadata update.
- Full `metadata.agentContextSnapshot` and `metadata.modelUsage` remain unchanged
  in Expand. Pre-P2C code may therefore ignore the new tables and read every
  Expand-era message from metadata.
- Detail reads are table-first. A missing detail row falls back to the matching
  legacy metadata object. A present but invalid detail row does not silently use
  stale metadata.
- Context snapshots are immutable per `snapshotId`. Lifecycle updates carrying
  the same `(message_id, snapshot_id)` skip snapshot serialization/UPSERT, which
  prevents queued/streaming/tool/completed transitions from repeatedly writing
  a large snapshot to WAL.
- `metadata.modelUsage === null` creates no usage row. When present, the table
  stores the full-run aggregate counters but only the first call plus the latest
  63 calls. Original `sequence` values are preserved. The projection adds
  `callsTruncated`, `retainedCallCount`, and `droppedCallCount`; aggregate counts
  must never be recomputed from the retained array.
- Snapshot list pagination has one driving source: `chat_messages`. It LEFT JOINs
  the snapshot table and uses the metadata JSON object only for rows without a
  detail row. This keeps old/new rows in one cursor order without UNION duplicate
  or omission risk.
- List reads may parse at most the selected page plus one sentinel row into JS.
  They must not call `getConversation()`, unbounded `listMessages()`, or hydrate
  message payloads outside the page.
- Message and conversation deletion rely on connection-scoped
  `PRAGMA foreign_keys=ON`; both detail rows cascade. Never use `INSERT OR
  REPLACE` for detail writes because its implicit delete/insert semantics can
  violate lifecycle expectations; use UPSERT.
- Future Contract code is guaranteed to roll back to an independently accepted
  Expand version. Expand itself can roll back to pre-P2C because it keeps full
  metadata. Contract-era lightweight metadata is not required to work on a
  version older than Expand.

### 4. Validation And Error Matrix

| Condition | Expected result |
| --- | --- |
| Fresh database | Both tables, foreign keys, checks, and cursor indexes exist. |
| Existing database with legacy metadata | Startup creates empty detail tables; historical `metadata_json` bytes stay identical. |
| Queued assistant create | Message and snapshot commit together. |
| Streaming/tool update with the same snapshot ID | Message updates; snapshot row and `updated_at` do not change. |
| Completed assistant with model usage | Full metadata remains; retained detail stores first + latest 63 and full aggregates. |
| Failed/error assistant with partial usage | Failure metadata, snapshot, and available usage commit together. |
| Snapshot/usage UPSERT throws | Entire matching message insert/update rolls back. |
| Detail row exists and metadata differs/is lightweight | Detail row wins for Inspector/list/model usage reads. |
| Detail row missing and metadata object exists | Legacy metadata fallback is returned. |
| Legacy metadata malformed, null, or snapshot is non-object | Snapshot list omits the row without failing or widening the query. |
| `limit` missing | Return at most 50 snapshots. |
| `limit` is 0, fractional, non-numeric, or greater than 100 | HTTP 400 with an explicit limit error. |
| Cursor is malformed, invalid timestamp, or belongs to another conversation | HTTP 400; never reset to the first page. |
| Message/conversation deleted | Both detail rows are absent; `foreign_key_check` remains empty. |
| Pre-P2C code opens an Expand database | Extra tables are ignored; full metadata read/update remains functional. |

### 5. Good / Base / Bad Cases

- Good: queued create inserts one immutable snapshot; three streaming updates
  reuse the row; completed update adds retained usage in the same transaction.
- Base: a historical assistant message has no detail row, so Inspector and the
  paged list read its full snapshot from legacy metadata.
- Good rollback: Contract writes lightweight metadata plus complete detail rows;
  rolling back to Expand keeps Inspector/export functional through table-first
  reads.
- Bad: create the message, commit, then insert the snapshot in a separate
  transaction. A crash creates a detail-less Contract message.
- Bad: call snapshot UPSERT on every public tool update merely because metadata
  still contains the same immutable snapshot.
- Bad: paginate new-table rows and metadata rows separately and merge in JS;
  cursor boundaries will duplicate or skip mixed-version rows.

### 6. Tests Required

- `tests/storage/message-detail-expand.test.js` uses a real `ChatAppStore` to
  assert DDL/indexes, zero backfill, byte-identical metadata, queued/completed/
  failed writes, same-snapshot no-rewrite, injected rollback, table priority,
  legacy fallback, 63/64/65/100 retention, restart, and message/conversation
  cascade.
- `tests/http/context-snapshot-pagination.test.js` seeds mixed old/new and
  table-only rows, poisons `getConversation`/`listMessages`, checks default 50,
  maximum 100, cursor isolation/ties, invalid input, detail/export, and malformed
  legacy metadata exclusion.
- `scripts/p2c-expand-gate.js` validates 15,052 synthetic messages with
  production-scale metadata/snapshots. The report records heap/RSS, latency,
  disk delta, unchanged historical metadata bytes, zero forbidden hydration,
  integrity, and foreign-key results.
- A pre-P2C build must open an Expand-created SQLite fixture and read/update the
  complete legacy metadata successfully. Reopening with Expand must still read
  its detail rows.
- Existing storage, agent executor, Goal/turn/private/image/handoff, deletion,
  Inspector, and server smoke suites remain regression gates.

### 7. Wrong Vs Correct

#### Wrong

```ts
messageRepository.update(messageId, messagePayload);
messageDetailRepository.upsertModelUsage(detailPayload); // separate commit
```

A failure between statements exposes a completed message without its Contract
rollback detail.

#### Correct

```ts
const updateMessageTransaction = db.transaction((payload) => {
  messageRepository.update(payload.messageId, payload.message);
  persistMessageDetails(payload);
  return getMessage(payload.messageId);
});
```

The public message state and detail state cross the commit boundary together.

#### Wrong

```ts
if (metadata.agentContextSnapshot) {
  upsertContextSnapshot(metadata.agentContextSnapshot);
}
```

This rewrites the same large immutable snapshot on every lifecycle update.

#### Correct

```ts
if (!detailRepository.hasContextSnapshot(messageId, snapshot.snapshotId)) {
  detailRepository.upsertContextSnapshot(snapshotPayload);
}
```

Only a missing or genuinely different snapshot is serialized and written.
