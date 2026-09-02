# Agent session 复用（有条件地推翻"每轮新建 session"）

Status: accepted

## 背景与决策

`agent-executor.ts` 此前记录了一个刻意决策：每个 agent turn 新建 provider session，因为完整房间历史每次都注入 prompt，长生命 session 只会带来跨轮污染和中断残留风险。本 ADR 推翻该决策：当**上下文使用率 < 50% 且距上次回复 < 1 小时**（阈值走配置）时，同一 (conversationId, agentId, profileId) 复用上一轮 session（`--resume`），两轮之间的新增对话以**单条 user message 追加到消息数组尾部**，不再全量重注入历史。

动机：全量历史重注入使每轮 input tokens 随房间历史线性增长，prefix KV cache 被动态段（turnId、时间戳、触发信息）击穿，长房间场景成本与延迟都不可接受。

## 关键约束（复用的前置条件，全部满足才复用）

- 复用键 = (conversationId, agentId, profileId)，跨会话不复用。
- prompt 拆分为静态段 / 动态段；静态段（系统提示、skill 集合、agent 身份、工具说明、模型、profile、AGENT_PROMPT_VERSION）做 hash 存入 session 元数据，复用前比对，不一致即失效。
- 上一轮 run 必须 status=success 干净结束；中断/超时/报错结束的 session 标记 poisoned，永不复用。
- 状态机 reusable/busy/poisoned 持久化于 `chat_agent_session_reuse` 表；复用判定与状态翻转在同一事务内，防并发竞态。
- 已读游标记录 session 已见的最后一条 chat_messages.id；复用前校验游标前消息一致性（count + 首尾 id + max(updated_at)），发现编辑/删除痕迹直接 poison（已注入内容无法从 provider session 撤回）。
- delta 消息合并为**一条** user message，与全量历史共用同一个 `formatHistory` 渲染函数，杜绝 fresh/reused 格式双轨。
- 复用是纯优化：任何不确定一律回退旧路径（新 session + 全量历史注入）。复用决策（sessionReused + 原因）写入 message metadata 供审计。

## Considered Options

- **保持每轮新建 session（原决策）**：简单、无污染风险，但 token 成本随历史线性增长，长房间不可用。拒绝。
- **长生命 session + 运行中消息转发**：把运行期间到达的消息实时转发进 provider session。复杂度与竞态面过大；改为 delta 窗口在 prompt 构建瞬间快照关闭，运行中消息走现有路由由下一轮拾取。
- **delta 注入系统提示词**：会破坏 KV cache 前缀，且与消息数组语义不符。拒绝，明确追加到消息数组尾部。
- **复用状态挂到 `chat_conversation_agents` 加列**：该表是成员关系表，状态机 + 审计字段不属于成员关系行；新建独立表，migration 纯增量、可独立回滚。

## Consequences

- 首轮 prompt 必须重构为静态/动态可分离结构；turnId、taskId、时间戳等每轮变化字段严禁进入静态段，否则 hash 比对与 KV cache 同时失效。
- 需要 fresh/reused 双模式回归测试（同一历史场景 A/B），证明复用模式下 agent 能看到并回应 delta 消息且无幻觉引用。
- 交付分两阶段：Phase 1 后端完整实现 + 本 ADR，feature flag 默认 OFF 合入；Phase 2 默认 ON + 前端 agent 开关。先 OFF 验证再翻默认值，避免一次性把风险带进生产路径。

## Known Limitations

- 游标一致性校验依赖 `max(updated_at)` 在编辑/删除后严格前移。正常路径（repository 在 update 时写入当前时钟）成立；若消息行被人为未来日期化（时钟偏移、外部导入回填），对该行的后续编辑可能不会推进 `max(updated_at)`，从而逃过检测。接受该残余风险：它要求数据库被非正常写入，且后果等价于复用了一个含过期历史的 session（模型看到旧版本消息），不产生数据损坏。检测口径记录于 `tests/runtime/session-reuse-ab.test.js` 的夹具设计（显式 `updatedAt` 时间线）。
