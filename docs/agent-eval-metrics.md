# Agent 评测与埋点（CAFF）

目标：用可量化的指标帮助你打磨提示词（prompt），重点覆盖：

- Agent 是否“该用工具就用工具”（尤其是通过工具在聊天室发言）
- 工具调用是否稳定（成功率、错误分布、时延）
- 多 Agent 协作链路是否按预期推进（handoff、private-only 等约束）

## 1. Prompt 版本（强烈建议）

CAFF 通过环境变量把 prompt 版本写入每次 agent turn 的元数据，方便你做 A/B 与回归对比：

- `CAFF_AGENT_PROMPT_VERSION`：未设置时默认 `2026-03-30`

你可以在启动前设置，例如（PowerShell）：

```powershell
$env:CAFF_AGENT_PROMPT_VERSION="v2026-03-30a"
npm run start:dev
```

## 2. 期望工具调用标签（Expectations）

CAFF 在每个 `conversation_agent_reply` 任务（即每个 agent turn）写入一条 `agent_expectations` 事件：

- 事件表：`a2a_task_events`
- `event_type = 'agent_expectations'`
- `event_json.expectations`：工具 -> 期望值（`required | forbidden | optional`）

默认策略（`policy.id = caff_default`, `policy.version = v1`）：

- `send-public`：`privateOnly=false` 时 `required`；`privateOnly=true` 时 `forbidden`
- `send-private`：`privateOnly=true` 时 `required`；否则 `optional`
- `read-context / participants / trellis-init / trellis-write`：默认 `optional`

这套标签的用途：把“工具使用”变成可算的混淆矩阵（TP/FP/FN/TN），而不是主观感受。

## 3. 工具调用埋点（Tool Calls）

当 Agent 通过 chat bridge 调用工具时（HTTP `/api/agent-tools/**`），CAFF 会追加 `agent_tool_call` 事件：

- 事件表：`a2a_task_events`
- `event_type = 'agent_tool_call'`
- `event_json` 包含：
  - `tool`: `send-public | send-private | read-context | participants | trellis-init | trellis-write`
  - `status`: `succeeded | failed`
  - `durationMs`
  - `request`（只记录长度/计数等，不落具体内容）
  - `error.statusCode / error.message`（失败时）

注意：这类埋点覆盖“请求到达服务端”的调用。若工具在 agent sandbox 内部就失败（没发出 HTTP），需要额外从 run stderr / provider toolchain 侧补充采集。

## 4. 指标口径（建议）

### 4.1 工具聊天率（Tool Chat Rate）

> 监控 Agent 是否按预期“通过工具在聊天室发言”

- `toolChatRate = publicToolUsedTurns / turns`

推荐同时看“在 `send-public=required` 的样本里”：

- `send-public recall = TP / required`
- `send-public false positive rate = FP / forbidden`

### 4.2 工具调用成功率

对每个工具：

- `successRate = succeededCalls / totalCalls`
- `p50/p95 latency`（来自 `durationMs`）

### 4.3 Private-only 遵循

用 `send-public=forbidden` 的 turn 统计：

- `private-only leak rate = FP / forbidden`（私聊阶段仍发 public）

## 5. 生成报表（脚本）

脚本：`scripts/agent-eval-report.js`

默认会读取：

- `--db-path`（显式指定时）
- 否则 `PI_SQLITE_PATH`
- 否则 `<PI_CODING_AGENT_DIR>/pi-state.sqlite`（默认 agent dir 为 `./.pi-sandbox` 或 `./.pi-sandbox-$PI_ENV`）

示例：

```powershell
node scripts/agent-eval-report.js --json
node scripts/agent-eval-report.js --since 2026-03-01 --until 2026-04-01
node scripts/agent-eval-report.js --agent agent-builder --json
```

输出：

- `agents[]`：每个 agent 的 turn 数、工具聊天率、`send-public/send-private` 混淆矩阵、工具成功率与延迟分位数
- `tools[]`：全局按工具聚合的成功率与延迟

## 6. Dashboard 分组维度（建议）

优先级从高到低：

- `agentId / agentName`
- `promptVersion`
- `provider / model / modelProfileId`
- `conversationType`
- `triggerType`（user / private / ...）
- `privateOnly / allowHandoffs`
- `routingMode / hop`
- 时间窗口（按天/小时）

