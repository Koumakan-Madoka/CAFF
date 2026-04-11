# PRD: Skill 自动化测试框架（Phase 3 重开）

## 背景

CAFF 已经具备完整的 Skill 测试基础设施雏形：

- 已有 `skill_test_cases` / `skill_test_runs` 数据模型，并与 `eval_cases` / `eval_case_runs` 关联
- 已支持 dynamic / full 两种 skill 加载模式
- 已支持生成测试用例、手动创建、单条运行、批量运行、运行历史、回归对比
- 已落地 dynamic 模式触发检测、full 模式 AI judge、L2 参数校验、L3 时序校验等能力

但当前产品语义仍然不够收敛，主要问题有四类：

1. **配置项过多，心智负担偏高**
   - `loadingMode`、`testType`、`expectedTools`、`expectedBehavior`、AI judge 等概念叠加
   - 用户不容易快速理解“dynamic / full 到底分别测什么”

2. **dynamic / full 的职责边界不够清晰**
   - 现在两种模式都同时挂着“触发 / 执行 / judge”的概念
   - 用户视角下很难形成稳定预期

3. **AI 生成后立刻 smoke run，打断编辑流**
   - 生成后的 case 还没人工调整就被立即执行
   - 会增加 token 成本，也不利于用户先修 prompt / 期望步骤 / 辅证信号

4. **full 模式结果仍然偏二值化**
   - 当前 AI judge 核心仍偏向 `passed / failed`
   - 对“为什么失败、失败在哪个维度、工具链质量如何”的诊断深度不足

因此需要在现有 Phase 1 / Phase 2 之上，重开一个 **Phase 3**，重点解决“模式语义收敛、配置简化、生成后先编辑、full 模式多维评估”这四个问题。

## Phase 3 核心目标

### 1. 收敛模式语义
- **Dynamic 模式**：只测 **skill 是否成功被加载 / 触发**
- **Full 模式**：只测 **skill 是否按预期完成行为链路并达成目标**
- 用户不再需要额外理解“同一模式里还要切换到底偏 trigger 还是偏 execution”

### 2. 两种模式都支持 AI 生成测试用例
- Dynamic 模式支持 AI 生成“更容易触发 skill 加载”的用户 prompt
- Full 模式支持 AI 生成“任务场景 + 期望行为步骤 + 目标描述”的测试草稿

### 3. 生成后不自动运行，先进入可编辑草稿态
- AI 生成 case 后默认仅保存为草稿
- 用户可先修改 prompt、期望步骤、目标、辅证信号、评估 rubric
- 只有在用户主动点击运行时才真正执行

### 4. Full 模式输出多维评估结果，而不只是 True / False
- 至少输出以下维度：
  - **关键步骤完成度**
  - **顺序执行度**
  - **目标达成度**
  - **行为符合度**
  - **工具调用覆盖度（辅证）**
  - **工具调用成功度（辅证）**
  - **工具调用错误率（辅证）**
- 每个维度都需要带分数或结构化结果，以及简短原因

### 5. 用更少的配置完成主流程
- 新用户应能用尽量少的概念完成主流程：
  - 选 Skill
  - 选模式（dynamic / full）
  - AI 生成草稿
  - 编辑后运行
  - 查看结果

## 非目标

- 不重写现有 eval-cases 基础设施
- 不新增新的模型供应商或运行时协议
- 不要求 Phase 3 一次性重做全部历史 case 数据
- 不在本阶段重做所有非 Skill Tests 区域的 UI

## 产品决策

### 1. Dynamic / Full 的职责重新定义

#### Dynamic 模式
目标：验证 Agent 是否在 dynamic loading 流程中**成功识别并加载目标 skill**。

**判定关注点**：
- 是否出现 `read-skill(skillId)`
- 是否加载了正确的 target skill
- 加载证据是否完整（tool call / session timeline / 事件埋点）

**不再关注**：
- 工具链执行质量
- 工具调用顺序
- 工具调用错误率
- AI judge 的综合执行判断

#### Full 模式
目标：验证 Agent 在 full loading 流程中，**是否完成 `expectedSteps` 定义的关键行为链路、遵循 skill 约束并最终达成目标**。

**判定关注点**：
- 关键 `expectedSteps` 是否完成，尤其是 `required` 步骤
- 行为步骤顺序是否基本合理
- 最终目标是否达成
- 是否违反 skill 的关键约束 / 角色要求
- 哪一步缺失、偏离或证据不足

**辅证 / 诊断关注点**：
- `expectedTools` / `strongSignals` 是否提供支持性证据
- 工具调用是否成功、是否存在异常或明显多余调用

**不再关注**：
- `read-skill` 是否出现（full 模式天然不依赖它）
- “有没有加载 skill”这一层的单独 trigger 判定
- 把关键词 / 工具名 / 参数 shape 硬匹配当成 Full 主判据

### 2. `testType` 从主配置中退场，改为内部兼容字段

当前 `testType=trigger|execution` 会与 `loadingMode=dynamic|full` 形成双重配置，增加心智负担。

Phase 3 方案：
- 前端主流程不再强调单独的 `testType` 选择
- 改为由 `loadingMode` 自动映射：
  - `dynamic` → 触发 / 加载验证
  - `full` → 执行质量验证
- 历史数据里的 `test_type` 字段继续保留，用于兼容旧 case 与旧报表
- 新 UI 中默认隐藏该字段，必要时仅在高级设置中保留只读或兼容展示

### 3. AI 生成改为 Draft-First，而不是 Generate-and-Run

#### Dynamic 模式 AI 生成
AI 负责生成更可能触发目标 skill 加载的用户表达，例如：
- 明确进入某玩法 / 某工作流的指令
- 避免只问概念、解释、百科类问题
- 产出多条表达风格不同但目标一致的触发 prompt

生成结果默认包含：
- `triggerPrompt`
- 目标 `skillId`
- 建议说明 / note
- 默认评估方式：检查 `read-skill(skillId)`

#### Full 模式 AI 生成
AI 负责生成更完整的执行测试草稿，例如：
- 用户任务场景
- 期望目标
- **期望行为步骤草稿**
- 可能的关键顺序提示
- 可作为辅证的工具 / 参数 / 输出信号
- 失败时应该观察什么证据

生成结果默认包含：
- `userPrompt`（Full 语义下的唯一任务输入字段，不再表示单独的 trigger 判定）
- `expectedSteps`
- `expectedGoal`
- `expectedSequence`（可选；若步骤已显式声明顺序，可由后端归一化）
- `evaluationRubric`
- `expectedTools`（可选；作为 supporting 辅证字段，不再是 Full 主判据）
- `note`

#### 生成后默认行为
- 生成结果直接进入 **draft** 状态
- **不自动 smoke run**
- 用户可以：
  - 直接编辑
  - 删除不合适的 draft
  - 手动挑一条先跑
  - 批量把草稿标记为 ready 后再跑

### 4. Full 模式采用“行为步骤主判 + 确定性辅证 + AI 评分”混合评估

Phase 3 不再让 Full 模式只输出一个 `passed` 布尔值，而是拆成三层：
1. **行为步骤主判**：AI judge 逐步判断 `expectedSteps` 是否完成，并给出证据
2. **确定性指标**：后端根据 step 结果、timeline、tool events 计算分数
3. **聚合 verdict**：输出 `pass / borderline / fail`，但只作为摘要，不替代多维结果

#### A. 代码可确定计算的主 / 辅指标
由 step 级结果、session timeline、tool call 事件、run metadata 共同计算：

- **关键步骤完成度** `requiredStepCompletionRate`
  - 分子：被 judge 判定 `completed=true` 的 `required` 步骤数
  - 分母：`expectedSteps` 中 `required=true` 的步骤总数
  - 角色：Full 模式默认主判据；若存在 required steps，默认参与 hard fail 判断
  - 空样本：若未配置 `required` 步骤，记为 `null`
- **步骤完成度** `stepCompletionRate`
  - 分子：被 judge 判定 `completed=true` 的步骤数
  - 分母：`expectedSteps` 总数
  - 角色：整体完成情况概览，不单独决定 hard fail
  - 空样本：若未配置 `expectedSteps`，记为 `null`
- **顺序执行度** `sequenceAdherence`
  - 计算方式：judge 先为每个 step 选择 `evidenceIds`，后端再按统一 timeline 中这些证据的先后关系计算顺序分数
  - 分母：参与顺序约束的关键步骤数
  - 角色：行为链路主判据之一；若步骤未配置顺序或证据不足，记为 `null`
- **工具调用覆盖度** `requiredToolCoverage`
  - 分子：被支持性证据命中的必需工具槽位数
  - 分母：`expectedTools` 中标记为必需的工具槽位总数
  - 角色：默认仅作辅证 / 回归对比 / 诊断，不再天然等于 hard gate
  - 空样本：若未配置必需工具，记为 `null`
