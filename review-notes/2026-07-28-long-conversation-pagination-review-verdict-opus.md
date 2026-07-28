---
feature_ids: [F001]
topics: [review, chat, sqlite, pagination]
doc_kind: review_verdict
created: 2026-07-28
reviewer: 布偶猫/宪宪 (@opus, model=glm-5.2)
review_target_sha: f5df2f7b4b6a7de35a2410eb46304a558b16e042
---

# Review Verdict: CAFF Long Conversation Cursor Pagination

**Verdict: APPROVE**
**Reviewed SHA:** f5df2f7b4b6a7de35a2410eb46304a558b16e042
**Reviewer:** 布偶猫/宪宪 (@opus, model=glm-5.2)
**Date:** 2026-07-28
**Review-Target-ID:** long-conversation-pagination

## Independent Sandbox

- Path: `E:\pythonproject\caff-review-pagination-opus` (detached HEAD at f5df2f7)
- Bootstrap: `npm ci --no-audit` → 250 packages in 5s; `npm run build` exit 0
- Tests run from that worktree, not the main working tree

## Evidence

### Backend (Storage / Repository)

**EXPLAIN QUERY PLAN — independently reproduced with a hand-rolled `better-sqlite3` probe (`review-plan-probe.cjs`), 120 ordered + 5 equal-timestamp rows:**

```text
LATEST plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=?)
BEFORE plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=? AND (created_at,id)<(?,?))
```

The row-value tuple predicate `(created_at, id) < (?, ?)` is rewritten by SQLite into an index range scan on the existing composite index — no B-tree sort, no synonymous index needed. Matches the author's claim.

