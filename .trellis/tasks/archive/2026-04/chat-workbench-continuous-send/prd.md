# PRD: Chat 工作台连续发送（Continuous Send）

## 背景

当前聊天工作台的发送链路本质上还是“同步回合模式”：

- 前端在提交消息后会设置 `state.sending = true`，并禁用输入框和发送按钮
- `POST /api/conversations/:id/messages` 会一直等待 `runConversationTurn(...)` 完成后才返回
- 后端同一会话存在活跃 turn 时，会因为 `activeConversationIds.has(conversationId)` 直接拒绝新 turn
- 用户如果想补充条件、纠正表达、追问细节，必须等 Agent 整轮回复结束

这会导致几个明显问题：

1. **聊天感不自然**：用户像被“发一条 → 等一条”的电线拴住，不像真正的 IM
2. **长回复体验差**：流式输出、工具执行、多人接力时，等待时间会被放大
3. **纠错成本高**：用户发现自己说漏条件时，无法立刻补充
4. **状态语义混杂**：当前“不能继续输入”既包含“请求还没发出去”，也包含“后端正在跑 turn”

这个任务的目标不是做“同一会话多条 Agent reply 真并发”，而是先把聊天工作台升级为：**用户可以随时继续发消息，系统在后台稳定地串行消费这些消息**。

## 目标

1. **允许连续发送**：用户在 Agent 回复、流式输出、工具执行期间，仍可继续输入并发送新消息
2. **保持语义稳定**：同一会话同一时刻最多只有 1 个 active run，避免上下文和工具副作用打架
3. **让队列可感知**：用户能明确知道“当前正在处理什么”“后面还排了几条补充消息”
4. **支持安全停止**：保留用户主动停止当前回合的能力，并为后续 queued 消息让路
5. **尽量复用现有 SSE / turn_progress 能力**：不把本任务扩散成整套聊天架构重做

## 非目标

- 不在本阶段支持“同一会话多个 Agent run 同时并发执行”
- 不默认启用“用户一发新消息就自动打断当前回复”
- 不重做跨会话调度，也不改变不同会话之间可并行处理的现有能力
- 不引入消息编辑 / 撤回 / 重排等额外交互
- 不改动谁是卧底 / 狼人杀在自动主持阶段的锁定规则

## 采纳方案

### 方案结论：并发接收 + 串行执行 + 用户显式停止

MVP 采用以下核心策略：

- **接收层并发**：用户消息始终允许落库并立刻出现在会话流里
- **执行层串行**：同一会话同一时刻只允许 1 个 active run
- **新消息默认排队**：如果当前 run 尚未完成，新消息进入 pending 队列，留给下一轮处理
- **当前 run 完成后自动续跑**：系统自动把“上次已消费边界之后的全部用户消息”组成下一轮输入
- **打断默认手动**：只有用户点击“停止”时才请求终止当前 run；普通新消息不会自动打断

这是产品体验和实现复杂度之间最稳的第一版平衡点。

## 核心语义设计

### 1. 消息接收与回合执行解耦

当前 `POST /messages` 的问题是：**发消息请求本身绑定了整轮 Agent 执行生命周期**。

本任务改造后应改为：

- `POST /messages` 负责“接收并持久化消息”
- 是否立即启动 run，由会话级调度器决定
- 接口返回应以“已接受 / 已排队 / 已启动”为主，而不是等待整轮回复完成
- 后续回复、流式更新、停止状态继续通过现有 SSE 事件驱动 UI

也就是说，**发送请求变短，运行状态变长**。

### 2. 单会话单 Active Run

同一会话内部保持强约束：

- 任意时刻最多 1 个 active run
- active run 可以处于 `queued / running / streaming / tool_running / stop_requested / completed / failed / aborted` 等状态
- 同会话的新用户消息不会创建第二个并行 run，而是进入下一轮 pending 集合

这样可以最大限度避免：

- Prompt 上下文竞争
- 工具副作用重复执行
- 多段回复互相抢顺序
- 用户不知道哪段回复在回应哪条消息

### 3. Run 输入快照（Input Snapshot）

每个 run 启动时必须固定自己的输入边界，不能在生成过程中热插拔后续消息。

建议在运行时明确记录：

- `batchStartMessageId`
- `batchEndMessageId`
- `consumedUpToMessageId`
- 或等价的顺序号 / 时间边界

语义要求：

- run 只消费启动时已经纳入该 batch 的用户消息
- run 进行过程中后来到达的消息，必须留给下一轮
- 当前 run 的 prompt 视图稳定，不因新消息插入而中途变化

### 4. Pending 消息聚合规则

存储层应保留用户的原始多条消息，不直接合并覆盖。

但在下一轮调度时，可以将“上一轮结束后积累的多条用户消息”作为一个 batch 统一消费：

- 存储层：保留原始消息顺序和 message id
- 调度层：把连续 pending 用户消息聚合成 next batch
- Prompt 层：可按原始顺序逐条注入，或整理成“补充消息块”，但语义必须等价
- UI 层：需要能提示“当前回复结束后，将继续处理你刚发的 N 条消息”

### 5. 打断策略

MVP 只支持一种默认策略：**用户主动停止**。

规则如下：

- 普通新消息到来时，不自动中断当前 run
- 用户点击“停止”后，将当前 run 标记为 `stop_requested`
- 如果当前处于纯生成 / 流式输出阶段，应尽快停止
- 如果当前处于工具执行阶段，进入“安全停靠”：等待当前工具步骤结束，再停止后续步骤 / 后续输出
- 停止后如果队列里还有未消费用户消息，系统应自动开始下一轮

