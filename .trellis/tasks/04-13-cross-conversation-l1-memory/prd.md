# PRD: Cross-Conversation L1 Memory

## Goal

- 将 L1 curated memory 从 `conversation + agent` 小卡片升级为真正可跨会话的 `local-user + agent` durable memory。
- 保留当前会话内 overlay 能力：本会话临时约定优先，同标题时覆盖 durable card。
- 继续保持多 agent 隔离：默认不跨 agent / persona，不引入多用户共享模型。

## Scope

### In Scope

- Storage/schema 将 memory card 升级为 `scope + owner_key + agent_id + title` upsert 模型。
- `local-user + agent` durable card 保存与读取；当前 `conversation + agent` overlay 继续保留。
- `list-memories` 返回可见 memory overlay：先当前会话 overlay，再同 agent 的 local-user durable。
- `save-memory` 默认写入 `local-user + agent` durable scope。
- `update-memory` / `forget-memory` 仅操作 `local-user + agent` durable cards，并带最小安全护栏。
- Prompt 注入改为注入 bounded visible memory cards，并保留 card scope 诊断。
- Regression tests 覆盖 schema/store/bridge/prompt 的跨会话可见性、agent 隔离与 durable mutation 安全流。

### Out Of Scope

- 多用户 / 远程共享身份模型。
- 跨 agent / 跨 persona memory 共享。
- private mailbox recall。
- 大型 memory 管理台、forget/update UI、复杂净化作业。

## Requirements

### 1. Scope Model

- Durable L1 scope 固定为 `local-user + agent`。
- Overlay scope 仍为 `conversation + agent`。
- 同标题可见性采用 overlay 优先；durable 不得覆盖当前会话内 overlay。

### 2. Tool Contract

- Tool bridge 仍从 invocation 推导 `conversationId/agentId`，agent 不可自报 scope。
- `save-memory` 仅写 durable scope；继续拒绝 secrets、TODO、临时状态。
- `update-memory` 仅更新当前 `local-user + agent` durable card，参数最小集为 `title + content + reason`，并支持 `expectedUpdatedAt` 做乐观并发保护。
- `forget-memory` 仅 tombstone 当前 `local-user + agent` durable card，参数最小集为 `title + reason`，并支持 `expectedUpdatedAt`。
- `list-memories` 只返回当前 agent 可见的 bounded active cards，并暴露每张 card 的 `scope`。

### 3. Prompt Contract

- Prompt 注入只包含 bounded visible cards。
- Prompt 文案需明确：memory 现在可能来自当前 conversation overlay 与 local-user durable 两层。
- 无 memory 时保持原行为兼容。

### 4. Safety

- 默认仍不得跨 agent / persona 共享 durable cards。
- `update-memory` / `forget-memory` 不得改动当前 conversation overlay，只允许处理 durable L1。
- 找不到卡时拒绝；`expectedUpdatedAt` 不匹配时返回并发冲突，不得静默覆盖较新的 durable 纠正。
- `forget-memory` 先走 soft delete / tombstone，而不是直接硬删；被 tombstone 的卡不再出现在 `list-memories` 与 prompt 中。
- Tool trace 只记录 scope/title/action/reasonTag/rejection reason，不回显长文本或 secret 内容。
- Schema/migration 必须兼容 foundation 阶段已写入的 conversation-scoped cards。

## Acceptance Criteria

- [ ] `save-memory` 写入的 card 在同一 agent 的其他 conversation 中仍可见。
- [ ] 其他 agent 在同一房间或其他房间中默认看不到该 durable card。
- [ ] 同标题时，当前 conversation overlay 在 `list-memories` 和 prompt 中优先显示。
- [ ] `update-memory` 只能更新当前 agent 的 durable card，并在 `expectedUpdatedAt` 失配时返回冲突。
- [ ] `forget-memory` tombstone 后，该 durable card 不再出现在 `list-memories` 与 prompt 中。
- [ ] Legacy `conversation-agent` cards 经 migration 后仍可读取。
- [ ] Regression tests 覆盖 store、bridge、prompt 文案与可见性。
