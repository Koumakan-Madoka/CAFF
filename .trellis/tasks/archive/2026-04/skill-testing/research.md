# Skill 测试调研报告

## 一、现有基础设施能力边界

### 1.1 Eval Cases 系统（可直接复用 ✅）

| 能力 | 说明 | 复用程度 |
|------|------|---------|
| 用例 CRUD | `eval_cases` 表，含 prompt_a/output_a/prompt_b/output_b | ✅ 直接复用 |
| A/B 回放 | 单条用例可变体 A/B 重跑，对比 prompt 改动效果 | ✅ 直接复用 |
| Session 快照 | 从 `a2a_tasks.session_path` 解析 assistant 消息、thinking、tool_calls | ✅ 直接复用 |
| Tool Call 采集 | `readSessionAssistantSnapshot()` 解析 session JSONL 中的 tool_call 事件 | ✅ 直接复用 |
| Agent Tool Bridge | `createInvocation()` + dryRun 模式拦截工具调用 | ✅ 直接复用 |
| 批量运行 | 前端 `runBatchButton` 支持选 model + 重复次数 | ✅ 直接复用 |

**需扩展的部分：**
- `eval_cases` 表缺少 `skill_id` 和 `test_type` 字段 → 新建 `skill_test_cases` 关联表或 ALTER TABLE
- `agent_expectations` 目前只标注 `send-public/send-private/read-context` 等通用工具 → 需扩展为可标注 skill 级别的期望
- 批量运行后缺少自动化判定逻辑 → 需新增 skill 测试专用的 pass/fail 判定

### 1.2 Agent Eval Report（可直接复用 ✅）

| 能力 | 说明 |
|------|------|
| 按 agent 聚合 | turns、toolChatRate、send-public/private 混淆矩阵 |
| 全局工具聚合 | 每个工具的 calls/succeeded/failed/p50/p95 |
| Expectations 匹配 | TP/FP/FN/TN 四格表 |

**复用方式：** 直接调用 `buildAgentEvalReport(db, { agentId })` 即可获取工具调用统计。Skill 测试的"执行测试"结果可映射到这套指标体系。

### 1.3 Skill Registry（只读引用 ✅）

`SkillRegistry` 提供：
- `listSkills()` — 列出所有 skill（含 external）
- `getSkill(id)` — 获取 skill 完整内容（name/description/body/files）
- `resolveSkills(ids)` — 按 ID 批量解析

测试生成器需调用这些方法读取 skill 内容来生成测试 prompt。

## 二、Skill 触发检测机制

### 2.1 什么是"触发"？

Skill 的"触发"有两种定义层级：

**层级一：加载触发（Dynamic 模式）**
- Skill 以描述符注入 → Agent 通过 `read-skill` 工具加载完整内容
- 检测方法：`agent_tool_call` 事件中 `tool = 'read-skill'` 且 `request.skillId` 匹配
- 优点：明确的二值判定（调用了/没调用）
- 缺点：仅适用于 `dynamic` 加载策略

**层级二：行为触发（Full 模式）**
- Skill 完整内容已注入 prompt → 无法通过工具调用来检测
- 检测方法：
  1. **工具调用匹配**：Skill 指令中提到的工具是否被调用（如 skill "狼人杀" 指示使用 `send-private`，则检查是否有 send-private 调用）
  2. **输出内容匹配**：Agent 回复中是否包含 skill 要求的关键行为（如提到了 skill 特有词汇）
  3. **AI 判定**：用一个独立的 LLM 调用来判定 Agent 行为是否符合 skill 指令

### 2.2 推荐方案

```typescript
interface SkillTriggerResult {
  skillId: string;
  triggered: boolean;
  detectionMethod: 'read-skill-call' | 'tool-match' | 'behavior-match' | 'ai-judge';
  evidence: {
    readSkillCalled?: boolean;
    matchedTools?: string[];
    matchedKeywords?: string[];
    aiJudgeScore?: number;  // 0-1
  };
}
```

- Dynamic 模式优先检查 `read-skill` 调用
- Full 模式优先检查工具调用匹配
- 兜底使用 AI judge（基于 skill body 生成判定 prompt）

## 三、工具调用正确率判定维度

### 3.1 判定层级

| 层级 | 说明 | 实现方式 |
|------|------|---------|
| L1: 工具名匹配 | 正确的工具是否被调用 | `agent_tool_call.tool` 与 expected 对比 |
| L2: 参数结构校验 | 调用参数是否符合预期格式 | JSON schema 校验 `event_json.request` |
| L3: 调用时序校验 | 工具调用顺序是否正确 | 按 `created_at` 排序检查 |
| L4: 结果正确性 | 工具调用结果是否符合预期 | 检查 `event_json.result` 或后续行为 |

### 3.2 指标计算

```
toolAccuracy = matchedTools / expectedTools
parameterAccuracy = validParams / totalToolCalls
executionSuccessRate = succeededCalls / totalCalls
```

### 3.3 从现有埋点获取数据

```typescript
// 已有的 agent_tool_call 事件结构
interface ToolCallEvent {
  tool: string;           // 'send-public' | 'send-private' | 'read-skill' | ...
  status: string;         // 'succeeded' | 'failed'
  durationMs: number;
  request: { skillId?: string; };  // 工具请求参数
  result: { skillId?: string; };   // 工具结果
  error?: { statusCode: number; message: string; };
}
```

L1 和 L4 可直接从现有埋点获取；L2 参数校验需要扩展判定逻辑；L3 时序校验需新增。

## 四、AI 自动生成测试 Prompt 的策略

