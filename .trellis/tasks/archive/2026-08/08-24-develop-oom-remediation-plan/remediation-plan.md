# Staged OOM Remediation Plan

## Executive Decision

Ship the confirmed memory health/backfill fix as a small P0 with no schema or UI response change. Do not bundle metrics, SSE, runtime query redesign, or metadata migration into that emergency patch. Each later risk gets an independently measurable and reversible change.

Recommended delivery order:

1. P0A: memory health/backfill no-message projection.
2. P1A: bounded HTTP metrics window and query projection.
3. P1B: SSE backpressure and diagnostics.
4. P2A: Goal/queue targeted queries.
5. P2B: bounded prompt/history projection per turn and hop.
6. P2C: model usage/context snapshot storage compatibility and optional offline compaction.

P0 should be a sequential Goal because it is one root-cause chain. P1A and P1B can become parallel DAG nodes after P0 acceptance. P2 should start only after repository query contracts are reviewed.

## P0A: Memory Health And Backfill

### Exact Behavior Contract

#### `ChatAppStore.getSummaryMemoryHealth()`

- Global mode consumes existing `listConversations()` header projections directly. This still materializes and parses one header per conversation, including bounded digest metadata, but never message rows; the production-shape heap/RSS gate below is the acceptance bound for that deliberate P0 scope.
- It must not call `getConversation()` or `listMessages()`.
- It must not build a second array of conversation objects; process each returned header immediately and retain only counters plus the already bounded `unsyncedDigests` list.
- Scoped mode uses `getConversationWithoutMessages()` so missing id diagnostics remain unchanged.
- Existing ledger/search self-test and per-digest `getBySourceDigestId` error handling remain unchanged.

#### `backfillConversationDigestSummarySegments()`

- Global mode iterates existing conversation headers and processes each header immediately.
- Scoped mode uses `getConversationWithoutMessages()` and preserves `404 Conversation not found`.
- It must not accumulate hydrated conversations.
- It preserves one request timestamp, explicit `taskName` precedence, per-digest continue-on-error, bounded `failures`, and idempotent upsert behavior.

#### `ChatAppStore.saveSummarySegmentFromDigest()`

- Conversation existence/title lookup uses `getConversationWithoutMessages()` or an equivalent no-message row projection.
- It must not call `listMessages()` either directly or through `getConversation()`.
- Stored segment fields, search text, task attribution, timestamps, and errors remain byte-for-byte compatible for the same input.

### API Compatibility

No route, request field, HTTP status, or response field changes in P0:

- `GET /api/memory/health?conversationId=...`
- `POST /api/memory/backfill { conversationId?, taskName? }`
- Health statuses remain `ok`, `needs_backfill`, and `unavailable`.
- Backfill keeps `{ conversationCount, digestCount, segmentCount, failedCount, failures }`.
- `unsyncedDigests` and `failures` keep their existing bounded limits and reason strings.
- The drawer continues to run global health on open. P0 makes that operation safe rather than hiding global state.

### Failure Semantics

| Case | Required result |
| --- | --- |
| scoped conversation missing | health diagnostic or backfill 404, matching current behavior |
| summary ledger/search unavailable | health `status='unavailable'`, no fake empty success |
| source digest lookup throws | increment unsynced count; bounded `lookup_failed` detail |
| one backfill digest write fails | continue other digests; increment `failedCount`; bounded `sync_failed` detail |
| repeated backfill | no duplicate `source_digest_id`; response counts remain valid |
| zero conversations/digests | successful zero counts, no message read |

### Expected Change Surface

- `lib/chat-app-store.ts`
- `server/domain/conversation/conversation-digest.ts`
- `tests/smoke/server-smoke.test.js` or a new focused memory-health regression suite
- `.trellis/spec/backend/summary-memory.md`

`server/api/memory-controller.ts` and the browser should require no behavior change.

### Required Red Tests

