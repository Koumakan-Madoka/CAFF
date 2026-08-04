---
feature_ids: []
topics: [skill-tests, removal, cleanup, mode-retirement]
doc_kind: plan
created: 2026-07-23
---

# Workplan: Remove CAFF Skill Tests Module

> Owner: 宪宪/@opus (glm-5.2) | Dispatch: P0 from CAFF改造指挥中心 (thread_mrxfv8tub5r1uvww)
> Reporting: state-transitions to main thread. Review: @砚砚 cross-family.

## 1. Goal & boundaries
End-to-end remove the Skill Tests product module (Skill Tests + its eval-cases reporting surface). Keep shared infra (general agent runtime, trace, a2a_tasks, chat schema). Keep existing SQLite data (no destructive migration). Keep .trellis/spec/archive historical docs for audit.

## 2. Verified scope (42 code files, NOT 157)
The "~157" count included ~106 .trellis/spec/archive historical docs (KEEP) + broad string matches. Real code footprint:

**UI (public/) — 15 files**
- `eval-cases.html`, `eval-cases.js`, `skill-tests.js`
- `skill-tests/` (11 view files): case-detail-data-view, case-detail-view, case-form-view, case-list-view, case-runs-view, chain-rail-view, environment-view, panel-state-view, run-detail-view, selected-skill-overview-view, summary-view
- `chat/skill-test-design-panel.js`

**API (server/api/) — 2 files**
- `skill-test-controller.ts`, `eval-cases-controller.ts`

**Domain (server/domain/skill-test/) — 18 files** (whole dir)
testing-doc-target, testing-doc-draft, testing-doc-auto-preview, sandbox-tool-contract, run-prompt, run-executor, run-evaluation, open-sandbox-typed-helpers, open-sandbox-runner.js, open-sandbox-factory, isolation, isolation-typed-helpers, environment-chain, environment-assets, design-service, chat-workbench-mode, chain-runner, case-schema

**Lib (lib/) — 3 files**
- `skill-test-generator.ts`, `pi-skill-test-sandbox-extension.mjs`, `pi-skill-test-sandbox-env.mjs`

**Tests — 4 delete + 3 surgical**
- DELETE: `tests/skill-test/` (3 files), `tests/runtime/pi-skill-test-sandbox-extension.test.js`
- SURGICAL (remove `skill_test_design` refs, keep test): `tests/runtime/skill-loading.test.js`, `tests/runtime/turn-orchestrator.test.js`, `tests/smoke/mode-store.test.js`

**Aux**
- `scripts/opensandbox/` (build-runtime-image scripts) — skill-only, delete
- `package.json`: `opensandbox:build-runtime-image`, `opensandbox:build-caff-image` scripts; remove skill-test files from `check` + `test:fast`; `opensandbox` npm dep becomes unused (verify no other import) → remove

## 3. Wiring / registration points (precise)
- `server/app/create-server.ts`:
  - L16 require eval-cases-controller; L25 require skill-test-controller; L42 require createConfiguredOpenSandboxFactory
  - L27 `SKILL_TEST_OPENSANDBOX_CHAT_API_URL` import (from ./config)
  - L136-151 `skillTestOpenSandboxFactory` creation
  - L455-460 `createEvalCasesController({...})` mount
  - L508-521 `createSkillTestController({...})` mount
- `server/api/conversations-controller.ts`: L30 import `isSkillTestDesignConversation`, L762 usage (READ before edit; remove skill_test_design special-case for create/participants)
- `server/app/config.ts`: `SKILL_TEST_OPENSANDBOX_CHAT_API_URL` (remove if skill-only)
- `public/index.html`: L23 script tag skill-test-design-panel.js; L48 nav 错题本 link; L205-266 skill-test-design-card section
- `public/skills.html`: L29 nav 错题本 link
- `public/app.js`: L3336/3339-3357 toggleSkillTestDesignSkillSelect; L3854-3866 new-conversation skill_test_design branch; L3290 renderSkillTestDesignCard call in renderAll
- `public/chat/conversation-list.js`: L68-69 skill_test_design badge special-case (remove; historical sessions render as generic type)

