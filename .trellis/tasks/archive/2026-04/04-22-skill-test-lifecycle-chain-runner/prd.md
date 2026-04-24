# PRD: 04-22-skill-test-lifecycle-chain-runner

## Goal
- 把已导出的 lifecycle-chain metadata 从“只会规划 / 导出”升级成“可显式按链运行”的最小 MVP。
- 支持同一 skill 下的 `full + execution` 草稿按线性顺序执行，并使用单次链级环境准备 / 验证 / 清理；默认 `stop_on_failure`，可显式选择目标达成阈值继续策略。
- 保持现有单 case run、evaluation、regression 语义可用；链运行是显式 opt-in，不替代普通单 case runner。

## Problem Statement
- 现有 `04-21-skill-test-lifecycle-chain-planning` 已经让聊天工作台和 draft export 能表达 `chainId / sequenceIndex / dependsOnRowIds / inheritance`，但这些字段目前仍停留在规划 metadata 层。
- 对“初始化 -> 配置 -> 执行 -> 验证 -> 清理”这类生命周期强依赖的 skill，逐条独立运行 case 会丢失共享环境、前序产物和故障停链语义，导致规划层说得出链，运行层却跑不出链。
- 如果没有显式 chain runner，系统就无法清楚定义：整链何时 bootstrap、失败后是否跳过后续、哪些上下文允许传递、如何清理共享环境、如何审计整链结果。

## Scope
- In scope:
  - 为已导出的链式 draft cases 提供显式“Run as chain”入口与后端执行链路。
  - 仅支持同一 skill、同一链组、线性顺序、`full + execution` 的最小 MVP。
  - 增加链级运行记录与 step 级链接，让整链结果和每步结果都可追踪。
  - 使用单次链级 preflight / bootstrap / verify / teardown 包裹整条链执行。
  - 受控传递前一步摘要、显式 artifact 引用和共享环境句柄；不把整段会话或任意外部状态直接塞给下一步。
  - 明确继续 / 停链策略：MVP 默认 `stop_on_failure`，并支持显式 `stop_on_failure_goal_threshold`，让链继续门禁与单步最终 verdict 分离。
- Out of scope:
  - DAG / 分支链、跨 skill 链、混合不同 loading mode / test type 的链。
  - 自动重试、从中间恢复、checkpoint / resume、并行链步执行。
  - 任意共享 conversation transcript、任意共享外部系统状态、自动推断未声明继承。
  - 替换现有单 case runner；单 case 运行入口与语义保持不变。

## User Flow
1. 用户在 Skill Tests 中看到一组带相同 lifecycle chain metadata 的 draft cases。
2. UI 显示“Run as chain”入口，并明确说明这是显式链运行，不等于普通逐条 run。
3. 用户触发链运行后，后端验证：同 skill、同链组、顺序连续、依赖闭合、环境来源可接受、inheritance 未超出 MVP 支持范围。
4. 系统执行一次链级 preflight / bootstrap / verify，建立共享环境句柄。
5. 系统按 `sequenceIndex` 顺序执行 step1 -> step2 -> step3；每一步可读取前一步摘要与显式 artifact 引用。
6. 默认策略下某一步失败时，当前链 run 标记 `failed`，后续依赖步骤标记 `skipped`，并保留失败原因和最后成功 step；若用户选择 goal-threshold 策略，非 pass 但目标达成度足够且无 critical constraint failure 的步骤可标记 `continued` 并放行下一步。
7. 无论成功或失败，系统都执行链级 teardown / cleanup，并把整链摘要与各 step run 结果持久化。

## Requirements
- 链运行必须是显式动作；不得因为 case 带有 `chainId` 就自动改变普通单 case run 语义。
- MVP 只允许运行 `source_metadata_json.skillTestDesign.chainPlanning` 已完整持久化的链式 cases；缺少 `exportChainId`、`sequenceIndex`、`dependsOnCaseIds` 的导出结果不得被链 runner 脑补修复。
- 同一条链内的 cases 必须满足：同 `skill_id`、同 `loading_mode = full`、同 `test_type = execution`、同 `exportChainId`。
- 链级校验必须 fail closed：顺序断裂、依赖丢失、跨链依赖、重复序号、缺失 step、混入 single case、混入不支持 inheritance 的 steps 都必须阻止运行。
- `environmentSource = missing` 的 steps 必须阻止整链运行；`user_supplied` 可在 MVP 放行，但 UI 和 run summary 必须显式提示该链依赖用户临时补充环境信息。
- MVP 的上下文传递只允许：`previousStepSummary`、显式 `artifactRefs[]`、`sharedEnvironmentHandle`；不得把完整聊天 transcript、自由文本长历史或未声明的外部状态透传给下一步。
- `inheritance` 在 runner MVP 中只支持与 `artifactRefs` / 共享文件系统句柄直接对应的安全子集；若 step 声明 `conversation` 或 `externalState`，必须结构化拒绝，而不是静默忽略。
- 链运行必须创建链级审计实体，并把每一步 run 关联回该链；整链状态至少包含 `running | passed | failed | aborted | partial` 之一；step 审计状态可额外使用 `continued` 表示“该步最终 verdict 非 pass，但链继续门禁已放行”。
- 整链 bootstrap / teardown 失败也必须写审计；不能因为某步尚未运行就没有链级记录。
- 现有 Skill Tests 页面必须能区分“普通 case run”和“chain run step”，并能看到哪一步失败、哪几步被跳过，以及哪一步因 goal-threshold 策略被继续。

