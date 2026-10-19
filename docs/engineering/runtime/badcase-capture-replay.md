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
| SealedCase | caseId | 标记触发后长期封存的证据包：Checkpoint + 轨迹计数/关联（MVP 暂无正文）+ BadcaseFlag 关联 | captured / runnable / reproduced / evaluable（见 §8） |
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
3. **能力失败关闭**：Linux 要求内核 ≥ 5.6（openat2）+ statx btime；Linux 同步 collector 在 win32/darwin **不支持**。Windows 服务现选择§5.50原生 NT 异步子集 collector，但管理开启仍关闭，不能据此开启真实项目；darwin 仍不支持。以下 openat2 自检/错误约定适用于 Linux 路径。能力探测在采集存储内的隔离探针目录自检（普通文件读取逐字节正确、符号链接拒绝、`..` 逃逸拒绝、statx btime 可用），**失败即在扫描用户目录之前拒绝采集，零目标内容读取**；helper 被篡改/崩溃/超时 → `capture_unavailable:*`，无回退读取路径；
4. 采集前扫描生成清单 M1（受限读取、秘密哨兵检测、hash 计算；可用上一检查点的 size+mtime+mode 快速路径复用 hash，仅加速本首扫）；写 staging 时受限重读、重校 hash、重扫秘密，检测扫描与读取之间的变化；
5. 采集后重扫 M2：**全量重新读取并重 hash**（不是 stat 级比对——stat 级无法发现“同长度改写 + 恢复 mtime”）；
6. M1 与 M2 在内容 hash 级无差异且写时重校全部通过 → `content-verified`；检测到差异 → 有限次重试，重试后稳定 → `corrected-after-retry`，仍不一致 → `write-during-capture` 并记录差异路径。重试耗尽的降级包保留最后一轮读取的内容 blob（清单引用它们才能恢复），证据级别如实披露。

- **枚举与 Git 元数据边界**：采集路径不再启动 Git。目录枚举由 helper 相对同一个根 fd 用 `openat2` 打开目录，再按目录 fd 列举、lstat/readlink；不按宿主路径递归，不跟随目录链接或跨挂载。枚举上限 100,000 条，超限或 helper 失败明确拒绝；不支持的文件名/不可读目录留下缺口。`.git/index`、config、info/exclude、树内 `.gitignore` 的字节也经受限读取。`git-classify.ts` 只解析固定子集：index v2/v3/v4、SHA-1/SHA-256 校验和、UTF-8 路径；未实现的必要扩展（如 split/sparse index）降级，不把不完整索引当完整 tracked 集合。Git 配置 include 不展开，符号链接 exclude 不读取，分别记录 `git_config_include_unverified` / `git_exclude_unreadable`。外置 gitfile 元数据只有命中独立 `authorizedInputPins` 且身份核验后才能读取；无授权时 `git_metadata_not_authorized`。配置/ignore 解析不是完整 Git 兼容实现，未验证语法必须降级，不授予完整性。index 拒绝内部 NUL、非零 padding、v4 名长错配、未验证的 extended flags、gitlink/submodule 和保留路径；配置拒绝未验证的引号/子节及 worktree/bare 等分类覆盖。ignore 按 UTF-8 字节匹配，采用动态规划而非通配回溯正则，避免重复星号造成指数耗时；每份规则至多 4096 行、每行 4096 字节，超限显式降级。POSIX 字符类、复杂转义等仍不支持。系统/全局 Git 配置不加载，不宣称重现其 ignore 语义；无法验证的规则不得提供严格评测资格。`enumeration_non_atomic` 明示多次枚举/读取不是原子现场。
- **漏采完整性**：纳入范围但不可读取的文件、特殊对象、不可枚举目录等记录在 `Checkpoint.uncaptured`（path/reason），并使 `replayInput.complete=false`。稳定权限拒绝不必反复重试；缺失/读取变化仍检测和重试。缺口不是用户明确排除，也不能把缺口或不可读目录的子项当成已确认删除。恢复时包内 hash 校验可成功，但返回 `uncapturedInScope`，不能宣称 `replayInputComplete=true`。恢复发生 hash/缺 blob 错误同样阻断完整输入状态。
- **容量预估**：先显式授权目录，再预估，最后另行开启主动采集；`disabled` 不阻止用户主动请求已授权目录的预估，但预估不得扩大授权、重新 pin、修改策略或生成检查点。预估使用与采集相同的根边界：目标必须恰为已授权根，打开后在同一 fd 上核对已持久化的 statx 身份，再枚举；未列入、未 pin、缺身份、根被替换或无独立 pin 的子目录均拒绝，不以 `authorized=false` 配合扫描结果代替拒绝。不启动 Git、不读取目标文件内容，使用同一受限目录枚举原语统计普通文件元数据；未应用 Git ignore，`includesIgnored=true` 表示可能高估，枚举缺口使 `complete=false`。能力探测会在专用存储安装 helper/自检，但不写项目目录或检查点。上述 fd/statx 调度适用于 Linux。Windows 已新增独立原生 NT 元数据预估（§5.38），不读取文件内容、不提供开启回执；其管理开启仍失败关闭（§5.50服务选择仅在显式测试状态下验证，非日常可用采集）。darwin 预估/采集均未支持，不是最终验收范围缩减。
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
- 授权绑定**目录对象**而非路径名：显式授权动作（authorizeProject）固定 realpath + statx 身份（dev/ino/btime，同一 fd 上查询）；采集时父进程持有根目录 fd，所有内容读取由 helper 经 `openat2` 限制域（BENEATH/NO_SYMLINKS/NO_MAGICLINKS/NO_XDEV）相对该对象原子解析——路径改名/替换/ABA 与读取结论无关，越权内容不会被读取，更不会到达 staging/CAS。此 Linux 路径能力缺失（win32/darwin/旧内核/helper 故障）失败关闭且零目标内容读取；Windows 独立 NT 路径的身份与句柄协议见§5.34–5.50，不能以 Linux 探针成功替代。越界符号链接不读取、不进清单，且使包不完整。

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
- **预估调度边界**：管理端 estimate/enable 使用 `estimateDirectoryAsync`，在独立 Linux 子进程中执行完整能力自检、根身份验证和受限 walk（保留同 fd 安全边界）。每根最多 30 秒、每服务进程最多 2 个并发子进程（不排队，超出返回 `estimate_busy`）；stdout/stderr 合计最多 4 MiB，子进程 Node heap 上限 128 MiB（不是整个进程树内存硬隔离）。超时/超输出杀死专用进程组，等待 close 后返回 `estimate_timeout`/`estimate_output_limit`；失败/损坏输出返回 `estimate_process_failed`/`estimate_output_invalid`，均不给回执。不是被测 agent 或 Docker 回放。此处进程组调度只适用于 Linux；Windows 使用§5.38独立、无子孙进程的异步 Python 元数据 helper，darwin 仍失败关闭。同步入口只用于子进程/离线测试，不得从管理 HTTP 路径回退调用。多根顺序执行，30 秒是逐根上界，不是整个请求上界。
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
- 原始轨迹正文 **一律未归档**：现有读取器不能证明任意工具文本/远祖私有来源已授权。读取成功仅保存固定原因 `trajectory_provenance_unverified` 及事件总数/选中数；读取失败仅保存白名单原因码。task output/error、事件 payload、路径等均不进入 case 或 CAS；秘密/私有拒绝同样不保存正文。这里保存的是已授权采集器先前生成的检查点及其现有闭包，不重新扫描目标，不开启项目、不读取新的 session/附件。这不是目标中完整轨迹归档的完成证明。用户 2026-10-16 裁决优先 MVP：不新增逐包正文预览/批准流程，正文扩展后置，不阻塞其余链路；页面继续显示“材料不完整（轨迹正文未归档）”。不因此扩大采集授权或降低最终验收标准。
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

### 3.7 停写后的显式 writer lock 恢复（内部操作入口）

`project-write-lock.ts` 新增 `inspectProjectWriteLock(root, projectId)` 和 `recoverProjectWriteLock(root, projectId, {writersStopped: true, expected})`。仅受信离线操作者调用，不导出为 HTTP/agent 工具、不在启动时扫描或自动执行；本段未授权任何真实项目恢复。§3.5/§3.6 的普通写入仍不回收遗留锁。

- **前置停写是硬性操作要求**：必须停止该项目全部生产者及其委托子进程，确认退出后才 inspect/recover。`writersStopped` 只是调用方声明，不认证操作者、不检测 PID、更不是强制 fencing；父进程死不代表文件 worker 已死。不得与仍在旧写栈内的进程并发恢复。恢复函数拒绝同 JS 栈的 `held` 锁，但不能识别其他进程或未结束的 supervisor lease。
- inspect 只读，拒绝缺存储、root/projects/project/锁目录静态链接、特殊文件、未知锁内条目、坏 owner；仅接受空旧锁或唯一 64 字节小写 hex owner。owner 有界 fd 读取并复验文件身份。返回 hash 绑定规范绝对锁路径、目录 dev/ino/birthtime/mtime/ctime 及 owner；这是本地身份变化检测，不是来源认证或死亡证明。同 OS 用户与存储根以上祖先仍属 TCB，不宣称 openat2 防路径替换。
- recover 以项目 `.writer-recovery` 独占 mkdir 串行化恢复调用，门内重新核对 expected；改变的锁/错误身份不移动。先创建独占 `.writer-lock-retired-<随机六字符>` 目录，再把旧锁原样 rename 到其 `lock` 子目录（不覆盖目的地）；核验迁移后目录身份与 owner，最后移除本次空 gate。回执只有 recovered、quarantineName、materialsChanged=false、executionState=unknown；不会把未知任务改为成功或升级 case 资格。
- 合作写者在 acquire 前后检查 gate，委托借用及同步重入入口也检查；gate 存在（包括链接/损坏/恢复者崩溃遗留）即 busy。两次检查关闭 precheck→mkdir 窗口，但不能撤销已执行的写栈；仍须前述停写。普通写者仅在自己刚取得的空锁上执行失败清理。旧 supervisor release 会再次核验 owner，不能删除新 owner 的锁。
- 不读取/改写 CAS、checkpoint、case、retention、runReferences、批准或预算；不释放引用，不删除临时材料，不自动重派发。恢复只允许后续显式重试原操作：重试仍按原路径复验闭包；临时文件导致 inventory busy 的状态保持，不因锁恢复变为 GC 授权。自动 GC 仍禁用。
- 失败只给固定码。rename 前错误释放本次 gate、原锁仍在；隔离目录若已创建则保留。rename 后身份复验失败保留 gate；gate 移除失败报错不伪造成功。恢复进程自身崩溃可留下 gate（包括 rename 已完成窗口），普通写入及再次恢复继续拒绝；**本入口不递归恢复该 gate、不回滚迁移**，需后续专项处置。无目录 fsync/掉电持久性保证、无后台排他调度或隔离工件列表/配额/GC；隔离目录不计入既有七类逻辑容量。

验证：`node --test tests/runtime/badcase-writer-recovery.test.js tests/runtime/badcase-sealing-lifecycle.test.js tests/runtime/badcase-run-references.test.js`。合成存储真实子进程覆盖 lease 持有者 SIGKILL 后等待退出、引用 hardlink 发布后 exit23（跳过 finally）、恢复 rename 后 exit23、跨进程恢复争用；既有封存 worker 强杀/超时回归不变。新恢复测试不声称已验证真实服务 supervisor 与其孤儿子进程的整棵进程树停止。无 Docker/模型/SQLite/UI 或用户真实 turn 证据，全部 AC pending。

### 3.8 采集管理至消息封存的合成集成验证

`tests/runtime/session-reuse-ab.test.js` 的 `authorized capture to message seal` 用例在 Linux 上把既有路径串联起来，无新增生产入口：随机 loopback HTTP → 实际 capture controller 授权/受限预估/独立开启 → 实际 agent-executor 的执行前 collector → SQLite 消息/run/task 关联 → 实际 flags controller 与 SQLite 只读子进程/封存文件 worker → 查询。项目、目录、数据库、CAS、会话及授权确认全部是测试自建夹具；`startRun`、工具桥与模型目录仍是替身，不执行真实 pi、模型或被测工具。

- fresh/resume 各一次：在替身 startRun 入口观察已发布检查点，随后改变现场文件/会话；核对恢复内容为执行前字节、resume 原 session 字节不含执行后追加、message/run/task/checkpoint 八键关联正确。替身写入真实 run 表，executor 写实际 task/event/message 表；不以手工补造 checkpoint 或只用内存 ChatStore 代替。
- 真实 HTTP 标记后要求 `saved_incomplete`、`checkpointSaved=true`，SQLite worker 必须完成直接关联核验（`trajectory_provenance_unverified` 且事件计数非零，不接受 `trajectory_unavailable` 作为正例）。原轨迹内容仍**未归档**，不升级 captured/runnable/complete/strictEvalEligible；该断言不是来源认证。
- 同文重复 POST 不新增 case、retention 或逻辑字节；每模式关闭重开 SQLite 并重建全部服务/controller，另以独立 Node 进程只读查询原 case。不是完整应用进程重启，也不模拟掉电恢复。最终关闭采集后新合成 turn 无新 checkpoint/占用增长；缺历史现场的消息仍可标记但不制造 case。整个测试只清理自己的临时目录/监听器，不读取生产 DB/授权目录。
- 每模式诊断输出实际 checkpoint 新增 blob/清单/总字节、collector 内部耗时、session 夹具字节、标记+封存新增字节与七类逻辑占用。它是小文件合成测量，非真实用户 turn、磁盘峰值、全环境成本或性能基准；镜像未参与。时间来自既有 collector `stats.durationMs`（清单最终发布前采样），不是完整 HTTP/turn 墙钟；随机 ID/路径/时间字段会使重复运行字节数略有变化。
- 同段 `badcase-writer-recovery.test.js` 补单一 foreign 文件拒绝（禁止继续探测 owner）及 lstat→open 窗口同字节 owner 换 inode 故障，要求拒绝且不迁移锁/丢字节；只覆盖受信测试注入，不宣称防御任意同权限竞争。

复跑：先构建，在具备 Linux openat2/statx、Python3 和匹配 Node ABI 的 `better-sqlite3` 环境执行 `node --test tests/runtime/session-reuse-ab.test.js tests/runtime/badcase-writer-recovery.test.js tests/runtime/badcase-sealing.test.js tests/runtime/badcase-trajectory-process.test.js tests/http/badcase-capture-controller.test.js tests/http/badcase-flags-controller.test.js`。新增集成用例非 Linux 显式 skip，不以 Windows 通过数代替真实采集验证。

共享 Windows node_modules 不可直接作为 Linux SQLite 运行依赖：可在**独立测试副本**复制已安装 better-sqlite3 源码，移除该副本旧 build，再用本机已有且版本匹配的头文件执行 `node <npm自带node-gyp路径>/bin/node-gyp.js rebuild --nodedir=/usr --release -j 2`；不修改共享安装、不下载头文件或执行系统安装。其他依赖可只读链接；build/tests/public 复制到副本，使宿主及子进程解析同一 Linux SQLite；非 Git 副本还须复制 package.json，供 serverVersion 的包版本回退使用（否则可能报 harness_config_unverified）。本次验证范围为 Node22.22.0/better-sqlite3 12.11.1，不能推断此前 Linux Node24 SIGABRT 已解决。无浏览器、Docker、真实模型或真实用户采集证据；所有最终 AC 仍待验收。

### 3.9 显式离线 CAS 孤儿回收（不释放永久引用）

`orphan-gc.ts` / `scripts/badcase-capture/collect-orphan-blobs.cjs` 提供可信本机操作者入口；不接生产 HTTP、agent 工具或定时任务。此处补的是失败采集后**无任何现存引用的 CAS blob**回收，不是 7 天/配额驱逐或完整生命周期。前文“自动 GC 关闭”仍成立；§3.3/§3.6 的 inventory 本身仍不能直接驱动删除，只有本入口持独占写者 lease 后重新完整扫描才允许本次显式操作。

操作（仅针对操作者已获授权管理的存储；本轮只在自建合成目录验证）：

1. 构建后执行 `node scripts/badcase-capture/collect-orphan-blobs.cjs --capture-root <绝对路径> --project <项目ID>`，返回 `planHash`、候选 hash/逻辑字节、保护对象数；`deletionAuthorized=false`。预览会短暂创建/释放 `.writer-lock` lease，**不是零写入查询**，但不改材料。
2. 核对候选后，原命令追加 `--collect <planHash> --confirm`。调用方只提交摘要，不提交删除路径/候选数组。CLI 是同 OS 用户受信管理操作，不认证人类身份；不存在后台批准/自动执行。
3. 在新的独占 lease 中重算整个清单及摘要；任何相关清单、引用、目录内容或 blob 身份变化均要求重新预览。不沿用旧候选；锁覆盖重扫、逐文件身份复查、unlink 全过程。普通合作 collector/封存/run publisher 无法并发入锁，同步重入也不借用此 supervisor lease。底层直接 CAS/retention API 调用方仍有持锁义务，非合作写者/同权限恶意竞态在 TCB 外。

保护及失败边界：

- 永久保护**全部** live checkpoint（不限最新/时间/状态）及 retention/runReferences 闭包，含 file/prompt/session/config/skill。复用 `checkpointBlobHashes`，仅导出原闭包函数、未更改原 retention 语义；未知 hash 字段对现存 CAS 保守额外保护，不作为未来 schema 支持证明。未读取 blob 正文/hash，保护集合不是内容完整性证书。
- case 复验原 schema/关联及 retention 存在；flags 核对 envelope checksum/schema/项目/消息及冻结关联，已有 checkpointId 必须可由 live 或永久引用定位。latest 同样不得悬空。缺引用对象、损坏清单、未知 schema/条目、未发布临时文件、非空 staging、遗留恢复隔离目录均整体拒绝；不跳过、不修复、不自动删锁或工件。
- 自有 root/projects/project、类别/前缀/文件拒静态链接和特殊文件；元数据单文件最多16MiB、累计64MiB、目录枚举累计10000项、JSON遍历64层，fd有界读取并比较打开前后身份及UTF8。祖先与同OS用户仍属TCB；上限不是RSS硬限制，`readdir`/JSON解析仍有分配成本。存储超过限制显式失败，不悄悄截断。
- 不删 checkpoint/latest/flag/case/retention/runReference，不碰 staging、镜像、runtime/harness归档、批准/预算/评分。成功/失败/超时/未知结果或容器清理成功**均不释放运行引用**；旧 prepare/run 引用仍可长期累积，保护占用不能借此回收。不会根据 PID/TTL 推断运行结束。
- 仅按锁内验证的 CAS hash 路径逐个 unlink，不递归删目录。中途 I/O/身份失败返回固定 `orphan_gc_delete_failed` 及已删除数量/逻辑字节，不伪造整批成功，也不回滚已删孤儿；显式重新预览才可继续。lease 释放失败为独立错误并保留进度。跨进程崩溃留下失败关闭锁，无持久 GC 完成回执/自动恢复/掉电或原子批量保证；沿§3.7停写后处理锁，不把异常退出当已完成回收。`reclaimedBytes` 仅是被 unlink 文件的逻辑大小，硬链接/打开fd/文件系统可能使物理空间未释放。

验证：构建后 `node --test tests/runtime/badcase-orphan-gc.test.js tests/runtime/badcase-run-references.test.js tests/runtime/badcase-checkpoint-retention.test.js tests/runtime/badcase-usage.test.js tests/runtime/badcase-cli-verification.test.js`。自有合成目录覆盖CLI子进程、真实封存case、共享闭包、预览后新增pin/换文件、跨进程锁争用、部分unlink失败及GC子进程中途exit23。Linux另经真实collector生成小样本→永久引用→孤儿回收→两次恢复逐字一致；不含SQLite/浏览器/Docker/真实用户turn/模型。E54 owner+name成对一致替换负例随同收编。全部 AC pending；不因本入口宣称期限/配额回收、长期环境生命周期或AC6已完成。

### 3.10 停写后的显式检查点期限／配额退役（两阶段）

`inspectCheckpointExpiry/expireCheckpoints` 复用 `orphan-gc.ts` 的有界、失败关闭 inventory 与独占 lease；操作者入口为 `scripts/badcase-capture/expire-checkpoints.cjs`。仅退役未保护的 live checkpoint 清单，**不在同一调用删除 CAS**，不接后台/HTTP/agent，不释放任何永久引用。仅自建合成目录获得测试证据，未授权对真实存储运行。

1. 先停止该项目采集、所有 turn、封存和回放写者。关闭采集开关不能证明已启动的 turn 已结束；`writersStopped=true` / `--writers-stopped` 是受信操作者声明，不是存活检测或 fencing。lease 只能互斥合作的发布者，无法发现尚未发布引用的使用者，因此不能在活动系统里仅凭过期时间执行。
2. 构建后预览：`node scripts/badcase-capture/expire-checkpoints.cjs --capture-root <绝对路径> --project <项目ID> --as-of <UTC毫秒ISO时刻> --retention-days 7 --quota-bytes 10737418240`。参数顺序固定；期限/配额均须显式指定（按项目已配置值填写，不自动读取、修改或重启策略），预览正文完整返回本次规则。`asOf` 不可晚于当前宿主时间；确认必须复用同一时刻和规则，新的时刻需重新预览。时钟信任本机 OS；旧 cutoff 更保守，不代表实际保留了七天流量。
3. 检查 `candidates`（ID/createdAt/清单字节/reason）、`usageBytes`、`projectedOrphanBytes`、`projectedUsageAfterGc`、`quotaSatisfiedAfterGc` 和 `planHash`，再在原命令后追加 `--expire <planHash> --confirm --writers-stopped`。预览也暂持写 lease，不是零写入查询。确认在新 lease 内重扫，绑定 inventory、规则、保护集合及候选；任何变化拒绝并要求重预览。
4. 退役仅逐一 unlink 未保护清单，返回 `deletedCheckpointCount/reclaimedManifestBytes`，`blobsDeleted=false`。随后必须用§3.9**新的**预览与确认独立回收孤儿 CAS；不可把本阶段配额预测当作实际释放字节或删除授权。

选择及保护语义：

- 只选 schema-v1、`status=staged`、已知顶层键的清单；未知状态/未知顶层字段保守保留，不猜测其引用或生命周期。日期缺失、非规范 ISO 或晚于 cutoff 时刻（`asOf`）使整批失败关闭；未来 schema、损坏/缺失引用、未知目录/staging/链接等继续沿§3.9拒绝。
- latest、flags、retention、cases、runReferences 指向的检查点全部保留，不按成功/失败/超时/容器已清理释放。所有其他记录中出现的 live checkpoint ID 字面量也保守保护目标（checkpoint 自身 ID 不自保护）；独立永久 pin 集合仍作纵深防御。最新检查点永不通过本入口退役，不改写/删除 latest 指针；因此最后一份可能长期保留。
- 先按 createdAt、再按 checkpointId 稳定排序。`createdAt <= asOf - days×86400000` 为到期（含边界）；到期者无论配额是否满足均选中。其他可退役项仅在预测逻辑占用仍高于配额时按旧到新加入，达到配额即停止。保护材料即使自身超配额也不删除，此时明确 `quotaSatisfiedAfterGc=false`，不假称清理完成配额目标。
- 预测使用 committed 逻辑字节（与 computeUsage 同口径，排除policy/staging），共享 blob 只计一次；逐条元数据的保守 hash 集计数，只有移除全部引用才成为预测孤儿。已有孤儿也纳入未来§3.9回收预测，可能无需退役任何近期清单即可满足配额。不会读取 blob 正文证明完整性，文件系统物理占用和镜像/评测记录成本不在此数内。
- 逐文件删除前复查 identity；锁覆盖计划复算至删除结束，发布新 pin 必须等待。部分 unlink 失败返回固定码及准确已删除清单数量/字节，保留全部 CAS；剩余清单/引用始终不悬空。进程 exit 留失败关闭锁、无自动续跑，按§3.7停写恢复后必须重新预览。释放锁失败仍报失败并携带进度；无原子批量、目录掉电保证或持久退役回执。源码扫描沿用§3.9限额与同OS用户/祖先路径TCB，不防恶意并发。

验证：`node --test tests/runtime/badcase-checkpoint-expiry.test.js tests/runtime/badcase-orphan-gc.test.js tests/runtime/badcase-run-references.test.js tests/runtime/badcase-checkpoint-retention.test.js tests/runtime/badcase-usage.test.js`。合成存储覆盖期限边界、配额精确停点、共享/已有孤儿、latest/标记/pin/未知状态保护、换计划、CLI、真实子进程锁争用/exit23、I/O部分失败/身份替换/链接拒绝。Linux另以真实 collector 生成三份小样本后**人工改时间模拟老化**，退役未标记旧项、保留 retention 与 latest，单独GC后两次恢复二者文件一致；非真实用户turn或实际七天留存测量。没有生产定时驱逐/容量预留、完整环境生命周期、SQLite/浏览器/Docker/模型证据，全部AC仍pending。

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

- 仅专用 `/var/tmp/caff-image-recovery-*/docker.sock`，独立 data-root、vfs；校验 daemon ID 与共享 daemon 不同、开始时无镜像/容器。加载及整个 probe 创建/执行/inspect/清理均经显式 Unix socket，绝不回退 default daemon。恢复 transport 每次执行前后复验 daemon 和 image 身份；在 probe 创建容器后、start 前，另经恢复器持有的目标 transport inspect 该完整容器 ID、image ID、owner label 及未运行状态；attach 返回后、rm 前再次独立 inspect，核对同一 ID/image/owner、非零 StartedAt、已停止、非 OOM 与退出码；rm 后另经目标 transport 按完整 ID 查询 ps，必须无残留。成功返回要求三个观察均完成，末尾还核对回执 ID。没有观察或 ID 不符即拒绝，不以运行前后容器数相同代替存在性证据；观察失败仍由 probe 清理本次容器。此交叉核验针对受信代码误路由，非远程认证或抵御同权限恶意 probe。路径命名不等于隔离认证；生命周期管理器还必须核对命名空间和 PID。
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

### 5.2 批准声明持久化与一次性派发记录（可信内部协调器，非付费入口）

`evaluation-record.ts` 将 §5.1 接为文件型执行记录，模块本身无 HTTP/agent 工具、批准 UI、SDK/模型或 Docker launcher；§5.4 通过本地管理入口保存仅限离线脚本计划的声明，尚未接启动。`recordEvaluationApproval` 只保存可信调用方提供的人工批准**声明**，不认证发起者、也不授权真实付费。实际入口必须在用户批准具体用例、评分规则、模型及预算后调用；不能把 `confirmed=true` 当作人类身份验证。`dispatchRecordedEvaluation` 的 executor 是受信注入函数；模块自身测试使用离线替身；§5.3 新增脚本化模型的真实容器 SDK 提交/评分接线，仍不可当真实模型或 badcase 复现证据。

- 专用存储 `root/evaluations/<sha256(approvalId)>/`，不存原始任务、stdout/stderr、异常正文、参考答案或凭据；仅存严格 plan spec、批准声明、时间与结构化回执。approval ID 在该 root 内唯一；同 ID/相同内容重试只读，变更内容拒绝。不同 root/新 ID 不是全局去重，不能通过复制目录/删除文件重置批准来绕过预算。此存储必须在被测容器外、不进入 Git；未接 capture usage、配额、生命周期或 GC。
- 先独占创建批准目录，再以 wx/0600 写 `approval.json`；派发以 wx 创建永久 `claim.json`，使同一个批准跨进程只能被一个执行序列消费。重复启动即使已完成也拒绝，不重放、不从未完成尾部继续。每次先将预算预留事件写入编号 JSON 并 fsync，成功后才调用 executor；结果验证成功后追加落盘，先前结果不可覆盖。单个批准最多200次运行，单记录目录最多404项，批准文件64KiB/事件4KiB读取上限。file fsync **不是目录持久化或掉电保证**，存储及祖先路径、同 OS 用户为 TCB，不抵御删改整个记录或恶意路径替换。
- 派发使用模块自己的 `Date.now()`，不接受调用者提供时间；拒绝倒退。每次预留检查期限，并在磁盘写入结束后、调用 executor 前再次检查，request 携带精确 approvalId/planHash/expiresAt/单次费用与超时。时钟仍信任 OS；adapter 必须在真正异步启动/模型出口再次检查期限并执行超时、逐请求预算和容器终止，本模块没有这些硬限制。
- 只读查询按批准时刻重建 ledger，再按编号重放 reserve/result/finish，验证字段、时序、状态转换、固定模式与文件类型；部分/缺失/过大/未知/乱序数据拒绝，不补建或重置。并发读取可能看到未完成写入并明确失败，不声称原子读快照。活跃 executor 与崩溃遗留均报告 `unresolved`，不根据 PID/年龄猜测外部执行已停止。
- executor 抛错或回执非法：保留未结算预留，记固定原因 `dispatch_failed`/`invalid_result`，不伪造失败费用或评分；错误正文不落盘。记录写失败直接失败关闭，可能留部分工件；未知是否已执行时不得自动重试。进程退出后仍能查询已有合法记录，**没有自动修复、结算恢复、取消或后台重跑**。预算耗尽、过期、未知费用、超支及失败沿 §5.1 停止后续。
- `finished` 仅表示协调序列已记录终止，不保证所有任务成功；每次评分仍是受信 executor 的声明，没有执行/认证评分器。`executionVerified=false/strictEvalEligible=false` 不变；claim/reservation 不是执行证明。无输出材料存储、真实模型门控或资格升级。Docker 启动后/rm 后的目标侧独立交叉核验已在 §4.11/§5.3 接线，不以本段文件测试替代。

回归：构建后 `node --test tests/runtime/badcase-evaluation-record.test.js tests/runtime/badcase-evaluation-plan.test.js`。隔离临时目录、独立 Node 子进程查询/竞争、dispatch 内进程退出23、fsync故障、写入期间期限越界、未知成本与坏回执；均为静态/离线协调逻辑，不在宿主运行真实 agent。初始化 Docker 证据沿 §4.11，本段不宣称新增容器/真实模型/SQLite/UI 或任何 AC 完成。

### 5.3 持久派发 → 容器内 SDK prompt/真工具 → 容器外评分（脚本化模型诊断）

`scripted-evaluation.cjs` 是可信内部离线 adapter，不是付费入口。显式使用 `caff-offline-scripted/tool-loop-v1` 替换捕获的 provider/model；这是**声明的测试替身，不是忠实回放**，不得冒充单一 role 变量的真实模型评测。不会从脚本模式自动切换真实 provider。保留 §4.7 的受限 fresh/resume 输入范围，拒绝 skill/bridge/复杂历史/缺材料，不静默 fresh。

- 准备时锁内复验 capsule 并 protect，必须显式提供有效 runtime/harness 归档；计划由实际 capsule/checkpoint、镜像声明、暂存文件清单、两份角色字节及 host 评分规则派生摘要。角色文本限16KiB、有效UTF-8、无NUL并通过秘密哨兵扫描。容器 task harness 是**当前受信源码的内存钉住副本**，显式替换归档中的旧 diagnostic probe；`harnessHash` 绑定完整基础暂存清单（包含输入和runtime，非仅代码）。该任务 harness 尚未独立长期归档；宿主调度器和评分器代码仍属 TCB。
- `execute` 只能接 §5.2 的精确 dispatch 字段，并逐键对账 plan/run/common/role/次数/25s超时/单位测试预算。每个 run 再锁内读取、复验并 protect 完整原材料闭包，与准备时 capsule 字节一致；不读 live，不 release。prepare 本身保留一个引用，成功两次运行另外各一个引用。来源声明、输入字节、角色和计划均脱离调用方副本；每个容器另建暂存副本，仅选中 role 与运行元数据不同。run ID 在 plan 内唯一；跨相同计划的不同批准需联合 approvalId 区分，不宣称全局唯一。
- 显式注入专用恢复 transport，无默认 daemon fallback；容器前后隔离核验和创建/执行后/删除后三阶段独立目标观察沿 §4.11。宿主只复制/校验数据与可信发行文件，不 import SDK、不执行捕获代码。容器重新核对全部 manifest 文件、capsule/模式/history/invocation摘要、Node/Python/pi版本，关闭发现/扩展/compaction/retry/网络。
- 容器真正调用 `session.prompt(invocation, {expandPromptTemplates:false})`，受信脚本流通过正常 SDK agent loop 发出 write→read→edit→bash 四次工具调用，再结束；不是直接调用工具 execute，也不是播放历史工具输出。脚本无语义推理、不根据 role 改变行为，因此 baseline/candidate 通常得到同一产物，**不能证明 prompt 有效或候选提分**。模型注册仅用公开 inert marker 满足 SDK 认证接口，不注入真实凭据，Docker network none；真实模型调用为0。初始化前、prompt前及每次脚本流调用复验批准期限；25s容器内 timeout 保留，逐 run 时限与宿主主动终止接线见 §5.9；仍非返回硬上界或付费费用硬限。
- 被测容器不接收 host 评分规则/期望hash/wiki/前次产物。宿主固定非可执行的 `file-sha256-v1` 评分器仅比较本次固定产物字节摘要与预先绑定的 expectedHash/badcaseHash；容器回执不能自报分数。产物最多4096字节、规范base64，stdout最多16KiB，精确核对回执键/模式/各摘要/脚本5次/工具顺序/零网络。没有产物存储服务：原始产物与回执仅内存校验，持久记录只存其hash和二元评分；不落原始输出或异常正文。脚本及观测与 agent 同权限，不是抗恶意 agent 的证明，不能据此宣称一般评分防篡改完成。
- 成功的脚本运行可确认费用为0；坏回执/容器错误/清理失败/过期按协调器保留 unresolved/未知费用/未结算预留，停止后续并拒绝重放，不伪造0费用或已执行状态。评分只描述合成产物，`executionVerified/strictEvalEligible` 仍false，不升级 SealedCase 的 runnable/reproduced/evaluable。
- `verify-image-recovery.py --scripted-evaluation`（其余五个镜像参数同 §4.4）在专用 daemon 真跑 fresh/resume 各两份，读回逐次落盘结果、再次派发被拒、核对源 CAS 未变；另做容器内过期/移除prompt两项真实故障、已完成真实容器的回执篡改一项，均保留 unresolved。测试脚本自身生成的批准不是用户真实付费批准。实验记录/归档/容器均随专用生命周期清理，非长期交付用例；独立单测补编号间断、伪complete、幂等spec比对和目标daemon后置观察负例。

仍缺：真实人工批准UI/API、受控付费模型出口与逐请求预算硬限、真实模型对照及用户认可评分器、轨迹正文/完整输入支持、环境长期引用/GC/崩溃恢复、真实采集容量/UI验收。无本段 SQLite/浏览器/用户真实 turn 证据；全部 AC pending，不以此离线诊断代替 AC8。

### 5.4 本地离线批准声明与逐次报告管理（无启动/付费入口）

项目页新增 `badcase-evaluations` 面板，经生产 composition 接入 `evaluation-admin.ts` / `badcase-evaluations-controller.ts`。这是**摘要声明的人工确认入口**，不是可运行回放入口：目前操作者需复制受信离线计划的 `spec` JSON，界面显示完整 spec、planHash、逐次 run 清单及 5 分钟到期时间。尚未读取 case/归档/角色正文或评分规则，未核验这些摘要与实物一致；不证明用户认可了实际评分器或真实 badcase。不得用于满足真实模型运行批准条件。