- **工具调用成功度** `toolCallSuccessRate`
  - 分子：已命中辅证工具槽位中最终调用成功的数量
  - 分母：已命中辅证工具槽位数量
  - 角色：默认仅作辅证；用于解释“行为看起来对，但工具链质量不稳”
  - 空样本：若没有任何辅证工具被命中，记为 `null`
- **工具调用错误率** `toolErrorRate`
  - 分子：评估窗口内失败或异常的工具调用次数
  - 分母：评估窗口内被纳入评分的工具调用总次数
  - 角色：默认仅作辅证；除非 rubric 显式标记为 critical，否则不单独触发 hard fail
  - 空样本：若没有工具调用，记为 `null`

**统一规则**：
- API / DB 存储原始分数为 `0~1` 浮点，四舍五入到 4 位小数
- 前端展示为百分比，默认保留 1 位小数
- `null` 不参与 pass 阈值比较；只有 rubric 显式要求该维度时，才强制要求该维度非 `null`
- `expectedTools` / `strongSignals` 的所有命中都属于**支持性证据**；默认只能增强 / 削弱置信度，或把结果从 `pass` 拉到 `borderline`

**时间线与证据规则**：
- 评估窗口仅包含本次 case run 的 assistant 文本块、thinking 摘要、tool call、tool result 等证据；排除测试用例生成、draft 编辑、AI judge 自身 session、回归汇总等辅助流程
- 后端必须先归一化出稳定 timeline id：`msg-{n}`（assistant 文本块）、`thinking-{n}`（thinking 摘要）、`tool-call-{n}`、`tool-result-{n}`；同一 run 内唯一，并按真实时间线 / 事件序号排序
- `evidenceIds` 必须引用上述统一 timeline 中已存在的 id；judge 不得发明新 id，未知 id 视为无效证据并触发 warning / 降级复核
- 顺序分数优先基于 `evidenceIds` 计算；仅当 step 缺少明确证据 id 时，才回退到 `strongSignals` / `expectedTools.order` 做弱推断
- `expectedTools` 仍按槽位记录，但只用于支持性匹配和诊断解释，不再作为 Full 主判的唯一真源

#### B. 需要语义理解的 AI 评分
由 AI judge 基于运行证据做结构化评估：

- **目标达成度** `goalAchievement`
  - `0~1` 分数，判断 assistant 是否真正完成了 case 目标
- **行为符合度** `instructionAdherence`
  - `0~1` 分数，判断 assistant 是否符合该 skill 的核心约束 / 身份 / 流程
- **诊断摘要** `summary`
  - 一句话总结这次 run 的主要问题或亮点
- **步骤级结果** `steps[]`
  - judge 逐步给出 `completed / confidence / evidenceIds / matchedSignalIds / reason`
- **约束检查结果** `constraintChecks[]`
  - judge 逐条判断 `evaluationRubric.criticalConstraints[]` 是否满足，并返回 `constraintId / satisfied / evidenceIds / reason`

**AI judge 返回 schema**：

```json
{
  "steps": [
    {
      "stepId": "step-1",
      "completed": true,
      "confidence": 0.91,
      "evidenceIds": ["tool-call-3", "msg-7"],
      "matchedSignalIds": ["sig-step-1-read-skill", "sig-step-1-acknowledge-rules"],
      "reason": "assistant 先读取规则文件，再基于规则继续执行"
    }
  ],
  "constraintChecks": [
    {
      "constraintId": "confirm-before-action",
      "satisfied": true,
      "evidenceIds": ["tool-call-3", "msg-7"],
      "reason": "先确认规则后才继续行动"
    }
  ],
  "goalAchievement": { "score": 0.8, "reason": "..." },
  "instructionAdherence": { "score": 0.85, "reason": "..." },
  "summary": "...",
  "verdictSuggestion": "pass | borderline | fail",
  "missedExpectations": ["..."]
}
```

**Judge 契约**：
- 所有 AI 分数范围固定为 `0~1`
- `reason` 必须引用可观察证据，不允许只写泛泛判断
- `matchedSignalIds` 只能引用当前 case 已定义的 `expectedSteps[].strongSignals[].id`；未知 signal id 记 warning 并降级为仅供展示的弱证据
- 若 case 配置了 `criticalConstraints`，judge 必须为每个归一化后的 `constraintId` 返回一条 `constraintChecks[]`；缺失项不会被静默当作通过，而是追加 `severity = 'needs-review'` 的 issue
- `evidenceIds` 只负责说明“这一步/这条约束依据了哪些证据”；`sequenceAdherence` 的数值由后端代码计算，不由 judge 自由打分
- `aiJudge.status` 只表达 judge 调用 / 解析状态，枚举固定为 `succeeded | parse_failed | runtime_failed | skipped`；业务层“待复核”统一通过 `issues[].severity = 'needs-review'` 表达，不再扩展新的 status 枚举
- 解析失败或模型调用失败时，run 仍然完成：
  - `aiJudge.status = 'parse_failed' | 'runtime_failed' | 'skipped'`
  - `steps` / `constraintChecks` / `goalAchievement` / `instructionAdherence` 记为 `null` 或空数组
  - 保留 `rawResponse` / `errorMessage`
  - 聚合 `verdict` 最高只能到 `borderline`，并提示需要人工复核

#### C. Full 模式统一输出结构
Full 模式运行结果至少输出：

```json
{
  "verdict": "pass | borderline | fail",
  "summary": "...",
  "steps": [
    {
      "stepId": "step-1",
      "completed": true,
      "confidence": 0.91,
      "evidenceIds": ["tool-call-3", "msg-7"],
      "matchedSignalIds": ["sig-step-1-read-skill"],
      "reason": "..."
    }
  ],
  "dimensions": {
    "requiredStepCompletionRate": { "score": 1, "reason": "..." },
    "stepCompletionRate": { "score": 0.8, "reason": "..." },
    "sequenceAdherence": { "score": 0.67, "reason": "..." },
    "goalAchievement": { "score": 0.8, "reason": "..." },
    "instructionAdherence": { "score": 0.85, "reason": "..." },
    "requiredToolCoverage": { "score": 1, "reason": "...", "role": "supporting" },
    "toolCallSuccessRate": { "score": 0.75, "reason": "...", "role": "supporting" },
    "toolErrorRate": { "score": 0.25, "reason": "...", "role": "supporting" }
  },
  "constraintChecks": [
    {
      "constraintId": "confirm-before-action",
      "satisfied": true,
      "evidenceIds": ["tool-call-3"],
      "reason": "..."
    }
  ],
  "aggregation": {
    "hardFailReasons": [],
    "borderlineReasons": [],
    "supportingWarnings": []
  },
  "aiJudge": {
    "status": "succeeded | parse_failed | runtime_failed | skipped",
    "rawResponse": "...",
    "errorMessage": ""
  },
  "missingSteps": ["..."],
  "missingTools": ["..."],
  "unexpectedTools": ["..."],
  "failedCalls": [
    { "tool": "bash", "reason": "..." }
  ]
}
```

### 5. 最终结论从“单布尔”变成“多维结论 + 可选聚合 verdict”

为了兼容回归报表和列表态展示，Full 模式仍可保留一个聚合后的 `verdict`：
- `pass`
- `borderline`
- `fail`

但该 verdict 只是聚合视图，不再是唯一结果。

默认聚合建议：
- 主判维度：
  - 若存在 `required` 步骤，则 `requiredStepCompletionRate >= 1.0`
  - `goalAchievement >= 0.7`
  - `instructionAdherence >= 0.7`
  - 若存在顺序约束，则 `sequenceAdherence >= 0.7`
- 辅证维度：
  - `requiredToolCoverage` / `toolCallSuccessRate` / `toolErrorRate` 默认只影响置信度、诊断与 `pass ↔ borderline` 边界
  - 只有 rubric 显式把某个工具信号标为 `critical` 时，工具维度才允许参与 hard fail
- 优先级规则：
  1. `requiredStepCompletionRate < 1.0` → 直接 `fail`
  2. `goalAchievement` / `instructionAdherence` 低于各自 `hardFailThreshold` → `fail`
  3. `sequenceAdherence` 默认只参与 `pass ↔ borderline`；只有 `evaluationRubric.criticalDimensions` 显式包含 `sequenceAdherence` 且 case 确实配置了顺序约束时，才允许在低于 `hardFailThresholds.sequenceAdherence` 时直接 `fail`
  4. `criticalConstraints` 必须通过 judge 的 `constraintChecks[]` 落地；任一约束 `satisfied = false` 且证据有效 → `fail`
  5. `verdictSuggestion = 'fail'` 只有在它同时指向某个可验证 hard condition（关键步骤缺失、`critical` 违约或主判维度显著不达标）且能引用可观察证据时，才允许把聚合结果直接推到 `fail`；否则最多把结果降到 `borderline`
  6. 若 `aiJudge.status != 'succeeded'`，或关键 `constraintChecks[]` 缺失 / 不可验证，且没有触发 hard fail，则聚合 `verdict` 最高只能到 `borderline`
  7. 若所有主判维度达标、`aiJudge.status = 'succeeded'` 且 AI 未建议 `borderline/fail`，则为 `pass`
  8. 若未触发 hard fail，但存在主判维度落在“`hardFailThreshold <= score < passThreshold` 复核区间”、非关键步骤缺失、顺序轻微异常、工具辅证明显偏弱、或 AI judge 建议 `borderline` / 仅凭弱证据建议 `fail`，则为 `borderline`
  9. supporting 维度除非 rubric 标记为 `critical`，否则不单独触发 `fail`
