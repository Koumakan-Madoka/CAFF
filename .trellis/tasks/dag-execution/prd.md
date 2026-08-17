---
feature_ids: [dag-execution]
topics: [dag, execution, scheduler, git-merge, sub-conversation, orchestration]
doc_kind: prd
created: 2026-08-16
branch: feat/dag-execution（已创建，基于 feat/dag-planning-ui-poc HEAD）
predecessor: .trellis/tasks/archive/2026-08/dag-planning/prd.md
---

# DAG 执行层 PRD（第二阶段 · 已收敛）

> 前置：第一阶段 POC（dag-planning）已完成并归档，决策 D1–D20 见归档 PRD。
> 本阶段目标：让「开始执行」真正驱动 agent 干活——**图纸系统 → 施工系统**。
> 立项讨论已收敛：用户拍板调度器形态与 worktree 隔离，Q3–Q6 授权 Kimi 决策，结论见第 6 节 D21–D26。
> 二次收敛（2026-08-16）：用户指出节点缺乏持续驱动与验收机制，拍板 Q1–Q4，结论见第 6 节 D27–D28。

## 1. 背景与目标

POC 的 activate 只翻转编排层状态（锁结构 + version+1），不 spawn 子会话、不做真实 git 操作、无调度循环。用户点击「开始执行」后没有 agent 在干活——这正是本阶段要补的。

**阶段目标**：activate 后，入度为 0 的 pending 节点自动进入执行流，由调度器 spawn 子会话派发任务；子会话完结回写节点状态并触发下游就绪检查；merge 节点执行真实分支合并（含冲突解决与 verify）。

## 2. 继承决策（直接沿用，不重议）

| 来源 | 内容 |
|------|------|
| D10 | merge 冲突由主理人 agent 解决 |
| D11 | merge 目标分支 = 节点自身 branch，基于上游 LCA 检出，按 depends_on 顺序逐条 merge |
| D12 | 合并失败：主理人 agent 有界重试（≤3）→ blocked + 回写原因 |
| D13 | 节点子会话扁平化挂根会话下 |
| D15 | activate/revert 仅根会话主理人 agent 或用户；**POC 未实现 actor 校验，本阶段必须补** |
| D16 | blocked 不传染，但下游 pending→doing 被 API fail-closed 拒绝 |
| D18 | status 流转落 doc 内嵌 append-only history[]（上限 200） |
| D19 | 节点可选 verify 命令；merge 每合一条及合完各跑一次 |
| D20 | propose-plan 自修复熔断（连续失败 5 次硬性报错）；**需确认 POC 是否已落实代码** |

## 3. 范围（Scope）

### 3.1 调度器（scheduler）
- activate 时：找所有入度 0 的 pending 节点 → 置 doing → spawn 子会话（D13 扁平化，挂根会话）→ 子会话注入节点 goal 作为初始指令 → 回写 spawned_conversation_id
- 子会话 spawn 后立即设置**轻量 session goal** 持续驱动（D27）：objective = 节点 goal + 完工指引，显式空 checklist（不继承会话级默认 checklist）
- 节点 done 的触发 = **worker 显式宣布完工（goal complete 提案）→ verifier 验收通过**（D28）；免验收节点由调度器代行 accept；done 必带 result 摘要（D23）→ 触发下游就绪检查（所有上游 done 且非 blocked 才允许 pending→doing，与 D16 一致）
- 验收打回（verifier reject）→ 反馈注回 worker 继续执行，无次数上限（goal 预算 + 对话深度兜底）；goal 预算耗尽 → blocked + 原因
- merge 节点就绪时 spawn 的主理人 agent 承担合并执行（D10–D12、D26）
- 形态：**事件钩子**（D21）；并发上限与排队见 D24；重启恢复见 D25

### 3.2 git 真实操作
- work 节点：spawn 前真实检出节点 branch（基于父会话 branch，D6）
- merge 节点：LCA 检出集成分支（D11）→ 逐条 merge → 每条后跑 verify（D19）
- 工作目录隔离：**每节点一个 git worktree**（D22）；主理人 agent 工作环境见 D26