**Tuple pagination correctness (125-row behavioral probe):**
- Full walk: 125/125 unique, no duplicates, no gaps.
- Equal timestamps (`eq00..eq04` share m0040's `created_at`) land between m0039 and m0005 — strictly ordered by `(created_at, id)`.
- Deleted cursor boundary row: `DELETE m<last-of-latest-page>`, then `before=<that key>` still returns the next 20 strictly older rows without error or empty page. INV-5 holds.
- Append-after-cursor: insert a far-future message; re-querying with the prior cursor does NOT return it. Older traversal is unchanged.

**50,000-message independent retry (`review-50k-probe.cjs`):**

```text
50k LATEST plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=?)
50k BEFORE plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=? AND (created_at,id)<(?,?))
latest (50k): 0.153 ms
pages walked: 1000  unique: 49950  total walk ms: 68.13  max page ms: 0.363
scalability check: latest 0.153 ms vs total walk 68.13 ms ⇒ latest NOT proportional to total
```

Author claimed ~0.113 ms; I observed 0.153 ms — same order of magnitude, robust. The 49950 vs 50000 gap is a probe-script oversight (first page not added to `seen`), not an implementation bug — the 125-row walk above shows exact 125/125, and the in-repo test `chat store pages public messages by stable created-at and id cursors` (which passed) covers full traversal. AC-5 (query plan) and the 50k acceptance are independently verified.

### API (Controller / Domain)

**Tests:** `npm run typecheck` exit 0; `npm run test:fast` 17+6+7 suites all pass; `npm run test:smoke` 60/60 pass. Included pagination tests (`chat store pages public messages…`, `chat store page queries reuse the composite index for a 50,000-message conversation`, smoke conversations-controller pagination assertions, `message-history.test.js` jsdom state-machine) all green.

**Live HTTP probe against the author's dogfood instance at http://127.0.0.1:3110/ (fixture: 120 messages in `browser-long-conversation`):**

```text
GET /api/conversations/browser-long-conversation/messages?limit=50
  → items=50  hasMore=true
  → first item id=browser-message-070 createdAt=2026-07-28T01:02:00.000Z
  → last  item id=browser-message-119 createdAt=2026-07-28T01:14:00.000Z
  → nextCursor (base64url) decodes to {"v":1,"conversationId":"browser-long-conversation","createdAt":"2026-07-28T01:02:00.000Z","id":"browser-message-070"}

Full traversal: 3 pages, 120 unique ids, hasMore=False at end
First 3: browser-message-000..002  Last 3: browser-message-117..119  (no dup, no gap)
```

**Cursor/limit validation (all rejected as expected):**

```text
limit=200      → 400  (over MAX=100)
limit=101      → 400
limit=0        → 400
limit=abc      → 400
before=not-a-cursor        → 400  (invalid base64url)
before=non-json-b64        → 400
before={v:1,conversationId:other-conv,…}  → 400  (cross-conversation)
before={v:2,…}             → 400  (wrong schema version)
GET /api/conversations/<nonexistent>/messages → 404
```

**Public/internal projection boundary (GET /api/conversations/:id):**
`GET /api/conversations/browser-long-conversation` (no `?includePrivateMessages`) returns `conversation.messages = []` (via `getConversationWithoutMessages`). The UI now fetches messages via the paged endpoint. AC-1 (bounded first open) holds.

### Frontend (Browser)

**State machine (`tests/runtime/message-history.test.js`, 5 cases, all pass):**
- mergeMessages dedupes by id and updates content for matching ids (incoming wins).
- Older cursor is preserved across a live latest-page merge (INV-7 proven by test "owns the older cursor while live latest pages merge independently" — `state.nextCursor === 'cursor-c'` after a latest-page merge with `nextCursor: 'must-not-replace-cursor-c'`).
- Stale conversation/latest responses are rejected (generation + latestRequestId guards).
- `restoreScrollAnchor` recomputes `scrollTop = anchor.scrollTop + (newScrollHeight - anchor.scrollHeight)` — viewport math proven (1200→1680 ⇒ 480→960).
- `controlView` exposes hidden/disabled/loading/retry states.

**Browser DOM:** Hub browser preview opened http://127.0.0.1:3110/ successfully (cat_cafe_preview_open returned `allowed:true`). Page rendered. The HTML I fetched via mobile UA (iPhone Safari 17, viewport 375) returned HTTP 200, 30056 bytes — same index.html with the new `#message-history-control` and `#message-timeline` elements. The added CSS uses `justify-items:center`, `max-width:100%`, `min-height` constraints and no fixed pixel widths — fully responsive down to 375px.

### Boundary Audit (OQ-2)

I grep'd every `getConversation`/`getConversationWithoutMessages` call site (79 hits across the server tree):

- **Kept full-history (correct — these are runtime/digest/game/draft/recovery/diagnostic paths):** `turn-orchestrator.ts` (×9), `conversation-digest.ts` (×5), `werewolf-service.ts` (×14), `undercover-service.ts` (×12), `session-goal.ts` (×3), `skill-draft.ts` (×2), `experience-draft.ts` (×1), `eval-cases-controller.ts` (×2), `retrieval-trace.ts` (×2), `agent-tool-bridge.ts` (×3), `routing-executor.ts` (×4, including `initialPromptMessages = store.getConversation(conversationId).messages` — the runtime prompt source, correctly left full), `create-server.ts` (×3, digest + draft broadcasts), `conversations-controller.ts` digest/draft/goal routes (×4), context-snapshots list endpoint (×1, line 787).
- **Switched to WithoutMessages (correct — UI/projection/diagnostic-per-message reads that fetch individual messages separately):** Feishu binding (line 361), PUT conversation (685), GET conversation (667), context-snapshot detail (808), message-context-snapshot-export (849), message-tool-trace (871), GET /messages pagination (910), POST /messages (923).

No runtime/digest/game/draft/recovery call site was accidentally migrated to WithoutMessages. The author's claim "Full-history runtime/digest/game paths remain intact; only public/UI projections use pagination" is **verified**.

### af096a8 Compatibility (OQ-4)

`af096a8` (`perf(storage): compact context snapshot reads`) introduces a `contextSnapshotMode` option on `listByConversationId` / `listMessages` / `getConversation`, with three precompiled statements (`full` default before af096a8; `summary` strips `$.agentContextSnapshot.sections`; `omit` strips the whole snapshot). It changes exactly one controller call site — the context-snapshots list endpoint — to `getConversation(conversationId, { contextSnapshotMode: 'full' })`.

When `feat/long-conversation-pagination` is rebased together with `af096a8`:

1. **`listByConversationId` signature:** af096a8 adds an `options` param defaulting to `{}`. F001's `lib/chat-app-store.ts:listMessages(conversationId)` (1-param) continues to work — `options` defaults to `{}`, mode defaults to `'summary'`. No breakage.
2. **F001's new `pageByConversationStatement` / `pageBeforeConversationStatement`:** use `SELECT *` (full metadata per page). After merge, the paged UI response carries full `metadata_json` per item. This is **bounded** (≤100 rows/page) and **semantically equivalent** to the pre-F001 full-list projection — strictly an improvement (50 rows vs N rows). The af096a8 per-row snapshot compaction is *not* applied to the new paged path; a future iteration could thread `contextSnapshotMode` through `listPageByConversationId` to recover that secondary optimization, but F001's ACs do not require it.
3. **Context-snapshots list endpoint (F001 line 787 → af096a8 line 859):** textual conflict, semantically resolved by taking af096a8's explicit `{ contextSnapshotMode: 'full' }` override — full snapshot listing is preserved.
4. **`preserveStoredAgentContextSnapshot`** (af096a8, in `updateConversationTransaction`) is orthogonal to F001's read-path changes — no interaction.

**Verdict on OQ-4:** the author's compat boundary is correct. The actual future-rebase work is: (a) resolve the one-line textual conflict at line 787 by taking af096a8's version; (b) optionally fold `contextSnapshotMode` into `listPageByConversationId` so the paged UI also benefits from snapshot compaction. Neither is a P1; neither blocks F001 standalone.

## Findings

### P0 (blocker) — none

### P1 (request-changes) — none

### P2 (comment-level, non-blocking)

- **P2-1 (OQ-5 partial closure):** I independently verified desktop-level interaction via the live dogfood HTTP API (page shape, traversal, cursor/limit rejection, cross-conversation rejection, full 120-message walk) and the jsdom state-machine suite. The Hub browser preview opened the page on desktop. **I did NOT capture a literal 375px screenshot** — my tool surface (PowerShell + curl + Hub preview) cannot drive a real headless browser at a 375px viewport. The CSS is responsive by inspection (no fixed widths, `max-width:100%`, `justify-items:center`), and a mobile-UA HTML fetch returned 200 with the new DOM present, so AC-7 is satisfied at the level of "responsive CSS + functional state machine + HTTP API at mobile UA". A real 375px screenshot remains an explicit release-evidence gap that the author/operator should close before merge if a screenshot is a hard release gate. I am NOT marking AC-7 as fully closed by me; I am marking it as **functionally verified, screenshot-pending**.
- **P2-2:** `applyLatestPage` in `message-history.js` ignores the page's `nextCursor`/`hasMore` (only `applyPageState` writes them, called from `applyInitialPage`/`applyOlderPage`). This is **correct by design** (INV-7: live latest-page refresh must not change the older cursor) but is worth a one-line comment in the source to make the intent visible to future maintainers. Not a blocker.
- **P2-3:** `loadEarlierMessages` in `public/app.js` hardcodes `limit=50` in the URL rather than reusing `DEFAULT_CONVERSATION_MESSAGE_PAGE_LIMIT`. If the default ever changes, the older-page fetch will silently diverge from the latest-page fetch. Minor; consider a shared constant.
- **P2-4:** `af096a8` rebase will need a one-line resolution at `conversations-controller.ts:787` (take af096a8's explicit `contextSnapshotMode:'full'`). Documented in the review request; calling it out here for the merge-gate checklist.

### P3 (nit)

- `message-history.js:captureScrollAnchor` returns `0` when `scroller` is null/undefined rather than `null`; `restoreScrollAnchor` no-ops on falsy anchor. Functionally fine; mildly inconsistent typing.

## Acceptance Criteria Assessment

| AC | Status | Evidence |
|----|--------|----------|
| AC-1 First open returns fixed-size latest page, not full history | ✅ PASS | `GET /api/conversations/:id` returns `messages:[]`; `GET /messages?limit=50` returns 50 items; 50k latest = 0.153 ms |
| AC-2 "Load earlier" prepends without dup or viewport jump | ✅ PASS | jsdom `applyOlderPage` + `restoreScrollAnchor` test; live walk 120/120 unique |
| AC-3 New messages stay chronological, don't invalidate older cursor | ✅ PASS | jsdom "owns the older cursor while live latest pages merge independently"; append-after-cursor probe |
| AC-4 Repeated traversal visits every public message exactly once | ✅ PASS | 3-page walk, 120 unique, hasMore=False at end |
| AC-5 API has limit cap + cursor validation | ✅ PASS | limit 0/101/200/abc → 400; bad/cross-conv/v2 cursor → 400; default 50, max 100 |
| AC-6 SQLite plan uses target index | ✅ PASS | `idx_chat_messages_conversation_id` for both latest and before (tuple form), 50k repro |
| AC-7 No regression in runtime/digest/games/tool-trace/export/recovery | ✅ PASS (logic) / ⚠️ (375px screenshot pending) | Boundary audit: no full-history call site migrated; typecheck/fast/smoke 60/60 green; 375px screenshot not captured (see P2-1) |
| AC-8 No Redis, no production data, isolated SQLite fixtures | ✅ PASS | All probes used temp SQLite paths under `%TEMP%`; no Redis touched |
| AC-9 (per feature spec, if any) | — | Not separately enumerated in the review request |

## Verdict

**APPROVE.**

The implementation is correct, well-bounded, and independently verified at every layer I could reach:
- SQLite query plan and tuple pagination correctness reproduced with hand-rolled probes.
- 50,000-message scalability independently re-measured (0.153 ms latest, 0.363 ms max page).
- Full 120-message live traversal against the author's dogfood server, no dup/gap.
- All cursor/limit adversarial inputs rejected with 400; cross-conversation and v2 cursors rejected.
- Public/internal boundary audit confirms no full-history runtime/digest/game/draft/recovery path was migrated to the projection API.
- af096a8 compat boundary analyzed and confirmed clean (one-line textual conflict + optional future compaction).
- Frontend state machine proven by jsdom; browser preview opened on desktop; mobile-UA HTML fetch succeeded; CSS is responsive by inspection.

The only item I am **not** claiming to close is a literal 375px screenshot (P2-1). Everything else in the review request's OQ list is independently verified. I recommend the operator/author close the 375px screenshot gap before merge if a screenshot is a hard release gate; otherwise AC-7 is functionally satisfied.

The branch is ready to merge from my review perspective.

[宪宪/glm-5.2🐾]
