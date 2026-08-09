---
feature_ids: [F005]
topics: [image, multimodal, content-blocks, capability, routing, upload, storage, design-gate]
doc_kind: discussion
created: 2026-08-09
status: design_gate_review_revision
---

# F005 Image Input and Multimodal Routing — Design Gate 讨论与架构决策记录

## Status

Kickoff lead（@opus/布偶猫）完成架构发现后，进入 Design Gate 讨论。本记录产出 Architecture cell / Map delta 与 Decision Packet（OQ 1/2/3）。D1-D3 为技术决策，**不升级 operator**。UI 部分（OQ 4/5）由 @烁烁/暹罗猫 负责视觉与交互设计 Gate。

> **2026-08-09 Review R1 修订**：砚砚 Changes Requested（5 P1 + 3 P2）已逐条收敛——D1 保持定案；D2 改为 model-level `supportsImageInput`（P1-4）；D3 定为两阶段 + 生命周期状态机、不再升级 operator（P2-2）；阻断语义定案为预写入 422 + composer 保留附件（P1-3）；opaque imageId 投影 URL 保 SSRF=0（P1-2）；`content` 为唯一文本真相源（P1-1）；spec Owner 统一 @opus（P2-1）；F003 图片 delivery 显式 Non-goal（P2-3）。
>
> **2026-08-09 Review R2 修订**：砚砚第二轮 Changes Requested（5 P1 + 3 P2，commit `docs(F005): address design gate review R2`）——P1-1 capability preflight 移到 `store.createMessage` 前同步段 + initial targets all 规则 + handoff per-invocation block；P1-2 引入 `image_uploads` registry 表为持久化真相源 + 幂等矩阵；P1-3 image-only 消息支持（`content.trim() || imageIds.length>0`）；P1-4 `supportsImageInput` 字段钉死 + provider-editor 模型级控件；P1-5 精确像素/GIF/attach-time 去重上限 + config endpoint + dependency-free parser；P2-1 上传响应统一 `{ imageId }`；P2-2 清理"等待 operator 拍板"旧语义；P2-3 F003 reject 补 AC-B4。
>
> **2026-08-09 Review R3 修订**：砚砚第三轮 Changes Requested（5 P1 + 3 P2，commit `docs(F005): address design gate review R3`）——P1-1 capability 改以 **PI runtime canonical `model.input` 为单一真相源**（弃 `supportsImageInput` 布尔，防 preflight 放行 + PI 静默剥图；parity + 静默降级回归测试）；P1-2 upload **batch 契约 `{ images: [{ imageId }] }`** + 上传阶段 `clientRequestId`（首次上传前生成）+ 两阶段幂等矩阵 + 丢响应重试；P1-3 registry schema 补 `broken` 状态 + `client_request_id` 约束 + **attach 单事务**（message INSERT + 条件 UPDATE 同一 transaction）；P1-4 `collectPromptImages(promptMessages)` prompt visibility 同源 + later-invocation per-invocation block（持久化 carrier + UI trace pill）；P1-5 安全策略 = **只承诺结构头解析**（删完整解码承诺）+ 前端预检 UX-only + config fetch 失败 fail-closed；P2-1 `MAX_IMAGE_BYTES=10_485_760` 精确字节；P2-2 UI 证据矩阵补 pixel/animated GIF/config-fail/network-unknown 行；P2-3 README 清 D1-D5/"需 operator 授权 spike"/failed-tone 旧语义。**待砚砚复审放行后进入实现。**
>
> **2026-08-09 Review R4 修订（三个完整状态模型，Stateful Object Gate）**：砚砚第四轮 Changes Requested（5 P1 + 3 P2，commit `docs(F005): address design gate review R4`）。同一状态对象连续 4 轮 finding → 触发 ≥3 轮升级规则，按三个完整状态模型修订，不再逐句补丁：
> 1. **Upload batch identity + atomic completion/retry**（P1-1+P1-2）：新增 `image_upload_batches` 批级表（`UNIQUE(conversation_id, client_request_id)` + `status complete` 为 completion truth）+ `request_fingerprint`（count + ordered file hashes/size/mime，同 key 异 payload → 409 `UPLOAD_IDEMPOTENCY_CONFLICT`）+ 提交协议（R5 修订为可恢复提交协议，见下）+ 半批次/crash 点测试。
> 2. **Multimodal prompt 单一投影 + markers + budget**（P1-3）：单一投影函数同 window（与 `agent-prompt.ts:205` `.slice(-24)` 对齐）产出 `{text, images}` + 确定性 image marker + `MAX_IMAGES_PER_INVOCATION`/`MAX_IMAGE_PROMPT_BYTES` 预算，超限显式 fail-closed，不孤立传入窗口外历史图。
> 3. **Per-invocation/integrity failure persistence**（P1-4+P1-5）：capability 阻断后沿 `agent-executor.ts:1302-1313,1947-1980` 契约直接写 `status='failed'` + `MODEL_NO_IMAGE_INPUT`/reason + `metadata_json.invocationBlocks` + 计入 failedReplies + **断言 startRun 未调用**；registry 补 `integrity_status='missing_file'`（attached 保留消息关联），历史 UI 降级占位、invocation 结构化失败不剥图。UI 文案改「本次调用已阻断：模型不支持读取历史图片」。
> 4. 补齐：P2-1 UI 图片项状态机 `pending_validation → ready | rejected`；P2-2 registry 转移约束补可执行 SQL invariants（status/integrity 枚举 CHECK、attached 必填 message/time 字段、recycled 必有 TTL、slot 范围）；P2-3 清理 D1-D5 → D1-D3 + OQ4/5。
>
> **待砚砚复审 R4 放行后进入实现。**
>
> **2026-08-09 Review R5 修订（可恢复提交协议 + 可执行 schema）**：砚砚第五轮 Changes Requested（本 thread 4 P1 + 2 P2、跨 thread 5 P1 + 3 P2，合并 4 P1 + 3 P2，commit `docs(F005): address design gate review R5`）。核心修正：
> 1. **P1-1 batch 可恢复提交协议**（spec:58/139/164、README:95、UI Gate:125）：弃"临时文件 → 单次 DB commit complete → finalization → response"（DB commit 后 crash 无法 rollback，complete 会 canonical 到缺文件批次）。改 `pending reservation（服务端算 fingerprint + lease）→ 全量预检写临时目录 → 同文件系统原子 rename batch 目录 → 最终 SQLite transaction（校验 expected_count/children/final paths 后插 image rows + complete）→ response 只认 complete`。pending 命中 lease 有效 resume/reconcile、过期回收重跑，不得当空批次重跑 INSERT。补 crash 点测试。**request_fingerprint 改服务端权威**（对实际校验后 bytes 计算，客户端 digest 仅 hint）。
> 2. **P1-2 registry schema 可执行 + 去 broken 双真相源**（spec:47-48/96、Architecture:166）：`UNIQUE(batch_id, slot)`（修正无效 `UNIQUE(conversation_id, client_request_id, slot)`——child 表已无该列）；child 表删冗余 `conversation_id`（经 batch FK 取归属）；`attached_message_id REFERENCES chat_messages(id) ON DELETE RESTRICT`；生命周期只留 `staged|attached|recycled`，文件缺失统一走 `integrity_status='missing_file'`（弃 `broken` 状态），完整性 invariants（ok ⟺ integrity_error NULL、missing_file → error NOT NULL）。
> 3. **P1-3/P1-4 UI 发送条件钉死 + rejected 语义收敛**（UI Gate:52/57）：`hasPayload = content.trim().length > 0 || strip.length > 0`；`canSend = hasPayload && strip.every(item => item.status === 'ready')`（存在 pending/rejected 即禁用，rejected 须先移除）；四象限测试矩阵。rejected 卡片保留可见可移除，"本地明确非法不入 strip / 服务端拒绝进 rejected"并存表述收敛。
> 4. **P1-4/P1-5 单一失败契约**（spec:85）：预算超限唯一 fail-closed（`IMAGE_PROMPT_BUDGET_EXCEEDED`，删除"或显式截断"分支）；attached missing_file/读文件失败 → `IMAGE_CONTENT_UNAVAILABLE`，复用同一 assistant `status='failed'` + invocationBlocks + failedReplies + startRun 未调用 + queue 继续失败路径。
> 5. **P2-1/P2-2/P2-3 补齐**：batch CHECK（`1 <= expected_count <= MAX_IMAGES_PER_UPLOAD`、complete ⟺ completed_at NOT NULL、complete 时 child count = expected_count 且 slots 连续、rejected 必有 reason 为终态、pending lease/recovery）；child GC 后 batch 行同步清理（batch/child 同步 GC）；filename 明确非 fingerprint 语义字段；三份文档同步新 authoritative 边界。
>
> **2026-08-09 Review R6 修订（fenced lease + 会话删除契约）**：砚砚第六轮 Changes Requested（2 P1，commit `docs(F005): address design gate review R6`）。两个真实集成边，不再扩展新架构：
> 1. **P1-1 fenced lease**（spec:45/60-65/71/146、README:102、UI Gate:133）：lease 只有 `lease_expires_at`、无 owner → 并发同 key duplicate 会同时 resume 写同一 temp/final dir，stale worker 超时后仍可 takeover 后 late-complete。钉死：batch 加随机 `lease_token`；reservation/takeover 用条件 UPDATE/CAS 取得唯一 lease；**lease 有效时非 owner 不得 resume**（结构化 `UPLOAD_IN_PROGRESS` + retryAfter，或同进程 in-flight promise 去重），不启动第二条文件管线；过期 takeover 生成新 token；**最终 complete transaction 带 `WHERE status='pending' AND lease_token=<caller>`**，stale worker 影响行数 0、停止并清理自己临时产物；补 concurrent duplicate / lease expiry takeover / stale worker late-complete / complete 后 canonical retry 测试。
> 2. **P1-2 会话删除契约**（spec:47/57/76/146、README:103、真实链 `conversations-controller.ts:847` → `chat-app-store.ts:2075` → `conversation.repository.ts:123` DELETE + `migrations.ts:642` `chat_messages` CASCADE）：R5 的 `image_uploads.attached_message_id ON DELETE RESTRICT` 会阻断现有会话删除（CASCADE 删 message 被 RESTRICT 挡住，第一条带图消息后会话删除稳定报错）。补：`image_upload_batches.conversation_id` 明确 FK REFERENCES `chat_conversations(id)`；**会话删除 = 同一 SQLite transaction 内先 purge 该会话全部 image rows + batch rows（明确立即 purge）再删 conversation**，不依赖 CASCADE 碰运气；DB commit 后 best-effort 删 batch dirs；文件删除失败由启动 reconciliation 清孤儿、不回滚已完成的 DB 删除；测试：带 attached/staged/recycled 图会话删除成功、无 FK 错误、registry/batch 无残留、目录删除失败后 reconciliation 收敛、DELETE conversation 不回归。
>
> **2026-08-09 R7 契约加固（command-center 平行 review `001343`，对已 PASS 的 `9c619a4` 的独立二次审视，不重开 Gate，折叠为实现期可执行契约）**：5 条 finding 全部落入 spec/README/UI Gate（commit `c963cd6`，仅 spec 文件；README/UI Gate 本段同步说明）：**P1-1 filesystem fencing**——temp 目录改 `.tmp/<batch_id>/<lease_token>/`（token/attempt 隔离），fenced UPDATE 影响 0 行 → 整个 SQLite transaction ROLLBACK（不留半批次 child rows）+ 清自己 attempt；**P1-2 rename-then-crash**——启动 reconciliation 不得把 pending batch 的 final 目录当孤儿删，pending final-dir 验证 → 齐全 fenced commit 补 complete / 不齐清 final 保 pending；**P1-3 batch canonical vs child TTL**——整批消费（部分 attach → 400 `IMAGE_PARTIAL_BATCH_ATTACH_REJECTED`）+ 整批 GC（未消费 batch 同事件清 batch+child+file），已消费 batch child 随消息删除逐 TTL 释放、batch 行最后清理（新增 `consumed_at`）；**P2-1 rejected 执行路径**——确定性校验失败（magic-byte/像素/大小/张数/文件名/expected_count）→ `rejected`+reason 终态、同 key 重试返回原因、换 payload 须新 key；存储/DB/crash → 保持 `pending`；**P2-2 Architecture 去旧**——fenced lease 三分支 + token 隔离 + 整批语义替换 R5 旧"有效 lease resume"。

