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
| `write` (改) | `product-code`, `test-code`, `docs-evidence` | Mutations of repo-tracked files: `edit`/`write` tools, bash redirections (`>`, `>>`), `sed -i`, `apply_patch`, `tee`. Path class decides the subcategory: `tests/**` → `test-code`; `docs/**`, `.agents/**` → `docs-evidence`; otherwise `product-code`. Every write step also carries a **write scope** (§5 rule 8): `repo` / `sandbox` / `temp` / `unknown`; only `repo` (and conservatively `unknown`) counts toward `firstWriteMs`, and only a repo-scope write ends the cold-start read phase. |
| `test` (测) | `targeted` (定向测试), `full-regression` (全量回归) | Test runner invocations. Records run count and failure count. |
| `build-check` (构建与检查) | — | `tsc`, `npm run build`, `npm run typecheck`, `npm run check`, `node --check` chains, linters. Not tests. |
| `process-report` (流程与汇报) | — | CAFF bridge tooling: `update-goal`, `suggest-goal`, `propose-plan`, `send-public`, `create-delegation`, `await-delegation`, `conversation_notify/request` (agent-chat-tools commands). |
| `thinking` (模型思考) | — | Wall-clock intervals inside the turn span with no tool execution running. Includes model generation and harness overhead; v1 cannot split further (documented, accepted). |
| `exception-retry` (异常与重试) | — | Two disjoint time sources: (a) tool steps that failed **before any semantic execution** (tool invocation errors, missing results, bridge errors) — the step never did read/write/test work, so no semantic category applies; (b) model-side error intervals: assistant messages with `stopReason = 'error'` (interval = previous trace event end → that row's timestamp), and pi-runtime watchdog/progress-timeout intervals. Source (b) is complete for live turns and best-effort for historical backfill — runtime-only events that never reached the session JSONL are simply absent, and the panel annotates `partial-*` accordingly. A failed *test run* stays in `test` (failure is signal); a failed *edit* that executed stays in `write`. |
| `unclassified` (未分类) | — | Rule classifier returned nothing and JEV was disabled, low-confidence, timed out, or errored. Never a hard guess. |

Turn-level metrics (also committed):

- `firstWriteMs`: turn span start (timestamp of the first trace event —
  the first assistant/model event of this turn's slice, not the user
  message) → the first step that mutates a **repo-tracked** file. Write
  steps carry a write scope (§5): `repo` counts; `sandbox` (agent
  `.pi-sandbox` / `agent-sandboxes` / `$PI_AGENT_PRIVATE_DIR` probe
  scripts) and `temp` (OS temp scratch) never move this metric even
  though they stay `write` steps; `unknown` (unresolvable target,
  JEV-classified write, legacy row) is conservatively treated as repo.
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
    with end-only timing and flagged. Incremental re-parse advances
    `parse_offset` in **bytes**, always to a newline boundary; a
    call/result pair split across two incremental passes (open step in
    pass N, end-only orphan in pass N+1) is merged back into one step by
    `toolCallId` in the pipeline — never stored as two rows. The merge
    keeps the stored row's classification **including its write scope**
    (§5 rule 8): washing it to NULL would re-count sandbox/temp scratch
    as a repo write. The turn-span anchor is the min of the pass's first
    event and stored row starts, so `firstWriteMs` never goes negative
    when a kept open row predates the pass's first event. An
    unterminated trailing line that does not yet parse is an in-flight
    tail: excluded from `parse_offset`, and it does **not** flip
    `partial-truncated`; that status is reserved for genuinely corrupt
    middle lines (`corruptLines > 0`).
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
   `conversation_notify`, `conversation_request`, `list_rooms`,
   `room_workspace_*`) → `process-report`.

   Shell segmentation is **quote-aware**: `&&`, `||`, `;`, `|` split only
   outside single/double quotes, so `rg -n "a\|b"` stays one segment.
   `cd`/`pushd`/`popd` segments are **neutral**: they carry no category
   and never poison a chain (`cd /repo && npm test` is a test run); a
   command with only neutral segments is `null`. Leading `FOO=bar` env
   assignments and **launcher prefixes** — `sudo`, `timeout [-s S] [-k D]
   <dur>`, `time`, `env [-u X | VAR=v | -i]…`, `command`, `nice [-n N]`,
   `stdbuf` — are stripped (quote-preserving, via word spans) so anchored
   patterns see the real binary; a `git -C <path>` prefix is likewise
   stripped. A bare launcher with no payload (`env`) keeps its own
   meaning; a launcher prefix whose payload matches nothing is `null`,
   never a guessed read.
