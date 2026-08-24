# Summary Memory

## Scenario: Memory Health / Backfill No-Message Projection (OOM Safety)

### 1. Scope / Trigger
- Trigger: the develop/3100 OOM incident where global memory health, global summary backfill, and `saveSummarySegmentFromDigest()` fully hydrated every conversation (repository get + `listMessages()` SELECT * without LIMIT + per-row `JSON.parse(metadata_json)`) and accumulated the hydrated objects for the whole request; production shape is 373MB `metadata_json` with a ~93.5MB single-conversation raw projection.
- Applies when changes touch `getSummaryMemoryHealth()`, `backfillConversationDigestSummarySegments()`, `saveSummarySegmentFromDigest()`, `getConversationWithoutMessages()`, or any projection these paths consume.
- Goal: these memory-summary paths must never read message history and must never accumulate fully hydrated conversation objects, while keeping every existing HTTP field, status value, count, idempotency, task attribution, bounded diagnostic, scoped missing-conversation, and per-digest partial-failure semantics byte-compatible.

### 2. Signatures
- `ChatAppStore.getSummaryMemoryHealth(conversationId?)`
  - Scoped mode: `getConversationWithoutMessages(normalizedConversationId)` (existence + title + metadata only).
  - Global mode: iterates `listConversations()` headers and processes each header immediately inside a per-conversation counting closure; only counters plus the already-bounded `unsyncedDigests` list survive to the response.
- `backfillConversationDigestSummarySegments(store, input)`
  - Scoped mode: `store.getConversationWithoutMessages(...)` when available (fallback `getConversation` only for mock stores that lack the projection); missing conversation still throws `404 'Conversation not found'`.
  - Global mode: iterates `listConversations()` headers and processes each header immediately via a per-conversation backfill closure (`conversationCount` increments per header); no `conversations[]` array is accumulated.
- `ChatAppStore.saveSummarySegmentFromDigest(conversationId, digest, options?)`
  - Uses `getConversationWithoutMessages()` for existence + `conversation.title`; missing conversation still throws `'Conversation not found'`.
- `ChatAppStore.getConversationWithoutMessages(id)` = repository get + agents projection; by construction it never calls `listMessages()` and never parses per-message `metadata_json`.

### 3. Contracts
- None of `getSummaryMemoryHealth()` (global or scoped), `backfillConversationDigestSummarySegments()` (global or scoped), or `saveSummarySegmentFromDigest()` may call `getConversation()` or `listMessages()` or otherwise read message history; the regression guard is a real-SQLite test where `store.listMessages` is poisoned to throw.
- Global health consumes `listConversations()` headers directly; `id`, `title`, and digest metadata are all header fields, so no second hydrated conversation array may be built. Global backfill processes one header at a time with immediate per-header processing.
- Do not add a new streaming id/title/metadata query surface for these paths; `listConversations()` headers and `getConversationWithoutMessages()` are sufficient and keep the emergency-fix surface minimal.
- Response compatibility is frozen: health `{ ok, status: 'ok'|'needs_backfill'|'unavailable', table, segments, search, backfill, diagnostics }` (including bounded `unsyncedDigests` with `missing_segment` / lookup-failure reasons and `conversation_not_found` diagnostics for scoped misses); backfill `{ ok, action: 'backfill', conversationCount, digestCount, segmentCount, failedCount, failures }` (bounded failures, `reason: 'sync_failed'`, per-digest continue-on-error, single request timestamp, explicit-`taskName`-only attribution). Idempotency via unique `source_digest_id` is unchanged.
- Known pre-existing normalization split (locked, not changed by P0): health counts digests with an id via id-only filtering (including pathological empty-summary digests), while backfill's `normalizeDigestEntry` drops empty-summary digests — so a pathological digest can show `unsynced` in health but never be attempted by backfill.
- Memory budgets (from the production-shape synthetic gate, system Node v24): global health ≤10s / ≤128MiB heap delta; scoped health ≤2s / ≤64MiB; global backfill (single + idempotent repeat) ≤120s / ≤128MiB; 20 consecutive health runs leave ≤32MiB post-GC retained heap; concurrent (8-way real HTTP) health leaves ≤320MiB peak RSS delta with zero retained growth. The synthetic seed is deterministic, non-sensitive, and records exact digest count/distribution (201 digests / 64 conversations, distribution {1×21, 3×21, 5×21, 12×1}); it is not a production copy and must not become one.

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| any of the five paths (global/scoped health, global/scoped backfill, direct `saveSummarySegmentFromDigest`) | `store.listMessages` poisoned to throw | all complete successfully without reading message history |
| scoped health / scoped backfill | conversation id missing from store | health records `conversation_not_found` diagnostic; backfill throws `404 'Conversation not found'` |
| global health / global backfill | empty store | health `status: ok` with zero counts; backfill returns all-zero counts and `segmentCount: 0` |
| global backfill | repeated invocation | counts identical, `segmentCount` stable, exactly one row per `source_digest_id`, no duplicates |
| backfill | one conversation's digest save throws | continue-on-error: remaining conversations still backfill, `failedCount`/bounded `sync_failed` failures reported, health recheck shows remaining unsynced |
| direct `saveSummarySegmentFromDigest` | valid digest | stores/updates one segment keyed by `source_digest_id` using only existence + `conversation.title` from the no-message projection |

