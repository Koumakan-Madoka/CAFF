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
| BadcaseFlag | flagId | 用户提交后持久化的问题标记：实际问题、期望行为 | 当前不可变记录；sealState=pending（不是封存状态已完成） |
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
- 启动失败仍保留关联：检查点成功后若 `startRun` 同步抛错，消息和 stage/task 进入失败状态、保留原始错误与 `badcaseCheckpointId`，并释放工具调用注册；没有运行句柄或错误自带 runId 时记录 `runId=null`，不伪造已启动事件。同步启动异常与运行中异常共用终态处理；启动前已领取的可复用 session 仍按既有规则尝试恢复。检查点存在不证明 agent 已经运行。
- **不复用** `context-snapshot.ts`：它是 Inspector 展示投影（受保护分区仅存 presence+hash、疑似密钥被 redact、preview 裁剪）。回放采集是独立通道，与之并行。
- 仅在 CapturePolicy=enabled 的项目、且目标目录命中授权清单时采集；项目关闭后不主动采集。

### 2.2 文件现场

- 纳入：授权目录内的 tracked、dirty、untracked、显式纳入模式的 ignored 文件，以及相对上一检查点的删除状态。
- 排除：授权目录外的一切路径；凭据与私有目录（见 §6 威胁模型）；符号链接越界目标不跟随。
- 表示：内容寻址存储（CAS，SHA-256）。Checkpoint 只存目录清单（路径 → blob hash + mode + size）与删除标记；未变化文件复用已有 blob。
- **删除恢复语义**：`deletions` 仅表示相对上一检查点的路径差集，不是 Git 索引状态导出。首次采集前已删除的 tracked 文件不在完整文件清单中；恢复只允许写入空目录，按该清单重建，因此该文件仍不存在，不从 Git HEAD 补回。此保证是文件现场的缺席状态，不代表恢复 `.git`、index 或 `git status`；恢复到已有 checkout、应用删除补丁不受支持。不可读缺口不能当成确认删除（见 §2.3）。
- 首版按**文件级**去重，不做文件内差异去重；大型二进制（数据库、日志、构建产物）须由授权清单显式纳入才采集。

### 2.3 一致性级别（不宣称原子快照）

采集期间 worktree 可能被 room 外写入者（用户编辑器、后台进程）修改。slot 机制只串行化 room 内 agent turn，不能杜绝外部写入。必须区分两个不同性质的事实：

- **完整性（integrity）**：清单与 blob 的 hash 校验通过，即“恢复出来的内容逐字节等于清单记录的内容”。这只证明包内自洽，不证明包等于源现场。
- **源现场一致性（consistency evidence）**：有依据表明清单记录的是采集窗口内未检测到变化的现场。双扫相同是“未检测到变化”的检测记录，**不是同时性证明**——协调写入可以让两次扫描读到从未同时存在的状态，任意次数的内容比对都无法排除这种情况。

采集流程：

1. **授权绑定"已打开的目录对象"而非路径名**：仅显式授权动作 `authorizeProject` 把每个授权目录解析为真实路径并持久化为 `authorizedDirPins`（realpath + Linux `statx` 目录对象身份 `(devMajor, devMinor, ino, btime)`）；**普通 `savePolicy` 只保留仍在清单中的目录的既有 pin，绝不钉住新对象**——新增/变更目录保持未钉住，采集按 `authorized_root_unpinned` 失败关闭，直到再次显式授权（GPT 复审 #1 第六轮）。授权后根被替换（realpath 或 statx 身份不符）→ `authorized_root_replaced` 拒绝，缺身份 → `authorized_root_identity_missing` 失败关闭。根身份 statx 在**已持有的同一个根 fd** 上完成（禁止按路径二次打开——两次打开之间的换根会让身份比对与持有对象脱节）。v1 保守边界：采集目标必须恰为授权根本身（`target_must_be_authorized_root`），子目录目标没有独立身份 pin，拒绝而不是降级为路径信任；
2. **受限读取（openat2 限制域，Linux 唯一支持平台）**：采集开始时父进程打开根目录 fd 并在整个采集期间持有（钉住目录对象）；**所有目标树内容读取**（首扫/写时重读/二扫）由 helper 进程以 `openat2(rootfd, relpath, …, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)` 完成——路径解析在内核中相对**对象**原子发生，路径改名/替换/ABA 时序与读取结论无关，符号链接与 bind mount 被内核拒绝（ELOOP/EXDEV），`..` 逃逸被 RESOLVE_BENEATH 拒绝。helper 对同一 fd 读前/读后各做一次 fstat（mtime/ctime/size/ino），不一致即 `changed_during_read`。只读普通文件（O_NONBLOCK 防 FIFO 阻塞，特殊文件拒绝）；单文件上限 64 MiB。helper 为 python3 ctypes 直调 syscall 实现（本仓库 `helpers/badcase-capture/capture_helper.py`，内嵌副本 SHA-256 固定，运行时写入采集存储受信缓存并逐字节校验）；helper 与采集存储不可被被测 agent 写入是部署前提（记入 TCB）；
3. **能力失败关闭**：Linux 要求内核 ≥ 5.6（openat2）+ statx btime；win32/darwin v1 **不支持**（受限逐级相对打开需 NT 内核原语，Win32 无等价物，本阶段无法证明正确性）。能力探测在采集存储内的隔离探针目录自检（普通文件读取逐字节正确、符号链接拒绝、`..` 逃逸拒绝、statx btime 可用），**失败即在扫描用户目录之前拒绝采集，零目标内容读取**；helper 被篡改/崩溃/超时 → `capture_unavailable:*`，无回退读取路径；
4. 采集前扫描生成清单 M1（受限读取、秘密哨兵检测、hash 计算；可用上一检查点的 size+mtime+mode 快速路径复用 hash，仅加速本首扫）；写 staging 时受限重读、重校 hash、重扫秘密，检测扫描与读取之间的变化；
5. 采集后重扫 M2：**全量重新读取并重 hash**（不是 stat 级比对——stat 级无法发现“同长度改写 + 恢复 mtime”）；
6. M1 与 M2 在内容 hash 级无差异且写时重校全部通过 → `content-verified`；检测到差异 → 有限次重试，重试后稳定 → `corrected-after-retry`，仍不一致 → `write-during-capture` 并记录差异路径。重试耗尽的降级包保留最后一轮读取的内容 blob（清单引用它们才能恢复），证据级别如实披露。

- **枚举与 Git 元数据边界**：采集路径不再启动 Git。目录枚举由 helper 相对同一个根 fd 用 `openat2` 打开目录，再按目录 fd 列举、lstat/readlink；不按宿主路径递归，不跟随目录链接或跨挂载。枚举上限 100,000 条，超限或 helper 失败明确拒绝；不支持的文件名/不可读目录留下缺口。`.git/index`、config、info/exclude、树内 `.gitignore` 的字节也经受限读取。`git-classify.ts` 只解析固定子集：index v2/v3/v4、SHA-1/SHA-256 校验和、UTF-8 路径；未实现的必要扩展（如 split/sparse index）降级，不把不完整索引当完整 tracked 集合。Git 配置 include 不展开，符号链接 exclude 不读取，分别记录 `git_config_include_unverified` / `git_exclude_unreadable`。外置 gitfile 元数据只有命中独立 `authorizedInputPins` 且身份核验后才能读取；无授权时 `git_metadata_not_authorized`。配置/ignore 解析不是完整 Git 兼容实现，未验证语法必须降级，不授予完整性。index 拒绝内部 NUL、非零 padding、v4 名长错配、未验证的 extended flags、gitlink/submodule 和保留路径；配置拒绝未验证的引号/子节及 worktree/bare 等分类覆盖。ignore 按 UTF-8 字节匹配，采用动态规划而非通配回溯正则，避免重复星号造成指数耗时；每份规则至多 4096 行、每行 4096 字节，超限显式降级。POSIX 字符类、复杂转义等仍不支持。系统/全局 Git 配置不加载，不宣称重现其 ignore 语义；无法验证的规则不得提供严格评测资格。`enumeration_non_atomic` 明示多次枚举/读取不是原子现场。
- **漏采完整性**：纳入范围但不可读取的文件、特殊对象、不可枚举目录等记录在 `Checkpoint.uncaptured`（path/reason），并使 `replayInput.complete=false`。稳定权限拒绝不必反复重试；缺失/读取变化仍检测和重试。缺口不是用户明确排除，也不能把缺口或不可读目录的子项当成已确认删除。恢复时包内 hash 校验可成功，但返回 `uncapturedInScope`，不能宣称 `replayInputComplete=true`。恢复发生 hash/缺 blob 错误同样阻断完整输入状态。
- **容量预估**：先显式授权目录，再预估，最后另行开启主动采集；`disabled` 不阻止用户主动请求已授权目录的预估，但预估不得扩大授权、重新 pin、修改策略或生成检查点。预估使用与采集相同的根边界：目标必须恰为已授权根，打开后在同一 fd 上核对已持久化的 statx 身份，再枚举；未列入、未 pin、缺身份、根被替换或无独立 pin 的子目录均拒绝，不以 `authorized=false` 配合扫描结果代替拒绝。不启动 Git、不读取目标文件内容，使用同一受限目录枚举原语统计普通文件元数据；未应用 Git ignore，`includesIgnored=true` 表示可能高估，枚举缺口使 `complete=false`。能力探测会在专用存储安装 helper/自检，但不写项目目录或检查点。Windows/darwin 当前预估也失败关闭；这是待补齐的平台能力，不是最终验收范围缩减。
- **树外回放输入的独立授权边界**：session 文件等树外输入必须位于策略 `authorizedInputDirs`（经 `authorizeProject` 钉 pin 为 `authorizedInputPins`）固定的某个目录内，且经受限根打开+读取（realpath 越界 → `session_not_authorized`；输入根被替换 → `session_input_root_replaced`；链接/特殊文件 → `session_read_failed:*`）；不因“属于回放材料”自动获授权（GPT 复审 #1 第六轮：裸 `readFileSync(sessionPath)` 曾读取并归档树外符号链接）。
- **跨重启身份的诚实残余**（`inode_reuse_residual`）：dev+ino+btime 三元组核对目录对象跨重启身份，收敛但非数学消除 inode 复用；仅显式 `authorizeProject` 钉住/更新 pin，普通 `savePolicy` 之外的任何路径都不会重新钉住新对象。

- **一致性证据三级**：`content-verified` / `corrected-after-retry` / `write-during-capture`，三者 `atomicityGuaranteed` 恒为 false。三级都只是检测记录，级别只描述“检测到什么”，不构成严格对照资格。
- **严格对照资格在 v1 恒不可用**（`strictEvalEligible=false`，原因 `no_independent_consistency_evidence`）：严格对照要求独立的源现场一致性依据（如文件系统快照/写屏障），v1 不具备。所有检查点可保存、可标记、可作 best-effort 回放并附一致性证据披露，但**不得参与严格对照评测**（AC2/AC7）。禁止以“清单自洽”“双扫无差异”或重命名状态冒充“现场一致”。
- 对照评测的公平性由“baseline 与 candidate 从同一 Checkpoint 恢复”保证；checkpoint 对历史现场的保真度按 consistency evidence 如实披露。
- mtime 快速路径只用于首扫加速；它对任何资格判定无影响，因为 M2 永远全量重 hash。枚举与读取的 `mtimeMs` 统一由 helper 在 Python 侧从整数 `st_mtime_ns` 派生，禁止把 JSON 解码后已丢精度的 JS 纳秒 Number 再除以 10^6（双重舍入会使未变化文件无法稳定复用）。这仍是毫秒浮点缓存键，不宣称纳秒无损或提高一致性资格；旧清单无需迁移，舍入不匹配最多触发重新 hash，随后写入统一口径。
- 不用 git 脏状态 hash 作为一致性证据（漏 untracked/ignored，且无同时性保证）。

### 2.4 回放输入

