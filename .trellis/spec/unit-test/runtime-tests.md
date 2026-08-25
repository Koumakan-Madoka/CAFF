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
- For default Agent routing, test the shared resolver directly and also assert
  observable orchestration behavior: actual Agent execution, enqueue strategy,
  image capability target, queued execution-time snapshot, and SQLite close/reopen order

## Real SQLite Hydration Guards

Conversation hydration regressions require a real temporary `ChatAppStore`, not only a mock that returns pre-clipped arrays.

- Seed enough ordered rows to put required/current fixtures outside the latest-24 window.
- Replace `store.getConversation`, unbounded public `store.listMessages`, and unbounded private `store.listPrivateMessages` with path-specific throwing poisons only after fixture creation.
- Keep restart recovery, queue startup/inference, durable pending discovery, Goal continuation/action, default routing, side snapshot, private visibility, and deletion reconciliation in separate tests so the first poison failure cannot mask another path.
- Prove non-tautology by rebuilding the exact baseline and running the same test file: failure stacks must reach the known old hydration entrypoints. A missing newly introduced method is a valid baseline red only when another test independently reaches the old behavior stack.
- Add a fail-closed test by removing a bounded method from a real store that retains its production capability marker. Assert `501` before run-store handles, active-turn state, or partial writes are created.
- For bounded prompt unions, assert exact deduplication and `(createdAt,id)` order: 24 ordinary history rows plus an old explicit source, then one current-turn reply in final projection. Side snapshot tests must append a later row and prove it remains absent.
- Seed 300 pending main-lane user rows to prove drain executes SQL-limited `256 + 44` batches, each execution receives every row its cursor crosses, and durable cursor checkpoints advance to each successful batch endpoint. Use a repository-level nullable import fixture to lock `turn_id IS NULL` history behavior because the canonical production schema declares `turn_id NOT NULL`.

The production-shape gate uses child processes with `--expose-gc`, a warm baseline, 10ms in-process heap/RSS sampling, projection-call sampling, and parent-process RSS sampling. Budget evaluation takes the larger RSS peak. Reports must include exact seed shape, selected-row counts/maxima, functional assertions, latency, peak deltas, post-GC retention, zero forbidden calls, and read-only `integrity_check=ok`. Synthetic databases live only under gitignored `.tmp`; external integration environment variables are cleared.

## Useful Existing Suites

- `tests/runtime/agent-tool-bridge.test.js`: bridge behavior and `.trellis`
  write safety
- `tests/runtime/turn-orchestrator.test.js`: prompt assembly and Trellis context
  readiness rules
- `tests/runtime/pi-runtime.test.js`: lower-level runtime behavior
