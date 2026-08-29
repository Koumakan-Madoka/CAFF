---
feature_ids: [model-token-limits-ui]
topics: [model-provider, model-catalog, context-window, max-tokens, frontend, validation]
doc_kind: prd
created: 2026-08-17
branch: feat/model-token-limits-ui
base_branch: feat/dag-execution
---

# Model context and output limits UI

## Goal

Allow local administrators to inspect and edit each configured model's Pi `contextWindow` and `maxTokens` values from the existing model provider management screen, including trusted prefill from models.dev catalog imports.

## Requirements

- Project optional `contextWindow` and `maxTokens` values through `GET /api/model-providers`.
- Accept both fields in provider model patches and persist them to `models.json`.
- Render two optional positive-integer inputs per model in the provider editor.
- Empty inputs remove explicit values, meaning Pi defaults apply (`128000` context window and `16384` max output tokens).
- Show the effective value/default source in the UI without implying the model capability was auto-detected.
- Reject non-integers, non-positive values, and explicit `maxTokens > contextWindow` with stable field paths.
- Preserve unrelated model compatibility fields through patch-merge.
- Map valid models.dev `limit.context` / `limit.output` values to Pi `contextWindow` / `maxTokens` during catalog import.
- Show catalog-derived runtime limits as read-only import values with explicit provenance; missing or invalid values remain empty and use Pi defaults.
- Revalidate catalog-derived limits server-side so a modified browser payload cannot forge model capabilities.
- Re-import updates catalog-managed limits (or clears stale values when the current snapshot omits them) while preserving unrelated custom model fields.

## Cross-Layer Contract

Data flow: `models.json` -> provider projection -> browser draft -> PUT payload -> provider patch validation -> atomic `models.json` replacement.

Model fields:

- `contextWindow?: positive integer`
- `maxTokens?: positive integer`

When omitted, the UI displays Pi defaults (`128000` and `16384`) as defaults but submits an omitted value. When both are explicit, `maxTokens` must not exceed `contextWindow`. The server remains authoritative for validation.

## Validation Matrix

| Input | Expected |
| --- | --- |
| `262144 / 16384` | Persist and return both explicit values |
| both omitted | Remove explicit fields; UI labels Pi defaults |
| zero, negative, decimal, string | `422` with `provider_model_limit_invalid` at exact model field path |
| `maxTokens > contextWindow` | `422` with `provider_model_limits_inconsistent` at `maxTokens` path |
| catalog `200000 / 8192` | import writes `contextWindow: 200000`, `maxTokens: 8192` |
| catalog limit missing/invalid/inconsistent | import writes no explicit limit; re-import clears stale catalog-managed limits |
| browser sends a value different from the current catalog projection | `422` with `catalog_import_limit_mismatch` at the exact body field |

## Acceptance Criteria

- [x] Existing model values load into the two inputs.
- [x] Saving edited values round-trips through the API and `models.json`.
- [x] Clearing values restores default labeling and removes explicit keys.
- [x] Invalid values produce a visible, stable validation error.
- [x] Provider config, HTTP, and production browser UI regression tests pass.
- [x] Build, typecheck, and repository checks pass.
- [x] Catalog detail displays valid limits as read-only runtime values with snapshot provenance.
- [x] Catalog import persists trusted `limit.context` / `limit.output` mappings.
- [x] Missing or invalid catalog limits do not invent capabilities, and re-import clears stale values.
- [x] Tampered catalog limit payloads fail closed without changing `models.json`.
