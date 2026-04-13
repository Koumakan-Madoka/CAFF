## Relevant Specs
- `.trellis/spec/runtime/agent-runtime.md`: prompt 构建、工具桥接、运行时约束的主文档。
- `.trellis/spec/skills/skill-system.md`: 现有 dynamic skill loading、descriptor path、skill registry 约定。
- `.trellis/spec/skills/skill-testing.md`: skill proposal / publish gate 最可能复用的测试框架。
- `.trellis/spec/backend/controller-patterns.md`: 如果新增 recall 或 proposal API，需要遵循 controller 约定。
- `.trellis/spec/backend/architecture.md`: backend 层边界与职责划分。
- `.trellis/spec/unit-test/runtime-tests.md`: runtime / tool / storage 相关回归测试模式。
- `.trellis/spec/guides/cross-layer-thinking-guide.md`: 此任务横跨 storage、runtime、backend、skills。
- `.trellis/spec/guides/cross-platform-thinking-guide.md`: 涉及路径、sandbox、工具命令时需要注意平台差异。

## Hermes Findings
- Hermes 的 skill 自迭代本质是 `prompt nudges + skill_manage tool + local skill repo + safety scan`。
- Hermes 的“记忆”更接近 `长期小记忆 + 会话检索 + 外部 memory provider + skills procedural memory`。
- Skills 在 Hermes 中更像程序性记忆，适合与长期事实记忆分开建模。

## Existing CAFF Patterns
- `server/domain/conversation/turn/agent-prompt.ts`: 已支持动态 skill descriptor 注入；当前 public history budget 为 `24` 条，private mailbox budget 为 `16` 条，说明 recall 价值在于“超出 prompt budget 的按需回忆”，而不是继续堆更多历史。
- `server/domain/conversation/turn/agent-executor.ts`: 已负责声明 agent 可用 bridge 工具、注入 `CAFF_CHAT_*` 环境变量、记录 task event；新增 recall 工具时这里必须同步更新。
- `lib/agent-chat-tools.ts` + `server/api/agent-tools-controller.ts` + `server/domain/runtime/agent-tool-bridge.ts`: 已形成 agent-facing tool 链路，当前支持 `send-public`、`send-private`、`read-context`、`list-participants`、`trellis-init`、`trellis-write`。
- `storage/sqlite/migrations.ts` + `lib/chat-app-store.ts` + `storage/chat/message.repository.ts`: 已有 public/private chat message 持久化，但没有检索索引、search API、diagnostics 或 recall 结果结构。
- `lib/skill-registry.ts`: 已区分本地可写 skills 目录与 project extra skill dirs（只读外部根目录）；这为后续 `published vs draft` 隔离提供了现成语义。
- `server/api/skills-controller.ts`: 现有 skill CRUD 面向 operator，且直接写共享 registry；不适合直接暴露给 agent 做自迭代。
- `server/api/skill-test-controller.ts` + `tests/skill-test/`: 已有成熟的 draft-first 测试与回归框架，天然适合作为 skill publish gate。

## Exact Integration Map
### Storage
- `chat_messages` 已包含 `conversation_id / turn_id / role / sender_name / content / status / created_at`，足够支撑第一版 public episodic recall。
- Phase 1 优先给 public messages 增加 `FTS5` 检索表与同步触发器；如果运行环境不支持 `FTS5`，则保留受限 `LIKE` fallback 或显式 diagnostics，而不是默默改成全量扫描。
- `chat_private_messages` 暂不纳入第一版 recall，避免多 agent 房间里 private mailbox 泄漏与权限模型膨胀。

### Runtime / Tool Bridge
- 新 recall 能力应沿用现有 bridge 形态接入：`lib/agent-chat-tools.ts` → `server/api/agent-tools-controller.ts` → `server/domain/runtime/agent-tool-bridge.ts`。
- `agent-prompt.ts` 只补一条短提示：当需要超出当前注入历史的旧 public 对话时，使用 recall 工具；不要默认把 recall 结果自动塞进 prompt。
- `agent-executor.ts` 需要把新工具加入 expectation / audit 语义，保持 prompt、bridge、trace 三处一致。

### Backend / Wiring
- `server/app/create-server.ts` 是最合适的 wiring 点，用于组装 search helper/store 并注入 agent tool bridge。
- 第一版不强制新增面向 UI 的独立 recall controller；bridge API 已足够支撑 agent 可调用与测试验证。

### Skills / Future Publish Gate
- `lib/skill-registry.ts` 当前的本地 skills 目录属于共享可写状态；后续 skill self-iteration 不能直接写这里，否则会污染所有 agent 的共享工作副本。
- 已发布 shared/project skills 通过 extra skill dirs 进入 registry，且天然只读；后续 proposal 流应新增独立 draft workspace 或 proposal store，再通过 skill-testing 发布到 shared skill 根目录。
- 结论：Phase 1 做 recall；Phase 3 再做 `proposal -> test -> publish`，不要把两个问题在第一刀里耦合。

