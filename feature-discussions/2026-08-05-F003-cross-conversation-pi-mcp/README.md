---
feature_ids: [F003]
topics: [cross-conversation, mcp, pi, tree-navigation, handoff, design-gate]
doc_kind: discussion
created: 2026-08-05
status: approved_for_implementation
---

# F003 Kickoff Discussion and Design Gate Decision Record

## Status

产品语义、架构主线、官方 MCP SDK 直接依赖与 UI 文本线框均已获得 operator 确认。Design Gate 已放行实施；实现继续遵守固定 facade、非 Fork spawn、持久 receipt/provenance 与树非 ACL 的冻结边界。

## Operator Experience / 原始需求锚点

1. 初始授权（source message `0001785861665897-001227-e6e5ef90`，本线程 bootstrap `0001785861843443-001232-7ee8f3e8`）：

   > CAFF 中的 Agent 应能明确寻址另一个聊天室，发送可持久追踪的消息或请求，并在原聊天室看到发送状态、来源、回执、失败与重试；Pi runtime 通过 CAFF-owned bridge 调用白名单 MCP 能力，而不是假装 Pi 原生支持 MCP。

2. 树导航新增需求（2026-08-04，thread message context）：

   > “派生子聊天室的功能也要一起做，一个聊天室派生的子聊天室最能在聊天框左侧体现出来，总而言之就是要有树状结构，这样方便用户找聊天室”

3. Fork 语义纠正（2026-08-05）：

   > “你的理解更接近于Fork，我意思是更接近于创建一个全新的聊天室然后给这个新聊天室的某个agent注入一段初始上下文”

4. 最终 Clowder 对齐裁决（2026-08-05，message `0001785910121413` 附近）：

   > “我们先向Clowder 原版看齐吧，一条写得足够完整的首条交接消息就够了”

5. operator 在修正版总结后回复“好”，授权进入 kickoff 文档收敛。

6. Design Gate 最终批准（2026-08-05，message `0001785912003140-001436-f87dfd0e`）：

   > “两项都批准，创建一个新线程，还是以你为主理人，烁烁为UI设计官，宪宪辅助”

## Evidence Read

- `storage/sqlite/migrations.ts:289-344`：conversation/message schema 无 lineage/project/delivery fields。
- `storage/chat/conversation.repository.ts:10-32`：当前 header 全局按最近活动排序。
- `lib/chat-app-store.ts:2134-2173`：最新 main 已强制显式 participants。
- `server/domain/runtime/agent-tool-bridge.ts:512-535, 819-870, 1036-1118, 1394-1455`：invocation-scoped credential 与 current-conversation-only bridge。
- `server/domain/conversation/turn-orchestrator.ts:899-980`：可复用的单 Agent side-dispatch。
- `lib/pi-sdk-host.mjs:76-92, 123-137`、`lib/pi-runtime.ts:378-382`：Pi extension binding 边界。
- `public/chat/conversation-list.js:16-101`：扁平会话卡逐项渲染。
- `public/chat/new-conversation-dialog.js:68-79, 96-260`：可复用的显式 participants dialog/sheet。
- `public/chat/message-timeline.js:399-420`、`public/styles.css:1695-1763`：现有 trace pill/tone/live rotor 状态语言。
- 当前桌面/移动截图：`feature-discussions/2026-07-29-caff-ui-m4-design/v3-structure/after/ui-1440.png`、`ui-375.png`。
- Clowder 源码核对结论：真正 branch 复制历史；`propose_thread` 创建独立空 thread 并只投递 `initialMessage`。F003 选择后者。

## Discussion Evolution

### Round 1: Cross-Conversation Delivery

砚砚独立结论（message `0001785862888397-001235-b25b983b`）：

- conversation 是唯一聊天室实体；notify/request 共用 durable envelope。
- 独立 delivery/event 是状态真相源；chat_messages 是现场投影。
- principal 身份注入，Pi 只见 facade，不见 MCP transport/config。
- source receipt + target provenance 双向现场可见。
- message/dispatch/response 三正交状态；重试、取消、late reply、loop guard fail closed。

宪宪 challenge（message `0001785862949687-001245-e4d2f1c3`）促成两项收敛：

- 定向跨聊天室执行复用 side-dispatch，不让 external peer message 触发目标聊天室主 turn。
- request reply 回源更新 receipt，默认不自动 wake 来源 Agent。

烁烁 UX 分析（message `0001785863409320-001250-c47e381d`）促成现场方向：

