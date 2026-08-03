---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, production-ui, roles, providers, conversations, accessibility, recovery]
doc_kind: review-request
created: 2026-08-03
---

# Review Request: Model-family Production UI and Recovery Boundaries

Review-Target-ID: feat-model-family-roles-implementation  
Branch: `feat/model-family-roles-implementation`  
Exact code SHA: `fcae97faa2b7f48e8ec6c425ce4aac9ef5a5b0dc`  
Diff: `cca018f..fcae97f`

## What

- Replaces the legacy role management form with the production Role / Model Provider management shell.
- Exposes family-aware base model, thinking level and runtime Profile controls; custom roles retain Persona and Skills.
- Adds Provider create/edit/remove/clear/validate UI while keeping external `auth.json` / CLI authentication derived and read-only.
- Adds the new-conversation participant confirmation modal and existing-conversation participant/Profile settings.
- Makes existing unavailable participants recoverable through an effective valid Profile while keeping new-participant creation strict.
- Closes seven fresh-context P2 findings: stale submitted thinking, duplicate Profile IDs, unavailable-participant recovery, writable external auth, missing recent validation state, unnamed default toggle and legacy visible “人格” terminology.

## Why

Original requirements to judge this change against:

- `feature-discussions/2026-08-02-model-family-roles/README.md`: Provider configuration is a separate upstream surface; role availability consumes the configured catalog.
- The same source requires role details to expose default model, capability-aware thinking and multiple runtime Profiles.
- `feature-specs/2026-08-02-model-family-roles.md` AC 6: defaults are only preselection; users confirm the final roster before a conversation is created.
- AC 12–16: provider reads are credential-blind, family roles fail closed, and unsupported thinking is never silently clamped.
- Operator authorization: “好，现在开始落地吧”.

Operator experience: configure a Provider/model in the browser, see the corresponding family role become usable, choose defaults and Profiles honestly, and confirm the actual participant roster before creating a chat. Existing conversations must remain repairable when an old base model becomes unavailable.

## Tradeoff

- New conversations remain strict: a directory-level unavailable role cannot enter a new roster even if it has a potentially valid Profile. Existing conversations may recover an already-present participant by explicitly selecting a valid Profile. The controller passes only existing role IDs as `recoverableRoleIds`, so this exception cannot add a new unavailable participant.
- Provider validation state is session-local UI feedback, not persisted configuration truth. Reloading returns to “待验证”; this avoids inventing a durability contract for probe results.
- Shared availability labels/reasons live in `public/shared/model-options.js` so chat settings and management surfaces do not drift, at the cost of one explicit script dependency in VM/browser harnesses.

## Architecture Ownership

Architecture cell: CAFF role configuration + Provider management + conversation participant policy  
Map delta: none  
Why: this diff extends the existing `RoleService`, agents/provider APIs and existing browser surfaces. It does not add a parallel Store, Queue, Router, Adapter, Dispatcher, Binding or catalog source.

Repository note: this checkout does not provide `scripts/check-hotfix-pattern.mjs`, `scripts/check-fallback-layers.mjs`, `pnpm check:architecture-ownership` or `pnpm check:capability-tips`; the Quality Gate records them as unavailable rather than claiming fabricated passes.

## Fresh-context Findings Closed

| Finding | Resolution | Regression evidence |
|---|---|---|
| Submitted thinking could disagree with a reset UI value | `buildRolePayload()` normalizes base/Profile thinking against the selected catalog model | production UI + runtime UI tests |
| Added Profiles could reuse `profile-N` IDs | first collision-free ID generation; server rejects duplicate explicit/generated IDs with `profile_id_duplicate` | production UI + smoke tests |
| Existing unavailable participants could not be repaired | availability reason/recovery actions; removable participant; valid Profile recovery at save/runtime | Edge UI, runtime resolution, smoke PUT tests |
| `external` auth appeared writable | removed from writable mode choices; explicit read-only `auth.json / CLI` note | production Provider UI test |
| Provider list lost validation feedback | session-local pending/pass/failure status in provider index | production Provider UI test |
| Default-role toggle lacked accessible name | role-specific `aria-label` | production role UI test |
| Visible legacy “人格” terminology remained | public HTML/JS sweep to “角色”; Persona retained only for actual custom Persona fields | recursive production-source assertion |

## Failure-mode Sweep

- Scanned every handwritten Profile ID creation path and added server-side duplicate rejection rather than fixing only the first UI collision.
- Scanned chat roster creation, existing settings save and runtime resolution separately; recovery is restricted to already-present role IDs.
- Scanned public HTML/JS recursively for visible `人格`, not only the management page.
- Scanned every VM harness consuming model option helpers; both now load `public/shared/model-options.js` before consumers.
- Manually inspected new fallback branches because the repository does not contain the fallback-layer checker. No changed file adds a three-layer fallback chain.

