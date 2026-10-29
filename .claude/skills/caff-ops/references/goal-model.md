# Goal 机制速查

权威文档是仓库里的 `docs/engineering/backend/session-goal.md`、`docs/engineering/backend/planner-interface.md` 和 `docs/engineering/runtime/agent-session-reuse.md`，代码在 `server/domain/conversation/session-goal.ts`、`goal-contract.ts`、`turn/session-reuse.ts`、`turn-orchestrator.ts`。这里是 2026-10 的摘要。

## 数据放在哪

`conversation.metadata` 下有四个相关字段：

- `sessionGoal`：Goal 本体。
  - 基本信息：`goalId`、`revision`、`objective`、`status`（active / paused / complete）、`owner {agentId, agentName}`。
  - `decisions`：`{ committed, provisional, openQuestions, nonGoals, rejectedOptions }`。
  - `acceptanceCriteria[]`：`{ id, statement, verifyBy, status: pending|passed|waived, risk, evidenceRefs[] }`。
  - `workItems[]`：`{ id, text, status: todo|in_progress|done }`。
  - `evidence[]`：`{ id, kind, criterionIds[], summary（≤1000 字）, reference }`。
- `sessionGoalProposal`：待裁决的提案，包括 `action`、提案人、`baseRevision`、理由和提议的内容。
- `sessionGoalRuling`：最近一次裁决，包括 `outcome` 和 `ruledBy`（`kind` 是 user、planner 或 agent）。
- `sessionGoalRunner`：自动续跑状态，包括 `status`、`iteration`、`maxIterations`、`lastContinuedAt`，以及失败计数和阈值（连续失败 3 次、累计失败 5 次）。runner 刚重置时还没有失败计数字段。

## 两类修改

- **常规更新**（agent 用 `update-goal`，REST 里叫 `update-delivery`）：只能改工作项状态、验收标准状态（不能新增豁免）和证据，而且必须带当前 revision。只要碰到 objective、decisions、标准定义（statement / verifyBy / risk）或工作项的 id 和文字，就会被 409 拒绝。
- **结构性修改**：agent 用 `suggest-goal --action revise` 提交提案，由提案人以外的 agent、规划者或用户裁决；规划者驱动的 Goal 里只有规划者和用户能裁决。提案人自己裁决会被 403。规划者和用户也可以直接 revise。
- revise 和 update-delivery 都是合并语义：没传的集合保留原值，传了的集合整个替换，要列出全部保留的 ID（`planner-interface.md` 的「Merge semantics」）。
- **整体替换**：在已有 Goal 的 room 里 set（直接 set 或接受 set 提案），等于换一个全新的 Goal：新 goalId，revision 重置为 1，runner 重置；旧的决策、标准、证据和裁决都不保留，只沿用 createdAt（`goalFromMutation` 的 set 分支）。要保留旧 Goal 的 goalId 和历史就用 revise。
- 同一时间只有一个待裁决提案。新提案会覆盖旧的，并留下 superseded 裁决审计。
- 每次修改成功，revision 都会加一。

## 证据规则

- 验收标准要标成 passed，必须引用证据，而且被引用的证据的 `criterionIds` 里要包含这个标准。
- Goal 要 complete，所有验收标准都得是 passed 或 waived。
- 证据是验收门唯一的凭据，不能删掉这个字段，否则"通过"就只剩一个作者自己就能改的状态。
- 从 PR #162 开始的约定：只在工作项或验收标准状态变化、或者里程碑需要留证时才调用 `update-goal`。中间进展、测试计数、剩余清单写进仓库 docs，不写进证据。过时的证据替换掉，不要往后追加。

## Goal Runner

