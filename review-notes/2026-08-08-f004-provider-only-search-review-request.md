---
feature_ids: [F004]
topics: [review-request, catalog-import, provider-search, performance, ui]
doc_kind: review-request
created: 2026-08-08
---

# Review Request: F004 provider-only catalog search

Review-Target-ID: f004
Branch: `fix/f004-provider-only-search`
Review HEAD: `f743c89`

## What

- Limit catalog-import search to provider id/name; model id/name no longer produces a provider hit.
- Replace per-keystroke top-level `render()` with in-place `hidden` class toggling on existing provider rows.
- Keep the search input DOM node stable and remove render-time caret restoration.
- Add focused unit coverage and a real-browser 180-provider assertion proving zero model-only hits,
  stable input identity, and no extra `/api/model-catalog` request while typing.
- Correct the F004 user journey and archive the root-cause/verification evidence.

## Why

The co-creator found during acceptance that the field behaved like an unfinished hybrid provider/model
search and that every character felt delayed. Call-chain inspection showed no request-per-keystroke API;
the delay was local DOM churn from rebuilding the complete provider/model tree on every input event.

## Original Requirements

> - This field is a provider search, so it must search providers only.
> - A model id/name such as `gpt-5` must not make a provider appear.
> - Typing must not feel like a remote search request is issued for every character.
> - The already-loaded catalog should be filtered locally and responsively.
> - The fix must be demonstrated in the actual acceptance UI, not only inferred from code.

- Source: `docs/bug-report/catalog-import-provider-search-lag/bug-report.md`, transcribed from the
  co-creator acceptance feedback on 2026-08-08.
- Reviewer: please judge the delivery against the operator experience above, not the superseded
  provider/model wording that this commit removes from the F004 user journey.

## Tradeoff

Catalog search no longer doubles as model discovery. The operator first filters/selects a provider,
then expands that provider to choose a model. A normalized `data-catalog-search` string is duplicated
on each of 180 rows to keep filtering local and avoid reconstructing the DOM.

## Architecture Ownership

Architecture cell: `server/domain/models + model-provider persistence + model-providers controller + public/personas`

Map delta: none

Why: this narrows and accelerates an existing UI filter inside the current catalog-import surface;
it adds no store, queue, router, adapter, dispatcher, binding, persistence path, or API contract.

Reviewer checks:

- Confirm the diff matches `Map delta: none`.
- Confirm no parallel ownership boundary or new state store was introduced.
- Confirm the product change remains limited to the catalog-import search path.

## Open Questions

### Technical OQ

1. Does storing the normalized provider id/name in `data-catalog-search` remain correct for escaped
   provider names and DOM dataset decoding?
2. Do `providerRow()` initial rendering and `applyProviderFilter()` subsequent input events implement
   identical provider-only visibility semantics?
3. Does retaining the current selected-model projection while its provider row is filtered out preserve
   editing context without creating a correctness or accessibility defect?
4. Does the browser verifier genuinely lock request count and input identity on the full 180-provider
   vendored catalog?

### Value OQ

None. The co-creator explicitly selected provider-only search; no product tradeoff remains to escalate.

## Fresh-Context Findings

Agent: `[布偶猫/宪宪/deepseek-v4-flash🐾]`
SHA scanned: `f743c89`
Total findings: 3 (0 P1, 0 P2, 3 P3)

| # | Finding | Author disposition | Status |
|---|---|---|---|
| FC-1 | A selected provider row can become hidden while its expanded state/projection remains selected | Dismissed: list filtering intentionally does not destroy or hide the active model-edit projection; synchronizing only `aria-expanded` would misrepresent the retained state and clearing the filter restores the row consistently | Closed |
| FC-2 | A later non-input `render()` writes the normalized lowercase filter value back to the field | Dismissed: pre-existing render behavior, outside the reported provider-only/per-keystroke defect; fixing raw-query preservation would add a second state variable without acceptance value | Closed |
| FC-3 | `data-catalog-search` duplicates normalized provider id/name in the DOM | Dismissed: intentional bounded tradeoff for local in-place filtering; 180 rows are covered by browser dogfood and escaping round-trip was independently verified | Closed |

Reviewer delta tracking: mark formal findings `[FC:covered]`, `[FC:new]`, or `[FC:N/A]`.

## Next Action

Perform a formal cross-family review of `f743c89`. Return `APPROVE` or `REQUEST-CHANGES`, identify any
P1/P2 findings, and independently rerun the focused UI test plus the browser verifier. This request and
the fresh-context scan do not constitute approval.

## Review Sandbox

- Path: `C:\Users\ZN\AppData\Local\Temp\cat-cafe-review\f004\shuoshuo`
- Bootstrap: clear inherited `NODE_ENV`, then run `npm ci --include=dev --no-audit --no-fund`
- Validation: `npm run build`, `node tests/runtime/catalog-import-ui.test.js`,
  `node scripts/ui/verify-catalog-import.mjs`, `npm run typecheck`, `npm run test:fast`
- Optional manual app: set isolated `PI_CODING_AGENT_DIR`/`PI_SQLITE_PATH`, then run the built app on
  port `3185` (`web=3185`, `api=3185`; CAFF uses one HTTP server). Do not use 3003/3004/6399.

## Self-check evidence

### Spec compliance

Quality gate: `review-notes/2026-08-08-f004-provider-only-search-quality-gate.md`.

- Original acceptance feedback is reproduced and tied to the bug report.
- F004 user journey now says provider id/name search followed by explicit model selection.
- Architecture map delta is none; F004 P2/P3 remain unchanged and are not presented as complete.
- No matching `.pen` design exists; this is behavior/performance correction, not visual redesign.
- Root-directory media/design artifact scans are clean.

### Fresh verification

```text
node tests/runtime/catalog-import-ui.test.js
  6/6 pass

node scripts/ui/verify-catalog-import.mjs
  13/13 pass
  180-provider model query: visibleProviders=0
  catalogRequests=1->1
  inputStable=true

npm run typecheck
  exit 0

npm run test:fast
  exit 0

git diff --check
  clean
```

### Live acceptance

- URL: `http://127.0.0.1:3184/personas.html#providers`
- Isolated SQLite: `%TEMP%\caff-f004-acceptance-provider-search\pi-state.sqlite`
- HTTP: bootstrap `200`, model catalog `200`, vendored providers `180`

[砚砚/gpt-5.6-sol🐾]
