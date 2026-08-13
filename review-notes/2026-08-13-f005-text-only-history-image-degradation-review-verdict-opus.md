---
title: F005 Text-Only Historical-Image Degradation — Review Verdict (opus)
feature_ids: [F005]
topics: [review, hotfix, image, multimodal, capability, degradation]
doc_kind: review_verdict
created: 2026-08-13
reviewer: 布偶猫/@opus
author: 缅因猫/@砚砚
review-target-id: f005-text-only-history-image-degradation
branch: fix/f005-text-only-history-image-degradation
reviewed-sha: c454fb1
product-sha: c454fb1
base: origin/main@3cdb7f1
verdict: APPROVED
---

# F005 Text-Only Historical-Image Degradation — Review Verdict

## Verdict

**APPROVED**（0 P1 / 0 P2 / 0 P3）— 覆盖当前 local head `c454fb1`，基线 `origin/main@3cdb7f1`。

修复目标：later text-only invocation 在可见历史含图时，从硬失败（`MODEL_NO_IMAGE_INPUT` block）降级为显式占位文本投影 + `images: []` + `block: null`，照常 `startRun`。当前发送的同步 preflight 422 契约保持不变。

## 独立 Quality Gate（在 `caff-acceptance-f005` worktree 独立重跑，非作者转述）

| 门禁 | 结果 |
|------|------|
| `npm run build`（tsc + copy-build-assets） | ✅ exit 0 |
| `node tests/runtime/image-invocation.test.js` | ✅ 11/11 |
| `node tests/runtime/agent-executor-hook.test.js` | ✅ 8/8 |
| `npm run typecheck`（typecheck + public 两 tsconfig） | ✅ exit 0 |
| `git diff --check origin/main..HEAD` | ✅ exit 0 |
| `npm test` 全量（fast + smoke） | ✅ exit 0 |
| `c454fb1` 改动范围 | ✅ 7 文件：image-invocation.ts + multimodal-projection.ts + 2 测试 + bug-report.md + Feature Doc amendment + review-request，无 public/ UI 变更 |

## 独立代码核验（非作者转述）

### 1. text-only 分支保留 canonical metadata，只替换 prompt-visible content

`projectMessagesWithImagePlaceholders`（multimodal-projection.ts:167-192）对含图 user 消息做 `{ ...message, content: ... }` spread——`metadata.contentBlocks` 原样保留，仅重写 prompt-visible `content`。回归测试断言 `projectedMessages[0].metadata.contentBlocks[1].imageId === 'i1'` 通过。✅

### 2. windowing 与 placeholder 顺序稳定

- 窗口：`slice(-maxMessages)`，`maxMessages` 默认 24，与 `buildProjectedHistoryText` / `projectMultimodalPrompt` 同窗；`image-invocation.ts:104` 的 `maxMessages` 解析默认值一致。✅
- 顺序：文本前缀保留，然后按 `imageBlocks` 数组序每图一个占位符（`contentParts.push(IMAGE_UNREADABLE_PLACEHOLDER)`）。测试覆盖 caption+单图、无 caption+双图 两种序列。✅

### 3. text-only 永不读字节、永不传图、preflight 不回归

- `!capability.supportsImage` 分支（image-invocation.ts:112-119）在 `readImage` 被调用前返回；回归测试用 `readImageCalls` 计数断言 **0 次 read**。✅
- `images: []`，`startRun` 照常调用（agent-executor-hook 测试改断言 `startRunCalled === true` + `capturedImages` deepEqual `[]` + prompt 含占位符）。✅
- `image-preflight.ts`（同步 422 契约）未被本 commit 触碰，diff 无相关改动。✅

### 4. vision / budget / missing-file / MIME 路径不变

本 commit 只改 text-only 分支 + 新增 helper + 测试 + 文档；`projectMultimodalPrompt`、`IMAGE_PROMPT_BUDGET_EXCEEDED`、`IMAGE_CONTENT_UNAVAILABLE`、MIME 校验分支均未改动。✅

### 5. agent-executor 消费接线核对

`imageBlock`（agent-executor.ts:1271）在 text-only 下为 `null` → 跳过 L1392 `if (imageBlock)` 失败分支 → 不写 failed reply、不计 `failedReplies`（测试断言 0）；`projectedConversationHistory`（L1273）非 null → agent-prompt.ts:576-577 `historyMessages = projectedMessages || messages` → `formatHistory` 渲染占位文本进 prompt。✅

### 6. 测试质量（Red→Green）

- RED 语义真实：旧行为返回 `MODEL_NO_IMAGE_INPUT` block + 不调 startRun，新断言（startRun=true、images=[], prompt 含占位符）在旧代码上必然失败。✅
- bug-report.md 完整记录根因（invocation 投影契约而非 persistence/adapter）、复现、Clowder 兼容性依据。✅

## 结论

修复精确命中根因：invocation 投影层把"历史含图"误判为"必须 vision"，降级为显式占位投影后正常 `startRun`，与 Clowder 兼容语义对齐。canonical 元数据保留、无字节读取、同步 preflight 与 vision/预算/完整性契约全部不变。`Map delta: update required` 属实（扩展既有 invocation projection 边界，无新 Store/Queue/Adapter）。**APPROVED**，可进 merge-gate（push 后创建 PR → E1-E5 → squash merge）。

[宪宪/布偶猫 · opus · deepseek-v4-flash🐾]
