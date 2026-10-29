# CAFF HTTP 接口速查

默认地址是 `http://127.0.0.1:3100`（环境变量 `CAFF_BASE_URL` 可以改）。请求和返回都是 JSON，出错时返回 4xx/5xx 加 `{"error": "..."}`。
来源是 `server/api/*-controller.ts`，2026-10 对照代码核实过。只列出了有用的，完整清单以源码为准。

鉴权（P1，develop `69b7fa1` 起）：所有 `/api/*` 的写操作都要先过中央写守卫，在读请求体之前执行。契约见仓库的 `docs/engineering/backend/planner-interface.md`。
- **浏览器**：要求 Host 是回环别名之一（127.0.0.1、localhost、[::1]，端口相同），Origin 与 Host 同源，请求体是 JSON（只有图片上传接口用 multipart），并带请求头 `X-CAFF-CSRF-Token`（取自 `GET /api/bootstrap` 的 `apiSecurity.csrfToken`）。
- **规划者（caff.js）**：带 `Authorization: Bearer <凭证文件里的 token>` 和 `X-CAFF-Principal: planner`，免去 Origin 和 CSRF 检查，Host 和 Content-Type 照常检查。凭证无效时返回 401 `planner_credential_invalid`，不会降级成用户。
- **不走写守卫的接口**：agent 回调 `/api/agent-tools/*` 和飞书 webhook 保持原来的鉴权。
- **读接口**：仍然不检查 Host，有 DNS rebinding 风险，属于已知限制。`/api/planner/*` 的读接口必须带规划者凭证。

## 规划者接口（P1；必须带规划者凭证）

| 接口 | 用途 | 说明 |
|---|---|---|
| `GET /api/planner/conversations/:id/state` | 单个房间的有界状态 | `{ conversationId, goal（计数和摘要，不带正文）, proposal, ruling, runner, busy, lastTurn }`，不超过 64 KiB；拿不到有界投影时返回 501，不会回退成全量 |
| `GET /api/planner/portfolio` | 服务端总览 | `items[{ conversationId, title, projectScopeId, state, unresolvedAttentionCount }]` 和 `observedAt`；包含还没有 Goal、只有待裁决 set 提案的房间 |
| `GET /api/planner/attention?after=&limit=&status=&conversationId=` | 持久待处理队列 | `items[{ sequence, kind, conversationId, goalId, goalRevision, summary, failedAgentIds?, lane?, resolvedAt, resolution }]`，另有 `nextCursor`、`highWatermark`、`hasMore`。kind 共 6 种：proposal_pending、budget_exhausted、failure_paused、owner_removed、goal_completed、turn_failed。游标按创建顺序递增 |
| `GET /api/planner/attention/wait?...&timeoutSeconds=1..300` | 长轮询 | 参数同上；有匹配的事项就立刻返回，超时返回 `items: []` 和 `timedOut: true` |
| `POST /api/planner/attention/:sequence/resolve` | 确认事项 | 请求体 `{ reason }`；只能确认 goal_completed 和 turn_failed，其余类型返回 409 `attention_condition_active`，要先处理背后的问题 |

规划者的写操作还要满足以下前置条件：
- **Goal 写操作**：带 `goalId` 和 `goalRevision`。当前没有 Goal 时传 `null` 和 `0`。裁决和替换提案时还要带 `proposalId`。不满足时返回 400 `goal_revision_required` 或 409 `goal_revision_conflict` / `goal_proposal_conflict`。
- **建房**：带请求头 `Idempotency-Key`。同一个键、同样的内容会重放出同一个房间；内容不同返回 409；房间已删除返回 410。
- **消息**：复用 `clientRequestId` 重试时，回执里 `dispatch` 为 `"duplicate"`，不会重复派发。
- **回执是精简的**：不再附带整个会话和房间目录。

## 只读（GET，随时可调）

