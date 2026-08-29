# OOM Evidence And Architecture Review

## Baseline

- Source baseline: `origin/develop@2188f20cef21e70b05e92754b52a42f619f67598`.
- Room worktree was clean when the review began.
- Review actions were read-only against source and previously authorized read-only production measurements. No production process, file, configuration, or database was changed.

## Incident Timeline And Confidence

1. The old develop/3100 main process, PID 31880, ran for about 64,976 seconds before V8 reached its default old-space ceiling near 4 GB.
2. The final Mark-Compact moved 4095.7 MB to 4095.3 MB. Nearly all old-space was still reachable after full collection.
3. The current main process was restarted after the crash and initially used roughly 0.7 GB working/private memory, showing no immediate return to 4 GB.
4. The user recalls likely opening the memory or summary panel near the crash window.
5. `public/chat/summary-memory-panel.js::setOpen()` calls `refreshHealth()` whenever the long-term memory drawer opens.
6. `refreshHealth()` calls global `GET /api/memory/health`; it does not pass a conversation id.
7. The handler delegates synchronously to `ChatAppStore.getSummaryMemoryHealth()`.

Conclusion: opening the memory panel is the high-confidence direct trigger. The evidence does not prove the exact HTTP request because the crash window has neither access logs nor a heap snapshot.

## Production-Scale Evidence

Previously authorized read-only measurements established this workload shape:

| Measure | Observed value |
| --- | ---: |
| SQLite file | about 2.09 GB |
| Conversations | 256 |
| `chat_messages` rows | 15,052 |
| Message content | about 9.7 MB |
| `metadata_json` | about 373 MB |
| Rows with context snapshot/model usage | 5,819 |
| Metadata on those rows | about 369 MB |
| Largest conversation metadata | about 87.5 MB |
| Largest conversation raw message projection | about 93.5 MB |
| `a2a_task_events` rows | about 484,602 |

Representative large messages contain an `agentContextSnapshot` near 94 KB and `modelUsage.calls` with hundreds of nested call objects. JSON strings become larger V8 object graphs after parsing because arrays, object headers, keys, strings, and numbers all have allocation overhead.

## Confirmed Direct Trigger Chain

```text
open memory drawer
  -> summary-memory-panel.setOpen(true)
  -> refreshHealth()
  -> GET /api/memory/health
  -> memory-controller
  -> ChatAppStore.getSummaryMemoryHealth()
  -> listConversations() headers
  -> getConversation(id) for every header
  -> listMessages(id)
  -> ChatMessageRepository SELECT * with no LIMIT
  -> normalizeMessageRow()
  -> JSON.parse(metadata_json)
  -> push full conversation into conversations[]
  -> retain all 256 hydrated object graphs until response construction completes
```

The array is the decisive retention root. The request is synchronous, so garbage collection cannot reclaim prior conversations while they remain reachable from `conversations[]`.

## Backfill Has Three Hydration Layers

`backfillConversationDigestSummarySegments()` has more than one problem:

1. It calls `getConversation()` for every header.
2. It stores every hydrated result in `conversations[]` before processing.
3. For every digest, `saveSummarySegmentFromDigest()` calls `getConversation()` again even though it only needs existence and title.

Replacing only the outer backfill calls would reduce peak retention but would still repeatedly parse every message in a conversation once per retained digest. P0 must remove all three message-read paths.

## Existing Lightweight Projection

- `ChatAppStore.listConversations()` returns `normalizeConversationHeader()` rows.
- The header already includes `id`, `title`, parsed conversation `metadata`, counts, and timestamps.
- `conversation.metadata.conversationDigests` is therefore available without reading `chat_messages`.
- `getConversationWithoutMessages()` is the established scoped fallback and returns the same conversation metadata with an empty `messages` array.

This means health and backfill do not require a new schema or message query.

## Runtime Hydration Inventory

### Request/operation scoped

| Path | Current read | Retention lifetime | Risk |
| --- | --- | --- | --- |
| Global memory health | all conversations plus all messages | whole HTTP request | Critical direct trigger |
| Global memory backfill | all conversations plus all messages | whole HTTP request | Critical manual trigger |
| Segment save | one full conversation per digest | one digest write | High churn inside backfill |
| Agent metrics without dates | all selected assistant metadata and matching task events | whole report build | High independent peak |
| Model catalog fallback | read/parse/clone multi-MB catalog | one request | Low/background peak |

