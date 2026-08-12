---
feature_ids: [F005]
topics: [review, hotfix, image-only, multimodal, runtime, routing, content-blocks]
doc_kind: review_request
created: 2026-08-12
---

# Review Request: F005 image-only runtime routing hotfix

Review-Target-ID: f005-image-only-runtime-routing
Branch: fix/f005-image-only-runtime-routing
Implementation-HEAD: fa0d1545f513ea2d97d4fb0678b5608b78927b9e
Base: origin/main@fd1da04feb00e88aa47246502f27094dffc41b8e
Author quality-gate verdict: not issued; hotfix self-pass is prohibited

## What

Fix the merged-main runtime break where image-only messages persisted successfully but stopped at
`Message content is required`, while captioned and historical messages could lose images before the
provider invocation.

- Runtime readers now consume canonical `message.metadata.contentBlocks` through one exported helper.
- Persisted image-only queue batches remain executable when their selected messages contain canonical
  image blocks.
- Direct `runConversationTurn(..., { imageIds })` passes those ids into `store.createMessage()` so the
  store retains ownership of image attachment and content-block derivation.
- Persisted batches reject detached `imageIds`; direct and batch image sources cannot be mixed or
  silently ignored.
- Runtime fixtures now use the same message shape as storage, API, and UI.
- The runtime queue spec and a root-cause bug report record the corrected contract.

## Why

F005 established `metadata.contentBlocks` as the stored message shape and permits image-only messages,
but the final queue/invocation consumers still enforced the old text-only and top-level-block assumptions.
The tests repeated that non-canonical shape, so they were internally green while merged-main browser
acceptance failed at the real boundary. Fixing only the empty-text guard would have let requests continue
while still stripping images, violating AC-B3.

## Original Requirements

> Image-only messages are valid: empty `content` plus attached `imageIds` must persist and execute.
> Stored image blocks live under `metadata.contentBlocks`; `content` remains the only text truth.
> Vision-capable providers receive structured image content.
> Unsupported targets fail closed with an explicit reason before persistence where possible.
> No path may silently drop an image or continue as text-only.

- Source: `docs/features/F005-image-input-and-multimodal-routing.md` lines 13-17, 29-40, AC-B2/B3.
- Source: `.trellis/spec/runtime/conversation-turn-queue.md`.
- Diagnosis: `docs/bug-report/f005-image-only-runtime-routing/bug-report.md`.
- Please review against the no-silent-drop invariant, not only the immediate empty-text symptom.

## Tradeoff

- Chose canonical metadata-only reads. No compatibility fallback to top-level `message.contentBlocks` was
  added because that would preserve two competing runtime shapes and let fixture drift recur.
- Reused `messageImageBlocks()` in queue and invocation code instead of adding a second image detector.
- Kept direct `imageIds` flowing through `store.createMessage()` instead of synthesizing blocks in routing;
  ownership validation, batch consumption, attachment, and projection remain one atomic store contract.
- Rejected mixed `batchMessageIds + imageIds` input instead of choosing one source and silently dropping the
  other. F003's top-level `targetMessage.contentBlocks` is a separate delivery DTO and remains unchanged.

## Architecture Ownership

Architecture cell: `server/domain/conversation/turn` within the existing F005 conversation/messages cell
Map delta: none for this hotfix
Why: the original F005 feature already introduced and documented the content-block/routing architecture.
This hotfix corrects consumers inside the existing cell and adds no Store, Queue, Router, Adapter,
Dispatcher, Binding, dependency, persistence schema, or ownership boundary.

Mechanical ownership command: unavailable (`check:architecture-ownership` is not present in this repo).
Manual mismatch scan found no new ownership primitive; reviewer should independently confirm `Map delta: none`.

## Failure-Mode Sweep

The same silent-drop family was scanned across runtime, storage, API, UI, and tests:

1. Persisted message consumers now read only `metadata.contentBlocks`.
2. Direct image-only input forwards `imageIds` to the store rather than losing them at routing.
3. Persisted image-only batches are accepted from canonical blocks even when concatenated text is empty.
4. Pure empty batches still fail with `Message content is required`.
5. Mixed persisted-batch plus detached-image input fails explicitly with 400; neither source is ignored.
6. F003 delivery's top-level block field is a distinct DTO and still fails closed for images by design.

## Fresh-Context Findings

Finding generator only, not an approval authority.

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| FC-1 | P1 | `batchMessageIds + imageIds` could pass the image-presence guard while detached ids were never persisted or projected, creating another silent-drop path. | Red regression added; routing now rejects all mixed-source batches with explicit 400. |

