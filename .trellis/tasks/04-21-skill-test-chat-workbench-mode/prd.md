# PRD: Skill Test 聊天工作台模式

## 背景

当前 `skill-test` 的 AI 生成测试用例能力仍偏一次性：
- 用户只能把需求压缩进单轮生成请求，无法持续对话式补充“想优先覆盖什么”“哪些边界不重要”“已有回归 bug 要不要纳入”
- 生成器难以复用 CAFF 已有的多 agent 讨论、追问、交叉审查能力
- 生成结果通常直接面向 case 草稿，缺少“先形成测试矩阵、再确认、最后批量落地”的中间层

与此同时，CAFF 已经具备几块可复用基础：
- 聊天工作台已经支持多 agent 协作、显式 @、连续对话与工具调用
- Skill Tests 已经具备 draft-first 的 case 存储、编辑、运行、回归对比与结构化 schema
- Skill 动态加载与 Trellis 上下文注入已经能为 agent 提供 skill 说明、项目 spec 与工作流约束

因此，需要把“AI 生成 skill 测试用例”从单点按钮，升级为聊天工作台中的一个专用模式，让用户通过多轮对话引导 agent 设计并批量生成测试草稿。

## 目标

1. 在聊天工作台新增一个面向 Skill Tests 的专用模式，用于交互式设计和生成测试用例。
2. 让用户可以通过多轮对话告诉 AI：目标 skill、已有测试、优先路径、边界条件、非目标范围、回归来源等。
3. 复用多 agent 协作能力，至少覆盖：规格拆解、漏测挖掘、边界/反例补洞、草稿整理输出。
4. 在正式生成测试草稿前，先产出可确认的测试矩阵或测试计划，避免一次性生成大量低价值 case。
5. 将确认后的结果批量写入现有 `skill_test_cases` 流程，且默认仍保持 `draft` 状态，不自动运行。

## 非目标

- 不在本任务中重写现有 Skill Tests 运行与评估引擎
- 不移除现有 `skill-test` 页面中的手动创建、编辑、运行能力
- 不把聊天工作台改造成完全自由的“任意测试生成器”
- 不在本阶段追求所有测试资产都必须从聊天工作台创建
- 不在本阶段自动执行生成后的 case；运行仍由用户显式触发

## MVP 范围

### In Scope

- 聊天工作台新增“Skill Test 生成/设计”模式入口
- 模式级上下文装配：目标 skill、相关 `SKILL.md` / `TESTING.md`、已有测试草稿/历史、必要 spec 文档
- 模式级 agent 指令：优先先追问和形成测试矩阵，而不是立刻输出测试代码或 case JSON
- 轻量状态机：
  - `收集上下文`
  - `形成测试矩阵`
  - `确认范围`
  - `生成草稿`
  - `导出结果`
- 多 agent 协作分工的最小版本（例如：规划 / critic / scribe）
- 将确认后的测试草稿批量落到现有 `skill_test_cases`，并保留来源信息
- 对话内能查看生成摘要、导出结果、失败原因
- `Phase 1` 至少稳定支持 `dynamic + trigger` 类型测试草稿的规划、生成与导出；`full + execution` 可进入实现探索，但不是首版阻塞项

### Out of Scope

- 自动根据聊天结果立即跑 smoke run 或 run-all
- 复杂的可视化流程编排器或 DSL 编辑器
- 在一次对话里同时为多个 skill 做跨 skill 统一规划
- 把历史 skill-test 页面完全合并到聊天工作台
- 基于外部文件或长日志的一键回归导入（可作为后续增强）

## 用户流程（MVP）

1. 用户在聊天工作台选择 `Skill Test` 模式，并指定目标 `skill`。
2. 系统为该模式装配专用上下文：
   - skill 描述与 `SKILL.md`
   - 目标 skill 已声明的环境依赖契约（优先读取 `TESTING.md` 中有效的 `Prerequisites` / `Bootstrap` / `Setup` / `Teardown` / `Verification`，不存在或内容不足时再读取 `SKILL.md` 或稳定关联 spec 中可复用的 setup 约定；仍无法定位时标记为缺失）
   - 相关 spec（skill testing / runtime / UI 等）
   - 当前 skill 已有测试用例与最近运行摘要（如可用）
