---
feature_ids: [F005]
topics: [image, multimodal, ui, composer, timeline, design-gate]
doc_kind: design
created: 2026-08-09
status: design_gate_review_revision
---

# F005 UI Design Gate — 图片输入与时间线渲染设计

> Owner: @烁烁/暹罗猫（视觉与交互）· 输入: kickoff 架构发现 + OQ 4/5 · 下游: @opus 实现前对齐
> **R2 修订（@opus 同步，2026-08-09）**：§1.3 预检加像素/GIF 上限并改用 config endpoint 常量源；§1.3 增加 image-only 发送；§3 补 image-only + AC-B1 证据行；§5 常量改为 config endpoint（不再前后端同 import TS，P1-5）、新增 provider-editor 模型级 capability 控件约定（P1-4）、上传响应统一 `{ imageId }`（P2-1）。
> **R3 修订（@opus 同步，2026-08-09）**：§1.3 前端预检定位为 **UX-only（非安全边界，服务端始终权威）** + config fetch 失败 fail-closed 禁用附件入口；§1.2/§5 上传改为 **batch 契约 `{ images: [{ imageId }] }`**（P1-2）+ upload `clientRequestId` 首次上传前生成并跨重试复用 + 网络未知失败保留 request id + imageIds（丢响应重试）；§5 能力位改为 **PI runtime canonical `input`（checkbox 编辑 `'image'` membership）**，弃 `supportsImageInput` 布尔（P1-1）；§2.3 补 per-invocation 阻断的 UI carrier（trace pill / inline note，复用现有语言）；§3 证据矩阵补 pixel/animated GIF/config fetch failure/network-unknown retry 行（P2-2）。

## 0. 设计原则

1. **复用现有视觉语言**：composer / ghost-button / trace-pill / eyebrow / muted / toast，不引入新组件体系。
2. **图片是一等内容，但 UI 克制**：默认状态 composer 不多占一行；有图时才出现 attachment strip。
3. **失败可见、绝不静默**：非法图片、上传失败、渲染失败、路由阻断全部给人话原因。
4. **移动端一等公民**：375px 下 strip 可横滑、缩略图可点、按钮触控目标 ≥ 40px。

## 1. OQ4 收敛：选图入口与预览/移除

### 1.1 入口形态（收敛结论）

- **主入口**：`composer-inner` 左侧新增 `icon-btn ghost` 附件按钮，图标新增 `icon-image`（现有 icons.svg 无图片图标，需补 1 个 symbol，风格对齐 `stroke-width=1.75` 线框族）。
- **快捷键路径**：`hidden file input`（`accept="image/png,image/jpeg,image/webp,image/gif"` `multiple`），点击附件按钮触发。
- **粘贴（paste）同 Phase 交付**：监听 composer textarea 的 `paste` 事件，clipboardData 中含图片文件时进入与选图相同的预检+预览管线。**理由**：operator 高频场景是截图 → 直接粘贴给模型看，paste 成本极低（与选图共用同一条管线），砍掉会伤主旅程。
- **拖拽（drag-drop）延后**：不作为本 Phase 交付。textarea 全屏拖拽态需要 overlay 视觉与防误拖处理，独立价值低于 paste，列为后续增量（Non-goal for this phase，记入 spec OQ4 收敛）。

### 1.2 预览 / 移除交互

- **Attachment strip**：有图时出现在 `composer-inner` 上方、`composer-footer` 之上的独立行（`composer-attachments`），横排缩略图卡片：
  - 缩略图 56×56（object-fit cover，圆角对齐现有卡片 8px）；
  - 右上角 16px 圆形移除按钮（复用 `icon-x`），hover/focus 可见，键盘可达（`aria-label="移除图片 {filename}"`）；
  - 每张卡片底部 `muted` 小字显示文件名截断（tooltip 全名）；
  - 超过上限（5 张，对齐受控上传边界）时再选即拒，提示见 1.3。
