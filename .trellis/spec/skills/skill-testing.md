# Skill Testing Framework

## Overview

The skill testing framework evaluates whether agents correctly identify and execute skills. It builds on the existing eval-cases infrastructure and provides:

1. **Trigger Testing**: Verifies that agents correctly identify and invoke a skill
2. **Execution Testing**: Validates correct tool usage specified by the skill
3. **Automated Test Generation**: AI-powered generation of test prompts from skill content
4. **Regression Testing**: Persistent test cases for comparing prompt/model changes

## Architecture

### Data Model

```sql
-- Skill test cases (persistent test definitions)
CREATE TABLE skill_test_cases (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  eval_case_id TEXT,                    -- Links to eval_cases
  test_type TEXT NOT NULL DEFAULT 'trigger',  -- 'trigger' | 'execution'
  loading_mode TEXT NOT NULL DEFAULT 'dynamic',  -- 'dynamic' | 'full'
  trigger_prompt TEXT NOT NULL,         -- Generated/user-provided prompt
  expected_tools_json TEXT NOT NULL DEFAULT '[]',  -- Expected tool calls
  expected_behavior TEXT NOT NULL DEFAULT '',  -- AI judge criteria (future)
  validity_status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'validated' | 'invalid'
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Skill test runs (execution results)
CREATE TABLE skill_test_runs (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  eval_case_run_id TEXT,                -- Links to eval_case_runs
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'running' | 'succeeded' | 'failed'
  actual_tools_json TEXT NOT NULL DEFAULT '[]',  -- Actual tool calls
  tool_accuracy REAL,                    -- Tool name match rate (0-1)
  trigger_passed INTEGER,               -- 1 = skill was triggered
  execution_passed INTEGER,              -- 1 = tools called correctly (NULL if trigger failed)
  error_message TEXT DEFAULT '',
  created_at TEXT NOT NULL
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

Each `skill_test_case` auto-creates an `eval_case` for integration with existing eval infrastructure.
Each `skill_test_run` auto-creates an `eval_case_run` for result tracking.
`eval_case_runs.prompt_version` stores the effective prompt version for each run so Phase 2 regression views can compare the same case across prompt/model combinations.

## Evaluation Logic

### Two-Stage Gating

```
Step 1: Trigger Evaluation
  - Check if skill was identified and invoked
  - Dynamic mode: Detect `read-skill(skillId)` in tool calls
  - Full mode: Combine behavior-signal matching with AI judge over assistant evidence

  Result: trigger_passed = 1 | 0

Step 2: Execution Evaluation (only if trigger_passed = 1)
  - Compare actual tools vs expected tools
  - L1: Tool name matching (Phase 1)
  - L2: Parameter structure validation (Phase 2)
  - L3: Call sequence verification (Phase 2)

  Result:
    - tool_accuracy = matched / expected
    - execution_passed = (tool_accuracy >= threshold) ? 1 : 0
    - if L3 sequence is enabled, `execution_passed` additionally requires sequence pass
    - NULL if trigger_passed = 0