- 执行器的 pi 身份读取复用 `pi-model-config-validator.mjs` 的 metadata-only ESM 解析与双包版本钉验（coding-agent/pi-ai）：从与 SDK host 同级的位置使用 `import.meta.resolve` 找到已安装入口，再读包身份；不以 lockfile 声明冒充安装结果，不执行 SDK。当前包只导出 ESM import，不能用 CommonJS `require.resolve('…/package.json')`（该路径未导出）。解析失败、包缺失或版本不符仍返回空身份并降级，不放宽采集校验。身份在进程内缓存，运行期原地替换依赖不受支持，需要重启；识别成功不等于 SDK/工具依赖齐备或镜像可运行。
- fresh：归档本轮完整 prompt 组装结果；运行配置（provider/model/promptVersion/skill 清单）记入 `runConfig`，缺模型标识 → `model_config_missing`，缺 provider/promptVersion → `run_config_incomplete`，不可完整回放。
- resume：**必须在检查点时刻归档 pi session 文件**（`resolveSessionPath` 指向的 JSONL，含全历史）。session **存在 ≠ 完整、语法合法 ≠ 结构可信，未验证维度默认 incomplete**（维度清单制，校验器 `session-validator.ts`，全部规则钉到固定 pi 版本 **0.85.1**——pi-coding-agent 与 pi-ai 均由 package-lock 固定；`CURRENT_SESSION_VERSION=3` 是 session 格式版本，不等于运行时版本，两者分别固定）：
  - **拒绝归档（结构损坏/未验证格式，ok=false）**：非空；每行合法 JSON 且为普通对象；首行 session 头 version 钉死 3（缺 → `session_header_version_missing`，其他 → `session_unsupported_version`；v1/v2 会被 pi 加载时迁移改写，归档原始字节不保真）；条目 `type` 恰好为 pi 0.85.1 的 9 种非头类型（`message`/`thinking_level_change`/`model_change`/`compaction`/`branch_summary`/`custom`/`custom_message`/`label`/`session_info`；未知类型 = 固定版本不会写出的条目 → `session_unverified_entry_type`）；`id` 唯一；`parentId` 后向引用（悬空 → `session_chain_broken`）；message `role` 恰好为存储角色白名单 **{user, assistant, toolResult, bashExecution, custom}**（pi-ai `Message` 联合 + pi-coding-agent `CustomAgentMessages` 模块增强；`branchSummary`/`compactionSummary` 是投影期生成类型，作为存储条目出现即拒绝）；按角色逐字段校验（assistant 需 `api`/`provider`/`model`/`usage`/`stopReason`；toolResult 需 `toolCallId`/`toolName`/`isError`；bashExecution 需 `command`/`output`/`cancelled`/`truncated`；custom 需 `customType`/`display`；内容块按角色限定块类型并逐字段校验）；附件**严格 base64 + MIME 白名单**（png/jpeg/gif/webp；非法编码 → `session_attachment_malformed`）；`model_change` 的 `provider`/`modelId` 必填（→ `session_model_change_incomplete`）；compaction 的 `firstKeptEntryId` 必须是当前叶路径上位于其前的**非头条目**（指向 session 头/自身/未来条目/其他分支 → `session_compaction_ref_broken`，依据 `buildContextEntries` 语义）；branch_summary 需非空 summary，`fromId` ∈ 已见条目 **或字面量 `"root"`**（`branchWithSummary`：`fromId = leafId ?? "root"`）；toolResult 的 `toolCallId` 必须引用叶路径上前序 assistant 的 `toolCall`（→ `session_tool_chain_broken`）；`custom_message` 的 `content` 为 null 即拒绝（pi 类型化 API 不会写出 null）；`thinking_level_change.thinkingLevel` 必须属于固定版本合法值域 {off, minimal, low, medium, high, xhigh, max}（缺字段/对象/未知值 → `session_thinking_level_invalid`——`getSessionContextSettings` 会把该值原样传给 `buildSessionContext`）；`label.targetId` 必须引用已见的非头条目（`appendLabelChange` 对未知 targetId 直接 throw；→ `session_label_target_unknown`），`label` 为 string|undefined；`session_info.name` 为可选 string（→ `session_session_info_invalid`）。每种获准类型都有对应验证器，未实现的类型默认不完整。
  - **可归档但 complete=false（unverifiedDimensions）**：图像编码形态良构但像素/附件依赖未验证 → `image_content_unverified`；`custom` 条目是扩展私有状态，无通用验证依据 → `extension_state_unverified:<customType>`；bashExecution 与 bash/未知工具的自由文本依赖不可静态分析 → `unanalyzable_tool_dependencies:<name>`；已知文件工具（read/write/edit）的 path 实参在授权根外 → `out_of_scope_path_dependency:<name>`（根内**不要求当前存在**——历史工具实参不是本轮启动必需文件）。每个检查点记录机器可读的 `verifiedDimensions`/`unverifiedDimensions`；"需要哪些维度"由固定规则按 session 实际出现的条目类型推导，未识别 ≠ 不需要。
  - 缺 session 或依赖缺失 → 标记“不可完整回放”，**禁止静默降级为 fresh**（deliveryMode 是实验条件，变更即换条件）。
- **harness/skill 内容固定**：skill ID 列表不等于内容固定，serverVersion 非空不等于 harness/tool 配置已固定，**空对象不是有效配置快照**。调用方必须提供：(a) serverVersion（git SHA 或包版本）；(b) 含必填键的有效配置快照对象 `configSnapshot`——必填键及类型：`piVersion`/`agentPromptVersion` 非空字符串、`toolBridgeEnabled` 布尔、`deliveryMode` 枚举（fresh/resume）、`agentName` 字符串；空对象/缺键/类型错误 → `harness_tool_config_unverified`，命中哨兵 → `harness_config_contains_secret`；有效快照经哨兵扫描后归档进 CAS 并记录 hash。**跨字段一致性**：`piVersion`（容许 `pi:` 前缀）必须等于采集器钉住的 pi 版本 0.85.1（session 校验规则与上下文构建语义均钉在该版本真实实现上），不符 → `harness_version_unverified`；声明的 `deliveryMode` 必须与实际采集模式一致，不符 → `harness_delivery_mode_mismatch`（GPT 复审 #3 第六轮：`piVersion=999.0.0`、声明 fresh 实际 resume 曾 complete=true）；(c) 每个声明 skill 的内容快照（id + 来源 + 内容 + sha256）。快照内容经 hash 校验与秘密哨兵扫描后归档进 CAS，使回放包自包含；**声明集合与实际归档集合对账**，空内容不得跳过校验（`content=""` 照常与声明 hash 比对）。缺 serverVersion → `harness_config_unverified`；声明的 skill 无快照 → `skill_snapshot_missing:<id>`；hash 不符 → `skill_snapshot_hash_mismatch:<id>`；含哨兵 → `skill_contains_secret:<id>`；未归档且无更具体原因 → `skill_snapshot_not_archived:<id>`，均不可完整回放。
- 每个检查点携带机器可读的 `integrity.knownLimitations`（常驻限制声明，不是文档级披露）：`no_atomic_snapshot`、`no_independent_consistency_evidence`、`linux_only_capture_v1`、`enumeration_metadata_only`、`inode_reuse_residual`、`helper_trusted_compute_base`、`harness_config_caller_asserted`（配置快照由调用方声明，采集方不独立验证其来源）、`environment_not_pinned`（W4）、`external_service_state_not_pinned`。
- prompt 与 session 在**受控变量替换后的最终字节**上过秘密哨兵扫描；命中即拒绝归档该输入并记录 `prompt_contains_secret` / `session_contains_secret`（输入损失显式标记，不先写 CAS 再脱敏）。
- **执行器关联**：检查点返回后才调用 `startRun`；成功创建的 checkpoint ID 写入 assistant 消息元数据 `badcaseCheckpointId`，运行成功/失败的最终元数据替换均须保留该字段，与消息 `runId` 共存。采集拒绝或异常不伪造 ID，也不阻断正常 turn；这不等于已实现标记 API、重启持久化验收或采集故障 UI。
- **本轮运行图片**与 prompt 文本、执行前 resume session 独立。执行器必须传递实际 `runOptions.images`（包括模型能力投影后的空数组），不能从历史图片标记推断运行输入。当前阶段未实现独立授权的附件归档：仅保存 `invocationImageCount`，非空图片使 fresh/resume 均 `complete=false`、原因 `invocation_images_not_archived`；恢复亦不得上报完整。该通道不保存图片字节/base64/路径/hash，不扩大上传目录授权。显式非数组输入 → `invocation_images_invalid`，计数 null；旧调用方省略字段仍视为无图片，调用方声明的可靠性不是采集器独立验证的事实。附件归档仍是 AC3 交付缺口，不将此降级当作附件支持完成。
- 回放输入独立于 Inspector 投影存储。

### 2.5 凭据与受控变量替换

- prompt 中嵌入的 `CAFF_CHAT_API_URL`、callback token 等运行时凭据：**不归档原值**，归档时替换为占位符并记录位置。
- 回放时由评测服务重新签发并注入。允许替换的变量显式列清单：评测回调地址、运行凭据、工作目录映射、会话标识。清单之外 prompt 逐字节一致；基线与候选使用同一替换规则与归一化 hash。
- 若脱敏/排除导致关键任务输入缺失 → 标记不可完整回放，不猜测填充。
- **秘密扫描无“未检查”路径**：内容已整体读入内存，不设大小跳检上限；文本用完整哨兵模式集，二进制（含 NUL）用高置信子集（`sk-`/`ghp_`/`github_pat_`/`xox`/私钥头）按 latin1 扫描，键值型文本模式不用于二进制以免误报。写 CAS 前对最终字节重扫（TOCTOU 防线）。秘密命中文件不记录内容 hash（低熵秘密的 hash 可暴力反推），只记录排除事实。私钥头模式的边界断言必须覆盖行首/换行后/二进制前缀（连字符前 `\b` 在这些位置不成立）。
- **无豁免机制**：本阶段不提供 secretAllowlistPatterns 一类的秘密豁免（目录级永久豁免会放行后续加入的真实凭据）。已知假阳性路径只能用 excludedPatterns 整体排除，或经评审修订哨兵模式集。
- 授权绑定**目录对象**而非路径名：显式授权动作（authorizeProject）固定 realpath + statx 身份（dev/ino/btime，同一 fd 上查询）；采集时父进程持有根目录 fd，所有内容读取由 helper 经 `openat2` 限制域（BENEATH/NO_SYMLINKS/NO_MAGICLINKS/NO_XDEV）相对该对象原子解析——路径改名/替换/ABA 与读取结论无关，越权内容不会被读取，更不会到达 staging/CAS。能力缺失（win32/darwin/旧内核/helper 故障）失败关闭且零目标内容读取。越界符号链接不读取、不进清单，且使包不完整。

## 3. 存储与生命周期契约

- 位置：CAS 与清单位于项目运行时数据目录下的专用子目录（**在授权采集目录之外**，避免自采集递归），整体 gitignore；不写 fixtures、不写流程台账、不改用户 Git 历史。
- 暂存：默认未标记 Checkpoint 保留 7 天、每项目 10 GiB（可配置初值，P1）；超额可提前清理最旧的**未封存**数据。
- 封存：BadcaseFlag 确认后，关联 Checkpoint 及其全部可达 blob 被 pin，不受期限/配额回收；封存占用对用户可见。运行中 ReplayRun 引用的对象同样受 pin 保护。
- GC：仅回收无 pin、无运行引用、超期或超额挤出的对象；共享 blob 引用计数保护；空间不足/磁盘写失败/采集失败时 CapturePolicy 转 suspended 并显式报告，**不伪造采集成功**。
- 配额核算：占用 = CAS blob + checkpoint 清单 + latest 指针（“零新增 CAS 字节”不等于“零新增总空间”）。每个重试 attempt 都做写前预检（文件 + prompt/session/skill 计划字节 + 清单估值）；**预检是估计，写时实际字节是硬上限**——逐 blob 落盘前按写时读到的实际内容重新核算（扫描后文件膨胀不得先突破配额再失败）；落盘前按实际清单字节终检；终检超额不落清单，可能留下无引用孤儿 blob，由 GC 回收。检查点自报 `newBlobBytes` / `newManifestBytes` / `totalNewBytes`，必须与实际占用增长一致。
- 测量：开启前展示授权目录容量预估；运行后展示每检查点新增字节、项目总占用、封存占用；区分文件/session/镜像成本（AC9）。

### 3.1 本地采集管理 API（Goal D10）

首版信任同一 OS 用户的本地进程。管理请求复用 `local-admin-guard`（loopback、Host、Origin、bootstrap CSRF）；这些检查和 `confirmed=true` **不是人类身份认证**，不抵御同宿主 shell 模拟请求或同权限进程修改策略文件。不注册 agent 授权工具；UI 必须展示目录及风险并显式确认。此边界不豁免 Docker 回放隔离、秘密排除或模型预算审批。

仅已登记 projectId 可访问 `/api/projects/:projectId/badcase-capture`：

- `GET`：策略、七类已提交逻辑占用（见 §3.3）与 `trustBoundary=same_os_user`；不扫描目标。占用包含 cases 记录字节，但尚不提供封存独占/共享 CAS 分摊、暂存 attempt 或 session/镜像分项，不能充当完整容量报告。策略与容量独立可观测：仅 `computeUsage` 抛出 `capture_usage_unavailable` 时，HTTP 200 返回真实策略、`usage:null`、`usageError=capture_usage_unavailable`；正常为 `usageError:null`。成功管理动作的状态响应采用相同语义，不因响应中的容量统计失败而冒充策略写入失败。策略读取/写入、授权 pin 或其他错误不被此降级吞掉；动作本身失败仍返回错误。UI 显示占用未知（不显示零或旧统计），仍可关闭和重新读取；enabled 仅表示策略允许，不保证采集可用。采集器仍直接使用失败关闭的统计，不将未知视为零或放宽配额。
- `POST /authorize`：`confirmed=true`，完整提供 `authorizedDirs`、`authorizedInputDirs`、`includedIgnoredPatterns`、`excludedPatterns`；拒绝相对/空目录、CAS 与授权根互相包含（包括可解析别名）。先持久化 disabled 再 pin；pin 失败也不继续启用，但旧授权范围已被新范围替换，不自动回滚原 pin，需重新授权。平台不支持时 pin 可能没有 identity，授权动作不等于采集可用，后续预估必须明确失败。
- `POST /settings`：仅接受正安全整数 `stagingRetentionDays` / `stagingQuotaBytes`，保留其余策略及原 pin；目录、排除/纳入模式只能重新显式授权修改，普通保存不能扩大授权。
- `POST /estimate`：空对象，逐一预估已授权目标根；不开启、不写检查点。返回逐根 `ok/complete/reason`、文件容量合计和成本口径（未算输入 session、图片、镜像及清单）；重叠授权根可能重复统计。不完整或失败不给开启回执；`dir_not_authorized`、`authorized_root_unpinned`、`authorized_root_unresolved`、`authorized_root_identity_missing`、`authorized_root_replaced`、`target_must_be_authorized_root`、`target_root_replaced`、`root_open_failed`、`statx_failed`、`capture_unavailable:*` 等原因原样返回，UI 不应一律映射为“目录不存在”；未知 reason 保留原值，不推测成功或原因。
- **预估调度边界**：管理端 estimate/enable 使用 `estimateDirectoryAsync`，在独立 Linux 子进程中执行完整能力自检、根身份验证和受限 walk（保留同 fd 安全边界）。每根最多 30 秒、每服务进程最多 2 个并发子进程（不排队，超出返回 `estimate_busy`）；stdout/stderr 合计最多 4 MiB，子进程 Node heap 上限 128 MiB（不是整个进程树内存硬隔离）。超时/超输出杀死专用进程组，等待 close 后返回 `estimate_timeout`/`estimate_output_limit`；失败/损坏输出返回 `estimate_process_failed`/`estimate_output_invalid`，均不给回执。不是被测 agent 或 Docker 回放。Windows/darwin 仍失败关闭；同步入口只用于子进程/离线测试，不得从管理 HTTP 路径回退调用。多根顺序执行，30 秒是逐根上界，不是整个请求上界。
- **并发管理**：每次 estimate/enable/authorize/settings/disable 都使旧操作失效；await 前后校验操作代次及策略指纹，覆盖同值 ABA；enable 完成时再次验证回执未过期。disable 等操作使待完成结果失效，但当前子进程可以继续到完成/30 秒超时，不据此重新开启。不同能力探针使用独立随机目录避免并发互删。强杀发生在自检期间可能留下仅含合成探针的目录；不自动删除无法证明属于本次调用的遗留目录。父进程崩溃后的孤儿治理未在此切片交付。授权 pin、策略/容量存储读写以及 turn 采集仍有同步路径，本切片不声称整个服务器已无阻塞操作。
- `POST /enable`：`confirmed=true` + 成功预估的 `estimateId`。回执绑定项目及完整策略，仅本进程有效、10 分钟过期、使用后消耗；重新授权、普通保存或关闭使其失效。开启前再验证目标根身份和枚举，失败拒绝；这不是原子快照或空间保证。服务重启保留策略（含 enabled），但未使用的回执失效，需要重新预估。
- `POST /disable`：空对象，关闭后不再主动采集；不扫描，不自动删除既有材料。
- **写锁争用**：管理动作遇到结构化 `capture_writer_busy` 返回 HTTP 409 与同名 issue，不映射为 500，不自动重试/解锁。写入前争用不修改持久策略，但操作代次/旧预估回执仍失效；释放锁后 enable 必须重新预估。authorize 分为先保存 disabled、再 pin 两步，不承诺整个动作原子回滚（第二步争用时第一步可能已经落盘）。UI 明确提示“存储正忙”，保留重新读取/重试入口，不宣称已关闭或保存成功；其他异常仍由原错误路径处理。