Final rescan after FC-1: no remaining correctness, security, spec-mismatch, or missing-test findings.

## Independent Hotfix Quality Gate Required

The author has prepared evidence but has not signed a quality-gate verdict. Per the hotfix self-pass rule,
another cat must execute the quality gate on `fa0d1545` before formal review approval can count.

### Scope and mechanical scans

- Diff: 9 files, 307 insertions, 39 deletions relative to `origin/main@fd1da04`.
- `scripts/check-hotfix-pattern.mjs`: unavailable in this repository.
- `scripts/check-fallback-layers.mjs`: unavailable; manual added-line scan found no same-file 3-layer fallback.
- `check:architecture-ownership` and `check:capability-tips`: unavailable in `package.json`.
- Design scan: no `designs/**/*.pen`; the hotfix has no frontend code delta.
- Root media/design artifact scan: zero in worktree and committed diff.
- Follow-up tail scan: no deferred implementation or next-PR repair claim.
- Dependency, migration, Redis, and production-data deltas: none.

### Red -> Green

- RED: canonical metadata projection fixtures failed 14 multimodal cases on the merged implementation.
- RED: persisted image-only batch failed with `Message content is required`.
- RED: direct image-only routing passed no `imageIds` to `store.createMessage()`.
- RED: FC-1 mixed-source regression reported `Missing expected rejection`.
- GREEN: focused projection/invocation/agent/routing suites pass `99/99`, including legal direct and
  persisted image-only paths, pure-empty rejection, and mixed-source rejection.

### Author verification on `fa0d1545`

```text
npm run check                                                exit 0
npm run typecheck                                            exit 0
node --test <4 affected runtime suites>                      99/99
npm test                                                     exit 0 (fast + smoke)
npm run test:ui                                              110/110
UI structure contract                                       15/15
git diff --check                                             exit 0
```

Expected log noise is limited to existing npm config deprecation notices and synthetic errors asserted by
failure-path tests.

### Dogfood-Your-Slice

Scope verdict: required; this hotfix changes a user-visible runtime path.

- Worktree: `E:/pythonproject/caff-acceptance-f005-completion` at `fa0d1545`.
- Runtime: current build on dynamic loopback `http://127.0.0.1:50726/`, fresh temporary SQLite and agent
  directory, local OpenAI-compatible mock provider; no production data and no reserved ports.
- Result: `29/29` checks passed.
- Image-only and captioned desktop sends reached completed assistant outcomes.
- All three provider requests contained `data:image/png;base64,...`.
- Refresh preserved image tiles and image-before-text order.
- 375px picker/remove/paste/send completed with no horizontal overflow.
- Non-vision send returned 422 before persistence; message count stayed `0 -> 0` and composer state remained.
- No unexpected HTTP, page, or console errors.
- Evidence: `%LOCALAPPDATA%/Temp/cat-cafe-evidence/f005-completion/fa0d1545/evidence.json`.
- Screenshots and the desktop walkthrough video are in the same evidence directory.

## Open Questions

### Technical OQ

1. Does metadata-only image detection cover every persisted runtime message path without a legitimate
   top-level message shape being lost?
2. Is rejecting mixed persisted-batch/detached-image input the correct fail-closed boundary?
3. Do the direct and persisted image-only regressions exercise the real store/prompt contracts deeply enough?
4. Does `Map delta: none` accurately describe this correction inside the existing conversation turn cell?

### Value OQ

None. This is a reversible correctness hotfix for the already-approved F005 experience.

## Next Action

1. Independently execute and sign the hotfix quality gate for exact HEAD `fa0d1545`.
2. If the gate passes, perform formal review of `origin/main...fa0d1545` and return APPROVED or CHANGES
   REQUESTED with severity and exact code/test references.
3. On approval, record a logical review comment once GitHub is reachable; shared-account `gh pr review
   --approve` is not valid.

## Review Sandbox

- Suggested path: `%LOCALAPPDATA%/Temp/cat-cafe-review/f005-image-only-runtime-routing/opus`.
- Checkout: detached `fa0d1545` and read-only.
- Use a fresh temporary SQLite and agent directory only.
- Use dynamic loopback ports; do not use 3003, 3004, or Redis 6399.
- `node_modules` may be installed in the sandbox or linked read-only from an existing F005 worktree.

[砚砚/gpt-5.6-sol🐾]
