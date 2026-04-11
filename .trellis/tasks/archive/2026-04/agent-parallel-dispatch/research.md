# Research: Agent Parallel Dispatch

## Goal

在 CAFF 中验证一条最小可行路径：当同一 conversation 已有 agent 正在运行时，用户显式单 `@Agent` 是否可以像 `clowder-ai` 的 side-dispatch 一样，旁路启动另一个空闲 agent，而不是继续被 conversation 级队列阻塞。

本阶段只产出方案，不写实现代码。

配套的压缩版实施清单见：`implementation-checklist.md`。

## Executive Summary

结论：**可以借鉴 `clowder-ai`，但不建议直接照搬它的整套 thread/cat invocation 体系。**

CAFF 当前的根阻塞点不是“消息发不进去”，而是**活动执行单元被建模成 conversation 级单 active turn**：

- `submitConversationMessage()` 先持久化用户消息，再尝试启动 `drainConversationQueue()`。
- `drainConversationQueue()` 只按 conversation 维度续跑批次；一旦同一 conversation 已 active/dispatching，新的用户消息只能变成 queued batch。
- `runConversationTurn()` 入口又明确拒绝同一 conversation 的第二个并发 turn。
- agent-to-agent handoff / `send-private` 唤醒也只会进入**当前 turn 内部队列**，并不会创建新的并发执行槽。
- 前端状态同样默认“一个 conversation 只有一个 activeTurn”。

因此，用户显式 `@另一个空闲 agent` 之所以仍会被阻塞，不是因为 mention 路由不认识目标，而是因为**整个 conversation 在执行模型上只有一个可运行中的 turn 槽位**。

`clowder-ai` 能做到“一个猫在跑时，显式 `@` 另一个空闲猫直接并发”，关键不是单个 if，而是把锁粒度下放成了 **thread + cat slot**，再配一个**slot-aware queue**。

对 CAFF 的最小 v1，不需要一步把所有 turn/handoff 都重写成多槽系统。更稳妥的方案是：

1. **保留现有 conversation-level main turn queue 不动**，继续承接普通广播、无显式 `@`、多 mention、当前 handoff 语义。
2. **新增一层 per-agent slot registry + slot-aware side-dispatch queue**，只服务“用户显式单 `@Agent`”这一个最小场景。
3. 仅当目标 agent slot 空闲时，允许 side-dispatch；目标 agent 忙碌时，进入该 agent 的 slot queue。
4. side-dispatch v1 **不开放 agent-to-agent handoff / private wake-up 自动并发扩散**，避免语义爆炸。

这条路线能满足用户最关心的目标，同时把风险压在可控范围内。

## Current CAFF Blocking Model

### 1. Conversation 级单活跃 turn

CAFF 当前的运行时规格已经明确：同一 conversation 同时最多一个 active run；连续发送只是“先接收消息，再串行续跑下一批”，不是同会话多 run 并发。

对应代码形态是：

- `server/domain/conversation/turn-orchestrator.ts`
  - `activeConversationIds: Set<conversationId>`
  - `activeTurns: Map<conversationId, turnState>`
  - `dispatchingConversationIds: Set<conversationId>`
- `server/domain/conversation/turn/routing-executor.ts`
  - `runConversationTurn()` 如果发现 `activeConversationIds.has(conversationId)` 直接 `409`
- `server/domain/conversation/turn/turn-runtime-payload.ts`
  - 运行时 payload 只暴露 `activeTurns[]`，并且前端按 `conversationId` 查找单个 activeTurn

### 2. 连续发送是 queued batch，不是 side-dispatch

当前 `/api/conversations/:conversationId/messages` 的行为是：

1. 先持久化用户消息。
2. 如果 conversation 没有 active/dispatching work，则启动 `drainConversationQueue()`。
3. 否则返回 `dispatch='queued'`。

`drainConversationQueue()` 只会：

- 按 `lastConsumedUserMessageId` 找出下一个 queued user batch
- 调一次 `runConversationTurn(conversationId, { batchMessageIds })`
- 成功后推进 consumed 边界
- 失败则保留队列等待后续 drain

也就是说，**后来消息永远排在当前 active turn 后面**，不会因为目标 agent 不同而旁路启动。

### 3. 当前“并行”只存在于一个已启动 turn 内

CAFF 现在有的 `mention_parallel` 只是在**同一个 turn 里**，对首轮多 mention 做并行 fan-out：

- 这是 turn 内部的并行 speaker execution。
- 这不是新的独立 turn / slot。
- 并行首轮之后不会继续自动 handoff 扩散。

