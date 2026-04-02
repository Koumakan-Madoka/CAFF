# PRD: Skill 自动化测试框架

## 背景

CAFF 现有完整的 Agent 评测基础设施（"错题本" eval-cases）：

- **Eval Cases 系统**：`eval_cases` + `eval_case_runs` 表，支持从会话中提取 assistant turn 作为测试用例，A/B 对比回放
- **Tool Call 埋点**：`a2a_task_events` 表记录 `agent_tool_call` 事件，含工具名、状态、耗时
- **Expectations 标签**：`agent_expectations` 事件为每个 turn 标注工具期望（required/forbidden/optional），构建混淆矩阵
- **Agent Eval Report**：`buildAgentEvalReport()` 按 agent 聚合工具聊天率、recall、FPR、延迟分位数
- **Eval Cases UI**：前端 `eval-cases.html` + `eval-cases.js`，支持用例管理、单条/批量回放、结果对比

但目前 **没有针对 Skill 的系统性测试机制**。Skill 是注入到 Agent prompt 中的指令集，用户无法验证：
1. 某条 skill 是否被 Agent 正确识别和触发（触发测试）
2. Skill 中的工具调用指令是否被 Agent 正确执行（执行测试）
3. Skill 的整体效果是否随 prompt/model 变化而回归（回归测试）

## 目标

复用现有 eval-cases 基础设施，构建 **Skill 自动化测试框架**：

### 1. 触发测试（Trigger Test）
- 让 AI 根据 skill 的 name + description + body 自动生成触发场景（用户消息）
- 将生成的场景作为 prompt 发送给 Agent，验证 Agent 是否正确识别并触发该 skill
- 判定标准：skill 是否出现在 Agent 的工具调用链路中（如 `read-skill` 调用，或 skill 指令被遵循）

### 2. 执行测试（Execution Test）
- 重点测试 skill 中涉及的工具调用正确率
- 基于 skill 的指令，构造需要调用特定工具的 prompt
- 通过 `agent_tool_call` 埋点验证：
  - 工具是否被调用（recall）
  - 调用参数是否正确（参数校验）
  - 调用结果是否符合预期（success rate）

### 3. 回归测试（Regression Test）
- 将 skill 测试用例持久化到 `eval_cases` / `eval_case_runs`
- 支持 prompt version / model 切换后的回归对比

## 技术方案

### 数据链路

```
skill_test_cases (1) ──→ (N) skill_test_runs
       │                        │
       │ eval_case_id           │ eval_case_run_id
       ▼                        ▼
   eval_cases (1) ──→ (N) eval_case_runs
```

每条 `skill_test_case` 自动关联一条 `eval_case`（以 skill 维度的测试场景作为 eval case）。
每次 `skill_test_run` 执行时，自动创建对应的 `eval_case_run`，其 ID 回填到 `skill_test_runs.eval_case_run_id`。

### 判定阶段门控（触发/执行解耦）

```
skill_test_run 执行 → 收集 tool_call 事件
  │
  ├─ Step 1: trigger_passed？
  │    dynamic 模式：检测 tool_calls 中是否存在 read-skill(skill_id)
  │    → YES: trigger_passed = 1，继续 Step 2
  │    → NO:  trigger_passed = 0，execution_passed = NULL（跳过执行评判）
  │
  └─ Step 2: execution_passed？（仅 trigger_passed=1 时执行）
       L1: actual_tools ∩ expected_tools 的匹配率
       → tool_accuracy = |matched| / |expected|
       → execution_passed = (tool_accuracy >= threshold) ? 1 : 0
```

**报告维度**：触发通过率、执行通过率（仅触发成功样本）、工具调用准确率——三者独立统计，互不干扰。

### 数据模型

在现有 `eval_cases` 基础上扩展：

