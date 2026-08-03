---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [roles, model-family, providers, migration, ui, reflection]
doc_kind: reflection
created: 2026-08-03
---

# CAFF Model-family Roles — Reflection Capsule

## Outcome

CAFF now treats GPT、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi as seven permanent system roles instead of shipping a default roster of fictional personas. Provider configuration is a credential-blind local-admin surface; a single Pi-backed catalog drives family availability; custom roles retain Persona、Skills and cross-family Profiles; old system seeds retire without deleting user history; new chats persist only an explicitly confirmed roster; and runtime drift fails closed before visible execution artifacts. PR #50 merged as `4bbc260`; independent full-PR review covered `bec42b8`; merged-main vision guard APPROVE is recorded in `cf34e9d`.

## What Worked

- Architecture and UI Gates froze the identity/history boundary, catalog ownership, local-admin security model and interaction contract before production implementation.
- The task chain kept Provider persistence、catalog、migration、RoleService、participants、runtime and UI as separate rollback units with RED→GREEN evidence.
- RoleIdentity / RoleConfig separation removed the data-loss risk instead of hiding old seeds or mapping them onto new family identities.
- The implementation derived thinking capability from the pinned Pi runtime boundary; after one bad fixture was found, the team swept every handwritten capability snapshot rather than patching only Kimi.
- Browser acceptance at desktop、900px and 375px caught behavior that source and jsdom review alone could not prove, including focus ownership and responsive management surfaces.
- Cloud Codex review quota was unavailable, but the five-slice local review chain, exact-final-HEAD delta audit, full gates and third-cat vision guard preserved independent coverage and traceability.

## What Failed

- The first Kimi fixture claimed `max` support from memory rather than the pinned nested Pi package truth. The correction required a model-by-model capability sweep.
- Provider save→add→cancel exposed a real ownership race: the UI allowed a second mutation while the first server-truth projection was still in flight, producing a ghost draft row.
- CI initially used Node 20 while the repository runtime contract required Node `>=22.19.0`; local green runs did not represent the GitHub environment until the workflow was aligned.
- A production UI test treated toast visibility as completion even though the mutation lock released later in `finally`; the correct readiness boundary was `disabled=false && aria-busy=false`.
- The completion evidence recorder repeated the same early-signal mistake after navigation by waiting for a static button node before deferred `app.js` had bound events. The failed run produced no partial video; a readiness-gated rerun succeeded.

## Trigger Missed

Two classes of trigger were initially missed. First, capability fixtures must be resolved from the pinned runtime implementation, never inferred from a model name or remembered support table. Second, UI readiness must follow the owner of the state transition: a request record、toast or parsed DOM node is only an observation, not proof that mutation ownership or deferred initialization has completed. The final implementation and tests now wait on domain readiness signals rather than presentation-side early signals.

## Doc Links

- [Feature spec](../feature-specs/2026-08-02-model-family-roles.md)
- [Kickoff and Design Gate](../feature-discussions/2026-08-02-model-family-roles/README.md)
- [Architecture Gate](../feature-discussions/2026-08-02-model-family-roles/architecture-gate.md)
- [UI Design Gate](../feature-discussions/2026-08-02-model-family-roles/ui-design-gate.md)
- [Implementation plan](../feature-specs/2026-08-03-model-family-roles-implementation-plan.md)
- [Final PR review packet](../review-notes/2026-08-03-model-family-final-pr-review-request.md)
- [Vision guard request](../review-notes/2026-08-03-model-family-roles-vision-guard-request.md)
- [Vision guard verdict](../review-notes/2026-08-03-model-family-roles-vision-guard-verdict-shuoshuo.md)
- [Close Gate Report](../project-evidence/CAFF-model-family-roles-close-gate-report.md)
- [Provider mutation race report](../docs/bug-report/model-provider-save-add-race/bug-report.md)
- [Provider readiness test-race report](../docs/bug-report/provider-management-ready-signal-test-race/bug-report.md)
- [CI Node engine drift report](../docs/bug-report/ci-node-engine-drift/bug-report.md)

## Rule Update Target

None. Existing root-cause-first debugging、TDD、real-browser acceptance、exact-runtime source verification、cross-individual review and vision-guardian rules found and contained every failure. Durable prevention is already encoded in the Node 22.19 workflow pin, Pi capability truth tests, serialized Provider mutation lock, readiness assertions and retained browser evidence; adding another governance layer would duplicate those executable contracts.