项目管理页提供采集管理面板，始终针对**选中项目**而非激活项目：读取状态不授权、不扫描目标、不开启；目录、输入根、ignored 纳入及排除模式从持久化策略载入，不自动填入项目路径。授权确认展示全部范围及“先关闭、失败仍替换旧范围”的风险；预估成功后需另行确认开启。普通保存只提交期限/配额，响应会恢复持久化范围并明确提示未保存的范围草稿已丢弃。编辑、失败、刷新、切换项目及本地过期均丢弃 UI 回执；服务端仍是授权/回执有效性的裁定者。未知错误码和逐根失败原因以纯文本保留。请求使用 bootstrap 的 `localAdmin.modelProviders` 本地管理能力与 CSRF（与控制器共用同一门禁），能力/令牌缺失时禁用管理，不自行绕过。

UI 用 selection/action generation 丢弃过时响应（含 A→B→A），等待预估/开启时仍可点击关闭；切换项目不会撤销已发送的管理请求，重新读取才能确认持久化结果。关闭使服务端在途结果失效但不立即取消 worker；多客户端冲突以服务端为准。预估显示原始字节及口径，已提交总占用使用 `computeUsage` 的统一口径（blob/checkpoint/latest/flags/retention/cases/runReferences），管理页显示这七项逻辑文件字节及总和；CAS 中 session 尚未独立分项，未宣称含所有暂存、镜像或单 turn 新增占用。

UI jsdom/合成 HTTP 测试不等于真实用户采集证据。文件/session/镜像独立成本、单 turn 新增占用及封存/回收仍待交付；消息标记入口见 §3.2。控制器测试的正向开启部分使用合成预估；Linux 用真实 collector 的预估/换根负例单独验证，不将 API/UI 测试称为真实 agent turn 或严格评测证据。

### 3.2 消息标记持久化、API 与 UI

`badcase-flags.ts` 提供 `mark/get` 服务，写入 `<captureRoot>/projects/<projectId>/flags/<messageId 的 SHA-256>.json`。当前只保存用户的实际问题/期望行为及服务端消息关联，不读取目标文件、不复制消息正文/轨迹、不授权或开启采集；不是 `SealedCase`，不能据此声明材料已长期保存。

- 项目归属从 conversation 校验，消息须属于该 conversation 且为终态 assistant；runId 使用生产 ChatStore 的正整数或 null，不伪造运行 ID。checkpointId 只从消息元数据取；清单存在时核对 project/conversation/turn/agent/checkpoint ID。清单存在只表示 `manifest_present_unverified`，不证明 blob 完整；没有关联或清单不可读分别记录 `not_recorded` / `missing_or_unreadable`。关联错配拒绝，不静默改绑。缺失 captureStore 或 loadCheckpoint 抛错同样归为 `missing_or_unreadable`；历史消息缺 turnId/agentId 时保留用户标记和 checkpointId，但记为 `association_incomplete` / `checkpoint_unavailable`，不宣称已验证关联，已知字段错配仍拒绝。
- **封存关联冻结**：新标记在首次发布时增加可选 schema-v1 字段 `sealAssociation`，包含 project/conversation/message/turn/agent/task/checkpoint/run 八个键；全部源字段符合轨迹读取器的标识格式时才保存，否则为 null。它不证明轨迹来源授权、task/run 数据库关联或 checkpoint/blob 完整；这些仍须在后续读取/保留阶段独立验证。内部只读 `resolveSealAssociation(scope)` 重验消息归属和终态、校验持久关联的精确键集合及其与 Flag 基础字段的一致性，再逐键比对当前消息，只返回脱离副本。原消息字段变化报 `flag_seal_association_mismatch`，无标记报 `flag_not_found`；旧记录缺字段或首次为 null 报 `flag_seal_association_incomplete`，不使用后来的消息补齐、不改写原记录。旧记录仍可查询/同文重试；损坏关联报 `flag_record_invalid`，不当作历史缺失。此入口由 §3.5 封存编排调用；自身不触发归档、不授权读取任意工具文本、不改变 Flag 的 pending 状态。HTTP GET/POST 返回的 flag 包含冻结的八键关联（含 turnId/agentId/taskId），不是仅返回原有基础字段。
- 首版每项目每消息一条不可变标记；相同文本重试返回原标记且不重新绑定后续变化的 run/checkpoint/turn/agent/task。不同文本返回 `flag_already_exists`，不覆盖原始问题；编辑/多条标记工作流尚未提供。每个文本上限 8192 UTF-8 字节，空白、NUL 和现有秘密哨兵拒绝，错误不回显原文。哨兵仍非通用秘密识别证明。
- 完整临时文件 fsync 后以同目录 hardlink 原子、禁止替换地发布；并发竞争只接受一个记录，相同请求收敛、不同文本冲突。无 hardlink 能力或磁盘失败显式报错，不退回覆盖 rename。校验和用于检测意外损坏，不认证同 OS 用户；损坏记录不得当作不存在而覆盖。未实现目录 fsync，不承诺突然断电后的持久性；进程崩溃可能残留 `.tmp-*`，本切片不自动清理。
- HTTP：`GET/POST /api/projects/:projectId/conversations/:conversationId/messages/:messageId/badcase-flag`。POST 复用 local-admin guard 与 bootstrap CSRF（D10）；GET 仅校验 loopback/Host，不要求 CSRF token，同一 OS 用户的本地进程可读取标记描述；项目必须仍登记，scope 只从路径读取并由 ChatStore 核验。POST 仅接受 `confirmed=true/actual/expected`；不接受客户端 run/checkpoint/status，首次 201、幂等重试 200、不同文本 409。生产控制器在标记持久化后等待异步封存结果，响应额外含独立 `seal` 投影；封存失败不将已保存的标记变成 HTTP 写入失败，见 §3.5。GET 返回 `{flag:null,seal:null}` 或标记及封存投影，不授权、不扫描、不创建标记；内部 get 只投影 scope，忽略额外字段，HTTP 不接受客户端 body 派生 scope。读取失败/磁盘失败分别 409/503；业务错误只返回白名单错误码，未知异常统一 `badcase_flag_unavailable`，不回显路径/用户文本。JSON/body 解析层的 400/413 由路由通用错误处理，不保证带 `issues` 数组，UI 必须兼容。没有新增 agent 工具，confirmed 参数不是人类身份认证。
- `get/mark` 每次都重验源消息。源消息删除后 404、变非终态后 409，不再通过此消息入口暴露既有记录，但磁盘标记仍保留；项目取消登记后也不可通过 API 查询。尚无按项目列举或孤立 flagId 查询入口，不承诺删除后的检索。对仍存在的消息，服务/SQLite/HTTP 重启后记录可查询且关联固定。
- 存储写路径（含 flags 目录）属于受信 TCB：必须是服务持有、未被不可信进程写入的本地专用存储，不纳入采集目标、也不挂载给回放 agent。当前按路径创建目录/发布，没有与目标读取同等的 openat2 限制，不能抵御同权限进程将存储子目录替换为符号链接；D10 信任同一 OS 用户不是技术沙箱。校验和和本地管理 guard 均不改变此限制。
- `sealState=pending`，`captured/runnable/reproduced/evaluable` 均为 false，明确 `checkpoint_not_sealed` / `trajectory_not_archived` 等缺失。Flag 不可变字段不承担后续封存状态；查询独立 seal 投影判断材料是否保存。检查点引用接线见 §3.5，运行引用与 GC 仍未交付。标记写入使用共享 writer lock，但为了保留用户报告，描述本身仍无配额拒绝；不能据此宣称所有写入总量受硬上限约束，也不能把标记落盘视为完整封存验收。

聊天 UI 在终态 assistant 卡片提供“标记问题”，包括没有 agent 配置或 checkpoint 的历史消息。弹窗按当前 Room 的项目归属查询，缺项目不发请求；打开只 GET，不扩大授权或开启采集。UI 从 bootstrap 获取管理能力/CSRF，缺失或查询失败禁用提交；既有标记只读。首次填写实际/期望时在原有一次标记确认中说明不可修改及自动保存已有现场；不增加封存按钮或第二次确认，只 POST 三个允许字段，不提交 run/checkpoint/status。UTF-8 长度/非空/NUL 先在客户端检查，秘密哨兵及归属仍由服务端裁定。旧服务无 seal 投影时显示“已标记 · 待封存”，新区分保存失败、缺现场和材料已保存但不完整，不显示已采集/可回放。未知业务错误用纯文本、无 issues 的解析错误显示 HTTP 状态；失败保留草稿，可能已落盘须重新查询或原文重试，不自动覆盖冲突。

消息切换、A→B→A、关闭或会话切换用 generation 丢弃旧响应。弹窗关闭清空本地草稿和 token，已发 POST 不会撤销；重开再次查询。原生 close 事件是排队任务，旧 close 到达时若弹窗已重开不得清空新状态；回归使用显式队列覆盖此顺序，并验证真正关闭仍清空。保存中禁用重复提交，关闭始终可用。Flag 仍验证 pending/四项 false，独立 seal 投影展示保存中、未保存、失败、缺关联或材料已保存但不完整。失败/未保存提供同文重试，不再弹额外确认；描述仍只读。非预期状态、完整性宣称或关联不匹配拒绝。jsdom/合成浏览器证据不替代真实采集、封存或回放验收。

### 3.3 检查点持久引用底座（内部 API）

`createCheckpointRetentionStore` 保存 `projects/<projectId>/retention/<sha256(referenceId)>.json`，由 §3.5 文件 worker 使用。它本身不是 SealedCase，不自动改变 Flag 的 pending 状态，也不产生 captured/runnable/reproduced/evaluable。仅受信服务调用方可传入由服务端派生的项目/checkpoint/会话/turn/agent/reference 关联；此模块不读 ChatStore、不自行证明用户授权、不暴露 HTTP 或 agent 工具。实际标记接线还必须复核消息和不可变 Flag 关联，不能把这些字段交给客户端。

- 首次 retain 校验五元组和当前 schemaVersion=1；保存完整 JSON 清单副本（含删除、排除、不完整原因和模式），冻结原有材料，不将 resume 降级 fresh。不要求输入完整才保留已有证据；缺失输入仍缺失，保留的 complete 字段是原采集器声明，不是本模块重新认证。
- 已存在的普通文件、prompt、session、harness config、skill 引用按 SHA-256 去重；全部 hash 语法先验，再逐 blob 读取、校验内容 hash 和秘密哨兵。缺失、损坏、不可读均拒绝新引用。该闭包只理解当前 schema-v1 引用字段，新增引用类型须同步升级读写契约；不证明附件、轨迹、环境或严格一致性已满足。
- `wx` 临时文件 + 文件 fsync + 同目录 hardlink 原子禁止覆盖发布；同 reference/关联重试返回最初副本，并重验其 blob；不同关联冲突。发布竞争以完整的胜者记录为准，失败不覆盖、只尝试删除本次临时文件。源清单被覆盖/删除不影响副本；不改用户 Git、不复制 CAS blob。无 hardlink 能力失败关闭，不退回可覆盖 rename。文件权限 POSIX 0600；未承诺目录 fsync/掉电持久性。
- `get` 与 `protectedObjects` 只读取/验证引用记录，不证明当前 blob 仍完好；后者返回去重 checkpoint/blob 集合、引用数和引用元数据字节。记录损坏、错配、闭包被删减、未知目录项不静默跳过；发现未完成临时文件返回 busy。引用自身无自动过期或删除入口，即使 blob 丢失也仍保留保护集合。
- **尚不是 GC 安全事务**：无 writer/GC 共用事务、无在用 ReplayRun 租约、无自动崩溃恢复；§3.5 的同步 writer lock 与容量终检不构成 GC 事务，inventory 返回不能作为允许删除的证明（枚举与后续写入仍可竞争）。自动 GC 继续禁用。孤立引用/临时文件可能残留，不能自动清理。`computeUsage` 已将保留清单与标记元数据计入总量及 `bytesByKind` 分项，管理 API/UI 和采集器现有配额预检共用此总量；消息标记生产 API 已写入 flags，标记→保留/封存写入及写者协调见 §3.5；单独调用底座仍须由可信调用方持锁和进行容量检查，统计本身不等于容量保护。
- 延续 §3.2 同 OS 用户存储 TCB：静态引用文件链接/特殊文件拒绝，但目录路径不提供 openat2 防替换保证、checksum 不抵御同权限篡改。校验 blob 当前为同步路径，一次读一个 blob；生产 HTTP 通过独立文件 worker 调用，不能在主事件循环同步验证大包 blob。任意轨迹正文的来源验证与归档、恢复入口仍待交付。

