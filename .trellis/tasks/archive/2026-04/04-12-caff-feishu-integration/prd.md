# PRD: 04-12-caff-feishu-integration

## Goal
- 在 CAFF 中继续完善飞书接入 MVP，让飞书文本消息通过官方 SDK 长连接稳定进入现有 CAFF 会话链路，并把 assistant 的文本回复回发到飞书。
- 飞书侧继续共用一个 bot 身份与一个 `chat_id -> conversation_id` 绑定，不在飞书接入层按 `@agent` 或 `@bot` 拆分单独对话；Agent 路由继续复用 CAFF 既有群聊能力。
- 当前阶段重点收口四件事：稳定收消息、会话续接、能显式区分回复来自哪个 Agent、能通过简单命令新开一段对话。

## Scope

### In scope:
- 以官方 `@larksuiteoapi/node-sdk` 长连接模式作为当前飞书接入主路径，复用现有长连接入口与共享事件处理链路。
- 入站仅支持飞书文本消息；非文本消息先安全忽略并记录可诊断日志。
- 继续采用“一条飞书会话 = 一个 CAFF conversation”的持久化绑定策略；未知 `chat_id` 自动创建默认 `coding` 会话。
- 新增飞书聊天命令 `/new`：当用户发送该命令时，为当前飞书 `chat_id` 新建一个默认 `coding` conversation，并将绑定切换到新会话。
- 对飞书回调按 `event_id` 或 `message_id` 做持久化去重，避免长连接重放导致重复入库与重复回复。
- 将飞书入站消息送入现有 CAFF 群聊链路，并在消息 `metadata` 中保留必要的飞书来源信息。
- 当 assistant 回复完成后，将纯文本回复发送回对应飞书会话，并为每条回复补充 `【Agent名】` 前缀以区分当前发言 Agent。
- 添加覆盖长连接入站、会话绑定、`/new` 命令、去重、出站前缀回复的最小回归测试。

### Out of scope:
- 以 webhook challenge / verification token 作为本阶段主验收路径。
- 在飞书接入层基于 `@agent` 或 `@bot` 做独立 conversation 拆分、单次路由覆盖、或多人格绑定。
- 为每个 Agent 单独创建飞书 bot 身份。
- 卡片、图片、文件、语音、reaction 等富媒体能力。
- 扫码绑定 UI、管理面板、前端配置页面。
- 多租户、多飞书应用同时接入。
- durable outbound retry、死信队列、后台补偿任务。
- 将飞书抽象成类似 `clowder-ai` 的多平台统一 connector gateway。
- 在本阶段支持加密事件体（`encrypt_key`）解密。

## Requirements