3. agent 首轮优先追问：
   - 想优先覆盖哪些主路径/异常路径/回归问题
   - 是否有 mock / 环境 / 隔离限制
   - 是否只想产出测试计划，还是直接落草稿
   - 如目标 skill 未声明环境依赖契约，显式标记缺口，并把聊天中补充的安装/初始化信息视为待确认输入，而非默认既有定义
4. 多 agent 产出测试矩阵：场景、优先级、关键断言、风险点、是否建议纳入 MVP。
5. 用户确认或修订范围后，系统按确认矩阵批量生成结构化测试草稿。
6. 用户选择“导出”后，草稿写入 `skill_test_cases`，状态为 `draft`，并能回跳到 Skill Tests 工作区继续编辑/运行。

## 方案草图

### 1. 新模式而不是强化旧 `/generate`

优先将该能力实现为聊天工作台中的新模式，而不是继续在 `skill-test` 的单个 `/generate` 接口上堆更多参数。原因：
- 需要多轮对话与澄清
- 需要多 agent 协作
- 需要中间产物（测试矩阵）
- 需要用户确认后再导出，而不是立即生成并结束

### 2. 保持 Draft-First

聊天工作台导出的所有测试用例默认都应：
- 使用现有 canonical schema（尤其是 full mode case 字段）
- 写入现有 `skill_test_cases`
- 初始状态为 `draft`
- 不自动触发运行

### 3. 模式内状态机要轻，不要完全自由漂移

MVP 不做复杂工作流引擎，但需要最小状态约束，避免讨论发散：
- `收集上下文`：读取 skill、已有 case、补充用户目标
- `形成测试矩阵`：列出候选场景、边界、优先级
- `确认范围`：用户删改和确认
- `生成草稿`：输出结构化 case 草稿
- `导出结果`：落库或回写

### 4. 多 agent 角色建议

MVP 可先固定一组默认分工：
- `planner`：整理用户目标、维护阶段推进
- `critic`：补充边界场景、反例、漏测点
- `scribe`：把确认后的结果整理为可导出的 case 草稿

后续如有需要，再开放角色可配置化。

## 结构化对象与门禁约束

### 1. 测试矩阵最小结构
测试矩阵是聊天工作台模式中的中间规划对象，用于承接“先追问、再规划、后生成”的流程。它不是新的测试存储格式，也不替代现有 `skill_test_cases` canonical schema。

建议矩阵至少包含以下字段：
- `matrixId`：本次规划结果的唯一标识，用于确认、生成和导出门禁
- `skillId`：当前目标 skill
- `phase`：当前阶段，对应 `收集上下文`、`形成测试矩阵`、`确认范围`、`生成草稿`、`导出结果`
- `rows[]`：候选测试场景列表，每行至少包含：
  - `rowId`
  - `scenario`：场景描述
  - `priority`：`P0 | P1 | P2`
  - `coverageReason`：纳入该场景的覆盖理由
  - `testType`：`trigger | execution`
  - `loadingMode`：`dynamic | full`
  - `environmentContractRef`：可选，指向目标 skill 内的环境依赖契约位置；格式采用相对 skill 根目录的 `<relative-path>#<heading-or-contract-id>`，例如 `TESTING.md#Bootstrap`
  - `environmentSource`：`skill_contract | user_supplied | missing`，表示环境信息来自 skill 内契约、用户临时补充或仍缺失；后续子任务复用该字段时以本 PRD 定义为准
  - `riskPoints[]`：关键风险点、边界点、反例点
  - `keyAssertions[]`：关键断言或预期行为摘要
  - `includeInMvp`：是否建议纳入当前导出范围
  - `draftingHints`：可选，供后续草稿生成使用的补充提示

