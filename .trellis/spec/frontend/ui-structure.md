# UI Structure

## Conversation Tree Row Layout

### Scope / Trigger

- Applies to the compact sidebar tree in `public/styles.css` and rows rendered by `public/chat/conversation-list.js`.

### Contract

- Every normal row is a flat three-track surface: a 44px tree-guide target, one flexible two-line conversation item, and one 44px overflow trigger. Parent and leaf rows at the same depth therefore share the same title baseline and full-row hover/active boundary.
- Depth uses compact 14px indentation outside the guide track. Parent rows render an accessible disclosure button with `aria-expanded`; leaf rows render an `aria-hidden` endpoint. Nested rows may use low-contrast decorative continuation/branch lines, but those lines never become controls.
- `button.conversation-item` remains the primary navigation target. It paints no independent card background; hover, focus-within, and active backgrounds belong to the containing row, with an additional non-color active marker.
- The title line and title use `min-width: 0`; the title owns the remaining flex width and applies ellipsis. Metadata remains a second line, and participant text is independently shrinkable with ellipsis. Type/agent metadata is flat text rather than a nested card/pill treatment.
- One overflow trigger replaces separate rename/spawn hover buttons. The trigger has `aria-haspopup="menu"` and synchronized `aria-expanded`; only one row menu can be open. Menu actions are 44px high, Escape restores trigger focus, outside click closes the menu, and touch layouts keep the trigger visible.
- Rename is always offered. Spawn is omitted at the depth limit; otherwise it preserves the existing disabled state and explanatory title when project binding does not permit spawning. Starting rename or spawn closes the menu, and inline rename retains prefilled focus/select plus save/cancel behavior.
- Focus leaving the combined overflow trigger/menu region closes the menu without stealing focus; Escape restores trigger focus and outside pointer clicks close the menu.
- Compact tree guides use the same 14px depth step as row indentation: nested continuation lines pass through the guide slot center and branch ticks extend from that line toward the row marker. Guides are decorative and must not intercept input.
- Rows use `isolation: isolate` to keep decorative guide lines behind row content, which also confines each row's stacking. A row whose overflow menu is open must therefore be lifted (`z-index: 1` via `:has(.conversation-actions-menu:not([hidden]))`) so following rows never cover or intercept the open menu.
- Compact failure/live pills and busy metadata keep their existing delivery/runtime semantics; the redesign must not derive or rewrite status.

### Validation Matrix

| Case | Expected behavior |
| --- | --- |
| root parent and root leaf | aligned full-row surfaces and title baselines; disclosure caret vs decorative endpoint |
| nested parent/leaf | compact depth indentation plus faint guides without a dead 44px spacer |
| collapsed parent | `aria-expanded=false`, descendants hidden, row geometry unchanged |
| root or nested row with long title | title and participant metadata ellipsize while status and menu remain reachable |
| hover/focus/active | row owns the background; active state also has a visible leading marker |
| overflow menu | one menu open; correct ARIA; 44px actions; Escape/focus-leave/outside click close safely; open row stacks above siblings |
| spawn unavailable | disabled menu item retains the project-binding explanation |
| depth-limit row | rename remains; spawn is absent; root-conversation guidance remains visible |
| inline rename | menu disappears; prefilled form and save/cancel flow remain keyboard operable |
| touch layout | overflow trigger remains visible and all controls retain 44px targets |

### Required Tests

- `tests/ui/chat-experience-m4.test.js` locks the shared three-track row, full-row states, compact depth, accessible guide/trigger targets, overlay menu, open-row stacking lift, ellipsis, and flat metadata contracts.
- `tests/ui/cross-conversation-ui.test.js` locks semantic `ul > li`, parent disclosure buttons, leaf endpoints, menu contents, depth-limit behavior, collapse, and unchanged status semantics.
- `tests/ui/conversation-list-rename.test.js` locks ARIA/menu contents, disabled spawn, one-open-menu state, and rename transitions.
- Browser geometry checks should cover 280px width, root/nested parent and leaf alignment, long text, light/dark row states, menu containment, open-menu click-through on rows with following siblings, and touch/keyboard focus behavior. Focus-leave behavior should be covered by the jsdom renderer suite.


## Goal Model-Failure Auto-Pause UI

### Scope / Trigger

- Applies when `conversation.metadata.sessionGoal.status === 'paused'` and normalized `sessionGoalRunner.status === 'error_paused'`.

