# F004 Models.dev Catalog Import

Status: completed

## Legacy Sources

- `feature-discussions/2026-08-06-F004-models-dev-catalog/README.md`
- `feature-specs/2026-08-06-F004-models-dev-catalog-implementation-plan.md`
- `review-notes/2026-08-07-f004-*.md`
- `review-notes/2026-08-08-f004-*.md`

## Durable Outcome

F004 added a vendored models.dev snapshot, provenance-aware catalog projection, explicit provider import, runtime-safe metadata mapping, provider-only local search, and provider identity fixes. Delivery spanned PRs #57-#61.

## Delivery Evidence

- Catalog import UI: `3350b38a2b83dc845b487f5f083397e6c84b02af`
- Vendored snapshot: `94d5f342c28ab4676cc33910e8207a383be33ba6`
- Provider-only search: `b9c5af0e5772bc950c9a3d3903604b43cfc53698`
- Provider card/display identity: `09f51fbe9fe2b6e1e8a11a36efee77d3afc6c970`, `9ca33d18066710e9170ce2fd917216aea464be70`
- Final status: completed

## Current Truth Sources

- `docs/features/F004-models-dev-catalog.md`
- `.trellis/spec/backend/model-provider-config.md`
- Catalog import, provider config, HTTP, and production UI tests

## History Recovery

Use the path-specific Git log or `git show 4e66af3:<legacy-path>` to recover the final legacy process documents. Current catalog behavior is defined by current specs, code, and tests.