## 架构发现（Evidence Read）

### CAFF 现状（基线 `origin/main@3c51a8b`）

| 层 | 文件 | 现状 |
|----|------|------|
| 消息存储 | `storage/sqlite/migrations.ts:284-300`、`storage/chat/message.repository.ts` | `chat_messages.content` TEXT + `metadata_json` TEXT；无 content-block 契约，全部按 string 读写 |
| 发送 API | `server/api/conversations-controller.ts:1017-1020` | 只接受 `{ content, clientRequestId }`；无 multipart / file |
| 前端 composer | `public/index.html:96-113`、`public/app.js:4375-4378` | 只有 textarea，发 JSON body；无 file input/预览 |
| Prompt 投影 | `server/domain/conversation/turn/agent-executor.ts:1239-1240,1456` | `buildAgentTurnPromptSections` → 纯字符串 prompt → `startRun(provider, model, prompt)` → `pi-sdk-host.mjs:225` `session.prompt(prompt)` |
| 模型能力 | `server/domain/models/model-provider-config.ts` | 运行时契约只有 `id/name/api/baseUrl/family/reasoning`，无 modalities/capability |
| 目录数据 | `assets/model-catalog.json` (F004) | 有 `modalities: { input: [...], output: [...] }`，但 F004 明确为 catalog metadata，不静默升级 runtime 能力 |
| PI runtime | `lib/pi-runtime.ts:174-205` | assistant 侧已解析 content-block 数组（`extractAssistantText`），但 user prompt 输入是单字符串 |

