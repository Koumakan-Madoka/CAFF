# 有界实时观测时间线

## Goal

统一聊天观测时间线的存储、历史投影、HTTP/SSE 传输和浏览器合并。模型调用与工具执行合并后总计最多保留 16 条，固定保留第 1 条与最新 15 条；运行中的新模型调用和工具状态通过轻量 SSE 持续出现，展开只读取一次权威 detail 快照。

## Non-Goals

- 不删除或改写 session JSONL、`a2a_task_events` 等审计证据。
- 不批量重写既有 SQLite 明细行；历史数据在读取和投影时收敛。
- 不恢复定时轮询，不为每个 SSE 事件重新请求完整 tool-trace。
- 不从保留的 16 条事件反推完整模型调用、工具执行、token、费用或 provider miss 聚合。
- 不改变模型调用、工具执行、重试、路由或消息终态语义。

## Data Flow

```text
Pi message_end / tool lifecycle / bridge tool event
  -> normalized observability event with stable identity and sequence
  -> bounded first-1 + latest-15 projection
  -> future detail persistence + lightweight live SSE
  -> browser incremental upsert + same bounded projection
  -> one initial GET snapshot for expansion
  -> terminal state converges to the same retained events and full aggregates
```

Historical messages without future detail use the existing session/task evidence path once, then the HTTP response is bounded before transport. Original audit rows remain intact.

## Timeline Contract

- Maximum retained events: 16 total across `model_call` and `tool_execution`.
- Retention: first event plus latest 15 events, preserving chronological order and original sequence values.
- Every event exposes a stable `eventId`, typed `eventType`, and positive `timelineSequence`. Updates to a running tool reuse its identity and sequence.
- Projection exposes `totalEventCount`, `retainedEventCount`, `droppedEventCount`, and `truncated` independently from retained rows.
- Full-run aggregates remain authoritative: model-call counts, cold/post-cold counts, provider misses, tool-execution counts, failures, duration, token usage and cost are never recomputed from retained events.
- Model-call SSE contains only normalized usage, stop reason, stable identifiers, and aggregate/window counters. It never contains prompt text, assistant text, thinking content, raw provider payloads, tool arguments, credentials or session paths.
- Tool SSE keeps the existing bounded/redacted step projection and gains the same stable timeline identity/sequence semantics.

## Acceptance Evidence

- Baseline red tests prove more than 16 mixed events escape the current tool-trace response and no model-call SSE is emitted after a long-running `message_end`.
- Storage writes retain at most 16 relevant rows/events; historical detail reads and session projections converge without database backfill.
- The browser performs at most one detail GET per expanded message snapshot and applies later SSE events without polling.
- Five concurrent Agents with more than 64 events each retain at most 16 visible rows per message while newest events continue to appear.
- UI shows full totals and `中间省略 N 条`; 1440x900 and 375x812 have no horizontal overflow or incoherent overlap.
- Target and adjacent tests, check, typecheck, build and independent exact-SHA review pass.
