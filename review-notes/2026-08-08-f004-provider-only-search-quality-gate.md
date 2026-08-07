---
feature_ids: [F004]
topics: [quality-gate, catalog-import, provider-search, performance, ui]
doc_kind: quality-gate
created: 2026-08-08
---

# F004 Provider-Only Search Quality Gate Report

Branch: `fix/f004-provider-only-search`
Baseline HEAD: `bd2ea1b74cbd81148e4315ffe4ca0537ec773b8d`
Worktree: `E:\pythonproject\caff-acceptance-f004`

## Original requirement and root cause

Source: co-creator acceptance feedback on 2026-08-08, archived in
`docs/bug-report/catalog-import-provider-search-lag/bug-report.md`.

- The search field must match provider id/name only, not model id/name.
- Typing must remain responsive and must not behave like request-per-keystroke search.

Call-chain inspection confirmed that typing did not call a search API. The lag came from the
input handler calling the top-level `render()` on every character, replacing `root.innerHTML`,
walking providers and models, and recreating the focused search input. Model matching was a
separate product-contract error in `providerRow()`.

## Scope and vision coverage

- `public/personas/catalog-import.js` now filters pre-rendered provider rows in place using
  provider id/name data only.
- Model-only queries no longer reveal or auto-expand a provider.
- The search input node remains stable, so caret restoration code is no longer needed.
- `docs/features/F004-models-dev-catalog.md` now describes provider search followed by model
  selection instead of provider/model search.
- This is a scoped P1 acceptance correction. F004 P2/P3 remain intentionally unchanged and do
  not block this bug-fix review.

## Verification evidence

| Check | Result |
|---|---|
| TDD regression | RED observed before implementation for model-only matching and input replacement/refetch behavior; GREEN after the fix |
| `node tests/runtime/catalog-import-ui.test.js` | 6/6 pass |
| `node scripts/ui/verify-catalog-import.mjs` | 13 browser/API scenarios pass |
| 180-provider browser dogfood | model-only visible providers `0`; `/api/model-catalog` requests `1 -> 1`; input node stable; recorded sequential typing `11ms` |
| `npm run typecheck` | exit 0 |
| `npm run test:fast` | exit 0, including check/build and the catalog UI regression suite |
| `git diff --check` | clean |
| matching `designs/**/*.pen` | none; this behavior correction does not introduce a new visual design |
| root media/design artifact scan | clean |

The repository does not contain `scripts/check-hotfix-pattern.mjs` or
`scripts/check-fallback-layers.mjs`; manual diff inspection found no hotfix marker and no added
fallback layer. No store, queue, router, adapter, persistence contract, API contract, or external
dependency changed.

## Runtime and dogfood evidence

Isolated acceptance target: `http://127.0.0.1:3184/personas.html#providers`

```text
PORT=3184
PID=10064
HEAD=bd2ea1b74cbd81148e4315ffe4ca0537ec773b8d
TARGET=working-tree build with provider-only search
PROCESS_AFTER_TARGET=yes
BOOTSTRAP_HTTP=200
CATALOG_HTTP=200
PROVIDERS=180
PROVENANCE=vendored
SQLITE=%TEMP%\caff-f004-acceptance-provider-search\pi-state.sqlite
```

The Hub Browser Preview was opened directly to the provider-management route. The acceptance
service uses an isolated agent directory and SQLite database; it does not use production user
data or reserved ports 3003/3004/6399.

## Architecture ownership

Architecture cell: `server/domain/models + model-provider persistence + model-providers controller + public/personas`

Map delta: none

Why: the change narrows and accelerates an existing UI filter inside the current catalog-import
surface. It adds no ownership boundary or new state store.

## Verdict

Quality gate passed. The fix is ready for fresh-context scan and cross-family review; no self-review
or self-merge is permitted.

[砚砚/gpt-5.6-sol🐾]