因此它不能解决“当前 A 正在跑时，用户再 `@B` 让 B 旁路并发”的问题。

### 4. handoff/private wake-up 仍挂在当前 turn 内部队列

`server/domain/runtime/agent-tool-bridge.ts` 里的 `send-private` handoff 只是在当前 run 的 `enqueueAgent()` 上追加 queue item。

这意味着：

- handoff 不会创建新的 conversation 外并发执行槽
- `allowHandoffs` 为 false 时会直接被禁止
- 即使当前 turn 内能接力，也还是**单个 turn 上的串并行编排**，不是多 active run

### 5. UI 默认一个 conversation 只有一个 activeTurn

`public/app.js` 与 `public/chat/conversation-pane.js` 的关键假设是：

- `activeTurnForConversation(conversationId)` 只取 `activeTurns.find(turn => turn.conversationId === conversationId)`
- stop / composer status / live draft / timeline live stage 都围绕这个单一 activeTurn 推导
- conversation list 的 busy 状态也主要看 `activeConversationIds` / `dispatchingConversationIds`

所以即使后端偷偷允许多个并发 run，当前 UI 也会天然“只认一个”。

## What Clowder-AI Actually Contributes

`clowder-ai` 真正值得借的不是某个具体文件，而是下面这四个机制的组合。

### 1. 锁粒度从 per-thread 变成 per-thread-per-cat

`InvocationTracker` 把执行槽定义为 `(threadId, catId)`：

- 同一 thread 内，不同 cat 可以并发
- 同一 thread + 同一 cat 仍然保持单锁
- cancel / complete / delete guard 都按 slot 维度收口

这是 side-dispatch 的真正基础。

### 2. 发送路径做 slot-aware 分流

`messages.ts` 不是一律看 thread busy，而是按场景分流：

- whisper：检查目标 cat slot 是否忙
- 广播 + 显式 `@`：检查目标 cats 是否有 busy slot
- 普通广播 / 无显式 `@`：检查 thread 是否有任何 active invocation

这条规则正好对应 CAFF 需要的最小目标：

- `@空闲Agent`：可以立刻 side-dispatch
- `@忙碌Agent`：继续排队
- 非显式定向广播：保持串行

### 3. queue 不是 thread-only，而是 slot-aware

`QueueProcessor.tryAutoExecute()` 会扫描 queued entries，并把**所有目标 slot 空闲的 entry**都启动起来。

因此：

- 某个 busy cat 的 entry 不会卡住另一个空闲 cat 的 entry
- 不同目标 cat 的 queued entry 可以并发启动
- 同一个 cat 的 queued entry 仍保持串行

### 4. 前端 active 状态是多 slot，不是单 busy flag

`activeInvocations` 以 invocationId 为 key，记录多个 active slot；`hasActiveInvocation` 只是其派生值。

这让前端能表达：

- 同一 thread 下多个 agent 同时活跃
- 一个 slot 结束后，另一个 slot 仍保持 active
- stop / status / 输入框可根据目标 slot 更细粒度判断

## CAFF vs Clowder-AI: Structural Delta

### CAFF 当前模型

- 锁单位：`conversationId`
- 主队列：conversation queued user batches
- active 状态：`activeTurns[conversationId]`
- handoff：当前 turn 内部 queue
- stop：conversation 当前 active turn 全停
- UI：单 `activeTurn`

### Clowder-AI 模型

- 锁单位：`threadId + catId`
- 主队列：slot-aware invocation queue
- active 状态：`activeInvocations[invocationId]`
- handoff：可以通过 queue + autoExecute 进入空闲 slot
- stop：按 slot 更自然
- UI：多 slot

### 对 CAFF 的启示

如果直接把 CAFF 改成完全的 `clowder-ai` 多 slot invocation 架构，改造面会非常大：

- `turn-orchestrator`、`routing-executor`、`turn-state` 基本都要重切
- 前端 `activeTurn` 假设几乎处处要改
- stop/delete/trace/timeline 语义要整体重定义

所以更现实的最小方案应该是：**在现有 conversation turn queue 旁边，叠加一个 side-dispatch slot layer**，而不是第一步就把所有 turn 逻辑全量迁移。

## Recommended CAFF V1

## V1 User-Facing Behavior

只开放这一条能力：

1. 用户消息是**显式单 `@Agent`**。
2. 目标 agent 在当前 conversation 的 slot 是空闲的。
3. 即使此时 conversation 已有其他 agent 正在运行，也允许该目标 agent 旁路并发启动。

