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

- `recoverPendingResponses` re-projects replies for completed dispatches
  whose projection failed (delivery-id evidence is sufficient: the worker
  attested the result in-band) and for unknown-outcome dispatches.
- For `failed` (unknown-outcome) dispatches the reply is accepted only when
  its persisted metadata matches BOTH `crossConversationDeliveryId` and
  `crossConversationInvocationId` (the delivery's `targetInvocationId`).
  Missing or mismatched evidence keeps the outcome unknown; the newest
  message in the target room is never used as a guess.
- `agent-executor` stamps `crossConversationDeliveryId` and
  `crossConversationInvocationId` (the dispatch's tool invocation id) onto
  the queued/streaming/final/failed assistant message metadata, so a reply
  that lands after a worker crash or a server restart remains verifiable.
- Recovery is idempotent: the response delivery is keyed by
  `reply_to_delivery_id`, so repeated scans project at most once and never
  re-run the target model.

## Regression Anchors

- `tests/runtime/cross-conversation-delivery-lease.test.js`: controllable
  clock + delayed dispatcher covering multi-lease queue/run, stale-claim
  fencing, stale sweep snapshots, restart recovery with verified/wrong/
  missing invocation evidence, and heartbeat cleanup.
- `tests/storage/cross-conversation-delivery-lease.test.js`: SQLite-level
  atomic conditions for claim tokens, renewal, stale-token transitions, and
  expiry re-verification.
