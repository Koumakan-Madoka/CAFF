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
  15 calls. Original `sequence` values are preserved. The projection adds
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
| Completed assistant with model usage | Full metadata remains; retained detail stores first + latest 15 and full aggregates. |
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
  legacy fallback, 15/16/17/64/100 retention, restart, and message/conversation
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

## Scenario: P2C-Contract Lightweight Message Metadata And Transport

### 1. Scope / Trigger

- Trigger: a future assistant message is created or updated with explicit full
  `contextSnapshot` / `modelUsage` detail input, or a public message crosses the
  messages-page or SSE transport boundary.
- P2C-Contract does not alter the Expand schema or historical rows. It only
  changes future assistant metadata and browser-facing projections.
- Contract rollback is guaranteed to the accepted Expand build. A pre-P2C
  build is not required to understand Contract-era lightweight metadata.

### 2. Signatures

```ts
ChatAppStore.createMessage({ ..., metadata, contextSnapshot?, modelUsage? })
ChatAppStore.updateMessage(messageId, { ..., metadata, contextSnapshot?, modelUsage? })
buildContractMessageMetadata(metadata, { contextSnapshot?, modelUsage? })
projectMessageForTransport(message) -> message
projectConversationMessageEventPayload(eventName, payload) -> payload
```

`contextSnapshot` and `modelUsage` are write-only detail inputs. They are never
returned as top-level message fields.

### 3. Contracts

- New assistant queued/streaming/completed/error writes pass the full immutable
  snapshot separately from metadata. Completed/error writes also pass full-run
  model usage separately when available.
- The Store writes full `snapshot_json` and retained full `calls_json` in the
  same transaction as the message state, then serializes only lightweight
  metadata. Detail failure rolls back the entire create/update.
- Lightweight `metadata.agentContextSnapshot` contains only version, snapshot/
  conversation/turn/message/agent/prompt identifiers, capture time,
  immutability, total tokens/bytes, and `sectionCount`. It contains no
  `sections`, `contentPreview`, or `displayContent`.
- Lightweight `metadata.modelUsage` contains the four full-run aggregate
  counters plus `callsTruncated`, `retainedCallCount`, and `droppedCallCount`.
  It contains no `calls` array.
- Store slimming is opt-in through explicit detail inputs. Expand-era callers
  that still write full metadata without explicit inputs remain byte-compatible;
  Contract must not silently rewrite historical or externally managed rows.
- Full detail persistence prefers explicit inputs. Legacy fallback persistence
  accepts only full snapshots with a `sections` array and model usage with calls;
  a lightweight reference must never overwrite a full table row.
- `GET /api/conversations/:id/messages` maps every item through the shared
  transport projector before deletion eligibility is attached.
- SSE serialization maps every `conversation_message_created` and
  `conversation_message_updated` payload through the same projector. Applying
  this at `SseBus` frame construction covers all producers, initial events, and
  legacy `writeEvent` without changing internal scheduler payloads.
- Transport projection is non-mutating and applies to legacy, Expand, and
  Contract rows. It preserves unrelated metadata needed by timeline, deletion,
  usage, digest, cross-conversation, Goal, private/image, and handoff behavior.
- Inspector/export and dedicated detail reads never use the transport
  projection. They remain table-first with legacy metadata fallback.

### 4. Validation Matrix

| Condition | Required result |
| --- | --- |
| queued assistant with explicit full snapshot | metadata has lightweight reference; table has full `displayContent` |
| streaming/tool update with same snapshot | metadata stays lightweight; immutable table row does not rewrite |
| completed/error with full usage | metadata has aggregates only; table keeps first + latest 15 full calls |
| null usage | no usage detail row; metadata has no calls/detail body |
| explicit detail UPSERT throws | matching message create/update fully rolls back |
| historical legacy/Expand row | stored `metadata_json` bytes remain unchanged |
| legacy/Expand/Contract mixed message page | no `displayContent` or `modelUsage.calls`; cursor/order unchanged |
| any created/updated SSE producer | serialized event has the same lightweight message projection |
| Inspector/Markdown for all three generations | full detail renders through table-first/legacy fallback |
| exact Expand build opens Contract DB | Contract-era full table detail remains readable and updateable |

