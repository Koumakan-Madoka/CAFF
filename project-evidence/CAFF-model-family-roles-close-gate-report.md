---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [roles, model-family, providers, completion, close-gate]
doc_kind: close_gate_report
created: 2026-08-03
---

# CAFF Model-family Roles Close Gate Report

```yaml
close_gate_report:
  feature_id: CAFF-MODEL-FAMILY-ROLES
  spec_path: feature-specs/2026-08-02-model-family-roles.md
  head_sha: 4e2c532fadea62e795c1f783ed830b7a764f0f44
  delivery_merge_sha: 4bbc260bd572fe5073c06daee588f87e9915f46d
  reviewed_feature_sha: bec42b856c8e11fde690478097a4cb639d0c7424
  guardian_verdict_sha: cf34e9d0bc3a1823c6348698ca22b47d1dd1b75f
  report_date: 2026-08-03
  harness_feedback: none
  harness_feedback_reason: Normal product feature; no skill, MCP, shared rule or SOP behavior changed, the operator reported no vision mismatch, and observed quota/readiness friction was explained and closed by existing executable gates rather than a harness-level defect.

  ac_matrix:
    - ac_id: AC-1
      status: met
      evidence:
        - kind: test
          ref: tests/storage/model-family-role-migration.test.js
          description: RoleIdentity and active RoleConfig are separated while identity-bound history remains resolvable.
        - kind: test
          ref: tests/storage/chat-store.test.js
          description: Stable role IDs remain the keys used by conversations, messages, memory and role APIs.
      resolution: null

    - ac_id: AC-2
      status: met
      evidence:
        - kind: test
          ref: tests/runtime/model-family-registry.test.js
          description: Exact seven-family classification and unknown/conflict fail-closed precedence are covered.
        - kind: doc
          ref: review-notes/2026-08-03-model-family-roles-vision-guard-verdict-shuoshuo.md
          description: Merged main exposed exactly seven permanent role-family identities and enforced same-family configuration.
      resolution: null

    - ac_id: AC-3
      status: met
      evidence:
        - kind: test
          ref: tests/runtime/runtime-role-resolution.test.js
          description: Family Persona and Persona Skills never reach runtime prompt configuration.
        - kind: test
          ref: tests/smoke/server-smoke.test.js
          description: Locked family identity fields and family Persona/Profile Persona writes are rejected.
      resolution: null

    - ac_id: AC-4
      status: met
      evidence:
        - kind: test
          ref: tests/storage/chat-store.test.js
          description: Custom roles retain name, avatar, Persona, Skills, base model and Profiles across persistence and migration.
        - kind: doc
          ref: review-notes/2026-08-03-model-family-roles-vision-guard-verdict-shuoshuo.md
          description: Independent API acceptance created a custom role with Persona and a cross-family Profile.
      resolution: null

    - ac_id: AC-5
      status: met
      evidence:
        - kind: test
          ref: tests/smoke/server-smoke.test.js
          description: Multiple runnable defaults persist while unavailable roles cannot be made default.
        - kind: screenshot
          ref: project-evidence/CAFF-model-family-roles-browser/new-conversation-mobile-375.png
          description: The mobile confirmation surface projects only runnable default suggestions.
      resolution: null

    - ac_id: AC-6
      status: met
      evidence:
        - kind: test
          ref: tests/runtime/new-conversation-dialog.test.js
          description: The request builder requires an explicit non-empty final participant roster.
        - kind: test
          ref: tests/ui/new-conversation-dialog.test.js
          description: Cancel, empty selection, confirmation, focus and persistence boundaries pass in real Edge.
        - kind: doc
          ref: project-evidence/CAFF-model-family-roles-browser/model-family-roles-journey-15s.webm
          description: A 15-second merged-main recording shows the explicit new-chat confirmation surface.
      resolution: null

    - ac_id: AC-7
      status: met
      evidence:
        - kind: test
          ref: tests/storage/chat-store.test.js
          description: Default changes do not rewrite existing conversation rosters.
        - kind: test
          ref: tests/runtime/werewolf-game.test.js
          description: Game participant policy remains explicit and independent of interactive chat defaults.
        - kind: test
          ref: tests/http/feishu-controller.test.js
          description: External new-room policy is explicit and does not reuse interactive defaults or an existing room roster.
      resolution: null

    - ac_id: AC-8
      status: met
      evidence:
        - kind: test
          ref: tests/storage/model-family-role-migration.test.js
          description: All nine legacy system IDs retire, modified seeds also retire, and restart does not revive them.
        - kind: doc
          ref: review-notes/2026-08-03-model-family-roles-vision-guard-verdict-shuoshuo.md
          description: Independent real-server restart observed seven active family roles and legacy_revived:0.
      resolution: null

    - ac_id: AC-9
      status: met
      evidence:
        - kind: test
          ref: tests/storage/model-family-role-migration.test.js
          description: Count/hash/FK audits, rollback and backup recovery preserve history, messages, memory and custom roles.
        - kind: test
          ref: tests/storage/chat-store.test.js
          description: Retired role identity continues to explain conversation, message and memory history.
      resolution: null

    - ac_id: AC-10
      status: met
      evidence:
        - kind: doc
          ref: feature-discussions/2026-08-02-model-family-roles/architecture-gate.md
        - kind: doc
          ref: feature-discussions/2026-08-02-model-family-roles/ui-design-gate.md
        - kind: pr
          ref: https://github.com/Koumakan-Madoka/CAFF/pull/50
          description: PR merged with two successful unit checks after exact-final-HEAD independent review.
        - kind: doc
          ref: https://github.com/Koumakan-Madoka/CAFF/pull/50#issuecomment-5165873252
          description: Cross-family final-HEAD APPROVE; no P0/P1/new P2/new P3.
      resolution: null

    - ac_id: AC-11
      status: met
      evidence:
        - kind: test
          ref: tests/ui/new-conversation-dialog.test.js
          description: AppShell inert, initial focus, Tab/Shift+Tab trap, Escape/cancel return focus and 44px targets pass.
        - kind: screenshot
          ref: project-evidence/CAFF-model-family-roles-browser/new-conversation-mobile-375.png
        - kind: doc
          ref: project-evidence/CAFF-model-family-roles-browser/model-family-roles-journey-15s.webm
      resolution: null

    - ac_id: AC-12
      status: met
      evidence:
        - kind: test
          ref: tests/runtime/configured-model-catalog.test.js
          description: Pi registry, runtime default and models.json are the only catalog inputs consumed by roles.
        - kind: test
          ref: tests/ui/model-family-roles-production.test.js
          description: Production Provider/Role navigation, model rows, explicit family and responsive management surfaces pass.
        - kind: screenshot
          ref: project-evidence/CAFF-model-family-roles-browser/providers-desktop.png
      resolution: null

    - ac_id: AC-13
      status: met
      evidence:
        - kind: test
          ref: tests/runtime/model-provider-config.test.js
          description: Credential-blind projection, blank-preserve, explicit clear and unknown-field preservation are covered.
        - kind: test
          ref: tests/runtime/model-provider-persistence.test.js
          description: Validation, restricted backup, platform-aware atomic replacement and Windows durability result are covered.
        - kind: doc
          ref: review-notes/2026-08-03-model-family-roles-vision-guard-verdict-shuoshuo.md
          description: Independent browser/API evidence found no secret in DOM and observed explicit durability state.
      resolution: null

    - ac_id: AC-14
      status: met
      evidence:
        - kind: test
          ref: tests/http/model-providers-controller.test.js
          description: Loopback, Host, Origin, JSON and CSRF gates fail closed with redacted errors.
        - kind: test
          ref: tests/runtime/provider-validation.test.js
          description: Validation blocks unsafe addresses and command execution, pins DNS and enforces timeout/body/redirect limits.
      resolution: null

    - ac_id: AC-15
      status: met
      evidence:
        - kind: test
          ref: tests/runtime/model-provider-config.test.js
          description: Provider removal is an explicit independent operation that changes only models.json configuration.
        - kind: test
          ref: tests/runtime/runtime-role-resolution.test.js
          description: Removed model references remain explicit and unavailable rather than silently falling back.
        - kind: doc
          ref: review-notes/2026-08-03-model-family-roles-vision-guard-verdict-shuoshuo.md
          description: Independent drift acceptance observed default_model_missing with no cross-family rewrite.
      resolution: null

    - ac_id: AC-16
      status: met
      evidence:
        - kind: test
          ref: tests/runtime/runtime-role-resolution.test.js
          description: Base/Profile model and thinking capability are revalidated immediately before execution.
        - kind: test
          ref: tests/runtime/pi-model-catalog-host.test.js
          description: supportedThinkingLevels are resolved from the pinned Pi implementation rather than a CAFF table.
        - kind: test
          ref: tests/ui/model-family-roles-production.test.js
          description: Base model, capability-filtered thinking and multiple Profile controls pass in production UI.
        - kind: screenshot
          ref: project-evidence/CAFF-model-family-roles-browser/role-detail-qwen.png
      resolution: null
```