2. Test runners (`node --test`, `node <flags> --test` (flags skipped
   pairwise so `--import tsx` never swallows `--test` as its value),
   `npm test`, `npm run test:*`,
   `yarn test:*`/`pnpm test:*` without `run`, `npm --prefix <dir> test`,
   `vitest`, `jest`, `mocha`, `npx playwright test`, `npx tsx --test`,
   `pytest`, `python|python3|*.exe -m pytest|unittest` (incl. venv
   paths), `node … vitest.mjs [run]`, `*/node_modules/.bin/{vitest,jest,
   mocha}` (both slash forms, incl. Windows `node_modules\.bin\…`),
   `go test`, `cargo test`) → `test`. Output fingerprints
   (`# pass N`, `# fail N`, `tests N passed`, `N failing`, exit code)
   fill run/failure counters. Failed runs stay in `test`. **Every test
   segment counts**: a chained `npm test; npm test` is two full runs —
   the step exposes `testRunCounts = {full, targeted}` and `fullRunCount`
   sums it.
3. Build/check (`tsc`, `npm run build`, `npm run typecheck*`, `npm run
   check`, `node --check`, eslint) → `build-check`.
4. Mutations (`edit`/`write` tools; bash with `>`, `>>`, `sed -i`,
   `apply_patch`, `tee`, `mv`, `cp`, `rm`, `mkdir`, `touch` targeting repo
   paths; `git checkout --`/`git restore`) → `write` with path-class
   subcategory decided by the **destination** path class (redirection
   target, `tee` operand, `mv`/`cp` destination, `sed -i` operand; NULL
   when no target is extractable — never a hardcoded guess). VCS
   bookkeeping that mutates repo state but not file contents (`git add`,
   `commit`, `rm`, `mv`, `stash`, `apply`, `am`) → `write` with NULL
   subcategory; `git stash list`/`git stash show` are read-only
   inspections → `read` (golden sample gs-052/gs-146/gs-294).
   Redirections to `/dev/null`/`NUL` discard output and are **not**
   writes; neither is scratch redirection into the OS temp area
   (`/tmp/`, `/var/tmp/`, `$TMPDIR`, `%TEMP%`, `%TMP%`) — 改 covers
   产品代码/测试/文档与证据 and a temp scratch file is none of those
   (golden sample gs-148/gs-293). `awk`/`gawk`/`mawk` default to `read`
   (extraction); the rare `awk -i` in-place form is a known gap.
   `git stash push/drop/create` (and bare `git stash`) mutate repo state
   → `write` with NULL subcategory; only `list`/`show` are reads.
   Every `write` classification also carries a **write scope**
   (`classifyWriteScope`, §2): `repo` for relative (workdir-anchored)
   targets; `sandbox` for `.pi-sandbox/` / `agent-sandboxes/` paths and
   `$PI_AGENT_PRIVATE_DIR` / `$PI_AGENT_SANDBOX_DIR` references; `temp`
   for `/tmp/`, `/var/tmp/`, `$TMPDIR`, `%TEMP%`, `%TMP%`; `unknown`
   for anything else (absolute paths outside the known scratch areas,
   unresolvable targets). `unknown` is conservatively treated as repo
   by `firstWriteMs` and the cold-start flip; `sandbox`/`temp` writes
   stay `write` steps but never end the cold-start read phase (§2 read
   row: "first repo-file mutation").
5. Reads (`read`/`grep`/`find` tools, `ls`, `cat`, `sed` without `-i`,
   `diff`, read-only git incl. via `git -C`) → `read` with cold-start
   subcategory before the first write. The classifier exposes
   `noteExternalCategory`: JEV and exception-retry outcomes that resolve
   to `write` are fed back so later reads flip cold-start →
   purposeful-lookup even when the write itself was rule-opaque.