### 5. Good / Base / Bad Cases

- Good: queued metadata stores a 12-field snapshot reference while the same
  transaction stores the complete 250 KiB snapshot in the detail table.
- Base: a legacy-only row stays byte-identical in SQLite but is summarized when
  it crosses HTTP/SSE.
- Bad: derive table detail from already-slim metadata; Expand rollback would
  open an Inspector snapshot with no `displayContent`.
- Bad: delete `displayContent` separately in each controller/broadcaster; one of
  the ten producers will drift and leak the full payload.

### 6. Required Tests And Gate

- `tests/storage/message-detail-contract.test.js`: real SQLite lightweight/full
  split, queued/streaming/completed/failed/null usage, immutable no-rewrite,
  injected rollback, retained call sequences, and historical byte identity.
- `tests/http/message-metadata-contract.test.js`: mixed legacy/Expand/Contract
  page projection plus full Inspector fallback.
- `tests/http/sse-message-metadata-contract.test.js`: created/updated SSE frame
  projection at the bus boundary.
- `tests/ui/message-metadata-contract.test.js`: lightweight reference keeps the
  context button enabled and aggregate model-usage badge intact.
- `scripts/p2c-contract-gate.js`: production-shape historical-byte identity,
  new-row/database/payload reduction, memory/latency, SQLite integrity, and
  exact Expand rollback evidence.

### 7. Wrong Vs Correct

#### Wrong

```ts
store.updateMessage(messageId, {
  metadata: { agentContextSnapshot: lightweightReference },
});
```

No full detail input crosses the transaction boundary. If the table row is
missing, Inspector and an Expand rollback have no complete snapshot to read.

#### Correct

```ts
store.updateMessage(messageId, {
  metadata: { agentContextSnapshot: lightweightReference },
  contextSnapshot: fullSnapshot,
  modelUsage: fullModelUsage,
});
```

The Store atomically persists full detail while serializing only the lightweight
message metadata.

## Trace Inspector Point-Read Projection

- `GET /api/conversations/:conversationId/messages/:messageId/trace-inspector` is a table-first detail route layered over existing context snapshot/model usage/observability reads. It must not add a detail table, backfill rows, call `getConversation()`, or call unbounded `listMessages()`.
- The selected message is validated once at the controller edge. The domain lineage projector may call `getMessage(id)` and `getMessageContextSnapshot(id)` for at most 8 same-conversation, same-agent assistant nodes.
- A lineage node contains identifiers, delivery mode, capture time, agent identity, session name, and cursor metadata only. Ancestor `sections`, `displayContent`, message content, session path, task output, and raw JSONL never cross this projection.
- An exact `metadata.privateOnly=true` parent is an absorbing boundary. The projector returns `protected_parent`, does not append that node, clears its target id and timeline timestamp from the prior lineage cursor, and strips retained-prefix session/hash/cursor/time identifiers from the Trace response copy without rewriting the stored immutable snapshot.
- Trace export is generated from the already-safe Inspector payload. It escapes Markdown table delimiters in projected lineage/event cells and may append the existing safe Context Snapshot Markdown, but must not reopen session JSONL or recompute prompt state.
- Required tests use a real `ChatAppStore`, poison full-conversation hydration, and cover consecutive resume ancestry, deleted/missing detail, legacy schema including reused records with unknown prompt delivery, protected parent identifiers/timestamps, cycles, depth limit, mixed model/tool events, unknown usage counters, terminal failures, and export leakage/delimiter markers.

## Unified Observability Timeline Detail

- `chat_message_observability_timelines` is the table-first detail for mixed
  `model_call` and `tool_execution` events. Terminal assistant updates persist
  it in the same transaction as message status, model usage, and context detail.
