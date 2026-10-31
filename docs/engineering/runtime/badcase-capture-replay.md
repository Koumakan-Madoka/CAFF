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

### WikiSkill 用例、模型归纳与审核

- `scripts/badcase-capture/import-text-cases.cjs --config <绝对路径> --confirmed` 是操作方入口，不部署到 3100。新全局配置含 `globalRoot`（实例的 `<agentDir>/badcase-global`）、`sourceWorktree`（仅用于校验存储在源目录外）、`selections`；不含所属 `projectId`。旧项目配置只为迁移/历史入口兼容保留。每项 selection 仅含用户确认的 `conversationId`、`messageId`、`actual`、`expected`。没有确认参数时不访问 API、不落盘。
- 导入仅 GET 固定 `http://127.0.0.1:3100` 的会话、分页公共消息和所选消息的 tool-trace API；不打开生产 SQLite、不 POST 标记、不读私信/session 文件、不修改生产库，不转发认证或跟随重定向。只接受终态 `role-family-gpt` assistant 消息，每批最多 20 条，每房间最多扫描 100 页（每页 100 条），单响应最多 2 MiB，单请求 10 秒；越界或不支持直接失败。
- 纯文本用例保存实际问题、期望、GPT 角色、源消息与轨迹摘录。摘录各最多 32 KiB 并显式标截断，轨迹 API 404 显式标缺失，其他失败不冒充缺失；沿用秘密哨兵拒绝策略，不声称可检测所有秘密。整批成功才本地原子发布，同一来源同内容重提幂等，变化则冲突，不覆盖已确认材料。此入口不封存现场，永远记录 `kind: text-only`、`replayable: false`、`split: train`，不能用于回放评分。
- 用户确认重放任务来源后，先运行 `assign-wiki-split.cjs --config <绝对路径> --confirmed`，新全局配置含 `globalRoot/sourceWorktree/caseIds`；caseIds 是计划重放任务对应的已导入源用例，不是已回放的证明。固定种子 `wikiskill-holdout-v1` 对源 ID 排序哈希，≥6条取 `round(N/3)` 条留出，其余训练；不足6条不建独立测试集并显式披露。未选作重放任务来源的纯文本用例仍为训练集；为满足 wiki 的≥10条训练要求，须在扣除留出来源后仍有足够材料。
- 划分写入外部 wiki 快照并冻结，同一集合不同顺序重提幂等，不允许看结果后换种子/增删任务重划。曾进入任一 wiki 版本的用例不能后来伪称未见测试集；已标为 test 的来源在生成入口读取 Key 前被拒绝，存储层也拒绝其混入 draft。重新导入不把 test 改回 train，源用例仍 `text-only/replayable:false`；页面只展示计划划分，不把它冒充可回放数量。若最终有任务不支持，后续批量报告须披露真实可回放数，不重划来隐藏缺口。
- wiki 与用例是全局对象：存于源 worktree 外 `<agentDir>/badcase-global/snapshots/`，记录 `scope: global`，没有所属项目；用例只在 `source` 中记录来源项目/房间/消息。API 不依赖项目存在或当前激活项目。复用 writer-lock 原语在独立根下取固定锁，每次变更追加带 checksum 的不可覆盖快照；重启读取最新完整快照，损坏拒绝而不退回旧审核状态。不属于 checkpoint CAS、TTL/配额或 orphan GC 的删除范围。
- `migrate-global-wiki.cjs --config <绝对路径> --confirmed` 显式迁移已有本地集合，不访问3100或模型。配置含 `globalRoot/sourceWorktree/legacy`，legacy 含旧 `captureRoot/sourceWorktree/projectId`。保留全部用例、版本、条目ID/文字/审核状态、时间与固定划分；源快照不修改，目标记录迁移来源 checksum。相同源重复迁移无写入，不覆盖迁移后的审核；只支持一个既有集合迁入空全局存储，多集合合并直接拒绝。
- `wiki-store.ts` 的 draft 接口校验所选训练用例关联、每用例至少归入一条或有明确未归类原因；未知用例/遗漏拒绝。条目含标题、失败模式、症状、根因假设、≤300 Unicode 字符的 prompt 准则、关联用例 ID 和 `draft/approved/rejected` 状态。模型输出不能指定批准状态；每次重新生成创建新版本，不覆盖旧版本。
- `generate-wiki.cjs --config <绝对路径> --confirmed --output <新的绝对路径>` 是操作方模型归纳入口，新全局配置只含 `globalRoot`、`sourceWorktree`、明确所选的 `caseIds` 和沿用 S3 的固定 `image` 身份。每次1–20条、输入最多1 MiB，只投影所选 GPT 训练用例的问题/期望/消息/轨迹摘录与截断状态；测试集、其他用例、源认证配置不发送。无确认、未知或非训练用例在读取 Key/调用模型前拒绝。模型内容为不可信数据，宿主验证字段、≤300字及全用例覆盖后才追加新版本；不自动重试、补写遗漏或批准条目。
- 归纳只调用官方 `deepseek/deepseek-v4-flash` 一次，复用 D4 的只读 Key 来源与 `runDirectDockerTask` 一次性容器隔离，不在宿主推理，不挂载生产 DB、凭据目录、Docker socket 或真实仓库；仅输入一个文本 JSON 和固定 worker，无 agent 工具。容器最长120秒、响应最多512 KiB，非200/截断/无效JSON失败。输出 JSONL 记录模型、耗时、成败、可得用量、容器清理/隔离投影与新版本ID；基础设施未提供调用记录为 null，不冒称零调用。CLI 保留现有 Linux Docker 宿主要求，Windows 须由受信操作方沿用 S3 的 Linux 执行方式，页面不提供模型/Key/镜像 JSON 配置。
- 独立主导航 `/wikiskill.html` 提供全局用例、Wiki 审核、候选、对照结果四区均已接通：展示全部来源用例（包括留出/未归类），以及关联同类任务的可回放封存、分组、固定提交与检查点；历次版本、归类覆盖，编辑 draft 并通过/驳回；候选区选择声明目标和当前版本已通过条目，生成草稿、查看全文/diff、确认。来源纯文本不会冒充原历史现场。结果区只读展示本轮全局目标已保存的逐题/逐轮、总体、训练/留出、复现/探针/控制汇总；没有结果时明确提示，不将旧角色候选或筛选结果当作本轮交付；`projects.html` 移除 wiki/离线评测控件，只保留项目采集目录与开关。
- `register-replay-cases.cjs --config <绝对路径> --confirmed` 是受信操作方登记入口，不调用模型。配置含 `globalRoot/sourceWorktree/cases`，每条含原 `sourceCaseId`、`category`（reproduction/probe/control）、已批准任务、固定样例提交/来源提交/子目录/文件清单 hash、`request` 封存关联、`rules` 和 `checkpointHash`。整批先校验评分规则及真实封存闭包，再一次性发布；登记只继承既有来源划分，不重抽留出、不改来源纯文本或已审核 wiki，不允许复用检查点或覆盖既有来源任务。操作方负责来源与任务/提交的语义对应；页面的“可回放”只表示登记时通过预检，正式评测仍须重验全部材料，不能替代运行结果。记录存于全局快照 `replayCases`，不是所属项目；`request` 中项目 ID 仅用于定位来源采集归档。
- `GET /api/wikiskill` 只读返回全局状态与实际声明目标目录；`POST /api/wikiskill/review`、`/candidate`、`/confirm-global-candidate` 沿用本地管理 Host/Origin/CSRF 门禁与严格布尔确认。不接受客户端选择项目、存储根、文件证据或任意候选正文；生成绑定 versionId/entryIds/targetId 与 revision，确认绑定 candidateId/candidateHash 与 revision。审核后的条目冻结；重分组需重新生成，最小编辑器不改关联用例。加载、保存、审核不生成候选；只有显式点击生成才确定性创建草稿。上述操作均不调用模型、不启动评测、不改生产角色/提示词/工具。生成与确认复用 `collectWikiCandidateFiles`，重新读取全部已登记封存及保留清单，核对 checkpoint/blob hash、普通文件/大小与秘密哨兵后作字面泄漏检查；读取总量≤4MiB、文件≤1024，缺材料直接拒绝，不退回 live cwd。写入失败或结果未知时禁用写入、要求刷新核对，不自动重试。旧项目 wiki HTTP 路由不再提供。
- 全局目标 `global-harness-behavior-v1` 声明在 `lib/agent-prompt-targets.ts`：它是 `agent-prompt.ts` 已有且所有角色/两种路由模式共用的7行行为准则，不是 GPT persona，也不是 SDK 的 `SYSTEM.md`。抽取常量不改变正常 turn 的任何 prompt 字节。`prepareSealedPromptTarget` 只在封存 prompt 的 Room work context 与 Routing instructions 之间定位唯一、完整、hash 固定的这一个片段；候选仅替换其内容，其余身份/角色/路由/工具/技能/文件/回调不变，并记录目标 hash 与去除该片段后的共同输入 hash。无需旧角色 `roleSpan`，也不为缺片段、版本不符、重复/引用或材料不全的旧封存补造目标。离线准备与正式对照执行内核已接通；真实候选与 A/B 尚待用户审核/确认。
- `create-wiki-candidate.cjs --targets` 只读列出声明目标：1个全局行为片段及8个 CAFF 工具的单一 description。工具目录直接取实际注册定义的文字副本，不执行注册函数、不暴露或改变参数 schema/执行器。新全局生成配置仅含 `globalRoot/sourceWorktree/versionId/entryIds/targetId`，仍经 `--config <绝对路径> --confirmed` 操作方入口；只选同一版本内 approved 条目，候选确定性等于该目标原文加所选准则，保存目标/候选 hash 和可应用 diff，初始为 draft。生成先重新读取所有已登记封存及其 checkpoint hash，扫描文件与全部来源期望；新的全局内核对完整候选执行既有字面泄漏拒绝，不只检查新增准则。确认内核绑定 candidateHash/当前 revision，再验当前目标定义、approved 来源和传入的文件材料；不启动模型、不写入正常 agent 或工具配置。前端已接通选择/生成/确认，只展示新全局目标候选及两种目标的边界；确认本身不评测。全局提示词批量 CLI 已接通下述确认门禁，真实候选仍等待用户审核 wiki；工具描述本期不要求评测结论，执行入口明确拒绝该类型。
- 以下角色候选/批量机制是已有兼容基础，不是新版 D12 全局目标的完成声明。新版只替换一个声明的全局系统提示词片段，其余配置不变；工具 description 暂只生成/确认，页面不暴露旧角色确认入口。
- `create-wiki-candidate.cjs --config <绝对路径> --confirmed` 是旧版无模型的角色候选生成入口。配置含 `captureRoot/sourceWorktree/projectId/versionId/entryIds/request`；request 必须是同项目 GPT 的封存关联。复用 sealed-direct 校验并从封存中提取原角色，不读取当前生产角色、不补造缺材料。只选一个 wiki 版本内的 approved 条目，候选严格等于原角色原文 + 固定标题/项目符号包装的所选准则，不追加用例期望、标题、症状或根因文字。候选、原文、追加段、diff、角色 hash、条目与封存锚点、文件 hash 一起保存在外部 wiki 快照中，初始为 draft；同内容重提幂等。
- 准则的泄漏检查是**字面启发式，不是语义检测**：拒绝包含已导入用例的完整非空期望/非空行，或与期望/用例文件共享任意连续≥8个 Unicode 字符；完整非空文件内容即使不足8字也拒绝。生成时只读扫描封存锚点文件；比较入口对每个实际封存输入再次扫描文件，并对当前已导入的全部期望重验。参考答案不发给被测模型；不宣称识别短于8字且非完整值/行的片段、改写或所有秘密。失败只报通用泄漏码，不打印命中的参考内容。
- 旧角色候选的确认基础仍绑定候选 ID/hash 与当前 revision，并重验批准状态和泄漏；确认本身不启动评测、不修改生产 prompt。新全局页不提供此旧角色操作；全局目标确认使用独立路由，评测使用独立的全局候选配置。读取旧版无 candidates 的快照只在内存补空数组，不改原文件。
- `compare-sealed` 可用 `wikiCandidate: { sourceWorktree, candidateId }` 替代 `candidateRole`；两者不能混用。此模式在读取 Key/接触 Docker 前要求持久化确认、所选来源仍 approved、候选内容/hash 可重建、当前封存的原角色 hash 与候选锚点一致；不同角色版本明确拒绝，不对各用例偷偷拼接不同候选。每轮继续重验，并在 plan/results summary 记录候选 ID、wiki/条目与候选角色 hash。旧的手写 `candidateRole` 入口保留兼容，但不代表获得 wiki 审核/确认。
- 已只读导入用户确认的16条真实历史；保持13条训练、3条留出（#4/#10/#14），由训练集真实生成5条 wiki 草稿。用户已批准方案A的7道题：R1/#1、R2/#4、R9/#2三道汇报复现题，v6 R3/#6接口膨胀探针，#10/#14/#16三道控制题；不再继续筛题，不重归纳wiki。当前7题均完成真实原生采集/恢复字节比对；通过隔离的操作方 SQLite 消息/运行记录和一次性 Docker SDK 执行封存5题，不冒称正常聊天调度或原历史现场。准备阶段第5题（#10）模型重复工具调用后未完成，记 error，封存其执行前现场而不改判 fail/pass；停止后续2题、未重试该轮。正式对照仍须保留全部7题槽位。只复现了汇报难懂一类，不能把字面误伤当复现；尚未完成全局目标候选或正式 A/B，AC5–AC7 不因接口存在而自动通过。