### Clowder 参考（不照搬语义，取其边界）

| 层 | 参考实现 | 可借鉴边界 |
|----|---------|-----------|
| 消息 schema | `packages/shared/src/types/message.ts` | `MessageContent = Text | Image | Code | ToolCall | ToolResult`；ImageContent `{type:'image', url, alt?}` |
| multipart/校验 | `packages/api/src/routes/parse-multipart.ts`、`image-upload.ts`、`utils/image-storage.ts` | MIME 白名单 png/jpeg/gif/webp、10MB/张、MAX_FILES=5、文件名消毒防穿越、`/uploads/` URL 静态服务 |
| 路径/URL 提取 | `providers/image-paths.ts` | 从 contentBlocks 提取绝对路径（CLI `--add-dir`）/HTTP URL（外部 runtime） |
| 能力判定 | `providers/KimiAgentService.ts:97-99` | `supportsImageInput = modelConfig.capabilities.includes('image_in')` 式显式能力位 |
| CLI 传图 | `providers/image-cli-bridge.ts` | base64 media items / prompt path hints / `--add-dir` 工作目录 |

## 关键 Tradeoff（决策要点）

1. **content-block 契约落点**：在现有 `content` + `metadata_json.contentBlocks` 做增量扩展（历史/FTS/摘要零回归）vs 把 `content` 整体改为结构化数组（更"统一"但破坏 FTS/digest/全部 string 消费者）。**已定案**：增量扩展，`content` 为唯一文本真相源，text block 服务端派生（P1-1 双真相源收敛）。
2. **图片传输时序**：两阶段（先 upload 拿 opaque imageId，消息引用 imageId，服务端投影 URL——幂等清晰、失败可重试）vs multipart 单次提交（事务简单但耦合，clowder 风格）。**已定案（D3）**：两阶段，属技术决策不升级 operator；生命周期状态机（staged→attached、幂等复用、TTL GC、删除后回收）。
3. **capability 落库**：model-level `input`（`providers[id].models[i].input: Array<'text'|'image'>`，与 PI runtime canonical 一致，显式、持久、operator 可读写）vs 运行时由 catalog 动态派生（不污染配置但需要每次判定、依赖 catalog 在线/快照）。**已定案（D2，R3 P1-1）**：model-level 显式 `input` 数组（单一真相源，弃 `supportsImageInput` 布尔——PI 层不消费布尔位会静默剥图），catalog 仅 import 时投影默认值，未知 fail closed。