1. Instrument a real SQLite store so `listMessages()` throws; global health must currently fail and the fixed path must succeed with exact counts.
2. Repeat for scoped health.
3. Repeat for global and scoped backfill.
4. Call `saveSummarySegmentFromDigest()` directly with `listMessages()` forbidden.
5. Seed multiple conversations and digests; assert processing order does not affect counts and only the bounded detail list is retained.
6. Inject one digest write failure; assert later conversations still backfill.
7. Assert a second backfill creates no duplicate rows.

The negative assertion is an architectural contract: message history reads are forbidden, not merely absent in the current implementation.

## P1A: Bound Agent Metrics

### Server HTTP Policy

- `/api/metrics/agent` requires both `since` and `until`.
- The inclusive date window may cover at most 31 days.
- Missing, one-sided, reversed, or oversized ranges return 400 with a stable error code/message.
- `public/metrics.js` initializes both controls to the last seven complete days and always sends them.
- The report echoes the effective boundaries so the UI never labels a bounded result as `Range: all`.
- Requiring both HTTP boundaries is an intentional compatibility break for direct/bookmarked API calls. Update browser and smoke consumers in the same P1A change; do not silently apply a server default that could be mistaken for an all-time report.

### Offline Compatibility

`scripts/agent-eval-report.js` remains an explicit local operator tool and may retain unbounded mode. This separates an interactive server safety boundary from offline batch analysis.

### Query Plan

1. First patch: enforce the HTTP window and select only metadata fields actually used by the report.
2. Follow-up: move boolean/count extraction to SQLite `json_extract`/aggregation where available; query only the bounded event rows for selected task ids and dates.
3. Preserve the missing `a2a_task_events` fallback and exact aggregate semantics.

### Tests

- no HTTP range -> 400;
- one-sided or >31-day range -> 400;
- seven-day UI default -> bounded request;
- date-only `until` remains inclusive;
- CLI unbounded mode remains functional;
- production-shape 31-day report stays within the memory budget below.

## P1B: SSE Backpressure

### Transport Contract

- Serialize each SSE event frame once. A frame is written to each ready response at most once.
- Treat `res.write(frame) === false` as a backpressure signal, not proof that the client is dead. Mark the client blocked, arm a five-second drain deadline, and stop writing later frames directly until `drain` clears the state. Each new blocked episode gets a fresh five-second deadline; clear the prior timer on `drain`, close, error, or removal.
- Maintain at most one bounded per-client FIFO whose queued frame bytes plus `res.writableLength` never exceed 2 MiB. Check the combined budget before every direct write or enqueue. A single frame larger than 2 MiB removes the client before that frame is written, even when its buffers are otherwise empty.
- On `drain`, flush the FIFO in order until it is empty or another write returns `false`. Do not enqueue the frame that first returned `false`; Node already accepted it into the response buffer. If a flush write returns `false`, enter a new blocked episode and re-arm the deadline without duplicating that accepted frame.
- Remove and end/destroy the client only when the 2 MiB combined budget would be exceeded, the five-second drain deadline expires, or the response closes/errors. Prelude, initial events, normal events, and keepalives use the same accounting before the client is admitted or retained.
- Keep normal event ids, event names, conversation filtering, initial events, and pings compatible. The server may send a bounded EventSource `retry` value for standards-compatible consumers, but the shipped browser currently closes errored streams and reconnects manually after 1.5 seconds; P1B preserves that bounded client delay rather than relying on `retry:` for reconnect throttling.
- CAFF does not currently consume `Last-Event-ID` or replay missed SSE events, so P1B includes a minimal browser recovery change. After an errored stream successfully reopens, but not on the initial connection, coalesce one authoritative `refreshAll(selectedConversationId)` call to refresh bootstrap/conversation-list/runtime state and the selected conversation through HTTP. Repeated opens while that recovery refresh is in flight must not start parallel refreshes. The implementation must not claim at-least-once event delivery.
- Track bounded diagnostics: active client count, clients currently backpressured, slow-client disconnects by byte-budget/timeout reason, queued frame bytes, and aggregate `writableLength`. Do not log payloads.

### Tests

