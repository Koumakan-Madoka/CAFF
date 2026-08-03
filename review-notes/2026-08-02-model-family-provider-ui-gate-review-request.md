---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, roles, providers, credentials, design-gate, security]
doc_kind: review-request
created: 2026-08-02
---

# Review Request: Provider-inclusive Model-family Roles Design Gate

Review-Target-ID: model-family-roles
Branch: feat/model-family-roles
Review target SHA: `4bfd529c5ae4be602b6d1e208024b8da8e9df5f7`

## What

- Adds a first-class “模型供应商” management surface beside role management in the executable UI fixture.
- Freezes provider connection, authentication state, model-entry family classification and the resulting configured catalog ownership.
- Extends the Architecture Gate and Feature Spec with credential-blind reads, explicit secret clearing, loopback local-admin authorization and recoverable platform-aware config writes.
- Extends the real headless Edge contract for existing, external-auth, blank-draft, locked, 900px and 375px provider states while retaining chat-dialog regressions.

No production schema, API, runtime or UI implementation is included in this review target.

## Why

The operator accepted the role UI direction, then identified the remaining daily friction: concrete providers can only be configured through backend files. Provider connection is the upstream source of family availability, so the Design Gate must cover it before implementation rather than leave a disconnected backend-only workflow.

## Original Requirements

> “挺好看的，不过感觉可以顺便把前端可以配置具体的provider这个事给做了，原来CAFF只能在后台配置，怪麻烦的”

- Source message: `0001785670702728-000129-abe47e6c` in the model-family roles discussion.
- Discussion truth: `feature-discussions/2026-08-02-model-family-roles/README.md`.
- Please judge whether the provider surface removes the backend-only configuration friction without weakening secret or local-admin boundaries.

## Tradeoff

- Provider configuration is a separate management surface, not duplicated inside each family-role detail.
- v1 mutating operations are loopback local-admin only. Remote administration needs an authenticated design and is intentionally excluded.
- The browser receives configured/mode/masked state only. It cannot inspect an existing literal secret, env/command reference or external CLI credential.
- The fixture is executable design truth, not production implementation; canonical-main freshness remains a hard gate before TDD begins.

## Architecture Ownership

Architecture cell: CAFF chat role + conversation domain
Map delta: none
Why: the proposal extends the existing model configuration and role/catalog boundaries without creating a second provider store, model registry or Agent runtime.

Reviewer checks:

- Confirm the diff is consistent with `Map delta: none` and does not imply parallel Store/Registry ownership.
- Confirm `models.json provider configuration + runtime registry/env defaults -> ConfiguredModelCatalog -> family availability` has one direction and one role-facing fact source.
- Confirm read DTOs cannot expose plaintext secrets, raw env/command references or credential-bearing headers.
- Confirm mutation/clear/validate cannot be reached by LAN/CSRF and validation never executes `!command`.
- Confirm backup, atomic replacement and Windows directory-sync semantics cannot corrupt or falsely report the write.

## Open Questions

### Technical OQ

- Are credential redaction and empty-preserves/explicit-clear semantics complete for literal, env, command, external and none auth modes?
- Is the loopback Host/Origin/JSON/per-process-CSRF boundary sufficient for a v1 local-admin editor, including proxy and redirect failure modes?
- Does platform-aware atomic replacement preserve recoverability without turning unsupported Windows directory fsync into a false save failure?
- Does the fixture communicate provider -> catalog -> role availability clearly at desktop, intermediate and mobile widths?

### Value OQ

None. Operator UI acceptance remains a separate gate after peer findings are closed.

## Fresh-Context Findings

Agent: author fresh-context session `[砚砚/gpt-5.6-sol🐾]`
SHA scanned: working tree over `54fb096`
Total findings: 6 (3 P1, 3 P2)

| # | Severity | Finding | Author disposition | Status |
|---|---|---|---|---|
| FC-1 | P1 | Raw command-reference leakage in the proposed read model | Replaced with mode/configured-only read contract | Fixed in `28a7229` |
| FC-2 | P1 | LAN/CSRF could turn command and Base URL validation into RCE/SSRF | Added loopback local-admin, Host/Origin/JSON/CSRF and bounded zero-redirect validation contracts | Fixed in `28a7229` |
| FC-3 | P1 | Unsupported Windows directory fsync could falsely report a completed replacement as failed | Added platform-aware durability result including `directory_sync_unsupported` | Fixed in `28a7229` |
| FC-4 | P2 | Role catalog source wording omitted registry/env aggregation | Defined the aggregated `ConfiguredModelCatalog` as the role-facing source | Fixed in `28a7229` |
| FC-5 | P2 | Fixture lacked new-provider, external-auth and auth-none states | Added all three states plus empty editable model row | Fixed in `28a7229` |
| FC-6 | P2 | 900px fixture layout disagreed with the responsive contract | Unified CSS/docs and added real 900px browser assertions | Fixed in `28a7229` |