### 3.3 schema 增量（draft 期向后兼容）
- 可选 `verify?: string`（D19）
- 可选 `base_branch?: string`（显式声明检出基线；merge 节点推荐）+ 校验（须等于某父节点 branch）
- 可选 `result?: string`（done 回写必填的执行摘要，D23；**不引入结构化 input/output 字段**）
- 可选 `verifier?: string`（验收 agent id，D28；须为根会话 participant 且 ≠ 执行 agent）
- doc 内嵌 `history[]`（D18）

### 3.4 API / 权限
- activate/revert 加 actor 校验（D15，403）
- pending→doing 加 blocked 传递上游 fail-closed 检查（D16，409 + 明细）
- status 流转写 history[]（D18）

### 3.5 前端
- 节点卡片展示 spawned_conversation_id 跳转链接
- blocked 节点 + 「上游阻塞」派生徽标（D16）
- 执行进度可视化（doing 动画 / history 时间线，可选）

## 4. 明确不做（本阶段）
- 不放宽树深 ≤2 约束（D13 已绕过）
- 不新增 plan 状态枚举（D17）
- 不做多 plan 并存（D14）
- 不做章鱼合并（D11）

## 5. 验收基线
1. 四步 demo 回归不破（POC 基线）
2. activate → 入度 0 节点自动 doing + 子会话真实创建 + goal 注入（受 D24 并发上限约束）
3. worker 在子会话显式宣布完工（goal complete 提案）→ verifier 验收通过（免验收节点由调度器代行 accept）→ 节点 done（带 result）→ 下游自动就绪
4. merge 节点：worktree 真实检出 + 逐条合并 + verify 跑通（验收通过后仍先过 verifyNodeCompletion 机械校验才落 done）
5. 冲突场景：主理人 agent 重试 → blocked 回写原因 → 人工解除
6. server 重启后执行态 reconcile（D25）：完结→done、存活→原会话恢复一次、失败→blocked；goal 状态（active/验收中/预算耗尽）一并 reconcile
7. 验收打回：verifier reject → 反馈注回 worker → 再次宣布完工 → 通过后 done；goal continuation 预算耗尽 → blocked + 原因

## 6. 立项讨论收敛记录（2026-08-16）

用户拍板：Q1 调度器=事件钩子；Q2 每节点一个 worktree；Q3–Q6 授权 Kimi 决策。

| 编号 | 决策 |
|------|------|
| D21 | **调度器形态=事件钩子**（用户拍板）：订阅两类事件——plan activate、子会话完结/status 回写；无轮询、无独立 watcher 进程；调度逻辑作为 runtime 事件订阅者实现；启动时跑一次 reconcile（D25）兜底丢事件 |
| D22 | **git 隔离=每节点一个 worktree**（用户拍板）：路径约定 `.worktrees/dag/<plan-id前8位>/<node-id>/`；节点 branch 检出进专属 worktree，子会话 agent 的 cwd 即该目录；spawn 前 worktree 若已存在且脏 → 节点置 blocked + 原因，不擅自清理 |
| D23 | **不加结构化 input/output 字段**（Kimi）：输出载体 = 节点可选 `result?: string`（done 回写必填，≤2000 字符）+ 子会话本体 + 分支产物；输入载体 = goal 文本，spawn 时调度器把各上游 `result` 摘要拼进初始指令。理由：摘要字符串已够下游消费，结构化 io 的 schema 演化成本高，未来需要机器可解析产物时再演化 |
| D24 | **并发上限默认 3**（Kimi）：全局同时 doing 的节点数 ≤ `CAFF_DAG_MAX_CONCURRENCY`（默认 3）；超限就绪节点保持 pending（不新增 queued 枚举，与 D17 防状态机膨胀一致），前端派生「排队中」徽标；槽位释放按节点在 doc.nodes 声明顺序 FIFO 补位。理由：本机多 agent 并发跑 LLM+git，3 是保守默认值 |
| D25 | **重启 reconcile**（Kimi）：server 启动扫描 active plan——doing 节点：spawned 会话已完结→回写 done 走正常传播；未完结→向**原**子会话注入「继续执行」指令恢复（不新建会话，保上下文），每节点自动恢复仅 1 次（计数落 history），恢复失败→blocked+原因「server 重启中断」；pending 不动 |
| D26 | **主理人 agent 工作环境**（Kimi）：merge 节点 spawn 的子会话获得——① 专属集成 worktree 作 cwd；② git 操作子集（status/diff/merge/merge --abort/add/commit，走 runtime shell 白名单，禁 push --force 与删分支）；③ 初始指令注入源分支列表（按 depends_on 顺序）、verify 命令、D12 流程（重试≤3→blocked+原因）；④ 无 activate/revert/结构修改权限（D15） |

