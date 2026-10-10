# Badcase 可恢复采集与 Docker 对照评测契约

Status: draft (W1, Goal `prop_35bba976` accepted 2026-10-10)
Baseline: `f8c797fd6d60c33b63b1eaae772712e80d710c14`
Scope: CAFF 用户 badcase 的执行前检查点采集、用户标记封存、Docker 隔离回放、单一 agent 角色指令的基线/候选对照评测 MVP。

本文件是工程契约，不是交付记录；交付证据记录在 Goal。首版非目标：wiki 自动聚类、自动 prompt 提案、自动发布、生产 prompt 修改、整机/桌面应用/任意工具调用前进程状态的恢复。

## 1. 对象模型

| 对象 | 标识 | 含义 | 关键状态 |
|---|---|---|---|
| CapturePolicy | projectId | 项目级采集授权：开关、授权目录清单、纳入的 ignored 模式、排除模式、暂存期限与配额 | disabled / enabled / suspended(空间不足或采集失败) |
| Checkpoint | checkpointId | 某次 agent turn 执行前的现场：文件清单+内容引用、回放输入、环境指纹、一致性级别 | staged / sealed / expired / incomplete |
| BadcaseFlag | flagId | 用户对某条消息/某次 run 的问题标记：实际问题、期望行为 | draft / confirmed |
| SealedCase | caseId | 标记触发后长期封存的证据包：Checkpoint + 轨迹 + BadcaseFlag 关联 | captured / runnable / reproduced / evaluable（见 §8） |
| EnvironmentTemplate | templateId | 人工配置的环境模板；首次成功重建后归档镜像 | pending / archived(digest+arch 固定) / broken |
| ReplayRun | replayRunId | 从某 Checkpoint 恢复起点的一次容器内执行（baseline 或 candidate） | prepared / running / completed / failed / killed |
| EvaluatorSpec | evaluatorId | 经人审核的验收规则与评分器，含版本 | draft / approved / frozen |
| EvalReport | reportId | 一次对照实验的逐次结果集合 | partial / complete |

关系：`BadcaseFlag → (messageId, runId, checkpointId)`；`SealedCase` pin 住其 Checkpoint 及全部可达 blob；`ReplayRun` 引用 SealedCase + EnvironmentTemplate + prompt 变量 + EvaluatorSpec。

## 2. 采集契约

### 2.1 挂点与时机

- 挂点在 `server/domain/conversation/turn/agent-executor.ts`：上下文快照创建（`buildContextSnapshot`）之后、`startRun`（`lib/pi-runtime.ts`）之前。此时 turnId、worktree、fresh/resume、prompt 全文、模型配置均已确定，agent 尚未触碰文件系统。
- 粒度：**每个 agent turn 开始前一次**。不在每次工具调用前采集。
- **不复用** `context-snapshot.ts`：它是 Inspector 展示投影（受保护分区仅存 presence+hash、疑似密钥被 redact、preview 裁剪）。回放采集是独立通道，与之并行。
- 仅在 CapturePolicy=enabled 的项目、且目标目录命中授权清单时采集；项目关闭后不主动采集。

### 2.2 文件现场

- 纳入：授权目录内的 tracked、dirty、untracked、显式纳入模式的 ignored 文件，以及相对上一检查点的删除状态。
- 排除：授权目录外的一切路径；凭据与私有目录（见 §6 威胁模型）；符号链接越界目标不跟随。
- 表示：内容寻址存储（CAS，SHA-256）。Checkpoint 只存目录清单（路径 → blob hash + mode + size）与删除标记；未变化文件复用已有 blob。
- 首版按**文件级**去重，不做文件内差异去重；大型二进制（数据库、日志、构建产物）须由授权清单显式纳入才采集。

### 2.3 一致性级别（不宣称原子快照）

采集期间 worktree 可能被 room 外写入者（用户编辑器、后台进程）修改。slot 机制只串行化 room 内 agent turn，不能杜绝外部写入。因此：

1. 采集前扫描生成清单 M1（路径+size+mtime+hash 流式计算）；
2. 采集后重扫生成 M2；
3. M1==M2 → consistency=`verified`；不一致 → 有限次重试，仍不一致 → consistency=`best-effort` 并记录差异路径。
- `best-effort` 包可保存、可标记，但**不得参与严格对照评测**（AC2/AC7）。
- 不用 git 脏状态 hash 作为一致性证据（漏 untracked/ignored，且无同时性保证）。

### 2.4 回放输入

- fresh：归档本轮完整 prompt 组装结果与工具/技能配置版本。
- resume：**必须在检查点时刻归档 pi session 文件**（`resolveSessionPath` 指向的 JSONL，含全历史），并校验历史分支/压缩状态/附件/路径依赖完整。缺 session 或依赖缺失 → 标记"不可完整回放"，**禁止静默降级为 fresh**（deliveryMode 是实验条件，变更即换条件）。
- 回放输入独立于 Inspector 投影存储。

### 2.5 凭据与受控变量替换

- prompt 中嵌入的 `CAFF_CHAT_API_URL`、callback token 等运行时凭据：**不归档原值**，归档时替换为占位符并记录位置。
- 回放时由评测服务重新签发并注入。允许替换的变量显式列清单：评测回调地址、运行凭据、工作目录映射、会话标识。清单之外 prompt 逐字节一致；基线与候选使用同一替换规则与归一化 hash。
- 若脱敏/排除导致关键任务输入缺失 → 标记不可完整回放，不猜测填充。

## 3. 存储与生命周期契约