### Contract

- `public/shared/session-goal.js` preserves the runner payload and normalizes `iteration`, `maxIterations`, and `consecutiveModelFailureCount` as non-negative numbers.
- The Goal drawer badge says `模型失败自动暂停` instead of presenting this state as an unexplained manual pause.
- Details show the automatic continuation position, `模型调用失败自动暂停`, consecutive count, bounded pause reason, and redacted last failure summary.
- Existing Resume remains enabled for ordinary conversations and uses the normal Goal API; server-side Resume clears runner/streak metadata before scheduling another continuation.
- DAG-bound goal controls keep the existing D27/D28 lock. The scheduler moves an error-paused doing node to blocked; UI must not synthesize a completion or verifier result.
- Rendering uses only persisted normalized metadata delivered through the existing `conversation_goal_updated` refresh path; it never parses provider error text in the browser.

### Validation Matrix

| State | Expected UI |
| --- | --- |
| manual paused Goal without `error_paused` runner | existing `已暂停` label; no model-failure details |
| matching `error_paused` runner | auto-pause badge, count, safe reason, safe last error, Resume available when not DAG-locked |
| legacy/missing runner fields | numeric fields normalize to zero; no throw |
| Resume succeeds | refreshed conversation no longer shows streak/auto-pause details |

### Good/Base/Bad Cases

- Good: a provider billing failure pauses after three attempts and the user can see the safe reason before fixing the provider and resuming.
- Base: historical manually paused Goals render unchanged.
- Bad: browser regex-matches `errorMessage`, exposes raw provider payloads, or shows an actionable Resume control that bypasses the existing DAG lock.

### Required Tests

- `tests/ui/app-shell.test.js` renders a real `error_paused` metadata fixture and asserts badge, reason, summary, and Resume/Pause enabled state.
- `npm run check` and `npm run typecheck:public` cover the shared helper and panel syntax/types.

### Wrong vs Correct

#### Wrong
```js
if (/balance|429/u.test(lastError)) status.textContent = 'Provider failed';
```

#### Correct
```js
if (runner && runner.status === 'error_paused') {
  appendDetail(details, '暂停原因', runner.pauseReason);
}
```

## Pending Goal Proposal Checklist

### Scope / Trigger

- Applies to `public/chat/session-goal-panel.js` when `metadata.sessionGoalProposal.action === 'set'`.

### Contract

- The proposal card shows the proposed objective and normalized checklist as read-only approval content.
- The normal goal form remains an active-goal/new-goal editor; a pending proposal must not silently populate that editable form or look already active.
- Checklist markers render as `[ ]`, `[~]`, and `[x]`, matching the agent bridge and stored proposal contract.

### Required Tests

- `tests/ui/app-shell.test.js` verifies pending objective/checklist visibility and that the no-active-goal form still shows its normal default state.

## Goal Owner Select

### Scope / Trigger

- Applies to `public/chat/session-goal-panel.js` 主理人 select in the goal drawer, backed by shared helpers in `public/shared/session-goal.js`.

### Contract

- The select defaults to `未设置` (no owner) and lists current conversation roster agents as options; changing it submits `POST /goal { action: 'set-owner', ownerAgentId }`.
- When the stored owner is no longer on the roster, keep a `XX（已不在会话）` option selected instead of silently resetting the display; removal is handled server-side (fail-closed pause + proposal).
- Rebuild options only when conversation/roster/owner actually changes; do not clobber an in-progress user selection on unrelated refreshes.
- Under the DAG execution lock (`dagNodeGoalBinding`, active/paused node doing), the select is disabled together with lifecycle buttons and reports that the owner is scheduler-managed.
- A failed `set-owner` submit (network error, 4xx/5xx, concurrent roster change) must not leave the unpersisted value on screen: the panel invalidates its owner-select cache on error and re-renders the select from the persisted goal owner after showing the failure toast.

### Required Tests

- `tests/ui/session-goal-owner.test.js` verifies rendering, `set-owner` submission, removed-owner display, DAG-lock disabling, and revert-to-persisted-owner on a failed submit.


## Collapsed Tool-Trace Failure Summary

### Scope / Trigger

- Applies to `public/app.js` trace-state normalization and `public/chat/message-timeline.js` collapsed failure notes.

### Contract

