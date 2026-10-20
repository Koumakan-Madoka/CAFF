# Turn Time Breakdown (单轮耗时分析)

## Scenario: Per-Turn Time Analysis for Agent Replies

### 1. Scope / Trigger

- Trigger: session goal "CAFF 可观测性加强" — every agent reply with tool
  steps gains a "耗时分析" button next to "查看观测时间线"
  (`public/chat/message-timeline.js`, trace toggle area), showing where the
  wall-clock time of that single turn (one trace) went.
- Applies when changes touch `server/domain/runtime/turn-time-breakdown.ts`
  (new), the pi-event classification hook in
  `server/domain/conversation/turn/agent-executor.ts` (and the event
  surfacing in `lib/pi-runtime.ts`), the secondary `tryAppendInvocationEvent`
  hook in `server/domain/runtime/agent-tool-bridge.ts`, the time-breakdown API
  controller, the migration additions in `storage/sqlite/migrations.ts`, or
  the breakdown button/panel in `public/chat/message-timeline.js`.
- In scope: single-trace observability only. Out of scope (goal non-goals):
  inter-turn wait analysis, room-level aggregation, alerting, agent prompt or
  behavior changes, historical bulk backfill, and JEV redaction (v1 sends raw
  command/output per the user's 2026-10-20 decision).

### 2. Terminology and Category Taxonomy

Every tool step and every wall-clock interval of a turn is attributed to
exactly one category (分类口径, committed decision `categories-v1`):

| Category | Subcategories | Definition |
| --- | --- | --- |
| `read` (读) | `cold-start-reread` (冷启动重读), `purposeful-lookup` (有目的查阅) | Reads of files, search, read-only git (`log`/`show`/`diff`/`status`). Reads before the turn's first repo-file mutation are `cold-start-reread`; afterwards `purposeful-lookup`. |
| `write` (改) | `product-code`, `test-code`, `docs-evidence` | Mutations of repo-tracked files: `edit`/`write` tools, bash redirections (`>`, `>>`), `sed -i`, `apply_patch`, `tee`. Path class decides the subcategory: `tests/**` → `test-code`; `docs/**`, `.agents/**` → `docs-evidence`; otherwise `product-code`. |
| `test` (测) | `targeted` (定向测试), `full-regression` (全量回归) | Test runner invocations. Records run count and failure count. |
| `build-check` (构建与检查) | — | `tsc`, `npm run build`, `npm run typecheck`, `npm run check`, `node --check` chains, linters. Not tests. |
| `process-report` (流程与汇报) | — | CAFF bridge tooling: `update-goal`, `suggest-goal`, `propose-plan`, `send-public`, `create-delegation`, `await-delegation`, `conversation_notify/request` (agent-chat-tools commands). |
| `thinking` (模型思考) | — | Wall-clock intervals inside the turn span with no tool execution running. Includes model generation and harness overhead; v1 cannot split further (documented, accepted). |
| `exception-retry` (异常与重试) | — | Two disjoint time sources: (a) tool steps that failed **before any semantic execution** (tool invocation errors, missing results, bridge errors) — the step never did read/write/test work, so no semantic category applies; (b) model-side error intervals: assistant messages with `stopReason = 'error'` (interval = previous trace event end → that row's timestamp), and pi-runtime watchdog/progress-timeout intervals. Source (b) is complete for live turns and best-effort for historical backfill — runtime-only events that never reached the session JSONL are simply absent, and the panel annotates `partial-*` accordingly. A failed *test run* stays in `test` (failure is signal); a failed *edit* that executed stays in `write`. |
| `unclassified` (未分类) | — | Rule classifier returned nothing and JEV was disabled, low-confidence, timed out, or errored. Never a hard guess. |

Turn-level metrics (also committed):

- `firstWriteMs`: turn span start (timestamp of the first trace event —
  the first assistant/model event of this turn's slice, not the user
  message) → the first step that mutates a repo-tracked file.
- `sessionReused` + `sessionReuseReason`: read directly from the turn's
  message metadata (`sessionReused` / `sessionReuseReason`, written by
  `agent-executor.ts` at turn start; reason codes `reused`, `busy_stale`,
  `claim_conflict`, `reuse_evaluation_error`, cursor-class reasons). This
  is the authoritative derivation already surfaced by the trace inspector
  and labeled by the frontend `sessionReuseReasonLabel` map — the breakdown
  panel must reuse the same codes and labels, never re-derive. History
  messages lacking the field display "无记录", never a guess.
  `sessionAssistantStartIndex` is used only as the §4 slice offset.
- `fullRunCount` / `fullRunFailCount`: per §5.

### 3. Time Attribution (resolves open question `q-parallel`)

- All accounting is wall clock. Per category, take the **union of its step
  execution intervals** — parallel tools never double-count.
- Overlapping steps of *different* categories: the overlapped slice is
  attributed by fixed priority `test > write > build-check > read >
  process-report > exception-retry > unclassified`. Rationale: proportional
  splitting assumes parallelism is uniformly shared, which distorts
  IO-wait-heavy steps; priority-on-union is deterministic, reproducible, and
  matches the committed "区间并集计、不重复计时". Model error/timeout
  intervals (§2 source (b)) are disjoint from tool intervals by
  construction — the model was not executing a tool while erroring — so
  their low priority position is defensive only.
- `thinking` = turn span minus the union of all tool execution intervals
  minus §2(b) error intervals. Turn span = timestamp of the first event of
  the trace (first model call or tool step) → timestamp of the last event;
  for a live turn, "now".

### 4. Data Sources and Step Extraction

- **Authoritative history**: pi session JSONL. Two extraction paths:
  - `readSessionAssistantSnapshot`
    (`server/domain/runtime/message-tool-trace.ts`) is reused **only** for
    model/usage events and the `sessionAssistantStartIndex` per-turn slice.
    It parses `role === 'assistant'` rows only; its `toolCalls` carry no
    timestamps and no output, so it cannot feed timing or classification.
  - A new step parser (`turn-time-breakdown.ts`) reads both row kinds:
    `tool_call` items inside assistant rows give each step's start (all
    tool_calls in one assistant message share that message's timestamp —
    parallel starts are expected and handled by §3 union), and
    `role === 'toolResult'` rows give the end `timestamp`, `toolCallId`,
    `toolName`, `content` (output), and `isError`. Interval = assistant
    message timestamp → matching toolResult timestamp, joined by
    `toolCallId`; a toolResult without a matching call is still recorded
    with end-only timing and flagged.
- **Real-time**: the pi event stream — `handle.on('pi_event', ...)` in
  `server/domain/conversation/turn/agent-executor.ts` receives
  `tool_execution_start` / `tool_execution_end` (`toolCallId`, `toolName`,
  `args`/`result`, `isError`; pi-sdk `ToolExecutionEndEvent`).
  `lib/pi-runtime.ts` currently consumes both only to maintain
  `activeToolCalls`; the pipeline surfaces them onward to the classifier
  sink. CAFF-native bridge tools that do not pass through the pi event
  stream remain covered by `tryAppendInvocationEvent`
  (`agent-tool-bridge.ts`). Dedup across both sources by `toolCallId`.
- Step identity: `(taskId, toolCallId)`. Session-derived steps without a
  `toolCallId` fall back to `(taskId, toolName, ordinal)`.
- Open intervals: a step without an end timestamp (missing result,
  interrupted turn) is clamped to the next trace event timestamp when one
  exists; otherwise it records `durationMs = NULL`, contributes nothing to
  the §3 union, and is flagged in the step list — open intervals never
  silently extend to "now".

### 5. Rule Classifier

Inputs: tool name, command argv (for `bash`), affected path class, CAFF tool
name, exit status, and command-output features. Evaluation order is fixed;
first hit wins:

1. CAFF bridge activity — both forms: CLI (`node .../agent-chat-tools.js
   <cmd>`) and native bridge tool names (`update-goal`, `suggest-goal`,
   `propose-plan`, `send-public`, `create-delegation`, `await-delegation`,
   `conversation_notify`, `conversation_request`) → `process-report`.
2. Test runners (`node --test`, `npm test`, `npm run test:*`, `vitest`,
   `jest`, `pytest`, `go test`, `cargo test`) → `test`. Output fingerprints
   (`# pass N`, `# fail N`, `tests N passed`, `N failing`, exit code) fill
   run/failure counters. Failed runs stay in `test`.
3. Build/check (`tsc`, `npm run build`, `npm run typecheck*`, `npm run
   check`, `node --check`, eslint) → `build-check`.
4. Mutations (`edit`/`write` tools; bash with `>`, `>>`, `sed -i`,
   `apply_patch`, `tee`, `mv`, `cp` targeting repo paths) → `write` with
   path-class subcategory decided by the **destination** path class.
5. Reads (`read`/`grep`/`find` tools, `ls`, `cat`, read-only git) → `read`
   with cold-start subcategory before the first write.
6. Infra failures with no semantic execution (invocation error, missing
   result) → `exception-retry`. Rules 2–5 deliberately run first: a step
   that *did* execute semantics (a test that ran and failed, an edit that
   applied) keeps its semantic category even when its exit status is a
   failure; only steps that never got to do semantic work fall through to
   this rule.
7. Otherwise → `null` (JEV fallback, §6).

**Full-regression vs targeted (resolves `q-fullrun`, part 1)**: an
invocation is `full-regression` when it matches the repo's canonical
full-suite entry — `npm test`, `npm run test:fast`, bare `node --test
tests/`, `npx vitest run`, bare `pytest` — with no path/file subset
arguments; path-scoped invocations (`node tests/runtime/foo.test.js`,
`pytest tests/x/`) are `targeted`. Wrapper scripts (`bash scripts/*.sh`,
`node scripts/*.js`, npm script chains not listed above) are opaque to
rules → JEV fallback with command + output. `fullRunCount` counts
`full-regression` invocations per turn; `fullRunFailCount` counts those
with non-zero exit or a fail fingerprint.

### 6. JEV Fallback

- Reuses `createTypeSafeClient`
  (`server/domain/integrations/typesafe/typesafe-client.ts`); no new
  external client.
- Trigger: rule classifier returned `null` (includes opaque wrapper
  scripts that actually run tests).
- Request: one `choice` question, options = the §2 categories; state =
  command + output. Output truncated **head 2000 + tail 2000 chars (4000
  max)** (resolves `q-fullrun`, part 2) to bound cost and latency; the
  client's own `maxStateChars`/`maxRequestChars` caps still apply.
- Latency policy: `timeoutMs = 8000` as the single overall deadline;
  `maxRetries` is left at the client default (passing 0 falls back to the
  default via `normalizePositiveInt`), so a transient failure may retry
  within the 8 s deadline and then still lands on the fallback path.
- Dedicated client: the pipeline constructs its own `createTypeSafeClient`
  instance with its own `maxRequests`/`tokenBudget`, never sharing the
  agent-tool-bridge instance — classification volume must not consume the
  bridge's process-local budget.
- Low confidence (< 0.6) or choice `unclassified` → `unclassified`, never a
  hard guess.
- Cache: `sha256(toolName + argv[0] + flags-only(argv) + output
  fingerprint)` → category, in `jev_classification_cache`; cache hits skip
  the network entirely.
- Switch: JEV runs only when `TYPESAFE_API_KEY` is configured **and** the
  per-project config `timeBreakdown.jevEnabled` (system service config
  store) is true; default **false** → rules only (open question
  `q-jev-config`: wiring waits for credential/config confirmation).
- Failure/timeout/disabled: step stored as `unclassified` with
  `jevStatus = 'ok' | 'timeout' | 'error' | 'disabled' | 'low-confidence'`;
  never blocks, never throws into the turn path. A later pass (next view
  click) may reclassify `timeout`/`error` steps via cache or a fresh call.

### 7. Storage Schema (new migration)

```sql
CREATE TABLE IF NOT EXISTS chat_turn_time_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  message_id TEXT,
  step_key TEXT NOT NULL,           -- toolCallId or toolName:ordinal
  tool_name TEXT NOT NULL,
  category TEXT NOT NULL,           -- §2 taxonomy
  subcategory TEXT,
  classified_by TEXT NOT NULL,      -- 'rules' | 'jev' | 'jev-cache' | 'unclassified'
  jev_status TEXT,                  -- §6 enum, NULL when classified by rules
  confidence REAL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  run_kind TEXT,                    -- 'targeted' | 'full-regression' | NULL
  run_failed INTEGER,               -- 0/1/NULL
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, step_key)
);

CREATE TABLE IF NOT EXISTS chat_turn_time_summaries (
  message_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'live' | 'complete' | 'partial-truncated' | 'partial-interrupted'
  turn_started_at TEXT,
  turn_ended_at TEXT,
  category_ms_json TEXT NOT NULL,   -- {category: ms} after §3 attribution
  metrics_json TEXT NOT NULL,       -- firstWriteMs, sessionReused(+Reason), fullRunCount, fullRunFailCount
  parse_offset INTEGER,             -- JSONL byte offset for incremental re-parse
  computed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jev_classification_cache (
  cache_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);
```

### 8. Real-Time Pipeline

- Hook: the pi event stream (`handle.on('pi_event', ...)`,
  `agent-executor.ts`). On `tool_execution_end` (start/end pair gives the
  interval) the pipeline enqueues `{taskId, messageId, toolCallId,
  toolName, args, result, isError, startedAt, endedAt}` onto an in-process
  async queue; `tryAppendInvocationEvent` in `agent-tool-bridge.ts` remains
  the secondary hook for CAFF-native bridge tools absent from the pi
  stream. The turn path **never awaits** classification; the queue timer is
  `unref`'d and must never keep the process alive (same contract as the
  observability sampler).
