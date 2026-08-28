# Drain Public Handoffs From Private Recipients

## Goal

Ensure a public handoff emitted by an immediately launched private recipient is executed in the same conversation turn even when the ordinary routing queue was empty while that private recipient was still running.

## Requirements

- Drain ordinary queued handoffs and in-flight private executions as one scheduler lifecycle.
- Re-check the ordinary queue after every private-execution settlement before finishing the turn.
- Preserve hop reservation, parallel capacity, stop behavior, cross-channel deduplication, and routing audit events.
- Do not change mention parsing, private message persistence, side-lane dispatch, or queue payload schemas.
- Add a regression that reproduces: Agent A privately launches Agent B; after the initial ordinary queue is exhausted, B publicly hands off to A; A must execute a third hop.

## Acceptance Criteria

- [x] The regression fails on the pre-fix implementation because Agent A executes only once and the turn finishes with `queue_exhausted`.
- [x] After the fix, Agent A executes twice, Agent B executes once, and the public handoff creates hop 3.
- [x] `conversation_turn_finished` is emitted only after hop 3 settles.
- [x] Existing private/public deduplication, capacity-limited fallback, stop, and hop-limit tests remain green.
- [x] Runtime checks, typecheck, build, and relevant smoke tests pass.
- [x] Runtime and unit-test specs document the joint-drain contract and regression.

## Verification Notes

- Baseline regression: 0/1, with `alphaExecutionCount` equal to 1 instead of 2 after the public handoff was accepted as `queued`.
- Fixed routing regression and adjacent private scheduling tests: 7/7.
- Rebuilt combined routing, bridge, and executor suites: 152 business assertions passed. Two unrelated image-preflight cleanup hooks remain non-green on Windows because `fs.rmSync` receives `EPERM` after their assertions pass.
- Server smoke and mode-store: 75/75.
- `npm run check`, server/public typecheck, equivalent build, and `git diff --check`: pass.

## Technical Notes

The current scheduler drains `queue` once and then only waits for `inFlightPrivateExecutions`. A private recipient can enqueue an ordinary public handoff during that wait, after the ordinary loop has exited. The fix should use one outer drain condition: finish only when the ordinary queue and in-flight private execution set are both empty, while retaining the existing inner queue execution semantics and terminal-reason precedence.
