# Agent Metrics (Bounded Window & Projections)

## Scenario: `/api/metrics/agent` Bounded Window (OOM Safety)

### 1. Scope / Trigger
- Trigger: the develop OOM remediation plan P1A — unfiltered `/api/metrics/agent` requests materialized all matching `chat_messages` rows (including full `metadata_json`) plus all matching `a2a_task_events` rows for the whole call; production shape is 15,052 messages / 373MB `metadata_json` / 484K task events, so one unbounded request could reach multi-GB live sets.
- Applies when changes touch `server/api/metrics-controller.ts`, `server/domain/metrics/agent-eval-report.ts`, `public/metrics.js`, or any consumer of the agent metrics report.

### 2. Signatures
- `validateAgentMetricsWindow(sinceInput, untilInput): { message } | null` (shared by HTTP controller; exported from `agent-eval-report.ts`)
  - Both boundaries are required; each must be a `YYYY-MM-DD` date or an ISO 8601 datetime (`YYYY-MM-DD` optionally with `THH:MM[:SS[.mmm]]` and `Z|±HH:MM`); `until` must be strictly after `since`; the span must be ≤ 31 days.
  - Impossible calendar dates (e.g. `2026-02-31`, `2026-04-31`, day/month zero) are rejected — `Date.parse` would silently normalize them through the legacy parser, so validation round-trips the date components through `Date.UTC` and compares them.
  - Every accepted boundary normalizes to a canonical UTC instant (`...Z`, millisecond precision): date-only `since` → that day's midnight; date-only `until` → the exclusive end of that day (next midnight UTC) so "that day" stays inclusive, matching the query's `created_at < @until` semantics; datetimes with `Z` or `±HH:MM` offsets convert to their UTC instant (raw offset strings do not share lexical order with persisted UTC `created_at`, so TEXT comparison of raw offsets mis-selects rows); zone-less datetimes are defined as UTC wall-clock time (matching the baseline lexical behavior).
- `buildAgentEvalReport(db, options)` keeps its aggregate output shape (per-agent turns/completed/failed, expectations tp/fp/fn/tn for send-public/send-private, tool calls/succeeded/failed with p50/p95 durations) while selecting only bounded projections:
  - Message query: scalar columns (`agent_id`, `sender_name`, `status`, `task_id`) plus `json_valid`-guarded projections for `publicToolUsed` (`json_extract`) and the three count fields (`publicPostCount`, `privatePostCount`, `privateHandoffCount` — `json_extract` nested under a `json_type(...) IN ('integer','real')` CASE so only JSON numbers survive). Never `SELECT m.*`, never raw `metadata_json` in the select list.
  - Event queries (split by family so each result row carries only its own columns — a combined projection gave all 484k+ event rows property slots for both families and broke the concurrent-report RSS budget):
    - Expectations query (`event_type = 'agent_expectations'`): `root_truthy`, `expectations` type, and `send-public`/`send-private` values plus compact integer type codes.
    - Tool-call query (`event_type = 'agent_tool_call'`): `root_truthy`, `tool`/`status` values plus compact integer type codes, and `durationMs` gated to JSON numbers.
    - Both filter `task_id IN (task ids from the message window)`; a SQL-level `root_truthy` CASE reproduces the baseline JSON truthiness semantics (object/array/true truthy; text truthy when longer than 2 chars; numbers truthy when non-zero). Never materializes `event_json`.
  - Type codes are compact integers (1=text, 2=integer, 3=real, 4=true, 5=false, 6=object, 7=array; 0=null/missing), not `json_type()` strings: string columns cost ~50 bytes per value on 484k-row result sets and broke the RSS budget as integers do not.
  - JS-side reconstruction (`jsonJsValue`) rebuilds the parsed value behind each projection so the frozen baseline expressions keep their exact `JSON.parse` semantics: `String(object)` → `'[object Object]'`, `String(array)` → its `join(',')` (only the small projected subtree is reparsed), `String(true)` → `'true'`; boolean counts never count (SQLite folds JSON true/false into 1/0, baseline `Number.isInteger(true)` is false); `durationMs: true` never enters the latency percentiles (baseline `Number.isFinite(true)` is false).
  - Malformed JSON degrades to defaults exactly as the baseline did (guards via `json_valid`).

