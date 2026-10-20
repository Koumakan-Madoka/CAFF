# Turn Time Breakdown (单轮耗时分析)

## Scenario: Per-Turn Time Analysis for Agent Replies

### 1. Scope / Trigger

- Trigger: session goal "CAFF 可观测性加强" — every agent reply with tool
  steps gains a "耗时分析" button next to "查看观测时间线"
  (`public/chat/message-timeline.js`, trace toggle area), showing where the
  wall-clock time of that single turn (one trace) went.
- Applies when changes touch `server/domain/runtime/turn-time-breakdown.ts`
  (new), the `tryAppendInvocationEvent` hook in
  `server/domain/runtime/agent-tool-bridge.ts`, the time-breakdown API
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
| `exception-retry` (异常与重试) | — | Steps whose failure carries no semantic work: tool invocation errors, model call errors, bridge errors, timeouts before execution, and exact-duplicate retries after such infra failures. A failed *test run* stays in `test` (failure is signal); a failed *edit* stays in `write`. |
| `unclassified` (未分类) | — | Rule classifier returned nothing and JEV was disabled, low-confidence, timed out, or errored. Never a hard guess. |

Turn-level metrics (also committed): `firstWriteMs` (turn start → first
repo-file mutation), `sessionReused` + `sessionReuseReason`,
`fullRunCount`, `fullRunFailCount`.

### 3. Time Attribution (resolves open question `q-parallel`)

- All accounting is wall clock. Per category, take the **union of its step
  execution intervals** — parallel tools never double-count.
- Overlapping steps of *different* categories: the overlapped slice is
  attributed by fixed priority `test > write > build-check > exception-retry
  > read > process-report > unclassified`. Rationale: proportional splitting
  assumes parallelism is uniformly shared, which distorts IO-wait-heavy
  steps; priority-on-union is deterministic, reproducible, and matches the
  committed "区间并集计、不重复计时".
- `thinking` = turn span minus the union of all tool execution intervals.
  Turn span = timestamp of the first event of the trace (first model call or
  tool step) → timestamp of the last event; for a live turn, "now".

### 4. Data Sources and Step Extraction

- **Authoritative history**: pi session JSONL, parsed by
  `readSessionAssistantSnapshot` (`server/domain/runtime/message-tool-trace.ts`)
  with the task's `sessionAssistantStartIndex` slice — immune to the
  `MAX_TOOL_EVENT_COUNT = 200` window that truncates the tool-trace API.
  Session rows win on timestamps when both sources have a step.
- **Real-time**: bridge tool events (`a2a_task_events`,
  `event_type = 'agent_tool_call'`) carry `toolCallId`, tool name, request,
  result, status, `durationMs`, and `created_at`.
- Step identity: `(taskId, toolCallId)`. Session-derived steps without a
  `toolCallId` fall back to `(taskId, toolName, ordinal)`.

### 5. Rule Classifier

Inputs: tool name, command argv (for `bash`), affected path class, CAFF tool
name, exit status, and command-output features. Evaluation order is fixed;
first hit wins:

1. CAFF bridge commands (`node .../agent-chat-tools.js <cmd>`) →
   `process-report`.
2. Test runners (`node --test`, `npm test`, `npm run test:*`, `vitest`,
   `jest`, `pytest`, `go test`, `cargo test`) → `test`. Output fingerprints
   (`# pass N`, `# fail N`, `tests N passed`, `N failing`, exit code) fill
   run/failure counters. Failed runs stay in `test`.
3. Build/check (`tsc`, `npm run build`, `npm run typecheck*`, `npm run
   check`, `node --check`, eslint) → `build-check`.
4. Mutations (`edit`/`write` tools; bash with `>`, `>>`, `sed -i`,
   `apply_patch`, `tee`, `mv`, `cp` targeting repo paths) → `write` with
   path-class subcategory.
5. Reads (`read`/`grep`/`find` tools, `ls`, `cat`, read-only git) → `read`
   with cold-start subcategory before the first write.
6. Infra failures with no semantic work → `exception-retry`.
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
- Latency policy: `timeoutMs = 8000`, `maxRetries = 0` (fallback replaces
  retries). Low confidence (< 0.6) or choice `unclassified` →
  `unclassified`, never a hard guess.
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

- Hook: `tryAppendInvocationEvent` in `agent-tool-bridge.ts`, after
  `runStore.appendTaskEvent` succeeds, enqueues `{taskId, messageId,
  payload}` onto an in-process async queue. The turn path **never awaits**
  classification; the queue timer is `unref`'d and must never keep the
  process alive (same contract as the observability sampler).
- Worker: rule-classify → upsert `chat_turn_time_steps`; JEV-needed steps
  are stored `unclassified` + pending, then resolved asynchronously and
  updated in place.
- Queue overflow (depth cap, default 256): drop with a counter; affected
  turns are completed by lazy backfill on next view click. Dropped steps
  must never lose the bridge event itself — only the classification.
- Task completion flips the summary to `complete`; a missing terminal event
  yields `partial-interrupted` and the panel says so.

### 9. API and Lazy Backfill

- `GET /api/conversations/:conversationId/messages/:messageId/time-breakdown`
  → `{ status, categoryMs, metrics, steps[] , computedAt }`.
- Fresh summary row → return as-is (cached path target: < 2 s).
- No/stale row → locate `message → task → session_path +
  sessionAssistantStartIndex`, parse the JSONL from `parse_offset`, classify
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
- Token usage display (open question `q-tokens`): v1 **shows** per-turn
  model token consumption in the metrics row since the data already exists
  in the model-usage path; flagged for user confirmation at review — removal
  is a one-line change if rejected.

### 11. Validation & Error Matrix

| Case | Expected behavior |
| --- | --- |
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

- `tests/runtime/turn-time-breakdown-rules.test.js`: every §5 branch,
  path classes, cold-start vs purposeful reads, full vs targeted
  fingerprints, exception-retry vs failed-test distinction.
- `tests/runtime/turn-time-breakdown-attribution.test.js`: parallel
  interval union, priority slicing, thinking-time gaps.
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