- **本地预览用 `URL.createObjectURL`**，发送成功或移除时 `revokeObjectURL`，不泄漏。
- **发送中状态**：strip 卡片降透明度 + 移除按钮禁用，发送成功后清空 strip；失败保留 strip 让 operator 可重试或移除。
- **移动端**：strip 横向滚动（`overflow-x: auto`），卡片尺寸不变；附件按钮在 375px 布局中保持在 textarea 左侧，触控目标 40×40。

### 1.3 非法图片即时提示

- **前端预检（R3 定位：UX-only，非安全边界——服务端始终权威）**（选择/粘贴时立即，白名单值来自 `GET /api/image-upload/config` 启动时 fetch，非硬编码）：MIME 白名单（png/jpeg/webp/gif）+ 单文件大小上限（10MB）+ 张数上限（5）+ 宽/高 ≤ 4096 + 总像素 ≤ 16M（animated GIF 拒绝）。**浏览器侧解析为尽力而为**：无法可靠解析的格式以服务端校验结果为准；前端预检只负责尽早给人话反馈，**不得因前端解析失败放行或拦截有歧义的文件**（R3 定案：前端不做安全边界）。
- **config 拉取失败 = fail closed（P2-1）**：`GET /api/image-upload/config` 启动时 fetch 失败 → **禁用附件入口**（附件按钮置灰 + `#composer-status` 显示「图片能力暂不可用」，toast 同步），**禁止硬编码 fallback**（常量只能来自服务端单一真相源）；恢复后自动重新启用。
- **上传重试与幂等（P1-2）**：`clientRequestId` 在**首次上传尝试前**生成（选择第一张图进 strip 时），上传响应丢失 / network-unknown 时**保留 request id + 已返回的 imageIds**，重试用同一 `clientRequestId` 走 canonical batch 恢复（服务端返回既有 `{ images }`），不重复上传。
- **提示双通道**：
  - 瞬态：`showToast` 一条人话原因（如「不支持 .bmp，仅支持 PNG/JPEG/WebP/GIF」「单张不能超过 10MB」「最多 5 张图片」「图片像素超限」）；
  - 常驻：`#composer-status`（composer-footer 现有 status 位）同步显示同一原因，直到下一次合法操作清除——保证 toast 消失后仍可追溯。
- **合规图片进入 strip，非法的永远不进入**；发送按钮不被非法选择阻塞（operator 可仍发纯文本）。
- **image-only 发送**：strip 非空 + 文本为空时可发送（P1-3）；发送按钮启用条件 = `content.trim() || strip 非空`。

## 2. OQ5 收敛：时间线图片渲染

### 2.1 正常态

- **气泡内布局**：`metadata.contentBlocks` 中 image block 渲染为 `message-image-grid`：
  - 单图：最大宽度 320px、保持纵横比、圆角 8px；
  - 多图：2 列 grid（gap 8px），375px 下保持 2 列但卡片等比缩小；
  - 图片在文本正文**之前**（视觉动线：先看图再看文字说明），与消息 meta 行（时间/trace pill）无冲突。
- **点击行为**：首版 `<a href="{url}" target="_blank" rel="noopener">` 包裹缩略图，新 tab 看原图。**不做 lightbox**——避免新增遮罩层组件，后续增量再说。
- **alt**：`alt="{alt || filename || '图片'}"`，无 alt 时给通用人话。

### 2.2 降级态（加载失败）

- 缩略图 `onerror` → 替换为占位卡片（同尺寸，`dashed` 边框 + `icon-image` 灰显 + 「图片加载失败」`muted` 文案 + 可点击的 URL 文本）。
- **绝不空白、绝不破版**；占位卡片同样可点击尝试新 tab 打开。

### 2.3 路由阻断反馈（预写入 422 + composer 保留附件）

- 目标模型不支持图片输入时，服务端返回 **422 `MODEL_NO_IMAGE_INPUT`**（结构化 error + 人话 reason），**消息不落库、不进入 runtime、图片保持 staged 可复用**（Phase B 定案，见 spec 契约不变量）。
- UI 行为：发送后乐观消息**回滚**（时间线不出现 blocked 消息——无 blocked 状态机）；composer **保留 attachment strip**（operator 可移除图片，或换支持图片的模型后重发）；`#composer-status` 常驻显示阻断原因（如「该模型不支持图片输入，图片未发送给模型」，文案以服务端 reason 为准），toast 同步提示。
- 复用现有 failed/pill 色彩与字号，不新造状态色。