- Goal 处于 active 时，owner agent 每轮回复完都会被自动续跑。续跑提示是 "Automatic session-goal continuation (n/N). Objective: … Continue with the next concrete step…"，所以 agent 往往每轮只推进一小步。
- 默认上限 20 轮（环境变量 `CAFF_SESSION_GOAL_AUTO_CONTINUE_MAX_TURNS`），跑满就停，需要人工接着推。
- 计数按 epoch 算，键是 `goal.updatedAt`：set、resume、revise、pause、complete 这类生命周期修改开新 epoch，从头计数；update-goal 这类常规更新会把计数带进新 epoch，不重置。dismiss 掉 Goal Runner 的预算提案不改 Goal，计数不变，下次触发续跑时又会生成一个，所以要接着跑只能 resume。
- 没有 owner 时，续跑按默认路由派发：正文里的 @ 提及 → 最近一个公开回复过的 agent（`default_last_agent`）→ 排第一的 agent（`default_first_agent`）。
- `pause` 只拦下一次续跑，不影响正在进行的那一轮。`resume` 和 `set` 会重置 runner。
- **有提案待裁决时，runner 不会自动续跑**（`claimSessionGoalAutoContinue` 返回 `pending_proposal`），runner 的状态也不会更新，所以看起来像卡住了。跑满上限时，runner 的状态会变成 `budget_limited`。
- 跑满 20 轮时，Goal Runner 会自己生成一个 pause 提案（"reached its 20-turn safety budget"，提案人是 Goal Runner）。要接着跑，就对仍然 active 的 Goal 执行 `goal-action resume --allow-clear-proposal --confirm`：它会替换这个提案，把 runner 重置到 1/20，并马上续跑。
- 实测：接受 revise 提案后，runner 也从 1/20 重新计数。
- runner 的字段保留最后一次的值，Goal 暂停以后它可能还显示 running，以 Goal 的状态为准。

## Session 复用与冷启动

- 复用以（会话，agent，profile）为单位。Goal Runner 续跑走严格策略，下面三个 revision 必须一致才能复用：消息创建时记下的 Goal revision、当前的 Goal revision、session 记录的已知 revision。agent 只要在某一轮改了 Goal，下一轮必然 `goal_revision_mismatch`，只能冷启动。
- 严格策略下，上下文占用达到 50% 也必须新开 session（`usage_ratio_above_threshold`）。占用率 = 上一次调用的输入 token ÷ 模型的 `contextWindow`。环境变量 `PI_CHAT_SESSION_REUSE_MAX_USAGE_RATIO`（默认 0.5）只管普通对话；Goal 续跑取 `min(环境变量, GOAL_REUSE_MAX_USAGE_RATIO=0.5)`，这个 0.5 写死在 `session-reuse.ts` 里，只能调低，调高要改代码。工程文档注明这是用户授权的边界。pi 自己的 `compaction`（agent 目录下的 `settings.json`）要接近窗口上限才触发，在 CAFF 里基本碰不到。
- prompt 的静态部分（比如工具说明）变了会触发 `static_hash_mismatch`。部署新代码后，每个 agent 在每个 room 的第一轮都会遇到一次。
- 冷启动的代价是每轮都要重读 skill、项目说明和相关文件。实测平均要两三分钟才第一次改文件，约占每轮时间的四分之一。

## 常见现象和原因