### Turn/Goal scoped

| Path | Current read | Retention lifetime | Risk |
| --- | --- | --- | --- |
| `enqueueGoalContinuationMessage()` | full conversation | continuation decision | Avoidable churn |
| `listPendingUserMessages()` | full conversation per call | queue scan | Repeated churn |
| routing turn startup | full conversation | whole turn closure | Large bounded live set |
| initial prompt snapshot | full conversation again | whole turn | Duplicate live set |
| `buildExecutionInput()` | full conversation per hop | entire Agent invocation | Multiplies with parallel/long runs |
| final turn projection | full conversation | settlement | End-of-turn peak |

`agent-prompt.ts` ultimately renders only the last 24 public history messages, but routing first loads and parses every message. During a long Agent run, the execution input and async closure keep the hydrated conversation reachable. Parallel Agent runs can retain separate snapshots.

### Per-run accumulators

- `lib/pi-runtime.ts` retains `state.reply`, `assistantUsageByKey`, active tool calls, and listener closures until the run settles.
- `agent-executor.ts` separately accumulates `rawReply` until the same run settles.
- `modelUsage.calls` and `agentContextSnapshot` are then persisted on every assistant message, growing future hydration cost.
- The current default absolute run timeout is three hours, so these are bounded but potentially long-lived.

### SSE

`server/http/sse-bus.ts::writeEvent()` ignores the boolean result of every `res.write()`. A slow or half-open client therefore lets Node's socket queue retain serialized event frames until the socket closes. Full message update events can include large metadata. This is a true unbounded retention risk independent of memory health.

## Lifecycle Review And Exclusions

No primary evidence currently points to a forgotten top-level scheduler Map as the direct leak:

- routing cleanup removes active conversation/turn entries and clears run handles;
- Agent invocations unregister in `finally`;
- slot registry holders/waiters release or clear by conversation;
- Pi process listeners are removed during cleanup;
- stdout/stderr diagnostic tails are bounded;
- DAG owner chains self-remove.

These structures still retain their legitimate in-flight object graphs while work is active, but their terminal cleanup paths exist. The incident shape is better explained by one huge reachable request graph, potentially amplified by active runs or slow sockets.

## Recent-Change Analysis

- Memory health/backfill and the automatic drawer health check date to the May summary-memory feature, not the morning's Goal-owner merge.
- Goal continuation dates to the earlier session-goal feature and increases allocation frequency, but active Goal conversations were not individually large enough to explain a 4 GB one-shot peak.
- The Goal-owner feature merged after the crash and cannot be its direct cause.
- Message metadata growth accumulated over time. An old full-hydration defect crossed the failure threshold only after the database became large enough.

## Existing Test Gaps

- Smoke tests verify health/backfill response values with tiny conversations.
- No test forbids `listMessages()` in health, backfill, or summary-segment save.
- No test seeds large nested metadata or measures heap/RSS.
- Metrics tests verify correctness with small fixtures and one 1,005-task case, not hundreds of MB of metadata/events.
- SSE has no focused transport test for `write() === false`, slow-client removal, or bounded buffering.
- Turn tests exercise behavior extensively but do not assert bounded repository projections or hydration counts.
- No long-duration steady-state test combines Goal continuation, memory health, metrics, and slow SSE clients.

## Falsifiers And Remaining Uncertainty

The direct-trigger conclusion should be downgraded if any of these are later shown:

- an access log proves no memory-health/backfill request occurred near the crash;
- an isolated production-shape reproduction shows pre-fix health remains far below the observed live heap;
- a safe isolated heap-retainer profile instead shows dominant `ServerResponse` buffers, metrics rows, or run closures;
- the new process grows monotonically to 4 GB without memory/metrics panel activity.

Even if one falsifier changes the exact trigger, P0 remains required: the source path is independently capable of materializing the complete production message metadata set and retaining it in one request.

## Ranked Risks

1. **P0, high confidence:** global memory health/backfill full hydration and retained arrays.
2. **P1, medium-high confidence:** unbounded HTTP metrics report.
3. **P1, medium confidence:** SSE socket backpressure ignored.
4. **P2, high confidence amplifier:** repeated Goal/turn full hydration and per-hop closure retention.
5. **P2, high confidence growth source:** unbounded per-run call details and duplicated context snapshots persisted in message metadata.