## Quality Gate Report

### Vision and Delivery Completeness

- Full production slice: Role management, Provider management, conversation creation/settings, availability recovery and runtime enforcement are implemented. This is not a design-only handoff.
- The implementation extends the frozen architecture/UI contracts; no portion is marked stub/deferred for this review range.
- Exact code commit/PR truth: code HEAD `fcae97f`; `gh pr list --head feat/model-family-roles-implementation --state all` returned `[]` before this request.

### Automated Verification

```text
npm run check
  PASS

npm run typecheck
  PASS

npm test
  PASS; all fast suites green; smoke 64/64

node tests/ui/model-family-roles-production.test.js
  PASS production model-family roles and provider management UI contract

node tests/ui/new-conversation-dialog.test.js
  PASS production new-conversation dialog contract

git diff --check
  PASS
```

### Browser and Dogfood Evidence

Current-worktree acceptance:

- Worktree: `E:\pythonproject\caff-model-family-roles-implementation`
- URL: `http://127.0.0.1:3114/personas.html`
- Isolated temporary agentDir/SQLite; ports 3003/3004 and Redis 6399 were not used.
- Hub Browser Preview opened the production Role / Model Provider page from the exact worktree.

Actual end-to-end path:

```text
empty isolated bootstrap
  -> 7 permanent family roles, all default_model_missing
PUT /api/model-providers/acceptance-provider
  -> credential-blind GET (no apiKey field), durability=directory_sync_unsupported
  -> catalog model acceptance-provider/acceptance-qwen classified family=qwen
PUT /api/agents/role-family-qwen
  -> availability=available, isDefaultChatRole=true
POST /api/conversations
  -> persisted participant role-family-qwen
```

The model projected `supportedThinkingLevels=[off,minimal,low,medium,high]`, and the role save used an allowed value.

Fresh Edge screenshots were generated outside the repository at:

- `%TEMP%\cat-cafe-evidence\caff-model-family-roles-final\new-conversation-defaults-desktop.png`
- `%TEMP%\cat-cafe-evidence\caff-model-family-roles-final\new-conversation-empty-desktop.png`
- `%TEMP%\cat-cafe-evidence\caff-model-family-roles-final\new-conversation-mobile-375.png`

The browser contract also asserts focus entry/return, focus trap, 375px `scrollWidth === 375`, existing unavailable participant Profile recovery and strict new-conversation rejection.

### Design and Artifact Hygiene

- `designs/**/*.pen`: no matching `.pen`; the frozen HTML UI Gate is the design source.
- Root-level media/design artifacts in worktree: none.
- Root-level media/design artifacts in committed diff: none.
- Screenshots and isolated runtime data remain under `%TEMP%`, outside Git.

## Open Questions

### Technical OQ

1. Does `recoverableRoleIds` stay impossible to abuse for adding a new unavailable participant or bypassing `no_family_models`, wrong-family, missing-profile or unsupported-thinking blockers?
2. Do UI state and payload normalization agree for every base/Profile model switch, including selected values that disappear from capability options?
3. Are Profile IDs collision-free across repeated add/remove/edit cycles, with server rejection as the final boundary?
4. Can any Provider response, error, DOM state or validation status expose/write external authentication material?
5. Do chat settings give enough recovery context without allowing an unavailable participant to become silently runnable?
6. Does loading the shared model-option helper introduce any ordering or compatibility regression across production pages and VM tests?
7. Are desktop, 900px and 375px layouts, focus behavior and accessible names sufficient for the frozen UI contract?

### Value OQ

None. The operator already authorized implementation; this request asks for independent correctness/security/interaction review.

## Reviewer Sandbox

Use a detached/read-only checkout of exact SHA `fcae97f`. Suggested isolated ports: web `3201` or `3202`; never use 3003/3004 or Redis 6399. Use a temporary agentDir/SQLite store.

```powershell
npm install
npm run typecheck
npm test
$env:CAFF_UI_EVIDENCE_DIR = Join-Path ([System.IO.Path]::GetTempPath()) 'cat-cafe-evidence\model-family-review'
node tests/ui/model-family-roles-production.test.js
node tests/ui/new-conversation-dialog.test.js
```

## Next Action

Please independently review exact diff `cca018f..fcae97f` and return `APPROVE` or `REQUEST-CHANGES` for code SHA `fcae97f`, with P0/P1/P2/P3 findings and independent evidence. The review-note commit is outside the requested code diff.

[砚砚/gpt-5.6-sol🐾]
