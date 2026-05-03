# PRD: conversation-digest

## Goal
- Design and implement a lightweight Conversation Digest MVP for CAFF so long multi-agent conversations can preserve durable, structured context beyond the recent-message prompt window.

## Requirements
- Support a manual `/digest` slash command that summarizes the current conversation without sending the slash command as a normal user message.
- Store digest entries as append-only conversation metadata under `conversation.metadata.conversationDigests` for the MVP, avoiding a database schema change.
- Use a structured digest shape with `facts`, `decisions`, `openQuestions`, `nextActions`, and `artifacts` sections.
- Include digest provenance fields so users and agents can understand when it was created and which conversation range it summarizes.
- Inject recent digest entries into agent prompts as historical context, clearly lower priority than recent raw messages.
- Keep digest generation user-triggered in MVP; do not add automatic N-turn summarization yet.
- Provide concise slash-command feedback and refresh conversation metadata in the UI after digest creation.
- Add a lightweight right-side digest/timeline panel that lists digest entries and their structured sections.
- Allow users to delete a digest entry from the panel if it is stale or inaccurate.
- Keep storage bounded by limiting retained digest entries and trimming oversized section text.

## Out of Scope
- Vector embeddings, semantic search, hybrid retrieval, or project/global evidence indexes.
- Cross-conversation merge or Trellis task journal export.
- Background automatic summarization on idle or close.
- Agent-side direct durable digest mutation without a user-triggered command.
- Database migrations for dedicated digest tables.

## Technical Notes
- Store entries under `conversation.metadata.conversationDigests`.
- Digest entry shape: `{ id, createdAt, updatedAt, createdBy, messageRange, summary, facts, decisions, openQuestions, nextActions, artifacts }`.
- `messageRange` should include enough lightweight provenance to identify summarized public-message bounds, e.g. `{ fromMessageId?, toMessageId?, messageCount }`.
- Manual `/digest` may create the digest through a thin conversation API endpoint and reuse the existing turn/model infrastructure where appropriate.
- Prompt injection should sit before recent public history and state: digest is historical, recent raw messages override it.
- Default retention should be small and predictable, e.g. latest 5 digest entries per conversation.
- Default auto-continuation safety budget remains unrelated to digest behavior.

## Acceptance Criteria
- [ ] `/digest` creates a structured digest entry for the selected conversation and does not appear as a normal chat message.
- [ ] Digest entries persist in conversation metadata and survive reloads.
- [ ] Agent prompts include retained digest entries with historical-context guidance.
- [ ] Recent raw conversation messages remain higher priority than digest content.
- [ ] Conversation summaries/API payloads expose updated digest metadata after creation or deletion.
- [ ] Right-side chat UI shows a digest timeline panel with structured sections.
- [ ] Users can delete an inaccurate digest entry from the panel.
- [ ] Tests cover digest metadata lifecycle and prompt injection behavior.