- New writes retain at most 16 events (`first 1 + latest 15`) while keeping full
  total/retained/dropped/truncated fields and full model/tool aggregates.
- New model usage writes also retain 16 calls. Reads re-apply that window to
  historical rows written under the former 64-call bound and preserve the
  already-dropped count; no existing row is rewritten or backfilled.
- Tool-trace reads use the unified row when present and skip session JSONL.
  A row whose model-call aggregate exceeds that message's authoritative model
  usage is recognized as a legacy cross-message contamination artifact; read
  projection discards that row, rebuilds from the message's own session/task
  evidence, and never rewrites the stored audit detail. Historical messages
  without a row use the same bounded session/task compatibility projection.

## Scenario: Bounded Live Observability Timeline

### 1. Scope / Trigger

- Trigger: persisting, reading, transporting, or rendering model-call and tool-
  execution detail for one assistant message.
- Applies to `lib/observability-timeline.ts`, message detail storage,
  `message-tool-trace.ts`, executor/bridge SSE, and the chat timeline.

### 2. Signatures

```ts
retainObservabilityEvents(events, totalEventCount?)
  -> { events, totalEventCount, retainedEventCount,
       droppedEventCount, truncated }

GET /api/conversations/:conversationId/messages/:messageId/tool-trace
  -> { trace: {
       timelineEvents[<=16],
       timelineWindow: {
         totalEventCount, retainedEventCount, droppedEventCount, truncated,
         modelCallCount, coldStartModelCallCount, postColdModelCallCount,
         providerMissCount, toolExecutionCount, failedToolExecutionCount,
         totalToolDurationMs
       },
       summary, ...
     } }

SSE conversation_model_event | conversation_tool_event
  -> { conversationId, messageId, taskId, event, timelineWindow }
```

```sql
chat_message_observability_timelines(
  message_id PRIMARY KEY, conversation_id, turn_id, agent_id,
  total_event_count, retained_event_count, dropped_event_count,
  events_truncated, events_json,
  model_call_count, cold_start_model_call_count,
  post_cold_model_call_count, provider_miss_count,
  tool_execution_count, failed_tool_execution_count,
  total_tool_duration_ms, created_at, updated_at
)
```

### 3. Contracts

- A message timeline retains 16 mixed events: original first event and latest 15.
  Each has stable `eventId`, `eventType`, and original positive
  `timelineSequence`; updates to a running tool reuse both identity and sequence.
- `timelineWindow` keeps full total/retained/dropped/truncated fields and the
  full model/tool/miss/failure/duration aggregates. `summary` and table aggregate
  columns keep the same full values; no consumer derives them from the 16
  retained rows.
- Browser aggregate merges are field-preserving. A finite non-negative field in
  the incoming HTTP/SSE window may replace the corresponding aggregate; an
  omitted, null, empty, negative, or non-numeric field never clears an existing
  `summary` / `modelUsageSummary` value. Compatibility HTTP snapshots that carry
  only the four retention fields therefore keep their full summary counts.
- The executor emits `conversation_model_event` only for a newly observed
  usage-bearing assistant call. It excludes prompt, visible reply, thinking,
  raw provider wrappers, and tool arguments. Tool SSE retains existing redaction.
- Terminal message, model usage, context detail, and unified timeline commit in
  one Store transaction. A valid table-backed tool-trace read skips session
  JSONL. If its stored model-call count is greater than the same message's
  table-first model-usage count, the timeline is a legacy cross-message
  contamination artifact: the HTTP read discards it in memory, rebuilds from
  that message's model/session/task evidence, and leaves the SQLite row and
  session JSONL unchanged.
- A historical message without unified detail uses the compatibility path. Its
  bridge query reads first 1 + latest 199 rows and SQL-aggregates the full
  counts; final HTTP detail arrays all derive from the 16-event timeline.
