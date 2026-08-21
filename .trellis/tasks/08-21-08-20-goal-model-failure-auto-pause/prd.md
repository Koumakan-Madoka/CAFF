# Goal Model Failure Auto Pause

## Goal

Prevent an active session Goal from exhausting its automatic continuation budget when the selected model/provider is failing immediately. The Goal Runner must persist a same-epoch failure streak and automatically pause after three qualifying model-invocation failures, while exposing a safe reason to the user and failing DAG goal-driven nodes closed to `blocked`.

## Confirmed Contract

- Count only Goal Runner automatic-continuation turns that produce zero completed replies and at least one structured model-invocation failure.
- A qualifying failure turn must finish within 60 seconds.
- The first and third qualifying failures in a streak must span no more than 5 minutes.
- The streak belongs to one Goal epoch and is persisted under `conversation.metadata.sessionGoalRunner`, so a service restart preserves progress.
- Any completed model reply, a normal user-authored main turn, or Goal `set`/`resume` resets the streak.
- User stop/cancel is neutral: it neither increments nor resets the streak.
- Tool/application errors and failures exceeding the 60-second threshold do not increment the streak.
- On the third qualifying failure, atomically pause the active Goal, set the runner status to `error_paused`, persist bounded structured failure context, and stop further automatic continuation without waiting for a proposal ruling.
- Resume starts a fresh Goal epoch for this guard and clears the failure streak.
- A DAG goal-driven child that reaches `error_paused` transitions from `doing` to `blocked` with a machine-readable failure reason, preserving D27/D28 worker/verifier authority for normal completion.
- SSE and the Goal UI show a concise human-readable auto-pause reason. Error detail must be single-line, clipped, redacted, and must not contain credentials, raw prompts, private messages, or stack traces.

## Failure Classification

- Preserve structured invocation failure metadata at the agent execution boundary rather than relying only on provider-specific text matching.
- Distinguish at least `provider`, `timeout`, `process_exit`, `cancelled`, and `unknown` failure kinds.
- A Goal streak increment requires a model-invocation classification eligible for this guard; cancellation and tool/application failures are ineligible.
- Existing timeout termination types remain authoritative. Long-running watchdog failures are excluded by the 60-second duration threshold.

## Persistence Contract

`sessionGoalRunner` gains a bounded failure-streak projection tied to `goalUpdatedAt`, including:

- consecutive qualifying failure count;
- streak start and last failure timestamps;
- last structured failure kind/code;
- safe last-error summary;
- `error_paused` status and pause timestamp when the threshold is reached.

Normalization must tolerate absent, legacy, malformed, or stale-epoch metadata. Stale-epoch streak data must never affect the current Goal.

## UI And Events

- Reuse existing Goal update/SSE refresh paths where possible.
- The Goal panel and compact Goal status must distinguish an automatic model-failure pause from a manual pause.
- The user must be able to Resume through the existing Goal controls; Resume clears the streak before any continuation is scheduled.
- No new provider credentials, raw provider payloads, or full error bodies are exposed through SSE or browser state.

## DAG Contract

- The scheduler observes the durable `error_paused` Goal/runner state in event handling and startup reconcile.
- A current bound `doing` child becomes `blocked` with a dedicated reason such as `dag_goal_model_failure_paused`.
- This system transition must not fabricate a worker completion proposal, verifier ruling, or successful node result.
- Normal D27 completion and D28 worker/verifier authorization remain unchanged.

## Non-Goals

- Do not automatically switch provider or model.
- Do not automatically resume after a cooldown or health probe.
- Do not change the existing 20-turn total continuation budget.
- Do not classify a single failure as sufficient to pause.
- Do not pause on ordinary tool errors, user cancellation, or non-Goal user turns.
- Do not introduce a new external API for provider health.

## Acceptance Criteria

- [ ] Three qualifying failures, each no longer than 60 seconds and within a 5-minute total streak window, directly pause the Goal on the third failure and prevent a fourth continuation.
- [ ] Two failures followed by a completed reply reset the streak; the next qualifying failure records count 1.
- [ ] A normal user-authored turn, Goal set, or Goal resume clears the streak; user cancellation is neutral.
- [ ] A slow failure, tool/application error, or user cancellation does not increment the streak.
- [ ] A persisted streak of two survives a fresh store/orchestrator instance and pauses on the next qualifying failure in the same Goal epoch.
- [ ] Stale or malformed runner metadata cannot pause a newer Goal epoch.
- [ ] SSE/UI display a safe auto-pause reason and Resume clears the visible streak state.
- [ ] A DAG-bound goal-driven child enters `blocked` on `error_paused`, including restart reconciliation, without bypassing D27/D28.
- [ ] Existing Goal budget proposal, manual lifecycle, queue, and DAG completion tests remain green.
- [ ] `npm run check`, `npm run typecheck`, `npm run build`, targeted tests, and cross-layer checks pass.

## Expected Evidence

- Red tests first for qualifying streak, reset rules, restart persistence, direct pause, and DAG blocked behavior.
- Targeted runtime/domain/UI/DAG suites pass after implementation.
- Commit-pinned independent review approves the exact candidate SHA.
- Isolated preview demonstrates the visible pause reason and successful Resume reset before user acceptance.
