---
feature_ids: [F003]
related_features: [F002]
topics: [chat, cross-conversation, delivery, mcp, pi, tree-navigation, handoff, reliability]
doc_kind: spec
created: 2026-08-05
---

# F003: Cross-Conversation Delivery, Child Conversation Tree, and Pi MCP Bridge

> **Status**: in-progress | **Owner**: @cat-ir4rwo6b | **Priority**: P1

## Why

CAFF 的 Agent 目前只能在当前聊天室内发言、私信和使用 invocation-scoped 工具；当工作需要交给另一个聊天室时，没有明确寻址、持久状态、回执、失败恢复或安全的 Pi MCP 调用路径。operator 也无法把相关聊天室组织成可查找的树。最终体验应是：Agent 能可靠地把消息或请求交给另一个聊天室的指定 Agent，operator 在原地看见全过程，并能从当前聊天室创建一个全新的子聊天室，用一条完整首消息启动主理 Agent，而不是复制父聊天室形成隐式 Fork。

## Current State / 现状基线

基线：`origin/main@edb134b4213f36942134b4b1266e96c2d82a4b32`（2026-08-05）。

- `chat_conversations` 只有 `id/title/type/metadata/timestamps`，没有项目作用域、父子关系或创建来源字段；`chat_messages` 没有跨聊天室 delivery 真相源（`storage/sqlite/migrations.ts:289-344`）。
- 会话 header 按最近活动全局排序（`storage/chat/conversation.repository.ts:10-32`），左侧列表逐项扁平 `forEach` 渲染（`public/chat/conversation-list.js:16-101`）。
- 最新创建路径已经要求至少一位显式 participant，缺失或空数组会 fail closed（`lib/chat-app-store.ts:2134-2173`）；F003 应复用该契约，不恢复隐式参与者 fallback。
- `agent-tool-bridge` 使用 invocation ID + callback token，并把 read/post/search/participants 绑定到 `context.conversationId`（`server/domain/runtime/agent-tool-bridge.ts:512-535, 819-870, 1036-1118, 1394-1455`）。它已有可信 principal 注入点，但没有目标 conversation 参数、delivery 状态机或 MCP capability gateway。
- `turn-orchestrator` 已有定向单 Agent side-dispatch、任务记录和重启恢复测试（`server/domain/conversation/turn-orchestrator.ts:899-980`; `tests/runtime/turn-orchestrator.test.js:3107-4158`），可作为跨聊天室定向执行扩展点。
- Pi SDK Host 已支持 `extensionPaths` 并在 prompt 前 bind extensions（`lib/pi-sdk-host.mjs:76-92, 123-137`; `lib/pi-runtime.ts:378-382`），但 CAFF 没有把白名单 MCP/internal capability 变成 Pi-native facade tool 的受控桥。
- 当前 UI 已有新建聊天室 dialog、移动端会话抽屉，以及 `running/success/failed/neutral` trace pill、live rotor 和失败 note；F003 应复用这些交互与 token，不新造第二套状态语言。

## What

### Phase A: Durable Cross-Conversation Delivery Core

- 新增 `notify`、`request` 和供 Phase C 使用的 `bootstrap` delivery kind；v1 每个 delivery 精确寻址一个目标 conversation 和一个目标 participant Agent，广播/fan-out 由调用方显式创建多条 delivery，而不是一个 envelope 隐式扩散。
- delivery row 本身是可 claim 的 durable dispatch/outbox；append-only event/attempt 记录承载审计与恢复，不另造内存队列真相源。
- 将 message persistence、dispatch 和 response 拆为三个正交状态，避免“已落消息”和“Agent 已执行”被一个 status 混淆。
- Agent 发送者身份从 invocation principal 注入；模型参数不能自报 sender、source conversation、server credential 或权限范围。
- `notify/request` 的目标消息使用低权限 external peer 语义并带 provenance，不伪装 operator/user/system。定向执行复用 side-dispatch，不触发目标聊天室的全 participant 主 turn。
- `request` 首版单 responder；目标 Agent 的最终回答自动生成 correlated reply，回源后更新 receipt，但默认不自动唤醒源 Agent，避免乒乓循环。
- 实现幂等、重启恢复、受限自动重试、超时、取消、late reply 和 trace/hop loop guard。
- 增加可执行的 conversation project scope。Agent delivery 仅允许 source/target 都绑定同一非空 project scope；legacy 未绑定聊天室默认不可被 Agent 跨聊天室寻址，必须由 operator 显式绑定。

