---
feature_ids: [F005]
related_features: [F002, F003, F004]
topics: [chat, image, multimodal, content-blocks, capability, routing, upload, storage, provider]
doc_kind: spec
created: 2026-08-09
---

# F005: Image Input and Multimodal Message Routing

> **Status**: spec | **Owner**: @opus/布偶猫 (kickoff lead) | **Priority**: P1

## Why

CAFF 聊天目前只支持纯文本消息：`chat_messages.content` 是单一 TEXT，发送接口只接收 `{ content, clientRequestId }`，没有任何图片输入、内容块或多模态能力判定的契约。CAFF 原始改造愿景（`thread_msiputnz4yxhs6j3`）明确要求"支持图片输入"，且多模态路由不能靠硬编码模型名猜——必须在 capability registry 层回答"这个模型能不能读图"，再决定把图片送给谁。

价值终点：operator 在聊天里选一张图、预览、随文本发出，带图消息在刷新/历史回放/继续会话后依然完整；路由层依据 CAFF 自己的 capability registry 判断目标模型是否支持图片输入，支持的 provider adapter 收到结构化 image 内容，不支持的模型在发送前或路由处被明确阻断——任何路径都不得静默丢图。

## Current State / 现状基线

Baseline: `origin/main@3c51a8b` (2026-08-08)。
- `chat_messages` 表只有 `content TEXT NOT NULL`，`metadata_json TEXT` 已承接 F003 的 `clientRequestId`、上下文快照等扩展，但**没有 content-block 或图片契约**（`storage/sqlite/migrations.ts:284-300`；`storage/chat/message.repository.ts` 全部按 string 读写）。
- 前端 composer 只发 `{ content, clientRequestId }` 到 `POST /api/conversations/:id/messages`（`public/app.js:4375-4378`；`server/api/conversations-controller.ts:1017-1020`）；输入区只有 textarea（`public/index.html:96-113`），无 file input/预览/拖拽。
- 消息投影：`turn-orchestrator` → `routing-executor` 把消息组装成 `promptMessages`（`prompt-visibility.ts`），`agent-executor.ts:1239-1240` 用 `buildAgentTurnPromptSections`/`formatAgentTurnPromptSections` 拼成**纯字符串 prompt**，经 `startRun(provider, model, prompt, ...)`（`agent-executor.ts:1456`）进入 `pi-sdk-host.mjs` 的 `session.prompt(prompt)`（`pi-sdk-host.mjs:225`）。整条链目前只消费字符串。
- PI runtime 已能解析 assistant 侧的 content-block 数组（`lib/pi-runtime.ts:174-205` 的 `extractAssistantText` / `assistantMessageHasPendingToolUse`），说明 SDK 事件流是结构化的，但 **user prompt 输入仍是单字符串**，无 image 入口。
- models domain（F004）：`model-provider-config.ts` 的运行时契约只有 `id/name/api/baseUrl/family/reasoning`，**无 modalities/vision/capability 字段**；vendored `assets/model-catalog.json` 里有 `modalities: { input: [...], output: [...] }`，但按 F004 明确属于 catalog metadata，**不得静默升级为 runtime 能力**。
- 无 `/uploads/` 静态服务、无 multipart 解析、无图片上传校验、无图片存储（仓库里仅头像 data URL 校验先例：`lib/chat-app-store.ts:222` 限制 png/jpeg/webp/gif）。

## What

### Phase A: 统一 content-block 契约 + 受控图片上传存储

**文本单一真相源（canonical）**：`content`（TEXT 列）是消息文本的唯一真相源。`metadata_json.contentBlocks` 里的 `{ type: 'text', text }` 是**写入时的派生视图**，不是第二真相源：

- **写入派生**：服务端落库时由 `content` 派生 text block（`contentBlocks = [{type:'text', text: content}, ...imageBlocks]`），客户端**只提交 `content` + `imageIds`**，不得直接提交 text block。
- **冲突拒绝**：客户端请求中若携带 `contentBlocks` 或与 `content` 冲突的 text 内容，服务端返回 400（结构化错误 `TEXT_BLOCK_FROM_CLIENT_REJECTED`），拒绝落库。
- **读取规则**：FTS 搜索、摘要 digest、历史解析一律只读 `content`；`contentBlocks` 仅供渲染结构与图片引用。`content` 与 text block 永不并行歧义。
- **image-only 消息（P1-3 定案）**：`content.trim() || imageIds.length > 0` 为合法消息。纯图消息允许空 `content`，此时**不生成 text block**（`contentBlocks` 只有 image blocks），`content` 落库为空字符串。前后端空文本校验同步放宽（现 `public/app.js:4319-4321`、`turn-orchestrator.ts:1405-1407` 的"Message content is required"改为"content 为空时必须有 imageIds"）。