## 阻断语义（P1-3 定案，2026-08-09；P1-1 R2 修正位置）

采用**预写入 422 + composer 保留附件**。**capability preflight 必须发生在 `store.createMessage` 之前的同步段**（真实链：controller 同步调用 `submitConversationMessage` → `createMessage` 同步落库 → 异步 drain，`turn-orchestrator.ts:1420-1445`），不能放 routing 异步段——否则 HTTP 已 200 且消息已落库。initial targets 用 **all 规则**（@mention 命中的所有 agents 或第一个 agent，任一模型不支持图片 → 422 `MODEL_NO_IMAGE_INPUT`，消息不落库、图片保持 staged 可复用）；后续 handoff/side-dispatch 到不支持图片的模型时输出 per-invocation 结构化 block，不剥图。前端回滚乐观消息、保留 strip、composer-status/toast 展示原因。时间线不出现 blocked 消息，无 blocked 状态机。原"时间线持久化 failed note"方案废弃。

## 安全边界（P1-2 定案，2026-08-09；P1-2/P1-5 R2 加固）

- 客户端**只提交 opaque `imageIds`**，服务端校验归属/存在/状态后投影 `/uploads/` URL——SSRF 面为零由契约保证，非运行期假设。**上传响应按 batch 契约返回 `{ images: [{ imageId }] }`（有序），不提前下发持久 URL**（P1-2 R3；首版 UI 用 objectURL 预览）。
- 上传校验在服务端：magic-byte（不信任浏览器 MIME）+ 像素尺寸（`MAX_IMAGE_WIDTH/HEIGHT=4096`、`MAX_IMAGE_PIXELS=16M`、animated GIF 拒绝）+ 大小（10MB）/张数（5）+ 文件名消毒；**attach-time 再校验** distinct imageIds ≤ 5 且去重（多 upload 请求无法绕过）。
- **图片状态以最小 `image_uploads` registry 表为持久化真相源**（P1-2）：DB 真相源 + 启动 DB/文件 reconciliation + integrity 标记（R5 P1-2：弃 `broken` 双真相源）+ 孤儿回收；幂等矩阵（同 clientRequestId canonical result / 不同 key 引用已 attached 明确拒绝）。
- **常量真相源**：`lib/image-constants.ts` 为单一真相源，经 `GET /api/image-upload/config` 以 JSON 暴露前端（classic defer scripts 无法 import TS，P1-5）。magic-byte/尺寸解析采用 dependency-free 有限解析器；需新增 direct dependency 时先回指挥中心走依赖授权。

