---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, roles, runtime, model-family, prompt, thinking, profiles]
doc_kind: review-request
created: 2026-08-03
---

# Review Request: Model-family Runtime and Prompt Enforcement

Review-Target-ID: feat-model-family-roles-implementation
Branch: feat/model-family-roles-implementation
Exact review SHA: `aec8b68`
Diff: `a027566..aec8b68`

## What

- Adds `RoleService.resolveRuntimeParticipants()` as the single runtime boundary that re-reads the current configured model catalog and aggregates every blocked participant into one `409 conversation_participants_unavailable` response.
- Revalidates family/provider/model/thinking/profile state before accepting a new message and again before main-turn or side-dispatch execution artifacts are created.
- Resolves family roles only from an exact valid same-family base/Profile model. Family roles never use environment model fallback, cross-family fallback, nearest-thinking clamp, Persona Prompt or Persona Skills.
- Preserves the existing custom-role empty-model runtime fallback, while an explicitly selected stale custom Profile blocks instead of silently becoming the base/default model.
- Preserves stale `selectedModelProfileId` values when hydrating conversations so runtime can report the actual invalid selection instead of erasing it.
- Makes the executor consume the prevalidated provider/model/thinking tuple exactly and keeps a defensive prompt-level family Persona/Persona-Skills filter.
- Wires the new runtime resolver and executor tests into the default `npm test` path.
- Closes the two nonblocking Task 5 review notes: omitted roster fields mean unchanged, and Feishu `/new` always uses adapter new-room `defaultRoleIds` rather than an existing roster or interactive defaults.

## Why

Original requirements to judge this change against:

- `feature-discussions/2026-08-02-model-family-roles/README.md`: model Profiles can bypass a base provider/model choice, so family constraints must be enforced again at runtime rather than trusted from save time.
- `feature-discussions/2026-08-02-model-family-roles/README.md`: model classification must remain centralized; runtime must consume the configured catalog rather than duplicate provider/model string rules.
- `feature-specs/2026-08-02-model-family-roles.md:164-169`: family base/Profile models must remain in-family; stale or reclassified catalog references must become understandable blockers and never silently fall back.
- `feature-specs/2026-08-02-model-family-roles.md:33`: thinking values are filtered by the selected catalog model, empty means runtime default, and unsupported explicit values must fail closed instead of being silently clamped.
- `feature-specs/2026-08-03-model-family-roles-implementation-plan.md:209-227`: validate all participants before visible/durable execution artifacts, aggregate all blockers, preserve custom fallback, block stale selected Profiles, send exact runtime settings and omit family Persona/Persona Skills.

Operator experience: when a configured provider/model/Profile stops being runnable, pressing Send must fail immediately with actionable role-specific reasons. No partial sibling run, assistant placeholder, task or model invocation may start. A model-family participant behaves as a system model identity, not as a fictional Persona; custom roles keep their existing Persona, Skills and fallback behavior.

## Tradeoff

Runtime validation intentionally reads the current role directory/catalog twice on the normal message path: once before user-message persistence, and once at turn/side-run creation. This costs a small local catalog projection but closes the configuration-change window before execution artifacts and keeps queued/recovered paths fail-closed.

The executor retains its legacy env/default branch only for call sites that do not carry `runtimeConfig`; production conversation orchestration now supplies `runtimeConfig`. This avoids breaking isolated/runtime compatibility callers while making the model-family production path exact.

## Architecture Ownership

Architecture cell: CAFF role configuration + conversation runtime execution
Map delta: none
Why: the change extends the existing `RoleService` validation boundary and existing orchestrator/executor/prompt flow; it does not create a parallel catalog, store, queue, router, dispatcher or binding.

## Open Questions

### Technical OQ

