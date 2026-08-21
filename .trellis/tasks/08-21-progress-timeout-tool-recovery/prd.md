---
feature_ids: [progress-timeout-tool-recovery]
topics: [runtime, watchdog, tools, recovery, ipc, cancellation]
doc_kind: prd
created: 2026-08-21
branch: room/c2fab452-caff-bug-bug
---

# One-Shot Progress-Timeout Tool Recovery

## Goal

When the useful-progress watchdog expires while Pi has a confirmed active tool call, abort the stuck tool without discarding the Pi session, wait for the current agent loop to settle, and inject one bounded recovery instruction into the same session. A recovery failure or any later progress timeout fails closed, while cancellation, provider errors, process exits, Goal failure streaks, expected completion, and digest fallback retain their existing authority.

## Confirmed Contract

- Recovery is opt-in per `startRun` caller and is enabled only by the conversation agent executor. Digest and other model consumers retain the current hard-timeout behavior.
- A progress timeout is recoverable only when the runtime has observed `tool_execution_start` for at least one tool call whose matching `tool_execution_end` has not arrived.
- At most one recovery attempt is allowed per Pi run. The absolute run timeout is not reset or extended.
- The host aborts the active agent loop, waits until the same session is truly idle, then prompts that same session. It must not spawn a replacement host or create a new Pi session.
- The host accepts recovery only while the original turn is still in flight. A request arriving after the turn has settled is rejected or ignored without injecting a phantom prompt.
- The recovery prompt is generic and bounded. It may include the active tool name, but never tool arguments, command text, credentials, paths, private messages, or raw provider payloads.
- The prompt tells the model that the prior tool was stopped by the progress watchdog, forbids blindly repeating the same broad operation, asks for a short bounded preflight or connectivity check, and requires asking the user when an external prerequisite is missing.
- A second progress timeout, recovery IPC delivery failure, host recovery failure, missing acknowledgement, or inability to settle and re-prompt terminates with `progress_timeout` and bounded recovery-attempt context.
- User cancellation, heartbeat timeout, absolute run timeout, parent shutdown, provider/model error, signal, and nonzero process exit remain fail-closed and authoritative. Recovery must not overwrite their termination classification.
- `stopReason='aborted'` is not a successful terminal assistant message and must not trigger expected-completion shutdown during recovery.
- Recovery lifecycle is observable through structured runtime and task events without marking the agent stage terminal while recovery is in progress.

## Progress Definition

`PI_PROGRESS_TIMEOUT_MS` remains a sliding no-event watchdog. Model and tool `pi_event` messages refresh it; host heartbeat does not. Long downloads that emit tool updates continue normally. A process that transfers bytes but emits no observable Pi event for the configured interval is considered stalled.

## Runtime And IPC Contract

Parent to host:

- `recover`: includes a bounded reason, attempt number, and optional tool name. It excludes tool arguments and raw command content.

Host to parent:

- `recovery_started`: confirms the original loop was aborted and settled and the recovery prompt was accepted by the same session.
- `recovery_failed`: reports a bounded safe failure reason and attempt number.

Runtime state:

- Track active tool calls by `toolCallId` from `tool_execution_start` through `tool_execution_end`.
- Track whether recovery is enabled, requested, acknowledged, and consumed.
- Preserve `runId` and `sessionPath` across recovery.
- Persist the final run as succeeded only after a genuine terminal completion; persist fail-closed outcomes with the existing authoritative termination type.

## Validation Matrix

| Case | Active tool | Recovery used | Expected outcome |
| --- | --- | --- | --- |
| Good: first silent tool stall | yes | no | abort tool, settle, prompt same session, continue |
| Good: recovered run completes | any | yes | normal success and expected completion |
| Base: slow model/no active tool | no | no | existing `progress_timeout` termination |
| Bad: second silent stall | yes | yes | fail closed as `progress_timeout` |
| Bad: recovery delivery/host failure | yes | requested | fail closed as `progress_timeout` |
| Cancel race | any | any | `cancelled` remains authoritative |
| Provider error after recovery | any | yes | structured provider failure remains authoritative |
| Heartbeat/absolute timeout or process exit | any | any | existing terminal reason remains authoritative |
| Digest timeout | irrelevant | disabled | existing timeout catch and extractive fallback; no recovery prompt |
| Idle-window recovery request | no turn in flight | any | no prompt and no phantom assistant reply |

## Observability

- Emit structured recovery-requested and recovery-started events through the existing runtime event stream.
- Project those events through the executor/task-event path using bounded user-safe summaries.
- Do not expose tool arguments or the recovery prompt through SSE.
- A final fail-closed timeout continues to produce the existing structured invocation failure kind `timeout`; recovery metadata may distinguish `recoveryAttempt=1` without making Goal auto-pause count a slow watchdog failure.

## Non-Goals

- Do not increase or disable the default 10-minute progress watchdog.
- Do not change individual tool timeouts, including a model-selected 20-minute command limit.
- Do not hard-code Docker, VPN, registry, package-manager, or network-provider behavior.
- Do not synthesize progress events from process liveness, CPU usage, file size, or network throughput.
- Do not retry a tool automatically without model reasoning.
- Do not recover pure model stalls, unknown runtime stalls, heartbeat failures, absolute timeouts, provider errors, or process exits.
- Do not respawn Pi or migrate the turn to a new session.
- Do not alter Goal continuation thresholds or digest output contracts.

## Acceptance Criteria

- [x] A fake SDK host that starts a tool and then goes silent receives exactly one recovery request; the tool is aborted, the loop settles before the new prompt, the same session continues, and the run succeeds.
- [x] A progress timeout without an active tool sends no recovery IPC and terminates exactly as before.
- [x] A second progress timeout after recovery fails closed with one recorded recovery attempt and a structured timeout classification.
- [x] A host recovery failure or disconnected IPC channel fails closed without hanging.
- [x] A user Stop racing with recovery remains `cancelled`; no late recovery prompt or `recovery_failed` noise changes the final result.
- [x] A recovery request after the initial turn is idle cannot create a phantom turn.
- [x] An aborted assistant message cannot trigger expected completion; a genuine recovered terminal message can.
- [x] Provider error, signal, nonzero exit, heartbeat timeout, and absolute timeout retain their current precedence and structured metadata.
- [x] Digest model calls never opt into recovery and still reach the existing extractive fallback on timeout/provider failure.
- [x] Goal automatic model-failure streak behavior is unchanged; recovered success records no failure, and a slow fail-closed progress timeout is ineligible for the fast-failure streak.
- [x] Recovery task/SSE events are bounded and contain no tool arguments, command payload, credentials, private text, or raw provider response.
- [x] Existing normal completion, cancellation, runtime, executor, digest, Goal, and DAG regression suites remain green.
- [x] `npm run check`, `npm run typecheck`, `npm run build`, targeted tests, cross-layer checks, and `git diff --check` pass.

## Expected Evidence

- Red tests first for active-tool recovery, no-tool termination, abort-to-prompt settling, idle-window rejection, cancellation race, second stall, expected-completion filtering, and digest opt-out.
- Targeted runtime host, parent runtime, executor, digest, Goal, and UI/event tests pass after implementation.
- Runtime spec documents option signatures, IPC fields, lifecycle state transitions, precedence/error matrix, privacy constraints, and named test points.
- The exact candidate commit receives commit-pinned independent review.
- An isolated acceptance instance demonstrates a synthetic silent tool stall, one visible recovery, bounded continuation, fail-closed repeat behavior, and user cancellation before user acceptance.