二次收敛（2026-08-16）：用户指出节点缺乏持续驱动模型干活的机制、且干活 agent 完工后应由验收 agent 把关。Q1 verifier 形态=**同子会话内另一个 participant agent**（用户）；Q2 缺省验收=**可以由根会话主理人 agent 兼任**（用户）；Q3 打回重试=**不设上限**，goal 预算 + 模型对话深度兜底（用户）；Q4 流程定位=**并入本阶段**（用户）。

| 编号 | 决策 |
|------|------|
| D27 | **节点持续驱动 = 子会话轻量 session goal**（用户拍板「只复用 goal 机制，不复用默认 checklist」）：spawn 成功后调度器立即对子会话 set session goal——objective = 节点 goal + 完工/验收指引，**显式传空 checklist**（机制上 `hasChecklistInput` 命中即不注入会话级默认重 checklist；节点内 agent 可自行 update-goal-checklist 建轻量清单）。复用现有 continuation 循环（turn 完结 → Goal Runner 续推）与预算熔断（goal-runner pause 提案 → 节点 blocked + 原因）。节点 done 的触发从「turn 结束」改为「goal complete 被确认」；worker 被告知完工后调 suggest-goal --action complete 宣布 |
| D28 | **验收 agent（verifier）**：schema 加可选 `verifier?: string`（agent id）。解析规则：显式指定 → 必须是根会话 participant 且 ≠ 执行 agent（=worker，即根会话第一位 participant；同人即自验收，spawn 前 fail-closed `dag_verifier_self_review`，呼应 no-self-review 治理）；未指定 → 取根会话 participants 中第一位 ≠ worker 的 agent（多 agent 会话天然「他人验收」，主理人兼任在其非 worker 时成立）；单 agent 会话 → 免验收。流程：worker propose complete → 调度器拦截（不等人工确认）→ 有 verifier：向子会话定向投递验收请求（targetAgentId=verifier，内容含节点 goal / worker result 摘要 / worktree 路径 / verify 命令 / git diff 指引）→ verifier 调 suggest-goal **accept / reject**（bridge 新增两动作，禁止提案人自批 403）裁决；accept → goal complete → 调度器写 done+result（merge 节点仍先过 verifyNodeCompletion 机械校验，双层兜底）；reject → 提案驳回 + verifier 反馈注回 worker（goal 保持 active，continuation 继续驱动），无次数上限。免验收节点：调度器代行 accept。用户在 UI 人工 accept 子会话提案同样生效（兼容人工验收） |

## 7. 开发顺序建议
1. schema 增量（result/base_branch/verify/history）+ 校验 → 2. D15/D16/D18 API 落地 → 3. worktree 管理模块 → 4. 事件钩子调度器（spawn/就绪/排队）→ 5. merge 执行器（D11/D12/D19/D26）→ 6. 前端联动 → 7. 六条验收基线（①–⑦已完成）

二次收敛追加：8. D27 轻量 goal 驱动（spawn 设 goal + done 触发改造 + reconcile 扩展）→ 9. D28 验收流（schema verifier + bridge accept/reject 防自批 + 调度器验收事件流）→ 10. 基线 3/7 端到端回归 + spec 同步
