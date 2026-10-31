# Badcase 采集、封存与 Docker prompt 对照评测

## 当前状态

本契约描述 2026-10-30 用户确认的最短路径 MVP，以及 2026-10-31 批准的 WikiSkill 层扩展（Goal `goal_aa132140-e957-4a58-9ed6-d58812370377`）。S0–S3 的固定 SHA `460d0512` 与 wiki 层最后一起由用户一次性接受，旧证据不冒充新增功能证据。旧设计与审查记录保留在 Git 历史和各自 Goal 记录中，不把历史 FAIL 追认为 PASS，也不沿用已取消的网关、双账本或持久付费批准义务。交付与验收证据以当前 Goal 为准；本文件不是另一份任务台账。

### 采集与恢复

- 仅在项目显式开启采集后工作。`projects.html` 正常入口为选择工作目录和开关；读取页面不自动授权、开启或扫描内容。管理请求沿用 loopback/Host/Origin/CSRF 门禁，信任同一 OS 用户，不是人类身份认证或抵御同权限进程的沙箱。
- `agent-executor.ts` 在本轮 prompt、实际 SDK cwd 和 session 选择确定后、`startRun` 前保存检查点。范围是该 turn 实际 worktree，不根据可能陈旧的 Room 路径猜测，也不是每次工具调用前快照。关闭后不再主动采集，既有封存不删除。
- 保存纳入范围的已跟踪文件、脏内容、未跟踪文件及删除/缺席状态；遵循显式排除、秘密过滤和 ignored 纳入策略。Git 分类元数据不作为恢复出的 `.git`，私有/凭据目录不能因“整个 worktree”被纳入。内容按 SHA-256 存 CAS，清单引用内容；恢复仅写入专属新空目录，不修改真实仓库，不从 HEAD 补回已删除文件。
- 保存归一化 prompt、执行配置、声明的角色片段及可用的执行前 session。resume 缺少 session 不得退回 fresh。采集失败或材料缺失不伪造检查点、完整性或可回放状态；正常 turn 与采集成功不是同一事实。
- Windows 主路径使用已有原生采集实现；支持的宿主启动条件包括 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=NUL`，且没有其他未支持的 Git 环境注入。不得给运行中的生产实例临时改变量来冒充原环境。不同平台的读取实现不能互相充当验证证据。
- 容量是逻辑落盘字节，不是物理分配块/空闲空间保证。UI 区分最近检查点新增文件、session、其他回放内容、共享 CAS、清单成本；缺少旧统计时显示未知，镜像成本不在其中。检查点发布前耗时不等于整个 turn 耗时。
- 清单/blob 自洽不证明原子现场；并发写入一致性、权限和 Git 元数据保真不在本 MVP 承诺内，`strictEvalEligible` 不升级为 true。

### 用户标记与封存

- 用户在聊天 UI 选择一条终态 assistant 消息，填写“实际问题”和“期望行为”，确认后保存标记并尝试封存其执行前现场。UI 不要求用户填写检查点 ID、JSON 或再做一次封存确认。
- 关联由服务端从消息的 project/conversation/message/turn/agent/task/checkpoint/run 派生，不接受客户端改绑。标记与封存状态分别查询；已标记不代表已封存，已封存不代表可回放。
- 同一消息相同文本重复提交幂等，不新增第二份封存；不同文本不覆盖原记录。没有执行前检查点的旧消息显示缺现场，材料缺失不现场补造。进程重启后，对仍存在且归属有效的消息可查询原记录。
- 封存通过保留引用 pin 住清单和可达 blob，不受普通期限/配额回收。采集存储在源 worktree 外，属于同 OS 用户可信存储，不挂载给评测 agent。

### WikiSkill 用例与版本存储（已实现的底座）

- `scripts/badcase-capture/import-text-cases.cjs --config <绝对路径> --confirmed` 是操作方入口，不部署到 3100。配置仅含 `captureRoot`、`sourceWorktree`、`projectId`、`selections`；每项 selection 仅含用户确认的 `conversationId`、`messageId`、`actual`、`expected`。没有确认参数时不访问 API、不落盘。
- 导入仅 GET 固定 `http://127.0.0.1:3100` 的会话、分页公共消息和所选消息的 tool-trace API；不打开生产 SQLite、不 POST 标记、不读私信/session 文件、不修改生产库，不转发认证或跟随重定向。只接受终态 `role-family-gpt` assistant 消息，每批最多 20 条，每房间最多扫描 100 页（每页 100 条），单响应最多 2 MiB，单请求 10 秒；越界或不支持直接失败。
- 纯文本用例保存实际问题、期望、GPT 角色、源消息与轨迹摘录。摘录各最多 32 KiB 并显式标截断，轨迹 API 404 显式标缺失，其他失败不冒充缺失；沿用秘密哨兵拒绝策略，不声称可检测所有秘密。整批成功才本地原子发布，同一来源同内容重提幂等，变化则冲突，不覆盖已确认材料。此入口不封存现场，永远记录 `kind: text-only`、`replayable: false`、`split: train`，不能用于回放评分。
- wiki 自包含文本存于源 worktree 外的 `<captureRoot>/wiki/<projectId>/snapshots/`，不把文本放进 checkpoint CAS。复用项目 writer lock，每次变更追加带 checksum 的不可覆盖快照；重启读取最新完整快照，损坏拒绝而不退回旧审核状态。该目录不属于 checkpoint TTL/配额或 orphan GC 的删除范围，也不算作 CAS 容量。
- `wiki-store.ts` 的 draft 接口校验所选训练用例关联、每用例至少归入一条或有明确未归类原因；未知用例/遗漏拒绝。条目含标题、失败模式、症状、根因假设、≤300 Unicode 字符的 prompt 准则、关联用例 ID 和 `draft/approved/rejected` 状态。模型输出不能指定批准状态；每次重新生成创建新版本，不覆盖旧版本。
- 审核接口以当前 revision 防止旧页面覆盖新状态；只允许编辑 draft 的文字、通过或驳回，审核后的条目冻结，重新生成另起 draft 版本。重分组需重新生成，最小编辑器不改关联用例。这里的模型名与 draft 数据是待接入生成器的存储契约，**目前尚未接通真实模型聚类、审核页面、候选 prompt 或批量评测**；合成定向测试不构成 AC5–AC7 的真实用例证据。

