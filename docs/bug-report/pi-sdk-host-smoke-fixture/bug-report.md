---
feature_ids: [F002]
topics: [runtime, sdk-host, smoke-test, regression]
doc_kind: bug_report
created: 2026-07-28
---

# Pi SDK Host Smoke Fixture Regression

## 1. Reporter

Found by 缅因猫/砚砚 during the F002 full quality gate while running `npm test` in
`E:\pythonproject\caff-pi-sdk-host`.

## 2. Reproduction

Expected: all server smoke tests pass, including the end-to-end path where a pi-mono agent
initializes Trellis and writes a PRD through CAFF's chat tool bridge.

Actual: 59/60 smoke tests passed; the Trellis agent smoke timed out after about 15 seconds with
`Condition was not met in time`, and none of the expected Trellis files appeared.

Command:

```text
npm test
```

## 3. Root Cause

The smoke test still set `PI_COMMAND_PATH` to `tests/fixtures/fake-pi-trellis-tools.ps1`.
F002 intentionally removed all `PI_COMMAND_PATH` and CLI-spawn handling from the main runtime,
so the override had no consumer. The server therefore launched the real SDK host against the
test's empty isolated agent directory instead of the fake fixture. With no configured model
credentials, the fake tool flow never ran and the polling assertion timed out.

Call-chain evidence:

```text
server-smoke.test.js env PI_COMMAND_PATH
  -> app server / turn orchestrator
  -> startRun()
  -> fork(pi-sdk-host.mjs)
```

`lib/pi-runtime.ts` no longer reads `PI_COMMAND_PATH`; this is correct production behavior. The
defect was the stale test transport, not a missing runtime fallback.

## 4. Fix

- Replaced the PowerShell CLI fixture with
  `tests/fixtures/fake-pi-sdk-host-trellis-tools.mjs`.
- The new fixture receives the structured `start` command over Node IPC, invokes the real CAFF
  chat tools with `process.execPath`, emits a typed `message_end` event over IPC, and handles the
  structured abort command.
- Updated the smoke server environment to use `PI_SDK_HOST_OVERRIDE`.
- Removed the Windows-only skip because the Node IPC fixture is cross-platform.
- Deleted the obsolete PowerShell fixture. No CLI fallback was restored.

## 5. Verification

```text
node --test --test-name-pattern='pi-mono agent can initialize' tests/smoke/server-smoke.test.js
  -> 1/1 pass, about 0.51 seconds

npm test
  -> exit 0
  -> server smoke 60/60 pass
  -> Trellis SDK-host smoke about 0.67 seconds
```