- 定义最小 content-block 契约：消息在现有 `content` 纯文本之上，经 `metadata_json.contentBlocks` 携带可选结构化块，首版只含 `{ type: 'text', text }`（服务端派生）与 `{ type: 'image', imageId, url, alt? }`（url 由服务端投影，见下）。`content` 保持兼容，历史消息、FTS 搜索、摘要 digest 不破坏。
- **受控 opaque 引用（SSRF 面为零）**：上传端点按 **batch 契约（P1-2 定案）**返回 `{ images: [{ imageId }] }`（有序 opaque id 数组，与请求 file 顺序一致；不返回持久 url——首版 UI 用 objectURL 预览，无需提前持有持久 URL）。客户端**只提交 `imageIds: string[]`（opaque id）**，服务端在落库时校验归属/存在/状态后投影出 `/uploads/...` URL 写入 contentBlocks。客户端无法提交任意 URL/路径——`/uploads/` 静态路由只接受服务端生成的受控文件名，无符号路径解析，无远程抓取。
- 新增受控图片上传端点：MIME 白名单（png/jpeg/webp/gif）、**magic-byte 校验（不信任浏览器 MIME）**、**结构头解析校验（签名/尺寸头/像素，见 P1-5——只承诺结构头解析成功，不承诺完整解码）**、单文件大小上限、每次张数上限、文件名消毒防路径穿越；图片存到 upload 目录并通过静态路由暴露。
- **图片生命周期（P1-2/P1-3 定案：最小 `image_uploads` registry 表，非重型附件系统）**：新增 `image_uploads` SQLite 表作为图片状态的**持久化真相源**。完整 schema 与状态机见下（P1-3 补齐 broken 状态与 client_request_id 约束）。
- **`image_uploads` registry schema（P1-3 定案）**：
  - 列：`image_id` PK、`conversation_id` NOT NULL、`status` NOT NULL、`client_request_id` NOT NULL、`slot` NOT NULL（该图在上传批次内的 0-based 位置，同一批次每张图一个固定槽位）、`file_name`、`stored_path` NOT NULL、`mime_type`、`width`、`height`、`size_bytes`、`attached_message_id`（nullable，仅 attached 非空）、`created_at`、`attached_at`（nullable）、`ttl_expires_at`（nullable）。
  - **唯一约束**：`UNIQUE(conversation_id, client_request_id, slot)`——同一次上传批次的每张图占据固定槽位；batch 重试（同 `client_request_id`）命中同一批次的既有槽位返回 canonical，不会重复写行。
  - **`client_request_id` 语义**：**上传请求 id**，由前端**在首次上传尝试前生成**（选择第一张图、进入 strip 时即生成，不是点击发送时——P1-2 修正现 `app.js:4363` 的时机），同一批次的全部图片共享，跨"结果未知"重试复用。发送消息用的是**另一个消息级 `clientRequestId`**（现有 F003 机制）。
  - **状态机**：`staged`（上传完成，未关联消息）→ `attached`（消息落库时原子 UPDATE，写入 `attached_message_id`/`attached_at`）；`recycled`（消息删除后由 attached 转入，可由 GC 释放）；`broken`（启动 reconciliation 发现 DB 有引用但文件缺失）。状态集合：`staged | attached | recycled | broken`。
  - **转移约束**：仅 `staged` 可 → `attached`；仅 `attached` 可 → `recycled`；`broken` 从非 attached 状态（staged/recycled）由 reconciliation 标记；`recycled`/`broken`/超 TTL 的 `staged` 由 GC 删文件 + 删行。`attached` 不允许被直接删除（必须先转 `recycled`）。
  - DB 是真相源，文件与 DB 通过 `stored_path` 关联；启动时 DB/文件 reconciliation（DB 有引用但文件缺失 → 非 attached 标记 broken、attached 记录 integrity 告警不剥图；文件存在但无 DB 行 → 孤儿回收）。