### 5. Tests Required
- `tests/storage/summary-memory-no-messages.test.js`: real SQLite store with `store.listMessages` poisoned to throw; covers global/scoped health, global/scoped backfill, direct `saveSummarySegmentFromDigest`, scoped missing-conversation diagnostics, per-digest partial-failure continue-on-error, empty-store semantics, repeat-backfill idempotency, and `taskName` attribution branches — all under the no-message contract.
- `scripts/summary-memory-p0-gate.js` (with `scripts/summary-memory-p0/{synthetic-seed.js, gate-child.js}`): production-shape synthetic SQLite gate enforcing the heap/RSS/latency budgets above for single, repeated, and concurrent health/backfill runs; fails with exact `listMessages` call counts if the implementation regresses to full hydration.

### 6. Wrong vs Correct
#### Wrong
```ts
// Health/backfill/save paths hydrating full history per conversation.
const conversation = this.getConversation(conversationId); // listMessages() SELECT * + JSON.parse(metadata_json)
conversations.push(conversation); // accumulated for the whole request
```
- On production shape (373MB metadata_json) this reaches multi-GB live sets and triggered the develop/3100 OOM.

#### Correct
```ts
// Global: process one lightweight header at a time.
for (const header of this.listConversations()) countConversationDigests(header);
// Scoped / direct save: no-message projection.
const conversation = this.getConversationWithoutMessages(conversationId);
```
- Only counters, bounded diagnostics, and lightweight projections survive the request; message history is never read.

## Scenario: Cross-Conversation Summary Segment Search

### 1. Scope / Trigger
- Trigger: implementing searchable long-term experience memory across CAFF conversations and tasks.
- Applies when changes touch digest persistence, summary segment storage, `/api/memory/search`, agent `search-memory`, recall trace metadata, or prompt recall of historical experience.
- Goal: promote bounded conversation digests into a lightweight searchable ledger before adding embeddings or a heavier evidence index.

### 2. Signatures
- Storage table: `chat_summary_segments`
  - Fields include `conversation_id`, `source_digest_id`, `source_kind`, `conversation_title`, `task_name`, `summary`, structured section JSON, message range, provenance, and bounded `search_text`.
  - `source_digest_id` is unique so syncing a digest into the ledger is idempotent.
