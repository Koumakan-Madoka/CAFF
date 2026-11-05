# WikiSkill 冻结轨迹包

## 边界

轨迹包是 Wiki 拥有的证据，不是聊天 Inspector 的展示投影，也不是现场可回放、已复现或可判分的证明。现有 checkpoint 封存记录仍保留自己的完整性/可回放限制。

本契约覆盖标记入口、轨迹组装、不可覆盖存储和显式授权的只读历史回填操作入口。Badcase 页面、文件导出、DeepSeek 推荐的受信执行入口及页面确认冻结已接入；run 级回放、新分组及现场完整元数据仍待后续接入；不能把展示/导出或合成测试当成可回放、可评分或已入库的证明。

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
- `scene`：已有 checkpoint 的文件清单、删除/跳过/未采集项，以及已记录的 HEAD/分支/状态。只投影清单，不读取或导出现场文件内容、不事后运行 Git 补造历史元数据。
- `complete` 与 `missingReasons`：缺少原始上下文、session、精确轮次边界、输出/结果、耗时、usage、发消息步骤或已有现场的 HEAD/分支时明确降级。

Session 读取限于本实例 `named-sessions` 中选择的普通 `.jsonl`，最大 128 MiB；拒绝界外路径/链接目标和无效 UTF-8。仅接受 v3 JSONL，验证 ID 唯一、父链可解析。用冻结的起止计数选择本轮分支；保留这一分支的前缀，不含续写的下一轮或旁支。只凭 usage 推导的旧轮次终点会明确标 `turn_end_inferred_from_usage`，不冒充精确采集。

旧 Inspector 快照只有 `displayContent` 时仍可展示已有材料，不能从 `[REDACTED]` 还原原文或声称逐字原始请求。旧冻结包的 `original_context_unavailable` 只表示没有新版 `archiveContext.sections`，不意味着从 session 恢复的本轮输入和续用前轮缺失；已冻结包、hash 和导出原文不作迁移。页面对旧码解释为「没有新版上下文归档；本轮输入和续用前轮已从会话日志恢复」，session 本身缺失时另有明确缺失码。

新生成包不再添加上述宽泛旧码，分开记录：`context_archive_missing`（没有新版 sections 原文归档）、`system_prompt_missing`（没有当时系统提示词）、`system_prompt_display_redacted`（使用已有模式脱敏历史展示版）、`provider_request_bytes_missing`（未录制供应商原始请求字节）、以及各自的 session/边界/工具结果缺失码。保留旧展示分区的截断标记。`context.systemPromptSource` 区分 `known_value_archive|historical_display|missing`，`providerRequestBytesCaptured` 如实为 false。`complete` 仍判断 B2 所要求的语义轨迹材料；原始供应商请求字节不在 B2 内，只有 `provider_request_bytes_missing` 不使 B2 材料降级，不能把它解读为已录制网络请求。

## 已知值替换与存储

- 保存前对解码后的所有字符串和属性名作已知值字面替换 `[*]`；长值优先、重叠值不重复处理占位符。记录策略及替换次数，不记录 key 原值。
- **不**使用秘密哨兵、熵或额外模式检测；非已知值逐字保留。不能声称识别任意秘密。旧标记/知识库文字自身原有的校验不因此放宽。
- 包保存在 `<globalRoot>/traces/<source-identity-sha256>.json`，envelope 带 `schemaVersion/hash/bundle`。hash 是替换后的 `JSON.stringify(bundle)` 的 SHA-256；读取同时核对内容、来源及用例引用 hash，损坏拒绝，不回退旧内容。
- 写入使用 0600 临时文件、fsync 和 hardlink no-replace；包最大 128 MiB，超限显式失败，不截断。目录祖先属于同 OS 用户可信存储，不是路径交换安全沙箱。
- Wiki 用例只保存 `traceBundle` 的 hash、时间、完整性、缺失原因和步数等引用，避免在每一版 8 MiB Wiki 快照里重复大包。包与引用发布均在 Wiki 的现有 writer-lock 内；旧快照、组别和 replay 登记不改。
- 同来源先到者冻结，重试验证并返回原包，既不读取续写 session 也不改 hash。包已发布但快照附加失败时，`recoverCaseTrace` 只附加已有包。首次标记没留下包时，重试不能把后来内容标成原标记时采集，必须明确报告未归档；历史补全应走单独授权的回填路径。
- Wiki 自有目录不属于 checkpoint TTL/GC；删源房间不影响已有包。删除/清理 Wiki 存储不在此接口内。

## Badcase 页与导出

独立页签位于 WikiSkill 顶部的 Badcase，`#badcases` 可直达，`#bc-<显示编号>` 可定位。原知识库默认页和「用例」的归类/旧回放题入口保留。页面使用 `public/shared/badcase-pipeline.js` 的独立组件（加载只读，确认须用户动作），避免侵入评分 v2 的编辑器；每张卡片仅预留 `data-assertion-slot`，不伪造断言、模型建议、分组确认或新版评测结果。

