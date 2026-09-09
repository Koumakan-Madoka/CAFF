# Research Notes

## Baseline
- Room branch: `room/cda46b1b-caff-agent-delegation`
- Baseline commit: `bb13875b74d481d1892a515984680ca0a191674b`
- Room build was generated from this commit using `npm run build` with the existing repository dependency tree.
- Red command: `node tests/runtime/agent-delegation.test.js`
- Red evidence: `read-context` has no integer `revision` on the first read, and the authenticated bridge exposes neither `handleCreateDelegation` nor `handleAwaitDelegation`.

## Existing Patterns
- `server/domain/runtime/agent-tool-bridge.ts`
  - `createInvocationContext` retains invocation, conversation, turn, stage, run store and enqueue context in an authenticated in-memory map.
  - `handlePostMessage` owns ordinary `send-public` and `send-private`; private handoff directly calls `context.enqueueAgent` and currently launches recipient work in the active turn.
  - `handleReadContext` calls `buildAgentToolContextPayload`, which reads conversation messages and recipient-scoped private messages. There is no revision cursor or pending delegation projection.
  - Invocation events are appended to the current `a2a_tasks` task through `runStore.appendTaskEvent`.
- `server/domain/conversation/turn/routing-executor.ts`
  - Active turns are held in `activeConversationIds` and `activeTurns` until queue exhaustion.
  - Private launches use reserved hops and `inFlightPrivateExecutions`; the private recipient is awaited by the routing loop, so this is not a non-blocking yield boundary.
  - `enqueueAgent` is the existing integration point for a continuation queue item.
- `server/domain/conversation/turn/agent-executor.ts`
  - The normal invocation owns one runtime run and calls `activeRunHandle.complete()` only for public bridge completion.
  - Session reuse uses `(conversationId, agentId, profileId)`, a CAS claim, cursor/hash validation, and `busy -> reusable` only after clean success. Poison/fallback rules must remain unchanged for continuations.
- `storage/sqlite/migrations.ts`, `storage/chat/*`, `lib/chat-app-store.ts`
  - Cross-conversation deliveries have durable CAS state, lease expiry, deadlines, cancellation, append-only events, idempotency and restart maintenance. They intentionally model a different cross-conversation message projection and cannot become the in-room canonical contract.
  - `a2a_tasks` and `a2a_task_events` are generic runtime task/event persistence used by `SqliteRunStore`; their name reflects a historical experiment, not an internal delegation protocol.
- `server/app/create-server.ts`
  - Cross-conversation worker startup has maintenance/recovery timers and post-commit event broadcasting. Delegation recovery should use a similarly isolated maintenance owner, but must settle requester continuation by exact delegation id.
- `storage/chat/message.repository.ts` and `lib/chat-app-store.ts`
  - Message ordering uses `(created_at, id)` and mutable `updated_at`; existing message updates can support a monotonic conversation revision projection without changing ordinary message payloads.

## Contract Decisions
- Add a delegation-specific durable model rather than using `a2a_tasks` or cross-conversation deliveries.
- MVP aggregation is `all`; `any` and `quorum` are explicit reserved modes rejected deterministically until implemented.
- Terminal delegation states are absorbing. Late recipient outcomes are audit data and never rewrite the ruling.
- `await/yield` is a control-flow transition that persists a wait edge, returns a clean current invocation result, and removes the active runtime slot. It is not a sleeping promise.
