---
feature_ids: [F003]
topics: [ui, conversation-tree, receipt, provenance, spawn-dialog, responsive]
doc_kind: design
created: 2026-08-05
status: ready_for_implementation
---

# F003 Phase C UI 实施设计（烁烁）

> 上游真相源：Feature spec AC-C1..C7 + Design Gate "UI Design Contract"。本文档把已批准的线框落到具体文件、状态映射与证据计划，不引入新视觉语言。

## 1. UI 数据依赖（Phase A/B 需向客户端暴露）

现状盘点（worktree `caff-f003`，Phase A 已合入）：

- `conversation.repository.ts` 已持久化 `project_scope_id / parent_conversation_id / origin_conversation_id / origin_message_id / tree_depth`。
- `GET /api/conversation-deliveries/:id` 返回 `{ delivery, targetMessage, sourceReceipt, responseDelivery, responseMessage, events }` —— receipt card 的单一数据源已具备。
- 缺口（Phase C 需补齐，均属可逆实现细节）：
  1. **会话列表 payload** 需携带 `parentConversationId`、`treeDepth`、每节点 compact delivery 状态聚合（queued/running/failed/responded 计数或最严重态），否则 tree row 无法渲染层级与状态点。
  2. **SSE patch**：delivery 状态迁移需向 source conversation 与 target conversation 各推一条 patch 事件（含 deliveryId + 三态），客户端只原位更新对应 receipt/节点状态点，DB 仍是刷新后真相源（AC-C4）。
  3. **Spawn API** `POST /api/conversations/:id/spawn` 请求体契约已在 Design Gate 冻结，UI 直接对齐。

## 2. 组件落点（复用优先，不造第二套语言）

| UI 元素 | 落点文件 | 复用/新增 |
|---|---|---|
| 紧凑 tree row（36–44px） | `public/chat/conversation-list.js` | **替换**现有 70–80px 卡片渲染；保留 `renderSignature` 防抖与 scrollTop 恢复机制 |
| 树缩进/展开箭头 | 同上 + `public/styles.css` | 新增 `.conversation-tree-row`、`.tree-toggle`；depth 用 `padding-left = depth * 16px`，max depth 3 |
| 节点状态点 | 同上 | 复用 `mini-badge busy` 模式，失败用已有 failed tone |
| 节点 [＋] 派生入口 | 同上（hover/focus 出现） | 点击打开既有 dialog，不在 row 内 inline 编辑 |
| Spawn dialog 扩展 | `public/chat/new-conversation-dialog.js` | **复用**整个 dialog/sheet/focus-trap/inert 机制；新增只读父节点行、项目 select、主理 Agent select、`initialMessage` textarea、非 Fork 提示文案 |
| Source receipt card | `public/chat/message-timeline.js` | 新 message metadata kind；复用 `createTracePill` tones + `appendLiveToolRotor` |
| Target provenance header | 同上 | `external_agent` role 消息头部条，可点击跳回来源 |
| Spawn birth card | 同上 | 首消息上方 provenance 条 + "返回父聊天室"，消息本身仍是普通公开 user message |
| 移动端 | 既有 hamburger drawer | 零新交互；选中节点即关闭 drawer；spawn 复用 full-screen sheet |

## 3. 状态 → 视觉映射（派生 label，持久层不合并三态）

| 组合（message/dispatch/response） | 展示 label | tone | live rotor |
|---|---|---|---|
| persisted/queued/* | 已排队 | neutral | ✓ |
| persisted/running/* | 处理中 | running | ✓ |
| persisted/completed/waiting | 等待回复 | neutral | ✗ |
| persisted/completed/received | 已回复 | success | ✗ |
| */failed 或 */timed_out | 失败/超时 + 人话原因 | failed（展开） | ✗ |
| */cancelled | 已取消 | neutral | ✗ |
| response late | 迟到回复 | failed 边框 + "迟到" 标记 | ✗ |

规则：正常路径永远一行 compact；**失败才展开**人话原因 + [重试]/[取消]/[跳转]；同一 delivery 一张 receipt 原位 patch，禁止 toast-only（AC-C4、noise_dedup_policy）。

## 4. 渲染与排序稳定性（AC-C6）

- `renderSignature` 扩展为 tree 签名：id/parentId/depth/title/compactStatus/expanded/selected 参与签名；**lastMessageAt 不再参与排序**。
- 兄弟排序固定（创建时间或显式 order key），SSE 消息活动只 patch 节点状态点，**不重排整棵树**。
- 选中节点自动展开祖先；`expanded` 状态存客户端（session 级），刷新后由 selected 节点推导最小展开集。
- 空态、单根、根/子/孙、折叠、深链（URL 直达孙节点）均为 signature 分支，全部入证据。

## 5. Spawn dialog 行为契约（AC-C1/C2）

- 父节点行只读锁定；标题、项目、participants（复用 roleCard 机制）、主理 Agent（仅限已选 participants）、`initialMessage`（非空、bounded）全部显式。
- 固定提示文案："这是一个全新聊天室；不会复制父聊天室历史或配置。"
- 提交走 spawn API；成功后选中新节点并展开祖先。bootstrap 失败时聊天室保留，birth card 显示失败原因 + [重试]（AC-C3）。
- max depth 达到时不显示 [＋]，改为一次性引导文案"已达最大层级，请新建根聊天室"（AC-C6）。

## 6. 证据计划（AC-C5/C7）

1440px + 375px 截图矩阵：空态 / 单根 / 根子孙三层 / queued / running / failed 展开 / responded / 折叠态 / 深链选中孙节点 / mobile drawer 开+选即关 / spawn sheet。
测试：tree 排序稳定性、receipt SSE patch 不重渲整树、spawn 非 Fork UI 断言（新聊天室只有一条公开首消息）。全部走隔离 SQLite browser fixture，不碰 Redis 6399。

## 7. 文件范围（预计）

- `public/chat/conversation-list.js`（重写渲染为 tree）
- `public/chat/new-conversation-dialog.js`（spawn 模式扩展）
- `public/chat/message-timeline.js`（receipt/provenance/birth card kind）
- `public/styles.css`（tree row、provenance header、receipt card）
- `lib/chat-app-store.ts` / conversation controller（列表 payload 补 tree 字段 + compact status）
- SSE 事件：delivery patch
- 测试：UI fixture + list payload 断言

[烁烁/k3-256k🐾]