6. Infra failures with no semantic execution (invocation error, missing
   result) → `exception-retry`. Rules 2–5 deliberately run first: a step
   that *did* execute semantics (a test that ran and failed, an edit that
   applied) keeps its semantic category even when its exit status is a
   failure; only steps that never got to do semantic work fall through to
   this rule.
7. Otherwise → `null` (JEV fallback, §6). **Opaque-segment rescue:**
   when one segment is opaque but another is a high-confidence runner
   (rule 2) or build/check (rule 3) hit, the command classifies by that
   hit and the step is flagged `hasOpaqueSegment = true` for honest
   annotation; opaque next to any weaker category (read/write) stays
   `null` — a silently wrong `read` is worse than an honest JEV call.

**Full-regression vs targeted (resolves `q-fullrun`, part 1)**: an
invocation is `full-regression` when it matches the repo's canonical
full-suite entry — `npm test`, `npm run test:fast`, bare `node --test
tests/`, `npx vitest run`, bare `pytest` — with no path/file subset
arguments; path-scoped invocations (`node tests/runtime/foo.test.js`,
`pytest tests/x/`) are `targeted`. Output redirections (`>`, `>>`, `2>`,
`2>&1`, `&>`) and their targets are stripped before this judgement —
`npm test > /tmp/x.log` is a full run, never targeted. Package-dir flags
(`--prefix <dir>`, `--cwd <dir>`) are selectors, not path subsets:
`npm --prefix ./pkg test` is a full run of that package. Wrapper scripts
(`bash scripts/*.sh`, `node scripts/*.js`, npm script chains not listed
above) are opaque to rules → JEV fallback with command + output.
`fullRunCount` counts `full-regression` invocations per turn;
`fullRunFailCount` counts those with non-zero exit or a fail fingerprint.

### 6. JEV Fallback

- Reuses `createTypeSafeClient`
  (`server/domain/integrations/typesafe/typesafe-client.ts`); no new
  external client.
- Trigger: rule classifier returned `null` (includes opaque wrapper
  scripts that actually run tests).
- Request: one `choice` question for the category (options = the §2
  step categories), plus a second `choice` for `runKind`
  (full-regression / targeted / not-a-test, only meaningful when the
  category answer is `test`) — a single API round trip; state is a
  structured object `{toolName, command, output, isError, durationMs}`.
  Command truncated to **head 8000 chars** (pure cost bound; the client's
  own caps are never approached). Output truncated **head 2000 + tail 2000
  chars (4000 max)** (resolves `q-fullrun`, part 2) to bound cost and
  latency; the client's own `maxStateChars`/`maxRequestChars` caps still
  apply.
- Latency policy: `timeoutMs = 8000` as the single overall deadline;
  `maxRetries` is left at the client default (passing 0 falls back to the
  default via `normalizePositiveInt`), so a transient failure may retry
  within the 8 s deadline and then still lands on the fallback path.
- Dedicated client: the pipeline constructs its own `createTypeSafeClient`
  instance with its own `maxRequests`/`tokenBudget`, never sharing the
  agent-tool-bridge instance — classification volume must not consume the
  bridge's process-local budget.
- Low confidence (< 0.6) or choice `unclassified` → `unclassified`, never a
  hard guess. A **missing** confidence field is accepted as confident —
  only an explicit value below the threshold degrades; this is also why the
  cache's `confidence` column is nullable (§7).
- JEV-classified `write` steps carry `subcategory = null`: the §2 three-way
  write split (product-code / test-code / docs-evidence) is populated only
  for rule-classified steps. W4 may post-process subcategories from
  command/output; v1 does not.
- Cache: `sha256(toolName + argv[0] + first positional + flags-only(argv)
  + output fingerprint)` → category, in `jev_classification_cache`; cache
  hits skip the network entirely. argv identity is read from the **first
  logical line** only. The first positional (script path /
  subcommand) is part of command identity so two different wrapper scripts
  never share an entry; the output fingerprint is coarse (length bucket,
  fail/pass fingerprint, exit status) so log churn still hits the cache.
  **Opaque bodies**: when the command contains a heredoc (`<<`), a
  newline, or an inline-exec flag (`-e` / `-c` / `--eval`), argv-level
  identity collapses (two different `node - <<'NODE'` scripts share argv0
  and flags), so a sha256 of the whole command body joins the key —
  different scripts never share an entry, identical re-runs still hit.
