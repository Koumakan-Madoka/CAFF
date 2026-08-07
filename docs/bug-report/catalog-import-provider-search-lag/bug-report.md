---
feature_ids: [F004]
topics: [catalog-import, provider-search, performance, ui]
doc_kind: bug-report
created: 2026-08-08
---

# F004 catalog import provider search lag

## Reporter and discovery

The co-creator found this during manual acceptance of `origin/main@bd2ea1b` at the isolated catalog-import UI. The search accepted both provider and model queries, and typing felt delayed enough to resemble a request-per-keystroke implementation.

## Reproduction

1. Open `/personas.html#providers` and choose **从目录导入**.
2. Type a model id/name such as `gpt-5` in the provider search field.
3. Continue typing with the full 180-provider vendored catalog loaded.

Expected:

- Search matches provider id/name only.
- Typing filters the already-loaded provider rows without replacing the input or making a network request.

Actual:

- Model id/name also makes its provider visible and auto-expands the model list.
- Every input event calls `render()`, replaces `root.innerHTML`, scans every provider and its models, and rebuilds the full catalog DOM.

## Root cause

`public/personas/catalog-import.js` mixed two responsibilities in `providerRow()`:

- provider filtering;
- model discovery through `models.some(...)` plus automatic expansion.

The input handler then called the top-level `render()` for every keystroke. Network tracing through the fetch call sites confirms that typing does **not** call `/api/model-catalog`; the lag is local CPU/DOM churn from rebuilding the 180-provider tree and recreating the focused input.

## Fix

- Limit filtering to provider id/name.
- Filter existing provider row elements in place by toggling `hidden`.
- Keep the search input node stable; remove render-time caret restoration.
- Update unit/browser acceptance contracts so model-only queries do not match providers.

## Verification

- Focused UI regression suite: `node tests/runtime/catalog-import-ui.test.js` passes 6/6.
- Browser acceptance: `node scripts/ui/verify-catalog-import.mjs` passes the desktop, mobile, import, and vendored-fallback scenarios.
- On the full 180-provider vendored catalog, a model-only query yields zero visible providers.
- The browser verifier retains the same search input DOM node and observes no additional `/api/model-catalog` request while typing character by character.
- A provider name/id query still filters correctly, and the isolated acceptance service exposes bootstrap/catalog HTTP 200 on port 3184.