- a normal client gets one correctly formatted frame;
- a healthy client may return `false` during a burst of large frames, emit `drain` within five seconds, receive the queued frames in order, and remain connected; the fake response must increment `writableLength` for accepted buffered bytes, return `false` after crossing its modeled high-water mark, then reduce `writableLength` before emitting `drain`;
- a flush that returns `false` starts a fresh five-second blocked episode without duplicating or reordering frames;
- a single frame over 2 MiB removes the client before `write()` receives that frame;
- a permanently blocked client is removed when the 2 MiB combined budget is exceeded and receives no later write;
- a client below the byte budget but without `drain` is removed after five seconds;
- keepalive, prelude, and initial events follow the same budget/deadline rule;
- the first stream open does not duplicate bootstrap loading; an open after an error coalesces exactly one `refreshAll(selectedConversationId)` while recovery is in flight, and a turn that completed during the disconnect is visible afterward without replaying missed event ids;
- the existing 1.5-second manual reconnect delay remains bounded; a server `retry:` field is not treated as controlling the shipped client's reconnect loop;
- 100 connect/close/reconnect cycles leave zero clients, pending frames, listeners, and timers;
- a permanently blocked client under 10,000 large events does not grow RSS beyond the budget.

## P2A: Goal And Queue Targeted Queries

### Query Contracts

- `enqueueGoalContinuationMessage()` uses `getConversationWithoutMessages()` for roster, Goal, and proposal checks.
- Add a repository query for pending main-lane user messages after the durable cursor, excluding `metadata.dispatchLane='side'` in SQL.
- Add targeted lookup for cursor/message ids instead of scanning a full conversation for each helper call.
- Startup cursor inference gets a dedicated query; it must preserve the current trailing-user and explicit-empty-cursor semantics.
- Queue counts and deletion reconciliation remain ordered by persisted `(createdAt,id)`.

### Acceptance

- Goal continuation decision performs zero full conversation hydrations.
- Queue depth/pending discovery returns exactly the same ids as current logic across restart, side lane, deletion, failed batch, and explicit empty cursor tests.
- No change to Goal owner, auto-pause, Stop, or dispatch behavior.

## P2B: Bounded Turn/Prompt Projection

The prompt formatter renders only the last 24 history messages, but routing currently parses the entire history before slicing. Replace that with purpose-specific projections:

- latest qualifying public assistant reply for default routing;
- selected queued batch rows;
- bounded prompt history window plus current-turn rows;
- message ids required by side-lane snapshots;
- final conversation header and newly completed replies.

Do not simply cache one full hydration for the turn. That reduces repeated parsing but still keeps a 100-200 MB object graph alive for up to three hours. The target contract is a bounded object graph whose size depends on prompt limits/current turn, not total conversation history.

Required compatibility tests cover default-last-Agent ordering, image preflight, private visibility, current-turn incomplete-message exclusion, side snapshots, handoffs, parallel mentions, Stop, Goal continuation, and restart recovery.

## P2C: Persisted Metadata Growth

### `modelUsage.calls`

- Keep exact total aggregates: `modelCallCount`, cold-start count, post-cold count, provider miss count, and aggregate token/cost values.
- Persist at most 64 detailed call rows: the first cold-start row plus the most recent 63 calls.
- Add `callsTruncated: true` and `retainedCallCount` when details were clipped; preserve original sequence numbers.
- UI/tool trace shows aggregate totals and labels the detailed timeline as truncated.

### `agentContextSnapshot`

- New writes store the full snapshot in a dedicated message-id keyed SQLite table, not ordinary `chat_messages.metadata_json`.
- Message metadata stores only a small availability/version marker.
- The existing context-inspector endpoint reads the new store first and falls back to legacy metadata, so old rows remain readable.
- Normal message list and runtime prompt projections never fetch snapshot blobs.

### Database Compatibility And Compaction