Formal reviewers: annotate findings as `[FC:covered]`, `[FC:new]` or `[FC:N/A]`.

### Formal UI Review Delta

Siamese independently APPROVED the UI dimension at `28a7229` and reported two non-blocking `[FC:new]` P3 findings. Both are closed in `4bfd529`:

| # | Finding | Red -> Green | Status |
|---|---|---|---|
| P3-1 | Responsive table implied two provider model-row behaviors below 1024px while CSS had one | Gate wording unified to “标签化两列”; existing 900px Edge assertion remains green | Fixed |
| P3-2 | Provider management had create/edit but no remove path or explicit v1 exclusion | Added impact-aware remove/abandon confirmation, locked-state disabling, focus restoration and API/persistence/history contracts | Fixed |

The removal confirmation names affected roles and model count. `DELETE /api/model-providers/:id` removes only the current `models.json` entry through the same backed-up atomic replacement path; it preserves role identities, history and external auth, then recalculates catalog availability without silent model fallback.

## Next Action

Return `APPROVE` or `REQUEST-CHANGES` for `4bfd529`:

- architecture/security review: provider ownership, credential boundary, local-admin authorization, validation and persistence durability;
- UI review: information architecture, masked-secret semantics, blank provider flow, responsive behavior and continuity with the accepted role UI.

## Review Sandbox

- Architecture/security path: `/tmp/cat-cafe-review/model-family-roles/opus`
- UI path: `/tmp/cat-cafe-review/model-family-roles/siamese`
- Start Command: `python -m http.server 3201 --directory designs`
- Preview: `http://127.0.0.1:3201/model-family-roles-ui-gate.html#providers`
- Ports: `web=3201`, `api=n/a`; do not use reserved 3003/3004.
- Targeted contract: `node tests/ui/model-family-roles-ui-gate.test.js`

The review target is already committed, so a detached read-only sandbox can check out `4bfd529` directly. No dependency install is required for the static fixture; repository-wide commands use the existing lockfile and installed dependencies.

## Self-Check Evidence

### Spec Compliance

| Requirement | Evidence | Status |
|---|---|---|
| Frontend provider configuration | Provider index/detail and real blank draft in executable fixture | Pass |
| Separate provider and role ownership | Same management shell, separate surfaces, one-way catalog source | Pass |
| Credential-blind reads | Empty password/reference fields; configured/mode/masked states only | Pass |
| Explicit secret deletion | Dedicated danger confirmation with focus handling | Pass |
| Local-admin security | Loopback, Host/Origin/JSON/CSRF and bounded validation contract | Pass |
| Recoverable writes | Old-snapshot backup plus platform-aware atomic replacement contract | Pass |
| Responsive behavior | Real Edge assertions at 900px and 375px with no horizontal overflow | Pass |
| Existing role/chat behavior | Existing focus trap, game switch and 375px chat regressions remain green | Pass |
| Provider removal | Existing provider impact confirmation, draft abandon path, focus return and locked-state controls | Pass |

### Dogfood-Your-Slice

Scope verdict: required because this is user-visible interactive design.

End-to-end path: Hub Browser Preview -> 模型供应商 -> existing provider -> external auth -> 添加供应商 -> 添加模型 -> return to role catalog.

Evidence:

- `http://127.0.0.1:3100/model-family-roles-ui-gate.html#providers`
- `%TEMP%/caff-model-family-ui-gate-evidence-provider/desktop-provider-final.png`
- `%TEMP%/caff-model-family-ui-gate-evidence-provider/desktop-provider-new.png`

Observed defects from fresh-context dogfood are the six findings above; all are closed in the review target.

### Verification

```text
npm test
  exit 0; test:fast + test:smoke passed on final 4bfd529

npm run check
  exit 0

npm run build
  exit 0

npm run typecheck
  exit 0

node tests/ui/model-family-roles-ui-gate.test.js
  PASS model-family roles UI Design Gate contract

git diff --check
  exit 0
```

Repository-specific architecture ownership, hotfix and fallback-layer scripts are not present. Manual diff inspection found no production Store/Registry/Router/Adapter addition and no new three-layer fallback. This is a Design Gate scope expansion, not a hotfix.

Artifact hygiene: no root-level media/design artifacts in the worktree or committed diff; no matching `.pen`; no plaintext `sk-*` pattern in the six product files. Unrelated pre-existing untracked governance files are outside this review target.

## Related Documents

- Discussion: `feature-discussions/2026-08-02-model-family-roles/README.md`
- Architecture Gate: `feature-discussions/2026-08-02-model-family-roles/architecture-gate.md`
- UI Design Gate: `feature-discussions/2026-08-02-model-family-roles/ui-design-gate.md`
- Feature Spec: `feature-specs/2026-08-02-model-family-roles.md`
- Executable fixture: `designs/model-family-roles-ui-gate.html`

[砚砚/gpt-5.6-sol🐾]