如果目标 agent 忙碌，则：

- 不报错
- 不打断别的 run
- 进入该 agent 的 slot queue，等它空闲后再执行

以下场景 v1 先不放开：

- 无显式 `@` 的普通广播
- 多 agent mention
- agent-to-agent handoff 自动并发
- `send-private` 对其他 agent 的 side-dispatch 自动唤醒
- 精细到 slot 的 stop 按钮

## V1 Routing Rule

建议把 `POST /messages` 的调度判定拆成两层：

### Layer A: 保留现有 main turn queue 的场景

仍走当前 `submitConversationMessage()` / `drainConversationQueue()` 的 conversation 级串行路径：

- 无显式 mention
- 多 mention
- `#ideate` / `#execute` 等复杂 turn 模式
- 游戏房间特殊逻辑
- 其他所有当前已有语义

### Layer B: 新增 side-dispatch 分支

仅当满足以下全部条件时，走 side-dispatch：

- 是普通 conversation（非游戏自动主持锁定阶段）
- 用户输入经 mention parser 后，得到**恰好一个显式目标 agent**
- 当前 conversation 已存在其他 active work，或者该目标 agent 已有 slot queue 需要统一处理
- 目标 agent 不在 active slot 中

分支结果：

- **目标 slot 空闲** → 立即启动 side-dispatch
- **目标 slot 忙碌** → 入该 agent 的 slot-aware queue

> 关键点：v1 的 side-dispatch 判断只看“目标 agent slot 是否空闲”，而不是“conversation 是否整体 busy”。

## Core Design: Overlay, Not Rewrite

### 1. Slot Registry（新）

新增一个 conversation-scoped slot registry，粒度为：

- `slotKey = conversationId + agentId`

最小职责：

- `has(conversationId, agentId)`：目标 agent 是否正在执行 side-dispatch 或其他 slot-run
- `start(conversationId, agentId, meta)`：占用该 slot
- `complete(conversationId, agentId, token)`：释放该 slot
- `listByConversation(conversationId)`：给 runtime payload / UI 展示当前活跃 slot
- `cancelAll(conversationId)`：给 conversation-level stop 使用

建议记录的最小 slot 元信息：

- `slotId`
- `conversationId`
- `agentId` / `agentName`
- `sourceMessageId`
- `assistantMessageId`
- `turnId`（side-dispatch 也仍生成独立 turnId，方便 trace）
- `status`（dispatching / running / stopping）
- `startedAt` / `updatedAt`
- live tool headline（可选，便于前端 composer status）

### 2. Slot-Aware Queue（新）

新增一条**只服务显式单 mention side-dispatch** 的轻量队列。

队列 entry 建议最小包含：

- `entryId`
- `conversationId`
- `targetAgentId`
- `userMessageId`
- `cleanedContent`
- `createdAt`
- `dispatchSource = 'user_explicit_single_mention'`

关键语义：

- 同一 target agent 的 queued entry 仍串行
- 不同 target agent 的 queued entry 可以在空闲时并发启动
- main turn queue 与 side slot queue 分别维护，不互相吞并

### 3. Side-Dispatch Runner（新）

新增一个“单 agent、无 handoff”的 side-dispatch runner，建议复用现有 `executeConversationAgent()`，但不要直接复用整个 `runConversationTurn()` 流程。

原因：

- `runConversationTurn()` 天然假设一个 conversation 同时只有一个 active turn
- 它会把状态写进 `activeTurns[conversationId]`
- 它的队列和 stop 行为都围绕单个 turnState 展开

更合理的 v1 做法是：

- 为 side-dispatch 创建一个**synthetic single-agent run state**
- 只给目标 agent 准备 stage
- `allowHandoffs = false`
- `enqueueAgent = null`
- 不参与现有 main turn 的 mention queue/handoff queue
- 执行完成后，释放 slot，并尝试 drain 该 slot queue / 其他空闲 slot queue

### 4. Runtime Payload（扩展）

保留现有字段不删：

- `activeConversationIds`
- `dispatchingConversationIds`
- `conversationQueueDepths`
- `conversationQueueFailures`
- `activeTurns`

新增 side-dispatch 相关字段，例如：

- `activeAgentSlots: Array<{ slotId, conversationId, agentId, agentName, sourceMessageId, assistantMessageId, status, startedAt, updatedAt }>`
- `agentSlotQueueDepths: Record<conversationId, Record<agentId, number>>`
- 可选：`dispatchingAgentSlotIds: string[]`

