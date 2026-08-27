# PI 0.84.3 Expected Completion Abort Regression

## Goal

Prevent the assistant error emitted after CAFF intentionally starts
`expected_completion` from turning an already successful `send-public` reply
into a failed message/task. The completed run must settle with an empty
unresolved assistant-error list while preserving usage and the reply that
existed before completion.

## Confirmed Root Cause

PI AI 0.84.0 made provider-auth resolution abort-aware. When CAFF completes a
turn after a successful public post, the SDK host abort can win the next model
call's auth setup race. PI's lazy stream setup then emits an assistant message
with `stopReason='error'` and `errorMessage='This operation was aborted'`.

`lib/pi-runtime.ts` already ignores later assistant output when terminal PI
output calls `requestExpectedCompletion`, but caller-driven `complete()` enters
`beginTermination({ type: 'expected_completion' })` without enabling that same
guard. The post-completion error is therefore added to `assistantErrors`, and
`agent-executor.ts` defensively converts the otherwise successful result into a
failed message/task.

## Runtime Contract

| Event order | Required result |
| --- | --- |
| assistant output, caller `complete()`, trailing assistant abort error | trailing assistant output is ignored; run succeeds; unresolved `assistantErrors=[]` |
| assistant output, caller `complete()`, trailing text/update/end | trailing text does not enter the final reply or usage |
| assistant provider error before `complete()` | error remains unresolved and the executor fails the invocation |
| caller `cancel()` and trailing assistant error | cancellation remains authoritative and failed |
| heartbeat, progress, or absolute run timeout | timeout remains authoritative and failed |
| ordinary provider abort/error without expected completion | existing failure semantics remain unchanged |
| exact `stream_read_error` retry lifecycle | PI native retry and CAFF retry reconciliation remain unchanged |
| terminal PI assistant output requests expected completion | existing ignore-after-completion behavior remains unchanged |

## Implementation Constraint

At the `beginTermination` entry, enable `ignoreFurtherAssistantOutput` only
when `reason.type === 'expected_completion'`, before sending abort IPC. Do not
match error text, remove already-recorded errors, or suppress errors in the
executor after the runtime result has been assembled.

## Non-Goals

- Do not rewrite historical run `10437`, message
  `0b6f885a-b43c-45a7-a621-a43055d3b8cd`, or related task rows.
- Do not broaden or change the exact `stream_read_error` normalization.
- Do not alter user cancellation, watchdog, timeout, provider-error, process
  exit, or Goal failure-classification contracts.
- Do not deploy, restart, or modify production port 3100.
- Do not publish an upstream PI issue or pull request in this task.

## Acceptance Criteria

- [x] A regression test is captured red on the synchronized PI 0.84.3 baseline
      for `complete()` followed by the abort-shaped assistant error.
- [x] The same test proves completion-after text is absent from the reply and
      completion-before text/usage remains intact.
- [x] A provider error observed before completion still reaches
      `assistantErrors` and executor failure conversion.
- [x] User cancellation and heartbeat/progress/run watchdog tests remain
      authoritative failures.
- [x] Existing terminal-assistant expected completion and exact
      `stream_read_error` retry tests remain green.
- [x] Focused runtime/executor/bridge/turn tests prove message/task/run/usage
      state without a failure context on successful public completion.
- [x] Check, typecheck, build, and the applicable PI/runtime/Goal/DAG/private/
      image/handoff/smoke regression suites pass or have pre-existing failures
      recorded with baseline evidence.
- [x] Runtime and unit-test specs contain the executable expected-completion
      contract and regression matrix.
- [ ] An independent reviewer approves the exact frozen candidate SHA.
- [ ] An isolated acceptance instance proves a real successful `send-public`
      completion across UI, SSE, SQLite, logs, usage, and status; external side
      effects are disabled and production 3100 remains untouched.
- [ ] User acceptance and merge authorization precede a merge commit to
      `develop`; the accepted tree is checked byte-for-byte after integration.

## Evidence Boundaries

- Room branch/worktree: `room/c2fab452-caff-bug-bug` in its server-assigned
  isolated worktree.
- Base at task start: `origin/develop` at
  `3adeb3acc56cfd8a14d1ce287453275d71b2cc8f`.
- Post-acceptance synchronization base: `origin/develop` at
  `6c3210222d908a9097809f83a9712a7fc5075ba7`; combination merge baseline
  `d278ae9446116ae74a5e47f0fd58cad2d6871a1e`.
- Historical failed records remain unchanged as root-cause evidence.
- Acceptance uses a distinct port, SQLite path, log path, agent directory,
  uploads, temp storage, and credentials with external delivery disabled.