- Conversation metadata recall cache:
  - `conversation.metadata.conversationRetrievalTraces?: ConversationRetrievalTrace[]`
  - Trace shape: `{ id, kind: 'summary_memory_search', tool: 'search-memory', status: 'seen'|'used'|'pinned'|'expired', createdAt, turnId, agentId, agentName, assistantMessageId, queryPreview, latest, filters, resultCount, usageCheckedAt?, results }`
  - Trace `results[]` stores bounded summary-segment evidence only: `{ sourceDigestId, sourceKind, conversationId, conversationTitle, taskName, summary, facts, decisions, nextActions, artifacts, matchedTerms, score, segmentUpdatedAt, status, usedAt?, usageScore? }`.
- Store methods:
  - `saveSummarySegmentFromDigest(conversationId, digest, options?)`
  - `deleteSummarySegmentBySourceDigestId(sourceDigestId)`
  - `deleteSummarySegmentsByConversationId(conversationId)`
  - `searchSummarySegments({ query, limit?, excludeConversationId?, taskName?, sourceKind?, conversationTitle?, updatedAfter?, updatedBefore? })`
- API:
  - `GET /api/memory/search?q=...&latest=true&limit=...&excludeConversationId=...&taskName=...&useCurrentTask=true&sourceKind=entry|rollup&conversationTitle=...&updatedAfter=YYYY-MM-DD&updatedBefore=YYYY-MM-DD`
  - `POST /api/memory/search` with `{ query | q, latest?, recent?, limit?, excludeConversationId?, taskName?, useCurrentTask?, sourceKind?, conversationTitle?, updatedAfter?, updatedBefore? }`
  - `GET /api/memory/health?conversationId=...`
  - `POST /api/memory/backfill` with `{ conversationId?, taskName? }`
  - `POST /api/agent-tools/search-memory` with `{ invocationId, callbackToken, query | q, latest?, recent?, limit?, includeCurrentConversation?, excludeCurrentConversation?, useCurrentTask?, taskName?, sourceKind?, conversationTitle?, updatedAfter?, updatedBefore? }`
  - Search response: `{ ok, query, scope: 'summary-segments', searchMode, resultCount, results, diagnostics }`
  - Health response: `{ ok, status: 'ok'|'needs_backfill'|'unavailable', table, segments, search, backfill, diagnostics }`, where `backfill.unsyncedDigests` is a bounded diagnostic list with conversation/digest ids and reasons.
  - Backfill response: `{ ok, action: 'backfill', conversationCount, digestCount, segmentCount, failedCount, failures }`, where `failures` is bounded and includes digest-level failure reasons.