### 4.1 方案对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| Few-shot 模板 | 确定性强、速度快 | 需要手工维护模板 |
| 基于 skill body 结构化生成 | 覆盖全面 | 生成质量取决于 LLM |
| 混合策略（模板 + LLM 扩展） | 兼顾确定性和覆盖度 | 实现复杂度中等 |

### 4.2 推荐混合策略

```
Step 1: 解析 skill body，提取关键指令和工具调用要求
Step 2: 用结构化模板生成基础触发场景（覆盖主要路径）
Step 3: 用 LLM 扩展生成边界场景（覆盖 edge case）
```

#### 触发测试 Prompt 生成模板

```typescript
function generateTriggerPrompts(skill: Skill): TriggerPrompt[] {
  const prompts: TriggerPrompt[] = [];
  
  // 从 skill body 中提取工具调用相关指令
  const toolMentions = extractToolMentions(skill.body);
  
  // 为每个提到的工具生成触发场景
  for (const tool of toolMentions) {
    prompts.push({
      type: 'trigger',
      prompt: `[Skill: ${skill.name}] 用户请求需要使用 ${tool} 工具的场景`,
      expectedTools: [tool],
    });
  }
  
  // 为 skill 描述中提到的核心能力生成触发场景
  prompts.push({
    type: 'trigger',
    prompt: `[Skill: ${skill.name}] 基于 description 的通用触发场景`,
    expectedBehavior: skill.description,
  });
  
  return prompts;
}
```

#### 执行测试 Prompt 生成

```typescript
function generateExecutionPrompts(skill: Skill): ExecutionPrompt[] {
  // 从 skill body 中解析出具体工具调用指令
  // 生成需要精确执行这些指令的 prompt
  // 设定 expectedTools + expectedParams
}
```

### 4.3 LLM 生成 Prompt 的调用方式

复用现有 `startRun()` 机制：
- 输入：skill name + description + body 摘要
- 输出：JSON 格式的测试用例列表
- 使用轻量 model（如 gpt-4o-mini）降低成本

## 五、与 Skill Loading Mode 的交互

### 5.1 Full 模式

- Skill 完整内容已注入 prompt
- 触发测试：无法通过 `read-skill` 检测，需使用行为匹配或 AI judge
- 执行测试：直接检查工具调用，与现有 expectations 机制一致
- **推荐：** Full 模式的 skill 测试以执行测试为主

### 5.2 Dynamic 模式

- Skill 仅注入描述符
- 触发测试：核心检测点 — Agent 是否在需要时调用 `read-skill`
- 执行测试：先触发 `read-skill`，再检查后续工具调用
- **推荐：** Dynamic 模式同时做触发测试和执行测试

### 5.3 测试用例标记

每个测试用例需标注适用的 loading strategy：

```typescript
interface SkillTestCase {
  applicableStrategies: ('full' | 'dynamic')[];
  // dynamic 专属：检查 read-skill 调用
  // full 专属：检查行为匹配
  // 两者皆可：检查工具调用正确率
}
```

## 六、实现路线建议（已根据 review 反馈调整）

### Phase 1: 最小可行版本（dynamic-only）

> **核心原则**：先做确定性最高的部分，用结果验证框架可行性

1. 新建 `skill_test_cases` 表（含 `loading_mode` 字段，关联 `eval_cases`）
2. 实现 `POST /api/skills/:skillId/test-cases/generate`（基于模板生成 dynamic 触发测试）
3. **新增「可触发验证」步骤**：生成后自动 smoke run，触发率为 0 标记 `invalid`
4. 复用 eval-cases 的 run 机制执行测试
5. 实现基础判定逻辑（L1 工具名匹配 + `read-skill` 调用检测）
6. 前端在 skill 详情页展示测试结果

### Phase 2: AI 生成 + 执行测试 + 参数校验

1. 接入 LLM 生成多样化测试 prompt
2. 实现 L2 参数结构校验（**从 skill body 中 parse 工具调用示例参数**，自动生成 expected params）
3. 实现 AI judge 判定（full 模式触发检测）
4. 批量运行 + 回归对比

### Phase 3: 集成与持续化

1. Skill 编辑后自动触发回归测试
2. Prompt version 变更后自动回归
3. 测试报告集成到全局 dashboard

### Review 反馈采纳记录

| 反馈来源 | 建议 | 采纳情况 |
|---------|------|----------|
| doro | Phase 1 先只做 dynamic 触发测试 | ✅ 已纳入 Phase 1 范围缩减 |
| doro | 参数校验从 skill body parse 示例 | ✅ 已纳入 Phase 2 L2 校验方案 |
| doro | 生成后加「可触发验证」步骤 | ✅ 已纳入 Phase 1，新增 `validity_status` 字段 |
| doro | `skill_test_cases` 加 `loading_mode` 字段 | ✅ 已加入表结构 |

## 七、核心发现总结

1. **eval-cases 系统可直接复用 80%+ 的基础设施**：session 管理、tool bridge dryRun、tool call 埋点、A/B 回放——这些都不需要重写
2. **触发检测的核心区分在 loading mode**：dynamic 模式有明确的 `read-skill` 调用信号；full 模式需要行为匹配或 AI judge
3. **工具调用正确率已有完整的埋点和聚合**：`agent_tool_call` 事件 + `buildAgentEvalReport()`，只需要加一层 skill 维度的聚合
4. **测试 prompt 生成的最佳方案是混合策略**：模板覆盖主路径 + LLM 扩展边界场景
5. **新增代码量预估**：~500-800 行 TypeScript（Phase 1），主要是 controller + 判定逻辑 + 前端展示