### 可回放子集与对比入口

- 当前正式 MVP 入口为 `scripts/badcase-capture/compare-sealed.cjs`。`--config <绝对路径> --plan` 只准备与校验材料，不读 Key、不接触 Docker/模型；`--run --confirmed --output <新的绝对路径>` 才执行，输出路径已存在时拒绝覆盖。
- 配置显式指定封存关联、可信代码/依赖根、固定镜像身份、候选角色、重复次数、规则和超时。`repeats` 为 1–20，超时 1–300 秒，默认每容器 120 秒。新输入/角色/规则不自动复用旧结果。
- `sealed-direct-input.cjs` 重新读取封存与保留引用，验证所有引用 blob 的 hash、角色片段唯一性/位置、原始运行配置、回调材料及 portable-default-resources 声明。只接受材料完整的 fresh、无图片、无额外技能/外部设置依赖的已声明可移植子集。旧封存不原地修补；不支持时返回 `unsupported_or_missing_replay_materials`，不是空会话 fallback。
- 原变体使用封存 prompt；候选只替换归档时已定位且 hash 匹配的角色指令片段。GPT 模型族角色本来没有自定义 persona，采集仅把它已交付的 `Rules:` 段定位进元数据，不改变 SDK 实际收到的 prompt；候选在这段规则原文后追加已审核准则，身份/会话/工具/技能等其他段不变。旧自定义角色仍使用 `Your private persona instructions:` 段；两种包装分别校验原片段 hash 并保留原包装，不为 GPT 虚构 persona，不为无片段的旧封存补造定位，其他模型族的 Rules 段不在此首个 GPT 子集内。其他归一化输入保持相同，分别记录 checkpoint/common-input/variant/distribution hash，每次运行前重验封存和可信分发未变。执行模型是明确选择的评测配置，当前是 DeepSeek 执行 GPT 角色指令，不冒称 GPT 模型或采集时的原模型。
- 受控替换仅限已记录的工作根、回调地址/临时身份、会话标识、工具与私有目录变量；未知占位符或替换计数不符拒绝。回调在容器内独立建立，不连接生产会话/DB。公共回复参与评分，不能以最后一条内部 SDK 文本替代已发布内容；未发布时回复为空。worker 记录 `replySource`（`public` / `internal` / `none`），逐次结果/事件与 CLI 展示该来源；缺少可信来源记录时标 `unknown`，不把未知说成未发布。规则只接受 `public`，缺来源的旧 receipt 不重新判为通过。
- 真正的原 CAFF SDK、工具和扩展在 Docker 内执行，不播放历史工具输出，不在宿主运行被测 agent。可信固定分发包括匹配的 Linux 原生依赖；缺依赖直接失败，不移除工具/扩展绕过。