#### 已提交容量口径

`computeUsage(projectId)` 返回 `blobCount`、`totalBytes`、`bytesByKind: { blobs, checkpoints, latest, flags, retention, cases, runReferences }`。总量为七类目录中非 `.tmp-` 文件的 `stat.size` 之和（逻辑字节而非物理分配块），不解析元数据；损坏清单仍占容量。CAS 按实际存储对象计一次，不按引用数重复计数；各保留清单记录（含清单副本与引用元数据）字节分别计入，共享 CAS blob 仍只计一次。标记/保留的幂等重试不新增容量。

不计 policy、staging、未发布临时文件、镜像和未知目录；不得称为整块磁盘总占用或 free-space 保证。目录或条目静态链接/特殊文件、元数据枚举/读取失败、枚举后条目消失及数值溢出抛出净化的 `capture_usage_unavailable`，不返回零或部分成功；管理 HTTP 仅在状态投影层转为显式容量未知，见 §3.1。缺少某类别目录视为该类尚无数据。父路径仍属同 OS 用户可信存储；这不是抵御并发路径替换的安全遍历。统计同步且非原子，本身不提供预留、GC 锁或增长上限；§3.5 封存写入在共享锁内基于此总量终检。未开启任何 GC。

### 3.4 独立数据库轨迹读取层（内部只读 API，尚未归档）

异步入口 `readBadcaseTrajectoryAsync` 使用可信的一次性 Node 子进程，只读打开已存在的 SQLite，不执行 ChatStore 迁移、agent、shell 或 session 文件遍历。每 Node 父进程最多两个读者，不排队；每次最多 30 秒，stdout/stderr 合计最多 4 MiB + 1 KiB，Node heap 128 MiB（不是原生 SQLite 内存或 RSS 上限）。超时/超量强杀子 PID，等待 close 后释放名额；非零退出（含原生崩溃）即使已输出合法 JSON 也拒绝。不转发 stderr/未知错误，仅返回固定原因码；清除 Node 启动钩子及无关宿主环境变量。进程选项/测试观察器仅供内部可信调用，不得由 HTTP/DB 输入指定。

当前 worker 不创建子孙进程，因此只终止其 PID；这不是通用进程树沙箱或 Docker 被测运行时。父进程崩溃后的孤儿治理未实现。父侧复验关联、大小与不完整状态，不把进程正常返回升级为完整封存；§3.5 已从标记 API 调用该入口，但不保存原始返回正文，亦未解决已观测的特定 Linux Node24 原生模块崩溃。

`readBadcaseTrajectory({db, association, limits})` 直接读取 SQLite，而不复用 `message-tool-trace` / Inspector 的首尾窗口、摘要或脱敏展示。当前只是封存编排的输入适配器，无 HTTP/agent 工具入口，不写 CAS、不改变 Flag，不构成 `SealedCase`。

- 调用方必须先取得封存授权并从不可变关联派生 project/conversation/message/turn/agent/task/checkpoint/run；模块再检查项目归属、消息各关联、task metadata 的会话/turn/agent 以及 task↔run 双向关联。缺关联、已知错配、非终态或数据源异常均返回固定错误码，错误不携带数据库文本或路径。
- 单 SQLite 只读事务内读取 task 输出/错误、run 的 assistant errors、**全部** `agent_tool_call` / `agent_reply_terminating` 事件，按 id 排序；保留原始 payload 内容而非截短展示。其他事件只计数并声明未归档。上限默认 10,000 个选中事件、返回 JSON 4 MiB，内部调用可调低不能调高；metadata 单份 64 KiB。UTF-8 数据字节在 SQL 中预检（仅最终大小的下界，不是瞬时内存上限），最终 JSON 字节再检；超限整次拒绝，不悄悄截断。SQL 汇总仍可能遍历大量行，同步读取器没有执行时间或数据库总大小保证；后续 HTTP 封存编排必须使用异步进程入口，不可直接同步接入主事件循环。
- 不额外读取 `chat_messages.content`，但 `task.output` 可包含与 assistant 消息相同的完整回复正文。不输出 run prompt、task 原始 metadata、session 路径；不打开任何 session/附件文件，不读取祖先快照或擅自扩大授权目录。已知当前消息/task、直接触发消息的私有标记拒绝；直接触发消息缺失或跨会话也拒绝。更远私有祖先、任意工具文本的来源授权尚未证明，明确 `private_ancestry_not_verified`，调用成功不能当作落盘授权。
- 对返回的 task/run/事件内容做秘密哨兵、敏感 JSON 键（包括短值/嵌套 JSON 字符串）、Bearer/赋值文本与私有标记检查；命中整包拒绝，不先存再脱敏。已知 `send-private/read-context` 工具也拒绝。它是保守的已知模式过滤，会误报，**不能证明任意自由文本不含未知秘密或未授权内容**；不替代后续归档授权/来源检查与凭据受控替换。
- 返回 `databaseConsistent=true` 仅指本次 DB 读事务；`complete=false`、`strictEvalEligible=false` 恒定。执行后 session、原始 context snapshot、usage、timeline、附件、私有祖先与跨文件一致性均明确未完成。turn 前 resume session 仍是独立检查点材料，不可拿这份 DB 证据替代。§3.5 只使用其成功计数/固定失败码，正文仍不归档；GC 继续禁用。

### 3.5 标记即保存已有现场（不完整封存）

用户选择点“标记问题”即直接封存，不增加第二次确认。生产 `create-server` 注入 `createBadcaseSealingService`：POST 先通过原有标记校验并持久化不可变 Flag，再执行异步读取/文件保存；HTTP 请求等待结果，不是持久后台任务队列。断开客户端不主动取消；GET 只读、不补归档。旧标记仅在显式同文 POST 重试时尝试封存，启动/查询不批量补写。

- 首次/重试从冻结八键关联派生请求。等待轨迹读取后再次核对当前消息，缺失/改变拒绝文件写入；同一服务同一 flag 的在途调用合并。不同文本仍冲突，客户端不能传 worker 路径、存储根、关联或归档内容。
- 原始轨迹正文 **一律未归档**：现有读取器不能证明任意工具文本/远祖私有来源已授权。读取成功仅保存固定原因 `trajectory_provenance_unverified` 及事件总数/选中数；读取失败仅保存白名单原因码。task output/error、事件 payload、路径等均不进入 case 或 CAS；秘密/私有拒绝同样不保存正文。这里保存的是已授权采集器先前生成的检查点及其现有闭包，不重新扫描目标，不开启项目、不读取新的 session/附件。这不是目标中完整轨迹归档的完成证明。
- SQLite 读取在既有只读子进程完成且必须干净退出，随后另启不加载 SQLite 的文件 worker，持锁校验并保留清单和每个现有 blob。文件 worker 每父进程最多两个、不排队；达到上限先报 `seal_busy`，未达上限而同项目已有写者时报 `capture_writer_busy`，二者均不启动新的 worker。30 秒超时、stdout/stderr 合计 64 KiB+1 KiB、192 MiB Node heap，剔除宿主 preload/凭据环境；非零退出拒收成功。只从受信 CAS 读取，不启动 agent/shell。worker 输出仅承载 case 结果及协议包装，不返回最大 16 MiB 的 retention 清单；输出限制不能用作清单大小限制。强杀后仍占并发名额直到 close 回收，避免尚未退出的进程逃出并发上限。文件 worker 的锁改由父进程在 spawn 前取得，只委托给这一子进程执行同步写入；正常/异常/超时都等 close 后由父进程释放本次锁。强杀可能留下未发布临时文件，但存活父进程可释放本次锁、允许显式重试；不是扫描或回收历史锁。父进程自身崩溃、机器断电和孤儿治理仍未解决。
- case 独立存于 `projects/<projectId>/cases/<sha256(messageId)>.json`，不改原 Flag；记录关联、固定状态、检查点引用 ID、来源缺失和计数，不含标记原文/清单副本（后者在 retention）。64 KiB 上限、校验和、精确字段/关联校验，文件 fsync+hardlink 禁止覆盖。相同关联重试验证原保留闭包而不重新绑定当前清单；损坏 case/引用/blob 拒绝，不覆盖为新成功。目录 fsync 与掉电保证未实现，路径祖先仍是同 OS 用户可信存储。
- 独立 `seal.state`：`saving`（本进程在途）、`not_saved`（无最终记录）、`failed`（本次操作失败）、`unavailable`（冻结关联缺失/改变）或 `saved_incomplete`（最终记录已发布，检查点闭包曾校验保存）。只有最后一种显示“现场已保存·材料不完整”。`complete/captured/runnable/reproduced/evaluable/strictEvalEligible` 仍全 false；不认证 checkpoint 输入完整、环境或一致性。GET 的已保存状态是发布记录，不重新逐 blob 审计；显式 POST 重试才复验闭包。失败不覆盖/删除已有 case，因此失败 POST 与后续 GET 的历史发布记录可能不同，不能把 GET 解释为当前完整性审计。
- 标记已成功、封存失败时 POST 仍返回原 201/200 与 `seal.state=failed`，不丢用户报告；未知错误只显示固定码。失败状态不是独立持久审计日志；重启后无最终记录显示 `not_saved`，UI 支持同文重试。文件写失败（如 ENOSPC）在正常栈退出后释放锁，可重试；引用已发布而 case 失败时保留孤立引用，重试收敛，不自动删除。文件 worker 强杀后仅在父进程仍存活且确认 close 时释放委托锁；父进程/机器崩溃后的锁恢复仍待交付，不能据此声称 AC6 已完成。释放失败返回固定 `seal_lock_release_failed`，保留失败关闭状态，不伪造成功或递归删锁。
- `project-write-lock.ts` 用项目 `.writer-lock` 目录互斥，覆盖生产 turn collector、Flag 写入、策略 savePolicy 和文件封存 worker；同步调用栈内允许重入。争用失败关闭，不排队，不按 PID/时间自动抢锁。只约束合作写者，不防同权限恶意修改；底层 CAS/retention 直接 API 仍要求调用方持锁，尚未交付 writer/GC 事务或运行租约。锁文件状态不计逻辑容量。文件 worker 的 supervisor lease 在 `.writer-lock/owner` 保存本次随机标识（0600）；该标识通过独立内部协议字段传给子进程，不采用 HTTP/数据库请求里的 lockOwner。借用时核对项目路径与完整标识，子进程只在同步调用栈内开启重入、绝不释放父锁；父进程持有 lease 时不进入进程内重入集合，故同父进程的管理/collector/标记写入照常报 busy。父进程只在没有创建子进程或子进程 close 后释放自己的 lease，释放前复验 owner，不凭时间/PID抢锁；旧空锁目录、未知/损坏 owner 不自动修复。该标识不抵御同权限进程篡改，也不是新的授权凭据。父子进程同时更新为前提，不承诺热升级混用 worker 协议。
- 封存 worker 在锁内将**最终 case 字节与新 retention 的实际序列化字节**一起预检，再发布引用并终检 case；容量未知/不足拒绝新增封存，不按零计算。case 字节计入管理 API/UI 与采集预检总量；CAS 不重复复制。这里只限制受锁协调的封存计划，不预分配物理磁盘、不限制标记描述本身增长；空间耗尽仍可能写失败。未自动启动 GC、真实项目采集或模型。

复跑入口：构建后 `node --test tests/runtime/badcase-sealing.test.js` 覆盖容量/损坏/关联拒绝、失败重试、同文幂等、独立 Node 进程只读查询、SQLite/服务重建及真实临时 HTTP。安装了 Playwright Chromium 的环境可运行 `node scripts/badcase-capture/verify-sealing-ui.cjs`，使用临时 SQLite/CAS、随机 loopback 端口和仅允许该端口的浏览器网络，验证取消零 POST、容量失败后同文重试无二次确认、重新打开仍显示材料不完整。后者是生产面板/控制器的合成页面，不是完整应用或真实 turn；不启动模型、不打开真实项目采集。`node --test tests/runtime/badcase-sealing-lifecycle.test.js` 另以真实文件 worker 在 retention 发布处注入阻塞，验证强杀/超时→close→释放本次父锁→显式重试，以及外来锁保护、委托验证、错误输出与并发名额；不删除中断留下的临时文件。它不证明父进程崩溃恢复、孤儿治理、掉电持久性或 Docker 回放；Linux SQLite 门槛仍单独保留。

### 3.6 回放运行的持久保护引用（内部底座，未接 launcher）

`createReplayRunReferenceStore` 提供 `protect/get/protectedObjects`，存储在 `projects/<projectId>/runReferences/<sha256(replayRunId)>.json`。不是运行任务账本或活跃进程检测器，没有 HTTP/agent 工具入口；已由 §4.2 内部文件恢复探针在创建 Docker 前调用，但尚未接入 pi 回放 launcher，不代表实际启动/完成了 agent 回放。未来 launcher 必须先成功 protect，再创建运行；模块为同步文件操作，只能由可信文件 worker/离线工具调用，不能直接放到 HTTP 主事件循环。

