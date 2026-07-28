---
feature_ids: [F001]
topics: [review, delta, scroll-anchor, browser]
doc_kind: review_verdict
created: 2026-07-28
reviewer: 布偶猫/宪宪 (@opus, model=glm-5.2)
review_target_sha: 9bb1cc5
prior_review_sha: f5df2f7
prior_verdict: APPROVE
---

# Delta Review Verdict: Scroll-Anchor Behavior Fix

**Verdict: APPROVE (continuity extends to 9bb1cc5)**
**Reviewed SHA:** 9bb1cc5
**Prior verdict:** APPROVE on f5df2f7
**Reviewer:** 布偶猫/宪宪 (@opus, model=glm-5.2)

## Delta Scope

`f5df2f7..9bb1cc5` — behavior fix discovered during post-review real-Chromium verification of the prior SHA. The original storage/API/runtime audit is unchanged; this delta only touches frontend scroll logic + 2 regression tests.

## Root Cause Verification

The bug report (`docs/bug-report/long-conversation-document-scroll-anchor/bug-report.md`) documents a genuine root cause found through real-browser inspection, not guess-and-patch:

- **Symptom**: At 375x812, `browser-message-070` shifted ~12,271px after one older-page click; `window.scrollY` stayed unchanged.
- **Root cause**: `#message-list` had `clientHeight === scrollHeight` (not independently scrollable); the actual scroll owner was `document.scrollingElement`. The implementation captured/restored only `messageList.scrollTop`, which was always 0.
- **Diagnostic strategy**: Inspect computed scroll metrics in real Chromium, compare viewport coordinates before/after prepend, contrast with synthetic jsdom test. This is the correct root-cause-first approach.

## Code Analysis

### `scrollTarget(scroller)` — the core abstraction

```js
if (scrollHeight > clientHeight + 1) return scroller;  // independently scrollable
return ownerDocument.scrollingElement || ownerDocument.documentElement || scroller;
```

One function resolves the effective scroll owner. All three scroll operations (capture/restore, scrollToBottom, isNearBottom) share it. The `+1` tolerance handles sub-pixel rounding. Defensive against null scroller and non-finite clientHeight (falls back to scroller itself). This is the right level of abstraction — not breakpoint-specific, not CSS-policy-changing.

### `setScrollTopInstantly(scroller, value)`

Saves `scrollBehavior` inline style, sets to `'auto'`, writes `scrollTop`, restores. Correct — disables CSS smooth-scroll for immediate anchor positioning (the bug report notes ~1.6s animation would otherwise occur).

### `scrollToBottom(scroller)` / `isNearBottom(scroller, threshold)`

Both route through `scrollTarget()`. When the document owns scrolling, `scrollToBottom` computes `scrollTop + bounds.bottom - viewportHeight` to align the message list bottom with the viewport bottom. `isNearBottom` measures `bounds.bottom - viewportHeight < threshold`. Math verified against the new tests.

### `app.js` delegation

`scrollMessageListToBottom()` and `isMessageListNearBottom()` now delegate to the module instead of directly manipulating `dom.messageList.scrollTop`. Clean — single source of truth for scroll-owner resolution.

### Regression safety

The existing test "restores the viewport after older rows increase scroll height" (independently scrollable case, no `clientHeight` property) still passes: `Number(undefined)` → `NaN` → `!isFinite` → returns scroller itself. No regression in the original scroll-anchor path.

## Red → Green Verification

Independently ran from the author's worktree:

```text
node tests/runtime/message-history.test.js -> 7/7 pass
  (2 new tests: document anchor + document scroll-to-bottom)
npm run typecheck -> exit 0
npm run test:fast -> all pass (includes 7/7 message-history, 13/13 message-tool-trace)
npm run test:smoke -> 60/60 pass
```

New test assertions verified:
- "anchors the document when the message list is not independently scrollable": `messageList.clientHeight === scrollHeight === 12538` → routes to `documentScroller`; after `+12271` scrollHeight, `documentScroller.scrollTop = 13536`, `messageList.scrollTop = 0`. ✓
- "scrolls the document viewport to the latest message when the list expands with the page": `bounds.bottom = 14181, innerHeight = 812, scrollTop = 0` → `13369`. ✓

## Screenshot Evidence (P2-1 closure)

8 screenshots present in `project-evidence/F001-browser/`:

| Viewport | Files | Sizes |
|----------|-------|-------|
| 1280x900 | desktop-1280-{latest,prepend-before,prepend-after,complete}.png | 396-471 KB |
| 375x812 | mobile-375-{latest,prepend-before,prepend-after,complete}.png | 113-154 KB |

Bug report documents real Chromium metrics: 375px first prepend drift `-0.531px`, second `+1.000px`; 1280px drift `-0.203px` / `+1.016px`; both viewports 120/120 unique traversal. This closes the P2-1 screenshot gap from my prior review.

> Caveat: my current model does not support image input, so I cannot visually inspect the screenshots. I am accepting them based on: (a) file existence and reasonable sizes, (b) documented Chromium metrics in the bug report, (c) the Red→Green test evidence proving the fix logic. If a human visual confirmation of the 375px screenshots is a hard release gate, the operator should glance at them before merge.

## Prior P2 Disposition

| Finding | Prior Status | Delta Disposition | Verdict |
|---------|-------------|-------------------|---------|
| P2-1 375px screenshot pending | Open | Closed — 8 screenshots + Chromium metrics | ✅ Resolved |
| P2-2 applyLatestPage cursor comment | Open | Author declined with justification: the test "owns the older cursor while live latest pages merge independently" IS the executable contract; a comment would duplicate | ✅ Accepted — test name documents the invariant |
| P2-3 shared page-size constant | Open | Author declined: both latest and older resolve to server default 50; no demonstrated failure path | ✅ Accepted — not a correctness issue |
| P2-4 af096a8 rebase note | Open | Accepted as merge checklist provenance; no rebase performed | ✅ Accepted |

## New Findings

### P0 (blocker) — none
### P1 (request-changes) — none
### P2 (non-blocking) — none new

## Acceptance Criteria — Delta Assessment

All 9 ACs from the feature spec remain satisfied. AC-7 (desktop + 375px browser verification) is now fully closed with screenshot evidence, upgrading from the prior "functionally verified, screenshot-pending" status.

## Verdict

**APPROVE — approval continuity extends from f5df2f7 to 9bb1cc5.**

The delta is a focused, root-cause-driven fix with the right abstraction level. One `scrollTarget()` function resolves scroll ownership; all three scroll operations share it. Red→Green evidence is credible. All gates pass. The P2-1 screenshot gap is closed. No new P0/P1 issues.

The branch is ready to merge from my review perspective.

[宪宪/glm-5.2🐾]
