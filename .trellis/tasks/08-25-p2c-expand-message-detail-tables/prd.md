# P2C Expand Message Detail Tables

## Goal

Establish the reversible Expand baseline for P2C by adding message-keyed context
snapshot and model-usage-call storage, atomic dual writes, table-first dual
reads with legacy metadata fallback, and bounded context-snapshot pagination.

## Confirmed Decisions

- Future Contract rollback is guaranteed to this independently accepted Expand
  version. Expand itself remains directly rollback-compatible with pre-P2C code.
- Model usage detail retention is the first call plus the latest 63 calls. The
  original `sequence` values remain unchanged and truncation counts are stored.
- `GET /api/conversations/:conversationId/context-snapshots` keeps the
  `snapshots` field, adds `pageInfo`, defaults to 50 rows, and caps pages at 100.
- Message pagination and SSE payload slimming are deferred to P2C-Contract.

## Requirements

### Storage Contract

- Add idempotent schema migration for
  `chat_message_context_snapshots` and `chat_message_model_usage_calls`.
- Each row is keyed by `message_id`, references `chat_messages(id)`, and is
  removed by `ON DELETE CASCADE`.
- Add only the indexes required for stable conversation-scoped cursor reads.
- Do not backfill, rewrite, compress, or otherwise mutate historical messages.

### Atomic Write Contract

- The queued assistant message and its context snapshot are inserted in one
  SQLite transaction.
- Completed and failed/error assistant updates atomically update the message and
  the relevant new-table rows in the same SQLite transaction.
- Legacy `metadata.agentContextSnapshot` and `metadata.modelUsage` remain
  complete and authoritative for pre-P2C rollback compatibility.
- New model usage detail stores at most 64 calls using first-plus-latest-63,
  preserves original sequence values, and records retained/dropped counts.
- Any detail-row write failure rolls back the matching message insert/update.

### Dual Read Contract

- Context snapshot and model usage detail reads prefer the new table when a row
  exists and fall back to legacy message metadata when it does not.
- Mixed databases containing old-only, new-only, and dual-written messages keep
  Inspector, export, queued/completed/error, and existing timeline behavior.
- New-table absence after rollback to pre-P2C code is harmless because Expand
  continues to write full legacy metadata.

### Pagination Contract

- The context-snapshot list endpoint must not call `getConversation()` or an
  unbounded message-list method.
- Results use stable descending `(createdAt, messageId)` ordering with an opaque
  cursor, default limit 50, and maximum limit 100.
- The response remains `{ conversationId, snapshots, pageInfo }`; `pageInfo`
  identifies whether another page exists and provides the next cursor.
- Invalid limits/cursors fail with explicit client errors and do not silently
  widen the query.

## Non-Goals

- Do not slim or remove context snapshots/model usage from message metadata.
- Do not change message pagination or SSE payload shape.
- Do not backfill, compress, or rewrite historical rows.
- Do not deploy or touch production port 3100, its database, configuration, or
  process.
- Do not merge into `develop` before independent review and user acceptance.

## Data Flow And Ownership

`agent-executor` builds immutable snapshot/model usage values -> `ChatAppStore`
owns transactional message plus detail persistence -> storage repositories own
DDL-facing SQL and row normalization -> conversation controller delegates
bounded list/detail reads -> Inspector/export/UI consume the existing shapes.

## Validation Matrix

| Case | Expected evidence |
| --- | --- |
| Fresh database | Both tables, foreign keys, and bounded-read indexes exist. |
| Existing pre-P2C database | Startup migration is idempotent; historical rows are unchanged and no detail rows are synthesized. |
| Queued assistant create | Message and context snapshot row commit together. |
| Completed assistant update | Message, snapshot, and retained model usage calls commit together. |
| Failed/error assistant update | Failed metadata and available snapshot/model usage details commit together. |
| Injected detail write failure | Whole message insert/update transaction rolls back. |
| Mixed old/new rows | New-table values win; missing table rows fall back to full legacy metadata. |
| More than 64 calls | Retain original first sequence and latest 63 sequences; record exact retained/dropped counts. |
| Message deletion | Both detail rows cascade-delete in the same transaction. |
| Snapshot list | Default 50, max 100, stable non-overlapping cursor pages, no full conversation hydration. |
| Pre-P2C rollback | Full legacy metadata written by Expand remains readable; extra tables are ignored. |
| Restart and synthetic production shape | Integrity remains `ok`; list memory/latency depend on page size, not conversation history. |

## Required Tests And Evidence

- Real SQLite red tests first for DDL/indexes, atomic queued/completed/error
  writes, rollback injection, delete cascade, mixed dual reads, retention, and
  bounded cursor pagination with hydration poison.
- Parent/baseline run proving the new regression suite fails for the expected
  missing schema/old hydration behavior rather than import/build failure.
- Existing storage, context Inspector/export, agent executor, deletion, server
  smoke, Goal/turn/private/image/handoff regressions.
- Production-shape synthetic database with historical metadata distribution,
  mixed old/new rows, read-only integrity check, disk delta, latency, heap/RSS,
  and zero forbidden list hydrations.
- `npm run check`, `npm run typecheck`, `npm run typecheck:public`, `npm run
  build`, focused tests, diff check, and secret scan.
- Executable backend/runtime/unit-test spec updates, exact-SHA independent
  review, isolated preview, and explicit user acceptance before integration.

## Stop Conditions

Stop and ask rather than guessing if SQLite transaction ownership cannot cover
all three write states, rollback would require modifying legacy metadata,
cursor compatibility needs an API-breaking response change, or environment
isolation for acceptance cannot be proven.