### Phase B: CAFF-Owned Pi MCP Capability Bridge

- 通过 CAFF-owned Pi extension 注册固定 facade tools；Pi 看到的是业务语义参数，不是 MCP transport/server/tool 的通用代理面。
- CAFF server-side capability registry 将 facade 映射到固定 internal capability 或 operator 配置并白名单化的 MCP tool；连接信息、headers、command、env、server URL 和真实 tool name 不进入模型参数或结果。
- F003 首批 facade 覆盖 cross-conversation `notify` 和 `request`；所有调用复用 Phase A principal、权限、幂等和审计。
- bridge fail closed：未注册 facade、schema 不符、目标超出权限、credential 过期或 MCP 结果无法通过 projection 时拒绝，不自动 fallback 到任意 HTTP/shell/tool call。

### Phase C: New Child Conversation + Complete Initial Message + Tree UI

- `spawn` 是一个产品动作、三个持久原子：创建全新 conversation、写入父子/来源 provenance、持久化一条 operator 确认的完整 `initialMessage` 与 `bootstrap` delivery。
- 新聊天室的 participants、主理 Agent、项目配置必须显式选择；不复制父聊天室历史、摘要、participants、模型、Skills、状态或任务。
- `initialMessage` 是新聊天室第一条公开 user message，所有 participants 与 operator 都能看到；默认只 side-dispatch 第一个主理 Agent，其他 participants 不自动启动。
- 数据事务提交后才执行 bootstrap worker。若执行失败，新聊天室保留，来源与目标现场显示 warning/retry；不会删除 operator 已看见的聊天室。
- 左侧扁平卡片列表升级为紧凑 tree row；桌面常驻侧栏、移动端复用既有 hamburger drawer。节点派生入口复用新建聊天室 dialog/sheet，而不是在窄树行内塞第二套表单。
- 来源聊天室显示独立 durable receipt card；目标消息显示可点击 provenance；树节点、receipt 和目标现场同步 queued/running/succeeded/failed/cancelled/response 状态。

## User Journey

### Primary Journey: 从当前聊天室把任务交给另一个聊天室

- **Scope unit**: conversation delivery
- **Actor**: CAFF Agent，operator 旁观并可干预
- **Entry**: Agent 在当前 conversation 的 Pi facade tool 中选择另一个 conversation 与其中一位 participant Agent
- **Flow**:
  1. Agent 发送 `notify` 或 `request`，CAFF 立即在当前聊天现场落一个持久 receipt。
  2. receipt 显示目标聊天室、目标 Agent、delivery kind 与 queued/running 状态；刷新页面后状态仍在。
  3. 目标聊天室出现带来源 conversation、发送者和 request deadline 的 provenance 消息；只有目标 Agent 被定向启动。
  4. `request` 完成后，回答回到来源 conversation，receipt 变为“已回复”；来源 Agent 不被自动再次唤醒。
  5. 若权限、投递、执行或响应失败，receipt 原位显示人话原因与合法的重试/取消动作。
- **Success evidence**: SQLite state/event assertions + restart fixture + source/target desktop and 375px screenshots
- **Non-goals**: 同步 RPC、跨项目默认放行、隐式广播全部 participants

### Supporting Journey: 从当前节点创建一个全新子聊天室