- Use an expand/contract rollout. The expand release creates the empty table, reads both layouts, and still writes legacy metadata; it is the rollback floor for later steps.
- After expand acceptance, the contract release writes snapshots to the new table plus a small metadata marker and stops embedding the full snapshot in new message metadata.
- A contract-release rollback targets the expand release, not a pre-migration binary that cannot read the new table. The plan must pin and retain that compatibility SHA.
- Historical extraction/rewrite is an explicit offline command with dry-run, batch size, checkpoint, transaction-per-batch, disk-space preflight, backup requirement, and idempotent resume.
- Do not run compaction automatically on 3100.
- Old rows remain readable throughout. Rewriting old rows or dropping legacy fields is blocked until the compatibility window, reverse-read tests, and user-authorized backup/rollback drill are complete.

## Synthetic Production-Shape Dataset

Default validation uses non-sensitive synthetic data, not a production database copy:

- 256 conversations;
- 15,052 messages;
- about 9.7 MB total content;
- about 373 MB total metadata JSON;
- 5,819 assistant rows with nested context snapshots and model usage;
- one conversation near 93.5 MB raw message projection;
- about 484,000 synthetic task events for metrics tests;
- bounded digest metadata on representative conversations; the shape manifest records the exact digest count and per-conversation distribution used for the 120-second backfill budget.

The generator must be deterministic, gitignored, and disposable. A real production copy requires separate explicit user authorization, isolated credentials/ports/logs, read-only source copying, and deletion approval after validation.

## Performance Acceptance Matrix

Measurements run in a disposable child process on the same Node major/ABI as production. Wrap per-digest repository calls to sample `process.memoryUsage()` inside synchronous loops, and sample child RSS externally every 100 ms. Use `--expose-gc` only in validation to measure retained heap after an explicit collection.

| Scenario | Required result |
| --- | --- |
| P0 global health, full synthetic seed | zero `listMessages`; correct counts; peak heap delta <=128 MiB; peak RSS delta <=256 MiB; completes <=10 s |
| P0 scoped health on largest conversation | zero `listMessages`; same response semantics; peak heap delta <=64 MiB; completes <=2 s |
| P0 global backfill then idempotent repeat | zero `listMessages`; no duplicate segments; peak heap delta <=128 MiB; peak RSS delta <=256 MiB; each request completes <=120 s |
| 20 sequential health calls | no 5xx/OOM; post-GC retained heap delta <=32 MiB from warm baseline |
| 8 concurrent HTTP health requests | all succeed; peak RSS delta <=320 MiB; no retained growth after completion |
| bounded 31-day metrics report | exact aggregates; peak RSS delta <=512 MiB |
| healthy SSE client, burst of 6 x 256 KiB events with timely drain | may observe `write() === false`; remains connected; receives frames in order; queued bytes return to zero |
| blocked SSE client, 10,000 x 256 KiB events | client dropped when the 2 MiB combined budget or five-second drain deadline is reached; peak RSS delta <=64 MiB; no writes after removal |
| mixed Goal + memory health 8-hour soak | peak RSS <1.5 GiB; after warm-up, heap trend <=5 MiB/hour and RSS trend <=20 MiB/hour; no monotonic climb to limit |

Thresholds are stop gates, not targets to relax after failure. If the synthetic generator or reference hardware makes one threshold invalid, the implementation PR must document a revised measured baseline and obtain reviewer/user approval before acceptance.

## Functional Regression Matrix

- health: ok / needs_backfill / unavailable / scoped missing conversation;
- backfill: zero digests / explicit task / partial failure / idempotent repeat;
- digest create/compact/delete segment synchronization;
- metrics: range validation, aggregates, missing event table;
- SSE: normal, filtered, initial, ping, close, backpressure;
- Goal: owner/no-owner/removed-owner, pending proposal, continuation budget;
- queue: restart, side lane, cursor deletion reconciliation, failed pending batch;
- runtime: serial/parallel/handoff/private/Stop/image prompt snapshots;
- metadata: old rows, new rows, mixed layout, truncated call timeline, context endpoint fallback.

## Isolation And Validation Environment