- `POST /api/projects/:projectId/badcase-evaluations/preview` 仅接收 `{spec}`。严格计划字段并限 `caff-offline-scripted/tool-loop-v1`、`offline-diagnostic-role`、`file-sha256-v1`、25s、每 run 1 micro-USD 预留/总额 repetitions×2（与脚本适配器一致；不是实际收费）。拒绝其他 provider、额外路径/凭据/执行器，执行既有秘密哨兵扫描；没有秘密识别完备性承诺。
- 预览只存服务内存，不创建目录；服务生成随机 approvalId，将完整脱离副本的计划、projectId、创建/到期时间绑定。全服务最多 64 张未过期回执，满额返回 busy，不驱逐有效回执；到期在下次 preview 惰性清除。重启丢失未确认回执，不自动重建。
- `POST .../approve` 只接收 `{confirmed:true, approvalId, planHash}`。须同项目、同摘要、回执未过期且时钟未倒退；不允许客户端改期限/预算/模型或追加字段。用户取消无 approve POST、无落盘。保存调用 §5.2；同回执未过期的重试幂等，网络失败不自动重试，已有 ID 可只读核对。保存瞬间内部 §5.2 也校验期限，磁盘失败不伪报成功；已写但回执丢失仍可能存在记录。
- `GET .../records/:approvalId` 只读重建已确认记录；项目隔离存储，重启后无需预览回执。错项目、缺失、畸形/不完整记录拒绝，不返回空报告冒充未运行。逐次 run/角色摘要、费用、评分、汇总与批准配置原样显示为文本；`null` 费用明确是未知，`reserved/unresolved` 不证明进程仍活跃或已停止。未发起时 runs 为空，不生成合成评分。没有查询所有记录的列表，用户须保留 ID。
- 管理复用 loopback/Host/Origin/JSON/bootstrap CSRF guard；没有 agent tool，且**生产 composition 不提供任何 dispatch/start 能力**（§5.6 专用工作台显式注入时才开放材料/start 路由）。同 OS 用户进程仍可模拟确认或改存储，confirmed 不是人类身份认证。此接口不接真实 provider、不触碰 Docker/SDK/采集开关，不授予任何付费许可；后续受控付费出口需单独门控。
- 数据固定在 `<agentDir>/badcase-offline-evaluations/<sha256(projectId)>/evaluations/<sha256(approvalId)>`；客户端不能选择 root。自有 root/project 目录拒绝符号链接，祖先与同 OS 用户仍为 TCB。构造与 GET 不创建目录；该存储独立于 capture CAS/配额统计，暂无配额/GC/删除/项目删除联动，不宣称容量保护完成。部分文件和旧 claim 不修复、不清理、不重试执行。
- 页面切换项目会清空回执、ID、草稿和报告，忽略旧异步响应；不撤回已经提交的管理写入。修改 spec 立即使回执失效；确认时再次检查期限。完整 JSON 使用 textContent，不渲染调用方 HTML；错误不回显原异常正文。
- 顶层固定 `mode=offline-scripted-declaration`、`launchAvailable=false`、`paidAuthorization=false`、`materialVerified=false`；底层 `executionVerified/strictEvalEligible=false` 不变。报告写入由受信离线协调器负责；§5.5 已接专用 daemon 的内部离线 runner 与此批准存储；生产项目页仍没有启动入口。§5.6 的独立操作者工作台另提供显式材料启动能力；报告信封不因此升级通用 launch/material 资格。
- 验证脚本 `node scripts/badcase-capture/verify-evaluation-admin-ui.cjs` 在随机 loopback 端口/临时目录运行实际面板、HTTP controller、持久化服务，浏览器仅允许本服务出口；验证取消零批准请求、显式确认、服务重建与逐次报告查询。两次评分由测试注入 executor 产生，**不是 Docker/模型/真实项目证据**；不覆盖完整 app shell 或 SQLite，全部验收资格不升级。

### 5.5 已保存项目批准 → 可信离线 runner → 同一管理报告

`approved-scripted-evaluation.cjs` 导出可信内部 `dispatchApprovedScriptedEvaluation`。不是 HTTP 路由/agent 工具，也没有任意 JSON 上传执行或自动启动 CLI。操作者提供专用管理 root、projectId/approvalId、封存关联与归档引用、角色正文/评分规则，以及 §4.11 恢复器的 `runProbe` 能力；该函数自身不启动 daemon、不签发批准、不从材料变化生成新批准。注入函数属于 TCB，不是 Docker 能力认证；真实验证必须使用恢复器，单测替身不得冒充 Docker。

- 通过与管理 GET 相同的 `read()` 读取离线批准；缺失、非离线、已消费、过期、倒退时钟均在材料准备前拒绝。不建缺失记录/目录。`evaluationAdminRecordRoot` 统一只读存储路径和自有 root/project 目录检查，禁止链接重定向；同权限进程与祖先路径仍属 TCB。
- 精确核对 request 关联的 projectId 和 flagId；从实际封存 capsule、角色、归档材料重新生成 §5.3 完整 spec，次数取已批准 spec。要求完整 spec 与 planHash 同时相等，不只核对 case 或 role 摘要。无批准材料差异、缺归档、损坏 CAS 不创建 claim、不调用 transport；材料准备可能已经留下保护引用，不撤销或授予 GC。镜像真实身份仍由恢复 transport 校验，不把镜像声明 hash 当 load/来源证明。
- 准备后重读完整批准报告并复验期限，防止读材料耗时越过期限；内容变化/已有 claim 拒绝。协调器再从同一项目 root 加载并 wx 领取 claim、先写预算事件，逐 run 请求的 approvalId/planHash/expiresAt 再绑定原批准，随后由 adapter 逐 run 锁内复验并 protect。仍无跨文件原子事务，不抵御同 OS 用户恶意替换；已有引用/claim 不自动清除，失败不得自动重试。
- 只通过原存储追加逐次结果，返回与管理 GET 相同的信封；管理服务重建后直接查询，不需旧预览票据。坏回执/transport 异常保留 unresolved/未知预留，不写异常正文/原始产物。重复调用在准备前拒绝；并发消费沿 §5.2 永久 claim。此内部路径只核验受限脚本诊断材料与批准声明一致，不升级一般忠实回放资格：`launchAvailable/paidAuthorization/materialVerified/executionVerified/strictEvalEligible` 继续 false。`materialVerified=false` 指管理信封不发布通用材料认证，不能据此声称本段未执行逐字节检查。
- 真实实验：已授权 Linux root 下运行 `verify-image-recovery.py --approved-scripted-evaluation`，其余五参沿 §4.4；与 `--scripted-evaluation` 互斥。随机 loopback HTTP controller 的 preview/approve（模拟用户点击）→内部 runner→专用 daemon SDK 工具→重建服务后 GET。fresh/resume 各两个真实容器；另一个成功容器的回执篡改后 unresolved。每个场景验证换角色计划零 transport 且未消费、错项目 GET 拒绝、重复派发零新容器、源 CAS 不变。测试本身生成批准，**不代表真实人类批准**；无浏览器、完整 app shell、SQLite 或真实模型证据。临时记录与环境随实验删除，非长期留存。
- 自动回归：`badcase-approved-scripted-evaluation.test.js` 覆盖完整计划绑定、缺/坏归档与 CAS、准备中到期/批准变化、非离线记录、异常未知预留、并发/重复消费；`badcase-evaluation-admin.test.js` 补持久化非离线记录 GET 拒绝（E43 P3）。新模块初始红灯仅模块缺失，非原实现 bug 修复。本段未修改 SDK/harness 行为；动态 timeout 后续接线见 §5.9，完整容器侧变异电池仍未交付。

生产项目页仍缺启动与实际材料配置生命周期；§5.6 补独立工作台。受控真实模型出口、用户真实 badcase 及付费参数批准、长期引用/配额/GC/崩溃恢复仍缺；全部 AC pending。不能将本链路的脚本固定产物评分称为 prompt 提分或真实 badcase 复现。

### 5.6 专用离线材料工作台（显式启动、无生产接线）

`scripted-workbench.cjs` + `workbench-server.cjs` 提供受信操作者编程接口 `startScriptedWorkbenchServer({root, materials, runProbe})`。没有自动 CLI、配置文件加载、生产 create-server 接线或 agent 工具。操作者须先准备专用归档恢复 daemon，再注入 §4.11 的 runProbe；服务本身不创建/终止 daemon，也不认证注入函数。材料列表是至多64项脱离副本的受信配置（ID/项目、封存请求、固定镜像、runtime/harness归档、两角色、固定hash评分规则）；浏览器不提交路径、socket、provider、执行器或捕获代码。镜像声明先复用纯 `prepareOfflineTask` 校验（合成空文件仅供结构校验，不执行），真实镜像身份仍到启动时由恢复器核验。

- 独立 HTTP 仅绑定 `127.0.0.1:0`，使用独立管理 root、随机 CSRF、既有 local-admin guard，静态资源固定白名单、no-store/CSP、固定错误码，无生产 DB/凭据。GET检查loopback/Host，POST另检查Origin/JSON/CSRF；同OS用户仍可模拟管理请求。关闭服务等待在途请求结束，不代表取消容器；操作者不得先销毁仍在用的daemon。
- 可选 controller 路由 `GET .../materials` 只列当前项目材料ID；`POST .../material-preview` 只接 `{materialId,repetitions}`（1–10）。生产没有workbench能力时这些路由和 `material-approve/start` 均404。ID选择不扩大采集授权，也不启用采集。
- material-preview 从封存CAS、归档及角色/规则重建实际计划，**会产生/保留prepare保护引用**；取消或过期不unpin，不授权GC。与§5.4纯spec预览不同，不宣称无磁盘副作用。最多64张5分钟内存票据，满额在准备前拒绝；到期惰性移除，时钟倒退拒绝。
- 人审投影展示两角色正文、固定task=`fixed-write-read-edit-bash-v1`、deliveryMode、输入/历史摘要、镜像声明、expectedHash/badcaseHash与完整计划/次数/超时/预留单位。它**不提交捕获的原始请求、不展示其正文、仍是脚本替身任务**；评分是容器产物SHA256与两个不同hash比较，不是用户自然语言评分器。规则/参考答案不进入被测容器。`reviewHash`绑定该投影及planHash；归档路径、capture root、session正文不出现在投影。确认前review/角色正文/规则仍在内存；§5.7增加确认时的本地持久归档（无配额/GC）。持久报告仍保留既有plan摘要，人审正文另查；不把reviewHash当人类身份或来源认证。
- `POST .../material-approve` 和 `POST .../start` 均严格 `{confirmed:true,approvalId,planHash,reviewHash}`，检查项目、票据、期限、时钟和全部摘要。前者只保存现有批准声明，后者须另一次显式确认；start重读持久批准并绑定票据planHash/期限，再经§5.5复验材料和claim。包含有效但不同repetitions的新持久计划也拒绝（开发回归先红后修）；多阶段读取不是防同权限恶意竞争的原子事务。
- 每个workbench一次在途启动，无排队；同票据第一次尝试即锁住，无论是否已claim，错误均不自动重试。其他票据busy时不消费。持久claim仍是跨实例最终一次性防线。浏览器断开不取消运行；启动请求同步等候runner返回，不承诺HTTP/kill硬上界。重启丢失票据，不恢复旧任务；已有批准与逐次报告可凭ID查询。资格信封沿旧管理层全部false，表示未取得通用回放/付费许可，不表示专用工作台没有执行能力。
- 独立页面 `badcase-workbench.js` 仅被专用server加载，生产projects页不加载。材料选择→角色/规则文本预览→保存确认→启动确认分离，取消零对应POST；修改材料/次数/ID使旧预览失效。报告/预览只textContent，项目切换丢弃迟到响应；启动失败或结果未知保留ID、禁再次启动、不自动POST重试；刷新查询不重新授权。
- 验证两种口径明确分开：`node scripts/badcase-capture/verify-workbench.cjs --browser` 用真实Chromium+实际HTTP/归档材料/存储，但executor是合成替身（零Docker/模型）；`verify-image-recovery.py --workbench` 加§4.4五参用实际HTTP显式启动→专用daemon真实SDK工具→重建后GET，fresh/resume各两容器，无浏览器。两者不合称浏览器到Docker同次端到端；均非真实人类批准/真实模型/真实badcase。实验工件随自有生命周期清理，非长期记录。Windows/Linux链接回归覆盖read与runner在root/project两层指向同内容decoy仍拒绝、零transport/零decoy写入（E44 P3）。

仍缺生产材料/环境注册及生命周期、完整回放和真实评分人审、受控模型出口/费用硬限、真实用户turn与模型重跑、长期引用/配额/GC/崩溃恢复。动态timeout后续见§5.9，完整容器侧变异电池仍缺；Linux SQLite门槛和全部AC pending保持不变。

### 5.7 已确认人审投影的持久归档（专用工作台）

`review-archive.cjs`只保存§5.6已经展示的角色正文、固定hash规则、镜像声明、模式与摘要，以及项目/材料/批准ID、创建/到期时间、reviewHash；完整计划仍在原批准记录。它不是环境包、原始请求/会话归档、材料注册表或真实模型批准。不增加生产能力，也不把投影重新送进容器。

- preview不写review文件；material-approve在原批准落盘之前以`wx/0600`独占创建`<adminRoot>/<sha256(projectId)>/reviews/<sha256(approvalId)>.json`，fsync并有界读回复验。调用方返回副本与票内投影分离；完整旧文件仅允许精确幂等，不覆盖冲突/部分文件。写入或fsync失败不确认成功，不删除工件；完整但未确认fsync的文件可被精确重试重新使用，不声称掉电持久性。目录未fsync，双文件不是原子事务；过期/崩溃可能留下无批准的孤立投影，GET必须先读有效批准，不自动补批准或修复。
- 编码文件上限256KiB；有界fd读取，lstat/fstat身份与大小、UTF-8、schema、逐角色16KiB/UTF-8/NUL、秘密哨兵、reviewHash、planHash、角色hash、评分器版本hash及镜像schema/环境hash复验。拒绝额外字段/路径；自有root/project/reviews层及文件拒绝链接。祖先路径及同OS用户仍属TCB，多次读取不是抗恶意竞争的原子快照，摘要不是认证；未知秘密不能保证全识别。invocation/history摘要只做格式与reviewHash绑定，离线查询不读取CAS证明其真实性；start仍经原runner复验实际材料。
- 专用controller可选`GET .../reviews/:approvalId`：先读同项目有效离线批准，再绑定投影的ID、plan、批准到期时间和recordedAt。返回原全false信封加`reviewArchive`；不要求当前注册表、材料实物或未过期票据，不新建目录/补缺文件。旧批准可继续查`records`；缺失/损坏投影报`evaluation_review_invalid`，不宣称人审材料已保存。生产未注入workbench时新GET仍404。
- start在claim之前读持久投影，并将其reviewHash、完整review及materialId重绑内存票据；缺失、替换、损坏拒绝且不消费claim。查询不签发票据、不复活启动权限；重启仍只能查旧记录。通用内部§5.5 runner未变，不把这层投影要求声称为所有受信内部调用者的强制约束。
- 独立UI增加“查询已保存人审材料”，按批准ID只读、textContent展示；先清空旧预览授权，检查项目/批准/计划/到期绑定，迟到响应隔离。角色正文不会进入原生产报告页面。新文件保留至操作者另行授权处理，尚无配额/列表/删除/GC/环境引用，不计入capture占用；不能以本段称已完成材料生命周期。
- 验证：工作台/HTTP/UI套件覆盖确认前不写、重试、重启且注册表改变仍读旧值、语义改写后重算hash、超限/非法UTF-8、秘密哨兵、链接、部分写/fsync/写后过期、启动前缺失与替换拒绝；单在途回归加5s per-test超时，防守卫缺失导致无限挂起。`verify-workbench.cjs --browser`用Chromium+合成executor查重启后的持久正文；`verify-image-recovery.py --workbench`仍是另一次HTTP→专用Docker工具诊断，增加重启投影一致检查。两类证据不合称同次浏览器→Docker，临时实验记录清理不等于真实项目长期留存；无真实采集/模型、全部AC pending。


### 5.8 同次浏览器 → 专用 Docker 验证（合成材料、脚本模型）

`verify-image-recovery.py --browser-workbench` 加 §4.4 五个镜像参数，以及显式 `--browser-executable <绝对路径>`、`--browser-library-dir <绝对路径>`；需要独立字体配置时再传 `--browser-fontconfig <绝对路径>`。这些路径仅由可信操作者提供，不接 HTTP，也不自动安装、下载或探测宿主浏览器。缺路径/模式混用在启动 daemon 前拒绝。

- Python 保持原专用 daemon 生命周期，另以 `unshare --net` 启动 Node 调度器和浏览器，只在新命名空间启用 loopback；Node 检查自身 net namespace 不同于父进程。HTTP 仍绑定随机 `127.0.0.1:0`；Docker CLI 使用显式 unix socket，任务容器仍 `network=none`。浏览器请求路由仅允许该工作台 origin。浏览器环境只传固定 PATH/LANG、自有 HOME/TMPDIR、显式库目录及可选字体配置，不传生产凭据。root Chromium 使用 Playwright 默认 no-sandbox，**不宣称浏览器 OS 沙箱**；仅允许可信合成页面，不用于不可信网页或真实用户内容。
- `--browser` 仍为真实浏览器+合成 executor；新增内部 `--browser-docker` 明确选择真实归档恢复 transport，二者不可混用，不因浏览器启用而退回合成 transport。第三种旧 `--workbench` 仍是无浏览器 HTTP→Docker。前两种既有分离证据不被追溯改写为同次证据。
- 同一脚本在 fresh/resume 两材料上由浏览器取消/确认批准、取消/确认启动，验证取消零 POST、确认各两次 POST；真实运行四个 SDK 工具任务。页面读出的逐次 runId 与实际 transport 调用顺序相等，四个容器 ID 必须有效且唯一。服务重建且当前角色改变后，浏览器重新查询 report/review，逐字比较原记录，旧授权不复活；源 CAS 不变，每模式三保护引用。`sameRunBrowserDocker` 只表达此诊断证据，不升级通用 executionVerified/strictEvalEligible。观察基于受信验证器与已有目标 daemon 三阶段检查，不是第三方认证。
- 浏览器等待任务结果至多120s；既有 Node 诊断300s超时、daemon退出/残留核查保持不变，不能把此等待上限宣称为容器任务硬时限或父进程崩溃恢复。失败只输出已知阶段码，不输出原始 assertion/路径/响应。脚本清理自身 daemon/容器/实验材料；外部操作者提供的浏览器、库、字体目录不自动删除。
- 初次只有 `ldd`/版本与无选择框静态页通过仍不足：本环境 `<select>` 渲染因缺 Fontconfig 配置/字体触发 Skia FATAL/SIGTRAP。必须有实际工作台下拉选择和点击证据。实验额外从已验签 Debian 索引取得字体包、校验 hash 并仅解包，私有字体配置与缓存不修改系统；这不是项目镜像依赖归档。
- 全程固定脚本 provider、合成封存输入、模拟确认，真实 SDK/tools 只在专用 Docker。不是人类实际批准、忠实原任务回放、真实模型或 badcase 复现；所有 AC 仍 pending。无生产代码/UI能力扩展，无真实采集、付费、合并或发布。

### 5.9 离线逐 run 截止、主动停止与超时记录

`scripted-evaluation.execute` 把已逐键核对的 `timeoutMs` 显式传给专用恢复器，再传给 `runProbe`。离线计划仍固定25000ms，不新增页面可调范围或付费能力；内部 probe 仅接受整数1–25000ms，省略时25000ms，显式null/越界拒绝。预检、归档/暂存、create及创建观察不在此任务计时内。

- 在调用 `docker start -a -i` **之前**启动宿主单调时钟计时，包含 attach/stdin解包及SDK运行。到期经同一目标transport重新inspect，核验完整容器ID、镜像、owner和隔离配置，只对仍在运行的这个ID发 `docker kill`；已经退出也不撤销截止状态。await返回时另检查单调耗时，防事件循环延迟让晚到结果抢在timer回调前被接受。外部attach CLI kill触发点为timeoutMs+5000；原容器内`timeout -k 2 25`仍是纵深限制。
- 停止观察与kill操作必须join后再进行完成观察/清理，不留异步watchdog与rm或下一run竞争。原本地inspect和恢复器独立目标侧完成观察均须确认Running=false、非OOM、真实StartedAt与attach退出码匹配；随后owner核验、rm和两侧残留检查全部通过才返回`termination={reason:deadline,timeoutMs,stopped:true,removed:true}`，并清空超时返回的stdout/stderr。不以退出码124、stdout、CLI已退出或UI等待超时推断停止成功。任务恰好在截止时正常结束亦按已到期处理，不给成功评分。
- adapter先绑定容器ID/manifest，再严格核对termination完整字段、批准时限和`result.failure=timeout`，返回`timed_out`且cost/outputHash/score均null。原持久协调器记录此行，保留该次未知费用预留、stopReason=cost_unknown，不派发候选、不自动重试；重读仍为同一结果。`finished`仅表示本序列结束，不代表费用已结清。停止失败、观察失败、清理失败或畸形回执仍为`unresolved/dispatch_failed`，不伪造timed_out或零成本；不释放CAS引用。
- **边界**：这是存活受信父进程的截止控制，不是实时硬上界。事件循环、Docker控制命令及close/清理可能延迟，总墙钟含准备和清理；daemon故障、父进程崩溃/重启恢复、孤儿治理及真实模型出站费用硬限仍缺。固定25s容器内限制不能替代完整崩溃恢复。transport及内部probe注入仍属TCB，不认证任意调用方提供的函数或回执；无新生产入口、真实采集或模型权限，通用资格保持false。
- 回归覆盖时限传递/范围、owner错配、kill/rm失败、晚退出、事件循环阻塞、超时回执缺项/错时限/未清理，以及报告重读/无评分/未知费用。新增接口三红为功能缺口，计时器延迟晚结果另先红后修；不是把新模块缺失当行为红灯。E48补64位非hex与65位hex ID负例，属于既有验证器覆盖。
- 真实验证沿用 `verify-image-recovery.py --scripted-evaluation` 和§4.4五参，共9容器：旧7场景加fresh/resume各一个故障任务。只在私有内存中替换受信task源码的固定bash步骤为忽略TERM的长循环（工具超时60s），**在计划/hash/批准之前**纳入清单，不改共享源码、不在执行后伪造manifest。真实SDK通过session.prompt进入bash工具；截止kill前在目标daemon `top`中观察固定子进程标记，kill后原三阶段观察及清理通过，逐次持久记录timed_out、无评分/费用未知、后续未派发、源CAS不变。该故障任务不是正常两角色效果比较；无真实模型、付费或用户badcase复现证据。完整容器侧守卫变异电池与全部AC验收仍未完成。

### 5.10 专用 daemon 的显式崩溃清理（内部 opt-in，不结算评测）

`probe-recovery.cjs` 提供 `saveProbeIntent` 与 `recoverProbeIntent`。`runProbe` 仅在受信调用方传入 `recovery={directory,target}` 时，于任何 Docker create **之前**写入意图；`restoreImageArchive` 的可选 `recoveryDirectory` 将已钉住的目标传给每次 probe。省略仍为旧诊断路径，不宣称已有恢复覆盖；没有新增 HTTP/agent 能力或后台扫描。

- 意图记录版本、随机 UUID owner、固定 name、image ID、目标 socket/daemon ID/data-root；不含 prompt、session、凭据或原始输出。配置根必须是普通目录，文件以 `wx/0600` 独占写、fsync、读回复验；4KiB 上限、UTF-8/schema/hash、root与文件链接拒绝。重复/部分写不覆盖、不自动修复；意图发布失败零 Docker 调用。文件 fsync 不等于目录掉电持久性；hash 不是同 OS 用户来源认证，路径祖先仍属 TCB。
- 恢复须显式传 `schedulerStopped:true`，由可信生命周期所有者先停止/隔离原调度器并确认退出；这只是受信调用方声明，**不实现租约、跨进程 fencing 或人类认证**，不得与仍可 create/start 的生产者并发调用。不按历史 PID、时间或批准过期猜测已停止；无法确认时不可恢复。
- 每次调用从指定意图文件有界重读，绑定操作者提供的目标；共享 daemon 仅 info 读取，目标须 ID 不同、正确私有 socket/data-root/vfs，真实路径另验0700目录/socket归属。所有 inspect/list/kill/rm 经显式目标 socket；按随机 owner label 查询，零个视为未发现、多个拒绝。存在时核对完整64hex ID、精确name/image/owner及既有全套隔离配置；kill 前复验 daemon/容器，停止后再次确认 Running=false，才按完整 ID `rm`（不带 force）。移除后重新核验 daemon 与 owner 查询为空。错误/身份变化/停止失败/残留均拒绝，不做 prune 或按名字 kill。
- 返回仅清理观测 `{containerId,stopped,removed,executionState:unknown,resultSettled:false}`。重复恢复已消失对象返回 null ID；只证明当前相同受信 daemon 内未发现该 owner，不证明从未执行或收费。原意图不删除、不写成已完成；不更新批准、预算、评测记录或 CAS 引用。未知结果仍 `reserved/unresolved`，永久claim仍拒绝重跑，绝不因清理成功伪造 score、timed_out 或零费用。
- 复跑 `verify-image-recovery.py --probe-recovery` 加§4.4五参：同一专用 daemon 中运行四个真实子调度器，分别停在意图写后/create前、create后/start前、fresh及resume真实SDK bash阻塞中；监督者仅 SIGKILL 自己 spawn 的子进程并等待 exit。后两者先从目标 top 观察 `caff-deadline-child`，再强杀调度器，重读意图清理。三容器全部移除，运行中两例各一次kill；各批准保留一个未知预留、两保护引用，记录/CAS字节不变，重复恢复为空且重复派发拒绝。故障harness沿§5.9在计划前钉住，仅脚本模型、零真实模型；不是用户badcase复现。
- 初始实验中只 await 永久 Promise 不足以保持 Node 存活（IPC 未 ref），导致预期 SIGKILL 前子调度器自然退出，验证器失败关闭；修复为保留 IPC listener 后复跑，不将前两次失败记作通过。验证器错误只输出固定阶段码。
- **仍缺**：整个监督者/daemon/主机崩溃或掉电恢复、自动枚举与产品管理接线、恢复调度排他锁、意图/暂存目录配额与GC、cleanup回执长期归档，以及采集/封存历史锁的恢复。真实探针被强杀可能保留自身stage；本实验用独立TMPDIR纳入Python所有者最后清理，通用恢复函数不递归删除暂存路径。所有AC仍pending，不启用真实采集、付费、合并或发布。
- E49两项覆盖补齐：正常完成断言无termination，超时fake start产生非空stdout/stderr并断言清空；这些是原行为回归，非新增产品漏洞修复。

### 5.11 已封存消息选择与操作者启动入口（离线脚本模型 MVP 接线）

`sealed-workbench.cjs` 将已存在的封存消息接入 §5.6 工作台：操作者只提供 `captureRoot` 与 `selections: [{id, projectId, conversationId, messageId}]`，无需手填八键关联或重造检查点。每次构建注册表只读对应 case 文件，校验本层 root/projects/project/cases 与文件不是链接、64KiB 有界 fd/UTF8/checksum、选择范围与既有 case 精确 schema，然后复验 retention 闭包和输入 blob；任一缺失/损坏整批拒绝。不扫描授权目标/消息库、不开采集、不复制轨迹正文、不从 live checkpoint 补建、不在选择阶段 protect。preview 与每次 run 仍按原机制锁内重验/protect。目录祖先与同 OS 用户仍属 TCB，非恶意同权限竞争或来源认证。

**可操作入口**：`node scripts/badcase-capture/serve-sealed-workbench.cjs --config <绝对路径/operator.json>`。配置是操作者本地文件，不是浏览器上传或 agent tool；不进 Git。启动输出随机 loopback URL；打开后依次“选材料 → 预览 → 保存确认 → 显式启动 → 查询逐次报告/人审归档”。生产项目页仍只负责授权/预估/开启、消息标记和查询；不在生产服务里注入 Docker 启动能力。

配置精确八键（不接受其他字段）：
- `root`：独立评测记录目录；与 `captureRoot` 互不包含。两个绝对路径须由操作者确认隔离，祖先别名属 TCB。
- `captureRoot`、`selections`：已经授权采集并通过标记产生的存储与消息身份；选择器不要求原 live checkpoint 仍存在。未封存消息不能启动。
- `sources: {runtimeArchive, harnessArchive}`：§4 归档函数返回的完整引用，不是目录字符串；必须是受信本地归档。
- `roles: {baseline, candidate}`：单角色指令两个文本；`rule: {expectedHash, badcaseHash}` 为两个不同的 SHA256。
- `imageArchive`：`archiveImage` 返回的完整可信镜像归档引用（不是浮动 tag 或任意外部 tar）。
- `destination: {socket, daemonId, dataRoot}`：按 §4.11 管理的专用、初始空 daemon；socket 必须为 `/var/tmp/caff-image-recovery-*/docker.sock` 的 unix URL，独立 data-root/vfs、不同于共享 daemon。操作者负责其独立 mount/net namespace 与整个生命周期，CLI **不创建或停止 daemon**。

CLI 有界读取 256KiB 配置、拒绝文件链接/非法 UTF8/已知秘密哨兵；先核验镜像归档、消息材料与注册表，再在专用空 daemon 恢复归档，最后监听。失败只输出固定错误，不回显路径/内容。SIGINT/SIGTERM 停止监听并等在途请求完成，不是取消任务；不得先停 daemon。保留报告、归档和引用，不自动 GC。中断重启后票据丢失，仅能查旧报告；原 daemon 已非空时不能重新调用此 CLI 恢复，须由操作者准备新的专用空 daemon，旧报告目录可复用。不支持生产 DB/凭据、付费模型或隐式 fallback。

**支持范围不能混淆**：这仍是 `fixed-write-read-edit-bash-v1` 脚本模型验证，不提交捕获的原始请求。已有 SDK 诊断限制不放宽：工具桥关闭、无 skill/受控变量替换、resume 仅支持规定的线性 user 文本历史；普通 CAFF 复杂 turn 可能被 preview 拒绝，不会降级 fresh。`realModel/faithfulReplay/strictEvalEligible` 等仍 false；轨迹正文未封存。CLI 是已有材料的操作者入口，不是最终真实 badcase MVP 验收通过或付费许可。

验证：`node --test tests/runtime/badcase-sealed-workbench.test.js`（Linux 需匹配 ABI 的 SQLite；Windows 显式跳过真实 collector 用例）。`verify-image-recovery.py --browser-workbench --captured` 加 §4.4 五个镜像参数及 §5.8 浏览器参数，使用真实 collector + HTTP 授权/预估/开启、SQLite 消息/run/task、HTTP 标记/worker 封存、重复幂等/重建查询、关闭采集；随后按消息选择并删除 live checkpoint，Chromium 预览/批准/启动 → 专用 Docker 真实 SDK 工具 → 逐次评分及重建页面查询。fresh/resume 各两容器，归档及 CAS 不变、各三保护引用。该模式需将 scripts 一并复制到 §3.8 的 Linux 私有副本；不修改共享 Windows SQLite。

验证材料与 turn/模型/确认均合成：collector 在模拟现场变更前调用，不等于真实 executor/模型 turn（既有 executor 挂点证据见 §3.8）；采集和标记走真实 HTTP 但非浏览器点击，浏览器只覆盖后半工作台。轨迹只验证直接关联与计数，正文不保存。原 `--captured` 联合 Docker 验证复用选择器及相同工作台/恢复器，不从 CLI 子进程开始；实际 CLI 子进程验证见 §5.12。用户真实采集、模型预算、忠实回放与全部 AC 仍待交付/验收。

### 5.12 操作者 CLI 子进程至浏览器/Docker 的同次验证

在 §5.11 的 `verify-image-recovery.py --browser-workbench --captured` 命令追加 `--operator-cli`（仍需五个镜像参数及三个显式浏览器路径）。这只是验证器选项，不是新的生产入口。Python 管理同样的临时空 daemon/net+mount namespace；Node 验证器保存自有合成配置，再用 `process.execPath serve-sealed-workbench.cjs --config <绝对路径>` 启动**未替换模块或 transport 的真实 CLI 子进程**。子进程仅继承 PATH 与专用运行所需 HOME/TMPDIR/LANG，不继承 PI/模型凭据；就绪 JSON 有界 4KiB、必须是 loopback URL 与离线标记，失败只出固定验证错误。实验监督者仅终止自己 spawn 的子进程，等待退出；启动失败/超时不升级成功，daemon 清理由 Python 所有者负责。

两次真实 collector/HTTP/SQLite 封存使用同一自有 CAS、不同 messageId，fresh/resume 共同选择进入一个 CLI 注册表。浏览器预览/取消/确认/启动、实际容器 SDK 工具与评分沿原产品路径；先删除 live checkpoint，证明选择依赖封存材料。两次启动请求返回后，验证器从**显式目标 socket**读取有界 Docker 历史事件（daemon 仅保留有限历史，缺事件即失败），独立核对每个容器完整 64hex ID、固定 image ID、owner/name、按序 create/start/die(0)/destroy，且累计恰为 2/4 个，最终目标容器为空。无注入 transport 包装。报告 runId 来自持久报告，事件容器 ID 来自 daemon；仅声明**每次串行请求对应两容器的批次关联**，不声称逐 runId 与容器 ID 有独立双向绑定或密码学认证。CLI 路径的 `identity` 字段为 null（未截获内部恢复回执），Python 单独核对实际镜像 Config/RootFS/ID/架构并报告实际 RepoDigests，不补造回执。

完成后向 CLI 发 SIGTERM 并等 exit=0/signal=null，再由不同的父验证进程重建原工作台 HTTP 服务，变更内存注册表文本，浏览器查询旧报告/人审归档逐字一致，旧启动票据拒绝。读回 transport 明确抛错，禁止再次执行；**不是重启 CLI**（同一 daemon 已非空，不能绕过其恢复守卫）、不是新空 daemon 上的二次 CLI 启动验证，也不是完整生产服务重启/掉电。公共 CAS 的六个保护引用与源 blob 保持，不自动释放或 GC。usageBytes 为两次阶段的累计逻辑占用，不是各模式独占增量。

自动测试：`node --test tests/runtime/badcase-cli-verification.test.js tests/runtime/badcase-sealed-workbench.test.js tests/runtime/badcase-workbench-verification.test.js tests/runtime/badcase-scripted-workbench.test.js`；Windows 不支持 POSIX graceful SIGTERM，明确跳过对应监督者测试；真实 collector 的 Linux SQLite 前置沿 §3.8。注册表提前拒绝负例钉住的是 image schema（并非 role 正文；role 仍由 preview 校验）；相对 captureRoot 负例要求任何文件读取前拒绝。所有数据、确认与模型仍合成，浏览器仅覆盖后半，不扩大轨迹正文权限，不升级忠实回放/真实模型/任何 AC。

### 5.13 单 run 内逐模型请求的持久门控（内部前置件，无网络）

`model-egress.ts` 提供 `dispatchModelEgress(root, policy, drive, transport)` 与只读 `readModelEgress(root, runId)`。**没有生产/HTTP/agent/SDK 接线，没有网络客户端、凭据或真实付费许可**；§5.3–5.12 的断网脚本路径不变。本层补充 §5.2 的每 run 预留：同一个 agent turn 内的多次模型请求也必须先持久预留，再交给受信 transport。root 必须为预先建立的专用绝对目录；自有 root/model-egress/runId 层及文件拒绝静态链接，祖先路径与同 OS 用户仍属 TCB。

- policy 固定 approvalId/planHash/runId、provider/model/settingsHash、期限、请求数量（1–1000）、双向字节上限（各≤4MiB）、单请求时限（≤300s）、每请求预留及 run 总额（整数 micro-USD）。直接调用本层时这些仍是**可信调用方声明**；可选 §5.16 内部绑定器已与原 EvaluationDispatch/批准记录对账，但没有人工认证启动入口；settingsHash 不代替设置正文或模型协议校验。provider/model 为本模块内部简单标识符，不支持任意现有 provider ID。transport 收到固定模型标识与请求 bytes，但本层不解析模型协议、也不阻止 bytes 中包含其他模型字段；将来协议 adapter 必须拒绝覆盖、校验 token 上限及经人工确认的定价/最坏费用。不能凭任意声明启动真实付费。
- 独占 mkdir 永久 claim 同 root 下的 runId（不同进程也互斥），先独占写 policy，再对每请求按连续编号 wx/0600 写 reserve、fsync、读回复验，写后再检查期限，才调用 transport。同一时刻只有一个请求；重复整个 run、并发请求、已结束 sender 均拒绝。不重试、不续跑、不退款：每发起一次始终消耗整份预留，即使实际费用更低；预算不足或请求数耗尽停止。实际费用超过声明上界会如实报告并停止，**这不是供应商计费硬限保证**。
- 输入仅有界 Buffer，复制后 hash；已知秘密哨兵拒绝。transport 回执严格两键 body/costMicroUsd，属性读取异常也算坏回执；有界响应复制后只持久 hash/字节数/费用，不存请求正文、输出正文、异常正文或凭据。只有 result 的 fsync+读回复验成功后才返回响应。未知费用、超预留、坏回执、transport 抛错均停止且不释放输出；未知结果保留完整预留。秘密扫描不证明内容来源获授权，响应不在本层归档。响应大小检查发生在 transport 返回后，不限制其流式接收时的内存；真实 adapter 必须另外实施流式上限。
- 到期发 AbortSignal；单调耗时复查防事件循环延迟，超时粘性使晚到成功转为 timeout，费用未知。不强行返回：必须等 transport settle，即使其忽略 abort；driver 提早返回也 join 在途请求并记 driver_detached。**没有进程/网络强制终止或墙钟硬上界**，将来必须由受控出口及 Docker launcher 兑现。OS 时钟倒退拒绝；倒退终止记录使用最后已观测时间，不伪造当前时刻。
- 读回按 schema、编号、请求派生 ID、日期、预留额度及结果状态复验；已结束结果与未结算 reservation 区分。活跃与崩溃遗留均 unresolved，无法推断 transport 已停止。fsync/写/读回复验失败留原文件，不修复、不移除 claim；部分文件可导致只读查询显式 record_invalid，不能因此重派发。文件 fsync 不保证目录掉电事务；无存储 GC、删除、自动重结算或供应商账单认证。