- **幂等矩阵（P1-2/P1-3 修正，两阶段分别幂等）**：
  | 场景 | 行为 |
  |------|------|
  | **上传阶段**：同 `(conversation_id, client_request_id)` 重试（首传响应丢失 / network-unknown） | **canonical result**：返回既有批次的 `{ images: [{ imageId }] }`，不重复写行不重复存文件 |
  | **消息阶段**：同消息 `clientRequestId` + 同 imageIds 重试（消息落库后） | **canonical result**：返回既有消息，imageId 复用已 attached，不重复消费 |
  | 不同 `client_request_id` / 不同消息 key 引用已 attached 的 imageId | **明确拒绝**（400 `IMAGE_ALREADY_ATTACHED`），不静默复用 |
  | imageId 不存在 / 非本会话 / broken | 400 结构化错误 |
  | `staged` 超过 TTL（24h） | 后台 GC 删文件 + 删行 |
  | **消息删除（P1-3 选定一种）** | 其 `attached` 图片行 → `recycled`（原子 UPDATE，`ttl_expires_at = now()`），GC 按 TTL 释放文件 + 行；不做"转 staged 复用"分支 |
- **attach 单事务（P1-3 定案）**：`message INSERT` 与所有 image 行条件 UPDATE（`staged`→`attached`，校验 `conversation_id` 归属、`status='staged'`、`attached_message_id IS NULL`、影响行数 = imageIds 去重后数量）在**同一个 SQLite transaction** 内；任一行不满足则整体回滚，不产生半条消息或部分 attached。
- 图片持久化随消息原子性：上传文件与消息落库通过幂等流程关联，刷新/历史回放/继续会话后图片仍存在；孤儿上传文件不阻塞消息写入。
- 失败路径明确：上传校验失败、存储失败、imageId 校验失败（不存在/非本会话/已 attached 且非同 key）时返回结构化错误，前端展示人话原因，不静默丢图。

### Phase B: Capability registry 与多模态路由判定

- **能力是 model-level，且以 PI runtime canonical `model.input` 为单一真相源（P1-1 R3 定案）**：capability 位钉死为 **`providers[id].models[i].input?: Array<'text' | 'image'>`**——与 PI runtime 0.80.10 一致（`@earendil-works/pi-ai` `transform-messages.js` 用 `model.input.includes('image')` 判定，不包含时把 image 降级成 `"(image omitted: model does not support images)"`；CAFF 的 `pi-model-config-validator.mjs` 已把 models.json 交给 pinned PI `ModelRuntime.create` 校验，`input` 字段可直接被 runtime 消费）。**不引入并行布尔位** `supportsImageInput`：自定义 `supportsImageInput: true` 会被 Pi 模型合成忽略，造成 CAFF preflight 放行、PI 层静默剥图，直接违反 AC-B3。运行时可读视图 = `input.includes('image')`。
  - **catalog import 投影**：`modalities.input` 仅在显式 import/save 模型时投影为 `input`（`modalities.input.includes('image')` → `input: ['text','image']`），运行时判定以 models.json 显式值为准。
  - **未知/缺失一律 fail closed**：`input` 缺失或未含 `'image'` → 判定为不支持图片（CAFF 校验端默认 `input: ['text']`，与 PI 一致）。
