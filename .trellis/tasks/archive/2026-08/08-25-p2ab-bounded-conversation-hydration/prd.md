# P2A+B: Bounded Conversation Hydration

## Goal

On the latest `origin/develop` baseline (`75deccd8e618bfb2672512e237f232250580fcd9`), remove conversation-size-dependent hydration from the persistent Goal/turn execution path. Goal continuation, pending main-lane queue discovery, cursor inference/reconciliation, default Agent routing, prompt history, side-lane snapshots, and final reply construction must use purpose-specific SQL queries or bounded message projections.

Each Agent prompt uses at most the latest 24 ordinary history rows, plus the current turn rows and messages explicitly referenced by the runtime. The union is deduplicated and returned in canonical `(createdAt, id)` order. Its in-memory size must depend on this bounded working set, not total conversation history.

## Required Contracts

### Repository projections

- Add purpose-specific `ChatAppStore` / message-repository reads for:
  - conversation header/metadata/participants without messages;
  - pending main-lane user messages after the durable consumed cursor;
  - a message by id and bounded message-id sets;
  - prior surviving user message for deletion cursor reconciliation;
  - latest qualifying public completed Assistant reply for default routing;
  - recent prompt history with a default limit of 24.
- All new reads are bounded by explicit row limits, message ids, or a cursor predicate. No schema or migration changes.
- Production `ChatAppStore` paths fail closed if a required bounded projection is unavailable; compatibility test doubles may implement the new signatures directly.

### Runtime behavior

- Goal continuation and owner/proposal/Stop gates read only the conversation header and targeted queue rows.
- Queue startup prefers the durable cursor. Legacy cursor inference remains compatible but uses targeted SQL rather than full conversation messages.
- Successful batches advance the durable cursor; failed batches do not. Deletion reconciliation keeps assistant-only deletion persistence and previous-user fallback semantics.
- Default Agent priority remains explicit `initialAgentIds` > actionable user mention > latest qualifying current-participant public Assistant reply > first participant.
- Side-lane snapshots store/reference message ids and hydrate only their bounded id set when a queued slot starts.
- Prompt, context-inspector snapshot, and final reply projections use the same bounded history union. Current-turn and explicitly referenced rows are never lost even when older than the latest 24.
- Public/private visibility, stable `(createdAt, id)` ordering, image content blocks, handoff deduplication, parallel mentions, restart recovery, and Goal failure/owner semantics remain unchanged.

## Non-Goals

- No context snapshot table or other schema change.
- No truncation of `modelUsage.calls`.
- No historical data rewrite, compression, deletion, or migration.
- No production 3100 process/config/database changes, heap increase, or production heap snapshot.
- No merge to `develop` before independent review and explicit user acceptance.

## Validation And Error Matrix

| Case | Expected result |
| --- | --- |
| Goal continuation on a large conversation | Schedules/blocks exactly as before; no `getConversation()` or unbounded `listMessages()` call |
| Pending main queue with durable cursor | Returns only later eligible main-lane user rows in stable order |
| Missing durable cursor after restart | Targeted legacy inference reproduces existing pending/consumed decision |
| Failed batch | Cursor remains unchanged and batch retries after restart |
| Deleted consumed user row | Cursor moves to previous surviving user; assistant-only delete persists unchanged cursor |
| Unmentioned main message | Latest qualifying public completed reply Agent wins; private/failed/empty/removed-agent rows are excluded |
| Side snapshot grant | Only snapshotted ids are loaded, with latest persisted content; later ids remain invisible |
| Prompt with >24 old rows | Latest 24 ordinary history rows plus current-turn and explicit references are present once, in canonical order |
| Private mailbox / visibility | Current Agent sees only authorized private rows; public history does not gain private content |
| Missing required bounded store API | Fail closed with the existing unavailable/internal contract; never fall back to full hydration |

## Red Evidence

- Use a real temporary SQLite `ChatAppStore` and poison `getConversation()` and/or unbounded `listMessages()` so any forbidden call throws with a path-specific marker.
- Cover Goal continuation, queue initialization/discovery, cursor inference/reconciliation, and default Agent routing independently so one poison failure cannot mask another path.
- Add prompt/side/final-reply fixtures whose old required/current rows are outside the latest 24, proving the union rule is non-tautological.
- Confirm the tests fail on the `75deccd8` baseline with stacks at the known hydration entrypoints before implementation turns them green.

## Acceptance Evidence

- Compatibility regressions: restart, side lane, deletion cursor, failed batch, Goal owner/proposal/Stop and failure pause, private visibility, image preflight, handoff and parallel mentions.
- Synthetic SQLite shape: 15,052 messages and approximately 373 MiB `metadata_json`, including one large conversation, realistic digest distribution, large single rows, private rows, images, failed batches, and Goal metadata.
- Gate scenarios: one main turn, repeated/long Goal workload, concurrent bounded turns, process restart, side snapshot, and deletion reconciliation. Every scenario records forbidden-call counts, selected row counts, latency, heap/RSS peak and post-GC retention.
- Budgets are pinned in the executable gate after baseline measurement and architecture review; selected history cardinality must remain bounded by `24 + current-turn ids + explicit-reference ids` regardless of total history.
- System Node v24, serial execution: `npm run check`, `npm run typecheck`, `npm run typecheck:public`, `npm run build`, focused runtime/storage suites, and required smoke tests.
- `git diff --check`, high-confidence secret scan, Trellis validation, and read-only SQLite `integrity_check=ok`.
- Exact commit-pinned independent architecture/code review, then isolated acceptance instance with unique port/database/logs and external side effects disabled. User acceptance is required before PR merge.

## Code-Spec Targets

- `.trellis/spec/runtime/conversation-turn-queue.md`: bounded queue, cursor, side snapshot, and prompt-history contracts.
- `.trellis/spec/backend/session-goal.md`: no-message Goal continuation contract.
- `.trellis/spec/unit-test/runtime-tests.md`: real-SQLite poison and production-shape gate patterns.
- Add a backend storage projection spec only if the final repository signatures are too broad for the runtime documents above.

## Rollback

The implementation has no schema/data migration. Reverting the reviewed P2A+B commits restores prior read paths and prompt construction. Synthetic/acceptance databases are disposable isolated artifacts and are removed only after user-authorized acceptance cleanup.
