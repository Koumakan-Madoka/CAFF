# Trace Inspector And Session Lineage

## Goal

将现有“上下文”抽屉升级为可审计的 Trace Inspector。用户应能从一条 assistant 回复出发，理解触发、Session 复用判定、启动或恢复、实际 prompt 投递、模型调用、工具执行、usage 采集和消息终态落库，并能沿当前 Session 定位父 Session 与祖先 Session。

## Terminology

- **新建 Session**：本次 agent run 未恢复旧 provider session，`sessionReused=false`，Context Snapshot 的 `deliveryMode=fresh`。
- **复用旧 Session**：本次 agent run 使用 `--resume` 恢复旧 provider session，`sessionReused=true`，Context Snapshot 的 `deliveryMode=resume`。
- **Provider cache 结果**：单次模型调用的 cache read / provider miss 证据，与 Session 新建或复用是两个独立维度。
- **Session lineage**：当前 assistant 消息及其 resume 快照引用的上一条 assistant 消息，继续沿父快照引用形成的有界链。
- **Trace event**：从已有持久化消息、task/run 事件、不可变快照和 model/tool timeline 生成的安全、有界、按时间排序的审计投影。

## Requirements

1. 前端不再使用“冷启动”描述 Session 生命周期。首次模型调用按当前消息显示“新建 Session”或“复用旧 Session”；cache hit/provider miss 继续作为独立 provider 结果展示。
2. 新增稳定的 Trace Inspector 详情契约，聚合当前消息摘要、Session 语义、run evidence、lineage、完整高层阶段和现有有界 model/tool 事件。
3. 高层 trace 至少覆盖：触发、复用判定与 claim 结果、Session 启动/恢复、实际 prompt 投递、模型调用、tool 执行、usage、消息落库；失败或缺失证据要显示明确状态，不伪造时间或成功结论。
4. model/tool 原始事件继续使用现有 first-one-plus-latest-15 窗口及全量聚合，不引入第二套无界日志。
5. lineage 最大返回 8 个可定位节点。父节点只由 `retainedSessionPrefix.cursorMessageId` 解析；每个节点仅含 messageId、snapshotId、sessionName、deliveryMode、capturedAt、agent、cursor 摘要和是否在当前消息页，不返回旧 prompt、section 内容、message content 或 privateOnly 内容。
6. lineage 遇到 fresh 根、旧 schema、缺失或删除消息、缺失快照、跨 conversation、privateOnly、循环或深度上限时停止，并返回封闭的 termination code 与可展示说明。
7. 点击父/祖先节点时，若消息在当前页则滚动定位对应消息；不在当前页仍可按 messageId 懒加载其 Inspector，并提示“消息不在当前页”。原消息可以通过返回按钮恢复。
8. Trace Inspector 提供“Trace / 上下文”两个视图。上下文分区与 retained prefix 保持现有真实投递口径；详情默认折叠，大 payload 不阻塞首屏。复制与 Markdown 导出复用同一安全投影。
9. 运行前 Context Snapshot 保持不可变。运行后 cache/usage 与终态证据从同一消息 metadata、detail tables 和 task/run rows 读取，不回写快照。
10. 不修改 provider session 文件格式，不重新注入旧前缀，不改变 prompt 字节、复用判定、KV cache 或 privateOnly 可见性规则。

## Data Contract

`GET /api/conversations/:conversationId/messages/:messageId/trace-inspector`

```text
{
  schemaVersion: 1,
  message: { id, turnId, agentId, agentName, status, createdAt, updatedAt },
  session: { mode, reused, reason, sessionName },
  snapshot: <materialized safe AgentContextSnapshot>,
  runEvidence: <same-message normalized evidence>,
  lineage: {
    maxDepth: 8,
    nodes: [{ depth, relation, messageId, snapshotId, sessionName,
              deliveryMode, capturedAt, agentId, agentName,
              cursor: { messageId, messageCount, firstMessageId, maxUpdatedAt } | null }],
    termination: { code, atDepth }
  },
  trace: {
    events: [{ id, phase, status, title, occurredAt, durationMs, summary,
               detailRef, sequence }],
    timelineWindow: <existing bounded model/tool window>,
    summary: <full aggregate counters and terminal state>
  }
}
```

Validation ownership:

- Controller validates conversation/message ownership and assistant role.
- Domain projector validates and bounds lineage, event fields and safe summaries.
- Existing snapshot materializer owns section integrity/redaction.
- Existing message-tool-trace projector owns session JSONL redaction and bounded model/tool evidence.
- UI consumes closed enums and never infers private eligibility or reconstructs lineage from arbitrary IDs.

## Validation Matrix

| Case | Expected result |
| --- | --- |
| First fresh reply | “新建 Session”; no parent; trace contains trigger through persisted terminal stage. |
| First resume | “复用旧 Session”; parent resolves; context contains only `session_delta`; provider cache shown separately. |
| Two consecutive resumes | Current -> parent -> ancestor resolves in order without duplicate/cycle. |
| Tool and multiple model calls | One chronological trace with full aggregate counts and retained 16-event window. |
| Failed run | Failure node and bounded reason visible; no false persisted-success event. |
| Legacy schema v1 parent | Current node remains inspectable; lineage terminates `legacy_schema`. |
| Deleted/missing parent | Terminates `parent_missing`; API/UI do not throw. |
| privateOnly parent | Terminates `protected_parent`; no parent identifiers or content are projected. |
| More than 8 generations | Returns 8 nodes and `depth_limit`; no unbounded reads. |
| Malformed/cyclic references | Terminates `invalid_reference` or `cycle`; no cross-conversation lookup. |
| Message outside current page | Inspector opens via point read and shows “消息不在当前页”. |
| Long IDs/hash/payload at 390px | No horizontal document/drawer overflow or control overlap. |

## Acceptance Criteria

- [ ] “冷启动” Session 文案已替换为“新建 Session”/“复用旧 Session”，provider cache 结果语义仍独立可见。
- [ ] fresh、连续两次 resume、tool、多模型调用和失败路径均展示有序 trace。
- [ ] 当前、父、祖先 lineage 可定位，分页外消息可懒加载。
- [ ] old schema、删除父节点、privateOnly、循环和深度上限失败安全。
- [ ] resume 的实际 delta 与快照仍逐字同源，旧前缀不重新投递或输出到 lineage。
- [ ] Trace/context 复制和导出只包含安全投影。
- [ ] 相关 runtime/backend/frontend/storage 测试通过。
- [ ] `npm run check`、两套 typecheck、build、server smoke 通过。
- [ ] 3210 使用隔离 SQLite、日志和无外部 side effect 的候选环境通过桌面及 390px 人工验收。
- [ ] 精确候选 SHA 获得非作者独立 APPROVE。

## Non-Goals

- 不修改 provider session JSONL 格式。
- 不把 retained Session 前缀重新注入 prompt 或复制到当前快照。
- 不做全量聊天历史分页重构。
- 不保存无界原始 trace，不展示模型 thinking 或原始 provider 包装。
- 不处理本 Goal 之外的 Session reuse P2。

## Likely Change Surface

- `server/domain/conversation/turn/context-snapshot.ts`
- `server/domain/runtime/message-tool-trace.ts`
- 新的 backend trace/lineage projector
- `server/api/conversations-controller.ts`
- `lib/chat-app-store.ts` / message detail repository 的有界 point-read helper
- `public/app.js`, `public/chat/message-timeline.js`, `public/index.html`, `public/styles.css`
- runtime/http/storage/UI focused tests and current specs