- source receipt 是独立 durable timeline item，不依附某条普通消息。
- target provenance 在消息头部可点击返回来源。
- 复用现有 pill/tone/live rotor；失败才展开，禁止 toast-only。
- 会话列表从高卡片密度切换为紧凑 tree row，移动端复用 drawer。

### Round 2: Tree Requirement and Incorrect Fork Assumption

第一次扇入错误地把“树关系”推成“冻结父聊天室公开上下文”。operator 明确指出这更像 Fork，要求重新讨论。该 Round 的以下内容全部 superseded：

- 父历史/摘要 snapshot。
- 自动生成 handoff context bundle。
- 复制 participants、模型、Skills 或项目配置。
- recipient-only 隐藏 bootstrap。
- 树邻接自动成为通信授权。

### Round 3: New Conversation + Initial Message

烁烁重设计（message `0001785894193438-001279-27f970b6`）把 spawn 收敛为三个正交原子：新 conversation、树边、一次性 handoff delivery。

宪宪复核（message `0001785894736749-001293-2ea4fd77`）确认默认立即 target-scoped wake、树不自动授权、dispatch 必须 durable。

砚砚扇入（message `0001785895186277-001299-1b92dd98`）仍包含 recipient-scoped bootstrap。operator 追问 Clowder 原版后，最终裁决改为：

- 一条 operator 确认的完整 `initialMessage` 就是全部启动上下文。
- 首消息写入新聊天室公开 timeline，所有 participants 可见。
- 只自动唤醒 primary Agent。
- 不做 bundle、snapshot、隐藏 context 或独立 bootstrap 表。

最终修正版见 message `0001785910121440-001399-cdee2604`，operator 随后确认“好”。

## Frozen Product Semantics

1. **Cross-conversation**：Agent 可向一个目标 conversation 的一个 participant Agent 发送 notify/request；source 有 durable receipt，target 有 provenance。
2. **Request**：单 responder，final answer 自动回源，不自动 wake requester。
3. **Authority**：Agent 跨房间内容是低权限 external peer input；spawn 的 `initialMessage` 由 operator 确认，因此是公开 user message，但不高于后续 operator 输入。
4. **Spawn**：全新 conversation + parent/origin provenance + explicit project/participants/primary Agent + complete initialMessage + durable bootstrap dispatch。
5. **Non-Fork**：不复制父 history、digest、participants、profiles、skills、tasks 或 state。
6. **Failure**：DB 事务失败不产生半成品；dispatch 失败保留已创建 conversation 并可重试。
7. **Tree**：navigation/discovery/source provenance；不是 transport ACL。
8. **Pi bridge**：Pi-native facade + CAFF server-side allowlist；不暴露 generic MCP proxy。

## Design in Context

### Existing Surface

- 桌面左侧是固定侧栏，当前 conversation 使用约 70–80px 卡片，显示 title/type/participant count/time/busy。
- 移动端会话列表已经进入 hamburger drawer；主聊天不在顶部重复堆列表。
- 新建聊天已使用单页 dialog，移动端为 full-screen sheet，显式选择 participants。
- timeline 已有 live rotor 与 success/failed/running/neutral 状态 token。

### Selected Direction

- **替代而非共存**：`conversation-list` 的高卡片行替换成 36–44px tree row；不在树旁保留第二套扁平列表。
- **Spawn 入口**：节点 hover/focus 出现 child-plus；点击复用 `new-conversation-dialog`，增加 locked parent、project、primary Agent、initialMessage，而不是在窄 row 内 inline 编辑。
- **Desktop**：侧栏常驻 tree；选中节点自动展开祖先。
- **Mobile**：复用现有 hamburger drawer；选择节点后关闭，不创造横向 tab 或第二套树交互。
- **状态**：tree node 只显示需要行动的 compact status；详细错误与 retry 在 source receipt/target birth card。

### Rejected Alternatives

| 方案 | 拒绝原因 |
|---|---|
| 在现有 80px conversation card 上继续缩进 | 三层后宽度和高度同时失控，结构仍不清楚 |
| 节点内 inline spawn form | 与既有 dialog/sheet 重复表单和焦点管理，窄侧栏密度过高 |
| 单独跨聊天室 inbox/dashboard | 离开问题现场，且和 timeline/tree 重复状态 owner |
| 树邻接自动授权 | navigation 动作不等于 permission expansion |

## Text Wireframes

### Desktop conversation tree

```text
会话                                      [＋]

▾ CAFF 跨聊天室通信                       ●
  ├─ 协议与权限
  ├─ UI 树状导航                 [处理中] [＋]
  └─ Pi MCP Bridge
▸ 模型角色体系
```

### Spawn dialog extension

