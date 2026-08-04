# Skill Testing Framework

## Overview

The skill testing framework verifies skill behavior across two loading modes and persists run-level evidence for regression.

Core capabilities:

1. **Dynamic mode load verification**: confirms the agent loads the target skill (`read` on `/skills/<skillId>/SKILL.md`)
2. **Full mode execution evaluation**: step-level + constraint-level + dimension scoring + aggregated verdict
3. **Draft-first generation**: AI-generated cases are persisted as editable drafts (no auto-run)
4. **Structured validation**: all save/run/judge paths emit canonical `issues[]` and `caseSchemaStatus`
5. **Regression tracking**: buckets by `provider/model/promptVersion` for skill-level and case-level views

## Architecture

### Data Model

```sql
CREATE TABLE skill_test_cases (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  eval_case_id TEXT,
  test_type TEXT NOT NULL DEFAULT 'trigger',
  loading_mode TEXT NOT NULL DEFAULT 'dynamic',
  trigger_prompt TEXT NOT NULL,
  expected_tools_json TEXT NOT NULL DEFAULT '[]',
  expected_behavior TEXT NOT NULL DEFAULT '',
  validity_status TEXT NOT NULL DEFAULT 'pending',
  case_status TEXT NOT NULL DEFAULT 'draft',
  expected_goal TEXT NOT NULL DEFAULT '',
  expected_steps_json TEXT NOT NULL DEFAULT '[]',
  expected_sequence_json TEXT NOT NULL DEFAULT '[]',
  evaluation_rubric_json TEXT NOT NULL DEFAULT '{}',
  environment_config_json TEXT NOT NULL DEFAULT '{}',
  generation_provider TEXT NOT NULL DEFAULT '',
  generation_model TEXT NOT NULL DEFAULT '',
  generation_created_at TEXT NOT NULL DEFAULT '',
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE skill_test_runs (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  eval_case_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  actual_tools_json TEXT NOT NULL DEFAULT '[]',
  tool_accuracy REAL,
  trigger_passed INTEGER,
  execution_passed INTEGER,
  required_step_completion_rate REAL,
  step_completion_rate REAL,
  required_tool_coverage REAL,
  tool_call_success_rate REAL,
  tool_error_rate REAL,
  sequence_adherence REAL,
  goal_achievement REAL,
  instruction_adherence REAL,
  verdict TEXT DEFAULT '',
  evaluation_json TEXT NOT NULL DEFAULT '{}',
  environment_status TEXT DEFAULT '',
  environment_phase TEXT DEFAULT '',
  error_message TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (test_case_id) REFERENCES skill_test_cases(id)
);
```

### Eval-Case Integration

```
skill_test_cases (1) ──→ (N) skill_test_runs
       │                        │
       │ eval_case_id           │ eval_case_run_id
       ▼                        ▼
   eval_cases (1) ──→ (N) eval_case_runs
```

- Each skill test case links to one `eval_case`.
- Each skill test run links to one `eval_case_run`.
- `server/api/skill-test-controller.ts` must ensure dependent chat/run/skill-test schema migrations before handlers touch `eval_cases`, `eval_case_runs`, or run-debug tables on the shared store DB.
- `eval_case_runs.prompt_version` is the regression bucket key with provider/model.

### Isolation Contract (MVP)

Skill-test execution now supports an explicit isolation layer before the pi run starts.

- `legacy-local`:
  - keeps the pre-existing host/shared behavior for explicit local debugging
  - must be marked as `notIsolated = true`
  - cannot be treated as publish-gate evidence
- `isolated`:
  - requires an isolation driver (preferred backend: `OpenSandbox`)
  - creates a case-scoped writable world: sandbox dirs, project root, SQLite/chat store, skill snapshot, and audit evidence
  - default execution is `host-loop + sandbox-tools`: the agent loop, orchestration, live events, chat bridge, and result persistence stay on the host, while file and command side effects are delegated into the sandbox case world
  - the env/config-backed `OpenSandbox` adapter may still expose a sandbox-side `startRun(...)` compatibility path, but that is no longer the default skill-test execution chain
  - sandbox direct-HTTP bridge POCs must use an explicitly reachable CAFF base URL (`CHAT_APP_ADVERTISE_URL` or `CAFF_SKILL_TEST_OPENSANDBOX_CHAT_API_URL`) instead of assuming `127.0.0.1` inside the sandbox maps back to the host service
  - default server wiring may opt into an env/config-backed `OpenSandbox` adapter; isolated publish-gate paths must fail closed when that driver is unavailable

Case-scoped isolation payload is stored under `evaluation_json.isolation` and surfaced from run-detail endpoints. The payload includes:

- `mode`, `notIsolated`, `publishGate`, `driver.{name,version}`, `sandboxId`, `runId`, `caseId`
- `trellisMode` (`none | fixture | readonlySnapshot | liveExplicit`)
- `egressMode`
- `execution.{runtime,loopRuntime,toolRuntime,pathSemantics,preparedOnly,reason}` where `runtime` is a compatibility projection, `loopRuntime` captures where the agent loop ran, `toolRuntime` captures where file or command side effects ran, and `pathSemantics` captures whether the agent saw host or sandbox path/cwd semantics
- sandbox adapters may still keep an internal `startRun(...)` compatibility hook, but that adapter detail is not part of the public execution evidence contract
- host-loop isolated runs may expose `CAFF_SKILL_TEST_VISIBLE_*` envs (project, sandbox, private, skill, root, output, sqlite) so runtime extensions and trace mapping can prefer sandbox-visible paths without changing the host loop's real filesystem cwd
- `egress.{mode,enforced,scope,reason}` so record-only network policy requests stay explicit in evidence
- `chatBridge.{mode,configured,configuredUrl,reachable,auth,rejects}` so sandbox direct-HTTP bridge POCs show whether case-scoped credentials were validated; the auth payload must include run/case/task binding and TTL metadata but never the callback token
- Skill-test chat bridge credentials default to 600s for short trigger/dynamic runs and 3600s for `full + execution` / chain steps; `CAFF_SKILL_TEST_BRIDGE_TOKEN_TTL_SEC` overrides the short-run default, while `CAFF_SKILL_TEST_EXECUTION_BRIDGE_TOKEN_TTL_SEC` overrides long execution runs explicitly
- `toolPolicy.allowedTools[]` and `toolPolicy.rejects[]`
- `resources` such as case project root, sandbox/private dir, isolated SQLite path, skill snapshot path, and adapter-specific remote/container resource paths when available
- `pollutionCheck` compares live `.trellis`, shared skills, and live private dirs before/after the run; shared SQLite detection must use case-scoped logical markers (skill-test task ids, case ids, conversation ids, and agent ids) within the run window instead of hashing the entire live database / `-wal` files, so unrelated room traffic does not look like isolation pollution
- isolated-mode telemetry (`a2a_tasks` / `a2a_task_events`) must write to the case-scoped run store during execution; final shared eval/result persistence happens outside the pollution-check window and stores a debug/trace snapshot for later run detail views
- OpenSandbox may use pre-baked runtime assets and a pre-baked CAFF source template, but the source template must be copied into the case-scoped project directory before execution; runner `cwd` and `CAFF_TRELLIS_PROJECT_DIR` must continue to point at the isolated case project, and case-level `.trellis` materialization must be overlaid there
- Pre-baked OpenSandbox images built by `scripts/opensandbox/build-runtime-image.js` must include Node.js plus the Python bootstrap toolchain (`python`/`python3`, `pip`, and `python3-venv`) so `TESTING.md` bootstrap commands can install Python packages inside the isolated container. Plain `node:20-bookworm` is treated as a Node-only fallback and should not be relied on for Python package bootstrap.
- full-mode trigger/execution AI judges must reuse the same case-scoped `agentDir` + SQLite path and the same effective runtime `provider/model` as the isolated run; judge helper runs must not fall back to the live shared store or unresolved default provider selection inside the pollution-check window
- `cleanup.ok|error`; cleanup is idempotent, so an OpenSandbox `not found`/404 during cleanup means the sandbox is already gone and should not be reported as `skill_test_cleanup_failed`
- OpenSandbox Docker cleanup errors that say `removal of container ... is already in progress` are also idempotent cleanup success: the auto-expiration path already owns deletion, so CAFF must not report `skill_test_cleanup_failed` for that cleanup race
- Local Full-mode runs can exceed the default `CAFF_SKILL_TEST_OPENSANDBOX_TIMEOUT_SEC=300` while uploading/executing the case world; raise the env var (for example `3600`) rather than relying on Docker auto-expiration to clean active runs