- **capability 可执行契约（P1-1 R3）**：`input` 必须可被 operator 读写——provider-editor 模型级新增 capability 控件（**checkbox 编辑 `'image'` membership**：勾选 → `input` 含 `'image'`；取消 → 移除），normalize 时接受 `Array<'text'|'image'>`（非规范值拒绝：非数组、含非 text/image 元素）；API 投影把 `input` 纳入 provider 回读 payload；手工编辑的模型默认 `input: ['text']`，operator 可显式勾选图片能力。**parity 回归测试**：CAFF capability 判定与 PI `model.input.includes('image')` 必须一致（含静默降级回归测试——`input` 不含 image 的模型，images 不得被送进 `session.prompt`）。
- **阻断语义定案（P1-1 R2 修正位置 + R3 扩展）**：真实链路是 controller **同步**调用 `submitConversationMessage` → `store.createMessage`（同步落库）→ 异步 drain（`turn-orchestrator.ts:1420-1445`）。因此 capability preflight 必须发生在 **`store.createMessage` 之前**（controller 同步段内），而不是 routing 异步段——否则 HTTP 已 200 且消息已落库。具体规则：
  - **initial targets 的 all 规则**：preflight 解析初始 target-set（与 `resolveInitialSpeakerQueue` 同源：@mention 命中的所有 agents，无 mention 则第一个 agent，`routing-executor.ts:95-102`），**所有 initial target 的模型必须都支持图片输入**（任一不支持 → 422 `MODEL_NO_IMAGE_INPUT`，消息不落库、不进入 runtime、图片保持 staged 可复用）。首版采用 all 规则（图片进共享 user 消息，所有 initial agents 都会收到；不能为某个 agent 剥图）。多 agent mixed-capability 场景下，operator 可移除图片或换用全 vision 的 target-set 重发。
  - **handoff/side-dispatch 的 per-invocation 阻断（P1-4 R3 扩展）**：后续 handoff 或 side-dispatch 到不支持图片的模型时，该 invocation 输出结构化 block `MODEL_NO_IMAGE_INPUT`（附人话 reason），**不剥图继续、不静默丢弃**——图片仍在该用户消息里，只是该 invocation 明确声明不可读图。**持久化/UI carrier**：该 block 写入该 invocation 的 assistant 消息 `metadata_json.invocationBlocks`，UI 以 trace pill / inline note 展示（复用现有 trace pill 语言）；**queue 继续**：该 invocation 失败不终止 turn，其余 agent 正常执行；turn failure 按现有计数逻辑计入（`failedReplies`）。**prompt 可见性同源（P1-4 关键）**：每个 invocation 组装 prompt 时，从 `promptMessages`/snapshot 经 **`collectPromptImages(promptMessages)`**（与 `prompt-visibility.ts` 同源）收集可见图片集合（历史带图消息 + 当前 imageIds，按消息顺序与文本 prompt 对齐），以 `input.includes('image')` 对**该 invocation 的可见图片集合**逐次判定——不仅看当前请求是否带图，后续纯文本 turn 但可见历史含图时，非 vision target 也要 per-invocation block，不允许历史图被静默剥掉（见 AC-B3 扩展）。
  - 422 为**预写入**（不入队、无 blocked 状态机、无半条消息）；时间线不出现 blocked 消息。
- provider adapter（PI SDK host 侧）：把结构化 image block 翻译成 PI 可消费的输入——具体形态已在 Design Gate 后经 spike 验证（见 Open Questions / Decision Packet D1）。

### Phase C: 聊天 UI 输入与展示

- composer 增加图片选择入口：文件选择 + 预览 + 移除，随文本一起发送（**image-only 允许**：strip 有图时无文本也可发送）；不支持的图片类型/超限在 UI 层即时提示。
- 消息时间线渲染 image block：历史消息回放、SSE 增量、refresh 后均显示图片；展示失败有降级提示而非空白。

## User Journey

### Primary Journey: 发送一张图片并让多模态模型理解

- **Scope unit**: 一次带图片的聊天消息发送。
- **Actor**: operator。
- **Entry**: 在当前聊天室的 composer 中点击图片入口并选择一张本地图片。
- **Flow**:
  1. 图片在输入区即时预览，operator 可移除后重新选择，并输入随图文字。
  2. 发送后，带图消息立即以 optimistic 形态出现在时间线（含图片缩略图）。
  3. 目标 Agent 的模型支持图片输入时，图片随消息进入模型上下文，Agent 可描述/分析图片内容。
  4. 目标模型不支持图片输入时，服务端返回 422 `MODEL_NO_IMAGE_INPUT`，消息不落库、图片保持 staged 可复用，operator 看到人话原因可移除图片或换支持图片的模型重发，绝不静默丢图。
  5. 刷新页面或回到该会话继续聊天，图片仍在原消息位置完整显示。
- **Success evidence**: 上传/存储/渲染/能力判定/runtime 传输各层测试 + desktop/375px 浏览器证据。

### Supporting Journey: 多模态能力一目了然