- 实现参考决策表：
  - `requiredStepCompletionRate < 1.0` → `fail`
  - `goalAchievement` / `instructionAdherence` 低于 `hardFailThreshold` → `fail`
  - `sequenceAdherence` 低于 `hardFailThreshold` 但未被列入 `criticalDimensions` → `borderline`
  - `sequenceAdherence` 低于 `hardFailThreshold` 且被列入 `criticalDimensions` → `fail`
  - 任一 `criticalConstraint` 的 `constraintChecks.satisfied = false` → `fail`
  - 关键 `constraintChecks[]` 缺失、`sequenceAdherence = null` 且顺序被标为 critical、或 `aiJudge.status = 'parse_failed' | 'runtime_failed'` → 最高 `borderline`
  - 主判维度达标，但工具辅证偏弱 / 证据不足 → `borderline`
  - 主判维度达标、AI judge 成功且无 `critical` 辅证问题 → `pass`
- 默认 helper 规则：
  - `hasWeakEvidence(steps)`：任一已判 `completed = true` 的 `required` step 在证据归一化后没有有效 `evidenceIds`、任一步骤 `confidence < 0.5`、或 judge 引用了不存在的 `evidenceIds` / `matchedSignalIds`
  - `hasSupportingMetricWeakness(metrics)`：任一非空 supporting 指标满足 `requiredToolCoverage < 1`、`toolCallSuccessRate < 0.8`、或 `toolErrorRate > 0.2`；这些规则只允许把 `pass` 拉到 `borderline`，不单独触发 `fail`

## 2026-04-08 补充决策：Full 模式改为“行为步骤主判、工具信号辅证”

> 本节用于把 Full 模式“行为步骤主判、工具信号辅证”的口径细化成实现约束；如文中仍残留旧的工具硬匹配表述，均以本节为准。

### 1. 为什么要补这次规划

当前 Full 模式虽然已经具备多维评估雏形，但核心心智仍偏向：
- 先定义要命中的工具 / 参数 / 关键词
- 再根据这些硬信号推出“是否按预期执行了 skill”

这在真实 skill 场景里很容易失真：
- 同一步行为可能由不同工具组合完成
- 参数结构可能等价但不完全同形
- assistant 的文本表达变化很大，但行为本身是对的
- skill 真正重要的往往是“先做什么、再确认什么、最后产出什么”，而不是某个固定字符串

因此 Phase 3 的 Full 模式补充决策是：
- **主判据**改为“是否完成预期行为步骤”
- **工具 / 参数 / 关键词**降级为辅证、置信度增强项、诊断线索
- **顺序执行度**改为按“行为步骤顺序”评分，而不是只看工具顺序

### 2. Full 用例主 schema：`expectedSteps`

Full 模式的 AI 生成与手动创建都应以 `expectedSteps` 作为第一公民：

```json
[
  {
    "id": "step-1",
    "title": "加载并理解规则",
    "expectedBehavior": "先读取技能说明或等效上下文，确认玩法约束后再继续行动",
    "required": true,
    "order": 1,
    "failureIfMissing": "如果未先理解规则就直接输出主持流程，说明关键准备步骤缺失",
    "strongSignals": [
      {
        "id": "sig-step-1-read-skill",
        "type": "tool",
        "name": "read",
        "arguments": { "path": "<contains:SKILL.md>" }
      },
      {
        "id": "sig-step-1-acknowledge-rules",
        "type": "text",
        "pattern": "<contains:已阅读规则>"
      }
    ]
  }
]
```

字段约定：
- `title`：步骤短标题，便于 UI 和回归视图展示
- `expectedBehavior`：这一步“应该做什么”，使用自然语言描述
- `required`：缺失是否可直接影响 verdict
- `order`：关键步骤顺序；可留空表示顺序宽松
- `failureIfMissing`：缺失时的诊断提示
- `strongSignals`：可选强证据，支持工具调用、参数模式、文本片段、状态变化等；**仅做辅证**，不再天然等于 hard gate

保留字段：
- `expectedGoal`：整条 case 的最终目标
- `expectedSequence`：可选显式顺序配置；若给出则视为对 `expectedSteps.order` 的补充或覆盖
- `expectedTools`：supporting 辅证字段；可由生成器回填，但不再作为 Full 模式的唯一真源

补充约束（新 Full case 的规范化真源）：
- `userPrompt`：必填非空字符串；Full 新 case 一律写该字段
  - Full create / update 仅接受 `userPrompt`
  - 服务端内部存储、聚合、judge prompt 与前端新 UI 一律以 `userPrompt` 为 canonical 字段
- `expectedGoal`：必填非空字符串；描述最终任务目标，不与某一步骤重复
- `expectedSteps`：`1~12` 个步骤；新建 / 更新 / 运行 Full case 时若为空应视为 schema 不完整
  - 新 Full case 至少要有 `1` 个 `required = true` 的步骤，避免主判维度失真
- 每个 step 必须满足：
  - `id`：case 内唯一、稳定；默认使用 `step-{n}`，供 UI diff / 回归对比 / evidence 引用
  - `title`：单行短标题，适合列表或标签展示
  - `expectedBehavior`：`1~3` 句自然语言，描述“应观察到的行为”，不能退化为纯关键词列表
  - `required`：默认 `true`
  - `order`：正整数或空；如显式填写则同一 case 内必须唯一；重复 `order` 视为顺序配置冲突；如同时提供 `expectedSequence`，以 `expectedSequence` 的归一化结果为准
  - `failureIfMissing`：推荐填写；用于 UI 直接解释失败原因
  - `strongSignals`：每步最多 `5` 条；仅允许 `tool | text | state` 三类支持性信号，默认 `severity = supporting`
    - `strongSignals[].id`：case 内唯一、稳定（默认带 `stepId` 前缀）；默认使用 `sig-<stepId>-<slug>`，供 `supportingSignalOverrides`、`matchedSignalIds` 与 UI diff 引用，禁止再按数组下标引用
    - `strongSignals[].type = 'tool'`：至少提供 `toolName`；可选 `argumentsMatcher`，其 matcher 语法只允许 `contains | equals | regex`
    - `strongSignals[].type = 'text'`：至少提供非空 `text` 或 `pattern`；若显式指定 matcher，同样只允许 `contains | equals | regex`
    - `strongSignals[].type = 'state'`：至少提供 `key`、`expected`，可选 `matcher`；`key` 只允许引用后端可确定投影到 run/evaluation 上下文的规范化状态字段。若当前实现尚未提供该 `key` 的确定性投影，则该信号只能降级为 judge 提示并返回 warning，不得偷偷当成 hard gate
    - 匹配语义：默认先作为 judge 提示；若后端执行确定性 supporting match，只允许 `contains | equals | regex` 三类操作符（写成 `<contains:...>` / `<equals:...>` / `<regex:...>`），未知语法降级为纯提示并记录 warning
- `expectedSequence`：可选数组；内容应引用 `stepId`，由后端归一化为顺序约束；若与 `step.order` 冲突，记录 warning 并以 `expectedSequence` 为准
- `expectedTools`：只保留为 supporting / 调试字段；新生成器可以回填，但不能代替 `expectedSteps`

`evaluationRubric` 的最小可执行结构：

```json
{
  "criticalConstraints": [
    {
      "id": "confirm-before-action",
      "description": "在继续执行前必须先确认规则或关键上下文",
      "failureReason": "未确认规则就直接行动",
      "appliesToStepIds": ["step-1"]
    }
  ],
  "criticalDimensions": [],
  "passThresholds": {
    "goalAchievement": 0.7,
    "instructionAdherence": 0.7,
    "sequenceAdherence": 0.7
  },
  "hardFailThresholds": {
    "goalAchievement": 0.5,
    "instructionAdherence": 0.5,
    "sequenceAdherence": 0.4
  },
  "supportingSignalOverrides": [
    {
      "stepId": "step-1",
      "signalId": "sig-step-1-read-skill",
      "severity": "critical",
      "failureReason": "必须先读取规则文件"
    }
  ]
}
```