Publish-gate interpretation rules:

- isolated publish-gate runs fail closed when `execution.toolRuntime !== sandbox` or `execution.pathSemantics !== sandbox`
- isolated publish-gate runs with `egressMode = deny` fail closed unless `egress.enforced = true`

Isolation failures must surface canonical validation issues such as:

- `skill_test_not_isolated`
- `skill_test_policy_rejects_present`
- `skill_test_tools_not_sandboxed`
- `skill_test_path_semantics_not_sandboxed`
- `skill_test_egress_not_enforced`
- `skill_test_pollution_detected`
- `skill_test_cleanup_failed`

## Environment Readiness Chain

Skill-test can optionally run an environment workflow before the main pi execution starts. New assetized environment work should prefer `environmentConfig.asset` (`envProfile`, `image`, `imageDigest`, `baseImageDigest`, `testingMdHash`, `manifestHash`, `buildCaseId`) over per-run bootstrap for ordinary execution cases.

`skill_test_environment_assets` is the shared skill/profile registry for those reusable assets:

- rows are keyed by `skillId + envProfile`
- `environment-build` writes or refreshes the shared entry after a successful manifest/image result
- ordinary execution cases should reference a profile (`environmentConfig.asset.envProfile`) rather than a build case id
- case-level `environmentConfig.asset.image*` remains an explicit override / pin for debugging or reproducibility

`test_type = environment-build` is the minimal environment-asset producer path:

- it reuses the sandbox-side `preflight -> bootstrap -> verify` workflow instead of starting a normal model run
- a passing run persists `.pi-sandbox/skill-test-environment-manifests/<skillId>/<envProfile>/<manifestHash>/environment-manifest.json`
- the persisted manifest keeps `skillId`, `envProfile`, `baseImage`, `testingMdHash`, `installSteps[]`, `verifyCommands[]`, `buildCaseId`, and verification evidence
- the run response and `skill_test_cases.source_metadata_json.environmentBuild` keep the bindable asset summary (`envProfile`, `manifestPath`, `manifestHash`, optional built `image`, `imageDigest`, `baseImageDigest`)
- a successful `environment-build` also updates the shared `skill_test_environment_assets` row for the same `skillId + envProfile`; image-less manifest results may seed an empty shared row only when no runnable image exists yet, but they must not silently overwrite an existing runnable image entry
- when the caller explicitly requests image build, the controller may invoke the clean-image builder from that manifest; if image build is skipped, ordinary execution cases that inherit that profile still fail closed with `env_not_built` until an image is actually built
- the Skill Tests UI exposes a `buildImage` toggle only for the selected `environment-build` case; single-case runs send `environmentBuild.buildImage=true` when checked, and run detail surfaces manifest, image, digest, and bindable asset metadata

### Config Sources & Preconditions

- `server/domain/skill-test/environment-chain.ts` owns environment config normalization, explicit `TESTING.md` machine-contract parsing, and `preflight -> bootstrap -> verify -> cache` orchestration; `server/domain/skill-test/environment-assets.ts` owns shared skill/profile asset registry, environment-build manifest finalization, and async clean-image builder invocation; `server/domain/skill-test/case-schema.ts` owns canonical case validation, tool/sequence normalization, judge-output validation, and schema envelopes; `server/domain/skill-test/run-evaluation.ts` owns full-mode AI judge prompts/runs, sequence evidence scoring, tool-call matching, and full-mode verdict aggregation; `server/domain/skill-test/run-executor.ts` owns single-case run orchestration, live run/tool events, environment-build short-circuiting, eval/skill-test persistence, and isolation finalization; `server/domain/skill-test/design-service.ts` owns Skill Test workbench conversation state, matrix confirmation/export validation, duplicate warnings, and draft source-metadata patching; `server/domain/skill-test/testing-doc-draft.ts` owns TESTING.md draft section normalization, machine-contract block rendering, and draft validation errors; `server/api/skill-test-controller.ts` stays as the thin HTTP/composition layer.
- Run-request `environment.override` wins over stored case `environmentConfig`; when a case has no explicit environment config, the controller may derive one only from an explicit `skill-test-environment` JSON fenced block inside `TESTING.md` instead of guessing from prose/table/bullet formatting.
- `server/domain/skill-test/run-prompt.ts` assembles skill-test run prompts. Prompts inject the full `TESTING.md` content as human-readable reference context when present; `full + execution` prompts must also surface `expectedGoal` and `expectedSteps` as authoritative completion targets so a short `userPrompt` cannot silently downscope the case into a lighter review-only task.
- `dynamic + trigger` runs do not auto-derive heavy `TESTING.md` environment contracts by default; they only run that chain when the request explicitly enables environment handling or the case itself stores an environment config.
- When `environmentConfig.asset` is present and enabled, the single-case runner performs an `asset-check` phase before the agent run. Missing image bindings return `env_not_built`; a `testingMdHash` mismatch against the current target skill `TESTING.md` returns `env_stale`; a passing asset check skips the legacy per-run bootstrap workflow and passes the bound image/profile to the isolation layer.
- If a case only declares `environmentConfig.asset.envProfile` (or has no case-local asset block but the resolved config implies a profile), the single-case runner may hydrate the asset from shared `skill_test_environment_assets` for that `skillId + envProfile`. That shared hydration should show up as `asset.source = skill_profile_default` in evaluation detail.
- When the environment chain is disabled, skill-test keeps the existing default flow and starts the run without extra preflight/bootstrap/verify work.
- Environment probes, bootstrap commands, and verify commands are only allowed when isolated execution uses `host-loop + sandbox-tools` and `evaluation_json.isolation.execution.toolRuntime = 'sandbox'`; otherwise the run must return `runtime_unsupported`.
- `probeCommand`, `bootstrap.commands[]`, and `verify.commands[]` always execute through the sandbox tool adapter inside the case world. They must never fall back to host-side command execution.
- `server/domain/skill-test/sandbox-tool-contract.ts` is the typed facade for environment-chain sandbox capabilities. `createSkillTestEnvironmentRuntime()` normalizes `sandboxToolAdapter`, `commandEnv`, `availableEnv`, and execution metadata before `executeEnvironmentWorkflow()` runs.
- The typed sandbox adapter contract must normalize `runCommand()` results to `{ stdout, stderr, exitCode }`, coerce `readFile()` payloads to `Buffer`, and preserve the distinction between `commandEnv` (forwarded into sandbox commands) and `availableEnv` (broader runtime baseline used by `env` requirement preflight checks).
- `server/domain/skill-test/isolation.ts` and `server/domain/skill-test/open-sandbox-factory.ts` may temporarily keep file-wide `@ts-nocheck`, but their exported signatures should import the shared contract so typed callers do not fall back to ad-hoc object shapes.