- Backend `failureContext.summary` is the collapsed headline; `failureContext.text` remains the full redacted context used by the copy/details action.
- The collapsed note must prefer the summary and label it by source (`失败步骤`, `任务失败`, `会话失败`, or `消息失败`). It must not use the full metadata block as the first-line text.
- Legacy/live trace payloads without `summary` continue to render through the existing failed-step or generic status fallback.

### Validation Matrix

| Case | Expected behavior |
| --- | --- |
| summary contains provider/task/step error | collapsed note shows the concise summary only |
| summary absent but failed step exists | existing failed-step fallback remains visible |
| summary absent and task/message failed | localized generic task/message failure fallback |
| full `text` contains IDs/status metadata | IDs remain available for copy/details, never become the collapsed headline |

### Required Tests

- `tests/ui/cross-conversation-ui.test.js` asserts summary-first rendering and metadata exclusion from the collapsed note.
- `npm run check` covers the browser modules; targeted jsdom timeline tests cover legacy fallback behavior.


## Current Shape

- `public/*.js`: page-level entry files and screen composition
- `public/chat/*.js`: chat room UI modules
- `public/shared/*.js`: shared browser helpers like API access, avatars,
  themes, repository-owned icons, and toasts
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

## Unsummarized Message Deletion UI

- `public/chat/message-timeline.js` renders deletion controls only for public `user` and `assistant` cards. Server-projected `message.deletionEligibility` owns summarized/cross-conversation/role/status policy; runtime and digest state only add a transient busy disable.
- Each eligible card has a native checkbox and repository-owned `trash` icon button. Both controls retain a 44px target, remain visible under `@media (hover: none)`, and expose labels/titles for keyboard and assistive technology.
- The batch toolbar is a sibling overlay under `.message-viewport`, outside `#message-list` renderer ownership. It shows selected count plus icon-only delete/cancel commands; it is not inserted as a fake timeline message.
- Single and batch deletion use one confirmation contract: exact count, permanent/no-undo language, attachment removal, and no rollback of files, commits, Goal/DAG, or external effects.
- A failed atomic request preserves every checkbox and displays the server reason. Success clears the deleted selection, filters the local timeline immediately, and schedules the standard SSE/page refresh.
- Conversation switches and messages disappearing after refresh clear stale selected IDs. Summarized or busy messages retain disabled controls with a discoverable reason rather than accepting a request that is known to fail.
- `tests/ui/message-deletion.test.js` covers single delete, multi-select/cancel, rejection retention, disabled reasons, toolbar ownership, 44px targets, and touch visibility. The complete server/API contract is in `../backend/conversation-message-deletion.md`.

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
- P2C-Contract message metadata may contain only a lightweight
  `agentContextSnapshot` reference and aggregate-only `modelUsage`. The context
  button depends on reference presence/`snapshotId`, not snapshot sections; the
  token badge depends on the four aggregate counters, not `modelUsage.calls`.
- Message pages and `conversation_message_created` / `_updated` SSE frames must
  never deliver `displayContent` or model-call arrays to the browser. Inspector
  and Markdown content continue to load from dedicated detail endpoints.

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
  `setTabVisible(panelId, visible, {count})`, `scrollToBottom()`,
  `syncComposerHeight()`, `setComposerValue(value)`.
- Drawer tabs: 6 always-visible (participants/goal/memory/summary/settings/
  context) + 2 conditional (game/drafts) driven by feature visibility.
- Panel modules sync open-state via `caffShell.onChange`; shell-driven changes
  arrive with `{ fromShell: true }` semantics.

### 3. Contracts
- Scroll skeleton: `body.chat-app` overflow hidden, `.app-shell` = 100dvh,
  message-list is the only long scroll region; header/composer never scroll out.
- Message rows keep intrinsic height (`grid-auto-rows: max-content`); a fixed
  viewport must create overflow, never compress card tracks and clip bodies.
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
- Renderer ownership: `#message-list` contains renderer-owned message/empty-state
  nodes only. The shell-owned new-message pill is a sibling overlay in
  `.message-viewport`; never append shell chrome inside `#message-list`.
- New-message semantics come from direct-child `.message-card[data-message-id]`
  set differences. Do not use `subtree:true` DOM mutation as a proxy for a new
  message: tool-trace expansion and streaming card internals are not messages.
- A visible new-message pill means the reader is explicitly unpinned. Renderer
  replacement/layout scroll events must not clear it; clear only when the reader
  moves down to the bottom or activates the pill.
