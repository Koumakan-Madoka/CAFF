# Agent Session 复用

ADR：`docs/adr/0001-agent-session-reuse.md`（推翻"每轮新建 session"的原决策）。

## 判定契约

复用键 = `(conversationId, agentId, profileId)`。普通触发全部满足既有条件才复用；Goal Runner 自动续跑还必须通过下方严格 Goal 连续性门禁。任一不满足都回退旧路径（新 session + 全量历史）：

| 条件 | 不满足时的 reason |
|------|------------------|
| 全局 flag 开（Phase 2 默认 ON，`PI_CHAT_SESSION_REUSE_ENABLED=0/false/off/no` 显式关闭） | `disabled` |
| 该 agent 未关闭复用（`chat_agents.session_reuse_enabled`，默认 1） | `agent_disabled` |
| 存在 reusable 行 | `no_prior_session` |
| 距上次回复 < `PI_CHAT_SESSION_REUSE_MAX_IDLE_MS`（默认 1h） | `idle_timeout` |
| 上次 assistant 调用 input tokens ÷ contextWindow < `PI_CHAT_SESSION_REUSE_MAX_USAGE_RATIO`（默认 0.5） | `usage_ratio_exceeded` |

contextWindow 的来源链路：`resolveSessionReuseContextWindow` 从 `modelCatalog.getOptions()` 匹配 provider+model 并读取 `contextWindow` 字段。该字段必须由装配层透传——`lib/pi-model-catalog-host.mjs` 从 runtime 模型注册表携带（正整数，否则 null），`configured-model-catalog.ts` 的 rebuild 在 models.json 分支与 runtime 默认分支都必须复制该字段（`normalizeContextWindow` 只接受正整数，非法值归一为 null，models.json 值优先、runtime 值兜底）。任一环节丢字段都会导致 usage ratio 解析为 null → `usage_snapshot_missing` → 永远 fresh，且单测用 fake catalog 时不会暴露（必须用真实 `createConfiguredModelCatalog` 覆盖）。
| 静态段 hash 一致 | `static_hash_mismatch` |
| 游标一致性校验通过 | `cursor_history_mutated` → poison |

## Goal Runner 严格复用

仅 `source=goal-runner && goalAutoContinue=true` 的自动续跑使用严格策略；用户消息、mention、handoff 等人工/普通触发继续使用上表的普通策略，不因会话存在 active Goal 而增加门禁。

- Goal 元数据包含不可变 `goalId` 与正整数 `revision`。新建/替换/恢复 Goal 生成新 ID 和 revision 1；同一 Goal 的 objective/status/owner/checklist 变化保留 ID 并递增 revision。
- Goal Runner 消息在 claim 时固化 `goalId + goalRevision`。严格判定要求消息固化值、当前 Goal 和 reusable 行记录的 provider 已知值三方一致。缺失返回 `goal_identity_missing`，ID 不一致返回 `goal_identity_mismatch`，revision 不一致返回 `goal_revision_mismatch`。
- 严格策略的 usage ratio 必须 `< min(普通配置阈值, 0.5)`。因此达到 0.5 必须 fresh，即使 `PI_CHAT_SESSION_REUSE_MAX_USAGE_RATIO` 被配置为更高；配置为更低值时更低值继续生效。
- reusable 行的 nullable `goal_id/goal_revision` 表示该 provider Session 最近实际收到的 Goal 版本。fresh 完整 prompt 成功后记录当前 Goal；resume 未重新投递 Goal 段，因此成功后继承 claim 前值，绝不能把外部发生的新 revision 冒充为 provider 已知。
- 原子 claim 同时使用 null-safe equality 守卫 `goal_id/goal_revision`。旧 schema 行迁移后为 null/null：普通触发兼容，严格 Goal Runner 以 `goal_identity_missing` fresh，并在首次干净 fresh 成功后自愈。
- checklist 更新在同一 metadata 写中迁移同 Goal runner 的 `goalUpdatedAt` key，保留 iteration 与失败 streak；这修复了每次 checklist 更新后 continuation iteration 回到 1 的问题。

