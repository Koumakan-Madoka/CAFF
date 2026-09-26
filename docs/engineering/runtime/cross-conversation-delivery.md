# Cross-Conversation Delivery Lease And Recovery

Contract for `server/domain/conversation/cross-conversation-delivery.ts`,
`storage/chat/cross-conversation-delivery.repository.ts`, and the reply
metadata stamped by `server/domain/conversation/turn/agent-executor.ts`.

## Lease Model

- A delivery row is claimed atomically (`claimNext` / `claimById`) with
  `claim_owner`, `claim_expires_at` (now + `leaseMs`, default 30s), and a
  unique per-claim `claim_token` fencing token.
- The worker renews the lease from claim time until the flight fully ends:
  the heartbeat covers waiting for a target-room execution slot, the complete
  target turn, and response projection. Renewal interval defaults to
  `leaseMs / 3` (`leaseRenewIntervalMs`). The heartbeat is cleared in
  `finally` on every exit path (success, failure, cancel, claim loss).
- Worker lease, model execution timeout, and request `deadlineSeconds` are
  independent clocks. The lease only proves the worker is still maintaining
  the dispatch; it never extends or shortens the request response deadline.

## Fencing

- Every claim-guarded transition (renew, start, complete, release-for-retry,
  fail-before-start, unknown-outcome, running-cancel) requires both the
  owner and the exact claim token; recovery transitions additionally
  re-verify `claim_expires_at <= now` at update time so a renewal that lands
  after the sweeper's snapshot defeats the stale write.
- A worker whose transition is rejected because the claim moved on throws a
  `cross_conversation_claim_stale` fencing error and the flight ends with
  outcome `claim_lost`: it appends only an audit event and never rewrites
  delivery state owned by a newer claim.
- `claim_token` is a server-internal concurrency primitive; HTTP payloads and
  SSE broadcasts strip it.

## Outcome Semantics

- Pre-start failure with budget left: requeue (`retry_scheduled`); exhausted:
  terminal `failed`. These paths keep their original behavior.
- Invocation started, then the worker loses contact: the sweeper marks
  `failed` with `recovered_started_unknown_outcome`. This is terminal for the
  dispatch ledger but means "outcome unknown", not "target failed". Started
  invocations are never automatically replayed.
- Cancellation, request timeout, and execution outcome are ledgered
  separately; a cancelled or timed-out request keeps its own response state
  (`cancelled` / `timed_out`) and a later verified reply flips it to `late`
  without touching the dispatch state.

## Late-Result Recovery

`recoverPendingResponses` runs two strictly separated phases, each scanning
its candidate set with a bounded keyset-paginated cursor
(`recoveryScanPageSize`, default 100). Permanently unrecoverable records
(unknown outcome, no trusted evidence) stay in their set but can never block
later candidates behind a fixed window; cursors wrap around at the end of
the set and reset on restart, so recovery converges within one page turnover
per intervening record.

### Phase 1: outcome verification (request and notify)

Unknown-outcome dispatches (`failed` with `recovered_started_unknown_outcome`
or `dispatch_unknown_outcome` and a `targetInvocationId`) are matched against
the invocation's persisted terminal assistant message (completed OR failed).
The evidence is trusted only when its metadata matches BOTH
`crossConversationDeliveryId` and `crossConversationInvocationId` (the
delivery's `targetInvocationId`); missing or mismatched evidence keeps the
outcome unknown and the newest message in the target room is never used as a
guess.

- Completed evidence verifies completion: an atomic guarded transition moves
  `dispatch_status` to `completed` and clears the unknown-outcome error
  (`outcome_verified_completed` audit event; the original lease accident
  events stay in the append-only log). A request then projects its response
  idempotently in the same scan.
- Failed evidence verifies the failure: `dispatch_status` stays `failed`,
  `last_error_code` becomes the queryable `dispatch_failed_verified` with the
  invocation's error message (`outcome_verified_failed` audit event), and no
  response is projected.
- Verification guards require the unknown-outcome state and the exact
  invocation id, so verification is idempotent and can never rewrite a
  cancelled delivery or a delivery that failed for another reason.

### Phase 2: response projection (request)

Requests whose outcome is not in doubt (completed, cancelled, timed out) but
whose response has not been projected yet re-project from the persisted
reply. Unknown-outcome dispatches are excluded from this phase; they are
owned by phase 1 until verified. For completed dispatches the delivery-id
evidence is sufficient: the worker attested the result in-band.

`agent-executor` stamps `crossConversationDeliveryId` and
`crossConversationInvocationId` (the dispatch's tool invocation id) onto the
queued/streaming/final/failed assistant message metadata, so a reply or
failure that lands after a worker crash or a server restart remains
verifiable. Response projection is idempotent: the response delivery is keyed
by `reply_to_delivery_id`, so repeated scans project at most once and never
re-run the target model.

## Regression Anchors

- `tests/runtime/cross-conversation-delivery-lease.test.js`: controllable
  clock + delayed dispatcher covering multi-lease queue/run, stale-claim
  fencing, stale sweep snapshots, restart recovery with verified completion
  and verified failure for request and notify, wrong/missing invocation
  evidence, fair bounded scanning past unrecoverable records, and heartbeat
  cleanup.
- `tests/storage/cross-conversation-delivery-lease.test.js`: SQLite-level
  atomic conditions for claim tokens, renewal, stale-token transitions,
  expiry re-verification, outcome-verification guards, and keyset
  pagination.