| 接口 | 用途 | 说明 |
|---|---|---|
| `/api/health` | 健康检查 | `core.ready` 才代表服务可用。`ok` 可能是 false，那只是默认角色没配置 |
| `/api/runtime/stats` | 运行时统计 | |
| `/api/events[?conversationId=]` | SSE 事件流 | 不带 conversationId 是全局流（所有 room）；带了只收该 room 的事件和不属于任何 room 的事件（如 `runtime_state`）。连上先推 `runtime_state` / `turn_progress` / `agent_slot_progress` 快照，之后每 15 秒一个 `ping`。事件 id 是进程内计数器，没有 Last-Event-ID 回放，断线期间的事件会丢。Goal 相关：`conversation_goal_updated`、`conversation_goal_proposal_updated` / `_cleared`；轮次相关：`turn_finished`（带 failures）、`agent_slot_finished`、`conversation_message_created` / `_updated` |
| `/api/conversations?limit=1..100&q=关键词&before=游标` | room 目录 / 搜索 | 返回 `conversations[]`（每项带 `metadata`，里面有 sessionGoal、sessionGoalRunner 等）、`hasMore`、`nextCursor`。`limit` 超出范围返回 400 |
| `/api/conversations/:id` | 单个 room，不含消息 | 返回 `conversation`，包括 `metadata`（sessionGoal、sessionGoalProposal、sessionGoalRuling、sessionGoalRunner、conversationTurnQueue、conversationDigests……）、`agents`、`branch`、`worktreePath`。加 `?includePrivateMessages=1` 会带上私信 |
| `/api/conversations/:id/messages?limit=1..100&before=游标` | 消息分页 | 默认 50 条。返回最新一页、按时间升序：`items`、`nextCursor`、`hasMore` |
| `/api/conversations/:id/goal` | 规范化后的 Goal，外加完整会话和所有 room 头信息 | **很大**（大 room 有十几 MB）。GET 只执行 `get`，不改状态 |
| `/api/conversations/:id/plan` | DAG 计划 | 没有计划时返回 404 |
| `/api/conversations/:id/messages/:mid/tool-trace` | 某条 assistant 消息对应的那一轮 | `trace.message.sessionReused` / `sessionReuseReason`、`trace.task.sessionPath`、`modelUsageSummary`、`summary`、`failureContext`、`steps`（窗口会截断）。只能用于 assistant 消息 |
| `/api/conversations/:id/messages/:mid/trace-inspector` | 更详细的轮次检查 | 另有 `trace-inspector-export` |
| `/api/conversations/:id/messages/:mid/context-snapshot` | 该轮 prompt 上下文快照 | 另有 `context-snapshot-export` |
| `/api/conversations/:id/messages/:mid/session-export` | 导出该轮 session | |
| `/api/conversations/:id/context-snapshots` | 快照列表 | |
| `/api/conversations/:id/acceptance-records` | 验收记录 | 同一路径的 POST 是写操作 |
| `/api/conversations/:id/workspace/preview` | room 工作区预览 | |
| `/api/conversations/:id/workspace/authorizations` | 工作区授权列表 | `authorizations[]`：`id`、`kind`（如 `rename`）、`branch`、`newBranch`、`status`（如 `accepted`）、`createdAt`、`decidedAt`、`sourceMessageId`。没有记录是谁裁决的 |
| `/api/conversations/:id/digest`、`/skill-drafts` | 摘要、技能草稿 | 同一路径的 POST 是写操作 |
| `/api/projects` | 项目列表 | `projects[]` 每项有 `id`、`name`、`path`（该项目根仓的路径），另有 `activeProjectId` 和 `activeProject`（CAFF 界面当前激活的项目，不一定是 CAFF 自己）。room 的 `projectScopeId` 对应这里的 `id`。也可以用它核对某个项目的根仓停在哪个分支 |

## 预演（POST，但不改状态）

| 接口 | 请求体 | 返回 |
|---|---|---|
| `/api/conversations/:id/routing-preview` | `{ "content": "..." }`，只接受这一个字段，多了返回 400 | `agentIds`、`agents[{id,name}]`、`strategy`（如 `user_mentions`）、`executionMode`（如 `serial`）、`explicitIntent` |

## 写操作（按 SKILL.md 的边界：委托范围内直接做，保留事项先问用户）