```sql
-- Skill 测试用例表
CREATE TABLE IF NOT EXISTS skill_test_cases (
  id        TEXT PRIMARY KEY,
  skill_id  TEXT NOT NULL,
  eval_case_id TEXT,                           -- 关联到 eval_cases，创建时自动生成
  test_type TEXT NOT NULL DEFAULT 'trigger',  -- 'trigger' | 'execution'
  loading_mode TEXT NOT NULL DEFAULT 'dynamic', -- 'dynamic' | 'full' — 适用的 skill 加载模式
  trigger_prompt TEXT NOT NULL,                -- 生成的触发 prompt
  expected_tools_json TEXT NOT NULL DEFAULT '[]', -- 期望调用的工具列表
  expected_behavior TEXT NOT NULL DEFAULT '',   -- 期望行为描述（AI 判定用）
  validity_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'validated' | 'invalid' — 可触发验证状态
  note      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Skill 测试运行记录（复用 eval_case_runs 的 run 机制）
CREATE TABLE IF NOT EXISTS skill_test_runs (
  id        TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  eval_case_run_id TEXT,                       -- 关联到 eval_case_runs，执行时自动创建
  status    TEXT NOT NULL DEFAULT 'pending',
  actual_tools_json TEXT NOT NULL DEFAULT '[]', -- 实际调用的工具
  tool_accuracy REAL,                          -- 工具调用准确率（仅 trigger_passed=1 时计算）
  trigger_passed INTEGER,                      -- 触发是否成功 (0/1)
  execution_passed INTEGER,                    -- 执行是否成功 (0/1/NULL)，NULL 表示跳过
  error_message TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (test_case_id) REFERENCES skill_test_cases(id)
);
```

### 测试用例生成策略

生成流程分三步：

**Step 1 — 种子提取**：从 skill body 中提取关键动词和场景词
- 解析 skill 的 name、description、SKILL.md body
- 提取动作词（如"投票""发言""执行"）和场景词（如"狼人杀""谁是卧底"）
- 识别 skill 涉及的工具名列表（从 body 中的工具调用示例提取）

**Step 2 — Few-shot 模板生成**：
提供 2-3 个标注好的「skill → 好的触发 prompt」示例，让 AI 知道输出格式和风格：
```
输入：skill "狼人杀"（description: 后端全自动主持的狼人杀玩法...）
好的触发 prompt：「我们来玩一局狼人杀吧！我来当玩家」
坏的触发 prompt：「狼人杀是什么？」（这只是提问，不会触发 skill 执行）
```

**Step 3 — Smoke run 验证**：生成后自动执行一次，检测是否成功触发 `read-skill`
- 触发成功 → `validity_status = 'validated'`
- 触发失败 → `validity_status = 'invalid'`，不纳入后续批量测试

### 前端方案

**扩展 `eval-cases.html`**：在现有页面增加「Skill Tests」tab 页签，复用已有 UI 组件和样式。
- 列表视图：按 skill 分组展示测试用例，显示 validity_status、最近一次 run 结果
- 运行面板：单条执行 / 全量执行按钮，实时进度条
- 结果统计：按 skill 聚合触发通过率、执行通过率、工具调用准确率（三栏独立）
- 详情弹窗：单次 run 的 tool_calls 明细，触发/执行阶段各自的状态

### 关键代码改动

1. **新增 `lib/skill-test-generator.ts`** — 基于 skill 内容自动生成触发测试 prompt（种子提取 + few-shot）
2. **新增 `lib/skill-test-validator.ts`** — 生成后的可触发验证（smoke run + validity 标记）
3. **新增 `server/api/skill-test-controller.ts`** — Skill 测试 REST API
4. **复用 `server/api/eval-cases-controller.ts` 的 run 机制** — 实际执行测试用例（自动创建 eval_case + eval_case_run）
5. **复用 `server/domain/metrics/agent-eval-report.ts`** — 测试结果聚合
6. **扩展 `public/eval-cases.html` + `public/eval-cases.js`** — 新增 Skill Tests tab，复用现有 UI 组件

### API 设计

```
GET    /api/skills/:skillId/test-cases           — 列出 skill 的测试用例
POST   /api/skills/:skillId/test-cases/generate  — AI 自动生成测试用例
POST   /api/skills/:skillId/test-cases           — 手动创建测试用例
POST   /api/skills/:skillId/test-cases/:id/run   — 执行单个测试用例
POST   /api/skills/:skillId/test-cases/run-all   — 执行全部测试用例
GET    /api/skills/:skillId/test-runs            — 查看测试运行历史
GET    /api/skill-test-summary                   — 全局 skill 测试概览
```

## 实施策略调整（Phase 1 简化）