```

### Trigger Detection (Dynamic Mode)

Trigger is detected when:

1. **Tool call event** (from `a2a_task_events` table):
   ```sql
   WHERE event_type = 'agent_tool_call'
     AND tool = 'read-skill'
     AND json_extract(request, '$.skillId') = @targetSkillId
   ```

2. **Session file tool call** (from session JSONL):
   ```javascript
   // Extract from assistant messages
   if (block.type === 'toolCall' && block.name === 'read') {
     // Check if path contains /skills/<skillId>/
     const match = path.match(/\/skills\/([^/]+)\//);
     if (match && match[1] === skillId) trigger = true;
   }
   ```

### Trigger Detection (Full Mode - Phase 2)

Full-mode trigger evaluation now uses two signals in parallel:

1. **Behavior/text cues**
   - Build loose trigger signals from `skill.name`, `skill.description`, `expectedBehavior`, and case note
   - Match those signals against assistant output + assistant thinking extracted from the session JSONL
   - If any signal matches and the run produced observable output, `signalMatched = true`

2. **AI judge**
   - When observable evidence exists, run a lightweight judge prompt through `startRun()` with the same provider/model
   - The judge only sees the captured evidence (`triggerPrompt`, `expectedBehavior`, skill metadata/body excerpt, assistant output, observed tools)
   - It must return compact JSON:
     ```json
     {"passed": true, "confidence": 0.92, "reason": "...", "matchedBehaviors": ["..."]}
     ```
   - Parse failures or judge errors do not fail the test run; they are recorded under `triggerEvaluation.aiJudge`

Full-mode `trigger_passed` becomes true when any of these sources pass:
- `expectedToolMatched`
- `signalMatched`
- `aiJudge.passed === true`

Per-run result JSON stores:
- `triggerEvaluation.matchedSignals`
- `triggerEvaluation.decisionSources`
- `triggerEvaluation.aiJudge` (`attempted`, `passed`, `confidence`, `reason`, `matchedBehaviors`, `errorMessage`)

### Execution Evaluation (L1 - Phase 1)

```typescript
function evaluateExecution(expectedTools: string[], actualTools: string[]): {
  toolAccuracy: number;
  executionPassed: number;
} {
  const matched = expectedTools.filter(exp =>
    actualTools.some(act => act === exp)
  );

  const toolAccuracy = expectedTools.length > 0
    ? matched.length / expectedTools.length
    : 1;

  const EXECUTION_THRESHOLD = 0.8; // 80% match rate required

  return {
    toolAccuracy,
    executionPassed: toolAccuracy >= EXECUTION_THRESHOLD ? 1 : 0
  };
}
```

### Execution Evaluation (L2 - Phase 2)

`expectedTools` now supports either plain tool names or structured specs:

```json
[
  {
    "name": "read-skill",
    "order": 1,
    "arguments": {
      "skillId": "werewolf"
    }
  },
  {
    "name": "send-public",
    "order": 2,
    "requiredParams": ["content"],
    "arguments": {
      "content": "<string>"
    }
  }
]
```

L2 keeps the L1 tool-name gate, then additionally checks whether at least one matching call satisfies:
- `requiredParams`: dot-paths that must exist in the actual tool arguments
- `arguments`: partial argument-shape match; placeholder values such as `<string>`, `<number>`, `<boolean>`, `<array>`, `<object>`, and `<any>` are supported
- `arguments` also supports `<contains:...>` for generator-produced partial string matches (for example placeholder-heavy file paths or long shell commands)

### Execution Evaluation (L3 - Phase 2)

Structured expected tools may also declare `order` (positive integer). When at least one expected tool has an `order` value:
- execution still uses L1/L2 matching to compute `toolAccuracy`
- `executionEvaluation.sequenceCheck` verifies the ordered subset appears in the observed tool timeline in ascending order
- `execution_passed` requires both the L1/L2 threshold and `sequenceCheck.passed = true`

Observed order is reconstructed from a single timeline source to avoid cross-source false positives: use the session tool-call timeline first (with lightweight alias inference for chat-bridge shell commands such as `read-skill` and `send-public`), and fall back to `agent_tool_call` events only when the session has no tool-call timeline.

Per-run detail stores both `executionEvaluation.toolChecks[]` and `executionEvaluation.sequenceCheck` in `eval_case_runs.result_json`, so the UI can show which tool was missing, which parameter path was absent, and whether the ordered tools appeared in the wrong position.

## Test Case Generation

### AI-Powered Generation (`lib/skill-test-generator.ts`)

**Goal**: Generate natural-language prompts that trigger specific skills.

**Process**:

1. **Seed Extraction**: Parse skill SKILL.md for:
   - Action verbs (e.g., "投票", "发言", "执行")
   - Context keywords (e.g., "狼人杀", "谁是卧底")
   - Tool names mentioned in examples

2. **Few-Shot Prompting**: Provide 2-3 examples of good triggers:
   ```text
   Skill: werewolf (description: 后端全自动主持的狼人杀玩法...)
   Good trigger: "我们来玩一局狼人杀吧！我来当玩家"
   Bad trigger: "狼人杀是什么？" (This is a question, won't trigger execution)
   ```

3. **Generate**: AI produces N trigger prompts for the skill.

   For `execution`-focused cases, the generator also derives structured `expectedTools` directly from skill-body examples:
   - fenced bash/code snippets
   - inline backticked commands and tool names
   - plain-text workflow lines that contain command examples (for example `**[2/4] python3 ...**`)
   - placeholder-heavy paths/commands are normalized into partial string checks such as `<contains:.trellis/spec>`

4. **Smoke Run Validation**: Auto-execute each prompt:
   - Trigger success → `validity_status = 'validated'`
   - Trigger fail → `validity_status = 'invalid'`

### Manual Test Case Creation

Users can manually create test cases via API:

```javascript
POST /api/skills/:skillId/test-cases
{
  "testType": "trigger",           // or "execution"
  "loadingMode": "dynamic",        // or "full"
  "triggerPrompt": "我们来玩狼人杀",
  "expectedTools": [
    {
      "name": "read-skill",
      "order": 1,
      "arguments": { "skillId": "werewolf" }
    },
    {
      "name": "send-public",
      "order": 2,
      "requiredParams": ["content"],
      "arguments": { "content": "<string>" }
    }
  ],
  "expectedBehavior": "Agent should call read-skill for werewolf",
  "note": "Manual test case"
}
```

## API Endpoints

### Test Case Management

```
GET    /api/skills/:skillId/test-cases           -- List test cases
POST   /api/skills/:skillId/test-cases           -- Manual create
POST   /api/skills/:skillId/test-cases/generate  -- AI generate
GET    /api/skills/:skillId/test-cases/:caseId   -- Get single case
GET    /api/skills/:skillId/test-cases/:caseId/regression -- Case-level regression buckets by provider/model/promptVersion
DELETE /api/skills/:skillId/test-cases/:caseId   -- Delete case
```

### Test Execution

```
POST /api/skills/:skillId/test-cases/:caseId/run   -- Run single test
POST /api/skills/:skillId/test-cases/run-all       -- Run all `validated` and `invalid` cases
```

### Results and Reports

```
GET /api/skills/:skillId/test-cases/:caseId/runs   -- Run history for case
GET /api/skills/:skillId/test-runs                 -- All runs for skill
GET /api/skills/:skillId/regression                -- Skill-level regression buckets by provider/model/promptVersion
GET /api/skill-test-runs/:runId                    -- Single run detail + debug
GET /api/skill-test-summary                        -- Global summary
```

## Test Execution Flow

```
1. Prepare Test
   - Load test case
   - Ensure agent sandbox exists
   - Set up eval_case linkage

2. Configure Environment
   - CAFF_SKILL_LOADING_MODE = testCase.loadingMode
   - PI_AGENT_SANDBOX_DIR points to skill registry
   - Tool bridge enabled (dry-run mode)

3. Execute Agent Run
   - Start pi runtime with trigger_prompt
   - Register tool invocation
   - Await completion

4. Evaluate Results
   - Collect tool calls from a2a_task_events + session file
   - Check trigger (read-skill or behavior match)
   - Check execution (tool matching)

5. Persist Results
   - Create eval_case_run
   - Create skill_test_run
   - Update test case validity_status (`pending` → `validated`/`invalid`)
```

## Metrics and Reporting

### Summary by Skill

```json
{
  "skillId": "werewolf",
  "totalCases": 10,
  "casesByValidity": {
    "validated": 8,
    "invalid": 2
  },
  "totalRuns": 50,
  "triggerPassedCount": 40,
  "executionPassedCount": 38,
  "triggerRate": 0.8,        // 40 / 50
  "executionRate": 0.95,      // 38 / 40
  "avgToolAccuracy": 0.92
}
```

### Run Detail with Debug

```json
{
  "run": {
    "id": "...",
    "status": "succeeded",
    "triggerPassed": 1,
    "executionPassed": 1,
    "toolAccuracy": 0.9
  },
  "debug": {
    "taskId": "...",
    "sessionPath": "/path/to/session.jsonl",
    "outputText": "...",
    "toolCalls": [...],
    "session": {
      "thinking": "...",
      "text": "...",
      "toolCalls": [...]
    }
  }
}
```

## Implementation Files

### Core Components

- `lib/skill-test-generator.ts`: AI test case generation
- `server/api/skill-test-controller.ts`: HTTP endpoints and execution logic
- `storage/sqlite/migrations.ts`: Database schema migrations
- `tests/skill-test/skill-test-generator.test.js`: Generation logic tests
- `tests/skill-test/skill-test-schema.test.js`: Schema validation tests

### Integration Points

- `lib/minimal-pi.ts` (`startRun`): Executes agent runs for tests
- `lib/agent-chat-tools.ts`: `read-skill` CLI tool definition
- `server/domain/runtime/agent-tool-bridge.ts`: Tool invocation registration
- `server/domain/conversation/turn/agent-sandbox.ts`: Sandbox setup
- `public/skill-tests.js`: Frontend UI for test management

## Phase Scope

### Phase 1 (Current)

- ✅ Trigger testing for dynamic mode only (via `read-skill` detection)
- ✅ L1 execution testing (tool name matching)
- ✅ AI test case generation with smoke run validation
- ✅ `loading_mode` field in test cases
- ✅ Eval-case integration

### Phase 2 (In Progress)

- ✅ Full mode trigger testing (behavior matching + AI judge)
- ✅ L2 parameter structure validation
- ✅ L3 call sequence verification via ordered `expectedTools` specs (`order`)
- ✅ Regression buckets across provider/model/promptVersion for both skill-level and case-level views

## Testing Guidelines

### When to Add Skill Tests

- When creating a new skill (auto-generate initial test cases)
- When modifying skill body that affects tool usage
- When changing skill loading mode behavior
- When updating prompt templates or model configurations

### Test Coverage Targets

- Each skill should have at least 3-5 validated test cases
- Mix of trigger-focused and execution-focused test types
- Both dynamic and full mode tests (if skill supports both)

### Debugging Failed Tests

1. **Trigger failure**:
   - Check `read-skill` tool call payload
   - Verify skill registry contains the skill
   - Verify `CAFF_SKILL_LOADING_MODE` environment variable

2. **Execution failure**:
   - Compare `actualTools` vs `expectedTools`
   - Check if expected tools are correct (maybe skill changed?)
   - Review session debug output for reasoning

3. **Validity is `invalid`**:
   - Review trigger_prompt (too vague?)
   - Manually test prompt in chat
   - Consider generating new test case
