---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, model-family, providers, migration, participants, runtime, ui, security]
doc_kind: review-request
created: 2026-08-03
---

# Review Request: Model-family Roles Final PR

Review-Target-ID: feat-model-family-roles-implementation
Branch: `feat/model-family-roles-implementation`
PR: `Koumakan-Madoka/CAFF#50`
Merge base: `origin/main@b9f3ddfa88b3e8942d0dd095f1dcaeb4c979d451`
Product/test HEAD before this review packet: `27f731740d5ad71e5e3d30d375b95db2fed1d965`
Review scope: the complete `origin/main...PR HEAD` diff. The exact packet-inclusive PR HEAD is supplied in the routed review request after this file is committed.

## What

- Replaces the legacy seeded system personas with seven permanent GPT, Claude, Gemini, DeepSeek, Qwen, GLM and Kimi model-family roles while preserving custom roles and historical identity.
- Adds credential-blind Provider administration, configured-model catalog projection and capability-aware base/Profile controls.
- Makes conversation participants explicit, keeps existing unavailable participants repairable, and validates family/model/Profile/thinking again before runtime work begins.
- Separates model-family identity from custom Persona/Skills and ships the production management/new-conversation/settings UI.
- Includes migration backup/audit/rollback contracts, Provider mutation serialization, CI runtime alignment and deterministic production UI readiness tests.

## Why

The feature must replace fictional fixed system personas with honest model-family roles without sacrificing custom personas, user history, provider safety or runtime correctness. Availability and defaults must remain suggestions/configuration truth rather than hidden participant or model fallback policy.

## Original Requirements

> GPT、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi 七个系统模型族角色永久存在；自定义角色继续保留 Persona 与 Skills。
> Provider 配置是独立上游 surface，角色只消费已配置模型目录。
> 默认参与者只作预选，创建会话前必须让用户确认最终 roster。
> family role 的模型、family、Profile 与 thinking 在保存、参与者和 runtime 边界 fail closed。

- 来源：`feature-discussions/2026-08-02-model-family-roles/README.md`
- 契约：`feature-specs/2026-08-02-model-family-roles.md` AC 1–16
- **请对照上面的摘录判断完整 PR 是否真正解决 operator 的问题，而不只判断测试是否通过。**

## Tradeoff

- Provider secrets are write-only/masked and never returned through read DTOs; users trade secret readback convenience for a smaller leakage surface.
- New conversations strictly reject unavailable roles. Only an already-present participant can use explicit same-family Profile recovery, preventing the recovery path from adding an unavailable role.
- Model-family roles cannot carry Persona prompts or Persona Skills. Conversation/mode skills remain available, and custom roles retain their existing Persona/Profile behavior.
- There is no silent cross-family or nearest-thinking fallback. A removed/conflicting/unsupported model produces a structured blocker before assistant placeholders or run tasks are created.
- Legacy system role IDs are retired from active configuration but retained through an identity ledger and conversation history rather than remapped to new family IDs.

## Architecture Ownership

Architecture cell: CAFF role configuration + Provider management + conversation participant/runtime policy
Map delta: none
Why: the implementation extends the existing chat store, agents/conversations APIs, Pi SDK model catalog host and production browser surfaces. It does not create a parallel Store, Queue, Router, Adapter, Dispatcher, Binding or second provider/catalog truth source.

Please verify:

- the complete diff matches `Map delta: none`;
- no parallel configuration/catalog/participant-policy source was introduced;
- storage migration and runtime enforcement remain attached to the existing canonical boundaries.

## Open Questions

### Technical OQ

1. Does the SQLite migration preserve custom roles, messages, private recipients, memory, sender identity and legacy participation history across success, rollback and restart?
2. Can any Provider DTO, error, log, DOM state, validation path or backup expose credentials, execute command auth, bypass local-admin/Origin/CSRF checks, or perform an unbounded request?
3. Can family/model/Profile/thinking validation be bypassed at save, participant recovery or runtime, including catalog changes after a conversation was created?
4. Does any conversation creation path still infer participants from interactive defaults, including bootstrap, external channels, games or direct API callers?
5. Are model-family Persona/Skills excluded without regressing custom Persona/Profile behavior, conversation/mode skills, routing or memory?
6. Are Provider mutations fully serialized through success/failure cleanup, with Add/Refresh/list/detail unable to observe or create a ghost draft while a mutation is in flight?
7. Does the production UI remain accessible and responsive at desktop, 900px and 375px, and do tests wait for the real readiness boundary rather than an early toast?
8. Do the Node `22.19.0` CI alignment and complete 103-file diff introduce any dependency, platform or documentation-truth regression?

### Value OQ

None. The operator already authorized implementation; this request is for independent full-PR correctness, security, migration and interaction review.

## Prior Review Provenance

Earlier review verdicts are historical evidence, not approval for the final PR HEAD:

- production UI APPROVE at `fcae97f`, with one P2 Provider mutation race;
- Provider mutation delta APPROVE at `6e3573b` after Red→Green closure;
- docs-only continuity APPROVE at `67f2dd8`.

After `67f2dd8`, the PR changed CI runtime configuration, normalized Markdown hygiene, and fixed a production UI test readiness race. Cloud Codex review returned only a quota-exhausted notice and produced no valid review. The requested verdict must independently cover the complete final PR HEAD.

## Next Action

Independently review the exact PR HEAD named in the routed request against `origin/main`, not only `67f2dd8..HEAD`. Return `APPROVE` or `REQUEST-CHANGES` with P0/P1/P2/P3 findings and independent evidence. Also post the logical verdict as a PR issue comment containing the covered HEAD SHA and signature; shared GitHub identity means `gh pr review --approve` is not valid.

## Review Sandbox

- Path: `E:\pythonproject\caff-roles-review-fcae97f` (existing detached/read-only reviewer worktree; fetch and detach at the exact requested HEAD before review)
- Suggested ports: `web=3201`, `api=3202`
- Never use Clowder AI ports 3003/3004 or production Redis 6399.
- Use an isolated temporary agent directory and SQLite database for acceptance.

```powershell
npm install
npm run check
npm run typecheck
npm test
node tests/ui/model-family-roles-production.test.js
node tests/ui/new-conversation-dialog.test.js
git diff --check origin/main...HEAD
```

## Self-check Evidence

Final product/test HEAD `27f7317`:

```text
npm run check                                      PASS
npm run typecheck                                  PASS
npm test                                           PASS; smoke 64/64
node tests/ui/model-family-roles-production.test.js PASS
node tests/ui/new-conversation-dialog.test.js       PASS
Provider readiness stress                           20/20 PASS
git diff --check origin/main...HEAD                 PASS
root media/design artifact gates                    0 findings
GitHub CI                                            2/2 SUCCESS
```

Browser acceptance used the real production UI with isolated temporary agentDir/SQLite data. Evidence screenshots remain outside the repository under `%TEMP%\cat-cafe-evidence\caff-model-family-roles-final\`; no runtime data or generated media was committed.

## Related Truth Sources

- `feature-discussions/2026-08-02-model-family-roles/README.md`
- `feature-discussions/2026-08-02-model-family-roles/architecture-gate.md`
- `feature-discussions/2026-08-02-model-family-roles/ui-design-gate.md`
- `feature-specs/2026-08-02-model-family-roles.md`
- `feature-specs/2026-08-03-model-family-roles-implementation-plan.md`
- `docs/bug-report/provider-management-ready-signal-test-race/bug-report.md`

[砚砚/gpt-5.6-sol🐾]
