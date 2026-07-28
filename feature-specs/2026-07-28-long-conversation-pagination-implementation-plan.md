---
feature_ids: [F001]
topics: [chat, sqlite, pagination, plan]
doc_kind: plan
created: 2026-07-28
---

# Long Conversation Cursor Pagination Implementation Plan

**Feature:** F001 - `docs/features/F001-long-conversation-cursor-pagination.md`
**Goal:** Opening or refreshing a conversation returns only a fixed latest public-message page while stable cursor traversal keeps all older public history reachable.
**Acceptance Criteria:** AC-1 through AC-9 from the Feature spec.
**Architecture cell:** CAFF conversation storage/read path
**Map delta:** none
**Map delta why:** Existing repository, store, controller, and chat modules already own each boundary.
**Architecture:** Add a tuple-keyset repository page, a store projection/page facade, a domain cursor codec, and a thin GET route. Keep full-history aggregate reads unchanged outside the public UI, whose state merges latest pages and prepends older pages by id.
**Tech Stack:** TypeScript/CommonJS, better-sqlite3, Node test runner, plain browser JavaScript, CSS.
**Frontend verification:** Yes - browser desktop and 375px.

---

## Finish Line

One 50-message latest-page response opens any conversation, repeated cursors traverse every public message exactly once, live updates preserve loaded history and cursor state, and all existing runtime/game/digest/export behavior remains green.

Not building: private-message pagination, offset pages, prompt truncation, Redis, or a new index.

## Terminal Schema

```ts
type MessageCursorKey = {
  createdAt: string;
  id: string;
};

type ConversationMessagePage = {
  items: Message[];
  nextCursor: string | null;
  hasMore: boolean;
};
```

The opaque cursor envelope is `{ v: 1, conversationId, createdAt, id }`. It is encoded/decoded only by the server domain helper.

## Stateful Object Census

### Object 1: MessagePageCursor

Lifecycle owner: `server/domain/conversation/message-pagination.ts` issues and validates; the repository consumes only decoded keys.

| State | Event | Next | Rule |
|-------|-------|------|------|
| absent | latest request | issued or exhausted | Cursor keys come from oldest returned item. |
| issued | before request | issued or exhausted | Request must target the same conversation. |
| issued | cursor row deleted | issued or exhausted | Tuple boundary remains valid without row lookup. |
| issued | newer row appended | issued or exhausted | Older traversal is unchanged. |
| any | malformed/cross-conversation input | rejected | Return `400`; never fall back to latest. |

Invariants:

- INV-1: Page items are strictly ascending by `(createdAt,id)`.
- INV-2: Every before page contains only keys strictly less than its cursor.
- INV-3: `hasMore=true` iff the `limit+1` probe found an older row.
- INV-4: An issued cursor is bound to exactly one conversation and schema version.
- INV-5: Cursor validity does not depend on the boundary row still existing.

Adversarial tests: equal timestamps; deleted boundary row; append after issuance; malformed base64/JSON/schema; cross-conversation replay; limit 0/1/100/101.

### Object 2: UiHistoryWindow

Lifecycle owner: `public/app.js` for the currently selected conversation only. It is derived in memory and never persisted.

| State | Event | Next | Rule |
|-------|-------|------|------|
| idle | open conversation | loading-latest | Clear prior conversation cursor/window. |
| loading-latest | success | ready/exhausted | Replace with latest page, then scroll bottom. |
| ready | load earlier | loading-older | Keep current items and capture scroll height/top. |
| loading-older | success | ready/exhausted | Prepend by id and restore anchor by height delta. |
| ready/loading-older | live refresh | same | Merge latest items; do not replace older cursor. |
| any loading | conversation switch | idle for new id | Stale response must not mutate new conversation. |
| loading-older | failure | ready | Keep items/cursor and expose retry state. |

Invariants:

- INV-6: Visible persisted public messages are unique by id and sorted by `(createdAt,id)`.
- INV-7: A live latest-page refresh never changes `nextCursor` for the currently loaded oldest boundary.
- INV-8: A successful prepend keeps the previously oldest card at the same viewport position within rounding tolerance.
- INV-9: Response data is applied only when its conversation id still owns the UI window.

Adversarial tests: double-click load; live append during older fetch; switch conversation during fetch; same-timestamp messages; optimistic user message becomes persisted.

## Task 1: Repository Page Red Tests

**Files:** `tests/storage/chat-store.test.js`, `storage/chat/message.repository.ts`, `lib/chat-app-store.ts`

1. Add failing tests for latest page, before cursor, equal timestamps, limits, empty history, deletion, append stability, no gaps, and no duplicates.
2. Run the focused storage suite and confirm failures are missing page APIs.
3. Implement prepared latest/before statements with `limit+1`, bounded reversal, and store normalization.
4. Run focused tests green and commit.

## Task 2: Cursor/API Red Tests

**Files:** `tests/smoke/server-smoke.test.js`, `server/domain/conversation/message-pagination.ts`, `server/api/conversations-controller.ts`, `lib/chat-app-store.ts`

1. Add failing controller tests for response shape, default/max limits, invalid/cross-conversation cursors, and the no-public-messages conversation projection.
2. Confirm GET `/messages` is missing and conversation GET is unbounded.
3. Implement strict cursor codec, projection method, and thin GET route without changing POST.
4. Run smoke tests green and commit.

## Task 3: Query Plan and 50k Evidence

**Files:** `tests/storage/chat-store.test.js`, `project-evidence/F001-sqlite-query-plan.md`

1. Add isolated SQLite tests that insert 50,000 rows transactionally.
2. Assert page size remains bounded and `EXPLAIN QUERY PLAN` names `idx_chat_messages_conversation_id` for latest and before queries.
3. Record plan strings and measured elapsed time as non-threshold evidence; do not add a synonymous index.
4. Run focused tests green and commit.

## Task 4: Frontend Window Red Tests

**Files:** `tests/runtime/message-pagination-ui.test.js`, `public/app.js`, `public/chat/message-timeline.js`, `public/index.html`, `public/styles.css`, `package.json`

1. Add a jsdom harness proving latest open, older prepend/dedupe, stale-response rejection, live merge cursor preservation, and scroll-anchor restoration.
2. Confirm tests fail because pagination state/actions/control do not exist.
3. Implement the smallest state/controller changes and history control, reusing existing ordering/optimistic-message logic.
4. Run UI tests, browser syntax/typecheck, and commit.

## Task 5: Full-History Audit and Regression

**Files:** `docs/features/F001-long-conversation-cursor-pagination.md`, `project-evidence/F001-full-history-call-site-audit.md`, affected existing tests only if an API contract assertion changes.

1. Classify every production `getConversation()`/`listMessages()` call as UI projection, runtime prompt, digest, game, export/trace, recovery, or diagnostics.
2. Verify only the public UI GET path moved to the projection/page APIs.
3. Run `npm run typecheck`, `npm run test:fast`, and `npm run test:smoke`.
4. Record exact evidence and commit.

## Task 6: Browser Acceptance

**Files:** `project-evidence/F001-browser-acceptance.md` and screenshots.

1. Start the worktree server on an unreserved port such as 3110 with an isolated SQLite fixture.
2. Use browser preview at desktop and 375px to open a long conversation, load older messages, append a new message, refresh, and repeat pagination.
3. Capture screenshots plus item/order/cursor observations and stop the local server.
4. Run the quality gate and request non-author review.

## Open Questions

Technical: none unresolved before implementation. Private-message pagination remains explicitly outside F001.

Value: none; no operator decision is required beyond the dispatched acceptance criteria.