- Cache adapter contract (implemented in W4 over sqlite): `get(key)`
  returns the stored entry `{category, subcategory, runKind, confidence}`
  or `null` on miss or parse failure; `set(key, entry)` persists exactly
  that shape. Both are fault-tolerant: a throwing `get` behaves as a miss,
  a throwing `set` is swallowed — classification never rejects into the
  turn path because of the cache.
- Switch: JEV runs only when the repo-wide master switch
  `TYPESAFE_ENABLED=true` (same convention as `jev_ask` in
  `agent-tool-bridge.ts`), **and** `TYPESAFE_API_KEY` is configured,
  **and** the per-project config `timeBreakdown.jevEnabled` (system
  service config store) is true; default **false** → rules only (open
  question `q-jev-config`: wiring waits for credential/config
  confirmation). The master switch gates both client construction and
  `resolveJevEnabled`, so a project switch can never send unredacted v1
  payloads while the global capability is off, even with a stale key in
  the environment. When disabled the classifier does not even read the
  cache — "rules only" means exactly that; do not "fix" this later, it
  would change the switch semantics.
- Failure/timeout/disabled: step stored as `unclassified` with
  `jevStatus = 'ok' | 'timeout' | 'error' | 'disabled' | 'low-confidence'
  | 'pending'`; never blocks, never throws into the turn path. `pending`
  marks a step queued for async JEV resolution (§8/§9). A later pass (next
  view click) may reclassify `timeout`/`error` steps via cache or a fresh
  call — JEV-bound steps persist a compact `payload_json`
  ({args, truncated output}) so the retry needs no session re-parse.

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
  run_count_full INTEGER,           -- §5 per-segment counts (`npm test; npm test` = 2)
  run_count_targeted INTEGER,
  write_scope TEXT,                 -- §5: 'repo'|'sandbox'|'temp'|'unknown'; NULL (legacy/JEV) ≈ repo
                                    -- upsert: COALESCE(excluded, stored) — sparse writes never wash it
  payload_json TEXT,                -- JEV-bound steps only: {args, truncated output} for retry
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
  parse_offset INTEGER,             -- last parsed JSONL byte offset (bookkeeping; §9 re-parses the full slice)
  assistant_count INTEGER,          -- cumulative assistant rows seen (bookkeeping; the §9 re-parse is a full slice pass)
  computed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jev_classification_cache (
  cache_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  subcategory TEXT,
  run_kind TEXT,                  -- 'targeted' | 'full-regression' | NULL
  confidence REAL,                -- NULL when JEV omitted the field (§6)
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
  stream. The first pi event of a turn enqueues a **turn-start marker**
  anchoring the span at the trace's first event (the first tool step can
  start well after it — model thinking); `auto_retry_start` enqueues a
  §2(b) error event (interval = previous trace event end → retry
  timestamp). The turn path **never awaits** classification; the queue
  timer is `unref`'d and must never keep the process alive (same contract
  as the observability sampler).
- Summary lifecycle: the first classified step (or the turn-start marker)
  of a task inserts the `chat_turn_time_summaries` row with
  `status = 'live'`; every subsequent step updates it incrementally, so an
  in-progress turn is refreshable (AC1). Task completion flips it to
  `complete`. **Failure and cancellation seal too**: the executor's catch
  path calls `completeTask` with `status = 'partial-interrupted'` and
  `endedAtMs = stage.endedAt` — otherwise the summary would stay `live`
  forever with thinking growing without bound (AC5). A watchdog
  (`progress_timeout` family) failure additionally enqueues a §2(b) error
  event at the stage end so the no-progress tail counts as
  exception-retry, not thinking. A missing terminal event yields
  `partial-interrupted` and the panel says so.
- Worker: rule-classify → upsert `chat_turn_time_steps`; JEV-needed steps
  are stored `unclassified` + pending, then resolved asynchronously and
  updated in place.
- Queue overflow (depth cap, default 256): drop with a counter; affected
  turns are completed by lazy backfill on next view click. Dropped steps
  must never lose the underlying event — only the classification.

### 9. API and Lazy Backfill

