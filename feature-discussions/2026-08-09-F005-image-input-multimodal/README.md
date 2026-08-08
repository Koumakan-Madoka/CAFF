---
feature_ids: [F005]
topics: [image, multimodal, content-blocks, capability, routing, upload, storage, design-gate]
doc_kind: discussion
created: 2026-08-09
status: design_gate_review_revision
---

# F005 Image Input and Multimodal Routing — Design Gate 讨论与架构决策记录

## Status

Kickoff lead（@opus/布偶猫）完成架构发现后，进入 Design Gate 讨论。本记录产出 Architecture cell / Map delta 与 Decision Packet（OQ 1/2/3），等待跨猫讨论收敛 + operator 拍板后再进入 worktree 实现。UI 部分（OQ 4/5）转交 @烁烁/暹罗猫 负责视觉与交互设计 Gate。

> **2026-08-09 Review 修订**：砚砚 Changes Requested（5 P1 + 3 P2）已逐条收敛——D1 保持定案；D2 改为 model-level `inputModalities`（P1-4）；D3 定为两阶段 + 生命周期状态机、不再升级 operator（P2-2）；阻断语义定案为预写入 422 + composer 保留附件（P1-3）；opaque imageId 投影 URL 保 SSRF=0（P1-2）；`content` 为唯一文本真相源（P1-1）；spec Owner 统一 @opus（P2-1）；F003 图片 delivery 显式 Non-goal（P2-3）。**待砚砚复审放行后进入实现。**

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
3. **capability 落库**：model-level `inputModalities`（`providers[id].models[i]`，显式、持久、operator 可见）vs 运行时由 catalog 动态派生（不污染配置但需要每次判定、依赖 catalog 在线/快照）。**已定案（D2）**：model-level 显式声明，catalog 仅 import 时投影默认值，未知 fail closed。

## 阻断语义（P1-3 定案，2026-08-09）

采用**预写入 422 + composer 保留附件**：目标模型不支持图片输入时，服务端返回 422 `MODEL_NO_IMAGE_INPUT`，消息不落库、不进入 runtime、图片保持 staged 可复用；前端回滚乐观消息、保留 strip、composer-status/toast 展示原因。时间线不出现 blocked 消息，无 blocked 状态机。原"时间线持久化 failed note"方案废弃（与 AC-B2 发送前阻断冲突）。

## 安全边界（P1-2 定案，2026-08-09）

- 客户端**只提交 opaque `imageIds`**，服务端校验归属/存在/状态后投影 `/uploads/` URL——SSRF 面为零由契约保证，非运行期假设。
- 上传校验在服务端：magic-byte（不信任浏览器 MIME）+ 像素尺寸 + 大小/张数 + 文件名消毒。

## Decision Packet（OQ 1/2/3 → operator 拍板）

### D1: PI image 输入形态（OQ 1）— 技术 A/B

- **A. prompt 路径 hint**：`session.prompt()` 仍收字符串，prompt 内嵌 `[图片: /uploads/xxx.png]`，模型经 sandbox 工具读取文件。改动最小，但依赖模型会用工具读文件、图片不直进上下文。
- **B. SDK media/结构化参数**：若 `@earendil-works/pi-coding-agent@0.80.10` 暴露 image/content-block prompt 参数，则直传结构化 image，模型一定"看见"。需 spike 验证 SDK 能力。
- **倾向**：B 优先（符合"图片是一等内容"愿景），A 为退化路径；两者都要求不剥图 fail closed。**需 operator 授权 spike 验证 SDK 0.80.10 的 prompt 输入面。**

**✅ D1 Spike 结论（2026-08-09 @opus，读全局安装 SDK 0.80.10 type defs）**：

**B 可行，且是一等公民**。`session.prompt(text, options)` 的 `PromptOptions` 已声明 `images?: ImageContent[]`（`dist/core/agent-session.d.ts:130-141`），`ImageContent = { type: 'image', data: string /* base64 */, mimeType: string }`（`pi-ai/dist/types.d.ts:239-243`）。`steer(text, images?)` / `followUp(text, images?)` 同样接受 `ImageContent[]`。SDK 还自带 `cli/file-processor.ts` 把 `@file` 参数转成 `{ text, images }`（含 `autoResizeImages` 2000×2000 上限），印证结构化 image 是官方输入路径。

**D1 定案：采用 B（结构化 `session.prompt(prompt, { images })`）**，图片 base64 + mimeType 直传模型上下文。实现透传路径已定位：`agent-executor.ts:1456` → `startRun()`（`pi-runtime.ts:347`）→ IPC `{type:'start', prompt, config}`（`pi-runtime.ts:968`）→ `normalizeStartCommand`（`pi-sdk-host.mjs:61`）→ `runAgentRuntime(runtime, prompt)`（`pi-sdk-host.mjs:208`）→ `session.prompt(prompt)`（`pi-sdk-host.mjs:225`）。需在 `start` 命令增加 `images` 字段并透传至 `session.prompt` 第二参。A（路径 hint）降级为 Non-goal——不引入双路径复杂度。

### D2: capability 落库形态（OQ 2）— **已定案（技术决策）**

- **定案（Design Gate Review，2026-08-09）**：能力位是 **model-level**——`providers[id].models[i].inputModalities: ['text','image']`（或等价 `supportsImageInput?: boolean`），**不挂在 provider 顶层**（砚砚 P1-4 纠正：图片能力因模型而异，provider 层无意义）。
- catalog `modalities.input` 仅在**显式 import/save 模型时**投影为默认值写入 models.json；运行时判定以 models.json 显式值为准，未知/缺失一律 fail closed 为不支持图片。
- 原 A（provider 顶层字段）/ B（catalog 派生视图）两选项均因坐标错误废弃，不再需要 operator 拍板。

### D3: 上传与发送时序（OQ 3）— **已定案（技术决策）**

- **定案（Design Gate Review，2026-08-09）**：两阶段——`POST /api/conversations/:id/images` 返回 `{ imageId }`（opaque），消息体带 `imageIds` 引用，服务端落库时校验并投影 URL。**属技术决策，不升级 operator**（砚砚 P2-2）。
- 生命周期状态机：`staged`（上传完成未关联）→ `attached`（消息落库原子关联）；`clientRequestId` 幂等复用已 attached 图片；`staged` 超 TTL（24h）由 GC 清理；消息删除后图片引用转可回收，GC 释放。
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

**UI Gate 已提交（2026-08-09 @烁烁）**：见 [ui-design-gate.md](./ui-design-gate.md)。收敛要点：选图主入口 + 粘贴同 Phase、拖拽延后；attachment strip 预览/移除；时间线 image-grid + 占位降级 + failed-tone 阻断标注；AC-C1/C2 desktop/375px 证据映射表已备。