### Wiki 批量对照

- 新全局模式仍复用 `compare-wiki-batch.cjs` 的 `--plan` / `--run --confirmed --expected-plan <hash> --output <新的绝对路径>` 与同一个 `runComparison`/Docker launcher，不新增执行后门或环境权限。全局配置只含 `globalRoot/sourceWorktree/candidateId/repoRoot/dependencyRoot/image/repeats/timeoutMs/cases`；每项 case 仅含 `sourceCaseId/category`，封存请求、规则、固定提交、checkpoint hash 从全局已登记任务派生，禁止调用方改写规则、塞候选正文或混入旧所属项目字段。整个批次在 Key/Docker 前重验 confirmed 候选、approved 来源、全局声明目标、所有登记文件的字面泄漏、冻结划分和逐题现场；工具 description 不支持执行，缺全局片段不降级为旧角色替换。
- 新全局单例配置使用 `globalWikiCandidate: { globalRoot, sourceWorktree, candidateId }`，与 `candidateRole/wikiCandidate` 严格互斥。以封存中精确匹配的声明片段为原版本，仅替换为确认的同一 `candidateText`；记录 targetId/baseHash/candidateHash、checkpoint/common-input/input hash，其余角色、工具、技能、回调、文件等不变。每次重验候选及封存，不读取 live worktree 或生产 prompt。
- 全局题组是**显式确认的新任务清单**，不重划原8来源的训练/留出。必须包含原有全部3条留出，其他来源只能是该 wiki 版本已见过的训练用例。方案A保留7题（排除原2条训练任务、加入#2），记录 `excludedSplitTrainingCaseIds/additionalTrainingCaseIds`；不能为沿用旧任务清单而扩大为9题，也不能把旧训练任务的移除说成留出被删除。确认的7题中缺登记或不支持的槽位仍计入7×N分母，分别标 unsupported/未运行；补齐封存或更改题组会改变 planHash，不能沿用旧执行确认。旧角色模式的保留全部原槽位要求不变。
- 新全局结果保留逐轮 pass/fail/error、逐题与总体/训练/留出/复现/probe/控制汇总，CLI 明示通过/计划、错误、未运行及可评分通过率；JSONL 每行仍包含来源与题型，记录模型请求、耗时、成败与可得用量。失败即停、未知调用不伪作零、无自动重试和 D5 隔离沿用既有执行器。报告固定披露基线筛选选择偏差及“只复现了汇报难懂一类”，不把接口探针或控制题冒充更多失败类别。当前仅合成完整封存与驱动验证，未批准真实 wiki、生成真实候选或发起正式 A/B，不因页面接通就声称真实评测完成。
- 全局 CLI 的 `--run` 在批次结束后（包括 error/unsupported/未完整执行）把摘要保存到 `<globalRoot>/comparisons/`，并输出 `comparisonId`。`--plan` 不落盘、不调用模型。每次执行有独立 `executionId`，同一次结果重复保存幂等，不把两次碰巧分数相同的执行合并；原子 no-replace 文件带 checksum，损坏拒绝读取。存储沿用全局根/源目录隔离验证，不改变 wiki revision、审核、用例或冻结划分；不属于 checkpoint 回收范围。仅受信操作方可写，保存时核对已确认的全局提示词候选、当前来源/登记/划分。属于 same-OS-user 证据记录，不是不可伪造的运行证明。
- 结果摘要只保留固定模型、候选/计划/运行/检查点/规则 hash、逐轮状态/原因、已知调用数及未知标记；计数/通过率从逐轮状态重算，不信任输入汇总。不复制公共回复、文件内容、完整模型调用/usage、任意 worker 字段或 Docker inspect。原始逐调用/文件/隔离证据仍在操作方 `--output` JSONL；选定 Key 的拒绝边界不变。结果文件≤512KiB，页面/API返回最近20份。保存失败明确报错，已 fsync 的 JSONL 保留，不重试模型；受信操作方可从其中最后的 `batch_summary` 调用同一结果存储恢复保存。
- `GET /api/wikiskill` 同时返回只读 `comparisons`，页面显示通过/计划、失败、error、未运行、可评分分母和 N/A，始终披露筛选偏差与复现范围；没有网页启动评测、上传/改写结果或自动重试接口。页面刷新不读 Key、不运行 Docker/模型。
- 以下为旧角色兼容模式，不能替代新版全局目标验收。
- `compare-wiki-batch.cjs --config <绝对路径> --plan` 只读预检整个批次：固定的 GPT 已确认候选、approved 来源、冻结划分、每条封存/角色/文件泄漏检查与规则，返回 `planHash`；不读取 Key、不接触 Docker，不把预检支持称为已运行。真正执行需 `--run --confirmed --expected-plan <hash> --output <新的绝对路径>`，计划变化即拒绝；不覆盖旧结果。确认 flag/hash 是受信操作方对用户已批准用例/规则的执行确认，不是人类身份认证。
- 配置仅含 `captureRoot/sourceWorktree/projectId/candidateId/repoRoot/dependencyRoot/image/repeats/timeoutMs/cases`，每条 case 仅含 `sourceCaseId/request/rules`。必须保留冻结计划的全部来源槽位，禁止重复源或复用同一个检查点凑数；关联必须是本项目、本采集根的 GPT。筛选替换任务可补充**已属于该候选 wiki 版本训练集**的来源，记录为 `additionalTrainingCaseIds`，仍是 train，不改写存储中的划分、不重抽留出；新增未参与该版本归纳的来源拒绝。增补改变计划 hash，必须按新计划取得用户确认，不能沿用旧执行确认。request 和 rules 均为 null 可明确标无封存；被替换的原计划来源也须保留为不支持项并计入未执行分母，不得偷偷删去困难的留出项。其余缺材料按 sealed-direct 不支持处理；不是把历史文本当可回放任务。用户确认的重放任务与新封存的对应由操作方显式绑定，不能由本 CLI 自动证明任务语义等价。
- 单一候选不得使用留出来源生成的 wiki；各用例必须与候选的原角色 hash 一致。对**全部**用例先预检，最后一条角色不匹配/泄漏也在任何 Key/模型使用前阻断；初始不支持用例明确列出并保留分母，其余可支持用例可继续执行。默认原/候选各3次，沿用单例1–20次、超时和 D5 容器隔离，不给批量入口新增网络/挂载权限；固定官方 DeepSeek 模型与 D4 Key 来源，批内只读 Key 一次，仅以环境变量注入各一次性容器。
- 每条仍复用 `runComparison`。每个用例执行前重验整体计划，每次模型运行仍重验封存和固定分发；用例间 runtimeHash 变化在后续模型执行前拒绝。基础设施或模型 error 停止余下批次，不重试；普通任务 fail 不阻断其余轮次。JSONL 保留带来源 ID/分组的逐调用、逐轮、逐用例和整批汇总；异常中断保留已知事件，未得到完整证据的活动槽位记基础设施 error 并标调用记录未知，不补造成功或零调用。
- 逐用例、总体、训练、留出分别报告原/候选的 planned/attempted/pass/fail/error/notRun。`passRate = pass/(pass+fail)` 仅对可评分项，零分母为 null/N/A；同时保存 `plannedPassRate = pass/planned`，CLI 明示通过/计划、失败、错误、未运行及可评分分母，不能用剔除错误假装整体提分。`completed` 只表示所有计划轮次完成，不等于所有任务通过。准备支持少于6条、wiki训练少于10条会显式披露，不因数量字段存在就满足验收。
- 该旧角色批量入口仍为操作方 CLI，不提供网页一键启动或结果库；只有上述新全局目标结果可进入 WikiSkill 结果区。输出 JSONL 与 CLI/JSON 汇总作为结果材料。旧链仅合成驱动验证，不冒称新版全局目标已真实运行或用户接受。