这样可以让 v1 前端先叠加显示 side slots，而不用立刻废掉现有 `activeTurns`。

### 5. API Response（扩展而非推翻）

`POST /messages` 目前返回：

- `acceptedMessage`
- `conversation`
- `conversations`
- `dispatch: 'started' | 'queued'`
- `runtime`

v1 可以保持这个结构，只把 `dispatch` 扩展为更细的值，或保留兼容字段再补充附加信息，例如：

- `dispatch = 'started'`：main turn 启动
- `dispatch = 'queued'`：main turn queue
- `dispatch = 'side_started'`：side-dispatch 立即启动
- `dispatch = 'slot_queued'`：side slot queue

如果担心兼容性，可以新增：

- `dispatchLane = 'main' | 'side'`
- `dispatchTargetAgentId`

前端就不需要靠猜测区分“为什么这个消息没有被 main turn queue 吃掉”。

## Prompt Snapshot & Message Visibility Semantics

这是 v1 最需要提前定义清楚的部分。

### Rule 1: side-dispatch 使用独立 snapshot

每个 side-dispatch 在启动时冻结自己的 prompt snapshot：

- 包含 dispatch 时刻已持久化、允许可见的消息
- 包含本次刚接受的 user message
- 不会在运行中热插入别的并发 slot 后续输出

### Rule 2: 不看见别的并发 slot 的“未完成占位/流式半成品”

当前 CAFF assistant message 会先创建 placeholder，再流式更新。

如果 side-dispatch 简单照抄现有 `buildPromptSnapshotMessageIds()`，就可能把其他并发 slot 的：

- `queued` assistant placeholder
- `streaming` 中间内容

错误地带进 prompt。

因此 v1 必须额外规定：

- side-dispatch snapshot **只吸收 dispatch 时刻的稳定消息**
- 对“其他 turn/slot 尚未完成的 assistant message”默认不可见
- 当前 slot 自己的 assistant placeholder 仍可通过本 slot 的 `currentTurnId` / local stage 可见

### Rule 3: 并发输出只对后续 dispatch 可见

如果 A slot 和 B slot 同时运行：

- A 运行中途产出的回复，不会热插入到 B 的 prompt
- B 运行中途产出的回复，也不会热插入到 A 的 prompt
- 只有后面新启动的 run / queued batch，才会看到它们最终落库后的结果

这本质上是 **dispatch-time snapshot isolation**。

### Rule 4: v1 不开放 side-dispatch handoff

为避免 prompt 可见性和 queue 扩散语义失控，v1 side-dispatch runner 建议固定：

- `allowHandoffs = false`
- `send-private` 对其他 agent 的 handoff 不触发 enqueue
- public trailing mention 只显示，不触发新 run

## Queue Order Semantics

CAFF v1 必须接受一个事实：启用 side-dispatch 后，conversation 内会出现**双车道**。

### Lane 1: Main Turn Lane

继续保持当前语义：

- 普通广播
- 无显式 `@`
- 多 mention
- 当前 serial/handoff turn

这些消息仍按 conversation queue 顺序消费。

### Lane 2: Side-Dispatch Lane

只处理：

- 用户显式单 mention
- 目标 agent 定向 side-dispatch

这些 entry 按目标 agent slot 是否空闲决定立即启动或排队。

### 可解释顺序

这会引入新的用户可见现象：

- 一个后发的显式 `@空闲Agent`，可能比前面排队中的普通广播更早得到回复

这不是 bug，而是 v1 的**有意优先级**：

- main lane 保证 main lane 自己的顺序
- side lane 保证同一 target agent slot 自己的顺序
- **跨 lane 不承诺按用户发送顺序完成**

因此建议后续实现时给 assistant message metadata 补足：

- `dispatchLane`
- `sourceMessageId`
- `targetAgentId`
- `slotId`

方便 timeline / debug / trace 解释“它为什么先出来”。

## Stop / Delete / Cancellation Semantics

### V1 Stop

建议 v1 仍保留**conversation-level stop**，但语义改成：

- 取消当前 main turn（如果有）
- 取消当前所有 active side slots
- 不新增 slot 级 stop API

对于 queued work：

- main turn queue：维持当前语义，stop 只停 active work，不丢用户已发送消息
- side slot queue：同样不丢弃 queued explicit-mention entry

这样行为与当前“stop active turn，后续 queued batch 仍可继续”更一致。

### V1 Delete

删除 conversation 时必须额外阻塞：