### 1. Connection Mode
- v1 当前验收以官方 SDK 长连接模式为准，不再以 webhook 模式作为主目标。
- 长连接所需配置至少包含：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_CONNECTION_MODE=long-connection`。
- 启动失败、鉴权失败、飞书平台返回错误时，服务应记录明确日志，但不能导致 CAFF 主进程崩溃。
- 当前代码中若保留 webhook 兼容路径，可继续存在，但不作为本任务主验收标准。

### 2. Inbound Message Handling
- 仅处理飞书文本消息；非文本消息统一安全忽略并记录可诊断结果。
- 飞书接入层不再以 `@bot` 作为业务触发前提；能够路由到当前应用 bot 的文本消息默认进入当前 chat 绑定的 CAFF 会话。
- 飞书接入层不负责解析 `@agent` 路由，也不按 `@agent` 创建独立对话；消息正文应尽量原样进入 CAFF，让 CAFF 自己的群聊/点名逻辑继续生效。
- 需要识别并忽略 bot 自己发出的消息，避免飞书回发自身出站消息形成自回环。
- 入站消息应复用现有 `turnOrchestrator.submitConversationMessage(...)`，并写入：
  - `senderName`：优先使用飞书发送者展示名，缺失时回退到稳定标识；
  - `metadata.source = 'feishu'`；
  - `metadata.feishu`：至少包含 `eventId`、`messageId`、`chatId`、`chatType`、`senderOpenId` 等调试与路由所需字段。
- 进入 CAFF 后，消息应像普通群聊用户消息一样出现在现有会话与 Web UI 中，无需新增前端通道。

### 3. Conversation Mapping And Chat Command
- 继续采用 `feishu chat_id -> caff conversation_id` 的 1:1 持久化绑定策略：
  - 私聊：按飞书私聊 `chat_id` 绑定到一个 CAFF conversation；
  - 群聊：按飞书群 `chat_id` 绑定到一个 CAFF conversation。
- 当入站消息命中未绑定的 `chat_id` 时，系统自动创建一个标准 `coding` conversation，并持久化绑定关系。
- conversation 绑定必须持久化，重启后仍可恢复映射，不依赖内存状态。
- 新增飞书命令 `/new`：
  - 当消息正文 `trim()` 后精确等于 `/new` 时触发；
  - 系统为当前 `chat_id` 新建一个默认 `coding` conversation；
  - 立刻将该 `chat_id` 的绑定切换到新 conversation；
  - `/new` 命令本身不应作为普通用户消息提交给 CAFF；
  - 系统应向飞书回一条简短确认文本，说明已切换到新会话。
- 本阶段不要求 `/reset`、`/sessions`、`/use` 等更复杂的会话管理命令。

### 4. Dedup And Outbound Reply Handling
- 入站去重必须使用持久化记录，至少覆盖飞书重试场景：
  - 同一 `event_id` 重放不会重复创建用户消息；
  - 同一 `message_id` 的重复投递不会重复触发 assistant 执行。
- 出站发送也需要有最小幂等保护，避免同一 assistant 消息被重复回发到飞书。
- 当绑定到飞书的 conversation 产生 assistant 完成消息时，系统应将其纯文本内容发送回对应飞书会话。
- v1 仅要求纯文本出站；不要求卡片渲染、富文本格式化、媒体上传。
- 每条 assistant 出站消息都应补充 `【Agent名】` 前缀，便于用户在飞书里区分当前发言 Agent：
  - 优先使用现有消息中的 Agent 显示名；
  - 缺失时回退到稳定的 speaker 标识；
  - 若仍无法确定，至少使用可诊断的默认前缀（如 `【assistant】`），而不是静默丢失身份信息。
- 出站失败采用 best-effort 策略：
  - 记录错误日志与必要的事件记录；
  - 不回滚已完成的 CAFF assistant 消息；
  - 不在 v1 中引入后台重试队列。

### 5. Validation And Error Handling
- 对不支持的事件类型、不完整 payload、非文本消息、已处理过的重复消息，应安全忽略或返回可诊断结果，不能导致服务崩溃。
- 当前阶段仍不支持加密事件体；若收到 `encrypt` payload，应以明确错误或 ignored 结果安全拒绝，并在日志中标注为未支持能力。
- 长连接启动日志应区分“客户端已启动尝试连接”和“真正建立可用连接”，避免误导排障。
- 飞书平台临时错误、网络错误、SDK 内部异常应尽量打印原始错误码/错误信息，方便定位联调问题。

### 6. Data And Storage
- 继续使用会话映射持久化表，至少记录：`platform`、`external_chat_id`、`conversation_id`、`created_at`、`updated_at`，并对 `(platform, external_chat_id)` 建唯一约束。
- 继续使用外部事件幂等与投递记录表，至少记录：`platform`、`external_event_id` 或 `external_message_id`、`direction`、`conversation_id`、`message_id`、`created_at`，并建立能阻止重复处理的唯一索引。
- 本阶段不新增 `chat_id + agent_id` 级别的绑定维度，也不为 Agent 单独落独立会话映射。

### 7. Implementation Clarifications
- 长连接事件仍应走统一的 Feishu inbound service path，避免 long-connection 与 webhook 各自维护不同解析逻辑。
- 飞书接入层的职责是“收消息、做幂等、找 conversation、提交 CAFF、回发文本”，而不是重做 CAFF 的群聊路由语义。
- `/new` 创建的新会话默认为 `coding` 模式；若底层 conversation 创建接口需要 mode/type 参数，应显式传入或命中既有默认值。
- 回复前缀应尽量在出站格式化的最后一层处理，避免污染 CAFF 内部消息存储原文。
- 自动化测试至少覆盖：长连接文本入站、`chat_id` 绑定命中与新建、`/new` 切会话、重复事件去重、assistant 回复前缀格式。

## Acceptance Criteria
- [ ] 配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_CONNECTION_MODE=long-connection` 后，CAFF 能通过官方 SDK 建立飞书长连接并接收入站事件。
- [ ] 飞书私聊或群聊中的一条文本消息到达后，系统能自动创建或命中 `chat_id -> conversation_id` 绑定，并把消息写入现有 CAFF 会话流。
- [ ] 新写入的飞书入站消息在 CAFF 中包含 `metadata.source = 'feishu'` 以及必要的飞书原始标识字段。
- [ ] 飞书接入层不会因为 `@agent` 文本而额外拆分 conversation；同一个 `chat_id` 默认继续复用当前绑定的 CAFF conversation。
- [ ] bot 自己发出的消息会被忽略，不会形成自回环。
- [ ] 同一 `event_id` / `message_id` 重放不会产生重复用户消息，也不会触发重复 assistant 回复。
- [ ] assistant 在该 conversation 中完成回复后，飞书会收到对应的纯文本消息，且带有 `【Agent名】` 前缀。
- [ ] 用户在飞书发送 `/new` 时，系统会为当前 chat 新建一个默认 `coding` conversation、切换绑定，并返回确认文本。
- [ ] `/new` 之后的后续飞书消息会进入新 conversation，而不是继续沿用旧上下文。
- [ ] 非文本或当前不支持的飞书事件不会导致服务崩溃，并有可诊断的处理结果。
- [ ] 至少存在覆盖长连接入口、会话绑定、`/new` 命令、去重逻辑、出站前缀回复的自动化测试。

## Non-Goals
- 不在本阶段重做 CAFF 的消息架构，也不把飞书接入扩展成通用多平台网关。
- 不在本阶段修改 `public/` 前端来专门适配飞书消息展示。
- 不在本阶段实现基于 `@agent` 的独立 conversation 切分或多人格会话管理。
- 不在本阶段实现历史消息回填、消息编辑同步、消息撤回同步。
- 不在本阶段处理飞书组织级复杂权限、管理员配置 UI 或多环境切换界面。

## Technical Notes
- 长连接入口继续落在 `server/domain/integrations/feishu/feishu-long-connection.ts`，并复用既有官方 SDK 接法。
- 飞书 API 交互与共享入站/出站逻辑继续放在 `server/domain/integrations/feishu/` 下。
- 入站消息继续复用 `server/domain/conversation/turn-orchestrator.ts` 的现有提交流程，而不是单独造一套 prompt/turn 执行链路。
- `/new` 命令的识别应尽量放在 Feishu service 进入 conversation 提交前的薄层逻辑中，避免污染更通用的 conversation 提交接口。
- 出站前缀格式建议在 assistant 回复发往飞书前的格式化函数中补上，避免修改存储层原始消息文本。
- 数据落库与唯一索引预计继续触达 `storage/sqlite/migrations.ts` 及对应 store 层。
- 测试大概率覆盖 `tests/runtime/`、`tests/storage/`、必要时补一层 `tests/http/` 或 service 级测试，用来验证长连接输入、conversation 路由、`/new`、幂等与出站前缀发送。