### 3. Contracts
- Digest `create` and auto-create should sync the newly created digest entry into `chat_summary_segments`.
- Digest compaction should sync the produced rollup segment into `chat_summary_segments` and delete searchable segments for obsolete digest ids that are no longer retained in `conversation.metadata.conversationDigests`.
- Synced digest segments should stamp the active Trellis task name when a resolver is available; the server passes the current `.trellis/.current-task` title/name so task filters work for real manual and automatic digest output, not only direct store calls.
- Legacy metadata-only digests can be backfilled into summary segments via `POST /api/memory/backfill`; backfill is idempotent through `source_digest_id` and should only apply `taskName` when explicitly supplied, avoiding accidental attribution of old conversations to the currently active task. Backfill should not silently hide digest-level write failures: it returns `failedCount` plus bounded `failures` with conversation id/title, digest id/kind, reason, and message.
- `GET /api/memory/health` performs a lightweight summary-memory self-test: verifies the `chat_summary_segments` ledger can be counted, runs latest-mode search with limit 1, reports total segments/latest segment, and compares metadata digest ids against existing `source_digest_id` rows to expose pending backfill without writing data. Pending backfill includes a bounded `unsyncedDigests` list with `missing_segment` or lookup failure reasons.
- Explicit digest `delete` removes the matching summary segment by `source_digest_id`.
- Explicit digest `clear` removes all summary segments for that conversation.
- Search is bounded keyword LIKE search in this iteration; do not add embeddings/vector search yet.
- Summary segment search uses OR recall across extracted query terms and ranks results by matched-term coverage before recency, so multi-word searches can still find partial historical matches while putting fuller matches first; query extraction should word-segment CJK text when runtime support is available and fall back to deterministic bounded CJK bigrams when it is not, so Chinese memory searches are not forced into exact whole-sentence matches.
- Search results expose bounded `matchedTerms` (up to 8 query terms) plus numeric `score` so UI, tools, and prompt recall can explain why a segment was recalled without exposing raw source messages.
- Search text includes bounded digest provenance (`sourceKind`, `triggerReason`, and `createdBy`) in addition to title/task/summary sections, so searches like `manual`, `high_value_signal`, or model names can recall relevant summary segments.
- Search may optionally filter by `taskName` and `conversationTitle` with bounded LIKE matches, by `sourceKind` using exact `entry`/`rollup`, and by `updatedAfter`/`updatedBefore` date boundaries on `segment_updated_at`; filters narrow results after the normal current-conversation exclusion.
- `/api/memory/search` normally requires a query, but `latest` / `recent` can request the latest bounded summary segments with the same filters; this uses `like_latest` mode and does not copy raw source messages.
- `/api/memory/search` may accept `useCurrentTask` / `currentTask` to resolve the active Trellis task into the same `taskName` filter; explicit `taskName` wins, and unresolved current task requests fail with 400 instead of widening to global search.
- Agent `search-memory` tool should default to excluding the active conversation so manual retrieval favors cross-conversation/cross-task experience; `includeCurrentConversation` may opt back in, `--latest` / `--recent` can request newest bounded summary segments without a query, `--current-task` resolves the active Trellis task into a task filter, and `--task` / `--conversation` / `--kind` / `--since` / `--until` expose the same filters.
- Successful agent `search-memory` calls with at least one result record a bounded `conversationRetrievalTraces` entry on the active conversation with `status: 'seen'`. This cache captures evidence the tool returned even if the assistant only paraphrases part of it publicly; failed or zero-result searches do not write trace entries.
- After an assistant reply completes, the runtime runs a deterministic weak-overlap usage check for traces from that same assistant message and agent. Matching evidence is promoted from `seen` to `used` with `usedAt` and `usageScore`; non-matching evidence remains `seen`. The matcher may use bounded source ids, titles, summaries, section snippets, matched terms, English tokens, and CJK bigrams, but must not call an LLM or inspect raw tool transcripts.
- `pinned` evidence is reserved for future user/system keep actions and must not be demoted by usage checks; `expired` evidence stays in metadata for audit but is omitted from prompt injection.
- Recall trace metadata must never store raw public messages or full tool transcripts. It stores only bounded summary-segment fields, source digest ids, query/filter provenance, agent/turn/message ids, usage status, and compact section snippets.
- Prompt assembly must not run cross-conversation summary-memory search by default. Long-term memory should enter agent context through explicit retrieval (`search-memory`) and the same-agent `conversationRetrievalTraces` cache produced by that tool, not through silent per-turn recall.
- Agent-facing prompt text should teach explicit retrieval triggers: when users mention prior context such as “上次”, “之前”, “还记得吗”, “回忆一下”, or equivalent wording, the agent should call `search-memory` instead of assuming long-term memory was already injected.
- Prompt assembly may inject same-agent `conversationRetrievalTraces` as `Last recalled evidence cache` before live conversation history. The section is recall evidence, not instruction; it filters to the current agent id so one agent's retrieved context does not silently become another agent's private working memory. Prompt selection prioritizes `pinned`, then `used`, then `seen`; `used`/`pinned` entries include detailed sections, `seen` entries are compact candidates, and `expired` entries are omitted. Prompt text must say current raw messages and current task/spec context override recalled evidence.
- The automatic summary-memory query/diversity helper may remain as an opt-in compatibility path, but the default executor path must leave `relatedMemorySegments` empty and must not call `searchSummarySegments` during normal agent turn startup.
- Chat UI exposes a long-term memory search drawer that calls `/api/memory/search`, defaults to excluding the active conversation, can opt into current-conversation results, exposes optional task/current-Trellis-task/conversation-title/date/kind filters, can show latest bounded summary segments without a keyword, shows trigger/created-by provenance plus matched terms/score, lets users open the source conversation for a returned segment, shows `/api/memory/health` status and pending backfill counts, and exposes an explicit idempotent “backfill all legacy digests” action that calls `POST /api/memory/backfill` without implicit task attribution.
- Chat composer supports `/memory <query>` and `/mem <query>` as UI-only slash commands: they open the long-term memory drawer, run the same default current-conversation-excluding search, clear the composer, and do not create a chat message; `/memory` with no query only opens/focuses the drawer.
- `conversationDigestState` remains lightweight; raw source messages must not be copied into summary segment state.

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| `saveSummarySegmentFromDigest` | missing conversation | throws `Conversation not found` |
| `saveSummarySegmentFromDigest` | valid digest | stores/updates one segment keyed by `source_digest_id` |
| `searchSummarySegments` | multi-term query | returns bounded summary segment results ranked by matched-term coverage, then recency, with per-result `matchedTerms` |
| `searchSummarySegments` | CJK query without spaces | word-segments the bounded query when supported, otherwise uses bounded CJK bigrams, and can match related Chinese summary text by segmented terms instead of only exact full phrase |
| `searchSummarySegments` | query matches `triggerReason` or `createdBy` provenance | returns the matching summary segment and includes those terms in `matchedTerms` |
| `searchSummarySegments` | `excludeConversationId` set | excludes segments from that conversation |
| digest sync | task resolver returns active Trellis task | stores the task name on the summary segment for later task-filtered search |
| `searchSummarySegments` | `taskName`, `conversationTitle`, `sourceKind`, and date boundaries set | returns only matching task/title/kind/date-window summary segments and echoes filters |
| `/api/memory/search` | `useCurrentTask` set and active task resolves | searches with the resolved `taskName` filter and echoes it in filters |
| `/api/memory/search` | `useCurrentTask` set but no task resolves | returns `400 Unable to resolve the current Trellis task for memory search` |
| `search-memory` bridge tool | `useCurrentTask` set inside a Trellis project | resolves the active task title/name into the same task filter and echoes it in filters |
| `search-memory` bridge tool | `latest: true` without query | returns latest bounded summary segments with `searchMode: like_latest` and preserves current-conversation exclusion by default |
| `search-memory` bridge tool | successful search returns one or more results | appends one bounded `seen` `conversationRetrievalTraces` entry to active conversation metadata and returns `recallTrace` diagnostics |
| `search-memory` bridge tool | failed search or zero results | does not write a retrieval trace |
| assistant reply completion | reply overlaps a same-turn trace result by source id/title/summary/section tokens | promotes that result and trace to `used` with bounded usage diagnostics |
| assistant reply completion | reply does not overlap a same-turn trace result | leaves that result as compact `seen` evidence |
| prompt recall cache | trace contains `used`, `seen`, and `expired` evidence | injects used evidence first with details, seen evidence compactly, and omits expired evidence |
| default agent turn startup | summary-memory store is available and recent text matches historical segments | does not call `searchSummarySegments` and does not inject `Retrieved Long-Term Memory` automatically |
| explicit `search-memory` retrieval | successful same-agent trace exists | injects the bounded `Last recalled evidence cache` for that same agent on later turns |
| opt-in automatic recall helper | keyword search returns many matches from one source conversation plus lower-ranked matches from another source conversation | requests up to 15 bounded candidates and includes cross-conversation diversity before filling remaining prompt slots |
| opt-in automatic recall helper | keyword search returns fewer than five results and active task resolves | fills unused slots with latest bounded segments using a `taskName` filter, deduplicates already selected segments, excludes the current conversation, and labels the recall reason |
| opt-in automatic recall helper | latest current-task fallback finds no exact task-title filter results but latest segments include a slug-like alias for the active task | uses the bounded latest candidate pool, applies normalized title/slug alias locally, and returns only matching current-task memories |
| `GET /api/memory/search` | missing query without `latest` / `recent` | `400 query is required` |
| `POST /api/memory/search` | `latest: true` without query | returns latest bounded summary segments with `searchMode: like_latest` |
| `GET/POST /api/memory/search` | invalid `sourceKind` | `400 sourceKind must be entry or rollup` |
| `POST /api/memory/search` | `excludeConversationId` set | returns matching segments outside that conversation |
| `GET /api/memory/health` | table/search available and all metadata digests synced | returns `status: ok` with segment count and latest segment provenance |
| `GET /api/memory/health` | metadata digests lack summary segment rows | returns `status: needs_backfill` with `backfill.unsyncedDigestCount` and bounded `unsyncedDigests` reasons |
| `GET /api/memory/health` | summary-memory store/search unavailable | returns `status: unavailable` with diagnostics instead of pretending memory is empty |
| `POST /api/memory/backfill` | legacy metadata digests exist | idempotently creates searchable summary segments and returns zero `failedCount` |
| `POST /api/memory/backfill` | a digest fails to sync into a segment | returns bounded `failures` with `reason: 'sync_failed'` instead of hiding the failed digest |
| `POST /api/memory/backfill` | `taskName` supplied | stamps that explicit task on backfilled segments |
| Memory drawer backfill action | clicked by user | calls `POST /api/memory/backfill` explicitly, shows conversation/digest/segment counts, and does not apply task attribution silently |
| digest compaction | older entry segments exist | syncs/updates the rollup segment and removes obsolete entry segments from search |
| digest delete | segment exists | removes matching segment |
| digest clear | segments exist | removes all segments for conversation |

