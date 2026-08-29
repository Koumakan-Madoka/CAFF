# F002 Pinned Pi SDK Host Migration

Status: completed

## Legacy Sources

- `review-notes/2026-07-28-pi-sdk-host-review-request.md`
- `project-evidence/F002-quality-gate.md`

## Durable Outcome

F002 replaced the CLI adapter with a pinned SDK host process while preserving IPC isolation, runtime event translation, abort behavior, catalog validation, and test isolation. PR #49 landed as `6e6af44`; `b9f3ddf` recorded merge truth.

## Delivery Evidence

- Feature delivery: `6e6af446d36572e463fc2bb1a75d18ae5284933b`
- Documentation closure: `b9f3ddfa88b3e8942d0dd095f1dcaeb4c979d451`
- Final status: completed

## Current Truth Sources

- `docs/features/F002-pi-sdk-host-migration.md`
- `.trellis/spec/runtime/agent-runtime.md`
- Pi runtime, SDK-host, smoke-fixture, and catalog-host tests

## History Recovery

Use `git show b9f3ddf:<legacy-path>` or the path-specific Git log to recover the removed review/evidence packet. Current runtime behavior is defined by the feature document, runtime spec, code, and tests.
