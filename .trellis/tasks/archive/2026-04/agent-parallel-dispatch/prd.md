# PRD: Agent Parallel Dispatch

## Background
- CAFF 原本同一 conversation 内只有一个 active run；当某个 agent 正在运行时，用户显式 `@` 另一个 agent 也会被 conversation 级队列阻塞。
- `E:\pythonproject\clowder-ai` 的 side-dispatch / per-agent invocation slot 思路可作为参考，但需要适配 CAFF 的运行时、队列和 UI 状态模型。

## Status Update
- 本任务最初以 research 为范围启动，先产出调研、风险清单和 implementation checklist。
- 在方案确认与 review 完成后，用户已批准进入实现阶段，本任务最终交付的是 **CAFF 版最小可行 agent 并行 v1**。

## Goal
- Phase 1：调研并产出 CAFF 版“真 agent 并行”的最小可行设计。
- Phase 2：在用户确认后实现最小 v1：当一个 agent 正在运行时，用户显式单 `@Agent` 且目标 agent 空闲，则允许旁路并发启动；目标 agent 忙碌时进入该 agent 的 slot queue。
- 核心目标：保留现有 main turn queue 语义，不一次性放开所有广播 / handoff / 多 mention 并发。

## Scope
- In scope:
  - 对比 CAFF conversation-level turn queue 与 clowder-ai per-agent invocation slot 的差异。
  - 实现最小 v1 行为：用户显式单 `@Agent` 且目标 agent 空闲时允许 side-dispatch；目标 agent 忙时继续排队。
  - 梳理并落地 orchestrator / routing executor / runtime bridge / API / UI active 状态的必要改造。
  - 明确并实现 prompt snapshot、消息可见性、stop/delete、trace/timeline、slot queue 的并发语义。
  - 输出实施清单、回归测试和 closeout 文档。
- Out of scope:
  - 不立即放开普通广播、无显式 `@`、多 mention、agent-to-agent handoff 的全量并发。
  - 不做数据库迁移或 UI 大改，除非后续阶段另行确认。

## Acceptance Criteria
- [x] 产出调研记录，说明 CAFF 当前阻塞点与 clowder-ai 可借鉴机制。
- [x] 给出并实现 CAFF 最小 v1：显式单 `@` 空闲 agent 可并发启动，忙碌 agent 仍排队。
- [x] 落地核心改造点：slot registry、slot-aware queue、runtime dispatch、API payload、前端 active slot 状态。
- [x] 覆盖关键风险：prompt 可见性、队列顺序、取消/停止、会话删除、trace/timeline 一致性。
- [x] 完成 review follow-up：补齐 direct main-turn gate、持久化 side-lane metadata、queued side stop、queued snapshot rehydrate。
- [x] 通过验证：`npm run build`、`npm run check`、`node tests/runtime/turn-orchestrator.test.js`、`node tests/smoke/server-smoke.test.js`。
