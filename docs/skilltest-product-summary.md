# Skill Tests 功能产品总结

## 一句话定位

`Skill Tests` 是 CAFF 内部面向 Skill 作者、评审者与平台维护者的 **Skill 质量工作台**。

它的核心作用不是“跑一条测试”这么简单，而是把 Skill 的验证拆成 **可生成、可编辑、可运行、可诊断、可回归、可隔离** 的完整闭环，并逐步承担 **skill publish gate 前置门禁** 的职责。

简单说：

> 它是 CAFF 里专门用来验证“一个 Skill 有没有被正确加载、有没有按预期完成任务、结果能不能作为后续发布依据”的产品化测试台。

---

## 这项功能主要解决什么问题

从产品视角看，Skill Tests 主要在解决 5 类痛点：

1. **Skill 改了以后，很难稳定复测**
   - 过去更多依赖人工口头验证或临时对话，复现成本高。

2. **“能不能触发”与“执行得好不好”混在一起**
   - 一个 Skill 可能已经被成功加载，但行为链路仍然不合格。
   - 也可能执行逻辑没问题，但 dynamic 模式下根本没正确读取目标 `SKILL.md`。

3. **结果过于二值化，不够诊断**
   - 只知道 pass/fail 不够，需要知道失败在哪一步、缺了什么证据、是顺序错了还是目标没达成。

4. **回归对比不成体系**
   - 换模型、换 prompt version、换 agent 后，缺少稳定的横向对比视图。

5. **测试过程可能污染真实环境**
   - 特别是涉及 `.trellis`、shared skills、SQLite、agent sandbox 的 Skill，如果直接在宿主环境跑，测试结果不适合充当发布依据。

---

## 目标用户是谁

这不是一个面向最终聊天用户的功能，而是一个偏内部的 QA / 研发工具。

主要用户分三类：

### 1. Skill 作者
- 希望快速验证自己写的 Skill 是否能被正确触发
- 希望在改 prompt、改步骤、改约束后立刻看到结果
- 希望沉淀可复用的测试 case，而不是每次手动试

### 2. 评审 / QA / 项目维护者
- 需要判断某个 Skill 是否达到了“可上线 / 可发布 / 可回归”的标准
- 需要知道失败原因，而不是只看一个布尔值
- 需要批量运行 Ready case，做例行巡检

### 3. 平台 / Runtime 维护者
- 需要验证 dynamic/full 两种 Skill 注入模式的行为是否一致、是否稳定
- 需要把 Skill 测试结果纳入更可信的隔离环境和发布门禁流程

---

## 在产品中的入口与形态

当前 Skill Tests 不是独立站点，而是集成在 `错题本 / A/B 测试` 页面里：

- 页面入口：`/eval-cases.html`
- 入口位置：顶部 Tab 中的 `Skill 测试`

它已经形成了一套比较完整的工作台形态：

- 顶部固定工具栏：选 Skill / Agent / 模型 / Prompt Version / 运行默认配置
- 概览区：看当前 Skill 的 case 状态和最近表现
- 用例列表区：搜索、筛选、快速运行、进入详情
- 详情区：按 `概览 / 详情 / 运行历史 / 回归对比` 分 Tab 展示
- 创建区：支持手动创建结构化 case
- Summary 区：查看所有 Skill 的汇总表现

从产品完成度看，这已经不是“一个后台接口 + 一个表单”的阶段，而是一个可持续使用的 **Skill QA 工作台**。

---

## 核心产品流程

当前主流程已经比较清晰，可以概括为：

1. **选择 Skill**
   - 决定本次要验证哪个 Skill。

2. **选择运行上下文**
   - 可选 Agent、模型、Prompt Version。
   - 可配置本次运行默认值：`isolationMode`、`trellisMode`、`egressMode`、`publishGate`。

3. **生成或创建测试用例**
   - 可以让 AI 自动生成草稿。
   - 也可以手动创建更精确的 case。

4. **先编辑，再决定是否运行**
   - 生成后的 case 默认进入 `draft`。
   - 用户可以修改 prompt、目标、步骤、工具、顺序、rubric。
   - 只有确认后才标记 `ready` 或手动运行。

5. **执行单条或批量运行**
   - 单条运行：适合调试。
   - 批量运行：只跑 `ready` case，适合回归。

6. **查看诊断结果**
   - 看 live trace、工具轨迹、运行结果、结构化 issue、步骤完成情况。

7. **做回归对比**
   - 按 `provider / model / promptVersion` 分桶比较结果。

---

## 当前能力拆解

## 1. 用例生产与生命周期管理

当前 Skill Tests 已经支持完整的用例管理能力：

- **AI 生成测试用例草稿**
  - 支持 `dynamic` 与 `full` 两种模式生成。
- **手动创建测试用例**
  - 适合补充复杂或高精度 case。
- **Draft-First 工作流**
  - 生成后默认保存为 `draft`，不自动运行。
- **状态流转**
  - 支持 `draft`、`ready`、`archived` 等状态。
