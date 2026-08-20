# 修复正常完成误报会话失败与错误摘要

## Goal
修复模型已经正常完成回复后，Pi SDK 收尾中止写入的 `stop=aborted` / `Request was aborted.` 被工具轨迹误判为会话失败的问题，并让前端失败窄条优先显示可操作的真实错误摘要。

## Requirements
- 正常完成的 assistant 消息与 succeeded task 不因 session JSONL 尾部的 abort 噪声显示失败。
- 保留用户主动停止、watchdog 超时、任务失败、消息失败、模型真实 error、失败工具步骤的失败语义。
- 失败上下文详情仍保留经过脱敏的诊断元数据，但首屏摘要不得以消息/任务 UUID、status、created、run、provider/model/stop 元数据开头。
- 首屏摘要优先级：失败步骤错误 > task error > assistant/session error > 明确消息失败兜底。
- 不迁移或清理历史会话数据。

## Cross-layer Contract
- Source: Pi session JSONL may contain multiple assistant messages, including a terminal success followed by an SDK-abort error emitted solely during `expected_completion` cleanup.
- Backend projection: failureContext must judge authoritative persisted message/task terminal state before treating session-only abort text as failure.
- UI projection: failureContext exposes a concise `summary` separately from full redacted `text`; UI uses `summary` for the collapsed note and `text` for copy/detail.

## Validation and Error Matrix
| Case | Expected |
| --- | --- |
| message=completed, task=succeeded, trailing session error=`Request was aborted.` | no failureContext |
| message=completed, task=succeeded, trailing unrelated model error | session failure remains visible |
| task=failed with task error | failureContext source=task; concise summary is task error |
| failed tool step with error | source=step; concise summary is step/tool error |
| message=failed without detailed error | message failure fallback remains visible |
| user cancel or watchdog timeout persisted as failed task/message | remains failed |

## Acceptance Criteria
- [ ] Regression test first reproduces completed/succeeded + trailing abort noise as false failure.
- [ ] Backend targeted tests prove false failure is removed and true failures remain.
- [ ] Frontend test proves collapsed failure note uses concise summary rather than full metadata context.
- [ ] `npm run check`, `npm run build`, `npm run typecheck`, and applicable targeted tests pass.
- [ ] Independent review confirms failure boundaries and regression coverage.

## Non-goals
- Do not change intentional user cancellation, watchdog timeout, or true provider/model error semantics.
- Do not delete or rewrite existing JSONL sessions.
- Do not redesign the tool timeline UI.