基于 review 反馈，对实施范围做以下调整：

### Phase 1 范围缩减
1. **触发测试仅覆盖 dynamic 模式**：利用 `read-skill` 工具调用做明确的二值判定，不做 AI judge
2. **执行测试 L1 工具名匹配**：Phase 1 只做工具名级别匹配，不涉及参数结构校验
3. **新增「可触发验证」步骤**：AI 生成测试用例后，自动执行 smoke run，触发率为 0 则标记为 `invalid`
4. **`loading_mode` 字段**：`skill_test_cases` 表增加 `loading_mode` 列，区分 dynamic/full 用例

### Phase 2 扩展
1. Full 模式触发检测（行为匹配 + AI judge）
2. L2 参数结构校验（从 skill body 中 parse 示例参数，自动生成 expected params）
3. L3 调用时序校验

## 验收标准

### Phase 1
- [ ] 可为任意 skill 自动生成触发测试 prompt（基于 skill name + description + body）
- [ ] 生成后自动进行可触发验证（smoke run），标记无效用例
- [ ] 触发测试仅覆盖 dynamic 模式（通过 `read-skill` 调用判定）
- [ ] 执行测试仅做 L1 工具名匹配
- [ ] 可手动创建自定义测试用例（指定 trigger prompt + 期望工具 + 期望行为）
- [ ] 测试用例标记 `loading_mode`，区分 dynamic / full
- [ ] 测试结果持久化，可按 skill 聚合查看通过率和工具调用准确率
- [ ] 前端可查看 skill 测试列表、运行结果、通过率统计

### Phase 2
- [ ] 支持 A/B 回归：不同 prompt version / model 对比同一 skill 测试用例的表现
- [ ] Full 模式触发检测（行为匹配 + AI judge）
- [ ] L2 参数结构校验（从 skill body parse 示例参数）
- [ ] L3 调用时序校验

## 实现注意事项（Review 反馈 #3 — 菲比啾比）

### 1. 触发判定的埋点复用
`agent-tool-bridge.ts` 中 `read-skill` 工具调用已有完整的 `agent_tool_call` 事件埋点，包含 `request.skillId` 和 `result.skillId`。
Phase 1 触发判定直接查 `a2a_task_events` 表：
```sql
WHERE event_type = 'agent_tool_call' AND tool = 'read-skill' AND json_extract(request, '$.skillId') = :targetSkillId
```
**无需额外埋点。**

### 2. Skill 上下文环境配置
Skill 测试 run 需要 Agent 运行在「有 skill 描述符注入」的环境下。`agent-prompt.ts` 在 prompt 构建时注入 skill 描述符。
skill test run 的 env 配置要点：
- `PI_AGENT_SANDBOX_DIR` 指向包含对应 skill 的 sandbox 目录
- skill registry 路径正确，使 prompt 构建能注入 skill 描述符
- 否则 Agent 看不到 skill，自然不会触发 `read-skill`

### 3. `test_type` 字段语义
按当前门控设计（先触发、触发成功后执行），每个用例天然同时覆盖触发和执行。
Phase 1 该字段**保留但改含义**为「侧重点」标记：
- `trigger`：主要验证能否触发（expected_tools 为空或少量）
- `execution`：主要验证工具调用正确性（expected_tools 较完整）
报告时按侧重点分别聚合。

### 4. Smoke run 成本优化
批量生成后统一 smoke run，而非逐条执行。优化策略：
- **静态筛选**（生成阶段）：检查 skill 是否存在于 registry 中、trigger prompt 长度是否合理（< 5 字或 > 500 字直接标记 invalid）
- **批量执行**：通过筛选的用例进入 smoke run 队列，统一执行
- 减少无意义的 `startRun()` 调用，节省 token 消耗

## 调研要点（本阶段产出）

1. 现有 eval-cases 系统的完整能力边界（哪些可直接复用，哪些需要扩展）
2. Skill 触发检测机制（如何判定 skill 被"触发"——read-skill 调用？指令遵循？行为匹配？）
3. 工具调用正确率的判定维度（工具名匹配、参数结构校验、调用时序）
4. AI 自动生成测试 prompt 的策略（few-shot？基于 skill body 的结构化模板？）
5. 与现有 skill loading mode（full/dynamic）的交互影响
