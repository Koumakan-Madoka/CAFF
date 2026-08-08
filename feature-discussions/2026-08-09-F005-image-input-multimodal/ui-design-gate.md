---
feature_ids: [F005]
topics: [image, multimodal, ui, composer, timeline, design-gate]
doc_kind: design
created: 2026-08-09
status: design_gate_submitted
---

# F005 UI Design Gate — 图片输入与时间线渲染设计

> Owner: @烁烁/暹罗猫（视觉与交互）· 输入: kickoff 架构发现 + OQ 4/5 · 下游: @opus 实现前对齐

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

- **前端预检**（选择/粘贴时立即）：MIME 白名单（png/jpeg/webp/gif）+ 单文件大小上限（10MB）+ 张数上限（5）。
- **提示双通道**：
  - 瞬态：`showToast` 一条人话原因（如「不支持 .bmp，仅支持 PNG/JPEG/WebP/GIF」「单张不能超过 10MB」「最多 5 张图片」）；
  - 常驻：`#composer-status`（composer-footer 现有 status 位）同步显示同一原因，直到下一次合法操作清除——保证 toast 消失后仍可追溯。
- **合规图片进入 strip，非法的永远不进入**；发送按钮不被非法选择阻塞（operator 可仍发纯文本）。

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

### 2.3 路由阻断标注（与 status 语言一致）

- 目标模型不支持图片输入时，消息不进入 runtime（Phase B 阻断）；UI 在该消息的 meta 区域追加一条 `message-tool-trace-note failed` 同款 tone 的说明行：「该模型不支持图片输入，图片未发送给模型」（文案以服务端结构化 reason 为准）。
- 复用现有 failed/pill 色彩与字号，不新造状态色。

### 2.4 三种渲染路径一致性

历史回放、SSE 增量、刷新后渲染全部走同一个 `renderImageBlocks(message)` 助手（message-timeline 模块内），保证三条路径输出同一 DOM 结构——这是 AC-C2 的实现层锁。

## 3. 需求 → 证据映射（AC-C1/C2）

| AC | 设计点 | 验证方式 | Desktop 证据 | 375px 证据 |
|----|--------|---------|-------------|-----------|
| AC-C1 选图+预览+移除 | 附件按钮 → file input → strip 预览 → x 移除 | UI 单测（strip 增删、objectURL 生命周期）+ browser verifier | 选 2 图 → strip 2 卡片 → 移除 1 → 剩 1 截图 | 375px strip 横滑 + 触控移除截图 |
| AC-C1 粘贴 | paste 事件进同一管线 | UI 单测 + verifier 粘贴事件模拟 | 粘贴截图 → strip 出现 | 同左（mobile viewport） |
| AC-C1 非法提示 | MIME/大小/张数预检 + toast + status | UI 单测矩阵（bmp/11MB/第6张）+ verifier | toast + composer-status 文案截图 | 同左 |
| AC-C1 随文本发送 | strip + textarea 一起提交 | verifier：发送后 strip 清空、消息含图 | 发送后 timeline 带图消息截图 | 375px 发送流程截图 |
| AC-C2 时间线渲染 | image-grid 正常态 | verifier + 渲染单测 | 单图/多图 grid 截图 | 375px 2 列 grid 截图 |
| AC-C2 历史/刷新一致 | 三路径同一 renderImageBlocks | verifier：发送 → 刷新 → 图片仍在原位 | 刷新前后对比截图 | 同左 |
| AC-C2 降级态 | onerror 占位卡片 | verifier（坏 URL fixture） | 占位卡片截图 | 同左 |
| AC-C2 阻断标注 | failed-tone 说明行 | verifier（无 vision 模型 fixture） | 阻断说明行截图 | 同左 |

> browser verifier 沿用 `scripts/ui/verify-*.mjs` 现有模式（自起隔离实例 + Playwright desktop/390px 双 viewport + 截图落 `.tmp/`）。

## 4. 明确 Non-goals（本 Phase）

- 拖拽上传 overlay（后续增量）；lightbox 原图查看器；图片编辑/裁剪；多图重排。
- 不改动 trace pill / cross-conversation 面板的任何现有视觉。

## 5. 对实现的接口约定（给 @opus）

1. `icons.svg` 需新增 `icon-image` symbol（设计稿：矩形框 + 内含圆形太阳 + 波浪山形线，`stroke-width=1.75`，24 viewBox）。
2. composer DOM 插入点：`composer-inner` 之前新增 `#composer-attachments` 容器；附件按钮插入 `composer-inner` 内 textarea 之前。
3. 时间线渲染入口：`message-timeline.js` 新增 `renderImageBlocks(message)`，被三路径（历史/SSE/刷新）统一调用。
4. 常量（前端预检与服务端校验同源）：`IMAGE_MIME_WHITELIST`、`MAX_IMAGE_BYTES=10MB`、`MAX_IMAGES_PER_MESSAGE=5`——建议定义在共享模块，前端 import，服务端复用，避免双写漂移。

[烁烁/k3-256k🐾]
