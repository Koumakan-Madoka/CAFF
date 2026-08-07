---
feature_ids: [F004]
topics: [quality-gate, models.dev, vendored, provenance, catalog, env-validation]
doc_kind: quality-gate
created: 2026-08-07
---

# F004 AC-1 Quality Gate Report

Branch: `feat/f004-ac1`
HEAD: `1a5d568f791244b2075e0a3b28309b2f9abac286`
Worktree: `E:\pythonproject\caff-f004-ac1`

## Original requirements and vision coverage

Source: `feature-discussions/2026-08-06-F004-models-dev-catalog/README.md` (vendored snapshot explanation and P1 approval).

- The operator needs a reproducible models.dev catalog that works offline and records its exact source.
- Catalog metadata must remain separate from the CAFF `models.json` runtime contract.
- Environment variable names may be displayed, but values must never be read, uploaded, logged, or persisted.
- Missing upstream verification must block the snapshot; no SHA or hash may be fabricated.

AC-1 is now covered by `assets/model-catalog.json`, `assets/model-catalog.LICENSE`, `assets/model-catalog.SOURCE.md`, and the reproducibility test.

## Verification evidence

| Check | Result |
|---|---|
| `npm run check` | exit 0 (included in final `test:fast`) |
| `npm run build` | exit 0 (included in final `test:fast`) |
| `node tests/runtime/models-dev-catalog-asset.test.js` | 1/1 pass |
| `node tests/runtime/models-dev-import.test.js` | 6/6 pass |
| `node tests/runtime/models-dev-catalog-cache.test.js` | 3/3 pass |
| `node tests/http/model-catalog-controller.test.js` | 6/6 pass |
| `npm run test:fast` | exit 0, 33s |
| Default controller dogfood | HTTP 200, 180 providers, no injected catalog document |
| `git diff --check` and root-media scan | clean; no root media/design artifacts |

Dogfood initially exposed `catalog_env_invalid` for upstream `302AI_API_KEY`. The validator was corrected to preserve numeric-leading upstream names while still rejecting whitespace/control characters; the focused tests, dogfood, and final full gate were rerun successfully.

## Architecture ownership

Architecture cell: `server/domain/models + model-provider persistence + model-providers controller + public/personas`
Map delta: none
Why: this adds the vendored source and validation coverage inside the existing catalog/import boundary; it introduces no parallel store, queue, router, adapter, or runtime registry.

## Dogfood-Your-Slice

Required because the vendored asset changes the default user-visible catalog route. The isolated controller invocation with no `catalogDocument` option returned:

```json
{"handled":true,"statusCode":200,"providers":180,"firstProvider":"zhipuai"}
```

No environment-variable values were read or included in the response.

## Verdict

Quality gate passed. AC-1 is implementation-complete and ready for cross-family review; feature status remains `review-ready` until that review and merge gate complete.

[砚砚/gpt-5.6-sol🐾]
