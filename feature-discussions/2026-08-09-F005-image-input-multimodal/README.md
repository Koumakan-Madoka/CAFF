---
feature_ids: [F005]
topics: [image, multimodal, content-blocks, capability, routing, upload, storage, design-gate]
doc_kind: discussion
created: 2026-08-09
status: design_gate_pending
---

# F005 Image Input and Multimodal Routing — Design Gate 讨论与架构决策记录

## Status

Kickoff lead（@opus/布偶猫）完成架构发现后，进入 Design Gate 讨论。本记录产出 Architecture cell / Map delta 与 Decision Packet（OQ 1/2/3），等待跨猫讨论收敛 + operator 拍板后再进入 worktree 实现。UI 部分（OQ 4/5）转交 @烁烁/暹罗猫 负责视觉与交互设计 Gate。

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

1. **content-block 契约落点**：在现有 `content` + `metadata_json.contentBlocks` 做增量扩展（历史/FTS/摘要零回归）vs 把 `content` 整体改为结构化数组（更"统一"但破坏 FTS/digest/全部 string 消费者）。
2. **图片传输时序**：两阶段（先 upload 拿 URL，消息引用 URL——幂等清晰、失败可重试）vs multipart 单次提交（事务简单但耦合，clowder 风格）。
3. **capability 落库**：`supportsImageInput` 直接进 `models.json`（显式、持久、operator 可见）vs 运行时由 catalog 动态派生（不污染配置但需要每次判定、依赖 catalog 在线/快照）。

## Decision Packet（OQ 1/2/3 → operator 拍板）

### D1: PI image 输入形态（OQ 1）— 技术 A/B

- **A. prompt 路径 hint**：`session.prompt()` 仍收字符串，prompt 内嵌 `[图片: /uploads/xxx.png]`，模型经 sandbox 工具读取文件。改动最小，但依赖模型会用工具读文件、图片不直进上下文。
- **B. SDK media/结构化参数**：若 `@earendil-works/pi-coding-agent@0.80.10` 暴露 image/content-block prompt 参数，则直传结构化 image，模型一定"看见"。需 spike 验证 SDK 能力。
- **倾向**：B 优先（符合"图片是一等内容"愿景），A 为退化路径；两者都要求不剥图 fail closed。**需 operator 授权 spike 验证 SDK 0.80.10 的 prompt 输入面。**

**✅ D1 Spike 结论（2026-08-09 @opus，读全局安装 SDK 0.80.10 type defs）**：

**B 可行，且是一等公民**。`session.prompt(text, options)` 的 `PromptOptions` 已声明 `images?: ImageContent[]`（`dist/core/agent-session.d.ts:130-141`），`ImageContent = { type: 'image', data: string /* base64 */, mimeType: string }`（`pi-ai/dist/types.d.ts:239-243`）。`steer(text, images?)` / `followUp(text, images?)` 同样接受 `ImageContent[]`。SDK 还自带 `cli/file-processor.ts` 把 `@file` 参数转成 `{ text, images }`（含 `autoResizeImages` 2000×2000 上限），印证结构化 image 是官方输入路径。

**D1 定案：采用 B（结构化 `session.prompt(prompt, { images })`）**，图片 base64 + mimeType 直传模型上下文。实现透传路径已定位：`agent-executor.ts:1456` → `startRun()`（`pi-runtime.ts:347`）→ IPC `{type:'start', prompt, config}`（`pi-runtime.ts:968`）→ `normalizeStartCommand`（`pi-sdk-host.mjs:61`）→ `runAgentRuntime(runtime, prompt)`（`pi-sdk-host.mjs:208`）→ `session.prompt(prompt)`（`pi-sdk-host.mjs:225`）。需在 `start` 命令增加 `images` 字段并透传至 `session.prompt` 第二参。A（路径 hint）降级为 Non-goal——不引入双路径复杂度。

### D2: capability 落库形态（OQ 2）— 价值取舍

- **A. `models.json` 顶层 `supportsImageInput: boolean`**：operator 在 provider 配置里显式看到并确认，`models.json` 优先、catalog 缺失即 false。语义清晰、可审计，但扩展了 F004 刚钉死的 `models.json` 契约（F004 说"目录元数据不得静默升级 runtime 契约"——这里是**显式**升级，需 operator 点头）。
- **B. catalog 派生视图**：不碰 `models.json`，每次路由时查 catalog modalities。零配置污染，但离线/快照过期时会漂移，且 provider 手动配置的模型无法可靠判定。
- **倾向**：A。F005 本质是把 catalog 的 `modalities` 变成 CAFF 自己的可写能力位，与 F004"显式确认"精神一致。**需 operator 确认接受对 F004 契约的显式扩展。**

### D3: 上传与发送时序（OQ 3）— 技术 A/B

- **A. 两阶段（upload → 消息引用 URL）**：`POST /api/conversations/:id/images` 返回 `{url, uploadId}`，消息体带 `imageUrls` 引用；重试/幂等清晰，上传失败不影响文本消息发送。孤儿文件可后台 GC。
- **B. 单次 multipart**：消息接口直接收文件流（clowder 风格），一个事务落文件+消息，无孤儿，但发送接口耦合文件解析、失败重试需要重传整包。
- **倾向**：A。CAFF 消息接口是 JSON body + 幂等 key，两阶段改动面最小且失败路径干净。**需 operator 确认。**

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

**UI Gate 已提交（2026-08-09 @烁烁）**：见 [ui-design-gate.md](./ui-design-gate.md)。收敛要点：选图主入口 + 粘贴同 Phase、拖拽延后；attachment strip 预览/移除；时间线 image-grid + 占位降级 + failed-tone 阻断标注；AC-C1/C2 desktop/375px 证据映射表已备。
