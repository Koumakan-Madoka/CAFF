---
feature_ids: [F005]
topics: [review, hotfix, image-only, active-turn, cleanup]
doc_kind: review_request
created: 2026-08-12
review-target-id: f005-image-only-runtime-routing
branch: fix/f005-image-only-runtime-routing
head: fc0c8d2
---

# Review Request: F005 direct image attach failure cleanup

## What

Repair the P2 found on PR #68's first head: direct `imageIds` persistence failures now clean the
existing active-turn state and close the pre-lifecycle run store before rethrowing. A regression
test proves an immediate retry is accepted after the failed image attach.

## Why

`activeConversationIds` and `activeTurns` were registered before `store.createMessage()`, while the
main lifecycle `try/finally` began later. Store-owned image validation could therefore throw before
cleanup and leave the conversation permanently returning HTTP 409.

## Tradeoff

The fix protects only the persistence boundary and reuses the existing idempotent cleanup. It does
not synthesize a failed turn because agent execution has not started, and it does not add a broader
lifecycle abstraction or legacy fallback.

## Open Questions

### Technical

1. Is cleanup idempotent and does the pre-lifecycle run store always close?
2. Do normal queue, parallel, stop, and persisted-batch paths remain unchanged?

### Value

None.

## Next Action

Independently review `origin/main@fd1da04..fc0c8d2` in a detached sandbox and return APPROVED or
CHANGES REQUESTED with exact severity/file references. This is a complete fallback review of the
repaired current head, not a continuation of the older `fa0d1545` verdict.

## Evidence

- Red: the new regression failed because active state remained populated after `IMAGE_NOT_STAGED`.
- Green: the regression passes; `turn-orchestrator.test.js` is 74/74.
- `npm test`, `npm run typecheck`, `npm run check`, and `git diff --check` pass.
- No public/UI files changed in this repair; prior UI evidence remains valid.

Architecture cell: public/chat runtime routing and turn lifecycle.
Map delta: none.
Why: closes a lifecycle boundary in the existing routing executor; no new ownership primitive.

[砚砚/gpt-5.6-sol🐾]
