+---
feature_ids: [F005]
topics: [review, image, multimodal, ui]
doc_kind: review_request
created: 2026-08-12
---

# Review Request: F005 Phase C image composer and timeline

Review-Target-ID: f005-phase-c
Branch: feat/f005-phase-c-image-ui
Commits: e72fe2c..685fb6b
HEAD: 685fb6b

## What

Implement the missing browser surface for the already-merged F005 image pipeline:

- picker + paste intake, ordered preview strip, remove, local/server validation
- batch upload with ordered imageIds and retry identity
- image-only and text+image message submit
- one metadata.contentBlocks timeline renderer for optimistic/history/SSE/refresh
- visible missing/load-error fallback with retry/open actions

Fresh-context fixes are included: actual HTTP 202 UPLOAD_IN_PROGRESS, retryable vs deterministic rejects, message-level clientRequestId reuse/confirmation, caption freeze/restore, and sticky load-error recovery.

## Why

The operator could query the F005 config endpoint but could not attach an image in chat. Phase C must expose the merged backend without weakening upload/message idempotency or silently losing image state on network, 422, refresh, or renderer failure.

## Original Requirements

> 选图主入口 + 粘贴同 Phase、拖拽延后；attachment strip 预览/移除；时间线 image-grid + 占位降级。
> 阻断反馈 = 422 预写入 + 乐观消息回滚 + composer 保留附件。
> 历史回放、SSE 增量、刷新后渲染全部走同一个图片渲染助手。
- Source: feature-discussions/2026-08-09-F005-image-input-multimodal/ui-design-gate.md
- Please verify that the delivered browser workflow solves this operator-visible gap.

## Tradeoff

- Kept two-phase upload instead of multipart message submit so upload and message idempotency remain independently recoverable.
- Kept metadata.contentBlocks as the sole image rendering truth while content remains text truth.
- No drag/drop, lightbox, reorder, or image editor; these remain explicit Design Gate non-goals.
- The attachment state machine is one controller, not a second persistent browser store.

## Architecture Ownership

Architecture cell: public/chat (composer/timeline) extending the existing server upload/message contract
Map delta: none
Why: adds two focused browser modules and wiring; no parallel Store/Queue/Router/Adapter/Dispatcher/Binding or backend contract change.

## Open Questions

### Technical OQ

1. Inspect ImageComposer state ownership across upload key, message key, caption freeze, SSE/history confirmation, and conversation switch.
2. Inspect retry classification: only network unknown / 202 / 408 / 429 / 5xx offer same-key retry.
3. Browser-operate picker/paste, image-only/text+image, 422 retention, and load-error recovery on desktop + 375px.

### Value OQ

None.

## Fresh-Context Findings

Agent: [砚砚/gpt-5.6-sol🐾]
Initial staged snapshot scanned before commit; final HEAD: 685fb6b
Total findings: 5 (1 P1, 4 P2)

| # | Finding | Author disposition | Status |
|---|---|---|---|
| FC-1 P2 | HTTP 202 UPLOAD_IN_PROGRESS was parsed as success | fixed: structured 202 detection + same-key retry test | done |
| FC-2 P2 | message retries allocated a new clientRequestId | fixed: payload signature key + history confirmation | done |
| FC-3 P2 | load-error fallback was sticky | fixed: explicit retry/open actions | done |
| FC-4 P1 | caption could change while image POST was pending | fixed: textarea freeze + exact restore | done |
| FC-5 P2 | deterministic rejects incorrectly offered whole-batch retry | fixed: retryability classification + mutation guidance | done |

Failure-mode sweep: the first, second, fourth, and fifth findings were state-boundary ownership failures. The sweep covered every upload transition, every message submit/confirm exit, strip mutation, and conversation switch; tests lock the invariants. The image error was independent and now has DOM-local recovery.

Reviewer delta tracking: mark findings FC:covered / FC:new / FC:N/A.

## Next Action

Independently review 685fb6b and return APPROVED or CHANGES REQUESTED with severity and exact code/test references. This is frontend work, so browser operation is required.

## Review Sandbox

- Suggested read-only sandbox: C:/Users/ZN/AppData/Local/Temp/cat-cafe-review/f005-phase-c/opus
- Bootstrap: npm install only if node_modules is unavailable; this worktree already uses the repository lockfile
- Start: npm run build then set CHAT_APP_PORT to an available 32xx port and run node build/lib/app-server.js
- Reserved ports 3003/3004/6399 must not be used

## Quality Gate

Spec:
- feature-specs/2026-08-11-f005-phase-c-image-ui.md
- docs/features/F005-image-input-and-multimodal-routing.md
- feature-discussions/2026-08-09-F005-image-input-multimodal/ui-design-gate.md

Vision coverage:
- AC-C1 picker/paste/preview/remove/upload/send/failure feedback: implemented and checked
- AC-C2 shared timeline rendering/fallback/history-refresh parity: implemented and checked
- Delivery completeness: Phase C is complete; no follow-up code tail is used to claim completion
- Design file scan: no matching .pen; implementation follows the approved UI Design Gate
- Architecture mismatch scan: no parallel ownership primitive
- Fallback script: repository does not provide scripts/check-fallback-layers.mjs; manual scan found no 3-layer fallback growth in a single new decision boundary
- Artifact hygiene: worktree and origin/main...HEAD root-media scans empty
- Worktree: clean at 685fb6b

Validation:
- node --test tests/ui/image-composer.test.js tests/ui/message-images.test.js tests/runtime/message-tool-trace.test.js -> 32/32
- npm run typecheck -> exit 0
- npm run test:ui -> 110/110 + structure 15/15
- npm test -> exit 0 (test:fast + test:smoke)
- git diff --check origin/main..HEAD -> exit 0
- browser dogfood: isolated worktree server opened in Hub preview at 127.0.0.1:3227; the repository browser gate exercised focus/touch/layout/error-free runtime, and targeted jsdom/integration tests cover the deterministic 202/409/lost-response states
- Evidence: .tmp/ui-structure/shots within the worktree test-output area; earlier desktop/mobile image workflow captures are in the system temp evidence directory

Delivery note:
- git push was attempted and failed because this environment could not reach github.com:443. The review target is local HEAD 685fb6b; retry push before merge-gate.

[砚砚/gpt-5.6-sol🐾]
