# PRD: 04-21-skill-test-lifecycle-chain-planning

## Goal
- 让 `skill_test_design` 的测试矩阵能够表达“生命周期测试链”，用于描述多个 case 之间的顺序依赖、环境继承意图与链式覆盖范围。
- 保持现有 `skill_test_cases` canonical schema 与 `draft-first` 约定不变；链信息先作为规划/导出 metadata 存在，而不是直接改 runner。
- 为环境依赖重、状态会累积的 skill 提供可追踪的链式规划出口，同时避免过早锁死执行层语义。

## Problem Statement
- 当前聊天工作台更擅长输出彼此独立的测试场景；对“初始化 → 配置 → 执行 → 验证 → 清理”这类有状态 skill，会把强依赖步骤拆成一组松散 case。
- 这会让 planner/critic 难以表达“后一步依赖前一步产物或环境”的真实测试需求，也让用户难以确认哪些 case 本来属于同一条生命周期链。
- 如果现在直接改 runner 去共享会话、沙箱或外部状态，会同时牵动 isolation contract、失败恢复、checkpoint、审计与清理策略，风险过高。

## Scope
- In scope:
- 扩展测试矩阵结构，使其可表示 `single` 与 `chain_step` 两类场景。
- 定义链字段及门禁：`chainId`、`chainName`、`sequenceIndex`、`dependsOnRowIds`、`inheritance`、必要时的链级说明字段。
- 定义从测试矩阵到现有 `skill_test_cases` draft 的映射：每个 row 仍导出为独立 draft case，链信息统一写入 `skill_test_cases.source_metadata_json`。
- 约束 helper skill 在追问阶段主动识别“是否需要生命周期链”，在矩阵阶段输出明确的链结构，而不是在聊天正文里即兴拼接长 JSON。
- 让前后端在导入/确认/导出链路上保留链信息，并对非法链结构返回结构化错误。
- Out of scope:
- 修改现有 runner 去共享沙箱、共享 conversation 或自动继承外部状态。
- 新增链级运行器、链级评分器、链级回归对比视图。
- 把链信息写成新的临时 case schema，割裂现有 `skill_test_cases` / run / evaluation 流程。
- 自动推断未声明的环境继承、artifact 继承或 teardown 策略。

## Requirements
- 链能力必须停留在规划/导出层；导出的每一步仍是 `case_status = draft` 的 canonical case。
- 链信息统一持久化到 `skill_test_cases.source_metadata_json`；不得新增割裂现有 run/evaluation 链路的临时 case schema。
- `inheritance` 必须显式声明，未声明时默认不继承，不能由 agent 自行脑补外部状态。
- Phase 1 的 `inheritance` 只是声明式意图，不代表 runner 会实际共享 sandbox、conversation、artifact 或外部状态。
- 生命周期链若涉及环境安装、初始化、验证或清理步骤，必须优先引用被评测 skill 内已声明的环境依赖契约（优先 `TESTING.md`，必要时回退到 `SKILL.md` 或稳定关联 spec）；链规划只负责表达“谁依赖谁、谁先谁后”，不负责把安装知识临时发明进 row 文本。
- `inheritance` 只表示环境/产物/状态的继承意图，不替代依赖安装定义；安装步骤来源必须可追溯到 `skill_contract` 或用户明确补充。
- 若 skill 未提供环境契约，则链式 row 只能显式标记为 `environmentSource = missing` 或 `user_supplied`，并要求用户确认；若用户未补充且链步骤需要真实环境准备，应阻止该链整组进入导出；不得默认视为可继承环境。
- `dependsOnRowIds` 必须通过拓扑校验，不能出现循环依赖、跨链依赖或与 `sequenceIndex` 冲突的顺序。
- `scenarioKind = chain_step` 时，缺少 `chainId`、缺少 `sequenceIndex`、依赖不存在、依赖跨链或依赖成环都必须 fail closed，不允许静默降级。
- 只有未声明为链式 step、且 canonical case 必填字段完整的 row，才允许按 `single` case 导出。
- 在 `确认范围` 阶段，UI / agent 应对成环、断链、删除中间 step、跨链依赖等问题给出可见提示，并阻止进入 `生成草稿`；后端 confirm/export 必须执行权威校验，并以后端结构化错误为准。
- UI 至少能提示“这些 draft 属于同一条建议测试链”，并明确“当前仅作规划展示，运行仍为独立 case”，避免用户误以为 Phase 1 runner 已支持共享执行。
- 来源审计继续保留 `conversationId`、`messageId`、`matrixId`，并补充链级 metadata，确保后续 runner 改造时可追溯。

