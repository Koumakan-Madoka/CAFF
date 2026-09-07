# Native Runtime Agent Delegation

## Goal
Implement traceable in-room Agent delegation in CAFF using native runtime orchestration. Replace shell sleep and repeated read-context polling with durable delegation state, explicit non-blocking await/yield, deterministic terminal settlement, and requester continuation while preserving ordinary send-private and read-context behavior.

## Scope
- Add a dedicated durable delegation record and append-only lifecycle events. The record owns delegation_id, requester and recipient invocation identity, source trace/turn, request payload, commit/reference, idempotency key, deadline, state, result, error, and aggregation metadata.
- Add agent-tool creation and explicit await/yield contracts behind the existing authenticated tool bridge.
- Make recipient terminal outcomes (succeeded, failed, cancelled, timed_out) authoritative in the runtime, without requiring a recipient mention or completion tool call.
- Persist a structured completion payload and wake exactly the requester continuation associated with the delegation id.
- Reuse the existing Agent Session Reuse path for a continuation when its normal clean-success preconditions hold; a failed or timed-out continuation is terminal and must not be used as a polling mechanism.
- Support concurrent child delegations with an explicit aggregation contract. MVP supports `all`; the schema and validation reserve `any` and `quorum` for a later compatible extension and reject unsupported modes deterministically.
- Add cancellation propagation, deadline scanning, late-result handling, restart recovery, revision/hasChanges/pending delegation compatibility fields for read-context, and repeated unchanged-read short-circuiting with bounded guidance.
- Keep cross-conversation delivery as a separate feature. A2A is a future external adapter only, not the internal wire or storage contract.

## Non-Goals
- No A2A Agent Card, JSON-RPC, SSE wire format, or external adapter.
- No mid-run ReAct checkpoint/replay.
- No conversion of every ordinary send-private call into fire-and-forget.
- No removal or breaking change to ordinary send-private/read-context.
- No long-lived wait_for that retains a model/runtime slot.

## Canonical Contract
- Delegation states: `queued -> running -> succeeded|failed|cancelled|timed_out`; terminal states are absorbing. A recipient result arriving after timeout/cancel is recorded as a late event/result and cannot rewrite the terminal ruling.
- Aggregation: `all` is the first implementation. It reaches success only when every child succeeds; one failed/cancelled/timed_out child makes the group terminal with structured child outcomes. `any` and `quorum` are persisted as explicit modes but rejected at creation until implemented.
- Creation is idempotent on `(requester_invocation_id, idempotency_key)` and returns the existing delegation without duplicating child work.
- `await/yield` records a wait edge from the requester source run/turn to one delegation or an `all` group, closes the current trace successfully, and releases the model execution slot. It must not block a Promise or keep an active turn slot occupied.
- Runtime completion is keyed by exact `delegation_id`; it emits one completion event and schedules one requester continuation. Duplicate terminal attempts are no-ops with an audit event.
- Completion payload is structured JSON containing schemaVersion, delegationId, status, aggregation, child outcomes, result, error, terminalAt, and lateResultCount. Sensitive prompt/session data is excluded.
- Ordinary read-context continues to return recent public/private messages and participants. Its compatible additions are a monotonic revision, `hasChanges` relative to an invocation read cursor, and bounded pending delegation summaries. Repeated reads with unchanged revision are short-circuited and carry explicit yield guidance rather than pretending to wait.

## Acceptance Criteria
- [ ] Baseline investigation and canonical contract are recorded in task/spec documentation.
- [ ] A pre-fix regression demonstrates repeated unchanged read-context/伪等待 and missing structured return behavior.
- [ ] Durable schema/repository supports creation, idempotency, guarded transitions, events, deadline/cancel/recovery scans, and restart-safe terminal settlement.
- [ ] Recipient success, failure, cancellation, and timeout each produce one deterministic terminal delegation state without recipient mention.
- [ ] Explicit yield releases the active runtime slot and requester continuation receives the structured completion payload through session reuse when eligible.
- [ ] Concurrent `all` aggregation works; unsupported `any`/`quorum` are explicit and fail closed.
- [ ] Late results cannot overwrite terminal state and are observable.
- [ ] read-context revision/hasChanges/pending delegation and unchanged-read guard work without breaking normal callers.
- [ ] Existing send-private and read-context compatibility tests pass.
- [ ] Relevant tests, check, typecheck, build, and isolated manual verification pass; spec/ADR matches code.
- [ ] A fixed commit SHA receives an independent review with scope, risks, and author validation evidence.

## Technical Notes
- Follow existing SQLite repository + ChatAppStore transaction patterns and append-only task/delivery event conventions, but use a delegation-specific table/name rather than treating `a2a_tasks` or cross-conversation delivery as the canonical model.
- Integrate at the authenticated agent-tool bridge, routing executor, agent executor, runtime slot lifecycle, and server startup/recovery maintenance points.
- Preserve Agent Session Reuse cursor/hash/poison semantics. A yield is a clean current invocation boundary; continuation is a new queued execution associated with the exact delegation completion.
- Use bounded projections and real temporary SQLite fixtures in tests. Keep raw evidence under ignored `.tmp` and durable contracts under `.trellis/spec/` or `docs/`.