### 5. Tests Required
- `tests/storage/chat-store.test.js`: store can save and search digest summary segments across conversations, including task/title/kind/date filters and CJK segmented query terms.
- `tests/smoke/server-smoke.test.js`: digest create syncs a searchable task-attributed segment, digest compaction removes obsolete entry segments while retaining the rollup segment, and digest delete removes its segment; auto-create stamps task attribution; `/api/memory/search` accepts exclusion plus task/title/kind/date/current-task filters; `/api/memory/health` reports ok/needs_backfill/unavailable readiness with unsynced digest reasons; `/api/memory/backfill` makes legacy metadata digests searchable and reports digest-level sync failures.
- `tests/runtime/agent-executor-hook.test.js`: default agent turn startup does not call summary-memory search and prompt guidance tells agents to use explicit `search-memory` triggers instead of assuming automatic injection.
- `tests/runtime/turn-orchestrator.test.js`: when covering the opt-in automatic helper, validates query construction, task affinity, diversity, latest current-task fallback, slug-like task aliases, and `search-memory` filter guidance.
- `tests/runtime/agent-tool-bridge.test.js` and `tests/runtime/agent-chat-tools.test.js`: agent `search-memory` tool routes through the bridge, remains bounded, excludes current conversation by default, supports latest-without-query lookup, forwards task/title/kind/date filters, records bounded `seen` retrieval traces for successful result-bearing searches, and promotes weakly matched evidence to `used` after assistant replies.

### 6. Wrong vs Correct
#### Wrong
```ts
conversation.metadata.summarySegments = rawMessages;
conversation.metadata.conversationRetrievalTraces = [fullToolTranscript];
```
- This bloats metadata and stores raw source messages or full tool outputs in long-term state.

#### Correct
```ts
store.saveSummarySegmentFromDigest(conversationId, digest, { metadata: { source: 'conversation_digest' } });
recordConversationRetrievalTrace(store, conversationId, {
  tool: 'search-memory',
  queryPreview: query,
  results: response.results,
});
```
- This stores bounded structured digest output in the searchable ledger and only bounded source ids/snippets in the same-agent recall cache.