- 输入为服务端派生的 `replayRunId`、已有 retention 的 `referenceId` 及项目/checkpoint/会话/turn/agent 五元组。只引用**已保留的不可变副本**：源引用缺失必须失败，不从当前 live checkpoint 补建；每次 protect（包括幂等重试）复验源关联、全部 blob hash 与秘密哨兵。ID 也做秘密哨兵检查；不写 prompt、轨迹或凭据。
- 记录冻结上述关联、源 checkpoint JSON 的 SHA-256、去重闭包与创建时间。每项目每 replayRunId 一条，不允许改绑；基线和候选可使用不同 run ID 指向同一源副本，不复制 CAS 或整个清单。源保留清单变化、损坏或缺失必须拒绝，不静默读 live 清单。记录不含 runnable/running/reproduced/evaluable 声明。
- protect 在共享项目 writer lock 内完成源复验、**实际新引用字节**配额终检和发布；父 supervisor lease 不允许同父进程的 protect 重入。runReferences 纳入统一容量统计/API/UI 与采集预检，CAS 仍只计一次。超限、容量未知、磁盘错误显式拒绝；幂等重试不新增字节。不是磁盘空间预分配；底层非合作写者不受其保护。
- 临时文件 wx/0600、文件 fsync、hardlink 禁止覆盖，正常异常只清理自己的临时文件。进程在发布后崩溃可留下已发布引用、临时文件和旧锁：已发布引用可只读查询；inventory 见临时文件返回 busy，写入仍被旧锁拒绝。**本模块没有解决旧锁恢复或孤儿治理**，不凭 PID/时间猜测清理，也不承诺目录 fsync 或掉电持久性。
- 库存文件名正则作为冗余快速拒绝保留；记录校验仍独立要求文件名等于 replayRunId 的哈希名，不宣称单独正则有独立变异红灯。接口键集合回归限制为 get/protect/protectedObjects，不仅检查 release 名称。临时文件导致 inventory busy 是有意保守阻断，不会自行随时间恢复；源缺失/目录错误的两处兜底仍归一固定错误码，细分原因未交付。
- get/inventory 校验记录、源副本及闭包绑定，但不重读每个 blob；即使 blob 当前缺失，已发布引用仍保护其 hash。未知/损坏/链接/特殊条目、丢失源引用或枚举失败不跳过。静态类别目录和文件链接拒绝，祖先路径仍属同 OS 用户可信存储；不是 openat2 沙箱。
- 当前引用**无过期、完成或 release 删除入口**：任务失败/重启/结束都不会自动解除保护，这是有意过度保留而非完整运行生命周期。`protectedObjects` 恒带 `deletionAuthorized=false`，只读列表不授予 GC 删除权限；未来 GC 必须持同一写锁、合并封存/运行/仍保留检查点的闭包，并取得可信容器终止证据后才设计释放。自动 GC 仍关闭，AC6 尚未完成。

复跑：构建后 `node --test tests/runtime/badcase-run-references.test.js tests/runtime/badcase-usage.test.js`。合成 CAS/子进程覆盖源副本不变、同起点独立引用、重启/幂等、配额边界、缺/坏 blob、磁盘错误、跨进程争用及发布后进程退出；不启动真实 agent/模型或 Docker 回放。

## 4. 环境与 Docker 隔离契约

- EnvironmentTemplate 首版人工配置；首次成功重建后归档镜像并固定 **digest + 架构 + 运行时版本**。缺镜像/依赖 → preflight 显式阻断，禁止静默回退浮动 tag 或宿主执行。
- **整个被测 pi 子进程**（含 read/edit/write 内置文件工具与 bash）在容器内执行；只包装 bash 不满足契约。worktree 以每次运行独立副本/卷挂载，不以可写方式挂真实目标仓库。
- CAFF server 与调度留在容器外；容器内仅回调**独立评测服务**（独立数据库、会话、凭据、端口、日志）。禁止：生产 DB/凭据、Docker socket、privileged、回连生产 CAFF。
- 网络默认拒绝，按需放行受控模型出口与评测回调；限制 CPU/内存/运行时间；终止走容器 kill 兜底，资源超限可靠终止并安全清理。
- 第一次真实 agent 重跑即在容器内；宿主机只允许"采集 → 临时目录恢复 → 清单校验"静态测试。

### 4.1 断网 Docker 执行底座（内部实验入口，非 pi 回放 launcher）

`docker-sandbox.ts` 的 `prepareOfflineTask/runOfflineDockerTask` 只接收可信调用方已准备好的合成文件包、`.cjs` 入口与人工指定的镜像身份。没有 HTTP、agent 工具、生产采集或模型入口，**pi SDK、session、评测回调、预算门控和评分仍未接入**；§4.2 另提供已封存文件与保护引用的固定恢复探针。不允许用该入口自行加载真实 badcase 或绕过授权；当前用途仅断网隔离验证。`completed` 仅表示离线程序退出 0，不产生 runnable/reproduced/evaluable，strictEvalEligible 恒 false。

- 调度器当前只支持 Linux 主机（可由操作者显式在 WSL Linux 内启动）；Windows/macOS 默认入口失败关闭，不自动换 shell、WSL 或宿主执行任务。宿主仅运行受信调度器和静态输入校验，被测文件程序及其 shell 子进程均在 Docker 内。Docker 使用 PATH 中的受信 CLI、固定 `default` context，仅接受本地 Unix socket；CLI 本身可访问宿主 Docker socket，但 socket **不进入被测容器**。CLI、daemon、本地镜像及同 OS 用户配置属于 TCB，不宣称抵御恶意 Docker daemon/镜像。单进程最多两个在途任务，直到清理完成/明确失败才释放名额。
- 模板必须同时指定本地 image ID、repository digest、Linux 架构及准确 Node/Python 版本；预检要求本地 inspect 一致，实际 create 使用 image ID 和 `--pull never`。拒绝浮动 tag、缺镜像、架构/digest 不符、镜像声明 VOLUME/ONBUILD/活动 HEALTHCHECK。容器内在写任务文件及启动程序前校验 Node 与 `/usr/bin/python3 --version`，不符退出 78。RepoDigests 是本地 daemon 的声明，不是独立供应链来源证明；该底座**不导出/恢复镜像，未校验 pi/项目依赖安装**（独立镜像导出见 §4.10），不能算 AC4 完成。
- 输入只接受精确字段集合、规范相对 ASCII 路径、普通文件、规范 base64 和逐文件 SHA-256；拒绝重复、父子文件冲突、绝对/越界/链接字段、秘密哨兵。至多4096文件、16MiB原始内容、32MiB传输JSON；不是任意规模历史检查点恢复器，亦未保留文件 mode。payload 经 stdin 传入，不经命令行/宿主临时目录/tar。恢复到本次全新 `/work` tmpfs，先全部写入再启动入口；不同运行拥有独立容器和副本。归一化 inputHash 包含镜像、文件包和入口，不含随机容器标识或超时；比较完整实验条件仍需未来对照 manifest，不能只凭此 hash 认定 AC7；该 hash 不含调度器构建产物，不能证明调度器字节一致（例如嵌入 bootstrap 的 checkout 行尾差异）。
- 固定 `--network none`、只读根、uid/gid 65534、cap-drop ALL、no-new-privileges、512MiB内存且禁额外swap、1CPU、64pids、private IPC，无端口发布/宿主挂载/设备/额外能力/宿主PID。仅 `/work` 64MiB 与 `/tmp` 16MiB tmpfs 可写；后者 noexec。固定入口 `/usr/bin/env -i` 清空镜像继承环境，再以最小 PATH/HOME/TMPDIR 启动 Node；不传宿主 CAFF/PI/provider/Node钩子或凭据。镜像本体必须为人工审核的无秘密环境；env清空不替代镜像审核。启动前及完成后复核 inspect 中镜像、入口、命令和隔离字段，错配阻断。
- 运行超时由调用方显式给出，1–300000ms；stdout/stderr合计至多1MiB，超限/超时终止 attach CLI，然后强制删除本次容器以终止整个容器进程树。Docker控制操作的默认15秒是 kill 触发点，不是返回时间上界：仅杀直接 CLI 子进程，等待 close 才结算；若 CLI 后代持有输出管道，返回可能继续等待。总墙钟还包含预检/清理，不等于任务超时。日志驱动 none，输出仅在调用方内存返回，不自动持久保存；输出是不可信任务文本，后续展示/归档仍须审计，不能作为完整模型轨迹证据。内存/进程限制为容器级约束，不声称每种资源超限均有专用可识别原因码。
- 用随机 name+owner label 标识本次容器。create结果不确定时按本次 name 查询，核验label后仅按完整ID删除；不删除外来容器、不全局prune。rm后用精确name查询确认不存在，失败抛 `offline_cleanup_failed` 并提供本次标识和固定原始码，不伪造cleaned=true。此保证依赖存活调度器；父进程崩溃、daemon中断后的孤儿恢复未交付。失败不会解除既有保护引用；当前入口也不创建保护引用。

回归：`node --test tests/runtime/badcase-docker-sandbox.test.js` 为注入CLI的确定性故障测试，不当作Docker证据。真实验证：构建后在Linux运行 `node scripts/badcase-capture/verify-offline-docker.cjs --image-id <sha256:...> --repository-digest <repo@sha256:...> --architecture amd64 --node-version <vX.Y.Z> --python-version "Python X.Y.Z"`；镜像必须已由人工准备，本脚本不pull/build。验证相同输入两份独立恢复、容器内Node文件/shell读写、只读根/链接越界写拒绝、网络/宿主环境隔离、超时/超输出/内存压力、版本不符/缺镜像阻断及本次容器清理。不是pi工具测试、真实turn/模型或Docker回放验收；Linux SQLite门槛不变。

### 4.2 已封存文件 → 保护引用 → Docker 恢复探针（内部、非 agent 回放）

`retained-restore.ts` 的 `prepareRetainedRestoreProbe/runRetainedRestoreProbe` 仅供可信离线工具/文件 worker；没有 HTTP/agent 入口。请求只含 captureRoot、冻结八键关联、flagId、replayRunId、镜像与超时，不允许自定义程序/entrypoint/环境/挂载。当前真实验证仅使用合成封存包，不授权自动读取真实项目或调用模型。

- 共享 writer lock 内先验证最终 case 与原 retention，再把普通文件 CAS 字节脱离到内存。缺 case/retention 不补建、不读 live checkpoint，不重新采集目标或打开 session 路径。路径使用既有 ASCII 子集，拒绝越界、父子文件冲突、秘密哨兵、symlink、secretExcluded、uncaptured 非空、size/hash 不符、非法/重复或与现有树冲突的 deletions；不做部分恢复后报成功。最多4094个现场文件（另占两个固定探针文件）、4096个删除项；整体仍受 §4.1 的16MiB/32MiB限制。目录替换、单 blob 读取内存边界沿用受信存储底座，不构成恶意同 OS 用户沙箱，不能在 HTTP 主线程调用。
- 完整包校验通过后，**在任何 Docker 调用之前** protect 已有 retention 闭包（不仅文件，还包括已有 prompt/session/harness/skill blob）。缺/坏非文件 blob 也拒绝；配额、锁争用、引用冲突不启动容器。随后释放同步写锁，使用已脱离字节启动 Docker，保护引用持续存在。失败或成功都不 unpin，自动 GC 仍关闭。重试同 runId 可再次创建独立探针容器，但不新增引用；换 runId 重试会累积永久保护引用，当前没有自动释放或 GC。引用不是执行账本或 exactly-once 启动凭证。同锁内 checkpointChecksum 的二次比较是冗余纵深防御，不宣称存在合作写者可插入的换源窗口。
- 容器内固定 `restore-probe.cjs` 只对 `snapshot/` 做实际目录枚举、逐文件 size/hash 与删除缺席校验，然后改写本次副本用于隔离验证；不执行捕获的源代码、package hooks、prompt 或 session。固定程序与计划位于 snapshot 外，不把宿主绝对路径/原完整清单/输入正文发入容器。空树亦可验证。探针程序规范化自身行尾；不能由此推断整个调度器构建可复现。
- `snapshotHash` 覆盖排序后的文件路径/大小/hash 与删除清单；`inputHash` 另覆盖固定程序、计划及镜像。保护记录绑定原 checkpoint checksum，二者含义不同。恢复到全新目录而非已有 checkout；不从 Git HEAD 复活缺席文件。当前仅内容恢复，mode/时间戳不保留，fileModePreserved=false；文件→目录转换等与 deletions 冲突的清单明确不支持，不猜测适配。
- `filesVerified` 只有容器 completed、cleaned、inputHash 一致且 stdout 为精确固定回执、stderr 为空才为 true；异常回执拒绝，失败/终止为 false。回执不是对恶意镜像的远程证明，CLI/daemon/人工审核镜像仍属 TCB。fresh/resume 原模式仅作来源披露，`replayInputComplete/runnable/reproduced/evaluable/strictEvalEligible` 恒 false；resume 缺 session 的文件探针可成功，但**没有启动任何 session，更不代表降级 fresh 或完整回放**。原 case 状态不改写，探针输出暂不持久化，不构成逐次评分报告。返回的 execution.stdout/stderr 仍是不可信文本，调用方不得直接持久化或向用户回显，须先经过独立的输出审计/投影。畸形 replayInput/deliveryMode 由 retention.get 的 schema 校验以固定 retention_record_invalid 拒绝，不依赖后续属性读取的 TypeError。

回归：`node --test tests/runtime/badcase-retained-restore.test.js tests/runtime/badcase-docker-sandbox.test.js tests/runtime/badcase-docker-command.test.js`。CLI 套件仅 Linux 运行 PATH shim，覆盖真实 spawn/env/stdin/超时触发/合计输出上限，不把它当 Docker 证据；非 Linux 真实入口拒绝另有回归。真实 Docker：用 §4.1 相同镜像参数运行 `node scripts/badcase-capture/verify-retained-restore.cjs ...`，临时合成 case/retention、删除 live 清单、两份独立恢复及改写、CAS 不变、损坏阻断、清理与持久保护引用；脚本仅删除自己创建的合成临时存储。不是采集器真实 turn、pi/session、模型或 AC 完成证据。

### 4.3 封存回放输入的只读预检（不是启动许可）

`replay-input-preflight.ts` 的 `inspectRetainedReplayInputs` 只接受 captureRoot、冻结八键关联、flagId，供可信离线/worker 使用；无 HTTP、SDK、Docker 或模型入口。读取已有 case→retention，不读 live checkpoint、不按宿主 session/skill 路径补材料，不创建锁、保护引用或写入记录。返回仅摘要/hash/计数/固定状态，不返回 prompt、session、skill 正文、路径或原始校验错误。检查针对本次内存中读到的副本；不是跨对象原子读取或将来的执行授权。

