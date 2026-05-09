# Conversation Digest Auto-Generation + Auto-Compaction

## Objective
Upgrade CAFF conversation digest from manual entries to a bounded automatic memory layer that creates model-backed summaries after enough new public messages and compacts older digest entries into a rollup.

## Scope
- Add a v3 same-agent retrieval trace cache for successful `search-memory` calls so tool-returned evidence survives into the next turn even when the public assistant reply only paraphrases part of it.
- Extend digest metadata entries with a `kind` field: `entry` for regular digest entries and `rollup` for compacted historical summaries.
- Add deterministic `compact` behavior that merges older digest entries into a bounded rollup without requiring embeddings or a background LLM.
- Add optional automatic digest creation after enough new public messages, intended to run after assistant replies complete.
- Add lightweight `conversationDigestState` waterline metadata plus optional idle-window, cooldown, and high-value-signal gates inspired by Clowder without adding a new table.
- Run compaction automatically after manual or automatic digest creation when detailed entries exceed the recent-entry budget.
- Keep manual control with `/digest`, `/digest compact`, and UI buttons.
- Keep prompt injection ordered as rollup first, then recent detailed entries, then same-agent recalled evidence traces, while preserving “recent raw messages override digest” guidance.

## Non-Goals
- Do not implement semantic/vector search.
- Do not auto-generate digests on every turn; only trigger after a configurable new-message budget or explicitly enabled high-value gate, and respect idle/cooldown limits.
- Do not add a new database table in this iteration.
- Do not persist raw tool transcripts or raw public messages inside recall trace metadata; store only bounded summary-segment snippets and source ids.

## Acceptance Criteria
- When `CAFF_DIGEST_AUTO_CREATE=true`, completed assistant replies update digest state and trigger digest creation once new public messages reach the message budget and any configured idle/cooldown gates allow it.
- Automatic digest creation uses configured model summary mode and stores bounded `entry` digests with trigger provenance.
- Creating more than the recent-entry budget automatically produces or updates one `rollup` digest and keeps only recent `entry` digests.
- `POST /api/conversations/:id/digest` supports `{ "action": "compact" }`.
- `/digest compact` calls the same API path and does not create a chat message.
- The digest panel marks rollup entries and exposes a compact action.
- Prompt includes compacted rollup before recent detailed digest entries.
- Successful agent `search-memory` calls with results write bounded `conversationRetrievalTraces` metadata and return recall-trace diagnostics.
- Prompt includes same-agent recalled evidence cache before conversation history and filters traces by current agent id.
- Regression tests cover automatic digest creation, automatic compaction, manual compaction, idle/cooldown/high-value gates, prompt ordering, retrieval trace persistence, and recall-cache prompt injection.
