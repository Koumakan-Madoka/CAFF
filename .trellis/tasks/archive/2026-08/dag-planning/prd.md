---
feature_ids: [dag-planning]
topics: [dag, planning, frontend, chat-tree, git-branch]
doc_kind: prd
created: 2026-02-14
branch: feat/dag-planning-ui-poc
---

# DAG 规划功能 PRD（POC 阶段）

## 1. 背景与目标

干活之前先做好规划：模型与用户讨论产出一张 DAG，每个节点有目标。CAFF 解析该图、持久化、并在前端渲染展示。用户可在图「正式开始前」编辑，启动后结构锁定。

POC 目标：跑通「讨论 → 模型 tool 出图 → 前端渲染 → draft 编辑 → 启动锁定 → 子会话共享 → tool 回写状态双端刷新」的完整闭环。

## 2. 已锁定决策（grill 两轮确认）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 存储归属 | 整棵会话树共享一份 plan，挂根会话（沿 origin_conversation_id 链解析），单表 JSON blob + version 乐观并发 |
| D2 | 生命周期 | `draft`（用户可编辑结构）→ `active`（锁结构、放 status 流转）→ `done/archived`；active 可退回 draft（确认弹窗 + 保留历史快照）；draft→active 仅用户可触发 |
| D3 | 节点 schema | `{id, title, goal, status, depends_on[], spawned_conversation_id, branch}`；status ∈ pending/doing/done/blocked |
| D4 | 边语义 | 仅表达执行依赖（DAG），不表达数据流 |
| D5 | 模型协议 | tool call 出图 + 服务端校验（无环 / id 唯一 / 依赖存在）；失败回执让模型自修复 |
| D6 | git 集成 | 会话增加 branch 字段；**每个节点一个独立 branch**；图构建时确定 branch 命名（不立刻检出）；顶层会话 branch 由用户指定；子会话/子节点 branch 基于父会话 branch 检出；合并由专门的 **merge 节点**承担 |
| D7 | 模型侧落地 | 新增 tool（agent-chat-tools 薄封装）+ 说明 skill；REST API 不可省（前端读图需要），校验逻辑抽 shared 模块供 tool 与 API 复用 |
| D8 | 前端形态 | 会话内可折叠 panel，支持二次扩展（加宽 / 全屏弹层）；渲染直接 dagre + 手写 SVG（跳过 mermaid），vanilla JS 友好 |
| D9 | status 更新权 | 用户手动 + 模型 tool 回写；绑定子会话完结自动置 done 留到派生功能阶段 |
| D10 | 合并冲突解决（第二阶段） | 由 merge 节点的主理人 agent（spawned 子会话 agent）负责解决冲突，不打回人工为第一手段 |
| D11 | 合并目标分支选择规则（第二阶段，Kimi 决策） | 目标分支 = merge 节点自身 `branch` 字段（图构建时定名的集成分支，落点语义）；该分支基于所有上游分支在 DAG 上的**最近公共祖先节点（LCA）**的 branch 检出；LCA 多义/不存在时退化为根会话 branch；源分支合并顺序按 `depends_on` 数组顺序逐条 merge（不做章鱼合并，冲突可逐个解决） |
| D12 | 合并失败状态流转（第二阶段） | 主理人 agent 有界重试自动解决（默认 ≤3 次）；仍失败 → 节点置 `blocked` 并在 status 回写中携带失败原因，等待主理人/用户介入；解除 blocked 回到 `doing` 继续；不自动跳过、不自动降级为 work |
| D13 | 节点 spawn 与树深 ≤2 的矛盾 | **方案 A：扁平化**——所有节点派生的子会话一律挂根会话下（parent = 根会话），绕过树深 ≤2 约束；会话列表变长由 UI 分组/折叠兜底，不动存量树深约束 |
| D14 | plan 数量上限 | **一棵树一辈子一份 plan**：owner_conversation_id UNIQUE 保持不变；plan 进入 done/archived 即该树规划生命周期终结，新目标必须开新会话树；不做部分索引改造 |
| D15 | activate/revert 权限边界 | 仅**根会话主理人 agent 或用户本人**可 activate / revert；子会话 agent 调用一律 403；任何 actor（含子会话 agent、用户）在 active 期都只能提 status 流转，不能改结构 |
| D16 | blocked 下游传播（Kimi 决策，第二阶段） | blocked **不传染**：下游节点状态不被自动改写；但某节点任一传递上游为 blocked 时，其 pending→doing 流转被 API 拒绝（409 + 阻塞上游明细，fail-closed）；前端 panel 展示派生的「上游阻塞」徽标（纯视图层计算，不落存储） |
| D17 | 整体中止语义（Kimi 决策） | **不新增 cancel/aborted 枚举**：放弃 active plan = revert 回 draft（快照已保留）→ 用户可选 archived 归档；生命周期枚举保持 draft/active/done/archived 四态不变，避免状态机膨胀 |
| D18 | status 变更审计（Kimi 决策，第二阶段） | 在 plan doc 内嵌 append-only `history[]`（不拆表）：`{node_id, from, to, at, actor, reason?}`，blocked 回写的原因落 `reason`；容量上限 200 条，超出滚动丢弃最旧；version 仍只管结构并发，history 不参与并发冲突 |
| D19 | merge 节点 verify 命令（Kimi 决策，第二阶段） | 节点 schema 增**可选** `verify?: string`（shell 命令，主要服务 merge 节点，work 节点亦可用）；执行期每合一条源分支后及全部合完后各跑一次，非零退出即视为合并失败进入 D12 重试流；缺省 = 跳过验证 |
| D20 | 模型自修复防护上限（Kimi 决策） | tool 校验失败回执机制不变，但 bridge 侧对同一会话**连续失败的 propose-plan 调用计数，上限 5 次**；超限返回硬性错误要求模型停止重试并向用户求助；成功一次即清零计数 |