- `GET /api/conversations/:conversationId/messages/:messageId/time-breakdown`
  → `{ status, categoryMs, metrics, steps[] , computedAt }`.
- Fresh summary row (terminal status: `complete`, `partial-truncated`,
  `partial-interrupted`) → return as-is (cached path target: < 2 s).
- No row or a `live` row → locate `message → task → session_path +
  sessionAssistantStartIndex`, **re-parse the turn slice from offset 0**
  with the §4 step parser (assistant `tool_call` starts joined to
  `toolResult` ends). A full reparse — not an incremental delta — because
  a delta cannot reproduce the turn start or the §2(b) error events that
  earlier passes already consumed (measured ~38 ms for a 17.87 MB
  session, far inside the AC5 budget); every refresh therefore sees the
  same authoritative span, `firstWriteMs`, and error intervals. Classify
  with **rules + JEV cache only** (fresh JEV calls are excluded from the
  synchronous backfill so multi-MB logs finish < 10 s; pending steps are
  marked and resolved asynchronously), upsert rows, return. Steps already
  resolved by JEV keep their category — backfill only refreshes their
  timing; rows already classified `jev`/`jev-cache` are never re-ruled.
  Rows already `pending`/`timeout`/`error` are refreshed but never
  re-enqueued by the parse loop; the retry list below owns them.
- Async JEV retry per click: `pending`/`timeout`/`error` rows with a
  `payload_json` are re-offered to the pipeline (deduped by step key,
  capped at 64 per click) after the response is assembled — the cap
  bounds budget burn when JEV is down and the view keeps refreshing.
- Corrupt JSONL lines are skipped and flip status to `partial-truncated`;
  an unterminated in-flight tail (normal mid-turn) is excluded from the
  offset but never flips status. No full historical backfill — only on
  click (goal non-goal `ng-backfill`).

### 10. Frontend

- "耗时分析" button beside the trace toggle in `message-timeline.js`.
  Visibility: once the trace is loaded the toggle shows only when the
  message has tool steps (`summary.toolExecutionCount > 0`); before the
  trace loads it stays discoverable, except that after a 404 (empty
  state) with no trace loaded it hides — a permanently empty button
  would be dishonest. An open or loading panel always keeps its toggle
  so it can be closed, and a message with cached breakdown data keeps it
  too. After a 404 the retry path requires loading the trace first (the
  toggle reappears once the trace shows tool steps); reopening an
  `empty` state re-fetches.
- Panel: per-category duration bars (ms + %), metrics row (首次改文件时间,
  会话复用及原因, 全量回归遍数/失败次数), and the step list with category
  labels. In-progress turns expose a refresh action that re-fetches the
  latest stored rows; a failed refresh keeps the last result and shows a
  刷新失败，显示上次结果 note instead of silently presenting stale data.
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
| multi-MB JSONL lazy backfill | full slice re-parse < 10 s excluding JEV waits; `partial-*` flags honest |
| failed / cancelled turn | sealed `partial-interrupted` at stage end by the executor catch path; watchdog tail counted as exception-retry; thinking bounded (AC5) |
| interrupted turn (no terminal event) | `partial-interrupted`, panel annotates |
| JEV off (default) | rules only; no `TYPESAFE_API_KEY` access attempted |
| project JEV switch on but `TYPESAFE_ENABLED` off | rules only; client never constructed; no payload leaves the process |

### 12. Tests Required

- `tests/runtime/turn-time-breakdown-parser.test.js`: §4 step parser —
  assistant `tool_call` ↔ `toolResult` join by `toolCallId`, parallel
  shared starts, orphan toolResults, corrupt lines vs in-flight tail,
  `sessionAssistantStartIndex` slicing, incremental `parse_offset`
  (byte-accurate under multibyte content).
- `tests/runtime/turn-time-breakdown-rules.test.js`: every §5 branch,
  path classes (incl. bash destination-path subcategories), cold-start vs
  purposeful reads, full vs targeted fingerprints, per-segment run
  counting, quote-aware segmentation, neutral `cd` prefixes, launcher
  prefixes (`timeout`/`env`/`time`/`sudo`/`command`/`nice`/`stdbuf`),
  runner aliases (`python -m pytest`, `vitest.mjs`, `node_modules/.bin`),
  redirection-vs-run-kind separation, opaque-segment rescue with
  `hasOpaqueSegment`, `git -C`, `/dev/null` redirections,
  exception-retry vs failed-test distinction, both bridge forms (CLI and
  native tool names).
