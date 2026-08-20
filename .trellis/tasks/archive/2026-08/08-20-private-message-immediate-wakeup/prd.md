# Immediate Private-Message Agent Wakeup

## Goal

When an Agent sends a private message to another currently idle Agent with handoff enabled, start the recipient inside the same conversation turn immediately instead of waiting for the sender's model trace to finish. Preserve one coherent turn lifecycle: cap duplicate cost, wait for every immediately launched recipient before finalizing the turn or scheduling Goal continuation, and define a reproducible commit-pinned review workflow without creating unnecessary review worktrees.

## Requirements

### Immediate private handoff

- After `send-private` persists a message to another Agent, and handoff is enabled, an idle recipient starts during the sender's still-running trace.
- A note to self and `--no-handoff` remain persistence-only: they neither launch nor route another Agent.
- Multiple distinct recipients may launch concurrently, subject to the existing per-turn parallel and hop budgets.
- The sender is not automatically terminated and may finish non-writing work, but a formal review request freezes repository writes by that sender for the rest of its trace.

### Cost and duplicate control

- One source Agent trace may launch a given recipient at most once.
- A later private message from the same source trace to the same already-launched/running recipient is still persisted, but it does not launch a second run; the bridge result states that the current recipient run is not guaranteed to see that later message.
- Prompt guidance tells Agents to send at most one complete private message per recipient per trace, avoid polling/P2 waiting, and include all relevant context before sending.
- Pi `steer` and `followUp` are explicitly out of scope for this MVP.

### Same-turn convergence and cancellation

- The turn does not emit `turn_finished`, settle the root task, clean up the active turn, or permit Goal continuation until the sender and every recipient launched by in-turn private handoff have settled.
- A sender returning `final` stops ordinary future routing but does not orphan or bypass already-launched private recipients.
- Hop capacity is reserved atomically when work is scheduled/launched, so concurrent recipients cannot receive duplicate hop numbers or exceed the turn budget.
- A user stop marks the turn stopped and cancels all registered in-flight recipient runs and queued slot waits. No new private recipient starts after stop.
- Recipient failure is recorded in the same turn's failure/reply evidence without prematurely failing or finalizing another in-flight Agent.

### Bridge result contract

- Preserve existing `handoffRequested` and `enqueuedAgentIds` compatibility fields where practical.
- Add an explicit bounded dispatch projection so the caller can distinguish immediately launched recipients from duplicate/already-running, queued/fallback, and persistence-only recipients.
- Tool telemetry records the dispatch outcome without echoing private content.

### Commit-pinned review safety

- Formal review requests must include the exact commit SHA, review scope/risks, author validation evidence, and desired response format.
- After sending a formal review request, the author must not modify repository files for the rest of that trace.
- Review worktree creation is risk-based, not automatic:
  - If the author will not continue modifying code and the room worktree is clean at the requested SHA, the reviewer may inspect and test in the room worktree.
  - If review is static and uses immutable commit objects (`git show`/`git diff <SHA>`), no worktree is required even if later development may continue.
  - If the reviewer must run tests while the room worktree may change or does not point at the requested SHA, create a detached review worktree at that SHA with isolated ports, database, logs, and external side effects.
  - If the reviewer is asked to modify code, use a separate writable branch/worktree rather than the detached review worktree or the author's room worktree.
- Review worktree cleanup is non-destructive and tolerant of Windows file locks; never force-remove a dirty or locked worktree.

## Acceptance Criteria

- [ ] A regression test proves recipient execution begins before the sender promise settles after a cross-Agent private handoff.
- [ ] A regression test proves self-private and `--no-handoff` do not launch another Agent.
- [ ] A regression test proves a second private handoff from the same source trace to the same recipient persists but does not create another execution.
- [ ] A regression test proves distinct recipients can start concurrently without exceeding the configured parallel/hop budget and receive unique reserved hops.
- [ ] A regression test proves sender `final` does not emit `turn_finished` until all in-flight private recipients settle.
- [ ] A regression test proves user stop cancels all current turn handles/recipients and prevents a late launch.
- [ ] Bridge/CLI tests lock the explicit dispatch-result wording and compatibility projection.
- [ ] Prompt tests lock one-complete-private-message guidance, no polling/P2 waiting, commit-pinned formal review, post-request write freeze, and risk-based review worktree rules.
- [ ] Existing mention routing, public handoff, side-lane slot, cancellation, and Goal continuation tests remain green.
- [ ] `npm run check`, `npm run typecheck`, `npm run build`, targeted runtime tests, and `git diff --check` pass.
- [ ] An independent Agent reviews the exact implementation commit SHA; any test execution uses the dynamic worktree rule above.

## Definition of Done

- A failing regression test demonstrates the previous deferred-wakeup behavior before implementation.
- Runtime, bridge result, prompt, test, and code-spec contracts are updated together.
- Verification evidence is recorded with exact commands/results.
- The implementation is committed on `room/c2fab452-caff-bug-bug`, independently reviewed at its exact SHA, and made available for user acceptance in an isolated environment if manual runtime validation is needed.
- Trellis is archived only after explicit user acceptance.

## Technical Approach

1. Refactor the main routing executor around a turn-local scheduler that owns pending queue entries, in-flight executions, source-trace-to-recipient launch deduplication, and atomic hop reservation.
2. Keep existing initial user routing semantics. When the bridge calls `enqueueAgent` for `triggerType: private`, schedule an idle eligible target immediately instead of only appending it behind the currently awaited execution.
3. Track every launched promise in the turn scheduler. A sender's `final` closes ordinary routing, while the scheduler drains already-launched private work before final turn settlement.
4. Continue using the existing `(conversationId, agentId)` slot registry and turn handle registration for per-Agent exclusion and stop cancellation. Do not launch a second invocation when the target is already scheduled by the same source trace.
5. Reserve hop ids synchronously in the scheduler before starting each execution; pass the reserved hop into `executeConversationAgent` instead of deriving it later from concurrently mutated `turnState.hopCount`.
6. Extend the bridge/CLI compact result with bounded dispatch outcomes, and update prompt/workflow guidance for cost and commit-pinned review safety.

