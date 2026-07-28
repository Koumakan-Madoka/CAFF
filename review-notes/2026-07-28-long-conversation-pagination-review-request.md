---
feature_ids: [F001]
topics: [review, chat, sqlite, pagination]
doc_kind: review_request
created: 2026-07-28
---

# Review Request: CAFF Long Conversation Cursor Pagination

Review-Target-ID: long-conversation-pagination
Branch: feat/long-conversation-pagination
Implementation SHA: f5df2f7b4b6a7de35a2410eb46304a558b16e042

## What

- Added stable SQLite keyset pagination on `(created_at, id)` and reused `idx_chat_messages_conversation_id`.
- Added bounded `GET /api/conversations/:id/messages?limit=&before=` with `items`, opaque `nextCursor`, and `hasMore`; default 50, maximum 100, strict cursor/limit/conversation validation.
- Changed the public conversation projection so opening and refreshing no longer hydrates all public messages.
- Added browser history state for latest-page loading, anchored older-page prepend, id deduplication, stable ordering, live latest-page merge, stale-request guards, and complete loading/error/retry/end states.
- Audited production full-history consumers and kept runtime prompts, digest, games, export, diagnostics, recovery, and tool-trace semantics explicit and unchanged.

## Why

Opening or refreshing a conversation previously read, serialized, and rendered every public message. Latency, memory use, response size, and DOM work therefore grew linearly with total history even though the user initially needs only the latest context. The change bounds the public UI read path without silently truncating internal full-history consumers.

## Original Requirements

> The user opens or refreshes a long conversation and immediately sees a fixed-size latest page at the bottom.
> Activating "Load earlier messages" prepends history without duplicate cards or a viewport jump.
> New messages remain chronological and do not invalidate the cursor for older history.
> Repeating the action traverses every public message exactly once.

- Source: `docs/features/F001-long-conversation-cursor-pagination.md` (`Why`, `User Journey`, and `Acceptance Criteria`), preserving the dispatch from the CAFF command thread.
- **Please judge the delivery against the operator experience above, not only the implementation-level ACs.**

## Tradeoff

- Rejected offset pagination because concurrent inserts and equal timestamps can create skips or duplicates and because deep offsets scale poorly.
- Did not add a synonymous index: both latest and before-cursor queries use the existing `(conversation_id, created_at, id)` index.
- Did not change global `getConversation()` semantics. Full-history runtime/digest/game paths remain intact; only public/UI projections use pagination.
- Kept cursors opaque and conversation-bound rather than exposing raw tuple parameters. This adds encode/decode validation but prevents cross-conversation reuse and leaves the API free to evolve.
- Did not fold unrelated local commit `af096a8` (`contextSnapshotMode`) into this branch. If it lands independently, conflict resolution must preserve full context-snapshot listing and the metadata needed by paged messages.

## Architecture Ownership

Architecture cell: CAFF conversation storage/read path (`storage/chat` -> `lib/chat-app-store` -> `server/api` -> `public/chat`)
Map delta: none
Why: the diff extends existing repository, store, controller, and chat-view boundaries; it does not introduce a parallel Store, Queue, Router, Adapter, Dispatcher, or Binding.

Please verify that the diff matches `Map delta: none`, particularly the new pagination domain helper and browser history-state module.

## Open Questions

### Technical OQ

1. Verify tuple predicates and reverse-query/reverse-result handling for equal timestamps, deleted cursor rows, and append-after-cursor behavior.
2. Verify the projection boundary: public reads are bounded while runtime prompt, digest, games, export, diagnostics, recovery, and tool trace do not lose required history or metadata.
3. Verify the browser ownership model under failed conversation switches, overlapping SSE refreshes, sends, and older-page loads; older cursors must not be reset by live latest-page merges.
4. Review compatibility with local-but-not-upstream commit `af096a8`: if later rebased together, context-snapshot listing must retain full snapshot mode and paged rows must retain required snapshot/tool-trace metadata.
5. Treat the missing captured 375px screenshot as an explicit release-evidence gap. The Hub Preview opened the real app, but the available typed surface exposed neither viewport control nor screenshot capture; do not mark AC-7 complete without independent desktop and 375px interaction evidence.

### Value OQ

None.

## Next Action

Please independently review `f5df2f7`, rerun the high-risk pagination/UI tests, inspect the SQLite plans, and exercise the live fixture at desktop and 375px. Return `APPROVE`, `REQUEST-CHANGES`, or `COMMENT` with findings grounded in the reviewed SHA and independent evidence. The 375px evidence gap is part of the requested review, not a claimed pass.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/long-conversation-pagination/opus`
- Start Command: `CHAT_APP_PORT=3111 PI_SQLITE_PATH=/tmp/cat-cafe-review/long-conversation-pagination/opus/review.sqlite npm run start:dev`
- PowerShell equivalent: `$env:CHAT_APP_PORT='3111'; $env:PI_SQLITE_PATH='/tmp/cat-cafe-review/long-conversation-pagination/opus/review.sqlite'; npm run start:dev`
- Ports: `web=3111`, `api=3111` (CAFF serves both through one HTTP server)
- Author dogfood instance: `http://127.0.0.1:3110/` (isolated 120-message SQLite fixture; PID 25500)

### Sandbox Bootstrap

```powershell
Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
npm ci
npm run build
```

This repository uses `npm`/`package-lock.json`; it has no `pnpm review:start` script.

## Self-Check Evidence

### Spec Compliance

- Quality Gate report: `project-evidence/F001-quality-gate.md`
- Verdict: pass with one explicit warning, the unavailable captured 375px screenshot.
- Artifact hygiene: no root-level media/design artifact in either worktree status or `origin/main...HEAD`.
- Worktree status: only pre-existing untracked `Microsoft/`; it is unrelated and must not be staged, cleaned, or removed.

### Test Results

```text
npm run typecheck  -> exit 0
npm run test:fast  -> exit 0
npm run test:smoke -> 60/60 pass
git diff --check   -> exit 0
```

Focused evidence:

```text
50,000-message latest page: approximately 0.113ms in the final gate run
latest plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=?)
before plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=? AND (created_at,id)<(?,?))
temporary B-tree: absent

isolated browser fixture page sizes: [50, 50, 20]
traversed ids: browser-message-000..browser-message-119
total: 120; unique: 120
```

### Relevant Documents

- Feature: `docs/features/F001-long-conversation-cursor-pagination.md`
- Design Gate: `feature-specs/2026-07-28-long-conversation-pagination-design.md`
- Implementation Plan: `feature-specs/2026-07-28-long-conversation-pagination-implementation-plan.md`
- Evidence: `project-evidence/F001-long-conversation-pagination.md`
- Quality Gate: `project-evidence/F001-quality-gate.md`

[砚砚/gpt-5.6-sol🐾]
