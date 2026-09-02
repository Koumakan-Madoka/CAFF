# Agent Session 复用

ADR：`docs/adr/0001-agent-session-reuse.md`（推翻"每轮新建 session"的原决策）。

## 判定契约

复用键 = `(conversationId, agentId, profileId)`。全部满足才复用，任一不满足回退旧路径（新 session + 全量历史）：

| 条件 | 不满足时的 reason |
|------|------------------|
| 全局 flag 开（Phase 2 默认 ON，`PI_CHAT_SESSION_REUSE_ENABLED=0/false/off/no` 显式关闭） | `disabled` |
| 该 agent 未关闭复用（`chat_agents.session_reuse_enabled`，默认 1） | `agent_disabled` |
| 存在 reusable 行 | `no_prior_session` |
| 距上次回复 < `PI_CHAT_SESSION_REUSE_MAX_IDLE_MS`（默认 1h） | `idle_timeout` |
| 上次 assistant 调用 input tokens ÷ contextWindow < `PI_CHAT_SESSION_REUSE_MAX_USAGE_RATIO`（默认 0.5） | `usage_ratio_exceeded` |
| 静态段 hash 一致 | `static_hash_mismatch` |
| 游标一致性校验通过 | `cursor_history_mutated` → poison |

busy 行超过 `PI_CHAT_SESSION_REUSE_BUSY_STALE_MS`（默认 2h）视为僵尸 → `busy_stale` poison。claim 冲突 → `claim_conflict`；判定异常 → `reuse_evaluation_error`。

## 状态机（`chat_agent_session_reuse`）

- `reusable → busy`：`claimAgentSessionReuse` 单条 UPDATE 完成。调用必须携带 `expectedHash`、`expectedCursorMessageId`、`expectedCursorMessageCount`、`expectedCursorFirstMessageId`、`expectedCursorMaxUpdatedAt`；SQL 同时比较复用行快照并从 `chat_messages` 重算游标前缀的 count / first id / max(updated_at)。任一不一致返回 `null`，不得启动 `--resume`；executor 随后重读 reusable 行，若游标校验已变异则先 poison 并审计具体 cursor reason，否则记 `claim_conflict`。
- `busy → reusable`：run 干净结束 `markAgentSessionReuseReusable`。executor 在 provider 启动前冻结本次游标边界，收尾通过 `appendSessionReuseCursorMessage(baseSnapshot, assistantMessageDone)` 只追加本轮回复；run 期间到达的消息保持在游标之后。upsert 可覆盖 poisoned 行以自愈，但不得用不同 `session_name` 覆盖 busy 行；只有持有该 session 的完成/恢复路径能执行 `busy → reusable`。
- `busy → reusable`（未触网中止）：`restoreAgentSessionReuse` 写回 claim 前快照。
- `* → poisoned`：`markAgentSessionReusePoisoned`，保留 session_path 供审计；poisoned 永不复用。

## 关键结构

- 配置解析：`resolveSessionReuseConfig(env)`（`server/domain/conversation/turn/session-reuse.ts`）。env 未设置时 Phase 2 默认 `enabled: true`。
- per-agent 门禁：executor 内 `agent.sessionReuseEnabled === false` → 跳过整个复用生命周期（不读表、不写回），metadata reason = `agent_disabled`。
- delta 注入：executor 先调用 `buildPromptMessages(delta, promptUserMessage, { currentTurnId, excludeIncompleteAssistantMessages: true })`，再将结果传给 `buildSessionReuseDeltaPrompt(delta, agents)`。这与 fresh 路径共用 private-only 与当前 turn 未完成 assistant 的可见性规则：其他 private-only 消息不可见，queued/streaming assistant 不进入 resumed prompt。fresh 路径通过 `requiredMessageIds` 保证触发消息必达；reused 路径若发现已清洗的 `promptUserMessage` 不在可见 delta 中（例如 private handoff 已被中间 run 的存储游标越过），必须将该 anchor 追加到 delta 尾部，不能让原文泄露或让触发消息静默丢失。最终文本继续共用 `formatHistory` 的逐条格式并使用 `{ truncate: false }`，游标后的全部可见消息合并为一个 user message，不能套用全量历史的 `MAX_HISTORY_MESSAGES=24` 窗口。
- 游标推进：复用生命周期启用时，executor 在调用 provider 前用同一时刻的完整 `store.listMessages(conversationId)` 冻结游标基线；该基线是存储一致性口径，不等于 prompt 投影。fresh prompt 即使只渲染最近 24 条或过滤 private-only 消息，仍以完整存储前缀建立下一轮 claim 可校验的快照；这与旧路径中窗口外/不可见消息不再注入的语义一致。收尾用 `appendSessionReuseCursorMessage(snapshot, assistantMessageDone)` 只加入本轮 assistant，禁止成功后重新读取全量消息，以免吞掉 run 期间到达的消息。
- 静态段 hash：`computeStaticPromptHash(sections, [provider, model, profileId, thinking])`；7 个 dynamic 段不进 hash（见 `agent-prompt.ts` 的 stability 标签）。
- 审计：queued/final/error metadata 均带 `sessionReused` + `sessionReuseReason`。

## API / 前端

- `PUT /api/agents/:id` 接受 `sessionReuseEnabled`（family 与 custom 角色的 `editableFields` 均含该字段）；请求体缺省时保留存量值。
- `public/personas/role-editor.js` 渲染"复用上一次会话" toggle；`management-utils.js#buildRolePayload` 总是携带该字段（`role.sessionReuseEnabled !== false`）。

## 验证矩阵（测试点）

- `tests/runtime/session-reuse-decision.test.js`：配置默认 ON + env kill switch、判定矩阵、游标校验、delta parity，以及超过 24 条 delta 时首尾消息均保留。
- `tests/storage/session-reuse-repository.test.js`：原子 claim、hash 与游标四元组守卫、claim 前编辑/删除真实消息前缀均拒绝、restore、poison 不可逆、schema 约束，以及不同 fresh session 不得覆盖另一 run 的 busy claim。
- `tests/runtime/session-reuse-ab.test.js`：flag OFF 字节级不变、复用全链路（claim 先于 startRun、完整游标指纹下传、delta-only prompt）、判定后/claim 前编辑触发 poison、运行中新增消息留给下一轮、private-only 与当前 turn 未完成 assistant 采用 fresh 可见性投影、已被中间游标越过的 private handoff 仍以清洗后 anchor 必达、`busy_stale` 审计、per-agent 关闭、编辑即 poison + 自愈；另经真实 routing executor 以最近 24 条 prompt 投影运行超过 24 条的会话，验证 fresh 建立完整游标且下一轮实际 resume。
- `tests/storage/chat-store.test.js`：toggle 持久化、默认 ON、重开库（reconcile）不重置。
- `tests/smoke/server-smoke.test.js`：family 角色 API round-trip 与缺省保留。

## Known Limitations

游标校验依赖 `max(updated_at)` 在编辑后严格前移；被人为未来日期化的消息行后续编辑可能逃过检测（详见 ADR Known Limitations）。并行批次冻结游标时若纳入同 turn 的未完成 peer assistant，该 peer 完成会使下轮一致性检查 poison 并回退 fresh；此路径不会泄露或丢失消息，但会损失一次复用命中。