- **Scope unit**: conversation tree node
- **Actor**: operator
- **Entry**: 左侧会话树节点的“派生子聊天室”入口
- **Flow**:
  1. operator 打开复用的新建聊天室 dialog/sheet，看到固定父节点，并显式填写标题、项目、participants、主理 Agent和完整 `initialMessage`。
  2. 提交后新节点立即出现在父节点下；新聊天室只包含该首消息，不包含父聊天室历史或快照。
  3. 首消息公开可见，主理 Agent自动开始；其他 participants 之后按正常聊天室规则参与。
  4. bootstrap 执行失败时聊天室仍可进入，出生证明卡显示来源、失败原因与重试。
- **Evidence**: API transaction tests + browser fixture/video covering desktop tree and mobile drawer

### Supporting Journey: 处理 legacy 未绑定项目聊天室

- **Scope unit**: conversation permission boundary
- **Actor**: operator
- **Flow**: Agent 试图寻址 legacy conversation → CAFF fail closed 并在 receipt 显示“目标聊天室未绑定项目” → operator 在会话设置中显式绑定后重试。
- **Evidence**: permission test + UI failure/recovery screenshot

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | Agent 能明确寻址另一个聊天室，发送消息或请求 | AC-A1, AC-A5 | API/domain tests + two-conversation fixture | [x] |
| R2 | 原聊天室能看到发送状态、来源、回执、失败与重试 | AC-A2, AC-C4 | persisted receipt assertions + screenshots | [x] |
| R3 | “Pi 原生不支持 MCP，但允许通过受控 bridge 使用 MCP” | AC-B1, AC-B2, AC-B3 | facade/schema/security tests | [x] |
| R4 | “派生子聊天室的功能也要一起做……左侧体现树状结构” | AC-C1, AC-C3, AC-C5 | spawn tests + desktop/mobile browser evidence | [x] |
| R5 | 新聊天室，不是 Fork | AC-C2 | history/participant/config non-copy assertions | [x] |
| R6 | “一条写得足够完整的首条交接消息就够了” | AC-C1, AC-C2 | first-message and prompt fixture | [x] |
| R7 | participants、主理 Agent、项目配置显式指定 | AC-C1 | request validation tests | [x] |
| R8 | 自动启动失败时聊天室保留并可重试 | AC-C3 | crash/failure recovery fixture | [x] |
| R9 | 不产生 recipient-only 暗上下文 | AC-C2 | prompt + UI visibility assertions | [x] |
| R10 | 树是导航/来源，不自动授予通信权 | AC-A3 | permission matrix tests | [x] |

### 覆盖检查

- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（见 Design Gate）

## Acceptance Criteria

### Phase A: Durable Cross-Conversation Delivery Core

- [x] AC-A1: `notify` 与单 responder `request` 共用一套 durable delivery contract；每条 delivery 只能寻址一个目标 conversation + 一个当前 participant Agent，source/target message projection 均关联同一 delivery ID。
- [x] AC-A2: delivery 的 message/dispatch/response 三组状态及 append-only events 在 SQLite 中持久化；页面刷新和进程重启后可恢复 receipt、目标 provenance 与合法下一动作。
- [x] AC-A3: Agent sender/source 由 invocation principal 注入；target 必须存在、与 source 同一非空 project scope、target Agent 为当前 participant。树关系不授予权限，unbound/different-project/非 participant/self-conversation 均 fail closed 并有测试。
- [x] AC-A4: 同 principal + facade + idempotency key 只产生一条 delivery/目标消息；提交后 enqueue 前崩溃可恢复，目标 invocation 已启动后不得自动重执行；queued cancel、running best-effort stop、timeout 与 late reply 均有确定状态和测试。
- [x] AC-A5: 跨聊天室执行使用单 Agent side-dispatch，不进入目标 conversation 主 turn；request 最终回答自动关联回源但不自动唤醒源 Agent。loop guard 拒绝同 trace 重复有向 edge，reply 反向 edge 仅允许一次，`maxHop=8`。