## Proposed Design
### Execution Contract
- 复用现有导出 metadata 作为链资格来源：`source_metadata_json.skillTestDesign.chainPlanning.exportChainId`、`sequenceIndex`、`dependsOnCaseIds[]`。
- 运行前先把候选 cases 解析为一条线性链；若解析结果不是严格单链，则拒绝启动。
- MVP 执行策略：
  - `sharedEnvironmentPolicy = single_chain_environment`
  - `stopPolicy = stop_on_failure` 为默认 strict 策略：只有 step run verdict/pass 语义通过才继续。
  - `stopPolicy = stop_on_failure_goal_threshold` 为显式宽松策略：当 step 执行状态为 `succeeded`、无 `critical-constraint` hard fail、且 `goalAchievement >= 0.8` 时允许继续；该 step 审计状态写为 `continued`，原始 `skill_test_runs.verdict` 仍保留 `borderline | fail | pass` 不被改写。
  - `carryForward = previous_step_summary + explicit_artifact_refs`

### Runtime Orchestration
- 新增 chain runner 服务，职责为：
  - 创建链级 run 记录。
  - 触发一次链级 preflight / bootstrap / verify。
  - 逐步调用现有 execution run 能力，并注入受控 chain context。
  - 在失败时标记后续依赖 step 为 `skipped`。
  - 统一执行 teardown / cleanup，并收口整链状态。
- 如需共享环境，应通过显式的 `sharedEnvironmentHandle` 或等价受控句柄表达，而不是通过“沿用上一次 case 的全部内部状态”这种隐式方式实现。

### Persistence / Audit
- 最小数据模型建议新增两张表，而不是把链状态全部硬塞进现有 `skill_test_runs`：
  - `skill_test_chain_runs`
    - `id TEXT PRIMARY KEY`
    - `skill_id TEXT NOT NULL`
    - `export_chain_id TEXT NOT NULL`
    - `status TEXT NOT NULL DEFAULT 'pending'`（`pending | running | passed | failed | aborted | partial`）
    - `stop_policy TEXT NOT NULL DEFAULT 'stop_on_failure'`
    - `shared_environment_policy TEXT NOT NULL DEFAULT 'single_chain_environment'`
    - `bootstrap_status TEXT NOT NULL DEFAULT 'pending'`
    - `teardown_status TEXT NOT NULL DEFAULT 'pending'`
    - `warning_flags_json TEXT NOT NULL DEFAULT '[]'`
    - `error_code TEXT NOT NULL DEFAULT ''`
    - `error_message TEXT NOT NULL DEFAULT ''`
    - `last_completed_step_index INTEGER NOT NULL DEFAULT 0`
    - `started_at TEXT NOT NULL DEFAULT ''`
    - `finished_at TEXT NOT NULL DEFAULT ''`
    - `created_at TEXT NOT NULL`
    - `updated_at TEXT NOT NULL`
  - `skill_test_chain_run_steps`
    - `id TEXT PRIMARY KEY`
    - `chain_run_id TEXT NOT NULL`
    - `test_case_id TEXT NOT NULL`
    - `sequence_index INTEGER NOT NULL`
    - `depends_on_step_ids_json TEXT NOT NULL DEFAULT '[]'`
    - `status TEXT NOT NULL DEFAULT 'pending'`（`pending | running | passed | failed | skipped | aborted`）
    - `skill_test_run_id TEXT NOT NULL DEFAULT ''`
    - `carry_forward_json TEXT NOT NULL DEFAULT '{}'`
    - `artifact_refs_json TEXT NOT NULL DEFAULT '[]'`
    - `error_code TEXT NOT NULL DEFAULT ''`
    - `error_message TEXT NOT NULL DEFAULT ''`
    - `started_at TEXT NOT NULL DEFAULT ''`
    - `finished_at TEXT NOT NULL DEFAULT ''`
    - `created_at TEXT NOT NULL`
    - `updated_at TEXT NOT NULL`
