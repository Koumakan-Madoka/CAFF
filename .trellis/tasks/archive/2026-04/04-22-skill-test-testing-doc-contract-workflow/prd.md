# PRD: 04-22-skill-test-testing-doc-contract-workflow

## Goal
- 在 Skill Test 聊天工作台中补一条显式工作流：当目标 skill 缺少可复用环境契约时，允许模型基于已有材料起草 `TESTING.md`，由用户确认后再写入 skill 目录。
- 让重环境依赖 skill 从 `environmentSource = missing / user_supplied` 安全升级为可引用的 `skill_contract`，避免 execution 类测试长期卡在缺契约门禁。
- 保持“模型整理、用户背书”的边界：模型不能臆造安装、凭据、外部服务、sandbox 权限或清理步骤。

## Problem Statement
- 当前聊天工作台已经会按 `TESTING.md -> SKILL.md -> stable spec` 查找环境契约；找不到时会把矩阵 row 标记为 `environmentSource = missing`，并对 execution / 真实外部环境依赖 fail closed。
- 但当用户愿意补充环境信息时，目前只能把聊天内容临时视为 `user_supplied`，没有正式的“生成草稿、确认、写回、刷新矩阵”产品闭环。
- 对环境较重的 skill，缺少 `TESTING.md` 会导致测试矩阵能规划、但 execution 草稿无法安全生成 / 导出，用户需要手动切出聊天去创建文档，流程割裂。

## Scope
- In scope:
  - 在 Skill Test 聊天模式中新增“环境契约缺口”分支：检测缺口、显式起草 `TESTING.md`、用户确认、固定路径写入、刷新上下文。
  - 支持结构化 `TESTING.md` 草稿预览，至少包含 `Prerequisites`、`Setup` / `Bootstrap`、`Verification`、`Teardown`、`Open Questions`。
  - `sections[].sourceKind` 仅允许 `skill_md | stable_spec | user_supplied | missing` 四种闭合枚举，作为草稿期溯源标签；它不扩展现有 `environmentSource = skill_contract | user_supplied | missing` 的 canonical 语义。
  - 只有用户显式选择“起草 TESTING.md”或等价确认动作后，系统才调用 preview；发现缺口时只提示，不自动塞入草稿卡片。
  - 用户确认后仅允许写入目标 skill 根目录下的 `TESTING.md`；MVP 对已有文件先提供完整覆盖预览和显式风险提示，不允许静默覆盖。
  - 写入成功后触发环境契约上下文刷新，并要求用户重新生成或重新确认受影响矩阵 rows。
  - 在导出摘要或矩阵提示中明确区分 `user_supplied` 与已写回后可被重新解析为 `skill_contract` 的契约。
- Out of scope:
  - 自动执行生成后的测试 case 或 smoke run。
  - 自动验证外部服务、凭据、GUI 应用、计划任务等真实环境是否可用。
  - 让模型在用户未确认的情况下修改任意 skill 文件。
  - 把聊天里临时补充的信息自动视为长期契约。
  - 设计 section 级 merge/patch 编辑器；MVP 只需要预览、确认、固定路径写入，已有文件先走完整覆盖预览。

## User Flow
1. 用户选择 Skill Test 模式并指定目标 skill。
2. 系统查找 `TESTING.md -> SKILL.md -> stable spec` 后发现环境契约缺失或不足。
3. 聊天工作台显示缺口摘要，并询问用户是否要起草 `TESTING.md`；如果用户只想继续 trigger-only 规划，可跳过此分支。
4. 用户补充必要的安装、初始化、验证、清理信息；模型只能整理已有材料和用户输入。
5. 用户显式请求起草后，系统生成结构化 `TESTING.md` 草稿卡片，展示各段来源、缺口和待确认项。
6. 用户选择：
   - 接受并写入 `TESTING.md`
   - 继续编辑 / 追加信息
   - 暂不写入，继续以 `user_supplied` 或 `missing` 状态规划