### Phase B: CAFF-Owned Pi MCP Capability Bridge

- [x] AC-B1: Pi SDK Host 通过 CAFF-owned extension 获得固定 facade tools；模型可见 schema 不包含 server URL/ID、transport、command、env、headers、credential、真实 MCP tool name 或通用 `{server, tool, arguments}` 代理。
- [x] AC-B2: server-side capability registry 只调用显式 allowlist 的 internal/MCP capability，并注入 invocation principal、project scope、trace 与 idempotency；未知 facade、参数越界、过期 token 和 result projection 失败均 fail closed。
- [x] AC-B3: `conversation_notify` 与 `conversation_request` 端到端通过同一 bridge 进入 Phase A delivery service，调用与结果均进入现有 agent tool trace 和 delivery event 审计，敏感配置不进入 prompt、timeline、日志或 API 响应。
- [x] AC-B4: bridge 有至少一条真实 MCP transport fixture、断连/超时/恶意参数 fixture，以及“不得降级为 shell/HTTP 通用代理”的回归测试。

### Phase C: New Child Conversation + Complete Initial Message + Tree UI

- [x] AC-C1: spawn API/UI 必须显式提供 title、project scope、participants、primary Agent 和非空 `initialMessage`；单事务持久化新 conversation、parent/origin provenance、participants、第一条公开 message 与 `bootstrap` delivery/outbox row。
- [x] AC-C2: 新聊天室不复制父历史、摘要、participants、模型 Profile、Skills、任务或状态；`initialMessage` 是所有 participants 可见的第一条 user message，只有 primary Agent 自动 side-dispatch，且其 authority 不高于后续 operator 输入。
- [x] AC-C3: DB 事务失败不产生半个聊天室；事务成功后的 bootstrap dispatch 失败保留聊天室并显示 retry。重试不重复创建 conversation、message 或 delivery。
- [x] AC-C4: source receipt、target provenance、tree node 三处使用同一 persisted state，复用现有 trace pill/tone/live rotor；正常路径低噪音，失败提供人话原因、重试/取消/跳转，SSE 只做 patch，DB 是刷新后的真相源。
- [x] AC-C5: desktop 左侧渲染稳定 tree row，选中节点自动展开祖先；mobile 复用既有 drawer，节点选择后关闭。1440px 与 375px 证据覆盖空态、根/子/孙、queued/running/failed/responded、折叠与深链。
- [x] AC-C6: conversation sibling ordering 在状态更新和 SSE 刷新时保持稳定，不因子节点消息活动重排整棵树；v1 禁止拖拽/reparent，达到最大深度时给出明确新建根聊天室引导。
- [x] AC-C7: `npm run check`、`npm run typecheck`、focused storage/runtime/UI tests、`npm run test:fast`、`npm run test:smoke` 和隔离 SQLite browser verification 全部通过；测试不得连接 Redis 6399 或生产用户数据。

## Dependencies

- **Evolved from**: N/A — CAFF 首个跨 conversation delivery / tree / MCP bridge Feature
- **Blocked by**: None — Design Gate 两项确认已由 operator 在 message `0001785912003140-001436-f87dfd0e` 批准
- **Related**: F002 — Pi SDK Host 已提供 extension binding 与进程隔离基础

## Risk

