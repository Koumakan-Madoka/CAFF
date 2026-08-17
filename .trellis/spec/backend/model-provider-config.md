---
feature_ids: [model-provider-config, model-token-limits-ui]
topics: [models-json, model-provider, context-window, max-tokens, local-admin]
doc_kind: code-spec
created: 2026-08-17
---

# Model Provider Configuration

## 1. Scope / Trigger

Use this contract when changing the local-admin model provider API, `.pi-sandbox/models.json` patch behavior, or the provider editor in `public/personas/provider-editor.js`.

Data flow:

`models.json -> projectModelProviderDocument -> GET /api/model-providers -> provider editor -> PUT /api/model-providers/:id -> patchModelProvider -> atomic models.json replacement`

## 2. Signatures

- `GET /api/model-providers`
- `PUT /api/model-providers/:id`
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

## 3. Contracts

- `contextWindow` is the model's total context capacity used by Pi for prompt history, tools, system input, and output reservation.
- `maxTokens` is the maximum tokens in one model response. It is not the context capacity.
- Missing persisted values use Pi custom-provider defaults: `contextWindow=128000` and `maxTokens=16384`.
- GET projects missing values as `null`, allowing the browser to distinguish explicit configuration from Pi defaults.
- PUT accepts a positive integer to set a value and `null` to remove the explicit field.
- The provider editor shows both the effective value and its source, for example `上下文 128000（Pi 默认）`. It must not claim that a missing value was detected from the remote model.
- Model patch-merge preserves unrelated Pi fields such as `cost`, `headers`, and `compat`.
- Validation is authoritative in `server/domain/models/model-provider-config.ts`; browser validation only provides earlier feedback.

## 4. Validation & Error Matrix

| Model input | Result |
| --- | --- |
| `contextWindow: 262144`, `maxTokens: 16384` | Persist and project both integers |
| both fields omitted | Use Pi defaults and project both as `null` |
| patch field is `null` | Delete the persisted field |
| zero, negative, decimal, or string | `422`, `provider_model_limit_invalid`, exact field path |
| effective `maxTokens > contextWindow` | `422`, `provider_model_limits_inconsistent`, `...maxTokens` path |

The consistency check uses effective values. For example, explicit `contextWindow: 8192` with omitted `maxTokens` is invalid because Pi would otherwise use `maxTokens: 16384`.

## 5. Good / Base / Bad Cases

- Good: `262144 / 16384` is explicit, survives GET -> edit -> PUT -> disk, and preserves unrelated model metadata.
- Base: both inputs are empty; the UI displays Pi defaults and sends `null` so old explicit values are removed.
- Bad: the UI displays a blank field as an auto-detected 256k capability, or sends numeric strings that bypass server validation.

## 6. Tests Required

- `tests/runtime/model-provider-config.test.js`: projection, patch, clear, stable validation code/path, and compatibility-field preservation.
- `tests/http/model-providers-controller.test.js`: GET projection, PUT disk round trip, and redacted `422` issue.
- `tests/runtime/model-input-capability-ui.test.js`: input values/placeholders, source labels, numeric payload, clear payload, and client-side invalid-state blocking.
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