### Case / Run Contract

- `skill_test_cases.environment_config_json` is the stored truth source for case-level environment plans.
- `skill_test_runs.environment_status` and `skill_test_runs.environment_phase` are summary projections. Detailed evidence stays under `evaluation_json.environment`.
- Supported requirement kinds are `command | package | env | capability | service`.
- `environment.cache.paths[]` only allows `{ root: 'project' | 'private', path: <relative path> }`; absolute paths, `..`, and paths escaping the case world are invalid.

### Result Shape

`evaluation_json.environment` is the canonical environment result envelope.

```json
{
  "status": "passed | env_not_built | env_stale | env_missing | env_install_failed | env_verify_failed | runtime_unsupported | skipped",
  "phase": "asset-check | preflight | bootstrap | verify | completed | skipped",
  "requirements": {
    "satisfied": [],
    "missing": [],
    "unsupported": []
  },
  "bootstrap": {
    "attempted": true,
    "commands": [],
    "results": []
  },
  "verify": {
    "attempted": true,
    "commands": [],
    "results": []
  },
  "source": {
    "testingDocUsed": true,
    "testingDocPath": "/skills/<skillId>/TESTING.md",
    "testingDocHash": "..."
  },
  "advice": {
    "mode": "none | suggest-patch",
    "target": "TESTING.md",
    "summary": "...",
    "patch": "..."
  },
  "cache": {
    "enabled": true,
    "key": "...",
    "status": "disabled | miss | restored | restore_failed | saved | save_failed",
    "reason": "...",
    "paths": [],
    "manifestPath": ".pi-sandbox/skill-test-environment-cache/<cacheKey>/manifest.json",
    "summaryPath": ".pi-sandbox/skill-test-environment-cache/<cacheKey>/summary.json",
    "artifactBytes": 123,
    "artifactSha256": "...",
    "createdAt": "...",
    "savedAt": "...",
    "expiresAt": "...",
    "lastValidatedAt": "...",
    "restoredFiles": 0,
    "restoredDirectories": 0,
    "restoredSymlinks": 0,
    "ignoredEntries": 0
  }
}
```

### Cache Contract

- Cache root is `.pi-sandbox/skill-test-environment-cache/<cacheKey>/` with `manifest.json`, `artifact.tgz`, and `summary.json`.
- Cache key must cover `skillId + planHash + worldHash`. `planHash` includes normalized requirements/bootstrap/verify plus the `TESTING.md` source hash when used. `worldHash` includes driver name/version, platform/arch, egress mode, tool runtime, and path semantics.
- Cache behavior is `restore-then-verify`: try restore only after the initial preflight reports missing required items, then re-run preflight + verify before the main skill run.
- Cache save is `save-on-success`: only after `bootstrap + verify` succeed. Save failure degrades to cache warning metadata and must not replace an already passed environment result.
- TTL janitor may remove expired or incomplete entries before lookup/save. Cache never expands side effects outside the sandbox case world.

### UI / Regression Expectations

- `public/skill-tests.js` renders environment status, requirement diffs, command evidence, TESTING.md advice, and cache metadata from `result.evaluation.environment` (falling back to `run.evaluation.environment` for older rows).
- Summary and regression views bucket environment outcomes from `environment_status` so environment failures do not get collapsed into generic skill failures.

## Evaluation Logic

### Mode Semantics (Phase 3)

- **Dynamic mode (default)**:
  - primary goal: load/trigger evidence
  - `trigger_passed` is based on target `SKILL.md` read evidence
  - trigger-style dynamic runs stop the agent loop immediately after the target `SKILL.md` load is observed
  - legacy dynamic execution cases (`test_type = execution`) keep their end-to-end execution semantics and do not use the early-stop path

- **Full mode**:
  - primary goal: behavior-chain quality evaluation (`expectedSteps`, constraints, goal/adherence)
  - run output is a structured `evaluation` object with dimensions and aggregated verdict
  - `execution_passed = 1` only when `evaluation.verdict === 'pass'`

### Dynamic Trigger Detection

Trigger is detected when any supported evidence source contains a target read:

1. **Tool call event** (`a2a_task_events` / `agent_tool_call`)
2. **Session JSONL tool blocks**
3. **Dynamic-load confirmation task event** (`a2a_task_events` / `skill_test_dynamic_load_confirmed`) when the live pi event proves the target read before session/tool-call persistence lands

Target path match is normalized to:

- `/skills/<skillId>/SKILL.md` (case-insensitive, slash-normalized)

### Full-Mode Judge Contract

Full execution judge must return structured JSON:

```json
{
  "steps": [
    {
      "stepId": "step-1",
      "completed": true,
      "confidence": 0.9,
      "evidenceIds": ["msg-1"],
      "matchedSignalIds": ["sig-step-1-read"],
      "reason": "..."
    }
  ],
  "constraintChecks": [
    {
      "constraintId": "confirm-before-action",
      "satisfied": true,
      "evidenceIds": ["msg-1"],
      "reason": "..."
    }
  ],
  "goalAchievement": { "score": 0.8, "reason": "..." },
  "instructionAdherence": { "score": 0.85, "reason": "..." },
  "summary": "...",
  "verdictSuggestion": "pass|borderline|fail",
  "missedExpectations": ["..."]
}
```

Validation rules (`server/domain/skill-test/case-schema.ts` / `validateJudgeOutput`):

- `status` enum: `succeeded | parse_failed | runtime_failed | skipped`
- `confidence` / `score` must be in `0..1`
- `evidenceIds` can only reference timeline ids: `msg-*`, `thinking-*`, `tool-call-*`, `tool-result-*`
- `matchedSignalIds` can only reference normalized `expectedSteps[].strongSignals[].id`
- unknown step/constraint/signal/evidence ids are stripped with warning issues
- missing step/constraint rows are backfilled with placeholder results (`needs-review` issues)
- duplicate step/constraint ids or invalid verdict suggestion downgrade to `parse_failed`

### Full-Mode Aggregation & Metrics

`buildFullModeExecutionEvaluation(...)` calculates:

- `requiredStepCompletionRate`
- `stepCompletionRate`
- `requiredToolCoverage`
- `toolCallSuccessRate`
- `toolErrorRate`
- `sequenceAdherence` (computed from step `evidenceIds` order, not judge free-scoring)
- `goalAchievement`
- `instructionAdherence`