- 不信任历史 complete=true：必须无缺口/秘密排除/未验证维度，图片计数明确为0；旧记录缺计数或必要维度字段失败关闭。复核整个已保留 CAS 闭包的 hash、秘密哨兵，合计上限16MiB；存储读取仍沿用同OS用户TCB、同步整blob读取，字节上限是读后逻辑限制而非RSS硬边界。
- prompt hash 必须存在且匹配 normalizedPromptHash；harness JSON 的 piVersion 钉至既有0.85.1、deliveryMode/agentPromptVersion 与运行声明一致，必填类型正确。provider/model/promptVersion 非空；声明 skill 集合与归档集合严格对账、重复/多余/缺失均拒绝，逐份验证UTF-8与hash。不把配置声明、包版本字符串或完整材料当作已安装SDK/项目依赖证明。
- resume 必须有原session字节，重新运行既有 session-validator，结构损坏/未知依赖拒绝；fresh 携带 session 同样拒绝，不更换模式。此预检尚未实现历史路径到容器路径的映射，故不给 session 校验器授权根：即使历史read/write/edit落在原授权根内，也保守报告 replay_session_dependencies_unverified。纯消息历史可通过；bash、扩展状态、图像等未验证维度不能因历史complete声明而放行。不修改原session、不开SDK、不迁移格式、不借宿主OS推断路径兼容性。
- 受控替换清单只接受既有允许变量的name/count，允许采集器分开记录prompt/session后按name合计；与两份归档字节中的保留占位符逐项对账，未知名称/额外原值字段/计数不一致拒绝。不签发凭据、不替换值。碰巧存在的同名占位符使计数不一致时也保守拒绝，不能猜测其来源。
- `inputMaterialsVerified=true` 只表示此静态输入子集校验通过；`launchAuthorized/runnable/reproduced/evaluable/strictEvalEligible` 全false，既有case状态不变。返回 checkpointChecksum、prompt/session/config及配置清单hash供后续对照，**摘要不构成可复用启动令牌**。未来launcher仍必须在共享锁内重新读验完整包并protect，应用审核过的路径/变量映射，在固定镜像内验证真实安装依赖后才允许启动；不能拿本次结果跳过这些步骤。文件恢复仍由§4.2独立验证；文件mode/环境/轨迹/附件及严格一致性没有因此补齐。

回归：构建后 `node --test tests/runtime/badcase-replay-input-preflight.test.js`，使用临时合成CAS，覆盖fresh/resume、删除live后仍可查、无写入、缺/坏blob、模式不降级、历史complete伪声明、版本/配置/skill/替换清单/UTF-8/秘密/大小负例。没有真实pi启动、Docker或模型证据，AC仍不能据此完成。

### 4.4 固定 SDK 的容器内初始化实验（合成输入，尚非封存 launcher）

`verify-pi-initialization.cjs` 是操作者显式执行的 Linux 验证脚本，不接 HTTP/agent 工具或真实 case。它补充 §4.1 的纯 Node 探针：**整个真实 pi 0.85.1 SDK 在 Docker 内加载**，分别初始化 fresh 与恢复一个固定的纯消息 resume 夹具，直接执行真实 SDK read/write/edit/bash 工具；不调用 `session.prompt`、不发送模型请求、不构成真实 agent turn。宿主只读取静态 npm 发布文件和生成合成包，不 import/执行 SDK。

- 依赖不是从被捕获项目解析：`pi-probe-materials.cjs` 只从本 Room 已安装、同 OS 用户可信的 npm 发布目录复制明确清单（SDK 的 dist/bundle 与 theme、chord 的 dist/context、typebox/build 及包元数据）。拒绝链接/非普通文件、缺文件、版本不符、超过4096文件/16MiB；不用 npm install/build、网络下载、全量 node_modules、宿主认证/会话或未授权私有目录。目录祖先与安装包本身仍属 TCB，版本字符串和 hash 不证明独立供应链来源。pi-ai 实现包含在 SDK 发布 bundle 内，另记录同版本包元数据；不宣称已经独立验证其所有 provider/原生模块/图像功能或项目依赖。这里是受信运行时工件验证，**不改变采集秘密扫描，也不开放“把捕获内容当依赖绕过扫描”的入口**。
- 宿主生成逐文件 size/hash、runtimeHash 与完整 inputHash。只把本次自建的普通文件暂存目录经 tar/stdin 传入全新 tmpfs，不接受外部 tar；容器内先逐文件验清单、核验 Node/Python/架构，再 import SDK。tar 在哈希校验之前解包，因此此传输仅适用于受信自产包，绝不能复用为不可信 case 解包接口。当前运行时文件约9.60MB，每次注入；未归档依赖包或镜像，不是已交付 EnvironmentTemplate 的镜像安装/离线重建保证。
- 固定本地 image ID+RepoDigest+架构，不 pull/build/浮动 tag。容器隔离沿用断网、只读根、uid65534、cap-drop ALL、no-new-privileges、512MiB含swap上限/1CPU/64pids/private IPC、无挂载/端口/设备、清空环境；镜像要求无 VOLUME/ONBUILD/活动 HEALTHCHECK，前后 inspect 复核隔离。唯一名字+owner label 核验后删除本次容器并检查精确名字无残留；异常不伪报清理成功。CLI 控制超时仍是 kill 触发点而非返回上界；进程内 `timeout -k 2 25` 与外部30s attach截止共同限制本次实验。调度器死亡/daemon故障的恢复仍未交付。
- resourceLoader 显式空扩展/skill/AGENTS/模板，settings 在内存，凭据路径只在容器 `/work/agent`；仓库内设置发现陷阱，初始化不得读取它。禁止模型网络刷新；network none 是实际网络边界，fetch/streamSimple 拒绝计数只作额外观测。固定模型目录条目只用于初始化，非模型付费授权。四个工具由测试程序直接调用，不冒充 LLM 自主工具执行。
- resume 输入必须事先存在且与固定合成夹具逐字节一致，之后才调用 `SessionManager.open`；该 SDK API 对缺失文件可能自动创建 session，故不得裸调用它当作“resume成功”。保留原 session id/消息，显式 cwdOverride 到 `/work/snapshot`；对纯消息夹具验证源字节未变。这**不是**通用历史工具路径映射，也没有把真实缺失 session 改成 fresh。fresh 两个容器的 inputHash 一致，三个正例 runtimeHash 一致，容器相互独立。
- 真实验证包含 fresh 两副本、resume，以及缺 SDK 入口、SDK/pi-ai 元数据错版、缺 session/损坏 session 五个负例；负例都必须失败且清理。回执只接受精确结构与固定字段，输出不保存原始任务文本。runnable/reproduced/evaluable/strictEvalEligible 全false，原 case/retention/runReference 完全不访问。**锁内重读校验/protect→真实输入启动尚未接通**，不能把本实验或 §4.3 摘要用作真实用例启动许可。上轮 skill/替换名/serverVersion/摘要四类覆盖已补，但预检语义未改变。

四类守卫的实际断言共用纯模块 `pi-probe-guards.cjs`：逐文件 size/hash、发现陷阱、model/network 零计数和清理 owner/完整 ID；模块随受信探针代码一起打包。它与入口脚本均是受信代码，在清单自校验前加载，不是对不可信代码的认证边界。`badcase-pi-probe-guards.test.js` 自动运行独立负例；文件 hash 接线另用 VM+文件系统桩验证在环境读取/SDK import 前阻断，清理接线用 Docker/tar 桩验证 foreign owner 时零 rm。纯断言测试不执行 SDK；计数/陷阱负例不代表真实 SDK 已触发这些异常，完整容器故障注入仍待补齐。

静态回归：`node --test tests/runtime/badcase-pi-probe-guards.test.js tests/runtime/badcase-pi-initialize-probe.test.js tests/runtime/badcase-replay-input-preflight.test.js`；普通回归不自动运行 Docker/SDK。真实复跑：在 Linux 本 Room 根、构建后运行 `node scripts/badcase-capture/verify-pi-initialization.cjs --image-id <sha256:...> --repository-digest <repo@sha256:...> --architecture amd64 --node-version <vX.Y.Z> --python-version "Python X.Y.Z"`。脚本只删除自己创建的临时目录/容器。不是 SQLite、完整 session/skill/工具桥、镜像归档、完整回放、预算/评分或任何 AC 完成证据。

### 4.5 封存初始化输入准备（已接数据恢复与受限 SDK 诊断）

`retained-initialization.ts` 的 `prepareRetainedInitializationCapsule` 仅供可信同步文件 worker/离线调用，不接 HTTP/agent 工具。接受 captureRoot、冻结关联、flagId、replayRunId；不接受既有预检摘要、宿主 session 路径或启动资格。整个读取、复验、序列化与 protect 在同一个项目 writer lock 内完成；使用已有 case/retention，缺源不从 live checkpoint 补建。重复调用重新校验材料，同 run 不重复保护；不自动释放引用，换 runId 仍会累积。

- 锁内重新执行 §4.3 预检，复验全部 CAS 闭包；复制字节时再次检查 hash/秘密。文件路径、普通文件类型、size、父子冲突和删除冲突另行验证。所有输入通过才发布完整闭包保护引用，核对 checkpoint 摘要与 blob 集合；失败不取消既有保护。
- 返回单个 JSON **字符串** `capsule`，包含原 checkpoint 和按 hash 排序的全量 blob base64，以及独立 capsuleHash/capsuleBytes。它是脱离存储的内存数据，不是 tar、可执行程序、路径映射或可复用授权；不得原样日志记录、HTTP 回显或交给通用解包器。后续容器消费者必须重新验证结构、hash/大小/路径，在独立 tmpfs 恢复，不能将捕获文件混进可信 SDK 文件清单或执行为扩展。
- 编码后的 capsule 上限 **4MiB**（另有原始字节提前限制），最多8192 blobs（与消费者一致），现场最多4094文件/4096删除项。这是初始化实验的额外限制，为独立的可信运行时工件预留空间，不改变采集上限或承诺通用大项目支持；仍是同步整 blob 读取，不是 RSS 硬边界。运行时与 capsule 总包上限仍须由后续消费者验证。
- 此步骤保存所有回放输入，不丢弃 skill/桥接配置或受控替换，但**不实现这些配置的执行语义**。没有调用 SDK/Docker，没有应用或发送 prompt，没有把 invocation prompt 当作角色/system prompt。launchAuthorized/runnable/reproduced/evaluable/strictEvalEligible 全false；原 case 完整性不升级。
- 共享锁只协调守约写者；同 OS 用户存储 TCB、非原子原始采集、无掉电保证及旧锁保守阻断的限制不变。准备后的源变化不改变已返回字符串，下一次准备仍重新校验；保护引用不代表已启动或已结束的进程。

定向回归：构建后 `node --test tests/runtime/badcase-retained-initialization.test.js`。使用临时合成 CAS，覆盖 fresh/resume、移除 live、不补缺源、坏材料、父 lease 争用、每次读取/发布都持锁、预检之后字节变化、重试引用保留、文件/删除冲突及编码后大小限制。§4.6 已接容器数据恢复消费者，§4.7 另接受限 SDK 初始化诊断（非忠实回放）；§4.4 已有共享守卫的离线负例，但不替代其真实容器异常路径证据，不构成 SDK/模型验收。

### 4.6 受保护 capsule → 容器内材料恢复（内部探针，非 SDK 初始化）

`retained-input-probe.cjs` 将 §4.5 的准备结果送给 §4.1 底座，固定运行 `capsule-materialization` 消费者。仅可信离线实验脚本，无 HTTP/agent 入口，真实验证只使用合成封存材料；不会开启项目采集或运行模型。整个 capsule 是固定名 `capsule.json` 的数据，**不使用 tar，不把捕获路径或代码拼进可信程序清单**。可信程序仅来自本 Room build，构建目录及同 OS 用户为 TCB；容器内固定入口复核 Linux/uid65534/工作目录，再执行材料恢复。

- 在宿主准备链的同一 writer lock 内复读/校验并 protect，解锁后传输已脱离的字符串；完整闭包保护先于任何 Docker 调用，失败/成功不 unpin。消费者再次校验 capsule/checkpoint 摘要、schema、规范 base64、每 blob hash/秘密哨兵、闭包缺失/额外/重复、文件大小/路径/父子冲突与删除冲突。resume 缺 session 拒绝，fresh 不允许夹带 session；不改模式。所有结构和内容验证完成后才创建恢复目录。
- 消费者只认 schema1 和现有闭包字段，不是完整 replay-input 语义验证器。它拒绝已知 incomplete/uncaptured，但不替代 §4.3 预检、session-validator、授权或来源证明；调用方提供的 hash 不是签名。完整 replay 语义、skill/桥接配置/凭据替换、角色指令与工具设置仍需将来的 SDK launcher 明确实现或拒绝。
- 容器中仅创建全新的 `/work/restored`，已有目录/链接失败关闭，不覆盖或递归清理。`snapshot/` 保存文件副本，`materials/checkpoint.json` 保留完整清单，`materials/blobs/<hash>` 保留完整输入闭包，包括 invocation prompt、session、harness 和 skill；不把 invocation 当作角色/system prompt，不发现/加载 `.pi` 扩展、package hooks 或归档代码。文件内容有意在 snapshot 和材料 blob 间重复，不使用这些瞬时副本作为存储去重/容量成本证据。
- 限制：编码 capsule 4MiB、最多8192 blobs/4094现场文件/4096删除项/4096 skill快照，总外层包仍受 §4.1 限制；全部同步内存处理，不是 RSS 硬边界。落盘逐文件 wx/0600 并读回核验，文件 mode/时间戳不保留。I/O 失败可留下本次新目录的部分内容，但不返回成功；容器由原底座终止/清理，宿主静态测试只清理自己临时目录。目的地祖先在可信边界内，不宣称恶意并发路径替换防护。
- 回执 `materializedHash` 是排序后的预期恢复文件 path/size/hash 清单摘要，写后每文件读回相等才返回；不是原始采集一致性、远程证明或执行许可。wrapper 要求 completed/cleaned/inputHash 匹配、精确 stdout 回执和空 stderr，向调用方只返回固定投影，不返回原始 stdout/stderr。`piExecuted/fileModePreserved/runnable/reproduced/evaluable/strictEvalEligible` 全false，原 case 状态不升级；没有发送 prompt、SDK 初始化或评分。

