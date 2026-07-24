# UI Structure

## Current Shape

- `public/*.js`: page-level entry files and screen composition
- `public/chat/*.js`: chat room UI modules
- `public/shared/*.js`: shared browser helpers like API access, avatars, and
  toasts
- `public/styles.css`: shared styling

## Conventions

- Keep page entry files focused on composition, screen-level state, and
  cross-module wiring.
- For a larger page without a bundler, keep the main entry in `public/<page>.js`
  and move focused view/data helpers into `public/<page>/` instead of growing
  another monolith.
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

## Chat Model Observability UI

### 1. Scope / Trigger
- Trigger: rendering assistant message usage badges and expanded tool trace details in `public/chat/message-timeline.js`.

### 2. Signatures
- Message metadata may include `tokenUsage` and `modelUsage` from the backend.
- Tool trace payload may include `summary.modelCallCount`, `summary.toolExecutionCount`, `summary.postColdModelCallCount`, `summary.providerMissCount`, top-level canonical `modelUsageSummary`, `modelUsageCalls[]`, and `timelineEvents[]`.

### 3. Contracts
- Use `模型调用` for asks to the model and `工具执行` for tool steps; do not call both "rounds" or use one count as the other.
- Provider miss labels use `providerMissCount / postColdModelCallCount` so cold start is visible but excluded from the miss denominator.
- The expanded trace should use `timelineEvents[]` as the single rendering source when present, with first-class typed rows for `model_call` and `tool_execution`, while preserving existing tool execution previews and statuses. Frontend fallback derivation exists only for legacy payloads that lack backend-normalized summary/timeline fields.
- Historical messages without `modelUsage` keep aggregate token badges and must not throw.

### 4. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| `modelUsage` present | Badge starts with model-call count and trace shows per-call cold-start/cache-hit/provider-miss state. |
| Tool trace has tool steps and model calls | Summary shows `模型调用 M 次` and `工具执行 N 次`, and expansion renders one `本次回复观测时间线` rather than separate model/tool sections. |
| Only aggregate `tokenUsage` exists | Badge shows aggregate token/cost/cache details without model-call pills. |
| Missing usage | No usage badge; timeline layout remains unchanged. |

### 5. Good/Base/Bad Cases
- Good: `3 次模型调用 · 消耗 42.1k token · provider miss 1/2 次模型调用`.
- Base: aggregate-only historical messages display total token and cost information.
- Bad: `模型 3 轮` next to `2 步` when the denominator actually means tool executions.

### 6. Tests Required
- Runtime trace tests should assert separate model-call and tool-execution counts.
- `npm run check` must cover browser syntax for `public/chat/message-timeline.js`.

### 7. Wrong vs Correct
#### Wrong
`provider miss 1/2` where `2` is the number of tool steps.

#### Correct
`provider miss 1/2 次模型调用` where `2` is the number of non-cold model calls.

## Chat AppShell（`public/shell/app-shell.js`）

### 1. Scope / Trigger
- Trigger: changing the chat workbench frame — fixed viewport, sidebar, unified
  context drawer, drawer tabs, scroll anchoring, or any focus/inert behavior in
  `public/shell/app-shell.js`, `public/index.html`, or the `body.chat-app`
  sections of `public/styles.css`.
- Design truth: `designs/caff-ui-redesign-brief.md` (§8.3 contract table, §8.7
  v4 freeze, §8.8 v5 conditional-tab delta) + `designs/mock-app-shell-a.html`.

### 2. Signatures
- `window.caffShell` bus: `openTab(panelId)`, `releaseTab(panelId)`,
  `closeDrawer()`, `isDrawerOpen()`, `activeTab()`, `onChange(cb)`,
  `setTabVisible(panelId, visible, {count})`, `scrollToBottom()`.
- Drawer tabs: 6 always-visible (participants/goal/memory/summary/settings/
  context) + 2 conditional (game/drafts) driven by feature visibility.
- Panel modules sync open-state via `caffShell.onChange`; shell-driven changes
  arrive with `{ fromShell: true }` semantics.

### 3. Contracts
- Scroll skeleton: `body.chat-app` overflow hidden, `.app-shell` = 100dvh,
  message-list is the only long scroll region; header/composer never scroll out.
- Focus ownership: the shell owns tab/drawer focus (APG roving tabindex).
  Panel modules must never write focus when opened `fromShell`; they may only
  focus their own inputs on direct user action.
- Conditional tab disappearance: snapshot focus BEFORE writing `hidden` (the
  browser drops focus to BODY the moment the attribute lands); fallback to the
  first visible tab in BOTH drawer-open and drawer-closed states; migrate focus
  to the fallback tab only when the drawer is open and focus was inside the
  hidden tab/panel.
- Closed-state exit: closed drawer/sidebar write `inert` + `aria-hidden`
  together; narrow-sidebar open is modal with inert background.
- Panel controller startup must depend only on its own panel DOM, never on
  legacy chrome (old header buttons/floating balls) removed by the AppShell.
- Conversation list renders `ul > li > button.conversation-item`; do not
  reintroduce non-focusable div items.
- Touch targets: ALL interactive elements ≥44px (full sweep, not sampling):
  rail, header buttons, tabs, tool-trace toggle, timeline retry, settings
  checkbox labels, send/stop, new-message pill.
- ≤480px header: `.runtime-pill`/`#conversation-meta` must be shrinkable
  (`min-width:0` + ellipsis) and `#conversation-meta` is hidden; status text
  overlapping header buttons by >1px is a regression.

### 4. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| Goal tab opened from shell | Form/events bound, no focus steal into objective |
| Active conditional tab hidden while drawer open | Focus lands on fallback tab, panel hidden |
| Current conditional tab hidden while drawer closed | Reopen shows exactly one visible selected tab, no hidden active panel |
| 375/320px header with long runtime text | No rect intersection with refresh/drawer buttons |
| Keyboard-only session switch | Tab reaches `button.conversation-item`, Enter loads room |

### 5. Tests Required
- `tests/ui/app-shell.test.js` (jsdom, part of `test:fast`) locks controller
  startup, focus ownership, list semantics, and both conditional-tab states.
- `scripts/verify-ui.mjs` (`npm run test:ui`, Playwright/Edge against a running
  dev server) locks layout-level contracts: full 44px sweep, 375/320 header
  overlap, real-browser focus migration, keyboard room switching.
- `npm run check` includes `public/shell/app-shell.js`.

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
- Blocking post-reply work should surface in both the composer status area and
  the chat timeline rather than silently delaying routing. Pending-experience
  digest absorption and model-mode digest generation use `conversation_digest_status`
  to show that the assistant is organizing experience or generating a summary
  after the completed message is visible, including bounded model thinking/output
  previews when the provider exposes them.
- Trellis-related UI affordances usually depend on backend prompt/runtime state,
  so verify both sides when changing labels, status handling, or tool exposure.