- **Scope unit**: provider 配置页面。
- **Actor**: operator。
- **Flow**: operator 在 provider 配置中能看到并可编辑所选模型是否支持图片输入（**编辑 PI canonical `input` 数组的 `'image'` membership**，provider-editor 模型级 checkbox；catalog 仅 import 时投影默认值），不支持的模型不被展示为可读图能力。
- **Evidence**: provider-editor 截图（含模型级 capability 控件）+ capability 判定测试 + **PI parity 回归测试**。

## 需求点 Checklist

| ID | 需求点（operator 转述/愿景） | AC | 验证方式 |
|----|---------------------------|----|---------|
| R1 | 聊天输入区能选图、预览、移除并随文本发送 | AC-C1 | UI 测试 + browser 证据 |
| R2 | 图片随消息持久化，刷新/回放/续会话仍存在 | AC-A2, AC-A3 | storage/restart 测试 + 截图 |
| R3 | 路由层按 capability 判定目标模型是否支持图片 | AC-B1, AC-B2 | capability/路由测试 |
| R4 | 不支持的模型必须明确阻断，不得静默丢图 | AC-B3 | 阻断路径测试 |
| R5 | 上传安全受控（MIME/大小/张数/路径穿越/SSRF） | AC-A1 | 安全校验测试 |

### 覆盖检查
- [x] 每个需求点都能映射到至少一条 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（Design Gate）

## Acceptance Criteria

### Phase A: Content-block 契约 + 上传存储

- [ ] AC-A1: 图片上传端点拒绝白名单外 MIME（magic-byte 校验，不信任浏览器 MIME）、超限文件（大小/像素）、超张数、路径穿越文件名；`/uploads/` 只服务受控目录，无符号路径/远程抓取（SSRF 面为零——客户端只提交 opaque imageId，服务端投影 URL）。**P1-5 安全策略定案**：上传接受 = **结构头解析成功**（magic-byte 签名 + 尺寸头 + 像素上限 + animated GIF 探测），**不承诺完整图片可解码**（有限 dependency-free header parser 无法证明解码性；删"解码失败拒绝"承诺）；**前端预检只是 UX，服务端始终权威，前端预检不作为安全边界**。**精确上限**：`MAX_IMAGE_BYTES = 10 * 1024 * 1024 = 10_485_760`（P2-1 精确字节值）、`MAX_IMAGES_PER_UPLOAD=5`、`MAX_IMAGE_WIDTH=4096`、`MAX_IMAGE_HEIGHT=4096`、`MAX_IMAGE_PIXELS=16_000_000`；**GIF 策略**：animated GIF 拒绝（`ANIMATED_GIF_REJECTED`），static GIF 按首帧尺寸校验；**attach-time 再校验**：消息 attach 时对 `imageIds` 去重并校验 distinct 数量 ≤ `MAX_IMAGES_PER_MESSAGE=5`（多 upload 请求无法绕过）。**常量真相源**：服务端 `lib/image-constants.ts` 为单一真相源，经 `GET /api/image-upload/config` 以 JSON 暴露给前端（前端启动时 fetch，不 import TS——classic defer scripts 无 bundler）；**config 拉取失败 = fail closed**：禁用附件入口/展示原因，禁止硬编码 fallback（P2-1）。**依赖策略**：magic-byte/尺寸解析采用 dependency-free 有限解析器（png/jpeg/webp/gif 头解析），若需新增 direct dependency 先回指挥中心走依赖授权。验证：校验矩阵测试 + 静态路由测试 + imageId 投影测试 + config parity 测试 + config fail-closed 测试。
- [ ] AC-A2: 带图消息以 `contentBlocks`（text 由 content 派生 + image 含 imageId/url）持久化，`content` 是唯一文本真相源且兼容不受破坏；客户端提交 text block/URL 返回 400；FTS 搜索、摘要 digest、历史消息解析不回归；**image-only 消息**（空 content + imageIds）可持久化且不生成空 text block。验证：message repository + 搜索/摘要测试 + 冲突拒绝测试 + image-only 测试。
- [ ] AC-A3: 刷新页面与进程重启后，图片引用仍可从静态路由访问且消息可完整回放。验证：restart fixture + 浏览器回放证据。
- [ ] AC-A4: 上传/存储/引用失败时返回结构化错误并展示人话原因，消息写入与图片上传通过幂等流程关联，不产生半个消息或孤儿阻断；**两阶段幂等矩阵（P1-2 R3）**：上传阶段同 `(conversation_id, client_request_id)` 重试（响应丢失/network-unknown）返回 canonical batch；消息阶段同消息 `clientRequestId` 重试返回 canonical result、不同 key 引用已 attached imageId 拒绝；`client_request_id` 在**首次上传前**由前端生成并跨重试复用；**attach 单事务**：message INSERT + 所有 image 行条件 UPDATE（staged→attached，含 ownership/status/row-count 校验）同一 SQLite transaction，任一行失败整体回滚。验证：错误路径测试 + 两阶段幂等矩阵测试（含丢响应重试）+ attach 事务原子性测试 + registry reconciliation 测试。

