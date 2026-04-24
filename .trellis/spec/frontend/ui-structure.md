# UI Structure

## Current Shape

- `public/*.js`: page-level entry files and screen composition
- `public/chat/*.js`: chat room UI modules
- `public/skill-tests/*.js`: Skill Tests-only helper modules loaded by
  `public/eval-cases.html`
- `public/shared/*.js`: shared browser helpers like API access, avatars, and
  toasts
- `public/styles.css`: shared styling

## Conventions

- Keep page entry files focused on composition, screen-level state, and
  cross-module wiring.
- For a larger page without a bundler, keep the main entry in `public/<page>.js`
  and move focused view/data helpers into `public/<page>/` instead of growing
  another monolith.
- Skill Tests follows the plain-script registration pattern: each helper file is
  an IIFE that registers a `create*Helpers()` factory on `window.CaffSkillTests`,
  `public/eval-cases.html` loads those helpers before `public/skill-tests.js`,
  and `public/skill-tests.js` passes explicit dependencies into the factories.
- Put reusable browser helpers in `public/shared/` instead of copying fetch or
  DOM utility logic across pages.
- When a chat feature grows beyond one screen concern, split it into
  `public/chat/` modules rather than expanding a single monolith.
- Preserve the existing plain JavaScript style; this repo is not using a
  framework build step for the browser code.
- Fail fast when a required page helper is missing. Prefer explicit
  missing-module errors in the page entry over silently skipping part of the UI.

## Chat Message Rendering

- Route assistant rich text rendering through shared helpers in `public/shared/`
  instead of injecting raw HTML from `public/chat/` modules.
- `public/shared/safe-markdown.js` is the shared Markdown entry point for agent
  message bodies. Keep raw HTML disabled, sanitize link protocols, and fall back
  to plain text if rendering throws.
- Keep natural-language content and tool diagnostics visually separated:
  `public/app.js` owns conversation-level trace state and SSE syncing for both
  main turns and side-slot events, while `public/chat/message-timeline.js`
  owns expandable per-message trace UI.
- Streaming trace rerenders must preserve reader context. Use stable step ids
  and restore scroll/anchor state for expanded tool timelines instead of
  snapping the viewport back to the top.

## Cross-Layer Watch Points

- UI payload expectations must stay aligned with controller and domain output.
- Chat composer lock state must come from runtime turn state, not only from the
  transient `POST /messages` request lifecycle. Continuous-send keeps normal
  conversation input/send enabled while `activeTurns`,
  `dispatchingConversationIds`, `conversationQueueDepths`,
  `conversationQueueFailures`, `activeAgentSlots`, and
  `agentSlotQueueDepths` describe the real background state.
- Stop, delete, and live-stage affordances must account for side-slot SSE state
  in addition to main-turn state. `public/app.js` is responsible for merging
  `turn_progress`, `agent_slot_progress`, and `agent_slot_finished` into one
  runtime view before `public/chat/conversation-pane.js` or
  `public/chat/message-timeline.js` render UI.
- Recovery affordances for failed queued batches belong in the same runtime-fed
  status area: if a queued main-lane batch is idle because dispatch previously
  failed, show that failure state in composer status and require an explicit
  confirmation before force-deleting the conversation and dropping the pending
  queued messages. Queued side-slot work is not part of that force-delete path.
- Trellis-related UI affordances usually depend on backend prompt/runtime state,
  so verify both sides when changing labels, status handling, or tool exposure.