### 模型与凭据

- 用户本轮选择 `modelProfile: "deepseek/deepseek-v4-flash"`，与官方 `https://api.deepseek.com` 配套，原/候选同模型、采样和资源条件。旧默认 `opencode-go/deepseek-v4.1-flash` 只为显式旧配置兼容保留，不将 CAFF 的 DeepSeek Key 发往 OpenCode。
- `keySource: "caff-deepseek"` 是用户显式授权的只读来源：宿主从 `PI_CODING_AGENT_DIR/models.json` 取匹配官方 provider 的 Key，支持字面值或 `$ENV_NAME`，拒绝 shell 表达式、错端点、错模型和缺来源；不自动扫描 auth.json、不回退其他凭据，不修改原模型配置。
- 另一显式来源为 `keySource: "evaluation-env"`（省略时同义）：读取 `CAFF_BADCASE_MODEL_KEY_FILE` 或 `CAFF_BADCASE_MODEL_KEY`。文件显式设置后，无效/缺失不得退回环境 Key。Windows 操作方可在受信启动器中只读 CAFF Key，经内存管道送到 Linux 宿主的该环境变量；不复制整份 CAFF 配置。
- Key 仅按环境变量名注入一次性容器，不进入 argv、env 文件、输入 tar、镜像、模型描述、归档或结果。容器 models.json 只写环境引用。选定 Key 出现在输入/输出时拒绝；错误不保存供应商响应正文或未净化 stderr。
- 每个实际 SDK HTTP 请求记一行：明确模型、耗时、HTTP 状态、成败和 SDK 可得的用量；不可得为 null，不估算供应商账单。每条真实请求最多接收一次完成事件；达到请求上限等在 HTTP 发出前被拒绝的 SDK 错误、重复完成事件不得覆盖上一条已完成请求。HTTP/传输失败已结算后，SDK 后续错误也不得把耗时延伸到拒绝重试的等待时间或虚构零用量；turn 失败仍单列 error，不因已有请求都成功就判为通过。旧运行原始记录保留，不按修复后的逻辑回填缺失用量或追算通过。原生 SSE 不经过自建模型网关或重写。失败后锁闭后续请求并停止剩余变体，不自动重试。进程/基础设施失效而没有可信请求记录时标 unknown，不捏造零调用。
- 用户授权的模型 Key 在容器进程环境内可见，这是本轮明确允许的能力；不宣称对容器内代码或 Docker 管理员保密。不能挂载生产 DB、整份凭据目录或其他生产认证。