验证：构建后 `node --test tests/runtime/badcase-model-egress.test.js tests/runtime/badcase-evaluation-record.test.js tests/runtime/badcase-evaluation-plan.test.js`。全部使用隔离临时目录与内存 transport，含独立 Node 进程竞争/exit23、写失败、超时/晚成功、预算边界、只读篡改拒绝；不在宿主执行 agent，不调用网络/模型，也不替代 Docker/真实模型/任何 AC 证据。文本协议适配前置件见 §5.14；受控出口、运行时凭据重签发、原始角色与完整输入回放、人审批准绑定仍未接线。

### 5.14 有界 Chat Completions 文本协议（内部前置件，无网络）

`chat-completions-protocol.ts` 是 §5.13 的可选内部适配层，**不是网络客户端、完整 pi provider、真实模型运行入口或付费许可**。无生产/HTTP/SDK/Docker 接线，不改变既有断网容器。本节 text-v1 入口只接受纯文本 system/user/assistant 消息（1–256 条）；工具调用/结果、图片、developer、推理扩展、预测、缓存计费均拒绝，绝不删字段或降级。§5.18 增加独立 opt-in tools-v1 入口，不改变 text-v1 或其旧批准。因此不能宣称已有完整 agent 工具循环或原始 badcase 忠实回放。

- `chatCompletionsSettings(spec)` 规范化固定版本 `chat-completions-text-v1`、provider/model、上下文/输出上限、temperature、双向字节上限及输入/输出定价（整数 micro-USD/百万 token），生成 settingsHash 和每请求最坏预留。声明仍由可信操作者提供，未查供应商目录或批准库；model 必须精确匹配响应，不接受浮动别名自动映射。
- 预留 = 向上取整的「整个声明上下文 × 输入价」+「输出上限 × 输出价」，各分量用 BigInt 运算，至少预留 1 micro-USD，总额≤10^12。故意保守，不用字节数猜 token，不宣称精确 tokenizer 或提交前 input-token 硬限；过长输入仍可能被供应商拒绝。若声明上下文/定价不真实，无法保证费用上界。`dispatchChatCompletions` 在创建 claim 前，将 policy 的 provider/model/settingsHash/双向字节上限/每请求预留与该 spec 精确绑定，再调用原持久协调器；批准 ID 仍是受信声明，不等于已获人工付费许可。
- `encodeChatCompletionsRequest(spec,messages)` 输出固定 model/temperature/max_completion_tokens、n=1、stream=false、store=false 的 JSON。适配 transport 在任何 exchange 前复验字节和设置，精确字段集拒绝额外 tools/seed/max_tokens/endpoint 等覆盖。请求要求 JSON.stringify 的规范字节（允许属性不同顺序，但不接受重复键、空白、替代转义）；UTF8、Unicode 文本与已知秘密哨兵复验。消息内容原样保留，拒绝不支持的类型；不证明数据来源获授权。协议坏请求在协调器中已经预留，只是 exchange 零调用，仍保守停止、不退还预留。
- 注入的受信 `exchange({body,signal})` 只返回 status 和异步字节迭代器；没有 URL/凭据参数，不读取环境。exchange 实现者必须独立固定 HTTPS 目的地、禁止重定向/重试、限制底层分配并在 abort 时释放资源；本模块不认证这些性质。可选内部 HTTPS 客户端见 §5.15，其测试接线不构成生产批准。仅 status=200；非 200 不读取错误正文。按块累计≤声明上限（≤4MiB），至多8192块，立即复制每块，不保留可变视图；溢出先 abort，再等待迭代器关闭。成功/失败均关闭 signal 作用域。此处读取的是非 SSE JSON 的传输分块，不是模型流式协议。仅限制本层持有的字节，不限制 exchange 内部或单块已分配内存；忽略 abort 或卡在 next/return 的 exchange 仍可能无限等待，不宣称墙钟硬限。
- 响应允许正常 JSON 格式；按 JSON.parse 语义复验字段，单 choice/index=0、assistant 文本、finish_reason=stop、精确 model 与完整 usage。截断、拒答、额外工具/未知字段、非零缓存/音频/推理/预测用量、未知 service_tier 均拒绝。prompt/completion/total 须整数、总数相符且不超过上下文/输出声明；零值的已知 usage details 可接受。费用由已验证 usage 和固定声明单价向上计算，**是声明费率下的 token 成本，不是已认证供应商账单**；既有 knownCostMicroUsd 只表示该算法得到了数值，不能拿来声称实际扣款已核验。不支持的用量/坏响应/交换异常经协调器记 transport_failed、费用未知，停止且不重试，不释放输出。
- 请求/响应只在内存流经受信 exchange；持久层仍仅保存 hash/字节数/费用。直接调用本层不归档 spec 正文，settingsHash 不能单独恢复定价；§5.16 可选绑定器另存完整设置/费率声明，但不是人工认证流程；无重新结算、网络/预算硬限、凭据重签发或权限提升。成功报告的 paidAuthorization/executionVerified/strictEvalEligible 仍 false。

验证：`npm run build && npm run test:badcase-budget` 包含协议负例与真实持久协调器整合；合成分块 JSON、hash-only 落盘/重读、坏用量后续零交换、设置/额度不一致在 claim 前零写入，以及 §5.13 policy 秘密哨兵/requestId 篡改两项回归。本节协议测试仅离线夹具；新增 §5.15 套件另有本地合成 TLS 接线，不是供应商兼容性实测、模型、Docker、浏览器、SQLite 或真实采集证据。后续仍须工具/完整输入协议、容器出口及人审批准绑定，才能请求真实模型预算。

### 5.15 固定目的地 HTTPS 交换器（内部客户端，无批准／容器接线）

`https-exchange.ts` 提供 `httpsExchangeEndpoint(spec)` 与 `createHttpsExchange(spec, credential)`，可作为 §5.14 的受信 exchange。**这不是付费入口、凭据签发器、网络代理服务或容器出口规则**；无生产/HTTP 路由/SDK/Docker 接线，既有断网脚本路径不变。测试只接本地合成 TLS 服务，不调用供应商或宿主 agent。调用方仍须先与人工批准库绑定 endpoint／协议设置／费率／材料／预算，再经过持久预留；§5.16 提供可选的内部记录绑定，但仍没有人工认证启动入口，不能凭此客户端开启真实模型。

- endpoint 精确六键：小写 ASCII hostname、单个规范公网 IPv4、无 query/fragment/转义/点段的 path、双向字节上限（各≤4MiB）、timeoutMs（1–300000）。规范化版本及全部字段生成 endpointHash；拒 IPv6/mapped、私网、loopback、link-local/metadata、CGNAT、文档／基准／多播等保守禁用段。192.0/16 整段保守排除，不宣称穷尽全球路由分类或验证地址归属。主机/IP 由受信操作者声明，**不是供应商来源认证、动态 DNS 发现或人审白名单**；公开生产地址仍必须由批准层排除。初次选择和任何 IP 轮换都须重新审核，不自动回退 DNS／其他地址。
- 直接 HTTPS 连接固定 IP:443，不做 DNS；SNI/Host 与证书 hostname 检查固定为声明主机。强制 rejectUnauthorized、TLS≥1.2、Node 内建 rootCertificates（不继承额外 CA）、16KiB 响应头上限；agent=false，不用全局代理／连接池，不接收自定义 URL/port/CA/proxy/headers。TLS secureConnect 后还核对 encrypted/authorized/remoteAddress，才 end(body)，不提前发送含凭据的 HTTP 字节。单在途；POST 一次，非200均销毁请求，不重定向、不自动重试、不解压。仅接受 application/json（可带 charset=utf-8）与 identity 编码。
- credential 为**同步受信回调**，每次有效交换调用一次，参数只有 endpointHash，返回精确 value/expiresAt。既不读取环境凭据，也不替操作者签发或证明凭据已轮换；回调必须提供专用临时凭据，禁止生产密钥。拒空值、控制字符、超长和过期值；原生 Promise 返回不支持并排空 rejection。凭据仅构造 Authorization，不写磁盘、日志、错误或返回值；不声称 JS 内存可可靠清零。同进程代码、Node TLS 根与 OS 网络栈仍属 TCB。
- 交换器限制自身接收累计字节及8192块，逐块复制，Content-Length 超限提前拒绝、结束核对实际长度及 complete。内核/Node/TLS 内部分配不是此上限的证明，最终 concat／协议复验会有多份有界副本。只在完整接收后向协议层交付一个内存分块，不是真正模型流式输出。响应内容与费用仍由 §5.14 复验。
- 从凭据回调前开始单调计时；时限与凭据剩余寿命取最短、钉住单调截止，同时检查绝对 expiresAt。abort/到期/错误/成功均 destroy 自有 request/response，移除监听及 timer；成功前重查截止，避免事件循环阻塞或 OS 回拨把晚结果当成功。destroy 是请求停止动作，不等待 socket close 事件，不证明供应商停止生成/停止收费；不是进程级或墙钟硬上界。同步受信回调阻塞也无法抢占，但返回超时后零请求。网络失败统一固定错误码，协议门控记未知费用并停止，不退预留。
- 直接调用本客户端不持久绑定 endpointHash／批准或归档 settings／费率正文；这些由可选 §5.16 绑定器提供。直接调用交换器不自行查账本，可信协调者有义务只在预留后调用。测试验证 §5.13→§5.14→本客户端顺序，但没有给未来生产调用方自动建立该保证。无真实模型权限或资格提升。

验证：`npm run build && npm run test:badcase-budget`。HTTPS 套件在自有临时目录用 OpenSSL 生成仅测试证书／私钥，127.0.0.1:随机端口启动合成服务；没有 OpenSSL 则明确 skip 实网用例，不能将其记作通过。**测试专用 https.request 包装改到 loopback、注入合成 CA 并替代 remoteAddress 观测**；原始目的地／TLS／代理选项由独立替身断言钉住。真实 TLS 检查成功、错 hostname、未信任证书、重定向拒绝、慢响应停止、超大响应头，以及预留先于凭据回调、文本协议、hash-only 落盘重读；这不证明真实公网路由、供应商兼容性、容器隔离或计费。测试结束关闭自有服务并删临时证书，无秘密提交。E58 输出超限但总和一致负例与有限8194块洪泛夹具同时纳入；移除块数守卫会快速断言失败，不再靠无限循环挂起检出。全部 AC 仍 pending。

### 5.16 出口／设置／费率正文绑定批准与双层预留（内部协调器）

`model-binding.ts` 将 §5.2 持久批准/逐 run 预留与 §5.13–5.15 逐请求账本/协议/HTTPS 连接起来。**不是人工认证、付费许可、生产路由、SDK provider 或 Docker launcher**。本协调器不直接提供 HTTP/CLI/UI/agent 接口；§5.17 另提供隔离的仅审阅声明入口，不接派发。原离线管理面仍严格只接受 scripted 模型。所有调用方、executor/scorer、凭据回调仍受信；测试只用合成批准与本地合成服务，未开启真实采集或真实模型。

- `modelBinding({settings,endpoint,maxRequests})` 固定协议/客户端版本、完整九键设置（含定价）、六键出口、每 run 请求上限，生成 `bindingHash`。双向字节上限必须相同；maxRequests 1–1000。新计划的 `model.settingsHash` **必须等于复合 bindingHash**，不是协议单独的 settingsHash；逐请求 policy.settingsHash 仍使用协议摘要，两个语义显式区分。provider/model 精确对账、每请求预留≤run 预算、请求 timeout≤run timeout。所有字段及完整 planHash 经原批准绑定，因此换 IP/目的地/费率/请求数必须另审新计划；不自动改写旧记录或旧 hash。
- `recordBoundModelApproval(root,spec,config,approval)` 只接受已建立的专用绝对 root。校验 plan/批准声明/秘密哨兵后，先将完整 binding 与 approval 写 `model-bindings/<sha256(approvalId)>.json`（wx/0600、fsync、读回复验），再调用原 recordEvaluationApproval。没有数据库事务：前一步成功后后一步失败可能遗留孤立 binding；read 不认可孤立项、不自动补批准。显式精确重试只接受相同正文，不覆盖部分/冲突数据。fsync 未确认的首次调用不写批准；后续明确重试可复用完整相同文件，但不能据此证明先前 fsync 已确认。文件 fsync 非目录掉电保证，无自动修复/GC/配额。
- `readBoundModelApproval` 有界 16KiB、UTF8/schema/摘要/完整批准对账；自有 root/model-bindings/evaluations/批准目录及归档文件拒静态链接，lstat→open 身份复验。可重读已过期/已消费历史声明；不能从其生成新的执行权限。祖先路径/同 OS 用户为 TCB，不防同权限进程全面重写存储。完整正文是受信声明，不认证供应商费率、IP 归属或公开地址非生产；秘密哨兵不代替输入授权审查。
- `dispatchBoundModelEvaluation(root,approvalId,execute,credential)` 只从磁盘读配置，不接受新的 endpoint/settings 覆盖。检查期限后由原 dispatchRecordedEvaluation 独占一次性 claim，逐 run 预留后才进入私有 adapter；不暴露接受任意旧 unresolved run 的入口。adapter 将完整 EvaluationDispatch 字段、复合 binding、批准及**当前最后一条 reserved run、unfinished 状态**重新对账；每次请求已持久预留后，取凭据前及同步凭据回调返回后再次读回复验。scope 仅 endpointHash，凭据期限截到批准/run 截止。缺失/篡改/过期/提前结束均不拨号；回调阻塞不可抢占，返回后重新检查。根目录和 trusted executor 不得交给被测代码。
- 逐请求期限取批准期限与本 run 起始+timeout 的最小值，同时在 guard 检查单调累计耗时；请求仍由原时限/HTTPS 计时器负责 abort。driver 在无请求时挂起不能被此模块强制终止，仍等待其返回，**不是整个 agent 进程或墙钟硬上界**。executor 必须由后续 Docker supervisor 提供停止与隔离，不能用此接口在宿主运行真实 agent。
- 本段只接受至少一次模型请求、请求账本完整 finished/completed、零未知费用，且 executor 回执的 cost 精确等于请求账本 knownCost。原外层 ledger 继续核验 runId/status/outputHash/score schema。零请求、协议失败被 driver 捕获、费用少报/多报、坏评分等保持外层 reserved/unresolved 并停止候选，不自动造失败分数或结算未知费用。成功输出/评分依然是受信 executor 声明，不证明原始 inputHash 被忠实使用、工具循环、评分有效或 Docker 执行；所有资格 false。
- 永久 outer claim 与 egress claim 防跨进程/重启重派发。子进程在 run 预留和 egress policy 落盘后 exit23 的合成验证保持 unresolved，重启只读不恢复执行。不同 root 的存储隔离不是全局一次性保证；调度方必须固定专用 root。run 结束/失败不释放任何材料引用，本段不操作 CAS。

验证：`npm run build && npm run test:badcase-budget` 新增绑定套件覆盖先归档后批准、精确重试/冲突、摘要/费用/时限绑定、16KiB/UTF8/链接/换 inode 拒绝、写/fsync 故障、双层预留顺序、逐请求复验、回调中篡改/过期、费用对账、并发 claim、exit23、重读。真实本地 TLS 合成服务验证批准→run→请求→TLS→结果及历史正文重读；测试专用 loopback/CA/peer 包装与 §5.15 相同限制，非供应商/公网/容器证据。E59 endpoint 秘密哨兵、data 及时但 end 晚到的两条负例同步收编。§5.17 补充本机完整配置确认声明入口；仍缺付费启动许可、专用凭据签发、容器出口、原始输入/工具协议与真实 badcase/模型预算证据；全部 AC pending。

### 5.17 独立本机模型配置审核页面（仅保存，不运行）

`model-review.ts` 与 `scripts/badcase-capture/model-review-server.cjs` 提供独立 loopback 操作者页面。**不是付费启动入口**：没有 executor、凭据源、dispatch/start 路由或 agent 工具；不载入生产页面或服务，不改变旧 scripted-only 管理面的能力。沿用户选择的同 OS 用户信任边界，复用 local-admin 的 remoteAddress/Host/Origin/JSON/CSRF 校验；这不是抵御本机 shell 模拟点击的认证，也不证明操作者真实读完配置。所有 launchAvailable/paidAuthorization/materialVerified/executionVerified/strictEvalEligible 恒 false。

- 受信操作者注册 `[{projectId,id,spec,config}]`，至多64项；`spec` 为 §5.1 完整 EvaluationSpec，`config={settings,endpoint,maxRequests}` 为 §5.16 正文。必须预先以 `modelBinding(config).bindingHash` 填 `spec.model.settingsHash`，不自动重写计划。注册时验证完整设置/绑定、provider/model、预算/时限与秘密哨兵，复制成不可变内存快照；重复ID或失配在监听/写盘前拒绝。浏览器只提交条目ID，不接受配置、存储路径或凭据。不是从真实 case 材料生成计划，摘要均为声明；不验证角色正文、评分规则、实际归档、供应商费率或 IP 非生产属性。
- 页面完整展示计划（含两角色各 repetitions、逐次与总预算/时限、材料/角色/评分器摘要）及绑定（模型参数、上下文/输出/双向字节限额、费率、目的地、每 run 请求数、逐请求预留）。金额为整数 micro-USD，1 USD=1000000 micro-USD；总预算不足全部计划 run 时原 ledger 仍会停止，审核页不替操作者提高预算。窗口 confirm 再核对项目/批准ID/双摘要；取消零批准POST。所有动态正文用 textContent，页面 CSP 禁外部加载/嵌入；不提供普通“保存配置即可启动”的路径。
- preview 只读注册表、零文件创建，生成随机UUID票据，最多64张/5分钟。确认仅接 confirmed=true、approvalId、planHash、bindingHash；项目/双摘要/期限/进程观察时钟回拨失配拒绝。新配置须另行注册/预览/确认。请求体按实际字节≤2048、UTF8往返/JSON校验；CLI注册文件≤256KiB、lstat/open/fstat身份/UTF8校验，拒文件链接；同用户/祖先路径仍TCB。
- 本轮全量回归在 Windows 发现父版本锁 owner 的 inode Number 舍入碰撞，真实临时文件探针确认不同64位 inode 被舍入成同值。新回归用 `9007199254740992n/9007199254740993n` 确定性模拟，先红后修：锁恢复 owner、批准记录、模型绑定、逐请求账本与本页注册文件均改用 bigint lstat/fstat 身份比较；只有通过上限检查的 size 转 Number 用于缓冲区，不改变持久 schema。修复不是原子快照或同用户恶意竞争防护。**未全面修复**其他旧路径的 Number 身份戳：`orphan-gc.ts` 及 `scripts/badcase-capture/{probe-recovery,harness-archive,runtime-archive,image-archive,serve-sealed-workbench,sealed-workbench,review-archive}.cjs` 仍保留同类数值比较，存在高 inode 精度风险（尚未对各路径逐一构造行为复现）；不得据本段宣称跨平台身份校验已全覆盖。
- 持久范围是 `root/<sha256(projectId)>`，自有 root/项目层拒链接。先原 binding 正文落盘，后原批准记录；沿 §5.16 wx/0600/fsync/复验、精确重试不覆盖、部分失败不修复、非掉电事务。没有另存“已读证明”、页面/配置条目ID或操作人身份，也不把记录当付款授权。重启丢票不丢记录；GET允许显式项目ID查询旧批准，不依赖当前注册表或其存在，不创建目录、不恢复票据/消费权限。历史正文/报告始终来自磁盘，不由新注册表重建。存储独立于capture配额，暂无列表/删除/GC。
- 人工入口（先 build）：`node scripts/badcase-capture/model-review-server.cjs --root <专用绝对存储目录> --registry <操作者JSON文件绝对路径>`。JSON仅包含上述注册数组，不包含凭据；不要使用生产存储或把 root 交给被测容器。stdout仅打印随机 loopback URL 与不可启动标记，终端 Ctrl-C 停止自有服务，不清除已保存记录。程序式 `startModelReviewServer({root,entries})` 返回 url/close，测试使用随机端口/隔离临时目录；未经批准不得将本脚本指向真实材料/开启采集。注册文件/源配置是操作者责任，暂不提供材料选择器与模板生成器。

验证：`npm run test:badcase-budget` 包含服务/真实HTTP/DOM负例；`node scripts/badcase-capture/verify-model-review-ui.cjs` 使用本地已有Playwright Chromium，真实页面预览→取消零POST→确认→关闭并重建服务/清空注册表→历史完整正文查询，临时profile/服务/目录均清理。E60两项负例补“最后请求完成后篡改绑定”和“未await send即返回匹配费用”，守卫未改。新段无 Docker/SDK/真实采集/模型调用；旧本地合成TLS回归不算容器或供应商证据。仍缺材料真实性人审、付费启动、凭据重签发、容器出口/工具循环与用户批准的真实badcase评测；全部 AC pending。

### 5.18 显式工具协议与审核绑定（无 SDK／容器执行）

§5.14 的同一模块增加 `toolChatCompletionsSettings({settings,tools})`、`encodeToolChatCompletionsRequest`、`createToolChatCompletionsTransport`、`dispatchToolChatCompletions`。**只扩展 wire 协议，不执行工具、不是 SDK provider 或容器出口服务**；旧 text-v1 函数仍拒绝 tools/tool_calls/tool 消息。未来真实工具执行必须留在已批准的 Docker 内，不能把本节合成工具结果当作实际执行。

- tools-v1 配置显式包含原九键 settings 与1–16个 function 定义。定义精确 type/function，function 精确 name/description/parameters；name≤64字符且唯一，parameters 是 type=object 的 JSON 对象。定义规范化排序对象键，数组保留顺序；整个定义树≤2048节点、深度≤16、UTF8 JSON≤8192字节，拒秘密哨兵、`$ref/$dynamicRef` 及原型危险键。参数 schema 是**有界不透明声明**，不在宿主运行解释器或解引用；不保证供应商支持任意 schema 关键词，也不验证调用参数符合 schema。固定容器工具验证器仍必须做参数校验，执行权限/工具路径安全由容器和 harness 保证。
- `chat-completions-tools-v1` 版本、完整 settings/费率和规范化定义共同生成协议 settingsHash，必然不同于 text-v1。`modelBinding` 显式允许 `{settings,endpoint,maxRequests,tools}`，产生 kind=`evaluation-tool-model-binding-v1`，完整工具定义也进入复合 bindingHash；**旧三键配置及其规范字节/hash 不变**。旧计划加 tools、改变工具正文但不换计划/批准均失败。§5.17 注册表/预览展示/确认保存/历史读取沿用原流程，显示全部定义；确认仍不授予付费权限。16KiB 归档上限不变，定义过大或归档超限拒绝，不截断。
- 工具请求固定已审 tools、tool_choice=auto、parallel_tool_calls=false，加上原固定 model/temperature/输出上限/n=1/stream=false/store=false。不接受请求覆盖任何定义或设置；请求规范字节、UTF8/秘密哨兵、双向字节限制沿 §5.14。历史总条数1–256；串行 assistant 调用必须恰好一个合法 function call，随后紧邻一个同 ID 的 tool 文本结果；拒孤立/重复/错序/缺结果、重复 call ID、未知工具、并行调用及图片等不支持内容。调用参数保留原始 JSON 字符串（包括正常格式空白），要求≤64KiB JSON 对象且满足树深/节点/危险键限制；不做 schema 语义或重复 JSON 键认证。
- 响应只允许原 stop 文本或 tool_calls 的单一已审 function；可空 content 仅用于工具调用。响应 call ID 不得与本次请求历史重复；arguments 同上限；拒 length/拒答/未知工具/多个调用/额外字段。共享 §5.14 的有界分块/复制/abort、model/usage/费用复验后才释放**原始响应字节**。费用来自完整已验证 usage，包含模型为工具调用生成的 token，仍是声明费率成本、不是供应商账单。预留仍以整个声明上下文和输出上限计算，不按工具字符串猜 token。
- 绑定器只从持久正文选择 text 或 tools 派发器，继承 outer claim→run预留→请求预留→取凭据前后复验→HTTPS→双账本对账。坏工具响应/坏用量停止、不重试、不退预留，不能结算完成评分；旧文本批准不能借工具请求扩权。协议仅核验**本次提交的完整历史内部关联**，不证明它是上次响应/实际工具执行的忠实延续；可信 supervisor 仍须绑定真实 SDK 轨迹、原始输入、固定工具定义与 harnessHash。无容器通道、凭据签发、生产/付费启动接线；所有资格仍 false。

验证：`npm run build && npm run test:badcase-budget` 包含两轮合成 call/result、真实请求账本及批准库整合（baseline/candidate 各两请求，费用160 micro-USD为合成声明）、定义/hash/串行关联/用量/字节/未知费用停止负例。工具结果由测试构造，HTTPS 在新工具整合中为替身；旧文本回归保留真实本地 TLS 用例。`node scripts/badcase-capture/verify-model-review-ui.cjs --tools` 验证真实 Chromium 完整工具预览、取消零批准POST、确认保存、关闭重建且空注册表历史逐字相同；不执行模型或工具。不带参数仍验证原文本审核。E61 HTTP UTF8 负例改成 `[0x22,0xff,0x22]`，独立于 JSON 语法拒绝。无 Docker/SDK/SQLite/真实采集/模型证据，不能据此宣称完整工具循环、忠实回放或任何 AC 通过。

### 5.19 最窄模型回放入口：封存消息→人审→断网 Docker 工具循环→报告

本节是 §5.13–5.18 前置件的集中接线，不另造预算／采集存储。`model-evaluation-operator.cjs` 提供独立操作者 CLI；**没有生产页面启动入口、后台付费或 agent 授权工具**。原 `model-review-server` 保持仅保存声明；新 CLI 必须另行显式 `--run <approvalId> --confirm-paid`，不能凭页面保存自动开跑。代码具备实际 HTTPS 出口能力，但截至本段作者验证只运行合成模型服务；尚无用户真实案例／供应商兼容性／实际费用证据，不能宣称 MVP 或任何 AC 验收完成。

- `prepareOperator` 从已封存的 project/conversation/message 选择材料，经原完整性预检生成实际计划，而非操作者手填输入摘要。`prepareModelEvaluation` 固定镜像、runtime/harness 归档、原始 invocation 和有限 fresh/resume 历史、两角色正文、工具定义、模型／费率／出口／请求数、重复次数和预算。每 run 在原锁内重新验证并保护原 CAS 闭包；不读 live 源、不自动 fresh。harnessHash 还包括容器文件及本次 host preparer/relay/probe/recovery 代码摘要；评分器摘要包括 host scorer 代码及规则。执行前重新检查 host 文件摘要，变动须重建计划／批准。
- 被测进程与 read/write/edit/bash 全在现有专用 Docker 内，继续 network=none、无宿主 bind/socket、只读根、65534、cap-drop ALL、no-new-privileges、512MiB/1CPU/64pids。不开放容器网络。`container-model-relay.cjs` 只通过**固定容器 ID 上的固定 Docker exec 程序**搬运 `/work/model-relay` 有界请求／响应；容器不能选择宿主路径、命令、出口、CA、header 或凭据。宿主只调用原 send 闭包，经过原 run/request 预留、协议验证、批准复验、HTTPS 后返回模型字节；不执行被测代码或 SDK。poll/exec 有性能开销，是 MVP 取舍，不宣称低延迟。
- 邮箱序号从1连续、单在途、同号同正文重复不重发；跳号／篡改／超限失败停止。读程序仅在容器内运行，普通文件/O_NOFOLLOW/bigint fd 身份和有界读取，写响应临时文件后 rename。请求／响应正文不落宿主持久账本；容器 tmpfs 随容器清理。relay 发生错误按已验证且不可变 ID 停止进程，等 attach 和在途 send 结束后才交回外层清理；原 supervisor 的逐 run deadline/身份复验/清理仍在。网络 abort 不证明供应商停止收费，等待在途请求结束不是严格返回墙钟上界；父／daemon／主机崩溃保证不因此增加。
- `container-model-adapter.cjs` 对实际 SDK tools 定义与批准定义逐字结构对账；SDK 当前上下文转为 tools-v1 文本／串行调用，不丢弃图片、thinking、自定义消息等未知内容，而是拒绝。模型响应驱动真实 SDK 工具循环，容器不再内置固定工具步骤。仍限无扩展／无 skill、thinking off、无 compaction/retry、Linux、支持的有限历史；不是任意原始 harness 的忠实回放。供应商必须支持精确 tools-v1 和 usage 形状，否则显式失败不降级。
- 为收窄 MVP，整个 run 1–25000ms（含恢复及 SDK 启动），只评分固定文件 `evaluation-result.txt`（普通文件、≤4096字节）。host 固定 SHA256 评分器将输出与人审 expectedHash/badcaseHash 比较；规则、参考摘要与前次产物不进入容器。容器报告的调用次数须与真实请求账本一致，费用从账本读取而非信任容器。失败／超时／缺输出／坏回执保持 reserved/unresolved、无评分和未知费用，不伪造失败分数；后续候选停止。报告仍保留 executionVerified/strictEvalEligible=false，成功不自动提升用例复现资格。

操作者流程（需要先 `npm run build`，Linux 专用环境；以下是接口说明，不是当前真实采集或付费授权）：

1. 准备一个不入 Git 的绝对路径 JSON 配置，精确顶层键为 `root,captureRoot,selection,image,imageArchive,sources,roles,rule,model,limits,target,productionResourcesExcluded`。root 为独立评测账本目录；captureRoot 为获授权封存存储；selection 为 `{id,projectId,conversationId,messageId}`；image/imageArchive/sources/target 沿 §4.4–4.11 的固定镜像、可信归档、专用**空** daemon 声明；roles 为 `{baseline,candidate}`；rule 为 `{expectedHash,badcaseHash}`；model 为 §5.18 `{settings,endpoint,maxRequests,tools}`；limits 为 `{repetitions,timeoutMs,perRunLimitMicroUsd,totalLimitMicroUsd}`。`productionResourcesExcluded:true` 是操作者对专用路径、非生产目的地／资源的声明，不是软件认证。角色全文与规则须在该操作者配置中人审；审核页面展示其摘要及完整模型配置，不额外声称正文已读证明。实际工具定义可在归档 SDK 的隔离容器中导出，验证器给出该流程；运行时必须再次精确匹配。
2. `node scripts/badcase-capture/model-evaluation-operator.cjs --config <绝对JSON> --review` 从真实材料生成注册表并打开原仅审核 loopback 页面。预览／确认绑定完整计划与配置，5分钟内有效；取消不启动。关闭页面服务不会删除批准。规划会保留现有材料引用，不做引用释放。
3. **只有用户批准具体案例、评分规则、模型、次数、时限及预算后**，操作者为该进程单独注入 `CAFF_EVALUATION_MODEL_KEY`（不可贴入 Room、配置文件、命令参数或日志），再显式执行 `node scripts/badcase-capture/model-evaluation-operator.cjs --config <绝对JSON> --run <approvalId> --confirm-paid`。默认不读取通用 OPENAI/ANTHROPIC 环境变量、生产 auth.json 或 CAFF provider store；用户明确授权的非生产模型 Key 复用例外见 §5.20。专用变量在入口取入内存后从环境删除，不传 Docker；每请求给受控回调短期限 lease，再由原协调器截到批准/run截止。**这是进程内使用租期，不是供应商凭据签发或轮换实现**；专用临时密钥的发行、权限／真实失效由操作者负责。没有这些材料则不得真实启动。
4. 执行先重建材料计划和 binding，与持久批准双对账；确认未消费后，先 wx/0600/fsync/读回写独立 `launch-<approvalIdHash>.json`（仅 ID／摘要／时间），再恢复专用空 daemon 的可信镜像，恢复后重验批准期限，进入原永久 claim。没有隐式重试、恢复部分 run 或回退宿主。启动声明写入后即使 load 失败也不自动删除该声明；需查明原因并重新人审取得新批准。它不提供掉电事务或抵御同 OS 用户模拟确认。
5. `node scripts/badcase-capture/model-evaluation-operator.cjs --config <绝对JSON> --report <approvalId>` 只读重建历史报告，不读取当前材料／归档／daemon、不恢复启动权限。配置中 root/project 必须保持一致。所有原始包、批准、日志和临时凭据不入 Git；无自动合并发布。

作者验证入口：`python3 scripts/badcase-capture/verify-image-recovery.py --model-relay --captured <§4.4 五镜像参数>`。在显式授权的自有 Linux 环境，真实 collector+SQLite+HTTP 标记／重启查询→封存选择→模型审核 HTTP 预览/批准→同一个操作者 run 函数→专用 Docker SDK 工具→独立 host 评分／报告重读。两种模式各 baseline/candidate，从归一化相同起点发出16次合成模型请求；另加坏响应／模型超时各一次，拒绝评分且容器清理。模型是仅 loopback 的合成 TLS 服务，沿 §5.15 测试专用 CA/路由/peer 替换；不连接供应商，费用是合成声明。不是浏览器点击→真实 CLI 子进程的同次证据（本段实际调用 CLI 导出的同一操作者函数），也不是用户真实 badcase。普通 `test:badcase-budget` 只跑静态/替身测试，不自动启动 Docker 或供应商。

### 5.20 显式非生产模型认证复用（宿主侧，非自动发现）

用户本 Room 2026-10-16 授权先尝试复用 CAFF 的 GLM 模型认证、由 GPT 选择简单问题。当前 GLM 公开运行标识为 `Huawei-Huoshan / zhipu/glm-5.3`。这不授权生产凭据、内部身份令牌、认证文件进入容器或模型读取其他 provider。既有 Goal/Docker/秘密排除门控不变。

在 §5.19 已审核配置的付费启动命令后**同时**追加 `--reuse-models <明确授权的非生产models.json绝对路径> --confirm-nonproduction`。原 `--confirm-paid`、持久批准、双摘要对账、一次性 launch 与双层预算仍不可省略。默认 Key 模式不变；review/report 不读取此来源；不从环境发现 CAFF provider store，不读取 auth.json、生产数据库或其他 agent 的私有存储。复用模式也删除继承的专用 Key 环境项，避免传给子进程。

`authorized-model-auth.cjs` 仅构造受信同步回调；首次**预算预留后的凭据请求**才只读所指定文件，逐次重读。最多1MiB、精确 bigint fd/路径身份与大小/时间前后复验、普通单链接文件、拒 symlink/无效UTF-8；目录祖先和同 OS 用户仍为 TCB，不声称抵御同权限对手。只选择批准的 provider 与唯一精确 model，要求 openai-completions、无自定义 header、HTTPS hostname 和完整 chat/completions 路径等于批准目的地，拒 URL 用户信息/query/hash/非默认端口。首版仅支持 literal API Key；拒命令、环境展开、OAuth/内部登录令牌和隐式回退。首次成功读取的源文件字节摘要仅在内存钉住，后续任何改动失败关闭；不修改原文件，不执行源文件中的配置命令。

launch 声明只增加 `credentialSource`：类型、provider/model、endpointHash、sourcePathHash 和用途确认，不保存 Key、Key hash、源文件内容/hash 或明文来源路径。该声明必须与持久批准的 provider/model/endpoint 精确相等，且先于 daemon 恢复落盘。认证回调仅在宿主受信 HTTPS 出口使用，容器仍只获 settings/tools/maxRequests；来源代码及操作者入口加入 harness 的 hostCode 摘要，变更须重建计划。lease 仍只是进程内使用期限，不是供应商重新签发或真实吊销。