- Programmatic composer clear/restore/insertion must call
  `caffShell.setComposerValue(value)`. Direct `.value =` writes in `app.js` or
  mention-menu bypass height synchronization and are forbidden.
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
| Renderer replaces all message cards while pill is visible | Pill remains visible outside `#message-list`; a later unseen message id can show it again |
| Long conversation exceeds the viewport | Message bodies stay inside their cards while the list gains scroll overflow |
| Tool trace expands inside an existing card | No new-message pill is created |
| Composer succeeds after a tall command | Value clears and height returns to the one-row baseline |
| Failed send restores a tall message | Original value and tall height are both restored |
| `npm run test:ui` in a development checkout | Builds assets, starts a unique localhost port with temporary SQLite and `.env.local` disabled, then deletes all run-owned conversations |
| `CAFF_VERIFY_APP` override | Rejects non-loopback targets before creating or deleting conversations |
| Browser evidence bundle | At most 3 screenshots plus one approximately 15-second walkthrough video, all under the temporary run directory |

### 5. Tests Required
- `tests/ui/app-shell.test.js` (jsdom, part of `test:fast`) locks controller
  startup, focus ownership, list semantics, both conditional-tab states,
  renderer replacement, trace-only mutations, composer synchronization, v5
  mock IA, and the self-contained runner contract.
- `scripts/verify-ui.mjs` (`npm run test:ui`, repo-owned Playwright/Edge) starts
  its own dynamic-port app with `CAFF_DISABLE_ENV_LOCAL=1`, a temporary
  `PI_SQLITE_PATH`, and a unique run id. It locks layout/focus behavior, full
  44px sweep, 375/320 header overlap, keyboard room switching, composer
  clear/restore, renderer replacement, DELETE success, and zero run residue.
  Explicit targets are loopback-only; emergency cleanup reports failures rather
  than swallowing them. The same run writes no more than three screenshots and
  one walkthrough video to its temporary evidence directory.
- `npm run check` includes `public/shell/app-shell.js`.

### 6. Good / Base / Bad Cases

- Good: renderer replaces the complete card list while the reader is off-bottom;
  the sibling pill stays visible and tool-trace expansion does nothing to it.
- Base: new direct-child message id arrives while pinned; the list follows the
  bottom without showing a pill.
- Bad: shell chrome is inserted into `#message-list`, or any subtree addition is
  interpreted as a message.

### 7. Wrong vs Correct

#### Wrong

```js
messageList.appendChild(pill);
observer.observe(messageList, { childList: true, subtree: true });
composerInput.value = restoredText;
```

#### Correct

```js
messageViewport.appendChild(pill); // sibling of renderer-owned list
observer.observe(messageList, { childList: true });
window.caffShell.setComposerValue(restoredText);
```

## Management AppShell

### 1. Scope / Trigger

- Trigger: changing the outer frame, navigation, list selection semantics,
  responsive layout, or scroll ownership of `personas.html`, `skills.html`,
  `projects.html`, or `metrics.html`.
- Applies to those four HTML/page-entry pairs, the `body.management-app`
  section of `public/styles.css`, and `public/shared/management-list.js`.
- Existing CRUD/filter APIs and form ids are compatibility boundaries. This
  shell migration does not authorize backend contract changes.

### 2. Signatures

- Page root: `body.management-app[data-page]` containing `.management-shell`,
  `nav.rail`, `.management-main`, `.management-header`, and
  `main.management-content`.
- Content panes: `.management-index.management-pane` and
  `.management-detail.management-pane`.
- Shared stateless DOM helpers:
  - `CaffShared.createManagementListItem({ id, active?, compact? })`
  - `CaffShared.createManagementListEmptyState(message)`
- Navigation routes, in order: `/`, `/personas.html`, `/skills.html`,
  `/projects.html`, `/metrics.html`.

### 3. Contracts

- `body.management-app` owns a fixed `100dvh` viewport and never lets the
  document become a content scroll container.
- At widths >=768px, index and detail panes are bounded sibling scroll owners.
  At widths <768px, the rail moves to a 56px bottom bar and
  `.management-content` becomes the single internal scroll owner while both
  panes use `overflow:visible`.
- Exactly one rail destination has `aria-current="page"`, matching the current
  route. Do not restore per-page topbar navigation.