### Signatures And Fields

```text
sessionGoal = { goalId, revision, objective, status, ... }
Goal Runner message.metadata = { source:'goal-runner', goalAutoContinue:true,
                                goalId, goalRevision, goalIteration, ... }
chat_agent_session_reuse = { ..., goal_id NULL|TEXT, goal_revision NULL|INTEGER }
evaluateSessionReuse({ ..., goal:{ strict, goalId, goalRevision,
                                   triggerGoalId, triggerGoalRevision } })
```

### Strict Validation Matrix

| Case | Result |
| --- | --- |
| trigger/current/row ID and revision match; ratio `< min(config, 0.5)` | continue ordinary checks; eligible to resume |
| any Goal evidence missing or malformed | fresh / `goal_identity_missing` |
| trigger or row ID differs from current Goal | fresh / `goal_identity_mismatch` |
| trigger or row revision differs from current Goal | fresh / `goal_revision_mismatch` |
| ratio exactly `0.5`, with ordinary config `0.8` | fresh / `usage_ratio_above_threshold` |
| human-triggered run with mismatched row Goal evidence | Goal gates skipped; ordinary decision remains authoritative |

### Good / Base / Bad

- Good: a fresh Goal run stores revision 4; the next revision-4 Goal Runner message resumes below 50%.
- Base: an upgraded null/null row can still serve a human message, but the first Goal Runner continuation goes fresh and self-heals its evidence.
- Bad: overwrite the row with the current Goal revision after an ordinary resume that delivered only `session_delta`; the provider never saw that Goal section.
- Bad: apply a configured 80% ordinary threshold to Goal Runner; the strict 50% boundary is user-authorized and must still force fresh.

### Wrong vs Correct

```ts
// Wrong: records metadata state that was not delivered on resume.
markReusable({ goalId: currentGoal.goalId, goalRevision: currentGoal.revision });

// Correct: fresh records the delivered full Goal; resume inherits the claim.
markReusable({
  goalId: resume ? claimed.goalId : currentGoal?.goalId ?? null,
  goalRevision: resume ? claimed.goalRevision : currentGoal?.revision ?? null,
});
```

busy 行超过 `PI_CHAT_SESSION_REUSE_BUSY_STALE_MS`（默认 2h）视为僵尸 → `busy_stale` poison。claim 冲突 → `claim_conflict`；判定异常 → `reuse_evaluation_error`。

## 状态机（`chat_agent_session_reuse`）

- `reusable → busy`：`claimAgentSessionReuse` 单条 UPDATE 完成。调用必须携带 `expectedHash`、`expectedCursorMessageId`、`expectedCursorMessageCount`、`expectedCursorFirstMessageId`、`expectedCursorMaxUpdatedAt` 以及私聊边界 `(expectedPrivateCursorMessageId, expectedPrivateCursorMessageCreatedAt, expectedPrivateCursorInitialized)`；SQL 同时比较复用行快照并从 `chat_messages` 重算游标前缀。任一不一致返回 `null`，不得启动 `--resume`；executor 随后重读 reusable 行，若游标校验已变异则先 poison 并审计具体 cursor reason，否则记 `claim_conflict`。
- `busy → reusable`：run 干净结束 `markAgentSessionReuseReusable`。executor 在 provider 启动前冻结本次公共和授权私聊边界；fresh 记录实际投递的 mailbox 边界，resume 只追加私聊游标之后的新可见消息并推进到本轮实际投递的最后一条。run 期间到达的消息保持在游标之后。upsert 可覆盖 poisoned 行以自愈，但不得用不同 `session_name` 覆盖 busy 行；只有持有该 session 的完成/恢复路径能执行 `busy → reusable`。
- `busy → reusable`（未触网中止）：`restoreAgentSessionReuse` 写回 claim 前快照。
- `* → poisoned`：`markAgentSessionReusePoisoned`，保留 session_path 供审计；poisoned 永不复用。