`--confirm-nonproduction` 是操作者对用途/来源的责任声明，**不是软件认证凭据非生产**，也不能把已知生产 Key 改名合法化；用途不明或已知为生产的来源不得实际启动。能成功读到 Key 不证明供应商认可该用途、路由可用或存在付费许可。人工授权可委托选择小题与保守运行参数，但不能冒称人已逐字审核尚未展示的规则。

兼容修复：protocol 与 request ledger 的模型名保留旧语法，额外接受一个 `vendor/model`（总长≤128）；provider/approval/call ID 语法不变。不接受 URL、空段、路径遍历、多级斜杠；wire model 与供应商响应仍须逐字匹配，绝不删掉 `zhipu/` 或改用别的模型。旧无斜杠配置的规范字节/hash不变。

首轮选择为新建 CSV 编号前导零受控样本，不读取用户真实项目；baseline/candidate各一次、25秒/run、作者自限总预留1美元。这是首次真实出口验证的计划，不是完成证据；本节交付与离线读取成功均不等于已运行真实模型、不代表历史 badcase 复现或任何AC通过。网关配置未声明费率，不把任意假设价冒充供应商账单。

### 5.21 失败阶段诊断（无正文，不改变放行条件）

首轮真实 GLM 尝试（Goal E65）只留下 HTTP 200 和 `transport_failed` 汇总；原始响应及临时账本未保留，无法事后确认认证语义、响应格式或哪条校验失败。**HTTP 200 不证明模型任务成功；不得为旧运行补造具体根因。** 本增量只补离线可验证的诊断缺口，不自动重试供应商，也不放宽 tools-v1、模型精确匹配、usage、预算或容器校验。

- 内部异常用 WeakMap 绑定闭集标签，不读抛出值的 message、code、stack、任意属性/getter。HTTPS 边界只输出 credential/connect/peer/status/headers/body/cancelled 阶段；协议边界只输出 request/exchange/collect/decode/response 及 response_envelope/choice/usage 子阶段。落盘值带 `https_` 或 `protocol_` 前缀。标签不包含实际状态码、header、主机、模型返回值、源路径、凭据或正文；不会保留异常 cause。`https_cancelled` 包含 abort/期限失效，不断言供应商取消计费。
- 仅已完成请求账本的 `status=transport_failed` 结果可追加可选 `failureStage`，读侧精确校验闭集。旧 schema-v1 无该字段仍按原字节读取；success/reserved/timeout 等不加字段。外层 timeout 优先且粘性，不把晚到阶段误报为最终原因。不识别的第三方异常不加标签，而非保存其文本。
- 操作者可离线调用已存在的 `readModelEgress(scope, runId)` 查询 `requests[].failureStage`：scope 是 `<评测root>/<sha256(projectId)>`，runId 来自原 `--report` 的 ledger。查询无网络、凭据、daemon 或当前材料依赖；尚未派发或账本缺失不补造诊断。该字段目前不投影到审核页面或外层 CLI 报告，须读取请求账本；不宣称 UI 已展示。
- 阶段只是**校验边界**，不是供应商根因或 prompt 归因。例如 `protocol_response_envelope` 可能是模型名/字段/形状不匹配，`protocol_response_usage` 可能是用量形状、总和或范围错误；不记录实际字段值。任何失败仍保留费用未知及预留、不退款/重试、不评分、不启动候选；标签不能提升任何 AC 或完整回放资格。后续真实运行按新审核 SHA 重新生成计划和批准；现有 hostCode 只摘要列举的操作者脚本，不包含本次三个编译模块，不能声称本次变动会自动改变 harnessHash。旧已消费批准仍不可重用。

E68 的第二批真实尝试仅定位到 `protocol_response_envelope`，不能由此推断具体字段。为避免再次只得到同一粗粒度标签，新响应包络失败现按原判定顺序细分为 `protocol_response_envelope_` 加下列**八个固定后缀**：`keys`（非对象、缺必需键或存在未知键）、`id`、`object`、`created`、`model`、`fingerprint`（system_fingerprint）、`service_tier`、`choices`（非单 choice 数组）。只记第一个失败检查，不输出原始键名/值、字段数量、响应内容或例外文本；keys 失败不继续解释缺哪个键或多哪个键。所有谓词和先后顺序与旧 compound guard 相同；特别是未知字段、精确模型名、服务等级与单 choice 限制没有放宽。旧 `protocol_response_envelope` 账本保持可读，不迁移或补造新标签。新闭集不接受带任意后缀的伪造标签；工具与文本协议共享此检查。它仍不是供应商根因证明，不凭标签自动删字段、改模型或重试；E65/E68 的具体不兼容项仍未知。

验证：合成服务覆盖 HTTPS 各阶段经过真实协议及持久请求账本的传递；协议覆盖收集、UTF-8/JSON、envelope/choice/usage 与文本/工具两模式；包络八个检查覆盖逐项坏响应→请求账本落盘/重读、停止第二请求、保留预留与未知费用、无响应hash/字节数及内容，未知后缀拒绝、旧包络标签兼容；keys 与 model 同时错误只标 keys。负例还覆盖恶意异常 getter/proxy、伪造属性、未知落盘标签、成功结果夹带标签及超时后标签抑制。真实供应商故障根因仍未知，未以合成响应冒充 E65/E68 原始响应；本细分实现不读取 Key、不调用供应商、不新增 Docker/UI 证据，也不修复已证实的供应商兼容性问题。

Linux 真实调用前预检两次暴露 HTTPS 定时器过早唤醒：Node 对小数延时取整时，回调可能早于单调截止，旧实现立即销毁请求并误记 `https_body`。截止回调现先复验期限，尚未到期则仅重新挂计时器（不重新发送请求）；实际到期或外部 abort 仍销毁请求，完成后的迟到回调无动作。受控早唤醒测试分别验证随后 abort/期限失效、计时器清理和零重发。此处是新发现的本地时序故障，不解释 E65 的 HTTP 200 失败；修复本身没有读取密钥或调用供应商。

### 5.22 OpenCode Go 显式客户端身份／会话配置

用户 2026-10-16 改选 `opencode-go/deepseek-v4.1-flash`，确认非生产认证复用与费率未知风险，并进一步声明该模型预算无金额上限。此授权不等于后台无限循环：作者先采用最多6次供应商请求、每次25秒的有界诊断批次，保留逐次批准、预算预留及审计，不自动重放已消费批准。E70 的单次真实请求返回 HTTP400/`https_status`，没有保留错误正文，**具体拒绝原因仍未知**；下述兼容支持不能倒推该次失败根因。