### 可回放子集与对比入口

- 当前正式 MVP 入口为 `scripts/badcase-capture/compare-sealed.cjs`。`--config <绝对路径> --plan` 只准备与校验材料，不读 Key、不接触 Docker/模型；`--run --confirmed --output <新的绝对路径>` 才执行，输出路径已存在时拒绝覆盖。
- 配置显式指定封存关联、可信代码/依赖根、固定镜像身份、候选角色、重复次数、规则和超时。`repeats` 为 1–20，超时 1–300 秒，默认每容器 120 秒。新输入/角色/规则不自动复用旧结果。
- `sealed-direct-input.cjs` 重新读取封存与保留引用，验证所有引用 blob 的 hash、角色片段唯一性/位置、原始运行配置、回调材料及 portable-default-resources 声明。只接受材料完整的 fresh、无图片、无额外技能/外部设置依赖的已声明可移植子集。旧封存不原地修补；不支持时返回 `unsupported_or_missing_replay_materials`，不是空会话 fallback。
- 原变体使用封存 prompt；候选只替换归档时已定位且 hash 匹配的角色指令片段。其他归一化输入保持相同，分别记录 checkpoint/common-input/variant/distribution hash，每次运行前重验封存和可信分发未变。模型是明确选择的评测配置，不把它冒称为采集模型本身。
- 受控替换仅限已记录的工作根、回调地址/临时身份、会话标识、工具与私有目录变量；未知占位符或替换计数不符拒绝。回调在容器内独立建立，不连接生产会话/DB。公共回复参与评分，不能以最后一条内部 SDK 文本替代已发布内容；未发布时回复为空。worker 记录 `replySource`（`public` / `internal` / `none`），逐次结果/事件与 CLI 展示该来源；缺少可信来源记录时标 `unknown`，不把未知说成未发布。规则只接受 `public`，缺来源的旧 receipt 不重新判为通过。
- 真正的原 CAFF SDK、工具和扩展在 Docker 内执行，不播放历史工具输出，不在宿主运行被测 agent。可信固定分发包括匹配的 Linux 原生依赖；缺依赖直接失败，不移除工具/扩展绕过。