### Phase B: Capability registry + 路由

- [ ] AC-B1: capability 位为 model-level 且**以 PI runtime canonical `providers[id].models[i].input: Array<'text'|'image'>` 为单一真相源**（P1-1 R3；弃 `supportsImageInput` 布尔——PI 层不认识它，会造成 preflight 放行 + PI 静默剥图）；catalog `modalities.input` 仅在显式 import/save 时投影为 `input`，models.json 显式值优先，未知模型 fail closed 为不支持图片；`input` 可经 provider-editor 模型级控件读写（checkbox 编辑 `'image'` membership；normalize 只接受合法数组；回读保留）。**parity 回归测试**：CAFF 判定与 PI `model.input.includes('image')` 一致 + 静默降级回归测试（`input` 不含 image 的模型，images 不得进 `session.prompt`）。验证：model-level 判定矩阵 + 投影/优先级测试 + capability 读写测试 + parity/静默降级测试。
- [ ] AC-B2: **同步 preflight 在 `store.createMessage` 之前**（controller 同步段）识别 imageIds；**initial targets 任一模型不支持图片 → 预写入 422**（`MODEL_NO_IMAGE_INPUT`），消息不落库、不进入 runtime、图片保持 staged 可复用；**prompt 可见性同源**：每次 invocation 用 `collectPromptImages(promptMessages)` 按可见图片集合判定（`agent-executor.ts:1322-1329` 每个 invocation 都是新 session 且注入完整 room history），后续纯文本 turn 可见历史含图时同样判定，非 vision target 输出 per-invocation 结构化 block（**持久化到 `metadata_json.invocationBlocks` + UI carrier，queue 继续，失败计入 failedReplies**）。验证：路由阻断测试 + 消息不入队断言 + staged 复用断言 + preflight 位置断言（createMessage 前）+ handoff block 测试 + **"图片消息后刷新/重启再发纯文本"测试 + 多图顺序测试**。
- [ ] AC-B3: 任何路径都不得静默丢图：不支持的模型不剥图继续，失败必带明确原因；**PI runtime 的静默降级被 preflight + per-invocation 判定双保险挡住**（`input` 不含 image 的模型 images 永不进 `session.prompt`）。验证：全路径断言测试（grep 无静默过滤）+ parity 静默降级回归测试。
- [ ] AC-B4 (P2-3): F003 notify/request 两入口收到带图消息 → 结构化 reject `IMAGE_DELIVERY_NOT_SUPPORTED` + 人话原因，消息与图片不剥离不降级。验证：notify/request 两路径 reject 测试。

### Phase C: UI 输入与展示
- [ ] AC-C1: composer 支持选图 + 预览 + 移除 + 随文本发送；非法图片在 UI 层即时提示。验证：UI 测试 + desktop/mobile 证据。
- [ ] AC-C2: 消息时间线渲染图片，历史回放/SSE 增量/刷新后一致；展示失败有降级提示。验证：browser 证据 + 渲染测试。

## Dependencies

- **Evolved from**: F002（PI SDK host 运行时方言边界，image 输入投影依赖其 prompt 契约）。
- **Related**: F004（capability registry 从 catalog modalities 投影）；F003（跨聊天室 delivery 复用 content-block 契约时需同步支持图片）。
- **Blocked by**: Design Gate review 对 D1-D5 的技术定案（本 spec OQ 1/2/3/5 与 UI Gate OQ 4 均已收敛；R1/R2/R3 三轮 review 的 P1/P2 已修订）。D1 已 spike 定案。等待 Design Gate 复审放行后进入实现。

