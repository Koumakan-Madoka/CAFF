---
feature_ids: [F005]
topics: [runtime, image, multimodal, capability, routing, regression]
doc_kind: bug-report
created: 2026-08-13
---

# F005: Text-only models hard-failed on historical image context

## Reporter

The operator reproduced this on `origin/main@3cdb7f1` after sending an image, switching the conversation participant to a model whose `input` is `['text']`, and sending a later text message. The assistant reply was persisted as `failed` with `MODEL_NO_IMAGE_INPUT` instead of continuing with a textual indication that the image could not be read.

## Reproduction

1. Persist a user message with one or more image `contentBlocks`.
2. Select a text-only model such as `deepseek-v4-flash` / `opencode-go` (`input: ['text']`).
3. Send a later text message or route a handoff/side-dispatch through that model.

Expected: the invocation continues with one explicit placeholder per visible historical image, `images: []`, and no invocation blocker. Canonical image metadata remains available to the timeline.

Actual: `buildInvocationImages()` returned `MODEL_NO_IMAGE_INPUT`; `agent-executor.ts` persisted a failed assistant reply, incremented failed replies, and did not call `startRun`.

## Root-cause analysis

`server/domain/conversation/turn/image-invocation.ts` treated any image in the visible window as requiring vision capability before selecting the projection path. The `!capability.supportsImage` branch therefore returned a hard blocker before `projectMultimodalPrompt()` or history prompt construction. `agent-executor.ts` correctly consumed that block according to the then-current contract, so the failure was rooted in the invocation projection contract rather than in persistence or the model adapter.

Clowder compatibility research showed the intended behavior: persisted image history is represented textually for providers that cannot consume image inputs. CAFF now follows that behavior explicitly instead of relying on provider-side silent dropping.

## Fix

`multimodal-projection.ts` adds a shared historical-image placeholder projection. For a text-only invocation, `buildInvocationImages()` returns `block: null`, `images: []`, and projected messages with `[一张图片，但是你没有读取图片的能力]` in the original message/image order. The projection does not read image bytes and leaves `metadata.contentBlocks` untouched. The synchronous current-send `image-preflight.ts` 422 `MODEL_NO_IMAGE_INPUT` contract is intentionally unchanged.

## Verification

- Red observed before production changes: old image invocation and executor tests failed against the new downgrade assertions.
- `npm run build` passed.
- `node tests/runtime/image-invocation.test.js` passed (11/11).
- `node tests/runtime/agent-executor-hook.test.js` passed (8/8).
- Remaining runtime, typecheck, check, and full test gates are recorded in the review packet after implementation.