- main turn active / dispatching
- 任一 side slot active / dispatching
- main queue 仍有待处理 batch
- side slot queue 仍有待处理 entry

force-delete 是否允许丢 side slot queue，建议沿用当前 guarded 模式：

- 只有 idle 且确实是 queue failure 卡住时才允许 force
- active side slot 绝不允许 force-delete 绕过

## Trace / Timeline / Runtime Consistency Risks

### 1. `activeTurns` 不能再代表 conversation 全部 active work

即使 v1 不动现有 main turn 结构，只要 side slot 生效，`activeTurns` 就不再等于“这个 conversation 的所有活跃执行”。

因此：

- conversation list busy 逻辑要把 `activeAgentSlots` 算进去
- composer status 要同时看 main turn 和 side slots
- delete/stop 的 guarded state 要同时看两边

### 2. 现有 `turn_progress` 事件是 conversation + 单 turn 视角

当前 `turn_progress` payload 是：

- `conversationId`
- `turn`

而前端按 `conversationId` 覆盖 `activeTurns[]` 中的那一个条目。

如果 side-dispatch 也复用这条事件但仍让前端按 `conversationId` 覆盖，就会互相打架。

因此 v1 更稳妥的策略是：

- main turn 继续走 `turn_progress`
- side slot 先主要通过 `runtime_state` + message update + tool trace live event 驱动
- 如需增量事件，新增 `agent_slot_progress` / `agent_slot_finished`，不要硬塞进现有单 turn 合约

### 3. tool trace 本身问题不大，但 live stage lookup 要扩展

好消息是：`conversation_tool_event` 主要按 assistant `messageId` / `assistantMessageId` 合并；只要 side-dispatch 也有自己的 assistant message，这条 trace 流本身并不天然排斥并发。

真正要补的是：

- 前端 `liveStageForMessage()` 当前只会去单个 `activeTurn.agents` 里找 live stage
- side slot 的 live stage 需要能被 timeline 找到

因此 v1 需要扩展一层“按 messageId 从 main turn + side slots 联合查 live stage”的 helper。

## Handoff / Private Wake-Up Risk Boundary

这是 v1 最应该明确砍掉的范围。

当前 CAFF 的：

- public mention handoff
- `send-private --to Agent`

都跟“当前 turn 内部 queue”强绑定。

如果在 v1 就把它们也接到 side slot queue，会立刻遇到：

- prompt snapshot 谁看见谁
- handoff 是沿 main lane 还是 side lane
- private message 是否允许跨并发 slot 即时唤醒
- stop 时 queued handoff 清理范围怎么定义

所以建议 v1 明确：

- user-origin explicit single mention 支持 side-dispatch
- agent-origin handoff/private wake-up 一律保持当前 turn 内语义
- side-dispatch runner 关闭 handoff

等 slot registry + slot queue + UI active slot 跑稳后，再考虑 phase 2 统一 agent-origin queue。

## Concrete Impact Areas

### Backend / Orchestrator

重点文件：

- `server/domain/conversation/turn-orchestrator.ts`
  - 新增 main lane vs side lane 的分流判定
  - 接入 slot registry / slot queue / side-dispatch drain
  - stop / clearConversationState / runtime payload 也要感知 side slots

- `server/domain/conversation/turn/routing-executor.ts`
  - 需要抽出 prompt snapshot / prompt message helper，供 side-dispatch runner 复用
  - main turn 逻辑本身 v1 尽量少动

- `server/domain/conversation/turn/agent-executor.ts`
  - 复用单 agent 执行能力
  - 明确 v1 side-dispatch `allowHandoffs=false`

- `server/domain/conversation/turn/turn-state.ts`
  - 如需单独 summary 结构，可新增 side slot summary helper

- `server/domain/conversation/turn/turn-runtime-payload.ts`
  - 加 side slot 字段

### Runtime Bridge

重点文件：

- `server/domain/runtime/agent-tool-bridge.ts`
  - side-dispatch 场景下要明确 handoff 是被禁止、降级成普通 private message，还是报 409
  - tool trace event 仍要保留 messageId / turnId / agentId 一致性

### API

重点文件：

- `server/api/conversations-controller.ts`
  - `/messages` 返回 side lane dispatch 结果
  - `/stop` 改成停 main turn + side slots
  - `DELETE /conversation` 加 side slot / slot queue guard

### Frontend

重点文件：

