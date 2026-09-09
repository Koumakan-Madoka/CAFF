# Native Runtime Agent Delegation

## 1. Scope / Trigger

This contract applies to in-room Agent delegation created through the authenticated
agent-tool bridge. It covers durable delegation state, side-lane recipient
execution, explicit await/yield, cancellation, deadlines, requester continuation,
and compatible `read-context` projection.

Use this contract when changing any of:

- `server/domain/conversation/agent-delegation*.ts`
- `server/domain/runtime/agent-tool-bridge.ts`
- `server/domain/conversation/turn-orchestrator.ts`
- `server/domain/conversation/turn/agent-executor.ts`
- `storage/chat/agent-delegation.repository.ts`
- `lib/chat-app-store.ts` delegation methods
- `create-delegation`, `await-delegation`, or `cancel-delegation`

A2A and cross-conversation delivery are separate external/domain boundaries.
They are not the storage or execution contract for in-room delegation.

## 2. Signatures

### Bridge tools

```text
create-delegation {
  invocationId, callbackToken,
  recipientAgentIds: string[],
  content: string,
  idempotencyKey: string,
  aggregation?: "all" | "any" | "quorum",
  deadlineSeconds?: integer,
  reference?: string
}

await-delegation { invocationId, callbackToken, delegationId }
cancel-delegation { invocationId, callbackToken, delegationId, reason? }
```

`all` is implemented. `any` and `quorum` are reserved and return 501.

### Runtime and orchestrator

```text
createAgentDelegationRuntime({
  store,
  onCompletion?,
  onChanged?,
  onCancelRequested?
})

runtime.settleRecipient({ delegationId, status, result?, at? })
runtime.scanDeadlines(limit?)
runtime.cancel(delegationId, reason?)

turnOrchestrator.dispatchAgentDelegation({ delegation, childDelegations })
turnOrchestrator.requestStopAgentDelegation({
  requesterConversationId,
  childDelegationIds
}, reason?)
turnOrchestrator.enqueueDelegationContinuation(delegation)
```

### Store projections

```text
getAgentDelegation(id)
listAgentDelegationChildren(parentId)
listPendingAgentDelegationsForRequester(conversationId, agentId)
listPendingAgentDelegationsForConversation(conversationId)
listExpiredAgentDelegations(now, limit)
```

The requester projection returns pending top-level groups only. The conversation
projection may include groups and children because Goal parking must fail closed
while any child remains active.

## 3. Contracts

### Identity and authorization

- Creation idempotency is `(requesterInvocationId, idempotencyKey)`.
- Await, cancel, and pending projection authorize by the authenticated invocation's
  `(conversationId, agentId)` matching the persisted requester conversation and
  requester Agent.
- A continuation invocation from that same Agent may manage a delegation created
  by an earlier invocation. Other Agents and conversations receive 404, identical
  to an unknown delegation ID.

### Durable state

- Group/child states are `queued -> running|awaiting ->
  succeeded|failed|cancelled|timed_out`.
- Terminal states are absorbing SQLite CAS transitions.
- Recipient results after a terminal state append `late_result`, increment
  `late_result_count`, and cannot rewrite the ruling.
- `all` succeeds only when every child succeeds. Any failed, cancelled, or timed
  out child makes ordinary aggregation fail.
- An explicit requester cancellation makes the group `cancelled` and absorbs
  unfinished children into `cancelled`.
- Omitted deadlines use `DEFAULT_DELEGATION_DEADLINE_SECONDS=86400`, so restart
  maintenance can eventually settle every pending record.
- Deadline scan aggregates already-terminal children before applying timeout to
  a group.

### Execution and cancellation

- Each recipient source message persists `metadata.source='agent-delegation'`,
  the exact child `delegationId`, `privateOnly=true`, `dispatchLane='side'`, and
  `dispatchTargetAgentId`.
- The durable side-lane marker prevents main queue discovery and restart recovery
  from replaying recipient work as an ordinary user turn.
- Recipient terminal settlement is owned by `agent-executor`; it does not depend
  on a recipient mention or completion tool call.
- Cancellation calls `onCancelRequested` before record settlement. Server wiring
  routes it to `requestStopAgentDelegation`, which cancels matching queued slot
  waiters and sets `stopRequested` plus cancels handles for matching running slots.
- A recipient completion racing cancellation becomes a late result.

### Await/yield and continuation

- Await persists the wait edge and asks the current Agent invocation to complete
  cleanly. It does not retain a Promise or model slot.