## Decision Packet（OQ 1/2/3 — 技术决策，不升级 operator）

### D1: PI image 输入形态（OQ 1）— 技术 A/B

- **A. prompt 路径 hint**：`session.prompt()` 仍收字符串，prompt 内嵌 `[图片: /uploads/xxx.png]`，模型经 sandbox 工具读取文件。改动最小，但依赖模型会用工具读文件、图片不直进上下文。
- **B. SDK media/结构化参数**：若 `@earendil-works/pi-coding-agent@0.80.10` 暴露 image/content-block prompt 参数，则直传结构化 image，模型一定"看见"。需 spike 验证 SDK 能力。
- **倾向**：B 优先（符合"图片是一等内容"愿景），A 为退化路径；两者都要求不剥图 fail closed。**D1 spike 已执行并定案（见下），"需 operator 授权 spike"旧语义已清理（P2-3 R3）。**

**✅ D1 Spike 结论（2026-08-09 @opus，读全局安装 SDK 0.80.10 type defs）**：

**B 可行，且是一等公民**。`session.prompt(text, options)` 的 `PromptOptions` 已声明 `images?: ImageContent[]`（`dist/core/agent-session.d.ts:130-141`），`ImageContent = { type: 'image', data: string /* base64 */, mimeType: string }`（`pi-ai/dist/types.d.ts:239-243`）。`steer(text, images?)` / `followUp(text, images?)` 同样接受 `ImageContent[]`。SDK 还自带 `cli/file-processor.ts` 把 `@file` 参数转成 `{ text, images }`（含 `autoResizeImages` 2000×2000 上限），印证结构化 image 是官方输入路径。