7. 若目标 skill 已存在 `TESTING.md`，系统展示完整覆盖预览和显式风险提示；用户确认前不得写入。
8. 写入成功后，系统刷新 skill 环境契约上下文，并提示重新生成或重新确认矩阵。
9. 后续 execution rows 若能引用新 `TESTING.md#...` 契约，可在重新确认后从 `missing / user_supplied` 转为 `skill_contract`。

## Requirements
- `TESTING.md` 草稿必须是正式工具 / API 产物，而不是普通聊天文本；只有通过确认动作写入后才算 `skill_contract`。
- 每个草稿段落必须带来源元数据；`sections[].sourceKind` 是草稿期展示 / 审计标签，且仅允许 `skill_md | stable_spec | user_supplied | missing`。
- 用户聊天补充在写入前仍是 `user_supplied`，不得自动升级；写入后也必须经过重新读取契约和重新确认矩阵，才能在后续流程中体现为 `skill_contract`。
- 发现缺口时不得自动生成草稿卡片；必须由用户显式触发 `previewTestingDocDraft` 或等价动作。
- 模型不得生成未由 `SKILL.md`、stable spec 或用户明确输入支撑的安装命令、凭据、外部服务地址、sandbox 放权或 teardown 操作。
- 写文件必须 fail closed：路径固定为目标 skill 根目录的 `TESTING.md`，禁止绝对路径、目录穿越、符号链接逃逸和任意文件覆盖；skill root 解析应复用现有 skill registry。
- 若 `TESTING.md` 已存在，MVP 必须先返回完整覆盖预览和显式确认门禁；用户确认前不得覆盖。
- 若草稿生成后目标文件被外部修改，已有草稿应标记为 `superseded` 并要求重新预览 / 确认。
- 写入后必须重新读取目标 skill 的环境契约，更新聊天模式上下文；不得把旧矩阵里的 `environmentSource` 静默改成 `skill_contract`，需要重新确认受影响 rows。
- apply 动作必须保留来源审计：`conversationId`、`messageId`、`skillId`、`draftId`、`appliedBy`、`appliedAt`、`sourceKinds`。
- 若草稿仍包含影响 execution 的 `Open Questions`，或缺少 `Prerequisites` / `Setup` 这类关键 section，execution row 仍应按既有 fail-closed 规则处理；`Verification` / `Teardown` 缺失在 MVP 可先降级为显式警告。

## Proposed Design
### State / Artifact
- 新增模式内 artifact：`testingDocDraft`。
- 建议字段：
  - `draftId`
  - `skillId`
  - `targetPath: TESTING.md`
  - `status: proposed | needs_user_input | confirmed | applied | rejected | superseded`
  - `sections[]`: `heading`、`content`、`sourceKind`、`sourceRefs[]`、`openQuestions[]`
  - `audit`: `conversationId`、`messageId`、`agentRole`、`createdAt`

### Mapping Rules
- `sections[].sourceKind` 只用于草稿期溯源展示和 apply 审计，不改变现有 canonical `environmentSource` 枚举。
- 写入前，聊天补充仍按 `user_supplied` 处理；写入并重新刷新契约后，来自 `skill_md` 或 `stable_spec` 的整理结果才会通过新 `TESTING.md` 在后续矩阵 / 导出中收敛为 `skill_contract`。
- `missing` 来源不会因为草稿存在而自动消失；只有用户补足并重新写入后，后续流程才可重新评估。

### Backend Actions
- `previewTestingDocDraft`：根据已装配 skill context、用户补充和缺口摘要生成结构化草稿，不写盘；仅在用户显式请求时触发。
- `applyTestingDocDraft`：校验 draft、确认状态、目标路径和文件状态，执行固定路径写入；若文件已存在则基于确认过的完整覆盖预览执行 apply。
- `refreshSkillEnvironmentContract`：写入后重新读取 `TESTING.md`，输出可引用的 `environmentContractRef` 候选。
- `resolveSkillTestingDocTarget`：复用 `lib/skill-registry.ts` 的 skill root/path 解析能力，避免聊天模式自行拼路径。