约定：
- `criticalConstraints` 用于表达“违背即 fail”的语义约束；优先用自然语言描述，而不是只写工具名；其判定结果必须由 judge 通过 `constraintChecks[]` 返回
- `criticalConstraints[].id` 必须在 case 内唯一；`appliesToStepIds` 若出现未知 stepId，视为 schema error
- `criticalDimensions` 用于把默认只参与 `pass ↔ borderline` 的主判维度提升为可 hard-fail；Phase 3 当前只允许 `sequenceAdherence`
- `passThresholds` / `hardFailThresholds` 未填写时回落到 PRD 默认值；`sequenceAdherence` 只有在 case 明确配置顺序约束时才参与阈值判断
- 只有当 `criticalDimensions` 显式包含 `sequenceAdherence` 且 case 已配置顺序约束时，`hardFailThresholds.sequenceAdherence` 才会生效；否则顺序维度即使低于 hard-fail 阈值，也只会进入 `borderline`
- 若 `criticalDimensions` 包含 `sequenceAdherence`，但归一化后没有任何顺序约束，视为 schema error
- `supportingSignalOverrides` 是唯一允许把某个辅证信号提升为 `critical` 的入口；引用必须使用固定二元键 `stepId + signalId`，若目标信号不存在则 schema 校验失败
- 未显式提升前，`strongSignals` / `expectedTools` 永远只算 supporting
- judge prompt、后端聚合、前端详情都读取同一份归一化 `evaluationRubric`

### 3. AI 生成逻辑：从“关键词/工具清单”改成“行为步骤草稿”

Full 模式 AI 生成时：
- 主输出应是 `expectedSteps`
- 每一步描述要能被人类编辑、复核、解释
- 如有明显的工具调用偏好，可额外输出到 `strongSignals` 或 `expectedTools`
- 不再要求模型把“需要匹配的关键词列表”当作 Full 主评测配置

生成侧要求：
- 默认生成 `3~7` 个关键步骤，避免过碎
- 至少标记哪些步骤是 `required`
- 若 skill 有明显流程顺序，尽量补 `order`
- 若 skill 存在核心约束（例如必须先确认、不能跳过某环节），要写进步骤描述或 rubric

### 4. Judge 逻辑：逐步判定，而不是只给整体 pass/fail

Judge 需要对每个 step 返回结构化结果：

```json
{
  "steps": [
    {
      "stepId": "step-1",
      "completed": true,
      "confidence": 0.91,
      "evidenceIds": ["tool-call-3", "msg-7"],
      "matchedSignalIds": ["sig-step-1-read-skill", "sig-step-1-acknowledge-rules"],
      "reason": "assistant 先读取规则文件，再基于规则继续执行"
    }
  ],
  "constraintChecks": [
    {
      "constraintId": "confirm-before-action",
      "satisfied": true,
      "evidenceIds": ["tool-call-3", "msg-7"],
      "reason": "先确认规则后才继续行动"
    }
  ],
  "goalAchievement": { "score": 0.84, "reason": "..." },
  "instructionAdherence": { "score": 0.88, "reason": "..." },
  "summary": "...",
  "verdictSuggestion": "pass | borderline | fail",
  "missedExpectations": ["..."]
}
```

要求：
- `reason` 必须绑定可观察证据
- `evidenceIds` 指向后端整理后的事件 / 消息列表，便于 UI 回放与调试；只允许引用当前 run 的规范化 timeline id（`msg-*` / `thinking-*` / `tool-call-*` / `tool-result-*`）
- `matchedSignalIds` 只能引用当前 case 已声明的 `strongSignals[].id`，不得回退成自由文本串
- 若 judge 返回不存在的 `evidenceIds` 或 `matchedSignalIds`，后端应记录 schema warning，并把该 step 标记为弱证据 / 待复核，而不是静默当成强证据
- 若 case 定义了 `criticalConstraints`，judge 必须返回逐条对应的 `constraintChecks[]`；缺失项记 warning，并把该 run 标记为 `needs-review`
- `confidence` 范围固定为 `0~1`
- judge 负责“这一步算不算完成”和“关键约束是否满足”，而不是直接决定所有数值指标

### 5. 顺序执行度：按步骤证据顺序算，工具顺序只做辅助

新的 `sequenceAdherence` 规则：
- 后端先把可观察证据整理成统一 timeline（assistant 文本块、thinking 摘要、tool call、tool result 等）
- judge 为每个 step 选择 `evidenceIds`
- **顺序分数由代码根据这些 `evidenceIds` 的先后关系计算**，而不是纯靠 judge 自由发挥
- 若某个 step 缺少明确证据 id，才回退到 `strongSignals` / `expectedTools.order` 推断

这样可以避免“文字上说顺序对了，但数值又和工具匹配算法打架”的情况。

### 6. 最终 verdict：关键步骤与约束主导，工具维度退为辅证

Full 模式最终 verdict 改为以下心智：
- **直接 fail**：关键 `required` 步骤缺失、明显违反关键约束、目标明显未达成、judge 明确给出 `fail` 且有证据支持
- **pass**：关键步骤完成、顺序基本合理、目标达成、行为符合 skill 约束，且 judge 成功返回结构化结果
- **borderline**：没有 hard fail，但存在步骤证据不足、顺序轻微异常、judge 解析失败或只拿到弱证据

原有维度的角色调整：
- `requiredToolCoverage` / `toolCallSuccessRate` / `toolErrorRate`：保留，但主要用于**辅证、解释和回归对比**
- 默认情况下，这些指标只应影响 `confidence`、诊断解释或把结果从 `pass` 拉到 `borderline`
- 只有 rubric 显式把某个工具信号标为 `critical` 时，它们才允许参与 hard fail
- 它们不应再单独充当 Full 模式“是否按预期执行 skill”的唯一主判据

聚合伪代码（实现真源）：

```ts
function aggregateFullVerdict(normalizedCase, aiJudge, metrics) {
  const hasRequiredSteps = metrics.requiredStepCompletionRate !== null;
  const hasSequenceConstraint = normalizedCase.sequenceConstraintStepIds.length > 0;
  const sequenceIsCritical =
    hasSequenceConstraint &&
    normalizedCase.rubric.criticalDimensions.includes('sequenceAdherence');
  const hardFailReasons = [];

  if (hasRequiredSteps && metrics.requiredStepCompletionRate < 1) {
    hardFailReasons.push('missing-required-step');
  }
  if (
    metrics.goalAchievement !== null &&
    metrics.goalAchievement < normalizedCase.rubric.hardFailThresholds.goalAchievement
  ) {
    hardFailReasons.push('goal-hard-fail');
  }
  if (
    metrics.instructionAdherence !== null &&
    metrics.instructionAdherence < normalizedCase.rubric.hardFailThresholds.instructionAdherence
  ) {
    hardFailReasons.push('instruction-hard-fail');
  }
  if (
    sequenceIsCritical &&
    metrics.sequenceAdherence !== null &&
    metrics.sequenceAdherence < normalizedCase.rubric.hardFailThresholds.sequenceAdherence
  ) {
    hardFailReasons.push('critical-sequence-hard-fail');
  }
  if (violatesCriticalConstraint(aiJudge.constraintChecks, normalizedCase.rubric)) {
    hardFailReasons.push('critical-constraint');
  }
  if (
    aiJudge.status === 'succeeded' &&
    aiJudge.verdictSuggestion === 'fail' &&
    judgeFailIsBackedByObservableEvidence(aiJudge, hardFailReasons)
  ) {
    hardFailReasons.push('judge-backed-hard-fail');
  }
  if (hardFailReasons.length > 0) {
    return fail(hardFailReasons);
  }

  if (aiJudge.status !== 'succeeded') {
    return borderline(['judge-needs-review']);
  }
  if (hasUnknownCriticalConstraintCheck(aiJudge.constraintChecks, normalizedCase.rubric)) {
    return borderline(['critical-constraint-needs-review']);
  }
  if (sequenceIsCritical && metrics.sequenceAdherence === null) {
    return borderline(['critical-sequence-needs-review']);
  }

  const primaryNeedsReview =
    (metrics.goalAchievement !== null &&
      metrics.goalAchievement < normalizedCase.rubric.passThresholds.goalAchievement) ||
    (metrics.instructionAdherence !== null &&
      metrics.instructionAdherence < normalizedCase.rubric.passThresholds.instructionAdherence) ||
    (hasSequenceConstraint &&
      metrics.sequenceAdherence !== null &&
      metrics.sequenceAdherence < normalizedCase.rubric.passThresholds.sequenceAdherence);

  if (primaryNeedsReview) {
    return borderline(['primary-dimension-below-pass-threshold']);
  }

  const hasBorderlineSignals =
    hasMissingNonRequiredSteps(aiJudge) ||
    hasWeakEvidence(aiJudge.steps) ||
    hasSupportingMetricWeakness(metrics) ||
    aiJudge.verdictSuggestion === 'borderline' ||
    (aiJudge.verdictSuggestion === 'fail' &&
      !judgeFailIsBackedByObservableEvidence(aiJudge, []));

  if (hasBorderlineSignals) {
    return borderline(['needs-human-review-or-supporting-signals-weak']);
  }

  return pass(['primary-dimensions-met']);
}
```

