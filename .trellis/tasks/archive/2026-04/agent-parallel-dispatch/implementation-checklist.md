# Implementation Checklist: Agent Parallel Dispatch v1

## 一句话目标

只放开一个最小场景：**同一 conversation 已有 agent 在运行时，用户显式单 `@Agent` 且目标 agent 空闲，则允许旁路并发启动；若目标 agent 忙碌，则排进该 agent 自己的 slot queue。**

不在 v1 放开的范围：

- 普通广播 / 无显式 `@`
- 多 mention
- agent-to-agent handoff 自动并发
- `send-private` 对其他 agent 的 side-dispatch 自动唤醒
- slot 级单独 stop 按钮

## 推荐实现顺序

### Phase 0：只抽复用件，不改行为

目标：把后续 side-dispatch 必须复用的能力先抽出来，降低 Phase 1 风险。

建议改动：

- `server/domain/conversation/turn/routing-executor.ts`
  - 抽出 prompt snapshot / visible message helper
  - 抽出“单 agent 执行所需最小输入”构造逻辑
- `server/domain/conversation/turn/turn-state.ts`
  - 预留 side slot summary 的公共结构或 helper
- `server/domain/conversation/turn/turn-runtime-payload.ts`
  - 允许未来无痛追加 side slot 字段

建议新增：

- `server/domain/conversation/turn/prompt-visibility.ts`
  - 放 `buildPromptSnapshotMessageIds()` / `buildPromptMessages()` 这类可复用逻辑

Phase 0 验收：

- 不改变当前 runtime payload
- 不改变 `POST /messages` 行为
- 不改变 `turn_progress` / `turn_finished` 事件语义

### Phase 1：后端最小 side-dispatch 能力

目标：后端完成双车道调度，但 UI 先只做最小兼容展示。

建议新增：

- `server/domain/conversation/turn/agent-slot-registry.ts`
  - 管理 `(conversationId, agentId)` 维度的 active slot
- `server/domain/conversation/turn/agent-slot-queue.ts`
  - 管理 explicit single mention 的 slot-aware queue
- `server/domain/conversation/turn/side-dispatch-runner.ts`
  - 跑单 agent、禁 handoff 的 side-dispatch 执行器

必须修改：

- `server/domain/conversation/turn-orchestrator.ts`
  - 在 `submitConversationMessage()` 做 main lane / side lane 分流
  - main lane 继续复用 `drainConversationQueue()`
  - side lane 负责：判定显式单 mention、检查 slot、立即启动或入 slot queue
  - conversation stop / clear state / runtime payload 需要感知 side slots
- `server/domain/conversation/turn/turn-runtime-payload.ts`
  - 新增 `activeAgentSlots`
  - 新增 `agentSlotQueueDepths`
- `server/api/conversations-controller.ts`
  - `POST /messages` 返回 side-lane 相关 dispatch 信息
  - `POST /stop` 变成 stop main turn + 全部 active side slots
  - `DELETE /conversation` 加 side slot / slot queue guard
- `server/domain/runtime/agent-tool-bridge.ts`
  - side-dispatch 场景下禁用 handoff 扩散
  - 保持 tool trace 的 `conversationId` / `turnId` / `assistantMessageId` / `agentId` 一致

建议的请求分流规则：

1. 先持久化用户消息。
2. mention 解析后若**不是显式单 mention**，直接走现有 main lane。
3. 若是显式单 mention：
   - 目标 slot 空闲 → 立刻 `side started`
   - 目标 slot 忙碌 → 进入该 agent 的 slot queue
4. side slot 完成后：
   - 释放 slot
   - 优先尝试 drain 同 agent 的下一条 queued entry
   - 再尝试其他 idle agent 的 queued entry

建议的 side runner 约束：

- 单 agent only
- `allowHandoffs = false`
- 不参与现有 turn 内部 mention queue
- 使用 dispatch-time prompt snapshot isolation
- 不读取其他并发 slot 的 streaming / placeholder assistant message

Phase 1 验收：

- A 正在运行 + 用户 `@B` 且 B 空闲 → B 立即并发启动
- A 正在运行 + 用户 `@A` → 进入 A 的 slot queue
- A 正在运行 + 普通广播 → 仍进入 conversation main queue
- A 正在运行 + `@A @B` → 仍走现有 main lane 语义，不 side-dispatch

### Phase 2：前端 active slot 叠加展示

目标：UI 正确表达“main turn + side slots 并存”。

必须修改：

- `public/app.js`
  - 新增 `activeAgentSlotsForConversation()` / `conversationHasActiveSideSlots()` 之类 helper
  - runtime merge 逻辑纳入 `activeAgentSlots`
  - stop request 清理逻辑不能只看 `activeTurns`
  - `liveStageForMessage()` 改成同时查询 main turn + side slots
- `public/chat/conversation-pane.js`
  - composer status 能表达多 slot 同时活跃
  - stop 文案改为“停止当前会话中的全部活跃执行”
  - delete disabled 判定加入 side slots / slot queue
