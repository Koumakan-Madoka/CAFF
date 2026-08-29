---
feature_ids: [F001]
topics: [chat, pagination, browser, scroll-anchor]
doc_kind: bug_report
created: 2026-07-28
---

# Long Conversation Document Scroll Anchor

## Reporter

砚砚 discovered the defect during post-review real-browser verification of F001 at implementation SHA `f5df2f7`.

## Diagnosis Capsule

| Field | Evidence |
| --- | --- |
| Symptom | On both 1280px and 375px viewports, loading an older page moved the previously visible first message thousands of pixels below the viewport. At 375px, `browser-message-070` moved from about `469px` to `12741px` while `window.scrollY` stayed unchanged. |
| Evidence | The live isolated fixture rendered 50 messages, but `#message-list.clientHeight === #message-list.scrollHeight`; the actual scroll owner was `document.scrollingElement`. The implementation captured and restored only `messageList.scrollTop`. |
| Root cause | The pagination state helper assumed `#message-list` was always independently scrollable. Responsive CAFF layouts allow that grid row to expand with the page, so scroll ownership can move to the document. The same assumption also made initial scroll-to-latest and near-bottom detection ineffective. |
| Diagnostic strategy | Inspect computed scroll metrics and bounding boxes in real Chromium, click the real history button, then compare the same message's viewport coordinate before and after prepend. Contrast this with the synthetic jsdom scroller test. |
| Timeout strategy | If scroll ownership was not evident within one browser probe, inspect ancestor overflow/height constraints and instrument scroll events rather than patch CSS blindly. |
| Warning strategy | Three failed fixes or a requirement for several breakpoint-specific fallbacks would trigger a layout/scroll architecture review. One scroll-target abstraction resolved all affected paths. |
| User-visible correction | Initial conversation load now brings the latest message into the active viewport. Prepending older messages preserves the same visible message whether the list or the document owns scrolling. |
| Acceptance | Red tests fail on document-owned scrolling; focused tests turn green; real 1280px and 375px clicks keep anchor drift within about 1px; both viewports traverse 120/120 unique messages; fast/smoke/typecheck pass. |

## Reproduction

Runtime preflight for the fixed verification server:

```text
PORT=3110
PID=45856
START_TIME=2026-07-28 16:24:37 +08:00
HEAD=02e3250 plus the documented F001 scroll-anchor working-tree delta
TARGET_COMMIT=f5df2f7 implementation plus the scroll-anchor delta
PROCESS_AFTER_TARGET=yes (server started after a fresh npm run build)
LOG_EVIDENCE=server-fixed.stdout.log identifies the URL and isolated SQLite path; this logger does not emit PID fields
```

1. Open the isolated 120-message conversation at `http://127.0.0.1:3110/`.
2. Use a 375x812 viewport and scroll the `加载更早消息` button into view.
3. Record the viewport top of `browser-message-070`.
4. Click the button and wait for the timeline to grow from 50 to 100 rows.

Expected: `browser-message-070` remains at the same viewport coordinate.

Before the fix: it moved by approximately `12,271px`; the browser stayed at the old document scroll position.

## Fix

- Resolve the effective scroll owner: use `#message-list` when it has an independent scroll range, otherwise use its document scrolling element.
- Capture and restore scroll-height deltas on that effective target.
- Apply scroll restoration without CSS smooth-scroll animation.
- Reuse the same scroll-owner rule for initial scroll-to-bottom and near-bottom detection.

Rejected alternative: imposing a breakpoint-specific fixed height on the message list. That would introduce nested-scroll layout policy and would not address other cases where an ancestor or document owns scrolling.

## Verification

```text
RED:
node tests/runtime/message-history.test.js
  -> 5 pass, 2 fail
  -> document anchor stayed at 1265 instead of 13536
  -> scrollToBottom was missing

GREEN:
node tests/runtime/message-history.test.js -> 7/7 pass
node tests/runtime/message-tool-trace.test.js -> 13/13 pass
npm run typecheck -> exit 0
npm run test:fast -> exit 0
npm run test:smoke -> 60/60 pass
```

Real Chromium metrics:

| Viewport | Initial rows | First prepend drift | Second prepend drift | Final traversal |
| --- | ---: | ---: | ---: | --- |
| 1280x900 | 50 | `-0.203px` | `+1.016px` | 120 rows, 120 unique |
| 375x812 | 50 | `-0.531px` | `+1.000px` | 120 rows, 120 unique |

Raw screenshots were removed from the current tree during Trellis ledger convergence. The acceptance metrics are retained above; exact media remains recoverable from Git history under `project-evidence/F001-browser/` at `968e7e5`.

[砚砚/gpt-5.6-sol🐾]
