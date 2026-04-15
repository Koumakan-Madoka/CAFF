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
  generation_provider TEXT NOT NULL DEFAULT '',
  generation_model TEXT NOT NULL DEFAULT '',
  generation_created_at TEXT NOT NULL DEFAULT '',
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
  - supports async driver setup and async adapter-provided `startRun(...)` handles so remote/container backends can prepare case worlds before the pi run starts
  - creates a case-scoped writable world: sandbox dirs, project root, SQLite/chat store, skill snapshot, and audit evidence
  - the env/config-backed `OpenSandbox` adapter may upload a sandbox-side Node runner plus pi runtime assets and execute the skill-test case through `commands.run`; when that path succeeds, session JSONL is copied back into the case outputs and evidence must report `execution.runtime = sandbox`
  - sandbox direct-HTTP bridge POCs must use an explicitly reachable CAFF base URL (`CHAT_APP_ADVERTISE_URL` or `CAFF_SKILL_TEST_OPENSANDBOX_CHAT_API_URL`) instead of assuming `127.0.0.1` inside the sandbox maps back to the host service
  - default server wiring may opt into an env/config-backed `OpenSandbox` adapter; isolated publish-gate paths must fail closed when that driver is unavailable

Case-scoped isolation payload is stored under `evaluation_json.isolation` and surfaced from run-detail endpoints. The payload includes:

- `mode`, `notIsolated`, `publishGate`, `driver.{name,version}`, `sandboxId`, `runId`, `caseId`
- `trellisMode` (`none | fixture | readonlySnapshot | liveExplicit`)
- `egressMode`
- `execution.{runtime,preparedOnly,adapterStartRun,reason}` so prepared-only adapters cannot masquerade as sandbox execution, and sandbox-side runner execution stays distinguishable from remote-world preparation only
- `egress.{mode,enforced,scope,reason}` so record-only network policy requests stay explicit in evidence
- `chatBridge.{mode,configured,configuredUrl,reachable,auth,rejects}` so sandbox direct-HTTP bridge POCs show whether case-scoped credentials were validated; the auth payload must include run/case/task binding and TTL metadata but never the callback token
- `toolPolicy.allowedTools[]` and `toolPolicy.rejects[]`
- `resources` such as case project root, sandbox/private dir, isolated SQLite path, skill snapshot path, and adapter-specific remote/container resource paths when available
- `pollutionCheck` compares live `.trellis`, shared skills, and live private dirs before/after the run; shared SQLite detection must use case-scoped logical markers (skill-test task ids, case ids, conversation ids, and agent ids) within the run window instead of hashing the entire live database / `-wal` files, so unrelated room traffic does not look like isolation pollution
- isolated-mode telemetry (`a2a_tasks` / `a2a_task_events`) must write to the case-scoped run store during execution; final shared eval/result persistence happens outside the pollution-check window and stores a debug/trace snapshot for later run detail views
- OpenSandbox may use pre-baked runtime assets and a pre-baked CAFF source template, but the source template must be copied into the case-scoped project directory before execution; runner `cwd` and `CAFF_TRELLIS_PROJECT_DIR` must continue to point at the isolated case project, and case-level `.trellis` materialization must be overlaid there
- full-mode trigger/execution AI judges must reuse the same case-scoped `agentDir` + SQLite path and the same effective runtime `provider/model` as the isolated run; judge helper runs must not fall back to the live shared store or unresolved default provider selection inside the pollution-check window
- `cleanup.ok|error`; cleanup is idempotent, so an OpenSandbox `not found`/404 during cleanup means the sandbox is already gone and should not be reported as `skill_test_cleanup_failed`
- OpenSandbox Docker cleanup errors that say `removal of container ... is already in progress` are also idempotent cleanup success: the auto-expiration path already owns deletion, so CAFF must not report `skill_test_cleanup_failed` for that cleanup race
- Local Full-mode runs can exceed the default `CAFF_SKILL_TEST_OPENSANDBOX_TIMEOUT_SEC=300` while uploading/executing the case world; raise the env var (for example `3600`) rather than relying on Docker auto-expiration to clean active runs

Publish-gate interpretation rules:

