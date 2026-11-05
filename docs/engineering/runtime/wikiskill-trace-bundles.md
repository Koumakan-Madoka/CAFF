# WikiSkill 冻结轨迹包

## 边界

轨迹包是 Wiki 拥有的证据，不是聊天 Inspector 的展示投影，也不是现场可回放、已复现或可判分的证明。现有 checkpoint 封存记录仍保留自己的完整性/可回放限制。

本契约覆盖标记入口、轨迹组装和不可覆盖存储。历史回填操作入口、Badcase 页面和文件导出、脱水确认、run 级回放及新分组另行接入；不能把这里的 API 和合成测试当成那些功能已交付。

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

旧 Inspector 快照只有 `displayContent` 时可以展示已有材料，但必须标 `original_context_unavailable`；不能从 `[REDACTED]` 还原原文或声称完整。

## 已知值替换与存储

- 保存前对解码后的所有字符串和属性名作已知值字面替换 `[*]`；长值优先、重叠值不重复处理占位符。记录策略及替换次数，不记录 key 原值。
- **不**使用秘密哨兵、熵或额外模式检测；非已知值逐字保留。不能声称识别任意秘密。旧标记/知识库文字自身原有的校验不因此放宽。
- 包保存在 `<globalRoot>/traces/<source-identity-sha256>.json`，envelope 带 `schemaVersion/hash/bundle`。hash 是替换后的 `JSON.stringify(bundle)` 的 SHA-256；读取同时核对内容、来源及用例引用 hash，损坏拒绝，不回退旧内容。
- 写入使用 0600 临时文件、fsync 和 hardlink no-replace；包最大 128 MiB，超限显式失败，不截断。目录祖先属于同 OS 用户可信存储，不是路径交换安全沙箱。
- Wiki 用例只保存 `traceBundle` 的 hash、时间、完整性、缺失原因和步数等引用，避免在每一版 8 MiB Wiki 快照里重复大包。包与引用发布均在 Wiki 的现有 writer-lock 内；旧快照、组别和 replay 登记不改。
- 同来源先到者冻结，重试验证并返回原包，既不读取续写 session 也不改 hash。包已发布但快照附加失败时，`recoverCaseTrace` 只附加已有包。首次标记没留下包时，重试不能把后来内容标成原标记时采集，必须明确报告未归档；历史补全应走单独授权的回填路径。
- Wiki 自有目录不属于 checkpoint TTL/GC；删源房间不影响已有包。删除/清理 Wiki 存储不在此接口内。

## 失败与验证

标记已成功而轨迹写入失败时返回 `trace.error: wiki_trace_unavailable`，不泄露路径/原始异常，不掩盖标记和封存状态。GET 遇到损坏返回 `wiki_trace_invalid`（409），未知 case 沿用 `wiki_unknown_case`；无包返回 null。

定向测试：`badcase-trace.test.js`、`badcase-trace-mark.test.js`、`badcase-wiki-controller.test.js`。覆盖先红后绿、完整长结果、前缀/旁支/续写边界、已知值替换、不可覆盖、原子发布失败恢复、首次失败后拒绝伪造冻结、SQLite 真实消息、删源房间后读取及 HTTP 只读门禁。相关标记、封存、context snapshot、executor 和 Wiki store 测试作为相邻回归。测试执行必须使用独立临时 Wiki/agent/SQLite 路径并删除继承的 `CAFF_BADCASE_CAPTURE_DIR`。