- Summary lifecycle: the first classified step of a task inserts the
  `chat_turn_time_summaries` row with `status = 'live'`; every subsequent
  step updates it incrementally, so an in-progress turn is refreshable
  (AC1). Task completion flips it to `complete`; a missing terminal event
  yields `partial-interrupted` and the panel says so.
- Worker: rule-classify → upsert `chat_turn_time_steps`; JEV-needed steps
  are stored `unclassified` + pending, then resolved asynchronously and
  updated in place.
- Queue overflow (depth cap, default 256): drop with a counter; affected
  turns are completed by lazy backfill on next view click. Dropped steps
  must never lose the underlying event — only the classification.

### 9. API and Lazy Backfill

- `GET /api/conversations/:conversationId/messages/:messageId/time-breakdown`
  → `{ status, categoryMs, metrics, steps[] , computedAt }`.
- Fresh summary row → return as-is (cached path target: < 2 s).
- No/stale row → locate `message → task → session_path +
  sessionAssistantStartIndex`, parse the JSONL from `parse_offset` with the
  §4 step parser (assistant `tool_call` starts joined to `toolResult`
  ends), classify
  with **rules + JEV cache only** (fresh JEV calls are excluded from the
  synchronous backfill so multi-MB logs finish < 10 s; pending steps are
  marked and resolved asynchronously), upsert rows, return.
