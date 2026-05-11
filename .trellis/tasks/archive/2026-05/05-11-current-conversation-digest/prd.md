# PRD: Current Conversation Digest / 当前聊天室摘要

## Background

CAFF already keeps recent raw conversation messages in each agent prompt and supports structured conversation digests in conversation metadata. However, users need the injected digest layer to be clearly framed as current-room continuity context rather than hidden long-term memory, and it must sit before recent messages so raw messages can still override stale summaries.

## Goal

Expose a stable `Current Conversation Digest / 当前聊天室摘要` prompt section for each agent turn, sourced only from the current conversation's retained digest metadata, placed before recent raw conversation history, and visible as a distinct Agent Context Inspector section.

## Non-Goals

- Do not restore automatic cross-conversation long-term memory injection.
- Do not search or inject `search-memory` results unless an agent explicitly uses the tool.
- Do not create a new database table for the MVP.
- Do not include private messages or other agents' private content in the digest section.

## MVP Scope

### Prompt Injection

- Use current conversation metadata digests only: latest rollup first, then recent detailed entries.
- Inject the section before `Conversation history` / recent raw messages.
- Label the section clearly as current conversation digest context, not instructions and not long-term memory.
- Keep the existing conflict rule: recent raw messages override digest content.
- Omit the section entirely when no current conversation digest exists.

### Inspector Visibility

- Preserve a dedicated context snapshot section for the digest layer.
- Use a user-readable title such as `Current Conversation Digest / 当前聊天室摘要`.
- Keep visibility `full` with existing redaction rules.
- Ensure section metadata still includes source, approximate tokens, byte size, hash, and truncation state.

### Tests

- Cover prompt order: digest section appears before recent conversation history.
- Cover absence: no empty placeholder when the conversation has no digests.
- Cover provenance wording: section says it is current conversation context and raw recent messages win conflicts.
- Cover Inspector title/source via snapshot metadata where practical.

## Acceptance Criteria

- [ ] Agent prompts include current conversation digest context when retained digests exist.
- [ ] The digest section is placed before recent raw conversation history.
- [ ] The section is clearly named `Current Conversation Digest / 当前聊天室摘要` or equivalent.
- [ ] The section states that it is context, not instructions, and recent raw messages override it.
- [ ] No digest placeholder is injected when there are no current conversation digests.
- [ ] Agent Context Inspector shows the digest as a distinct section with full metadata.
- [ ] Long-term memory remains explicit-tool-only and is not silently injected.
- [ ] Regression tests cover section wording, order, omission, and snapshot metadata.

## Risks And Mitigations

### Digest Confused With Long-Term Memory

Mitigation: label the section as current conversation digest context and keep `search-memory` wording separate.

### Stale Summary Overrides Recent Messages

Mitigation: preserve explicit conflict wording and place raw messages after the digest.

### Hidden Context Concern

Mitigation: keep the section in the Agent Context Inspector as full visibility with redaction.
