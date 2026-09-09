# Native Runtime Agent Delegation Verification

## Baseline

- Base: `develop@bb13875b74d481d1892a515984680ca0a191674b`
- Initial implementation: `1835231`
- First review fix candidate: `e01785c8f1f8dcd1fb8b9a6e8bd1a676b0f51d5f`
- Cancellation lifecycle candidate: `79ba395b2e3f3f49101d4263e390c209145b522e`

## Regression Evidence

The post-review regression was run before the latest production fix:

```text
npm run build && node tests/runtime/agent-delegation.test.js
8 passed, 2 failed
```

The failures reproduced:

- a continuation invocation from the same requester Agent could not see/manage
  the earlier invocation's pending delegation;
- top-level cancellation did not emit the required completion or invoke side
  execution stop propagation.

A focused orchestrator regression then exposed a second execution of persisted
delegation source messages through the main queue. The durable source metadata
was missing `dispatchLane='side'`.

## Current Validation Evidence

```text
npm run build
passed

npm run check
passed

npm run typecheck
passed (runtime and public TypeScript projects)

node tests/runtime/agent-delegation.test.js
10 passed

node --test --test-name-pattern='delegation cancellation|delegation continuation|goal continuation' tests/runtime/turn-orchestrator.test.js
5 passed

node tests/runtime/agent-tool-bridge.test.js
35 passed

node tests/runtime/agent-executor-hook.test.js
14 passed

node tests/runtime/session-reuse-ab.test.js && node tests/runtime/session-reuse-decision.test.js
20 passed

node tests/storage/chat-store.test.js
25 passed

npm run test:smoke
87 passed
```

The focused cancellation scenario proves one running child is marked stopped,
one queued child is cancelled before grant, and delegation source messages are
not replayed by the main queue. The cancellation completion includes final child
outcomes. The Goal parking regression proves that a pending delegation prevents
Goal Runner message creation, then terminal settlement allows exactly one
continuation routed to the persisted Goal owner.

`node tests/runtime/turn-orchestrator.test.js` passed 105/107. The two failures
are the pre-existing Windows `EPERM` failures in image-preflight test cleanup
hooks at lines 6986 and 7052; both test bodies pass before `fs.rmSync` fails.
`npm test` reaches the same two failures after all preceding suites, including
the newly registered delegation suite, pass. Smoke was run separately because
`test:fast` stops at those cleanup failures.

`git diff --check` passes. Trellis JSONL entries parse as file references and
`buildTrellisPromptContext` reports this task `Status: READY`.

## Review History

Independent review of `1835231` found two blocking continuation/aggregation
issues. Independent review of `e01785c` confirmed both blockers fixed and the
main create/await/yield/settle/continuation path working, then identified:

- cancellation state did not propagate to queued/running side execution;
- exact invocation authorization blocked post-yield await/cancel/read-context;
- a low-reach top-level cancellation path could miss completion.

The `79ba395` independent focused review verified each prior P1/P2 fix with
separate reproduction and found no blocking issue. Its sole merge condition was
that the spec-declared Goal parking behavior lacked a regression test. This
supplemental change adds that test without changing production behavior; the
remaining P3 observations are recorded as non-blocking residual risks.

## No-Deadline And Post-Message Amendment

After the first develop merge, a real model delegation with an explicit 300
second deadline finished about five seconds late. The runtime correctly kept the
timeout absorbing, but the product decision changed: new in-room delegations now
have no automatic deadline. The Agent-facing CLI and prompt no longer advertise
`--deadline-seconds`; both CLI and domain validation reject legacy input instead
of silently ignoring it. Historical durable rows with a non-null `deadline_at`
retain deadline scanning and late-result behavior.

The same investigation reproduced a separate P1 regression: the CLI still sent
public bridge messages to `/api/agent-tools/post-message`, but the controller no
longer registered that route. Before the production fix, the focused regression
suite failed 3/33 tests: the post-message controller returned unhandled, the CLI
sent the retired deadline option, and new delegation records contained a 24-hour
deadline.

Post-fix evidence:

```text
node --test tests/runtime/agent-delegation.test.js tests/runtime/agent-tool-bridge.test.js tests/runtime/agent-executor-hook.test.js tests/runtime/session-reuse-decision.test.js tests/runtime/agent-chat-tools.test.js tests/http/conversation-deliveries-controller.test.js tests/runtime/agent-prompt-static-hash.test.js
103 passed

node --test --test-name-pattern='delegation cancellation|delegation continuation|goal continuation' tests/runtime/turn-orchestrator.test.js
5 passed

npm run test:smoke
95 passed (91 server + 4 mode-store)

npm run check
passed

npm run typecheck
passed

npm run build
passed

git diff --check
passed
```

The no-deadline regression advances the clock by 100 years and proves both group
and child remain active with `deadlineAt=null`. Existing historical-deadline
tests still prove aggregation-before-timeout and absorbing late results. The
controller regression invokes both `/api/agent-tools/post-message` and
`/api/agent-tools/delegation/create` through the real route handler and proves
both remain registered.