`aggregateFullVerdict(...)` outputs `pass | borderline | fail`.

Hard-fail examples:

- missing required steps
- critical constraint violated
- critical sequence hard-fail (when sequence is configured + marked critical)
- goal/adherence below hard-fail thresholds
- judge suggests fail with observable evidence backing

Borderline examples:

- judge runtime/parse failure
- missing critical checks / weak evidence
- primary dimensions below pass threshold but not hard-fail
- supporting metrics weakness

### Persistence Truth Source

- `evaluation_json` is the source of truth for full-mode evaluation payload.
- mirror columns are projection fields (`*_rate`, `sequence_adherence`, `goal_achievement`, etc.).
- projection consistency warnings:
  - `evaluation_projection_mismatch`
  - `evaluation_projection_failed`

## Canonical Case Schema

### Prompt Canonicalization

- canonical input field: `userPrompt`
- compatibility alias: `triggerPrompt`
- if both provided and differ after normalization -> `prompt_alias_conflict`
- prompt length constraints: `5..2000`

### Full-Mode Required Fields

Full case save/update/run requires canonical schema:

- `userPrompt` (non-empty)
- `expectedGoal` (non-empty)
- `expectedSteps` array size `1..12`
- at least one `required = true` step
- `evaluationRubric` object (may be empty but must be object shape)

Step constraints:

- stable `id` (case-unique)
- non-empty `title` + `expectedBehavior`
- optional `order` (positive, unique)
- `strongSignals` max 5 per step
- signal type only: `tool | text | state`

Rubric constraints:

- `criticalDimensions` only allows `sequenceAdherence`
- thresholds in `0..1`, and `hardFail <= pass`
- `criticalConstraints[].appliesToStepIds` must reference known steps
- `supportingSignalOverrides` must reference existing `stepId + signalId`

### Validation Envelope

All save/run/read paths expose canonical validation envelope:

```json
{
  "issues": [
    {
      "code": "expected_steps_required",
      "severity": "error|warning|needs-review",
      "path": "expectedSteps",
      "message": "..."
    }
  ],
  "caseSchemaStatus": "valid|warning|invalid",
  "derivedFromLegacy": false
}
```

Preflight rule:

- if schema is invalid (`caseSchemaStatus = invalid`), run is rejected with `case_schema_invalid` and agent run does not start.

## Test Case Generation

### AI Draft Generation (`lib/skill-test-generator.ts`)

- Both loading modes support AI generation via `/generate`.
- Dynamic mode drafts prioritize load-trigger language.
- Full mode drafts prioritize:
  - `expectedGoal`
  - `expectedSteps` (stable `step-{n}` IDs)
  - optional `expectedSequence`
  - `evaluationRubric`
  - optional supporting `expectedTools`
- Generator prompt enforces canonical `userPrompt` and keeps `triggerPrompt` as legacy alias.

### Draft-First Persistence

Generated rows persist as drafts by default:

- no automatic smoke run
- user edits first, then run manually or promote to ready
- generation metadata persisted:
  - `generationProvider`
  - `generationModel`
  - `generationCreatedAt`

Chat workbench draft export keeps the same draft-first rule and adds stricter audit guarantees:

- matrix import/confirmation/export must reference an assistant `messageId`; missing source message fails closed
- large official matrices may be written by the scribe to project-local `.tmp/skill-test-design/<skillId>/<matrixId>.json` artifacts instead of pasted into chat
- artifact import accepts only paths mentioned by the source assistant message, only within `.tmp/skill-test-design/`, only `.json`, and only up to 1MB before normal matrix validation
- exported rows persist `source_metadata_json` with at least `conversationId`, `messageId`, `matrixId`, `matrixRowId`, `agentRole`, `exportedBy`, and `exportedAt`; artifact-backed imports may also persist `matrixArtifactPath`
- repeated export from the same chat workbench conversation should reuse the latest matching chat-export draft (`conversationId + matrixRowId`, then same normalized prompt / environment-build identity) while the case is still `draft`, updating the existing row instead of creating another duplicate draft
- conversation `skillTestDesign.export` persists the user-facing export summary: `exportedCaseIds[]`, `exportedCount`, `duplicateWarningCount`, `skippedRowCount`, and `skippedRows[]` so refreshes still show duplicate/skipped context without re-running export
- the chat panel deep-link into Skill Tests uses `/eval-cases.html?tab=panel-skill-tests&skillId=<skillId>&caseId=<first-exported-case-id>&matrixId=<matrixId>`; `public/skill-tests.js` reads this query once, opens the Skill Tests tab, selects the target skill/case, and then falls back to normal localStorage selection
- Skill Tests case detail renders chat-export tags from `sourceMetadata.source = skill_test_chat_workbench`, including matrix/row ids, environment source, and lifecycle chain id when present
- batch export must be atomic for a single request; if any candidate row fails validation, no partial `skill_test_cases` rows may remain from that export attempt

## Scenario: Skill-Test Design Matrix Contract

### 1. Scope / Trigger

- Trigger: a `skill_test_design` conversation imports a matrix, confirms scope, or exports draft cases.
- Cross-layer path: `server/domain/skill-test/chat-workbench-mode.ts` + `server/domain/skill-test/design-service.ts` -> `server/api/skill-test-controller.ts` -> `public/chat/skill-test-design-panel.js` -> `skill_test_cases.source_metadata_json`.
- Phase boundary: current implementation enforces assistant-source audit, confirm-before-export, duplicate warnings, atomic draft export, environment-contract gating, `environment-build` draft export, and lifecycle-chain metadata for matrix rows.

### 2. Signatures

- Conversation type: `skill_test_design`
- Conversation phases: `collecting_context | planning_matrix | awaiting_confirmation | generating_drafts | exported`
- HTTP routes:

```text
GET  /api/conversations/:conversationId/skill-test-design
POST /api/conversations/:conversationId/skill-test-design/import-matrix
POST /api/conversations/:conversationId/skill-test-design/confirm-matrix
POST /api/conversations/:conversationId/skill-test-design/export-drafts
```

- Baseline matrix shape:

```ts
type SkillTestMatrix = {
  kind?: 'skill_test_matrix';
  matrixId: string;
  skillId: string;
  phase: 'collecting_context' | 'planning_matrix' | 'awaiting_confirmation' | 'generating_drafts' | 'exported';
  rows: SkillTestMatrixRow[];
};

type SkillTestMatrixRow = {
  rowId: string;
  scenario: string;
  priority: 'P0' | 'P1' | 'P2';
  coverageReason: string;
  testType: 'trigger' | 'execution' | 'environment-build';
  loadingMode: 'dynamic' | 'full';
  riskPoints: string[];
  keyAssertions: string[];
  includeInMvp: boolean; // normalized storage field; imports may use includeInExport alias and UI should call this the current export scope
  draftingHints?: Record<string, unknown>;
  environmentContractRef?: string;
  environmentSource?: 'skill_contract' | 'user_supplied' | 'missing';
  scenarioKind?: 'single' | 'chain_step';
  chainId?: string;
  chainName?: string;
  sequenceIndex?: number;
  dependsOnRowIds?: string[];
  inheritance?: Array<'filesystem' | 'artifacts' | 'conversation' | 'externalState'>;
};
```