## Acceptance Criteria
- [x] 测试矩阵 schema 能表示链式 step，并区分单 case 与链式 case。
- [x] helper skill 会主动追问 skill 是否存在生命周期链或状态依赖。
- [x] 已确认的链式矩阵 row 可导出为现有 `skill_test_cases` draft，且 metadata 中保留链信息。
- [x] 链式 row 若涉及环境准备，矩阵与导出 metadata 能明确标识引用了哪个 skill 内环境契约，或明确标记契约缺失 / 用户补充；缺失且未确认时会阻止整链导出。
- [x] agent 不会把未沉淀到 skill 的安装步骤偷偷塞进 `inheritance` 语义里。
- [x] 非法链结构（如成环、顺序冲突、跨链依赖、删除中间 step 后断链）会在确认范围或导出前被结构化拦截。
- [x] 现有单 case 规划、确认、导出与运行流程不受破坏。
- [x] spec 至少补充“链只属于规划/导出层，不代表 runner 已支持共享环境执行”的约束。

## Proposed Cut
### Matrix Shape
- 为 `rows[]` 新增可选字段：
  - `scenarioKind: single | chain_step`
  - `chainId`
  - `chainName`
  - `sequenceIndex`
  - `dependsOnRowIds[]`
  - `inheritance[]`，候选值先限制在 `filesystem | artifacts | conversation | externalState`
  - `environmentContractRef`，采用主 PRD 定义的 `<relative-path>#<heading-or-contract-id>` 格式
  - `environmentSource: skill_contract | user_supplied | missing`，语义以主 PRD 的环境来源定义为准
- `chainId` 只要求在同一个 `matrixId` 内唯一；导出时服务端可标准化为持久化用的链组标识，避免跨会话或多轮生成撞名。
- `inheritance[]` 候选值含义：
  - `filesystem`：计划复用前序步骤产生的文件或沙箱路径
  - `artifacts`：计划复用前序步骤导出的产物、报告或结构化输出
  - `conversation`：计划复用同一测试链的会话上下文或历史消息摘要；Phase 1 不代表 runner 会自动共享 conversation
  - `externalState`：计划复用外部系统、服务或应用状态；必须配套显式 reset / teardown 契约或标记缺失
- 保持现有 `scenario`、`priority`、`coverageReason`、`testType`、`loadingMode`、`riskPoints[]`、`keyAssertions[]` 不变。
- `inheritance` 不能替代环境依赖契约；如果链步骤需要安装或初始化信息，必须通过 `environmentContractRef` 或 `environmentSource` 明确来源。
- 上述链字段只描述规划关系；Phase 1 不承诺 runner 会执行任何继承行为。

### Export Mapping
- 每个确认后的 row 仍映射成一条 canonical draft case。
- 链字段统一写入 `skill_test_cases.source_metadata_json`，而不是扩展 `skill_test_cases` 的核心 canonical 列。
- 同一链的多个 draft 使用共享链组标识与明确的 `sequenceIndex`，供 UI 与后续 runner 读取。
- `source_metadata_json.skillTestDesign.chainPlanning` 至少保留规划期字段：`matrixId`、`rowId`、`scenarioKind`、`chainId`、`chainName`、`sequenceIndex`、`dependsOnRowIds`、`inheritance`。
- 导出完成后，服务端应补充 draft 级解析结果：`exportChainId`、`dependsOnCaseIds`、`exportedCaseId`；其中 `dependsOnCaseIds` 由同批导出的 `dependsOnRowIds` 映射而来。
- 若 `dependsOnRowIds` 无法解析为同批导出的 case id，后端必须返回结构化错误并阻止导出。
- 如果用户在确认阶段删除或排除中间 row，系统必须重新计算依赖或显式提示断链，不能等到导出后才静默丢弃依赖。

### Deferred Execution Work
- runner 后续再决定：
  - 同一 conversation 连续运行，还是每步新 conversation + artifact 注入。
  - 是否共享沙箱目录，还是通过快照/产物恢复实现链式续跑。
  - 失败策略采用 `stop_on_failure`、`skip_dependents` 还是可配置策略。
- 如果这些执行语义需要落地，应另开后续子任务，而不是在本任务里顺手实现。

## Validation
- `npm run check`
- `npm run build`
- `node --test --test-name-pattern="skill test design" tests/skill-test/skill-test-e2e.test.js`
- 如新增前端链提示，补跑相关聊天工作台或 skill test UI 的 targeted tests

## Notes
- 这是 `04-21-skill-test-chat-workbench-mode` 的子任务，目标是先让聊天工作台与 draft 导出链路“看得懂链”，而不是立刻“跑得动链”。
- helper skill 应在追问阶段主动询问 skill 是否存在生命周期、状态累积、前置配置、产物复用或清理步骤，并把用户确认后的结果写入矩阵链字段。
- 如果在实现过程中发现必须先改 runner 才能继续，应停止扩 scope，并再拆一条专门的执行层任务。