### 2. 环境依赖与 setup 契约
- 被评测 skill 应显式提供可复用的环境依赖契约，优先落在目标 skill 目录下的 `TESTING.md`；`TESTING.md` 至少应包含 `Prerequisites`、`Bootstrap` / `Setup`、`Teardown`、`Verification` 中一类有实际内容的段落，才可视为有效契约。
- 若 `TESTING.md` 不存在或没有可执行 / 可验证的 setup 内容，系统应按顺序回退到 `SKILL.md`、稳定关联 spec；仍无法定位时将 `environmentSource` 标记为 `missing`，而不是从聊天记录或常识推断。
- 聊天工作台在 `收集上下文`、`形成测试矩阵`、`生成草稿` 阶段，必须优先引用 skill 内已有契约；只有在契约缺失或用户明确补充临时环境时，才允许把聊天内容作为补充输入。
- 若用户在聊天中补充环境安装 / 初始化信息，应标记为 `user_supplied` 和待确认补充；系统可在导出摘要中提示“建议沉淀到 `TESTING.md` / spec”，但不得在未实际回写前把它视为 `skill_contract`。
- 测试矩阵与导出 metadata 至少应保留 `environmentContractRef` 与 `environmentSource` 这类环境来源字段，用于区分 `skill_contract`、`user_supplied`、`missing`。
- 未声明的安装步骤、外部依赖、凭据需求、sandbox 限制不得由 agent 臆造；对 `testType = execution` 或明确依赖外部环境 / 凭据 / sandbox 的 row，若 `environmentSource = missing`，正式生成 / 导出必须 fail closed；纯 trigger 规划可降级为警告，但仍需保留缺口状态。

### 3. 测试矩阵到 canonical case 的映射原则
- 每个已确认的 `matrix row` 都必须能映射到一个或多个现有 `skill_test_cases` 草稿
- `dynamic + trigger` 行至少要能映射到现有 canonical 字段：`skill_id`、`test_type`、`loading_mode`、`trigger_prompt`、`expected_tools_json`、`expected_behavior`
- `full + execution` 行如纳入实现范围，则在不破坏现有 schema 的前提下补充映射到 `expected_goal`、`expected_steps_json`、`evaluation_rubric_json` 等 full mode 字段
- 测试矩阵中的字段是“规划输入”，最终导出结果必须落回现有 canonical schema，不新增割裂 run/evaluation 链路的临时 case 格式
- 环境、隔离、mock 等信息应优先从目标 skill 已声明的环境契约读取；若 skill 与对话均未明确，不应由 agent 臆造；可在草稿中留空或保留待补状态，由用户后续补充
- 所有导出结果默认 `case_status = draft`，且不会自动运行

### 4. 生成与导出门禁
- 会话阶段必须显式持久化，并在 prompt、工具调用、UI 状态和服务端校验中保持一致
- 在 `确认范围` 完成前，agent 的目标是追问、整理和输出测试矩阵，而不是直接导出正式 case 草稿
- 正式生成草稿或导出时，必须至少关联：`conversationId`、`messageId`、`matrixId` 以及一个可验证的确认状态
- 若当前没有已确认的测试矩阵，则生成草稿和导出操作必须 fail closed，并返回结构化错误，而不是隐式降级为直接生成
- 正式生成或导出时，如果 row 的 `environmentSource = missing` 且该 row 是 execution 类型或明确依赖真实外部环境，必须 fail closed；如果只是 trigger 规划，可以降级为警告但必须保留缺口 metadata
- 即使 agent 在聊天文本中提前给出草稿示例，也不应视为正式导出结果；只有通过门禁校验的生成/导出链路才会写入 `skill_test_cases`

### 5. 来源审计与重复提示
- 聊天模式导出的测试草稿必须保留来源审计信息，至少包含：`conversationId`、`messageId`、`matrixId`、`agentRole`、`exportedBy`、`exportedAt`
- 来源信息应通过统一 metadata/source 落点持久化，避免前端、后端、运行时分别维护不一致的来源字段语义
- 导出前应进行轻量重复提示；MVP 可按 `skillId + loadingMode + testType + normalizedTriggerPrompt` 做粗粒度相似性判断
- 重复提示默认不阻塞导出，但应在聊天内明确提示用户该草稿可能与现有 case 重复或高度相似

## 可能改动的层

### 前端
- 聊天工作台模式入口、上下文面板、阶段提示、导出交互
- Skill Tests 工作区可能需要补一条“从聊天模式打开/回跳”的入口联动

### 后端 / Runtime
- 新模式定义及 conversation bootstrap
- 模式到 prompt/runtime 的上下文注入
- 多 agent 协作的模式专用指令
- 对话结果到 `skill_test_cases` 的导出接口/工具

### Skill Test 领域
- 复用现有 case schema、draft-first 持久化与生成元数据结构
- 为“聊天生成来源”补充来源字段或 metadata（如 conversationId / messageId / exportedBy）

