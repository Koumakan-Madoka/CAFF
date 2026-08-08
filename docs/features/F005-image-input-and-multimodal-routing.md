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

- 定义最小 content-block 契约：消息在现有 `content` 纯文本之上，经 `metadata_json.contentBlocks` 携带可选结构化块，首版只含 `{ type: 'text', text }`（服务端派生）与 `{ type: 'image', imageId, url, alt? }`（url 由服务端投影，见下）。`content` 保持兼容，历史消息、FTS 搜索、摘要 digest 不破坏。
- **受控 opaque 引用（SSRF 面为零）**：上传端点返回 `{ imageId, url }`，但**客户端只提交 `imageIds: string[]`（opaque id），服务端在落库时校验归属/存在/状态后投影出 `/uploads/...` URL** 写入 contentBlocks。客户端无法提交任意 URL/路径——`/uploads/` 静态路由只接受服务端生成的受控文件名，无符号路径解析，无远程抓取。
- 新增受控图片上传端点：MIME 白名单（png/jpeg/webp/gif）、**magic-byte 校验（不信任浏览器 MIME）**、**像素尺寸校验（解码失败/超限拒绝）**、单文件大小上限、每次张数上限、文件名消毒防路径穿越；图片存到 upload 目录并通过静态路由暴露。
- **图片生命周期（最小状态机）**：`staged`（上传完成，未关联消息）→ `attached`（消息落库时原子关联）。同 `clientRequestId` 重试复用已 attached 的图片（幂等，不重复消费）；`staged` 超过 TTL（如 24h）由后台 GC 清理；消息删除后其图片引用转为可回收，`attached` 图片随消息级联或 GC 释放（首版采用 GC，不引入独立 attachment 表）。
- 图片持久化随消息原子性：上传文件与消息落库通过幂等流程关联，刷新/历史回放/继续会话后图片仍存在；孤儿上传文件不阻塞消息写入。
- 失败路径明确：上传校验失败、存储失败、imageId 校验失败（不存在/非本会话/已 attached）时返回结构化错误，前端展示人话原因，不静默丢图。

### Phase B: Capability registry 与多模态路由判定

- **能力是 model-level，不是 provider 顶层**：capability 位挂在 `models.json` 的模型节点上——`providers[id].models[i].inputModalities: ['text','image']`（或等价 `supportsImageInput?: boolean`）。catalog `modalities.input` **仅在显式 import/save 时作为默认值投影**进 models.json，运行时判定以 models.json 显式值为准，未知/缺失一律 fail closed 为不支持图片。
- **阻断语义定案（P1-3）**：采用**预写入 422 + composer 保留附件**，不持久化 blocked message。路由层在组装 user 消息时检测 imageIds 是否非空：目标 Agent 的模型不支持图片输入 → 服务端返回 422（结构化错误 `MODEL_NO_IMAGE_INPUT` + 人话 reason），**消息不落库、不进入 runtime、图片保持 staged 可复用**；前端回滚乐观消息、保留 attachment strip（可换目标重发或移除）、在 composer-status/toast 展示原因。时间线不出现 blocked 消息，幂等/重试只作用于成功路径（无 blocked 状态机）。
- provider adapter（PI SDK host 侧）：把结构化 image block 翻译成 PI 可消费的输入——具体形态已在 Design Gate 后经 spike 验证（见 Open Questions / Decision Packet D1）。

### Phase C: 聊天 UI 输入与展示

- composer 增加图片选择入口：文件选择 + 预览 + 移除，随文本一起发送；不支持的图片类型/超限在 UI 层即时提示。
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
  4. 目标模型不支持图片输入时，消息被明确阻断或图片被标注不可达，operator 看到人话原因，绝不静默丢图。
  5. 刷新页面或回到该会话继续聊天，图片仍在原消息位置完整显示。
- **Success evidence**: 上传/存储/渲染/能力判定/runtime 传输各层测试 + desktop/375px 浏览器证据。

### Supporting Journey: 多模态能力一目了然

- **Scope unit**: provider 配置页面。
- **Actor**: operator。
- **Flow**: operator 在 provider 配置中能看到所选模型是否支持图片输入（来自 model-level `inputModalities` 能力位，catalog 仅 import 时投影默认值），不支持的模型不被展示为可读图能力。
- **Evidence**: provider-editor 截图 + capability 判定测试。

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

- [ ] AC-A1: 图片上传端点拒绝白名单外 MIME（magic-byte 校验，不信任浏览器 MIME）、超限文件（大小/像素）、超张数、路径穿越文件名；`/uploads/` 只服务受控目录，无符号路径/远程抓取（SSRF 面为零——客户端只提交 opaque imageId，服务端投影 URL）。验证：校验矩阵测试 + 静态路由测试 + imageId 投影测试。
- [ ] AC-A2: 带图消息以 `contentBlocks`（text 由 content 派生 + image 含 imageId/url）持久化，`content` 是唯一文本真相源且兼容不受破坏；客户端提交 text block/URL 返回 400；FTS 搜索、摘要 digest、历史消息解析不回归。验证：message repository + 搜索/摘要测试 + 冲突拒绝测试。
- [ ] AC-A3: 刷新页面与进程重启后，图片引用仍可从静态路由访问且消息可完整回放。验证：restart fixture + 浏览器回放证据。
- [ ] AC-A4: 上传/存储/引用失败时返回结构化错误并展示人话原因，消息写入与图片上传通过幂等流程关联（clientRequestId 幂等复用已 attached 图片），不产生半个消息或孤儿阻断。验证：错误路径测试 + 幂等复用测试。

### Phase B: Capability registry + 路由

