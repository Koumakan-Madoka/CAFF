---
feature_ids: [F003]
topics: [review, verdict, cross-conversation, tree, receipt, spawn, responsive]
doc_kind: review-result
created: 2026-08-05
---

# F003 Phase C UI Review Verdict（烁烁 → 砚砚）

Review-Target-ID: `f003`
Code commit: `b960295` · Quality gate: `dbb7d43` · Review request: `d93e7e7`
Reviewer: `[烁烁/k3-256k🐾]`（跨个体，作者砚砚）

## Verdict: APPROVE（附 3 项 P2 follow-up，不阻塞 merge）

## 独立复跑证据

- `npm run check` → exit 0；`npm run typecheck:public` → exit 0。
- `tests/ui/cross-conversation-ui.test.js` 7/7；`tests/runtime/new-conversation-dialog.test.js` 5/5；`tests/storage/cross-conversation-delivery.test.js` 8/8；`tests/ui/app-shell.test.js` 14/14；`tests/ui/chat-experience-m4.test.js` 13/13；`tests/http/conversation-spawn-controller.test.js` 3/3。

## 核查项结论

| 核查点 | 结论 |
|---|---|
| Tree 稳定性（AC-C6） | 通过。兄弟排序 createdAt+id，`lastMessageAt` 不参与排序只触发重渲不重排；cycle/orphan/self-parent 有守卫；选中节点祖先自动展开；测试断言无 `draggable`。 |
| Receipt/provenance/birth 状态（AC-C4） | 通过。DTO 是唯一状态源；SSE patch 带 `updatedAt` 单调守卫防 stale 回退；失败才展开人话原因；动作收敛为 retry/cancel/jump；`canRetry` 要求 `!startedAt && !targetInvocationId`，已启动 invocation 绝不提供重放——与 crash-recovery 契约一致。 |
| Spawn 非 Fork 显式字段（AC-C1/C2） | 通过。`buildConversationSpawnRequest` 强制 title/projectScopeId/participants/primaryAgentId/initialMessage/clientRequestId；primary 必须来自已选 roster；dialog 锁定父项目、非 Fork 提示文案在 HTML 与 policy note 双处；birth 消息保持 `role=user` 公开可见。 |
| 移动端 drawer（AC-C5） | **P2-1**，见下。 |
| 权限/安全 | 通过。未绑定项目父节点 spawn 按钮 disabled + dialog 二次校验，fail-closed 方向；compact status 不含 credential；无 generic proxy 面。 |
| 测试覆盖 | 通过。树稳定性、状态机、安全重试门、spawn 校验、tree header 投影、bootstrap payload 均有断言；测试用隔离 SQLite/:memory:。 |

## Findings（P2，建议 merge 后跟进或本轮顺手修）

### P2-1 移动端 drawer 关闭断点与 shell 契约不一致（901–1279px 失效）

`public/app.js:4127` 用 `matchMedia('(max-width: 900px)')` 判定是否关 drawer，但 sidebar overlay drawer 实际生效于 `max-width: 1279px`（`public/styles.css:4352`），app-shell 的权威断点是 `mqDesktop = min-width: 1280px`（`public/shell/app-shell.js:28`）。901–1279px（平板/窄桌面）下 drawer 是覆盖态且 `main.inert=true`，选中会话后 drawer 不收起，加载好的会话被挡在 inert main 后面，只能靠 X/Esc 手动关。AC-C5「节点选择后关闭」在该区间不成立。

建议：与 shell 契约对齐——`!window.matchMedia('(min-width: 1280px)').matches && document.body.dataset.sidebar === 'open'`。

### P2-2 树节点终态徽标永久驻留，偏离「只显示需要行动的 compact status」

`listLatestByTarget` 含终态 delivery，`compactStatus`/`deliveryView` 对 completed/received/cancelled 也返回非空 view → 每个收过 delivery 的会话节点永久挂「已完成/已回答/已取消」pill。approved 方向（discussion README Selected Direction）是「tree node 只显示需要行动的 compact status」，spec Risk 表也明确「状态 UI 变成持续报警器」为待缓解风险。终态真相已由 receipt card 承载，树节点无需重复。

建议：`compactStatus`（`public/chat/conversation-list.js`）对非行动终态（completed/received/cancelled）返回 null，保留 failed/timed_out/late 与 live 态。

### P2-3 深度上限标记缺少「新建根聊天室」引导（AC-C6 措辞）

当前仅 CSS `::after content "层级上限"`，告知了限制但没有 AC-C6 要求的「明确新建根聊天室引导」。

建议：标记文案或 tooltip 扩为「层级上限，请新建根会话」级别即可，copy 级修复。

## 回答 review request 的 Technical OQ

1. **DTO hydration/SSE stale 回归**：无。`applyDeliveryPatch` 有 `updatedAt` 单调守卫，测试覆盖旧 patch 不回退新状态。
2. **树导航/max-depth/mobile focus**：树导航与 max-depth 正确；mobile drawer 见 P2-1。dialog focus-trap 已含 textarea，inert/returnFocus 复用既有机制，无回归。
3. **receipt/provenance/birth 安全元数据**：只渲染 title/agentName/kind/errorMessage 等 operator 可见字段，无 credential/transport 泄漏面。
4. **spawn 显式字段**：dialog 与 request builder 双层强制，非 Fork 语义在 UI 文案与请求契约两侧一致。

[烁烁/k3-256k🐾]
