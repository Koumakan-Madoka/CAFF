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

- `GET`：策略、CAS/清单/latest 占用与 `trustBoundary=same_os_user`；不扫描目标。占用尚不包含暂存 attempt、session/镜像分项或封存分项，不能充当完整容量报告。
- `POST /authorize`：`confirmed=true`，完整提供 `authorizedDirs`、`authorizedInputDirs`、`includedIgnoredPatterns`、`excludedPatterns`；拒绝相对/空目录、CAS 与授权根互相包含（包括可解析别名）。先持久化 disabled 再 pin；pin 失败也不继续启用。平台不支持时 pin 可能没有 identity，授权动作不等于采集可用，后续预估必须明确失败。
- `POST /settings`：仅接受正安全整数 `stagingRetentionDays` / `stagingQuotaBytes`，保留其余策略及原 pin；目录、排除/纳入模式只能重新显式授权修改，普通保存不能扩大授权。
- `POST /estimate`：空对象，逐一预估已授权目标根；不开启、不写检查点。返回逐根 `ok/complete/reason`、文件容量合计和成本口径（未算输入 session、图片、镜像及清单）；重叠授权根可能重复统计。不完整或失败不给开启回执；`dir_not_authorized`、`authorized_root_unpinned`、`root_open_failed`、`capture_unavailable:*` 等原因原样返回，UI 不应一律映射为“目录不存在”。
- `POST /enable`：`confirmed=true` + 成功预估的 `estimateId`。回执绑定项目及完整策略，仅本进程有效、10 分钟过期、使用后消耗；重新授权、普通保存或关闭使其失效。开启前再验证目标根身份和枚举，失败拒绝；这不是原子快照或空间保证。服务重启保留策略（含 enabled），但未使用的回执失效，需要重新预估。
- `POST /disable`：空对象，关闭后不再主动采集；不扫描，不自动删除既有材料。

目前只接 API；UI 显式确认、容量分项、用户标记/封存/回收仍待交付。控制器测试的正向开启部分使用合成预估；Linux 用真实 collector 的预估/换根负例单独验证，不将 API 测试称为真实 agent turn 或严格评测证据。

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