- Personas, skills, modes, projects, and metric agents render as
  `ul > li > button.agent-list-item`. Keep native button keyboard behavior and
  the existing delegated click paths; do not add keydown simulation.
- Page entries fail fast if either management list helper is unavailable. The
  helper owns no collection state, selection state, API calls, or persistence.
- Preserve all existing page ids, forms, CRUD/filter requests, and Skill/mode
  switching behavior during shell edits.
- All visible interactive targets are at least 44px high. Checkbox/radio inputs
  may keep their visual control size only when their clickable label is >=44px.
- `body.chat-app` and `body.management-app` share CAFF tokens and rail visual
  primitives, but their scroll owners are deliberately different: chat uses
  the message list; management uses bounded panes or the mobile content region.

### 4. Validation & Error Matrix

| Case | Expected behavior |
| --- | --- |
| Desktop 1440 | Left rail, fixed header, side-by-side index/detail panes, no document overflow. |
| Tablet 820 | Left rail and two bounded panes remain usable; no horizontal overflow. |
| Mobile 375 | Bottom rail is 56px; panes stack; content is the only internal scroll region; header text does not overlap refresh. |
| Metrics filters at 1440/820/375 | Since and Until are single-column, fully contained by the narrow filter form, and never overlap; both native date-picker buttons remain reachable. |
| Native list keyboard selection | Focusing a collection button and pressing Enter updates active selection and detail content. |
| Empty projects payload | A semantic `li` empty state appears and unavailable selected-project actions are disabled. |
| Missing shared helper | Page entry throws an explicit missing-module error instead of rendering a partial screen. |
| Browser/runtime failure | UI verification reports console, page, and non-favicon HTTP errors as failed checks. |

### 5. Tests Required

- `tests/ui/management-shell.test.js` is part of `test:fast` and locks the four
  shell landmarks, legacy chrome removal, route/current-page mapping, critical
  ids, semantic lists, helper behavior, scoped CSS, and runner integration.
- `scripts/ui/verify-management-pages.mjs` is called by
  `scripts/verify-ui.mjs`. It reuses the runner-owned browser, loopback app,
  temporary SQLite, and output directory; it must not start a second service.
- Browser proof covers all four routes at 1440 plus responsive 820/375,
  keyboard selection, an intercepted empty projects payload, metrics date-input
  containment/non-overlap at 1440/820/375, visible 44px targets, document
  containment, and clean page/console/HTTP diagnostics.
- The combined UI evidence stays bounded to three PNG files and one walkthrough
  WebM. One PNG is `ui-v2-1440-management.png`.
- `npm run check` includes `public/shared/management-list.js` and all four page
  entries.

### 6. Good / Base / Bad Cases

- Good: the user scrolls a long persona editor while the rail and management
  header stay reachable and the index pane retains its own position.
- Base: an empty collection renders an inert semantic empty row without
  changing existing API or form behavior.
- Bad: a management page restores `.topbar`, uses a clickable div for a list
  item, or makes `body` the mobile content scroll owner.

### 7. Wrong vs Correct

#### Wrong

```html
<body>
  <div class="topbar">...</div>
  <div class="agent-list"><div class="agent-list-item">...</div></div>
</body>
```

#### Correct

```html
<body class="management-app" data-page="personas">
  <nav class="rail" aria-label="主导航">...</nav>
  <main class="management-content">
    <aside class="management-index management-pane">
      <ul class="agent-list"><li><button type="button">...</button></li></ul>
    </aside>
    <section class="management-detail management-pane">...</section>
  </main>
</body>
```

## Theme and Repository-Owned Icon System

### 1. Scope / Trigger

- Trigger: changing application colors, surface hierarchy, radii, shadows,
  theme persistence, the rail/header/drawer icon language, or how `.svg` files
  are served.
- Applies to all five routes (`index.html`, `personas.html`, `skills.html`,
  `projects.html`, `metrics.html`), `public/shared/theme.js`,
  `public/shared/icons.js`, `public/assets/icons.svg`, the Milestone 3 section
  of `public/styles.css`, and `server/http/static-file.ts`.
- The theme layer may change presentation only. It must preserve AppShell focus,
  inert, scroll-owner, CRUD/filter, element-id, and API contracts.

### 2. Signatures

- Persistent key: `caff:theme` with the only valid stored values `light` and
  `dark`.