## Architecture

```text
composer (file input + preview + remove; image-only allowed when strip non-empty; clientRequestId for upload generated BEFORE first upload)
  -> GET /api/image-upload/config (constants: mime/size/pixel/count whitelist, JSON, single truth lib/image-constants.ts; fetch failure -> fail closed, disable attachment entry)
  -> POST /api/conversations/:id/images (multipart batch, magic-byte MIME/size/pixel/count/filename guard; dependency-free header parser; client_request_id) -> returns { images: [{ imageId }] } (ordered)
  -> controlled upload store (/uploads/, opaque server-generated filename) + image_uploads registry (staged, UNIQUE(conversation_id, client_request_id, slot))
  -> message { content: text (canonical, may be ''), imageIds: opaque[] }  // client never submits url/text-block
  -> SYNC capability preflight (BEFORE store.createMessage): resolve initial targets (mention-set or first agent);
     imageIds present + any target model.input lacks 'image' -> 422 MODEL_NO_IMAGE_INPUT (no persistence, images stay staged)
  -> store.createMessage (validate imageId ownership/state + distinct-count<=5 -> SINGLE transaction: message INSERT + conditional image rows staged->attached -> project url
     -> metadata.contentBlocks [{type:text(derived, omitted when content empty)}, {type:image,imageId,url}])
  -> async drain -> routing (per-invocation: collectPromptImages(promptMessages) visible set; handoff/side-dispatch to non-vision model
     -> per-invocation MODEL_NO_IMAGE_INPUT block persisted to metadata_json.invocationBlocks + UI carrier, no stripping, queue continues)
  -> agent-executor prompt projection (images) -> pi-sdk-host session.prompt(prompt, { images }) -> model (PI runtime gate: model.input.includes('image'); images never passed when input lacks image)
```

Architecture cell: `server/domain/conversation (messages) + server/domain/models (capability) + server/http (upload static) + public/chat (composer/timeline)`

Map delta: update required

Why: F004 的 models cell 只覆盖 provider 配置；本 Feature 首次把"能力判定"写进 models domain 契约，并在 conversation/messages 引入 content-block 与受控上传——需要更新 `server/domain/models` 与消息存储的归属边界说明，不新增并行 Store/Router。

## Eval / Tracking Contract

- **Primary users + activation**: 聊天 operator；activation 是首次选择图片并发送，或配置 provider 时查看图片能力。
- **Friction metric**: 带图消息中被阻断（不支持模型）或展示失败的占比；上传被拒次数，按原因聚类。
- **Regression fixtures**: content-block 持久化 fixture；restart 图片可达 fixture；capability 判定矩阵 fixture；阻断（不剥图）fixture；UI 选图/预览/移除 fixture。
- **Sunset signal**: 当 catalog/runtime 两侧 capability 判定冗余（所有目标模型统一支持图片）时移除 registry 分支；替换方案必须保留不剥图保证与上传安全。

## Risk

| 风险 | 缓解 |
|------|------|
| 静默丢图或剥图继续 | 全路径断言：阻断必带原因，无静默过滤 |
| content-block 破坏历史消息/FTS/摘要 | content 保持兼容，contentBlocks 只做增量扩展 |
| 上传面开放攻击（路径穿越/SSRF/炸弹） | 受控目录、opaque imageId 投影（客户端不提交 URL）、magic-byte MIME、大小/像素/张数限制、无符号解析、无远程抓取 |
| PI 不支持结构化 image 输入 | Design Gate spike 已定案：SDK 0.80.10 原生支持 `images` 参数（见 OQ1）；不剥图 fail closed |
| capability 误判（CAFF 声明与 PI runtime 不符） | 单一真相源 `model.input`（与 PI 0.80.10 一致）+ catalog 仅 import 投影默认 + parity 回归测试（CAFF 判定 == `model.input.includes('image')`），未知 fail closed |
| preflight 放错层（落库后才阻断） | capability preflight 在 `store.createMessage` 之前的同步段（AC-B2 位置断言测试） |
| PI 层静默降级剥图（`input` 不含 image 仍传图） | preflight + per-invocation 判定双保险：`input` 不含 image 的模型 images 永不进 `session.prompt`（AC-B3 parity 静默降级回归测试） |
| prompt 历史图片被静默剥掉（later-invocation） | `collectPromptImages(promptMessages)` 与 prompt-visibility 同源，每次 invocation 按可见图片集合判定 + per-invocation block 持久化 carrier（AC-B2） |
| image_uploads registry 与文件漂移 | DB 为真相源，启动 reconciliation + broken 标记 + 孤儿回收（AC-A4 reconciliation 测试） |
| 多 Agent mixed-capability 会话 | initial targets all 规则（任一不支持 → 422）+ handoff/side-dispatch per-invocation block，不剥图 |