- 索引草案：
  - `idx_skill_test_chain_runs_skill_chain(skill_id, export_chain_id, created_at DESC)`
  - `idx_skill_test_chain_run_steps_chain(chain_run_id, sequence_index)`
  - `idx_skill_test_chain_run_steps_case(test_case_id, created_at DESC)`
- 只有真正执行过的 step 才写现有 `skill_test_runs` / `eval_case_runs`；`skill_test_chain_run_steps.skill_test_run_id` 回链到具体 run。被 `stop_on_failure` 跳过的 steps 只写 step audit，不强行制造伪 run 记录。

### API / UI
- 最小 API 草案建议显式引入 `test-chains` 资源，避免把链级运行塞进单 case run 语义：
  - `POST /api/skills/:skillId/test-chains/run`
    - request: `exportChainId`、可选 `caseIds[]`、可选 `stopPolicy = stop_on_failure | stop_on_failure_goal_threshold`，以及与现有单次运行兼容的 `provider` / `model` / `promptVersion` / `agentId` / `agentName` / `isolation` / `environment`
    - behavior: 校验链成员、拓扑、environment gate、unsupported inheritance，创建 `skill_test_chain_runs` + `skill_test_chain_run_steps` 后启动整链
    - response: `chainRun`、`steps[]`、`warnings[]`、`issues[]`、可选 `pollUrl`
  - `GET /api/skills/:skillId/test-chains/:chainRunId`
    - response: `chainRun`、`steps[]`、可选 `latestTrace`
  - `GET /api/skills/:skillId/test-chains/by-export/:exportChainId/runs?limit=20`
    - response: `runs[]`，供 Skill Tests 列表 / 详情展示最近链运行历史
- 最小 response DTO 草案：
  - `POST /run` 与 `GET /:chainRunId` 尽量返回同形结构，前端可以复用同一个 chain-run 详情组件。
  - `chainRun` 至少包含：
    - `id`
    - `skillId`
    - `exportChainId`
    - `status`（`pending | running | passed | failed | aborted | partial`）
    - `stopPolicy`（`stop_on_failure | stop_on_failure_goal_threshold`）
    - `sharedEnvironmentPolicy`
    - `bootstrapStatus`
    - `teardownStatus`
    - `currentStepIndex`
    - `lastCompletedStepIndex`
    - `totalSteps`
    - `warningFlags[]`
    - `errorCode`
    - `errorMessage`
    - `startedAt`
    - `finishedAt`
  - `steps[]` 至少包含：
    - `id`
    - `testCaseId`
    - `sequenceIndex`
    - `title`
    - `status`（`pending | running | passed | continued | failed | skipped | aborted`）
    - `dependsOnStepIds[]`
    - `skillTestRunId`
    - `summary`
    - `artifactRefs[]`
    - `errorCode`
    - `errorMessage`
    - `startedAt`
    - `finishedAt`
  - `warnings[]` 用来承载不阻塞执行但需要显式提醒的条件，例如 `environmentSource = user_supplied`。
  - `issues[]` 用来承载 fail-closed 校验问题；若 `issues[]` 非空，`POST /run` 不会真正启动链运行。
- 示例返回形状（启动成功后立即返回）：

```json
{
  "chainRun": {
    "id": "chainrun_123",
    "skillId": "bettergi-one-dragon",
    "exportChainId": "export_chain_bootstrap_flow",
    "status": "running",
    "stopPolicy": "stop_on_failure",
    "sharedEnvironmentPolicy": "single_chain_environment",
    "bootstrapStatus": "passed",
    "teardownStatus": "pending",
    "currentStepIndex": 1,
    "lastCompletedStepIndex": 0,
    "totalSteps": 3,
    "warningFlags": ["user_supplied_environment"],
    "errorCode": "",
    "errorMessage": "",
    "startedAt": "2026-04-22T13:20:00+08:00",
    "finishedAt": ""
  },
  "steps": [
    {
      "id": "chainstep_1",
      "testCaseId": "case_bootstrap",
      "sequenceIndex": 1,
      "title": "bootstrap environment",
      "status": "running",
      "dependsOnStepIds": [],
      "skillTestRunId": "",
      "summary": "",
      "artifactRefs": [],
      "errorCode": "",
      "errorMessage": "",
      "startedAt": "2026-04-22T13:20:01+08:00",
      "finishedAt": ""
    },
    {
      "id": "chainstep_2",
      "testCaseId": "case_execute",
      "sequenceIndex": 2,
      "title": "execute main flow",
      "status": "pending",
      "dependsOnStepIds": ["chainstep_1"],
      "skillTestRunId": "",
      "summary": "",
      "artifactRefs": [],
      "errorCode": "",
      "errorMessage": "",
      "startedAt": "",
      "finishedAt": ""
    }
  ],
  "warnings": [
    {
      "code": "chain_run_environment_user_supplied",
      "message": "This chain uses user-supplied environment notes; verify them before trusting the result."
    }
  ],
  "issues": [],
  "pollUrl": "/api/skills/bettergi-one-dragon/test-chains/chainrun_123"
}
```