- `window.CaffTheme`:
  - `getTheme(): 'light' | 'dark'`
  - `hasExplicitPreference(): boolean`
  - `setTheme(theme: 'light' | 'dark'): 'light' | 'dark'`
  - `toggle(): 'light' | 'dark'`
  - `syncControls(): void`
- `window.CaffIcons.create(name, { className? }): SVGSVGElement` is a stateless
  DOM factory. It creates `<svg><use href="/assets/icons.svg#icon-NAME">` and
  throws for unknown names.
- Every page contains exactly one `button[data-theme-toggle]` and loads the
  synchronous `/shared/theme.js` before `/styles.css`.

### 3. Contracts

- `public/shared/theme.js` is the only ThemePreference lifecycle owner. Page
  entries and renderers must not read/write `caff:theme` or
  `document.documentElement.dataset.theme` directly.
- A valid stored preference wins over `prefers-color-scheme`. Without a valid
  stored value, system color scheme is a live, non-persisted projection.
- Apply `html[data-theme]` and `color-scheme` synchronously before stylesheet
  parsing. Local-storage read/write failures must degrade to in-memory state
  without blocking page boot or clicks.
- `storage` events with `light|dark` synchronize an explicit preference across
  tabs. Removing the key returns to live system projection; invalid values are
  ignored.
- Theme toggle `aria-label`, `title`, `aria-pressed`, and sun/moon `<use>` must
  describe the current state and the next action. Its visible hit area is at
  least 44px on every route and breakpoint.
- `public/assets/icons.svg` is the only product icon path registry. Static HTML
  uses `<use>` directly; dynamic renderers use `CaffIcons.create`. Do not copy
  path data into page modules or introduce an icon runtime dependency.
- Application chrome uses repository-owned `currentColor`, `fill:none`,
  approximately 1.75px-stroke SVGs. User messages, persona avatars, and game
  content may still contain semantic emoji; the ban applies to product chrome.
- The static server must return `.svg` as `image/svg+xml`. Returning
  `application/octet-stream` leaves external `<use>` nodes present but visually
  blank in Edge.
- Light and dark share identical layout density. Application chrome uses flat
  canvas/surface/sunk layers, no decorative gradient or backdrop blur, 6/8/10/
  12px geometry, and restrained shadows. `999px` is semantic-only (avatar,
  status badge, progress track), not a default button/card radius.
- Normal body/input/primary-button text contrast is at least 4.5:1 in both
  themes. Focus and semantic status colors must remain visible without relying
  on color alone.

### 4. Validation & Error Matrix

| Case | Expected behavior |
| --- | --- |
| First visit, system dark | First painted document is dark; no `caff:theme` value is written. |
| Stored `light` while system dark | Light wins on every route and ignores later system changes. |
| Stored `sepia` or corrupted text | Ignore it and project the current system theme; never write the invalid value into `data-theme`. |
| localStorage throws `SecurityError` | Page boots, current-tab toggle still works, persistence is best-effort only. |
| Toggle on chat then navigate to personas | New route applies the explicit theme before CSS and exposes the matching label/icon. |
| Cross-tab valid storage event | Current document and all toggle controls synchronize atomically. |
| Cross-tab key removal | Explicit state clears and future system-theme changes are observed again. |
| `/assets/icons.svg` has wrong MIME or fails | Browser gate reports a bad response/MIME and visible line-icon contract fails. |
| 1440/820/375 in either theme | No horizontal document overflow; existing fixed-shell and scroll-owner contracts remain intact. |
| New dynamic product icon | Must be added to the sprite allowlist and rendered through `CaffIcons.create`; unknown names fail fast. |

### 5. Good / Base / Bad Cases

- Good: the user chooses Dark in chat, opens Skills, and receives the same
  theme before first paint; rail and action icons remain crisp via
  `currentColor`, while cards use borders rather than glow/blur.
- Base: no preference exists, so each tab follows the OS and updates when the
  OS changes.
- Bad: a page waits for `DOMContentLoaded` before adding Dark, stores `system`,
  embeds an emoji gear in a header, duplicates an SVG path in a renderer, or
  adds a black overlay on top of hard-coded white-alpha cards.

### 6. Tests Required

- `tests/ui/theme-icons.test.js` is part of `test:fast` and locks script-before-
  CSS ordering, the ThemePreference state machine, storage failure, cross-tab
  events, sprite completeness, helper fail-fast behavior, SVG MIME, chrome
  emoji removal, semantic theme tokens, and verifier wiring.