解释：
- `requiredStepCompletionRate`、`goalAchievement`、`instructionAdherence`、`sequenceAdherence` 是 Full 默认主判维度
- `requiredStepCompletionRate`、`goalAchievement`、`instructionAdherence` 按三段式工作：低于 `hardFailThreshold` → `fail`；介于 `hardFailThreshold` 与 `passThreshold` 之间 → `borderline`；达到 `passThreshold` 才能进入 `pass` 候选
- `sequenceAdherence` 默认也是主判维度，但仅影响 `pass ↔ borderline`；只有当 `criticalDimensions` 显式包含它时，才允许低于 `hardFailThreshold` 直接进入 `fail`
- `criticalConstraints` 由 judge 的 `constraintChecks[]` 承担语义落地；`violatesCriticalConstraint(...)` 只认 rubric 中已声明、且证据有效的 `constraintId`
- `requiredToolCoverage`、`toolCallSuccessRate`、`toolErrorRate` 默认只能进入 `hasSupportingMetricWeakness(...)`
- `judgeFailIsBackedByObservableEvidence(...)` 至少要命中：缺失 `required` step、违反 `critical` constraint、或显著低于主判阈值，并能引用有效 `evidenceIds`
- `sequenceAdherence = null` 不直接 `fail`；即使顺序被列为 critical，也只把结果上限压到 `borderline`，避免把“证据不足”误当成“顺序已被证明错误”
- `hasWeakEvidence(...)` 默认命中条件：已完成的 `required` step 缺少有效 `evidenceIds`、step `confidence < 0.5`、或 judge 引用了不存在的 `evidenceIds` / `matchedSignalIds`
- `hasSupportingMetricWeakness(...)` 默认命中条件：`requiredToolCoverage < 1`、`toolCallSuccessRate < 0.8`、或 `toolErrorRate > 0.2`（仅在对应指标非空时检查）
- 任何实现都不得绕过这套优先级，用单一 tool metric 或单条 judge 建议直接把结果打成 `fail`

### 7. 旧版 Full 用例策略：不做兼容迁移

本次决策：**不再为旧版 Full 用例（仅 `expectedTools/expectedBehavior/expectedSequence`）增加兼容工作量**。

执行口径：
- Full case 必须满足 canonical schema（`userPrompt + expectedGoal + expectedSteps + evaluationRubric`）；不满足即按 `case_schema_invalid` 处理
- run preflight 不再提供 legacy fallback（不再自动从 `expectedTools` 派生步骤）
- 旧版 Full case 的处置策略是“手动重建或归档”，而不是运行时自动迁移
- `expectedTools` 可继续作为新 case 的辅证字段存在，但不再承担“旧数据迁移来源”语义

### 8. Validator checklist（实现前真源）

为避免“创建时一套、运行时一套、judge 回包又一套”，Phase 3 validator 统一分成 3 个决策层级：
- `reject-on-save`：创建 / 更新直接 4xx，不写库
- `normalize-with-warning`：允许保存或继续运行，但必须把 warning 返回前端，并记录到 case / run 的 validation warnings
- `needs-review-at-run`：本次 run 可继续，但聚合 verdict 最高只能到 `borderline`

统一输出建议（canonical 只认 `issues[]`；`errors / warnings / needsReviewReasons` 只允许作为由 `issues[]` 派生的 UI 视图，不得继续作为独立协议扩散）：

```json
{
  "normalizedCase": {},
  "issues": [
    {
      "code": "user_prompt_required",
      "severity": "error | warning | needs-review",
      "path": "userPrompt",
      "message": "userPrompt is required"
    }
  ],
  "caseSchemaStatus": "valid | invalid"
}
```

#### A. 创建 / 更新 Full case：必须拒绝（reject-on-save）

- canonical `userPrompt` 非空
- `expectedGoal` 非空
- `expectedSteps` 必须是 `1~12` 项数组，且至少 `1` 个 `required = true`
- 每个 step 的 `id` 必须 case 内唯一；`title` / `expectedBehavior` 归一化后非空
- `order` 若存在必须为正整数且同一 case 内唯一；归一化顺序约束不得引用未知 stepId，也不得形成重复 stepId 的硬顺序列表
- 每个 step 的 `strongSignals` 最多 `5` 条；`strongSignals[].id` 必须 case 内唯一
- `strongSignals[].type` 只允许 `tool | text | state`
- `strongSignals[]` 必须满足各类型最小 shape：`tool -> toolName`、`text -> text | pattern`、`state -> key + expected`；否则记 `signal_shape_invalid`
- 若使用确定性 supporting matcher，只允许 `contains | equals | regex`
- `evaluationRubric.criticalConstraints[].id` 必须 case 内唯一；`appliesToStepIds` 全部可解析到现有 step
- `criticalDimensions` 只允许 `sequenceAdherence`
- 若 `criticalDimensions` 包含 `sequenceAdherence`，归一化后必须存在顺序约束
- `passThresholds.*` / `hardFailThresholds.*` 必须位于 `0~1`，且同一维度满足 `hardFailThreshold <= passThreshold`
- `supportingSignalOverrides[]` 只能引用已存在的 `stepId + signalId`；同一对引用不得重复；`severity` 当前只允许 `critical`

#### B. 创建 / 更新 Full case：允许归一化但必须回 warning（normalize-with-warning）

- 同时提供 `step.order` 与 `expectedSequence` 且二者冲突 → 以 `expectedSequence` 为准，并返回 warning
- `failureIfMissing` 缺失 → 自动补默认诊断文案，并返回 warning
- `strongSignals` 使用未知 matcher 语法 → 降级为 judge 提示文本，不参与确定性 supporting match，并返回 warning
- `expectedTools` 与 `expectedSteps` 同时存在 → 允许保存，但必须在 UI 上标注“辅证字段”，避免被误读为主判真源

#### C. 运行前 preflight：`normalizeCase()` 的硬规则

- run 路径必须先执行同一套 case validator；不能绕过创建 / 更新校验直接跑 agent
- 若归一化后的 case 仍命中任一 `reject-on-save` 条件，则**不启动 agent run**，直接返回 `case_schema_invalid`
- 不提供运行时 legacy fallback；Full case 只要缺失 `expectedGoal`、`expectedSteps`、required step 或可解析顺序配置，就直接返回 `case_schema_invalid`
- preflight 必须把 `normalizedCase` 与 `issues[]` 一并传给 judge 构造、聚合器与前端 run 详情

#### D. Judge 回包 validator：决定 `aiJudge.status` + `issues[]`

- `aiJudge.status` 只表达调用 / 解析状态，固定枚举为 `succeeded | parse_failed | runtime_failed | skipped`；“待复核”统一通过 `issues[].severity = 'needs-review'` 表达
- judge 原始输出不可解析、缺少顶层必填字段、或 `goalAchievement.score / instructionAdherence.score / confidence` 超出 `0~1` → 统一记为 `aiJudge.status = 'parse_failed'`
- `steps[]` 中出现未知 `stepId` → 丢弃该项并返回 warning
- `steps[]` 中同一 `stepId` 重复出现 → 视为 schema invalid，整体降级为 `parse_failed`
- 若某个归一化 step 没有对应 judge 结果 → 自动补一条 `completed = false`、`confidence = 0` 的占位结果，并追加 `severity = 'needs-review'` 的 issue
- `constraintChecks[]` 中出现未知 `constraintId` → 丢弃该项并返回 warning
- `constraintChecks[]` 中同一 `constraintId` 重复出现 → 视为 schema invalid，整体降级为 `parse_failed`
- 若 case 定义了 `criticalConstraints` 但 judge 漏回某条检查 → 自动补 `satisfied = null` 的占位结果，并追加 `severity = 'needs-review'` 的 issue
- 非法 `evidenceIds` / `matchedSignalIds` 只做剥离与 warning，不静默当作命中；若剥离后必需 step / critical constraint 没有任何有效证据，本次 run 最高只能 `borderline`
- `matchedSignalIds` 只能引用 case 内唯一的 `strongSignals[].id`
- `verdictSuggestion` 只允许 `pass | borderline | fail`

#### E. 落库 / projection validator：`evaluation_json` 是唯一真源

