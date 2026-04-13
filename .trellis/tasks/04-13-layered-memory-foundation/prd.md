# PRD: Layered Memory Foundation

## Goal

- 将 CAFF 的记忆实现从 Hermes umbrella 任务中拆出，作为独立实现与验收单元。
- 提供可控、可诊断、可回滚的分层记忆基础：L2 episodic recall 与 L1 curated memory cards。
- 保持多 agent 房间安全边界：默认不跨 conversation、不跨 agent、不读取 private mailbox。

## Problem Statement

- CAFF 已有 public/private 消息持久化和 prompt 历史预算，但超出预算的旧 public 消息缺少检索式召回能力。
- CAFF 需要小而硬的长期 memory card 来保存稳定事实，但不能把临时 TODO、密钥或跨人格内容写进共享上下文。
- 记忆链路横跨 SQLite、store、runtime tool bridge、CLI 工具和 prompt 注入；需要独立任务收敛边界和测试。
- 该任务不应被 skill-test isolation / OpenSandbox / skill proposal 发布闸范围拖大。

## Scope

### In Scope

- L2 episodic recall：基于当前 conversation 的 public message 检索，带结果上限、snippet 裁剪、scope 诊断、speaker/agent 发言人筛选和 fallback 诊断。
- L1 curated memory cards：面向当前 `conversation + agent` 的小型长期记忆卡片，支持 TTL/status/source/metadata/budget/upsert。
- Agent-facing bridge tools：`search-messages`、`list-memories`、`save-memory` 以及后续必要的 `forget/update` 安全流。
- Prompt 注入：仅注入当前 agent 在当前 conversation 下的少量 active memory cards；recall 结果默认不自动注入。
- Safety：拒绝 secrets/token/password/private key、明显 TODO/next-step/临时状态，以及越权 scope 写入。
- Regression：覆盖 storage、tool bridge、agent chat tools、turn orchestrator/prompt 的默认兼容性。

### Out Of Scope

- Skill proposal、skill publish gate、OpenSandbox、skill-test isolation。
- 跨 conversation / 跨 agent / 跨 user 的全局共享记忆。
- private message recall。
- 外部向量数据库或复杂 memory provider。
- 大规模前端 memory 管理台。

### Follow-Up Direction: Cross-Conversation L1

- 本期实现仍保持 `conversation + agent` scope，不修改已完成的 foundation 验收边界。
- 当前 CAFF 使用场景默认只有一个本地 human user；后续若将 L1 从“会话内小卡片”提升为真正的长期偏好 / 事实记忆，可先演进为 `local-user + agent` scope，而不是引入开放式全局共享或复杂多用户账号模型。
- 跨会话 L1 默认仍不得跨 agent / 跨 persona 共享；A agent 写入的 durable memory 不应自动暴露给 B agent。
- 如果未来出现多用户或远程共享场景，再将 `local-user` 身份锚点迁移/扩展为明确的 participant/user id，不在 foundation 阶段提前扩大权限边界。
- 写入契约需要比本期更严格：仅允许稳定偏好、长期事实、长期约束或明确长期约定；继续拒绝 secrets、TODO、临时状态、一次性任务结论。
- 读取与 prompt 注入建议采用分层覆盖：优先当前 `conversation + agent` overlay，再读取同一 `local-user + agent` 的 bounded durable cards，并保留来源与 scope 诊断。
- 后续设计需要补齐 local user 身份锚点、upsert key、冲突覆盖规则、撤回 / 更正流，以及 active budget 在 conversation-scope 与 local-user-scope 之间的配额策略。

## Requirements

### 1. Episodic Recall

- Recall scope 固定为当前 invocation 的 conversation public messages。
- 输入必须校验 query 长度、limit 上限，以及可选的 speaker/agent 发言人筛选；不允许无界全库扫描。
- 允许仅按当前 conversation 内的 speaker/agent 发言人做 bounded 检索，但不得借此跨 conversation 或绕过 public scope。
- 输出必须包含 `searchMode`、`scope`、`resultCount`、bounded `results[]`、filters 和 diagnostics。
- FTS5 不可用时必须显式诊断 fallback 或 unavailable，不得静默扩大扫描范围。

### 2. Curated Memory Cards

- Memory card scope 初始固定为 `conversation + agent`，不跨人格、不跨会话。
- 每张 card 至少包含 title/content/source/status/created_at/updated_at/ttl_days/expires_at/metadata。
- 冲突策略以 `(conversation_id, agent_id, title)` upsert 为默认最小实现。
- 活跃预算默认每 scope 最多 6 张 active cards；超预算要有可解释清理或拒绝策略。
- TTL 过期、archived/deleted 状态不得进入 prompt active 注入。

### 3. Tool And Prompt Contract

- Tool bridge 必须从当前 invocation 推导 conversationId/agentId，不接受 agent 自报 scope。
- `save-memory` 只保存稳定偏好、长期事实或明确可复用约束；拒绝 secret 与临时行动项。
- `list-memories` 只列出当前 scope 的 active/可见 cards。
- Prompt 只加入短 guidance 和 bounded memory cards，不改变默认 public/private history budget。

### 4. Safety And Audit

- 写入与读取必须留下足够测试诊断：queryPreview、speaker/agent filters、resultCount、memory title/status、rejection reason、scope。
- Tool trace 或 task event 中不得泄漏完整 secret 内容或过长文本。
- 所有 memory 行为必须在多 agent 共享房间中默认隔离。

## Integration Points

- Storage: `storage/sqlite/migrations.ts`, `storage/chat/message.repository.ts`, `storage/chat/memory-card.repository.ts`
- Store: `lib/chat-app-store.ts`
- Bridge/API/CLI: `server/domain/runtime/agent-tool-bridge.ts`, `server/api/agent-tools-controller.ts`, `lib/agent-chat-tools.ts`
- Runtime prompt: `server/domain/conversation/turn/agent-prompt.ts`, `server/domain/conversation/turn/agent-executor.ts`
- Tests: `tests/storage/chat-store.test.js`, `tests/runtime/agent-tool-bridge.test.js`, `tests/runtime/turn-orchestrator.test.js`, `tests/runtime/agent-chat-tools.test.js`

## Acceptance Criteria

- [x] `search-messages` can retrieve bounded same-conversation public message results with diagnostics and optional speaker/agent filters.
- [x] Memory cards are scoped to current `conversation + agent` and enforce TTL/status/budget rules.
- [x] Unsafe or transient memory writes are rejected with explicit reason.
- [x] Prompt injection includes only bounded active memory cards and preserves existing chat behavior when no memory exists.
- [x] Regression tests cover storage, bridge, CLI output, and prompt/tool guidance.
- [x] No skill-test isolation or OpenSandbox work is mixed into this task.

## Validation Plan

- Run targeted storage tests for message recall and memory card persistence.
- Run runtime bridge tests for `search-messages`, `list-memories`, and `save-memory` scope/rejection behavior, including speaker-filtered recall.
- Run turn orchestrator tests for prompt injection and backward compatibility.
- Run agent chat tools tests for CLI result formatting.

## Notes

- This task owns the memory work already started under the Hermes branch and any follow-up memory hardening.
- Skill proposal and publish gate should consume memory only as ordinary context; they must not be implemented here.