## 3. 数据模型

### plans 表（新增）

```
plan_id               TEXT PK
owner_conversation_id TEXT  -- 根会话 id，后代会话沿 origin 链解析到此
status                TEXT  -- draft | active | done | archived
version               INTEGER  -- 乐观并发；draft 每次编辑 +1；进入 active 打快照
doc                   TEXT  -- JSON blob，见下
created_at / updated_at
```

### plan doc（JSON blob）

```json
{
  "nodes": [
    {
      "id": "n1",
      "title": "短标题",
      "goal": "节点目标描述",
      "status": "pending",
      "depends_on": ["n0"],
      "branch": "feat/dag-planning/n1-xxx",
      "spawned_conversation_id": null,
      "kind": "work | merge"
    }
  ],
  "edges": [{"from": "n0", "to": "n1"}]
}
```

### conversations 表（扩展）

新增 `branch TEXT` 字段：用户创建/指定；子会话默认基于父会话 branch 命名规则生成（图构建时确定命名，执行时才检出）。

## 4. API 契约（POC 最小集）

- `GET  /api/conversations/:id/plan` — 沿 origin 链解析根会话 plan；无 plan 返回 404
- `PUT  /api/conversations/:id/plan` — draft 期整图写回；body 带 version，冲突返回 409；active 状态拒绝结构变更（仅允许 status 字段流转）
- `POST /api/conversations/:id/plan/activate` — draft→active（仅用户入口，打快照）
- `POST /api/conversations/:id/plan/revert`  — active→draft（保留 active 期 status 历史快照）

校验（shared 模块，tool 与 API 复用）：无环（拓扑排序）、节点 id 唯一、depends_on 引用存在、merge 节点入度 ≥ 2 告警。

## 5. 模型 tool

`propose-plan`（agent-chat-tools 薄封装 → 走同一 API/校验）：
- 入参：plan doc JSON
- 行为：draft 期创建/整体替换；active 期仅允许 status 流转
- 失败：返回校验错误明细，模型自修复重试

配套 skill：说明 DAG 产出格式、merge 节点语义、branch 命名约定。

## 6. 前端（vanilla JS，dagre + SVG）

- 会话页右侧可折叠 panel（仿 session-goal-panel 模式），支持加宽与全屏弹层
- draft：拖拽节点、增删节点/边、编辑 title/goal；写回走 PUT（带 version）
- active：只读结构；节点可点选切换 status；节点上展示 spawned_conversation_id 链接与 branch 名
- 渲染：dagre 布局 + 手写 SVG 渲染与交互（不引入框架）
- ⚠️ POC 实现调整（2026-08-15）：仓库内仅有 dagre-d3-es（纯 ESM + d3 依赖），无法被无打包的 vanilla 前端直接加载；POC 内置 dagre 风格轻量分层布局（longest-path 分层 + barycenter 排序，`public/chat/plan-panel.js` 的 `layoutPlan`），零新增依赖。后续若引入打包器再换回 dagre，接口已隔离在 `chat.planDagView`
- 编辑交互落地方式：节点点选 + 表单编辑（title/goal/status/branch/kind/depends_on 勾选），拖拽改结构后置；全屏弹层提供缩放按钮 + 拖拽平移

## 7. POC 验收基线（四步 demo）

1. mock plan JSON 写入存储
2. 主会话前端渲染出图
3. spawn 子会话，子会话面板看到同一份图
4. 模型通过 tool 更新图（含 status 回写），两个会话面板都刷新

## 8. 明确不做（POC 期）

- 节点级 branch 的实际检出/合并执行（只存命名约定与展示；执行语义见 D10/D11/D12/D19）
- 从节点派生子会话的 UI 入口（schema 已预留 spawned_conversation_id；挂载规则见 D13）
- 子会话进度自动回写节点状态
- 数据流边、局部更新拆表（plan_node/plan_edge）
- 显式 input/output 产物字段、`base_branch` 显式声明、`merge_order`（现有 depends_on join 派生已够用，第二阶段真实执行时再评估）
- blocked 传播、status 审计 history、verify 命令、自修复计数熔断（决策已定：D16/D18/D19/D20，实现随第二阶段）
- activate/revert 的服务端权限强制（D15 规则已定，POC 期仅靠约定，第二阶段加 actor 校验）

## 9. 风险

- R1 节点级 branch 并行隔离是第二阶段最大工程点（worktree/检出/merge 节点执行语义），POC 只落 schema 与命名约定
- R2 panel 尺寸承载大图：依赖「加宽 + 全屏弹层」二次扩展，POC 需验证缩放/平移交互
