---
feature_ids: [F001]
topics: [chat, sqlite, pagination, design]
doc_kind: decision
created: 2026-07-28
---

# F001 Long Conversation Pagination Design Gate

## Evidence Read

- Repository query and existing composite index.
- `getConversation()` hydration and every production `getConversation()` call site grouped by file.
- Conversation GET/POST routes, frontend open/SSE refresh/send flows, timeline diff renderer, digest full-list calls, game services, runtime prompt assembly, trace and export endpoints.
- CAFF Trellis backend, controller, frontend, unit-test, code-reuse, and cross-layer guidance.

## Options

### A. Offset pagination

Rejected. Inserts before later offsets create duplicates/gaps, and deep pages require work proportional to the skipped history.

### B. Embed a latest page inside `GET /api/conversations/:id`

Rejected. It overloads one aggregate with two meanings for `messages` and makes cursor metadata easy for non-UI consumers to ignore.

### C. Conversation projection plus a dedicated message page

Selected. The conversation GET uses a no-public-messages projection. The existing `/messages` resource gains a read-only GET page contract while POST remains unchanged.

## Contract

Request:

```text
GET /api/conversations/:conversationId/messages?limit=50&before=<opaque-cursor>
```

Response:

```json
{
  "items": [],
  "nextCursor": null,
  "hasMore": false
}
```

- Default limit: 50. Maximum: 100. Non-integers, zero, negatives, and values above the maximum are `400`.
- `before` is an opaque base64url JSON envelope containing version, conversation id, created timestamp, and message id.
- The API validates envelope shape and conversation binding. Cursor rows do not need to continue existing.
- Items are always returned oldest-to-newest for direct timeline insertion.
- The repository reads newest-to-oldest with `limit + 1`, derives `hasMore`, drops the probe row, then reverses the bounded result.
- `nextCursor` points to the oldest returned item and is null when `hasMore` is false.

## SQLite Query Shape

Latest page:

```sql
WHERE conversation_id = ?
ORDER BY created_at DESC, id DESC
LIMIT ?
```

Before cursor:

```sql
WHERE conversation_id = ?
  AND (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT ?
```

SQLite can reverse-scan the existing ascending composite index. `EXPLAIN QUERY PLAN` is a release gate; a new index is forbidden unless that evidence disproves the assumption.

## Internal Full-History Boundary

- UI projection: conversation GET calls an explicit no-public-messages store method and then the message page endpoint.
- Runtime prompt/orchestration: unchanged full aggregate because current prompt selection and queued-message snapshotting derive from complete persisted history before applying their own recent-history bounds.
- Digest: unchanged explicit `listMessages()` full scan because incremental digest selection and manual digest creation need full ordering/range semantics.
- Undercover/werewolf: unchanged full aggregate; game state and public history remain behaviorally identical.
- Export/trace/context snapshots: targeted message lookup or intentional full scan remains unchanged.
- Diagnostics/memory health: unchanged for this feature; no silent truncation.

The existing aggregate method remains backward-compatible for internal consumers. New UI reads use the named projection method so page semantics do not spread into runtime code.

## UI Design In Context

- Existing surface: `public/index.html` has one scrollable `#message-list` between the participant strip and composer; `public/chat/message-timeline.js` owns cards and `public/app.js` owns fetch/state/SSE merge behavior.
- Placement: a compact history control is the first child of the message scroller, immediately before the oldest visible card.
- Alternative rejected: a fixed control above the scroller consumes permanent vertical space and disconnects the action from the history boundary.
- Desktop and narrow behavior: one centered compact button; text may wrap but the control remains full-width and does not overlap cards.
- States: hidden when exhausted/empty, enabled when more exists, disabled with loading text during a request, and retryable after an error without discarding loaded items.
- Existing UX improves because the latest context opens promptly while complete history stays reachable.

Text wireframe:

```text
+---------------- message scroller ----------------+
|              [↑ Load earlier messages]           |
|  oldest visible message                           |
|  ...                                              |
|  newest visible message                           |
+---------------------------------------------------+
| composer                                           |
```

## Architecture

Architecture cell: CAFF conversation storage/read path (`storage/chat` -> `lib/chat-app-store` -> `server/api` -> `public/chat`)

Map delta: none

Why: the feature extends established repository, store, controller, and chat-view boundaries; CAFF has no separate ownership-map document to update.

## Meta-Aesthetics

This is a coordinate change from unbounded aggregate hydration to an explicit UI projection plus keyset page. It does not add fallback layers, duplicate indexes, or offset repair logic.

## Convergence

Consensus: use option C, tuple keyset ordering, one cursor owner in UI state, and no runtime/digest truncation.

Open technical questions resolved locally: strict cursor parsing, cursor field names, page default/max, and DOM control placement are reversible implementation details covered by tests.

Open value questions: none; the dispatch already fixes the user journey and non-regression boundary.

## Convergence Check

1. Rejected reasons -> ADR? No; this is a local reversible API/read-path decision recorded here.
2. New lessons -> lessons document? No; the known unbounded-hydration root cause is captured in F001.
3. New operating rules -> guide file? No; no repository-wide process rule changes.