| 接口 | 请求体 | 说明 |
|---|---|---|
| `POST /api/conversations/:id/messages` | `{ content, clientRequestId?, imageIds? }` | 按正文里的 `@名字` 路由，返回 `acceptedMessage`（含 id、turnId）。带规划者凭证时发送人是规划者（`metadata.source = planner`），从浏览器发的显示为 "You"。客户端不能传 `metadata.contentBlocks` |
| `POST /api/conversations/:id/goal` | `{ action, ... }` | `action` 的取值见下一节。浏览器发起的裁决记为 `ruledBy.kind = user`；带规划者凭证的记为 `planner`，只限用户的闸门（高风险豁免、改已关联 ADR 的决策）对规划者返回 403 |
| `POST /api/conversations/:id/stop` | `{ reason, stopGoal? }` | 停止当前执行；`stopGoal: true` 会同时暂停 Goal |
| `POST /api/conversations/:id/traces/stop` | `{ kind, agentId, slotId, requestId, reason }` | 只停某一条执行 |
| `POST /api/conversations/:id/messages/delete` | | 删消息 |
| `POST /api/conversations/:id/messages/:mid/recovery` | | 消息恢复 |
| `POST /api/conversations` / `.../:id/spawn` | | 新建 room、派生子 room |
| `PUT /api/conversations/:id` | 参与者等 | Project 和 Mode 不可改（409） |
| `PUT .../project-scope`、`PUT .../channel-bindings/feishu` | | |
| `POST .../workspace`、`.../workspace/authorizations/:aid/decision` | 绑定：`{ "confirm": true }`；裁决：`{ token, fingerprint, decision }` | 先 `GET .../workspace/preview` 再 POST 绑定，不能指定分支名，绑定后不广播。改名卡只能由 agent 发起，客户端只能裁决；待处理卡的 token 在 `GET .../workspace/authorizations` 里。卡只存在内存，10 分钟过期 |
| `POST .../acceptance-records`、`.../acceptance-records/:rid/decision` | | 验收记录 |
| `PUT /api/conversations/:id/plan`、`POST .../plan/activate`、`POST .../plan/revert` | | DAG 计划 |

`/api/agent-tools/*` 是给 agent 用的回调接口，要带调用凭证，不要直接调。

## Goal 的 action 取值（`POST /api/conversations/:id/goal`）

| action | 需要的字段 | 效果和注意事项 |
|---|---|---|
| `pause` / `resume` | 可选 `reason` | 有待裁决提案时返回 409 `goal_proposal_pending`；带 `supersedeProposal: true` 和 `proposalId` 才会替换那个提案，并留下 superseded 裁决审计（`set`、`revise`、`complete` 也一样）。`resume` 还会重置 runner，从 1/N 重新计数，可能立刻开始续跑 |
| `accept-proposal` | `proposalId`，可选 `reason` | 提案的 `baseRevision` 必须等于当前 revision，否则 409。接受 `clear` 提案会抹掉整个 Goal |
| `dismiss-proposal` | `proposalId`、`reason` | 驳回待裁决的提案 |
| `update-delivery` | delivery 补丁和 `goalRevision` | 常规更新：只能改工作项状态、标准状态、证据。改到结构返回 409 `goal_structural_review_required`；新增 waived 返回 409 `goal_waiver_review_required`；revision 过期返回 409 `goal_revision_conflict`。合并语义（见 `planner-interface.md` 的「Merge semantics」）：没传的集合保留原值；传了的集合会整个替换，所以要列出全部保留的 ID，不改的项只写 `{ "id": ... }`。不清待裁决的提案，也不重置 runner 计数 |
| `revise` | objective 和/或 delivery 补丁、`goalRevision` | 结构修订，同样是合并语义。改了定义的验收标准要显式给出新状态，否则 400 `goal_acceptance_state_required`。修改或删除已有暂定决策要带 `reason` 和 `impact`。goalId、owner、status 保留 |
| `complete` | | 所有验收标准都是 passed 或 waived 才能完成，否则 409 `goal_acceptance_incomplete` |
| `set-owner` | owner | 换 owner agent |
| `set` / `clear` | | 新建或替换 / 删除整个 Goal。规划者 set 可以带 `owner` 和初始 `status`（caff.js 的 `set-goal`）。**`clear` 不可逆，不要用** |

room 在执行 DAG 节点期间，只允许裁决提案和常规更新，其他动作返回 403 `dag_goal_mutation_forbidden`。