暂不在 MVP 中实现：

- 任意新消息自动打断当前回复
- 基于意图识别的自动打断
- 同会话多分支并行推理

## 用户体验方案

### 1. 输入框始终可用

在普通会话中，只要不是游戏自动主持锁定态：

- 输入框不因当前 turn 运行而禁用
- 发送按钮不因当前 turn 运行而禁用
- 用户可以连续发送多条消息

### 2. 明确显示“正在处理”和“还有多少待处理”

建议在会话顶部 / 输入区状态文案中明确区分：

- 当前是否有 Agent 正在回复
- 当前是否处于停止中
- 当前后面还排了多少条待处理消息

建议的状态表达方向：

- `Alpha 正在回复`
- `还有 2 条新消息待处理`
- `正在安全停止当前回复…`
- `已根据你刚才的补充继续处理`

### 3. 用户消息即时可见

用户发送后应立即在消息流中看到自己的消息，而不是等整轮 run 完成后再刷新整个 conversation。

### 4. 停止按钮语义更清晰

停止按钮在连续发送模型下不再代表“恢复输入框可用”，而是代表：

- 请求停止当前 active run
- 尽快为后续 queued 消息让出执行机会

## 范围

### 主要改动层

#### 前端
- `public/app.js`
- `public/chat/conversation-pane.js`
- `public/chat/message-timeline.js`

#### 后端 / 调度
- `server/api/conversations-controller.ts`
- `server/domain/conversation/turn-orchestrator.ts`
- `server/domain/conversation/turn/routing-executor.ts`
- `server/domain/conversation/turn/turn-state.ts`
- `server/domain/conversation/turn/turn-events.ts`

#### 存储 / 会话视图（按实现需要）
- `lib/chat-app-store.ts`
- `server/domain/conversation/conversation-view.ts`

### 可能新增的能力

- 会话级 pending message 队列或等价状态记录
- run 与 message batch 的关联元数据
- 前端对 queued user messages / next batch 的可视化状态
- 更细粒度的 stop / abort 状态事件

## 验收标准

- [ ] 普通会话中，当 Agent 正在回复、流式输出或执行工具时，用户仍可继续输入并发送新消息
- [ ] `POST /api/conversations/:id/messages` 不再因为“当前会话已有 active run”而直接以 409 拒绝新消息；消息会被接受并进入当前会话
- [ ] 同一会话同一时刻始终最多只有 1 个 active run，不出现两个并行 run 同时消费同一会话上下文
- [ ] 当前 run 启动后使用固定输入快照；运行过程中后来到达的新消息不会被热插入当前 prompt，而是留给下一轮
- [ ] 当用户在当前 run 期间连续发送多条消息时，这些消息会按顺序进入 pending 队列，并在当前 run 完成后自动触发下一轮处理
- [ ] UI 能清楚展示“正在回复 / 停止中 / 还有 N 条待处理消息”等状态，不让用户误以为消息没有发出去
- [ ] 用户点击停止后，当前 run 会进入 `stop_requested`，并在安全点终止；若存在 queued 消息，则后续会自动继续处理
- [ ] 默认情况下，新消息不会自动打断当前 run；只有显式停止才会触发中断流程
- [ ] 谁是卧底 / 狼人杀在自动主持阶段仍保持现有锁定行为，不因连续发送改造被绕过
- [ ] 至少补充覆盖以下场景的测试：空闲会话立即启动、运行中消息入队、停止后续跑下一轮、输入快照不热插拔

## 风险与待确认问题

1. **批处理提示词格式**：下一轮 prompt 是逐条保留原始用户消息，还是整理成“补充消息块”？
2. **停止边界**：底层 provider / 工具桥能否可靠区分“停止输出”与“停止整个 run”？MVP 可以先统一为安全停靠。
3. **消息状态建模**：是否需要为用户消息显式增加 `accepted / queued / consumed` 等 metadata，还是由 turn/batch 关系间接推导即可？
4. **多端幂等**：是否需要前端补充 `client_message_id`，避免多个标签页 / 重试造成重复落库？
5. **接口返回形态**：发送接口应返回完整 conversation，还是返回“accepted message + queue summary + runtime snapshot”即可？

## 实施建议

1. 先把发送接口从“同步执行整轮”改成“接收消息 + 触发调度”两段式
2. 再补会话级串行调度器，让 active run 与 pending batch 可以稳定衔接
3. 然后改前端发送状态，不再用 `state.sending` 把整个输入区锁死
4. 最后补 queued 状态展示、停止语义、SSE 状态联动和关键回归测试

## 技术备注

当前代码中的几个直接卡点，后续实现时需要优先拆开：

- `public/app.js` 的 composer submit 逻辑会在请求期间设置 `state.sending = true`
- `public/chat/conversation-pane.js` 会因为 `state.sending` 禁用输入框和发送按钮
- `server/api/conversations-controller.ts` 的 `POST /messages` 直接等待 `runConversationTurn(...)`
- `server/domain/conversation/turn/routing-executor.ts` 在 `activeConversationIds.has(conversationId)` 时会拒绝新 turn

因此，这个需求的核心不是“把输入框解锁”这么简单，而是把**消息接收生命周期**和**turn 执行生命周期**真正拆开，咕咕嘎嘎。
