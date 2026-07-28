---
feature_ids: [F002]
topics: [quality-gate, runtime, pi, sdk, ipc]
doc_kind: evidence
created: 2026-07-28
---

# F002 Quality Gate Report

Spec: `docs/features/F002-pi-sdk-host-migration.md`

Original requirement: dispatch from the CAFF command thread, preserved in the F002 Why,
requirements checklist, acceptance criteria, and hard boundaries.

Worktree: `E:\pythonproject\caff-pi-sdk-host`

## Vision Coverage

| Requirement | AC | Implementation and proof |
| --- | --- | --- |
| Default production runs must not depend on PATH, a global npm shim, or guessed package paths | AC-A1, AC-A7 | `lib/pi-runtime.ts` forks the built `pi-sdk-host.mjs`; the old CLI spawn, prompt transport, and heartbeat extension were deleted. Runtime-source scans find no legacy coding-agent package reference. |
| CAFF must use one precisely pinned coding-agent package family | AC-A7 | `package.json` pins `@earendil-works/pi-coding-agent` to `0.80.10`; `npm ls --depth=0` resolves exactly `0.80.10`. Skill-test and OpenSandbox surfaces use the same package family. |
| Every supported runtime must satisfy the pinned SDK engine | AC-A7 | `package.json.engines.node` and host preflight require `>=22.19.0`; README and OpenSandbox defaults use Node 22. Node 20.19.4 import failure is preserved as root-cause evidence. |
| Pi/extension failures must remain isolated from the CAFF API process | AC-A5, AC-A6 | The ESM SDK loads in a forked Node host with a structured IPC channel. Crash, disconnect, cancel, timeout, and late-session shutdown paths are covered. |
| Existing `startRun()` callers and event/result contracts must remain valid | AC-A1 through AC-A6 | Runtime tests cover prompt transport, unicode, assistant events, usage, sessions, extensions, cancellation, timeout, malformed protocol input, and host crash diagnostics. Full server smoke exercises the chat/turn/tool path. |
| Runtime switching must never occur after prompt acceptance or tool execution | AC-A5, AC-A7 | There is no automatic CLI fallback. Termination uses an IPC abort request, then a bounded force-kill fallback only for the same host process. |

Delivery completeness: complete F002 implementation slice. All implementation ACs are met;
formal peer review, merge, close report, and completion truth remain workflow gates rather than
missing product scope.

## Functional Matrix

| AC | Result | Evidence |
| --- | --- | --- |
| AC-A1 event/caller contract | Pass | `tests/runtime/pi-runtime.test.js`; malformed IPC still emits compatible `stdout_parse_error` with `source: ipc`, and unused host stdout cannot backpressure-block IPC completion. |
| AC-A2 session/resume | Pass | Runtime config forwarding plus `tests/runtime/pi-sdk-host.test.js` coverage for explicit, continue-recent, and fresh session managers. |
| AC-A3 cwd/extensions/tool lifecycle | Pass | SDK host creates an `AgentSessionRuntime`, binds extensions before prompt, provides official print-mode command actions, and disposes the runtime for `session_shutdown`. Real dogfood records `start:startup` and `shutdown:quit`. |
| AC-A4 usage aggregation | Pass | Multi-call usage regression and real pinned-SDK dogfood report input 12, output 5, total 17. |
| AC-A5 abort/timeout | Pass | IPC abort-before-force-kill tests; host abort-before-runtime-dispose test; late-created runtime shutdown race regression. |
| AC-A6 host crash | Pass | Non-zero fake host exit preserves exit code and stderr tail and rejects the run. |
| AC-A7 version/package truth | Pass | Exact dependency `0.80.10`; single-family source scan; old runtime files removed; Node engine/preflight is `>=22.19.0`; OpenSandbox defaults to `node:22-bookworm` and its SDK version comes from package.json. |
| AC-A8 full gates | Pass | `npm run check`, `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check` all exit 0. |

## Dogfood-Your-Slice

Scope verdict: required. This changes the runtime path used by every agent run.

### Real pinned SDK host

An isolated temporary agent directory contained a local-only `models.json` whose
OpenAI-compatible provider pointed at an ephemeral `127.0.0.1` mock server. No production
session, Redis instance, external model, or billable API was used.

End-to-end path:

```text
build/lib/pi-runtime.startRun
  -> child_process.fork(build/lib/pi-sdk-host.mjs)
  -> import @earendil-works/pi-coding-agent@0.80.10
  -> AgentSessionRuntime + SessionManager + bindExtensions
  -> local mock model stream
  -> typed AgentEvent over Node IPC
  -> existing CAFF result/usage aggregation
```

Observed result:

```json
{
  "reply": "hello from pinned sdk host",
  "code": 0,
  "signal": null,
  "parseErrors": 0,
  "usage": { "input": 12, "output": 5, "totalTokens": 17 }
}
```

The same dogfood run loaded a temporary extension and observed:

```text
start:startup
shutdown:quit
```

Timing observation: the first cold-cache run took about 17.4 seconds; a second new-host run
reached the mock request at 1.61 seconds and completed at 1.64 seconds. This is recorded as a
review focus, not hidden as a passing-test detail.

