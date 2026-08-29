# F005 Multimodal Input and Provider Follow-Ups

Status: completed

## Legacy Sources

- `feature-discussions/2026-08-09-F005-image-input-multimodal/`
- `feature-specs/2026-08-11-f005-phase-c-image-ui.md`
- `review-notes/2026-08-11-provider-*.md`
- `review-notes/2026-08-12-f005-*.md`
- `review-notes/2026-08-13-f005-*.md`

## Durable Outcome

F005 delivered bounded image upload/storage, canonical image message metadata, multimodal runtime routing, composer/timeline UI, destination-room locking, image-only routing repair, and text-only historical-image degradation. Adjacent provider fixes normalized literal API keys and made API protocol selection explicit.

## Delivery Evidence

- F005 backend/runtime: `eb96a4fc46ad9426d1b1b256dceb6f1f5ede9060`
- Provider fixes: `92d82257a790be9ce78f9e29b881ec67d47f27e6`, `9f5319d82eed7b490f4edd8ddf9e789dfed3a851`
- Phase C UI: `6daeaffd2ce5226fd22261aa67814638cda711af`
- Room lock and image-only repairs: `fe35b242ddeda9640c8d3aae7651e8948252b861`, `0dea0f4fde0863222a1a27b68105dc353151401a`
- Text-only degradation: `6d481de82e2d3e92269ddbb764278189e9aa2eb0`
- Final status: completed

## Current Truth Sources

- `docs/features/F005-image-input-and-multimodal-routing.md`
- `.trellis/spec/backend/model-provider-config.md`
- `.trellis/spec/runtime/agent-runtime.md`
- Image storage, upload, routing, provider, and UI regression tests

## History Recovery

Use `git show 1a572f9:<legacy-path>` for the final legacy F005 review material, or the path-specific log for earlier stages. The archive does not preserve repeated request/verdict text because the commits and current contracts are authoritative.