- `scripts/ui/verify-theme-icons.mjs` is called by `scripts/verify-ui.mjs` and
  reuses its Edge instance, loopback-only app, temporary SQLite, diagnostics,
  and zero-residue cleanup. It must not start a second service.
- Browser proof loads all five routes in Light and Dark, checks the toggle and
  sprite response, reads computed gradients/blur/radii and 4.5:1 contrast, and
  reruns chat/personas at 820 and 375. The combined runner currently has 93
  checks and all must pass.
- `npm run check` covers both shared helpers; `npm run typecheck:public` covers
  their public types. A visual review must include at least Light chat, Dark
  chat, and Dark management screenshots.

### 7. Wrong vs Correct

#### Wrong

```html
<link rel="stylesheet" href="/styles.css" />
<button class="rail-button">⚙️</button>
```

```js
document.documentElement.dataset.theme = localStorage.getItem('theme');
title.textContent = '📦 Rollup';
```

#### Correct

```html
<script src="/shared/theme.js"></script>
<link rel="stylesheet" href="/styles.css" />
<button class="rail-button" data-theme-toggle aria-pressed="false">
  <svg class="app-icon" aria-hidden="true">
    <use href="/assets/icons.svg#icon-moon"></use>
  </svg>
</button>
```

```js
const icon = window.CaffIcons.create('archive', {
  className: 'app-icon digest-kind-icon',
});
```

## SSE Stream Recovery After Errored Reopen

### Scope / Trigger

- Applies when `public/app.js` stream open/error handlers or `public/chat/stream-recovery.js` change. Contract source: reviewed OOM remediation plan a9f9eec (P1B browser recovery).

### Contract

- Only an **errored** stream that successfully **reopens** triggers recovery: `markStreamError()` is called in the error handler before scheduling the existing manual reconnect (close + fixed 1.5s delay — unchanged; no reliance on EventSource native retry or a server `retry:` field).
- On open, `shouldRecoverOnOpen()` returns true exactly once per errored episode; the open handler then captures `preferredConversationId = state.selectedConversationId` and runs one `refreshAll(conversationId)` (bootstrap/list/runtime/current conversation over HTTP) via `runRecoveryRefresh`. The refresh failure path swallows errors; `finishRecovery()` runs in `finally` so a failed refresh re-arms future episodes without blocking them.
- Initial/healthy opens never refresh — startup already calls `refreshAll()` once; recovery must not duplicate bootstrap.
- Repeated opens while a recovery refresh is in flight never start a parallel `refreshAll`; the coalesced episode is surfaced by `finishRecovery()` returning `true` and runs as **exactly one serialized trailing refresh** after the in-flight one settles (a trailing refresh re-reads `state.selectedConversationId` at its start instead of reusing the stale captured id). Dropping the trailing episode would leave a quiet conversation stuck on stale state — there is no replay and no periodic authoritative broadcast, so state that changed after the first refresh read it would stay invisible until the next SSE event.
- No `Last-Event-ID` / `lastEventId` consumption on either client or server; no event replay; no at-least-once delivery claim. Missed events are recovered via the HTTP authoritative refresh plus subsequent live events (e.g. a turn finishing during disconnect becomes visible through the refresh).
- The stale-source guard (`state.eventSource !== source`) still applies in the open handler.

### Validation Matrix

| Case | Expected behavior |
| --- | --- |
| initial open | no refresh; no duplicate bootstrap |
| errored stream reopens | exactly one coalesced `refreshAll(selectedConversationId)` |
| recovery in flight, another errored episode reopens | no parallel refresh; `finishRecovery()` returns true and exactly one trailing refresh runs serialized after the in-flight one |
| first refresh rejects while a trailing episode is pending | trailing refresh still runs (the latch releases in `finally` regardless of refresh outcome) |
| recovery refresh rejects (no pending episode) | error swallowed; latch released; future episodes still recover |
| error during recovery window, then reopen | coalesced into the trailing refresh; no extra parallel refresh |
| any code path | no `lastEventId`/`Last-Event-ID` read (client or server) |

### Required Tests

- `tests/ui/stream-recovery.test.js`: jsdom behavior tests + source-contract greps (app.js error handler calls `markStreamError` before reconnect scheduling; no lastEventId consumption anywhere).
- `tests/smoke/server-smoke.test.js` and chat-experience suites keep the existing open/error contracts green (no regression in connection-status handling).

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
