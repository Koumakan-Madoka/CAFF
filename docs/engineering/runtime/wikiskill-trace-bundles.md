# WikiSkill 冻结轨迹包

## 边界

轨迹包是 Wiki 拥有的证据，不是聊天 Inspector 的展示投影，也不是现场可回放、已复现或可判分的证明。现有 checkpoint 封存记录仍保留自己的完整性/可回放限制。

本契约描述截至 2026-11-09 的代码行为，不代表已部署或已获最终接受。覆盖标记、不可覆盖轨迹、授权历史回填、脱水、三类模式标签、模型类别提议与整组确认、训练成员限定归纳及审核后自动关联、按模式首次分组、Badcase 页、离线预检，以及双检查的单次 run 与现场切点报告；正式计划/判分见[评分契约](wikiskill-scoring.md)。历史重分组保留原确认和冻结 trace 组别，新题另走首次分组，不重新随机旧题。新标记的现场元数据来自 schemaVersion 2 检查点，旧缺失如实披露；不能把展示、导出、元数据齐全或合成测试当成可回放、已复现或已入库的证明。

2026-11-10 M1 追加：trace 回调使用本次执行独立的最小 Goal store，并保存近似标记和不可改调用记录，详见[回放契约](badcase-capture-replay.md#2026-11-10-trace-回放的独立-goal-store)。不从 session_goal 展示文本反解结构化 Goal，不修改冻结 prompt/session/触发消息/准备输入或包 hash；以后标记时冻结结构化 Goal 不在本次范围。Goal 成功响应带出的人造状态是新增的后续上下文，不冒称恢复历史 Goal；公共读接口保持原样。页面标记在后续页面里程碑接入。

## 数据流与签名

1. `createAgentContextSnapshot({ ..., archiveKnownKeyValues? })`：正常 Agent 执行传入实例的已知 key 清单读取函数。内部 `archiveContext.sections` 保存同一份 delivered sections 的逐字内容，只替换已知 key；包含 harness 最终系统提示词（收到时），不二次生成提示词。`archiveContext` 不进入 `materializeAgentContextSnapshot()`、summary、Inspector 或其 Markdown 导出。原有 Inspector 的模式脱敏仍只用于展示字段。
2. 实例只读读取自己的 `models.json`、`auth.json`、环境中的 key/token/secret/password 值和已配置的 `turn-time-breakdown-jev` key。清单仅在内存、不可 JSON 序列化；不运行 `!command`、不刷新 OAuth、不回写源文件。缺文件允许空清单；文件不可读/损坏或 key 来源无法解析则拒绝原文归档，快照明确记录缺失，不阻断聊天。
3. 终态消息记录本次 session 的 assistant 起止计数和逐模型调用耗时。耗时取现有原生事件的 assistant `message_start`→`message_end` 单调时钟差，不含工具执行时间；未观察到的耗时保留 null。
4. `createBadcaseSealingService().mark()` 先持久化标记，然后在第一次 await **之前**调用内部 `freezeMarkedCaseTrace(options, input, flag, firstMark)`。它读取这条消息的 detail snapshot、精确 session、可用 checkpoint 清单和现有 usage/timeline，写入 Wiki。之后原有异步 checkpoint 封存流程继续；标记、轨迹包、现场封存分别报告状态。
5. `WikiStore.freezeCaseTrace(caseId, bundle)` / `readCaseTrace(caseId)` / `recoverCaseTrace(caseId)` 只接受服务端/受信操作方调用，不开放上传原文或任意路径的 HTTP 写入口。
6. `GET /api/wikiskill/cases/:caseId/trace` 返回 `{ traceBundle: packet | null }`，沿用 Wiki 的本地管理读取门禁。只从 Wiki 读取，不要求源项目、房间、消息或 session 仍存在，不会重建或回写源内容。

## 包内容

- `source`：project/conversation/message/agent 标识；`origin` 为 `mark|backfill`，`frozenAt` 为冻结来源时间。
- `context`：原始上下文 sections、系统提示词、实际 session 用户输入、已保留的 session 前缀条目、技能 sections，以及在前缀/本轮中观察到的 `read(.../SKILL.md)` 路径。
- `steps`：本轮所有 assistant 模型输出（不是摘录），调用参数、对应完整 `toolResult` 消息（含 details）、原始 usage 和已记录的模型耗时。工具实际返回给模型的截断标记保留；不按输出里出现的临时路径额外读取文件。
- `markedMessage`、实际问题、期望表现和发出消息的 `markedStep`。优先匹配携带公开回复的 `send-public` 调用，再匹配直接文本；无法定位保留 null，不能把最后一个内部记账步骤冒充公开回复步骤。
- `scene`：只投影本轮 checkpoint 的现场元数据，具体见下节；不导出现场文件正文，不读取当前 worktree 或运行 Git 补造历史状态。
- `complete` 与 `missingReasons`：缺少原始上下文、session、精确轮次边界、输出/结果、耗时、usage、发消息步骤或已有现场的 HEAD/分支时明确降级。

Session 读取限于本实例 `named-sessions` 中选择的普通 `.jsonl`，最大 128 MiB；拒绝界外路径/链接目标和无效 UTF-8。仅接受 v3 JSONL，验证 ID 唯一、父链可解析。用冻结的起止计数选择本轮分支；保留这一分支的前缀，不含续写的下一轮或旁支。只凭 usage 推导的旧轮次终点会明确标 `turn_end_inferred_from_usage`，不冒充精确采集。

旧 Inspector 快照只有 `displayContent` 时仍可展示已有材料，不能从 `[REDACTED]` 还原原文或声称逐字原始请求。旧冻结包的 `original_context_unavailable` 只表示没有新版 `archiveContext.sections`，不意味着从 session 恢复的本轮输入和续用前轮缺失；已冻结包、hash 和导出原文不作迁移。页面对旧码解释为「没有新版上下文归档；本轮输入和续用前轮已从会话日志恢复」，session 本身缺失时另有明确缺失码。

新生成包不再添加上述宽泛旧码，分开记录：`context_archive_missing`（没有新版 sections 原文归档）、`system_prompt_missing`（没有当时系统提示词）、`system_prompt_display_redacted`（使用已有模式脱敏历史展示版）、`provider_request_bytes_missing`（未录制供应商原始请求字节）、以及各自的 session/边界/工具结果缺失码。保留旧展示分区的截断标记。如果快照的 `archiveContext.unavailableReason` 表示原文归档失败（例如 `known_key_inventory_unavailable`），其 Inspector 占位文字**不是**历史系统提示词：新包写 `system_prompt_unavailable`、`context.systemPrompt=null`、`systemPromptSource=unavailable`，并在 `context.archiveUnavailableReason` 保留具体原因，展示 sections 仅供缺失审计。`context.systemPromptSource` 区分 `known_value_archive|historical_display|missing|unavailable`，`providerRequestBytesCaptured` 如实为 false。`complete` 仍判断 B2 所要求的语义轨迹材料；原始供应商请求字节不在 B2 内，只有 `provider_request_bytes_missing` 不使 B2 材料降级，不能把它解读为已录制网络请求。

## 本轮 Git 快照现场

采集 PR #179 合入后，标记时只读取消息绑定且 project/conversation/turn/agent 一致的 checkpoint；只接受 `schemaVersion: 2`、`gitSnapshot.kind: git-snapshot-v1`。`scene.metadataSource=checkpoint_git_snapshot_v2`；HEAD 和分支直接来自 `gitSnapshot.head/branch`，空分支字符串表示 detached，null 表示未记录，二者不混淆。

- `changes` 是冻结 patch 的路径，加上 `redacted-tracked` / `mixed-eol-tracked` 覆盖文件和明确删除项，去重排序。patch 只从本实例 CAS 按 hash 读取，校验 SHA-256 和 128 MiB 上限；`git apply --numstat -z` **只列清单，不应用**，保留 Unicode/引号/制表符等 Git 路径语义。读取/解析失败则为 null 和 `scene_changes_not_recorded`，不回退当前 Git。
- `untracked` 只取检查点 `files` 中 `origin=untracked` 的路径；`files` 仅白名单元数据（含 origin），不含 hash 指向的正文、patch 正文或 skill 资源。另保留删除、跳过、未采集项及排除规则；跳过项仅 path/reason/scope。有跳过/未采集、HEAD/分支或改动清单缺失时为 `metadataStatus=partial`，无 v2 快照为 `missing`，齐全才为 `recorded`。这是清单完整性，不是原子采集/可回放证明；v2 不保留 staged/unstaged 区分，`gitStatus=null`。
- `context.captureLoadedSkills` 投影该检查点的实际 loaded/sdk/prompt 名单（仅 name/filePath/baseDir）及采集状态，合并已记录的加载路径；不复制技能正文。名单未完成明确 `scene_loaded_skills_missing`。所有新字段和路径仍在写包前做相同已知值替换。
- Wiki 引用只增加现场状态/来源、HEAD/分支和跳过数摘要，供卡片展示；展开/搜索/JSON/Markdown 始终读取同一冻结包。旧包不迁移、不重新计算引用，也不据当前仓库、baseline 或轮前输入推断现场。
- #17–#20 只核验 B3 已复制的各自封存 checkpoint；若没有 v2 gitSnapshot，页面如实显示历史缺失并保留已有文件清单，不改变旧包及历史评测结果。这不是重新读取线上会话或其他 worktree 的授权。

## 已知值替换与存储

- 保存前对解码后的所有字符串和属性名作已知值字面替换 `[*]`；长值优先、重叠值不重复处理占位符。记录策略及替换次数，不记录 key 原值。
- **不**使用秘密哨兵、熵或额外模式检测；非已知值逐字保留。不能声称识别任意秘密。旧标记/知识库文字自身原有的校验不因此放宽。
- 包保存在 `<globalRoot>/traces/<source-identity-sha256>.json`，envelope 带 `schemaVersion/hash/bundle`。hash 是替换后的 `JSON.stringify(bundle)` 的 SHA-256；读取同时核对内容、来源及用例引用 hash，损坏拒绝，不回退旧内容。
- 写入使用 0600 临时文件、fsync 和 hardlink no-replace；包最大 128 MiB，超限显式失败，不截断。目录祖先属于同 OS 用户可信存储，不是路径交换安全沙箱。
- Wiki 用例只保存 `traceBundle` 的 hash、时间、完整性、缺失原因和步数等引用，避免在每一版 8 MiB Wiki 快照里重复大包。包与引用发布均在 Wiki 的现有 writer-lock 内；旧快照、组别和 replay 登记不改。
- 同来源先到者冻结，重试验证并返回原包，既不读取续写 session 也不改 hash。包已发布但快照附加失败时，`recoverCaseTrace` 只附加已有包。首次标记没留下包时，重试不能把后来内容标成原标记时采集，必须明确报告未归档；历史补全应走单独授权的回填路径。
- Wiki 自有目录不属于 checkpoint TTL/GC；删源房间不影响已有包。删除/清理 Wiki 存储不在此接口内。

## Badcase 页与导出

独立页签位于 WikiSkill 顶部的 Badcase，`#badcases` 可直达，`#bc-<显示编号>` 可定位。原知识库默认页和「用例」的归类/旧回放题入口保留。页面使用 `public/shared/badcase-pipeline.js` 的独立组件（加载只读，确认须用户动作），断言编辑仍在「用例」页；详情只读展示真实冻结版本、模型及断言，不伪造模型建议、确认或评测结果。

- 九步：标记、现场、脱水、归类、分组、断言、回放检查、原版复现、入库。约 1680px 最大内容区；左列表支持搜索及「等你、系统、已入库、到此为止」筛选，右侧选中详情在管理页内层滚动容器中固定并独立滚动；≤980px 上下排列。保留 #4、#10、#14 旧题来源身份，不把样例仓库当原现场；非 GPT 只报告。
- 分组区先选模式，再显示训练/门槛/测试/不参与四栏；实线为已生效，虚线为新提议，两种确认入口并入看板。全部模式只给数量和候选可评测性，不混排各模式用例；模式选择同时过滤列表。待归纳新模式按名称列出并标「待归纳」；还有预分类建议新模式但标签未确认的用例时，提示「建议同类用例的标签都确认后再分组」，只提示、不额外阻止确认。旧对照表改为默认折叠的审计信息。
- 「确认模式标签」面板说明：决定这条用例在哪个模式下分组，以及评测时算哪个模式的目标用例，确认后不能改。面板内显示预分类建议、把握和理由；建议新模式默认选待归纳，建议已有模式默认选该模式。标签、分组和关联均使用面板内具名的后果说明，再点「确认并锁定」，不弹浏览器对话框；不增加归纳成员、不改既有组别等边界放在默认折叠说明中。锁定后显示名称及当前评测角色。
- 分组区上方按待处理提议显示类别卡：名字、范围可改，成员可勾选并显示理由；不可确认的成员禁用并显示原因。说明范围用于分组展示、判断新用例归属和类别提议，归纳与候选不读；类别名将成为正式模式标题，名字和范围不要写某条用例的具体答案或字数。建议加入已有类别时身份只读，不借提议改写已冻结名字/范围。可取消部分成员回到单条标签面板，或「不采纳，逐条单独处理」。单条加入显示已有类别范围和成员，手动新建必填名字与范围；加入已关联类别会具名说明直接在目标正式模式里分组和评测。
- 待预分类用例的标签面板和知识库原入口均提供「预分类并提议类别」，沿用 `/api/wikiskill/induct` 整批规则，先预分类再单独调用模型提议类别。已预分类且没有待处理提议的合资格用例，在类别区和标签面板提供「提议新类别」，列明整批编号。**生产上已预分类的用例（例如 #21–#24），应在另获批准部署后走「提议新类别」**；本次交付不读取、确认或更改生产标签。
- 类别成员全部分组且有训练成员时，分组区显示「归纳模式内容（只提议）」：明确给模型的训练编号、不给的门槛/测试编号，以及不含范围说明。四项草稿均可改，准则按 Unicode 码点显示 300 字上限；通过前在面板内展开具名确认，审核通过后自动转正并关联，知识库同步显示。「驳回并重新归纳」先驳回并完整重读，再发起新归纳；第一步失败或结果未知则停止，不自动补发。训练成员漂移或已手动关联的草稿不可通过，但仍可驳回。
- #185 手动关联保留为次要入口，默认折叠到「其他操作：这一类其实是已有模式」。下拉框默认空选「选择已通过的模式…」，所有情况都须主动选择，未选禁用「关联…」；与本组训练用例有 caseIds 交集的已通过模式排前并标注来源，下方换行显示完整推荐。自动或手动关联后均列出门槛/测试目标复现题，并明确「目标题已确定 ≠ 可评测」，仍须冻结断言、通过回放检查等就绪条件；不新增就绪豁免。
- 类别、标签、分组和审核都在面板内展开后果说明，不使用浏览器对话框；编辑内容或勾选变化使已展开确认失效。每次写入后重新 GET 完整状态并清除旧确认，不复用过期 labelHash；只读、忙碌或结果未知时禁用写入，须明确刷新核对。原型的演示进度和重新演示不实现。
- 层级说明默认一行、可展开；trace/run 漏斗并排，断言、预检、复现及入库计数来自 `pipelineStates`，不把旧字面评测或 replay 登记当作通过。断言区显示冻结版本/模型/依据；正式 run 的非 reply 问题不兼容，trace 的 tool-only 版本也显示 `incompatible`。只有版本号高于最新冻结版本的草稿才提示待确认，旧草稿保留但不冒充新待办。无缓存待预检，无已判分结果待复现，有原始 run 回复但无匹配正式评分仅显示「待判分」。
- 原版复现仅取最近一个匹配当前冻结断言和执行身份的评分 v2 批次，不拼接：有效数为 pass+fail，fail 严格超过一半才算已复现；平票、无效、错误、未知及原始未判分回复均不证明复现。入库还须有效分组、冻结兼容断言及预检 supported。独立操作方诊断不冒充正式门槛记录。
- 每条的回填状态来自 `case.traceBundle` 引用和缺失原因，提供白话缺失说明（原机器码保留在 title 和包内）。没有批准按钮；读取页面不会重跑回填、模型或任何写接口。
- 现场按冻结证据显示「现场元数据已冻结」「现场部分记录 · 缺口已披露」或「历史现场元数据缺失」，不再统一显示等待采集合入。有现场仍走 trace 级；材料合资格时提供「切点推荐 · 只出报告」及单步型切点确认，不等待现场 run 执行器。选项显示「重新生成第 N 步 · 原输出：…」，确认明确「切在第 N 步之前」；后缀是第 N 步原输出，不是切点之前的上下文。缺真实系统提示词等材料仍不提供推荐（例如 #19/#20 的历史数据限制）。元数据齐全或切点确认都不代表已通过回放检查。旧包的 `pending_capture_integration` / `scene_metadata_pending_capture_integration` 仅解释为当时未接入且历史元数据未记录，不改包、引用或 hash。
- 「轨迹与上下文」首次展开才 GET 对应冻结包，不使用 `message` 或 `traceExcerpt` 兜底。三段可展开：上下文逐字段、逐次模型输出/完整参数/完整工具结果/耗时与用量、现场清单。原包内容以文本/JSON 显示而非 HTML；长块（>800 字符）默认折叠，展开仍保留完整原文。支持在本包所有三段内搜索、高亮并展开命中块；搜索不截断导出。缓存按 case ID + 引用 hash 隔离，刷新后的过期响应丢弃，失败只提供显式重试。
- `GET /api/wikiskill/cases/:caseId/trace/export.json` 与 `/trace/export.md` 沿用同一本地只读管理门禁和 hash 验证。响应为 attachment、no-store；无包返回 `wiki_trace_missing`（404），损坏仍拒绝（409）。JSON 是冻结包自身（仅排版差异），没有导出时间/当前分组等附加字段。Markdown 以包信息、上下文、逐步轨迹、用量、现场组织 JSON 代码块；每个字段保留，可由各块无损重组原包，动态围栏避免正文反引号破坏结构。两种格式均不访问源房间、路径或现场文件正文，不二次脱敏/推断/截断。

### 页面回放预检缓存（trace / run）

`GET /api/wikiskill`（以及确认后的页面刷新）只读取小型不可变预检记录。**不得**在 HTTP 路径调用 `prepareSealedOriginalTurn`、`materializeGitSnapshot`、Git 子进程或创建临时目录；也不在请求中读取轨迹包并调用 `buildDehydrationPrefix` 来补算 run 预检。没有当前身份／规则版本的缓存，或缓存损坏时，显示「待回放预检」，不冒充 supported，也不自动重算。原版复现按上节的有效判分严格多数口径显示 pass/fail，不拼接批次，也不因离线预检成功自动调用模型或判分。

受信操作方在 **HTTP 进程之外**运行 `node scripts/badcase-capture/precheck-wiki-pipeline.cjs --config <绝对路径> --confirmed`。配置闭合为 `{globalRoot, sourceWorktree}`，均须绝对路径，Wiki 不得位于 sourceWorktree 内。先 build；只使用该任务已批准的 Wiki 和封存库（隔离验证使用副本），不会从页面启动。这个命令不是读取生产、复制其他现场或写生产数据的授权。无模型请求、工具执行或评测；trace 重用真实封存输入准备（v2 可在离线命令进程中还原临时 Git 现场），run 重用冻结前缀构造器。v2 沿用本实例 `PI_CODING_AGENT_DIR`／环境的已知值只读清单，供现场字面替换；不认证、不刷新、复制或回写凭据。操作方须隔离这些环境变量，不得指向未获批准的生产配置。CLI 只接受 `--config` 和 `--confirmed`；配置为普通 JSON 文件（≤16 KiB，不跟随符号链接），无任意模块/路径扩展字段。成功打印 `{rules,results}`，参数/配置/缓存/锁错误只打印固定错误码并非零退出；它只增加获准 Wiki 的缓存文件，不推进 Wiki revision。

- trace 的键是 `(replay.id, checkpointHash, 预检规则版本)`；run 的键是 `(traceHash, decisionHash, 预检规则版本)`，同样跨进程长期复用。当前规则版本 `sealed-prefix-precheck-v1`；封存输入／前缀准入规则改变必须递增，不覆盖历史记录。
- `<globalRoot>/pipeline-prechecks/<身份 SHA-256>.json` 只保存身份、`supported|unsupported` 和白名单原因码，不保存文件、提示词、请求正文或原始异常。读取检查 envelope hash、身份和闭合结果字段，单份最多 8 KiB。缓存只表示输入可准备，不证明模型已执行、通过断言或入库。
- 计算前取得该身份的跨进程 writer-lock，锁内重读缓存；同一封存或前缀的 supported／unsupported 都只计算一次。写入为 0600、fsync、hardlink no-replace，旧记录与 Wiki revision／分组／轨迹包不变。崩溃遗留锁需受信离线恢复，不按年龄自动回收；损坏记录不覆盖、不重算。目录祖先仍属同 OS 用户可信存储，不是安全沙箱。
- 不选择在封存回调／服务器后台执行：避免增加聊天封存延迟和后台任务生命周期；代价是操作方须显式填充缓存，新题在此之前如实待预检。自动化测试覆盖 GET 零准备／还原／Git／临时目录、确认刷新只读、真实 v2 离线准备只运行一次、run 正负结果缓存、键／版本失效、损坏拒绝和锁占用。

### 原版预检受信命令（M3 接线中：run／现场切点报告）

`run-wiki-original-precheck.cjs` 是付费原版预检的受信入口，与上节**不调用模型**的回放检查缓存不同。当前切片已连接无现场 run 和现场的 `replayWikiRunReport`；trace 适配器、页面投影和入库门禁尚待后续切片，不能据此称 M3 完成。没有 HTTP／页面启动入口；运行命令不代表获得生产数据或真实模型额度授权。每次付费执行前仍须由规划者向用户确认额度。

- 先 build，以普通 JSON 配置（≤1 MiB、拒绝符号链接）运行 `node scripts/badcase-capture/run-wiki-original-precheck.cjs --config <绝对路径> --plan`；只读冻结输入和本实例明确指定的已知值清单，不认证、不发模型请求。输出原版计划、停止线及 `approvalHash`，不打印模型上下文。执行使用 `--run --confirmed --expected-plan <planHash> --approval <approvalHash> --output <新的绝对JSONL路径>`；这些参数不能混入 `--plan`。计划／预算／STOP 路径改变后旧确认失效；已有输出拒绝覆盖，也不支持恢复、补发或自动重试整批。
- 配置闭合字段：`kind:'wiki-original-precheck-v1'`、`globalRoot`、`sourceWorktree`、`caseId`、`rubricHash`、冻结 `toolset`、`codexAuthFile`、`knownKeySources`、`judgeCredentialDir`、`stopFile`、`limits`；可选 `policy`、`reportOnly`、`timeoutMs`、`judgeCatalogFile`。所有目录／文件选择均显式绝对路径；auth 只选 `.pi-sandbox/auth.json`，已知值清单和裁判目录必须指向同一个指定 sandbox，key 不在 JSON 中。只支持固定 GPT / xhigh / SSE，一次模型决定，不执行输出工具。现场必须显式 `reportOnly:true`；未接入的 trace 在离线阶段拒绝。
- 断言须冻结且来源未变，离线回放检查须匹配当前轨迹／切点／现场。run 默认5次、最多20次，可用 `policy:{repeats,failureThreshold,controlThreshold}` 配置；不因无效或错误再补一次。pass+fail 是比例分母，失败比例严格大于阈值（默认0.5）才复现；报告、停止、未完成和用量不明结果无复现／对照资格。现场报告仅判工具与可到达的 reply 问题，不伪造 trace／file 证据，始终只出报告、不作采纳依据。
- AI 判分复用正式 scorer／三票多数／同输出的技术重试，且必须显式提供 `judgeCatalogFile`：沿用 `readWikiEligibleJudges` 和完整配置资格校验；当前适配器仅支持已校准的固定 DeepSeek 配置，不借环境默认名单放行。配置、prompt 和资格冻结 hash 进入新计划；旧核心计划没有 `judge` 字段时仍按原字节／hash 读取。工具单检不读取裁判凭据；需要时所选 key 必须已在已知值清单内。资格／配置漂移在下一次付费请求前拒绝，不静默换裁判。
- `limits` 必填：`maxRequests`（worker＋judge 共用，1–4096）、`maxInputTokens`（含 cacheRead/cacheWrite）、`maxOutputTokens`、`maxTotalTokens`、`maxDurationMs`（最多3小时）。整数停止线、计划 hash 和 STOP 绝对路径一起绑定确认。请求上限是保守占用次数，不证明实际发送；token 是已报告用量停止线，单请求可能越线，不是可精确预扣的计费上限。每次实际 worker／judge 交换均受控制，取消信号直达 SDK／宿主连接；STOP、Ctrl+C、整批时限、缺失／不一致用量和证据写失败都会阻止后续请求。取消后等待请求结束，未知不记成零；裁判重试也不能绕过共享上限。恰好用完请求额度且全部计划尝试已经完整判完，可以完成；仍需裁判但额度已尽则停止。
- 先独占创建0600输出并预约不可变记录，再发请求。JSONL逐条 fsync，留存冻结请求、逐请求占用／用量、输出包、判分和 artifact hash；原始包另存在 `<globalRoot>/original-precheck-outputs/<precheckId>/run-replays/`，不会被普通 run／report 枚举读到。`original-prechecks/` 只存不可覆盖的预约／结果及安全引用，绑定断言版本、输入、切点和现场；不写 Wiki 快照、正式比较、门槛或测试统计。崩溃留下的预约如实未知，不自动补发。目录属于同 OS 用户受信存储，hash／no-replace 不是抵御同用户篡改的安全边界。

## 只读历史回填

操作入口：`node scripts/badcase-capture/backfill-wiki-traces.cjs --config <绝对路径> --confirmed`。这不是 HTTP 上传入口，也不是生产导入/部署授权。必须先编译当前代码，并准备 Wiki 数据的独立副本。

配置字段（不允许额外字段）：

- `globalRoot`：将被修改的 Wiki **副本**；`sourceWorktree`：当前房间工作树。
- `sourceAgentDir`、`sourceDatabase`：显式批准的源 agent 目录和 SQLite 文件，不扫描其他实例。
- `scratchDir`：空的、独立的临时目录。原始日志/选定行的复制件可能含敏感内容，不得提交或公开；仅报告、hash 和脱敏包可用作公开证据。
- `selections`：1–20 个唯一的 `{ caseId, mode: 'live' }` 或 `{ caseId, mode: 'sealed', captureRoot }`。`captureRoot` 必须是已复制的封存库，不跟随 manifest 内的原 worktree 路径。

所有写入根必须彼此独立，且不得与源 agent、数据库所在目录、工作树或封存库嵌套。调用方负责确认 Wiki 是副本；工具不是文件系统沙箱。CLI 使用显式源的既有只读 known-key inventory（含 JEV 指定行），仅内存保存；不复制凭据、不刷新/回写、不调用模型。

`live` 仅接受已存在的 3100 GPT text-only 用例。SQLite 使用 `readonly: true, fileMustExist: true`，不构造 ChatStore、不迁移、不执行 PRAGMA 或写 SQL。仅按选择的 message ID 和已关联的 task ID 查询 message/context/usage/task 行；task 的 room/agent/turn 关联必须一致。每一行先复制到临时 `.row` 文件再解析；session 只接受该源 `named-sessions` 中的普通 `.jsonl`，先复制再解析。源文件复制前后和副本 SHA-256 必须一致，处理完全部复制件、发布任何包之前再次核对源 hash；变动则整批停止，不发布包。数据库本身不复制、不全文件读取/hash（活跃 WAL 数据库的文件 hash 不能证明只读）；报告列出只读打开参数和逐条参数化 SELECT。源日志最大 128 MiB，数据库不受这个复制上限限制。

旧消息缺精确轮次终点时，可按已有 usage 推导并标记 `turn_end_inferred_from_usage`。缺边界时仅允许用 **唯一逐字匹配的公开回复** 及 JSONL 父链恢复所在用户轮次；分支或重复回复存在歧义则不推测，成功恢复也标记 `turn_bounds_recovered_from_unique_reply`。这两种均属历史补全，不冒充标记时采集。旧 Inspector 快照缺原文、缺系统提示词/模型耗时等继续逐项记录，不能因找到了输出就称完整。

`sealed` 只读取选定 checkpoint 清单及其明确引用且 hash 验证通过的 prompt/session/callback blobs。核对 checkpoint、callback 与用例的关联。封存的 replay 输入是**轮前前缀**，不是当轮模型输出；保存在 `context.retained`（`sealed_pre_turn_inputs`），与真正的 `context.trigger/priorSessionEntries/steps` 分开。当轮未录制则标 `sealed_marked_turn_not_recorded`，不访问它们的线上会话补造。现场只保存文件清单。旧清单未记 HEAD/branch 时保留 null 和原因。

报告逐条保存 `caseId`、由与页面相同的 `wikiDisplayCases` / `wikiGoalCaseNumber` 得到的 `caseNumber`、`complete|partial|unavailable|already_frozen`、包 hash、步数、缺失原因，另附源文件 hash 对照和查询审计。报告顺序不代表用例编号；不得用遍历计数、导入顺序或调用方的 `n` 字段选题。`partial` 是有当轮步骤但仍缺材料，`unavailable` 是没有可确认的当轮步骤（仍可保留已有上下文/现场）。成功和失败都不改原组别、回放登记或旧快照；已冻结用例重试不再打开来源。实际数据和操作报告留在忽略的临时证据目录，不进入 Git。

## 脱水材料、推荐与确认

`wiki-dehydration.ts` 是纯数据模块，不读文件、凭据或可变房间上下文，不调用模型或工具。材料与前缀能力如下，模型调用与存储由后述受信入口负责：

- 身份由 caseId 与冻结包 source/hash 绑定，编号仅由 `wikiGoalCaseNumber` 投影；旧题来源 #4/#10/#14 不允许脱水。判断具体系统提示词、触发消息、前缀和标记步骤是否存在，不因旧 `original_context_unavailable` 或缺耗时就拒绝已有消息前缀。现场用例默认仍走 trace。缺少真实系统提示词（包括归档失败或旧包误存的 `【上下文未归档：已知 key 清单不可用】` 占位文字）直接判为不可推荐，页面不提供请求按钮；构造切点前缀同样拒绝，故 `confirmDehydration(single)` 和 run 回放均返回 `wiki_dehydration_ineligible`，不冻结或回放占位前缀。历史展示版的正常路径脱敏不是这种整段缺失，仍按原批准边界使用；不改旧包、推荐、决定和 hash。
- DeepSeek 请求只投影当时起因、步骤卡片、发出回复、实际问题及期望，最后放能否脱水/切点两题。起因必须选自冻结的本轮输入或当时 Goal，不能从当前 Goal 补造。卡片不含 thinking 或结果 details，先替换已知 key 再裁剪；消息/方案正文保留头 500 尾 300，普通步骤最多 120，错误步骤保留报错行；旧日志中 `send-public` 已发送但工具报 `Command aborted` 时，同时保留 `messageBody`（同样头尾规则），不能让桥接终态吞掉发消息步骤的正文。只询问不晚于发出被标记消息的步骤；大于 254 个切点或 state 超过 64k 时显式拒绝，不静默丢材料。离线操作方须审核脱敏材料后才允许外发；页面入口由用户明确点击并确认授权发送这一条冻结投影，加载页面不外发。
- 用户 2026-11-05 批准由 DeepSeek v4 flash 替代组织停用的 JEV（旧 JEV 结果与冻结包不迁移）。输出为严格 JSON，恰含 `kind`（单步型/贯穿型/说不清）、`cutStep`（卡片整数步号或“无”）、`reason`（一句理由）、`evidence`（从该步 body/messageBody 原样摘的非空依据，无切点则为空）。程序核对依据必须是所选卡片原文子串，不接受改写、别步或发出回复字段里的文字来冒充。没有概率字段，不编造把握程度。离线受信调用保留 B6 的解析失败自动重试一次规则；**页面入口不自动重试**：一次 JSON/字段解析失败即保存真实输出，显式 `parse_failed`、答案为 null，默认回退到发消息步骤。用户可自行选择判断与切点接受该回退，或明确再点一次请求推荐，完成 B6 的一次重试。依据不匹配、无切点、非单步或说不清都只提供发消息步骤回退值并展示原因，均须用户确认，不自动冻结。
- 切点前缀只含冻结的续用消息、本轮输入、切点前的模型输出及完整结果，既不含切点输出也不含之后记账。历史展示版系统提示词和路径占位原样保留，metadata 明记「系统提示词为历史展示版，路径行已占位」。缺前置工具结果、无法解释的压缩前缀或越界切点拒绝，不用当前上下文兜底。

`recommendDehydration(input, { client, knownKeyValues })` 是受信操作入口，不开放 HTTP 上传材料/答案或任意源路径。调用方须先检查同一 `buildDehydrationRequest` 的脱敏投影，并传 `approvedRequestHash`。核对 revision、caseId、traceHash 后调用 `client.ask`；每条最多两次且仅解析失败允许第二次。并发占用同 store 拒绝，首次网络返回后检查 revision 再决定是否重试；writer-lock 内再核对 revision/hash。HTTP/网络拒绝立即停止，不重试、不保存伪造答案。已经保存的同请求只返回原记录、不重复外发；更换请求或答案不覆盖首份推荐。输出字符串及解析后的 JSON 字符串均作已知值替换，异常只报告固定码，不回显上游正文或凭据。

`POST /api/wikiskill/cases/:id/dehydration/recommend` 是页面的受信操作入口，使用 local-admin 的 Host/loopback/Origin/CSRF 守卫。闭合字段只有 `confirmed: true, expectedRevision, traceHash` 及可选 `retryOf`（上一份推荐 hash）；不能上传起因、答案、模型、key、路径或运行时配置。只允许活动的 GPT 来源、非 #4/#10/#14 旧题来源、具有冻结轨迹包且尚未冻结判断的用例；删除、缺输入、无效前缀、过期 revision/hash 在读取凭据前拒绝。有现场允许推荐切点，仅用于只出报告的单次检查，不把用例改成 run 级；没有真实系统提示词仍返回 `wiki_dehydration_ineligible`（422）。起因仅从冻结触发消息中提取；fresh 输入剥离提示词及其他历史，续用输入剥离 delta 包装，不读取当前房间或候选/分组/结果。

Badcase 页在「脱水」步骤为尚无推荐的合资格用例显示「请求推荐」。一次点击只发一次模型请求（传输亦有一次预算），不执行工具、不自动冻结、不改组。按存储根目录和 caseId 的进程内占用拒绝并发请求（包括不同 controller/store 对象）；已保存推荐后的重复请求为 409。新页面推荐的解析失败仅允许携带当前 `retryOf` 明确再请求一次，成功或其他回退原因不可重新请求，冻结后任何推荐请求均拒绝。第二份推荐**追加**到 `dehydrations` 并绑定 `retryOf`，第一份 JSON 原文、请求、hash 原样保留，页面可展开此前推荐；确认、回放计数和分组读取最后一份记录，不覆盖旧推荐或既有决定。失败或响应未知时页面停写，须刷新核对，不自动重发；进程内占用不承诺跨进程或崩溃后的计费请求去重。

应用启动装配默认 `runPageDehydration`，复用预分类的 `CAFF_BADCASE_WIKI_RUNTIME_CONFIG`／`badcaseWikiRuntimeConfig` 和 `credentialDir`，以同一只读 `readCaffDeepseekKey` 从本实例选择的 models.json 获取官方 DeepSeek 配置。key 只在宿主内存，已知值在发出和保存前替换，固定通过 `http://127.0.0.1:17890`，不直连回退、不刷新/写回/复制凭据；推荐不启动 Docker 或 SDK 工具。配置缺失或无效返回固定错误码，不回显路径、供应商错误正文或 key。自动化验证只使用合成配置和 fake 传输，不调用真实 DeepSeek。

`createDehydrationClient({ key, fetchImpl, maxRequests? })` 不发现/刷新/写入凭据、不构造 SDK 会话。固定使用与预分类相同的 `https://api.deepseek.com/chat/completions`、`deepseek-v4-flash`、temperature=0、max_tokens=32768、非流式 JSON 对象输出、110 秒超时，单条最多两次；请求不带工具。调用方显式提供该服务的 fetch/dispatcher，无直连兜底或重定向。返回只保存 content、finishReason、状态、耗时和 usage，不保存供应商信封/思考。响应上限 512 KiB，拒绝 key 回显。历史 B6 批次按单独批准只读取得 3100 `models.json` 的 deepseek provider，隔离副本已在 Goal 收尾删除；不是页面入口的生产读取授权。页面每次使用上述本实例运行时选择，不将 key 写入日志、证据或提交。

`saveDehydrationRecommendation` 在新的 Wiki 快照 `dehydrations` 中保存实际脱敏请求、JSON 原文/解析字段、依据核验、回退原因、尝试用量、建议、时间及独立 hash。不修改用例内容、冻结轨迹包/hash、旧组别、旧回放登记和历史结果。页面显示理由、原文依据/核验、切点卡片和完整脱敏请求/输出，按「等你处理」分组，不读取候选或判分结果参与推荐。

`POST /api/wikiskill/dehydration-confirm` 使用本地管理 Host/loopback/Origin/CSRF 门禁；闭合字段为 `confirmed, expectedRevision, caseId, traceHash, recommendationHash, kind, cutStep`。客户端必须显式确认，hash/revision 必须对应同一推荐和轨迹包。有现场允许确认 `single` 切点（可早于被标记回复，位于出错工具调用之前）；决定中的 `single/run` 只表示单次检查方式，现场用例的 pipeline、正式计划身份及首次分组仍为 trace，原组别和分组提议 hash 不变。已有推荐、冻结决定、轨迹包及 hash 不迁移或改写，已有同决定的幂等读取不重冻结。所有单步型切点均须能构造有效冻结前缀；贯穿型/说不清必须 `cutStep=null`，无现场时冻结为 `reference`，有现场则保留 `trace`。决定另带 `confirmedBy=local-user`、时间、内容 hash 和事件；同决定重试幂等，任何改判/改切点均拒绝，见过评测结果也不能重开。这个用户身份语义依赖本地管理入口与任务授权，不是对同 OS 进程的安全隔离。确认不发起模型、不执行工具、不改组、不生成断言。页面失败或结果未知时停写，刷新核对，不自动重试。

已完成的历史推荐范围是页面 #1/#2/#3/#5/#6/#8/#12/#15/#16（同时绑定 caseId），不是报告行号。9 条推荐及用户确认保留；#8 保留模型贯穿型推荐和用户单步型第 5 步改判；#12 经用户单向撤回 run 资格，冻结为贯穿型／只作参考，原推荐、首次确认和旧回放不删除、不改 hash。该历史批准批次计入 8 次原版回放，6 有效、#5/#8 两次无效，不补跑；有效不表示评分通过。#4/#10/#14 只作旧题来源；缺系统提示词的 #7/#9/#11/#13 当时按 B11 在隔离 Wiki 副本删除，冻结包与历史记录保留。生产实际修订、后续导入与接受记录以对应 Goal 为准，本段不是当前线上状态声明。带 pi-coding-agent 0.85.1 和固定 caff-capabilities schema 的单次模型回放见下节，不能把推荐/确认当成已回放或判分证据。

## run 级单次回放与正式评分接线

run 级用于控制成本：**从用户冻结的切点开始**，而不是从本轮开头重跑。单次检查只请求一次模型、不执行新工具，可以看回复，也可以看工具调用。无现场用例可走正式 run；有现场用例仅允许显式 `reportOnly` 的原版单次检查，不恢复现场、不续执行工具。现场题保留 trace 身份、分组及首次分组 hash；正式 `buildWikiRunRequest` 仍返回 `wiki_run_scene_unsupported`。从切点恢复现场并真实执行到自然结束的 run 执行器尚未实现，不能用报告冒充。

受信入口 `replayWikiRun({ store, runs, caseId, toolset, approvedRequestHash, candidate?, rubricHash? }, { client, knownKeyValues? })` 以及显式 `replayWikiRunReport` 不开放 HTTP 启动、任意前缀上传或答案上传。report 额外要求明确 `confirmed=true`、完整冻结 `rubricHash`，拒绝候选；报告身份在模型上下文之外绑定，不把断言或报告策略塞给模型。调用前由操作方核对同一请求 hash，并明确获得外发/调用授权。只接受已冻结 `single/run` 决定，核对决定 hash、用例和轨迹包 hash，逐字读取 `buildDehydrationPrefix` 的切点之前前缀；不附实际问题、期望、推荐、候选结果、旧分组或判分信息。系统提示词历史展示版/路径占位不回填，续用消息及前置完整工具结果保留。

- 原版不改任何上下文。受信操作方可提供已批准的全局候选，只允许替换一个 `global-harness-behavior-v1` 声明槽位（系统提示词或历史用户输入内），精确绑定原文/baseHash；多处/无法定位拒绝。其他系统/消息/工具定义不变。该纯数据能力不自动确认候选或启动对比实验。
- 工具仅为名称、说明、参数 schema；拒绝额外字段/execute。`loadWikiRunTools` 固定校验 pi-coding-agent 及其嵌套 pi-ai 为 0.85.1，基础四工具使用 definition factories；拦截固定 SHA 的 caff-capabilities 注册只取上述三个字段，不挂执行器，不调用 facade。SHA、文件 hash、版本及定义 hash 随请求保存。
- `createWikiRunClient` 直接调用嵌套 pi-ai 的 Codex 单次 `stream`，不创建 Agent/Session，不加载技能/当前房间，不接任何工具执行器。固定 `openai-codex/gpt-6.1-sol`、thinking xhigh、SSE、store=false、无 service tier、maxRetries=0；另有 fetch 一次预算。旧 SDK 内置目录没有该新模型 ID，使用最小原生 wire descriptor（直接发送用户批准的 ID，不回退其他模型）；不据该描述符推算价格，保存 token 用量但移除虚构 cost。实际序列化的请求体（无认证头）与完整 assistant 输出随结果保存。
- 复用现有 host-only `codex-transport.cjs`：只读取明确批准的 `.pi-sandbox/auth.json` access/expires，不读取 refresh 字段用于认证、不刷新、不复制/回写凭据；只向固定 Codex endpoint 经 `http://127.0.0.1:17890` 发请求，无直连/重定向兜底。SDK 只见公开 inert identity，真实 access 在 host transport 内存替换。过期、认证、网络或供应商失败停止，不重试；错误证据只留固定码，不保存上游诊断正文。
- 在网络调用**前**于 `<globalRoot>/run-replays/<id>.json` 原子 no-replace 占用。旧单次入口以请求 hash 为 id；正式重复尝试传入 `attempt:{planHash,executionId,iteration}`，id 绑定该计划/执行/题目/版本/迭代槽位，请求 hash 另存。相同槽位即使请求变化也不能再次发送。结果另写 `<id>.result.json`，0600、fsync、hash 校验、不可覆盖；128 MiB 上限，不截断。崩溃/写入失败保留 `reserved`（结果未知）占位，不能用重试自动再发。Wiki 旧快照、轨迹包、决定、分组和旧结果不改。此目录是同 OS 用户可信存储，不是防恶意路径替换沙箱。
- **未配工具检查时保持旧路径**：`stop/toolUse` 的完整文本回复，或独立 `bash` 的 send-public 调用（受限字面 heredoc/引号语法，提取正文但绝不执行）标 `reached`，供回复断言判分，不代表通过；其他工具调用（即便附有解释文字或同时发消息）、空输出、未识别的发消息语法仍无效。配工具检查时按[双检查协议](wikiskill-scoring.md#run-级双检查与纯文本解析)看各自可见的内容，工具单检可直接得到 pass/fail，工具失败不调用裁判；工具成功不等于回复成功。解析不了记 `arguments_unparseable`，没有判到任一检查记 `no_check_reached`，均不算通过/失败。请求或裁判技术故障另记 `error`，未知保留 `reserved`；不进有效分母，不做前缀一致性校验或继续工具循环。
- `projectWikiRunAccounting` 使用 `single-call-valid-output-v2` 规则，只读地将历史 `unreached` 投影为 `invalid`，移除摘要的旧 `countAsFailure`，不改原始请求/输出包、hash 或旧快照。`reached/pass/fail` 且没有被用户撤回、不是 `reportOnly` 的尝试 `eligibleForScoring=true`；原版工具检查 pass 和 fail 都属于有效输出，invalid 不属于。同 caseId/traceHash/decisionHash 的原版有效输出决定 `baselineStatus`（`valid_output|no_valid_output|pending|not_run`）；只有原版有有效输出且未撤回时，`caseEligibleForGateAndScreen=true`。候选输出、别的题/轨迹/决定、历史被撤回的输出不能替代原版证据。这个资格只是必要条件，不表示已确认复现、已分组或评分通过；M4 确认分组会重新核对这项资格；正式 run 选题/执行/评分已接入独立实验计划，仍须满足其模式标签、冻结分组、可判检查（AI 问题限 reply）、门槛 run≤trace 等门禁，不能直接沿用历史 `wikiRoundStage` 代替新确认记录。
- 原版没有有效输出、无法确认复现的题是无效测试用例，不进门槛和训练组初筛。#5/#8 现有两次回放按此只读投影为无效，不补跑；原文/hash 留存，页面明确显示「原版无有效输出」。#12 仍为用户改判后的无现场贯穿型、只作参考；旧回放另标「已被用户改判，不计入」，不混入当前 8 次回放计数。
- 请求中的当前已知值命中则在占用前拒绝；输出及实际请求体保存前进行同一已知值字面替换，不新增模式/秘密检测。模型请求参数和输出中的工具命令永远是文本数据。
- `GET /api/wikiskill` 的 `runReplays` 返回真实占位/结果摘要及当前会计资格；`GET /api/wikiskill/cases/:caseId/run-replays/:hash` 沿用本地只读管理门禁，返回 `{ accounting, reservation, result }`。`accounting` 是当前分类投影，后两项为 hash 核验后的原始包；历史包内的旧分类只供审计，不能参与当前计数。来源须与路径用例一致，无 POST 启动接口。
- 回放详情的 `/export.json|export.md` 导出相同三项；当前分类、原版无有效输出和用户撤回措辞与页面一致，原始包及 hash 不改。Markdown 用动态 JSON 围栏保留全文，可无损重组；两种格式均为 attachment/no-store、本地只读门禁，不调用模型或工具。原轨迹包的 JSON/Markdown 导出仍只包含冻结轨迹包，绝不加入当前分类或改写冻结内容。
- Badcase 页分总体/逐条显示有效输出、无效、请求失败和未知次数；原版无有效输出另列「无效测试用例」，跳过分组/断言/原版复现/入库，不显示为不通过。点击才读取完整请求/输出，全文转义、不截断、不执行工具、无页面回放请求。断言/复现结论仍由评分 v2 负责。
- 有现场的切点报告单列：`case.runChecks` 只统计原版、当前轨迹/切点决定、最新冻结完整断言版本及同一现场身份的 `reportOnly` 记录；显示通过/失败/无效（含原因）/技术错误/未知和「统计的是 vN」「不作采纳依据」。冻结新版本后旧次数不拼接、不重标。报告不供 baseline、原版复现、入库或门槛统计使用。
- 同一混合版本在新 trace 正式计划中按结构化执行记录判 toolCheck，仍判全部 AI 问题及原硬断言；工具单检也可用于 trace，计划绑定 `traceToolCheck:structured-v1`，不解析 bash、不用 AI 猜参数。历史 marker-free 计划/结果仍按当时忽略 toolCheck 的条件只读，字节/hash 不变，不静默沿用旧确认执行新语义。现场报告只判 reply 问题和 toolCheck，trace/files 问题列为未判到、不送裁判。版本有问题但没有 reply 依据时显示「本版本没有回复依据的问题」。没有工具检查也没有 reply 问题的报告在预留和模型调用前拒绝。完整版本 hash 始终保留，不以筛选后的问题重新算 hash。

确认来源也可由受信操作方在用户明确授权后传入 `{ source: 'user-via-planner', reference: <公开消息ID> }`，等同页面确认，来源和引用进入决定 hash；HTTP 无此字段。相同决定的页面重试不改来源。#8 原 DeepSeek 贯穿型推荐与用户单步型/第5步改判分别保留，冻结后不能再改。

## 模式标签与首次分组（新题）

`projectWikiPatternLabels` 投影标签及确认状态，只有已确认标签参与首次分组。标签有三类：已通过模式、具名待归纳新模式（新建或加入）、不归入任何模式（旧文案「未归入现有模式」）。旧门槛/测试题也可补标签（#1/#4/#10/#14）；已有标签保持锁定，不因新文案改变内容。标签决定分组和评测模式身份，不增加归纳成员、不改既有组别。

- `POST /api/wikiskill/pattern-label-confirm` 闭合字段为 `confirmed,caseId,entryId,pendingPattern,labelHash,expectedRevision`：必须二选一传 `entryId` 或 `pendingPattern`。`entryId` 为已通过模式 ID 或 null（不归入任何模式）；`pendingPattern` 只接受 `{id}` 加入或 `{name,scope}` 新建。名称去首尾空白后为 1–40 个 Unicode 码点、范围为 1–120 个码点；名称不与已有待归纳名称或已通过模式的去首尾空白标题重名。新建待归纳记录和确认标签在 writer-lock 内同一快照发布，不留下只有名称没有标签的半成品。#185 没有 scope 的旧类别仍可读取，缺失字段不补写、不改变旧 hash 输入。
- 标签确认绑定当前 labelHash/revision，锁定后相同内容及原 labelHash 重试幂等，修改拒绝 `wiki_pattern_label_frozen`；新请求陈旧 hash/revision 分别拒绝 `wiki_pattern_label_stale/wiki_revision_conflict`。选项变化（含新建、关联）会使未确认题的 labelHash 失效，页面须重读状态。`POST /api/wikiskill/initial-split-confirm` 闭合字段仍为 `confirmed,proposalHash,patternKey,expectedRevision`。所有确认均要求明确 `confirmed=true`、local-admin 的 Host/loopback/Origin/CSRF；HTTP 不接受种子、组别或模型答案。
- GET 只提议：仅活动 GPT、`split=null`、模式已确认者参与。有现场进入 trace；无现场必须已有冻结 single/run 决定且原版在同轨迹/决定下至少一次有效单次输出。参考、原版无有效输出、删除、旧题来源、非 GPT 和标签未确认者排除。已分组的活动 GPT 非旧题若仍缺标签，首次分组全局拒绝 `wiki_initial_split_labels_required`，列出题号，避免漏算配额；#4/#10/#14 和非 GPT 不构成此阻塞。
- `planWikiInitialSplit` 按确认模式键分别计算固定种子、用例 ID SHA-256 排序及整数配额缺口：已通过模式用 entryId；未关联待归纳模式用自己的 id，各自独立配额；不归入任何模式共用 `unclassified`。关联后用目标 entryId，与同模式既有题合并计数，只给尚未分组的题补配额。trace 训练:门槛:测试=2:1:1，run 训练:门槛=2:1，同缺按训练优先；各模式门槛 run 不超过 trace，测试只收 trace。已有组别计入配额但一律不动。没有新记录的旧状态（含旧 null 标签）保持原 labelHash 输入及首次分组提议 hash。2026-11-05 的旧重分组是全局分层，不按模式；下节是历史协议，不回算或改写。
- 确认在 writer-lock 内重核当前提议/hash/revision/资格，仅冻结选中模式尚未分配的行；没有自动随机重分或调用模型。无现场原版回放由经批准的受信操作方执行，页面没有回放/评测启动按钮。

### 待归纳新模式的一次性关联与旧入口冻结

- 新增可选 `pendingPatterns` 与 `pendingPatternLinks` 数组；新标签另带 `pendingPatternId`，不改变旧 entry/null 标签的字段或字节。`POST /api/wikiskill/pending-pattern-link` 闭合字段为 `confirmed,pendingPatternId,entryId,expectedRevision`，使用同一本地管理/CSRF 守卫。writer-lock 内核对 revision、待归纳记录和当前已通过模式；不存在或未通过的目标拒绝。一份关联原子发布且不可改，相同关联重复提交幂等，换目标拒绝 `wiki_pending_pattern_link_frozen`；允许多个待归纳模式关联到同一已通过模式。
- `resolveWikiPatternLabel` 在投影层解析：关联前 entryId=null、patternKey=待归纳 id，不算任何模式的目标复现题，也不因尚未关联而报错；关联后 entryId/patternKey 均为目标模式 ID。首次分组计数和评测套件共用这一解析。不批量改标签、已有组别、首次分组提议/确认、版本成员或历史记录。来源类别的限定归纳草稿经用户审核通过时自动建立同种关联（见下节）；普通无类别来源草稿的审核不猜测或自动建立类别关联。门槛和测试成员不因关联变成归纳材料。
- 有页面标签的非训练题在 `caseStateView` 为 `classification-confirmed`，memberships 用解析后的 entryId；未关联时为空并说明待归纳名称。知识库「待你处理」不再列作归类待确认，用例页不显示旧手动归入/接受归类按钮。服务端 `assignCase`（membership 路由）和 `resolveSuggestion` 对这类题拒绝 `wiki_pattern_label_frozen`，不写记录，不让旧入口盖过页面锁定。
- `wikiConfirmedClassification` 同时遇到页面标签与旧 classification 时，解析 entryId 不同则拒绝 `wiki_classification_confirmation_required`；相同才保留旧来源和时间。只有旧 classification 的题沿用原确认；不迁移旧数据。评测目标与计划门禁见[评分契约](wikiskill-scoring.md#模式身份与目标复现题)。

## 类别身份提议与训练限定归纳

类别身份（名字、范围、成员）与模式内容（失败模式、表现、原因推测、准则）分离。前者可参考尚未分组的全部合资格用例，由用户确认；后者只读已分组的训练成员，由用户审核。范围说明仅用于类别展示/分组、判断新用例归属和生成类别提议，**不进入限定归纳输入，也不进入候选生成**；候选仍只追加已审核模式准则（≤300 字）与已审核经验，不追加范围或四项完整内容。

### 类别提议与整组确认

- 资格由 `wikiCategoryEligibleCases` 权威计算：活动 `marked-badcase`、`source.agentId=role-family-gpt`（生产 `role` 存智能体 id，不要求字面 `GPT`）、`split=null`、标签未确认、预分类 `kind=new`。每批最多20条，服务端选择整批，不允许 HTTP 自选子集或提交模型答案。独立调用可以替换有重叠成员的旧待处理提议，页面普通入口只列尚无待处理提议的题。
- 两个触发：`POST /api/wikiskill/induct` 在预分类之后接独立类别模型调用；`POST /api/wikiskill/category-propose` 对已预分类题单独提议。两者 HTTP 字段均闭合为 `confirmed,expectedRevision`，要求 `confirmed=true`、当前 revision 和 local-admin Host/loopback/Origin/CSRF。联合流程先在副本校验预分类与类别输出，全部通过才在一个快照写入；类别输出无效时也不留下本次预分类半成品，不改已有预分类记录字节。沿用预分类运行时配置、模型与隔离执行方式，不额外发现凭据。
- 模型只提议身份：一个或多个 `{name,scope,members:[{caseId,reason}]}`，可额外用 `pendingPatternId` 建议加入已有类别。名字1–40、范围1–120个 Unicode 码点；每条理由非空、≤2048 UTF-8字节。所有入选 caseId 恰出现一次，不遗漏、重复或编造，字段封闭；新名字不得重名，加入已有类别必须沿用其名字及已有范围（旧无范围类别可给建议范围但不改旧记录）。任何输出不合格整批拒绝，不确认标签、不生成模式内容。
- 新可选 `categoryProposals` 保存模型、输入/调用证明、时间/revision、身份及独立 hash；`categoryProposalResolutions` 另存 `accepted|rejected|superseded` 的处理记录和 hash。新提议与旧 pending 提议有成员交集时，追加 superseded 处理，绑定替代提议 hash；不覆盖原提议，因此同一成员最多一个未处理提议。GET 的 `categoryProposalViews` 投影状态、各成员 `canConfirm/unavailableReason`，不修改历史；已单条确认的成员不能再整组确认。
- `POST /api/wikiskill/category-confirm` 闭合字段为 `confirmed,proposalHash,expectedRevision,name,scope,members`，members 每项只含 `caseId,labelHash`；仍须上述管理/CSRF/明确确认门禁。writer-lock 内在同一写前投影核对提议未处理、revision、非空成员子集、各成员资格及 labelHash、名字/范围/重名，再一次发布类别、全部勾选标签和 accepted 处理；任一失败全部不写。新类别复用 `pendingPatterns`，增加 scope、`sourceProposalHash`；建议加入已有类别不改其冻结身份。未勾选成员仍未确认，可单条处理。
- `POST /api/wikiskill/category-reject` 闭合为 `confirmed,proposalHash,expectedRevision`，只追加 rejected 处理，不改标签。整组确认/驳回均绑定原提议 hash，已处理提议拒绝重复处理；不是覆盖提议或解锁标签的入口。

### 限定归纳与审核转正

- `POST /api/wikiskill/category-induct` 闭合为 `confirmed,pendingPatternId,expectedRevision`，沿用上述管理/CSRF/明确确认门禁。规划和存储均检查：类别存在且未关联、活动 GPT 成员全部已分组、有1–20条训练成员、最新版本没有该类别的待审核草稿。不自动分组或补齐材料。
- 模型输入白名单严格为 `{phase:'category-induction',name,cases}`；cases 正好是本类别训练成员，每条只有 `id,actual,expected,message,traceExcerpt`。不含范围、门槛/测试成员的任何内容、其他用例、已有模式或评测结果；类别名字只作标题而非额外事实。模型输出恰含一份四项内容：`failureMode,symptoms,rootCauseHypothesis,guideline`，均非空字符串，准则≤300个 Unicode 码点，原因仅为假设。超限或额外字段整批拒绝。
- 新草稿追加到 `versions`（kind=`category-induction`），title 固定为类别名，caseIds 固定为训练成员，记录 `sourcePendingPatternId/categoryReviewRequired` 和独立 inductionRun；已通过条目的字节不改，归纳时不重写原版本。全局「用模型归纳新用例」在规划和 store 校验两处跳过未关联类别成员，它们的内容只能走限定归纳，避免重复提议模式；其他训练题沿用原流程。
- Badcase 分组区与知识库都调用现有 `/api/wikiskill/review`；允许修改四项内容（准则仍≤300字）、驳回或通过，不能改类别草稿的标题或成员。仅能审核最新版本中的草稿。通过前重核类别未关联与当前训练集合等于草稿 caseIds；训练成员漂移、类别已手动关联或旧版本均拒绝通过。
- 用户明确通过时在 **同一快照** 完成三件事：草稿置 approved、训练成员记为该模式的 model-confirmed 成员、追加同种不可改 `pendingPatternLinks` 关联；`categoryReviewRequired=false`。门槛和测试成员只经解析成为该模式的目标复现题，不加入训练 caseIds。驳回不关联，可重新归纳；已有手动关联或成员变化不妨碍驳回过时草稿。已通过模式保持原冻结/修订规则，不开放自动修改。

## 删除与分层重分组（历史协议，不用于新题首次分组）

- `deleteCases({caseIds,reason,expectedRevision}, confirmation)` 是受信操作方入口，没有 HTTP 删除路由。只接受 B11 已批准的页面 #7、#9、#11、#13，确认来源必须为 `user-via-planner` 并绑定消息引用。writer 锁内追加一个快照：从活动 `cases` 和待处理归属队列移除，原用例整体保存在 `deletedCases`，记录原因、确认、原编号、时间和 hash，另追加逐条 `case-deleted` 事件。重复同一操作幂等，不允许重新导入/标记让已删除来源复活。
- 旧快照、已冻结知识库版本/准则文字、脱水决定、旧 `replaySplit`/回放登记、请求/结果文件和轨迹包均不改。活动用例被删除后归纳/脱水/选题按未知用例拒绝；轨迹读取/导出允许按归档来源核对原包，用于审计。知识库证据计数与搜索只使用活动引用，因此模式 5 可显示零条用例，不修改准则原文；模式 2、4 不再把已删引用算作证据。
- `proposeRegroup({expectedRevision})` 只持久化一次固定提议、内容 hash 与 `case-regroup-proposed` 事件，不更改任何有效分组，也没有页面自动生成/确认/应用接口。用户先核对 Badcase 页完整前后对照及 hash；确认后仍保留原提议（包括未采用的 trace 改组），不得事后改写提议内容或 hash。确认后重复提议仅返回原记录，不重新随机。
- 尚未分配有效 `split`（`train|gate|test`，尤其新标记的 `split=null`）的活动用例不进入提议 rows、输入 hash 或配额。页面独立列为「待分配」，即使尚无提议或已有确认也可看见，留给后续首次分组流程；不自动分配。选择**提议前排除**而不是增加作废/再生成入口：重新分组只保留既有 trace 组别，null 没有可保留组别，提前排除即可避免冻住必然无法确认的提议，也不开放通过重复随机挑组。提议后新增未分配用例同样不改变本次输入，已有可确认提议不因此卡住；已有提议和确认不迁移。
- 提议建议沿用既有配额比例：trace / run 两层分别按固定种子 `wikiskill-trace-run-stratified-v1` 和用例 ID 的 SHA-256 排序。trace 用现有整数缺口算法（训练:门槛:测试 2:1:1，同缺按训练→门槛→测试）；run 用其训练:门槛 2:1 投影，同缺取训练，且门槛 run 数不超过 GPT 门槛 trace 数，超额留训练。该比例连同实际结果一起交用户确认，不宣称为 B8 已规定的比例。
- #4、#10、#14 旧题来源、无现场贯穿型参考、删除项、未确认脱水及没有同题/同轨迹/同冻结决定的原版有效输出者不参与。非 GPT 只报告，不用于满足 GPT 配额。run 资格从不可覆盖请求/结果存储的当前会计重新读取，不接受调用者提交资格、种子或评测结果。输入证据含原组别、轨迹/决定 hash、原版请求/结果 hash，不包含候选、评分或通过率；提议不是已确认复现或判分通过。
- 用户 2026-11-05 经规划者确认并修正提议：#19 保留门槛、#20 保留测试，不参与重新随机；#20 已作为测试题暴露，评分 v2 重跑仍须保留测试身份，不能挪入训练。只对六条有效无现场 run 应用原随机结果：门槛 #1，训练 #2/#3/#6/#15/#16。门槛 trace/run 各一条，run 正好一半；测试仍为 #20 加 #4/#10/#14 的三道旧题。#5/#8 无效、#12 参考、#4/#10/#14 旧题来源、#17/#18 只报告的身份不变。
- `confirmRegroup({expectedRevision,proposalHash,preserveTraceSplits:true,reason}, {source:'user-via-planner',reference})` 是受信操作方入口，无 HTTP 应用路由，不接受调用者的分组、种子或资格。明确确认来源、消息引用和调整原因不可省略。writer 锁内重读当前不可覆盖 run 请求/结果并重算原提议全部输入（含旧组别、轨迹/决定/结果 hash）；与原提议逐字不符、revision/hash 不匹配、run 进测试或门槛 run 超过 trace 均拒绝，不静默重分配。固定保留 trace 原组别，只更新六条符合资格 run 的 `cases[].split`，不修改任何 trace/排除项、`replaySplit`、回放登记、旧结果、准则、轨迹包或旧快照。
- 应用在单个新快照中增加 `regroupConfirmations` 与 `case-regroup-confirmed` 事件。确认记录包含原提议/input hash、原组别/提议组别/确认组别全表、trace 冻结原因、用户调整差异、分层计数、来源/引用/时间及独立内容 hash。相同确认幂等；再次改组/改来源拒绝；发布失败不生效，原快照/文件不改，可在原 revision 重试。原提议与旧快照是旧分组的审计记录，不覆盖或复用历史评测身份。
- 确认前 Badcase 页明确「尚未生效」；确认后只读显示「用户确认的分组 · 已生效」、两份 hash、来源与调整、原组别/原提议/用户确认对照及实际计数（现收在默认折叠审计区），详情同步有效组别与分组步骤。不再把未采用的 #20→训练提议当成当前组别；原提议仍可展开审计。分组不代表已复现、判分通过或现场可回放。历史材料已有训练/评测暴露，重分组不等于新的盲留出；训练 run 只能淘汰候选，不能作为采纳依据。正式新计划已接入 run 并分 trace/run 报告，旧确认与历史结果原样读取，判定公式不变，见评分契约。

## 不支持与交付边界

- 不录制供应商原始请求字节；保留的是当时归档的语义上下文和 session 消息。旧系统提示词只有展示版时不还原路径或被遮盖值；历史输出、耗时或现场缺失不补猜。
- 不做前缀一致性检验、多轮自动迭代，也不修改生产全局提示词。类别聚合只在用户明确发起后由模型提议，不自动确认类别或标签、不自动审核模式内容；用户审核通过后的原子转正/关联不是绕过人工审核。新标记后不自动调用推荐模型、自动确认切点、自动分组或自动启动回放。
- 无现场 run 每次尝试只请求一次模型，不执行工具；正式执行交替收集两版各10次有效输出并接双检查评分。有现场只允许原版切点报告，不参与正式 run；恢复现场的 run 执行器未实现。有现场的题仍走 trace，Git 元数据完整、checkpoint 存在或报告通过均不等于可回放/复现。
- 工具检查只支持代码判断的目标工具、模式和三类参数规则，不执行脚本、不让模型判断工具调用。只解析受限内联命令或原生结构化参数；一般管道、复合命令、heredoc、内联 Node 包装脚本、变量/命令替换及 stdin/文件输入不支持。唯一管道例外是固定小语法的纯 JSON 展示尾部；回复提取原有 send-public 字面 heredoc 能力不等于工具参数解析支持 heredoc。详见评分契约的精确范围；无效不能报成通过。
- 不做训练组初筛（含 run）、不重新校准或新增裁判/JEV、不做轨迹嵌文件的统一证据面改造；不把旧字面判分当成新版证据。测试拒绝 run，门槛分 trace/run 报告但不改公式。
- 不凭预分类、类别提议或普通草稿审核猜测关联；只有来源类别限定草稿经用户通过，才原子转正并关联。手动关联是次要入口，不能撤销或换目标。已确认的「不归入任何模式」（包括旧 null 标签）不能改成待归纳类别，不提供解锁/重选入口；不新增门槛组防误伤对照题的补充入口，留待后续 Goal。
- **N5 后续项**：断言冻结后先跑原版3–5次、由多数不通过决定能否正式评测，尚未实现，留待后续独立 Goal。冻结断言不会自动判分，离线预检不会启动回放；当前「已复现」只投影已有正式评分结果，不能承诺冻结后系统会自动判分。
- 只验证隔离副本。生产轨迹包导入、删除／分组生效、推送、合并、部署、真实上线复测都须另获批准，见[发布审批](wikiskill-release.md)。用户最终接受与规划者代码评审是不同关卡，不能互相替代。

## 失败与验证

标记已成功而轨迹写入失败时返回 `trace.error: wiki_trace_unavailable`，不泄露路径/原始异常，不掩盖标记和封存状态。GET 遇到损坏返回 `wiki_trace_invalid`（409），未知 case 沿用 `wiki_unknown_case`；无包返回 null。

定向测试：`badcase-trace.test.js`、`badcase-trace-mark.test.js`、`badcase-wiki-controller.test.js`。覆盖先红后绿、完整长结果、前缀/旁支/续写边界、已知值替换、不可覆盖、原子发布失败恢复、首次失败后拒绝伪造冻结、SQLite 真实消息、删源房间后读取及 HTTP 只读门禁。`badcase-trace-export.test.js` 覆盖 JSON 相等、Markdown 无损重组、只读/远端拒绝、缺包拒绝和仅清单导出；`badcase-pipeline.test.js` 覆盖真实冻结包惰性读取、三段视图、长结果/搜索、转义、失败无摘录兜底、过期响应及来源分组。既有 `badcase-wiki.test.js` 验证原功能未变。`badcase-trace-backfill.test.js` 另覆盖只读选择/查询与复制件、来源变动两次检查、实际 task schema 与关联、旧轮次唯一回复恢复与歧义拒绝、封存轮前材料不冒充当轮输出、大数据库不全量读取、删除来源后的幂等及旧分组保留。相关标记、封存、context snapshot、executor 和 Wiki store 测试作为相邻回归。测试执行必须使用独立临时 Wiki/agent/SQLite 路径并删除继承的 `CAFF_BADCASE_CAPTURE_DIR`。

收尾在提交后的同一固定 SHA 执行 `npm run typecheck`、`npm run build`、`npm run test:fast`（包含前端语法检查及全部 badcase 套件），分别记录 Windows Node 版本和 WSL Node **22.19.0**；平台跳过项与失败不得隐藏。用户授权规划者在 2026-11-05 明确裁定：Windows 跑完整 `test:fast`（含真实浏览器 UI）；WSL 不安装浏览器，只在操作方检查命令中排除 `tests/ui/fast-mode-ui.test.js`、`tests/ui/fast-mode-observability.test.js`、`tests/ui/message-trace-stop.test.js`、`tests/ui/turn-time-breakdown.test.js` 四个缺浏览器文件，其余顺序及全部测试保留，不改 package 脚本、不加 skip。Linux 这四个 UI 文件须由另行获批推送后的 PR CI 覆盖，当前不能声称已验证。WSL 使用该 SHA 的干净本地副本和 Linux 依赖，不复用 Windows 原生模块。每条测试命令使用新的临时 Wiki/agent/SQLite 根，清除继承的生产采集根和外部集成配置；npm 测试入口另会丢弃继承的 Wiki/采集目的地，这不是操作系统沙箱。

秘密扫描只报告范围、方法和命中数，不保存原值；至少覆盖房间交付相对集成基线的文件及新增 Git 历史对象，另核对已脱敏轨迹／导出证据。已知值清单仅内存使用，不因扫描扩大生产读取授权。B6 的 DeepSeek 隔离配置副本在收尾删除并记录不存在，不触碰生产 `models.json`／GPT 登录。停止已核实 PID、启动命令与隔离路径归属的本房间预览进程，保留数据、截图、hash 和回放结果供评审；不按端口猜测杀进程。原始检查日志及清理回执只留忽略临时目录；Goal evidence 记录固定 SHA、检查摘要、独立审查及最终用户接受。

待归纳模式回归另见 `badcase-wiki-pending-patterns.test.js`、`badcase-wiki-initial-split.test.js`、`badcase-wiki-pipeline.test.js`、controller 与两个页面测试：覆盖原子新建/加入/锁定、名称/hash/revision/权限拒绝、独立配额和旧 hash、关联前后目标题及计划门禁、冻结旧入口和冲突拒绝。验证只用合成数据与假预分类/归纳模型；关键标签、分组、关联及评测角色在隔离实例的 1440/1920 宽度截图。类别回归见 `tests/runtime/badcase-wiki-category-{proposals,generation,induction,induction-generation}.test.js`、`tests/http/badcase-wiki-category-{proposals,induction}.test.js` 与两个页面测试：覆盖两触发、封闭输出/取代不可改、整组原子性、训练输入白名单、审核原子转正及目标题、全局排除和候选不读范围；均使用假模型，不外发真实请求。部署后的真实生产操作另行批准。

独立 `tests/ui/wikiskill-layout.test.js` 不在默认 fast 入口，Windows 另跑真实 Edge；WSL 无浏览器不运行它，不把该项算入 Linux 已验证范围。
