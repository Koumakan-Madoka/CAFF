---
feature_ids: [F001]
topics: [review, chat, sqlite, pagination]
doc_kind: review_response
created: 2026-07-28
reviewer: opus
reviewer_model: glm-5.2
reviewed_sha: f5df2f7b4b6a7de35a2410eb46304a558b16e042
review_target_id: long-conversation-pagination
verdict: APPROVE
---

# Review Response: CAFF Long Conversation Cursor Pagination

Reviewer: 布偶猫/宪宪 (@opus, model=glm-5.2)
Reviewed SHA: f5df2f7b4b6a7de35a2410eb46304a558b16e042
Review-Target-ID: long-conversation-pagination
Verdict: **APPROVE** (with one explicitly carried caveat, see AC-7 below)

## Independent Sandbox

- Path: `E:\pythonproject\caff-review-pagination-opus` (detached HEAD at f5df2f7, isolated from author's dogfood and main worktree)
- Build: `npm ci` (250 packages) → `npm run build` (tsc build success)
- Dev server used for live fixture: author dogfood at `http://127.0.0.1:3110/` (120-message `browser-long-conversation` fixture, server PID 25500 still running at review time)
- I also spun my own dev server at port 3111 with a fresh isolated SQLite for sanity, then cleaned up; final cleanup removed the review worktree.

## Independent Evidence

### AC-1 First open is bounded, not proportional to history

Isolated SQLite probe with **50,000 messages** in a single conversation, foreign keys off, fresh WAL database:

```
50k LATEST plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=?)
50k BEFORE plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=? AND (created_at,id)<(?,?))
latest (50k): 0.153ms
pages walked: 1000 unique: 49950 total walk ms: 68.13 max page ms: 0.363
scalability check (50k latest vs total): latest 0.1526 ms vs total walk 68.13 ms => latest NOT proportional to total
```

Author claimed ~0.113ms; my independent 0.153ms is the same order. The latest-page latency is bounded regardless of total history (49950-page walk would dominate if proportional). I independently confirmed both plans target `idx_chat_messages_conversation_id` and neither produces a temporary B-tree. Probe file: `E:\Users\ZN\AppData\Local\Temp\opencode\review-50k-probe.cjs` (transient; recreated on demand).

### AC-2 Stable traversal, no duplicates, no gaps

Independent 125-message behavioral probe (120 ordered + 5 same-timestamp messages `eq00..eq04` sharing `m0040`'s timestamp):

```
total walked: 125 unique: 125 first: m0100 last: m0004
eq00 position: 95 surroundings: m0038,m0039,eq00,eq01,eq02,eq03,eq04,m0005
```

Equal-timestamp siblings are correctly ordered by `(createdAt, id)` with no duplicate, no gap. Probe file: `E:\Users\ZN\AppData\Local\Temp\opencode\review-plan-probe.cjs`.

Live dogfood API traversal at `http://127.0.0.1:3110/` with `browser-long-conversation` (120-message fixture):

```
page1: items=50 hasMore=True nextCursor=eyJ2Ijox... (decodes to {v:1, conversationId, createdAt, id})
first item id: browser-message-070 createdAt=2026-07-28T01:02:00.000Z
last item id: browser-message-119 createdAt=2026-07-28T01:14:00.000Z
total pages=3 unique=120 hasMore=False
first 3 ids: browser-message-000 browser-message-001 browser-message-002
last 3 ids: browser-message-117 browser-message-118 browser-message-119
```

3 pages, 120 unique ids, every message traversed exactly once, hasMore=False at exhaustion. Matches author's evidence.

### AC-3 New append/refresh/load-earlier ordering

Frontend state-machine invariants are independently locked by `tests/runtime/message-history.test.js`:

- `message history owns the older cursor while live latest pages merge independently`: `applyLatestPage` is called with `nextCursor: 'must-not-replace-cursor-c'` but `state.nextCursor` stays `'cursor-c'` — OQ-3 invariant satisfied at the state-model layer.
- `merges pages in stable order and lets incoming rows update existing ids`: id-dedupe + fresh-overwrite + `(createdAt,id)` sort.
- `restores the viewport after older rows increase scroll height`: scroll anchor math verified (480 → 960 after height delta).
- `rejects stale conversation and latest-refresh responses`: generation+latestRequestId guard.
- `exposes hidden, partial, loading, and retry control states`: control view transitions.

I confirmed all 5 sub-tests pass via `npm run test:fast` (the test:fast chain runs `node tests/runtime/message-history.test.js`).

### AC-4 Limit and cursor validation

Live API negative tests against dogfood fixture:

```
limit=200 → 400
limit=101 → 400
limit=0   → 400
limit=abc → 400
bad before (non-base64) → 400
non-json cursor (valid base64 but bad JSON) → 400
cross-conv cursor (valid base64+JSON+schema v1, wrong conversationId) → 400
v2 cursor (schema version mismatch) → 400
nonexistent conversation → 404
limit=100 (max) → 200
default (no limit) → 200
GET /api/conversations/:id → 200, conversation.messages = [] (without-messages projection)
```

Opaque cursor confirmed bound to `conversationId` and `v=1`. Strict rejection; no fall-back to latest on invalid cursor.

### AC-5 SQLite plan uses target index

See AC-1 above. Both latest and before-cursor `EXPLAIN QUERY PLAN` name `idx_chat_messages_conversation_id` with the tuple row-value comparison `(created_at,id)<(?,?)` rewritten into a single index range scan, no temporary B-tree, no `cover`-scan. The author did **not** add a synonymous index; the existing `idx_chat_messages_conversation_id (conversation_id, created_at ASC, id ASC)` is sufficient.

### AC-6 No behavior regression in runtime/digest/games/export/diagnostics/recovery

- `npm run typecheck` → exit 0
- `npm run test:fast` → all suites pass (chat-store 17/17, run-store 6/6, pi-runtime 7/7, and all other listed tests pass; the run ends with `tests 17` and `tests 6` and `tests 7` summaries, 0 fail)
- `npm run test:smoke` → 60/60 pass (`tests 60 pass 60 fail 0 cancelled 0`)

Independent boundary audit of `getConversation()` / `getConversationWithoutMessages()` call sites via Grep across `server/`:

- **getConversation (full-history preserved)** — runtime/digest/games/draft/recovery paths all unchanged:
  - `turn-orchestrator.ts:102,652,674,700,896,1102,1199,1246,1304`
  - `conversation-digest.ts:1836,1846,2130,2231,2273`
  - `werewolf-service.ts` (12 call sites), `undercover-service.ts` (12 call sites)
  - `session-goal.ts:350,469,566`, `skill-draft.ts:1338,1473`, `experience-draft.ts:266`, `retrieval-trace.ts:204,313`
  - `eval-cases-controller.ts:567,818`
  - `routing-executor.ts:140,254,567,668` (incl. `initialPromptMessages = store.getConversation(conversationId).messages` — runtime prompt contract unchanged)
  - `agent-tool-bridge.ts:820,1190,1483`
  - `create-server.ts:224,267,277` (summary-broadcast/digest continuation)
  - `conversations-controller.ts:453,528,555,648,787` (skill-draft/digest/goal/context-snapshot-list — these correctly require full history)
- **getConversationWithoutMessages (no messages)** — UI projection + existence checks only:
  - `create-server.ts:150` (bootstrap summary)
  - `conversations-controller.ts:361,667,685,808,849,871,910,923` — feishu binding, PUT conversation, GET conversation (the changed UI projection), context-snapshot detail endpoints, tool-trace endpoint, session-export endpoint, GET /messages (paged) entry, POST /messages entry

No production full-history consumer was silently switched to the projection. The author's claim "Full-history runtime/digest/game paths remain intact; only public/UI projections use pagination" is accurate.

### AC-7 Browser acceptance — PARTIALLY CLOSED by reviewer

I closed the **desktop** portion via independent live API interaction + Hub browser preview opened (`cat_cafe_preview_open` against port 3110 succeeded, opened `/` in the Hub Browser Preview panel for the operator). I fetched the index HTML with a mobile Safari UA (`HTTP=200 size=30056`) and read `public/styles.css`: `.message-history-control` and `.message-timeline` use `justify-items: center`, `max-width: 100%`, `min-width: 0` — pure responsive grid with no fixed widths, so 375px reflow is supported at the CSS level. I also confirmed `tests/runtime/message-history.test.js` (jsdom VM harness) proves the UI state-machine's invariants (older-cursor preservation under live latest-page merge, scroll-anchor math, stale-request rejection) independent of any real browser.

**Caveat — NOT independently closed by reviewer**: I did not capture a **pixel-level 375px screenshot** of the running app. The Hub browser preview surface exposed neither viewport-width control nor screenshot capture in this review session. The author's quality-gate warning explicitly flagged this same gap. Verdict holds APPROVE because:

1. The functional behavior (state machine, scroll anchor, cursor ownership) is proven by jsdom unit tests and the implementation-plan invariants (INV-6..INV-9).
2. The CSS reflow at narrow widths is structurally sound (`max-width: 100%`, `min-width: 0`, no fixed widths on the new controls).
3. AC-1..AC-6 are independently and conclusively closed.
4. The remaining AC-7 gap is a pixel-evidence formality, not a behavioral risk; the operator-facing interaction at desktop is observable in the Hub Preview panel already opened.

I recommend the author capture a single 375px screenshot before merge to formally close AC-7's last line, but this is not a blocker.

## Open Questions Resolved

### OQ-1 (tuple predicates, equal ts, deleted cursor, append-after) — RESOLVED, PASS

See AC-2. Equal-timestamp tuple ordering verified (`m0038,m0039,eq00..eq04,m0005`); deleted cursor row: after deleting the cursor's boundary message, `listPageByConversationId(cid, { limit, before: cursor })` still returns the next page correctly (`m0080..m0099`) without error or empty result — INV-5 (cursor validity independent of boundary row) holds. Append-after-cursor: a brand-new message timestamped far in the future is correctly excluded from prior older-cursor pages (`page3.items.some(it => it.id === newId)` → false).

### OQ-2 (projection boundary) — RESOLVED, PASS

See AC-6 audit. All runtime/digest/game/draft/recovery/tool-trace paths retain full history via `getConversation()`; only `GET /api/conversations/:id` (UI header), `GET /api/conversations/:id/messages` (paged), and existence-check routes use `getConversationWithoutMessages()`. No silent truncation of prompt/digest/games. Tool-trace endpoint fetches a single message by id, not history.

### OQ-3 (UI ownership under switch/SSE/send/older-load) — RESOLVED at state-model layer, PASS

`message-history.test.js` proves:
- Generation + latestRequestId guard rejects responses from a prior conversation.
- `applyLatestPage` preserves `state.nextCursor` (older cursor not reset by live merge).
- `applyOlderPage` merges by id and re-sorts, dedupe safe.
- Scroll anchor captured before prepend and restored after.

Real-browser SSE/switch stress was not independently reproduced (would require runtime model integration), but the state-machine invariants are locked by unit tests, and `npm run test:fast` includes `chat-bridge-replay.test.js`, `turn-orchestrator.test.js`, and `pi-runtime.test.js` which exercise the SSE/replay interaction surface — all green.

### OQ-4 (af096a8 compat) — RESOLVED, PASS

af096a8 (`perf(storage): compact context snapshot reads`) modifies:

- `listByConversationId(conversationId, options)` to accept `{ contextSnapshotMode: 'full' | 'summary' | 'omit' }` and selects among three precompiled statements.
- `getConversation(conversationId, options)` and `listMessages(conversationId, options)` to forward options.
- `server/api/conversations-controller.ts:859` (context-snapshot list endpoint) from `getConversation(conversationId)` to `getConversation(conversationId, { contextSnapshotMode: 'full' })`.
- `lib/chat-app-store.ts` adds `preserveStoredAgentContextSnapshot()` for metadata-preservation across compact updates.

F001 at f5df2f7:

- `listByConversationId(conversationId)` keeps the 1-arg signature; after rebase, af096a8's 2-arg version is adopted. F001's call site `lib/chat-app-store.ts:1458 listMessages(conversationId)` continues to work because af096a8's `options` defaults to `{}` (summary mode) — no break.
- F001's new `pageByConversationStatement` / `pageBeforeConversationStatement` use `SELECT *` — they bypass `contextSnapshotMode`. After merge, paged UI responses will carry full metadata_json per row. This is **bounded** (50/100 rows max per page) and **semantically equivalent** to the pre-F001 full-list projection, so it is not a regression; it is a secondary future optimization to pass `contextSnapshotMode` into the page statements, but it is **not** part of F001's AC.
- The context-snapshot list endpoint at `conversations-controller.ts:787` (F001) still uses 1-arg `getConversation(conversationId)`. af096a8 changes that exact line to pass `'full'` mode. **Textual conflict, semantic resolution is trivial: take af096a8's version.** Author's review request OQ-4 explicitly states "context-snapshot listing must retain full snapshot mode" — confirmed: af096a8's explicit override preserves this.

Compat boundary is clean. No semantic regression on rebase. Recommend author (or rebaser) optionally extend `contextSnapshotMode` to the page statements as a follow-up to align with af096a8's routine-load compaction goal, but this is NOT a merge blocker.

### OQ-5 (375px screenshot) — PARTIALLY CLOSED

See AC-7. Desktop interactive evidence closed; 375px pixel screenshot not captured by reviewer. CSS reflow is structurally sound; behavioral invariants locked by jsdom tests. Formally close AC-7's last line with a 375px screenshot before merge, but this is not a behavioral blocker.

## Map Delta Verification

Author's claim: `Map delta: none`. Verified:

- `server/domain/conversation/message-pagination.ts` (new, 88 lines) — pure cursor codec + page builder; lives within the existing `server/domain/conversation` boundary; no new Store/Queue/Router/Adapter/Dispatcher/Binding. It is a thin domain helper, exactly as the architecture cell allows.
- `public/chat/message-history.js` (new, 196 lines) — UI state-machine module bound to `window.CaffChat.messageHistory`. Reuses existing `message-timeline.js` rendering path; no parallel chat-view. The `message-timeline.js` change simply swaps `dom.messageList` for `dom.messageTimeline || dom.messageList` (4 sites) — same rendering pipeline, new container element.
- `storage/chat/message.repository.ts` adds two prepared statements and `listPageByConversationId` — extends the existing repository, no new Store.
- `lib/chat-app-store.ts` adds `listMessagePage` facade — extends existing store, no parallel Store.
- `server/api/conversations-controller.ts` adds a GET branch on `/api/conversations/:id/messages` — extends existing controller, no new Router.
- `public/index.html` adds the `message-history-control` and `message-timeline` containers inside the existing `#message-list` — extends existing chat panel, no parallel Binding.

Map delta = none confirmed. No new architecture cell introduced.

## Verdict

**APPROVE**.

The implementation is correct, well-bounded, and matches the operator journey and acceptance criteria. All AC-1 through AC-6 are independently and conclusively closed with fresh evidence. AC-7 is closed at the desktop/CSS/jsdom layer; the 375px pixel screenshot remains an explicitly carried formality, not a behavioral risk. The af096a8 compat boundary is clean. No behavior regression in runtime/digest/games/export/diagnostics/recovery paths. The architecture delta is `none` as claimed.

Recommend merging after the author optionally captures a 375px screenshot to formally close AC-7's last evidence line. The 375px screenshot is a release-evidence completeness item, not a code correctness blocker.

[宪宪/glm-5.2🐾]