**D1 定案：采用 B（结构化 `session.prompt(prompt, { images })`）**，图片 base64 + mimeType 直传模型上下文。实现透传路径已定位：`agent-executor.ts:1456` → `startRun()`（`pi-runtime.ts:347`）→ IPC `{type:'start', prompt, config}`（`pi-runtime.ts:968`）→ `normalizeStartCommand`（`pi-sdk-host.mjs:61`）→ `runAgentRuntime(runtime, prompt)`（`pi-sdk-host.mjs:208`）→ `session.prompt(prompt)`（`pi-sdk-host.mjs:225`）。需在 `start` 命令增加 `images` 字段并透传至 `session.prompt` 第二参。A（路径 hint）降级为 Non-goal——不引入双路径复杂度。

### D2: capability 落库形态（OQ 2）— **已定案（技术决策）**

- **定案（Design Gate Review R2 + R3，2026-08-09）**：能力位是 **model-level**，**以 PI runtime canonical `providers[id].models[i].input: Array<'text'|'image'>` 为单一真相源**（P1-1 R3：弃 `supportsImageInput` 布尔——PI `transform-messages.js` 用 `model.input.includes('image')` 判定，布尔位会被 PI 忽略、静默剥图，违反 AC-B3）。
- **可执行读写契约（P1-1 R3）**：provider-editor 模型级新增 capability checkbox（**编辑 `input` 数组的 `'image'` membership**，operator 可显式勾选/取消）；normalize 只接受合法数组（含 'text'/'image'）；API 回读 payload 保留该字段；手工编辑默认 `input: ['text']`。**parity 回归测试**保证 CAFF 判定 == PI `model.input.includes('image')`。
- catalog `modalities.input` 仅在**显式 import/save 模型时**投影为默认 `input`（`modalities.input.includes('image')` → `input: ['text','image']`）写入 models.json；运行时判定以 models.json 显式值为准，未知/缺失一律 fail closed 为不支持图片。
- 原 A（provider 顶层字段）/ B（catalog 派生视图）两选项均因坐标错误废弃。技术决策，不升级 operator。

### D3: 上传与发送时序（OQ 3）— **已定案（技术决策）**