### 模型与凭据

- 用户本轮选择 `modelProfile: "deepseek/deepseek-v4-flash"`，与官方 `https://api.deepseek.com` 配套，原/候选同模型、采样和资源条件。旧默认 `opencode-go/deepseek-v4.1-flash` 只为显式旧配置兼容保留，不将 CAFF 的 DeepSeek Key 发往 OpenCode。
- `keySource: "caff-deepseek"` 是用户显式授权的只读来源：宿主从 `PI_CODING_AGENT_DIR/models.json` 取匹配官方 provider 的 Key，支持字面值或 `$ENV_NAME`，拒绝 shell 表达式、错端点、错模型和缺来源；不自动扫描 auth.json、不回退其他凭据，不修改原模型配置。
- 另一显式来源为 `keySource: "evaluation-env"`（省略时同义）：读取 `CAFF_BADCASE_MODEL_KEY_FILE` 或 `CAFF_BADCASE_MODEL_KEY`。文件显式设置后，无效/缺失不得退回环境 Key。Windows 操作方可在受信启动器中只读 CAFF Key，经内存管道送到 Linux 宿主的该环境变量；不复制整份 CAFF 配置。
- Key 仅按环境变量名注入一次性容器，不进入 argv、env 文件、输入 tar、镜像、模型描述、归档或结果。容器 models.json 只写环境引用。选定 Key 出现在输入/输出时拒绝；错误不保存供应商响应正文或未净化 stderr。
- 每个实际 SDK HTTP 请求记一行：明确模型、耗时、HTTP 状态、成败和 SDK 可得的用量；不可得为 null，不估算供应商账单。原生 SSE 不经过自建模型网关或重写。失败后锁闭后续请求并停止剩余变体，不自动重试。进程/基础设施失效而没有可信请求记录时标 unknown，不捏造零调用。
- 用户授权的模型 Key 在容器进程环境内可见，这是本轮明确允许的能力；不宣称对容器内代码或 Docker 管理员保密。不能挂载生产 DB、整份凭据目录或其他生产认证。

### 容器与评分边界

- 只使用本地已存在、ID/RepoDigest/架构匹配的固定 Linux 镜像，不自动 pull/build。每次新容器：非 root `65534:65534`、只读根、cap-drop ALL、no-new-privileges、非 privileged、1 GiB 内存/同额 swap 上限、2 CPU、128 pids、独立 IPC、超时强停。
- `/work` 与 `/tmp` 为限额 tmpfs；无宿主 bind、生产 DB/凭据目录、Docker socket、设备或发布端口。输入经 stdin tar 放入 tmpfs，工作目录是恢复出的副本。Docker 日志驱动为 none，inspect 只保存脱敏隔离投影，不保存包含环境值的原对象。
- 真实模型运行使用 bridge 网络；native fetch 观察器只放行选定模型 URL 和容器本地回调。**这不是工具进程的网络出口防火墙**，不承诺阻止任意恶意项目代码外联；本 MVP 只执行用户确认的受信只读 trace，不将其用于敌对代码隔离保证。
- 宿主在容器退出、核验身份/隔离并确认删除后才评分。`pass`/`fail` 为可评分的任务结论，模型/worker/清理失败为 `error`；未执行次数单独列出，不从分母消失。
- 当前规则 `read-only-files-v1` 要求指定路径确有成功 read、前后文件树 hash 相同、无 write/edit 调用，公共回复包含用户确认的字面片段。宿主与容器将完整相对路径按同一字典序排序后计算文件树 hash，不使用目录深度优先顺序。`absentPaths` 必须与归档删除清单及文件缺席一致；字面回复核对不是语义评分器或自动根因判断，规则/评分只在宿主，不发送独立参考答案。
- 本轮确认的流程样例：checkpoint `c559893e-0bd7-4f13-8b19-71317b8acaf9`；读取 tracked.txt、dirty.txt、untracked.txt，零文件改动；回复包含 `stable file`、`dirty before turn`、`untracked before turn`、`deleted.txt`、`不存在`。候选仅追加逐项核验要求，原/候选各 3 次。
- 作者真实运行结果为原 3/3、候选 3/3，18 次模型请求，6 容器均已删除。这证明流程闭环，不是 badcase 已复现、候选提分或独立审查通过。原始记录在忽略的私有证据存储中，Goal 引用这些记录；旧记录没有 `replySource`，不回填或声称已按修复后的来源规则重跑。

