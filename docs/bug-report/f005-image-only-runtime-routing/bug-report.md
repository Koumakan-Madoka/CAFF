---
feature_ids: [F005]
topics: [image-input, multimodal, runtime, queue, content-blocks, acceptance]
doc_kind: bug-report
created: 2026-08-12
status: fix_implemented
---

# F005 Image-only Messages Stop Before Multimodal Runtime Routing

## Reporter

Found by 缅因猫/砚砚 during isolated merged-main completion acceptance at
`fd1da04feb00e88aa47246502f27094dffc41b8e`.

## Diagnosis Capsule

| Field | Evidence |
| --- | --- |
| Phenomenon | The browser accepts and persists an image-only message with HTTP 200, but the queued turn fails with `Message content is required`. Captioned image messages enter the turn, yet runtime image projection does not see their canonical persisted image blocks. |
| Evidence | Isolated app on a dynamic loopback port with a temporary agent directory and SQLite store; browser evidence JSON under `%LOCALAPPDATA%/Temp/cat-cafe-evidence/f005-completion/fd1da04f/`; server stack points to `routing-executor.js`; screenshot shows persisted image cards falling back after the invalid test PNG. |
| Confirmed root cause | F005 changed the accepted-message contract to allow `content === ''` when images exist and stores image blocks in `metadata.contentBlocks`. `routing-executor.ts` retained a text-only guard for both direct and persisted-batch execution. Separately, `image-invocation.ts` and `multimodal-projection.ts` read `message.contentBlocks` at the top level. Existing runtime fixtures repeated that non-canonical shape, masking the production drift. |
| Diagnostic strategy | Trace browser POST -> persisted message -> queue drain -> routing executor -> prompt visibility -> invocation projection, then replace fixture-only top-level blocks with the real storage/API shape and add an image-only persisted-batch regression. |
| Timeout strategy | If the focused red tests do not fail at the two identified boundaries, stop and capture the actual prompt-message payload before changing production code. |
| Warning strategy | Do not merely relax the empty-text guard: if invocation projection still reads the wrong field, the request continues while silently stripping images, violating AC-B3. |
| User-visible correction | Image-only messages proceed into the vision-model turn; captioned and historical image messages keep their image payload instead of being reduced to text-only runtime input. |
| Acceptance | RED: canonical metadata fixtures and persisted image-only batch test fail on `fd1da04`. GREEN: focused runtime tests, full repository gates, and repeated isolated desktop/mobile/provider browser journey all pass. Before merge, an independent cat must run the hotfix quality gate and review the final head. |

## Reproduction

1. Configure a model with canonical `input: ['text', 'image']` and bind it to a chat role.
2. Upload an image in the composer and send it with no caption.
3. Observe HTTP 200, a persisted user image message, then the server error `Message content is required` from the queued turn.
4. Send a captioned image and inspect invocation projection: the stored message exposes `metadata.contentBlocks`, while the runtime readers only inspect `message.contentBlocks`.

Expected: both messages enter multimodal agent execution with their image blocks.

Actual: the pure-image turn stops before agent execution; captioned messages can proceed as text while runtime image detection misses the canonical blocks.

## Root Cause

The content-block contract was propagated through upload, persistence, API response, history, and UI,
but not through the final queue and runtime projection consumers. Tests encoded the same top-level
shape as those consumers, so unit coverage was internally consistent but disagreed with the storage
truth.

## Fix

- Runtime image-block readers now consume `metadata.contentBlocks`, matching storage and UI.
- An empty textual batch is allowed only when canonical image blocks are present, while retaining the
  existing rejection for truly empty messages.
- Direct image-only routing passes `imageIds` into `store.createMessage()` so the store remains the
  single owner of upload attachment and canonical content-block derivation.
- The fix stays at the contract boundary and does not add fallback reads that preserve two competing
  content-block locations.

## Verification

- RED: canonical metadata fixtures failed 14 multimodal cases, and the persisted image-only batch
  stopped at `Message content is required`.
- GREEN: focused runtime suites, repository gates, and repeated browser acceptance are recorded in
  the hotfix review request. Independent cross-cat quality-gate and review evidence are required
  before merge and will be recorded by the reviewer.

[砚砚/gpt-5.6-sol🐾]
