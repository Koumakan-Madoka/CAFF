---
feature_ids: [model-provider-config, model-token-limits-ui]
topics: [models-json, model-provider, model-catalog, context-window, max-tokens, local-admin]
doc_kind: code-spec
created: 2026-08-17
---

# Model Provider Configuration

## 1. Scope / Trigger

Use this contract when changing the local-admin model provider API, `.pi-sandbox/models.json` patch behavior, or the provider editor in `public/personas/provider-editor.js`.

Data flows:

`models.json -> projectModelProviderDocument -> GET /api/model-providers -> provider editor -> PUT /api/model-providers/:id -> patchModelProvider -> atomic models.json replacement`

`models.dev snapshot limit -> projectCatalogModel -> catalog import UI -> POST /api/model-catalog/import -> trusted snapshot comparison -> patchModelProvider -> atomic models.json replacement`

## 2. Signatures

- `GET /api/model-providers`
- `PUT /api/model-providers/:id`
- `GET /api/model-catalog?providerId=<id>&modelId=<id>` returns `projection` plus `runtimeDefaults: { contextWindow, maxTokens }`
- `POST /api/model-catalog/refresh` (local-admin CSRF guard) fetches `https://models.dev/api.json` with fixed limits (15s timeout, 32MB payload cap, 2000 providers, 5000 models/provider), validates the schema, and atomically replaces the agent-dir online cache `models-dev-catalog.json`. Responses are `{status: "refreshed", provenance, providerCount}` or `{status: "not_modified", provenance, providerCount}` on an ETag `304`; upstream failures return `502`/`504` with `catalog_refresh_*` issue codes and never touch the last-known-good cache or `models.json`. `commitSha` provenance is recorded only when independently verified via the GitHub API. The mutation guard requires `Content-Type: application/json` on every admin mutation; the shared `fetchJson` client only sets that header when a body is present, so bodyless mutations (refresh) must declare it explicitly or the guard rejects with `415 provider_config_json_required`.
- `projectModelProviderDocument(document, options)`
- `patchModelProvider(document, providerId, patch)`

Each projected or patched model may contain:

```ts
{
  id: string;
  contextWindow: number | null;
  maxTokens: number | null;
}
```

The persisted `models.json` fields remain optional positive integers. `null` is an API patch instruction and is never persisted.

Catalog mapping:

```ts
limit.context -> contextWindow
limit.output -> maxTokens
```

## 3. Contracts

- `contextWindow` is the model's total context capacity used by Pi for prompt history, tools, system input, and output reservation.
- `maxTokens` is the maximum tokens in one model response. It is not the context capacity.
- Missing persisted values use Pi custom-provider defaults: `contextWindow=128000` and `maxTokens=16384`.
- GET projects missing values as `null`, allowing the browser to distinguish explicit configuration from Pi defaults.
- PUT accepts a positive integer to set a value and `null` to remove the explicit field.
- The provider editor shows both the effective value and its source, for example `上下文 128000（Pi 默认）`. It must not claim that a missing value was detected from the remote model.
- Model patch-merge preserves unrelated Pi fields such as `cost`, `headers`, and `compat`.
- Validation is authoritative in `server/domain/models/model-provider-config.ts`; browser validation only provides earlier feedback.
- `projectCatalogModelLimits` accepts only positive integer models.dev limits whose effective pair is valid under Pi defaults.
- Catalog detail renders accepted limits as read-only runtime import values. The raw `catalogMetadata.limit` remains visible for provenance, but missing or invalid values are not guessed.
- Catalog default placeholders come from the detail response's `runtimeDefaults`, which is sourced from `model-provider-config.ts`; browser literals are legacy-response fallbacks only.
- Catalog import submits the accepted values for reviewability, then the server reloads the current catalog projection and requires exact equality before writing. A mismatch is `catalog_import_limit_mismatch`.
- Re-import treats `contextWindow` and `maxTokens` as catalog-managed fields: current valid snapshot values replace old values; missing current values clear stale explicit fields. Other model fields such as `headers`, `compat`, and model-level proxy settings survive merge.
- Endpoint diagnostics (`server/domain/models/endpoint-diagnostics.ts`, browser mirror `public/shared/endpoint-diagnostics.js`) are advisory only and come in two tiers. **Verified combinations** (currently only Kimi For Coding on `api.kimi.com`, both directions: `anthropic-messages ↔ https://api.kimi.com/coding`, `openai-completions ↔ https://api.kimi.com/coding/v1`) produce a `mismatch` diagnostic with an explicit suggestion; each basis is checkable (pi's vendored registry and the vendored SDKs' path appending are pinned by mock-fetch tests, the openai-compatible URL by the current models.dev `kimi-code-plan-cn` entry). **Unverified hints**: any other `anthropic-messages` base URL ending in `/v1` yields only a `unverified` hint stating the factual request path — SDK path appending says nothing about a gateway's routing rules, so unknown endpoints never receive a guessed suggestion — and any `openai-completions` / `openai-responses` endpoint that is not a verified match yields a neutral `endpoint_not_verified` hint stating the pinned client path fact (`/chat/completions`, `/responses`), so that silence is reserved for verified matches and an unknown OpenAI endpoint cannot read as "checked and fine". Unknown dialects stay silent. Diagnostics are computed against the *effective* configuration: in the catalog projection a stored provider protocol wins over the catalog dialect (`effectiveDialect`, `dialectConflict`), stored model-level `api`/`baseUrl` overrides are surfaced separately (`modelEndpointOverride`) and keep precedence. The catalog import UI and the provider editor recompute on every edit and render a warning plus an explicit “apply suggestion” action only when a verified suggestion exists; the POST import response reports the post-import effective diagnostics (`endpointDiagnostic`, `modelEndpointDiagnostic`) and the import wizard renders them in a post-import advisory panel instead of discarding them. Raw catalog values and existing `models.json` entries are never rewritten silently, and there is no migration for stored configurations.

