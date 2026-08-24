# Agent Metrics (Bounded Window & Projections)

## Scenario: `/api/metrics/agent` Bounded Window (OOM Safety)

### 1. Scope / Trigger
- Trigger: the develop OOM remediation plan P1A — unfiltered `/api/metrics/agent` requests materialized all matching `chat_messages` rows (including full `metadata_json`) plus all matching `a2a_task_events` rows for the whole call; production shape is 15,052 messages / 373MB `metadata_json` / 484K task events, so one unbounded request could reach multi-GB live sets.
- Applies when changes touch `server/api/metrics-controller.ts`, `server/domain/metrics/agent-eval-report.ts`, `public/metrics.js`, or any consumer of the agent metrics report.

### 2. Signatures
- `validateAgentMetricsWindow(sinceInput, untilInput): { message } | null` (shared by HTTP controller; exported from `agent-eval-report.ts`)
  - Both boundaries are required; each must be a `YYYY-MM-DD` date or an ISO 8601 datetime (`YYYY-MM-DD` optionally with `THH:MM[:SS[.mmm]]` and `Z|±HH:MM`); `until` must be strictly after `since`; the span must be ≤ 31 days.
  - Date-only `until` normalizes to the exclusive end of that day (next midnight UTC) so "that day" stays inclusive, matching the query's `created_at < @until` semantics.
- `buildAgentEvalReport(db, options)` keeps its aggregate output shape (per-agent turns/completed/failed, expectations tp/fp/fn/tn for send-public/send-private, tool calls/succeeded/failed with p50/p95 durations) while selecting only bounded projections:
  - Message query: scalar columns (`agent_id`, `sender_name`, `status`, `task_id`) plus `json_valid`-guarded `json_extract` projections for `publicToolUsed`, `publicPostCount`, `privatePostCount`, `privateHandoffCount`. Never `SELECT m.*`, never raw `metadata_json` in the select list.
  - Event query: filtered to `event_type IN ('agent_expectations', 'agent_tool_call')` and `task_id IN (task ids from the message window)`; projects `json_type`/`json_extract` fields plus a SQL-level `root_truthy` CASE that reproduces the baseline JSON truthiness semantics (object/array/true truthy; text truthy when longer than 2 chars; numbers truthy when non-zero). Never materializes `event_json`.
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
| `until` before or equal to `since` | 400 `metrics_agent_window_invalid` |
| span > 31 days (e.g. 32 or 60 days) | 400 `metrics_agent_window_invalid` |
| 31-day date-only window | 200; until date inclusive (normalized to next midnight) |
| full ISO datetime window ≤ 31 days | 200; report echoes effective boundaries |
| valid window with malformed `metadata_json`/`event_json` rows | 200; affected values degrade to defaults (baseline behavior) |
| CLI invocation without boundaries | full-history report; `report.since`/`report.until` are null |

### 5. Tests Required
- `tests/http/metrics-agent-window.test.js`: six red window-contract tests (missing/one-sided each side/reversed/32-day/60-day/malformed → 400) plus green semantic locks (31-day date-only and ISO datetime windows echo boundaries and count only in-window messages) and the CLI explicit-unbounded lock.
- `tests/runtime/agent-eval-report.test.js`: raw-column poison guard (throwing getters on `metadata_json`/`event_json` regardless of column alias), aggregate equivalence, malformed-JSON degradation, expectations/tool projection semantics.
- `scripts/p1-metrics-sse-gate.js` scenario `metrics-31d-bounded`: production-shape synthetic seed (256 conversations / 15,076 messages / 369.5MiB metadata / 484,602 task events inside one 31-day window) verifies exact aggregate parity field-by-field, a SQL/row-level projection guard (rejects `SELECT *` and bare `metadata_json`/`event_json` materialization), peak RSS delta ≤ 512MiB, and bounded latency.
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
