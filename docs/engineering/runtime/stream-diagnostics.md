# Model stream and watchdog diagnostics

## Scope and invariant

`lib/stream-diagnostics.ts` projects native SDK events already received by the
parent in `lib/pi-runtime.ts`. It is **diagnostic only**. No refresh site, timeout,
recovery eligibility, retry, or completion policy changes. In particular, empty
and whitespace deltas still refresh the existing progress watchdog, and existing
limits can still terminate silent reasoning/tools. There is no new model-call
hard limit or semantic-progress classifier.

This instrumentation cannot reconstruct historical incidents, transport chunks
not exposed as SDK events, provider generation timing, or proxy buffering.

## Schema v1

The parent records receipt time (epoch milliseconds), not a provider timestamp:

- `eventCount`, fixed-label `eventCounts`, and a 32-record `recent` window;
- `lastPiEventAt`, `maxPiEventGapMs` (between observed events, not current silence),
  `lastDeltaAt`, `lastNonWhitespaceAt`;
- `phase`, `phaseSince`: **last observed activity**, not proof of current activity;
- delta count, empty count, confirmed whitespace-only count, total UTF-16
  `codeUnits`, scanned code units, scanned non-whitespace code units, and
  `unscannedCodeUnits`;
- progress refresh counts/time/reason, heartbeat count/time, configured watchdog
  limits and `progressArmed`/`terminating` capture state;
- `capture`: `periodic`, `terminating`, or `finished`.

All four existing progress-refresh sites are annotated: `initial`, `pi_event`,
`recovery_request`, `recovery_started`. Recording occurs only after the original
refresh guard passes and the timer is armed. Heartbeats never count as progress
refreshes. Events received during termination may appear in the diagnostic
window without refreshing the timer. The terminating snapshot is taken after
watchdogs are cleared; the final snapshot may include abort-tail events. On
natural child exit, `progressArmed` can still be true immediately before cleanup.

### Phase observations

| Observation | Phase |
| --- | --- |
| parent startup / agent_start / auto_retry_start | waiting (local startup/retry, not proof of upstream queueing) |
| assistant message_start | unknown (queueing vs hidden reasoning indistinguishable) |
| thinking_start / thinking_delta | thinking (visible thinking event, including empty delta) |
| text/toolcall start or delta | output (includes tool argument generation, not execution) |
| tool_execution or bash_execution start/update | tool |
| message/turn/agent end, retry end, tool end, compaction start/end, stream block end/done/error | unknown |

Unrecognized events do not assert a new phase. Parallel tool identities are not
tracked: an end event moves to unknown rather than claiming every tool finished.
No timer turns silence into a new phase. Always inspect timestamps; a stored
`thinking` phase does not prove the server is still thinking.

## Privacy and resource bounds

No text, tool names/IDs/arguments/results, message IDs, errors, prompts, keys,
raw delta, or hashes of content enter the new snapshot/event. Arbitrary event
labels are mapped to `other` (or `message_update:other`); known labels come from
fixed allowlists (currently 31 possible keys, ceiling 48). Labels over 40 code
units are rejected before lookup. These allowlists **do not gate watchdogs**.

- Scan at most the first **4096 UTF-16 code units per delta**, one pass using JS
  `\s`; length is read without scanning the full string. This does not bound the
  pre-existing IPC decoding cost or the number of events received.
- Non-whitespace counts are lower bounds if a suffix is unscanned. A truncated
  all-space prefix is never classified as a wholly whitespace-only delta.
- Length is neither bytes nor tokens; surrogate pairs count twice. Whitespace
  inside a JSON string may be meaningful. Non-whitespace growth is not semantic
  progress and repeated content is not detected.
- Keep the latest **32 event/refresh records combined**, no source references.
  Heartbeats update counters only, so cannot evict this window. Counters saturate
  at `Number.MAX_SAFE_INTEGER`. Snapshots are detached copies.
- Persist at most once per **30 seconds** by default, plus at most one terminating
  and one final snapshot. Internal `startRun` option `diagnosticsIntervalMs` is
  clamped to **1000..30000 ms** (for accelerated integration tests), with invalid
  numeric values using the default; no new environment/CLI setting.
- Each persisted JSON snapshot is hard-capped at **32768 UTF-8 bytes**. Persistence
  failure emits only `diagnostics_warning: snapshot_write_failed`; it does not
  change run outcome. Periodic timer is unref'd and cleared at termination/cleanup.

## Storage and loss boundaries

The nullable `runs.stream_diagnostics_json` column contains **one latest snapshot
per run**, replaced in place through the existing run store. It does not append
per-chunk task events. `SqliteRunStore.getRun().streamDiagnostics` exposes the parsed
snapshot, and runtime listeners can observe `stream_diagnostics` with `{summary}`.
No new UI/HTTP endpoint or SSE projection is added. Existing event/body storage is
unchanged; the privacy guarantee applies to the new diagnostics, not all run data.

`migrateRunSchema` adds this nullable column idempotently when the new build is
later opened against a database. Old rows remain null; no historical backfill.
Run retention/deletion owns snapshot retention/deletion automatically. Database
page/WAL/journal storage has SQLite's existing retention/checkpoint behavior;
the size bound is on the logical snapshot, not total database bytes or all runs.

Implementation verification uses temporary independent SQLite only. It neither
opens nor migrates production/acceptance databases. Deployment and its additive
migration require separate authorization; "do not modify existing databases"
is the implementation-stage operations boundary, not a claim that deployment
writes no data.

A killed child normally yields a final snapshot from the surviving parent. A
killed/crashed parent, failed storage write, or power loss may leave only the last
successful periodic snapshot (or null before the first flush). A 30-second period
is not a durability deadline: scheduling/storage stalls can delay it. The recent
window overwrites older detail even though aggregate counters remain. Timestamps
use the parent's wall clock, so clock adjustment can distort elapsed gaps; negative
observed gaps are clamped to zero. Never infer exact network timing or all-event
history from these samples.

## Verification

- `tests/runtime/stream-diagnostics.test.js`: phases; empty/whitespace/sparse
  deltas; long timestamp gaps; sensitive sentinels and unknown labels; 100000
  delta/unknown-event pairs plus refreshes; bounded prefix, window and JSON.
- `tests/runtime/pi-runtime-diagnostics.test.js`: real IPC fake hosts and isolated
  SQLite; live periodic persistence and abnormal finalization; continued feeding
  by empty/whitespace/thinking/text; subsequent stop-flow timeout; heartbeat-only
  silence; no added timer on silent reasoning/tools with existing limits disabled.
  These are time-scaled simulations, not a claim of a real 15-minute load test.
- `tests/runtime/pi-runtime.test.js`: baseline watchdog/completion/retry/recovery
  suite, with assertions for all four persisted refresh reasons.
- `tests/storage/run-store.test.js`: legacy migration, metadata independence,
  replacement semantics and hard size guard.

Run build, the above tests, SDK host tests, syntax checks and full typecheck before
handoff. Baseline typecheck failures must be reported separately, not declared a
pass or silently waived.
