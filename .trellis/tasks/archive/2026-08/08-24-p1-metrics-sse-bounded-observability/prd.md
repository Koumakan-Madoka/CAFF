# P1: Bounded HTTP Metrics, SSE Backpressure, Runtime Observability

## Goal

Eliminate the two remaining request-driven Node OOM risk classes on the latest `origin/develop` baseline (b872954) and add lightweight runtime observability, per the frozen OOM remediation plan a9f9eec (P1A + P1B + observability counters).

## Contract Sources

- Frozen plan: `.trellis/tasks/08-24-develop-oom-remediation-plan/remediation-plan.md` sections P1A (Bound Agent Metrics), P1B (SSE Backpressure), Synthetic Production-Shape Dataset, Performance Acceptance Matrix.
- Confirmed baseline gaps (reproduced on b872954):
  - `server/api/metrics-controller.ts:48-63` passes empty `since`/`until` through; `server/domain/metrics/agent-eval-report.ts:143-160` materializes all matching `chat_messages` rows (including `metadata_json`) for the whole call, then all matching `a2a_task_events`; unbounded single request.
  - `server/http/sse-bus.ts` `writeEvent` ignores `res.write() === false` (6 unchecked writes); no `writableLength` accounting, no queue, no drain deadline anywhere.
  - No `process.memoryUsage` logging and no exposed turn/queue/invocation/SSE-buffer counters.

## P1A: Bound Agent Metrics

- `/api/metrics/agent` requires both `since` and `until`; inclusive date window <= 31 days; missing, one-sided, reversed, or oversized ranges return 400 with a stable error code/message.
- `public/metrics.js` initializes both controls to the last seven complete days and always sends them; the report echoes effective boundaries.
- The dual-boundary HTTP requirement is an intentional compatibility break; update browser and smoke consumers in the same change; no silent server default window.
- `scripts/agent-eval-report.js` (offline CLI) retains explicit unbounded mode.
- Query plan: first patch enforces the HTTP window and selects only metadata fields actually used; follow-up moves extraction to SQL aggregation / bounded projections where available; preserve the missing `a2a_task_events` fallback and exact aggregate semantics.

## P1B: SSE Backpressure

- Per-client combined budget: queued FIFO frame bytes + `res.writableLength` <= 2 MiB, checked before every direct write or enqueue; a single frame > 2 MiB removes the client before that frame is written.
- `res.write(frame) === false` marks the client blocked and arms a 5-second drain deadline; each new blocked episode re-arms the deadline; clear timers on drain/close/error/removal.
- On `drain`, flush FIFO in order until empty or another `false`; never re-enqueue a frame Node already accepted; FIFO order preserved, no duplicates.
- Remove and end/destroy only on budget exceed, deadline expiry, or close/error; prelude, initial events, normal events, and keepalives share the same accounting.
- Browser recovery: only after an errored stream successfully reopens (not initial open), coalesce one `refreshAll(selectedConversationId)`; in-flight repeats do not start parallel refreshes; no Last-Event-ID, no replay, no at-least-once claims; existing 1.5s manual reconnect delay preserved.
- Bounded diagnostics: active clients, backpressured clients, disconnects by byte-budget/timeout reason, queued frame bytes, aggregate writableLength; no payload logging.

## Runtime Observability

- Lightweight counters: heap/RSS (periodic `process.memoryUsage()`), active turns/queues/invocations, SSE clients/queued/writable bytes.
- Counters must have correct lifecycle (register/unregister, zero after cleanup) and negligible overhead.

## Non-Goals

- No P2 work (goal/turn targeted queries, prompt window projection, `modelUsage.calls` cap, context snapshot table).
- No production data/config/process changes; no heap limit increase; no production heap snapshots.
- No merge to develop before user acceptance.

## Acceptance Evidence

- Red tests first: HTTP metrics missing/one-sided/>31-day windows return 400 (red on baseline: currently 200 unbounded); SSE backpressure tests fail on baseline (writes ignored, no budget); no-retention test for unbounded raw rows.
- Production-shape synthetic gates: bounded 31-day metrics peak RSS delta <=512 MiB; healthy SSE burst (6 x 256 KiB) drains in order and stays connected; blocked SSE (10,000 x 256 KiB) dropped at 2 MiB/5s with peak RSS delta <=64 MiB and no writes after removal; 100 connect/close cycles leave zero clients/queues/listeners/timers; concurrent metrics+SSE and long Goal workload stability.
- System Node v24: check/typecheck/build, focused tests, smoke; secret scan, diff check, SQLite integrity.
- Independent commit-pinned architecture/code review; isolated acceptance instance; user confirmation before merge.

## Rollback

- Single revert of the P1 commit(s) on develop restores prior behavior; no schema or data migrations.