- One terminal group consumes one `continuation_enqueued_at` CAS and creates one
  structured requester continuation message with `metadata.delegationId` and
  `metadata.initialAgentIds=[requesterAgentId]`.
- Continuation uses the persistent main queue plus `drainConversationQueue`.
  A busy side slot leaves the message queued instead of losing a direct 409.
- Session reuse remains governed by the normal clean-success cursor/hash/poison
  decision; delegation waiting is not a retry mechanism.
- Automatic Goal continuation parks while the conversation has pending delegation
  records.

### Read compatibility

- Ordinary `send-private` behavior is unchanged.
- `read-context` keeps public/private messages and participant fields and adds
  `revision`, `hasChanges`, `shortCircuited`, and bounded `pendingDelegations`.
- Revision is invocation-local and monotonic. An unchanged fingerprint returns
  `hasChanges=false` and `shortCircuited=true`; callers should yield rather than
  poll when pending work exists.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Duplicate create in one invocation | Same group and child IDs; no second dispatch |
| `any` or `quorum` creation | 501 deterministic unavailable error |
| Unknown, other-Agent, or other-conversation ID | 404 without disclosing ownership |
| Create then await then all children succeed | Group succeeds; one completion and continuation |
| Child fails/cancels/times out | Group terminal with structured child outcomes |
| Group deadline expires after children already settled | Aggregate children first; do not report false timeout |
| Requester cancels running and queued children | Running handles stop; queued waiters cancel; group is cancelled |
| Recipient completes after cancel/timeout | Late event/count only; terminal state unchanged |
| Recipient message reaches main queue discovery | Must be excluded by persisted `dispatchLane='side'` |
| Repeated unchanged read-context | Stable revision, `hasChanges=false`, short-circuit guidance |
| Requester continuation while a side slot is active | Durable message remains queued and drains after release |

## 5. Good / Base / Bad Cases

- Good: an Agent creates two child reviews, yields on the `all` group, both
  recipients settle through `agent-executor`, and exactly one structured
  continuation is routed back to the requester Agent.
- Good: a later requester invocation sees the still-pending group and cancels it;
  one running recipient is stopped and one queued recipient never starts.
- Base: no explicit deadline is supplied; the 24-hour default makes the record
  restart-visible and deadline maintenance eventually settles it.
- Bad: authorize await by exact requester invocation ID. The continuation cannot
  await or cancel work created before yield.
- Bad: persist delegation recipient messages without `dispatchLane='side'`.
  Main queue drain can execute the same delegated work a second time.
- Bad: mark only durable child records cancelled while leaving side-slot waiters
  and run handles alive. Capacity remains consumed and cancelled work continues.
- Bad: call `runConversationTurn` directly from recipient settlement. The child
  side slot is still active and the requester continuation hits the busy guard.

## 6. Tests Required

- `tests/runtime/agent-delegation.test.js`
  - creation idempotency returns stable group and child IDs
  - await plus child settlement produces one completion
  - same-Agent continuation authorization and other-Agent 404
  - cancel bridge response, group cancellation, and completion exactly once
  - default deadline, aggregation-before-timeout, late result, and read revision
- `tests/runtime/turn-orchestrator.test.js`
  - queue-backed continuation routes to the exact requester
  - cancellation stops a running child, removes a queued child, and starts no
    duplicate main-lane execution
  - pending delegation parks Goal continuation
- `tests/runtime/agent-tool-bridge.test.js` keeps ordinary bridge compatibility.
- `tests/runtime/agent-executor-hook.test.js` keeps terminal execution hooks and
  ordinary cancellation compatibility.
- Run `npm run check`, `npm run typecheck`, `npm run build`, focused suites, and
  `npm test` before freezing a review SHA.

## 7. Wrong vs Correct

### Wrong

```ts
if (delegation.requesterInvocationId !== context.invocationId) {
  throw notFound();
}
store.cancelAgentDelegation(delegation.id);
```

This makes post-yield management unreachable and leaves queued/running recipient
execution alive.

### Correct

```ts
assertRequester(delegation, context.conversationId, context.agentId);
onCancelRequested({
  requesterConversationId: delegation.requesterConversationId,
  childDelegationIds: delegation.children,
});
store.cancelAgentDelegation(delegation.id, error, at);
```

Authorization follows durable requester identity across invocations, and runtime
execution receives a stop signal before terminal record settlement.