- 列表接口 `runs[]` 可返回更轻的摘要 DTO，最少包含：`id`、`exportChainId`、`status`、`totalSteps`、`lastCompletedStepIndex`、`failedStepIndex`、`startedAt`、`finishedAt`，避免 Skill Tests 列表页为了概览把全部 step 明细都拉回来。
- 启动前 validation 失败的响应规则：
  - `issues[]` 非空时不得启动链运行；默认不创建 `skill_test_chain_runs`，可返回 `chainRun: null`、`steps: []` 和可展示的 `issues[]`。
  - 一旦已经创建链级 run 并进入 preflight / bootstrap / step execution / teardown，后续失败必须落链级审计，不再降级成纯启动前 validation error。
  - 前端必须按稳定 `code` 做展示和修复引导，不依赖后端英文 `message` 文案。
- Validation error matrix（MVP 最小门禁）：

| Code | 触发条件 | 是否启动 | HTTP 建议 | 审计落点 | 用户修复方向 |
| --- | --- | --- | --- | --- | --- |
| `chain_run_cases_missing` | `exportChainId` / `caseIds[]` 无法解析出 case，或指定 case 已删除 | 阻止 | `404` 或 `400` | 不创建 chain run | 刷新列表，重新选择链成员 |
| `chain_run_metadata_incomplete` | case 缺少 `chainPlanning.exportChainId` / `sequenceIndex` / `dependsOnCaseIds` 等必要 metadata | 阻止 | `400` | 不创建 chain run | 回到聊天导出流程重新生成链式草稿 |
| `chain_run_skill_mismatch` | 候选 case 的 `skill_id` 与路由 `skillId` 不一致 | 阻止 | `400` | 不创建 chain run | 移除跨 skill case，按单 skill 重新运行 |
| `chain_run_export_chain_mismatch` | 候选 case 混入多个 `exportChainId`，或 `caseIds[]` 不属于同一导出链 | 阻止 | `400` | 不创建 chain run | 只选择同一链组的 cases |
| `chain_run_mode_unsupported` | 任一步不是 `loading_mode = full` 或 `test_type = execution` | 阻止 | `400` | 不创建 chain run | 改为普通单 case run，或重新导出 execution 链 |
| `chain_run_topology_invalid` | `sequenceIndex` 重复 / 断裂、依赖非线性、跨链依赖、依赖不存在或形成环 | 阻止 | `400` | 不创建 chain run | 修正链顺序和依赖后重新导出 |
| `chain_run_case_schema_invalid` | 任一步 canonical case schema 不合法，现有 run/evaluation 无法执行 | 阻止 | `400` | 不创建 chain run | 在 Skill Tests 中修正 case 字段 |
| `chain_run_environment_missing` | 任一步 `environmentSource = missing`，或 execution 所需环境契约缺失 | 阻止 | `400` | 不创建 chain run | 补 `TESTING.md` / 确认环境契约后重新确认链 |
| `chain_run_inheritance_unsupported` | 任一步声明 `conversation`、`externalState` 或未知 inheritance 类型 | 阻止 | `400` | 不创建 chain run | 改成 `artifactRefs` / step summary / shared environment handle |
| `chain_run_runtime_config_invalid` | provider / model / isolation / environment 参数缺失或与现有 runner 不兼容 | 阻止 | `400` | 不创建 chain run | 修正运行配置后重试 |
| `chain_run_stop_policy_invalid` | `stopPolicy` 不是 `stop_on_failure` 或 `stop_on_failure_goal_threshold` | 阻止 | `400` | 不创建 chain run | 选择受支持的链继续策略 |
| `chain_run_already_running` | 同一 `skillId + exportChainId` 已有未完成 chain run | 阻止新启动 | `409` | 不创建新的 chain run | 打开当前运行详情或等待结束 |
| `chain_run_bootstrap_failed` | 已创建 run 后，preflight / bootstrap / verify 失败 | 已启动但失败 | `200`/`202` 后由 DTO 表示失败 | `skill_test_chain_runs` + pending steps | 查看环境错误，修复后重新启动 |
| `chain_run_step_failed` | 某一步 execution run 失败 | 已启动但失败 | `200`/`202` 后由 DTO 表示失败 | chain run + failed step + 已执行 `skill_test_runs` | 查看失败 step，后续 steps 保持 `skipped` |
| `chain_run_teardown_failed` | steps 结束后 teardown / cleanup 失败 | 已启动但部分失败 | `200`/`202` 后由 DTO 表示 `partial` / `failed` | chain run + teardown status | 人工清理环境并保留风险提示 |