```text
派生新聊天室
父聊天室        CAFF 跨聊天室通信（只读）
标题            [________________________]
项目            [CAFF ▾]
参与 Agent       [✓ 砚砚] [ 宪宪] [ 烁烁]
主理 Agent       [砚砚 ▾]
首条交接消息     [完整描述目标/约束/下一步……]

“这是一个全新聊天室；不会复制父聊天室历史或配置。”
                                      [取消] [创建并启动]
```

### Source receipt and target birth card

```text
跨聊天室请求   → UI 树状导航 · @砚砚     [等待回复]
已持久化 · 处理中                                      [跳转]

初始上下文 · 来自 CAFF 跨聊天室通信
这是一个全新聊天室；下面是 operator 确认的第一条消息。
[展开来源] [返回父聊天室]
```

## In-Context Observability

五问结论：受影响 operator 与目标 Agent 需要第一时间看到；source receipt、target provenance/birth card 和 tree status 都在原实体现场；若只能保留一个 surface，保留 in-context；dashboard 仅可做事后审计；重复状态原位 patch/dedup，不发连续 toast。

```yaml
in_context_observability:
  primary_surface: "source conversation 的 durable receipt card + target message/birth card provenance + conversation tree compact status"
  why_not_dashboard_only: "发送失败、权限拒绝和等待回复都直接改变当前下一步；切到 dashboard 才看到会让用户失去重试、取消和跳转现场"
  deep_dive_surface: "delivery event/attempt trace，定位为事后审计与故障分析；v1 不新增独立 dashboard"
  noise_dedup_policy: "同一 delivery 只原位更新一张 receipt；相同 reason/status 不重复发消息，失败才展开详情，SSE patch 不整条 timeline 重渲"
```

## Architecture Cell

```text
Architecture cell: storage/chat + lib/chat-app-store + conversation side-dispatch + agent-tool-bridge/Pi host + public/chat
Map delta: none
Why: CAFF 无独立 ownership map；新 delivery domain 放进既有 conversation/runtime/UI 链，不另造平行 Store、Queue、Router 或 inbox。
```

## Meta-Aesthetics Check

这是坐标变换：把“跨聊天室聊天”拆成持久 delivery、定向 dispatch、现场 projection 三个正交事实；把 spawn 拆成“新 room + lineage + first message”。被删除的 snapshot/bundle/隐藏 context/通用 MCP proxy 都是多项式堆项。delivery row 兼任 outbox，避免再叠一层 queue 真相源。

## Eval / Harness Summary

- **Soft**：facade 说明与 spawn dialog 明示目标、低权限 peer、非 Fork、只自动启动 primary Agent。
- **Hard**：principal 注入、project scope、participant check、allowlist、schema projection、idempotency、claim lease、maxHop、restart recovery。
- **Eval**：cross-room/crash/permission/MCP adversarial/spawn non-Fork/desktop-mobile 六组 fixture；完整指标见 Feature spec。

## Approved Operator Decisions

Approval evidence: message `0001785912003140-001436-f87dfd0e` — “两项都批准”。

### Decision 1: 真实 MCP interoperability

**推荐：批准直接、精确锁定官方 `@modelcontextprotocol/sdk`。**

- Value: CAFF bridge 能调用真实 MCP server，同时仍由 server-side allowlist、principal 和 projection 承担安全边界。
- Cost: 新增一个直接外部依赖，需要 lockfile、供应链 review 和 transport fixture。
- If rejected: Phase B 只能做 CAFF internal facade，不能声称交付“Pi MCP bridge”，等于主动缩减本 Feature 愿景。

### Decision 2: UI 体验方向

**推荐：批准“紧凑 tree row + 复用既有 dialog/sheet + 独立 receipt card”。**

- Value: 树结构取代高卡片密度，移动端沿用已有 drawer；创建和状态反馈都使用现有组件语言。
- Tradeoff: conversation preview/type/time 不再全部常驻在 tree row，详细信息移到选中现场或 tooltip。
- Alternative: 保留高卡片会显著降低树的可读深度，不推荐。

## Next Action

创建 F003 实现线程，工作区固定为 `E:\pythonproject\caff-f003-cross-conversation-pi-mcp`，回报契约使用 `state-transitions`。角色为：砚砚主理，烁烁负责 UI 设计，宪宪提供架构与实现辅助。新线程先读本讨论、Feature 聚合页与 Technical Design Gate，加载 `writing-plans` 形成分阶段实施计划，再按 `worktree`/`tdd` 进入代码实现。

[砚砚/gpt-5.6-sol🐾]