回归：`node --test tests/runtime/badcase-capsule-materialization.test.js tests/runtime/badcase-retained-initialization.test.js`。真实 Docker：Linux 本 Room 根构建后运行 `node scripts/badcase-capture/verify-retained-inputs.cjs` 并带 §4.4 相同的五个镜像参数。fresh/resume 各两份独立容器、移除 live 后材料一致、CAS 不变、持久引用保留；另对仅内存合成传输注入错误 capsule hash/坏 blob/越界路径/缺 session，要求容器内拒绝并清理。仍无镜像归档、真实 turn、SQLite、浏览器、模型、预算、评分或任何 AC 完成证据。§4.4 的 SDK 缺文件 open 行为与 session 夹具单源化现由 §4.7 补充；四守卫真实异常注入仍待补，不能用本段数据消费者故障替代。

### 4.7 恢复材料 → 真实 SDK 初始化诊断（不是忠实回放）

`retained-sdk-diagnostic.cjs` 在 §4.5 锁内复验/protect 后，把 capsule 交给 `retained-sdk-container.cjs`；容器内重新执行 capsule 校验及更窄的语义白名单，再恢复文件、加载真实 pi 0.85.1 SDK。无 HTTP/agent 工具入口，验证脚本仅使用自建合成封存材料，不开启真实采集。该诊断验证恢复文件与 session 能进入 SDK，而**不宣称原始 harness/system prompt 已重建**：固定使用显式 diagnostic system prompt，invocation 只验证字节并保留，绝不发送或当作角色指令；`invocationSubmitted=false`，没有 baseline/candidate 替换或模型调用。

- 支持 fresh、resume 的线性 user 字符串消息和可选 `thinking_level_change=off`；严格字段集合、版本3、父链、UTF-8、末尾换行均复验。分支、压缩、assistant/tool/图像、模型切换、扩展私有状态、parentSession、未知字段/类型一律拒绝；不默默换 fresh。不通用映射历史路径，只对这个无历史工具调用的诊断子集使用容器 cwdOverride。
- 已声明的 skill、桥接、受控替换、未验证维度、图片或秘密排除必须为空/关闭；不支持的材料显式 `sdk_diagnostic_unsupported`。harness 配置五键精确匹配且 pi 版本/模式/promptVersion 对账；固定 resourceLoader 不发现项目扩展/AGENTS/settings。provider/model 使用归档声明在离线目录精确查找，缺模型拒绝，不替换成探针默认模型。模型鉴权/真实调用参数、角色指令分离、完整 harness 工具语义仍未验证，故不是 runnable 判定。
- 宿主只静态打包受信 npm/build 文件。沿 §4.4 的自产 tar/stdin 运输；捕获材料只在固定 `capsule.json` JSON 文件内，捕获路径从不成为 tar member、代码模块或可信依赖。先解包后校验仍仅适用于受信构造的普通文件包，不是通用不可信 tar 接口；JSON 由消费者全量验证后才恢复。临时 stage 不记入持久 CAS 容量，失败按自身临时目录清理。整个包仍限制4096外层文件/16MiB，capsule4MiB。
- 同 §4.4 的镜像身份预检、隔离参数、清空环境、初始化超时、owner清理及残留检查。新脚本按顺序执行；`runProbe` 是内部实验原语，不另提供生产并发调度/队列，不能误用 §4.1 的2并发承诺。SDK只在容器内 import；host 测试只做静态校验或注入 transport，不能替代真实 Docker 证据。
- 原 session blob 保持在恢复材料目录不变，另复制为 `/work/resume-input.jsonl` 工作会话。真实 SDK 0.85.1 在历史未含 thinking level 时，初始化会追加一条 `thinking_level_change=off`。诊断只允许该确切追加（原字节前缀不变、父ID正确、单条白名单字段），已有 off 时工作字节必须完全不变；报告区分 `archivedSessionBytesUnchanged` 与 `workingSessionAppendedThinkingOff`，不再错误承诺工作副本零变化。恢复的全部材料在初始化后再次逐字节复验，CAS 原件未交给 SDK。
- 单独对明确不存在的合成路径调用真实 `SessionManager.open`，确认它返回新生成ID和空 entries/context；此实验与恢复输入路径独立，**不作为缺失 resume 的 fallback**。结论仅为创建空会话对象，不承诺立即落盘。§4.4 原探针的 session 字节现在由 `syntheticSession()` 单点生成，容器读取已验 hash 的 expected-session 数据，不再维护第二份硬编码历史。
- 回执仅含模式/摘要/计数/固定状态，stdout 必须精确匹配、stderr 为空、退出0、无 transport failure、manifest/完整容器ID正确；`runProbe` 只有清理完成才返回，清理失败抛错。结果不携带原始输出或输入文本，固定 `sdkInitialized=true` 也仅指诊断初始化；`runnable/reproduced/evaluable/strictEvalEligible` 全false，原 case 不升级。`diagnosticReceipt()` 仅供宿主构造**预期**回执，不是执行证明。容器使用 `observedDiagnosticReceipt()`：从恢复的 session blob 与 SDK 工作副本分别读 Buffer，逐字节核对原件、校验工作副本 UTF-8 及允许的 off 追加；另读取缺文件 open 对象的 ID、entries、context messages，必须非空ID且两集合为空。这些观测产生 `archivedSessionBytesUnchanged`、`workingSessionAppendedThinkingOff`、`missingOpenCreatesEmptySession`，不再由 plan 代填。fresh 使用 null/false 表示不适用；观测缺失或矛盾即失败，原始观测不出容器。回执新增 `sessionObservationVersion=1`；旧归档 harness 的无版本回执在 transport 后被精确比对拒绝，不静默接受或迁移。该版本不是代码认证或远程证明；`appendedOff` 已由原件及副本前置校验决定，观测形式不构成额外独立保证。wrapper 采用 JSON 字符串精确比对，旧归档 harness 与新宿主的键序差异可能导致失败关闭的误拒，不做宽松迁移。其余固定状态仍依赖现有容器断言与隔离，daemon/build/归档harness/宿主调度器仍属TCB。成功/失败均不 unpin；不具备父崩溃恢复、自动释放/GC、镜像归档或评分。

回归：`node --test tests/runtime/badcase-retained-sdk-diagnostic.test.js tests/runtime/badcase-capsule-materialization.test.js tests/runtime/badcase-retained-initialization.test.js`。消费者补独立非法模式（无session）、secretExcluded、4094/4095文件、normalizedPromptHash不符负例；protect回执/再次hash、wx/写后读回是纵深防御，不宣称恶意同权限并发安全。真实 Docker：Linux 本 Room 根构建后 `node scripts/badcase-capture/verify-retained-sdk.cjs` 加 §4.4 五个镜像参数，fresh/resume各两副本，另错误capsule hash、缺session、桥接开启、目录缺模型、SDK版本不符五个容器负例，以及初始化后归档观测字节损坏、工作副本缺off追加、缺文件实验非空entries/非空context/空ID五个观测负例；引用保留、源CAS不变、14容器清理。观测故障只在验证脚本的受信 staged probe 中注入并重算manifest，不是生产注入接口，不是SDK自身自然故障或篡改CAS实验。离线另覆盖未知entry、harness模式不符、session无末尾换行；8192接受/8193拒绝使用满足文件/skill数量和4MiB上限的精确blob闭包，避免其他守卫遮蔽。仍无真实用户turn/付费模型、SQLite/浏览器、完整轨迹、镜像归档、预算/评分或任何AC完成证据。

### 4.8 可信运行依赖的独立字节归档（不含镜像与 harness）