- 九步：标记、现场、脱水、归类、分组、断言、回放检查、原版复现、入库。按下一步责任方分组，可切换列表；支持问题/期望/来源/编号搜索和阶段、模型筛选。保留 #4、#10、#14 的旧题来源身份，不把样例仓库当原现场。非 GPT 来源单列，只报告。
- trace / run 两条漏斗分别展示实际封存、归档及用户确认可脱水的计数；尚未接入的新版检查/断言/入库计数显式为零，不把旧字面评测或 replay 登记当作通过证据。`run 级 · 待脱水确认` 不是已经获得测试资格。
- 每条的回填状态来自 `case.traceBundle` 引用和缺失原因，提供白话缺失说明（原机器码保留在 title 和包内）。没有批准按钮；读取页面不会重跑回填、模型或任何写接口。
- 现场统一显示「待接入 · 待采集能力合入」，已有包仅展示冻结的旧清单/null 与缺失理由。2026-11-05 规划者确认：等采集 PR #179 合入 develop、房间合入 origin/develop 后再接完整 HEAD/分支/改动/未跟踪/跳过项；不据当前 HEAD 或 baseline 猜历史，不改已冻结旧包 hash，AC1 保持 pending。新组装包的现场另带 `metadataStatus: pending_capture_integration` 和 `scene_metadata_pending_capture_integration` 缺失码；旧冻结包不补写字段，页面仍明确展示待接入状态。
- 「轨迹与上下文」首次展开才 GET 对应冻结包，不使用 `message` 或 `traceExcerpt` 兜底。三段可展开：上下文逐字段、逐次模型输出/完整参数/完整工具结果/耗时与用量、现场清单。原包内容以文本/JSON 显示而非 HTML；长块（>800 字符）默认折叠，展开仍保留完整原文。支持在本包所有三段内搜索、高亮并展开命中块；搜索不截断导出。缓存按 case ID + 引用 hash 隔离，刷新后的过期响应丢弃，失败只提供显式重试。
- `GET /api/wikiskill/cases/:caseId/trace/export.json` 与 `/trace/export.md` 沿用同一本地只读管理门禁和 hash 验证。响应为 attachment、no-store；无包返回 `wiki_trace_missing`（404），损坏仍拒绝（409）。JSON 是冻结包自身（仅排版差异），没有导出时间/当前分组等附加字段。Markdown 以包信息、上下文、逐步轨迹、用量、现场组织 JSON 代码块；每个字段保留，可由各块无损重组原包，动态围栏避免正文反引号破坏结构。两种格式均不访问源房间、路径或现场文件正文，不二次脱敏/推断/截断。

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

## M3 脱水材料、推荐与确认

`wiki-dehydration.ts` 是纯数据模块，不读文件、凭据或可变房间上下文，不调用模型或工具。目前只实现：

- 身份由 caseId 与冻结包 source/hash 绑定，编号仅由 `wikiGoalCaseNumber` 投影；旧题来源 #4/#10/#14 不允许脱水。判断具体系统提示词、触发消息、前缀和标记步骤是否存在，不因旧 `original_context_unavailable` 或缺耗时就拒绝已有消息前缀。现场用例默认仍走 trace。
- DeepSeek 请求只投影当时起因、步骤卡片、发出回复、实际问题及期望，最后放能否脱水/切点两题。起因必须选自冻结的本轮输入或当时 Goal，不能从当前 Goal 补造。卡片不含 thinking 或结果 details，先替换已知 key 再裁剪；消息/方案正文保留头 500 尾 300，普通步骤最多 120，错误步骤保留报错行；旧日志中 `send-public` 已发送但工具报 `Command aborted` 时，同时保留 `messageBody`（同样头尾规则），不能让桥接终态吞掉发消息步骤的正文。只询问不晚于发出被标记消息的步骤；大于 254 个切点或 state 超过 64k 时显式拒绝，不静默丢材料。调用方还必须审核脱敏材料后才允许外发。
- 用户 2026-11-05 批准由 DeepSeek v4 flash 替代组织停用的 JEV（旧 JEV 结果与冻结包不迁移）。输出为严格 JSON，恰含 `kind`（单步型/贯穿型/说不清）、`cutStep`（卡片整数步号或“无”）、`reason`（一句理由）、`evidence`（从该步 body/messageBody 原样摘的非空依据，无切点则为空）。程序核对依据必须是所选卡片原文子串，不接受改写、别步或发出回复字段里的文字来冒充。没有概率字段，不编造把握程度。JSON/字段解析失败重试一次完全相同请求；两次仍失败显式 `parse_failed`、答案为 null。依据不匹配、无切点、非单步或说不清都只提供发消息步骤回退值并展示原因，均须用户确认，不自动冻结。
- 切点前缀只含冻结的续用消息、本轮输入、切点前的模型输出及完整结果，既不含切点输出也不含之后记账。历史展示版系统提示词和路径占位原样保留，metadata 明记「系统提示词为历史展示版，路径行已占位」。缺前置工具结果、无法解释的压缩前缀或越界切点拒绝，不用当前上下文兜底。