- **Ready 门禁**
  - 无效 schema 的 case 不能标记 `ready`，也不能直接运行。
- **搜索与筛选**
  - 可按 case id、prompt、备注、工具等进行定位。
- **下载 / 删除**
  - 方便导出和清理 case。

从 PM 角度看，这一块解决的是“测试资产沉淀”问题：

> Skill 测试不再是一次性的，而是可以积累成长期可复用的 case 库。

---

## 2. 两种测试语义已经被明确拆开

这是整个 Skill Tests 最关键的产品定义。

### Dynamic 模式：只测“有没有正确加载 Skill”

当前 Dynamic 模式的定位已经被收敛得很清楚：

- 核心目标：验证 Agent 是否成功识别并加载目标 Skill
- 关键证据：是否读取目标 `/skills/<skillId>/SKILL.md`
- 适合场景：验证 Skill 是否会被正确触发、dynamic path 是否通

它**不再把执行质量当主任务**。

这意味着 Dynamic 更像一个“加载/触发正确性检查器”。

### Full 模式：只测“行为链路和任务结果”

当前 Full 模式则聚焦执行质量：

- 是否完成关键 `expectedSteps`
- 是否满足约束 `constraintChecks`
- 是否达成 `expectedGoal`
- 是否遵循期望顺序
- 是否存在明显工具失败或行为偏离

它**不再把 read-skill 当作主判据**，而是重点看任务是否真的完成。

从产品设计上，这个拆分非常重要，因为它显著降低了用户心智负担：

- `dynamic` = 验证“有没有正确加载”
- `full` = 验证“有没有正确完成”

---

## 3. 结果不再只是 Pass / Fail，而是可诊断的结构化评估

当前 Full 模式已经从“二值判断”升级成“多维评估”。

### 已有的关键评估维度

- **关键步骤完成度** `requiredStepCompletionRate`
- **整体步骤完成度** `stepCompletionRate`
- **顺序执行度** `sequenceAdherence`
- **目标达成度** `goalAchievement`
- **行为符合度** `instructionAdherence`
- **必需工具覆盖度** `requiredToolCoverage`
- **工具调用成功度** `toolCallSuccessRate`
- **工具调用错误率** `toolErrorRate`

### 已有的结构化诊断结果

- `steps[]`：每一步是否完成、证据是什么、置信度如何
- `constraintChecks[]`：关键约束是否满足
- `summary`：AI judge 给出的摘要
- `missedExpectations`：遗漏项
- `verdict`：聚合后的 `pass / borderline / fail`
- `issues[]`：统一的结构化问题列表，区分 `error / warning / needs-review`

这意味着当前 Skill Tests 的定位已经从：

> “有没有通过”

升级成：

> “为什么没通过、差在哪、能不能定位到具体步骤和证据”

这对评审效率和修复效率非常关键。

---

## 4. 已具备回归分析能力，而不是只看单次运行

当前 Skill Tests 已经不是一次性运行器，而是支持“持续回归比较”的系统。

### 当前回归维度

按以下维度做分桶：

- `provider`
- `model`
- `promptVersion`

### 当前可看的回归视角

- 单个 case 的运行历史
- 单个 case 的 regression 对比
- 单个 Skill 的 regression 汇总
- 所有 Skill 的 summary 汇总

这带来的产品价值是：

- 可以比较不同模型在同一 Skill 上的表现差异
- 可以比较不同 promptVersion 的回归变化
- 可以知道某个 Skill 是“偶尔失败”还是“系统性退化”

从 PM 角度，这使它具备了 **版本回归平台** 的雏形，而不只是测试执行器。

---

## 5. 已支持 Live 运行过程可视化

当前工作台已经能在运行过程中展示实时状态，而不是必须等运行结束再看结果。

### 已有的 Live 能力

- 运行进度事件流（SSE）
- 当前工具调用状态
- 工具轨迹
- assistant 输出增量
- 运行完成后的 trace 固化展示

这件事的意义很大：

- 调试 Dynamic 模式时，可以更快确认“是否已读取目标 Skill”
- 调试 Full 模式时，可以看到卡在哪一步
- 在 OpenSandbox 路径下，也能看到 runner 准备和执行过程

从体验上看，这明显降低了“等结果 + 猜问题”的成本。

---

## 6. 已具备隔离执行基础，开始承担 publish gate 基座角色

这是当前 Skill Tests 与普通测试面板最大的差异点之一。

### 当前支持的隔离模型

#### `legacy-local`
- 适合本地调试
- 明确标记为 `notIsolated`
- **不能作为 publish gate 证据**

#### `isolated`
- 目标是让每个 case 在隔离的可写世界中运行
- 避免污染真实 `.trellis`、shared skills、真实 SQLite、其他 agent sandbox
- 可结合 OpenSandbox 作为 container-first 后端

### 当前支持的 Trellis 访问档位

- `none`：不给 `.trellis`
- `fixture`：给最小可用样板
- `readonlySnapshot`：给接近真实项目的只读快照