- `environmentContractRef` format: `<relative-path>#<heading-or-contract-id>`, relative to the target skill root, for example `TESTING.md#Bootstrap`.
- `environmentSource` semantics:
  - `skill_contract`: the row references an existing contract from `TESTING.md`, `SKILL.md`, or stable spec.
  - `user_supplied`: the user supplied temporary setup information in chat; it is not yet a skill-owned contract.
  - `missing`: no trustworthy environment contract could be located.
- Exported draft metadata must keep the baseline audit envelope:

```json
{
  "source": "skill_test_chat_workbench",
  "conversationId": "conv-123",
  "messageId": "msg-456",
  "matrixId": "matrix-789",
  "matrixRowId": "row-1",
  "matrixArtifactPath": ".tmp/skill-test-design/demo-skill/matrix-789.json",
  "agentRole": "scribe",
  "exportedBy": "user",
  "exportedAt": "2026-04-21T00:00:00.000Z"
}
```

- When matrix rows carry environment or lifecycle-chain fields, export metadata should additionally preserve them under `source_metadata_json.skillTestDesign`, rather than flattening setup knowledge into free-text `note` fields.
- Duplicate warnings for trigger/execution drafts use normalized `triggerPrompt`; `environment-build` has no meaningful trigger prompt, so duplicate hints use the shared asset key (`skillId + envProfile`, defaulting to `default`) and matching `environmentContractRef` when present.

### 3. Contracts

- Context assembly for planning should prefer the target skill's environment contract in this order: `TESTING.md` -> `SKILL.md` -> stable spec. `TESTING.md` full text may still be injected to the model as human-readable reference, but if none of those sources provide actionable setup information the row must be marked `environmentSource = missing`.
- Runtime-readable `TESTING.md` contract status only comes from an explicit `skill-test-environment` fenced JSON block; prose/table/bullet sections remain reference context for the model and draft workflow, not executable gate truth.
- User-supplied environment instructions are temporary planning input. They must remain `environmentSource = user_supplied` until a human actually writes them back into `TESTING.md` or another stable spec.
- Skill Test design prompt policy defaults normal planning to complete `full + execution` coverage. The assistant should not ask the user to choose loading mode unless they explicitly want trigger/load-only coverage.
- Matrix normalization defaults omitted `testType` / `loadingMode` to `execution` / `full` for chat-workbench planning rows, and accepts `includeInExport` as an import alias for the normalized `includeInMvp` flag.
- Planning rows for `execution`, `environment-build`, or any row that explicitly depends on real external environment, credentials, or sandbox capabilities must fail closed at formal generate/export time when `environmentSource = missing`.
- Trigger-only planning rows may continue with warning metadata when `environmentSource = missing`, but the gap must remain visible in the matrix and export metadata.
- `inheritance` only describes reuse intent between chain steps. It must never be used to smuggle install/bootstrap/teardown instructions.
- Lifecycle-chain fields still originate from planning/export metadata, but exported `full + execution` cases with complete `chainPlanning.exportChainId / sequenceIndex / dependsOnCaseIds` metadata can now opt into the chain runner via `test-chains`; non-eligible rows remain independent-case execution.
- Confirm/export requests must keep assistant-source audit intact: `messageId` must point to an assistant message in the same conversation, `matrixId` must match the currently imported matrix, and export stays atomic for the whole batch.

### 4. Validation & Error Matrix

| Condition | Required behavior | Status / signal |
|-----------|-------------------|-----------------|
| `import-matrix` without `messageId` | Reject request | `matrix_source_message_required` |
| `messageId` does not point to an assistant message in the same conversation | Reject request | `matrix_source_message_invalid` |
| Matrix artifact path is not mentioned by the source assistant message | Reject request | `matrix_artifact_source_mismatch` |
| Request omits both inline `matrix` and `matrixPath` | Reject request | `matrix_missing` |
| Matrix shape is invalid after normalization | Reject request | `matrix_invalid` |
| `confirm-matrix` or `export-drafts` references a different `matrixId` | Reject request | `matrix_id_mismatch` |
| Export runs before confirmation | Reject request | `matrix_not_confirmed` |
| Confirmed matrix contains no rows in the current export scope | Reject request | `matrix_rows_empty` |
| Candidate draft validation fails during batch export | Reject whole batch and leave no partial `skill_test_cases` rows | atomic 400 failure |
| Matrix row uses a supported canonical combo (`dynamic/full` × `trigger/execution/environment-build`) | Build canonical draft input and validate atomically; do not silently coerce type | export via normal validation |
| Planned: `execution`, `environment-build`, or real-env row has `environmentSource = missing` | Reject formal generate/export; do not downcast to trigger | fail closed |
| Planned: chain row has cycle, cross-chain dependency, missing `sequenceIndex`, or unresolved `dependsOnRowIds` | Block confirmation/export and return structured validation errors | fail closed |

### 5. Good / Base / Bad Cases

- Good: the skill exposes `TESTING.md#Bootstrap`, a matrix row references `environmentContractRef = "TESTING.md#Bootstrap"`, `environmentSource = skill_contract`, and export metadata preserves both audit fields and the contract reference; for `environment-build`, the raw chat draft omits the `triggerPrompt` alias, stores a descriptive canonical prompt, remains `draft`, and relies on the contract or user-supplied `environmentConfig`.
- Base: the skill has no durable contract, the user supplies temporary setup steps in chat, the row is marked `environmentSource = user_supplied`, and trigger-only draft export is allowed with advice to write the setup back into `TESTING.md`.
- Bad: an execution row depends on external setup but leaves `environmentSource = missing`; formal generate/export must stop instead of guessing commands.
- Bad: a chain step puts bootstrap logic in `inheritance` or a free-text `note`; setup knowledge must stay in `environmentContractRef` / `environmentSource` and chain metadata must describe only dependency intent.

### 6. Tests Required

- `tests/skill-test/skill-test-e2e.test.js`: import requires assistant `messageId` and rejects non-assistant or mismatched artifact sources.
- `tests/skill-test/skill-test-e2e.test.js`: export remains atomic when one candidate row fails validation.
- `tests/skill-test/skill-test-schema.test.js`: `skill_test_cases` includes `source_metadata_json`, nested `skillTestDesign` metadata survives persistence, draft builders keep environment/chain metadata out of free-text `note`, and matrix normalization defaults chat-workbench rows to `full + execution` while accepting `includeInExport` input.
- `tests/skill-test/skill-test-e2e.test.js`: `environmentSource = missing` blocks execution / environment-build / real-env export without silently rewriting the row.
- `tests/skill-test/skill-test-e2e.test.js`: chat workbench export can persist `environment-build` drafts when a skill contract or user-supplied environment source is present and can warn on existing `skillId + envProfile` / `environmentContractRef` duplicates.
- `tests/skill-test/skill-test-e2e.test.js`: repeated export from the same conversation reuses existing draft rows by `matrixRowId` or normalized prompt instead of multiplying duplicate drafts.
- `tests/skill-test/skill-test-e2e.test.js`: chain topology issues such as cycles, cross-chain dependencies, missing middle steps, and unresolved `dependsOnRowIds` are blocked before export.
- Future UI test coverage: explicit user-facing messaging that chain grouping is planning-only and does not imply shared execution in Phase 1.