## Vision Guardian Signoff

| Field | Evidence |
| --- | --- |
| Guardian | 暹罗猫/烁烁 (`cat-mcmk1s9b`, model `k3-256k`) |
| Independence | Guardian is neither author (`cat-ir4rwo6b`) nor code reviewer (`opus`) |
| Source messages | `0001785759100206-000600-337e004c`, `0001785761177539-000601-e7b471d5` |
| Verdict commit | `cf34e9d0bc3a1823c6348698ca22b47d1dd1b75f` |
| Read set | Original requirements, Feature Spec, Architecture Gate, UI Gate, disclosure packet, merged main and production UI/runtime/migration contracts |
| Three-question verdict | The default experience now centers on model families; custom Persona capability and user history remain; Provider→catalog→role→chat recovery is usable end to end |
| Findings | P0/P1/P2/P3 none; intentional boundaries match explicit non-goals |
| Final verdict | **APPROVE — allowed to close CAFF-MODEL-FAMILY-ROLES** |

## User Journey Verification

| Journey | Step | Spec behavior | Independent evidence | Match |
| --- | ---: | --- | --- | --- |
| Primary | 1 | Add/edit Provider and family-classified models without reading secrets back | Guardian PUT/GET/DOM evidence; `providers-desktop.png` | ✅ |
| Primary | 2 | Catalog refresh drives true family availability and reasons | Guardian API acceptance and seven-role directory | ✅ |
| Primary | 3 | Configure same-family base/thinking/Profiles while custom retains Persona/Skills | Guardian 422/201 boundary probes; `role-detail-qwen.png` | ✅ |
| Primary | 4 | Defaults only preselect; final roster persists after confirmation | Guardian one-participant conversation; mobile screenshot and 15s recording | ✅ |
| Primary | 5 | Runtime drift blocks before placeholder/run and never clamps or switches family | Guardian drift probe; runtime resolution 3/3 | ✅ |
| Primary | 6 | Existing unavailable participant shows reason and repair/remove paths | Guardian conversation-settings DOM and screenshot set | ✅ |
| Migration | 1 | Backup once and rebuild identity/config/history in one transaction | Migration suite 4/4 | ✅ |
| Migration | 2 | Nine seeds do not revive; custom and user state remain | Guardian restart `legacy_revived:0`; migration audits | ✅ |
| Migration | 3 | Backup/FK/content-audit failure fails closed or rolls back | Backup-helper and audit-failure migration contracts | ✅ |