| 现象 | 多半是因为 |
|---|---|
| 工作项长期不动，测试数一直涨 | 工作项没有封闭的完成标准，agent 在同一条链上反复加固 |
| 每轮的 trace 都是 `goal_revision_mismatch` | agent 每轮都在 update-goal，比如把测试快照写进证据 |
| update-goal 返回 409 | 想改工作项文字或标准定义，这得走 revise 提案。agent 通常紧接着只改状态重试就成功了，界面上会显示一个"失败步骤"，属于正常现象 |
| 工作项已经是 done，描述里却还写着"当前仍为……" | 写工作项时把当时的状态写进了定义，状态一变就过时，而改定义要走提案。工作项描述只写"做什么"和"完成标准"，现状写进 docs |
| accept-proposal 返回 409 | 提交提案之后 Goal 又被改过，`baseRevision` 已经过期 |
| 提案不见了 | 被新提案覆盖，或者被带 supersede 的生命周期操作替换了。两种情况都会留下 superseded 裁决审计，看 `sessionGoalRuling` |
| Goal 突然变成 complete，用户以为是 agent 自己结的项 | agent 只能提 complete 提案，也不能裁决自己的提案。看 `sessionGoalRuling`：`ruledBy.kind` 是 `user` 并且没有 reason，就是有人在 CAFF 页面的 Goal 面板点了「确认提议」，或者在输入框打了 `/goal accept`；`planner` 是规划者裁决的；DAG 自动接受会记成 agent `dag-scheduler` 并带 reason。再用 `trace` 看 owner 那一轮的工具调用，排除它直接调了 REST |
| Goal 整个没了 | 被 clear 了，只能从回执重建 |
| 刚 set 完 Goal，就有一个意料之外的 agent 开跑，Goal 也没有 owner | set 时没带 owner，续跑按默认路由派给了排第一的 agent。规划者用 `set-goal --owner` 设置负责人 |
| 跑满 20 轮后不动 | runner 到上限了（状态是 `budget_limited`），需要人工继续 |
| Goal 显示 active、runner 显示 running，却好几天没动静 | 多半在等提案裁决，尤其是 complete 提案（活干完了在等结项） |
| 结项提案一直挂着，接受时报 409 | 提案提交之后 Goal 又更新过，`baseRevision` 过期了。让提案人重新提交，或者由用户直接执行 complete（前提是验收标准全部通过） |
| 提交很多、测试数猛涨，验收标准却一条没过 | 每个小提交都送独立审查（审查耗时≈实现耗时，PASS 率接近 100%），外加每步全量回归。另一个常见原因是用户口头说"先做 MVP"，但验收标准和承诺决策的严格度从来没降，审查者照着它们审，owner 就照着它们加固。大 room 实测审查能占全部 agent 时间的三分之一以上，FAIL 多半出在大批次（+1000 行以上）上 |
| 用户裁决了"小改不审"，owner 仍然每个提交都 @ 审查者 | 裁决只写进了 decisions，续跑提示里没有。owner 冷启动时按惯性走。需要在恢复前给 owner 发一条明确的执行约束 |
| runner 一直在跑，工作项却好几个小时不变；每轮只做"建红测""抽函数""只读确认"之类的一小步 | 有的模型会在推理里给自己设一个并不存在的每轮 token 预算（比如"还剩 14k，不够做完整宿主"），然后缩小这一轮的范围。CAFF 的 prompt、pi 的系统提示词和请求参数里都没有这种预算，轮次结束是 agent 自己 send-public 之后 CAFF 中止下一次调用，不是外部截断。用 `budget-scan.js` 按天、按模型统计这类说法的占比，用 `thinking-grep.js` 看单个 room 的原话 |
| 某条消息显示 `ERROR: 服务重启中断`，runner 不再续跑 | 实例重启打断了正在跑的那一轮，启动对账把它标成了失败；带 Goal 关联的轮次还会在待处理队列里留下 `turn_failed`。重启后不会自动续上，要人工 @owner 继续 |
| 用户已经批过一次"受控诊断"，owner 遇到同类失败又提暂停 | agent 把用户一句"授权"理解成只管那一轮，还可能把管历史失败的规则套到自己刚写的新测试上。裁决时要写明授权对这一类失败长期有效，并写清边界：每次重跑都要带新的诊断或修复、限定次数、保留现场不动；查不清就登记 unknown，转去做别的工作；同时说明只有哪些情况才该提暂停 |
| 测试在加载阶段报 `ERR_MODULE_NOT_FOUND`，worktree 里的 `node_modules` 是空的 | 多半是**别的 room** 的清理误删：有 agent 建临时 worktree 时用 junction 指向别人的依赖目录，解除 junction 失败后删除命令照常执行，就会顺着 junction 把目标清空。定位方法：看 `node_modules` 目录的修改时间，再查同一时段所有 agent 的 session 日志（`find <named-sessions 目录> -newermt`），看有没有清理命令。恢复：在 lockfile 与 package.json 依赖一致的前提下，`npm ci --offline` 只用本地缓存 |
| 代码早就写完，agent 却一直以分支名为由不肯提交，用户说"不用管"也没用 | 目标仓库的 AGENTS.md 规定了分支名格式（比如 `<type>/<kebab>`），CAFF 建的 `room/<id>-<slug>` 不合规，agent 认定提交前本地分支必须合规，口头授权不算规则例外。解法有两种：让 agent 发起平台改名，它会出一张 workspace 授权卡（kind=rename），用户接受后 `conversation.branch` 变成新名，工作区路径和 HEAD 都不变；或者把用户的例外批准写进 Goal 的承诺决策 |
| agent 不肯提交 set 提案，说 Goal 里有"可关联个人账号的身份和邮箱" | 目标仓库的 AGENTS.md 禁止真实姓名、账号和邮箱，agent 认为这条也管 Goal、提交记录这类协作记录。别在 Goal 里写真实身份：把身份和推送留给用户，推送前在本地改写未推送提交的作者（代码树不变）再推送，Goal 里只写"由用户处理"，并要求文档不引用待改写提交的 SHA |

