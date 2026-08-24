# Deduplicate Private And Public Handoffs Per Trace

## Goal

Prevent one source Agent run from launching the same recipient twice when it
first uses `send-private` with handoff enabled and later ends its public reply
with an actionable mention of that recipient.

The first successful dispatch wins. The public reply is still persisted and
shown normally, but the duplicate mention does not create another model run or
consume another hop.

## Confirmed Contract

- Deduplicate dispatch across private handoff and ordinary public mention by the
  stable identity `(sourceAgentId, sourceRunId, recipientAgentId)`.
- A private handoff records the trace recipient only after it returns
  `outcome='launched'`. `already_running` and `capacity_limited` attempts do not
  suppress a later public handoff.
- `send-private --no-handoff` is persistence-only and must not reserve the trace
  recipient; a later actionable public mention still launches it once.
- A duplicate public mention remains part of the durable public message and UI;
  only its second model invocation is suppressed.
- Different recipients in the same trace each remain eligible once.
- The same recipient from a different source Agent or later source run remains
  eligible.
- Stop, batch capacity, per-Agent activity, queue settlement, and hop-budget
  behavior retain their existing authority.

## Non-Goals

- Do not inject the later public mention into an already-running recipient with
  Pi `steer` or `followUp`.
- Do not queue a second recipient invocation after the first private run ends.
- Do not change public mention parsing or public message visibility.
- Do not change user-authored side-lane scheduling, cross-conversation delivery,
  provider/runtime session behavior, or persistence schemas.

## Data Flow And Ownership

1. `agent-tool-bridge` authenticates `send-private`, persists the private
   message, and requests immediate handoff through the turn-local scheduler.
2. `routing-executor` owns the canonical trace-recipient dispatch ledger because
   it already owns hop reservation, capacity, cancellation, recipient activity,
   immediate private launches, and ordinary public routing settlement.
3. `agent-executor` parses the sender's terminal public reply and returns its
   actionable mentions without independently deciding trace eligibility.
4. Ordinary routing consults the same trace-recipient ledger before reserving a
   hop or launching the mentioned recipient.

No private content is copied into the ledger, events, or public message.

## Validation Matrix

| Case | Expected behavior |
| --- | --- |
| private handoff to B, then actionable public mention B in same source run | B executes exactly once; public message remains visible; one hop consumed |
| duplicate private messages to B, then public mention B | B executes exactly once; later private/public dispatches are duplicates |
| private handoff to B, then public mention C | B and C each execute once |
| private `--no-handoff` to B, then public mention B | B executes once from public routing |
| private handoff to B completes before sender's public mention is routed | no second B invocation |
| private handoff to B is still running when public mention is routed | no second B invocation |
| same source Agent mentions B in a later source run | B is eligible again |
| another source Agent mentions B | B is eligible for that distinct trace |
| Stop wins before a pending launch | no late launch; cancellation semantics unchanged |
| capacity or hop budget blocks dispatch | existing bounded outcome applies; no excess launch or hop consumption |

## Good / Base / Bad

- Good: A sends one complete private review request to B, then publicly hands
  off to B; B runs once and the public handoff remains visible.
- Base: A sends a private note with `--no-handoff`, then publicly mentions B; B
  runs once because the private note never requested dispatch.
- Bad: deduplicating only by recipient, which would suppress a later source run
  or another sender; or marking persistence-only private notes as dispatched.

## Acceptance Criteria

- [ ] A regression test fails on the current baseline by observing two B
      executions for private handoff plus same-trace public mention.
- [ ] After the fix, B executes exactly once whether the private run is still
      active or has already completed before ordinary routing.
- [ ] `--no-handoff`, different-recipient, different-run, Stop, capacity, and
      hop-budget regression cases pass.
- [ ] Public content and private-message durability are unchanged.
- [ ] Relevant runtime specs document the shared cross-channel trace ledger and
      validation matrix.
- [ ] Targeted runtime tests, `npm run check`, `npm run typecheck`, and
      `npm run build` pass.
- [ ] An independent reviewer approves the exact candidate commit.
- [ ] An isolated preview demonstrates one recipient invocation for the real
      private-plus-public workflow before remote integration.

## Expected Change Surface

- `server/domain/conversation/turn/routing-executor.ts`: canonical cross-channel
  trace-recipient ledger and ordinary routing eligibility check.
- `tests/runtime/turn-orchestrator.test.js`: observable running/completed timing,
  different-recipient, repeated-private, capacity, Stop, and hop behavior.
- `tests/runtime/agent-tool-bridge.test.js` and
  `tests/runtime/agent-executor-hook.test.js`: lock both channels to the same
  source Agent and Pi run identity without changing their production APIs.
- `.trellis/spec/runtime/conversation-turn-queue.md` and
  `.trellis/spec/runtime/agent-runtime.md`: document the shared ledger and bridge
  identity contract.

`turn-orchestrator` user side lanes, cross-conversation delivery, bridge payload
signatures, persistence schemas, and Pi runtime code are not modified.