`recommendDehydration(input, { client, knownKeyValues })` 是受信操作入口，不开放 HTTP 上传材料/答案或任意源路径。调用方须先检查同一 `buildDehydrationRequest` 的脱敏投影，并传 `approvedRequestHash`。核对 revision、caseId、traceHash 后调用 `client.ask`；每条最多两次且仅解析失败允许第二次。并发占用同 store 拒绝，首次网络返回后检查 revision 再决定是否重试；writer-lock 内再核对 revision/hash。HTTP/网络拒绝立即停止，不重试、不保存伪造答案。已经保存的同请求只返回原记录、不重复外发；更换请求或答案不覆盖首份推荐。输出字符串及解析后的 JSON 字符串均作已知值替换，异常只报告固定码，不回显上游正文或凭据。

`createDehydrationClient({ key, fetchImpl })` 不发现/刷新/写入凭据、不构造 SDK 会话。固定使用与预分类相同的 `https://api.deepseek.com/chat/completions`、`deepseek-v4-flash`、temperature=0、max_tokens=32768、非流式 JSON 对象输出、110 秒超时，单条最多两次；请求不带工具。调用方显式提供该服务的 fetch/dispatcher，无直连兜底或重定向。返回只保存 content、finishReason、状态、耗时和 usage，不保存供应商信封/思考。响应上限 512 KiB，拒绝 key 回显。按照 B6 仅只读取得 3100 `models.json` 的 deepseek provider，写入隔离 agent 配置；不复制其他 provider/auth 或写回生产，key 不进入日志、证据、提交，Goal 收尾删除隔离凭据。

`saveDehydrationRecommendation` 在新的 Wiki 快照 `dehydrations` 中保存实际脱敏请求、JSON 原文/解析字段、依据核验、回退原因、尝试用量、建议、时间及独立 hash。不修改用例内容、冻结轨迹包/hash、旧组别、旧回放登记和历史结果。页面显示理由、原文依据/核验、切点卡片和完整脱敏请求/输出，按「等你处理」分组，不读取候选或判分结果参与推荐。

`POST /api/wikiskill/dehydration-confirm` 使用本地管理 Host/loopback/Origin/CSRF 门禁；闭合字段为 `confirmed, expectedRevision, caseId, traceHash, recommendationHash, kind, cutStep`。客户端必须显式确认，hash/revision 必须对应同一推荐和轨迹包。单步型切点须能构造有效冻结前缀；贯穿型/说不清必须 `cutStep=null`，无现场时冻结为 `reference`，有现场则保留 `trace`。决定另带 `confirmedBy=local-user`、时间、内容 hash 和事件；同决定重试幂等，任何改判/改切点均拒绝，见过评测结果也不能重开。这个用户身份语义依赖本地管理入口与任务授权，不是对同 OS 进程的安全隔离。确认不发起模型、不执行工具、不改组、不生成断言。页面失败或结果未知时停写，刷新核对，不自动重试。

当前批准的历史脱水范围是页面 #1/#2/#3/#5/#6/#8/#12/#15/#16（同时绑定 caseId），不是报告行号。#4/#10/#14 只作旧题来源；缺系统提示词的 #7/#9/#11/#13 按 B11 留到 M4 删除，保留冻结包与历史记录，本阶段不删。带 pi-coding-agent 0.85.1 和固定 caff-capabilities schema 的单次模型回放、输出存储仍未接入，不能把推荐/确认当成已回放或判分证据。

## 失败与验证

标记已成功而轨迹写入失败时返回 `trace.error: wiki_trace_unavailable`，不泄露路径/原始异常，不掩盖标记和封存状态。GET 遇到损坏返回 `wiki_trace_invalid`（409），未知 case 沿用 `wiki_unknown_case`；无包返回 null。

定向测试：`badcase-trace.test.js`、`badcase-trace-mark.test.js`、`badcase-wiki-controller.test.js`。覆盖先红后绿、完整长结果、前缀/旁支/续写边界、已知值替换、不可覆盖、原子发布失败恢复、首次失败后拒绝伪造冻结、SQLite 真实消息、删源房间后读取及 HTTP 只读门禁。`badcase-trace-export.test.js` 覆盖 JSON 相等、Markdown 无损重组、只读/远端拒绝、缺包拒绝和仅清单导出；`badcase-pipeline.test.js` 覆盖真实冻结包惰性读取、三段视图、长结果/搜索、转义、失败无摘录兜底、过期响应及来源分组。既有 `badcase-wiki.test.js` 验证原功能未变。`badcase-trace-backfill.test.js` 另覆盖只读选择/查询与复制件、来源变动两次检查、实际 task schema 与关联、旧轮次唯一回复恢复与歧义拒绝、封存轮前材料不冒充当轮输出、大数据库不全量读取、删除来源后的幂等及旧分组保留。相关标记、封存、context snapshot、executor 和 Wiki store 测试作为相邻回归。测试执行必须使用独立临时 Wiki/agent/SQLite 路径并删除继承的 `CAFF_BADCASE_CAPTURE_DIR`。