2026-10-16 只读核对 [OpenCode Go 官方文档](https://opencode.ai/docs/go/)：第三方编码 agent 应使用自身 User-Agent，并为每会话发送稳定的 `x-opencode-session`。原评测 HTTPS 出口两者均未发送。官方列出的当前 DeepSeek V4.1 Flash 路径为 `/inference/go/openai/v1/chat/completions`，本地授权来源仍声明 `/zen/go/v1/chat/completions`；这是另一项已观察差异，**不自动迁移来源或批准目的地、不声称旧路径已失效**。不冒充 OpenCode 或其他已验证客户端。

- 操作者可以在原六键 endpoint 上显式加入 `clientProfile:"opencode-go-v1"`。仅允许精确 `opencode.ai` 和上述两条路径，绑定配置的 provider 必须精确为 `opencode-go`；未知 profile、其他 host/path、自定义 headers 均拒绝。完整 profile 进入 endpointHash 及复合 bindingHash，必须重新审核计划；未配置 profile 的旧规范字节、hash 和请求头保持不变，不做隐式 opt-in。
- 仅该 profile 的 HTTPS 出口增加固定且真实的 `User-Agent:caff-badcase-evaluator/1.0` 与 `x-opencode-session:<runId>`。绑定器从已批准 run 提供64位小写十六进制 runId；每 run 所有请求稳定一致，baseline/candidate 使用各自独立 runId。不是 live Room/session ID，不含用户数据或凭据，不加入 prompt；它是受控协议元数据差异，不是第二个角色变量。工厂单次复制并校验 sessionId；缺失/非法/多余上下文在取凭据、联网前拒绝，未配置 profile 时也拒绝传入上下文。没有任意客户端名称、header 或会话值注入入口。
- 原认证来源的完整 HTTPS 路径、provider/model、预算后读取、来源字节钉住规则不变。profile 作用域与 legacy 不同，旧 endpointHash 不能取到新 profile 的凭据；仅改变请求目标为新路径但不改变来源声明仍失败关闭。TLS/地址/Host、截止/abort、禁止重定向和重试、正文/usage/模型精确验证、未知费用/预留保留、不评分语义均不变。

验证包括：原实现新增四例先红（未知 profile）后绿；profile/host/path/上下文负例、单次 session 属性复制和固定异常、连续请求会话稳定/跨 run 独立、持久批准与双账本贯穿、profile 删除篡改拒绝、原认证来源路径及新旧作用域隔离；既有 legacy hash 钉住测试保留。作者 Windows 五套117例＝116通过/1跳过，Linux Node22.22六套139/139；Linux私有副本8个单点变异（host/path、真实客户端名、会话快照、provider、批准runId、profile快照、session格式）全红，逐字节恢复后139/139并清理副本。`test:fast` 1883通过/41跳过、`test:smoke` 101/101、build/check及双typecheck通过。不包含新增真实供应商/Docker/UI运行，不声称已解决E70/完成对照；后续真实运行仍须固定SHA独立审查和新计划/批准。hostCode 未摘要编译模块的既有缺口保留，不能宣称本段修改自动改变 harnessHash；本 profile 自身确实改变 endpointHash/bindingHash。全部AC仍pending。

### 5.23 choice 失败细分（不改变响应接受集合）

E72 在 `cc6c39c8` 固定 SHA 审查通过、恢复提案获批后执行：98 个文件私有 Linux 副本逐字节预检，六套139/139；新计划/批准、原授权旧端点、显式客户端 profile、断网 Docker 内真实 SDK 基线仅发1请求，收到 HTTP200 后 `protocol_response_choice`，仍 `transport_failed/unresolved`、无评分、候选未启动。材料/双账本长期保留，2容器与专用daemon清理、源镜像不变。新增$0.25、累计$1.25未结算预留（不是实际账单）。HTTP200 不能证明哪个头消除了E70的400，也不能确认choice内具体失败项。本批最多6请求的授权尚不等于全部执行；诊断代码变更后仍先固定SHA独立审查，不自动重试旧批准。

将原 choice 复合守卫按原短路顺序拆为固定失败分类：`keys`、`index`、`finish`、`logprobs`、`message_keys`、`role`、`content`、`refusal`、`annotations`，每项标签前缀均为 `protocol_response_choice_`。只抛首项、不保存原始键名/值/响应正文。在两个原有拒绝点进一步区分已知形状，**均仍拒绝，不是兼容放行**：

- finish_reason 精确为已知 `length` 时使用 `truncated` 固定标签，其他不支持的结束原因仍 `finish`；不保存动态枚举、不把截断当成功。
- message 键集仅比原要求多 `reasoning_content`（可含原已准许的refusal/annotations）时使用 `message_reasoning`，与该值的类型/长度/内容无关；还有其他未知键或缺少必填键仍为 `message_keys`。不提取、不丢弃或接受reasoning字段，不把该合成分类声称为E72已确认事实。

旧粗粒度 `protocol_response_choice` 记录保留且不回溯重分类；11个新标签闭集加入现有schema-v1可选诊断，仅允许transport_failed，未知后缀读写两侧拒绝。文本/tools-v1共享校验，原null-content工具调用和正常结束保持可用；工具参数、usage、计费、超时粘性、失败停止后续请求/不退款/不评分语义不变。

作者验证：新增choice用例先红（旧粗标签）后绿；Windows六套155例＝153通过/2跳过（链接权限），Linux Node22.22六套155/155；11个标签退化、reasoning过宽分类、首败重排、旧粗标签删除共14个私有副本单点变异全红，逐字节恢复后155/155并清理副本；fast1899通过/41跳过、smoke101、build/check与双typecheck通过。本段代码验证零新增Key读取/供应商/Docker/UI操作；E72的那1请求单独记账，不混作离线测试。hostCode未摘要编译模块缺口不变，全部AC pending、不合并发布。

### 5.24 显式 DeepSeek 非 thinking 兼容配置

E74 为本有界批次第2个真实请求：审查通过的 `e6f21d8f`、98文件副本字节核验与155/155预检、新计划/批准、原端点+客户端profile，HTTP200 后固定标签 `protocol_response_choice_message_reasoning`。**本次已确认拒绝点是message仅多reasoning_content键，但值是否为空/非空未知**，不展示/保存该值、不把E72/E70倒推为同因。仍无评分、候选未启动，2容器/专用daemon清理、源镜像未改；新增$0.25，累计$1.50未结算预留（非账单）。

2026-10-16只读核对 [DeepSeek官方thinking文档](https://api-docs.deepseek.com/guides/thinking_mode)：默认开启thinking，可用请求 `thinking:{type:"disabled"}` 关闭；开启thinking时工具历史需保留reasoning_content。原容器SDK已设置thinkingLevel=off、模型reasoning=false，但出口未显式发送关闭参数。因此新增**独立显式配置**而非丢弃真实reasoning或自动放宽旧协议：

- settings可选 `compatibilityProfile:"opencode-go-deepseek-nonthinking-v1"`；仅接受精确provider=`opencode-go`、model=`deepseek-v4.1-flash`，并在modelBinding中要求endpoint已显式启用`opencode-go-v1`。未知值/undefined/null/其他provider或model均拒绝。新字段进入settingsHash、复合bindingHash、审核投影与计划，必须新批准；不改变源认证路径/端点，不自动选择或迁移旧配置。
- 主机文本/工具编码器及容器adapter都发送固定 `thinking:{type:"disabled"}`。主机在预算派发/取凭据前严格复验thinking对象唯一type键且精确disabled；缺失、enabled、自定义键、额外字段均拒绝。无profile的旧settings/请求字节/hash及响应接受集合不变。
- 仅显式profile的响应message允许省略reasoning_content，或值为null/空字符串。空格、非空文本、数字、布尔、对象、数组均以固定`protocol_response_choice_reasoning_invalid`失败关闭；不截断/提取/擦除真实reasoning，不允许reasoning历史字段。容器adapter另设同样的独立拒绝边界，不能绕过主机后静默丢弃。非零reasoning_tokens、未知usage、截断、额外未知字段等旧限制仍保持；不保证网关支持或实际遵守请求参数，真实验证仍在后续批准运行中。
- 基线/候选必须使用同一新profile及其他参数，从同一起点对照，不能与旧失败计划混作只变role的对照。容器adapter和model-profile.json真实字节纳入现有manifest/harnessHash；hostCode未摘要其他编译模块的既有缺口不因此关闭。响应验证失败仍费用未知/预留不退款/停止后续请求/不评分，未发生新的供应商运行即不得宣称修复已验证。

离线验证：新增4项先红后绿；Windows七套170＝168通过/2链接权限跳过，Linux Node22.22七套170/170。25个私有副本单点变异全部红（17个profile/编码器/请求复验/双边reasoning拒绝/闭集守卫，8个全部相邻旧choice谓词重排）；逐字节恢复后170/170并清理副本。E73多故障排序P3已纳入本次回归，不另拆补丁。fast1909通过/41跳过、smoke101、build/check及双typecheck通过；本段代码测试零新增Key/供应商/Docker/UI，E74的1请求独立记账，全部AC pending、不合并发布。

### 5.25 usage 详情拒绝分类（接受集合不变）

E76 在已审 `a01b14b8` 与新非thinking计划下实跑：99文件副本逐字节核验、七套170/170；共享任务提示要求一次bash修复/保存输出后最终回答，双variant各最多2请求/25秒。实际基线发2请求均HTTP200，第1通过协议校验并交容器SDK，第2 `protocol_response_usage` 失败；声明费率下首请求计量14030微美元并非供应商账单。外层unresolved/无评分、候选未启动，2容器/专用daemon清理、源镜像不变；本批已用4/6请求，新增外层实际预留$0.50、累计$2未结算，不与内层重复相加。不宣称输出修复或对照已完成，也不以首次成功推断第二次usage具体失败项。

保留原usage键集、计数上限、总和算术、prompt/completion两个zeroDetails谓词与短路顺序；只将后两个拒绝点细分，**非零缓存/推理计数仍拒绝**。固定前缀`protocol_response_usage_`下：prompt详情非法为`prompt_details`；仅已知cached_tokens为正整数且≤prompt_tokens、其他已知audio计数缺省或零、无未知键时拒绝标签为`cached_tokens`。completion详情非法为`completion_details`；仅已知reasoning_tokens为正整数且≤completion_tokens、其他已知详情计数缺省或零、无未知键时拒绝标签为`reasoning_tokens`。不保存计数、动态键名、异常文本或响应正文；所有标签都是失败分类，不构成缓存费率支持/供应商计费证明。

旧粗粒度`protocol_response_usage`继续用于前置键集/计数/算术拒绝并兼容旧记录，不回溯重分类。四标签闭集同现有schema-v1可选诊断规则，仅transport_failed可带；未知后缀读写两侧拒绝，文本/tools-v1共享检查；未知费用、预留不退款、停止后续请求、不评分语义不变。E76具体项仍未知，下次真实诊断使用新计划/批准，不重复消费旧批准；hostCode编译模块缺口不变。

作者验证：新增16个用例旧实现先红后绿；Windows七套186＝184通过/2链接权限跳过，Linux Node22.22 186/186；10个私有副本诊断变异（四标签退化、cache/reasoning分类上界、未知键/其他计数限制、详情顺序、旧粗标签保留）全部红，逐字节恢复后186/186并清理副本。fast1925通过/41跳过、smoke101、build/check及双typecheck通过。此代码验证零新增Key/供应商/Docker/UI；真实E76单独记账，全部AC pending、不合并发布。

### 5.26 显式允许有界缓存计数的新版本 profile

E78 在已审 `8a46d342`、99文件逐字节核验及186/186预检后，用新批准执行基线诊断。实际仅1请求HTTP200后落 `protocol_response_usage_cached_tokens`：**本次已确认是键集合法、audio缺省/零、正整数且不超过prompt_tokens的缓存计数，被旧零计数限制拒绝**；具体计数不保存，不回溯E76同因。仍无评分/候选，2容器及专用daemon清理、源镜像不变；本批5/6请求，作者拿到定位后停止付费。新增外层$0.50、累计$2.50未结算预留（非账单、不与内层重复相加）。本批长期保留批准/双账本/无正文摘要，临时生成CSV材料不是用户真实现场封存证据，不能充当历史badcase恢复验收。

按 [OpenAI官方SDK CompletionUsage定义](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/completions.ts) 的“cached_tokens present in the prompt”及prompt+completion总数语义，新增独立 `compatibilityProfile:"opencode-go-deepseek-nonthinking-cached-v1"`，不是改写旧profile：

- 同样精确钉住opencode-go/deepseek-v4.1-flash及已显式启用的OpenCode端点profile；新值进入settingsHash/bindingHash、审核/计划、容器model-profile.json和harnessHash，须新批准。旧无profile及`opencode-go-deepseek-nonthinking-v1`依旧拒绝任何非零缓存计数；不自动按供应商响应换模式或重用旧批准。
- 仅新版本允许prompt_tokens_details.cached_tokens为0..prompt_tokens的安全整数，其他已知audio计数缺省或0，无未知键；primary计数/总和/字节/窗口上限仍按完整prompt验证，非零reasoning/audio/prediction、非空reasoning内容、未知详情等继续拒绝。thinking请求仍固定disabled。
- 预算预留与主机逐请求BigInt向上取整计量仍对**完整prompt_tokens收费一次**，不减去缓存、不另加缓存、不拆分后重复取整、不杜撰折扣。费率是操作者声明而非供应商账单或真实费用上界，旧未知费用/未结算预留不因此结算。SDK展示计数分为input=prompt-cached、cacheRead=cached、output=completion，totalTokens仍prompt+completion；两输入分区同用声明的完整输入单价，cost.total仍完整prompt+output。SDK浮点展示不参与主机预算裁决。
- adapter独立复验缓存键集、类型/边界/audio以及模式门控，旧模式不能绕过主机后静默丢失非零缓存；新模式不重复计数或丢失缓存分类。实际adapter字节纳入manifest/harnessHash，其余hostCode编译模块缺口不变。

作者验证：新增4例旧实现先红后绿；Windows七套190＝188通过/2链接权限跳过，Linux Node22.22 190/190；15个私有副本变异全红（旧模式门控、类型/边界/未知键/audio、模式hash绑定、主机减缓存/加缓存、SDK折扣/重复计数/丢计数等），逐字节恢复复绿并清理。fast1929通过/41跳过、smoke101、build/check及双typecheck通过；本段代码验证零新增Key/供应商/Docker/UI，尚未以新版本调用供应商，不宣称已跑通对照。全部AC pending、不合并发布。

### 5.27 容器任务失败的固定阶段诊断（不提升执行资格）

E80 在已审 `bf63c60d` 与 cached 新 profile 下，基线2请求均HTTP200并通过协议/usage检查，随后 `driver_failed`；外层仍unresolved/无评分、候选未启动。临时容器已清理，无原始模型/工具正文可回溯，**不能确认是请求上限、SDK、最终消息、文件或回执失败**。本增量只在容器任务原有失败出口提供固定阶段，不把假设当根因、不追加付费请求。

- `model-task-container.cjs` 失败stderr改为唯一一行 `model_sdk_task_failed:<phase>\n`；phase只来自源码常量：`bootstrap`、`materials`、`input`、`runtime`、`session`、`prompt`、`final`、`artifact`、`receipt`、`dispose`。它表示当前校验/操作边界，不保存异常message/code/stack/cause、SDK消息、工具名/参数、路径、模型正文或计数；catch不读取抛出值的任何属性。材料/输入/环境/工具定义/预算/最终消息/产物和回执的原判定均不变。
- 仅当容器实际尝试进入第 `maxRequests+1` 次 mailbox 调用，额外锁存 `request_limit`，失败出口优先报该标签；SDK吞掉异常再以error消息结束时仍能辨别。请求数限制仍由原mailbox检查，不增加请求额度、不再派发、不改SDK retry设置。标签只表明曾发生超限尝试，不断言它是唯一根因；如果任务原本成功，诊断不新增失败条件。
- 这些stderr是被测容器可伪造的非权威诊断，不是完成回执或评分依据。宿主原有 `code===0`、空stderr及完整回执/账本校验保持不变；包括 `dispose` 在输出回执后失败，仍因非零退出/非空stderr拒绝评分。未知或旧stderr不解释为成功，不按字符串匹配绕过任何校验。请求账本 `failureStage` 闭集、外层schema及 `driver_failed` 语义不变；本节不自动将容器阶段写入请求账本或UI。受信操作者可在独立观察器中仅保留精确白名单标签，未知stderr不得保存/展示正文。
- probe实际字节本已进入manifest/harnessHash，本变更必须新计划/批准；不复用E80批准，不修复其他host编译模块未入摘要的既有缺口。Goal D14按用户2026-10-17裁决记录既定DeepSeek同用途持续授权、金额无上限、不逐批重问；仍以有界执行计划、新的可审计批准、失败停止及逐次记账管理，不等于后台无限循环或真实项目采集授权。

离线验证：`node --test tests/runtime/badcase-model-evaluation.test.js tests/runtime/badcase-container-model-relay.test.js` Windows与Linux Node22.22均15/15。覆盖宿主拒绝、合成VM逐阶段/恶意异常Proxy、请求超限抛出/被SDK吞掉、恰好上限后产物失败不误报超限、成功回执不变，以及零退出/有效回执带任何stderr仍不评分/不启动候选。VM替换动态import并提供合成SDK/FS，不运行真正SDK/容器/工具，不冒充E80现场或证明真实失败原因。Linux私有副本14单点变异全红（9阶段塌缩、删除超限锁存、错误>=边界、移除锁存优先、读取异常属性、宿主忽略stderr），逐字节恢复15/15并清理。fast1932通过/41跳过、smoke101、build/check及双typecheck通过。本增量代码验证零新增Key/供应商/Docker/UI操作；真实供应商/容器诊断须在固定SHA独立审查后另立计划，全部AC pending、不合并发布。

### 5.28 工具调用响应的固定拒绝标签（接受集合不变）

E83 在已审 `89dc41ac` 下以新计划运行，基线仅1请求收到HTTP200后落旧粗标签 `protocol_response`，无评分、候选未启动、失败即停。**具体失败谓词仍未知**；本节只补剩余工具调用拒绝路径的诊断，不将静态可疑范围当成真实根因，不重试旧批准、不放宽多个调用或未知工具等限制。

- `protocol_response_tool_` 后缀固定为12项：`calls`（非数组或不恰为1个）、`keys`、`id`、`reused`、`type`、`function_keys`、`name`、`arguments_text`、`arguments_size`、`arguments_json`、`arguments_object`、`arguments_structure`。原短路顺序逐项保留；最后一项涵盖原 stableJson 结构/深度/节点/引用限制与秘密哨兵检查，原顶层响应解码的秘密排除仍先执行。仅报首个固定标签，不含ID、工具名、参数、动态键值、正文、异常属性或数值。
- 共享 toolCall 的请求历史路径仍抛通用协议错误，不携带响应标签；响应路径才显式开启诊断。JSON解析和结构验证的异常不读任何属性；所有原拒绝输入仍拒绝，seen仅在完整验证后添加。原参数字节不规范化、不删字段，仍须容器内工具按批准schema验证；65536字节上限不变。
- 标签进入原schema-v1诊断闭集，未知后缀读写两侧拒绝，仅transport_failed可带；旧 `protocol_response` 继续可读、不回溯重分类。usage/完整prompt费用、预算预留不退款、失败停止后续请求、不评分及外层报告语义均不变。配置/harness变更后须新计划/新批准，其他hostCode编译模块缺口不变。

离线负例先在旧实现失败，新增覆盖12项标签、持久读写、未知后缀、正文不落盘、旧记录兼容、未知费用/停止请求、请求历史仍无响应标签，以及可达的相邻双故障顺序。无效ID不可能同时是历史复用ID（纳入历史前已验证ID），该相邻交换无可达双故障，未宣称此等价变异被测试杀死。Windows七套212＝210通过/2链接权限跳过，Linux Node22.22七套212/212；50文件私有副本字节核验，41个非等价单点变异全部红（12标签退化、11守卫、6可达相邻交换、12闭集删除），逐字节恢复212/212并清理副本。build/check、双typecheck、fast1954通过/41跳过、smoke101及diff-check通过。本增量零Key/供应商/Docker/UI操作，E83具体原因仍未知，累计$4未结算预留非账单；全部AC pending、不合并发布。

### 5.29 宿主执行源码的计划绑定与派发复验

E85确认编译模块变动后计划仍与E83相同：旧hostCode仅列6个脚本，没有覆盖实际协议/出口/账本等编译依赖。此后不得以旧计划代表新执行代码，也不得重用已消费批准。本节收编该**磁盘源码摘要覆盖缺口**，不改变协议接受集合，不定位或放宽E85的tool keys拒绝。

- `model-host-code.cjs` 从仓库根下的model-evaluation与operator入口保守遍历字面量relative CommonJS require，包含传递依赖、函数内lazy依赖及inventory自身；Node内建模块不作为仓库文件。首次实现覆盖51个文件，包括协议、HTTPS出口、model-binding/egress、evaluation-plan/record、秘密排除、认证模式、输入材料、Docker/恢复/清理及审核辅助代码。清单按仓库相对POSIX路径排序，仅含路径与实际文件字节SHA256，不含绝对安装位置、源码、认证文件或Key。
- 缺文件、非普通文件、realpath别名/符号链接、越出仓库的依赖、非js/cjs、动态require/import、非Node外部包以及清单/单文件超限均阻断，不静默省略。遍历不require这些依赖，不执行operator、SDK或被测代码。扫描是适用于当前受审源码的保守约束，**不是完整JS语义分析器或抵御恶意代码作者的边界**；新依赖写法须独立审查后显式扩展，不能声称覆盖任意eval/别名加载。
- preparer加载依赖前保留清单，每次prepare复验，真实磁盘清单纳入harnessHash和返回的review；scorer版本引用完整相对路径的自身摘要。新源码必须重建计划/批准，旧批准不能用于新plan；无自动迁移或hash回退。每次execute在容器创建前复验；relay使用受检send，在每次受信send前后及接受回执/评分前再次复验。漂移/缺失仍走失败停止、unresolved/不评分，不退款或自动重试，不启动候选。原回执、stderr、usage、计费和双账本判定不变。
- 此清单证明的是**受信磁盘源码身份**，不是内存中函数/require.cache、VM替换、外部注入dedicatedProbe/observer或Node内建运行时的完整证明。代码更新须使用新启动的受信进程；启动前已加载的模块及同OS用户/路径祖先仍为TCB。不提供原子文件系统快照，检查间篡改再恢复不能据此被排除。E82/E85额外observer不因本节自动成为已绑定代码；既有faithfulReplay/strict资格仍false，不据此关闭任何AC。
- E84 P3补充transport路径负例：直接构造非法请求历史，经请求验证须固定`protocol_request`且exchange零调用；不再仅依赖encode外层catch的无标签断言。删除response门控必须被该路径测试杀死。此为回归覆盖，无协议行为变更。

离线验证用独立临时源码副本修改编译模块/传递辅助文件，比较harness与plan hash、阻断旧批准与派发、删除文件、发送前和回执前漂移；清单单测验证路径无关/排序/lazy依赖/新增边及不执行源码、越界/动态/外部依赖拒绝。实际runProbe→relay→send组合使用合成Docker协议fixture，**不是Docker/SDK运行或E85复现证据**。不读取真实Key、不新增供应商/真实Docker/UI操作。累计$4.50仍为未结算预留非账单，全部AC pending，不合并发布。

### 5.30 工具调用键集失败的无正文分类

E85仅确认`protocol_response_tool_keys`拒绝，未保留响应正文，无法回溯缺键/额外键或值形态。本节只在原`keys(value, ['id','type','function'])`失败分支内细分，接受集合及原首败顺序不变，不授权删除字段或兼容供应商扩展：

- 固定标签`protocol_response_tool_keys_shape`表示非对象或数组；`keys_missing`表示缺少至少一个必需键且没有额外键；`keys_mixed`表示既缺必需键又有额外键；`keys_index`表示三个必需键均存在且唯一额外键是固定的已知`index`；`keys_extra`表示必需键齐全、其他额外键组合。后四者同前缀`protocol_response_tool_`。分类不读取`index`或未知键的值，不保留动态键名、键数量、具体缺键、正文或异常内容，`keys_index`不表示值有效或可直接放行。
- 请求历史仍在原失败点抛通用错误，不进入新分类；transport请求验证保持`protocol_request`且零exchange。通过键集后原id/reused/type/function/arguments检查顺序不变。原`protocol_response_tool_keys`和`protocol_response`旧记录继续可读，不回溯重分类；新标签进入持久化闭集，仅transport_failed可带，未知后缀拒绝。未知费用、预留不退款、失败停止、不评分不变。
- 测试包括全部7种缺键组合及与额外键组合、非对象、唯一index的多种不透明值、index与未知键同时存在、键集与后续谓词双故障、原参数字节保持、持久重读/旧粗标签/未知后缀和正文不落盘；分类断言在旧实现先红。同时收编E86 P3：清单单文件恰好1MiB/多1字节、恰好256文件/第257文件、重复依赖计数以及非法UTF-8的capture/verify负例，不修改清单代码或限额。

新编译字节由§5.29纳入harnessHash，须新计划/新批准后才能真实调用；本节离线验证不读取Key、不发供应商请求或启动真实Docker/UI。不倒推E85原因、不升级回放资格，累计$4.50未结算预留非账单，全部AC pending、不合并发布。

### 5.31 显式单工具 index0 元数据兼容配置

E89在已审`feeeddf1`下按新计划/批准运行：实际仅1请求HTTP200后`protocol_response_tool_keys_index`，确认必需键齐全且唯一额外键为`index`，**值未读取/保存，不能断言为0或合法**；不能倒推E85/E83同因。失败即停、候选未启动、无评分；累计$5.50为未结算预留非账单，实际费用未知。E88超时与E89显式选择另一已严格TLS验证地址的差异不证明历史网络根因。

[OpenAI官方SDK类型](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts)将`index:number`定义于流式`ChatCompletionChunk.Choice.Delta.ToolCall`，非流式`ChatCompletionMessageFunctionToolCall`只有id/type/function。因此本实现不宣称该网关非流式扩展是OpenAI标准，不擅自将非流式响应解释成流式增量，也不自动删除未知字段：

- 新增独立`compatibilityProfile:"opencode-go-deepseek-nonthinking-cached-index0-v1"`，仍限定精确opencode-go/deepseek-v4.1-flash及显式OpenCode端点clientProfile。settingsHash/bindingHash、review/manifest、harnessHash/plan与批准绑定该值；须新批准，不迁移旧记录或自动探测。旧无profile、nonthinking-v1、cached-v1继续拒绝任何index（包括0），既有规范请求字节/hash不变。
- **只在新profile的响应路径**，且原`tool_calls`仍恰好1个、完整id/type/function均在且无其他未知键时，接受可选数值0的index。不是必需字段；null/字符串/布尔/负数/非零/小数/对象/数组全部拒绝。键集缺失或额外未知键仍按既有分类先拒；结构合格但index非0使用既有固定`protocol_response_tool_keys_index`失败标签，不保存值（旧profile中该标签仍只表示唯一额外index键，不能回溯其值）。index校验先于id，后续复用ID/type/function/name/参数/usage守卫不变。
- 请求历史不接受index，仍generic/protocol_request且零exchange；不改变串行工具模式、不放行多个工具、流式响应或增量字段。宿主不修改原响应字节，原参数字节保持；容器独立复验调用键集及index的新模式/0边界后，仅映射工具ID、名称与解析的参数到SDK。SDK历史按原行为JSON.stringify参数且不带index；该元数据不是工具身份或参数，不被偷偷转成另一个工具。容器旧profile同步拒绝index，未知键/缺必需键也不再被adapter直接调用者静默擦除；原宿主已拒这些输入。
- 新模式继承显式thinking.disabled、仅null/空reasoning、完整prompt一次计费和有界缓存分区；不放宽非零reasoning、缓存上界、未知usage/费用、截断、stderr/回执、预留保留、失败停止和不评分规则。两variant须同模式/同起点，不能与旧失败计划混作只变角色的对照。

离线回归先红后绿，覆盖可选index/0/非法值、旧模式拒绝、缺键/未知键/多调用/复用ID、请求历史零exchange、容器独立拒绝与SDK历史投影、settings/endpoint及持久批准绑定、双账本费用/未知费/停止候选。仅合成HTTP/SDK映射fixture，不等于真实SDK或Docker/供应商执行。作者验证：4个新用例旧码先红；Windows九套265＝262通过/3链接权限跳过，Linux Node22.22私有1658文件逐字节核验后265/265，17单点变异全红（宿主/adapter模式与0边界、强制转换、缺键/未知键、请求门控、thinking/缓存上界、provider/model/端点绑定等），逐字节恢复265/265并清理。fast1998通过/42跳过、smoke101、check/build、双typecheck及diff-check通过。本代码增量零Key/供应商/真实Docker/UI操作；真实验证须固定SHA独立审查后新计划/新批准，不能称E89值合法或兼容已实证。外部observer仍不自动入hostCode证明，faithfulReplay/strict资格false，全部AC pending、不合并发布。

### 5.32 请求期限的组合与离线回归（不扩大运行时间）

运行总期限、单请求账本期限、HTTPS期限和宿主凭据lease期限是独立约束，不应把一次约18秒请求失败直接描述为25秒容器期限耗尽：

- 请求账本在持久预留后启动计时，期限取`min(policy.timeoutMs, approval剩余时间)`；到期abort，并等待transport收束后记录结果。事件循环延迟时还检查单调时钟耗时及批准绝对到期。超时优先于迟到成功或transport错误，结果`timeout`不携带迟到failureStage；费用未知、预留不退、停止后续请求。
- HTTPS另取`min(请求开始单调时间+endpoint.timeoutMs, lease剩余时间对应的单调期限)`，同时检查AbortSignal和lease绝对到期；结束时销毁自己的请求/响应。若HTTPS或lease先到期而账本尚未到期，记录`transport_failed/https_cancelled`；该固定标签不区分网络、HTTP等待或哪一条取消期限，不升级为根因结论。
- 容器/relay总期限仍是外围约束；单请求期限不为工具执行、第二请求或清理预留足够时间提供保证。现有25秒总上限不变，本节不增加超时、不调整模型/出口、不新增自动重试。修改任一运行配置仍须重建计划和批准，不能重用旧批准。
- 离线组合测试使用合成HTTPS事件、可控单调/绝对时钟和手动计时器，穿过真实protocol与持久账本：分别验证账本、HTTPS、lease、批准先到期，等期限时HTTPS回调先执行、账本计时器未执行的迟到成功、及时成功；检查一次请求、socket销毁、timer清理、持久重读、成本未知/不退预留、禁止后续发送及正文/凭据不落盘。它不执行真实Docker或供应商请求，不证明E88/E91哪条链路先失败。另补E90 P3：adapter直接调用时完整键集但type为错误值仍拒绝，不仅测试缺键。

本节仅补测试和期限说明，不修改生产执行代码或成功接受集合。E91仍无评分、候选未启动，累计$6未结算预留非账单；index0真实兼容与历史超时根因仍未知，全部AC pending、不合并发布。

### 5.33 已封存材料进入模型协调器的离线集成边界

本节只补集成测试，不改变采集器、模型launcher、配置或任何接受集合；也不把E93生成CSV样例升级为用户历史badcase证据。

- `badcase-model-evaluation.test.js`新增Linux用例，沿实际授权/容量预估/独立开启HTTP、collector、SQLite、标记/封存worker、DB重建读取，再以`selectSealedMaterials`选入现有`prepareModelEvaluation`和持久批准/双账本。fresh/resume各两variant，核对stage中完整checkpoint结构及原文件、prompt与resume session字节；同起点摘要相同且mode保留，实时文件/执行后session变更不能替换归档字节。Docker协议与HTTPS响应均为替身，回执和产物人为构造，**未执行SDK、真实Docker或模型**，不能当作指令实际被提交或工具实际被执行的证据。
- 逐次报告与批准持久重读一致，原case字节及全部不完整资格不变。删除必需prompt/session blob后选材明确拒绝，不退回live目录或静默改fresh；测试只在自己的临时CAS内删除并恢复合成blob。
- `session-reuse-ab.test.js`现有真实executor挂点→collector→SQLite→封存HTTP用例追加操作者预检负例：实际归档含`toolBridgeEnabled=true`等配置，被受限launcher以`sdk_diagnostic_unsupported`拒绝，fresh/resume均不篡改checkpoint、harness blob或封存状态，不创建批准/派发目录。完整配置有多个受限维度，本集成不把桥标志断言为唯一/首个拒绝原因；桥守卫的独立覆盖沿用§4.7语义测试。这里的`startRun`与工具桥仍是替身；合成prompt未嵌入回调值，受控替换清单可以为空，**不能声称这次集成已覆盖非空替换的真实执行**。非空替换拒绝由§4.7原有独立语义负例覆盖。操作者prepare会在语义能力检查前调用capsule的protect，故拒绝也可能留下永久保护引用；不能把“未创建批准/未派发”说成零写入或引用已释放，仍沿用过度保留规则。
- 因而“采集输入完整”不等于“现有模型入口支持该输入”。普通CAFF turn通常带工具桥、受控路径/回调替换或复杂resume历史；这些语义尚未实现时必须明确阻断，不得为了对照成功剥去它们。当前可运行闭环仍是显式关闭工具桥、无skill/替换且历史满足线性纯user文本限制的材料。用户提供真实case后也须先做能力预检，不承诺任意case可运行，不据此扩大采集授权。
- 运行上述集成需Linux openat2/statx、Python3及匹配Node ABI的SQLite，Windows显式跳过，不能用跳过数当Linux验证。宿主只执行受信文件/DB/状态机代码，不执行被测agent。本节不新增供应商调用、费用或真实项目采集；全部最终AC仍pending，executionVerified/faithfulReplay/strict资格不升级。

### 5.34 Windows 安全读取底座（尚未接通采集）

`helpers/badcase-capture/windows_read.py`新增受信 Python/ctypes 原生 NT 读取原语。**本阶段不修改 `detectCaptureCapability`，Windows 采集仍在扫描目标前失败关闭**；不把单文件读取测试称作实际 worktree 检查点或恢复证据。它是 W2 的实现底座，不是 AC2 已通过。

- 只接受固定本地驱动器上的 NTFS 目录，拒 UNC、网络/可移动驱动器、设备/extended namespace 输入及不支持的文件系统。先打开驱动器根，再将每个经过保守语法检查的路径组件交给 `NtCreateFile(RootDirectory=已持有父句柄)`；所有祖先句柄保持至根上下文或单次读取结束。禁止 `..`、绝对路径、反斜杠形式的相对路径、ADS、空组件、尾空格/点、设备别名和非法 UTF-16。路径规范化不是授权证明。
- 每级设 `OBJ_DONT_REPARSE`、`FILE_OPEN_REPARSE_POINT`并核对句柄属性，拒绝 junction/symlink/其他重解析对象，不跟随挂载点；只有磁盘普通文件可读。祖先与文件打开均不分享删除权限，持有期间 Windows 拒绝重命名/删除；仍分享读写，不锁住普通写入，不承诺原子快照。打开不兼容或被拒绝时不回退其他路径/API。
- 根身份由同一个句柄查询 `FileIdInfo` 的卷序列号/128 位文件 ID 和 `FileBasicInfo` 的创建时间，全部为十进制/十六进制字符串。传入 expected 身份时，先核对再打开子文件；错误身份或路径被新目录替代时拒绝。文件读取前后核对同句柄 ID、长度、写入/变更时间及属性，有变化不返回成功内容。身份复用、元数据 ABA 和文件间非原子性仍属残余限制，不提升 strict 资格。
- `Root`只作为上下文管理器使用，异常路径关闭所有已开句柄；测试内 `_after_open` 是受信进程内故障注入，不提供 CLI 或 agent 工具。本节首次提交尚无枚举（后续原语见§5.35）；helper 协议/源码嵌入、管理授权 pin 集成、跨进程绑定、CAS/恢复或 Linux 容器路径映射仍未接通；后续不能直接以 Node pathname 递归遍历补齐枚举，也不能重新打开未核对身份的根。外置 Git 元数据/session/附件仍需各自授权，不由此获得权限。
- 原生测试仅操作自建临时 NTFS 目录：二进制/空文件/Unicode 字节与 hash、字符串身份持久重开、身份错误与根替换、越界/别名、真实 junction（不要求管理员）、祖先/文件重命名拒绝、并发写检测、大小边界、缺文件/目录/异常后句柄计数恢复。本节首次提交将 Node wrapper 纳入 `test:fast`，在 Windows 要求实际运行七个 Python 测试（后续§5.35增至14项；缺 Python 或文件系统不支持即失败），非 Windows 显式跳过，不能冒充 Windows 证据。未触及真实项目采集或付费模型。驱动器/文件系统不支持的负例仅注入 API 结果，未访问真实网络/可移动卷；真实 junction 负例不能替代所有重解析类型的逐类实测。

API依据：[NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)、[OBJECT_ATTRIBUTES](https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes)、[CreateFileW sharing/reparse flags](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)、[FileIdInfo](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)、[GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandleex)。Python解释器/ctypes/原生Windows、同OS用户及受信helper部署仍属TCB。正式接通采集前须补完整管理→采集→恢复与拒绝边界证据，再以固定新SHA独立审查；全部AC pending，不合并发布。

### 5.35 Windows 句柄相对目录枚举（尚未接通采集）

在§5.34底座上新增 `Root.walk()`，只返回目录树元数据，不读取文件内容，也不执行 Git 或扫描树外 Git 元数据。**Windows 管理授权/预估/collector 仍未接通，原平台能力检查继续在扫描真实目标前拒绝**。本轮仅在自建临时 NTFS 目录验证原语，不是整个实际 worktree 的采集恢复证据，不升级 AC2 或 strict 资格。

- 每个目录通过同步 `NtQueryDirectoryFile(FileNamesInformation=12)` 在已持有句柄上枚举，以64KiB缓冲区续读，第一次显式 RestartScan，直到 `STATUS_NO_MORE_FILES`；不使用 `os.scandir`、Node pathname 递归、realpath、WSL 或备用 API。其他状态（包括 pending/buffer overflow）、无有效IO字节或格式错误即固定原因拒绝，不把局部结果当成功。解析 `FILE_NAMES_INFORMATION` 的有界链、UTF-16字节长度和4字节 next 对齐；只跳过精确 `.`/`..`，其余名称仍经组件检查，拒绝斜杠、非法UTF-16与路径别名。
- 每个子对象继续经 `NtCreateFile(RootDirectory=父句柄)` 相对打开。枚举阶段不按目录项声称的类型直接递归，而以已打开句柄的 `FileStandardInfo` 判定目录/普通文件；重解析对象仍由既有多层防御拒绝。另查询目录 `FileCaseSensitiveInfo=23`，非零Flags或能力无法核验即拒绝（根、walk和read均生效），避免已有 `OBJ_CASE_INSENSITIVE` 打开使区分大小写目录内A/a条目别名；当前原语不声称支持这种目录。遇到拒绝中止整个原语，不静默漏项；后续 collector 需要按既有策略将此原因映射为不完整包，而不是宣称完整快照。
- 全树默认及最大100000项/64层，可传更小的正整数界限；达到上限允许，超出拒绝。目录续读内部也限制剩余项数，并拒绝重复名称。返回按相对路径排序的 path/type/size/identity/写入与变更时间，身份与时间为字符串；不包括根自身，目录 size 规范为0。Python内 size 仍是精确整数，未来跨进程协议须另行有界验证，不能直接假设JS无精度损失。
- 保留父句柄至其子树结束，不分享DELETE；每个目录子树遍历前后核对同句柄身份/写入与变更时间/属性，变化则 `directory_changed`。此检测不是全树一致性证明：普通文件写入不必改变父目录时间；先前子树完成并释放后仍可能变化，元数据ABA亦可能漏检。后续采集必须继续原有双扫/同句柄内容变化检测与不完整资格，不能凭本列表赋予 strict 资格。
- `_after_list` 只用于受信进程内测试，不暴露CLI/agent入口。当前原语尚无秘密/ignored路径策略，不能直接拿它遍历真实项目；正式接线须在授权与排除策略下使用，不扩大凭据、私有目录、采集存储或树外session/附件权限。

验证：原生 Python 用例由7增至14；枚举六项在旧码因缺失接口先红，另加大小写语义能力拒绝用例。真实NTFS覆盖空根、Unicode/二进制元数据、两次同句柄重扫、400个长名称跨64KiB续读、项数/深度与参数边界、真实junction不枚举外部对象、目录变化/持有期间rename拒绝、子树异常释放、原生失败状态与损坏记录。部分协议/格式异常为进程内注入，不冒充内核真实返回；API状态注入不等于真实坏卷验证。大小写语义不支持/未知的负例为API注入，未创建真实大小写敏感目录，不宣称逐类实测。wrapper在Windows要求14项实际运行，非Windows仍显式跳过。作者私有副本13个单点变异全红（目录变化、原生项限、深度、重扫、单页截断、漏目录、pending/空成功、size、重复名称、UTF16替换解码、next对齐、大小写语义守卫），逐字节恢复后连续三次14/14并清理。未触及真实项目采集、模型/Key、Docker或UI；管理pin/helper协议/源码嵌入/CAS恢复/容器映射仍待后续实现，全部AC pending，不合并发布。

API依据：[NtQueryDirectoryFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntquerydirectoryfile)、[FILE_NAMES_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_names_information)。原生Windows、Python/ctypes、同OS用户与受信部署仍属于TCB。

### 5.36 Windows helper 跨进程协议、枚举前排除与受限传输（未接通管理/collector）

在§5.34–5.35原语上增加单请求协议与 `windows-helper.ts` 受信宿主适配器，生成 `windows-helper-source.ts`（与Linux源共同由 `embed-helper.js` 生成；Linux内嵌源码/协议不变）。**Windows `detectCaptureCapability`、管理授权/容量预估、collector仍失败关闭，未直接或间接调用本适配器。** 本节只是后续采集接线可复用的跨进程边界，不是实际worktree采集/CAS恢复或AC2证据，不得据此开启真实采集。

协议与限制：
- 宿主使用显式选择的Python执行 `-I -B <受信helper>`，绝对根/身份/policy只经stdin传递，不放入argv；`-I`隔离Python用户路径/环境注入，原生Windows/Python解释器/stdlib与同OS用户仍属TCB。调用前核对磁盘helper的实际字节SHA-256等于内嵌摘要；此校验不是不可变执行体或进程证明，不声称抵御同权限进程在校验后改文件/解释器。安装部署由后续接线负责，本适配器不自动落盘安装。
- 单个UTF-8 JSON请求，version固定1、闭集字段；Python拒绝重复JSON键、非法UTF-8、非有限数、未知字段、超长输入与非法路径，**所有语法验证先于目标根打开**。`identity`只接受version/op/root、只查询根对象身份，不枚举子树；`capture`必须额外带expected/excluded/paths，expected为完整规范身份，不能缺失/降级成identity操作。内容操作打开根后先核对expected，替根或错误身份即拒绝，无自动重新pin。这是传入pin的跨进程核对，**不是管理授权或pin持久化实现**，调用权仍不得暴露为agent授权工具。
- `walk(excluded=…)`接收最多256条**字面相对组件前缀**，不是Git glob，`*`/`**`等非法；管理层未来须显式编译其已有策略语法。组件比较使用NT `RtlEqualUnicodeString(IgnoreCase=1)`，不以Python/JS locale折叠猜测NT大小写规则。枚举父目录名称后，在 `_relative` 打开子对象**之前**按完整组件边界跳过匹配项；不打开/stat/递归被排除的私有目录/文件/junction，类似`Private-other`不被`private`误排除。父目录名称必须先读取才能排除其子项；原生项数限额保守计入这些名称，可能提前拒绝，不静默截断。
- 内容请求先在同一已核对根上完成策略约束的原生walk，全部paths必须精确命中本次manifest的普通文件，然后才读取任何内容。大小写别名、未出现在manifest的8.3短名、被排除路径、目录或缺失项一律 `path_not_in_manifest`；不按alias另行尝试。每次读取在内容前还核对叶文件身份，内容前后原有句柄一致性检查不变；读后长度与walk记录不符也拒绝。底层 `Root.read` 仍是受信原语，不自身接收完整排除policy，**不得绕过此manifest门控直接暴露给不受信请求或作为collector捷径**。
- 响应为一个JSON头加换行，随后按files顺序连接精确长度二进制body（无base64、无额外分隔符），不把内容当JSON/文本重新编码。身份（U64卷序列、128位小写hex文件ID、I64创建时间）、所有I64大小/时间均为规范字符串。宿主校验键集/类型/范围、根pin、目录父项/深度、路径唯一与Unicode标量排序、文件与manifest的路径/身份/长度、body长度与SHA-256以及无尾随字节；只将≤64MiB的body长度转换为Number，原始身份/枚举大小不转浮点数。低级响应不携带complete/strict/可运行等资格。
- 固定上限：请求1MiB、最多2048条互异内容路径，枚举100000项/64层，单文件64MiB、累计body128MiB、JSON头32MiB；宿主进程stdout限160MiB+1字节、超时10分钟。原生端在剩余body额度下读取，不预读超额文件；超头限/任一读取失败时丢弃整个成功响应及所有已读body，仅返回闭集固定原因，不输出部分成功。宿主要求exit=0且stderr为空，否则不透传或保存异常正文。损坏/截断管道也只能失败，不提取部分文件。超时/退出/异常测试中不保留秘密哨兵。

诚实性与后续义务：本协议只实施**传入的字面排除策略**，不自动提供秘密扫描、ignored/Git分类、私有目录发现、采集库排除或CAS封存；fixture空排除列表不授权真实采集。管理接线必须从持久policy编译强制排除，保持逐worktree独立授权与普通save不重新pin；树外Git/session/附件仍独立授权。本次walk再read仍非全树一致快照：同尺寸内容可在两个阶段之间变化，已经释放的子树可变化，身份复用/元数据ABA残余仍在；宿主字段校验不证明输入现场全树一致。后续collector双扫/不完整状态、CAS与恢复、容器路径映射和真实UI证据尚未补齐，strict及全部AC仍pending。

作者验证：Windows10 build19045/x64、Python3.13.5、Node24.13.1，自建临时NTFS树；原生由14增至18项，四项在旧码缺接口/协议时先红。覆盖原生跨进程pin→walk/二进制与空文件读取→替根拒绝、混合大小写/嵌套前缀在打开前排除（含真实junction）、别名/manifest门控、全批拒绝无部分body、重复键/UTF8/字段与输入限额、叶身份拒绝及walk后长度变化；另补`a.b`与`a/z`交错命名的全局排序断言。Node九项验证源嵌入一致、完整字段/64位边界/二进制帧/hash/父项/排序/拒绝闭集，并真实执行内嵌副本传输；加原生wrapper共十项、零跳过。累计body/头/文件限额算术使用受信进程内常量或测试VM缩小限额，**不是实写128MiB或真实耗尽磁盘验证**；过程超时/坏stderr/exit与源码错误用VM替身，不冒充真实挂死内核/解释器终止。所有测试故障接缝均不进入协议。

私有副本21个非等价单点变异全红：12个原生点（排除提前prune、NT大小写、根pin、叶pin、重复键、请求限额、身份schema、canonical manifest、body额度、头限额、walk/read长度、全局排序），9个Node点（枚举size字符串、卷约束、响应根pin、文件身份、body额度、文件hash、响应闭集、stderr拒绝、进程error拒绝）；各恢复逐字节一致后原生18/18、Node9/9，副本清理。零真实项目采集/模型Key/供应商/Docker/UI；历史6美元未结算预留非账单口径不变，不合并发布。

### 5.37 Windows 显式授权根身份持久化（采集仍关闭）

- 管理门面 `authorizeProject` 在 Windows 安装并自检已审查原生 helper，将 worktree 根与独立输入根分别保存为 `{realpath, identity:{volumeSerial,fileId,creationTime}}`；三个身份字段保持字符串。此处 `realpath` 是历史字段名，Windows 保存 **literal resolved path**，不先跟随 junction；根或祖先为 junction 即无 pin。Linux 仍用原 realpath/statx 路径，不改采集接受集合。
- 唯有显式授权创建/更新 pin。普通保存只保留仍列出的旧 pin，拒绝来参伪造的 pin；新增根无授权，移除根同时移除 pin；重启保留原对象身份。替根后的原 pin 在 native capture 请求中拒绝，只有再次显式授权才能换 pin。Windows 授权无论成功与否均保存 disabled，失败根不保留旧 pin，不回退 Linux/Node stat/WSL/纯路径授权；API 仍复用 local-admin/CSRF/确认，授权不等于开启。任一项目根/独立输入根失败不得报告部分成功：先持久化disabled和本轮成功的pin，再抛固定code，由HTTP映射409 `windows_authorization_unavailable` / `windows_authorization_root_rejected`；不透传异常正文。三个拒绝负例先红后绿。
- `windows-authorization.ts` 在采集存储内安装完整 SHA 命名的源码。首次排他创建，已有文件必须为普通文件且字节摘要正确，篡改不自动修复；并发首次安装读到半写文件可失败关闭，不承诺安装原子性。解释器经 PATH 显式固定候选顺序 python→python3，以 `-I -B`、10秒/1KiB验证 Windows Python≥3.9 的固定标记。每次授权重跑存储内独立临时目录身份稳定性与真实 junction 根拒绝自检，只删除自己的探针，失败原因固定不回传正文。
- 每个 native identity 请求另设10秒上限，capture 请求原限额不变。仍沿用同步管理门面：批量根的耗时顺序累加，可能阻塞事件循环；这不是异步批量授权或崩溃后探针自动回收的交付。路径/解释器/同OS用户/存储为 TCB，源码磁盘摘要不证明不可变执行体；自检不扫描项目文件、不证明捕获一致性或完整回放。
- 证据：Windows10 build19045/x64、Python3.13.5、Node24.13.1，自建临时NTFS根经真实门面/存储/helper验证主/输入pin、重启、替根、普通保存不重新pin、移除/新增根、真实junction根与祖先拒绝、源码安装/篡改失败；仅身份元数据查询，无真实项目采集。新授权套8/8，helper套10/10、原生wrapper1/1；与safe-read/estimate授权/HTTP管理组合82=57通过/25跳过。原生Python18/18由wrapper执行。
- 共享Linux回归：WSL Debian Node22.22，54文件私有副本逐字节核验；safe-read/estimate授权/Windows协议与合成管理四套60=52通过/8跳过（Windows原生与无CAP_SYS_ADMIN挂载缺证据），副本清理。首次合成VM在Linux以普通symlink模拟junction，rmdir语义不同导致自检清理断言失败；只为该VM模拟Windows junction删除行为后重跑通过，生产代码不变，不冒充Linux原生Windows证据。
- 私有副本11非等价单点变异全红并逐字节恢复：literal改realpath、跳过Windows分支、普通保存接受伪pin、失败仍生成pin、删disabled、项目根/输入根完整pin检查各一处、排他写改覆盖写、身份稳定性、junction拒绝、identity超时。全量fast2026通过/43跳过（含check/build）、smoke101、双typecheck与diff-check；首次fast脚本8193字符超过Windows cmd限制未执行，改为独立 `test:badcase-windows` 子脚本后完整重跑，不将失败计通过。
- **尚未接通**：持久策略→强制秘密/私有/Git/ignored排除编译、Windows estimate/collector双扫/CAS恢复、session输入读取、容器路径映射。原Windows采集能力门仍失败关闭，HTTP无法从真实估算获得开启回执；强制手工设置enabled也在采集能力门被拒。S1继续验证零目标内容读取，不把disabled短路当作能力门验证。旧节“零管理接线”是其固定SHA历史范围，当前只接身份授权。
- 未启动UI/真实Docker/模型/供应商，全部AC pending；历史6美元未结算预留非账单不变，不合并发布。本段不构成Windows实际worktree采集恢复或AC2通过。

### 5.38 Windows 授权后元数据容量预估（不开放文件采集）

在§5.37持久 pin 上接通 `estimateDirectory` / 管理 HTTP 使用的 `estimateDirectoryAsync`。**本段只交付可见容量预览，不实现 collector、CAS恢复或实际turn文件归档，不升级任何AC。** 旧节对“Windows预估未接通”的描述是其固定SHA历史范围，以本节当前契约为准。

- **独立只读协议**：新增 `op:estimate`，闭集字段为 `version/op/root/expected/excluded`，不得传 `paths`；pin 必填。原生根身份核对先于子树枚举，返回原有受限 walk 的精确64位字符串元数据、`files:[]`，不调用 `Root.read`，不执行 Git。宿主拒绝文件项/任何尾随body；旧 capture/identity 接受集合不变。源码变更进入新完整SHA安装文件；旧安装缺新文件时估算明确失败，不能自动安装/修复/重新授权。
- **持久授权边界**：仅接受恰为项目 `authorizedDirs` 中根的 literal resolved path 及原持久 pin；树外输入根不自动变成项目根，子目录不继承独立pin。NT helper仍接收原literal路径，而非realpath输出，拒替根/重解析/不支持卷/大小写语义，绝不回退Node遍历或WSL。宿主只做根名称的元数据规范性校验：canonical名称与literal不一致即拒，不把realpath结果作为helper目标消除junction。元数据名称检查不是身份授权，真正根pin仍由原生持有句柄比对。
- **排除编译与保守范围**：从持久 `excludedPatterns` 编译字面组件前缀，仅支持原有末尾 `/*` / `/**`，其他通配符/越界/非法组件/超过协议限额均拒。采集存储、`agentDir`（有配置时）、当前服务进程的 `PI_AGENT_SANDBOX_DIR/PI_AGENT_PRIVATE_DIR` 贡献 literal 和可解析canonical前缀；目标等于或位于这些保护根下则拒。保护根仅允许本地盘符绝对路径，UNC/扩展namespace在解析前拒绝；不存在的保护路径仍保留literal排除，其他解析失败拒绝。名称解析只用于排除，不读取目录内容；这些TCB配置不代表已经收集每个agent的所有私有路径，不能直接推广为turn采集策略。
- **原生强制名称表** `windows-metadata-v1`：每层在打开子对象前，以NT大小写比较排除 `.git`、`.pi`、`.pi-sandbox`、`.ssh`、`.aws`、`.azure`、`.gnupg`、`.env`、`.env.*`、`auth.json`、`credentials.json`；目标根或祖先命中这些名称也拒绝。`includedIgnoredPatterns` 不能覆盖该表。父目录中子项名称必然可见，但被排除对象不打开/递归；已知名称表可能过度排除同名非秘密文件，也不能识别任意改名的秘密，**不是万能凭据探测器/完整collector秘密策略**。
- **数量语义**：不读取Git规则、ignored普通文件也计入，`includesIgnored:true`；仅对纳入范围的普通文件大小以BigInt相加，超JS安全整数范围即 `estimate_size_overflow`，不舍入。返回 `exclusionPolicy`、限制表与 `captureAvailable:false`。`complete:true` 仅指本次元数据枚举无缺口，不表示原子现场、完整回放或实际磁盘占用；不含session、镜像、清单、CAS新增去重成本。文件仍可在预估后变化。
- **Windows异步边界**：不使用Linux worker/进程组或taskkill `/T`。固定PATH `python -I -B <已安装摘要源码>` 启动一个不派生子进程的受信helper，stdin传请求，stdout最多32MiB+换行，无正文；任何stderr、非零退出、进程错误、损坏协议均失败。每进程最多2个在途预估、不排队；每根25秒，超时/超输出按Node子进程句柄终止，丢弃部分输出，等待close后归还名额。单调迟到检查阻止计时器未执行时接受迟到成功，超时原因锁存，timer在close清理。不是进程树沙箱、内存硬隔离或跨进程全局配额；多根仍顺序累加。该代码不可复用于可派生子进程的helper。
- **TCB/限制**：解释器、同OS用户和存储仍可信，磁盘摘要不证明不可变执行。此预览固定使用 `python`，仅python3可用的授权安装仍会预览失败，不自动切换或重新pin。源码摘要/少量路径元数据/策略读取仍同步，不宣称事件循环绝不阻塞；整个目标walk与进程等待异步。同步批量授权和崩溃探针残留仍未解决。普通文件的collector、强制内容秘密扫描、Git/ignored分类、session、双扫/CAS恢复与容器映射仍待交付。
- **HTTP/UI防误启用**：显示实际字节/文件数与“元数据预估完成；采集尚不可用”，解释ignored/成本排除/内容未扫描。元数据成功但 `captureAvailable:false` 时不开启回执，enable重新检查可用性；即便旧回执可用也拒 `badcase_capture_collector_unavailable`。UI不得保留该类回执，不因成功预估自动开启。原Windows collector能力门不变，手工写enabled仍零目标内容读取后明确失败。
- **证据**：Windows10 build19045/x64、Python3.13.5、Node24.13.1，自建临时NTFS目录真实helper与持久服务重启：3文件8B，最后针对性验证sync90ms/async83ms（测试条件，不是实际turn增量或性能承诺）；真实HTTP授权→原生预估1文件5B→无回执/开启409→持久disabled；均零checkpoint/blob。真实junction验证每层已知名称及用户排除在打开前生效，未排除junction拒绝；私有目录alias指向树内时正确排除，私有祖先拒绝。原生19/19（含无读取/子对象打开计数在生产catch之外）；九套118=88通过/30平台跳过；JSDOM不是浏览器端到端验收。
- **终止/异常证据**：生产异步transport经测试VM只替换启动目标和缩短时限，真实Windows Node sleeper不派生子进程；其运行期间真实HTTP健康请求先完成，1500ms期限后等待真实子进程close才报失败。不是原生helper真实挂死实测。合成进程/小输出限额/单调时钟验证stderr、非零、超输出、并发、计时器未执行的迟到成功、超时优先及清理；不冒充32MiB实写/真实损坏卷。溢出和canonical名称不符负例含VM注入。
- **回归/审查证据边界**：收编E98 P3，删除原absolute-root守卫后现在由外部I/O计数断言报红，不再靠可被生产catch吞掉的assert证明“未触发I/O”，原守卫未改。私有副本16非等价变异全红，逐字节恢复再绿并清理：原生名称排除/私有根拒绝/意外读内容，溢出、canonical根、私有alias/祖先、用户排除，timer清理、迟到成功、超时锁存、输出界限、stderr、E98守卫、HTTP回执和enable复验。首次私有副本漏拷HTTP依赖config，baseline失败未算通过，补齐后完整重跑。Linux WSL Debian Node22.22私有57文件逐字节核验，六套75=62通过/13平台或挂载权限跳过，清理自有副本。`test:fast`2038通过/43跳过（含check/build）、smoke101、双typecheck、diff-check通过。初次编辑曾发生Windows默认文本编码损坏superscript设备名正则，既存协议测试检出；已恢复原字节并完整重跑，未放宽守卫。

本段未开启任何真实项目采集，未操作供应商/真实Docker/生产实例；历史6美元未结算预留非账单不变，全部AC pending，不合并发布。下一连接段仍是Windows文件采集策略、collector双扫及CAS恢复，再提供实际worktree证据，不能以本段元数据或测试数替代。

### 5.39 Windows 受限文件候选双扫与 CAS 恢复连接（未开放 turn collector）

本段新增内部 `readWindowsFileCandidate` 连接原生内容→宿主秘密扫描→可供受信 CAS writer 使用的内存计划；**没有管理/API/agent 工具入口，不写 policy/checkpoint/blob、不发开启回执，Windows turn collector 能力门不变**。仅使用自建临时 NTFS 树验证候选→既有 CAS→两次恢复，不能称实际 worktree、真实执行前 turn 检查点或 AC2/AC9 已通过。

- 新增独立 `op:snapshot`，请求闭集与 estimate 相同（必须原 pin/excluded，不接受 paths、钩子、预算覆盖）；不改旧 capture/estimate/identity 接受集合。复用持久根/保护根/排除编译 `prepareWindowsMetadataScope`，不安装、不重新 pin、不跨入树外输入或 Git 元数据。每次部署新 helper SHA 仍需显式授权安装；旧安装不自动迁移。固定 PATH python、源码磁盘摘要与原生/解释器/同 OS 用户/存储 TCB 限制不变。
- 原生单次调用持有同一授权根，三次全量原生元数据 walk 分别在第一次内容读前、两次内容读之间、第二次内容读后；两次独立全内容读均核对叶身份/大小/同句柄漂移，比较第二次 hash，两个后继 manifest 与首份逐字段相等。变化整批拒绝、不重试、不输出部分 body。三次 walk 都在打开子对象前强制 `windows-metadata-v1` 名称排除，敏感祖先/根亦拒；用户字面排除照旧生效。元数据 ABA、身份复用、各文件间非原子性仍可漏检，绝不升级 strict 资格。
- 首次读前预检最多2048个普通文件、每文件64MiB、总内容128MiB；枚举100000项/64层、头32MiB、请求1MiB不变。超限整批拒绝，不静默截断。保留首遍 body，只将第二遍作 hash/身份复验；响应格式沿用头+精确二进制。宿主要求 files 恰好等于 manifest 所有普通文件的 canonical 顺序，不能缺/多/换文件、hash/长度/身份异常或尾随字节；不再信任调用方的路径选择。此同步内部原型另设25秒上限，不接 HTTP/turn 以阻塞业务；不是异步 collector、内存硬隔离或进程树沙箱。
- 宿主在返回任何 CAS 计划前使用既有完整字节秘密哨兵。命中只留 `secretExcluded`/大小/类型，不返回其 hash、身份或内容；安全内容按 hash 内存去重，复制到独立非池化 `Buffer.alloc`，**不返回 wire subarray 或 pooled copy**（其 ArrayBuffer 可能仍包含同响应的排除秘密）。不宣称内存安全擦除。全部结果 `complete/strictEvalEligible/captureAvailable=false`；mode 显式合成为0644，不伪造 Windows→POSIX 权限恢复。
- **不能直接生产接线**：本原型沿用 metadata 范围，尚未解析 Git/ignored（普通 ignored 也会读），不是完整 collector policy；Git 元数据/session/附件不读取，未实现真实 invocation 配置、quota/引用/持久事务、空目录恢复、容器路径映射。后续必须补齐这些策略与 collector 集成，不得因为有双扫和CAS测试而绕过原 Windows 开启门。候选读取本身无自动落盘，测试用 writer 显式使用既有 stage/commit/checkpoint/restore，不是隐藏产品入口。
- 验证仅自建临时 NTFS：二进制/空/Unicode/重复内容经真实原生 helper→候选→CAS落盘、两次恢复清单一致；秘密内容和 hash 不进项目存储；改文件/新文件/删除的 fixture 差异可检测，但不冒充已解析 tracked/dirty/untracked 分类。替根、未 pin/换根、junction、源码篡改拒绝。两项原生新测试在旧实现因缺 snapshot 协议先红；另对初版返回 wire backing 的缺陷先红，再改为独立分配。变化故障通过进程内钩子在真实自建文件上操作；仅 hash ABA/低限额为注入，不冒充真实协调攻击或128MiB实写。
- 收编 E99 P3：异步 estimate 同名源码篡改和1MiB+1字节分别返回 `helper_integrity_failed`，每类连跑三次，catch 外 spawn 计数为零；恢复源码后可用、名额已归还。删除异步完整性检查后回归红，原生产守卫不变。

作者验证：Windows10 build19045/x64、Python3.13.5、Node24.13.1，原生21/21；十套 Node124=94通过/30平台跳过（含wrapper执行21原生）；fixture首份5个文件记录、3个唯一安全blob共8B，读取/落盘/两次恢复/第二份差异的组合159ms，仅该次小夹具总耗时，不是整个worktree或真实turn性能。`test:fast`2044通过/43跳过（含check/build）、smoke101、双typecheck与diff-check通过。WSL Debian Node22.22私有61文件逐字节核验，八套82=66通过/16平台或挂载权限跳过，自有副本清理；初次60文件副本漏拷Linux审计helper导致源码一致性测试ENOENT，未算通过，补齐后完整重跑，未改生产。

私有副本14非等价单点变异全部红并逐字节恢复后原生21/21、Node三套25/25再绿，副本清理：7原生（中间manifest、末尾manifest、独立hash、文件数、body预检、snapshot敏感根、第二遍读取），7 Node（完整files集合、2048项、25秒上限、E99异步SHA、秘密扫描、strict恒false、wire backing隔离）。其中wire backing负例在初版已先红；普通Node新套在build前因缺编译模块先红，不将此装载失败当语义回归证据。其余边界/异常口径如上，不冒充真实历史badcase。

本段无真实项目采集、Key/供应商、真实Docker/UI或生产操作；历史6美元未结算预留非账单及全部 AC pending 不变，不合并发布。

### 5.40 Windows 本地 Git 子集分类后读取（仍非 turn collector）

新增内部 `readWindowsGitFileCandidate`：在 §5.39 全文件原型之外提供**先读固定分类源→计算选择→只读选中文件→复核分类源**的独立入口，不执行 Git，不自动安装/re-pin、不持久化，不接管理/API/agent 工具或 turn。旧原型仍禁止生产接线；不能把本段当作完整 Git/ignored 策略或 Windows 已可开启。

- 独立闭集 `gitMetadata` 请求与 estimate 相同；原生三 walk/两读仅返回根 `.git` 文件（作为数据、不解释指向）、`.git/config/index/commondir/info/exclude` 和树中精确名 `.gitignore` 的内容。只允许 `.git/info` 为目录，其余固定子源必须为文件；根 `.git` 可为目录或 gitfile。进入根 `.git` 时只打开这张固定清单，hooks/objects/refs 等在子对象打开前剪枝；不展开 include、excludesFile、commondir 或 gitdir。用户/保护根排除依旧先于这张清单，**不覆盖默认 `.git` 排除以换取成功**。大小写变体/嵌套 `.git` 拒绝；其他原生敏感名称表、pin、重解析/句柄及 TCB 边界保留。`gitMetadata` 会读取分类所需的树内 `.gitignore`，包括忽略子树内此类规则源，但不读取其普通文件内容。
- 独立 `selectedSnapshot` 必须显式 paths（含空列表），在三 walk/两读范围内要求所有路径精确命中 canonical 普通文件；大小写/8.3别名、目录或缺失路径在第一次内容读前整批拒绝，不将空选择降成全采集。保留完整的非秘密元数据 manifest，files/body 恰好为请求选择；宿主复核完整闭集/顺序/身份/长度/hash和无尾随字节。`gitMetadata` 的宿主消费方另复核 `.git` 子项固定清单及类型。旧 identity/capture/estimate/snapshot 接受集合不变。
- 宿主要求 canonical 本地 `.git` 目录及可读 config/index；gitfile、commondir、缺少/被排除元数据、配置 include/excludesFile/未验证语法、损坏 index/规则或源中的秘密一律在普通文件内容读取前拒绝，无“宁多采”回退。复用既有内置 index/config/gitignore 解析器及 tracked 优先、目录忽略/深层规则、info/exclude和策略显式纳入逻辑。新增 `parseGitIndex` 可选 `stageZero:true` 拒绝单个未合并 stage，旧调用不传时行为不变；另拒重复名/非可移植路径/符号链接 mode，tracked mode 保留 index 的0644/0755，untracked mode 合成0644。
- 本地配置子集不验证 `core.ignorecase=true`（Windows Git 常见默认值），故明确拒绝；不为跑通夹具自动改项目配置。**不读 OS 用户级/系统/XDG 默认 Git 配置和全局忽略，外置 Git 元数据独立授权读取尚未实现**。因此机器可读分类名仅 `bounded_local_git_subset_v1`，并列出 `ambient_global_git_excludes_not_read` 等限制；`complete/strictEvalEligible/captureAvailable` 恒 false，不能宣称普通真实 worktree 的 ignored 授权已完整落实，更不能接 collector。
- 首轮分类元数据（含整个非敏感文件树的元数据）与选读时非 Git manifest 必须一致；选读后再原生读取全部固定分类源，与首轮的完整 manifest 和源内容 hash/身份逐项摘要对比。任何变化/失败不返回部分 blob 计划、不重试。秘密源拒绝不返回 hash/身份/正文；普通秘密文件只留 secretExcluded，安全 blob 独立非池化 Buffer.alloc，避免共享 backing 保留排除秘密。**多进程之间未持有同一根，跨调用 ABA/文件间非原子性仍可能漏检，不证明现场一致**。
- 每个新 helper op 各25秒，3个同步调用累计最多75秒的子进程限额（另有宿主校验/解析开销），不是单个25秒 turn 截止或异步业务接线。2048文件/64MiB单体/128MiB body/1MiB请求/32MiB头/100000项/64层不变。无 quota/引用事务/session/附件/真实 invocation/删除历史/空目录恢复/容器映射；不构成 AC2/AC9。

作者验证：Windows10 build19045/x64、Python3.13.5、Node24.13.1，原生23/23（两新项在旧协议先红）；11套 Node129=99通过/30跳过，原生按选择两读证明未选普通文件零 Root.read，固定元数据源证明 hooks/objects 子对象零打开。自建临时 Git 仓库仅测试侧执行 git init/add/config/ls-files，独立隔绝全局配置、显式设 `core.ignorecase=false`；dirty tracked、untracked、根/深层 .gitignore、info/exclude、ignored目录与显式纳入的文件集合和真实 ls-files 对照一致。该测试 Git 是oracle/夹具构造，不是采集器执行 Git，也不是用户真实 worktree/turn 或历史badcase证据。缺 `.git` 授权、gitfile、单stage、坏校验/编码/规则、源秘密/配置未知均拒绝；选读前后变化及失败无计划。新Node套最初缺模块的装载红不冒充语义回归证据。

`test:fast`2049通过/43跳过（含check/build）、smoke101、双typecheck/diff-check通过。WSL Debian Node22.22私有63文件逐字节核验，九套87=70通过/17平台或挂载权限跳过，副本已清理。私有副本17个非等价单点变异全红、逐字节恢复后Node两套16/16及原生23/23复绿并清理：5原生（Git固定清单、元数据源选择、空选择不回退、全路径预检、源类型）；12 Node（tracked优先、忽略启用、显式纳入、单stage、后继元数据摘要、选读manifest、配置验证、秘密扫描、backing隔离、恒false、新op25秒、wire固定清单）。首次扩展夹具因空Git模板无info目录而失败，补齐测试自身目录后全量重跑；不是产品故障或通过证据。

本段无真实项目采集/Key/供应商/真实Docker/UI/生产操作；历史6美元未结算预留非账单、全部AC pending及不合并发布不变。

### 5.41 Windows 分类读取异步链与共享期限（仍非 turn collector）

新增内部 `readWindowsGitFileCandidateAsync`，与 §5.40 同步入口共用一个生成器状态机，分类/选择/复验/秘密扫描及 blob 字节规则不分叉。异步入口**不重试、不回退同步调用**；旧同步入口保留兼容，其3×25秒上限不变，不能把它当作新的异步路径。没有新增管理/API/turn/开启接线。

- 异步链在 scope 编译之前固定 `performance.now()+25000`，三个 helper 始终接收同一个绝对单调期限；scope 后、每个响应消费前、每次状态机推进后（含同步分类及最终安全 blob 复制）检查期限。超时只返回 `git_capture_timeout`，没有部分 files/blobs，迟到响应不再做分类/秘密扫描。**同步文件系统调用、编码、hash 与解析不能被定时器抢占**：这是观察到逾期就拒绝的期限，不是保证25秒内响应的 CPU/系统调用硬中止。
- 新内部 `invokeWindowsGitHelper` 只接受 `gitMetadata/selectedSnapshot`；期限必须有限、在未来且不超过当前25秒。执行前仍验证已安装 helper 大小≤1MiB与完整 SHA，不安装/re-pin。每个进程本模块最多2个此类活跃 helper（独立于 metadata estimate 的名额，并非跨服务全局 semaphore）；单次输出仍≤32MiB头+128MiB body+换行，经原闭集 wire 解析及完整性校验，校验后再查期限。
- 使用异步 spawn、`python -I -B`、stdin 请求及管道；stderr/非零退出/进程错误/超输出/期限拒绝，不保存正文。按 Node 子句柄 SIGKILL，丢弃累计输出，**等 close 才释放名额和返回**。kill 返回 false/抛错保留固定 cleanup_failed；若操作系统始终不能关闭子进程，等待及名额会保持，不能宣称可靠的25秒硬清理或提供 taskkill/宿主执行回退。此 helper 不产生子孙，不是通用 Windows 进程树隔离。
- NT Python 代码及 Linux 生成源均未更改；仍 `bounded_local_git_subset_v1`，原 pin、默认排除/保护根、Git 缺/未知/外置引用阻断、普通文件秘密先于计划/独立 backing、complete/strictEvalEligible/captureAvailable 恒 false 等不变。异步成功额外列出 `async_git_chain_25s_observed_deadline`。Git 全局配置/外置元数据、session/实际 invocation、配额引用事务/删除历史/容器映射仍未接齐，不构成真实 worktree/执行前采集或 AC 通过。

作者验证（Windows10 build19045/x64、Python3.13.5、Node24.13.1）：新增异步 API 的测试在旧实现缺接口先红；原生24/24，新增嵌套 `sub/.git`/顶层 `.GIT` 各文件/目录负例，固定 `git_metadata_unsupported` 且生产 catch 外统计 Root.read 为0，收编 E101 P3。11套 Node136=106通过/30跳过，包含自建临时 NTFS Git 树 sync/async 文件、mode、blob 字节一致及秘密剔除；实际 sleeper 子进程期间隔离 `127.0.0.1:0` HTTP 健康请求先完成，1500ms测试期限后收到真实 close 才返回。sleeper 仅测试 VM 指定的 Node 子进程及缩短期限，不冒充 Python 真实挂死/生产UI证据。

虚拟时钟/子进程测试覆盖共享期限、scope/分类/最终复制耗时、迟到响应不消费、parse 后逾期、timer 未执行的迟到成功、timeout锁存、限额/2并发及等待close、源码同名篡改/1MiB界、spawn/kill异常、失败停止与无部分结果。私有副本10个非等价单点变异全部断言红（逐阶段重开25秒、链前/后期限、op闭集、25秒上界、并发、kill、输出上界、parse后期限、E101嵌套Git守卫）；逐字节恢复后基线复绿并清理。初始筛选下 kill 变异出现运行超时，未确证挂起根因、不计断言红；改成显式正向筛选+skip并补 synthetic 清理后完整重跑10红，原始仓库未变异。最初 Node wrapper 仍断言23个原生测试而失败，更新为24后完整重跑。

`test:fast`2056通过/43跳过（含check/build）、smoke101、双typecheck/diff-check通过。WSL Debian Node22.22，私有63文件逐字节核验，九套94=76通过/18平台或挂载权限跳过，副本清理；初始 WSL 命令转义/路径转换失败没有执行测试，修成独立脚本与禁MSYS转换后全量通过，仅清掉本轮自有空目录。无真实项目采集/Key/供应商/真实Docker/浏览器/生产操作；历史6美元未结算预留非账单、全部AC pending、不合并发布不变。

### 5.42 实际 turn 执行器等待异步采集（不开放 Windows 采集）

实际 `agent-executor` 的执行前挂点改为 `await captureTurnCheckpoint(...)`，兼容现有同步结果。根因是旧挂点把 Promise 当作普通结果：异步采集尚未结束就 `startRun`，且无法取得完成后的 checkpointId；不能直接把 §5.41 异步链接到旧挂点。新挂点等待采集结果或拒绝后才继续：成功仅接受 `captured===true` 且有 checkpointId，拒绝/空结果/异常继续用户 turn 但不伪造关联。复用原有实际 worktree、完整 prompt/投影 images、fresh/resume 及原 session 输入，不重扫、不改 fresh。

- 等待期间的用户停止在 `startRun` 前重新检查。停止走既有“未启动”异常清理：不创建 provider run，恢复已 claim 的 resume 行（不推进 cursor、不 poison），保留已完成 checkpoint 的关联，注销工具回调；消息沿用既有 failed+cancelled 证据，task 为 cancelled，不增加 failedReplies/failedCount。
- 不增加 `Promise.race` 或等待超时回退：放弃等待而允许仍运行的 collector 在后台落盘，会破坏执行前时序/引用清理。异步 collector 必须自行实现受限期限和关闭完成；本段不提供无法终止 collector 的硬超时或立即取消。等待期间 turn 可能持续停留在准备阶段，用户停止须等采集 settle 才完成清理。
- **生产服务仍返回原同步 collector，Windows 能力门继续关闭**；这里只修正实际执行器与异步采集服务的接口契约，未连接 §5.41 候选到生产服务。外置 Git/全局忽略/session 原生读取/配额引用事务/容器映射仍待完成，不能将本段宣称为 Windows 日常采集或 AC 通过。

作者验证：Windows10 build19045/x64、Node24.13.1；在真实执行器测试中注入 deferred collector、mock startRun/store。fresh/resume × 成功/拒绝/异步异常/空结果/等待中停止/停止后异步异常，共12种，旧挂点全部先在“采集未 settle 已启动 run”断言失败；修正后两套 `session-reuse-ab`/`agent-executor-hook` 合计63=61通过/2 Linux能力或SQLite场景跳过。断言在生产 catch 外，通过 entered latch 和 setImmediate 观察顺序（不依赖 sleep 毫秒猜测）；检查实际 worktree、模式/prompt/session一致、checkpoint→message 关联、回调释放、未启动无 runId、resume claim 精确恢复及取消不增加失败数。首轮新断言曾错误把用户停止计入 failedReplies，按既有取消语义修正测试后完整重跑，未改变生产计数规则。

私有 preloader 仅在独立测试进程内替换编译模块字节，3个非等价变异（删 await、删 stop 守卫、丢 checkpointId 赋值）均断言红；仓库源码/build未变异，SHA核对原编译文件不变，preloader临时目录已清理。`test:fast`2069通过/43跳过（含check/build），smoke101、双typecheck/diff-check通过。没有 Linux 独立复现或真实异步 collector 落盘证据；mock startRun 不执行 SDK/供应商，不冒充 Docker/UI/真实 turn 验收。本段零真实项目采集/Key/供应商/真实Docker/浏览器/生产操作；历史6美元未结算非账单、全部AC pending、不合并发布不变。

### 5.43 异步采集项目租约与显式同步提交（开启门仍关闭）

新增内部 `withAsyncProjectWriteLease(root, projectId, action)`，为后续 Windows 异步 collector 的读→分类→持久化提供互斥边界。**旧 `withProjectWriteLock` / `withDelegatedProjectWriteLock` 仍只允许同步调用栈，不能传异步 action**：其 `finally` 会在返回 Promise 时释放文件锁/重入标志。作者独立临时目录探针确认：旧同步 wrapper 中 action 尚在等待时锁已不存在，另一个同步 writer 已能执行；这是未来异步接线的兼容性危险，不声称当前生产同步 collector 已发生该竞态。

- 新 wrapper 在调用 action 前取得既有 owner 租约，整个 action（含所有 await）持有 `.writer-lock`，但**不把跨 await 的占用加入 `held`**。普通策略写入、封存、回收及其他进程仍失败 `capture_writer_busy`，不排队、不重试。不同项目可独立进行；嵌套 async wrapper 不隐式借用原租约。
- action 得到的 `writeSync(work)` 只在明确的同步调用栈中借用原 owner，允许既有同步 writer 重入；每次均复验 owner 与 recovery gate。同步提交内安排的异步回调不继承重入资格。action settle 后，在任何 cleanup await 前吊销该 closure，完成后或清理中调用均拒绝。
- `writeSync` 返回 thenable 为编程错误：固定 `capture_lock_async_commit`，立即观察返回任务的 rejection，等待该任务 settle 后才释放租约；即使 action 吞掉这个错误，也不得报告成功。此等待期间 closure 已吊销、普通 writer 仍 busy。**不是异步提交支持**，不能发现或终止未返回的 detached 任务；可信调用者必须在 action settle 前 await 自己启动的所有 helper 至真实 close，不能用 Promise.race 假装取消。没有硬超时、通用进程树隔离、任意闭包沙箱或有界未返回任务的承诺。
- 新 wrapper 的本进程 live 标志使离线 recovery 即使收到 `writersStopped:true` 也不能退休尚未 settle/drain 的该 action；这不是跨进程 fencing，其他进程的恢复仍依赖人工确认所有 writer/子进程停写。owner 不匹配/释放失败时保留 fail-closed 锁；wrapper 结束后，既有显式离线检查/恢复路径可用，不自动删锁、按年龄/PID回收或递归清理。
- **无生产 collector/管理开启接线**，既有同步 writer 与 supervisor lease 行为保持，Windows 能力门继续关闭。此 API 不授权目录、开启采集或豁免配额/秘密扫描；只协调遵循租约的内部 writer，底层 store 写入原语仍要求可信调用者提供锁与容量门控。外置 Git、session、真实 turn checkpoint、完整配额发布事务、容器映射均未完成，不构成 AC 通过。

作者测试使用独立临时目录与有界子进程：新 API 初始12例在旧模块缺导出先红；新增原生 Windows 连接例为自建 NTFS Git 子集（测试侧 Git 禁全局配置、ignorecase=false），在异步租约内调用 §5.41 真实 Python 链，显式同步测试 writer 提交 CAS/checkpoint，恢复两次清单相同。文件脏改/untracked 可恢复、秘密不恢复、策略保持 disabled、完整性/严格资格仍 false。该 writer 不是真实执行器采集、不开任何真实项目；配置保存/封存/GC被阻断的探针只验证互斥，不代表这些产品链路已验收。`test:badcase-locks` 纳入 fast，避免扩长 Windows 主命令。最终 Windows10 build19045/x64、Python3.13.5、Node24.13.1：新套15/15，writer-recovery/async-writer/GC/expiry/sealing-lifecycle/run-references六套92=86通过/6跳过；fast2084通过/43跳过（含check/build），smoke101、双typecheck及diff-check通过。WSL Debian Node22.22私有35文件逐字节核验、同六套92=91通过/1 Windows原生跳过，测试后字节不变且副本清理；首次WSL路径被Git Bash转换而未执行，改禁路径转换；第一次Linux副本漏两CLI导致2失败，补齐后最终全套重跑，不计初次通过。10个进程内preload非等价变异（提前释放、跨await放held、不drain、不吊销、吞误用、删live recovery守卫、不释放、删thenable检查、删owner复验、漏function thenable）全部断言红，均无超时/取消/语法或补丁失败；未修改仓库源码/build，编译文件SHA核对不变，最终干净新进程复绿。日志及可复验变异脚本仅在忽略临时目录，不作为新用例现场或实际turn性能证据。

### 5.44 预备检查点的配额发布步骤（内部连接，非开启采集）

新增内部同步 `publishPreparedCheckpoint({store, checkpoint, blobs})`，供异步 collector 在 §5.43 的 `writeSync` 内调用。它不读取目标树、不生成回放输入、不授权目录、不安装或重新 pin，也没有服务/HTTP/agent 接线；**生产 collector 与 Windows 开启门保持不变**。可信调用方仍负责根授权、候选分类、执行前时序及完整 fresh/resume 材料准备，并须 await 所有 helper 至真实 close；不能用本接口绕过这些义务。它不是任意调用方的 manifest 安全沙箱、异步任务取消器或完整 Windows collector。

- 发布全程沿用项目同步 writer 锁；若外层持有 async lease，只有显式 `writeSync` 栈可借用。等待中的其他保存/发布/GC仍 busy。锁内重读当前 policy，非 enabled 拒绝，不依据调用方旧策略启用。只接受 staged、schema-v1 引用闭包及 `strictEvalEligible:false`；true 拒绝而非静默降级。模式、缺失 session、限制说明与 complete 状态按可信预备清单原样保留，不补造材料或升格资格。
- 脱离调用方清单，按 `checkpointBlobHashes` 枚举文件/prompt/session/config/skill 共享 CAS 闭包；不接收无引用 blob 计划。所有新计划先复制、核 hash/秘密；所有既存 CAS hit 也校验实际字节 hash/秘密，而非只比尺寸。文件 size 必须匹配，清单本身也过秘密哨兵。材料无效时零 staging/manifest 写入。验证器沿用 schema-v1 已知引用，不构成全字段语义来源证明。
- 去重后的缺失 blob + 最终 JSON + latest 增量计量；自报 stats 用有限定点迭代，收敛后才允许 staging。latest 缩短时 stats 使用有符号实际增量，但配额仍预留 manifest 已写、latest 尚未缩短时的逻辑峰值。预检、逐 stage（显式计入尚未提交字节）及 CAS 提交后复检均保留；等于上限可写，多一字节拒绝。口径仍是 `computeUsage` 的已提交逻辑字节，不是物理可用空间：policy/staging/临时文件不在其清单内；预留 staging 字节不等于操作系统磁盘空间预留。
- CAS 提交后再次校验闭包，再保存 checkpoint，**最后**保存 latest，全部成功且 staging 清理成功才返回 captured/checkpointId。同 ID 已有文件即冲突，包含损坏 JSON，不覆盖旧证据。配额/写入/清理失败返回固定原因、空关联 ID，并尝试 suspended；若磁盘已不能保存 policy，无法保证 suspended 持久化，但仍不得报成功或透传异常正文。
- 多对象发布不是全局原子事务或掉电持久化保证（沿用 store 的逐文件临时写+rename，没有增加 fsync/journal）。失败前已提交的 CAS 不盲删，可由既有显式 GC 发现未引用对象；若 checkpoint 已落盘而 latest 失败，保留其 staged 清单保护引用，不给 turn 伪造成功关联。清理失败即使发生在 latest 成功后也撤销本次返回成功，已有引用不删除。进程崩溃锁/临时残留仍走既有人工离线处置，不自动恢复或清除。存储/同 OS 用户为 TCB，锁不是对任意 raw store 写入者的 fencing。

作者验证：Windows10 build19045/x64、Python3.13.5、Node24.13.1。初始21例对未实现 stub 全断言红；最终新套29/29，覆盖去重与已有 CAS、精确字节及额度边界、signed latest 增量/缩短前峰值、坏材料/秘密/严格资格/策略/ID冲突、同尺寸 CAS 损坏、stage/commit/manifest/latest/usage I/O 注入、已落盘后异常、末次配额与清理失败，以及 async lease 等待到发布的 GC 竞争。真实 Windows 自建 NTFS Git 树经 §5.41 异步 Python 候选→该发布步骤→两恢复；dirty/untracked 可恢复、秘密不入 CAS，resume 缺 session/complete=false/strict=false 原样保留。仅该临时夹具直接设测试策略 enabled；没有管理开启/真实项目授权、真实 turn/SDK/浏览器证据，不升级 AC2/AC9。

七套 publication/async-writer/writer-recovery/orphan-gc/checkpoint-expiry/sealing-lifecycle/run-references：Windows121=115通过/6跳过；WSL Debian Node22.22私有37文件逐字节核验同七套121=119通过/2 Windows原生跳过，测试后字节不变、副本清理。14个进程内 preload 非等价变异最终全部断言红（锁、额外计划、新/旧hash、清单秘密、size、strict、policy、冲突、配额边界/末检/缩短峰值、cleanup、末次hash），仓库源码/build未变异、编译SHA不变、干净进程复绿。初轮新计划hash变异被不同长度测试数据的size检查遮蔽，改为同尺寸坏字节后杀死；冲突变异第一次匹配编译标识符的子串导致语法错误，不计红，修正完整标识符后完整重跑14点。最终 fast2113通过/43跳过（含check/build）、smoke101、双typecheck/diff-check通过。零真实项目采集/Key/供应商/真实Docker/浏览器/生产操作；外置Git、session原生读取、实际turn接线、容器映射等仍待完成，历史6美元未结算非账单及全部AC pending不变，不合并发布。

### 5.45 Windows 独立授权的精确 session 文件读取（内部连接段）

新增 `windows-session-input.ts` 的 `readWindowsSessionInput`，**尚无 collector/服务/HTTP/agent/开启接线**。这只补 resume 输入的安全字节读取；不代表 session 格式/历史/附件/配置依赖已经验证、归档或可回放，也不改变 deliveryMode、complete 或严格资格。生产 Windows 门继续关闭，现有 Linux 输入路径不改。

- 仅查当前 `authorizedInputDirs` 仍列出的 `authorizedInputPins`；worktree 授权或孤立 pin 不算独立输入授权。不安装 helper、不新建 pin、不以当前身份替换原 pin。目标为本地盘符绝对路径、根内单个小写 `.jsonl` 后缀文件（最多64层）；无 glob、目录展开、批量 paths 或树外跳转。重叠输入根按列表首次匹配，缺/坏 pin 拒绝，不搜索其他根以绕过失败。
- 宿主 realpath 仅做元数据名称/保护根拒绝，不替换 literal helper 目标；存储及显式 privateDirs、当前进程 PI_AGENT_SANDBOX_DIR/PI_AGENT_PRIVATE_DIR 的 literal+canonical 路径禁止作为输入。非本地路径或非 ENOENT 的保护根解析错误失败关闭，尚不存在的保护根仍按 literal 禁止；不宣称自动发现所有 agent 私有目录。session 可位于独立授权的普通 agent 会话目录，所以不以整个 agentDir 为私有边界。调用方须提供其他已知私有目录；凭据秘密排除仍是既有哨兵策略，不是万能探测器。
- 原生新增闭集 `sessionInput:{version,op,root,expected,path}`，语法在根打开前验证；原根身份先于任何 session 子对象。每个相对组件只查询已持有父目录的名称表，精确命中磁盘名后才相对句柄打开，拒大小写/8.3 别名，不走 Root.walk 或打开无关子树。每层名称表最多100000项，可能观察同层其他名称，但不会返回这些名称、打开它们或枚举其子树。真实无关 junction 不妨碍选定文件读取；被选路径的 junction 仍拒。`_canonical` 仅进程内参数，wire 带该字段拒绝。
- 同一原根句柄两次精确内容读，比较叶身份、长度、hash；每次保留既有同句柄变化检测/不分享 DELETE/重解析拒绝/NTFS 与大小写语义检查。单文件64MiB，任何失败只给固定错误头、零 body；成功响应只含原根身份及一个 file，不含全树 entries。宿主复验闭集、根 pin、同卷叶身份、路径、长度、hash、精确收尾。不是原子快照：跨读 ABA、身份复用/元数据窗口残余不消失，不能升级 strict。
- `invokeWindowsSessionHelper` 与 Git transport 使用同一个私有受限实现和每模块2活跃子进程名额，但**各自 op 接受集合互斥**；Git 不接受 sessionInput、session 不接受 Git/其他 op。继续固定源码 SHA、`python -I -B`/stdin、输出界限、25秒绝对单调观察期限、按子句柄 kill 并等 close 才归还名额；保留历史 `git_capture_*` 低层固定标签，适配器只给固定 session 原因，无异常正文。共享的是名额与终止，不是全服务全局限额或进程树沙箱。同步 transport 为新 op 同样限25秒，但适配器不调用它，不重试/同步回退。
- 适配器在 scope、helper 返回后及最终复制后复查同一期限；晚到结果不读 body。秘密命中或非法 UTF-8 不返回字节/hash/身份；成功仅给独立非池化 Buffer 的**原始字节**（UTF-8 解码只验证，不损失 BOM/CRLF），不归档、写 CAS 或解析 session。同步 fs/解码不可抢占，OS 不 close 仍等候占额，不承诺硬25秒/立即取消、不可变执行证明或安全擦除内存；解释器、同 OS 用户及存储仍是 TCB。

作者验证（Windows10 build19045/x64、Python3.13.5、Node24.13.1）：三项原生新测在旧实现均因拒绝未知 op 先红；最终原生27/27。Node新套9/9：闭集/坏 body、根/叶字段、互斥 op/共享名额/kill非close/迟到、独立输入授权/路径与保护根别名/秘密/非法UTF8/非池化 backing/三阶段期限。真实自建 NTFS session 通过管理授权持久原 pin→新 async helper→原字节，替根/junction/秘密拒绝；policy保持disabled，零 CAS；不是合法 resume session 完整性或真实 turn 证据。Windows十二套145=115通过/30跳过；WSL Debian Node22.22私有28文件逐字节核验七套55=38通过/17原生Windows跳过，测试后字节不变，宿主私有源与Linux副本清理。

7原生+11Node非等价变异最终18点全部断言红（canonical、第二读、hash/叶身份、大小、根pin、JSONL限定；独立授权表、pin路径、保护根、秘密、UTF8严格、backing、三期限、wire根pin/hash）；原生私有副本逐字节恢复27/27并清理，Node仅进程内拦截编译模块读取、磁盘SHA不变，干净进程复绿。流程披露：最初 native 观察器把根祖先打开也计作 session 子项，修正为明确祖先清单后通过；真实 Node 测试误用不存在的 usage.blobBytes，改核 bytesByKind.blobs。初轮部分 native 变异返回成功 body 导致测试 JSONDecodeError，只作诊断不算断言击杀，改拆 header/body 对象断言后重跑全7红；Node wire-hash 补丁首轮匹配旧/新两处而拒绝，加入 session 分支上下文后重跑全11红。首次 WSL命令被MSYS路径转换导致未执行，以禁转换完整重跑。最终fast2122通过/43跳过（含check/build）、smoke101、双typecheck/diff-check通过。零真实项目采集/Key/供应商/真实Docker/浏览器/生产；外置Git、共享输入准备/依赖验证、实际turn落盘接线与容器映射仍待完成。历史6美元未结算非账单与全部AC pending不变，不合并发布。

### 5.46 共享回放输入准备与 Windows session→发布连接（内部连接段）

- `replay-input-preparation.ts` 从 Linux collector 抽出既有 prompt/受控替换、session-validator、runConfig、harness 与 skill 准备规则；同步 collector 仍经原受限读取边界传入 reader，不改工作根授权、采集时序、文件扫描或能力门。新共享函数不读取路径、不授权、不发布，reader 是可信内部接口，不能当作 agent 授权入口。
- `windows-replay-input.ts` 只作内部异步准备：进入时 structuredClone 固定调用材料并锁存 authorizedRoot，resume 且 sessionPath 非空时恰调用一次 §5.45 的独立授权 reader，fresh/缺路径不调用；前后复查同一单调 25 秒观察期限，迟到材料不消费、复制/同步校验后超时不给计划。reader 异常固定为 session_input_unavailable，不重试、不同步回退、不降 fresh。同步 clone/解析/hash 不可抢占，原生 helper 的 kill→close 语义不变，不宣称硬 25 秒清理。
- 历史断链/坏附件/未知结构拒归档；格式合法但图像、扩展状态、bash 或树外工具依赖未验证时可以归档原材料，但 complete=false，维度原样保留，不推定依赖已保存。调用级 images 仍只记数量、不归档。保留 toolBridgeEnabled 等完整配置，不剥配置伪装可支持。
- 共享层新增严格 UTF-8：旧 collector 的 toString('utf8') 会把 JSON 字符串中的坏字节替成 U+FFFD 后归档；现在 session_utf8_invalid、无 session hash/计划、仍为 resume。私有探针从父 SHA 提取并转译原函数，18 个合法 UTF-8 用例的清单/计划逐字节一致；同一坏字节用例证实旧实现 complete=true 且归档，新实现拒绝。所有返回计划均 Buffer.alloc 独立 backing，避免继续持有可能含被排除材料的共享池；不宣称安全擦除。
- Windows reader 仍先拒原始秘密与坏 UTF-8，因此已含真实秘密的 session 不会为了受控替换而放行；共享替换不是秘密扫描豁免。输入/harness 来源仍属调用方声明，authorizedRoot 参数不代表本函数已授予文件树采集权限；输入维度 complete=true 也不升级 checkpoint 的 strictEvalEligible。
- 验证：新接口旧构建缺模块时初始 14 例全红（接口红，不冒充历史语义回归）；最终新套 17 例，Windows 16 通过/1 Linux 跳过。自建 NTFS 临时 session 经独立管理 pin→原生读取→共用校验→测试 writer 租约/配额 publisher→重开 store，resume、CRLF 原始字节及 hash 保留；源 session 改坏后新准备不完整、旧 CAS 不变。测试直接设置 writer enabled，不是管理开启，也不是实际 turn。Linux 另经真实 collector 检查坏 UTF-8 不归档；WSL Debian Node22.22 私有 36 文件哈希核验，五套 133=129 通过/4 平台或权限跳过，测试后字节不变并清理。
- 私有进程内 10 单点变异全断言红：有损解码、秘密守卫、未验证维度、共享池 backing、结构归档门、受控替换、模式、await 前 clone、await 后期限与最终期限；源码/build 磁盘字节不变，干净进程复绿。Python/helper/内嵌源码均未改；Windows 原生 27/27，Windows 输入相关八套 72=71 通过/1 Linux 跳过。完整 fast/typecheck/build/smoke 结果记 Goal，不以测试数替代功能证据。
- **仍无 Windows turn collector/服务/管理开启接线**；外置 Git、全局忽略、core.ignorecase=true、输入依赖与附件真正归档、删除历史、真实工作树采集、Docker 路径替换/工具桥仍待完成。Windows 采集门保持关闭，全部 AC pending。零真实项目采集/Key/供应商/Docker/浏览器/生产，不合并发布；历史 6 美元未结算预留非账单保持。

### 5.47 Windows 文件/输入/发布的单租约组合（内部执行器注入，管理门仍关闭）

`windows-turn-collector.ts` 提供内部 `createWindowsTurnCollector`，将原生本地 Git 子集候选、独立授权 session 输入准备及预备检查点发布串成一个异步操作。**服务仍选择原 collector，Windows 管理 estimate 的 `captureAvailable=false` 与开启拒绝不改**；本段不授权或开启任何真实项目采集。后续生产选择该实现须另经固定 SHA 审查。

- 第一处 await 前 clone 全部调用材料并固定驱动器号绝对工作根；显式 fresh/resume 之外的模式拒绝，不默认降 fresh。策略在项目 async 租约内重读并 clone，必须 enabled；租约跨文件与 session helper 的真实 close，一直到显式 `writeSync` 调 publisher 完成及释放成功后，才能给执行器返回 checkpoint ID。普通策略写、封存、GC 与另一 collector 在 await 中仍 busy；释放失败即使清单已落盘也不返回成功关联，不盲删持久证据。
- 文件候选、输入准备及精确 session 读取接受可选的内部绝对单调 deadline：仅有限 number，取 `min(本层开始+25秒,外层deadline)`，不能延长旧上限；组合层共享从入场起的同一个 25 秒观察期限，读后迟到材料不消费，发布前逾期不写。同步 scope/clone/解析/最终 CAS 与 JSON 写不可抢占；**最后期限检查在发布前，已进入同步发布的写可能超过期限，不能事后伪造回滚或宣称硬 25 秒终止**。helper 的 kill→close、两名额与无同步回退语义不改。
- `privateDirs` 是可信宿主配置而非 turn 输入。文件 scope 增加显式私有根 literal+canonical 排除，与存储、agentDir、当前 sandbox/private 保护并行；坏格式/包含目标的私有根拒绝，遇 junction 不以 realpath 替代 NT 目标。它不自动发现同机全部私有根，也不是万能秘密检测器。
- schema-v1 清单保留关联 ID、完整 harness、session 模式与原字节；文件 blob 与输入 plans 一起交原 publisher 做引用闭包/秘密/hash/配额复验。`replayInput.complete=false` 恒定，并添加 `windows_capture_subset_unverified`，秘密文件另外列出排除路径；`strictEvalEligible=false` 不变。删除列表仍为空，不把策略排除/未知旧现场推断成删除；原有缺口（全局 Git、外置 gitdir、未验证配置、空目录、mode 合成等）不被组合动作抹除。`content-verified` 仅表示候选链未检测到变化，不是原子或独立一致性证明。
- 原生组合证据仅自建 NTFS Git/session 夹具（独立管理授权 pin 后用测试 writer 设 enabled）：真实 helper→共享校验→单租约 publisher→重开存储→两恢复清单一致；秘密不进入 CAS、resume/CRLF 保留、整体仍 incomplete。执行器测试注入此内部 collector，验证 fresh/resume 的实际 `agent-executor` 在 mock `startRun` 时清单已在磁盘，发布写失败继续 turn 但不关联旧/latest checkpoint。mock runtime/聊天 store 不是真实 pi、生产服务选择、用户 UI 或普通 CAFF Docker 回放证据；不构成 AC 通过。

### 5.48 Windows 外置 Git 固定输入原生读取（独立授权前置段，未接分类）

新增内部 `readWindowsGitMetadataInput({metadataRoot,metadataPath,policy,captureRoot,privateDirs,deadline})`，为后续 worktree 外置 Git 分类提供受限字节来源。**不自动发现或追随 `.git`、`gitdir`、`commondir`，不执行 Git，不解析配置/index，不归档、不写 CAS；尚未被 Git 候选/collector/服务调用**，现有本地 Git 子集仍拒外置元数据，Windows 开启门不改。

- `metadataRoot` 必须本身精确列在 `authorizedInputDirs`，且有与该根一致的原生 `authorizedInputPins`；worktree 授权、孤立 pin、只授权父目录均不足，不安装 helper 或重新 pin。未来 common 根与 worktrees/id 根需分别显式授权；此接口不因指针内容扩大范围。当前复用输入根授权表，不新增自动授权/UI 回执。
- 新闭集 op `gitInput:{version,op,root,expected,path}`，path 仅为 `config/index/commondir/gitdir/config.worktree/info/exclude` 六个精确值；根打开前验证，拒任意 paths/目录展开/大小写与8.3别名。语法先于根打开、原根身份先于后代；复用逐父名称表精确门控及两读身份/size/hash，零 Root.walk，不打开无关子树。允许原生 `.git` 目录作为**独立授权的输入根**，不取消 estimate/树扫描的 `.git` 排除。缺文件仍失败，不把任何错误猜作“可选文件不存在”。
- 宿主 realpath 仅用于拒别名，不替换 literal 原生根；存储、显式 privateDirs、当前 sandbox/private 的 literal+canonical 根禁止，坏私有根或非 ENOENT 解析错误失败关闭。只保护当前显式配置，不宣称发现其他私有目录；同 OS 用户/解释器/存储仍为 TCB，秘密哨兵不等于万能探测。请求 pin 在 await 前独立复制，调用方后改 pin/名称不更改本次请求。
- `invokeWindowsGitInputHelper` 的接受集合仅 gitInput，与 session/Git 树 op 互斥；共享源码 SHA/大小检查、两活跃 helper 名额、`python -I -B`/stdin、单文件64MiB、32MiB头+128MiB body、同一较早绝对25秒观察期限及 kill→close 归还。不是全服务名额或进程树沙箱；同步 fs/复制不可抢占，OS 不 close 仍等待，不承诺硬期限。新源码须经既有显式授权安装；旧安装不自动修复或重 pin，无重试/同步回退。
- 复用单 file 响应的宿主闭集/根pin/同卷叶身份/精确路径/长度/hash/收尾复验。秘密命中不给字节/hash/身份；成功只返回独立非池化原字节 Buffer，**不作 UTF-8 转换**（index 是二进制），后续分类必须另验证文本/index与指针语义。跨读 ABA、非原子与身份复用残余仍在，成功不改变 complete/strict/captureAvailable。

作者证据仅自建 Windows10 build19045/x64 NTFS（Python3.13.5/Node24.13.1）：新增原生三项在旧 op 先红；Node 初八例旧构建全红（前两项为协议断言，其余为缺新模块/函数）；最终原生30/30、新 Node9/9（含 await 请求锁存），十套98=97通过/1 Linux跳过。独立管理 pin→读取二进制 index/CRLF exclude，原根替换/junction/秘密拒绝，disabled/零CAS/零checkpoint；不是真实外置 Git 分类、实际worktree或turn证据。WSL Debian Node22.22私有43文件逐字节核验十套190=176通过/14平台跳过，测试后字节不变并清理；不以Linux合成用例代替Windows证据。

5原生+12Node单点变异最终17点全部断言红，原生私有副本字节恢复后30/30且清理，Node仅进程内拦截、编译磁盘SHA不改，干净基线复绿。初轮op负例仍携session不合法path，删op门存活；改合法session请求后红；删源码SHA守卫最初令mock等待不终止（看门狗超时，不计红），改错误admission时mock立即close后红；首次native身份变异仅触发JSONDecodeError不计，改拆头/body对象断言后全点重跑。最终回归数字记Goal，不以测试数替代功能。零真实项目采集/Key/供应商/Docker/浏览器/生产，全部AC pending，历史6美元未结算非账单、不合并发布；外置指针绑定/分类、全局忽略、core.ignorecase=true、删除历史/附件及服务开启/容器映射仍待完成。

### 5.49 Windows linked-worktree 外置 Git 指针绑定与分类（内部候选，服务门仍关）

`readWindowsGitFileCandidateAsync` 新增可信调用方可选的 `externalGit:{metadataRoot,commonRoot}`。只支持 linked-worktree 的有限布局：工作根 `.git` 为普通 gitfile，metadata 根有 `commondir/gitdir/index`，common 根有 `config/info/exclude`。**本轮将 §5.48 的读取接入实际文件分类，不新增服务/collector 的外置根选择或管理开启；不自动发现或保存选择，不开启真实项目采集。** 同步候选收到该选项立即 `git_external_async_required`，无同步回退；不提供选项仍沿用原本地子集及外置 gitfile 拒绝语义。

- async 入场在第一次 await 前 clone 所有 options，固定工作根、两个选择根、策略与 pin。两个外置根各自必须精确独立授权且保有原 pin；worktree 授权、父目录授权、孤立 pin、相同的两个根、工作树内根、UNC/驱动器号相对路径均不足。原 reader 对每次实际读取再检查 literal+canonical 保护与原生身份；agentDir 也作为私有根传入，不重新 pin、不安装 helper。默认 `.git` 排除不被覆盖，排除导致 marker 不可用时明确拒绝。
- 原生 `gitMetadata` 已能返回普通 `.git` 文件，本轮不更改 Python/helper/协议。gitfile 必须精确 `gitdir: ` 前缀；所有指针为严格 UTF-8、最多32768字节、仅一行（可有一个 LF/CRLF 结尾），拒空白边界、控制字符/BOM、UNC、根相对及驱动器号相对路径。允许绝对驱动器路径或相对路径，以相应基目录做纯 win32 词法归一化，按 Windows 不区分大小写比较到**预选根**：`.git`→metadataRoot，`commondir`→commonRoot，`gitdir`→当前工作根/.git。指针只作比较，绝不作为授权、helper 目标或新读路径；先核两个授权与 gitfile，再依次核 commondir/backlink，之后才读 config/index/exclude。
- 五固定源均必需；**缺 info/exclude 也拒绝**，不把任何错误猜作可选不存在。每组累计最多128MiB（另受既有每文件64MiB、指针32KiB约束），全部来源过秘密扫描后才解析。config 复用原有限语法，include/excludesFile/未知 extensions、worktreeConfig、core.ignorecase=true 等仍拒绝，不读 config.worktree 或全局 Git。二进制 index 复用独立 checksum/stage/mode/路径校验，缺/坏元数据无全采回退。
- 将已绑定的外置 config/index/info-exclude 与原工作树 `.gitignore` 投影到原有分类器，先得精确选择，再调用 selectedSnapshot；只投影分类材料，不把外置元数据归档为文件 blob。保留 tracked mode、忽略规则、显式 ignored 纳入、秘密剔除及独立 backing。选择前后纳入范围的工作树非 Git manifest 和 gitMetadata 签名仍复核；普通内容选读后再次读取五外置源并比较字节摘要。初始外置源在分类后只保留摘要，避免跨内容采集继续持有一组源 Buffer；不宣称安全擦除。
- 全链含最多13个 helper 调用，复用同一较早25秒观察期限、两活跃名额、kill→close；任何阶段失败或迟到立即停止，不消费迟到正文、不返回部分计划/秘密/内部异常文本。非原子与 ABA 残余仍在，尤其外置 reader 不跨调用返回叶身份，前后仅字节摘要比较，不能证明同一叶对象或全源同时存在。同步 clone/fs/解析不可抢占，不承诺硬终止。
- 成功仅 `bounded_external_git_subset_v1`，`complete/strictEvalEligible/captureAvailable` 全部 false。全局忽略、未支持配置、删除历史、空目录、会话/附件、服务选择与容器路径映射未因此完成。删除 tracked 项仅在当前文件集合中缺席，不冒充已采集删除历史；untracked mode 仍合成0644。

验证使用自建 Windows NTFS linked-worktree，临时 Git 操作仅用于建立夹具及 `ls-files` 分类 oracle（采集路径本身不执行 Git）：分别显式管理 pin 两个输入根，分类 dirty/tracked/untracked/显式 ignored/info-exclude；测试 writer 将安全 blob 入 CAS，保存不完整夹具清单并两次恢复一致，秘密不恢复、缺失 tracked 项不出现。策略仍 disabled，不是真实项目或真实 turn；缺 exclude、默认 `.git` 排除、worktreeConfig 与指针变更均拒绝。闭集授权/指针、五源前后变更、10次外置读取逐次失败及迟到、等待中篡改选择等由隔离 VM 测试覆盖；128MiB累计上限通过小限额注入验证，不冒充真实大文件写入。首批8项在旧代码7项断言红（含原生布局拒绝）/1项消极负例绿；后补该负例必须实际到达外置指针读取的断言，另补累计限额/逐阶段故障及工作树内根覆盖；最终测试/变异及独立审查结果记 Goal。全部AC pending，零真实项目采集/模型/Key/供应商/Docker/UI/生产，不合并发布；历史6美元未结算非账单不变。

### 5.50 Windows 外置 Git 持久选择、授权表单与服务 collector 接线（管理开启仍关）

策略新增可选 `windowsExternalGit` 数组，旧策略缺字段视为 `[]`；每项闭集 `{worktree, metadataRoot, commonRoot}`，最多32项。只接受驱动器绝对路径，拒控制字符/BOM/首尾空白、重复 worktree、相同双根、位于 worktree 内的元数据根。`worktree` 必须精确列在文件授权中，两元数据根必须各自精确列在独立输入授权中；父目录授权不替代精确授权。这里只做词法选择，**不是授权、pin 或指针发现**；每次实际读取仍经§5.48–5.49的原生身份、别名/私有根、字节及指针绑定复验。

- 本地管理 `authorize` 闭集接受此数组；省略视为清除选择。校验先于保存/授权 I/O，非法返回固定 `capture_external_git_selection_invalid`/422；settings/enable 不接受选择。表单独立 JSON 输入在确认框展示，打开/切换只读、坏 JSON 不发请求、编辑使预估回执失效。重新授权仍先 disabled，再独立 pin 所有明确列出的根。普通 service 保存只保留已有 pin，不接受传入伪造 pin；选择发生规范化后的变化强制 disabled，不能通过改变选择沿用 enabled 状态。移除授权根而未清理关联选择会拒绝保存，不静默扩大或隐式删除选择。
- Windows 服务选择原生 async collector，Linux/darwin 保持既有路径；没有 Windows 失败后回退 Linux、WSL、Node 文件读取或全采。executor 已在§5.42等待返回 Promise；其他直接调用者必须 await（Linux 仍可同步）。collector 锁内重读/clone 策略，只按实际 `targetDir` 精确选择，不从 invocation 的 `externalGit` 或 gitfile 自动发现根，不把同项目选择借给子目录/其他 worktree。共享25秒观察期限/项目租约/发布及失败不关联旧 checkpoint 语义不变。
- **管理开启保持关闭**：Windows estimate 仍 `captureAvailable=false`，不发 enable 回执；授权和选择不自动采集。本节测试仅在自己创建的临时 NTFS fixture 通过 raw test writer 设 enabled，不是用户真实项目授权或日常 turn。默认 `.git` 排除仍不被覆盖；未验证配置、全局 Git、常见 `core.ignorecase=true`、worktreeConfig、删除历史、附件归档和容器映射等仍缺。complete/strict 恒 false，不能称可完整回放或任何 AC 通过。
- E110 P3 收编：对 gitfile/commondir/gitdir 各置入5种控制/BOM字符于 `/<字符>/..` 可被 resolve 消除的段，先断言规范化后命中授权根，再证明在选择/外部内容读取前拒绝。另覆盖解析后本可命中的盘符相对/根相对指针和新策略同类控制字符；没有放宽生产接受集合。

作者验证（Windows10 build19045/x64、Python3.13.5、Node24.13.1）：新选择接口/collector/服务与管理 UI/API先在父构建失败，最终Windows十二套112=111通过/1 Linux跳过；HTTP/UI两套45=44通过/1 Linux跳过。自建 linked-worktree 经真实管理pin→保存选择→重建服务→fresh/resume 原生异步文件与session采集→真实publisher→两次恢复一致；保留CRLF/mode/秘密剔除、无外置元数据恢复、wrong-root失败不新增检查点，管理预估不给回执。一次诊断两模式合计1707ms/提交占用7864B，仅小夹具，不是实际turn容量或UI浏览器证据。兼容七套195=125通过/70平台能力跳过。WSL Debian Node22.22私有47文件字节核验十三套227=211通过/16平台跳过，测试后字节不变并清理。15语义变异最终断言红；单删pointer trim在现有夹具存活（规范化根比较仍拒绝），明确不计红；nested首轮被缺输入授权遮蔽，补精确授权后检出再完整重跑。编译/UI磁盘字节不变，干净基线复绿。fast2182通过/44跳过、smoke101、双typecheck/build/check/diff-check通过。初次fast仅旧同步测试观察Promise的reason失败，改为await断言后完整重跑；管理负例误含采集存储祖先先被旧目录守卫拒绝，修正夹具后完整重跑。额外兼容套检出旧测试仍假设所有非Linux预估失败（与§5.38既有Windows元数据预估矛盾，estimate生产代码本轮零改动），改为Windows明确断言captureAvailable=false并核对2文件7B后复绿；S1改为明确测试不支持的Linux同步collector而非已改为async的服务。零真实项目采集/Key/供应商/真实Docker/浏览器/生产，历史6美元未结算非账单，全部AC pending，不合并发布。

### 5.51 Windows `core.ignorecase=true` 的保守 ASCII 分类投影（管理开启仍关）

§5.40/5.49/5.50 对 `core.ignorecase=true` 的拒绝在此**仅为 Windows 候选**收窄为有界支持；不是全局 Git/完整 Windows Git 支持。`parseGitConfigSubset` 增加可信调用方 opt-in `allowIgnoreCase:true`，才解析显式 true/false/yes/no/on/off/1/0（含语法合法的引号/行尾注释），返回最后合法项的 `ignoreCase`。非法值、bare boolean、反斜杠等仍使 verified=false。默认调用的接受集合与返回对象形状不变，Linux collector 不传 opt-in、不增加文件访问。

- ignoreCase=true 时，索引及原生 manifest 的**所有相对路径**必须纯 ASCII；分别检查完整路径和逐组件拼写；每组最多100000路径、每路径32768字节/64组件，深度在前缀循环前拒绝，避免不受限的二次前缀展开；上述上限不等于内存/硬时限保证。无论完整文件名冲突还是 `A/x`、`a/y` 这种父目录歧义都失败关闭。允许索引与磁盘之间无歧义的 case-only 差异：只在分类视图中以 ASCII 小写匹配 tracked 集合及 mode；文件内容不折叠。`ignoreCase=false` 保留此前区分大小写与 Unicode 路径行为。
- `.gitignore`、info/exclude 的分类文本必须纯 ASCII，且不含 `[`（包含注释/转义中的该字符也保守拒绝），不把 `[A-z]` 等范围端点直接小写误称 Git 的 casefold wildmatch。其余已验证语法在分类视图中小写，继续经过既有有界 parser；ignore 源目录、walk entry 与 tracked key 一同投影，保留深层优先级、否定、目录不深入及 tracked 例外。原生只精确读取 `.gitignore`，遇到不同大小写的 `.GITIGNORE` 等 manifest 名称也拒绝，不因新配置静默漏用来源。以上不支持项固定 `git_ignorecase_unverified`，在 ordinary selectedSnapshot 前停止，无部分 blob 计划。
- **不把投影用于路径访问或授权**：最终 selectedSnapshot selector、CAS清单路径及恢复文件名均映回原生 manifest 的精确磁盘拼写；策略 includedIgnoredPatterns 仍匹配该原拼写，不借配置改变授权/排除语义。tracked mode 从索引投影取回；untracked 仍合成0644。根 pin、私有根/秘密保护、gitfile 双根选择与指针绑定、前后复验、25秒观察期限、两 helper 名额、单项目租约及配额发布步骤均不放宽。
- 本地与显式外置 Git 复用此分类步骤，成功记录 `windows_ignorecase_ascii_projection`；complete/strict/captureAvailable 仍 false。全局 config/excludes、worktreeConfig、删除历史、附件归档、容器映射与独立一致性证据仍缺。Windows管理开启保持关闭，estimate无enable回执；不为实际项目授权或开启采集。

验证：opt-in 与默认 parser 正反例；case-only tracked mode/精确 selector/策略原拼写；索引与树的完整名及父组件冲突、Unicode路径/规则、字符类与误拼写 ignore 来源均拒绝；64/65组件边界、项数/字节小限额注入正反例（不冒充真实大输入）覆盖前缀展开的边界；八组 ASCII wildcard/否定/目录/深层规则对照真实 Git `ls-files`。自建 NTFS 本地 Git 树以两步 rename 确认磁盘 case-only 改名，再经真实 service fresh/resume→publisher→重开store→两次恢复一致，CRLF session与秘密排除保持；自建 linked-worktree 服务链改为真实 ignorecase=true 并核验限制标签。临时 Git 只用于夹具/oracle，采集路径不执行 Git；raw test writer enabled不是管理开启或用户真实turn。E111 P3补32个互异且精确授权条目通过、33个拒绝、最后一条单独通过的独立上限用例。初新接口测试在父构建两项断言红，负例原先被整体不支持阻断，随后加强固定原因与针对性变异；误拼写 ignore 来源的初始变异被重复名守卫遮蔽，改为替换而不是新增来源后完整重跑检出。原生新夹具首次仅缺自建 info 目录，修正后完整重跑。详细命令、计数、变异及独立审查见Goal E112。全部AC pending；零真实项目采集/Key/模型/供应商/真实Docker/浏览器/生产；历史6美元未结算非账单不变，不合并发布。

### 5.52 Windows 管理预估与 collector 共用受信私有根边界（开启仍关）

修复服务门面的接线遗漏：此前 Windows collector 收到 `options.privateDirs`，但同步与 HTTP 使用的异步容量预估只传 agentDir，可能枚举显式私有根内的文件元数据、把其字节数计入预估；并非正文读取或 CAS 泄露。直接调用 metadata scope compiler 的私有根校验已存在，本次补齐生产调用链，不修改 Python/helper 协议、排除算法或授权权限。

- 服务构造时，仅 Windows 创建受信 scope：固定 agentDir、structuredClone 私有根列表（未传为 []）；同一配置传给 collector 与同步/异步预估。调用方随后替换 options 字段或修改原数组，不能在后续请求/await 期间缩小保护范围或改换 agentDir。更改这组宿主配置须重建服务；不是随请求传入或持久授权的可变选择。未知/未配置私有目录不自动发现，同 OS 用户、存储与解释器仍属 TCB。
- 复用既有 literal+canonical 双重保护：私有根在 worktree 内（含外部别名指回 worktree）时在原生打开子对象前排除；私有根包含 worktree 时拒绝整个预估。私有 junction 指向树外也必须先排除而不是尝试进入。不是通过 realpath 改写 helper 目标，不扩大授权、不重新 pin；环境私有根保护仍在每次编译时叠加。
- Linux 不读取这组 Windows-only 配置，沿既有同步 collector/异步估算 worker；未扩大 Linux 接受集合。预估仍仅元数据，complete 表示预估枚举无缺口，不表示检查点完整；Windows captureAvailable=false、无开启回执、enable 409、无 checkpoint/blob 写入保持不变。

回归先红：真实 NTFS 同步/异步服务各把应排除的 5B 计入（8B≠3B），真实 HTTP 把私有 16B 计入（21B≠5B）；VM 服务级测试定位遗漏及借用可变配置。修复后验证外部私有别名、树内私有 junction/目录、私有祖先拒绝，配置等待期间锁存及 Linux 不访问 privateDirs getter，均不修改原 pin/策略/检查点。7 语义变异最终全断言红，编译磁盘字节不改。首 HTTP red-first 断言失败后的 keepalive 清理挂起被工具超时终止（未计通过）；加 closeAllConnections 后重跑取得正常 exit1 断言红。首 Linux 私有闭包遗漏动态 estimate-worker，补齐后完整重跑；首 Linux 分支变异以原始 getter 异常失败，改为显式 doesNotThrow 断言后全部重跑，均不冒充通过。准确环境/命令/计数见 Goal E113。此修复不是管理开启或真实 turn 验收；全局 Git/worktreeConfig/删除历史/附件/容器映射及全部AC仍待完成，零真实项目采集/Key/模型/供应商/真实Docker/浏览器/生产；历史6美元未结算非账单不变，不合并发布。

### 5.53 Windows 同范围上一检查点的保守删除历史（管理开启仍关）

Windows Git 候选只在所有原生元数据/全树/内容/外置源复验成功后，返回临时 `observation`：完整非 Git 枚举的 `presentPaths`（含未选中的 ignored、秘密文件、目录），以及 SHA-256 `scopeHash`。摘要覆盖原始元数据请求的 literal 根、原 pin 身份、编译后的排除前缀和固定 Python 源码 SHA；不覆盖动态文件内容。完整路径表不写入检查点或 CAS，只有 scopeHash 持久化到 `integrity.windowsObservationScopeHash`。它是比较范围标记，不是不可篡改证明、原子快照或新的授权。

Windows collector 在既有跨 await 项目租约内读取同 target 的 latest。仅 schema-v1、同 project/精确 target、合法 checkpoint ID、Windows 标记、同 scopeHash、有效文件表且两边名称均为 ASCII 时可作历史基线；当前整个可见命名空间含非 ASCII，或旧清单含非 ASCII 时均不猜 NT Unicode 大小写语义。ASCII 比较忽略大小写，保留上次文件名作为删除条目。只报告上一清单普通非秘密文件在本次**完整枚举**中缺席的路径；Git ignore/显式 ignored 纳入变化造成的未选读、秘密剔除、case-only 改名、原路径改为目录不冒充删除。目录删除可使其原有文件路径被报告；不独立恢复空目录。

成功发布的新清单记录 `integrity.deletionHistoryBaselineId`；无可比基线为空字符串、`deletions=[]` 并保留 `deletion_history_baseline_unavailable`。scope 改变（包括原根身份、排除前缀或 helper 源码版本改变）不沿用旧历史，当前成功检查点可成为以后同范围采集的基线。删除列表纳入现有 manifestHash、配额预检和 CAS→清单→latest 发布流程，发布/租约失败仍不关联 turn。

限制：这是 `deletions_only_from_comparable_previous_checkpoint`，不是 Git HEAD/index 删除全集；首检查点前已删的 tracked 文件、未曾入选的文件、秘密文件、类型替换不据此推断。缺 latest/旧版本/坏范围标记仅说明历史不足，不能事后扫描补原现场。仍有同 OS 用户/存储 TCB、非原子/ABA 和同步解析不可抢占残余；scope 摘要不证明被测包完整。`complete=false`、`strictEvalEligible=false`、管理 estimate `captureAvailable=false`/无回执/开启拒绝不变。未开放真实项目采集，Docker 映射与普通 CAFF 回放、全局 Git/worktreeConfig、附件归档等义务不豁免。

验证：两组接口/范围测试和 collector 历史组合测试在父构建先失败；Windows 自建 NTFS Git/session 夹具连续采集、重开存储，验证真实删除与 ignore/case-only/类型替换/秘密的差别，两次恢复后清单一致；改变排除范围后不沿用历史。原始 first/resume 字节及严格资格保持；这不是日常真实 worktree 或管理开启验收。具体命令/结果以 Goal 证据记录为准。

### 5.54 Windows 已核验索引中的首次采集前缺席记录（管理开启仍关）

在 §5.53 的上一检查点历史之外，本地/显式选择外置 Git 的候选现可输出当前已校验索引中、在本轮完整可见命名空间中缺席的普通文件名。保留索引原拼写，不读取 Git HEAD/objects、不执行 Git、不增加授权根或打开已排除对象。临时推断结果只在既有全树/元数据/外置五源复验全部成功后随候选返回；失败不返回部分删除表、文件计划或 absence evidence。

可见性规则是保守子集，不是另一次 NT 路径探测：索引、枚举名称及编译后的排除前缀须全部可打印 ASCII，索引及树的逐组件拼写须无大小写歧义；否则不推断本轮索引删除，附 `indexed_deletions_namespace_unverified`，普通文件采集仍可成功（ignorecase=true 原有非 ASCII 拒绝不变）。按 ASCII 不分大小写判存活，case-only 名称差异、同名目录、祖先被普通文件替代均不算删除。逐组件排除原生 `METADATA_DENY_NAMES`、`.env.*`，再应用含受信 private/storage 根的编译排除前缀；源列表一致性有回归约束，Python/helper 源码与协议未改。含 `~` 的索引名不猜 8.3 短名语义。仅记录路径，不记录缺席文件的原内容、hash、身份或旧秘密判定；无法扫描不存在的旧内容，不能宣称其历史内容无秘密。

单次索引删除最多 2048 条，超限整批 `git_deletion_limit`，不截断冒充完整。collector 将有验证标记的索引记录与可比历史记录按 ASCII 不分大小写去重合并、字节排序（索引拼写优先），可比基线中已知 secretExcluded 的名字不会被索引重新带回。无历史基线时仍可记录索引缺席；范围改变只使旧历史不可比，不抹掉独立核验的当前索引证据。`integrity.indexedDeletionEvidence=verified_index_visible_ascii_v1` 与 `deletionHistoryBaselineId` 分别说明两类来源；无索引可见性证明时前者为空并保留首次删除未推断限制。删除列表仍进入 manifestHash/配额/发布链，restore 仍只在空目标恢复实际文件，不按 deletions 额外删除目标文件。

本节细化 §5.53：无基线不再必然 deletions=[]，历史限制标签改为 `deletion_history_only_from_comparable_previous_checkpoint`；已验证索引证据不再附“首检查点前 tracked 删除完全未推断”。不是 Git HEAD 删除全集：已从索引移除的 staged deletion、不可见/歧义/Unicode/短名及旧秘密内容仍不完整。complete/strict 恒 false，管理 estimate captureAvailable=false、无回执/enable409 不变，不得据此开放真实项目采集或宣称 AC2/AC9 通过。全局 Git/worktreeConfig、附件、容器映射及普通 CAFF Docker 回放仍待完成；非原子/ABA、同步不可抢占与同 OS 用户/存储 TCB 残余不变。

验证包括父构建失败回归、边界/保护根/大小写/类型/Unicode/元数据漂移用例，本地 NTFS 首次 preMissing、独立外置 linked-worktree 的 deleted 文件，fresh/resume 服务→真实 publisher→重开→两恢复一致，历史合并/秘密路径/范围变化负例。仅自建临时夹具，raw writer enabled 不是管理开启或真实项目 turn；准确命令、计数、独立审查以 Goal E115 为准。零 Key/模型/供应商/真实 Docker/浏览器/生产操作，历史6美元未结算非账单与全部 AC pending、不合并发布保持。

### 5.55 显式 Linux 普通文件 rwx 恢复前提（非普通 turn 回放完成）

§4.6 的旧 `decode/materializeInitializationCapsule` 和 SDK/模型执行入口保持原内容恢复契约：0600 写入、`fileModePreserved=false`，不因本节自动迁移。新增内部 `planModePreservingReplayCapsule` / `materializeModePreservingReplayCapsule`，供后续普通 Docker 回放接入；只恢复数据和普通文件 rwx 权限，不执行捕获脚本、不初始化 SDK、不申请模型或授权采集。

严格分支重新验证完整 capsule/闭包/路径/秘密边界，然后在首次 mkdir 前验证每个文件的 mode：须是安全整数，完整 regular-file mode 位于 `0100000..0100777`。缺失 mode、仅有 0755、非普通文件、字符串/小数/截断大整数、setuid/setgid/sticky 等均 `capsule_file_mode_invalid`；不猜默认值、不静默剥特殊位。规划在宿主平台无关、无写入，返回 `expectedReceipt` **仅为预期，不是落盘或容器观测证据**。

实际严格恢复仅 Linux；其他平台在写入前 `capsule_mode_platform_unsupported`，无宿主平台回退。复用全新目录/排他写入/全量内容读回复验后，逐文件以 `O_RDONLY|O_NOFOLLOW` 打开既有 0600 文件，在同一 fd 上 `fchmod`，再核验 regular-file、精确 rwx 且无特殊位，并通过该 fd 重读内容；mode 000 不需临时放宽权限。每次 finally close，chmod/读取/关闭失败无成功回执，可能留下本次新建的部分目录，不回滚、不清理、不解除引用保护。祖先/同 OS 用户仍为 TCB，不宣称抵抗同权限并发篡改。

新回执 `kind=linux-rwx-mode-restoration-v1` 的 `fileModePreserved=true` **仅指已核验的普通文件 rwx**；不包含目录 mode、属主、时间戳、ACL、xattr、挂载 noexec 或 Windows ACL 语义。新增 `modeInventoryHash` 绑定排序后的 snapshot/path/mode 表；旧 `materializedHash` 继续覆盖全部恢复文件的 path/size/hash（含 checkpoint.json），不改变旧摘要含义。`piExecuted/runnable/reproduced/evaluable/strictEvalEligible` 恒 false。

`retained-input-probe.cjs` 新增独立显式 `runRetainedModeProbe/modeTaskFor`，只将固定严格静态恢复入口放进原隔离 Docker 底座；缺 mode 在运行前拒绝，精确比对 completed/cleaned/inputHash/空 stderr/回执，绝不暴露原始输出。旧 probe、真实模型 launcher、管理门和 UI 未改。本轮测试使用自建材料及 WSL Linux 静态落盘，不把 fake transport 或 WSL 当成真实 Docker 证据；普通配置/tool bridge/回调/路径替换及真实 fresh/resume agent 回放仍缺。

回归 `tests/runtime/badcase-capsule-file-modes.test.js` 纳入 fast：fresh/resume 两恢复、严格 umask 下 0644/0755、000 同 fd 内容验证、特殊位/坏 mode 前置拒绝、非 Linux 零写、chmod/no-op/观测内容/close 故障及严格 wrapper。§5.54 的 E115 P3 补齐磁盘 `X.LOG` / 索引 `x.log` 反向 case-only（mock 与真实 NTFS 两步 rename、两种 ignorecase），删除 present 小写变异必须断言红。准确命令、计数及独立审查以 Goal E116 为准；非 AC 通过。零真实项目采集/Key/供应商/真实 Docker/浏览器/生产操作，全部 AC pending、历史6美元未结算非账单、不合并发布不变。

### 5.56 显式 worktree 输入路径映射准备（非回放执行器）

新增内部纯函数 `prepareWorktreeReplayInputs(capsule, expected, declaration)`，供后续普通 turn 容器入口消费；不接现有诊断/付费 launcher、SDK、管理/UI 或真实采集门。先完整复验 capsule 和 §5.55 的普通文件 mode，再处理声明；不访问任何源路径、不写工作副本、不执行归档脚本。`sourceRoot` 必须逐字等于 checkpoint.targetDir，`sourcePlatform` 显式 linux/win32，若 integrity.platform 存在还须一致；不能借宿主 OS 的 resolve/realpath 推断历史路径或扩大授权。声明不是 pin、授权或环境来源证明。

声明闭集 `{schemaVersion:1, sourcePlatform, sourceRoot, mappings}`，最多256项。每项是 `{input:'prompt', start, end, sourcePath}` 或 `{input:'session', line, pointer, start, end, sourcePath}`；start/end 是**解码字符串的 UTF-16 code-unit 半开区间**，line 从0起，pointer 是本节允许的固定 JSON 字段选择器，不是任意 JSON Patch。每一处原文必须精确等于 sourcePath，范围不重叠、不越界，文字位置有保守词法路径边界，不能用只声明根/路径前缀来隐藏紧邻的未声明 `../` 后缀；这不是 shell/自然语言解析器或任意字符串安全证明。路径为保守可打印 ASCII 子集，拒绝点段/空段、UNC/device/drive-relative、混合 Windows 分隔符、~短名；根不得为盘根或 `/`。Windows 对已归档文件/删除表的完整名和各父组件建立大小写拼写表（64层/100000项），有歧义则拒；sourcePath 与任何已知组件大小写不一致也拒，不能把原NT上可用的大小写别名静默变成Linux上的不同文件。不自动改写大小写，也不把未知新路径当成已存在依赖。源路径须精确位于已声明 worktree，**目的地不可由调用方选择**，固定 `/work/restored/snapshot` 加逐组件相对后缀，Windows分隔符在该后缀内转为 `/`，不做权限比较大小写折叠。

仅可改变 invocation 文字、resume 第0行 cwd、user 字符串 content、user/assistant text block，以及 assistant read/write/edit toolCall 的 `arguments.path`。cwd/工具path必须整字段映射；不改消息/调用ID、角色、工具名/输出、bash命令或任意扩展状态。resume 必须原有非空、换行终止的 JSONL v3 header，cwd 等于 sourceRoot 且显式映射；缺失/坏格式/未映射不降 fresh。JSONL 不整体重序列化：每个变更字段的规范 JSON 字符串 token 须在原行唯一，否则拒绝而非猜位置；仅替换该 token，CRLF/空白及其余字节不变。未声明位置残留同一源根（Windows包含大小写/分隔符变体）拒绝；遍历最多100000节点，数组不使用无界 spread。映射失败为固定 `replay_worktree_mapping_invalid`；底层 capsule/mode 错误保留原固定码。

返回独立 working invocation/sessionText、原 deliveryMode、完整未剥除的 runConfig/harness、skillSnapshots 和 controlledReplacements；原 capsule、归档 prompt/session/config 哈希不变。声明原序 JSON 哈希和映射后 invocation/session 哈希分别记录，另绑定原 materializedHash/modeInventoryHash，**这些是规划摘要，不是执行/落盘/独立观测回执**。未验证维度、缺关键输入、未归档图片不提升为支持。已有 runtime 占位符不在此换入凭据；不修改技能/配置内容、源文件正文或任意其他绝对路径，不探测全机路径，不验证复杂 session SDK 语义/工具依赖是否齐全，也不证明文件一致性。即使映射成功，piExecuted/launchAuthorized/runnable/reproduced/evaluable/strictEvalEligible 全false。未来执行器仍须独立核验完整配置/技能映射、历史依赖、隔离工具桥/回调和受控凭据替换，并使用同一声明处理两variant，不能以本函数成功绕过它们。

新回归 `badcase-worktree-replay-inputs.test.js` 纳入 fast，覆盖两种历史平台×fresh/resume、CRLF字节保留、复杂历史显式路径变更但不剥工具结果/配置、技能与凭据占位清单不变、跨worktree/别名/点段/重叠/部分路径/缺映射/歧义token/错误字段/容量边界负例。自建材料只作纯准备测试，不充当真实NTFS采集、WSL恢复或真实Docker/模型证据。普通 turn 执行桥尚未接通，Windows管理开启仍关闭，全部AC pending；历史6美元未结算非账单、不合并发布不变。首次直接追加 fast 命令触发 Windows cmd 长度限制、未执行测试；按原顺序将四套材料测试提取为 `test:badcase-replay-materials` 子命令，fast 引用它，未删减/并行化原测试。准确命令、计数和固定SHA独立审查以Goal E117为准。

### 5.57 文本路径映射的显式分隔符与历史负例

收紧 §5.56 的文字 span 边界：仅字符串首尾或紧邻的 ASCII 空格、Tab、CR、LF 可作为分隔符，前后分别检查。旧路径字符拒绝列表漏掉 `$!#` 等字符，可能把 `root$other` 的根前缀改成容器路径；不是沙箱逃逸，但会悄悄改变错误的路径。本次改为分隔符白名单：其余标点、引号、反引号、括号、Unicode 空白/零宽字符及其他控制字符均拒绝，不猜 shell、Markdown 或自然语言语法。引号包围的文本路径现在明确不支持；不静默剥引号或扩大 span。路径内部原已允许的空格不被分词，声明完整的 `root/source.txt backup` 仍可映射。这仍不是判断任意文字中完整路径的解析器或文件依赖证明；ASCII 空白也可能出现在真实文件名中，完整范围须由声明者确认。

cwd 和 read/write/edit `arguments.path` 继续必须整字段，不借相邻空白绕过；非白名单工具即使具有 path 形状参数也拒绝。resume 缺尾换行仍拒绝，不能漏掉最后一行及其源根残留。新增6项回归分别覆盖合法分隔符、全部94个可打印非空格 ASCII 字符及控制/Unicode邻接负例、两平台的用户字符串/用户与assistant文本block邻接、三类文件工具完整含空格路径与部分span负例、LF/CRLF未终止历史末行、bash/自定义工具path负例。E117 的3项P3以删整字段/尾换行/工具名单守卫的独立语义变异验证；采用空白后缀的部分工具path夹具，避免新边界守卫遮蔽整字段断言。旧实现文本邻接2项回归先红，其余覆盖测试在原守卫下本应通过。

只改纯输入准备层；原归档、完整配置/历史、fresh/resume模式、权限复验、固定目的地和全部false资格标志不变。不接SDK/工具桥/管理/UI/真实采集，不调用模型，不冒充容器执行证据。Windows管理开启仍关闭；普通CAFF Docker fresh/resume、隔离回调/凭据和其余验收义务未完成，全部AC pending。准确命令、计数和新固定SHA独立审查以Goal E118为准；历史6美元未结算非账单、不合并发布不变。

### 5.58 映射输入与 rwx 恢复的静态容器工作副本接线

新增内部 `planWorktreeReplayMaterialization` / `materializeWorktreeReplayInputs`，将 §5.55 的 rwx 恢复和 §5.56–5.57 的显式输入映射组合为一次静态工作副本落盘。仍不导入 SDK、不执行捕获文件、不提交 invocation、不注入凭据、不授予启动许可。完整 capsule/mode/声明校验及 runConfig 对象、controlledReplacements 数组形状检查在首次写入前完成；缺材料不补空配置或默认清单。实际写入仅 Linux，其他平台在调用底层恢复前 `replay_working_copy_platform_unsupported`，无 WSL/宿主执行回退。

生产容器入口固定目的地 `/work/restored`：原 snapshot 文件按普通 rwx 恢复，原 checkpoint 和全部输入/技能 blob 仍在独立 `materials` 下，随后排他创建 `working-inputs`。内部静态测试可传自有临时目录，此时文本中的 `/work/restored/snapshot` 只是未来容器逻辑路径，不能据此在宿主启动 agent。每次必须全新目的地，既有目录或链接由原排他恢复拒绝；不覆写上一 variant。

working-inputs 固定包含排序后的 `prompt.txt`、`run-config.json`、`harness.json`、`skill-snapshots.json`、`controlled-replacements.json`、`declaration.json`，仅 resume 另含 `session.jsonl`。prompt/session 为映射后的工作材料；session 延续原 JSONL 局部替换与 CRLF 保留语义，不降 fresh。配置/清单按解析对象 JSON 序列化，完整字段保留，**不是原配置字节相等声明**；原始配置/技能字节仍在 materials/blobs。受控变量仅保留原占位符和清单，不在本步替换。未知完整配置/技能路径仍待执行器核验，不剥 toolBridgeEnabled 或复杂配置以冒充支持。

底层恢复回执的 materializedHash/modeInventoryHash/fileModePreserved 须与计划匹配，之后才写 working-inputs。每个工作文件以 O_CREAT|O_EXCL|O_RDWR|O_NOFOLLOW、0600 打开，同 fd 写入、fchmod、fstat 核验普通文件/精确大小及无特殊位的0600，再以从0开始的有界位置读取（额外1字节检测长度变化）比对内容，finally close。I/O 原生错误传播，固定核验失败为 `replay_working_copy_write_failed`；失败可留下本次新建的部分目录，无成功回执、不清理、不解除引用保护、不回滚。祖先/同 OS 用户和存储仍为 TCB；不宣称原子恢复、掉电 fsync 保证或阻止同权限并发篡改。

计划的 `expectedReceipt` 是预期；实际落盘步骤仅在上述检查完成后返回对应回执，仍非独立容器证明。`kind=worktree-replay-materialization-v1` 继承映射/原材料/权限摘要，另以 workingInputHash 绑定排序的工作文件 path/size/sha256 表和 workingInputCount。fileModePreserved 仅普通 snapshot 文件 rwx；piExecuted/launchAuthorized/runnable/reproduced/evaluable/strictEvalEligible 恒false。

`retained-input-probe.cjs` 新增独立 `worktreeTaskFor/runRetainedWorktreeProbe`：固定静态容器入口消费 capsule/expected/declaration，使用既有隔离 Docker 底座；宿主先规划，容器再完整复验。wrapper 须精确比对 completed/cleaned/inputHash/64hex containerId/空stderr/完整stdout回执，不暴露原始输出。旧内容probe、mode probe、SDK/模型 launcher、采集服务/管理门与UI保持原接线。新自动测试纳入材料组/fast；WSL 静态恢复与 fake transport 不作真实 Docker 证明。真实工具桥/隔离回调/受控凭据替换、普通 fresh/resume SDK 执行仍未完成，Windows管理开启仍关闭，全部AC pending。准确命令、计数及新固定SHA独立审查以Goal E119为准；历史6美元未结算非账单、不合并发布不变。

### 5.59 单 invocation 独立评测回调内核（未接 Docker / trace 导入）

新增内部 `startEvaluationCallback({directory, seed, lifetimeMs})`，复用现有 `createChatAppStore` 和 `createAgentToolBridge` 的真实 context/participants/public post 语义，但**不启动应用服务器、不读取生产 DB/Room、不接调度器、模型、项目解析器或任意调用方路由**。directory 必须是受信调用方专用已存在父目录下的全新绝对路径；父目录拒 symlink/canonical 别名，排他 mkdir 0700，不递归创建、不重新打开已有目录。SQLite 固定为该目录的 `callback.sqlite`，显式传入 store，忽略 PI_SQLITE_PATH 等环境配置；Linux DB 文件另设0600。启动失败可保留本次部分目录，无自动删除或恢复；祖先/同 OS 用户及存储继续属于 TCB，目录检查不是抵御同权限竞态的沙箱。

当前 seed 闭集为 conversationId/turnId/agent{id,name}/userMessage{id,content}/assistantMessageId，仅支持一个已授权的纯文本用户种子和独立自定义角色 ID（内置 role-family-* 明确拒绝），在首个 await 前复制并经秘密哨兵及大小校验。这是**合成输入协议内核，不是完整历史 trace 导入器**；角色 prompt 只是回调身份占位，未执行/替换被测角色指令。不能剥原 trace 的其他参与者、私信、历史、复杂角色配置来套此接口并宣称 faithful replay；真正导入这些材料及显式 ID 映射仍待实现。

只绑定 `127.0.0.1:0`（随机端口），不允许自选 host/port/DB；未来可在专用容器的同一 network namespace 内与 pi 通信，**本提交尚未将它放入容器或接入任何 launcher**。固定路由白名单：GET `/api/agent-tools/context`、GET `/api/agent-tools/participants`、POST `/api/agent-tools/post-message`（仅 public，replace/append，noFinalize）。其他方法、私信、capabilities、跨Room、workspace/goal/delegation、memory、管理端点均显式拒绝，不 mock 成功或连生产补齐。支持现有 agent-chat-tools CLI，不新造模型工具协议；未覆盖的普通 CAFF 配置仍须阻断回放。

调用身份为每实例新生成的 UUID 和256-bit callback token，仅返回给受信调用方内存；不接收旧凭据、不从环境读取身份、不提供 HTTP 获取接口、不写入 DB/日志。复用 bridge 身份校验并额外定长 timingSafeEqual；实例间同 seed 不共享凭据、数据库或端口。GET 查询/POST body 闭集，拒重复查询、Origin、错误 Host、非 JSON、非法 UTF8、超过64KiB请求；每请求及累计输出最多32KiB，context limit最多24。最多128个通过外层请求门的请求、8个并行处理、16个连接及有限HTTP header/body超时；这不是完备抗DoS能力。仅允许已授权非秘密材料，采用现有秘密哨兵（**非万能秘密检测**）；公开输出也拒完整调用身份及已知哨兵，append后拼接再次检查，避免分片带回完整凭据。错误为固定码，不回显底层SQL/路径/输入/凭据，无访问日志。Node默认HTTP解析层错误不归为应用成功。

1..300000ms 单调 lifetime，过期主动 stop；显式 stop 先吊销身份，关闭且只关闭自有 listener/连接，等待活动 handler settle 后关闭 DB，重复 stop 返回同一 promise。异步请求读完后再次检查 live，不能在 stop 后碰已关闭SQLite。send-public默认沿既有 bridge 异步finalize路径使 invocation inactive，noFinalize可继续追加；没有自动启动其他 agent。数据库保留供受信验收器后续读取，不自动解除 run 引用；回调成功不授予 launch/runnable/reproduced/evaluable/strictEvalEligible。

本轮证据为自建种子：真实本地 HTTP + 现有 CLI读写、重开SQLite查询、双实例隔离、错误身份/路由/私信/超额/超时/半包stop及secret-split负例；不是捕获代码宿主回放、真实Docker/SDK/model执行或真实项目采集。§5.58 补 umask 0 下全部恢复目录0700断言，删除working mkdir及底层mkdir mode的独立变异须红，以闭环E119 P3。Windows管理门仍关闭，完整trace导入、Docker内服务接线、能力工具、普通fresh/resume执行、受控变量实际替换等未完成。准确命令、分套计数及固定SHA审查以Goal E120为准，全部AC pending；零真实采集/Key/模型/供应商/真实Docker/浏览器/生产，历史6美元未结算非账单、不合并发布不变。

### 5.60 固定容器内 bridge 诊断入口与退出清理（尚未交付 Docker 闭环）

`evaluation-bridge-container.cjs` 提供固定合成诊断入口：先要求 Linux、uid65534、cwd=/work、/.dockerenv 及无已知 CAFF/PI/provider/Node hook 环境项，再导入受信 `/work/build` 中的回调和 store；不执行 SDK、模型或捕获代码。该环境门不是防同 OS 用户伪造的沙箱；真正隔离仍必须来自既有固定镜像、network=none、无宿主可写挂载/socket、非 privileged 和资源/终止核验。**本提交没有自动打包所需 build/npm/native 闭包或接入 Docker launcher；仅把脚本放进镜像也不证明可运行。** 匹配 Linux/Node ABI 的 better-sqlite3、完整 bridge 依赖以及固定模板内路径仍须显式准备并核验；缺依赖失败，不 npm install、不接宿主 bridge、不回退宿主执行。

入口在同一 namespace 内创建两套新回调/SQLite，使用固定种子与自定义回调身份，而非导入真实 trace。通过固定 `process.execPath + /work/build/lib/agent-chat-tools.js` 子进程执行5次现有 CLI：读context、列participants、noFinalize公开发送、再读本实例和另一实例。验证context/参与者ID、跨实例身份401、输出只在本实例出现；关闭回调后重开其新数据库核验持久结果，连接须明确 ECONNREFUSED 才标 callbackClosed，超时/abort等不算关闭证据。仅返回无身份/原始输出的固定诊断回执，piExecuted/runnable/reproduced/evaluable/strictEvalEligible仍false。

子进程无 shell、stdin关闭、固定cwd，环境只含PATH/HOME/TMPDIR和该实例新生成的3个CAFF bridge变量；不继承宿主身份或模型凭据、不把身份放argv/文件/回执。stdout+stderr合计64KiB，3秒观察超时/超输出发送SIGKILL并等待close，非零退出、任何stderr、坏JSON或后置核验失败均固定失败；不重试。这里只管理固定CLI直接子进程，kill失败或OS不close会等待，不宣称硬3秒或任意进程树终止；真实容器supervisor仍须负责外层硬终止。回调寿命20秒，第二实例启动失败、子进程异常或成功路径均finally停止所有已拥有回调；cleanup失败不得返回成功回执，部分目录仍不自动删除或unpin。尚未把此生命周期绑定到SDK/普通turn launcher。

自动测试为**宿主合成CLI/HTTP/SQLite，VM仅模拟容器门和固定路径**，不执行真实agent；脚本在真实宿主调用必须先失败。覆盖双实例持久化、非容器/环境门、部分启动、子进程错误/超输出/超时/坏JSON、含糊关闭及cleanup失败；不能将该测试写成真实容器namespace或Docker证据。§5.59另补 publicLimit/privateLimit 的1..24边界与越界负例（E120 P3），以及append替换Thinking...不吞累计输出预算的正例。生产kernel/bridge/store、采集/管理/UI/SDK均未改。准确分套计数、变异及新SHA独立审查以Goal E121为准；Windows门仍关、完整trace/配置/技能/受控替换与普通fresh/resume Docker回放仍未完成，全部AC pending，零真实项目采集/Key/模型/供应商/真实Docker/生产，历史6美元未结算非账单、不合并发布不变。

### 5.61 固定分发材料与原生 SQLite 的 Docker bridge 诊断接线

`evaluation-bridge-launcher.cjs` 为§5.60增加受信调用入口 `runBridgeDiagnostic(repoRoot, dependencyRoot, image)`，不接HTTP/管理/UI/SDK。两个源根必须显式提供绝对canonical普通目录，不发现或回退依赖位置；每个固定路径的父目录逐层lstat拒链接，叶普通文件同fd有界读取、前后身份/size/mtime/ctime核对，finally close。祖先/受信安装/同OS用户仍TCB，非原子快照或来源认证。跟踪的 `evaluation-bridge-files.json` 固定63个build文件、273个npm/native文件及17个包的name/version；开发期静态require闭包分析只用于生成清单，运行时不扫描树/解析源码/导入包，不执行安装脚本、不npm install/编译。该清单覆盖固定诊断实际用到的分发材料，不承诺任意动态能力/SDK回放闭包完整；依赖变化须更新清单并审查。单文件8MiB、累计16MiB，超限在下一叶open前拒绝；不采集auth/session/真实项目或宿主全局模块。

原生addon必须位于固定 `node_modules/better-sqlite3/build/Release/better_sqlite3.node`。宿主只验证ELF64/小端/ET_DYN及目标amd64或arm64机器号；这**不是**Node ABI、libc或加载成功证明。Docker入口先核验环境门、Node版本/架构、全量manifest的路径/type/size/hash，再真正加载固定better-sqlite3，打开独立内存数据库并查询SQLite版本，finally close；错误架构/缺失/坏addon不回退宿主或另一路绑定。然后运行§5.60双回调及5次CLI诊断。容器内加载成功才回 `nativeSqliteVerified=true`，附inputHash/dependencyHash；主机须逐字核验固定回执、完整manifest、无stderr、exit0、64hex容器ID及既有transport的已核验清理契约，不返回原始stdout/stderr。哈希仅为完整性，不证明第三方分发来源真实性。

实测发现Docker tmpfs未显式exec时会阻止`.node`的可执行映射（`failed to map segment from shared object`）。不修改旧调用的WORK默认值；`runProbe`新增仅可信内部调用的布尔 `executableWork`，该诊断显式选择 `/work:rw,exec,nosuid,nodev,...`，并在create前/后及deadline停止前inspect逐项绑定同一选项。`/tmp`仍noexec，rootfs仍只读，network=none、uid65534、cap-drop ALL/no-new-privileges、512MiB/1CPU/64pids、无宿主挂载/socket/端口等原约束不变；无效选项在任何Docker调用前拒绝。exec只使隔离临时分发材料可加载，不扩大宿主访问或允许生产连接。沿用已审查runProbe的25秒观察期限、容器级kill和owner核验后移除；不将其称为绝对硬实时保证。默认daemon仍要求原RepoDigest校验，无自动专用daemon回退。

作者实际Docker验证使用既有固定Node24.21.0/amd64镜像、Python3.11.2；为诊断临时在同一固定隔离镜像内由受信better-sqlite3源码离线编译测试addon（非MVP自动编译功能）。验证真实namespace内CLI→HTTP→双SQLite、跨身份401、关闭/重开、坏native加载拒绝及清理。准确命令、镜像ID/digest、字节数/容器ID与独立审查见Goal E122。早期缺hpp编译输入、停止后tmpfs无法docker-cp、默认tmpfs映射拒绝及Node22宿主不能加载Node24测试addon均不计通过。人工编译的Node24测试addon还观察到间歇 `RemoveEnvironmentCleanupHook`/`Statement::~Statement` native SIGABRT（exit134）；镜像头文件版本与Node24.21.0一致，根因未定，最后双副本成功不能证明稳定性，也未证明正式npm构建同样受影响。失败均无成功回执且容器清理，不为消除此现象降级Node/换镜像/放宽ABI或回退；当时尚无正式预编译产物验证；后续限定产物的验证见§5.62，不能据此宣称旧崩溃已修复。E121两项P3补gate-clean ambient不继承及门拒绝时CAFF require计数0，已在E122经GLM独立变异确认闭环。

**这是固定合成Docker诊断，不是普通turn或用户badcase回放完成。** 没有SDK/模型/付费调用、真实trace导入、完整配置技能/受控替换/附件或fresh/resume执行；所有执行评测资格仍false，Windows管理开启仍关，全部AC pending。容器使用内存新身份，供应商/生产凭据不入材料；生产采集/桥/store未改，历史6美元未结算非账单、E106归DeepSeek、用户最终接受且不合并发布均不变。

### 5.62 容器 entry 执行级完整性回归与限定 native 产物验证

补齐E122的P3：测试直接取得 `prepareBridgeFiles` 实际生成的 `probe.cjs`，在VM中执行其异步入口，使用完全惰性的文件/native/bridge替身，**不在宿主加载addon或执行agent**。先确认合法清单经过全部文件读取、native open/query/close后才导入bridge并返回精确回执；分别破坏环境门、manifest schema/inputHash/4096项上限、Node版本/架构、重签后的路径/重复项、文件类型/大小/内容摘要、16MiB总量以及native加载/查询/关闭。失败须为固定错误、零公开输出；校验前拒绝不得触发native/CAFF导入。计数/总量负例的其他材料保持可消费，避免被缺文件或size不匹配遮蔽；VM替身只验证控制逻辑，不作真实ABI/Docker证明。§5.60内层入口同时拒绝LD_PRELOAD/LD_LIBRARY_PATH，与外层保持一致；回归先在旧内层门出现缺少拒绝，再修改门。JS环境门不是对OS动态加载器的沙箱：OS可能在JS运行前消费这些变量，真正隔离仍来自固定镜像、封闭启动环境及Docker约束。

为区分人工编译产物风险，作者显式从 `https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-node-v137-linux-x64.tar.gz` 取得预编译归档，仅在本agent私有临时依赖副本替换固定native位置；不覆盖共享node_modules、不安装/编译、不自动发现或更换版本。归档1,089,588B，SHA-256 `99c43785639d5d3690c396ba245ee680ac8b469a46b19233a3546f0eb7f8e312`；唯一普通文件 `build/Release/better_sqlite3.node` 为2,122,448B，SHA-256 `45cb92a176fb758533db6d9a343acdfc73e4de27ac4c20a0cb2a6fb5be3e84f2`。来源由显式HTTPS地址与下载时哈希记录，**没有发布者签名或独立构建来源证明**；该手工取得步骤不是产品运行时下载/安装功能。

限定计划最多3个隔离容器、失败即停：同一固定Node24.21.0/amd64镜像下，2个容器各8个顺序子进程（显式 `--expose-gc`、每进程100次独立内存库create/insert/select/close及周期GC，2秒/child），父进程先完成完整manifest复验才启动子进程；随后各运行原双回调/5 CLI诊断。第三个容器运行未修改的默认launcher。实测16个压力子进程/1,600次生命周期及3次bridge诊断均通过、无abort，清理后零probe容器；压力脚本只在ignored证据中，不进入被测配置或默认launcher。严格RepoDigest/镜像/网络none/只读根/无挂载/资源/work exec与tmp noexec核验保持。两压力副本同inputHash/dependencyHash，默认副本因entry字节不同inputHash不同，dependencyHash相同。

该结果仅支持**上述固定官方预编译产物、平台与有限负载条件下**继续后续SDK接线；不能归因或修复旧人工 `-O0` 构建的间歇SIGABRT，不能证明无限稳定或其他ABI/架构/版本适用，失败仍须停止分析而非重试冲过。宿主Node22只运行纯launcher测试，不导入Node24 addon。真实trace、完整配置/技能、受控替换及fresh/resume/SDK实际回放仍未接通；所有执行评测资格false、Windows开启门关闭、全部AC pending，无模型/付费/真实采集/生产写入，不合并发布。

### 5.63 生产 CAFF runtime 工厂、默认资源加载器与真实工具的容器接线

新增受信诊断 `caff-runtime-wiring.cjs` / `caff-runtime-container.cjs`，固定新建合成项目，不接受捕获程序、任意配置或prompt评测输入。宿主只静态打包：复用§5.61显式双根/固定bridge分发及既有§4.4 runtime分发拷贝（安装/祖先仍TCB），另外用同fd受限reader拷贝未经改写的 `lib/pi-sdk-host.mjs`、`proxy-routing.mjs`、两项CAFF扩展至原有相对目录。旧bridge launcher仅导出该可信内部reader，不改变原entry/清单/生命周期。最终全manifest仍受4096文件/16MiB限制；不提高上限，不npm install、不在宿主导入SDK、addon或扩展。

首次真实Docker fresh诊断失败并立即停止，resume未启动；之后两个独立单容器固定阶段探针将位置限定到extension registry（2项加载错误、0项已加载），没有打印原始错误或身份。源码确认发布SDK bundle在加载扩展时才懒调用 `require('jiti')`，旧runtime初始化材料缺该依赖，不能用禁用扩展绕过。补固定jiti 2.7.0的 `package.json`、`lib/jiti.cjs`、`dist/jiti.cjs`、`dist/babel.cjs`，在 `runtime/node_modules/jiti` 保持原目录关系并核验name/version；不改写扩展导入，也不另放不同版本root typebox（SDK bundle原virtual/alias机制提供同版本模块）。缺jiti的新增字节对照测试先红，补齐后再建立有界验证计划；失败现场与新计划证据分别保留在Goal，不把失败隐去或算作通过。此扩展接线材料不自动扩大旧runtimeArchive的闭集导入契约，任意捕获扩展/外部依赖归档仍未实现。

容器入口先验证环境、全manifest路径/重复/type/size/hash/总量/runtimeHash、Node身份及显式fresh/resume值，之后才新建项目/agent目录、加载SQLite、SDK和生产host。固定fixture的settings明确授权该合成项目、关闭安装遥测；其余默认资源发现/compaction/retry配置保持，不用空ResourceLoader或诊断system prompt替代真实CAFF runtime。角色SYSTEM.md、项目AGENTS.md、项目skill、contract skill与retired user-scope skill均有不同哨兵，调用原 `normalizeStartCommand` / `createSdkRuntime`，绑定json扩展模式，核对实际模型对象、历史、两扩展注册、context与技能进入/排除及完整工具存在。这里使用openai/gpt-4o-mini仅作离线目录解析，不发请求、无该供应商凭据，不扩展付费模型授权。项目信任只限容器内固定合成目录，不改宿主trust/settings。

fresh走原SessionManager.create；resume先保留独立原JSONL及working副本，再走原精确sessionPath分支，验证实际1条user历史与session ID、原归档字节不变。它只验证固定v3合成历史，不声称复杂历史/附件依赖或历史工作目录已经可重放。通过session实际注册的工具直接执行write/read/edit/read，核对落盘；bash实际检查uid65534与cwd，并用未改写CLI完成read-context→send-public→read-context的隔离HTTP/SQLite闭环。真实 `list_rooms` 扩展调用独立callback未支持的capability路由，须准确拒绝 `evaluation_callback_route_unavailable`，不将拒绝当成功能力、不静默删除工具或接生产路由。这些是驱动器直接调用工具，不是模型决定的tool loop。

callback在容器内新建DB/随机端口/新内存身份，身份仅进入当前容器内进程/工具子进程env，不入Docker Config.Env/argv/分发包/日志/回执。父进程fetch只许该callback精确origin，其余计数并拒绝；SDK PI_OFFLINE，初始化后modelRuntime.streamSimple置拒绝哨兵，**从未提交session.prompt**。子进程的网络硬边界仍是Docker network=none，不把父fetch计数当全网络审计。finally等待runtime.dispose与callback.stop全部settle，任一失败不输出成功；外围仍由原runProbe核验owner/镜像/隔离/期限并移除容器，无宿主回退。测试用惰性VM importer只到SDK边界就拒绝，验证bootstrap门/完整性/清理；Docker默认始终使用真实import，不提供agent授权工具。

本轮采用§5.62同一固定官方native与固定Node24.21.0/amd64镜像，真实fresh/resume已观察默认factory、资源/扩展、文件与shell工具及callback闭环；新SHA完整回归/负例和独立审查状态见Goal。它推进了生产运行时的容器接线，但仍是**零模型调用的固定合成wiring diagnostic**：未接用户选trace/封存capsule、完整捕获配置与外部技能/附件、受控路径/凭据替换、模型出口或prompt双variant执行。所有replay资格false，Windows开启门关闭，全部AC pending。正式native的有限压力成功不修复旧人工构建SIGABRT，不证明真实混合负载无限稳定；若重现仍停止分析，不以重试冲过。不改生产、不付费、不真实采集、不合并发布。

### 5.64 完整 SDK 启动配置的采集与 capsule→启动描述符连接（尚未执行回放）

原§5.63固定fixture证明了生产factory能在容器初始化，但日常采集的harness此前只存模型/版本摘要，不能据此重新构造实际thinking、session、cwd、扩展和skill路径。禁止用猜测默认值补齐。新增共享纯函数 `lib/pi-runtime.ts::resolveSdkStartConfig`，由实际IPC发送及执行前采集共同调用，完整保留当前11项SDK启动字段：provider/model/thinking/agentDir/sessionPath/resume/cwd/heartbeatIntervalMs/extensionPaths/additionalSkillPaths/retireUserScopeSkills。沿用原解析、默认和去重语义，不读文件、不启动进程、不加入extraEnv/供应商认证/SQLite/图片/任意options；宿主watchdog等非SDK字段仍由原runtime管理，**本描述符不是完整环境或全部harness归档**。实际SDK host仍会执行原normalizeStartCommand，描述符不冒充SDK加载后的有效配置证明。

executor在capture首个await前生成描述符，脱离引用的副本进入 `configSnapshot.sdkStartConfig`，复用原UTF-8/harness秘密扫描及CAS计划；配置中命中秘密哨兵则不归档该blob、输入incomplete。采集await结束且用户未停止后、startRun前同步重算对比：如果ambient默认值已变化，不关联该checkpoint到新run，发固定 `sdk_start_config_changed` 原因并继续普通turn；不删除旧checkpoint、不假造新现场。该检查不是全进程环境快照，也不证明SDK资源文件没有变化；停止/resume claim恢复及采集失败不阻塞turn的既有语义保持。

新增 `caff-replay-start.ts::planRetainedCaffStart`，消费完整封存capsule、既有worktree映射声明及独立SDK路径绑定声明，输出准备给原factory的完整config。**纯内存计划**：不打开任何原路径、不创建目录、不导入SDK、不调用模型、不签发身份、不提交prompt。先复验capsule/mode/输入映射，然后要求完整11字段闭集、类型、模型/版本/promptVersion/fresh-resume一致；缺 `sdkStartConfig` 的历史包明确拒绝 `replay_sdk_config_missing`，未知SDK字段拒绝而非剥掉。新采集配置不自动升级任何旧包。

绑定声明为 `{schemaVersion:1,sdkConfigHash,bindings:[{pointer,sourcePath,targetPath}]}`，hash绑定原完整config；每个cwd/agentDir/非空sessionPath及两路径数组的每一项必须且只能声明一次。只能改变这些已声明路径；其余设置逐值保留。cwd必须是本次实际完整worktree；根内路径映到 `/work/restored/snapshot`，必须有归档文件或后代，Windows使用精确拼写不猜大小写/别名。resume只能绑定已准备的 `/work/restored/working-inputs/session.jsonl`。生产executor的fresh同样有非空的命名sessionPath（预定新文件，并非旧历史）；§5.66修正先前将此路径与harness的resume输入混淆的错误。命名fresh必须单独绑定保证不存在的 `/work/restored/working-inputs/fresh-session.jsonl`，保持原host的open分支，不读原路径、不生成旧历史；空sessionPath的fresh仍保持create分支。一个显式选定、名称相符的CAFF capabilities分发路径可映到固定容器分发位置；任意其他外置扩展/agentDir/skill不静默替换或删除。

当前支持集合刻意保守：agentDir须在已归档worktree内部，已有SYSTEM.md/settings.json，不合成角色或设置以绕过缺失；禁止携带其auth.json（名称大小写均拒）。普通CAFF的外置私有agentDir仍需独立授权的内容归档、外置contract skill/附件及其他动态依赖闭包尚未完成，本次不跨入这些路径。完整harness、skill inventory、controlled replacement inventory和原始会话字节保留；不将占位符换成真实凭据或把仅配置计划当完整依赖核验。默认loader、settings/扩展/skills的真正执行语义只能由后续容器消费验证，不由这个planner背书。

自动证据包括：父构建缺helper/新planner接口红首、实际隔离fake-host IPC与共享描述符相等、真实executor的fresh/resume采集副本相等以及await期间ambient thinking漂移取消关联；另有完整配置/秘密拒绝/闭集及hash/路径/缺文件/外置依赖/模式负例。fake-host不运行SDK或模型，纯planner不作Docker证据。所有SDK初始化/提交/授权/执行/复现/评测资格仍false；本次尚未把新计划交给Docker entry，§5.63固定fixture不因此变成真实材料回放。Windows管理门仍关、全部AC pending，无真实项目采集、凭据复用、付费调用、生产接线、合并或发布；下一段直接连接该计划与已存在的容器恢复/生产factory，不再新造同类样例。

### 5.65 封存 capsule→权限恢复→原 CAFF runtime 的 Docker 初始化入口

新增受信操作者内部 API `retained-caff-initialization.cjs` 与容器入口 `retained-caff-container.cjs`，实际消费§5.64的完整capsule、期望hash、worktree映射和SDK路径绑定，不再创建固定项目、SYSTEM/settings或替换历史。它只允许**初始化**，不提供HTTP/agent授权入口，不接生产server，不提交prompt、不调用工具、不注入凭据、不伪造trace callback seed。普通turn回放尚未完成，`callbackWired=false`、`invocationSubmitted=false`及所有运行/复现/评测资格false。

宿主先脱离复制调用材料并纯验证，之后复用§5.63原分发和同fd可信reader：固定添加四项恢复/planner编译模块及原session-validator，原container脚本作为只导入其guard的 `caff-runtime-bootstrap.cjs`，另放capsule及声明四个DATA文件。仍为4096文件/16MiB总量，不扩大上限、不安装、无宿主SDK/native导入或执行捕获内容。安装来源/祖先/操作者仍属TCB；manifest hash是完整性而非来源认证。`caff-runtime-container.cjs`只将既有完整环境/manifest/Node/mode guard提取导出；原合成入口调用同一个guard，原协议及fixture不变。

新增 `planRetainedCaffInitialization` 复用完整启动计划，任何未应用controlled replacement或未解析占位符均阻断，不删除清单假装支持。resume再次执行原固定版本session-validator，结构错误、未知工具路径依赖、附件像素、扩展私有状态等未验证维度继续阻断；额外拒绝空timestamp/头ID复用/非树父引用。**没有放宽既有sealed-input预检**：普通历史含文件工具的路径依赖仍可能被上游保守门拒绝，复杂依赖尚不宣称支持。fresh不生成旧历史，resume不降fresh。

容器先调用原stage guard，再纯验证全部输入且模式相符，然后在专用新 `/work/restored` 用原mode-preserving materializer恢复snapshot与不可变materials、创建独立working-inputs。先核对写回回执、prompt、resume工作副本原始字节存在，之后才导入原SDK/host；精确调用原normalizeStartCommand并比较全部config，再调用原createSdkRuntime。没有空ResourceLoader、诊断system prompt、in-memory settings覆盖、关闭扩展或合成项目信任；归档settings、角色、项目context/skills和原retired过滤由原factory加载，外置缺依赖仍拒绝。模型无法解析、fallback、扩展错误均失败，不剥配置绕过。

resume以固定SDK `buildSessionContext` 对映射后的原条目生成参考，与真实初始化session.messages逐对象比较，并检查原session ID；不手写仅user投影、不把工具输出播放当执行。`historyVerified`只指**同一SDK对已接受材料的上下文投影一致**，不是独立验证历史语义/附件或完整回放资格。成功返回有界history数量及history/systemPrompt/tool-name清单hash，不返回正文、原始输出或身份；宿主核对精确回执、全部manifest/镜像/模式/声明/配置hash和观察值闭集。容器核对原capsule与全部materials字节不变，工作session/settings可由原SDK在该variant副本内写入；不要求工作session事后与原字节完全相同。finally等待runtime.dispose，失败不得输出成功；outer runProbe仍负责owner核验、隔离、期限和容器树终止/移除。

PI_OFFLINE与父fetch拒绝守卫在SDK前设置、退出恢复；§5.66将原初始化后streamSimple哨兵改为SDK导入后、host/factory调用前安装固定ModelRuntime请求方法原型守卫，并持续到dispose结束。计数不覆盖SDK模块顶层执行、直接provider API或子进程，不是全网络或全部模型API审计，硬边界仍是network=none、封闭env、无供应商凭据及零prompt提交。默认沿原镜像RepoDigest/身份门、exec-work的显式native选择、只读root、uid65534、无宿主挂载/socket/端口、cap-drop、512MiB/1CPU/64pids及tmp noexec；无宿主agent回退。

验证经真实store→封存→capsule生成合成材料，分别送默认Docker入口fresh/resume（Windows来源路径声明），另一个重签外层manifest但损坏capsule的容器负例须固定拒绝；不是授权真实worktree采集，不以合成用例冒充用户badcase。resume保留CRLF、user/assistant/custom-message历史，两个模式共享相同runtime/dependency及systemPrompt/tools hash。VM执行实际entry的restore/config/history/缺session/扩展/model/archive/清理负例仅为控制流覆盖，非Docker证据。适用回归、真实Docker数字和固定SHA审查以Goal E126为准；E124/E125未独立审查部分并入本初始化里程碑，不追认PASS。Windows开启门仍关、全部AC pending、历史6美元未结算非账单；下一步仍需真实trace callback/外置授权配置和依赖归档、受控凭据与模型出口、完整prompt双variant及UI闭环，不合并发布。

### 5.66 独立审查修复：生产命名 fresh 与初始化观测边界

DeepSeek 对 `197aa2a7` 的里程碑审查为 **FAIL（1×P1、5×P3）**，不是自动测试全绿即通过。P1根因为实际executor始终传入sessionName，`resolveSdkStartConfig` 在fresh也解析出命名路径；旧合成fixture却手写空sessionPath，planner因此拒绝真实生产者输出，容器样例还误走create分支。修复选择保留原完整描述符：非空fresh路径须显式hash绑定到独立working-inputs中的固定新文件，恢复后、任何SDK导入前lstat确认其不存在（已存在文件、目录、悬空链接或其他I/O错误均拒绝）。只改工作副本路径，不访问宿主原sessionPath；原factory使用open，初始化结果的sessionFile须与该路径相同且实际历史为空。resume仍必须有归档session并保持ID/历史，不降fresh；未命名fresh仍用create。本层不证明原宿主预定路径过去从未存在，也不补采历史。

fixture改为执行生产编译resolver，跨平台测试仅替换显式path语义及封闭环境，不再手写11字段配置；本机另直接与真实resolver输出逐值比较，并以原host的SessionManager分支桩检出open→create漂移。生产resolver的cwd与Room原始captureTargetDir仍来自不同生产者：**当前只支持与已授权checkpoint根精确同拼写的cwd**。测试覆盖resolver去尾分隔符后的正例，以及大小写、分隔符、尾斜杠、其他根差异；不相同报 `replay_sdk_cwd_mismatch`，不通过宿主realpath/大小写折叠猜目录身份、不扩大授权。它是已测试的支持边界，不声称任意真实Room路径格式都已接通。

补足审查覆盖：结构合法但含custom私有状态的session先断言原validator `ok=true` 且含unverifiedDimensions，再确认精确拒绝 `replay_sdk_session_unverified`；不让结构错误遮蔽该门。容器从原loader读取实际SYSTEM来源，必须命中归档snapshot文件且加载正文与原字节一致（SDK的BOM处理除外），并出现在实际agent systemPrompt中，保留项目SYSTEM优先级。session实际SettingsManager的global设置必须包含全部归档global键值，允许SDK增加当前副本的默认模型字段；失败不输出成功回执。此验证不证明任意setting下游效果或任意旧schema迁移均受支持，project覆盖/迁移仍可导致明确阻断。回执 `archivedResourcesVerified=true` 仅指这些具体检查。

模型哨兵在固定SDK导入后、host导入/factory创建前覆盖ModelRuntime的stream/complete/streamSimple/completeSimple/streamDeferred/fetchDeferred/cancelDeferred七方法，方法缺失即拒；持续至dispose完成，finally还原原型与进程状态，吞掉一次请求尝试也不能返回modelCalls=0。VM对每个方法在factory内注入请求，检出原初始化后打桩的盲窗；它不是任意SDK或provider的安全拦截器。`modelGuardBeforeFactory=true`不等于导入前全模型审计，Docker隔离与零凭据仍不可替代。

本轮真实Docker计划有界3容器：默认命名fresh、默认resume及故意在fresh目标预置文件的拒绝探针，失败即停、无模型请求。fresh验证原命名open分支目标及零历史；resume核对3条上下文；角色和global设置均经实际SDK观测；负例是显式改写诊断entry、重签manifest的测试，不是产品修改或历史badcase。全部容器清理；固定镜像/RepoDigest、架构/Node/native身份、资源/网络/挂载约束不变。仍是合成封存材料，不是实际NTFS授权采集或完整turn；普通trace callback、外置输入归档、凭据/模型出口和UI闭环仍缺，所有AC pending、Windows开启门关闭，历史6美元未结算非账单，不合并发布。新固定SHA与复审结论见Goal，不追认E124–E126为PASS。

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