- Browser expansion performs one GET. Subsequent tool/model SSE upserts by
  `eventId`, reapplies the same window, and does not poll or invalidate the
  snapshot when the message reaches terminal state.

### 4. Validation And Error Matrix

| Condition | Required result |
| --- | --- |
| 16 or fewer mixed events | retain all; dropped=0; truncated=false |
| 17 events | retain sequences `1,3..17`; total=17; dropped=1 |
| 65 events | retain `1,51..65`; total=65; dropped=49 |
| running tool update with same id | replace retained row; do not increment total |
| `message_end` repeated through `agent_end` | one model event and one model count |
| terminal success with running session tool | persist it as `observed` |
| terminal failure with running tool | persist it as `failed` |
| table row exists and its model count matches authoritative usage | no session JSONL read; return all detail arrays <=16 |
| stored timeline model count exceeds this message's model usage | ignore the contaminated row for projection, rebuild only this message's events, and do not rewrite SQLite |
| bounded HTTP snapshot has 216 events, 66 model calls, 150 tools | return 16 events plus `66`/`150` in both `summary` and `timelineWindow` |
| compatibility snapshot omits aggregate window fields | browser preserves full `summary` / `modelUsageSummary`; it does not replace them with `0` or retained-row counts |
| later model/tool SSE arrives | update only present authoritative aggregates; model and tool totals continue independently |
| historical row has 205 bridge events | true total=205; first and newest failure remain visible |
| SSE contains thinking/text markers | regression failure; markers must be absent |
| detail UPSERT fails | roll back the matching terminal message update |
| message/conversation deletion | timeline row cascades; FK check remains empty |

### 5. Good / Base / Bad Cases

- Good: five concurrent messages each receive 65 independent events; every
  browser trace contains `1,51..65`, reports total 65, and newest events remain
  live without a detail refetch.
- Base: an old message has no unified row, so its first expansion performs one
  bounded compatibility projection and keeps the audit JSONL unchanged.
- Base: a legacy row accumulated earlier same-turn messages, so its model count
  exceeds the current message's authoritative usage; the read path projects
  only current session/task evidence while retaining the original row for audit.
- Bad: trim model calls and tools independently to 16. The merged UI can then
  hold 32 rows and model/tool chronology diverges.
- Bad: recompute tool/model totals from retained rows or use random bridge ids;
  totals shrink and refresh creates duplicate events.

### 6. Tests Required

- `tests/storage/message-detail-expand.test.js`: real SQLite 40-event atomic
  write, exact retained sequences/counters, cascade, FK and 16-call convergence.
- `tests/runtime/agent-executor-hook.test.js`: running model SSE, safe fields,
  no thinking/visible text, one event.
- `tests/runtime/message-tool-trace.test.js`: 48 mixed events, 205 bridge
  events, one snapshot GET, 65-event live browser merge, stable identities, the
  `216 total / 66 model / 150 tool` aggregate-preservation regression, and a
  persisted 320-event cross-message artifact that converges to the current
  message's model/session/task evidence without rewriting its detail row.
- `tests/ui/observability-timeline-window.test.js`: five concurrent 65-event
  windows, omission copy, original sequence rendering, narrow-wrap CSS.
- `tests/ui/cross-conversation-ui.test.js`: the collapsed summary and expanded
  timeline both render full `66` model / `150` tool totals beside `16/216` and
  the 200-event omission row.
- `npm run check`, both typechecks, build, smoke, target/adjacent suites, and
  desktop/mobile browser verification remain gates.

### 7. Wrong Vs Correct

#### Wrong

```ts
trace.modelUsageCalls = trace.modelUsageCalls.slice(-16);
trace.steps = trace.steps.slice(-16);
summary.toolExecutionCount = trace.steps.length;
```

#### Correct

```ts
const window = retainObservabilityEvents(mixedEvents, fullTotal);
trace.timelineEvents = window.events;
trace.timelineWindow = window;
trace.summary = fullRunAggregates;
```
