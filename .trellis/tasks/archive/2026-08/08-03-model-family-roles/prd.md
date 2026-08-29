# Model-Family Roles and Provider Management

Status: completed

## Legacy Sources

- `feature-discussions/2026-08-02-model-family-roles/`
- `feature-specs/2026-08-02-model-family-roles.md`
- `feature-specs/2026-08-03-model-family-roles-implementation-plan.md`
- `review-notes/2026-08-02-model-family-*.md`, `review-notes/2026-08-03-model-family-*.md`, and `review-notes/2026-08-04-model-catalog-*.md`
- `project-evidence/CAFF-model-family-roles-*`
- `project-reflections/2026-08-03-model-family-roles-capsule.md`

## Durable Outcome

CAFF gained provider management, explicit model-family roles, participant policies, Pi-backed model/thinking capability projection, runtime enforcement, responsive management UI, and migration compatibility. PR #50 landed as `4bbc260`; lifecycle closure was recorded by `454f828`. The final review and vision guard approved the delivered behavior.

PR #53 later narrowed user-facing model options to configured routes, preserved runtime-registry data as metadata, and fixed dark-mode styling on the management surfaces.

## Delivery Evidence

- Feature delivery: `4bbc260bd572fe5073c06daee588f87e9915f46d`
- Lifecycle closure: `454f8289949896df8e506aa673294d49f040ae14`
- Model catalog and dark-mode follow-up: `9fc0a62e5315ccd9257cfd36f48b597bab00f6b4`
- Subsequent reconciliation: `7a73aadabe3a3320dda9ddfbd1da85cb9c605fac`
- Final status: completed

## Current Truth Sources

- `.trellis/spec/backend/model-provider-config.md`
- `.trellis/spec/runtime/agent-runtime.md`
- `.trellis/spec/frontend/ui-structure.md`
- Provider, role, participant, runtime, and production UI tests

## History Recovery

The legacy gate documents remain available in Git history. Use `git show 454f828:<legacy-path>` for the lifecycle-closing version. Current tests must depend on current specs and code, not this historical archive.