### Prompt / Agent Behavior
- planner 负责判断是否进入“环境契约缺口”分支并追问必要信息。
- critic 负责指出草稿中可能缺失的验证、清理、隔离和凭据风险。
- scribe 负责把确认后的材料整理为 `TESTING.md` 草稿，不直接导出 execution cases。
- agent 必须明确说出哪些内容来自用户、哪些仍是缺口，不能把草稿文本伪装成既有 skill 契约。
- agent 在用户未明确要求起草前，只提示“可起草 TESTING.md”，不自动输出大段文档草稿。

### Frontend
- 在聊天面板显示 `TESTING.md` 草稿卡片：section 预览、来源标签、缺口列表、风险提示。
- 目标文件已存在时，卡片需展示“将覆盖现有 `TESTING.md`”的显式警告和覆盖预览。
- 提供“确认写入”“继续补充”“暂不写入”动作。
- 写入成功后显示回流提示：建议重新生成矩阵或重新确认受影响 rows。

## Acceptance Criteria
- [x] 当目标 skill 缺少有效 `TESTING.md` 且 execution row 被环境门禁阻塞时，聊天工作台能提示“可起草 TESTING.md”。
- [x] 缺口检测本身不会自动生成文档草稿；只有用户显式请求后，系统才会生成结构化 `TESTING.md` 草稿预览。
- [x] 系统能生成结构化 `TESTING.md` 草稿预览，至少覆盖环境准备、启动/初始化、验证、清理和开放问题。
- [x] 草稿段落能区分 `skill_md`、`stable_spec`、`user_supplied`、`missing` 来源，且这些值是闭合枚举。
- [x] 用户未确认前，不会写入文件，也不会把 `user_supplied` 当作 `skill_contract`。
- [x] 用户确认后，仅能写入目标 skill 根目录的 `TESTING.md`；已有文件时必须先展示完整覆盖预览并显式确认。
- [x] 写入后会刷新环境契约上下文，并要求重新生成或重新确认相关矩阵 rows。
- [x] 后续导出的 case metadata 能引用新 `TESTING.md#...`，并仅在重新确认后将来源标记为 `skill_contract`。
- [x] 如果草稿仍缺少 `Prerequisites` / `Setup` 等关键 execution 环境信息，或仍有影响 execution 的 `Open Questions`，导出仍会 fail closed，而不是因为存在 `TESTING.md` 文件就放行。
- [x] `Verification` / `Teardown` 缺失在 MVP 至少会给出显式警告，不会被静默吞掉。
- [x] apply / preview / refresh 失败时返回结构化错误，聊天中可继续修正。
- [x] 现有 Skill Tests 手动创建、编辑、运行功能不受影响。

## Validation
- 后端单测 / e2e：缺口检测、显式 preview 触发、固定路径写入门禁、已有文件覆盖预览、写入后刷新上下文、`superseded` 草稿处理。
- 导出链路回归：未确认草稿不解锁 execution；写入并重新确认后可引用 `skill_contract`。
- 前端检查：草稿卡片渲染、覆盖警告、确认写入动作、失败提示和刷新提示。
- 常规验证：`npm run build`、`npm run typecheck`、`npm run check`、相关 `node --test tests/skill-test/*`。

## Notes
- 这是 `04-21-skill-test-chat-workbench-mode` 的后续子任务，不阻塞当前 MVP 提交。
- 本任务只负责把环境契约写回流程产品化；真实外部环境是否可运行，仍应由用户或后续显式运行来验证。
- 本任务与现有 `server/domain/skill-test/environment-chain.ts` 的 `suggest-patch` 能力是互补关系：后者仍是 run-time 建议文本，这里负责聊天工作台内的结构化 preview / confirm / apply 闭环。
- 如果实现中发现需要真正的 section 级 merge/patch 审批框架，应先拆分基础能力，避免把任意文件写入能力塞进 Skill Test 模式。
