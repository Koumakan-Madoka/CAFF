---
feature_ids: [F005]
topics: [runtime, image, multimodal, routing, review]
doc_kind: review-request
created: 2026-08-13
---

# F005 text-only historical-image degradation — review request

Review-Target-ID: f005-text-only-history-image-degradation
Branch: fix/f005-text-only-history-image-degradation

## What

Align later text-only invocations with Clowder behavior when the visible conversation history contains persisted image blocks. The invocation now projects each historical image to `[一张图片，但是你没有读取图片的能力]`, returns `images: []` and `block: null`, and proceeds through the normal `startRun` path. The synchronous current-send `image-preflight.ts` 422 `MODEL_NO_IMAGE_INPUT` contract remains unchanged.

## Original requirements

Source: `docs/features/F005-image-input-and-multimodal-routing.md` and the Clowder compatibility finding recorded in `docs/bug-report/f005-text-only-history-image-degradation/bug-report.md`.

- Historical image metadata must remain canonical and renderable in the timeline.
- A text-only model must not receive image bytes.
- A later text-only invocation must not hard-fail solely because historical images are visible; it must provide explicit placeholder context.
- Current-send initial-target preflight remains fail-closed with 422 `MODEL_NO_IMAGE_INPUT`.
- Vision model projection, image budget failures, and missing-image integrity failures retain their existing contracts.

## Diff scope

- `server/domain/conversation/turn/multimodal-projection.ts`: shared explicit placeholder projection helper.
- `server/domain/conversation/turn/image-invocation.ts`: text-only historical-image branch returns projected history instead of a blocker.
- `tests/runtime/image-invocation.test.js`: Red→Green placeholder/order/no-byte-read assertions.
- `tests/runtime/agent-executor-hook.test.js`: Red→Green `startRun`/empty-images/prompt assertions.
- `docs/bug-report/f005-text-only-history-image-degradation/bug-report.md`: root cause and evidence archive.
- `docs/features/F005-image-input-and-multimodal-routing.md`: dated superseding amendment and contract updates.

Architecture cell: `server/domain/conversation/turn` (invocation projection + agent prompt handoff)
Map delta: update required
Why: the change extends the existing invocation projection boundary; it does not add a Store, Queue, Router, Adapter, or parallel content-block reader.

## Independent self-verification

- RED observed before implementation: old `MODEL_NO_IMAGE_INPUT` behavior failed the new placeholder and `startRun` assertions.
- `npm test` — exit 0, full fast + smoke suite.
- `npm run typecheck` — exit 0.
- `npm run check` — exit 0.
- `npm run build` — exit 0.
- `node tests/runtime/image-invocation.test.js` — 11/11.
- `node tests/runtime/agent-executor-hook.test.js` — 8/8.
- `git diff --check` — exit 0 (only CRLF normalization warnings from existing repository settings).
- Root-level media/design artifact scan — no matches.

## Review focus

1. Confirm the text-only branch preserves `metadata.contentBlocks` while replacing only prompt-visible `content`.
2. Confirm helper windowing matches the normal history window and placeholder order is stable for captions plus multiple images.
3. Confirm text-only invocations never call `readImageBytes`, never pass `images`, and no current-send preflight behavior regressed.
4. Confirm vision, budget, missing-file, and MIME validation paths remain unchanged.

## Next action

Please perform an independent cross-family review on this exact branch HEAD after the commit is pushed. Review verdict should cover the exact current HEAD and the evidence above.

[砚砚/gpt-5.6-sol🐾]