- Full run 的写入路径只接受服务端聚合后的 `evaluation_json`；禁止客户端或 judge 直接覆写镜像标量列
- `requiredStepCompletionRate`、`stepCompletionRate`、`goalAchievement`、`sequenceAdherence` 等镜像列必须由 `evaluation_json.dimensions.*.score` 投影生成
- 若投影失败或镜像列与 `evaluation_json` 不一致，以 `evaluation_json` 为准，并记录修复 warning / backfill 任务
- 详情页读取 `evaluation_json`；列表筛选 / 排序 / 报表优先读取镜像列，但其修复真源始终是 `evaluation_json`

### 9. 建议拆分实施阶段（含分工）

推荐按“先冻 contract，再并行实现”的顺序拆成 5 个工作流：

- **Workstream A：Schema / Validator / Normalizer（先做，后续真源）**
  - 交付：case create/update validator、run preflight `normalizeCase()`、warning / needs-review 输出格式
  - 依赖：无
  - 完成标志：`userPrompt` canonical、`expectedSteps` / `evaluationRubric` 规则、judge 回包校验口径全部冻结

- **Workstream B：Generator / Judge Contract**
  - 交付：Full 生成器输出 `expectedSteps + expectedGoal + evaluationRubric`、judge 结构化输出 `steps[] / constraintChecks[] / matchedSignalIds`
  - 依赖：A 的 canonical schema
  - 完成标志：生成 draft 与 judge 回包都能稳定通过 validator，不再靠字段猜测

- **Workstream C：Aggregation / Persistence / Regression**
  - 交付：timeline id 归一化、`sequenceAdherence` 计算、`aggregateFullVerdict()`、`evaluation_json` 落库、镜像列投影、回归查询
  - 依赖：A（schema）、B（judge output shape）
  - 完成标志：同一 run 的 step / constraint / dimension / aggregation 数据可稳定重放与回归对比

- **Workstream D：UI Editor / Result UX**
  - 交付：Full case 编辑器校验提示、step 级结果页、constraintChecks / aggregation 展示
  - 依赖：A 的 case schema；可先基于 mock `evaluation_json` 并行开发，再接 C 的真实接口
  - 完成标志：用户能在 UI 中看见 reject / warning / needs-review 三层反馈，并完成“编辑 → 运行 → 看原因”主流程

- **Workstream E：Tests / Rollout**
  - 交付：契约测试 / 回归测试矩阵、人工验证 checklist
  - 依赖：A / C / D
  - 完成标志：发布时不需要手工猜字段含义，且 Full 新 schema 的端到端链路稳定可回归
  - 本次决策：不做 legacy case 批量转换策略与镜像列 backfill 项目化工作

推荐先后顺序：
1. 先完成 **A**，把 validator 与 canonical schema 钉死
2. **B** 和 **D** 可在 A 之后并行；D 先吃 mock 数据，减少等待
3. **C** 在 A 冻结后尽快接上，把聚合与落库真源稳定下来
4. 最后做 **E**，补测试矩阵与发布收口

如果按最小人力分工：
- `1` 人负责 **A**
- `1` 人负责 **B + C**
- `1` 人负责 **D + E**（前半先做 UI / mock，后半接验证与发布收口）

### 10. Workstream A 详细 implementation checklist（冻结 validator 真源）

Workstream A 的目标不是“先把功能做出来”，而是**先把 Full case / run / judge 三个边界的 canonical contract 钉死**，让后续 B / C / D 都只围绕同一份真源开发。

#### 10.1 交付边界

Workstream A 必须一次性交付 4 个纯逻辑入口；即使第一版暂时仍放在 `server/api/skill-test-controller.ts` 内部 helper，也必须保证它们**可单测、无 HTTP 依赖、无 DB 副作用**：

1. `validateAndNormalizeCaseInput(input, { existing, mode: 'create' | 'update' })`
   - 负责 create / update 的 reject-on-save 与 normalize-with-warning
   - 输出 canonical `userPrompt`、`expectedSteps`、`evaluationRubric`、`issues[]`
2. `normalizeCaseForRun(storedCase)`
   - 负责 run 前 preflight 与 `case_schema_invalid` 判定
   - 命中硬错误时直接返回 `case_schema_invalid`
3. `validateJudgeOutput(judgeJson, normalizedCase, timelineIds)`
   - 负责 judge 回包 schema 校验、占位补全、needs-review issues
4. `buildValidationEnvelope()`
   - 负责把各阶段产生的 `error / warning / needs-review` 结果统一成同一套 issue 结构

统一 issue 结构建议冻结为：

```json
{
  "code": "user_prompt_required",
  "severity": "error | warning | needs-review",
  "path": "expectedSteps[0].id",
  "message": "userPrompt is required"
}
```

统一输出 envelope 建议：

```json
{
  "normalizedCase": {},
  "issues": [
    {
      "code": "expected_steps_required",
      "severity": "error",
      "path": "expectedSteps",
      "message": "expectedSteps must contain 1~12 items"
    }
  ],
  "caseSchemaStatus": "valid | invalid"
}
```

约束：
- **不允许静默修正未声明的规则**；只有 PRD 明确列出的 normalize 行为可以自动修正
- **不允许 save / run / judge 三条路径各自定义 issue code**；必须共用同一套 code 命名
- **Controller 只做 HTTP 映射**；规则分支必须沉到上述纯 helper，避免后续 B / C / D 再次复制条件

#### 10.2 实施 checklist（按提交顺序）

**A1. 冻结 issue code 与 severity 映射**
- 先确定 `error / warning / needs-review` 三层的最终 code 清单
- 每条 code 必须写明：触发条件、输出路径、save 行为、run 行为
- 未进入本清单的情况，一律不得在实现中“临时新增一个字符串提示”

**A2. 扩展 create / update validator 到 Full canonical schema**
- 让 `validateAndNormalizeCaseInput(...)` 在 Full 模式只接受 canonical `userPrompt`
- 新增 `expectedSteps`、`evaluationRubric`、`criticalConstraints`、`supportingSignalOverrides` 的完整校验
- 保留 Dynamic 模式旧行为，但不得让 Full 的新规则污染 Dynamic 保存路径

**A3. 实现 `normalizeCaseForRun(...)` preflight**
- run 前必须重走与 save 相同的 schema 校验
- 不做 legacy 映射或运行时 fallback；缺少 canonical 字段直接判为 schema invalid
- 输出 `normalizedCase + issues + caseSchemaStatus`
- 命中硬错误时，不启动 agent run，直接返回 `case_schema_invalid`

**A4. 实现 `validateJudgeOutput(...)`**
- 校验 `steps[] / constraintChecks[] / matchedSignalIds / evidenceIds / verdictSuggestion`
- 自动补齐缺失 step / constraint 的占位结果
- 把未知 `evidenceIds` / `matchedSignalIds` 统一降级为 warning 或 needs-review，不允许静默当命中
- judge parse fail / duplicate id / 越界 score 必须统一落到 `aiJudge.status = 'parse_failed'`

**A5. 串起 issue 透传链路**
- create / update API 返回 `issues[]`
- run preflight 返回 `issues[]`、`caseSchemaStatus`
- run detail 的 `evaluation_json.validation` 必须保留本次 run 观察到的 warning / needs-review
- UI 后续只消费 `issues[]`，不再根据 message 文案做字符串判断

**A6. 测试冻结**
- `tests/skill-test/skill-test-schema.test.js` 至少覆盖：save reject、save warning、run preflight schema invalid、judge parse fail、judge placeholder backfill、needs-review 上限逻辑
- 所有新增 validator helper 必须优先有纯函数测试，再接 controller / E2E
- 对每条 issue code 至少有 1 个正例或反例，避免未来删规则时无感回归

#### 10.3 Validator rule matrix（实现时只认这张表）

##### A. Save / Update 路径

