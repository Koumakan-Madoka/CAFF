# Runtime Test Patterns

## Current Style

- Tests use Node's built-in `node:test` and `assert/strict`
- Runtime-oriented tests commonly import compiled output from `build/`
- Temporary directories come from `tests/helpers/temp-dir.js`

## Expectations

- Cover observable behavior, not just helper internals
- Add regression tests when changing prompt assembly, path validation, active
  project rules, or Trellis file IO
- Keep test fixtures small and explicit; many current tests construct minimal
  stores, conversations, and temp project dirs
- Preserve safety checks around symlinks, invalid paths, and missing active
  project state

## Useful Existing Suites

- `tests/runtime/agent-tool-bridge.test.js`: bridge behavior and `.trellis`
  write safety
- `tests/runtime/turn-orchestrator.test.js`: prompt assembly and Trellis context
  readiness rules
- `tests/runtime/pi-runtime.test.js`: lower-level runtime behavior