- `public/chat/message-timeline.js`
  - live draft / live tool trace 绑定 side slot 的 stage

按需再改：

- `public/chat/conversation-list.js`
  - 如果 busy badge 逻辑已拆出去，则要把 active side slots 算进去

Phase 2 验收：

- 同一 conversation 下两个 agent 并发时，列表和详情页都显示 busy
- 一个 slot 结束、另一个 slot 仍活跃时，UI 不会错误恢复成 idle
- timeline live stage 不串 messageId

### Phase 3：事件与 agent-origin queue 统一（后续，不进 v1）

后续再考虑：

- 新增 `agent_slot_progress` / `agent_slot_finished` 事件
- 把 `send-private` 唤醒并入 slot-aware queue
- 把 public handoff mention 也迁到 slot model
- 统一 `activeTurns` 与 `activeAgentSlots` 的状态模型

## 推荐改文件清单

### 后端核心

- `server/domain/conversation/turn-orchestrator.ts`
  - 当前主入口；必须承担 lane 分流与 side queue drain
- `server/domain/conversation/turn/routing-executor.ts`
  - 当前假设“一个 conversation 只能一个 active turn”；v1 只建议抽 helper，不重写主逻辑
- `server/domain/conversation/turn/turn-runtime-payload.ts`
  - 当前 runtime payload 只有 `activeTurns`，必须扩成 `activeTurns + activeAgentSlots`
- `server/domain/conversation/turn/turn-state.ts`
  - 如果要复用 summary / live tool headline，需补 slot summary helper
- `server/domain/runtime/agent-tool-bridge.ts`
  - 明确 side runner 下 handoff 的禁止或降级语义
- `server/api/conversations-controller.ts`
  - stop/delete guard、`POST /messages` dispatch payload

### 前端核心

- `public/app.js`
  - 当前有明显的 `activeTurnForConversation()` 单 turn 假设
- `public/chat/conversation-pane.js`
  - 当前 stop / delete / composer status 都围绕单 activeTurn
- `public/chat/message-timeline.js`
  - 当前 live stage 只从单个 `activeTurn` 查

### 测试

- `tests/runtime/turn-orchestrator.test.js`
  - lane 分流、slot queue 串行/并行语义、stop/delete guard
- `tests/runtime/agent-tool-bridge.test.js`
  - side runner 下 `send-private` / handoff 禁止或降级语义
- `tests/runtime/message-tool-trace.test.js`
  - side slot tool trace 不串 `assistantMessageId`
- `tests/smoke/server-smoke.test.js`
  - `POST /messages` 新 dispatch payload 与端到端 side-dispatch smoke

## 建议新增的数据契约

### Runtime payload

在现有字段基础上新增：

- `activeAgentSlots: Array<{ slotId, conversationId, agentId, agentName, turnId, sourceMessageId, assistantMessageId, status, startedAt, updatedAt }>`
- `agentSlotQueueDepths: Record<string, Record<string, number>>`

注意：

- 保留现有 `activeTurns`、`activeConversationIds`、`dispatchingConversationIds`
- v1 不建议删除旧字段，先做叠加兼容

### `POST /messages` 响应

建议保持原有 `dispatch` 粒度不变：

- `dispatch = 'started' | 'queued'`

同时新增：

- `dispatchLane = 'main' | 'side'`
- `dispatchTargetAgentId?: string`

这样：

- `started + main` = 现有主车道启动
- `queued + main` = 现有 conversation queue
- `started + side` = side-dispatch 立即启动
- `queued + side` = 进入 agent slot queue

## 明确的并发语义

实现前必须锁死这几条，不然很容易写散：

- snapshot 在 dispatch 时冻结，不热插入别的并发 slot 输出
- 不读取别的并发 slot 的 assistant placeholder / streaming 半成品
- 同一 agent slot 内串行，不同 agent slot 之间允许并发
- main lane 自己保序，side lane 同一 agent 自己保序，跨 lane 不承诺完成顺序
- v1 stop 仍按 conversation 级：一次停 main turn + 全部 active side slots

## 建议先不要动的文件/能力

v1 先不要扩散到这些点：

- `server/domain/conversation/turn/agent-prompt.ts`
  - prompt 指令本身不需要因为 v1 改动而重写
- 游戏自动主持相关服务
  - `server/domain/undercover/*`
  - `server/domain/werewolf/*`
- skill loading / Trellis prompt 注入
- 现有 `mention_parallel` 的 turn 内 fan-out 机制

## 实施前的最终闸门

只有当下面 4 条都确认后，再进代码阶段：

- 选定 side runner 是否新增独立 SSE 事件，还是先仅靠 `runtime_state`
- 选定 handoff 在 side runner 下的最终行为：报错 or 降级静默 private note
- 选定 `dispatchLane` 字段命名是否直接进入 API
- 确认前端 v1 是否必须展示“按 agent 的活跃槽”，还是先只修正 busy/stop/timeline
