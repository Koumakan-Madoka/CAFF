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

## P2C-Expand Message Detail Guards

- Use a real temporary `ChatAppStore`; inspect `sqlite_master`, `PRAGMA index_list`, `PRAGMA foreign_key_check`, and the detail tables directly.
- Insert historical old-only rows through SQL after schema creation, reopen the store, and assert detail counts remain zero plus `metadata_json` bytes remain identical. This proves no hidden backfill/rewrite.
- Exercise queued create, streaming updates, completed update, and failed/error update. Assert message plus detail atomicity and that repeated `(message_id, snapshot_id)` lifecycle updates do not change the snapshot row `updated_at`.
- Monkey-patch each detail UPSERT to throw after the message statement. Assert the entire create/update transaction rolls back, including content, status, metadata, and any earlier detail write.
- Test model usage at 63, 64, 65, and 100 calls. Full aggregate counters remain authoritative; retained sequences are respectively all calls, all calls, `1 + 3..65`, and `1 + 38..100`.
- Test table-first reads after directly changing legacy metadata to a conflicting or Contract-shaped lightweight object. Separately test legacy-only fallback and no-usage/null absence.
- Delete both an individual message and a whole conversation through store APIs; assert both detail rows disappear and `foreign_key_check` is empty. Raw SQLite fixtures must explicitly enable foreign keys or use the store connection.
- The snapshot HTTP test seeds mixed old/new/table-only rows and malformed/null/string legacy snapshots, poisons `getConversation` and `listMessages`, and asserts default 50, max 100, same-time ID ties, no duplicate/skip, cross-conversation cursor rejection, Inspector, and export.
- The production-shape gate must include at least 50 real object snapshots and one >=200 KiB snapshot, report disk delta for dual writes, verify unchanged historical metadata bytes, and clear external integration variables.
- Rollback proof runs the exact pre-P2C build against an Expand-created SQLite fixture. It must read/update full metadata while ignoring extra tables; reopening with Expand must still return table details.

## P2C-Contract Message Metadata Guards

- Run the same Contract test files against the exact accepted Expand build
  before implementation. Storage, HTTP, and SSE failures must reach full
  metadata/detail behavior; a lightweight UI compatibility fixture may already
  pass because the existing timeline only consumes references and aggregates.
- Real SQLite writes pass full `contextSnapshot` / `modelUsage` separately and
  assert the message row contains no `sections`, `displayContent`, or `calls`.
  Read the detail tables directly to prove full snapshots and retained call
  objects survived.
- Cover queued, streaming/tool, completed, failed/error, and null-usage states.
  Capture the immutable snapshot row before lifecycle updates and assert its
  JSON and `updated_at` remain unchanged.
- Inject explicit snapshot and usage UPSERT failures after the message statement;
  assert create/update content, status, metadata, and detail rows roll back.
- Seed legacy-only, Expand dual-written, and Contract table-backed rows in one
  real message page. Assert transport output preserves timeline/deletion/session/
  usage/cross-conversation/Goal/image fields but contains no full detail bodies.
- Test SSE at the real `SseBus` serialization boundary for both created and
  updated event names. This is the shared boundary for all producer call sites;
  source-only assertions are insufficient.
- Render a lightweight assistant fixture in jsdom and assert the context button
  remains enabled and aggregate model-call/provider-miss text remains visible.
- Record historical `metadata_json` bytes before future writes and compare them
  afterward. Production-shape gates must also report actual Contract row bytes,
  hypothetical Expand duplicate bytes, message-page/SSE payload bytes, DB delta,
  heap/RSS/latency, and integrity/FK results.
- Rollback proof uses the exact accepted Expand build against a Contract-created
  fixture. It must read full table detail, update the message, and leave the DB
  readable when Contract is restored.

## Expected-Completion Abort-Tail Guards

For caller-driven completion regressions, use a child IPC fixture instead of a
mocked result alone:

- Send a non-terminal assistant text/tool message first and call
  `handle.complete()` from the parent's `assistant_message` listener. This
  reproduces the bridge-success-to-runtime-completion ordering.
- After the child receives abort IPC, send `message_update`, `message_end` with
  an assistant error, and `agent_end`, then exit zero. The baseline must fail on
  the unexpected unresolved tail error before the runtime fix is applied.
- Assert the green result and persisted runs row together:
  `reply` and `usageCalls` contain only pre-completion data,
  `assistantErrors=[]`, and `status='succeeded'` with
  `assistant_errors_json='[]'`.
- Add a pre-completion provider-error variant. Trigger `complete()` only after
  the parent observes `assistant_error`, then assert that prior error remains
  unresolved and would still activate the executor's defensive failure path.
- Add a cancellation variant using the same abort-tail fixture. Assert
  `terminationReason.type='cancelled'` and retain the assistant tail diagnosis.
- Keep the existing heartbeat/progress/run timeout, terminal completion,
  ordinary provider-error, and exact stream retry tests in the same regression
  gate. The fix must be keyed to termination order and type, never a particular
  abort string.

## Useful Existing Suites

- `tests/runtime/agent-tool-bridge.test.js`: bridge behavior and `.trellis`
  write safety
- `tests/runtime/turn-orchestrator.test.js`: prompt assembly and Trellis context
  readiness rules
- `tests/runtime/pi-runtime.test.js`: lower-level runtime behavior