### 2.3b 后续 invocation 阻断（P1-4 R3：历史图 + handoff/side-dispatch）

- **不只当前发送**：带图消息之后，后续纯文本 turn / handoff / side-dispatch 到非 vision 模型，且**可见历史含图**时，该 invocation 同样输出 per-invocation `MODEL_NO_IMAGE_INPUT` block——**不剥图、不静默**。
- **UI carrier（R3 定案）**：该 block 渲染为消息上的 **trace pill / inline note**（复用现有 trace pill 语言与色调，如「该模型不支持读取历史图片，已跳过图片上下文」，文案以服务端 reason 为准），**图片仍完整显示在用户消息上**；不改变消息本体、不删除图片、时间线不出现死消息。queue 继续，其他 agent 正常回复。

### 2.4 三种渲染路径一致性

历史回放、SSE 增量、刷新后渲染全部走同一个 `renderImageBlocks(message)` 助手（message-timeline 模块内），保证三条路径输出同一 DOM 结构——这是 AC-C2 的实现层锁。

## 3. 需求 → 证据映射（AC-C1/C2）

| AC | 设计点 | 验证方式 | Desktop 证据 | 375px 证据 |
|----|--------|---------|-------------|-----------|
| AC-C1 选图+预览+移除 | 附件按钮 → file input → strip 预览 → x 移除 | UI 单测（strip 增删、objectURL 生命周期）+ browser verifier | 选 2 图 → strip 2 卡片 → 移除 1 → 剩 1 截图 | 375px strip 横滑 + 触控移除截图 |
| AC-C1 粘贴 | paste 事件进同一管线 | UI 单测 + verifier 粘贴事件模拟 | 粘贴截图 → strip 出现 | 同左（mobile viewport） |
| AC-C1 非法提示（MIME/大小/张数） | MIME/大小/张数预检 + toast + status | UI 单测矩阵（bmp/11MB/第6张）+ verifier | toast + composer-status 文案截图 | 同左 |
| AC-C1 非法提示（pixel/animated GIF） | 像素超限 + animated GIF 拒绝（P2-2 R3 补行） | UI 单测（超像素图 / animated GIF fixture）+ verifier | 像素超限提示 + GIF 拒绝提示截图 | 同左 |
| AC-C1 config fetch failure | config 拉取失败 → 禁用附件入口 + 展示原因（P2-2 R3 补行） | UI 单测（fetch mock 失败）+ verifier | 附件按钮禁用 + composer-status 文案截图 | 同左 |
| AC-C1 network-unknown 重试 | 上传丢响应 → 保留 request id + imageIds，同 key 重试 canonical 恢复（P2-2 R3 补行） | UI 单测（上传 reject 后重试）+ verifier | 重试成功后 strip 正常、无重复图片截图 | 同左 |
| AC-C1 随文本发送 | strip + textarea 一起提交 | verifier：发送后 strip 清空、消息含图 | 发送后 timeline 带图消息截图 | 375px 发送流程截图 |
| AC-C1 image-only | strip 非空 + 文本空可发送 | verifier：无文本 + 图 → 发送成功、无空 text block | image-only 消息截图 | 同左 |
| AC-C2 时间线渲染 | image-grid 正常态 | verifier + 渲染单测 | 单图/多图 grid 截图 | 375px 2 列 grid 截图 |
| AC-C2 历史/刷新一致 | 三路径同一 renderImageBlocks | verifier：发送 → 刷新 → 图片仍在原位 | 刷新前后对比截图 | 同左 |
| AC-C2 降级态 | onerror 占位卡片 | verifier（坏 URL fixture） | 占位卡片截图 | 同左 |
| AC-C2 阻断反馈 | 422 回滚乐观消息 + strip 保留 + status/toast 原因 | verifier（无 vision 模型 fixture） | 阻断后 strip 保留 + composer-status 文案截图 | 同左 |
| AC-C2 后续 invocation 阻断（P1-4 R3） | 历史图 + 纯文本 turn / handoff 到非 vision 模型 → trace pill 声明跳过图片上下文，图片仍显示 | verifier（历史带图后切非 vision 模型 fixture） | trace pill 截图 + 用户消息图片仍在截图 | 同左 |
| AC-B1 Supporting 能力一目了然 | provider-editor 模型级 capability 控件（**checkbox 编辑 PI canonical `input` 的 `'image'` membership**，默认关，import 投影；R3 弃 `supportsImageInput` 布尔） | verifier：开启/关闭 checkbox → payload `input` 数组含/不含 image → 回读保留 | provider-editor 模型卡片 checkbox 截图 | 375px provider 配置截图 |

