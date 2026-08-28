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
- Test model usage at 15, 16, 17, 64, and 100 calls. Full aggregate counters remain authoritative; retained sequences are respectively all 15 calls, all 16 calls, `1 + 3..17`, `1 + 50..64`, and `1 + 86..100`.
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
  the parent observes `assistant_error`, then assert that `resultPromise`
  rejects, the unresolved/history/usage evidence is preserved, and the real
  SQLite run stores `status='failed'` with the same non-empty
  `assistant_errors_json`. This is the regression for historical
  message/task-failed + run-succeeded divergence.
- Add a cancellation variant using the same abort-tail fixture. Assert
  `terminationReason.type='cancelled'` and retain the assistant tail diagnosis.
- Keep the existing heartbeat/progress/run timeout, terminal completion,
  ordinary provider-error, and exact stream retry tests in the same regression
  gate. The fix must be keyed to termination order and type, never a particular
  abort string.
- Reproduce the persisted trace boundary with a real temporary SQLite store,
  run row, task row, `agent_reply_terminating` event, and PI session JSONL.
  Assert that completed message + succeeded task/run + empty run assistant
  errors + expected completion keeps raw session diagnostics while setting
  `session.expectedCompletionTailIgnored=true` and
  `failureContext.hasFailure=false`.
- Use two fail-closed controls: the same session error with a non-empty run
  `assistant_errors_json`, and the same succeeded run without the
  expected-completion event. Both must retain `failureContext.hasFailure=true`.
  Do not match the session error string in the production projection.

## Failed And User-Stopped Message Recovery Eligibility Guards

- Use a real temporary `ChatAppStore` plus `SqliteRunStore`, a real context-detail row, and a real session JSONL. Projection-only mocks cannot prove source linkage, historical run compatibility, or the user-stop tuple.
- Seed an exact active user-stop source: assistant message `status=failed`, `metadata.cancelled=true`, invocation failure `kind/code/terminationType=cancelled` with `eligible=false`, task `status=cancelled`, run `status=failed + termination_type=cancelled`, and matching message/task/run/session/snapshot IDs. The pre-fix red must project/throw `conversation_recovery_source_task_not_failed`; the green must project `sourceKind=user_cancelled`, accept one explicit POST, run no tools, and leave all source rows unchanged.
- Test the runtime producer separately through `createTurnStopper -> handle.cancel -> agent-executor catch`; assert the exact message metadata and task terminal state. Keep Pi runtime cancellation-precedence tests for the persisted run termination evidence.
- Cancellation evidence is an absorbing negative matrix. Cover message-only, task/run-only, run-only, eligible-cancelled invocation, link mismatch, missing run (queued cancellation), missing snapshot, and missing session. Every partial/contradictory tuple must use the stable mismatch or existing missing-integrity reason and create no recovery row/job.
- Pair cancellation negatives with positive failed-source controls: progress/watchdog timeout and provider abort/error remain recoverable as `sourceKind=failed` when they carry no cancellation signal. Also keep ordinary completed message/task/run ineligible.
- Seed the historical divergence exactly: message `failed`, task `failed`, run `succeeded`, and persisted non-empty `assistant_errors_json`. Assert both message-page capability and POST accept it, then run the background job and compare all three source rows before/after; the succeeded run must not be rewritten.
- Pair it with a negative control whose succeeded run has `assistant_errors_json=[]`. Assert `eligible=false`, `reasonCode=conversation_recovery_source_run_not_failed`, POST returns the same code, and no recovery task/job exists.
- Cover transient and durable refusal separately: busy runtime state projects/throws `conversation_recovery_conversation_busy`; missing session file projects/throws `conversation_recovery_source_session_missing`. The message page and POST must use the same domain inspection rather than mirrored conditions.
- UI fixtures must carry the server capability and closed `sourceKind`. Show `整理失败现场` only for `enabled=true && eligible=true && sourceKind=failed`, and `整理停止现场` only for the corresponding `user_cancelled` kind. Render the bounded server reason for ineligible sources; missing capability and missing/unknown source kind fail closed.

## System Model Output Budget And Fallback Guards

- Use fake provider model objects with explicit `maxTokens` values that differ from both legacy caps (`2000`, `4096`) and Pi default `16384`. Assert Recovery, direct JSON digest/rollup, and direct title completion receive the provider value; separately omit it and assert `16384`.
- Reproduce `stopReason='length'` with thinking-only content and an empty-visible-text response. Assert at most two calls, the second call uses the same provider/model/maxTokens plus `thinking='off'`, and successful visible output follows the normal persistence path.
- Pair every retry case with provider-error/429 and thrown/AbortError controls. Those controls must make exactly one call and follow the existing mechanical/extractive/title fallback.
- Inspect Recovery `conversation_recovery_model_attempt` events directly. Assert only enumerated stop/block/diagnostic fields and numeric usage are stored; seed a unique hidden-thinking marker and prove it is absent from task events, recovery rows, run errors, logs, and result messages.
- Keep JSON repair inside the same two-call counter. A repairable first invalid response may make one thinking-off repair call; output exhaustion followed by invalid JSON must not make a third request.
- Provider/output tests must assert `empty_text`, `length_exhausted`, and `invalid_output` separately. Do not infer these states from model prose.