### 暂存期限、配额与回收

- 默认暂存规则为 7 天、每项目 10 GiB。已有实现是**显式离线操作方回收**，不是后台定时任务；运行前必须停止该存储的采集、turn、封存和 replay 写者，不能以 `--writers-stopped` 参数代替实际停写。
- `expire-checkpoints.cjs` 先预览：`--capture-root <绝对路径> --project <ID> --as-of <ISO时间> --retention-days 7 --quota-bytes 10737418240`。确认仍是同一计划后，再追加 `--expire <planHash> --confirm --writers-stopped`。
- 按到期及最旧优先配额压力选择可回收清单；封存/保留、已标记、运行引用、latest、未知引用/状态均保守保护。保护数据本身超额时如实返回配额仍不满足，不删封存来凑数。
- 第一步只删可回收清单。之后用 `collect-orphan-blobs.cjs` 的独立预览/planHash/确认入口删无引用 CAS；共享 blob 只计一次且仍被任一保留对象引用就保留。预览变化、存储损坏或锁争用拒绝删除；部分删除准确报告，崩溃残锁不自动解锁或重跑。
- 不自动删除 sealed case、保留引用、未知临时文件或其他 Room 数据。遗留锁/临时数据需另行确认来源后处理，不属于本次真实环境的破坏性清理授权。

### 验证与交付

- 收尾检查为 `npm run typecheck`、`npm run build`、`npm run test:fast`、`npm run test:smoke`；回收测试额外覆盖 Linux 原生 collector 的暂存过期、保留/最新仍可恢复，以及 TTL/配额/共享 CAS/异常保护。
- 中途只跑定向检查，收尾对最终固定 SHA 由 DeepSeek 独立审查；发现阻断项再修复、只复审修复。作者自验不替代审查，用户最终接受前不宣称交付完成。
- 只在本 Room 分支/worktree 实现；生产 3100 不变，不自动合并、推送或部署。历史设计的独立审查归属不因本契约收敛而改变。
- `c533d58e` 独立审查的 9 项 P3 仅记录：每轮最多 32 次模型请求；仅容忍 `windows_capture_subset_unverified` 这一 incomplete 理由且仍须 portable 声明；角色定位缺失/歧义时原变体也保守拒绝；summary 未单记候选角色 hash/原文；基础设施错误阶段被泛化；旧运行代码 SHA 对应靠人工核字节；凭据环境名是注入声明；旧 fast 为精确分段续跑；隔离投影未直接展示 Tmpfs（执行已断言）。

### 不支持清单

- 任意宿主现场在 Linux 的通用恢复、进程内存/后台服务/外部系统状态、权限/ACL/链接/并发原子一致性、`.git`/index/git status 的逐字保真。
- 此 MVP 主路径以外的换根、外置 Git 元数据、submodule/嵌套仓库、全局 Git 配置、复杂 ignore 语法；底层保留旧实现不等于本轮承诺其端到端可用。
- 正式 sealed-direct 入口的 resume、图片、额外技能/外部系统指令/自定义设置或旧缺材料封存。底层 fresh/resume 合成 Docker 演练不冒充这些历史用例已可回放。
- 尚未接通的真实模型 wiki 聚类、审核页面、approved 条目到候选 prompt 的生成与确认、批量评测，不因存储接口已存在就视为可用。未经用户审核自动生效、多轮自动调优、语义自动判分、任意规则插件、自动提分/确定性保证、自动发布或修改生产 prompt 均非本 Goal 承诺。
- 后台自动定时 GC、任意不可信代码的外联隔离、对同权限宿主/Docker 管理员隐藏容器环境 Key，以及没有可信 worker 记录时的精确供应商计费证明。
