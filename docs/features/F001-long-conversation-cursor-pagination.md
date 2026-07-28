---
feature_ids: [F001]
related_features: []
topics: [chat, sqlite, pagination, performance]
doc_kind: spec
created: 2026-07-28
---

# F001: Long Conversation Cursor Pagination

> Status: review | Owner: @cat-ir4rwo6b

## Why

Opening or refreshing a conversation currently reads and returns every public message, so latency, memory use, JSON size, and DOM work grow linearly with the total history even when the user only needs the latest context.

## Current State

- `storage/chat/message.repository.ts` lists a conversation with no `LIMIT`.
- `lib/chat-app-store.ts#getConversation()` always hydrates `messages` through that unbounded list.
- `GET /api/conversations/:id` returns the hydrated aggregate, and `public/app.js` replaces its current timeline with that full array on open and SSE refresh.
- SQLite already has `idx_chat_messages_conversation_id (conversation_id, created_at ASC, id ASC)`; the feature must prove query-plan use before changing indexes.
- Baseline evidence: `npm test` passed on `origin/main@0754e7959a35ef3086a166277bb24a98cc13b630` on 2026-07-28.

## What

- Add stable keyset pagination for public messages using `(created_at, id)` as the ordering key.
- Add a bounded read-only `GET /api/conversations/:id/messages` contract while preserving `POST` behavior.
- Make the public chat UI load the latest page first, prepend older pages without scroll jumps, and merge live latest-page refreshes without losing the older-page cursor.
- Keep runtime prompts, digest generation, games, trace inspection, exports, recovery, and diagnostics on their current full-history semantics unless a call site is explicitly a UI projection.

## User Journey

**Scope unit:** one conversation.

1. The user opens or refreshes a long conversation and immediately sees a fixed-size latest page at the bottom.
2. When older history exists, the user activates "Load earlier messages" at the top of the timeline.
3. Earlier messages appear above the current first message without duplicate cards or a viewport jump.
4. New messages arriving during or after history browsing stay in chronological order and do not invalidate the cursor for older history.
5. Repeating the action eventually traverses every public message exactly once.

## Acceptance Criteria

- [x] AC-1: The initial public-message response has a fixed maximum item count independent of total history.
- [x] AC-2: Latest and before-cursor pages traverse equal-timestamp histories completely with no duplicates or gaps.
- [x] AC-3: `limit` has a documented default and hard maximum; malformed, cross-conversation, and structurally invalid cursors return `400`.
- [x] AC-4: Empty conversations, boundary limits, deleted cursor rows, and messages appended after a cursor is issued have deterministic behavior covered by tests.
- [x] AC-5: `EXPLAIN QUERY PLAN` shows both latest and before-cursor queries use `idx_chat_messages_conversation_id`; no synonymous index is added.
- [x] AC-6: An isolated 50,000-message conversation returns only one bounded page and records query-plan/performance evidence.
- [ ] AC-7: Desktop and 375px browser verification proves initial bottom position, older-page prepend anchoring, no duplicate rendering, and correct live-message order.
- [x] AC-8: Runtime prompt, digest, undercover, werewolf, tool trace, export, diagnostics, and recovery paths retain full-history behavior or targeted lookup behavior, with the call-site audit recorded.
- [x] AC-9: `npm run test:fast`, `npm run test:smoke`, type checks, and focused long-history tests pass against isolated SQLite fixtures.

## Dependencies

- Existing SQLite `chat_messages` table and `idx_chat_messages_conversation_id` index.
- Existing plain-JavaScript chat timeline and HTTP controller.

## Risk

- Cursor ordering errors can silently skip or duplicate rows with equal timestamps.
- A live refresh can accidentally replace previously loaded history or reset the older-page cursor.
- Reusing the paged UI projection inside runtime or digest code would silently truncate agent context.
- Private mailbox history is stored separately and remains on its existing read contract; this feature paginates public conversation messages only.

## Non-Goals

- Offset pagination.
- Changing prompt history, digest, or game semantics.
- Paginating private mailbox messages or search results.
- Adding Redis, a second SQLite index, or production-data migrations.

## Links

- [Design Gate](../../feature-specs/2026-07-28-long-conversation-pagination-design.md)
- [Implementation Plan](../../feature-specs/2026-07-28-long-conversation-pagination-implementation-plan.md)