## Recovery Scribe Startup-Default Guards

- Clear `CAFF_RECOVERY_*`, `CAFF_DIGEST_{PROVIDER,MODEL,THINKING}`, and
  `PI_{PROVIDER,MODEL,THINKING}` only around synchronous service/server
  construction, then restore every previously present value. This makes tests
  deterministic without leaking environment mutations into neighboring cases.
- Both `cross-conversation-delivery-wiring` server-composition paths must start
  without ambient Pi configuration. The stale-restart recovery test must also
  construct a fresh service under that environment and assert runtime-default
  `thinking='off'`.
- Prove the baseline red reaches `validateDefaults` with
  `Recovery scribe runtime defaults are invalid`; do not satisfy the test by
  injecting `PI_THINKING=off` into CI or fixtures.
- Keep fail-closed controls beside the regression: explicit unsupported
  non-empty thinking and out-of-range timeout still throw at startup, while the
  config-manager suite continues to reject unavailable models, unsupported
  model thinking, unknown fields, and invalid limits.
- Production code may normalize only the exact empty result at the Recovery
  Scribe startup-default boundary. Assertions must not require changes to
  global `DEFAULT_THINKING`, generic `resolveThinkingSetting`, persisted config
  validation, provider/model selection, credentials, or production settings.

## Useful Existing Suites

- `tests/runtime/agent-tool-bridge.test.js`: bridge behavior and `.trellis`
  write safety
- `tests/runtime/turn-orchestrator.test.js`: prompt assembly and Trellis context
  readiness rules
- `tests/runtime/pi-runtime.test.js`: lower-level runtime behavior

## Bounded Observability Timeline Guards

- Start from red evidence at three boundaries: model detail still retaining 64,
  mixed tool-trace output exceeding 16, and `assistant_message` producing no
  live model SSE. Run tests from the room worktree build, not another worktree.
- Real SQLite coverage writes more than 16 mixed events and asserts atomic
  message/detail persistence, first-plus-latest sequences, full counters,
  cascade deletion, and `foreign_key_check`.
- Runtime fixtures emit thinking and visible text markers beside usage, then
  assert the model SSE contains neither marker and is emitted once despite
  `agent_end` duplication. A same-Agent, same-turn repeated-execution fixture
  must assert each assistant message receives a distinct invocation sequencer:
  both live SSE and persisted detail restart at timeline/model-call sequence 1,
  the second message contains only its own counters, and the first snapshot is
  not mutated.
- Browser harnesses send at least 65 events to five independent message traces;
  each retains sequences `1, 51..65`, reports total 65/dropped 49, and receives
  new model events without polling. Calling the detail loader after a terminal
  message patch must not make a second GET.
- Terminal-state regressions seed the same running tool in both canonical
  `timelineEvents` and derived `steps`. Completed-message refresh, main-turn
  finish, and side-slot finish must update the canonical event first, then
  rebuild to a non-running summary/activity without resurrecting the stale
  derived status. The completed-message HTTP refresh fixture must also capture
  render-time state and prove the last render sees `activity.status=idle`, not
  merely that an after-render in-memory mutation eventually becomes idle. A
  separate long-live-trace fixture must dispatch the real terminal
  `conversation_message_updated` frame while HTTP refresh is unavailable and
  prove the lightweight message projection, canonical tools, summary, activity,
  full aggregates, and last render converge synchronously. A DOM renderer
  fixture must additionally keep a stale matching turn/slot stage at
  `status=running` with `currentToolName` populated after the message becomes
  terminal; the terminal card must ignore that stage, render no live-tool panel,
  and show `已完成` from the converged trace. A second fixture must drive the
  real `conversation_tool_event` path so `trace.task.status` becomes `running`
  before the terminal message frame arrives; the terminal sync must converge
  the task status, force the summary out of `running`, and clear the inferred
  current-tool activity without any HTTP refetch.
- Tool-trace fixtures combine model and tool events and assert every returned
  detail array is derived from the same 16-event window while full summary
  counts remain unchanged. The HTTP `timelineWindow` must repeat the full
  model/tool/miss/failure/duration aggregates; a browser compatibility fixture
  with only retention fields must preserve `summary` / `modelUsageSummary`
  through initial expansion and later model/tool SSE. Rendered regression
  evidence must show `66` model calls and `150` tools beside `16/216` retained
  and `200` omitted events. A bridge history over 200 events must preserve the
  true first event, newest failure, and SQL-derived full total.