- `tests/runtime/turn-time-breakdown-attribution.test.js`: parallel
  interval union, priority slicing, thinking-time gaps, model error
  intervals → `exception-retry`.
- `tests/runtime/turn-time-breakdown-pipeline.test.js`: enqueue is
  non-blocking (zero storage writes on the turn path), live→complete
  summary lifecycle, toolCallId dedup, JEV pending→resolved→cache-hit,
  timeout/error/disabled statuses, queue overflow drop counter, worker
  failure isolation.
- `tests/runtime/turn-time-breakdown-jev.test.js`: fake JEV covering
  success / timeout / error / low-confidence / disabled; cache hit;
  truncation length; no turn-path blocking.
- `tests/storage/turn-time-breakdown-store.test.js`: migration, upsert
  idempotence, summary lifecycle, JEV cache adapter camelCase shape lock.
- `tests/http/turn-time-breakdown-controller.test.js`: cached read, lazy
  backfill, `partial-*` statuses, cross-chunk orphan merge, error mapping.
- `tests/ui/turn-time-breakdown.test.js`: button visibility, panel
  rendering (incl. empty/live/partial states), in-progress refresh
  click → fetch.
- `tests/runtime/turn-time-breakdown-golden.test.js` +
  `tests/fixtures/turn-time-breakdown-golden.json` +
  `tests/fixtures/turn-time-breakdown-golden-strata.json`: the AC3 golden
  sample (see §13.1). Freezes the rules result per step, asserts the
  reviewed disagreement set exactly, and guards the time-weighted
  agreement (≥90%) and the stratum-weighted corpus null-share estimate
  (≤30%; the sample-internal 41.3% is a stratification artifact, §13.1).
- `scripts/replay-turn-time-breakdown.js`: the AC4 replay tool
  (see §13.2). Not part of `test:fast` (it reads the live main DB).
- The parser test file carries the AC5 performance case: a >4MB
  synthetic session log must parse+classify well under 10s. Truncated,
  corrupt-line, open-step, and interrupted (`partial-*`) logs are
  covered by the parser/pipeline suites.

### 13. Acceptance Evidence: Golden Sample & Retrospective Replay (W6)

#### 13.1 Golden sample (AC3)

- **Corpus**: room `b7e50f1c` (评测/知识包 拆分三期) session JSONL logs,
  52,894 classifiable tool steps across 10-14..10-21.
- **Sampling**: stratified by (tool × rules-outcome × duration bucket),
  seeded RNG, 300 steps (`tests/fixtures/turn-time-breakdown-golden.json`;
  every record carries tool, command, output head/tail, isError,
  durationMs, the rules result at fixture time, and the hand label).