## Operator Experience Match

| Operator requirement | Delivered state | Match |
| --- | --- | --- |
| “削弱默认体验中的角色扮演属性，把 GPT、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi 七个模型族本身作为系统角色。” | Main exposes exactly seven system-managed family roles; family prompts omit Persona and cannot cross family | ✅ |
| “自定义角色继续保留现有能力。” | Custom roles retain Persona、Skills、base model and cross-family Profile Persona; migration preserves custom state | ✅ |
| “把具体 Provider 配置带到前端。” | A sibling 模型供应商 surface supports add/edit/validate/clear/remove while keeping read DTOs credential-blind and local-admin-only | ✅ |

## Requirement → Browser Evidence Mapping

| Requirement slice | Representative evidence | What it proves |
| --- | --- | --- |
| Provider configuration is visible but secrets are not | `project-evidence/CAFF-model-family-roles-browser/providers-desktop.png` | Dedicated Provider surface, model rows and masked administration state |
| Family runtime controls are capability-aware and Persona-free | `project-evidence/CAFF-model-family-roles-browser/role-detail-qwen.png` | Family role detail, same-family base/thinking/Profile controls and locked identity language |
| Explicit new-chat confirmation works on mobile | `project-evidence/CAFF-model-family-roles-browser/new-conversation-mobile-375.png` | 375px sheet, participant selection and responsive accessibility |
| The three primary UI surfaces form one usable journey | `project-evidence/CAFF-model-family-roles-browser/model-family-roles-journey-15s.webm` | Merged-main role directory → Provider surface → new-chat confirmation in an isolated 1280×720 run |