## 4. OQ answers (evidence-based)
- **OQ1 (eval-cases independence):** eval-cases is PART of the Skill Tests module. Evidence: `createEvalCasesController` has exactly 1 external caller (create-server mount); `eval_cases`/`eval_case_runs` tables referenced ONLY by the 2 controllers + migrations.ts (no third writer); nav labels the page "错题本" and co-creator listed eval-cases.* as removal targets. → Remove eval-cases controller + UI together. REMOVE table creation from `migrateChatSchema` (data preserved in existing DBs; fresh DBs won't create unused tables; no DROP).
- **OQ2 (OpenSandbox/scope/SQLite reuse):** OpenSandbox factory (`createConfiguredOpenSandboxFactory`/`resolveProviderAuthEnv`/runner/typed-helpers/sandbox-tool-contract) is SKILL-TEST-ONLY (only caller = skill-test-controller + create-server for it). skill-test scope = entire `server/domain/skill-test/` dir. SQLite: `skill_test_*` tables live in `migrateSkillTestSchema` (skill-only, only called from skill-test-controller L809); `eval_cases`/`eval_case_runs` in migrateChatSchema (kept); `a2a_tasks`/`a2a_task_events` in migrateRunSchema (shared runtime, kept). → Delete open-sandbox-* + whole skill-test domain dir; remove `migrateSkillTestSchema` function (preserves existing data; fresh DBs simply won't create unused tables).
- **OQ3 (skill_test_design historical sessions):** Stored as `chat_conversations.type='skill_test_design'` + `metadata.skillTestDesign`. Recommendation: KEEP type value in DB (no data migration). Historical sessions become normal writable conversations with old skill binding removed (message timeline renders; design panel gone; `skill-test-design-workbench` removed from participant skills via `retireSkillTestDesignMode`). Edits: remove `isSkillTestDesignConversation` import/usage in conversations-controller (server won't special-case on create — new ones can't be created since UI gone); remove badge special-case in conversation-list.js (treat as generic type). Risk: low — historical sessions still load, just no design controls.
- **OQ4 (API 退场):** All client callers (eval-cases.js, skill-tests.js, skill-tests/*.js, skill-test-design-panel.js) are deleted with the UI. NO remaining clients. → Direct 404 (router already 404s unmatched /api/ at create-server L537). No 410-Gone cycle needed.

## 5. Shared infra MUST-KEEP (do not touch)
- `lib/minimal-pi.ts`, `lib/sqlite-store.ts`, `lib/mode-store.ts`, `lib/chat-app-store.ts`, `lib/skill-registry.ts`, `lib/agent-chat-tools.ts`
- `server/domain/conversation/**`, `server/domain/runtime/**` (agent-tool-bridge, message-tool-trace), `server/domain/integrations/**`, `server/domain/undercover/**`, `server/domain/werewolf/**`
- `storage/sqlite/migrations.ts` (KEEP as-is; optionally remove `migrateSkillTestSchema` function + its eval_cases CREATE stays)
- `server/http/**`, `server/api/{conversations,agents,bootstrap,memory,metrics,modes,projects,skills,undercover,werewolf,feishu,agent-tools}-controller.ts`

## 6. Task DAG (execution order; dependencies serial, disjoint owned_paths)
NOTE: subagent (@fixer) delegation is BLOCKED in this env (kimi model unavailable). Executing directly.

- **T1 isolation+red-tests** (no deps): create git branch `remove-skill-tests`; write red tests: GET /api/skill-test/cases →404; GET /api/eval-cases →404; normal standard conversation create+load smoke (regression guard); assert skill_test_cases table still exists+rows preserved after migrateChatSchema+migrateRunSchema run (data preservation).
- **T2 UI layer** (deps: T1): delete public UI files; edit index.html, skills.html, app.js, conversation-list.js to remove entries.
- **T3 API+config** (deps: T2): edit create-server.ts (remove requires L16/25/42, factory L136-151, mounts L455-460 & L508-521, config import L27); edit config.ts; edit conversations-controller.ts (remove isSkillTestDesignConversation import L30 + usage L762); delete the 2 controller files.
- **T4 domain+lib** (deps: T3): delete server/domain/skill-test/ (18 files); delete lib/skill-test-generator.ts, lib/pi-skill-test-sandbox-*.mjs; remove migrateSkillTestSchema function from migrations.ts + its call site (already gone with controller).
- **T5 tests+scripts+package** (deps: T4): delete tests/skill-test/, tests/runtime/pi-skill-test-sandbox-extension.test.js; surgical-edit 3 tests; delete scripts/opensandbox/; edit package.json (scripts check/test:fast/opensandbox:*, dep opensandbox).
- **T6 verify** (deps: T5): npm run check; npm run build; npm run test:fast; grep/ast_grep sweep for residual `skill-test`/`eval-case`/`skill_test_design`/`createSkillTestController`/`createEvalCasesController` refs → must be ZERO in code (archive docs excluded). quality-gate.

## 7. Verification gates
- `npm run check` (syntax check all public JS, minus deleted files)
- `npm run build` (tsc compiles, no dangling imports)
- `npm run test:fast` (runtime+http+storage tests pass)
- Residual-reference sweep: 0 matches for skill-test symbols in server/lib/public/tests (archive .trellis excluded)
- Red tests from T1 go green; standard chat regression test stays green; data-preservation test confirms tables+rows intact.

## 8. Risk / open items
- 3 surgical-edit tests (skill-loading, turn-orchestrator, mode-store) reference `skill_test_design` while testing general features — must edit carefully to not break those tests' intent.
- `opensandbox` npm dep removal: verify no non-skill-test import first.
- conversations-controller.ts:762 — READ exact usage before editing (assumed: skill_test_design participant/creation special-case).
- Historical skill_test_design sessions: confirm they still load as normal writable conversations after panel removal (covered by T1 regression + manual check).