### Full CAFF chat/tool path

The server smoke starts an isolated CAFF server on an ephemeral port, creates a project/agent/
conversation, dispatches a user message, forks an IPC fake SDK host, invokes the real
`agent-chat-tools` bridge, and verifies `.trellis/workflow.md`, task metadata, and PRD output.
The focused path completed in about 0.51 seconds; the final full suite completed the same test
in about 0.67 seconds.

Bug found and fixed during quality-gate: the smoke still injected the removed `PI_COMMAND_PATH`
CLI fixture, so it accidentally started the real SDK without isolated credentials and timed out.
The fixture is now cross-platform Node IPC, and the PowerShell CLI fixture was deleted. See
`docs/bug-report/pi-sdk-host-smoke-fixture/bug-report.md`.

Fresh-context review then found two P1 issues before formal peer approval: unsupported Node 20
remained in the public/default sandbox contract, and the host skipped the SDK mode-level extension
lifecycle. Both were independently reproduced, fixed Red→Green, and documented in
`docs/bug-report/pi-sdk-host-fresh-context-findings/bug-report.md`.

## Design And Architecture

`.pen` glob result: no `.pen` files. No frontend/UI files changed, so visual comparison is not
applicable.

Architecture cell: `lib/pi-runtime.ts` runtime ownership cell

Map delta: none

Why: the change replaces the CLI adapter within the existing runtime boundary with an isolated
SDK host. It does not add a parallel store, queue, router, dispatcher, or API ownership cell.

## Contract Drift Audit

| Changed contract | Adjacent consumers checked | Result |
| --- | --- | --- |
| CLI argv/stdin/JSONL becomes Node IPC command/event objects | `startRun()` callers, runtime event emission, smoke fixture, build asset copy | Callers unchanged; prompt/unicode/event/error compatibility covered. |
| CLI signal termination becomes IPC `abort` then force-kill | cancel, external completion, expected completion, heartbeat timeout, parent signals, host disconnect | All paths share one termination classifier; late-created sessions are aborted and disposed. |
| Session selection moves to SDK `SessionManager` | named conversation sessions, resume, fresh runs, cwd-derived session directory | Explicit/open, continue-recent, and create mappings covered against the pinned SDK shape. |
| Runtime package discovery becomes a pinned project dependency | main runtime, skill-test extension, OpenSandbox image, local package resolver | Earendil package family is the single runtime truth; only OpenSandbox's explicit compatibility input may still name a command path. |
| Pinned SDK raises the Node runtime floor | package metadata, host startup, README, `.env.example`, OpenSandbox factory/build image | All surfaces require Node >=22.19; Node 20 fails early with an actionable host error instead of an `undici` initialization crash. |
| CLI print mode lifecycle becomes SDK-host lifecycle | extension discovery, command context, session startup/shutdown, abort | Host mirrors `runPrintMode`: bind before prompt, rebind after session replacement, and dispose through `AgentSessionRuntime`. |

## Process Guards

- Close report: generated at feature close after the reviewed commit/merge SHA exists; the
  pre-review AC matrix above has no unmet item or postponed implementation tail.
- Follow-up tail scan: no semantic blocking keyword hit. Package-lock integrity hashes produced
  false textual `P2` matches only.
- Hotfix detector: CAFF does not provide `scripts/check-hotfix-pattern.mjs`; this is a feature
  branch and removes a systemic dependency rather than applying a temporary workaround.
- Fallback detector: CAFF does not provide `scripts/check-fallback-layers.mjs`. Manual scan
  triggered on `pi-runtime.ts` and `pi-sdk-host.mjs`; the catches protect distinct process/IPC/
  session lifecycle boundaries rather than layering alternate runtimes. No CLI fallback exists.
- Capability tips: F002 is an internal runtime migration; the feature spec records
  `tips_exempt` with its reason.
- Artifact hygiene: no root-level media/design artifact remains. A PowerShell analysis cache
  created during verification was moved to the system temporary directory.
- Runtime ports: all server/model verification used ephemeral ports, not 3003/3004. No Redis
  connection was used.

## Verification

Fresh commands and results from the F002 worktree:

```text
npm run check                                                -> exit 0
npm run typecheck                                            -> exit 0
npm run build                                                -> exit 0
npm test                                                     -> exit 0
  test:fast                                                  -> exit 0
  server smoke                                               -> 60/60 pass
node --test tests/runtime/pi-runtime.test.js
  tests/runtime/pi-sdk-host.test.js
  tests/runtime/pi-skill-test-sandbox-extension.test.js
  tests/runtime/open-sandbox-factory.test.js                  -> 36/36 pass
git diff --check                                             -> exit 0
npm ls @earendil-works/pi-coding-agent --depth=0              -> 0.80.10
runtime package-family scan                                  -> no legacy coding-agent reference
Node 20 runtime contract scan                                -> no stale Node 20 support/default text
real pinned-SDK extension lifecycle                          -> start:startup, shutdown:quit
```

Quality Gate verdict: **pass, ready for formal peer review**. Formal approval is still required
from a different individual; this report is not self-review authority.
