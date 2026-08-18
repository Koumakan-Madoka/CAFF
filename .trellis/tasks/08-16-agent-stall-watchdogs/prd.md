---
feature_ids: [agent-stall-watchdogs]
topics: [runtime, watchdog, feishu, tests]
doc_kind: prd
created: 2026-08-16
branch: fix/agent-stall-watchdogs
---

# Fix agent stalls caused by live handles and false heartbeats

## Goal

Prevent conversation runs from remaining in `running` forever when a tool or integration handle stops making useful progress while the pi host still emits heartbeats.

## Requirements

- Isolate smoke tests from production Feishu long-connection environment values.
- Make Feishu long-connection shutdown await an in-flight SDK start and release the client again after that start settles.
- Separate host liveness, useful-progress, and total-run watchdogs.
- Persist configured progress and total timeout values in run records.
- Keep timeout termination observable through distinct reason types.

## Acceptance Criteria

- [x] Repeated host heartbeats do not extend the useful-progress deadline.
- [x] Genuine pi events refresh the progress deadline but do not extend the total deadline.
- [x] Feishu `stop()` waits for a pending `start()` and closes the SDK client after settlement.
- [x] `createServerApp.close()` waits for Feishu shutdown before invoking its callback.
- [x] In-process server tests cannot inherit production Feishu credentials or mode.
- [x] Targeted runtime tests, smoke tests, build, check, typecheck, and `test:fast` pass.

## Runtime Contract

- `heartbeatTimeoutMs` / `PI_HEARTBEAT_TIMEOUT_MS`: host-process liveness only.
- `progressTimeoutMs` or legacy `idleTimeoutMs` / `PI_PROGRESS_TIMEOUT_MS` or legacy `PI_IDLE_TIMEOUT_MS`: useful model/tool progress deadline; default 10 minutes.
- `timeoutMs` / `PI_TIMEOUT_MS`: total run deadline; default 60 minutes.
- A heartbeat refreshes only the heartbeat watchdog. A structured `pi_event` refreshes both heartbeat and progress watchdogs. No event refreshes the total watchdog.

## Validation Matrix

| Case | Expected |
| --- | --- |
| Heartbeats continue, no `pi_event` | terminate with `progress_timeout` |
| `pi_event` continues past total deadline | terminate with `run_timeout` |
| Host goes silent first | terminate with `heartbeat_timeout` |
| Feishu start settles after stop begins | client is force-closed again and stop resolves |