| code | 触发条件 | level | Save 行为 | 运行前行为 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `user_prompt_required` | Full case `userPrompt` 为空 | error | 400 | `case_schema_invalid` | Full 唯一输入字段 |
| `expected_goal_required` | Full case `expectedGoal` 为空 | error | 400 | `case_schema_invalid` | Full 主目标必填 |
| `expected_steps_required` | `expectedSteps` 不是 `1~12` 项数组 | error | 400 | `case_schema_invalid` | Full canonical schema 强制必填 |
| `required_step_missing` | `expectedSteps` 中没有任一 `required = true` | error | 400 | `case_schema_invalid` | Full 主判必须有 required step |
| `step_id_duplicate` | step `id` 重复 | error | 400 | `case_schema_invalid` | 不允许按位置隐式识别 |
| `step_title_or_behavior_missing` | step 的 `title` 或 `expectedBehavior` 归一化后为空 | error | 400 | `case_schema_invalid` | 两者都是真源字段 |
| `sequence_config_invalid` | `order` / `expectedSequence` 引用了未知 step、重复 step、或出现重复 `order` 等无效顺序配置 | error | 400 | `case_schema_invalid` | 不允许把坏顺序拖到聚合器 |
| `signal_id_duplicate` | `strongSignals[].id` case 内重复 | error | 400 | `case_schema_invalid` | supporting 引用必须稳定 |
| `signal_type_invalid` | `strongSignals[].type` 不在 `tool | text | state` | error | 400 | `case_schema_invalid` | |
| `signal_shape_invalid` | `strongSignals[]` 未满足 type 对应最小 shape（`toolName` / `text|pattern` / `key+expected`） | error | 400 | `case_schema_invalid` | 避免 state/text/tool 各自漂移 |
| `threshold_range_invalid` | 任一 `passThreshold` / `hardFailThreshold` 不在 `0~1` 或顺序错误 | error | 400 | `case_schema_invalid` | 同维度必须 `hardFail <= pass` |
| `critical_dimension_requires_sequence` | `criticalDimensions` 含 `sequenceAdherence`，但 case 无顺序约束 | error | 400 | `case_schema_invalid` | 默认顺序不直接 hard-fail |
| `constraint_target_missing` | `criticalConstraints[].appliesToStepIds` 引用未知 step | error | 400 | `case_schema_invalid` | |
| `override_target_missing` | `supportingSignalOverrides[]` 引用未知 `stepId + signalId` | error | 400 | `case_schema_invalid` | |
| `failure_if_missing_defaulted` | step 缺少 `failureIfMissing`，被自动补默认文案 | warning | 允许保存 | 保留 warning | 不得 silently patch |
| `sequence_source_conflict` | 同时提供 `step.order` 与 `expectedSequence` 且二者冲突 | warning | 以 `expectedSequence` 归一化后保存 | 保留 warning | 规则必须固定 |
| `unsupported_signal_matcher` | `strongSignals` 使用未知 matcher DSL | warning | 降级为 judge 提示文本后保存 | 保留 warning | 不参与确定性 supporting match |
| `supporting_expected_tools_present` | `expectedTools` 与 `expectedSteps` 同时存在 | warning | 允许保存 | 保留 warning | UI 必须标注为 supporting 字段 |

##### B. Run preflight 路径

| code | 触发条件 | level | Preflight 行为 | verdict 上限 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `case_schema_invalid` | preflight 后仍缺 `expectedGoal` / required step / 可解析 schema | error | 不启动 agent run | 不适用 | API 应直接返回结构化 issues |
| `critical_sequence_evidence_unavailable` | 顺序被标为 critical，但 run 前已知无法构造可验证顺序约束 | needs-review | 继续运行 | `borderline` | 证据不足不等于顺序已错 |

##### C. Judge output 路径

| code | 触发条件 | level | Judge validator 行为 | verdict 上限 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `judge_parse_failed` | JSON 不可解析、缺顶层必填、score 越界、重复 `stepId` / `constraintId` | error | `aiJudge.status = 'parse_failed'` | `borderline` | 不直接把 run 打成 fail |
| `judge_unknown_step_id` | `steps[]` 引用未知 `stepId` | warning | 丢弃该项 | `borderline`（若影响 required step） | |
| `judge_step_missing` | 某归一化 step 缺少 judge 结果 | needs-review | 自动补 `completed = false` 占位 | `borderline` | 防止静默漏评 |
| `judge_unknown_constraint_id` | `constraintChecks[]` 引用未知 `constraintId` | warning | 丢弃该项 | `borderline`（若影响 critical constraint） | |
| `judge_constraint_missing` | case 定义了 `criticalConstraints` 但 judge 漏回检查 | needs-review | 自动补 `satisfied = null` 占位 | `borderline` | 后端不自己猜是否满足 |
| `judge_unknown_evidence_id` | `evidenceIds` 不存在于当前 timeline | warning | 剥离无效 id | `borderline`（若 required step / critical constraint 失去全部证据） | |
| `judge_unknown_signal_id` | `matchedSignalIds` 不存在于 case | warning | 剥离无效 id | 正常或 `borderline` | supporting 只作弱证据 |
| `judge_verdict_invalid` | `verdictSuggestion` 不是 `pass | borderline | fail` | error | 视为 `parse_failed` | `borderline` | |

##### D. 落库 / projection 路径

| code | 触发条件 | level | Persistence 行为 | 备注 |
| --- | --- | --- | --- | --- |
| `evaluation_projection_failed` | `evaluation_json` 无法投影到镜像列 | warning | 保留 `evaluation_json`，镜像列置空并记录 backfill 任务 | `evaluation_json` 永远是真源 |
| `evaluation_projection_mismatch` | 镜像列与 `evaluation_json.dimensions` 不一致 | warning | 以 `evaluation_json` 为准并排队修复 | 不允许前端按镜像列反写真源 |

#### 10.4 Workstream A 的建议子任务（便于 1~2 人拆分）

如果只有 `1` 人：按 `A1 → A2 → A3 → A4 → A5/A6` 顺序串行落地。

如果有 `2` 人，建议拆成：
- **A-Case**：`validateAndNormalizeCaseInput(...)`、save/update issue codes、run preflight 输入归一化、case 相关单测
- **A-Run**：`normalizeCaseForRun(...)`、`validateJudgeOutput(...)`、run detail issue 透传、judge / needs-review 单测

协作边界：
- A-Case 先提交 issue code 清单与 canonical case shape，A-Run 只能消费这份真源，不再重命名字段
- A-Run 不得修改 save-path 规则；若 judge / preflight 发现新情况，只能回补到同一张 rule matrix，再统一加 code
- 两边最终共用同一个 `issues[]` envelope，禁止分别返回 `warnings[]` / `reviewFlags[]` 两套结构

#### 10.5 Workstream A 完成标志（进入 B / C / D 的门槛）

只有同时满足以下条件，才算 A 完成：
- Full case 的 create / update / run preflight / judge validate 都使用同一套 issue code 与 canonical 字段名
- `userPrompt` 已成为 Full 唯一 canonical 输入字段
- `expectedSteps` / `evaluationRubric` / `constraintChecks[]` / `matchedSignalIds` 的 contract 已被冻结，不再需要 B / C / D 自己猜 shape
- `tests/skill-test/skill-test-schema.test.js` 能覆盖 rule matrix 中所有 `error` code，以及主要 `warning / needs-review` 分支
- 出现 schema 异常时，前端与日志里都能拿到结构化 `issues[]`，而不是只看到一条模糊字符串

## 数据模型调整建议

### `skill_test_cases`
保留现有主结构，并新增 / 调整：

```sql
ALTER TABLE skill_test_cases ADD COLUMN case_status TEXT NOT NULL DEFAULT 'draft';
-- 'draft' | 'ready' | 'archived'

ALTER TABLE skill_test_cases ADD COLUMN expected_goal TEXT NOT NULL DEFAULT '';
ALTER TABLE skill_test_cases ADD COLUMN expected_steps_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE skill_test_cases ADD COLUMN expected_sequence_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE skill_test_cases ADD COLUMN evaluation_rubric_json TEXT NOT NULL DEFAULT '{}';
```

字段语义：
- `case_status`
  - `draft`：AI 生成后等待人工检查
  - `ready`：人工确认，可纳入批量运行
  - `archived`：不再使用
- `expected_goal`
  - Full 模式目标描述，供 AI judge 使用
- `expected_steps_json`
  - Full 模式行为步骤定义；作为 judge 和 UI 的主评测配置
- `expected_sequence_json`
  - Full 模式关键步骤顺序提示；可作为 `expectedSteps.order` 的补充 / 覆盖
- `evaluation_rubric_json`
  - Full 模式多维评估配置

兼容策略：
- `test_type` 继续保留为历史统计字段，但不再驱动新流程
- `case_status` 成为 case 生命周期的唯一写入真源；新建、编辑、列表筛选、批量运行都只读写 `case_status`
- `validity_status` 不再参与新流程读写、筛选或批量运行逻辑
- 旧 case 不做运行时兼容映射；发布前按“手动重建或归档”处理

### `skill_test_runs`
在现有字段基础上补充多维指标：

```sql
ALTER TABLE skill_test_runs ADD COLUMN required_step_completion_rate REAL;
ALTER TABLE skill_test_runs ADD COLUMN step_completion_rate REAL;
ALTER TABLE skill_test_runs ADD COLUMN required_tool_coverage REAL;
ALTER TABLE skill_test_runs ADD COLUMN tool_call_success_rate REAL;
ALTER TABLE skill_test_runs ADD COLUMN tool_error_rate REAL;
ALTER TABLE skill_test_runs ADD COLUMN sequence_adherence REAL;
ALTER TABLE skill_test_runs ADD COLUMN goal_achievement REAL;
ALTER TABLE skill_test_runs ADD COLUMN instruction_adherence REAL;
ALTER TABLE skill_test_runs ADD COLUMN verdict TEXT DEFAULT '';
ALTER TABLE skill_test_runs ADD COLUMN evaluation_json TEXT NOT NULL DEFAULT '{}';
```

