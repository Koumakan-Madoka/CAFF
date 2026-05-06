# Research: Conversation Digest MVP

## Relevant Specs
- `.trellis/spec/backend/architecture.md`: conversation metadata mutations should live in backend domain helpers, with thin controllers.
- `.trellis/spec/backend/controller-patterns.md`: route handlers should parse JSON, delegate state logic, return `sendJson`, and broadcast summary updates.
- `.trellis/spec/backend/session-goal.md`: `/goal` is the closest metadata-backed cross-layer feature and should be mirrored for `/digest` where practical.
- `.trellis/spec/runtime/agent-runtime.md`: prompt injection and chat bridge/tool contracts need mirrored updates when runtime-facing behavior changes.
- `.trellis/spec/frontend/ui-structure.md`: chat UI features should live in `public/chat/` modules and shared helpers in `public/shared/`.
- `.trellis/spec/guides/cross-layer-thinking-guide.md`: digest payload must round-trip from slash command → API/domain → metadata → summary/SSE → UI/prompt.
- `.trellis/spec/guides/code-reuse-thinking-guide.md`: reuse session-goal metadata route/panel/shared-helper patterns instead of creating divergent UI persistence.
- `.trellis/spec/unit-test/runtime-tests.md`: prompt assembly changes need runtime regression coverage.

## Code Patterns Found
- Metadata lifecycle domain helper: `server/domain/conversation/session-goal.ts` normalizes metadata, mutates via `store.updateConversation`, and formats prompt context.
- Thin route with SSE refresh: `server/api/conversations-controller.ts` handles `/api/conversations/:id/goal`, delegates to domain logic, broadcasts feature and summary events, then returns conversation/summary/conversations.
- Slash command interception: `public/app.js` parses `/goal` before optimistic message rendering and calls the same API path used by the panel.
- Right-side drawer module: `public/chat/session-goal-panel.js` manages stateful drawer rendering and calls shared `submitGoalCommand` helper.
- Browser helper module: `public/shared/session-goal.js` centralizes metadata extraction and label formatting.
- Prompt injection: `server/domain/conversation/turn/agent-prompt.ts` inserts `Session goal:` before local sandbox and before conversation history.
- Regression tests: `tests/smoke/server-smoke.test.js` covers goal API metadata lifecycle; `tests/runtime/turn-orchestrator.test.js` covers prompt injection.

## Proposed Data Flow
- Composer `/digest` → parse command → `POST /api/conversations/:id/digest`.
- Controller → `applyConversationDigestAction(store, conversationId, body)`.
- Domain helper → reads public messages from conversation, creates/deletes bounded digest metadata entry.
- Controller → broadcasts `conversation_digest_updated` or `conversation_digest_deleted` plus `conversation_summary_updated`.
- UI → summary/current conversation metadata refreshes, digest drawer renders timeline.
- Prompt → `formatConversationDigestsForPrompt(conversation)` injects retained entries as historical context before recent raw history.

## Files Likely to Modify
- `server/domain/conversation/conversation-digest.ts`: new domain helper for normalization, metadata mutation, deterministic MVP digest creation, deletion, and prompt formatting.
- `server/api/conversations-controller.ts`: add `/api/conversations/:id/digest` GET/POST route and broadcasts.
- `server/domain/conversation/turn/agent-prompt.ts`: inject Conversation Digest section.
- `public/shared/conversation-digest.js`: shared browser metadata helpers and labels.
- `public/chat/conversation-digest-panel.js`: right-side digest timeline panel and delete/create controls.
- `public/index.html`: load helper/module and add drawer DOM/button.
- `public/app.js`: add DOM bindings, `/digest` parsing/submission, SSE handlers, panel wiring.
- `public/styles.css`: drawer/timeline styling, reusing session-goal class patterns where practical.
- `tests/smoke/server-smoke.test.js`: digest API lifecycle coverage.
- `tests/runtime/turn-orchestrator.test.js`: prompt injection coverage.

## MVP Constraint Notes
- Use conversation metadata (`conversation.metadata.conversationDigests`) rather than a new table.
- Keep entries append-only with bounded retention (latest 5), and support explicit delete by id.
- Use manual trigger first; automatic summarization, search integration, and Trellis journal export remain later phases.
- Recent raw messages override digest content in prompt guidance.