- Warning matrix（不阻止启动，但必须提示）：

| Code | 触发条件 | 展示要求 |
| --- | --- | --- |
| `chain_run_environment_user_supplied` | 任一步环境来源为 `user_supplied` | 启动前和结果摘要都提示“依赖用户临时补充环境信息” |
| `chain_run_teardown_contract_missing` | 环境契约没有明确 teardown，但其他执行契约足够 | 结果摘要提示可能需要人工清理 |
| `chain_run_goal_threshold_continued` | `stop_on_failure_goal_threshold` 放行了 verdict 非 pass 但目标达成度过阈值的 step | 结果摘要提示该链包含待复核但已继续的 step |

- UI 至少展示：
  - 该组 cases 属于同一链
  - 当前是否可按链运行
  - 运行到第几步
  - 哪一步失败
  - 哪些后续 steps 因依赖被跳过
  - 若存在 `user_supplied` 环境来源，给出风险提示
  - 链详情与单 case run 明确分栏，避免把 `chain step audit` 误读成普通单 case run 历史

## Acceptance Criteria
- [x] Skill Tests 能识别同一 `exportChainId` 的链式 draft，并提供显式“Run as chain”入口。
- [x] 非链式 cases、结构不完整的链式 cases、混入不兼容 case 的集合不会误触发链运行。
- [x] 链运行会先做一次链级 bootstrap / verify，再按 `sequenceIndex` 顺序运行 steps。
- [x] 默认策略下某一步失败后，后续依赖 steps 会标记 `skipped`，整链状态为 `failed` 或 `partial`，而不是继续盲跑。
- [x] 当请求显式使用 `stop_on_failure_goal_threshold`，`status = succeeded`、无 critical constraint fail、且 `goalAchievement >= 0.8` 的 borderline step 会标记为 `continued` 并继续后续 steps；该 step 自己的原始 verdict 不会被改写成 pass。
- [x] 已执行 steps 仍保留现有 run/evaluation 记录；所有链 steps（含 `skipped` / `aborted`）都能通过链级审计回溯到所属 `chainRunId`。
- [x] UI 能看到链级摘要、当前步骤、失败步骤和跳过步骤。
- [x] `environmentSource = missing` 会阻止整链运行；`user_supplied` 至少会给出明确风险提示。
- [x] 声明 `conversation` 或 `externalState` 继承的链 steps，在 MVP 中会被结构化拒绝，而不是悄悄降级运行。
- [x] 启动前 validation failures 返回稳定 `issues[].code`，并符合 PRD 中的 validation error matrix；runtime 阶段失败会落链级审计而不是消失在启动错误里。
- [x] 现有单 case run、draft 编辑、普通 regression 视图不受破坏。
- [x] spec 明确补充“链 runner 的最小共享上下文 contract”和“仍未支持的执行语义边界”。

## Validation
- 后端 / e2e：链资格校验、线性执行顺序、失败即停、后续 step skip、链级审计回写、环境门禁与 unsupported inheritance 拦截。
- 前端：链入口展示、运行进度、失败/跳过状态、`user_supplied` 风险提示。
- 常规验证：`npm run build`、`npm run typecheck`、`npm run check`、相关 `node --test tests/skill-test/*`。

## Notes
- 这是 `04-21-skill-test-chat-workbench-mode` 的后续子任务；它依赖 `04-21-skill-test-lifecycle-chain-planning` 已经把链 metadata 稳定导出到 canonical draft metadata。
- 本任务关注“真链执行”，不是继续扩规划 JSON；如果实现中发现还需要更复杂的 checkpoint / resume 或分支链，应另开 follow-up，而不是继续膨胀本任务范围。