`runtime-archive.cjs` 仅供可信离线调用，无 HTTP/agent 管理入口。`archiveRuntime(repoRoot, absoluteNewDirectory)` 静态读取 §4.4 同一发布白名单，**仅保存 runtime/**，不保存 probe、session、case、认证配置或整个 node_modules。不 import SDK、不执行安装脚本、不联网。创建前验证四个包名/版本、必要入口和目录子集；创建全新目录后以 wx/0600 写入固定 `runtime.json`，fsync 文件并读回验证，成功才返回引用。失败保留部分目录、不覆盖/删除/自动重试；文件 fsync 不等于目录持久化或掉电保证。

- 归档是有版本的 JSON 数据，逐文件含路径、大小、SHA-256、规范 base64；最多4096文件、解码内容16MiB、编码文件24MiB。固定引用五键：directory、archiveHash、archiveBytes、runtimeHash、runtimeBytes；调用方须在归档之外钉住引用。读取先检查引用形状与大小，再拒绝根目录/文件链接和非普通文件，以 fd 限量读至期望大小+1；外层 hash 校验后复验结构、路径白名单/冲突/重复、大小/base64/hash、必要包版本及汇总。不会解包外部 tar，也不在宿主执行归档代码。这个上限不是 RSS 限制。
- 归档/引用/安装包及祖先路径仍是同 OS 用户 TCB。hash 是完整性而非来源认证；攻击者同时替换受信引用和包不是本模块声称防御的场景。它不是接收捕获代码绕过秘密扫描的接口，不替代完整 SDK/provider/项目依赖验证。
- `stageDiagnostic` 第4参数现为显式来源对象 `{runtimeArchive?, harnessArchive?}`，与 `runRetainedSdkDiagnostic` 的同名 options 属性一致（不再接受旧的第4位裸引用）；显式自有属性 `runtimeArchive` 选择归档路径，**属性值为 null/undefined/坏引用也直接拒绝，不回退安装源**。完全省略选项仍保留 §4.7 原来的 installed-distribution 实验；该旧实验不可被报告为归档回放。归档选择在输入保护之后、容器 transport 之前，失败仍保留保护引用。新的阶段只替换依赖字节来源，不改变 SDK 配置、session 语义或运行资格。
- 本段**没有归档镜像、harness/build/探针、项目依赖或版本化 EnvironmentTemplate**，容器内五文件 harness 的另行归档见 §4.9，仍非完整环境恢复。不选择 harness 归档时，诊断仍依赖当前受信 build/探针和人工已安装的固定镜像；不会 pull、load 或宿主 fallback。无生命周期/配额/API/UI/跨进程发布锁/GC，归档成本不计入项目 capture usage；调用方明确管理离线存放位置，原始工件不得提交 Git。§4.7 已将三个session相关字段改为观测派生并补负例；本段归档验证不能替代该回执接线或其他SDK副作用守卫的真实故障证据。

回归：`node --test tests/runtime/badcase-runtime-archive.test.js`。真实验证：Linux 本 Room 根构建后运行 `node scripts/badcase-capture/verify-runtime-archive.cjs` 加 §4.4 五个镜像参数；先临时归档真实白名单依赖，再用 fs shim 拒绝宿主 node_modules 的 readFile/lstat/readdir（不删除共享安装），fresh/resume 各两容器使用归档，比较摘要、归档未改、零模型调用、保护引用和清理；坏引用在 transport 前拒绝。安装源真实删除仅在合成单测中验证；真实实验为 shim，不是卸载系统环境。报告区分编码归档字节、runtime 内容字节和归档耗时；实验只清理自身临时存储，结束不保留工件。仍不构成镜像归档、忠实回放或任何 AC 完成证据。

### 4.9 容器内五文件 harness 归档（不含宿主调度器与镜像）

`harness-archive.cjs` 是可信离线工件 API，不接 HTTP/agent 工具、捕获内容或任意可执行归档上传。`archiveHarness(repoRoot, absoluteNewDirectory)` 只读取固定五文件：guard、容器入口（归档名 `probe.cjs`）、编译后的 `retained-sdk-diagnostic.js`、`capsule-materialization.js`、`secrets.js`。它们是受信程序，不是 badcase 输入；模块不在宿主执行这些归档字节。祖先、build、引用及同 OS 用户仍属 TCB，hash 不是来源认证，也不证明这些文件来自同一次构建或某个 Git SHA。

- 固定 `harness.json` 使用 schema1、固定 kind、精确五文件清单、逐文件 size/hash/规范 base64；总内容最多1MiB、编码归档最多2MiB，外部五键引用为 directory/archiveHash/archiveBytes/harnessHash/harnessBytes。先校验引用大小再访问文件系统；源文件及归档均拒绝静态链接/非普通文件，使用 fd 有界读取并核对对象及大小，读取多一字节检测增长。不保证同权限并发路径安全、原子源码快照或 RSS 硬限。
- 验证全部源与编码数据后才独占创建新目录，以 wx/0600 写入、文件 fsync、读回完整校验后返回引用；失败保留部分工件、不覆盖/自动删除。wx 在独占 mkdir 之外为纵深防御，lstat 的显式链接判断在类型检查之外亦为纵深防御；无目录 fsync/掉电恢复保证。
- `stageDiagnostic(..., {runtimeArchive, harnessArchive})` 明确选择两个独立来源；自有属性即使值为 null/undefined 也失败关闭，不回退当前源文件。来源对象未知键拒绝，旧裸 runtime 引用形状拒绝；完全省略某个属性仍是该部分的当前源码/安装实验，不能报告为双归档重跑。`prepareRuntimeFiles` 只读取 runtime，不再为了获取依赖顺带读取当前探针。输入仍先 protect，归档故障在 transport 前拒绝且不取消引用。
- `runtimeHash` **只覆盖 runtime/**；`harnessHash` 仅覆盖上述五文件的 path/size/hash 清单，完整 `inputHash` 覆盖本次 runtime+harness+capsule/expected/environment 数据。三个 hash 都不是远程证明或宿主调度器身份。容器先加载受信 guard 后验证输入；归档引用必须由可信调用方另行钉住，不能用捕获代码伪装 harness 绕过边界。
- 此处只归档**容器内 harness**，宿主 wrapper/规划器/transport/fixture、镜像、项目依赖与 EnvironmentTemplate 未归档，仍使用当前受信宿主调度器和已安装固定镜像。不接归档生命周期/配额/GC/UI/API；capture usage 不含这些离线工件。§4.7 三个session相关字段的观测化及四类语义负例已补，旧harness回执需遵守该节的版本拒绝规则；不改变初始化诊断语义、不授予任何运行资格。

回归：`node --test tests/runtime/badcase-harness-archive.test.js tests/runtime/badcase-runtime-archive.test.js`。真实实验：Linux 本 Room 根构建后，`node scripts/badcase-capture/verify-harness-archive.cjs` 加 §4.4 五个镜像参数。先临时归档 runtime 与五文件 harness，再以 fs shim 禁止当前安装源及五文件源的 readFile/lstat/readdir/open（不删除共享文件，不禁止此前已加载的宿主模块），fresh/resume 各两容器使用双归档，比较输入摘要、零模型调用、保护引用和清理；坏引用零 transport。合成测试才真实删除临时源。报告分别记录内容/归档字节与归档、读取校验耗时，单次缓存/挂载条件影响测量，非真实 turn 成本。实验结束只删除自身临时工件，不声称长期保存了环境；镜像不 pull/load/归档。普通回归不运行 Docker，全部 AC 仍须独立验收。

### 4.10 固定镜像的独立导出与完整性校验（不含导入/恢复启动）

`image-archive.cjs` 仅供可信离线调用，无 HTTP/agent 工具入口，不接受捕获代码或任意 tar 上传。`archiveImage(image, absoluteNewDirectory)` 对固定模板进行语法校验，要求 Linux、本地 default context 的 Unix socket，导出前后分别 inspect 同一 image ID/RepoDigest/架构/Linux，并拒绝 VOLUME/ONBUILD/活动 HEALTHCHECK。只执行 `docker --context default image save <imageId>`；无 pull/load/tag/remove/build，不修改共享镜像或启动被测容器。Node/Python 版本在本段仅为人工声明，**没有在导出过程执行版本检查**；原初始化诊断的容器版本检查仍不可省略。

- 使用独占新目录、固定 `image.tar`/`metadata.json`、wx/0600；save stdout 流式写入，归档最多4GiB，stderr只计数不保存/回显，超过64KiB拒绝。固定120s触发杀CLI，等待close后才关闭fd和释放进程内单并发名额；不是返回时间硬上界，也不证明 daemon 已停止内部只读导出。写入支持短写；非零退出、空流、超限、I/O/控制失败不返回引用。只导出指定完整image ID，不使用tag。注入runDocker/save/spawn与较小限额仅用于可信内部故障测试，非生产配置面。
- 保存后有界分块读取计算整包hash，fsync镜像文件，写入元数据并fsync；最终读回两文件校验成功才返回外部五键引用 directory/archiveHash/archiveBytes/metadataHash/metadataBytes。失败保留部分工件；无自动覆盖/删除/重试、目录fsync、掉电恢复、生命周期配额或GC。4GiB是单工件限额，不是磁盘预留或全局配额；这些离线字节不计入capture usage。
- `verifyImageArchive` 是只读、无Docker调用的**不透明字节完整性**检查：先验证外部引用形状/上界，再拒绝目录/文件静态链接与非普通文件，fd对象/大小核对、1MiB块hash及增长/截断检测；元数据最多64KiB，严格schema/kind/模板字段和与外部引用的hash/size对应。它不解析tar、不验证每层或导入可用性、不证明归档内config与声明image ID一致。外部引用、daemon、来源镜像、路径祖先与同OS用户仍是TCB；不抵御同时改写引用和字节，不承诺原子或恶意并发安全，不自动扫描整幅人工可信基础镜像的秘密。
- 返回 `runtimeVersionsVerified/restored/runnable=false`，不授予任何用例资格。元数据的 RepoDigest 是**导出时daemon观察**，不是registry签名、供应链证明，也不是导入后仍存在的保证。缺本地镜像或digest依然拒绝；原有 default-daemon 启动预检不修改。隔离 daemon 恢复诊断见 §4.11；项目依赖和宿主调度器归档、长期环境引用仍未实现，不能以导出成功代替AC4。两次 Docker save 字节不保证一致，外部引用只钉住本次导出；已观察到相同大小而摘要不同，原因未定位。

回归：`node --test tests/runtime/badcase-image-archive.test.js`，合成opaque字节、注入控制及真实Node CLI替身，不运行Docker。真实验证：Linux本Room根构建后，`node scripts/badcase-capture/verify-image-archive.cjs` 加 §4.4 五个镜像参数；真实save、流式读回、坏引用/翻转字节拒绝，Python只读自有可信tar头及至多1MiB config/manifest（最多16384成员、无提取），另核验config hash等于image ID、架构/OS及layer成员存在。此探针不属于通用验证器，也不验证layer内容或实际load。报告区分save+复验耗时和单次读取耗时；结束删除自身临时工件，不声称长期留存。导出manifest是否含RepoDigest单独报告，不将其缺失推断为已验证导入结果。本段无SDK/模型/容器/SQLite/UI/真实turn证据。

### 4.11 归档恢复到专用 daemon 后的 SDK 初始化闭环

用户 2026-10-15 裁决优先 MVP：归档导入后 RepoDigest 缺失不再阻断该恢复路径；不改变原有本地镜像模式的强校验，不伪造字段。`image-recovery.cjs` 的可信离线接口接受既有导出引用，导入前/后复验字节摘要；显式记录 `declaredRepositoryDigest` 与 `observedRepositoryDigests`。恢复的 image ID（config 内容摘要，包含层的未压缩摘要）、架构、OS、安全配置仍须匹配。该绑定不是 registry 来源认证；外部引用、本地 daemon、同 OS 用户与目录祖先仍属 TCB，不能接任意 tar 上传。

- 仅专用 `/var/tmp/caff-image-recovery-*/docker.sock`，独立 data-root、vfs；校验 daemon ID 与共享 daemon 不同、开始时无镜像/容器。加载及整个 probe 创建/执行/inspect/清理均经显式 Unix socket，绝不回退 default daemon。恢复 transport 每次执行前后复验 daemon 和 image 身份；在 probe 创建容器后、start 前，另经恢复器持有的目标 transport inspect 该完整容器 ID、image ID、owner label 及未运行状态，结束核对回执 ID。没有观察或 ID 不符即拒绝，不以运行前后容器数相同代替存在性证据；观察失败仍由 probe 清理本次容器。此交叉核验针对受信代码误路由，非远程认证或抵御同权限恶意 probe。路径命名不等于隔离认证；生命周期管理器还必须核对命名空间和 PID。
- `verify-image-recovery.py` 须人工授权 Linux root 环境；不自动提权或安装组件。随机0700目录、独立配置/socket/data-root/exec-root/pid/log，在 private mount/network namespace 启动 dockerd，关闭 bridge/firewall/forwarding。被测容器不 privileged、无 Docker socket，仍沿 §4.4 隔离检查；调度器宿主运行，SDK与工具只在容器执行。
- `verify-image-recovery.cjs` 真实 export→load→归档 runtime/harness→封存合成输入→fresh/resume各两副本 SDK 初始化。容器内实际核验 Node/Python 版本，未发送 invocation、零模型调用，仍非忠实回放/评分。归档身份对象的 `runtimeVersionsVerified:false` 仅表示 load 本身未执行版本检查；总报告另记容器版本验证结果。实验额外比较源与恢复的 Config/RootFS，及共享镜像与 daemon ID 前后未变。
- 实验拒绝损坏归档（零 Docker 调用）、缺失/损坏 runtime；单测覆盖共享/非空/错根 daemon、load失败、错误镜像/架构/安全配置、执行前身份变化。默认模式仍拒绝缺 RepoDigest。无 HTTP/生产调度接线；runtime/harness来自本次归档，宿主调度器和项目依赖未归档。
- 最后终止自己启动的 daemon 进程组，核对本次进程/宿主挂载无残留后才删除自身目录。异常清理失败保留现场，不自动处理其他 daemon；父进程被强杀/宿主重启后的恢复未实现。120s load、30s attach 等截止仅触发 CLI 终止，不保证 daemon 工作即时终止；最终靠专用 daemon 生命周期收口。镜像、runtime/harness实验归档非长期留存，未接配额/GC/持久环境引用；全部 AC 仍 pending。

复跑：先在本 Room 构建；Linux 已授权 root 下执行 `python3 scripts/badcase-capture/verify-image-recovery.py`，加 §4.4 五个镜像参数。需要已安装 dockerd/unshare/docker/Node/Python，无下载。定向自动回归：`node --test tests/runtime/badcase-image-recovery.test.js tests/runtime/badcase-docker-command.test.js`。

§4.7 同步补充非法UTF-8位于合法off追加JSON字符串内的负例：文本解码后语义仍合法，只有字节往返校验拒绝，避免尾部非法字节被JSON结构守卫遮蔽。它是既有守卫的覆盖，不是父实现缺陷修复。

## 5. 对照评测公平性契约

- baseline 与 candidate 从**同一 Checkpoint** 各自独立恢复起点；只有声明的 prompt 变量（首版：单一 agent 角色指令）变化；模型配置、harness/tool/skill 配置、EvaluatorSpec 版本一致。
- 对照 manifest 记录：checkpointId、镜像 digest、替换变量清单及归一化输入 hash、模型与参数、评分器版本。
- 被测 agent 不得读取 wiki、参考答案、评分秘密或前次运行产物。
- 真实模型评测须人工发起并批准模型、重复次数、超时与预算上限；未批准预算不能启动；不后台自动付费。逐次记录结果（非仅平均分），披露模型随机性与不可固定外部依赖；不以"必然提分"作为基础设施验收标准。
- 旧轨迹仅用于分析归因，不以播放历史工具输出替代真实工具执行。

### 5.1 固定对照计划与预算记账（内部纯状态机，尚未接 launcher）

`evaluation-plan.ts` 仅接收声明摘要：case/checkpoint/归一化输入/环境/harness、单一 role ID、baseline/candidate 角色内容摘要、provider/model/settings 摘要与评分器 ID/版本摘要。严格键集合拒绝额外字段；1–100 轮重复，逐轮 baseline→candidate，共同字段生成同一个 commonHash；完整计划（含两个角色摘要、次数、超时、单次/总预算）规范排序后生成 planHash。摘要不是归档字节验证或完整性资格，尚不自动从封存对象派生。模型随机性及固定执行顺序带来的时间偏差未消除。

- 人工批准声明必须 `confirmed=true`、绑定完整 planHash、含 approvalId/未过期时间；任何配置变化须新批准。这里只校验调用方声明，**没有人类身份认证、批准 UI/API、持久化或一次性消费**，不得直接作为启动/付费许可。同一个批准可创建多个内存 ledger，不能用此模块防跨进程重复支出。
- `reserve` 顺序领取每次运行、只允许一个未结算项；先按单次上限预留总预算，余额不足停止，不按平均/预测价格抢跑。单位为整数 micro-USD，每项上限 10^12，最多200项确保合计仍在安全整数内；非美元成本须外部先形成明确计费契约，不能擅自转换。时钟由受信调用方提供并要求不倒退，超时字段只是声明，**没有计时器、进程终止或实际出站费用硬限制**。
- `settle` 精确关联当前 run ID；completed 必须有输出摘要和两项二元评分（预期行为达成、目标 badcase 复现），失败/超时/取消不得带成功评分。结果仍由可信调用方声明，未执行或认证评分器。只存摘要和结构化结果，不收 stdout、任务正文、参考答案或凭据。
- 未知成本保留全部预留并停止，不能计作免费；实测超支如实记录、不钳制为上限并停止下一次。失败/超时/取消均停止；畸形回执保持预留，等待外部可信协调器确认终止和成本，不能释放后自动重试。正常成本确认后释放单次剩余额度。
- 报告逐次保留 variant/repetition/共同输入摘要/角色摘要/状态/成本/评分，并分别报告 baseline/candidate 的 attempted、scored、reproduced、expectationMet；失败计入 attempted 但不伪造评分，未结算的 reservation 不算已执行。`state=complete` 只表示计划条目已按调用方回执结算，`executionVerified=false`、`strictEvalEligible=false` 恒定，不更新 SealedCase 资格。

本段是离线调度逻辑，不创建容器、不运行 SDK/模型/评分器、不调用生产资源；自动测试只使用合成回执，不能替代真实重跑证据。**生产接线仍必须实现**：可信人工批准入口、持久化并发一次性消费与先写后派发、锁内复验/protect、独立副本/评分器隔离、受控模型出口逐请求费用预留、超时终止和可恢复报告。未知或无法约束的计费不能启动付费运行。本纯状态机不宣称 AC7/AC8 或付费门控已交付。

## 6. 威胁模型

| 威胁 | 后果 | 契约缓解 |
|---|---|---|
| 凭据/私钥进入 CAS 并随用例扩散 | 秘密泄露 | 授权目录+排除模式；归档前秘密扫描与占位替换；秘密哨兵测试（AC3） |
| 容器内 agent 写宿主机/生产 | 真实仓库与生产状态损坏 | 整体进程入容器；独立副本挂载；禁 socket/privileged；网络默认拒绝；越界路径与符号链接负向测试（AC5） |
| 回放回连生产 CAFF 回调 | 污染生产会话/计费 | 独立评测回调服务与数据库；生产回调访问拒绝测试（AC5） |
| 快照期间并发写 | 起点失真，对照结论无效 | 双扫一致性检测；v1 严格资格恒不可用，包仅作 best-effort 回放并披露证据级别（AC2） |
| 授权目录被 junction/symlink/bind mount 替换或逃逸 | 未授权内容进入 CAS | 授权绑定目录对象（statx 身份 pin）；openat2 限制域内核强制（BENEATH/NO_SYMLINKS/NO_MAGICLINKS/NO_XDEV）；能力缺失失败关闭零读取；Linux 真实链接/bind mount/替换探针（AC5） |
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