- Truncated/corrupt JSONL lines are skipped and flip status to
  `partial-truncated`; the panel annotates honestly. No full historical
  backfill — only on click (goal non-goal `ng-backfill`).

### 10. Frontend

- "耗时分析" button beside the trace toggle in `message-timeline.js`,
  rendered when the message has tool steps or an existing breakdown.
- Panel: per-category duration bars (ms + %), metrics row (首次改文件时间,
  会话复用及原因, 全量回归遍数/失败次数), and the step list with category
  labels. In-progress turns expose a refresh action that re-fetches the
  latest stored rows.
- Token usage display (open question `q-tokens`): v1 does **not** show
  token consumption by default; the panel gains it only after the user
  confirms the open question. The API may already carry the fields so
  enabling is display-only.

### 11. Validation & Error Matrix

| Case | Expected behavior |
| --- | --- |
| pi_event `tool_execution_end` arrives | step classified async; turn path never awaits; summary row live-updates |
| one logical step seen via both pi event and bridge event | dedup by `toolCallId`; bridge calls with distinct `toolCallId`s are separate steps under §3 union — never double-counted |
| rules classify a step | row upserted `classified_by='rules'`, no JEV call |
| opaque wrapper script, JEV on, confident | `classified_by='jev'`, cache row written |
| same command features again | `classified_by='jev-cache'`, zero network calls |
| JEV timeout / error / low-confidence / disabled | `unclassified` + correct `jev_status`; turn unaffected |
| classification worker throws | logged, turn path never sees it |
| queue overflow | step events kept in `a2a_task_events`; classification dropped + counted; lazy backfill repairs |
| cached summary read | API < 2 s |
| multi-MB JSONL lazy backfill | < 10 s excluding JEV waits; `partial-*` flags honest |
| interrupted turn (no terminal event) | `partial-interrupted`, panel annotates |
| JEV off (default) | rules only; no `TYPESAFE_API_KEY` access attempted |

