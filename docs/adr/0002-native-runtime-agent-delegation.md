# ADR: Native Runtime Agent Delegation

## Status
Accepted for the first implementation slice. The executable current contract is
`.trellis/spec/runtime/agent-delegation.md`; this ADR records the architectural
choice and rationale.

## Context
CAFF Agents previously used ordinary private handoff and `read-context` as a practical way to coordinate. That left a caller with no durable task handle, no deterministic completion event, and no runtime control-flow boundary for waiting. Repeated context reads could therefore become pseudo-polling while retaining a model run slot.

## Decision
Use a dedicated in-room delegation model owned by the native runtime. The canonical record is `chat_agent_delegations`; append-only lifecycle evidence is `chat_agent_delegation_events`. The model is separate from cross-conversation delivery and from the historical `a2a_tasks` runtime task tables.

A delegation has a stable ID, requester/recipient invocation identity, source turn/run, request and reference, idempotency scope/key, aggregation, nullable legacy deadline, status, result/error, child IDs, and continuation marker. State transitions are guarded by SQLite `UPDATE ... WHERE status IN (...) RETURNING` statements. Terminal states are absorbing. A result after terminal settlement increments `late_result_count` and appends `late_result`; it cannot rewrite the terminal state.

The first supported aggregation is `all`. Group creation atomically creates one group and one child record per recipient. `any` and `quorum` remain reserved contract values and fail closed at creation until implemented.

The authenticated bridge exposes `create-delegation`, `await-delegation`, and `cancel-delegation`. Creation is idempotent by requester invocation plus idempotency key and enqueues recipient work with child delegation IDs. Recipient source messages persist `dispatchLane='side'` and their exact target, so main-lane queue recovery cannot replay delegated work. Await changes an active delegation to `awaiting`, schedules a runtime completion boundary, and returns without waiting on a Promise. A later invocation from the same requester Agent in the same conversation may inspect, await, or cancel that delegation; a different Agent or conversation receives the same not-found response as an unknown ID. `agent-executor` calls the runtime settlement path on recipient success/failure/cancellation. Parent completion is derived from child terminal states and emits a structured completion payload. The requester continuation is persisted as a normal user queue message and handed to the existing main-lane queue drain. A busy side slot therefore defers execution until the slot releases instead of losing a direct `409` attempt. Automatic session-goal continuation parks while the requester conversation has any pending delegation.

New delegations have no automatic deadline and remain pending until recipient settlement or explicit requester cancellation. The retired `deadlineSeconds` creation field is rejected rather than ignored. Historical rows that already have a non-null deadline retain deadline-maintenance behavior after restart. Requesters may cancel through the authenticated `cancel-delegation` bridge. The runtime first signals the orchestrator to cancel matching queued side-slot waiters and stop matching running side-slot handles, then absorbs the group and unfinished child records into `cancelled`; a recipient result that races or follows cancellation is recorded as a late result and cannot reopen the group.

`read-context` remains a message/participant projection. It now adds a per-invocation monotonic revision, `hasChanges`, `shortCircuited`, and bounded pending top-level delegation summaries for the same requester Agent and conversation. It is not a task wait primitive.

A2A wire protocol is explicitly out of scope. A future external adapter may translate this domain contract, but Agent Card, JSON-RPC, SSE wire format, and external task endpoints are not internal dependencies.

## Consequences
- Ordinary send-private and read-context remain compatible.
- Explicit cancellation settles durable records after restart; deadline scanning remains only for historical records that already carry a deadline.
- Continuation scheduling is durable and queue-backed: a busy target is left pending for the normal drain rather than treated as a lost `409`; exact delegation metadata prevents ordinary routing from confusing the continuation with a user message.
- Automatic session-goal continuation parks while a delegation for the same requester conversation is pending.
- Session reuse remains governed by its existing cursor/hash/poison rules. The continuation starts at a clean runtime boundary and can use a normal eligible reuse decision; it does not poison the recipient session on ordinary waiting.

## Validation Matrix
- Good: duplicate create returns the same delegation and creates no second recipient enqueue.
- Good: all child results settle one parent and one structured completion; a late result is observable without rewriting terminal state.
- Good: await returns `yielded=true` while pending and `yielded=false` with completion after terminal settlement.
- Bad: unsupported `any`/`quorum` request returns a deterministic unavailable error.
- Bad: recipient self-target or non-participant target is rejected.
- Bad: a cancelled delegation cannot be moved back to running or succeeded by a late child result; the same remains true for a historical delegation already settled by its deadline.
