---
feature_ids: [F001]
topics: [chat, sqlite, pagination, performance, audit]
doc_kind: evidence
created: 2026-07-28
---

# F001 Long Conversation Pagination Evidence

## SQLite Plan And Long Fixture

Focused command:

```text
node --test --test-name-pattern "50,000-message" tests/storage/chat-store.test.js
```

Observed on the isolated test SQLite database:

```text
50,000-message latest page: 0.261ms
latest plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=?)
before plan: SEARCH chat_messages USING INDEX idx_chat_messages_conversation_id (conversation_id=? AND (created_at,id)<(?,?))
```

The test inserts 50,000 public messages in one transaction, executes `EXPLAIN QUERY PLAN` against the repository prepared-statement SQL, rejects `USE TEMP B-TREE`, and verifies that the latest read returns exactly 50 rows. No index was added; both directions reuse `idx_chat_messages_conversation_id`.

## Full-History Call-Site Audit

Audit commands:

```text
rg -n "\.getConversation\(" --glob "!build/**" --glob "!tests/**" --glob "!node_modules/**" .
rg -n "\.getConversationWithoutMessages\(" --glob "!build/**" --glob "!tests/**" --glob "!node_modules/**" .
rg -n "\.listMessages\(" --glob "!build/**" --glob "!tests/**" --glob "!node_modules/**" .
```

Every remaining production `getConversation()` call is accounted for below.

| Category | Production locations | Verdict |
| --- | --- | --- |
| Store aggregate/write compatibility | `lib/chat-app-store.ts:866,888,1105,1140` | Preserve. Transaction and external-channel write results retain the established complete aggregate contract. |
| Store digest/memory/skill inspection | `lib/chat-app-store.ts:1860,1977,1987,2285` | Preserve. These paths inspect digest metadata across conversations or conversation-agent skill bindings; behavior remains unchanged in F001. |
| Runtime prompt and recovery | `server/domain/conversation/turn-orchestrator.ts:102,652,674,700,896,1102,1199,1246,1304`; `server/domain/conversation/turn/routing-executor.ts:140,254,567,668`; `server/domain/runtime/agent-tool-bridge.ts:820,1190,1483` | Preserve. Prompt assembly, queue snapshots, routing, recovery, and agent tools depend on complete persisted public history before their existing selection rules. |
| Digest and memory workflows | `server/app/create-server.ts:224,267,277`; `server/domain/conversation/conversation-digest.ts:1836,1846,2130,2231,2273`; `experience-draft.ts:266`; `retrieval-trace.ts:204,313`; `session-goal.ts:350,469,566`; `skill-draft.ts:1338,1473` | Preserve. These workflows read or return the established aggregate and were explicitly excluded from silent truncation. |
| Games | `server/domain/undercover/undercover-service.ts:34,62,112,330,331,407,545,599,615,656,657,673,674`; `server/domain/werewolf/werewolf-service.ts:35,63,113,530,531,1007,1022,1067,1153,1212,1228,1269,1270,1286,1287` | Preserve. Host progression, public state, summaries, and reset/recovery retain complete-history semantics. The browser consumes bounded pages after game actions. |
| Eval and skill-test flows | `server/api/eval-cases-controller.ts:567,818`; `server/domain/skill-test/design-service.ts:183`; `server/domain/skill-test/isolation-typed-helpers.ts:265` | Preserve. Isolated evaluation/design workflows keep their existing aggregate behavior. |
| Write-action API results | `server/api/conversations-controller.ts:453,528,555,648` | Preserve response semantics for digest, skill-draft, and goal writes. The browser projection deliberately ignores response `messages` and refreshes through the bounded page endpoint. |
| Full diagnostic list | `server/api/conversations-controller.ts:787` | Preserve. The context-snapshot list intentionally scans assistant messages; targeted message diagnostics no longer do so. |

`listMessages()` remains only at `lib/chat-app-store.ts:1260` for aggregate construction and at `server/domain/conversation/conversation-digest.ts:2144,2346` for explicit digest range selection. No UI or public read endpoint calls it directly.

## Projection And Targeted Reads

The following paths now use `getConversationWithoutMessages()` and therefore cannot trigger a public-message scan:

- `GET /api/conversations/:id` and `GET /api/conversations/:id/messages`.
- Feishu binding validation and conversation PUT validation.
- Targeted context snapshot, session export, and tool-trace endpoints.
- Message POST type/existence validation before runtime dispatch.
- Conversation-summary SSE broadcast.
- Store-level existence checks for conversation update and public/private message creation.

The browser loads the latest page separately, prepends older pages with a scroll-height anchor, merges live latest pages by message id, and ignores unbounded `messages` arrays on write-action responses.

## Automated Evidence

- Repository cursor behavior: latest, equal timestamps, complete traversal, deleted cursor row, appended rows, limits, empty conversation, and full aggregate compatibility.
- HTTP behavior: default/max/boundary limits, malformed and cross-conversation cursors, invalid cursor timestamp, empty/missing conversations, and projection without public messages.
- Browser state logic: stable merge/update, older cursor ownership, stale response guards, scroll-anchor restoration, loading/error/full control states, and prevention of send-response history rehydration.
- `npm run typecheck:public`: pass.
- `tests/runtime/message-history.test.js`: 5/5 pass.
- `tests/runtime/message-tool-trace.test.js`: 13/13 pass.

## Real Browser Evidence

The first review exposed a screenshot gap. A follow-up real Chromium run then found and reproduced an actual defect that the synthetic scroller test had hidden: responsive layouts allowed `#message-list` to expand with the page, so `document.scrollingElement` owned the scroll position while the implementation restored only `messageList.scrollTop`.

Before the fix at 375x812, clicking `加载更早消息` moved `browser-message-070` from approximately `469px` to `12741px` in the viewport, a `12,271px` jump.

After the Red→Green fix:

| Viewport | Initial page | Initial latest message | First prepend anchor drift | Second prepend anchor drift | Complete traversal |
| --- | --- | --- | ---: | ---: | --- |
| 1280x900 | 50 unique rows | `browser-message-119` bottom at `881px` in a 900px viewport | `-0.203px` | `+1.016px` | 120 rows, 120 unique, control hidden |
| 375x812 | 50 unique rows | `browser-message-119` bottom at `793px` in an 812px viewport | `-0.531px` | `+1.000px` | 120 rows, 120 unique, control hidden |

Screenshots:

- [Desktop initial latest page](F001-browser/desktop-1280-latest.png)
- [Desktop after older-page prepend](F001-browser/desktop-1280-prepend-after.png)
- [375px initial latest page](F001-browser/mobile-375-latest.png)
- [375px after older-page prepend](F001-browser/mobile-375-prepend-after.png)
- [375px complete 120-message traversal](F001-browser/mobile-375-complete.png)

The cards have no horizontal overflow or duplicate rendering at 375px. The fixed right-edge goal tab is existing application chrome and does not cover message text or the history control.

## Final Gate Results

```text
npm run typecheck  -> exit 0
npm run test:fast  -> exit 0
npm run test:smoke -> 60/60 pass
git diff --check   -> exit 0
```
