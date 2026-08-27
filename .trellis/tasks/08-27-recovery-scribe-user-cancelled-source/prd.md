# Recovery Scribe User-Cancelled Source Eligibility

## Goal

Allow a user to manually request Recovery Scribe for a trace that the same user
explicitly stopped, while preserving the existing failed-trace recovery
contract and every source-integrity, idle, configuration, idempotency, and
routing guard.

## Requirements

- Preserve the existing failed-source path: `message=failed`, `task=failed`,
  and either `run=failed` or the documented historical
  `run=succeeded + assistantErrors[]` compatibility case remain recoverable.
- Add one narrow user-cancelled source classification. It requires all of:
  - a public assistant message with `status=failed`;
  - `metadata.cancelled === true`;
  - `metadata.invocationFailure.kind === 'cancelled'` and
    `metadata.invocationFailure.eligible === false`;
  - the linked task has `status=cancelled`;
  - the linked run has the persisted user-cancellation terminal evidence used
    by the runtime (`status=failed`, `termination_type=cancelled`);
  - message, task, run, context snapshot, and session path associations agree.
- Treat ordinary success, queued cancellation, system/watchdog timeout,
  provider abort/error, missing evidence, and contradictory evidence as
  ineligible for the user-cancelled classification. Failed traces that satisfy
  the existing failed-source path remain recoverable even when their cause is a
  timeout or provider failure.
- Keep Recovery manual only. Do not trigger it from Stop, startup, failure
  settlement, or any background reconciliation path.
- Keep the source message, task, run, session, and cancellation metadata
  unchanged by recovery.
- Keep the durable recovery result as the existing non-routable
  `recovery_scribe` system actor message. It has no tools, cannot replay or
  continue work, and cannot route mentions, private messages, Goal, DAG, or
  cross-conversation delivery.
- Keep current idle/mutation, same-conversation, context snapshot, session
  file, duplicate/idempotency, enablement, model configuration, timeout,
  output validation, fallback, and restart projection gates unchanged.
- Project an explicit server-owned source kind for eligible capabilities so the
  UI can label the manual action `整理停止现场` for user-cancelled sources and
  `整理失败现场` for failed sources. Missing or unknown source kind fails closed.

## Non-Goals

- No automatic scribe invocation after Stop.
- No source status rewrite from failed/cancelled to completed or succeeded.
- No tool rollback, tool replay, task retry, turn continuation, or new Agent
  session.
- No broad acceptance of every cancelled task/run, provider abort, timeout,
  queued side dispatch, or prose containing cancellation words.
- No schema migration, production deployment, production configuration change,
  or change to Pi cancellation semantics.

## Cross-Layer Contract

Data flow:

`agent-executor persisted cancellation evidence -> message recovery source classifier -> shared capability/POST inspection -> bounded HTTP message projection -> timeline label -> existing durable no-tools scribe path`

The domain service is the only eligibility owner. HTTP passes the capability
through unchanged. The browser renders only server-approved capabilities and
never reconstructs cancellation eligibility from message metadata.

## Validation Matrix

| Source evidence | Expected result |
| --- | --- |
| Existing failed task + failed run | Recoverable as failed trace; label `整理失败现场` |
| Existing historical succeeded run + assistant errors | Recoverable as failed trace; label `整理失败现场` |
| Consistent user-stop message + cancelled task + cancelled run termination | Recoverable as user-cancelled trace; label `整理停止现场` |
| User-cancelled source after restart | Same capability and manual POST behavior; no auto-run |
| Ordinary completed message/task/run | Ineligible |
| Task cancelled but message cancellation metadata absent | Ineligible |
| Message cancelled but invocation failure absent/not cancelled/eligible | Ineligible |
| Run termination missing, timeout, provider error, or ordinary abort | Ineligible for user-cancelled classification |
| Queued task/side-dispatch cancellation without an assistant run | Ineligible |
| Any message/task/run/link/snapshot/session contradiction | Ineligible with the existing stable fail-closed reason family |
| Existing recovery row | Return canonical duplicate before transient revalidation; no second job |
| Recovery disabled or conversation busy | Existing 503/409 behavior unchanged |

## Acceptance Criteria

- [ ] A real SQLite fixture reproduces the current manual-stop projection and
      POST rejection `conversation_recovery_source_task_not_failed` before the
      production fix.
- [ ] Red tests cover the consistent user-stop success path, failed-source
      compatibility, and the complete negative matrix above.
- [ ] Projection and POST use one source classifier and return the same source
      kind/reason outcome.
- [ ] UI offers `整理停止现场` only for server-approved user-cancelled sources and
      preserves `整理失败现场` for failed traces.
- [ ] Recovery remains manual, no-tools, non-routable, idempotent, and leaves
      all source records unchanged.
- [ ] Focused runtime, HTTP, UI, storage, capsule, delivery/routing, restart,
      Stop, smoke, check, typecheck, build, and complete serial regressions pass
      or any unrelated baseline failures are recorded precisely.
- [ ] Backend/runtime/frontend/unit-test specs contain executable signatures,
      contracts, matrix entries, Good/Base/Bad cases, and test points.
- [ ] A frozen exact SHA receives independent commit-pinned approval.
- [ ] The exact reviewed SHA passes isolated manual Stop -> optional scribe ->
      restart acceptance with isolated port/SQLite/agentDir/logs/credentials and
      external delivery disabled; production 3100 remains untouched.

## Technical Notes

- Prefer a narrow source-kind classifier inside `inspectSourceIntegrity()` over
  weakening the existing task/run predicates independently.
- Match structured fields only. Do not match error prose such as `aborted` or
  `cancelled`.
- Reuse the existing durable recovery lifecycle and system actor; the source
  classification should affect eligibility/projection copy, not execution
  authority.
