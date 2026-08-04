---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [roles, model-family, providers, credentials, migration, participants, runtime, ui, plan]
doc_kind: plan
created: 2026-08-03
status: done
completed: 2026-08-03
---

# CAFF Model-family Roles Implementation Plan

## Completion Status

Tasks 0–8、隔离 acceptance、全量回归、fresh-context 扫描、跨家族完整 PR review 与 merge gate 均已完成。布偶猫对 final packet-inclusive HEAD `bec42b856c8e11fde690478097a4cb639d0c7424` 明确 APPROVE，无 P0/P1/新增 P2；GitHub 两个 unit CI 与最终本地 `check`、`typecheck`、`npm test`（smoke 64/64）、生产 UI 契约、`git diff --check` 全绿。PR #50 于 2026-08-03 squash merge 至 `origin/main`（merge commit `4bbc260bd572fe5073c06daee588f87e9915f46d`）。第三独立个体烁烁在 merged main 上完成两条 User Journey 与 operator experience 全表核验并 APPROVE；CloseGateReport 逐条关闭 AC 1–16，Feature lifecycle 已完成。

## Completion Evidence

- [PR #50](https://github.com/Koumakan-Madoka/CAFF/pull/50) / delivery merge `4bbc260bd572fe5073c06daee588f87e9915f46d`.
- [Final full-PR review verdict](https://github.com/Koumakan-Madoka/CAFF/pull/50#issuecomment-5165873252) covering exact HEAD `bec42b856c8e11fde690478097a4cb639d0c7424`.
- [Vision guard APPROVE](../review-notes/2026-08-03-model-family-roles-vision-guard-verdict-shuoshuo.md), commit `cf34e9d0bc3a1823c6348698ca22b47d1dd1b75f`.
- [Close Gate Report](../project-evidence/CAFF-model-family-roles-close-gate-report.md), [reflection](../project-reflections/2026-08-03-model-family-roles-capsule.md) and [browser evidence](../project-evidence/CAFF-model-family-roles-browser/).
- All acceptance work is closed within this Feature; required successor: none.

**Feature:** CAFF-MODEL-FAMILY-ROLES — 模型族作为系统默认角色，同时保留用户自定义角色
**Goal:** 在不牺牲历史身份、用户状态与 custom Persona/Skills 的前提下，把 GPT、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi 落成能力感知、可配置、运行时 fail-closed 的系统角色，并提供 credential-blind 的本地 Provider 管理。
**Acceptance Criteria:** [Feature Spec](2026-08-02-model-family-roles.md) AC 1–16。
**Architecture:** [Architecture Gate](../feature-discussions/2026-08-02-model-family-roles/architecture-gate.md)。
**UI contract:** [UI Design Gate](../feature-discussions/2026-08-02-model-family-roles/ui-design-gate.md) 与 `designs/model-family-roles-ui-gate.html`。
**Implementation base:** exact `origin/main@b9f3ddfa88b3e8942d0dd095f1dcaeb4c979d451`。
**Implementation worktree:** `E:\pythonproject\caff-model-family-roles-implementation` / `feat/model-family-roles-implementation`。
**Tech stack:** TypeScript/CommonJS、Node ESM SDK host、better-sqlite3、plain browser JavaScript/CSS、Node test runner、真实 headless Edge acceptance。
**Frontend verification:** desktop + 900px + 375px；使用隔离 agentDir/SQLite，不接生产用户数据。

---

## Finish Line

Provider 配置可从浏览器安全维护且不读回凭据；catalog 的可见选项只由当前 `models.json` 与精确 runtime default 产生，Pi runtime registry 仅补齐可见项的标签与能力；七个 family role 永久存在并受同族模型/能力约束；custom role 保留 Persona、Skills 与跨族 Profile；旧九个系统 seed 退出活动目录但历史、记忆与发送者身份完整；新建会话必须显式确认参与者；运行前对模型、family、Profile 和 thinking 再验证，任何不可用角色都会在创建 placeholder/run 之前结构化阻断。

不建设：F241 Agent runtime/provider plugin、模型市场、计费、OAuth broker、远程 Provider 管理、旧角色归档页、自动跨族 fallback、第二套 provider 配置格式。

## Baseline Transfer Rule

实现分支只从 exact `origin/main` 创建。设计分支不整体 merge/cherry-pick；只通过路径级 `git restore --source feat/model-family-roles -- <frozen paths>` 转移下列产物：

- `feature-discussions/2026-08-02-model-family-roles/**`
- `feature-specs/2026-08-02-model-family-roles.md`
- 本实施计划
- `designs/model-family-roles-ui-gate.html`
- `tests/ui/model-family-roles-ui-gate.test.js`
- 对应 review packet

转移后先跑现有全量基线，再写第一条 RED；不得把设计分支的其他历史或环境 bootstrap 未跟踪文件带入实现分支。

## Terminal Contracts

```ts
type ModelFamily = 'gpt' | 'claude' | 'gemini' | 'deepseek' | 'qwen' | 'glm' | 'kimi';
type RoleKind = 'model_family' | 'custom';
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

type ConfiguredModelOption = {
  key: string; // provider + U+001F + model
  provider: string;
  model: string;
  label: string;
  source: 'runtime' | 'models_json';
  family: ModelFamily | null;
  familySource: 'explicit' | 'provider_alias' | 'model_alias' | 'unknown' | 'conflict';
  supportedThinkingLevels: ThinkingLevel[];
};

type RoleAvailability =
  | { status: 'available'; familyModelCount: number }
  | { status: 'no_family_models'; familyModelCount: 0 }
  | { status: 'default_model_missing'; familyModelCount: number }
  | { status: 'default_model_out_of_family'; familyModelCount: number; modelKey: string }
  | { status: 'profile_model_missing'; familyModelCount: number; profileId: string }
  | { status: 'profile_model_out_of_family'; familyModelCount: number; profileId: string }
  | { status: 'thinking_level_unsupported'; familyModelCount: number; modelKey: string; profileId?: string };
```

## Stateful Object Census

### Object 1: ProviderConfigDocument

Lifecycle owner: `server/domain/models/model-provider-config.ts` parses and patches；`model-provider-persistence.ts` is the only writer of resolved agentDir `models.json`。

| State | Event | Next | Rule |
|---|---|---|---|
| absent | GET | empty redacted document | No file is not an error and exposes no fallback write target. |
| absent | create provider | valid document | Validate the complete new document before any target write. |
| valid | GET | redacted snapshot | Never return `apiKey`, env/command reference, custom headers, or external credential material. |
| valid | update with blank/missing secret | valid | Preserve the existing raw secret byte-for-byte. |
| valid | explicit secret set | valid | Accept literal/env/command only as a mutation input; response remains redacted. |
| valid | explicit secret clear | valid | Remove only the selected provider's `apiKey` field. |
| valid | explicit provider remove | valid/absent | Remove only that `models.json` provider entry; preserve roles/history/external auth. |
| malformed | GET/mutation | rejected | Report redacted path issues; do not normalize or overwrite the file. |

Invariants:

- INV-1: The sole write target is `path.join(resolvedAgentDir, 'models.json')`; repository `.pi-sandbox` fallback is read-only unless it is that exact resolved agentDir.
- INV-2: Every successful mutation preserves unknown provider/model fields and untouched provider entries.
- INV-3: No HTTP payload, error, log, test snapshot, bootstrap state, or Git artifact contains raw secret/reference/header values.
- INV-4: Missing/blank `apiKey` means preserve; clear and provider removal are separate destructive routes.
- INV-5: Duplicate provider IDs/model IDs, invalid family values, invalid protocols, and malformed Pi schema fail before replacement.

Adversarial tests: literal/env/`${ENV}`/`!command`; command containing an inline token; blank update; mode switch without value; unknown nested fields; duplicate model IDs; malformed current file; delete non-existent provider; provider ID path encoding; secret-shaped exception text.

### Object 2: ProviderConfigReplacement

Lifecycle owner: `atomicReplaceModelConfig()` plus the one-time backup helper.

| State | Event | Next | Rule |
|---|---|---|---|
| idle | validated mutation | backing_up | Snapshot old bytes and checksum before temp creation. |
| backing_up | backup/fsync failure | failed_pre_replace | Original target remains unchanged. |
| backing_up | success | writing_temp | Backup has restricted permissions and TTL=0. |
| writing_temp | write/fsync failure | failed_pre_replace | Remove only the known temp path; retain original + backup. |
| writing_temp | same-dir rename success | replaced | Replacement is committed; never claim it can still be rolled back in-process. |
| replaced | parent fsync success | durable | Return `durable`. |
| replaced | Windows unsupported directory sync | directory_sync_unsupported | Return success with explicit reduced durability. |
| replaced | other directory sync failure | replaced_sync_failed | Return committed=true with diagnostic; do not report the write as undone. |

Invariants:

- INV-6: Validation and old-snapshot backup complete before target bytes change.
- INV-7: Temp and target are in the same directory; replacement is one rename operation, not delete-then-move.
- INV-8: Backup names never overwrite and include timestamp + SHA-256; secret-bearing backups inherit/restrict owner permissions and are never auto-deleted.
- INV-9: Windows `EPERM`/`EINVAL`/`ENOTSUP` from directory fsync is modeled separately from replacement failure.
- INV-10: Fault injection can prove target-byte identity for every pre-replace failure point.

Adversarial tests: backup collision; chmod failure; temp open/write/fsync failure; crash before rename; actual Windows replace-over-existing; directory fsync unsupported; post-replace sync error; concurrent mutation serialized by an in-process mutex with stale-snapshot rejection.

### Object 3: ConfiguredModelCatalogSnapshot

Lifecycle owner: `server/domain/models/configured-model-catalog.ts`; Pi model enumeration/capability projection executes through the repo-pinned SDK host and its nested `@earendil-works/pi-ai@0.80.10`.

| State | Event | Next | Rule |
|---|---|---|---|
| cold | bootstrap/API/runtime read | ready/error | Expose valid `models.json` entries plus the exact runtime default; use runtime registry only as metadata/capability lookup, never as a wholesale picker source and never read Agent/Profile rows. |
| ready | provider mutation | invalidated | Next read rebuilds from the newly committed file. |
| ready | role save | ready | Role references do not add options. |
| ready | runtime validation | ready/refreshed | Use current snapshot; a missing key is a blocker, not an env fallback. |
| error | config repaired | ready | Recovery requires a valid source, never stale role injection. |

Invariants:

- INV-11: `(provider,model)` is unique and source precedence is deterministic: explicit `models.json` entries are visible and augment matching Pi metadata; runtime default only adds a missing exact key; registry-only keys stay internal.
- INV-12: Family classification exists only in `model-family-registry.ts`; generic providers do not imply a family.
- INV-13: `supportedThinkingLevels` comes from Pi `getSupportedThinkingLevels(model)`, loaded relative to the actual `@earendil-works/pi-coding-agent` module; CAFF stores no model capability table.
- INV-14: Unknown/conflict options remain custom-selectable but are absent from every family-role selector.
- INV-15: Removing a provider invalidates catalog keys but never rewrites dependent RoleConfig rows.

Adversarial tests: provider/model alias conflict; anchored-vs-substring false positives; explicit family override; generic OpenRouter model; stale Agent/Profile reference; env default duplicate; no-reasoning model; all eight pinned capability snapshots including Kimi without `max` and a catalog model that legitimately supports `max`.

### Object 4: RoleIdentity

Lifecycle owner: `chat_role_identities` plus `role-service.ts`; it is a permanent, non-runnable ledger.

| State | Event | Next | Rule |
|---|---|---|---|
| absent | create custom/system family | active | Identity is inserted before active config. |
| active | edit RoleConfig | active | Identity snapshot updates only for permitted custom fields or system reconciler constants. |
| active custom | retire | retired | History is captured before active config deletion. |
| active family | delete request | active | Reject; family identities/configs are reconciled, not retired. |
| retired | startup | retired | Never resurrect, list as runnable, or reuse for a new role. |

Invariants:

- INV-16: Role IDs are permanent; custom IDs cannot use `role-family-*` and retired IDs cannot be reused.
- INV-17: Messages, private senders, memory cards, recipient ID arrays, and retired roster resolve through RoleIdentity when no active config exists.
- INV-18: The seven family IDs and locked display identity are idempotently reconciled; user-editable runtime/default fields are not overwritten.
- INV-19: The nine legacy system IDs are permanently classified `legacy_system/retired` and never seeded again.

Adversarial tests: modified legacy seed; retired custom ID recreation; delete family role; custom name/avatar change; restart reconciler; private recipient display after retirement.

### Object 5: RoleConfig

Lifecycle owner: active `chat_agents` row + `role-service.ts`.

| State | Event | Next | Rule |
|---|---|---|---|
| family available | valid runtime/default edit | family available | Same-family model/profile and supported thinking only. |
| family available | provider/model disappears | family unavailable | Persist reference; expose structured recovery reason. |
| family unavailable | valid repair | family available | No conversation row migration is needed. |
| custom active | edit | custom active | Preserve Persona, Skills, cross-family profiles, and existing fallback contract. |
| custom active | retire | absent active config | Identity/history remain. |

Invariants:

- INV-20: `role_kind/model_family` CHECKs encode family-vs-custom shape; `persona_prompt` is `NOT NULL DEFAULT ''` and must be empty for family.
- INV-21: Family locked fields, Persona, Persona Skills, profile Persona, cross-family model, and unsupported thinking are rejected with issue codes, never silently ignored.
- INV-22: `isDefaultChatRole` may be true for multiple runnable roles and affects only future interactive preselection.
- INV-23: Provider is derived from the selected catalog option; API rejects provider/model mismatches instead of accepting a hand-built pair.

Adversarial tests: system field overwrite; family Persona/Skills/profile Persona; missing base model; cross-family profile; unsupported base/profile thinking; custom empty Persona; stale custom profile; multiple defaults; default requested on unavailable role.

### Object 6: ConversationParticipants

Lifecycle owner: caller policy + `chat_conversation_agents`; the store accepts only explicit, validated, non-empty final participants.

| State | Event | Next | Rule |
|---|---|---|---|
| absent | interactive create | active roster | UI submits confirmed final participants. |
| absent | bootstrap | absent | Bootstrap is read-only and returns `selectedConversationId=null`. |
| absent | new Feishu chat | active/setup-required | Adapter supplies explicit configured `defaultRoleIds`; never reuse interactive defaults. |
| active | defaults change | active unchanged | Roster is a creation-time snapshot. |
| active | custom role retirement | active/history | Retired roster row is written, then active row is removed. |
| zero active | send | blocked | Preserve history and require explicit participant repair. |

Invariants:

- INV-24: `createConversation()` and `getOrCreateExternalConversation()` reject missing, empty, unknown, unavailable, duplicate-only, or invalid-profile rosters.
- INV-25: There is no first-three fallback in store, controller, mode, game, bootstrap, or external channel paths.
- INV-26: Mode skills merge into supplied participants without creating participants.
- INV-27: Existing external bindings keep their roster; zero runnable participants block dispatch with setup guidance.
- INV-27a: Feishu `/new` always uses the adapter's explicit new-room `defaultRoleIds` policy, even from an already bound room; it never copies that room's current roster or interactive defaults.

Adversarial tests: omitted/empty array; all IDs unknown; duplicate IDs; unavailable family role; invalid selected profile; standard/mode/game paths; Feishu `/new` without policy; existing bound room after retirement; bootstrap on empty DB writes zero rows.

### Object 7: RuntimeRoleResolution

Lifecycle owner: turn orchestration/executor before placeholder, task, session, or model invocation creation.

| State | Event | Next | Rule |
|---|---|---|---|
| pending | validate all participants | ready/blocked | Collect every unavailable role; do not partially start a turn. |
| ready | family resolve | resolved | Valid selected same-family profile, else valid same-family base, else fail. |
| ready | custom resolve | resolved/blocked | Preserve custom fallback, but an explicitly selected stale profile is an error. |
| resolved | invoke | running | Exact provider/model/thinking are sent; Pi clamp is not used as input validation. |

Invariants:

- INV-28: Runtime validation re-reads the latest catalog and runs before any durable/visible execution artifact.
- INV-29: A family role never falls back to `PI_PROVIDER/PI_MODEL`, another family, or “nearest” thinking level.
- INV-30: Family prompts omit Persona and Persona Skills unconditionally; conversation/mode Skills remain allowed.
- INV-31: Any blocked participant prevents the entire multi-agent turn and returns all role-specific recovery issues.

Adversarial tests: provider removed after conversation creation; model family reclassified; profile deleted; thinking capability changed; one of several participants invalid; no placeholder/run/task emitted; family prompt contains no Persona section; custom profile Persona still overrides.

## Implementation Dependency Chain

```text
Provider persistence + local-admin guard
  -> Pi-backed ConfiguredModelCatalog + family registry
  -> identity/schema migration
  -> RoleService + /api/agents protection/availability
  -> explicit participant policies
  -> runtime/prompt enforcement
  -> production UI
  -> full regression + isolated acceptance
```

The migration does not start until provider/catalog tests are green. Old seed deletion does not start until migration RED fixtures and backup/audit harness exist.

## Task 0: Create Exact Implementation Worktree and Baseline Evidence

**Files:** frozen artifact paths above; `project-evidence/CAFF-model-family-roles-baseline.md`.

1. Create `feat/model-family-roles-implementation` directly at `origin/main@b9f3ddf`; verify path/branch/HEAD and a clean tracked worktree.
2. Restore only frozen feature artifacts by path; record source design HEAD and reviewer APPROVE message `0001785727907116-000305-fdd2f496`.
3. Run `npm test`, `npm run typecheck`, and `git diff --check` before production edits.
4. Commit the artifact transfer/baseline evidence; do not include governance bootstrap files.

## Task 1: Provider Persistence and Local-admin HTTP RED → GREEN

**Files:** `server/domain/models/model-provider-config.ts`, `server/domain/models/model-provider-persistence.ts`, `server/domain/models/provider-validation.ts`, `server/http/local-admin-guard.ts`, `server/api/model-providers-controller.ts`, `server/app/create-server.ts`, `server/api/bootstrap-payload.ts`, `tests/runtime/model-provider-config.test.js`, `tests/http/model-providers-controller.test.js`.

1. Add RED tests for credential-blind projection, redacted-aware patching, explicit clear/remove, unknown-field preservation, schema/duplicate failures, resolved-agentDir-only writes, replacement fault injection, and actual Windows directory-sync result.
2. Add RED HTTP tests for configured host + socket loopback, exact Host/Origin, JSON content type, per-process CSRF, no CORS trust, and redacted error bodies.
3. Implement a per-server CSRF token in bootstrap and a local-admin guard. GET is loopback/Host gated; mutation/clear/remove/validate additionally require JSON + exact Origin + CSRF.
4. Implement serialized same-directory backup/temp/fsync/rename persistence with explicit durability result.
5. Add validation probe with `node:http`/`node:https`: scheme allowlist, no userinfo, DNS resolution with every address public, request lookup pinned to validated addresses, short timeout, body cap, zero redirect, no command execution, redacted status classes only.
6. Run focused tests green and commit.

## Task 2: Pi-backed Catalog and Model-family Registry RED → GREEN

**Files:** `lib/pi-sdk-host.mjs` or a narrow sibling host module, `server/domain/models/configured-model-catalog.ts`, `server/domain/models/model-family-registry.ts`, `server/api/bootstrap-payload.ts`, `server/app/create-server.ts`, `tests/runtime/configured-model-catalog.test.js`, `tests/runtime/model-family-registry.test.js`, `tests/runtime/pi-sdk-host.test.js`.

1. Add RED tests proving Agent/Profile rows cannot create catalog entries and all family precedence/conflict rules.
2. Extend the pinned SDK boundary to enumerate `ModelRuntime.getModels()` without network and load nested Pi `getSupportedThinkingLevels` relative to the resolved coding-agent module; assert package family/version in diagnostics.
3. Merge exact runtime default and valid `models.json` metadata into unique options with source, family, familySource, and supported thinking.
4. Replace bootstrap's ad hoc `buildConfiguredModelOptions()` and expose the same service to agents/provider/runtime consumers.
5. Re-run the eight-model capability truth test plus a legitimate `max` model; commit.

## Task 3: Identity and Schema Migration RED → GREEN

**Files:** `storage/sqlite/connection.ts`, `storage/sqlite/migrations.ts`, `scripts/chat-schema-backup.mjs`, `storage/chat/role-identity.repository.ts`, `storage/chat/conversation-agent-history.repository.ts`, existing chat repositories, `tests/storage/model-family-role-migration.test.js`, `tests/storage/chat-store.test.js`.

1. Build a legacy DB fixture containing all nine seeds (including a modified seed), custom roles, active rosters, public/private messages, memory, summaries, channel/external events, game metadata, skills, and profiles. Confirm RED count/hash/FK assertions.
2. Add migration detection before repository initialization. For file DBs, close the probe handle and synchronously invoke the one-time helper whose child process uses `better-sqlite3.backup()`; skip only `:memory:`. Backup failure blocks migration.
3. Add `chat_schema_migrations`, RoleIdentity, active RoleConfig columns/CHECKs, retired roster history, and rebuilt identity FKs in one exclusive transaction.
4. Backfill every existing identity; classify exact nine IDs as `legacy_system`, all other legacy rows as custom; copy retired roster before removing legacy configs/active roster rows; create seven family identities/configs.
5. Rebuild FTS triggers/indexes, run `foreign_key_check`, counts, per-role memory counts, and critical-field hashes before completing the ledger.
6. Prove rollback, restart idempotency, no seed resurrection, backup recovery, and old-binary restore procedure on an isolated copy; commit.

## Task 4: RoleService and `/api/agents` Protection RED → GREEN

**Files:** `server/domain/roles/system-role-catalog.ts`, `server/domain/roles/role-service.ts`, `lib/chat-app-store.ts`, `storage/chat/agent.repository.ts`, `server/api/agents-controller.ts`, `server/api/bootstrap-payload.ts`, `tests/storage/chat-store.test.js`, `tests/smoke/server-smoke.test.js`.

1. Add RED tests for seven idempotent family roles, custom CRUD compatibility, multiple defaults, availability payloads, locked-field rejection, family Persona/Skills/profile Persona rejection, same-family catalog enforcement, and unsupported thinking 422.
2. Move all role writes/deletes behind RoleService; keep `/api/agents` and stable `agentId`, but eliminate controller/store naked save/delete semantics.
3. Implement `retireRoleConfig()` as identity/history-first active-config removal. Family DELETE rejects; custom retirement never deletes history/memory.
4. Reconcile locked family identity on startup while preserving user runtime config/default flags.
5. Return one shared catalog/availability projection from bootstrap and `/api/agents`; commit.

## Task 5: Explicit Participant Policies RED → GREEN

**Files:** `lib/chat-app-store.ts`, `server/api/bootstrap-payload.ts`, `server/api/conversations-controller.ts`, `server/domain/integrations/feishu/feishu-service.ts`, game/mode call sites, `public/app.js`, `public/index.html`, `tests/storage/chat-store.test.js`, `tests/smoke/server-smoke.test.js`, `tests/http/feishu-controller.test.js`, existing game/mode tests.

1. Add RED tests for missing/empty/unknown/unavailable/invalid-profile rosters and empty-DB bootstrap purity.
2. Delete `pickDefaultParticipants()` and make store transactions require a validated non-empty participant list.
3. Make standard UI creation a real modal/dialog that snapshots runnable `isDefaultChatRole` suggestions, requires confirmation, and submits final participants.
4. Keep game/mode participants explicit; merge mode skills only into supplied rows.
5. Add Feishu `defaultRoleIds` adapter configuration for new rooms and `/new`; existing bindings retain roster; missing/invalid policy returns setup-required without creating a conversation.
6. Run standard/mode/game/external regression and commit.

## Task 6: Runtime and Prompt Enforcement RED → GREEN

**Files:** `server/domain/conversation/turn/agent-executor.ts`, turn orchestration/routing modules, `server/domain/conversation/turn/agent-prompt.ts`, runtime tests, smoke tests.

1. Add RED tests for pre-artifact all-participant validation, removed/reclassified models, stale profiles, changed thinking capability, and aggregated blocker payloads.
2. Resolve family model strictly from valid selected same-family profile or valid base; never call the existing env/default fallback for family roles.
3. Revalidate thinking against the current catalog immediately before run creation; custom selected stale Profile also blocks instead of silently falling back.
4. Branch prompt construction by roleKind: family omits Persona and Persona Skills; custom keeps current base/profile Persona and Skills; conversation/mode Skills remain.
5. Prove blocked turns emit no assistant placeholder, task, run, or partial sibling execution; commit.

## Task 7: Production Provider/Role UI RED → GREEN

**Files:** `public/personas.html`, `public/personas.js`, `public/shared/model-options.js`, `public/index.html`, `public/app.js`, `public/styles.css`, navigation labels in other pages, `tests/runtime/model-family-roles-ui.test.js`, existing UI Design Gate test.

1. Add production UI RED tests for provider/role surface switching, masked modes, blank-preserve, explicit clear/remove confirmations, model rows/family classification, locked family fields, custom Persona/Skills, profiles, thinking reset notice, defaults, availability, focus/inert state, and 375px width safety.
2. Implement the frozen Provider index/detail and Role directory/detail in the existing management shell; keep `/personas.html` compatibility while renaming user-facing navigation to roles/models.
3. Derive model and thinking selects only from catalog DTOs. On model change, unsupported thinking resets to inherit with an explicit toast; no nearest-level clamp.
4. Implement draft add/remove focus behavior and destructive confirmations exactly as the Design Gate.
5. Run jsdom/headless Edge contract and byte/behavior compare against the approved fixture where applicable; commit.

## Task 8: Full Regression, Migration Copy, and Isolated Acceptance

**Files:** `project-evidence/CAFF-model-family-roles-acceptance.md`, isolated fixture/backup paths outside Git, screenshots.

1. Run `npm run check`, `npm run typecheck`, `npm test`, `git diff --check`, and fallback-layer audit if the script exists.
2. On an isolated copy of a representative legacy DB, run migration, restart, count/hash/FK audit, role retirement/history rendering, and documented backup restore.
3. Start the implementation worktree on an unreserved port (not 3003/3004) with isolated agentDir/SQLite; never use Redis 6399.
4. Browser-accept desktop/900px/375px: Provider create/update/validate/clear/remove, family/custom role editing, default selection, explicit new-chat confirmation, unavailable repair, history rendering, game/mode and Feishu setup-required states.
5. Run `quality-gate` → `fresh-context-review` → cross-family `request-review`; author does not self-review.

## Commit Boundaries

Each Task lands as one or more reviewable commits with RED evidence in the commit body or adjacent evidence file. Every commit uses the required identity, contains `Why:`, and signs `[砚砚/gpt-5.6-sol🐾]`. Provider/catalog, migration, role service, participants, runtime, and UI are separate rollback units.

## Open Questions

Technical: none blocking. The one-time SQLite backup remains synchronous at the store construction boundary by using a short-lived child helper that calls the required asynchronous `better-sqlite3.backup()` and exits before the parent reopens/migrates the database; this avoids converting the entire server/store API to async.

Value: none. Operator has authorized implementation; any request to enable non-loopback Provider administration or merge this scope into F241/F247 requires a new product/security decision.

[砚砚/gpt-5.6-sol🐾]
