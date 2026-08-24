# P0: Eliminate memory health/backfill OOM trigger

## Goal

On the latest origin/develop baseline (2188f20), remove the confirmed OOM trigger:
global/scoped memory health, global/scoped summary backfill, and
`saveSummarySegmentFromDigest()` must not read message history. Global paths must
process one lightweight conversation projection at a time and must not accumulate
fully hydrated conversation objects. Existing HTTP response fields, status values,
idempotency, task attribution, bounded diagnostics, scoped missing-conversation and
per-digest partial failure semantics must remain unchanged. Prove functional
compatibility and bounded memory with real SQLite red tests and production-shape
synthetic data.

Planning reference (frozen, independently reviewed and approved):
`.trellis/tasks/08-24-develop-oom-remediation-plan/` at commit
a9f9eec4e3bb9751deb33e02ef905580f8909d5f.

## Confirmed hydration entries (reproduced on 2188f20)

1. `lib/chat-app-store.ts` `getSummaryMemoryHealth()` (~3857): global branch calls
   `getConversation()` per header and accumulates all hydrated conversations in
   `conversations[]` for the whole request; scoped branch also fully hydrates.
2. `server/domain/conversation/conversation-digest.ts`
   `backfillConversationDigestSummarySegments()` (~1838): identical accumulate-all
   pattern; then per digest calls `store.saveSummarySegmentFromDigest()`.
3. `lib/chat-app-store.ts` `saveSummarySegmentFromDigest()` (~3769): fully hydrates
   via `getConversation()` although it only needs existence and `conversation.title`.

`getConversation()` = repository get + `listMessages()` (SELECT * without LIMIT) +
per-row `JSON.parse(metadata_json)`. Production shape: 373MB metadata_json, largest
single-conversation raw projection ~93.5MB.

## Requirements

- Global health consumes `listConversations()` headers directly (title/id/digest
  metadata are all header fields); no second conversation array of hydrated objects;
  never calls `getConversation()`/`listMessages()`.
- Global backfill processes headers one at a time; scoped paths and direct
  `saveSummarySegmentFromDigest()` use `getConversationWithoutMessages()`.
- Response fields, status (`ok`/`needs_backfill`/`unavailable`), counts,
  idempotency, task attribution, bounded diagnostics caps, scoped 404
  (`conversation_not_found`), and per-digest continue-on-error partial failure
  semantics stay byte-compatible.
- Red tests on a real SQLite store: any `listMessages()` call throws; covers
  global/scoped health, global/scoped backfill, and direct summary-segment save.
- Production-shape synthetic SQLite gate: single, repeated, and concurrent
  health/backfill runs under heap/RSS/latency budgets; record exact digest
  count/distribution. No production copy, no production heap snapshot.

## Non-Goals

- No P1 (metrics window, SSE backpressure), no P2 (goal/turn targeted queries,
  modelUsage/context snapshot slimming).
- No production config/data/process changes; no heap limit increase; no automatic
  history compaction; no change to memory search relevance, digest content, or UI
  semantics.

## Acceptance Criteria

- [ ] Red tests fail on baseline (any `listMessages()` call in the five paths throws).
- [ ] Implementation switches all three entries to header/without-messages projections.
- [ ] Compatibility regression: fields/status/counts/idempotency/task attribution/
      diagnostics/empty/repeat/lookup-failure unchanged; zero drift elsewhere.
- [ ] Synthetic production-shape gate passes heap/RSS/latency budgets with exact
      digest count/distribution recorded.
- [ ] Executable spec updated; system Node v24 check/typecheck/build/focused tests
      and necessary smoke pass; secret, diff, and SQLite integrity checks pass.
- [ ] Independent commit-pinned review approved; isolated acceptance before any
      merge to develop; no merge without user confirmation.