### Tests
- `tests/storage/chat-store.test.js`: 覆盖索引建立、conversation scope、limit、diagnostics、fallback 行为。
- `tests/runtime/agent-tool-bridge.test.js`: 覆盖 recall 工具请求校验、返回结构、审计事件、对当前 turn 的可见性边界。
- `tests/runtime/turn-orchestrator.test.js`: 覆盖 prompt guidance / expectation 变化，确保默认聊天链路仍保持兼容。
- `tests/runtime/message-tool-trace.test.js`: 如果 recall 工具会影响 live tool trace 展示，需要补 trace 断言。
- `tests/skill-test/*`: Phase 3 再覆盖 proposal/publish gate，本次最小切片先不动。

## Minimal POC Decision
### Chosen Slice
- 只做 **L2 episodic recall** 的 public-message retrieval-first POC。
- 目标是让 agent 能按需回忆同一会话中的旧 public 消息，而不是默认把全部历史塞进 prompt。

### In Scope
- conversation-scoped public message search。
- agent-facing recall/search bridge tool。
- 结果上限、query 校验、snippet 裁剪、diagnostics、审计事件。
- 一条最小 prompt 提示，告诉 agent 何时使用 recall。

### Out Of Scope For POC
- L1 长期 memory 卡写入。
- private message recall。
- 自动 prompt 注入 recall 结果。
- skill proposal / patch draft。
- shared skill publish gate、review UI、外部 memory provider。

### Proposed Tool Contract
- 工具名建议定为 `search-messages`，保持与现有 `send-public` / `read-context` 风格一致。
- 输入：`query`、`limit`（受上限保护，可选）、可选 `beforeMessageId` 或 `beforeCreatedAt` 以后再扩展，第一版可先不做。
- 输出：
  - `query`
  - `searchMode`：`fts5 | like | unavailable`
  - `scope`：`conversation-public`
  - `resultCount`
  - `results[]`：`messageId / role / senderName / createdAt / snippet / score?`
  - `diagnostics[]`：例如 query 过短、fts 不可用、结果被裁剪

### Safety / Governance
- scope 固定为当前 invocation 的 `conversationId`，不允许跨会话搜索。
- 第一版只搜索 `chat_messages`，不碰 `chat_private_messages`。
- query 做长度和空值校验；结果数、snippet 长度、总返回字节数都要封顶。
- tool trace / task event 里保留 `queryPreview`、`limit`、`resultCount`、`searchMode`，便于调试与审计。
- 若底层索引不可用，不得偷偷退化成全库扫描；必须给出清晰 diagnostics。

### Backward Compatibility
- 不改变现有 `24 + 16` 的 prompt history 注入预算。
- agent 不调用 recall 工具时，现有聊天链路保持不变。
- prompt 仅新增简短使用提示，不加入默认 recall payload。
- 如果索引未启用或不可用，功能应以显式 `unavailable` / fallback diagnostics 失败，而不是影响原本会话发送链路。

## Cross-Layer Data Flow
`chat_messages` 写入
→ search index / fallback search repository
→ `agent-tool-bridge` recall handler
→ `agent-chat-tools` CLI 返回结构化结果
→ agent 决定是否把结果总结进当前回复

验证责任：
- controller / bridge 边界：参数校验、conversation scope、limit。
- store / repository 边界：检索、排序、snippet、fallback diagnostics。
- prompt 边界：仅说明工具存在与适用场景，不做隐式注入。

## Later Phase Notes
### L1 Curated Memory
- 已落地第一版 `chat_memory_cards`：固定 `conversation-agent` scope，字段包含 `scope`、`source`、`ttl_days`、`expires_at`、`status`、`updated_at`、`metadata_json`。
- 当前写入口为 agent-facing `save-memory`，读入口为 `list-memories`，都严格绑定当前 invocation 的 `conversationId + agentId`。
- prompt 仅注入当前 agent 在当前 conversation 下的少量活跃 memory cards，不跨 agent、不跨 conversation。
- 写入契约已加入基础扫描：拒绝 secrets/token/password/private key，以及明显的 TODO / 临时状态 / next-step 类内容。
- 当前冲突策略为 `(conversation_id, agent_id, title)` upsert；预算固定为每个 scope 最多 `6` 张 active cards。

### L3 Skill Proposal And Publish Gate
- 新增 `skill_proposals` / `skill_proposal_runs` 或等价存储，记录 proposal、来源 agent、测试结果、发布状态、回滚信息。
- proposal 草案应位于独立 draft workspace，而不是直接写 `skillRegistry.skillsDir` 或 project shared skills root。
- 发布前必须跑现有 `skill-testing`，沿用 draft-first、issues envelope、regression bucket 语义。

## Recommended Next Step
- Phase 1 recall 与 Phase 2 最小 L1 memory 都已落地；下一步优先进入 Phase 3 的 `skill proposal -> skill-testing -> publish gate`。
- 如果继续打磨 memory，可补 `forget/update` 操作、冲突净化、以及更细的 `user/project` 级 scope，但不建议在进入 proposal 流前继续扩张过多表面积。
