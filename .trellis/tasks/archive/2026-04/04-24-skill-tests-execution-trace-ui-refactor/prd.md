# PRD: 04-24-skill-tests-execution-trace-ui-refactor

## Goal
- 让 Skill Tests 的执行链与运行细节更容易阅读、定位和排错。
- 从前端彻底移除低价值的 `Publish Gate` 入口、状态残留和请求传参。
- 在不改变后端 runner / evaluation 语义的前提下，把 `public/skill-tests.js` 重构到更稳定的模块边界。

## Problem Statement
- 当前 Skill Tests 前端把 run settings、live trace、finalized trace、环境链、详情面板和回归对比分散堆在 `public/skill-tests.js` 中，演进成本高，改一处容易牵动多处。
- 执行链展示层级不清晰，用户在 live run 和 finalized run 之间看到的结构也不够一致，不利于快速判断当前卡在哪一步、证据是什么、最终结论是什么。
- `Publish Gate` 已经不再是有效前端能力，但仍保留在 UI、localStorage 和请求拼装里，增加界面噪音和维护成本。

## Scope
- In scope:
  - 删除 Skill Tests 前端中的 `Publish Gate` 可见入口、localStorage 残留和请求字段。
  - 基于现有归一化 trace 结果重做执行链展示层，让 live / finalized run 走同一条展示路径。
  - 让列表页中的链式用例拥有专用视觉形态：默认列表不强制分区，但链式 case 必须通过迷你轨道一眼可辨。
  - 让运行详情优先呈现 `Run -> Step -> 证据/断言 -> Verdict(or status)` 的稳定结构，并在详情头部补充链式轨道摘要。
  - 在展示边界稳定后，将 `public/skill-tests.js` 按 `api / state / trace / environment / detail` 等边界拆分。
  - 如相邻模式允许，补充或更新与 trace 渲染有关的前端测试。
- Out of scope:
  - 修改后端 chain runner、单 case runner、evaluation rubric 或 verdict 语义。
  - 重新定义 trace 数据模型；优先消费现有 `rebuildLiveRunTrace()` 的归一化输出。
  - 扩大到 Skill Tests 之外页面的整体视觉重做。

## User Flow
1. 用户打开 Skill Tests 页面，不再看到 `Publish Gate` 相关 UI。
2. 用户照常运行单条 case 或查看已有运行记录。
3. 在运行详情中，用户能按更清晰的层级查看 run summary、ordered steps、关键证据/断言，以及最终 `verdict`；若是 live run，先显示当前 `status` 占位，待 finalized 后再展示 verdict。
4. 现有列表、详情、回归对比等主流程保持可用。

## Requirements
- 前端不再渲染 `Publish Gate`，也不再持久化或发送 `publishGate` 字段。
- 刷新页面后，不会从旧 localStorage 状态中“复活” `Publish Gate`。
- live run 与 finalized run 的 trace 展示应共享同一套展示约定，而不是继续维护两套平行视图。
- 链式 case 的判定统一基于 `getSkillTestChainPlanningMeta(testCase)` 返回的 `exportChainId + sequenceIndex`，不再在列表层直接拼接零散字段。
- 默认列表继续保持单列表结构，但必须提供轻量筛选：`全部 / 链式 / 普通`。
- 链式 case 卡片必须拥有专用头部：显示链标识、step 位置和迷你轨道；长链要有折叠规则，避免把卡片挤成一团。
- 列表迷你轨道优先承担“形状识别”职责，不伪造跨 step 的整链 verdict；只有存在明确 step 状态时才做有限着色。
- 详情头部应补充完整链轨道摘要，优先做静态展示；复杂点击跳转可在后续拆模块后继续增强。
- 运行详情应先给出稳定的“运行摘要”区块，再展开工具时间线、环境链和评估明细，减少 live / finalized 之间的版式漂移。
- live run 在没有最终 verdict 时使用 `status` 作为明确占位，不伪造 `pass/fail`。
- finalized run 在可用时展示 `verdict`、必要维度摘要和失败上下文。
- 改造后不得破坏现有单条运行、批量运行、详情查看、回归对比和常用 run settings（除 `Publish Gate` 之外）的行为。
- 拆模块时应遵循 `ui-structure.md` 的前端结构约束，尽量抽离通用 helper，避免把混乱原样复制到多个文件。