> browser verifier 沿用 `scripts/ui/verify-*.mjs` 现有模式（自起隔离实例 + Playwright desktop/390px 双 viewport + 截图落 `.tmp/`）。

## 4. 明确 Non-goals（本 Phase）

- 拖拽上传 overlay（后续增量）；lightbox 原图查看器；图片编辑/裁剪；多图重排。
- 不改动 trace pill / cross-conversation 面板的任何现有视觉。

## 5. 对实现的接口约定（给 @opus）

1. `public/assets/icons.svg` 需新增 `icon-image` symbol（注意实际路径带 `public/assets/` 前缀，非仓库根裸 `icons.svg`；设计稿：矩形框 + 内含圆形太阳 + 波浪山形线，`stroke-width=1.75`，24 viewBox）。
2. composer DOM 插入点：`composer-inner` 之前新增 `#composer-attachments` 容器；附件按钮插入 `composer-inner` 内 textarea 之前。
3. 时间线渲染入口：`message-timeline.js` 新增 `renderImageBlocks(message)`，被三路径（历史/SSE/刷新）统一调用。
4. 常量（前端预检与服务端校验同源，**R2 P1-5 + R3 修订**）：服务端 `lib/image-constants.ts` 为**单一真相源**，导出 `IMAGE_MIME_WHITELIST`（png/jpeg/webp/gif）、`MAX_IMAGE_BYTES=10_485_760`（`10*1024*1024`，P2-1 精确字节值）、`MAX_IMAGES_PER_MESSAGE=5`、`MAX_IMAGE_WIDTH/HEIGHT=4096`、`MAX_IMAGE_PIXELS=16M`、`MAX_IMAGES_PER_UPLOAD=5`、`ANIMATED_GIF_REJECTED`；经 **`GET /api/image-upload/config` 以 JSON 暴露**，前端启动时 fetch（classic defer scripts 无 bundler，不能 import TS；config parity 测试保证前后端不漂移）。**fetch 失败 = fail closed**：禁用附件入口 + 展示原因，禁止硬编码 fallback（P2-1）。不再采用"前后端同 import TS"（浏览器不可行，R2 修正）。
5. **provider-editor 模型级 capability 控件（R2 P1-4 + R3 P1-1 修订）**：provider 配置页每个 model 卡片增加 capability checkbox（**编辑 PI runtime canonical `input: Array<'text'|'image'>` 的 `'image'` membership**——勾选 → `input` 含 `'image'`；取消 → 移除。**弃 `supportsImageInput` 布尔**，PI 层不消费它，会造成 preflight 放行 + PI 静默剥图）。默认 `input: ['text']`，catalog import 时按 `modalities.input` 投影默认；随 provider payload 保存/回读；不引入新组件体系，复用现有 checkbox/switch 视觉。
6. **上传响应契约（R2 P2-1 + R3 P1-2 修订）**：`POST /api/conversations/:id/images` 为 **batch 上传**，返回 **`{ images: [{ imageId }] }`**（有序，与请求 file 顺序一致），不返回持久 URL；预览全部用 `URL.createObjectURL` 本地 objectURL，发送成功后 revoke。**上传幂等**：请求携带 `clientRequestId`（**首次上传前生成**，选择第一张图时），丢响应/network-unknown 重试同 key 返回 canonical batch，前端保留 request id + 已收 imageIds。

[烁烁/k3-256k🐾]