## 关键结构

- 配置解析：`resolveSessionReuseConfig(env)`（`server/domain/conversation/turn/session-reuse.ts`）。env 未设置时 Phase 2 默认 `enabled: true`。
- per-agent 门禁：executor 内 `agent.sessionReuseEnabled === false` → 跳过整个复用生命周期（不读表、不写回），metadata reason = `agent_disabled`。
- delta 注入：executor 先调用 `buildPromptMessages(delta, promptUserMessage, { currentTurnId, excludeIncompleteAssistantMessages: true })`，再将公共 delta 与授权私聊 delta 传给 `buildSessionReuseDeltaPrompt(delta, agents, privateDeltaMessages)`。这与 fresh 路径共用 private-only 与当前 turn 未完成 assistant 的可见性规则：其他 private-only 消息不可见，queued/streaming assistant 不进入 resumed prompt。旧复用行若没有可证明的私聊边界返回 `private_cursor_missing` 并 fresh 自愈；新行只追加该 Agent 可见且位于私聊边界之后的消息。fresh 路径通过 `requiredMessageIds` 保证触发消息必达；reused 路径若发现已清洗的 `promptUserMessage` 不在可见 delta 中（例如 private handoff 已被中间 run 的存储游标越过），必须将该 anchor 追加到 delta 尾部，不能让原文泄露或让触发消息静默丢失。最终文本继续共用 `formatHistory` 的逐条格式并使用 `{ truncate: false }`，公共游标后的全部可见消息合并为一个 user message，私聊 delta 使用独立 mailbox 段且不重复整个 mailbox，不能套用全量历史的 `MAX_HISTORY_MESSAGES=24` 窗口。
- 游标推进：复用生命周期启用时，executor 在调用 provider 前用同一时刻的完整 `store.listMessages(conversationId)` 冻结游标基线；该基线是存储一致性口径，不等于 prompt 投影。fresh prompt 即使只渲染最近 24 条或过滤 private-only 消息，仍以完整存储前缀建立下一轮 claim 可校验的快照；这与旧路径中窗口外/不可见消息不再注入的语义一致。收尾用 `appendSessionReuseCursorMessage(snapshot, assistantMessageDone)` 只加入本轮 assistant，禁止成功后重新读取全量消息，以免吞掉 run 期间到达的消息。
- `chat_agent_session_reuse` 的可复用行除公共 cursor 外，还持久化 `private_cursor_message_id`、`private_cursor_message_created_at` 和 `private_cursor_initialized`。该 cursor 只针对当前 Agent 有权限看到的 `chat_private_messages`，按 `(created_at, id)` 排序；resume 查询只取 cursor 之后的授权行。旧 schema 通过 additive `ensureColumn` 迁移，默认 initialized=0，判定返回 `private_cursor_missing` 并 fresh 自愈，不能把旧 null/null 当作 provider 已知空 mailbox。
- 静态段 hash：`computeStaticPromptHash(sections, [provider, model, profileId, thinking])`；7 个 dynamic 段不进 hash（见 `agent-prompt.ts` 的 stability 标签）。
- 审计：queued/final/error metadata 均带 `sessionReused` + `sessionReuseReason`；Goal run 还带 `goalAutoContinue`、当前 `goalId` 与 `goalRevision`。
- Inspector 快照：executor 必须区分判定前的 `promptSections`（用于静态 hash/fresh fallback）与实际 `deliveredPromptSections`。fresh 使用完整 sections；成功 claim 后 resume 使用唯一 `session_delta` section，并从它格式化实际 `startRun` prompt。snapshot schema v2 写 `deliveryMode=fresh|resume`；resume 的 `retainedSessionPrefix` 只引用 session name、static hash、cursor 四元组与 last reply，不得把游标前历史重新渲染为本轮 sections。详情 API 的 `runEvidence` 从完成消息 session-reuse/token/model usage 投影 cache-read 等运行后指标，不修改不可变快照。缺少 delivery 字段的 schema v1 存量记录归一为 `unknown`；可依据 `runEvidence.sessionReused` 标记“旧版 Resume、分区口径不可靠”，但不得冒充 fresh 或精确 delta。