说明：
- Dynamic 模式下：主要写 `trigger_passed` 与加载证据；execution 相关字段可为 `NULL`
- Full 模式下：`trigger_passed` 可为 `NULL`，重点写多维 execution 结果
- `evaluation_json` 是 Full run 结果的细粒度真源，至少包含 `dimensions`、`steps`、`constraintChecks`、`summary`、`aiJudge`、`aggregation`
- `required_step_completion_rate`、`step_completion_rate`、`required_tool_coverage`、`sequence_adherence`、`goal_achievement` 等标量列是列表筛选、排序、报表聚合用的镜像索引，值必须从 `evaluation_json.dimensions.*.score` 投影得到
- 若标量列与 `evaluation_json` 不一致，以 `evaluation_json` 为真源，并在后续写回 / 迁移时修正镜像列

## 执行流程调整

### Dynamic 模式

```text
创建 / AI 生成 dynamic case
  → case_status = draft
  → 用户编辑后标记 ready
  → 手动运行
  → 检测 read 工具读了对应的skill路径
  → 输出 load passed / failed + evidence
```

### Full 模式

```text
创建 / AI 生成 full case
  → case_status = draft
  → 用户编辑 userPrompt / expectedSteps / expectedGoal / expectedSequence（可选 supporting: expectedTools）
  → 手动运行
  → 收集统一 evidence timeline
  → AI judge 评 step completion / goal / adherence / summary
  → 代码按 evidenceIds 计算 sequence，并结合工具辅证生成多维结果 + 聚合 verdict
```

### 批量运行规则
- 新逻辑只批量运行 `case_status = ready` 的 case
- `draft` case 不进入批量运行
- `archived` case 完全排除
- 用户可从列表中将草稿批量转为 ready

## API 调整建议

### 测试用例管理

```text
GET    /api/skills/:skillId/test-cases
POST   /api/skills/:skillId/test-cases
PATCH  /api/skills/:skillId/test-cases/:caseId
DELETE /api/skills/:skillId/test-cases/:caseId
POST   /api/skills/:skillId/test-cases/generate
POST   /api/skills/:skillId/test-cases/:caseId/mark-ready
POST   /api/skills/:skillId/test-cases/:caseId/mark-draft
```

### 执行与结果

```text
POST /api/skills/:skillId/test-cases/:caseId/run
POST /api/skills/:skillId/test-cases/run-all
GET  /api/skills/:skillId/test-cases/:caseId/runs
GET  /api/skills/:skillId/test-cases/:caseId/regression
GET  /api/skills/:skillId/regression
GET  /api/skill-test-runs/:runId
GET  /api/skill-test-summary
```

### case payload 归一化契约

- Full case 的创建 / 更新入参只接收 `userPrompt`
- Full case 在存储层、judge prompt、回归对比、前端新 UI 中统一使用 canonical `userPrompt`
- `expectedSteps[].strongSignals[].id`、`evaluationRubric.supportingSignalOverrides[].stepId`、`evaluationRubric.supportingSignalOverrides[].signalId` 必须在创建 / 更新时做 schema 校验，避免保存后引用漂移
- `evaluationRubric.criticalConstraints[].id` 必须 case 内唯一；`criticalDimensions` 只允许 `sequenceAdherence`，且要求归一化后存在顺序约束

### `generate` 请求语义调整

```json
{
  "loadingMode": "dynamic | full",
  "count": 5,
  "createDrafts": true
}
```

约束：
- `generate` 只负责生成草稿，不隐式触发 run
- Dynamic 返回“触发 prompt 草稿”
- Full 返回“执行测试草稿 + rubric 草稿”

### 生成模型策略
- Phase 3 默认复用页面顶部当前选择的 `provider / model` 作为 AI 生成模型，避免再新增一组“生成模型”配置
- `POST /generate` 可显式接收 `provider` / `model`；若前端未传，则回退到运行时默认模型
- `promptVersion` 继续只承担运行 / 回归标签语义，不作为“生成 prompt 模板版本”的配置源
- 生成出来的 draft 元数据需记录 `generationProvider`、`generationModel` 与生成时间，方便后续追查质量来源

## 前端交互调整建议

### 1. 主流程简化
用户主流程收敛为：
1. 选 Skill
2. 选模式（dynamic / full）
3. AI 生成或手动创建
4. 编辑草稿
5. 运行并看结果

### 2. 表单收敛
- 默认隐藏单独的 `测试侧重点` 控件
- Dynamic 模式只展示与加载验证相关的字段
- Full 模式才展示 `expectedSteps`、`expectedGoal`、`expectedSequence`、`evaluationRubric`，并将 `expectedTools` 降级到辅证区域

### 3. 生成结果优先进入草稿列表
- 生成后不弹自动运行
- 直接落到列表中的 `draft` 分组
- 就近提供：编辑、标记 ready、删除、运行

### 4. Full 模式结果页改成多维卡片
至少展示：
- 关键步骤完成度
- 顺序执行度
- 目标达成度
- 行为符合度
- 工具调用覆盖度（辅证）
- 工具调用成功度（辅证）
- 工具调用错误率（辅证）
- AI 总结

### 5. 回归视图支持维度对比
对 Full 模式，不只对比 pass/fail，还支持按维度看不同模型 / prompt version 的变化：
- `requiredStepCompletionRate`
- `goalAchievement`
- `instructionAdherence`
- `sequenceAdherence`
- `toolCallSuccessRate`
- `toolErrorRate`

## Phase 3 验收标准

- [ ] Dynamic 模式的产品语义清晰收敛为“只验证 skill 是否成功加载 / 触发”，运行结果不再混入 execution 质量结论
- [ ] Full 模式的产品语义清晰收敛为“只验证 skill 是否按预期执行并达成目标”，不再展示 `read-skill` 触发式判定为主结果
- [ ] 前端主流程默认不再要求用户同时理解 `loadingMode + testType` 两套概念；`testType` 从主配置中退场或显著降级
- [ ] Dynamic / Full 两种模式都支持 AI 生成测试用例
- [ ] AI 生成后的测试用例默认进入 `draft`，不会自动执行；用户可编辑后再运行
- [ ] 批量运行默认只运行 `ready` 状态的 case，避免误跑草稿
- [ ] Full 模式运行结果不再只是 True / False，而是至少输出关键步骤完成度、顺序执行度、目标达成度、行为符合度，以及工具调用覆盖度 / 成功度 / 错误率等辅证维度及原因
- [ ] Full 模式 AI 生成的 case 默认产出 `expectedSteps`，不再把关键词 / 工具参数硬匹配当成主评测配置
- [ ] Full 模式详情能够展示 step 级判定（`completed / confidence / evidence / reason`），用户可直接看到“哪一步没做对”
- [ ] 顺序执行度以行为步骤证据顺序为主计算，不再仅依赖工具顺序硬匹配
- [ ] Full 模式保留聚合 verdict，但该 verdict 只是摘要，不替代多维结果本身
- [ ] 回归对比能够展示 Full 模式关键维度随模型 / prompt version 的变化
- [ ] 明确旧版 `expectedTools` 主判 Full case 不纳入兼容范围，需手动重建或归档；历史 run 数据可只读查看

## Phase 划分更新

### Phase 1（已完成）
- Dynamic 模式触发检测
- 基础 execution L1 工具名匹配
- 初始生成 / 创建 / 运行链路
- Eval-case 集成

### Phase 2（已完成 / 已落地）
- Full 模式触发检测
- AI judge 初版
- L2 参数结构校验
- L3 调用时序校验
- 回归 buckets（provider / model / promptVersion）

### Phase 3（本次重开）
- 模式语义收敛：dynamic = load, full = execution
- `testType` 从主配置中退场
- 两种模式都支持 AI 生成
- AI 生成改为 Draft-First
- Full 模式改为多维评估输出
- 前端结果与回归视图围绕多维结果重构

## 需要重点评审的问题

1. **`test_type` 是仅前端隐藏，还是后端逐步废弃？**
2. **Dynamic 模式是否仍需保留可选 smoke validate 按钮，但不作为 generate 默认动作？**
3. **Full 模式的 `goalAchievement / instructionAdherence` 是否都交给 AI judge，还是部分由规则补充？**
4. **多维结果的阈值应否在 skill 级别可配置，还是先用全局默认值？**
5. **发布说明是否明确“旧版 full-mode case 需手动重建或归档，不做自动迁移兼容”？（当前决策：是）**

## 本次 PRD 更新结论

Skill Testing 不再继续扩张“一个模式同时测很多东西”的混合语义，而是进入 Phase 3：

- **Dynamic 模式只测 load**
- **Full 模式只测 execution**
- **两个模式都能 AI 生成 case**
- **生成后先编辑，不自动跑**
- **Full 模式主评测配置升级为 `expectedSteps` 行为步骤**
- **Full 模式结果升级为“步骤主判 + 多维诊断”，不再只有 True / False**