## Acceptance Criteria
- [x] 页面中不再出现 `Publish Gate` 相关输入、标签或提示文案。
- [x] Skill Tests 前端请求 payload 不再携带 `publishGate`。
- [x] 刷新页面后，`Publish Gate` 不会通过 localStorage 恢复。
- [x] 列表页中的链式 case 拥有与普通 case 明显不同的专用头部，用户扫一眼即可识别链式用例。
- [x] 列表支持 `全部 / 链式 / 普通` 轻量筛选，且默认仍保持单列表结构。
- [x] 链式 case 的迷你轨道支持长链折叠，不会因为 step 过多导致卡片失真。
- [x] live / finalized run 的运行详情都能通过统一的 trace 展示路径呈现，且 live run 使用 `status` 占位、finalized run 展示最终 `verdict`。
- [x] 详情头部能展示链式轨道摘要，执行链视图能更清楚地区分 run summary、ordered steps、关键证据/断言和最终结论。
- [x] `public/skill-tests.js` 被收敛或拆分到 `public/skill-tests/` 下的聚焦模块中，同时保持现有主要流程可用。
- [x] 如项目已有相邻测试模式，相关 trace 渲染或 view-model 逻辑得到最小必要覆盖更新。

## Implementation Plan
### PR1 — Remove Publish Gate frontend residue
- 删除 `public/eval-cases.html` 中的 `Publish Gate` 可见入口。
- 清理 `public/skill-tests.js` 中对应的 DOM 引用、localStorage key、hint 文案、事件绑定与请求传参。
- 明确保持后端默认行为不变：前端 simply stop sending the field。

### PR2 — Rework execution trace presentation
- 保持默认列表结构不大搬家，但为链式 case 增加专用卡头：`Chain` 标识、step 位置、迷你轨道。
- 链式判定统一使用 `getSkillTestChainPlanningMeta()`；长链遵循折叠规则：短链全显，长链显示 `起点 -> … -> 当前/失败步 -> 终点`，无可靠状态时退化为 `起点 -> +N -> 终点`。
- 为列表补充 `全部 / 链式 / 普通` 轻量筛选，帮助用户快速只看链式用例。
- 详情头部补充完整链轨道摘要；首版先做静态展示，不在 PR2 强塞复杂点击交互。
- 以现有 `rebuildLiveRunTrace()` 的归一化结果为唯一 trace 输入约定。
- 先补一个共用“运行摘要”骨架，再重排 run detail 渲染结构，统一 live / finalized 的展示层。
- live run 显示 `status`，finalized run 再补 `verdict` 与必要摘要。

### PR3 — Split `public/skill-tests.js`
- 在 PR2 稳定的展示边界之上，按 `api / state / trace / environment / detail / main` 拆分文件。
- 优先抽出低耦合 helper 和渲染函数，再搬迁事件绑定与页面状态。
- 保持模块拆分是“稳定边界迁移”，而不是把现有混乱复制成多文件混乱。

## Risks / Notes
- 删除 `publishGate` 后，`runSettings` 的对象形状会变小；需要留意旧 localStorage 数据读取时的兼容行为。
- `public/skill-tests.js` 中部分 trace helper 可能隐式依赖顶层常量或通用转义函数，拆分前需要先抽公共层。
- 该任务与 `04-22-skill-test-lifecycle-chain-runner` 都会触碰 `public/skill-tests.js`，实现时要以“消费既有 trace / chain DTO，不改 runner 语义”为边界，避免 scope 漂移。