### 3. Contracts
- HTTP `/api/metrics/agent` requires both `since` and `until`; missing, one-sided, malformed, reversed, or >31-day windows return `400` with stable error code `metrics_agent_window_invalid`. There is **no silent server-side default window** — a partial request must fail loudly rather than return data that looks complete.
- This dual-boundary requirement is an intentional compatibility break; every browser and smoke consumer must be updated in the same change. `public/metrics.js` initializes both controls to the last seven complete days (since = 7 days ago, until = yesterday), always sends both boundaries (empty inputs fall back to the default window), and its clear/reset action restores the default window instead of issuing an unbounded request. The report echoes the effective boundaries.
- The offline CLI (`scripts/agent-eval-report.js`) retains explicit unbounded mode: with no since/until it reports the full history and echoes `since`/`until` as null. Only the HTTP path is bounded.
- Message rows and event rows must not be retained as raw/unbounded materialized objects for the whole call; per-row processing consumes bounded projections. A regression guard asserts that reading the raw `metadata_json`/`event_json` columns (poisoned via throwing getters on better-sqlite3 rows) never happens.
- Aggregate semantics are frozen: the bounded report must produce byte-identical aggregates to the baseline for the same window (locked by semantic-lock tests that run green against both the baseline and new implementation).

### 4. Validation & Error Matrix
| Request | Expected result |
| --- | --- |
| no `since`/`until` | 400 `metrics_agent_window_invalid` ("require both since and until boundaries") |
| only `since` or only `until` | 400 `metrics_agent_window_invalid` |
| non-date / non-ISO garbage boundary | 400 `metrics_agent_window_invalid` |
| impossible calendar date (`2026-02-30/31`, `2026-04-31`, `2026-08-00`, month 0/13, datetime with a lying date part) | 400 `metrics_agent_window_invalid` |
| `until` before or equal to `since` | 400 `metrics_agent_window_invalid` |
| span > 31 days (e.g. 32 or 60 days) | 400 `metrics_agent_window_invalid` |
| 31-day date-only window | 200; until date inclusive (normalized to next midnight UTC) |
| timezone-offset boundaries (`+08:00`) | 200; rows selected by UTC instant, not raw string order |
| zone-less datetime boundaries | 200; treated as UTC wall-clock time (baseline lexical semantics) |
| full ISO datetime window ≤ 31 days | 200; report echoes effective boundaries |
| valid window with malformed `metadata_json`/`event_json` rows | 200; affected values degrade to defaults (baseline behavior) |
| valid window with boolean/object/array count, tool, status, or duration values | 200; aggregates match baseline JS type semantics exactly (booleans never count, object tool buckets as `[object Object]`, array status/expectations stringify to their join) |
| CLI invocation without boundaries | full-history report; `report.since`/`report.until` are null |
| CLI invocation with an invalid boundary | process exits with a clear error (no silent normalization) |

### 5. Tests Required
- `tests/http/metrics-agent-window.test.js`: red window-contract tests (missing/one-sided each side/reversed/32-day/60-day/malformed → 400), impossible-calendar-date rejections, offset-boundary UTC selection (a row at `04:00Z` must be inside `[+08:00, +08:00)` boundaries that equal `[00:00Z, next-day 00:00Z)`), zone-less-as-UTC locks, plus green semantic locks (31-day date-only and ISO datetime windows echo boundaries and count only in-window messages) and the CLI explicit-unbounded lock.
- `tests/runtime/agent-eval-report.test.js`: raw-column poison guard (throwing getters on `metadata_json`/`event_json` regardless of column alias), aggregate equivalence, malformed-JSON degradation, baseline JS type semantics for projected values (boolean counts/durations, object/array/true tool names, array status/expectations stringification, integral reals), expectations/tool projection semantics.
- `scripts/p1-metrics-sse-gate.js` scenario `metrics-31d-bounded`: production-shape synthetic seed (256 conversations / 15,076 messages / 369.5MiB metadata / 484,602 task events inside one 31-day window) verifies exact aggregate parity field-by-field, a SQL/row-level projection guard (rejects `SELECT *` and bare `metadata_json`/`event_json` materialization), peak RSS delta ≤ 512MiB, and bounded latency; scenario `concurrent-metrics-sse` re-verifies the same aggregates under 5 parallel reports with its own RSS budget.
- Smoke: `/api/metrics/agent` consumers send the 7-day default window and assert an unbounded request yields 400.

### 6. Wrong vs Correct
#### Wrong
```ts
// Unfiltered request materializes everything, including raw metadata blobs.
const messages = db.prepare('SELECT * FROM chat_messages WHERE ...').all(params); // row.metadata_json (up to ~323KB per row)
const events = db.prepare('SELECT * FROM a2a_task_events WHERE ...').all(params); // row.event_json
```

#### Correct
```ts
// HTTP layer: loud validation, no default window.
const windowError = validateAgentMetricsWindow(since, until);
if (windowError) throw createHttpError(400, windowError.message, { code: 'metrics_agent_window_invalid' });
// Query layer: bounded projections only.
SELECT m.agent_id, m.sender_name, m.status, m.task_id,
  CASE WHEN json_valid(m.metadata_json) THEN json_extract(m.metadata_json, '$.publicToolUsed') END AS public_tool_used, ...
```