## 4. Validation & Error Matrix

| Model input | Result |
| --- | --- |
| `contextWindow: 262144`, `maxTokens: 16384` | Persist and project both integers |
| both fields omitted | Use Pi defaults and project both as `null` |
| patch field is `null` | Delete the persisted field |
| zero, negative, decimal, or string | `422`, `provider_model_limit_invalid`, exact field path |
| effective `maxTokens > contextWindow` | `422`, `provider_model_limits_inconsistent`, `...maxTokens` path |
| catalog `limit.context=200000`, `limit.output=8192` | project and import `200000 / 8192` |
| catalog limit is missing, non-integer, non-positive, or effectively inconsistent | omit that runtime projection; import does not invent a value |
| re-import after current catalog removes both limits | clear stale persisted `contextWindow` / `maxTokens` |
| import body limit differs from current catalog projection | `422`, `catalog_import_limit_mismatch`, exact `body.<field>` path |

The consistency check uses effective values. For example, explicit `contextWindow: 8192` with omitted `maxTokens` is invalid because Pi would otherwise use `maxTokens: 16384`.

## 5. Good / Base / Bad Cases

- Good: `262144 / 16384` is explicit, survives GET -> edit -> PUT -> disk, and preserves unrelated model metadata.
- Base: both inputs are empty; the UI displays Pi defaults and sends `null` so old explicit values are removed.
- Bad: the UI displays a blank field as an auto-detected 256k capability, sends numeric strings that bypass server validation, or trusts a browser-edited catalog limit without comparing it to the current server snapshot.

## 6. Tests Required

- `tests/runtime/model-provider-config.test.js`: projection, patch, clear, stable validation code/path, and compatibility-field preservation.
- `tests/http/model-providers-controller.test.js`: GET projection, PUT disk round trip, and redacted `422` issue.
- `tests/runtime/model-input-capability-ui.test.js`: input values/placeholders, source labels, numeric payload, clear payload, and client-side invalid-state blocking.
- `tests/runtime/models-dev-import.test.js`: positive-integer mapping, partial mapping with Pi defaults, and invalid/inconsistent omission.
- `tests/runtime/endpoint-diagnostics.test.js`: the verified Kimi For Coding combinations in both directions, the unverified anthropic `/v1` hint (never a suggestion) for custom gateways, the neutral `endpoint_not_verified` hint for unknown OpenAI endpoints, negative cases for unknown inputs, mock-fetch pins of the vendored Anthropic `/v1/messages`, OpenAI `/chat/completions`, and OpenAI `/responses` path appends, a pin of pi's vendored kimi-coding registry entry, and browser-mirror symmetry across the decision matrix.
- `tests/runtime/catalog-import-ui.test.js` and `tests/runtime/provider-editor-ui.test.js`: diagnostic rendering against the effective dialect, explicit-apply behavior, reverse-direction suggestions after a protocol switch, stale-suggestion guards, dialect-conflict and model-override surfacing, the post-import advisory panel, neutral hints for unverified OpenAI endpoints, and custom-gateway no-suggestion guarantees.
- `tests/http/model-catalog-controller.test.js`: projection (including stored-protocol/model-override context), trusted import persistence with post-import advisory diagnostics, tamper rejection, stale-value clearing, custom-field preservation, and online refresh (cache write, index serving, CSRF, 502/504 mapping).
- `tests/runtime/models-dev-online-refresh.test.js`: ETag conditional requests, 304 last-known-good retention, invalid-payload/limit/timeout failures, and commitSha verification fallback.
- `tests/runtime/catalog-import-ui.test.js`: read-only prefill, provenance copy, submitted numeric values, missing-limit default copy, and the explicit `Content-Type` header on the bodyless refresh mutation.
- `tests/ui/model-family-roles-production.test.js`: production browser interaction and responsive provider model grid.
- Run `npm run check`, `npm run typecheck`, and `npm run build`.

## 7. Wrong vs Correct

### Wrong

```js
model.contextWindow = input.value; // Persists a numeric string.
copy.textContent = '模型支持 256k'; // Claims remote capability detection.
```

### Correct

```js
model.contextWindow = input.value === '' ? null : Number(input.value);
copy.textContent = '上下文 128000（Pi 默认）';
```