### 容器与评分边界

- 只使用本地已存在、ID/RepoDigest/架构匹配的固定 Linux 镜像，不自动 pull/build。每次新容器：非 root `65534:65534`、只读根、cap-drop ALL、no-new-privileges、非 privileged、1 GiB 内存/同额 swap 上限、2 CPU、128 pids、独立 IPC、超时强停。
- `/work` 与 `/tmp` 为限额 tmpfs；无宿主 bind、生产 DB/凭据目录、Docker socket、设备或发布端口。输入经 stdin tar 放入 tmpfs，工作目录是恢复出的副本。Docker 日志驱动为 none，inspect 只保存脱敏隔离投影，不保存包含环境值的原对象。
- 真实模型运行使用 bridge 网络；native fetch 观察器只放行选定模型 URL 和容器本地回调。**这不是工具进程的网络出口防火墙**，不承诺阻止任意恶意项目代码外联；本 MVP 只执行用户确认的受信任务（旧只读 trace 或已确认的文件产出任务），不将其用于敌对代码隔离保证。
- 宿主在容器退出、核验身份/隔离并确认删除后才评分。`pass`/`fail` 为可评分的任务结论，模型/worker/清理失败为 `error`；未执行次数单独列出，不从分母消失。
- 当前规则 `read-only-files-v1` 要求指定路径确有成功 read、前后文件树 hash 相同、无 write/edit 调用，公共回复包含用户确认的字面片段。宿主与容器将完整相对路径按同一字典序排序后计算文件树 hash，不使用目录深度优先顺序。`absentPaths` 必须与归档删除清单及文件缺席一致；字面回复核对不是语义评分器或自动根因判断，规则/评分只在宿主，不发送独立参考答案。
- 新增 `file-literals-v1`：`files` 中每项仅含 `path/contains/notContains`，两种字面数组可一空但不能全空，不支持正则/语义评分。允许在恢复副本中编辑/新增文件；每个指定文件必须存在且为可读取的普通 UTF-8 文件，即使只检查“不包含”也不能用文件缺失凑通过。参考字面值仅留宿主，原/候选 worker 输入同样只增加待取证路径，未向 prompt/模型发送参考答案。
- worker 在本轮工具执行结束后读取至多16个指定路径，每文件≤64 KiB、合计≤256 KiB，记录 final bytes 的 base64/hash/size。宿主在确认容器删除后校验编码、hash、大小和文字，再按逐文件字面谓词评分，结果/运行事件保存这些证据及逐项检查。已知文件不存在为 fail；证据缺失/损坏、二进制、链接/目录、越界或秘密哨兵命中等为 error，停止后续轮次而非伪判通过。可用的实际模型请求记录仍保留，未运行单列；不以文件证据不可用冒称模型零调用。worker 和宿主均拒绝选定 Key 藏在 base64 文件证据中，不能用编码绕过输出检查；不是检测所有秘密的保证。
- `read-only-files-v1` 行为不变；新规则依赖同一受信 worker 提供最终文件证据，不是宿主对任意敌对代码的独立文件系统证明。已用真实模型对作者构造的同类小任务做原角色基线筛选，但不是原历史现场复现、正式封存用例 A/B 或用户验收。按基线表现筛选/加强题目会带来选择偏差；#4/#10/#14 只对 wiki 生成保留，已查看这些来源的基线，后续须披露测试集并非完全未见，不据此声称无偏泛化或必然提分。
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
- 尚未完成真实用例验收的 wiki/候选、固定划分、新字面评分及批量评测链，不因接口或合成测试存在就视为验收通过。不同封存原角色版本不能共用同一个候选；需用户明确另起迭代，不自动适配。未经用户审核自动生效、多轮自动调优、语义自动判分、任意规则插件、自动提分/确定性保证、自动发布或修改生产 prompt 均非本 Goal 承诺。
- 后台自动定时 GC、任意不可信代码的外联隔离、对同权限宿主/Docker 管理员隐藏容器环境 Key，以及没有可信 worker 记录时的精确供应商计费证明。