- [ ] AC-B1: capability 位为 model-level（`providers[id].models[i].inputModalities`），catalog `modalities.input` 仅在显式 import/save 时投影默认值，`models.json` 显式值优先，未知模型 fail closed 为不支持图片。验证：model-level 判定矩阵 + 投影/优先级测试。
- [ ] AC-B2: 路由组装 user 消息时识别 imageIds；目标模型不支持 → 预写入 422 结构化阻断（`MODEL_NO_IMAGE_INPUT`），消息不落库、不进入 runtime、图片保持 staged 可复用。验证：路由阻断测试 + 消息不入队断言 + staged 复用断言。
- [ ] AC-B3: 任何路径都不得静默丢图：不支持的模型不剥图继续，失败必带明确原因。验证：全路径断言测试（grep 无静默过滤）。

### Phase C: UI 输入与展示
- [ ] AC-C1: composer 支持选图 + 预览 + 移除 + 随文本发送；非法图片在 UI 层即时提示。验证：UI 测试 + desktop/mobile 证据。
- [ ] AC-C2: 消息时间线渲染图片，历史回放/SSE 增量/刷新后一致；展示失败有降级提示。验证：browser 证据 + 渲染测试。

## Dependencies

- **Evolved from**: F002（PI SDK host 运行时方言边界，image 输入投影依赖其 prompt 契约）。
- **Related**: F004（capability registry 从 catalog modalities 投影）；F003（跨聊天室 delivery 复用 content-block 契约时需同步支持图片）。
- **Blocked by**: Design Gate review 对 D2/D3 的技术定案（本 spec OQ 2/3，已收敛）+ operator 对 UI 入口范围确认（OQ 4，UI Gate 已收敛）。D1 已 spike 定案。

## Architecture

```text
composer (file input + preview + remove)
  -> POST /api/conversations/:id/images (multipart, magic-byte MIME/size/pixel/count/filename guard)
  -> controlled upload store (/uploads/, opaque server-generated filename) -> returns { imageId }
  -> message { content: text (canonical), imageIds: opaque[] }  // client never submits url/text-block
  -> server: validate imageId ownership/state -> project url -> metadata.contentBlocks [{type:text(derived)}, {type:image,imageId,url}]
  -> capability registry (model-level inputModalities on providers[id].models[i]; catalog import default; unknown fail closed)
  -> routing: image present + model lacks vision -> pre-write 422 MODEL_NO_IMAGE_INPUT (no persistence, image stays staged)
  -> agent-executor prompt projection (images) -> pi-sdk-host session.prompt(prompt, { images }) -> model
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
| capability 误判（catalog 与运行时不符） | model-level inputModalities 显式声明 + catalog 仅 import 投影默认 + models.json 优先，未知 fail closed |

## Open Questions

1. **PI SDK host 如何接收 image 输入**：`session.prompt(prompt)` 是字符串。图片应走 prompt 内路径 hint（模型有工具可读 uploads 目录）、SDK media 参数（若 0.80.10 暴露）、还是消息 content-block 直传？需 spike 验证——决定 adapter 实现形态。**✅ 已定案（D1 spike，2026-08-09 @opus）**：`@earendil-works/pi-coding-agent@0.80.10` 的 `PromptOptions` 声明 `images?: ImageContent[]`（`dist/core/agent-session.d.ts:130-141`），`ImageContent = { type: 'image', data: base64, mimeType }`（`pi-ai/dist/types.d.ts:239-243`）；`session.prompt(prompt, { images })` 直传结构化 image，一等公民。A 路径 hint 降级为 Non-goal。实现透传路径见 Decision Packet D1。
2. **Capability 落库形态**：**✅ 已定案（Design Gate Review，2026-08-09 @opus）**——能力位是 **model-level**（`providers[id].models[i].inputModalities: ['text','image']` 或等价 `supportsImageInput?: boolean`），不是 provider 顶层。catalog `modalities.input` 仅在显式 import/save 时投影默认值，运行时以 models.json 显式值为准，未知 fail closed。不再需要 operator 拍板（技术决策，D2 收敛）。
3. **上传与发送时序**：**✅ 已定案（Design Gate Review，2026-08-09 @opus）**——两阶段（先 upload 拿 opaque imageId → 消息引用 imageId，服务端投影 URL）。技术决策，不再升级 operator（D3 收敛）。生命周期状态机（staged→attached、幂等复用、TTL GC、删除后回收）见 Phase A。
4. **UI 首版范围**：文件选择是否与拖拽/粘贴同 Phase 交付，还是拖拽/粘贴延后？**✅ UI Gate 已收敛（2026-08-09 @烁烁）**：选图主入口 + 粘贴同 Phase、拖拽延后。
5. **跨聊天室 delivery**：**✅ 已定案（Design Gate Review，2026-08-09 @opus）**——F005 首版**不支持** F003 图片 delivery：若 F003 notify/request 路径收到带图消息，返回结构化 reject（`IMAGE_DELIVERY_NOT_SUPPORTED` + 人话原因），显式 Non-goal，禁止静默剥图。见 Non-goals。

## Non-goals

- 图片生成、图片编辑、任意文件附件、OCR fallback、视频/音频上传。
- **F003 跨聊天室图片 delivery 首版不支持**：notify/request 收到带图消息 → 结构化 reject（`IMAGE_DELIVERY_NOT_SUPPORTED`），不静默剥图（OQ5 定案）。
- 不用 data URI 把图片塞进消息体（防 DB 膨胀）。
- 不按模型名硬编码 vision 白名单；不把 provider 差异泄漏到 UI/store。
- 首版不连 Redis 6399、不用生产用户数据；所有测试用隔离存储。