### 7. Wrong vs Correct

#### Wrong

```json
{
  "rowId": "row-cleanup",
  "scenario": "reuse prepared environment and then clean up",
  "testType": "execution",
  "loadingMode": "full",
  "inheritance": ["filesystem", "sudo apt install ffmpeg && ./bootstrap.sh"]
}
```

- Problems:
  - mixes dependency installation into `inheritance`
  - has no traceable environment contract source
  - cannot be safely exported or reviewed

#### Correct

```json
{
  "rowId": "row-cleanup",
  "scenario": "reuse prepared environment and then clean up",
  "testType": "execution",
  "loadingMode": "full",
  "environmentContractRef": "TESTING.md#Bootstrap",
  "environmentSource": "skill_contract",
  "scenarioKind": "chain_step",
  "chainId": "env-lifecycle",
  "sequenceIndex": 3,
  "dependsOnRowIds": ["row-bootstrap", "row-run"],
  "inheritance": ["filesystem", "artifacts"]
}
```

- Why this is correct:
  - environment setup is traceable to a skill-owned contract
  - chain fields only describe dependency intent
  - review/export logic can block or warn using structured fields instead of parsing prose

## Scenario: Skill-Test Design TESTING.md Draft Workflow

### 1. Scope / Trigger

- Trigger: a `skill_test_design` conversation detects missing `TESTING.md`, or detects insufficient environment contract coverage and the user explicitly asks to refresh the draft.
- Cross-layer path: `public/chat/skill-test-design-panel.js` -> `server/api/skill-test-controller.ts` -> `server/domain/skill-test/testing-doc-auto-preview.ts` + `server/domain/skill-test/testing-doc-draft.ts` + `server/domain/skill-test/testing-doc-target.ts` -> target skill `TESTING.md`.
- Purpose: keep `user_supplied` setup information as preview-only until a human confirms a fixed-path write, then require matrix refresh / re-confirmation before any export can treat the new document as a durable `skill_contract`.

### 2. Signatures

- Conversation state fields:
  - `metadata.skillTestDesign.testingDocDraft`
  - `metadata.skillTestDesign.environmentContract`
- HTTP routes:

```text
GET  /api/conversations/:conversationId/skill-test-design
POST /api/conversations/:conversationId/skill-test-design/preview-testing-doc-draft
POST /api/conversations/:conversationId/skill-test-design/apply-testing-doc-draft
POST /api/conversations/:conversationId/skill-test-design/refresh-environment-contract
```

- Draft shape:

```ts
type TestingDocDraft = {
  draftId: string;
  skillId: string;
  targetPath: 'TESTING.md';
  status: 'proposed' | 'needs_user_input' | 'confirmed' | 'applied' | 'rejected' | 'superseded';
  sections: Array<{
    heading: 'Prerequisites' | 'Setup' | 'Verification' | 'Teardown' | 'Open Questions';
    content: string;
    sourceKind: 'skill_md' | 'stable_spec' | 'user_supplied' | 'missing';
    sourceRefs: string[];
    openQuestions: string[];
  }>;
  content: string;
  readiness: {
    executionBlocked: boolean;
    missingCriticalSections: string[];
    openQuestions: string[];
    warnings: string[];
  };
  file: {
    existsAtPreview: boolean;
    hashAtPreview: string;
    sizeAtPreview: number;
    targetPath: 'TESTING.md';
    overwritePreview: boolean;
  };
  audit: {
    conversationId: string;
    messageId: string;
    agentRole: string;
    createdBy: string;
    createdAt: string;
    sourceKinds: string[];
    appliedBy?: string;
    appliedAt?: string;
  };
};
```

### 3. Contracts

- Missing `TESTING.md` auto-preview: summary/prompt context preparation may create and persist a guarded `testingDocDraft` preview with `audit.messageId = auto-testing-doc-preview`, `createdBy = system`, and no file write.
- Existing-file refresh remains explicit: when `TESTING.md` exists but is insufficient, the user must request a new preview before overwrite-capable apply is possible.
- `sourceKind` is a closed preview-only provenance enum and must not extend canonical case/export `environmentSource`.
- Apply is fixed-path and fail-closed: only the target skill root `TESTING.md` may be written; symlink escape, path traversal, and silent overwrite are rejected.
- If `TESTING.md` changed after preview, apply must reject with a superseded draft error and require a new preview.
- Applying a draft never silently mutates old matrix rows to `skill_contract`; it clears matrix confirmation/export state and requires user re-confirmation.
- `Prerequisites` / `Setup` remain critical execution gates; `Verification` / `Teardown` may degrade to warnings in MVP.
- Draft content should include a `skill-test-environment` JSON fenced block when source sections contain actionable setup or verification lines, so applying the draft creates a runtime-readable contract instead of prose-only documentation.

### 4. Validation & Error Matrix

| Condition | Required behavior | Status / signal |
|-----------|-------------------|-----------------|
| Manual preview has no source message | Reject request | `testing_doc_source_message_required` |
| Manual preview message id is not in the conversation | Reject request | `testing_doc_source_message_invalid` |
| Missing `TESTING.md` summary preparation has no chat source message | Create preview with system audit id and do not write the file | `auto-testing-doc-preview` |
| Draft target path is not exactly `TESTING.md` | Reject request | `testing_doc_target_invalid` |
| Draft section heading is outside the approved fixed set | Reject preview/apply normalization | `testing_doc_section_heading_invalid` |
| Existing file would be overwritten without explicit confirmation | Reject apply | `testing_doc_overwrite_confirmation_required` |
| Target file changed after preview | Reject apply and mark draft superseded | `testing_doc_draft_superseded` |
| Skill root is read-only / unmanaged for writing | Reject apply | `testing_doc_target_read_only` |

### 5. Tests Required

- `tests/skill-test/skill-test-schema.test.js`: preview draft builder normalizes required sections and preserves preview-only source kinds.
- `tests/skill-test/skill-test-e2e.test.js`: summary auto-preview creates a draft for missing `TESTING.md` without writing files.
- `tests/skill-test/skill-test-e2e.test.js`: manual preview creates a draft without writing files and preserves structured validation errors for invalid section headings.
- `tests/skill-test/skill-test-e2e.test.js`: apply writes fixed-path `TESTING.md` and invalidates matrix confirmation.
- `tests/skill-test/skill-test-e2e.test.js`: superseded previews fail closed when the target file changes between preview and apply.

## API Endpoints

### Test Case Management

```
GET    /api/skills/:skillId/environment-assets
GET    /api/skills/:skillId/environment-assets/:envProfile
GET    /api/skills/:skillId/test-cases
POST   /api/skills/:skillId/test-cases
POST   /api/skills/:skillId/test-cases/generate
GET    /api/skills/:skillId/test-cases/:caseId
PATCH  /api/skills/:skillId/test-cases/:caseId
POST   /api/skills/:skillId/test-cases/:caseId/mark-ready
POST   /api/skills/:skillId/test-cases/:caseId/mark-draft
DELETE /api/skills/:skillId/test-cases/:caseId
```

### Test Execution

