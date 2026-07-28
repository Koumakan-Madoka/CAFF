---
feature_ids: [F002]
topics: [runtime, node, sdk, extensions, lifecycle]
doc_kind: bug_report
created: 2026-07-28
---

# Pi SDK Host Fresh-Context Findings

## Reporter

Fresh-context scan of `feat/pi-sdk-host` at `4eab9a8`, before formal peer approval.

## Diagnosis Capsule

| Field | Evidence |
| --- | --- |
| Phenomenon | Node 20 remained publicly supported although the pinned SDK could not import; extensions loaded by the SDK host did not receive startup/shutdown lifecycle events. |
| Evidence | Node 20.19.4 import failed with `TypeError: webidl.util.markAsUncloneable is not a function`. The host called `createAgentSession()`/`session.dispose()` directly, while pinned SDK `runPrintMode()` calls `bindExtensions()` and `AgentSessionRuntime.dispose()`. |
| Root cause | Dependency engine requirements were not propagated across CAFF runtime surfaces. Separately, the migration treated typed `AgentEvent` compatibility as the whole CLI contract and missed mode-owned extension lifecycle responsibilities. |
| Diagnostic strategy | Compare package engines and every advertised/default Node surface; reproduce under Node 20; read pinned SDK `print-mode.js`, `agent-session-runtime.js`, and extension binding types; trace every host creation/abort/dispose path. |
| Timeout strategy | If the pinned API mapping did not work after one focused implementation, fall back to the exported `runPrintMode` design as the reference rather than layering compatibility shims. |
| Warning signals | Any remaining `node:20`/`20+` support text, direct `createAgentSession()` host construction, missing `bindExtensions`, or direct session disposal. |
| User-visible correction | Unsupported Node runtimes fail early with an actionable minimum-version error; supported runtimes preserve extension startup/resource/shutdown behavior. |
| Acceptance | Red tests fail on old HEAD; focused runtime 36/36, full `npm test`, typecheck/build/check, real pinned-SDK reply/usage, and real extension `start:startup` + `shutdown:quit` all pass. |

## Reproduction

### FC-1: Node runtime contract

```powershell
npx -y node@20.19.4 -e "import('@earendil-works/pi-coding-agent')"
```

Actual: import fails inside the SDK's `undici` dependency before a session can start.

Expected: every CAFF-supported/default runtime satisfies the pinned SDK engine, or fails before
loading it with a clear version message.

### FC-2: Extension lifecycle

The old host subscribed and prompted without `session.bindExtensions()`, then called
`session.dispose()` directly. Therefore `session_start`, `resources_discover`, command context,
extension `onError`, and `session_shutdown` were not mapped from the CLI print-mode contract.

## Fix

- Added `package.json.engines.node: >=22.19.0` and a host preflight before SDK import.
- Updated README, `.env.example`, OpenSandbox factory, and image builder defaults to Node 22.
- Replaced direct session construction with `createAgentSessionServices()` +
  `createAgentSessionFromServices()` inside `createAgentSessionRuntime()`.
- Added official print-mode-equivalent extension bindings and session rebind actions.
- Normal and abort shutdown now use `AgentSessionRuntime.dispose()`; abort remains ordered before
  disposal.

Rejected alternatives:

- Downgrading the SDK: conflicts with the operator-selected exact `0.80.10` runtime truth.
- Polyfilling Node 20: would hide an upstream engine contract and expand unsupported surface area.
- Calling `runPrintMode()` directly: it writes JSON/stdout and owns process signal/output behavior,
  conflicting with CAFF-owned structured IPC. Its lifecycle mapping is mirrored instead.

## Red → Green

- `tests/runtime/pi-sdk-host.test.js`
  - Red: missing `createSdkRuntime`, bindings, runtime disposal, and Node engine/preflight.
  - Green: 5/5.
- `tests/runtime/open-sandbox-factory.test.js`
  - Red: default was `node:20-bookworm`.
  - Green: default is `node:22-bookworm`, suite 13/13.
- Focused migration: 36/36.
- Full `npm test`: exit 0; server smoke 60/60.
- Real pinned SDK: reply `hello from pinned sdk host`, parseErrors 0, usage 12/5/17.
- Real extension lifecycle: `start:startup`, `shutdown:quit`.

## Failure-Mode Sweep

- Runtime-version contract scan covered package metadata, README badge/prerequisites, `.env.example`,
  OpenSandbox factory, and image builder; no Node 20 support/default residue remains.
- Lifecycle scan covered initial creation, session rebind actions, normal completion, explicit abort,
  timeout/disconnect signals, and the late-created-runtime shutdown race.