## Contract and Error Matrix

| Case | Expected behavior |
| --- | --- |
| Other Agent idle, handoff enabled, capacity available | Persist private message; launch recipient immediately; return launched outcome. |
| Same source trace repeats recipient | Persist message; do not launch twice; return duplicate/already-running outcome and visibility warning. |
| Recipient already scheduled/running for another in-turn source | Do not start a concurrent same-Agent run; queue at most one fallback wake or report existing scheduling according to scheduler state; never lose the persisted message. |
| No remaining hop/parallel capacity | Persist message; do not exceed budget; return bounded capacity outcome. |
| Self-private or `--no-handoff` | Persist only; no launch. |
| Sender finalizes while recipient runs | Stop future ordinary routing; await recipient; finalize once. |
| User stops during concurrent runs | Cancel all registered handles; settle once as stopped; no late launch. |
| Recipient fails | Record failure, await other in-flight work, then settle turn from aggregate evidence. |

## Good / Base / Bad Cases

- **Good:** Author commits, sends one complete private review request with SHA to an idle reviewer, reviewer starts immediately, author performs only short non-writing closeout, and the turn finishes after both settle.
- **Base:** A second message to the same reviewer is persisted but produces no second model run; the tool warns that the already-running trace may not see it.
- **Base:** The reviewer only uses `git show <SHA>` and does not create a review worktree.
- **Base:** The author will keep coding after the request and the reviewer must run tests, so the reviewer creates a detached SHA worktree with isolated runtime resources.
- **Bad:** Starting a second recipient invocation for every follow-up private message.
- **Bad:** Emitting `turn_finished`/Goal continuation while a private recipient is still executing.
- **Bad:** Running commit-pinned tests in a changing shared room worktree or force-removing a dirty/locked review worktree.

## Decision (ADR-lite)

**Context:** Deferred private handoff causes models to wait or poll after requesting review, wasting P2 tokens. True busy-session incremental delivery through Pi `steer` would require a long-lived IPC host, consumption acknowledgement, queue draining, and fallback logic; multiple steer messages can also add full-context model calls.

**Decision:** Implement option A: immediate launch only for eligible idle recipients, one launch per source trace/recipient, same-turn in-flight convergence, and commit-pinned review with dynamic worktree selection. Do not add `steer` or `followUp` in this task.

**Consequences:** The primary latency/cost bug is removed with bounded runtime changes. Follow-up private messages to an already-running recipient are durable but may wait for a later trace; callers are told to send one complete message. Busy-session incremental delivery remains a separately designed enhancement.

## Out of Scope

- Pi SDK `steer` or `followUp` support and long-lived host IPC.
- Automatically terminating the sender after `send-private`.
- Automatically creating a review worktree for every review.
- Letting two runs for the same `(conversationId, agentId)` execute concurrently.
- Changing public mention routing, initial user mention-parallel semantics, cross-conversation delivery, or side-lane user dispatch semantics except where shared stop/convergence tests require preservation.
- UI redesign for the single `currentAgentId` indicator during concurrent work.

## Relevant Specs and Code Patterns

- `.trellis/spec/runtime/agent-runtime.md`: bridge/prompt mirrored contracts and runtime lifecycle.
- `.trellis/spec/runtime/conversation-turn-queue.md`: main/side lanes, slot exclusion, prompt snapshots, stop and finish semantics.
- `.trellis/spec/guides/cross-layer-thinking-guide.md`: bridge → scheduler → runtime → prompt/test data flow.
- `.trellis/spec/unit-test/runtime-tests.md`: observable `node:test` regressions using built runtime artifacts.
- `server/domain/conversation/turn/routing-executor.ts`: current turn-local queue, private batch merge, hop derivation, and final settlement.
- `server/domain/runtime/agent-tool-bridge.ts`: private-message persistence and handoff enqueue callback.
- `server/domain/conversation/turn/agent-executor.ts`: prompt snapshot, invocation registration, run handles, final semantics, and result aggregation.
- `server/domain/conversation/turn-orchestrator.ts`: Agent slot wrapping, stop/Goal continuation gates.
- `server/domain/conversation/turn/agent-slot-registry.ts`: existing per-conversation/Agent mutual exclusion.
- `server/domain/conversation/turn/agent-prompt.ts` and `lib/agent-chat-tools.ts`: prompt and compact bridge-result contracts.

## Likely Files to Modify

- `server/domain/conversation/turn/routing-executor.ts`
- `server/domain/conversation/turn/agent-executor.ts` (only if scheduler callback/result typing or hop ownership requires it)
- `server/domain/runtime/agent-tool-bridge.ts`
- `server/domain/conversation/turn/agent-prompt.ts`
- `lib/agent-chat-tools.ts`
- `tests/runtime/turn-orchestrator.test.js`
- `tests/runtime/agent-tool-bridge.test.js`
- `tests/runtime/agent-chat-tools.test.js`
- `.trellis/spec/runtime/conversation-turn-queue.md`
- `.trellis/spec/runtime/agent-runtime.md`
- `.agents/skills/caff-workflow/references/checklists.md` or `environments.md` for the risk-based review-worktree recipe, after locating the narrowest authoritative section.

## Open Questions

None required for implementation. Concrete compatibility field names and scheduler helper boundaries may be refined from red-test evidence without changing the accepted behavior.
