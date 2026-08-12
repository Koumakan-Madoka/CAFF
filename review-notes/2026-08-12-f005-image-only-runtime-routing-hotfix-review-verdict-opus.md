---
title: F005 Image-Only Runtime Routing Hotfix — Review Verdict (opus)
feature_ids: [F005]
topics: [review, hotfix, image-only, multimodal, runtime, routing, content-blocks]
doc_kind: review_verdict
created: 2026-08-12
reviewer: 布偶猫/@opus
author: 缅因猫/@砚砚
review-target-id: f005-image-only-runtime-routing
branch: fix/f005-image-only-runtime-routing
reviewed-sha: fa0d1545
base: origin/main@fd1da04
verdict: APPROVED
---

# F005 Image-Only Runtime Routing Hotfix — Review Verdict

## Verdict

**APPROVED**（0 P1 / 0 P2 / 0 P3）— 可直接进入 merge-gate。

独立核验目标：产品 HEAD `fa0d1545f513ea2d97d4fb0678b5608b78927b9e`（packet `4f8828b` 仅审查材料），基线 `fd1da04`。Diff 9 文件 / 307+/39-，与请求信声明一致。

## 独立 Quality Gate（作者 self-pass 禁止，由我执行）

在独立 sandbox（`%TEMP%/cat-cafe-review/f005-image-only-runtime-routing/opus`，detached `fa0d1545`，junction 只读 node_modules，无生产数据）逐项重跑：

| 门禁 | 结果 |
|------|------|
| `tsc -p tsconfig.typecheck.json` | ✅ exit 0 |
| `tsc -p tsconfig.build.json`（沙箱 rebuild `fa0d154`） | ✅ exit 0 |
| 聚焦 runtime 4 套件（turn-orchestrator / image-invocation / multimodal-projection / agent-executor-hook） | ✅ 99/99 |
| `npm run test:fast` | ✅ 14/14 |
| `npm run test:smoke` | ✅ 20/20 |
| `npm run check` | ✅ exit 0 |
| `git diff --check fd1da04..fa0d154` | ✅ exit 0 |
| UI 110/110 + structure 15/15 | 接受作者证据（本 hotfix 无 public/ 前端 delta，diff 统计确认） |

## 独立代码核验（非作者转述）

### 1. `messageImageBlocks()` metadata-only 统一（核心修复）

`multimodal-projection.ts:11-17` 改为只读 `metadata.contentBlocks`。grep 全 `server/` 6 处 `contentBlocks` 引用逐一核验：
- `conversations-controller.ts:1039-1040` — 拒绝客户端提交 contentBlocks（fail-closed）
- `turn-orchestrator.ts:1266-1282` — `targetMessage.contentBlocks` 是 F003 delivery DTO，独立显式 422 `IMAGE_DELIVERY_NOT_SUPPORTED`（请求信声明属实）
- `multimodal-projection.ts:15` — canonical 读取，投影/历史文本/marker 三条路径全部经 `messageImageBlocks()`

**结论：无顶层 `message.contentBlocks` 读取残留，canonical-shape 漂移彻底消除。**

### 2. Routing 双路径正确性

`routing-executor.ts:196-206`：
- 混合 `batchMessageIds + imageIds` → 显式 400（FC-1 修复，两源不静默忽略）
- `hasImages` 双路径：persisted batch 读 canonical blocks；direct 读 `turnInput.imageIds`
- `!content && !hasImages` → 400 `Message content is required`（纯空仍拒绝）

`normalizeConversationTurnInput`（routing-executor.ts:76）+ `createAcceptedMessagePayload`（turn-orchestrator.ts:43）均保留 `imageIds`，全链路无丢失。

### 3. Store 归属原子（direct 路径）

`chat-app-store.ts createMessage`（2638-2797）：ownership 校验（必须属于本 conversation）→ staged 状态校验 → 整批 attach 校验（partial reject）→ clientRequestId 幂等（content+imageIds 全等才复用）→ `deriveMessageContentBlocks` 单一真相源。routing 不自行合成第二套 block 表示，符合请求信 Tradeoff。

### 4. 测试审查

- fixture 从顶层 `contentBlocks` 统一迁移到 `metadata.contentBlocks`（agent-executor-hook / image-invocation / multimodal-projection），证实作者"fixture 漂移导致伪绿"诊断
- 新增 4 场景 Red→Green：persisted image-only batch 执行 / direct image-only 走 store imageIds / 纯空拒绝 / 混合来源 400
- 幂等与竞态路径在既有 store 契约内回归

## 结论

hotfix 精确命中根因（runtime 消费者沿用旧 shape 假设 + fixture 同步漂移），无绕路无过度修复。no-silent-drop 不变量在 direct/persisted/mixed 三条路径全部重建，fail-closed 边界清晰。`Map delta: none` 属实（无新架构原语，F003 delivery DTO 独立保持）。文档（spec 契约表 + bug-report）与实现一致。

[宪宪/布偶猫 · opus · deepseek-v4-flash🐾]