- isolated publish-gate runs fail closed when `execution.runtime !== sandbox`
- isolated publish-gate runs with `egressMode = deny` fail closed unless `egress.enforced = true`

Isolation failures must surface canonical validation issues such as:

- `skill_test_not_isolated`
- `skill_test_policy_rejects_present`
- `skill_test_execution_not_sandboxed`
- `skill_test_egress_not_enforced`
- `skill_test_pollution_detected`
- `skill_test_cleanup_failed`

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

Validation rules (`validateJudgeOutput`):

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

## API Endpoints

### Test Case Management

```
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
```

Notes:

- `run-all` runs only effective `ready` cases.
- `POST /generate`, `POST /run-all`, and `POST /:caseId/run` parse JSON bodies strictly; malformed bodies must surface `400 Invalid JSON body` instead of silently falling back to default options.
- legacy rows (`validity_status`) are mapped to effective status for compatibility.

### Results and Reports

```
GET /api/skills/:skillId/test-cases/:caseId/runs
GET /api/skills/:skillId/test-cases/:caseId/regression
GET /api/skills/:skillId/test-runs
GET /api/skills/:skillId/regression
GET /api/skill-test-runs/:runId
GET /api/skill-test-summary
```

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

Frontend (`public/skill-tests.js`) consumes structured validation/evaluation:

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
- live run panel renders the active tool trace while a run is in progress and keeps the finalized trace visible after terminal events land

### Live Run SSE Contract

`server/api/skill-test-controller.ts` emits live progress over the shared `/api/events` SSE stream so the skill-tests workspace can render in-flight tool activity without waiting for the final `POST /run` response.

- `skill_test_run_event`
  - `phase`: `started | progress | output_delta | terminating | completed | failed`
  - includes `caseId`, `skillId`, `taskId`, synthetic `messageId`, provider/model metadata, status, and final `trace` on terminal phases
  - `progress` includes `executionRuntime`, `progressLabel`, optional `runnerStage`, `runnerPid`, and `runnerSessionPath` so OpenSandbox runner preparation/startup is visible before the first tool or text event
  - `output_delta` includes `delta`, accumulated `outputText`, `isFallback`, optional `messageKey`, `executionRuntime`, and `progressLabel`; the browser updates the live output preview without waiting for terminal `trace`
- `conversation_tool_event`
  - skill-test runs reuse the same live tool-step payload shape as chat workbench traces
  - payload is keyed by the synthetic skill-test `messageId` so the frontend can merge session + bridge steps with the existing step schema and CSS patterns

### Skill Tests Workspace Layout

- `public/eval-cases.html` keeps the Skill Tests workspace in a single-column-first flow: sticky top toolbar → overview → case list → detail → create → summary, with wide-screen enhancement only at larger breakpoints.
- The sticky toolbar is the only always-pinned control surface for high-frequency actions (`skill`, `agent`, `model`, `promptVersion`, run isolation defaults such as `isolationMode` / `trellisMode` / `egressMode` / `publishGate`, plus generate / manual create / run-all); page-level horizontal scrolling should be avoided outside local table overflow.
- The detail area stays tabbed (`overview`, `details`, `runs`, `regression`) so long histories and regression output do not crowd the editor surface.
- The detail header keeps case status, last-outcome summary, and primary actions visible at the top of the detail card, but it intentionally remains in normal document flow (`position: static`) instead of becoming sticky, because zoomed desktop layouts made a sticky header float above the workspace and obscure nearby content.
- Case list cards should expose short case id, status, recent run context, and direct run/detail actions, plus lightweight search/filter by `case id` or prompt keywords.
- Empty, loading, and failure states should point to the next action (`generate`, `manual create`, `retry`, `clear filter`) instead of leaving the workspace blank.

## Implementation Files

### Core Components

- `lib/skill-test-generator.ts`
- `server/api/skill-test-controller.ts`
- `storage/sqlite/migrations.ts`
- `tests/skill-test/skill-test-generator.test.js`
- `tests/skill-test/skill-test-schema.test.js`
- `tests/skill-test/skill-test-e2e.test.js`
- `tests/storage/run-store.test.js`
- `public/skill-tests.js`

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
