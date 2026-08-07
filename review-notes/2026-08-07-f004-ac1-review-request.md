---
feature_ids: [F004]
topics: [review, models.dev, vendored, provenance, catalog, env-validation]
doc_kind: review-request
created: 2026-08-07
---

# Review Request: F004 AC-1 vendored models.dev snapshot

Review-Target-ID: `f004-ac1`  
Branch: `feat/f004-ac1`  
HEAD: `1a5d568f791244b2075e0a3b28309b2f9abac286`

## What

- Added the 180-provider `assets/model-catalog.json` snapshot from the official models.dev API.
- Added the upstream MIT license and a source declaration with URL, `dev` commit SHA, raw payload SHA-256, normalized-provider hash, and generation time.
- Added the asset provenance/license regression test and registered it in `test:fast`.
- Corrected env-name validation so upstream names such as `302AI_API_KEY` remain displayable without accepting whitespace/control characters.
- Updated F004 AC-1 status, dependency, open question, and timeline.

## Why

AC-1 requires an offline, reproducible catalog with independently verifiable provenance. The real upstream payload contained a numeric-leading env name that the old shell-oriented validator rejected; preserving that name is required by the catalog contract and does not expose its value.

## Original Requirements

> “Vendored snapshot” means CAFF commits a point-in-time models.dev copy with source URL, upstream commit SHA, generation date, payload hash, and MIT license; no unverified SHA/hash may be invented. Catalog metadata remains separate from `models.json`, and env values are never read or persisted.

Source: `feature-discussions/2026-08-06-F004-models-dev-catalog/README.md`; implementation plan: `feature-specs/2026-08-06-F004-models-dev-catalog-implementation-plan.md`.

Please judge whether the committed snapshot and validator preserve these operator requirements.

## Tradeoff

The snapshot is ~6.66 MB and pins one upstream commit for deterministic offline behavior. Direct `curl.exe` could not connect in this environment, but `Invoke-WebRequest` returned HTTP 200 and the commit SHA was independently read from the upstream GitHub ref; no value came from the failed curl path. Numeric-leading env names are preserved rather than normalized.

## Architecture Ownership

Architecture cell: `server/domain/models + model-provider persistence + model-providers controller + public/personas`  
Map delta: none  
Why: the change extends the existing catalog/import boundary and adds no parallel persistence or runtime registry.

## Open Questions

### Technical OQ

1. Does the validator’s revised env-name boundary correctly preserve all upstream display names while excluding unsafe control/whitespace input?
2. Do the source declaration, raw payload hash, normalized-provider hash, and copied MIT license provide sufficient provenance for the vendored asset?
3. Does the default controller path load the real snapshot without mutating `models.json` or exposing env values?

### Value OQ

None; the P1 value decision was already approved in the kickoff discussion.

## Self-check evidence

See [`2026-08-07-f004-ac1-quality-gate.md`](2026-08-07-f004-ac1-quality-gate.md). Final `npm run test:fast` exited 0 after the real-catalog dogfood fix.

## Next Action

Please perform an independent cross-family review of the asset provenance, validator change, test coverage, and F004 documentation. Record findings against HEAD `1a5d568f791244b2075e0a3b28309b2f9abac286`; do not self-approve.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/f004-ac1/{reviewer-handle}`
- Start command: `npm ci --no-audit --no-fund && npm run test:fast`
- Ports: none required (controller dogfood is an isolated in-process test)

[砚砚/gpt-5.6-sol🐾]