这使得 Trellis 类 Skill 也能被比较安全地测试，而不是直接对真实项目动手。

### 当前支持的网络/门禁控制

- `egressMode`：`deny` / `allow`
- `publishGate`：把本次运行作为发布门禁证据的意图开关

并且现在的门禁策略是**偏保守的 fail-closed**：

- 如果不是 sandbox 级执行，不应被当成 publish gate 证据
- 如果 deny egress 没真正生效，也不应放行为可信证据
- 污染检查失败、cleanup 失败、policy reject 等都应进入 evidence

从产品角度，这说明 Skill Tests 已经从“功能验证”向“可信发布前验证”演进。

---

## 7. 当前 UI 也已经产品化，而不是工程原型

从当前界面设计看，产品侧已经做过一轮明显的可用性收敛：

- 顶部 sticky 工具栏承载高频操作
- 单列优先布局，更适合高缩放和巡检
- 详情区 Tab 化，避免信息堆叠
- 用例列表支持就近运行、查看详情、搜索和筛选
- 空态、失败态、加载态都有明确下一步提示

这说明当前 Skill Tests 的目标，不只是“开发时内部能凑合用”，而是希望成为团队成员长期使用的稳定工作台。

---

## 当前产品价值判断

如果用一句更偏 PM 的判断来概括：

> Skill Tests 现在已经不是“Skill 的附属调试页”，而是 CAFF 里专门面向 Skill 质量保障的基础设施产品。

它当前至少承载了 4 层价值：

### 1. 降低 Skill 开发与迭代成本
- 作者不必每次手工复现
- case 能沉淀下来反复使用

### 2. 提高问题定位效率
- 不只告诉你失败，还告诉你失败在哪一步、缺什么证据

### 3. 让回归有可对比的时间维度
- 可以比较模型、promptVersion、不同运行批次的表现

### 4. 为未来 Skill 发布体系铺路
- 隔离执行、污染检查、policy reject、publishGate 这些设计，本质上都在为后续“Skill proposal -> 测试 -> 发布”流程打地基

---

## 当前阶段的结论

如果给这个功能一个阶段性判断，我会这样定义：

### 当前它已经完成的部分

- 已形成 **完整 Skill 测试工作台**
- 已完成 **Dynamic / Full 双模式收敛**
- 已形成 **Draft-First case 管理机制**
- 已具备 **结构化评估与诊断**
- 已具备 **回归对比能力**
- 已具备 **Live trace 能力**
- 已具备 **隔离执行与 publish gate 的基础合同**

### 当前它还不是的部分

- 还不是“面向普通终端用户”的功能
- 还不是“完全无人审核就能自动发布 Skill”的完整发布系统
- 还没有把 skill proposal / review / publish UI 整个闭环都做完

所以更准确的产品判断是：

> 目前的 Skill Tests 是一个已经较成熟的内部 Skill QA 平台，并且已经具备成为 Skill 发布门禁底座的能力，但还没有走到“全自动发布平台”的最后一步。

---

## 当前的边界与限制

从 PM 视角，也要明确它现在的边界：

1. **高级能力仍偏内部用户导向**
   - isolation、trellisMode、egress、publishGate 这些概念对普通用户不够友好。

2. **Case 设计仍需要人工参与**
   - AI 可以生成草稿，但高质量 Full case 仍需要人校正步骤、目标和 rubric。

3. **发布门禁还在“基础设施完成”阶段**
   - 现在已经能提供可信证据基础，但还没有完整串起 skill proposal / review / publish 的产品流程。

4. **配置仍有一定学习门槛**
   - 尤其对第一次接触 Skill Tests 的人来说，dynamic/full、draft/ready、isolation/trellis 仍然需要被引导。

---

## 作为产品经理，我会怎么定义它的现状

我会给出下面这句总结：

> `Skill Tests` 当前是 CAFF 内部的 Skill 质量保障中台：前面承接 Skill 编写与调试，后面承接回归分析与未来发布门禁。它已经完成了“测试工作台”这一步，下一阶段更像是把它继续接到“Skill proposal / review / publish”链路里。

---

## 如果后续继续迭代，优先级建议

如果从产品路线图往下看，我认为最值得继续做的方向有 4 个：

### P1：把 publish gate 真正产品化
- 把“测试通过”与“允许发布”连接成清晰流程
- 提供更明确的 gate 状态、失败原因与放行条件

### P1：进一步降低使用门槛
- 给不同类型 Skill 提供推荐预设
- 用更少配置完成常见场景

### P2：增强 case 模板化与复用能力
- 支持按 Skill 类型沉淀模板
- 提高 AI 生成草稿的一致性和可编辑性

### P2：补齐更强的管理视图
- 例如 Skill 级健康度、失败趋势、最近退化、待处理问题聚合

---

## 最后一句总结

如果只保留一句话给团队同步：

> 当前项目里的 `skilltest` 功能，已经从“辅助开发的小工具”进化成了一个较完整的 **Skill 测试与回归工作台**，并且正在向 **可作为发布门禁基础设施的内部产品** 演进。
