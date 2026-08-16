---
name: dag-planning
description: "为会话提出或更新 DAG 工作计划（propose-plan tool）。用于开工前与用户讨论并产出结构化任务图、执行中回写节点状态、需要表达多节点依赖与并行/merge 语义时。节点含 goal/status/depends_on/branch/kind，merge 节点负责汇合并行分支。"
---

# DAG 规划（propose-plan）

CAFF 会话支持一份随会话树共享的 DAG 计划（plan）：整棵会话树（含子会话）读写同一份 plan，挂在根会话上。你通过 `propose-plan` tool 提出新计划或回写节点状态，服务端做权威校验，前端 panel 实时渲染。

## 何时使用

- 开工前规划：与用户讨论后，把任务拆成有依赖关系的节点图并提交
- 执行中回写：你完成了某个节点的工作，更新该节点的 `status`
- **不要**用它替代闲聊或小任务——只有多步骤、有依赖关系的工作才值得出图

## 调用方式

```bash
cat <<'PLAN_EOF' | node ./build/lib/agent-chat-tools.js propose-plan --content-stdin
{ "nodes": [ ... ] }
PLAN_EOF
```

可选 `--version <n>`：更新已有 plan 时带上当前版本号做乐观并发（版本不匹配会收到 `plan_version_conflict`，先 GET 重新读取再重试）。

## Plan doc 格式

```json
{
  "nodes": [
    {
      "id": "n1",
      "title": "短标题",
      "goal": "这个节点要达成什么（验收口径）",
      "status": "pending",
      "depends_on": [],
      "branch": "feat/dag-storage",
      "kind": "work",
      "spawned_conversation_id": null
    }
  ]
}
```

字段约定：
- `id`（必填，全图唯一）：稳定的短 id，如 `n1`、`storage-api`
- `title` / `goal`：标题与目标。goal 写清楚验收口径，后续执行以它为准
- `status`：`pending | doing | done | blocked`，缺省视为 `pending`
- `depends_on`：依赖的节点 id 列表（权威边来源；不必单独传 `edges`，服务端会校验一致性）
- `kind`：`work`（默认）或 `merge`。`merge` 节点表示把多个并行分支的成果汇合，入度应 ≥ 2（否则会收到 warning）
- `branch`：节点的工作分支名。**图构建时定名、不立刻检出**；命名从父会话 branch 派生（如父 `feat/x` → 子 `feat/x-node-slug`）。执行期每个节点检出到独立 worktree（`.worktrees/dag/...`）
- `base_branch`（可选）：显式检出基线，**必须等于某个父节点的 branch**；深层链路上的节点应设置它（如 `n2.base_branch = n1.branch`），否则节点分支默认从仓库主干 HEAD 切出，merge 时上游的传递性成果不会进入集成分支
- `verify`（可选）：执行完成后的校验命令。merge 节点尤其推荐——服务端在主理人 agent 报完工后会真实执行它，失败则节点置 `blocked`（fail-closed，不接受口头报工）
- `result`（执行期由调度器/你回写）：≤2000 字符的产出摘要，转 `done` 时携带；下游节点的初始指令会自动注入上游的 result
- `spawned_conversation_id`：绑定的执行子会话 id（由调度器系统通道写入，你只读）

## 生命周期与权限

- `draft`（讨论期）：可整体创建/替换 plan，结构随意改
- `active`（用户点「开始执行」后）：**结构锁定**——你不能增删节点、改边、改 goal/branch/kind/verify/base_branch，只能更新节点的 `status`；尝试结构修改会收到 `plan_locked_*` 错误。上游任一传递节点为 `blocked` 时，下游 `pending→doing` 会被 `409 plan_upstream_blocked` 拒绝（fail-closed），先解阻上游
- `done / archived`：拒写
- draft→active 只能由用户或根会话主理人 agent 触发；子会话里的你没有 activate/revert 权限（403），可以建议，但不要替用户「开工」

## 失败自修复

校验失败会返回 4xx + `issues` 明细（缺依赖、环、重 id 等）。按 issue 逐条修复后整体重传，不要只传差异。常见错误：
- `plan_cycle`：依赖成环，按返回的环路径拆掉一条边
- `plan_dependency_missing`：`depends_on` 引用了不存在的节点 id
- `plan_version_conflict`：版本过期，重新读取最新 plan 再改
- `plan_locked_*`：plan 已 active，只能改 status
- `plan_upstream_blocked`：传递上游有 blocked 节点，先处理上游再启动下游

## 出图建议

- 节点 5–12 个为宜；太碎用户难审，太粗失去规划意义
- 并行分支要有 `merge` 节点收口，merge 节点的 goal 写明「合并哪些分支、如何验证」，并配上 `verify` 命令
- 深层依赖链上的节点设置 `base_branch` 指向父节点 branch，保证传递性成果能进集成分支
- branch 命名遵循父会话派生约定，不要复用已有分支名
- 提交前自检：无环、依赖 id 都存在、merge 入度 ≥ 2