## API / 前端

- `PUT /api/agents/:id` 接受 `sessionReuseEnabled`（family 与 custom 角色的 `editableFields` 均含该字段）；请求体缺省时保留存量值。
- `public/personas/role-editor.js` 渲染"复用上一次会话" toggle；`management-utils.js#buildRolePayload` 总是携带该字段（`role.sessionReuseEnabled !== false`）。
- 可观测性文案必须把 Session 生命周期与 provider cache 分开：fresh 首次调用显示“新建 Session”，resume 首次调用显示“复用旧 Session”；`coldStartModelCallCount` 继续作为兼容字段，但不再作为用户可见 Session 文案。Trace Inspector 沿 resume 快照的 `retainedSessionPrefix.cursorMessageId` 提供最多 8 层元数据 lineage，绝不重渲染旧 prefix 内容。

## 验证矩阵（测试点）

- `tests/runtime/session-reuse-decision.test.js`：配置默认 ON + env kill switch、普通判定矩阵、严格 Goal identity/revision/50% 门禁、游标校验、delta parity，以及超过 24 条 delta 时首尾消息均保留。
- `tests/storage/session-reuse-repository.test.js`：原子 claim、hash/Goal 身份/revision、公共和私聊 cursor 守卫、Goal 字段 round-trip/restore、授权私聊 after-cursor 查询、claim 前编辑/删除真实消息前缀均拒绝、poison 不可逆、schema 约束，以及不同 fresh session 不得覆盖另一 run 的 busy claim。
- `tests/runtime/session-reuse-ab.test.js`：flag OFF 字节级不变、普通复用全链路、Goal Runner 同 ID/revision 且 `<50%` resume、revision 变化与 `=50%` fresh、人工触发不收紧、provider 已知 Goal 版本写回/继承、claim 先于 startRun、完整公共 cursor 指纹和私聊 mailbox cursor 下传、delta-only prompt、resume snapshot 的唯一 `session_delta` 与实际 prompt 逐字一致且不含游标前历史、授权私聊新消息进入 delta 且旧消息不重复、retained prefix 仅为引用、判定后/claim 前编辑触发 poison、运行中新增消息留给下一轮、private-only 与当前 turn 未完成 assistant 采用 fresh 可见性投影、已被中间游标越过的 private handoff 仍以清洗后 anchor 必达、`busy_stale` 审计、per-agent 关闭、编辑即 poison + 自愈；另经真实 routing executor 以最近 24 条 prompt 投影运行超过 24 条的会话，验证 fresh 建立完整游标且下一轮实际 resume。
- `tests/runtime/context-snapshot.test.js` + `tests/http/context-snapshot-pagination.test.js` + `tests/ui/context-inspector.test.js`：schema v2 delivery 字段/Markdown、详情 API post-run cache evidence、UI 的 resume/delta/retained prefix 展示口径。
- `tests/storage/chat-store.test.js`：toggle 持久化、默认 ON、重开库（reconcile）不重置。
- `tests/smoke/server-smoke.test.js`：family 角色 API round-trip 与缺省保留。

## Known Limitations

游标校验依赖 `max(updated_at)` 在编辑后严格前移；被人为未来日期化的消息行后续编辑可能逃过检测（详见 ADR Known Limitations）。并行批次冻结游标时若纳入同 turn 的未完成 peer assistant，该 peer 完成会使下轮一致性检查 poison 并回退 fresh；此路径不会泄露或丢失消息，但会损失一次复用命中。