- Use the room worktree at the exact candidate SHA.
- Use a dedicated acceptance port, SQLite path, log directory, and gitignored synthetic seed.
- Disable Feishu and all external outbound delivery.
- P0 health/backfill tests require no model credentials.
- Do not attach the acceptance instance to production SQLite.
- Record candidate SHA, database checksum/shape manifest, Node version, command, peak metrics, and response checksums.
- Heap snapshots are allowed only in a disposable isolated instance with at least 2x current heap free disk/RAM and an explicit stop budget. Prefer allocation sampling and counters first.

## Gray Rollout

1. Merge only the independently reviewed P0 candidate to `develop` using a merge commit.
2. Start an isolated integration instance from the merged tree and rerun the synthetic gates.
3. Schedule the 3100 restart in a quiet window; preserve the prior merge SHA and logs.
4. Keep the memory/summary panel operationally avoided until baseline memory is recorded for 15 minutes.
5. Open the memory drawer once from one browser, verify health response and process memory, then repeat five times.
6. Observe every 30 seconds for one hour, then hourly for 24 hours: RSS, heapUsed/heapTotal, external/arrayBuffers, active turns/invocations, SSE clients/writable bytes, endpoint latency/status.
7. Remove the temporary panel avoidance only after the controlled request and one-hour window pass.

## Rollback

P0 has no schema or destructive data change. Rollback is a normal revert of the P0 merge commit followed by restart. Backfill writes are idempotent summary-segment upserts and do not need reversal.

Immediate rollback/stop conditions:

- health/backfill count or status differs from the pre-deploy fixture;
- any request causes a >500 MiB RSS rise within 15 minutes;
- RSS exceeds 1.5 GiB during the controlled panel test;
- 5xx, event-loop stall, SQLite integrity failure, or repeated restart;
- memory remains monotonically increasing after requests finish.

After rollback, reinstate the operational panel/backfill avoidance and investigate only in an isolated instance.

## Temporary Production Mitigation

Until P0 is accepted:

- do not open the long-term memory drawer on 3100;
- do not run global memory backfill;
- do not open metrics without a narrow explicit date range;
- close unused CAFF browser tabs to reduce SSE exposure;
- sample process RSS/working set and retain crash/GC logs;
- do not raise the heap ceiling as the remedy;
- do not capture a near-limit heap snapshot on 3100.

If another restart shows rapid monotonic growth without panel activity, stop treating memory health as the only trigger and prioritize SSE/metrics/turn retainer evidence in an isolated clone.

## Independent Architecture Review

The exact planning commit `a2d37135ff7731123fd7d8d52b5543ab2792d32b` received an independent read-only architecture review with no blocking findings. The review confirmed the three P0 hydration paths, header-projection sufficiency, API/failure compatibility, P2 expand/contract direction, synthetic isolation, and rollout/rollback gates.

The review's first medium finding rejected immediate disconnect on the first `write() === false`: a healthy response can cross Node's high-water mark on one large frame. P1B above now uses a 2 MiB combined buffer budget plus a five-second per-blocked-episode drain deadline and includes a healthy burst/drain test. Low findings are also reflected above: the metrics HTTP break is explicit, header metadata remains measured by the P0 budget, and the synthetic manifest records digest cardinality.

A focused re-review of that revision confirmed the transport accounting but found that the existing browser does not refresh authoritative state on SSE `open`: it manually reconnects after 1.5 seconds and refreshes state only when later events arrive. P1B now explicitly includes a coalesced HTTP state refresh after a reconnect, while preserving no-replay semantics. The same revision also makes oversized-frame rejection, deadline re-arming, and realistic `writableLength` test modeling explicit.

Because these edits resolve the focused re-review findings, the new exact commit must receive one final focused independent confirmation before user confirmation.

## Review And Implementation Gate

This plan is complete only after:

1. an independent reviewer checks the exact planning commit for missed hydration paths, API compatibility, realistic budgets, and rollback safety;
2. findings are resolved or explicitly accepted;
3. the user confirms the reviewed plan;
4. a new implementation Goal is created for P0 only.

No implementation commit, production operation, or P1/P2 bundling is authorized by this document.
