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
- `eval_case_runs.prompt_version` is the regression bucket key with provider/model.

## Evaluation Logic

### Mode Semantics (Phase 3)

- **Dynamic mode (default)**:
  - primary goal: load/trigger evidence
  - `trigger_passed` is based on target `SKILL.md` read evidence
  - execution gate is only meaningful for legacy dynamic execution cases (`test_type = execution`)

- **Full mode**:
  - primary goal: behavior-chain quality evaluation (`expectedSteps`, constraints, goal/adherence)
  - run output is a structured `evaluation` object with dimensions and aggregated verdict
  - `execution_passed = 1` only when `evaluation.verdict === 'pass'`

### Dynamic Trigger Detection

Trigger is detected when either source contains a target read:

1. **Tool call event** (`a2a_task_events`)
2. **Session JSONL tool blocks**

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

For full mode, regression/summary `executionPassedCount` uses verdict-pass semantics.
- `executionRate` uses only execution-eligible runs as its denominator (full mode runs plus legacy dynamic execution cases); trigger-only dynamic runs are excluded from both numerator and denominator.

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

### Skill Tests Workspace Layout

- `public/eval-cases.html` keeps the Skill Tests workspace in a single-column-first flow: sticky top toolbar → overview → case list → detail → create → summary, with wide-screen enhancement only at larger breakpoints.
- The sticky toolbar is the only always-pinned control surface for high-frequency actions (`skill`, `agent`, `model`, `promptVersion`, generate, manual create, run-all); page-level horizontal scrolling should be avoided outside local table overflow.
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
- ✅ L1 tool matching for legacy execution checks
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