- 位置：CAS 与清单位于项目运行时数据目录下的专用子目录（**在授权采集目录之外**，避免自采集递归），整体 gitignore；不写 fixtures、不写流程台账、不改用户 Git 历史。
- 暂存：默认未标记 Checkpoint 保留 7 天、每项目 10 GiB（可配置初值，P1）；超额可提前清理最旧的**未封存**数据。
- 封存：BadcaseFlag 确认后，关联 Checkpoint 及其全部可达 blob 被 pin，不受期限/配额回收；封存占用对用户可见。运行中 ReplayRun 引用的对象同样受 pin 保护。
- GC：仅回收无 pin、无运行引用、超期或超额挤出的对象；共享 blob 引用计数保护；空间不足/磁盘写失败/采集失败时 CapturePolicy 转 suspended 并显式报告，**不伪造采集成功**。
- 测量：开启前展示授权目录容量预估；运行后展示每检查点新增字节、项目总占用、封存占用；区分文件/session/镜像成本（AC9）。

## 4. 环境与 Docker 隔离契约

- EnvironmentTemplate 首版人工配置；首次成功重建后归档镜像并固定 **digest + 架构 + 运行时版本**。缺镜像/依赖 → preflight 显式阻断，禁止静默回退浮动 tag 或宿主执行。
- **整个被测 pi 子进程**（含 read/edit/write 内置文件工具与 bash）在容器内执行；只包装 bash 不满足契约。worktree 以每次运行独立副本/卷挂载，不以可写方式挂真实目标仓库。
- CAFF server 与调度留在容器外；容器内仅回调**独立评测服务**（独立数据库、会话、凭据、端口、日志）。禁止：生产 DB/凭据、Docker socket、privileged、回连生产 CAFF。
- 网络默认拒绝，按需放行受控模型出口与评测回调；限制 CPU/内存/运行时间；终止走容器 kill 兜底，资源超限可靠终止并安全清理。
- 第一次真实 agent 重跑即在容器内；宿主机只允许"采集 → 临时目录恢复 → 清单校验"静态测试。

## 5. 对照评测公平性契约

- baseline 与 candidate 从**同一 Checkpoint** 各自独立恢复起点；只有声明的 prompt 变量（首版：单一 agent 角色指令）变化；模型配置、harness/tool/skill 配置、EvaluatorSpec 版本一致。
- 对照 manifest 记录：checkpointId、镜像 digest、替换变量清单及归一化输入 hash、模型与参数、评分器版本。
- 被测 agent 不得读取 wiki、参考答案、评分秘密或前次运行产物。
- 真实模型评测须人工发起并批准模型、重复次数、超时与预算上限；未批准预算不能启动；不后台自动付费。逐次记录结果（非仅平均分），披露模型随机性与不可固定外部依赖；不以"必然提分"作为基础设施验收标准。
- 旧轨迹仅用于分析归因，不以播放历史工具输出替代真实工具执行。

## 6. 威胁模型

| 威胁 | 后果 | 契约缓解 |
|---|---|---|
| 凭据/私钥进入 CAS 并随用例扩散 | 秘密泄露 | 授权目录+排除模式；归档前秘密扫描与占位替换；秘密哨兵测试（AC3） |
| 容器内 agent 写宿主机/生产 | 真实仓库与生产状态损坏 | 整体进程入容器；独立副本挂载；禁 socket/privileged；网络默认拒绝；越界路径与符号链接负向测试（AC5） |
| 回放回连生产 CAFF 回调 | 污染生产会话/计费 | 独立评测回调服务与数据库；生产回调访问拒绝测试（AC5） |
| 快照期间并发写 | 起点失真，对照结论无效 | 双扫一致性检测；best-effort 降级且禁入严格对照（AC2） |
| GC 误删封存/共享 blob | 证据丢失 | pin + 引用计数 + 并发 pin-GC 测试（AC6） |
| 被测 agent 读取评分信息 | 评分失真 | 隔离卷不挂 wiki/参考答案/前次产物；manifest 审计（AC7） |
| 预算失控 | 未授权付费 | 人工发起+预算门控，超限停止（AC7/AC8） |
| 采集失败被当成成功 | 虚假可回放状态 | 失败显式标记、suspended 上报、不伪造成功（AC6） |

## 7. 与 Harbor benchmark 契约的复用边界

既有 `room/22bfa2ba-gpt-caff-benchmark-*`（DAG 45d3a849）冻结了 Harbor MVP 契约（固定 Harbor v0.22.0、确定性二元评分、fixture 控制、生成物进 ignored `.runs/`）。本 MVP **不依赖 Harbor**：环境模板人工配置、评测围绕真实 badcase 回放。

可复用的原则（非代码）：版本/ digest 固定、禁止静默 fallback、fixture 作为流水线控制、生成物与凭据不入库。不修改、不合并那些分支；本 Goal 结束后如需要再讨论回放评测接入 Harbor 的后续契约。

## 8. 用例状态词汇（禁止越级宣称）

- **captured（已采集）**：有用户反馈与现场材料。不暗示可运行。
- **runnable（可运行）**：Docker 中任务可启动执行。
- **reproduced（已复现）**：原 prompt 的目标失败在重复运行中以报告的失败率确认；未复现保持诚实状态。
- **evaluable（可评测）**：验收规则可信（人审核），可用于基线/候选比较。

用户标记 ≠ prompt 根因结论；归因区分 prompt、工具/harness、环境依赖、模型能力、证据不足。未复现用例只作为"待验证假设"，不得直接固化为 agent 规则。