- **Labeling caliber**: the *dominant purpose* of the step, judged from
  command + output (e.g. a wrapper that prepares and runs a scenario
  suite is `test`; a failed run whose output shows real test failures is
  `test`, per §5 exception-retry's executed-then-failed rule).
  Labels: Kimi (author); reviewed against §5 semantics. A second-agent
  pass was folded into the W6 review discussion.
- **Results** (post W6 rules fixes): rules-resolved time-weighted
  agreement **97.3%** (≥90% ✓).
- **Null share — sample vs corpus** (W6 re-review correction): the
  sample-internal rules-null time share is **41.3%**, but that is a
  stratification artifact (opaque-wrapper strata were deliberately
  over-sampled) and is NOT the corpus property. The corpus-level
  rules-null time share, measured with
  `node scripts/replay-turn-time-breakdown.js --sandbox <sandbox>
  --conversation b7e50f1c --from 2026-10-14 --to 2026-10-21
  --scan-sessions`, is **27.0%** (587 sessions / 30,348 steps; the
  independent reviewer measured 27.2% with his own probe — cross-check
  within 0.2pp); over the full session window it is **22.5%**
  (977 sessions / 53,022 steps). The regression guardrail therefore
  compares a **stratum-weighted** estimate from the fixture
  (population counts in
  `tests/fixtures/turn-time-breakdown-golden-strata.json`, regenerated
  via `--scan-sessions --emit-strata` only when re-baselining):
  currently **21.3%**, asserted ≤ 30%.
- **JEV caveat / explicit AC3 gap**: JEV was credential-gated off in
  this environment (`TYPESAFE_*` absent; open question `q-jev-config`),
  so AC3's JEV-on caliber (未分类 ≤10%) is **not measured, only
  proxied**: golden labels stand in for JEV answers, matching the
  production JEV+cache behavior for a correct classifier. The honest
  corpus unclassified share under JEV-off is 27.0% (10-14..10-21
  window) — far above 10%, so the AC3 ≤10% number cannot be evidenced
  without live JEV credentials. This gap is recorded at the same level
  as the missing JEV credentials themselves and is part of
  `q-replay-caliber` user adjudication.
  Projected system agreement with a golden-matching JEV: **98.4%**.
- **Known disagreements** (frozen in the regression test, 6/300):
  - `gs-042`/`gs-150`: rg searches whose *pattern* names a bridge tool →
    rules FP `process-report`, golden `read`.
  - `gs-036`/`gs-046`: pipelines mixing read-context bridge invocations
    with real file reads; dominant category debatable, rules chose
    `process-report`.
  - `gs-297`: node_modules patch + syntax check in one step; rules
    `build-check`, golden `write` (borderline).
  - `gs-299`: 185s wrapper that ran tests then died on harness timeout;
    rules `exception-retry` (executed-then-failed policy), golden `test`.
- **Rules fixes driven by the sample** (W6): `git stash
  list|show` → `read` (was `write`, gs-052/146/294); scratch redirection
  into OS temp (`/tmp`, `$TMPDIR`, `%TEMP%`…) no longer counts as 改
  (gs-148/293); `awk`/`gawk`/`mawk` default to `read`.
  W6 re-review added: `git stash push/drop/create` → `write` (the
  list/show carve-out had regressed them to `null`); write scope
  (`repo`/`sandbox`/`temp`/`unknown`) so sandbox probe-script writes
  (gs-175 shape) no longer move `firstWriteMs`.

#### 13.2 Retrospective replay (AC4)

`scripts/replay-turn-time-breakdown.js` replays the classifier over
`chat_messages` turn windows (`created_at..updated_at`, steps assigned by
`startedAtMs`; thinking = window − tool union). `--overlay` applies the
golden-derived wrapper mapping as the replay-time substitute for JEV;
the overlay is a hand-written mapping for THIS corpus batch only — it is
replay evidence for this batch, not a reusable artifact.

Reproduction against the 10-20 retrospective claims (W6 re-review
calibers — every number below is a direct output of the replay script
with the documented flags):

| Claim | Reproduced (documented calibers) | Verdict |
| --- | --- | --- |
| 三期房间 10-20 批次 test 占比 ~76% ±5pp | 58 GPT turns, 20.41h. **Rules-only: test 0.0%** (unclassified 63.2% — the wrapper scripts are JEV-bound by design). **+`--overlay`: test 59.5%** (overlay = "assume JEV classifies the golden-reviewed wrappers correctly"). **+`--overlay --test-adjacent`: 69.9%** (adds build-check + read/write steps touching test paths). | **Not mid-band reproducible** — the strict rules caliber lands at 0% because the batch is dominated by opaque wrappers; the JEV-proxy caliber lands at 59.5%, the widest documented caliber at 69.9% (lower tolerance edge is 71%). The original script's exact 口径 is unavailable (open question `q-replay-caliber`); the order of magnitude (tests dominate, ~3/5–7/10 of the day) is confirmed. |
| GLM 首次修改等待 ~9.8 min ±1 | 三期房间 10-14..17 GLM sessions, `--first-write` with §5 write scope (only repo-scope writes count): session-level median 6.8 / **mean 9.4 min** (n=113). Without the write-scope fix (sandbox probe scripts counted) the mean was 8.5 — the W6 first-submission "near miss" was the metric bug, not the claim. | **Reproduced in-band** (9.4 ∈ [8.8, 10.8]). |

The replay script's header records these reference numbers; re-running it
with the documented flags against the same DB reproduces them.

### 14. Wrong vs Correct

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