## 技术约束与设计要求

1. **复用现有 Skill Tests schema**
   - Dynamic / Full case 仍使用已有 canonical schema
   - 不新增与现有 run/evaluation 链路割裂的临时格式

2. **导出链路必须可审计**
   - 至少能追踪导出来自哪个 conversation / message / agent 轮次
   - 失败时返回结构化原因，便于在聊天里继续修正

3. **上下文装配要有边界**
   - 只注入当前 skill 及必要 spec，避免模式 prompt 无限制膨胀
   - 既要支持动态 skill 读取，也要控制读取范围和来源

4. **保持跨层一致性**
   - 模式入口、后端 bootstrap、prompt 指令、导出 API、Skill Tests UI 之间的字段和状态语义必须一致

5. **环境准备知识尽量内聚在 skill 内**
   - 依赖安装、初始化、验证、清理等知识优先沉淀在被评测 skill 自身（优先 `TESTING.md`）；聊天工作台与测试 case 负责引用、确认和映射，不负责长期承载安装知识本体

## 验收标准

- [ ] 聊天工作台可创建一个 `Skill Test` 专用模式会话
- [ ] 进入该模式后，agent 会先围绕目标 skill 与测试目标进行追问，而不是直接生成 case
- [ ] agent 能产出一份结构化测试矩阵，至少包含场景、优先级、覆盖理由
- [ ] 用户确认矩阵后，系统可批量生成并导出测试草稿到现有 `skill_test_cases`
- [ ] 测试矩阵是结构化对象，至少包含 `scenario`、`priority`、`coverageReason`、`testType`、`loadingMode`
- [ ] 用户未确认测试矩阵前，系统不能正式生成或导出测试草稿；缺少确认状态时会返回明确错误
- [ ] 导出的 case 默认为 `draft`，不会自动运行
- [ ] 导出的测试草稿带有可审计的来源信息，至少可追踪到 `conversation / message / matrix`
- [ ] 若目标 skill 已声明环境依赖契约（如 `TESTING.md` 中的 `Prerequisites` / `Bootstrap` / `Verification`），聊天工作台会在测试矩阵与导出阶段优先引用这些定义
- [ ] 若目标 skill 按 `TESTING.md` → `SKILL.md` → 关联 spec 回退后仍未声明环境依赖契约，agent 会显式报告缺口，并把聊天补充标记为待确认输入，而不是自行编造安装步骤
- [ ] 导出 metadata 至少能区分“引用 skill 内环境契约”与“用户临时补充环境信息”，且 `user_supplied` 信息不会在未回写前被当作 `skill_contract`
- [ ] 对 execution 或明确依赖真实外部环境的 row，`environmentSource = missing` 会阻止正式生成 / 导出；trigger-only 规划可降级为警告
- [ ] 系统会对明显重复的候选草稿给出提示，且不影响现有 Skill Tests 页面继续编辑这些聊天生成草稿
- [ ] 生成失败、导出失败、schema 不合法、来源缺失时，聊天中能看到明确错误并继续修正
- [ ] 现有 Skill Tests 页面功能保持可用，且能继续编辑/运行这些聊天生成的草稿

## 初步实施分阶段

### Phase 1：模式与导出链路打通
- 新增模式入口
- 搭建模式 prompt / context
- 最小可用导出接口
- 使用固定多 agent（`planner / critic / scribe`）先跑通闭环，不开放角色自定义

### Phase 2：测试矩阵与多 agent 协作增强
- 引入阶段提示与矩阵确认
- 优化 planner / critic / scribe 分工
- 补来源追踪与回跳体验

### Phase 3：质量与回归闭环
- 增强对已有 case / 最近 run 的引用
- 完善导出校验、失败修复与回归对比入口
- 视效果评估是否逐步弱化旧的单点 `/generate` 入口

## 待确认问题

1. MVP 的入口应放在现有聊天工作台模式选择里，还是 Skill Tests 页面里“打开聊天设计模式”？
2. 是否在后续版本增加“导出为 draft bundle 再导入”的中间态，而非 MVP 必选项？
3. 固定多 agent 阵容是否需要按 skill 类型做轻量角色覆写？
4. 是否需要在第一版就支持“基于真实运行日志/聊天转录生成回归 case”？
