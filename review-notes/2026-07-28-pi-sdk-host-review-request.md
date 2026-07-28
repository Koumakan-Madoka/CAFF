---
feature_ids: [F002]
topics: [review-request, runtime, pi, sdk, ipc]
doc_kind: review_request
created: 2026-07-28
---

# Review Request: CAFF Pi Runtime CLI → SDK Host

Review-Target-ID: `feat-pi-sdk-host`

Branch: `feat/pi-sdk-host`

Review SHA: `595ac5c`

## What

- Replace the main agent's global Pi CLI/PowerShell/JSONL execution path with a CAFF-owned,
  forked ESM SDK host using structured Node IPC.
- Pin `@earendil-works/pi-coding-agent` to `0.80.10` and use that package family across the
  main runtime, skill-test extension, and OpenSandbox runtime image/resolver.
- Preserve the public `startRun()` handle, event, usage, session, completion, and error contracts.
- Delete the obsolete CLI spawn, stdin prompt transport, heartbeat extension, and PowerShell
  smoke fixture.

## Why

The prior path could execute a different globally installed package/version than the system
shim advertised and depended on PATH, shell wrappers, JSONL framing, and CLI exit semantics.
The isolated SDK host keeps the required failure boundary while making the package version and
IPC contract CAFF-owned and testable.

## Original Requirements

> Migrate the main CAFF Agent runtime from “global Pi CLI + JSONL stdout” to a precisely pinned
> `@earendil-works/pi-coding-agent` SDK host with structured Node IPC. Preserve `startRun()` and
> caller event contracts, keep Pi out of the CAFF API process, and never switch back to CLI after
> prompt acceptance or tool execution.

- Source: dispatch message `0001785235599092-002796-90a20aeb`, normalized into
  `docs/features/F002-pi-sdk-host-migration.md`.
- Please judge the delivery against this requirement, not only against individual tests.

## Tradeoff

- Rejected `pi-ai.complete()`: it is only the model layer and would require CAFF to rebuild the
  agent loop, sessions, tools, and extensions.
- Rejected same-process SDK embedding: lower IPC overhead but a larger crash/leak radius inside
  the API process.
- Chosen forked SDK host: retains one process per run and a measurable cold-start cost, but owns
  versioning/protocol semantics and preserves process isolation.

## Architecture Ownership

Architecture cell: `lib/pi-runtime.ts` runtime ownership cell

Map delta: none

Why: this replaces the adapter inside the existing runtime boundary; it does not add a parallel
store, queue, router, dispatcher, or API ownership cell.

Please check that the diff matches `Map delta: none`, especially the SDK host boundary and the
OpenSandbox compatibility surface.

## Open Questions

### Technical OQ

1. Is the pinned SDK mapping correct for explicit sessions, resume, fresh sessions, cwd, model
   resolution, settings, and extension discovery?
2. Are abort/disconnect/timeout races closed, including a session created after shutdown begins?
3. Does ignoring host stdout while retaining stderr + IPC diagnostics create any unacceptable
   observability gap? The alternative unread pipe was proven to deadlock under backpressure.
4. Is the OpenSandbox change appropriately scoped: pinned Earendil package and Node 22, while
   retaining only its explicit sandbox-side CLI compatibility runner?
5. Performance focus: isolated real-SDK dogfood observed about 17.4 seconds on the first cold
   cache and about 1.6 seconds on the next new host process. Is that acceptable without pooling?

### Value OQ

None. The operator already selected the forked SDK-host direction.

## Fresh-Context Findings

An independent fresh-context worker was triggered as a finding generator. No usable finding list
was available when this formal request was prepared. Separately, author self-check found and
fixed one issue before review: an unread stdout pipe could backpressure a noisy SDK/extension;
commit `595ac5c` changes stdout to `ignore` and adds a red→green regression. This is not counted
as independent review evidence.

## Next Action

Please perform an independent code review of the exact review SHA and return an explicit
`APPROVE` or `REQUEST-CHANGES` verdict with P0/P1/P2/P3 findings and independent validation
evidence. The author must not self-approve.

## Review Sandbox

- Suggested path:
  `C:\Users\ZN\AppData\Local\Temp\cat-cafe-review\feat-pi-sdk-host\cat-mcmk1s9b`
- Bootstrap: `npm ci`
- Validation: `npm run typecheck`, `npm test`, and the focused command below
- Ports: web=`n/a`, api=`n/a`; no dev server or UI validation is required

Focused validation:

```powershell
node --test `
  tests/runtime/pi-runtime.test.js `
  tests/runtime/pi-sdk-host.test.js `
  tests/runtime/pi-skill-test-sandbox-extension.test.js `
  tests/runtime/open-sandbox-factory.test.js
```

## Self-Check Evidence

### Spec compliance

- Quality gate: `project-evidence/F002-quality-gate.md`
- Feature truth: `docs/features/F002-pi-sdk-host-migration.md`
- Smoke regression root cause: `docs/bug-report/pi-sdk-host-smoke-fixture/bug-report.md`
- No `.pen` or UI changes; root media/design artifact scan is empty.

### Fresh validation

```text
npm run check       -> exit 0
npm run typecheck   -> exit 0
npm run build       -> exit 0
npm test            -> exit 0; server smoke 60/60
focused migration   -> 34/34 pass
git diff --check    -> exit 0
npm ls pinned SDK   -> @earendil-works/pi-coding-agent@0.80.10
```

Real pinned-SDK dogfood used only a temporary agent directory and an ephemeral local mock model
endpoint; result was `hello from pinned sdk host`, parseErrors 0, usage 12 input / 5 output.

### Worktree placement

- Target worktree: `E:\pythonproject\caff-pi-sdk-host`, branch ahead of `origin/main` by the F002
  commits only.
- The primary `E:\pythonproject\caff` worktree was already dirty with unrelated operator-owned
  files and was not modified by this task.