## Open Questions

1. **PI SDK host 如何接收 image 输入**：`session.prompt(prompt)` 是字符串。图片应走 prompt 内路径 hint（模型有工具可读 uploads 目录）、SDK media 参数（若 0.80.10 暴露）、还是消息 content-block 直传？需 spike 验证——决定 adapter 实现形态。**✅ 已定案（D1 spike，2026-08-09 @opus）**：`@earendil-works/pi-coding-agent@0.80.10` 的 `PromptOptions` 声明 `images?: ImageContent[]`（`dist/core/agent-session.d.ts:130-141`），`ImageContent = { type: 'image', data: base64, mimeType }`（`pi-ai/dist/types.d.ts:239-243`）；`session.prompt(prompt, { images })` 直传结构化 image，一等公民。A 路径 hint 降级为 Non-goal。实现透传路径见 Decision Packet D1。
2. **Capability 落库形态**：**✅ 已定案（Design Gate Review R2 + R3，2026-08-09 @opus）**——能力位是 **model-level**，**以 PI runtime canonical `providers[id].models[i].input: Array<'text'|'image'>` 为单一真相源**（P1-1 R3：弃 `supportsImageInput` 布尔，避免与 PI `model.input` 双真相源导致静默剥图），并定义可执行读写契约（provider-editor 模型级 checkbox 编辑 `'image'` membership、normalize/回读保留、catalog import 仅投影默认、未知 fail closed）。**parity 回归测试**保证 CAFF 判定与 PI `model.input.includes('image')` 一致。技术决策，不需要 operator 拍板（D2 收敛）。
3. **上传与发送时序**：**✅ 已定案（Design Gate Review R2 + R3，2026-08-09 @opus）**——两阶段（先 upload 拿 opaque imageId → 消息引用 imageId，服务端投影 URL），上传按 **batch 契约**返回 `{ images: [{ imageId }] }`（有序，P1-2）。**图片状态以 `image_uploads` registry 表为持久化真相源**（P1-2/P1-3）：状态机 `staged → attached → recycled` + `broken`，唯一约束 `UNIQUE(conversation_id, client_request_id, slot)`（上传阶段幂等，client_request_id 首次上传前生成），attach 单事务（message INSERT + 条件 UPDATE 同一 transaction），TTL GC、消息删除转 recycled、启动 reconciliation。技术决策，不再升级 operator（D3 收敛）。
4. **UI 首版范围**：文件选择是否与拖拽/粘贴同 Phase 交付，还是拖拽/粘贴延后？**✅ UI Gate 已收敛（2026-08-09 @烁烁）**：选图主入口 + 粘贴同 Phase、拖拽延后。
5. **跨聊天室 delivery**：**✅ 已定案（Design Gate Review，2026-08-09 @opus）**——F005 首版**不支持** F003 图片 delivery：若 F003 notify/request 路径收到带图消息，返回结构化 reject（`IMAGE_DELIVERY_NOT_SUPPORTED` + 人话原因），显式 Non-goal，禁止静默剥图。见 Non-goals。

## Non-goals

- 图片生成、图片编辑、任意文件附件、OCR fallback、视频/音频上传。
- **F003 跨聊天室图片 delivery 首版不支持**：notify/request 收到带图消息 → 结构化 reject（`IMAGE_DELIVERY_NOT_SUPPORTED`），不静默剥图（OQ5 定案；executable AC 见 AC-B4）。
- 不用 data URI 把图片塞进消息体（防 DB 膨胀）。
- 不按模型名硬编码 vision 白名单；不把 provider 差异泄漏到 UI/store。
- 首版不连 Redis 6399、不用生产用户数据；所有测试用隔离存储。