```
POST /api/skills/:skillId/test-cases/:caseId/run
POST /api/skills/:skillId/test-cases/run-all
POST /api/skills/:skillId/test-chains/run
GET  /api/skills/:skillId/test-chains/:chainRunId
GET  /api/skills/:skillId/test-chains/by-export/:exportChainId/runs
```

Notes:

- `run-all` runs only effective `ready` cases.
- `POST /generate`, `POST /run-all`, and `POST /:caseId/run` parse JSON bodies strictly; malformed bodies must surface `400 Invalid JSON body` instead of silently falling back to default options.
- `DELETE /api/skills/:skillId/test-cases/:caseId` must remove dependent `skill_test_runs` and `skill_test_chain_run_steps` rows in the same transaction before deleting the case row, so previously executed chain history does not trip a raw SQLite foreign-key failure.
- legacy rows (`validity_status`) are mapped to effective status for compatibility.

### Results and Reports

```
GET /api/skills/:skillId/test-cases/:caseId/runs
GET /api/skills/:skillId/test-cases/:caseId/regression
GET /api/skills/:skillId/test-runs
GET /api/skills/:skillId/regression
GET /api/skill-test-runs/:runId
GET /api/skill-test-runs/:runId/session-export
GET /api/skill-test-summary
```

- `GET /api/skill-test-runs/:runId/session-export` downloads the raw session JSONL captured for that run so humans can inspect the agent's exact tool/message behavior inside the skill-test sandbox baseline; isolated runs must persist a shared export copy before case cleanup so the download still works after the case world is removed, and the route returns `404` only when no persisted session evidence exists.

## Lifecycle Chain Runner (MVP)

- Persistence adds `skill_test_chain_runs` and `skill_test_chain_run_steps` so a chain run can keep chain-level status plus per-step audit without fabricating skipped `skill_test_runs` rows.
- `POST /api/skills/:skillId/test-chains/run` validates that all candidate cases belong to one `exportChainId`, are `full + execution`, have complete chain metadata, and do not leave `environmentSource = missing` unresolved.
- `server/domain/skill-test/chain-runner.ts` owns chain candidate validation, audit persistence, live snapshots, shared isolation/context lifecycle, and chain continuation policy; the controller only exposes the chain HTTP routes.
- The runner creates one shared isolation/context handle for the chain, runs environment bootstrap at chain scope, then calls existing single-case execution with step-scoped prompt carry-forward (`previousStepSummary`, explicit `artifactRefs[]`, `sharedEnvironmentHandle`).
- Chain continuation uses `skill_test_chain_runs.stop_policy`. The default `stop_on_failure` is strict: the first non-passing step marks later pending steps as `skipped`, while already executed steps keep their normal `skill_test_runs` / `eval_case_runs` evidence.
- `stop_on_failure_goal_threshold` is an explicit relaxed chain continuation policy. It allows the chain to continue when a step run has `status = succeeded`, no `critical-constraint` hard-fail reason, and `goalAchievement >= 0.8`; that chain step audit is stored as `continued`, and the underlying `skill_test_runs.verdict` remains unchanged for regression and review.
- `GET /api/skills/:skillId/test-chains/:chainRunId` returns chain summary plus ordered step audit; `GET /api/skills/:skillId/test-chains/by-export/:exportChainId/runs` returns recent chain summaries with ordered `steps[]` previews so the Skill Tests UI can show every step directly in chain history.
- Chain teardown evidence is persisted in `skill_test_chain_runs.teardown_evidence_json`. Chain detail responses include full isolation teardown evidence, including `pollutionCheck.changes`; summary/list responses only expose compact pollution status/count metadata.
- Chain history step cards surface each executed step's `skillTestRunId`, normal run detail, and session export action; skipped steps stay visible even though they intentionally have no `skill_test_runs` row.
- Running chain steps do not have a persisted `skill_test_runs` row until the single-case executor finishes, so chain history / detail UI must still expose a live-observability action that jumps to the step case's realtime trace instead of waiting for the final run-detail button to appear.

## Execution Flow

```
1. Preflight
   - Load stored case + schema envelope
   - Reject run when caseSchemaStatus = invalid

2. Runtime execution
   - Start pi run with CAFF_SKILL_LOADING_MODE
   - Capture session + task tool events

3. Evidence normalization
   - Build timeline ids: msg-*, thinking-*, tool-call-*, tool-result-*
   - Normalize expected tools / steps / sequence

4. Mode-specific evaluation
   - Dynamic: load trigger evaluation (+ legacy execution checks)
   - Full: execution judge validation + dimension metrics + aggregate verdict

5. Persistence
   - Write eval_case_run.result_json
   - Write skill_test_runs with mirror metrics + evaluation_json
   - Attach validation envelope to response and stored evaluation
```

## Metrics and Regression

### Skill Summary Shape

```json
{
  "skillId": "werewolf",
  "casesByStatus": { "draft": 3, "ready": 5, "archived": 1 },
  "totalCases": 9,
  "totalRuns": 42,
  "triggerPassedCount": 30,
  "executionPassedCount": 18,
  "triggerRate": 0.714,
  "executionRate": 0.429,
  "avgToolAccuracy": 0.88,
  "avgRequiredStepCompletionRate": 0.79,
  "avgStepCompletionRate": 0.83,
  "avgGoalAchievement": 0.76,
  "avgToolCallSuccessRate": 0.91
}
```

### Regression Buckets

Regression endpoints group by:

- `provider`
- `model`
- `promptVersion`

Regression/summary execution metrics are full-mode only: `executionPassedCount` uses full-mode verdict-pass semantics (falling back to `execution_passed` only for older full-mode rows without verdict projection), and `executionRate` uses only full-mode runs as its denominator.
- `eval_case_runs.provider` / `model` persist the effective runtime settings after request/env/default resolution, so defaulted runs still group into the correct regression bucket instead of collapsing into `default` labels.

## UI Contract (Workstream D)

Frontend keeps `public/skill-tests.js` as the Skill Tests page entry and pushes
focused rendering / data helpers into `public/skill-tests/*.js`.
`public/eval-cases.html` must load those helper scripts before
`public/skill-tests.js`; each helper registers a
`window.CaffSkillTests.create*Helpers()` factory, while the page entry remains
responsible for state, SSE wiring, fetch orchestration, and cross-panel
coordination.

- unified issues panels:
  - detail panel: `st-detail-issues`
  - create panel: `st-create-issues`
- local JSON parse errors are transformed into canonical `issues[]` instead of toast-only flows
- full run detail renders:
  - step results (`steps[]`)
  - `constraintChecks[]`
  - `aggregation` reasons
  - `aiJudge` status, `verdictSuggestion`, `missedExpectations`
- run detail reads `result.evaluation` first and falls back to `run.evaluation`
- run detail prefers the finalized persisted `result.trace` snapshot for completed runs, then only falls back to rebuilding from live DB/session evidence for older rows that lack stored trace data
- run detail and run history keep a stable `运行摘要 -> 工具时间线 -> 环境/评估细节` reading order so live and finalized runs do not drift into separate layouts
- live run panel renders the active tool trace while a run is in progress and keeps the finalized trace visible after terminal events land
- live chain panels and chain step cards should expose a running-step jump action (`查看实时调用` or equivalent) that selects the active case and reuses the existing live trace panel, because final run detail/session-export actions depend on persisted run rows that do not exist mid-run
- when the detail `runs` tab is active, relevant live run / live chain events should trigger a debounced refresh and a short polling fallback while the selected case still has in-flight activity, so newly persisted run rows and chain history cards appear without forcing humans to reselect the case; background refreshes should preserve the current panel content instead of flashing the loading state on every tick
- live runs use `status` as the explicit placeholder when no final verdict exists; finalized runs may add `verdict`, environment status, and step counts, but the UI must not invent `pass/fail` before persisted evidence exists
- run history actions keep both `下载 JSON` (normalized detail payload) and `导出 Session` (raw session JSONL evidence) so sandbox-side behavior can be inspected without guessing from summary cards

