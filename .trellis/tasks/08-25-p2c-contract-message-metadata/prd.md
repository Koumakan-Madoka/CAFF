# P2C Contract Message Metadata

## Goal

On the accepted P2C-Expand baseline, reduce future assistant-message storage and browser transport costs without changing historical rows or user-visible conversation semantics. Full agent context snapshots and retained model-usage call details remain authoritative in the Expand detail tables, while `chat_messages.metadata_json` and browser-facing message payloads carry only timeline-safe summaries.

## Requirements

### Future assistant writes

- Apply Contract storage only to newly created or subsequently updated assistant messages. Do not rewrite, backfill, compress, or otherwise mutate historical `chat_messages` rows.
- Persist the full `agentContextSnapshot`, including section `displayContent`, to `chat_message_context_snapshots` in the same SQLite transaction as the queued message create or lifecycle update.
- Persist retained `modelUsage.calls` detail to `chat_message_model_usage_calls` in the same SQLite transaction as completed or error updates.
- Pass full detail to `ChatAppStore` through explicit write-only detail inputs. Do not reconstruct table detail from lightweight message metadata.
- Store only a lightweight snapshot summary/reference in `metadata_json`: schema version, stable snapshot/message/conversation/turn/agent/prompt identifiers, aggregate sizes/tokens, section count, and section metadata required to identify the snapshot. It must not contain section `displayContent`.
- Store only full-population model-usage aggregate counters and retention counts in `metadata_json`. It must not contain `modelUsage.calls`.
- Preserve queued, streaming/tool, completed, error, failed, cancelled, null-usage, private, image, cross-conversation, Goal, handoff, and turn semantics.
- A detail write failure must roll back the entire corresponding message create or update.

### Reads and transport

- Keep Inspector, Markdown export, and internal dedicated detail reads table-first with legacy metadata fallback.
- Preserve legacy-only, Expand dual-written, and Contract table-backed messages in one conversation.
- Add one shared lightweight message transport projection and use it for `GET /api/conversations/:conversationId/messages` and every `conversation_message_created` / `conversation_message_updated` SSE producer.
- Project legacy and Expand rows at transport time without changing their stored bytes.
- Browser-facing message metadata must never include snapshot section `displayContent` or `modelUsage.calls`, regardless of storage generation.
- Preserve all fields required by the timeline, context button, deletion eligibility, session/usage badges, digest state, cross-conversation delivery, private/image messages, Goal continuation, handoff, and tool trace navigation.
- Keep the SSE `message` envelope for compatibility, but project its message payload through the same shared transport function used by message pagination.

### Model usage retention

- Keep Expand's table retention rule: at most 64 detailed calls, consisting of the first call and the most recent 63 calls.
- Preserve original call `sequence` values.
- Keep total, retained, dropped, and truncated counts plus the four full-population aggregate counters independent of the retained calls array.

### Rollback and compatibility

- Contract only guarantees rollback to the accepted Expand version.
- A precise Expand build must open a Contract-era database, read full Contract-era snapshots and retained usage details from the detail tables, update messages successfully, and pass SQLite integrity checks.
- Do not require pre-P2C code to understand Contract-era lightweight metadata.
- Do not alter schema, prompt construction, routing, Goal ownership/proposals/Stop behavior, queue/cursor semantics, private/image/handoff behavior, or production configuration.

## Non-Goals

- No historical backfill, metadata compression, row rewrite, or historical compression tool.
- No production deployment, production database access, production process restart, or port 3100 changes.
- No changes to prompt content/windowing, routing, turn queue semantics, Goal semantics, tool trace source, private messages, image handling, or handoff behavior.
- No merge to `develop` before exact-SHA independent review and explicit user acceptance in an isolated preview.

## Acceptance Criteria

- [ ] The room branch is synchronized to the accepted Expand merge tree and all applicable backend/runtime/frontend/unit-test/cross-layer specs are loaded.
- [ ] Exact Expand baseline tests fail for the expected full-metadata and full-transport behaviors before implementation.
- [ ] Real SQLite tests prove queued/completed/error Contract writes keep full detail in tables and lightweight metadata in `chat_messages`, with create/update rollback on injected detail failures.
- [ ] Lifecycle tests cover streaming/tool updates, completed, error/failed, cancelled, and null-usage states without rewriting immutable snapshot details or losing usage aggregates.
- [ ] Dedicated detail reads, Inspector, and Markdown export work for legacy-only, Expand dual, and Contract rows using table-first/legacy-fallback semantics.
- [ ] Real HTTP and SSE tests prove message pages and all created/updated events contain no `displayContent` or `modelUsage.calls` for legacy, Expand, or Contract rows while required timeline fields remain present.
- [ ] Restart, deletion cascade, pagination cursor, SSE reconnect, Goal/turn/private/image/handoff/cross-conversation/tool-trace regressions pass.
- [ ] A production-shape synthetic SQLite gate proves historical metadata bytes are unchanged, new-row and database growth are materially smaller, page/SSE payloads are bounded, and memory/latency/integrity remain within recorded budgets.
- [ ] A precise accepted Expand build successfully reads and updates a Contract fixture, then Contract can reopen it with full detail intact.
- [ ] Check, typecheck, public typecheck, build, focused suites, secret scan, diff review, executable specs, exact-SHA independent review, and isolated manual acceptance complete before integration.

## Technical Notes

- Prefer the existing `buildStoredContextSnapshotSummary`, `retainModelUsageCalls`, detail repository, and pagination patterns introduced by P2C-Expand.
- The transport projection must be structured and shared; avoid endpoint-specific object deletion or JSON string manipulation.
- The context button remains enabled through the lightweight `metadata.agentContextSnapshot.snapshotId` compatibility shape.
- Timeline model badges continue reading the four aggregate counters from lightweight `metadata.modelUsage`; detailed calls remain available only through dedicated table-first reads or the existing session trace path.
- Red tests must be non-tautological: run unchanged against exact Expand artifacts and fail on behavior assertions, not missing imports or build failures where avoidable.