| 风险 | 缓解 |
|------|------|
| 跨聊天室内容被伪装成 operator/system prompt | external peer role + provenance；只有 operator 确认的 spawn `initialMessage` 作为公开 user message |
| crash/retry 重复启动 Agent 或重复副作用 | delivery row claim/lease + 幂等目标消息 + invocation-start 后禁止自动重执行 |
| 树关系被误用为 ACL | navigation/source provenance 与 permission policy 分离；权限矩阵独立测试 |
| legacy conversation 没有项目边界 | unbound fail closed + operator 显式绑定，不静默猜测 |
| Pi bridge 退化为任意 MCP/HTTP/shell 代理 | 固定 facade、server-side allowlist、隐藏 transport/config、无 generic arguments proxy |
| 状态 UI 变成持续报警器 | 正常状态原位 pill，失败才展开；同 reason/status 聚合，禁止 toast-only/dashboard-only |
| 大树在窄侧栏不可读 | 紧凑 tree row、移动 drawer、最大深度与稳定排序 |
| 三个 Phase scope 互相吞噬 | 每个 Phase 独立 AC/fixture；Phase merge 后按大 Feature 流程做方向碰头 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | 是否批准将官方 `@modelcontextprotocol/sdk` 作为 CAFF 的直接、精确锁定依赖，以实现真实白名单 MCP bridge？ | ✅ 已批准（message `0001785912003140-001436-f87dfd0e`） |
| OQ-2 | 是否批准 Design Gate 中“紧凑 tree row + 复用现有新建聊天室 dialog/sheet + 独立 receipt card”的 UI 方向？ | ✅ 已批准（message `0001785912003140-001436-f87dfd0e`） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 聊天室继续等于 `conversation`，不新增 thread scope | 复用现有持久化、API 与 UI 边界 | 2026-08-05 |
| KD-2 | delivery row 自身是 durable dispatch/outbox 真相源 | 状态、重试、取消、恢复和审计不能只塞 message metadata | 2026-08-05 |
| KD-3 | 跨聊天室执行复用 target-scoped side-dispatch | 避免唤醒目标聊天室全部 participants | 2026-08-05 |
| KD-4 | 树负责导航/来源，不负责授权 | “方便找聊天室”不能静默扩张通信能力 | 2026-08-05 |
| KD-5 | Spawn 对齐 Clowder `propose_thread` 语义：全新聊天室 + 一条完整首消息 | operator 明确拒绝 Fork、snapshot 和自动 handoff bundle | 2026-08-05 |
| KD-6 | spawn 首消息公开可见，只自动启动 primary Agent | 无暗上下文，且保持定向启动 | 2026-08-05 |
| KD-7 | v1 每条 delivery 单目标 Agent | 一条 envelope 对应一个权限判断、dispatch 生命周期与 request responder | 2026-08-05 |
| KD-8 | CAFF 直接依赖并精确锁定官方 `@modelcontextprotocol/sdk` | 真实 MCP interoperability 不能依赖当前 transitive optional copy；安全边界仍由固定 facade、allowlist 与 principal 注入承担 | 2026-08-05 |
| KD-9 | UI 采用紧凑 tree row、复用现有 dialog/sheet，并用独立 durable receipt card 呈现跨聊天室状态 | 保持深层树可读、移动端沿用既有 drawer，并让状态留在发生现场 | 2026-08-05 |

## Architecture

- Architecture cell: CAFF conversation persistence + runtime side-dispatch + agent tool bridge + `public/chat` AppShell
- Map delta: none
- Why: CAFF 当前没有独立 ownership map；F003 在既有 `storage/chat -> lib/chat-app-store -> server/domain -> server/api -> public/chat` 边界内新增一个显式 delivery domain，不创建平行 Store/Queue/Router 体系。

## Eval / Tracking Contract

### Primary Users + Activation Signal

- Primary users: 在多 conversation 间分工的 operator 与 Pi Agent。
- Activation: Pi facade 调用 `conversation_notify/request`，或 operator 从会话树提交 spawn dialog。

### Friction Metric

- `delivery_terminal_failure_rate`：非权限预期拒绝的 terminal failure 比例。
- `receipt_first_visible_latency_ms`：提交到 source receipt 首次可见的延迟。
- `retry_duplicate_side_effect_count`：重试产生重复目标消息/invocation 的次数，目标恒为 0。
- `spawn_to_primary_start_ms`：spawn 提交到 primary Agent side-dispatch 开始的延迟。
- `unbound_scope_recovery_rate`：project scope 绑定提示后成功重试比例。

