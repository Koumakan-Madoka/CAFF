---
feature_ids: [F001]
topics: [quality-gate, chat, pagination, verification]
doc_kind: evidence
created: 2026-07-28
---

# F001 Quality Gate Report

Spec: `docs/features/F001-long-conversation-cursor-pagination.md`

Original requirement: dispatch in the CAFF command thread, preserved in the F001 Why, user journey, design gate, and implementation plan.

Worktree: `E:\pythonproject\caff-long-conversation-pagination`

## Vision Coverage

| Requirement | AC | Implementation and proof |
| --- | --- | --- |
| Opening or refreshing a long conversation must not load all public messages | AC-1 | Conversation GET returns an empty public-message projection; the UI independently requests the latest page. The 120-message dogfood returned 50 initially. |
| Complete stable traversal, including equal timestamps | AC-2, AC-4 | Tuple keyset `(created_at,id)`, repository traversal tests, deleted cursor row and append-after-cursor tests. |
| Strict bounded public API | AC-3 | Default 50, maximum 100, opaque conversation-bound cursor, invalid shape/timestamp/limit tests. |
| Reuse the existing SQLite index | AC-5, AC-6 | Both prepared-statement query plans use `idx_chat_messages_conversation_id`; 50,000-row page is bounded to 50. |
| Older history remains reachable without scroll jumps | AC-7 | Real Chromium at 1280x900 and 375x812 proves initial latest positioning, two anchored prepends with at most about 1px drift, 120/120 unique traversal, and responsive rendering. |
| Runtime, digest, games, trace, export, diagnostics, and recovery keep their semantics | AC-8 | Full-history call-site audit in `project-evidence/F001-long-conversation-pagination.md`; fast and smoke suites pass. |
| Release gates pass | AC-9 | Typecheck, fast, and smoke passed after implementation. |

Delivery completeness: complete F001 slice. No deferred AC, stub, next-PR tail, or rewrite requirement was found.

## Functional Matrix

| Layer/state | Result | Evidence |
| --- | --- | --- |
| Repository latest/before/empty/boundaries | Pass | `tests/storage/chat-store.test.js` |
| Equal timestamp, delete, append, no duplicate/gap | Pass | `tests/storage/chat-store.test.js` |
| HTTP projection, limits, cursor errors, missing conversation | Pass | `tests/smoke/server-smoke.test.js` |
| UI empty/full control hidden | Pass | `tests/runtime/message-history.test.js` |
| UI partial/loading/error/retry | Pass | `tests/runtime/message-history.test.js` |
| UI prepend anchor and live latest merge | Pass | `tests/runtime/message-tool-trace.test.js` |
| Failed switch / stale refresh ownership | Pass | `tests/runtime/message-tool-trace.test.js` |
| Send response cannot rehydrate full history | Pass | `tests/runtime/message-tool-trace.test.js` |

## Dogfood-Your-Slice

Scope verdict: required, user-visible UI and REST behavior.

Isolated environment:

```text
cwd: E:\pythonproject\caff-long-conversation-pagination
URL: http://127.0.0.1:3110/
SQLite: C:\Users\ZN\AppData\Local\Temp\caff-f001-browser-a2f3e75f70c84901a031ba0c3293a463\browser.sqlite
fixture: 120 messages in browser-long-conversation
```

Hub Browser Preview was opened through `cat_cafe_preview_open` after an HTTP 200 probe.

Real three-page traversal:

```json
{"pageSizes":[50,50,20],"firstId":"browser-message-000","lastId":"browser-message-119","total":120,"unique":120}
```

Bug found and fixed during dogfood/self-check: a failed switch could leave the selected conversation and message-history owner out of sync, allowing an old SSE refresh to issue two requests under the new owner's generation. The regression now proves zero requests when the owner differs.

The first review correctly carried a 375px screenshot gap. Follow-up verification used an already-installed local Playwright/Chromium runtime without adding a project dependency. That run found a real document-scroll ownership defect, fixed it Red→Green, and captured desktop and 375px screenshots under `project-evidence/F001-browser/`.

Browser anchor metrics after the fix:

```text
1280x900: first prepend -0.203px, second prepend +1.016px
375x812: first prepend -0.531px, second prepend +1.000px
both: initial 50 unique; final 120 rows / 120 unique; history control hidden at end
```

## Design And Architecture

`.pen` glob result: no matching design file. The implementation follows the F001 in-context wireframe and existing CSS variables/button primitives.

Architecture cell: CAFF conversation storage/read path (`storage/chat` -> `lib/chat-app-store` -> `server/api` -> `public/chat`)

Map delta: none

Why: the implementation extends existing repository, store, controller, and chat-view boundaries. Diff scan found no production addition of a parallel Store, Queue, Router, Adapter, Dispatcher, or Binding.

## Process Guards

- Close report: not yet generated because this is the pre-review gate; no unmet AC tail was found.
- Follow-up tail scan: no blocking keyword hit.
- Hotfix detector: CAFF does not provide `scripts/check-hotfix-pattern.mjs`; branch and commit intent are feature work, not hotfix.
- Fallback detector: CAFF does not provide `scripts/check-fallback-layers.mjs`; manual added-line scan found guards and one request `try/catch`, not three fallback layers in one file.
- Capability tips: Clowder Console-specific seed/check harness is absent in CAFF; not applicable to this repository.
- Artifact hygiene: no root-level media/design artifact in the worktree or committed diff.

## Verification

Fresh commands and results:

```text
npm run typecheck     -> exit 0
npm run test:fast     -> exit 0
npm run test:smoke    -> 60/60 pass
git diff --check      -> exit 0
```

Focused long-history result from the same worktree:

```text
50,000-message latest page: 0.113ms
latest plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=?)
before plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=? AND (created_at,id)<(?,?))
```

Quality Gate verdict: pass. The earlier visual-evidence warning is closed by real 1280px/375px Chromium interaction and screenshots. Because the browser run caused a behavior fix after the first peer review, the new SHA requires scoped non-author continuity approval before merge.