- Does every main-turn, direct-run, queued-batch and side-dispatch path validate the full roster before creating execution artifacts?
- Can any family role still reach `PI_PROVIDER/PI_MODEL`, another family, unsupported thinking, Persona Prompt or Persona Skills through a legacy executor/prompt branch?
- Does aggregating `role_missing`, reclassified/missing model, changed thinking capability and stale selected Profile retain stable paths, role IDs and recovery actions without leaking secrets?
- Is preserving stale `selectedModelProfileId` safe for all conversation hydration consumers, including games and settings surfaces?
- Does the custom empty-model fallback remain behaviorally compatible while explicit stale custom Profiles fail closed?
- Is freezing the resolved roster once per multi-agent turn the correct consistency point, or is there any existing mutation path that can change catalog/role state mid-turn and requires additional serialization?

### Value OQ

None. This review covers the authorized Task 6 slice plus Task 5 P3 closure; it does not claim the production Provider/Role UI or the whole feature is complete.

## Failure-Mode Sweep

Invariant: no runtime path may silently repair a broken family participant or partially start a multi-agent turn.

- Scanned message acceptance, queued main turns, direct main turns, side dispatch, executor setting resolution, prompt assembly and stale conversation hydration.
- Covered removed/reclassified models, changed thinking capabilities, missing roles, stale selected family/custom Profiles and multiple simultaneous blockers.
- Covered zero `chat_messages`, assistant placeholders, `a2a_tasks` and `runs` writes when validation blocks at message acceptance.
- Covered family base/Profile exact resolution, custom empty-model fallback, custom Profile Persona override, family Persona/Skills stripping and conversation Skills retention.
- Searched added fallback constructs manually because this repository does not contain `scripts/check-hotfix-pattern.mjs` or `scripts/check-fallback-layers.mjs`; no same-file three-layer fallback chain was introduced.

## Red → Green Evidence

- RED role-resolution tests first failed on reclassified models, changed capabilities, stale Profiles, aggregated issues, exact family Profiles and custom fallback.
- RED orchestration/smoke tests first observed message/task/run artifacts or missing 409 blocker payloads.
- RED executor/prompt tests first observed environment fallback and family Persona contamination.
- GREEN implementation centralizes the catalog-backed resolution in `RoleService`, calls it before artifacts, and makes executor/prompt consume the resolved role shape.
- Quality Gate found that the new focused suites were not in the aggregate test command; `package.json` was fixed before commit and the full aggregate suite was rerun.

## Self-Check Evidence

```text
npm run check
  PASS

npm run typecheck
  PASS

npm run build
  PASS

npm test
  PASS; test:fast now executes runtime-role-resolution and agent-executor-hook
  smoke 64/64

node tests/runtime/runtime-role-resolution.test.js
  PASS 2/2

node tests/runtime/agent-executor-hook.test.js
  PASS 4/4

git diff --check
  PASS
```

Dogfood path: `tests/smoke/server-smoke.test.js` starts an isolated HTTP server/store, creates a real conversation, mutates the live catalog fixture to reclassify one family model and remove another model's configured thinking capability, calls `POST /api/conversations/:id/messages`, observes aggregated HTTP 409 issues, and proves message/task/run row counts are unchanged. It separately deletes a selected Profile and proves the stale selection blocks instead of falling back.

No frontend files changed in this slice. There are no matching `.pen` files and no root-level media/design artifacts.

## Reviewer Sandbox

Use an isolated reviewer-selected detached/read-only checkout of `aec8b68`. Suggested server port: `3202` (ports 3003/3004 and Redis 6399 are forbidden).

```powershell
npm install
npm run typecheck
npm test
$env:CHAT_APP_PORT='3202'
npm start
```

Use an isolated temporary agent directory / SQLite store; do not reuse production data. No server startup is required for the code-only review because the smoke suite exercises the HTTP boundary.

## Next Action

Please independently review exact diff `a027566..aec8b68` and return `APPROVE` or `REQUEST-CHANGES` for code SHA `aec8b68`, with findings classified by severity. Please explicitly verify the Task 5 P3 closure and the six Technical OQs above. The review-note commit itself is outside the requested code diff.

[砚砚/gpt-5.6-sol🐾]