## 分析某个 Goal 的套路

1. `status` 和 `goal`：看状态、提案，以及工作项和标准的分布。
2. `messages --limit 20`：看每轮汇报了什么，以及"下一步"是否一直在重复。
3. `rounds --agent <owner>`：看每轮耗时由哪些部分组成、update-goal 的结果。
4. `trace`：抽查几轮的 `sessionReuseReason` 和失败原因。
5. 结论里把"机制是否健康"和"实质进展"分开写，有数据就给数据，推测要标明是推测。

## 全量效率分析（大 room、跨多天）

`rounds` 是按 session 文件统计的。session 复用时，同一个文件里会有好几轮，所以它会把几轮合成一行，还把轮与轮之间的空闲时间算进 wall（实测有 room 被算成 97 小时，按轮拆开只有 76 小时）。跨多天的 room 改用 `scripts/analysis/` 下的脚本，按 user 消息把 session 拆成单轮，再和 CAFF 消息逐条对上。下面的 `${CLAUDE_SKILL_DIR}` 是本 skill 的目录，也就是 SKILL.md 里 caff.js 所在的那个目录：

```bash
A="${CLAUDE_SKILL_DIR}/scripts/analysis"; D="<系统临时目录>/caff-<room前8位>"; S="<实例 agent 目录>/named-sessions"
mkdir -p "$D"
node "$A/fetch-messages.js" <会话UUID> "$D/messages.json"        # 全部消息（只读，分页拉取）
node "$A/analyze-room.js" "$D/messages.json" "$S" <会话UUID>
#   按天、按 agent 统计：轮次、wall、冷启动原因、revision 区间、update-goal 次数、测试耗时、首次改文件时间；顺带生成 $D/turns.json
node "$A/categorize-turns.js" "$D"     # 按活动分类：实现 / 独立审查 / 治理 / 失败 / 短回复，各占多少时间；冷启动 prompt 的增长
node "$A/reviews-runner.js" "$D"       # 审查结论 PASS/FAIL 和对应的改动规模；runner 每段跑到第几轮
node "$A/list-turns.js" "$D" <起ISO> <止ISO> [摘要字数]   # 逐轮流水，看具体的循环模式
node "$A/tokens.js" "$D/messages.json"                  # 按 agent、按天统计 token
node "$A/thinking-grep.js" "$S" <会话UUID> role-family-gpt <起ISO>   # 推理里的预算、收尾自述：判断每轮是不是被自设预算切碎
node "$A/budget-scan.js" "$S" role-family-gpt [原话输出文件]   # 全部 session：按天、通道、模型统计"预算"说法的占比（扫全部日志，可能要几分钟）
```

再加上 `git log --oneline <基线>..<room 分支>` 和 `git diff --numstat` 看提交节奏，以及源码、测试、文档各占多少。用完删掉 `$D`，里面是 room 的原文。

跨 room 对比（判断是个别 room 的问题还是平台通病）：

```bash
node "$A/scan-review-share.js" 40          # 消息数 ≥40 的新版 Goal room：agent 总时长、审查轮次和时间占比、FAIL 数、验收进度
node "$A/sample-reviews.js" <会话UUID> 15  # 抽看某个 room 最近的审查消息，判断是不是"每个小步都送审"
```

这两个脚本按消息时间戳和关键词估算，结论里要注明是估算。参考：大 room 的审查占比可能超过 40%，小 room 大多在 15% 以下。