### Regression Fixtures

1. 两个 conversation 的 notify/request/reply/late reply/cancel/timeout 端到端 fixture。
2. crash windows：事务前、提交后 enqueue 前、invocation start 后、reply 回源前。
3. permission matrix：self/unbound/different project/non-participant/expired token/tree-related-but-unauthorized。
4. bridge adversarial fixture：generic proxy fields、secret echo、unknown facade、malformed result、MCP disconnect。
5. spawn non-Fork fixture：父 history/config/participants/skills 不复制；公开首消息 + 单 primary wake。
6. 1440/375 tree/receipt/provenance UI fixture。

### Sunset Signal

当 pinned Pi SDK 连续两个 CAFF release 提供可审计的原生 MCP host，且同时具备 server-side allowlist、invocation identity 注入、project permission hook、tool trace/status callback 与 secret redaction 时，评估移除 Pi extension transport adapter；delivery domain、permission policy 和 UI receipt 不随之 sunset。

### Harness Layers

| 层 | 计划 |
|---|---|
| Soft | facade/tool description 明确“目标 conversation/Agent、低权限 peer input、不会自动唤醒来源”；spawn dialog 明示“全新聊天室，只带这一条首消息” |
| Hard | DB unique/foreign-key/check、principal 注入、project scope policy、server-side allowlist、schema projection、maxHop、claim lease 和 restart recovery tests |
| Eval | 上述 6 组 fixture + friction metrics + sunset signal；每个 Phase merge 后复查无重复副作用和现场噪音 |

## Tips Contribution（F244）

- 新增 tip：“从会话树派生全新子聊天室”，sourceRef 指向本 spec 的 Supporting Journey。
- 新增 tip：“跨聊天室投递失败时在原 receipt 卡片重试”，sourceRef 指向本 spec 的 Primary Journey 与 AC-C4。

## Non-goals

- 不实现同步 RPC、跨聊天室广播全部 participants 或自动 ping-pong wake。
- 不允许任意跨项目 delivery；不同 project 默认拒绝。
- 不实现通用 `{server, tool, arguments}` MCP 代理、任意 URL/headers/command/env 模型参数或 shell fallback。
- 不复制父聊天室历史/摘要/participants/模型/Skills/任务/状态；不生成 snapshot、handoff bundle 或 recipient-only 隐藏 bootstrap。
- 不新增独立后台收件箱或只在 dashboard 展示状态；现场 receipt/provenance/tree 是第一入口。
- v1 不拖拽/reparent、不把已有聊天室事后随意挂树、不级联删除有子节点的 conversation。
- 不连接 Redis 6399，不读取或修改生产用户数据。

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-08-04 | operator 授权跨聊天室通信与受控 Pi MCP bridge；新增派生子聊天室树需求 |
| 2026-08-05 | operator 纠正 Fork 假设，并冻结 Clowder 原版语义：全新聊天室 + 一条完整首消息 |
| 2026-08-05 | F003 kickoff/spec/Design Gate draft 落盘；等待 MCP SDK 依赖与 UI 方向确认 |
| 2026-08-05 | operator 在 message `0001785912003140-001436-f87dfd0e` 回复“两项都批准”，Design Gate 放行实施 |
| 2026-08-05 | F003 Phase A/B/C merged (PR #55) |

## Review Gate

- Phase A: storage/runtime/security focused review；先红后绿覆盖 crash、idempotency、permission 与 loop guard。
- Phase B: bridge security review；必须证明没有 generic proxy、secret echo 或 fallback 绕过。
- Phase C: UI/UX + in-context observability review；desktop/mobile browser evidence，且 reviewer 与作者不同个体。

## Links

- [Trellis Task Archive](../../.trellis/tasks/archive/2026-08/08-05-f003-cross-conversation/prd.md)
- [F002 Pi SDK Host Migration](F002-pi-sdk-host-migration.md)
