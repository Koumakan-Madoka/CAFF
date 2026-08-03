---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [ci, node, sdk-host, test, runtime-contract]
doc_kind: bug-report
created: 2026-08-03
status: fix_implemented
---

# CI Node Runtime Drift

## Reporter

GitHub Actions reported two identical `unit` failures for PR #50 at final candidate SHA `67f2dd8` (push run `30807729662`, pull-request run `30807734551`).

## Diagnosis Capsule

| Field | Evidence |
|---|---|
| Symptom | `tests/runtime/pi-sdk-host.test.js` expected a runtime created during shutdown to record `abort` then `runtime_dispose`; CI observed an empty lifecycle. |
| Evidence | Both Ubuntu jobs used Node 20 and failed at `tests/runtime/pi-sdk-host.test.js:297`. The repository declares `engines.node >=22.19.0`. |
| Root cause | `.github/workflows/test.yml` remained pinned to Node 20 after the pinned Pi SDK host raised the repository minimum to Node 22.19. The expanded feature test suite exposed the mismatch by running the SDK host contract in default CI. |
| Diagnostic strategy | Read both failed logs, trace the assertion through `startProcessHost()`, compare workflow/runtime contracts, then run the same test under Node 20.19.4 and Node 22.19.0. |
| Timeout strategy | If the two-runtime reproduction disagreed with CI, inspect runner environment and test scheduling before changing code. |
| Warning strategy | Do not weaken `assertSupportedNodeVersion()` or skip the SDK host test merely to make an unsupported runtime green. |
| User-visible correction | None directly; CI now validates CAFF on the minimum supported Node runtime instead of an unsupported one. |
| Acceptance | Node 20.19.4 reproduction stays RED for the expected version-boundary reason; Node 22.19.0 is GREEN; full local gates and GitHub Actions pass after the workflow update. |

## Reproduction

Expected: CI runs on a Node version allowed by `package.json`, and `npm test` passes.

Actual: the workflow selected Node 20. The SDK host correctly rejected it before runtime creation, so the shutdown lifecycle fixture never received a runtime to abort or dispose.

Independent runtime check:

```text
npx -y node@20.19.4 tests/runtime/pi-sdk-host.test.js  -> 4 pass, 1 fail
npx -y node@22.19.0 tests/runtime/pi-sdk-host.test.js  -> 5 pass, 0 fail
```

## Fix

Pin the GitHub Actions unit job to Node `22.19.0`, matching the repository's minimum supported runtime. No production SDK-host behavior or test assertion changes are needed.

Rejected alternatives:

- Setting the fixture's fake process version to Node 22 would hide that the overall CI process is unsupported.
- Removing the test from `npm test` would reopen a real lifecycle regression surface.
- Weakening the Node-version guard would allow CAFF to start on a runtime unsupported by the pinned SDK package.

## Verification

- Direct RED/GREEN runtime comparison above.
- `node tests/runtime/pi-sdk-host.test.js` on supported local Node: PASS.
- `npm run check`, `npm run typecheck`, `npm test`, `git diff --check`: required before push.
- PR #50 GitHub Actions `unit`: required after push.

[砚砚/gpt-5.6-sol🐾]
