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

- `reusable → busy`：`claimAgentSessionReuse` 单条 UPDATE 完成（判定与翻转同事务，hash 作 WHERE 守卫）。
- `busy → reusable`：run 干净结束 `markAgentSessionReuseReusable`（重算游标含本轮回复 + usage 快照；upsert 可覆盖 poisoned 行，自愈）。
- `busy → reusable`（未触网中止）：`restoreAgentSessionReuse` 写回 claim 前快照。
- `* → poisoned`：`markAgentSessionReusePoisoned`，保留 session_path 供审计；poisoned 永不复用。

## 关键结构

- 配置解析：`resolveSessionReuseConfig(env)`（`server/domain/conversation/turn/session-reuse.ts`）。env 未设置时 Phase 2 默认 `enabled: true`。
- per-agent 门禁：executor 内 `agent.sessionReuseEnabled === false` → 跳过整个复用生命周期（不读表、不写回），metadata reason = `agent_disabled`。
- delta 注入：`buildSessionReuseDeltaPrompt(delta, agents)` 与全量历史共用 `formatHistory`，外包固定头 `New messages since your last reply:`，追加到消息数组尾部保 KV cache。
- 静态段 hash：`computeStaticPromptHash(sections, [provider, model, profileId, thinking])`；7 个 dynamic 段不进 hash（见 `agent-prompt.ts` 的 stability 标签）。
- 审计：queued/final/error metadata 均带 `sessionReused` + `sessionReuseReason`。

## API / 前端

- `PUT /api/agents/:id` 接受 `sessionReuseEnabled`（family 与 custom 角色的 `editableFields` 均含该字段）；请求体缺省时保留存量值。
- `public/personas/role-editor.js` 渲染"复用上一次会话" toggle；`management-utils.js#buildRolePayload` 总是携带该字段（`role.sessionReuseEnabled !== false`）。

## 验证矩阵（测试点）

- `tests/runtime/session-reuse-decision.test.js`：配置默认 ON + env kill switch、判定矩阵、游标校验、delta parity。
- `tests/storage/session-reuse-repository.test.js`：原子 claim、hash 守卫、restore、poison 不可逆、schema 约束。
- `tests/runtime/session-reuse-ab.test.js`：flag OFF 字节级不变、复用全链路（claim 先于 startRun、delta-only prompt、游标推进）、per-agent 关闭、编辑即 poison + 自愈。
- `tests/storage/chat-store.test.js`：toggle 持久化、默认 ON、重开库（reconcile）不重置。
- `tests/smoke/server-smoke.test.js`：family 角色 API round-trip 与缺省保留。

## Known Limitations

游标校验依赖 `max(updated_at)` 在编辑后严格前移；被人为未来日期化的消息行后续编辑可能逃过检测（详见 ADR Known Limitations）。