- **定案（Design Gate Review R2 + R3 + R4，2026-08-09）**：两阶段——`POST /api/conversations/:id/images` 按 **batch 契约**返回 **`{ images: [{ imageId }] }`**（有序，P1-2 R3；opaque 不返回 url），消息体带 `imageIds` 引用，服务端落库时校验并投影 URL。**属技术决策，不升级 operator**（砚砚 P2-2）。
- **batch identity（R4 P1-1 + R5 P1-1 修订）**：新增 `image_upload_batches` 批级表为 **completion truth**（`UNIQUE(conversation_id, client_request_id)` + `status pending|complete|rejected`）+ **`request_fingerprint`**（**服务端对实际校验后 multipart bytes 计算**，count + ordered file hashes/size/mime，客户端 digest 仅 hint）；同 `(conversation_id, client_request_id)` 重试 fingerprint 一致 → canonical batch、**不一致 → 409 `UPLOAD_IDEMPOTENCY_CONFLICT`**。
- **batch 提交协议（R5 P1-1 + R6 P1-1：crash-consistent 可恢复协议 + fenced lease，替代 R4 "单次 DB commit all-or-nothing"）**：pending reservation（服务端算 fingerprint + 随机 `lease_token` + `lease_expires_at`，reservation 即取唯一 lease）→ 全量预检写临时目录 → 同文件系统原子 rename batch 目录到 final → **最终 SQLite transaction**（校验 expected_count/children/final paths 后插 image rows + 条件 UPDATE 置 `complete` + `completed_at`，**带 `WHERE status='pending' AND lease_token=<caller>`**）→ response 只认 complete。同 key 命中 pending：**同进程 in-flight → 共享 promise**；lease 有效但非 owner → `UPLOAD_IN_PROGRESS` + retryAfter（不得 resume）；lease 过期 → CAS 条件 UPDATE 抢占取新 token 成为唯一 owner 后 reconcile/重跑。complete ⟺ completed_at NOT NULL ⟺ child count = expected_count。补 crash 点测试 + concurrency 测试（concurrent duplicate / lease expiry takeover / stale worker late-complete / complete 后 canonical retry）。
- **生命周期以 `image_upload_batches` + `image_uploads` registry 表为持久化真相源（P1-2/P1-3 + R4 + R5 + R6）**：图级状态机 `staged` → `attached` → `recycled`（R5 P1-2 弃 `broken` 状态——文件缺失统一以 `integrity_status='missing_file'` 表达）+ `integrity_status`（R4 P1-5，attached 缺文件保留消息关联）；唯一约束 `UNIQUE(batch_id, slot)`（R5 P1-2 修正 R4 无效约束，`conversation_id`/`client_request_id` 经 batch FK 提供）；`image_upload_batches.conversation_id` 明确 FK REFERENCES `chat_conversations(id)`（R6 P1-2）；`attached_message_id` FK `ON DELETE RESTRICT`；**attach 单事务**（message INSERT + image 行条件 UPDATE 同一 SQLite transaction）；两阶段幂等矩阵（上传同 key+同 fingerprint canonical batch / 同 key 异 payload 409 / 消息同 key canonical result / 不同 key 引用已 attached 明确拒绝）；`staged` 超 TTL（24h）由 GC 清理；消息删除后 attached → recycled（选定一种，不做转 staged 复用）；**会话删除 = 同一 transaction 内先 purge 该会话全部 image rows + batch rows 再删 conversation（明确立即 purge，R6 P1-2），DB commit 后 best-effort 删 batch dirs、失败由 reconciliation 清孤儿**；启动时 DB/文件 reconciliation；child GC 后 batch 行同步清理（R5 P2-1）。
- 客户端不提交 URL/路径——SSRF 面为零由 opaque id 契约保证（砚砚 P1-2）。

## Architecture cell / Map delta

```text
Architecture cell: server/domain/conversation (messages) + server/domain/models (capability) + server/http (upload static) + public/chat (composer/timeline)
Map delta: update required
Why: 首次把能力判定写进 models domain 契约，并在 conversation/messages 引入 content-block 与受控上传；需更新 server/domain/models 与消息存储的归属边界，不新增并行 Store/Router。
```

## 转交 UI Design Gate（@烁烁）

- OQ 4: 文件选择入口是否与拖拽/粘贴同 Phase；预览/移除交互形态；非法图片的即时提示样式。
- OQ 5: 消息时间线图片渲染（缩略图/原图/降级态）；与现有 trace pill/status 语言一致性。
- 需求→证据映射表：AC-C1/C2 的 desktop + 375px 浏览器证据计划。

**UI Gate 已提交（2026-08-09 @烁烁）**：见 [ui-design-gate.md](./ui-design-gate.md)。收敛要点：选图主入口 + 粘贴同 Phase、拖拽延后；attachment strip 预览/移除；时间线 image-grid + 占位降级；**阻断反馈 = 422 预写入 + 乐观消息回滚 + composer 保留附件（无 blocked 状态机、无 failed-tone 时间线标注）**；AC-C1/C2 desktop/375px 证据映射表已备（R3 补 pixel/GIF/config-fail/network-unknown 重试行）。
