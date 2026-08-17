# Plan Panel (DAG 规划图前端)

## Scenario: Conversation Plan Panel

### 1. Scope / Trigger
- Trigger: implementing or modifying the DAG plan UI.
- Applies when changes touch `public/chat/plan-panel.js`, the plan tab in `public/index.html`, plan styles in `public/styles.css`, or plan wiring in `public/app.js` (`renderPlanPanel`, SSE handler, controller construction).
- PRD of record: `.trellis/tasks/dag-planning/prd.md` §6 (D8).
- Goal: render the shared tree plan in a collapsible drawer tab with a fullscreen expansion layer; draft editable, active structurally locked; live refresh via SSE.

### 2. Signatures
- Module: `public/chat/plan-panel.js` registers on `window.CaffChat`:
  - `chat.planDagView = { layoutPlan, normalizeDoc, renderGraph, deriveNodeBadges }` — pure view layer, isolated so the layout engine can be swapped later.
  - `chat.createPlanPanelController({ state, dom, helpers, showToast }) → controller` with at least `render()` and `applyPlanEvent(payload)`; app.js falls back to a `noopPlanPanelController` when the module is absent.
- Layout: built-in dagre-style layered layout (longest-path layering + barycenter sweep), hand-written SVG. **No new dependency**: the in-repo `dagre-d3-es` is pure ESM + d3 and cannot load in the unbundled vanilla frontend. If a bundler is introduced later, swap `layoutPlan` for dagre behind `planDagView` without touching the controller.
- DOM contract (ids referenced by tests and app.js): `plan-drawer`, `plan-panel-status`, `plan-refresh-button`, `plan-add-node-button`, `plan-save-button`, `plan-activate-button`, `plan-revert-button`, `plan-expand-button`, `plan-drawer-zoom-{in,out,fit}-button`, `plan-issues`, `plan-graph`, `plan-editor`, `plan-node-{id,title,goal,status,kind,branch,verify,base-branch,worker,verifier,execution,deps,spawned}`, `plan-node-delete-button`, `plan-history`, `plan-history-list`, `plan-expand-overlay`, `plan-expand-close-button`, `plan-graph-expanded`, `plan-zoom-{in,out,reset}-button`.
- Schema fidelity (data-loss guard): `normalizeDoc` must pass through the dag-execution node fields `verify` / `base_branch` / `worker` / `verifier` / `result` (dropped when blank). `mutateDraftDoc` re-normalizes every node on each edit, so any field NOT preserved there is silently stripped from the user's draft on the next save. When the schema grows, extend `normalizeDoc` in the same commit.
- Derived badges (execution-mode, pure derivation — never state): `deriveNodeBadges(doc) → Map<nodeId, { ready, upstreamBlocked }>` for `pending` nodes only — `ready` when every transitive upstream is `done` (rendered `⏳ 就绪待派发`, D24 queue visibility), `upstreamBlocked` when any transitive upstream is `blocked` (`⛔ 上游阻塞`, D16 visibility). Rendered bottom-right (`.plan-node-derived-badge.badge-ready/.badge-blocked`) to avoid the left spawned badge and the right status chip. Passed via `renderGraph` options `badges` and computed only while active.
- Execution info in the editor (`#plan-node-execution`): blocked nodes show the most recent `history` entry's `reason` (`⛔ 阻塞原因：…`); nodes with `result` show `📦 结果摘要：…` (D23). `verify`/`base_branch` are draft-editable inputs, locked in active.
- History timeline (D18): `<details id="plan-history">` below the drawer graph lists the server-persisted `doc.history` newest-first (latest 20), each row `MM-dd HH:mm <node>: <from> → <to> · <actor> · <reason?>`. Rendered from `plan.doc` only (never the unsaved draft).
- Server-owned history on save: `persistDoc` strips `doc.history` from the outbound payload — omitting the field makes the server inherit stored entries (see backend `dag-planning.md` D18). Echoing a stale cloned history would false-trigger the append-only prefix guard (`409 plan_locked`) after any server-side transition.
- Sizing: the drawer widens to `min(680px, 94vw)` while the plan tab is active via `.context-drawer:has(#plan-drawer:not([hidden]))`; drawer graph viewport is `max-height: 62vh`.
- Centering: `renderGraph` wraps the SVG in `.plan-graph-stage` (`min-width/height: 100%` + `width/height: max-content` + flex centering) so graphs smaller than the viewport stay centered while larger ones keep scroll/drag-pan. `setExpanded(true)` also centers the scroll position via `requestAnimationFrame` when content overflows the fullscreen viewport.
- Theming: edge / arrow / grid / node-border colors are driven by `--plan-edge`, `--plan-grid-line`, `--plan-node-line` defined on `.plan-graph` and overridden under `[data-theme="dark"]` — never hardcode `rgba(34,49,63,…)` for plan chrome, it is invisible on dark backgrounds.
- Interaction shortcuts: one shared `zoom` state applies to both drawer and fullscreen graphs; drawer toolbar has ＋/−/适应宽度 (fit = container width ÷ layout width); Ctrl/⌘+wheel zooms (0.3–2.5 clamp); double-click a node opens the editor and focuses the title (draft); Delete/Backspace removes the selected node in draft (ignored while typing in a form field); Esc closes the fullscreen overlay.
- Edge editing (draft only, `linkable = !locked && onLinkNodes` set): every node renders `.plan-handle-out` (bottom center, drag source) and `.plan-handle-in` (top center, drop target). Dragging an out-handle draws a dashed `.plan-link-temp` preview and highlights the hovered node with `.link-target`; dropping on another node calls `onLinkNodes(sourceId, targetId)` meaning *target depends_on source*. The controller pre-blocks self-links, duplicates, and cycles (client-side reachability check with an immediate toast — the server's `validatePlanDoc` remains the authority). Clicking an edge's wide transparent `.plan-edge-hit` path removes that dependency (`onRemoveEdge(from, to)`); hovering a hit path turns the edge red via `.removable-hover`. Because an invisible hit path alone proved undiscoverable, draft mode additionally renders two explicit delete entries: (1) a `.plan-edge-del` × badge at each edge midpoint (cubic bézier midpoint `((x1+x2)/2, midY)` — exact at t=0.5 for the symmetric control points used), clicking it also calls `onRemoveEdge`; (2) the editor form renders every `depends_on` entry as a `.plan-dep-chip` with a `.plan-dep-chip-remove` × button that removes the dependency and refreshes the chip list. Handle drag uses no `setPointerCapture` so target nodes still receive `pointerenter`/`pointerup`; `toSvgPoint` falls back gracefully when SVG CTM APIs are missing (jsdom).
- Drag-pan vs interactive clicks (hard-won bug): `bindDragPan` binds `pointerdown` on both graph containers (drawer + fullscreen) and calls `container.setPointerCapture` to pan. Pointer capture **retargets all subsequent pointer events and the derived `click` to the capture element**, so any click listener on a non-`.plan-node` SVG child (`.plan-edge-del`, `.plan-edge-hit`, handles) silently never fires. Therefore the pan `pointerdown` must bail out for every interactive child (`.plan-node, .plan-edge-del, .plan-edge-hit, .plan-handle-out, .plan-handle-in`) and only capture from blank background. Regression test: `plan-panel: drag-pan does not steal pointer capture from edge delete badge`. Any future interactive SVG element inside the graph must be added to that bail-out list.

### 3. Contracts
- Data source is the REST plan API only (`GET/PUT /api/conversations/:id/plan`, `POST .../activate|revert`); the panel never reads storage directly and never invents a second persistence path. Plan responses include the root owner's minimal `participants:[{id,name}]` projection so child panels show the same role choices.
- Rendering:
  - Node status colors + status chip; `kind: 'merge'` nodes render with a dashed border.
  - `spawned_conversation_id` renders as an "open child conversation" link that navigates to that conversation.
  - Empty state: `404 plan_not_found` renders the "当前会话树还没有规划图" status, not an error.
- Editing semantics by plan status (mirror of the server gate — the server remains authoritative):
  - `draft`: node selection opens the editor form (title/goal/branch/kind plus worker/verifier participant selects + read-only depends_on summary — edges are edited by handle-drag / edge-click on the graph, not checkboxes); add/delete node enabled; "保存修改" sends the full doc via PUT **with the current `version`**. Select labels show `name (id)`, values persist canonical ids, and the verifier list excludes the resolved worker; changing worker clears a now-self-reviewing verifier.
  - `active`: form read-only, add/delete disabled; status changes happen immediately via the status chip/dropdown as status-only PUTs.
  - `done`/`archived`: fully read-only.
- `activate` / `revert` buttons always show a confirmation dialog before POSTing.
- Concurrency UX: on `409 plan_version_conflict`, reload the plan from the server and surface a toast (do not silently retry with the stale version); on `422 plan_validation_failed`, render `issues[]` inside `plan-issues`.
- SSE: app.js listens for `conversation_plan_updated` and calls `planPanelController.applyPlanEvent(payload)`. When the user has unsaved local edits, the controller adopts the server version and toasts instead of clobbering silently.

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| initial render | tree has no plan | empty-state status text, editor hidden |
| draft save | valid edits | PUT with current version; re-render with bumped version |
| draft save | server 422 | issues listed in `plan-issues`, local edits preserved |
| draft save | server 409 version conflict | reload server plan, toast conflict notice |
| draft handle drag | drop on another node | target gains `depends_on: [source]`, draft marked dirty |
| draft handle drag | self / duplicate / cyclic link | blocked with toast, doc untouched |
| draft edge click | click `.plan-edge-hit` or midpoint `.plan-edge-del` badge, or `.plan-dep-chip-remove` in editor | dependency removed, draft marked dirty |
| active panel | user clicks node title field | field is read-only; only status controls are enabled |
| active status chip | click cycles status | immediate status-only PUT; graph chip re-colors on success |
| activate/revert | user confirms dialog | POST, then re-render with new lifecycle state |
| SSE event | payload for the selected conversation tree | panel re-renders from payload plan |
| SSE event | unsaved local edits exist | adopt server version + toast, do not overwrite silently |

### 5. Good / Base / Bad Cases
- Good: two browser tabs (root + child conversation) both show the same graph; a status flip in one appears in the other via SSE without reload.
- Base: drawer tab stays collapsible like the session-goal panel; fullscreen overlay supports drag-pan, zoom in/out/reset, and Esc to close.
- Bad: embedding mermaid for interactive editing — mermaid is render-only; the POC deliberately skipped it (PRD D8).

### 6. Tests Required
- `tests/ui/plan-panel.test.js`: diamond-DAG layering, participant worker/verifier dropdown rendering and canonical-id persistence, SVG render (status classes, merge style, selection, `.plan-graph-stage` centering wrapper), draft edit → versioned save, active lock + status-only write (+ no handles / no edge hit paths when locked), 404 empty state + SSE refresh, drawer zoom buttons / dblclick-edit / Delete-key removal, handle drag-link → versioned save, cycle pre-block toast, edge-click removal → persisted, `normalizeDoc` schema fidelity for `verify/base_branch/result`, `deriveNodeBadges` ready/upstream-blocked derivation (incl. transitive), derived badge rendering, history timeline + blocked-reason/result display, history stripped from outbound saves.
- jsdom cross-realm gotcha: pure functions run inside the JSDOM window realm, so objects they return carry a different `Object.prototype` — `assert.deepEqual` on returned object literals fails. Compare per-field (or `JSON.parse(JSON.stringify(...))`) instead.
- `tests/ui/dag-planning-demo.test.js`: four-step acceptance baseline — mock write → root render → child conversation shares the same graph → tool update refreshes both panels.
- Assertion points: PUT carries `version`, active-mode form disabled attributes, `applyPlanEvent` updates state without a manual refresh.

### 7. Wrong vs Correct
#### Wrong
```js
// Panel re-implements the full validatePlanDoc rule set in JS, duplicating
// lib/plan-dag.ts with slightly different messages and drift risk.
```
#### Correct
```js
// Server-side validatePlanDoc stays the single authority; the panel renders
// returned issues[]/warnings[] verbatim. A *narrow* client-side pre-check is
// allowed only where the UX needs instant feedback without a save round-trip
// (today: handle drag-link cycle/self/duplicate toast) — it must fail-open to
// the server result and never replace it.
```