## Contract Drift Audit

| Changed contract | Adjacent consumers checked | Result |
| --- | --- | --- |
| Stable role identity is separate from active runnable configuration | Migration, repositories, RoleService, history rendering, conversation roster and memory lookups | Retired/legacy identities remain explainable; active directory and runtime use RoleConfig only |
| ConfiguredModelCatalog and family registry are the sole availability source | Provider persistence, bootstrap, RoleService save, UI selects and runtime resolution | All layers consume the same catalog snapshot and unknown/conflict options fail closed |
| Conversation creation requires explicit final participants | Standard UI, store transaction, mode/game call sites, bootstrap and Feishu `/new` | No first-three fallback or interactive-default leakage remains |
| Provider admin is credential-blind and loopback-only | Projection, local-admin guard, controller, validation probe, persistence and UI | Secrets/references stay server-side; mutation requires Host/Origin/JSON/CSRF and safe validation |
| Thinking support comes from the selected Pi catalog model | Pi host, catalog DTO, RoleService, Profile editor and runtime preflight | UI/save/runtime agree; unsupported values return 422 instead of nearest-level clamp |

## Tail Audit

- Unmet AC: none.
- Deleted or operator-signed-off AC: none.
- All acceptance work is closed within this Feature.
- Intentional loopback、session-local validation、no OAuth/market/billing/plugin/cross-family fallback boundaries are explicit non-goals, not incomplete ACs.
- Evolution: this feature evolves CAFF's legacy Agent/Persona default roster into the model-family role system; no required successor remains.

## Feature Truth Audit

- Feature Spec, discussion and implementation plan are `done` with `completed: 2026-08-03` and completion timeline/evidence links.
- `CAFF-MODEL-FAMILY-ROLES` has no `BACKLOG.md` row, so no hot-layer removal is required.
- CAFF has no corresponding `docs/features/README.md` entry for this unnumbered project feature; the three canonical documents remain permanent truth anchors.
- Reflection capsule, CloseGateReport, guardian request/verdict, three representative screenshots and the 15-second WebM exist at their linked paths.
- CAFF has no `check:features` script or `scripts/check-feature-truth.mjs`; completion uses the explicit manual truth audit above plus `git diff --check` and repository syntax/type/test gates.

## Completion Quality Gate

Fresh post-merge verification ran from detached `origin/main@4e2c532fadea62e795c1f783ed830b7a764f0f44` on 2026-08-03:

- Guardian verdict integrity: local blob `5abe1c26c037225e0da233659499888e01ae2190` exactly matches `cf34e9d:review-notes/2026-08-03-model-family-roles-vision-guard-verdict-shuoshuo.md`.
- Markdown relative-link audit: PASS across all changed completion documents.
- Artifact hygiene: PASS; no `.pen` files, no repository-root media, and all three screenshots plus the 232,576-byte WebM are present under `project-evidence/CAFF-model-family-roles-browser/`.
- `npm run check`: PASS.
- `npm run typecheck`: PASS.
- `npm test`: PASS, including the complete fast suite and smoke 64/64.
- `git diff --check`: PASS.
- Feature truth audit: PASS; all three canonical documents are `done` with `completed: 2026-08-03`, `BACKLOG.md` has no matching row, all completion evidence paths exist, and no dedicated feature-truth or hotfix/fallback checker is present in this repository.