- `public/app.js`
  - 从“一个 conversation 一个 activeTurn”升级成“main turn + active side slots 联合视图”
  - busy、stop、runtime_state merge、timeline live stage lookup 都受影响

- `public/chat/conversation-pane.js`
  - composer status 改为能表达多 slot 活跃
  - stop 语义改成 conversation-wide stop all active work

- `public/chat/conversation-list.js`
  - busy badge 需要考虑 active side slots

- `public/chat/message-timeline.js`
  - live draft / tool trace 展示需要能绑定 side slot live stage

## Suggested Phased Rollout

### Phase 0: 内部抽取（低风险）

目标：不改行为，只抽 helper。

- 抽出 prompt snapshot / visible message 规则 helper
- 抽出单 agent runner 可复用包装层
- 让 runtime payload builder 支持未来插入 active side slots

### Phase 1: 最小 side-dispatch 后端能力

目标：满足“显式单 `@空闲Agent` 可并发启动；忙碌 agent 仍排队”。

- 新增 slot registry
- 新增 slot-aware queue（只收 explicit single mention user message）
- `POST /messages` 分流到 main lane / side lane
- side-dispatch runner 上线
- `/stop` / `DELETE` guard 感知 side slots
- runtime payload 增加 `activeAgentSlots` / `agentSlotQueueDepths`

### Phase 2: 前端 active slot 展示

目标：让 UI 正确表达并发状态。

- conversation list busy 修正
- conversation pane composer status / stop 状态修正
- timeline live stage lookup 支持 side slots
- 如有需要再加 `agent_slot_progress` 事件

### Phase 3: agent-origin 并发统一（后续）

目标：把 handoff/private wake-up 逐步迁入同一 slot queue 模型。

- `send-private` 对其他 agent 的 wake-up 进入 slot-aware queue
- public handoff mention 也转向 slot model
- 统一 main turn / side slot 的活跃状态模型
- 再评估是否把 `activeTurns` 演进成统一 `activeInvocations`

## Validation Checklist For Implementation Phase

### Core runtime cases

- idle conversation + 单 `@Agent`：仍保持当前直接启动
- A 正在运行 + 用户 `@B` 且 B 空闲：B 立即并发启动
- A 正在运行 + 用户 `@A`：进入 A 的 slot queue
- A 正在运行 + 用户普通广播：仍进 main conversation queue
- A 正在运行 + 用户 `@A @B`：仍走当前串行/并行 turn 语义，不 side-dispatch

### Prompt visibility cases

- side-dispatch 启动时，不带入别的并发 slot 的 streaming placeholder
- A/B 并发时，A 的新输出不会热插进 B 的 prompt
- side-dispatch 完成后，后续新 run 能看到它的最终回复

### Stop / delete cases

- stop 能同时取消 main turn + side slots
- stop 后 queued explicit-mention entry 不丢失
- active side slot 存在时 delete 返回 `409`
- idle 但 slot queue 卡住时，guarded force-delete 语义可解释

### Trace / timeline cases

- side-dispatch 的 tool trace 能按 assistant message 正常展示
- conversation pane 不会把 side slot 错认成 main turn 覆盖掉
- 多个 agent 并发时，timeline live stage 不串位

### Suggested tests to add later

- `tests/runtime/turn-orchestrator.test.js`
  - main lane / side lane 分流
  - side slot queue 仅阻塞同 agent，不阻塞其他 idle agent
  - stop/delete guard 覆盖 side slots

- `tests/runtime/agent-tool-bridge.test.js`
  - side-dispatch runner 下 handoff/private wake-up 的禁止或降级行为

- `tests/runtime/message-tool-trace.test.js`
  - side-dispatch tool trace 事件不串 messageId

- `tests/smoke/server-smoke.test.js`
  - `POST /messages` 返回 `side_started` / `slot_queued` 的端到端 smoke

## Recommendation

建议用户确认后，再进入实现阶段，并按下面顺序落地：

1. 先做 **slot registry + side slot queue + `/messages` 分流**
2. 再补 **runtime payload + stop/delete guard**
3. 最后改 **UI active slot 状态**

这样可以把改造范围锁在最小闭环里：

- 不推翻 main turn queue
- 不立即重写 handoff/private wake-up
- 不要求一开始就把所有前端状态统一成 `activeInvocations`

## Final Recommendation in One Sentence

**CAFF 最适合的 v1 不是“把整个 conversation turn 系统重写成 clowder-ai”，而是在现有 conversation 串行主车道旁边，叠加一个“仅服务显式单 `@Agent`”的 per-agent side-dispatch 车道。**