### Live Run SSE Contract

`server/api/skill-test-controller.ts` emits live progress over the shared `/api/events` SSE stream so the skill-tests workspace can render in-flight tool activity without waiting for the final `POST /run` response.

- `skill_test_run_event`
  - `phase`: `started | progress | output_delta | terminating | completed | failed`
  - includes `caseId`, `skillId`, `taskId`, synthetic `messageId`, provider/model metadata, status, and final `trace` on terminal phases
  - `progress` includes `executionRuntime`, `progressLabel`, optional `runnerStage`, `runnerPid`, and `runnerSessionPath` so OpenSandbox runner preparation/startup is visible before the first tool or text event
  - `output_delta` includes `delta`, accumulated `outputText`, `isFallback`, optional `messageKey`, `executionRuntime`, and `progressLabel`; the browser updates the live output preview without waiting for terminal `trace`
- `skill_test_chain_run_event`
  - `phase`: `started | progress | step_started | step_completed | step_failed | completed | failed`
  - includes `skillId`, `chainRunId`, `exportChainId`, chain status, current step ids/index, `progressLabel`, `runnerStage`, and the same `chainRun` / ordered `steps[]` / `warnings[]` envelope returned by `GET /test-chains/:chainRunId`
  - terminal phases keep skipped-step audit visible so the UI can update the chain live panel before the blocking `POST /test-chains/run` response resolves
- `conversation_tool_event`
  - skill-test runs reuse the same live tool-step payload shape as chat workbench traces
  - payload is keyed by the synthetic skill-test `messageId` so the frontend can merge session + bridge steps with the existing step schema and CSS patterns

### Skill Tests Workspace Layout

- `public/eval-cases.html` keeps the Skill Tests workspace in a single-column-first flow: sticky top toolbar → overview → case list → detail → create → summary, with wide-screen enhancement only at larger breakpoints.
- The sticky toolbar is the only always-pinned control surface for high-frequency actions (`skill`, `agent`, `model`, `promptVersion`, run isolation defaults such as `isolationMode` / `trellisMode` / `egressMode`, plus `chainStopPolicy`, generate / manual-create / run-all actions, and the conditional environment-build image toggle); page-level horizontal scrolling should be avoided outside local table overflow.
- The detail area stays tabbed (`overview`, `details`, `runs`, `regression`) so long histories and regression output do not crowd the editor surface.
- The detail header keeps case status, last-outcome summary, chain-summary rail, and primary actions visible at the top of the detail card, but it intentionally remains in normal document flow (`position: static`) instead of becoming sticky, because zoomed desktop layouts made a sticky header float above the workspace and obscure nearby content.
- Case list stays single-list-first, adds lightweight `全部 / 链式 / 普通` filtering, and cards should expose short case id, status, recent run context, and direct run/detail actions.
- Chain cases must be derived from `getSkillTestChainPlanningMeta(testCase)` and rendered with a compact rail in the card header; long chains collapse to `first / gap / current / last` or `first / +N / last` instead of stretching the whole card.
- Empty, loading, and failure states should point to the next action (`generate`, `manual create`, `retry`, `clear filter`) instead of leaving the workspace blank.

## Implementation Files

### Core Components

- `lib/skill-test-generator.ts`
- `server/api/skill-test-controller.ts`
- `server/domain/skill-test/chain-runner.ts`
- `server/domain/skill-test/environment-chain.ts`
- `server/domain/skill-test/run-executor.ts`
- `storage/sqlite/migrations.ts`
- `tests/skill-test/skill-test-generator.test.js`
- `tests/skill-test/skill-test-schema.test.js`
- `tests/skill-test/skill-test-e2e.test.js`
- `tests/storage/run-store.test.js`
- `public/eval-cases.html`
- `public/skill-tests.js`
- `public/skill-tests/panel-state-view.js`
- `public/skill-tests/summary-view.js`
- `public/skill-tests/selected-skill-overview-view.js`
- `public/skill-tests/chain-rail-view.js`
- `public/skill-tests/run-detail-view.js`
- `public/skill-tests/environment-view.js`
- `public/skill-tests/case-list-view.js`
- `public/skill-tests/case-runs-view.js`
- `public/skill-tests/case-detail-view.js`
- `public/skill-tests/case-detail-data-view.js`
- `public/skill-tests/case-form-view.js`

### Integration Points

- `server/domain/conversation/turn/agent-prompt.ts`
- `server/domain/runtime/agent-tool-bridge.ts`
- `server/domain/conversation/turn/agent-sandbox.ts`
- `lib/minimal-pi.ts`

## Phase Scope

### Phase 1 (Completed)

- ✅ Dynamic-mode trigger detection via target `SKILL.md` read
- ✅ L1 tool matching for legacy execution checks (including runtime alias normalization such as `participants` -> `list-participants`)
- ✅ eval-case integration baseline

### Phase 2 (Completed)

- ✅ Full-mode trigger judge (compatibility path)
- ✅ L2 parameter structure validation
- ✅ L3 ordered tool sequence validation
- ✅ provider/model/promptVersion regression buckets

### Phase 3 (Completed: Workstream B/C/D/E)

- ✅ **B Generator / Judge Contract**:
  - full draft canonical output (`userPrompt`, `expectedGoal`, `expectedSteps`, `evaluationRubric`)
  - stable `step-{n}` / `strongSignals[].id`
  - judge structured output + strict validator and parse-failed downgrade
- ✅ **C Aggregation / Persistence / Regression**:
  - timeline id normalization + evidence-bound sequence scoring
  - `aggregateFullVerdict()` and verdict pass semantics
  - `evaluation_json` truth source + projection mismatch/failure diagnostics
- ✅ **D UI Editor / Result UX**:
  - unified issues panel across create/edit/run
  - full run diagnostic rendering for steps/constraints/aggregation/aiJudge
- ✅ **E Tests / Rollout**:
  - contract + e2e regression matrix expanded
  - rollout checklist added at `.trellis/tasks/skill-testing/rollout-checklist.md`

## Testing & Rollout Guidelines

Run this baseline before release:

```bash
npm run check
npm run build
node --test tests/skill-test/skill-test-schema.test.js
node --test tests/skill-test/skill-test-generator.test.js
node --test tests/skill-test/skill-test-e2e.test.js
node --test tests/storage/run-store.test.js
```

When adding or changing skill behavior, ensure:

- dynamic and full contracts remain schema-valid
- issue codes remain stable across save/run/judge paths
- regression buckets still compare equivalent case/provider/model/promptVersion slices
- UI diagnostics remain readable for `error | warning | needs-review`
