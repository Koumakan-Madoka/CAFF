---
title: F005 PR #68 Active-Turn Cleanup Repair — Fallback Review Verdict (opus)
feature_ids: [F005]
topics: [review, hotfix, image-only, active-turn, cleanup, fallback-review]
doc_kind: review_verdict
created: 2026-08-12
reviewer: 布偶猫/@opus
author: 缅因猫/@砚砚
review-target-id: f005-image-only-runtime-routing
branch: fix/f005-image-only-runtime-routing
reviewed-sha: ed23ccb
product-sha: fc0c8d2
base: origin/main@fd1da04
verdict: APPROVED
---

# F005 PR #68 Active-Turn Cleanup Repair — Fallback Review Verdict

## Verdict

**APPROVED**（0 P1 / 0 P2 / 0 P3）— 完整 fallback review，覆盖修复后当前 head。

独立核验目标：PR #68 最终 head `ed23ccb`（product repair `fc0c8d2`，之后仅 review-request 文档），基线 `fd1da04`。这是对云端 P2 修复的完整 fallback 审查，非旧 `fa0d1545` verdict 的延续。

## 独立 Quality Gate（在 `caff-acceptance-f005-completion` worktree 重跑，非作者转述）

| 门禁 | 结果 |
|------|------|
| 聚焦回归（IMAGE_NOT_STAGED → active 释放 → 立即重试） | ✅ 独立运行 pass |
| `turn-orchestrator.test.js` | ✅ 74/74 |
| `tests/runtime/*.test.js` 全套件 | ✅ 394/394 |
| `tsc -p tsconfig.typecheck.json` | ✅ exit 0 |
| `npm run check` | ✅ exit 0 |
| `git diff --check fd1da04..ed23ccb` | ✅ exit 0 |
| `fc0c8d2` 改动范围 | ✅ 仅 3 文件：routing-executor.ts + turn-orchestrator.test.js + bug-report.md，无 public/ UI 变更 |

## 独立代码核验（非作者转述）

### 1. 根因确认属实

`routing-executor.ts:238-241` 在 `activeConversationIds.add` / `activeTurns.set` 之后、主 lifecycle `try`（line 343）开始之前，调用 `store.createMessage()`（243-262）。若 store-owned 图片校验/attach 抛错，原代码无任何 cleanup 路径，该 conversation 永久 409。**P2 真实存在，修复必要。**

### 2. 修复正确性

`fc0c8d2` 在 createMessage 外包局部 try/catch：

- 失败时 `cleanupActiveTurn()`（256）→ 复用既有幂等 cleanup（`cleanedUp` guard, 224-228），删除 `activeConversationIds` + `activeTurns`，clear runHandles，广播 `runtime_state`
- `runStore.close()`（257）→ 关闭尚未进入主 lifecycle 的 run store
- `throw error`（258）→ 保留原始错误（如 `IMAGE_NOT_STAGED`），不合成 failed turn（agent 执行未开始，符合请求信 Tradeoff）

### 3. Cleanup 幂等 + 双 close 安全性

- catch 调 `cleanupActiveTurn()` 后，finally（800-803）再调：`cleanedUp` guard 保证第二次直接 return，无重复广播
- catch 调 `runStore.close()` 后 finally 再调：实测 better-sqlite3 ^12.8.0 双 close 不抛（`DOUBLE CLOSE OK`），且 `SqliteRunStore.close()` 有 `ownsDb` guard（sqlite-store.ts:321-325）。回归测试 `assert.rejects(... /IMAGE_NOT_STAGED/)` 通过即证明 finally 的二次 close 未覆盖原始错误

### 4. 正常路径不变

- `usesExistingBatch`（persisted batch）分支不经过此 try/catch，不触碰
- queue/parallel/stop/agent-executor 逻辑全部在主 try 内（343+），未被修改
- `fc0c8d2..ed23ccb` 仅 review-request 文档，无产品代码

### 5. UI 状态恢复

失败路径通过 `broadcastRuntimeState()` 完整替换 `state.runtime`（public/app.js:3694-3719 `runtime_state` handler），active turn 卡片清除、input 恢复。`turn_finished` 事件缺失不影响恢复：`stopRequestConversationIds` 有 runtime_state 兜底清理（3700-3713）、消息未落库无需 `refreshConversationFromEvent`。对称性差异，非阻塞。

### 6. 测试质量

- RED 语义：store mock 在 `imageIds` 非空时抛 `IMAGE_NOT_STAGED`，断言 `activeConversationIds.has === false` + `activeTurns.has === false`，随后同 conversation 立即 text retry 成功 1 reply——精确覆盖 "修复前永久 409" 的回归
- bug-report.md 完整记录 RED/GREEN 证据链（74/74、门禁全过），诊断 Capsule 字段齐全

## 结论

修复精确命中云端 P2 根因（createMessage 在主 lifecycle 之外 + 无 cleanup），无绕路、无过度修复。cleanup 幂等、双 close 安全、正常路径零改动、UI 恢复完整，全部独立验证通过。`Map delta: none` 属实。**APPROVED**，可进 merge-gate（E1-E5 + Feature Doc Truth + CI）。

[宪宪/布偶猫 · opus · deepseek-v4-flash🐾]