### 12. Tests Required

- `tests/runtime/turn-time-breakdown-parser.test.js`: §4 step parser —
  assistant `tool_call` ↔ `toolResult` join by `toolCallId`, parallel
  shared starts, orphan toolResults, truncated/corrupt lines,
  `sessionAssistantStartIndex` slicing, incremental `parse_offset`.
- `tests/runtime/turn-time-breakdown-rules.test.js`: every §5 branch,
  path classes, cold-start vs purposeful reads, full vs targeted
  fingerprints, exception-retry vs failed-test distinction, both bridge
  forms (CLI and native tool names).
- `tests/runtime/turn-time-breakdown-attribution.test.js`: parallel
  interval union, priority slicing, thinking-time gaps, model error
  intervals → `exception-retry`.
- `tests/runtime/turn-time-breakdown-jev.test.js`: fake JEV covering
  success / timeout / error / low-confidence / disabled; cache hit;
  truncation length; no turn-path blocking.
- `tests/storage/turn-time-breakdown-store.test.js`: migration, upsert
  idempotence, summary lifecycle.
- `tests/http/turn-time-breakdown-controller.test.js`: cached read, lazy
  backfill, `partial-*` statuses, error mapping.
- `tests/ui/turn-time-breakdown.test.js`: button visibility, panel
  rendering, in-progress refresh.
- Golden-sample regression (goal AC3) and replay-vs-retrospective script
  (AC4) land with W6.

### 13. Wrong vs Correct

#### Wrong

```ts
// Blocking the turn on JEV; hard-guessing on low confidence.
const category = await jev.ask(...);           // agent stalls 8 s per step
return category || 'read';                     // fabricated attribution
```

#### Correct

```ts
// Fire-and-forget enqueue; unclassified is honest and repairable.
classificationQueue.enqueue({ taskId, messageId, payload });  // never awaited
// worker: rules first; JEV miss/timeout/low-confidence →
// upsert(..., { category: 'unclassified', jevStatus: 'timeout' })
```
