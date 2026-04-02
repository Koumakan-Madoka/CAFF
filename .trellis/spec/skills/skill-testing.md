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
  validity_status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'validated' | 'needs_review'
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

## Evaluation Logic

### Two-Stage Gating

```
Step 1: Trigger Evaluation
  - Check if skill was identified and invoked
  - Dynamic mode: Detect `read-skill(skillId)` in tool calls
  - Full mode: Check if behavior matches skill (future: AI judge)

  Result: trigger_passed = 1 | 0

Step 2: Execution Evaluation (only if trigger_passed = 1)
  - Compare actual tools vs expected tools
  - L1: Tool name matching (Phase 1)
  - L2: Parameter structure validation (Phase 2)
  - L3: Call sequence verification (Phase 2)

  Result:
    - tool_accuracy = matched / expected
    - execution_passed = (tool_accuracy >= threshold) ? 1 : 0
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

4. **Smoke Run Validation**: Auto-execute each prompt:
   - Trigger success → `validity_status = 'validated'`
   - Trigger fail → `validity_status = 'needs_review'`

### Manual Test Case Creation

Users can manually create test cases via API:

```javascript
POST /api/skills/:skillId/test-cases
{
  "testType": "trigger",           // or "execution"
  "loadingMode": "dynamic",        // or "full"
  "triggerPrompt": "我们来玩狼人杀",
  "expectedTools": ["read-skill", "http-post"],
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
DELETE /api/skills/:skillId/test-cases/:caseId   -- Delete case
```

### Test Execution

```
POST /api/skills/:skillId/test-cases/:caseId/run   -- Run single test
POST /api/skills/:skillId/test-cases/run-all       -- Run all validated cases
```

### Results and Reports

```
GET /api/skills/:skillId/test-cases/:caseId/runs   -- Run history for case
GET /api/skills/:skillId/test-runs                 -- All runs for skill
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
   - Update test case validity_status (pending → validated/needs_review)
```

## Metrics and Reporting

### Summary by Skill

```json
{
  "skillId": "werewolf",
  "totalCases": 10,
  "casesByValidity": {
    "validated": 8,
    "needs_review": 2
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

### Phase 2 (Future)

- ⬜ Full mode trigger testing (behavior matching + AI judge)
- ⬜ L2 parameter structure validation
- ⬜ L3 call sequence verification
- ⬜ A/B regression comparison across prompt versions/models

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

3. **Validity stuck at 'needs_review'**:
   - Review trigger_prompt (too vague?)
   - Manually test prompt in chat
   - Consider generating new test case
