# PRD: Agent Context Inspector

## Background

CAFF already supports exporting each agent session, but raw JSON is hard for users to inspect. Existing recording features mainly expose system context, while users often cannot tell which part of the prompt/context a behavior came from. We need an agent context display feature that makes the actual injected context observable, explainable, and exportable without leaking private or sensitive data.

## Goal

Build an Agent Context Inspector that lets users inspect, per agent and per turn, the context sections actually injected into an agent run. The feature should answer: "What context did this agent receive, which section did it come from, how large was it, was it truncated, and can I export it in a readable form?"

## Non-Goals

- Do not expose hidden system/developer instructions, secrets, auth tokens, raw environment variables, or other agents' private content.
- Do not replace the existing raw session JSON export in the MVP.
- Do not implement prompt editing or replay from the inspector in the MVP.
- Do not build a complete token-accurate tokenizer if the project currently only has approximate token accounting.

## MVP Scope

### Snapshot Capture

- Capture context section snapshots at agent turn start, based on the actual prompt/context assembled for that run rather than reconstructing from current data sources later.
- Store section metadata: `sectionKey`, title, source, visibility level, content hash, approximate tokens, byte size, truncated flag, and truncation note when available.
- Preserve per-agent and per-turn boundaries.

### Visibility Model

Use a three-level display policy, with `full` as the default for user-inspectable context that was actually injected for the selected agent turn:

1. `full`: show complete content after inline secret/path redaction.
2. `summary`: show metadata and a safe summary only when the runtime explicitly requests a summary view.
3. `presence`: only show that the section exists when the runtime explicitly marks it presence-only.

Initial policy:

- `full`: conversation messages, session goal/checklist, Trellis task/PRD/spec excerpts, persona instructions, skill descriptions, memory/digest excerpts, routing/tool instructions, private mailbox content received by the selected agent, and sandbox guidance.
- `summary`: reserved for intentionally summarized future sections.
- `presence`: reserved for sections that are not user-inspectable runtime material or are explicitly marked presence-only by trusted backend code.

Any section containing `PI_AGENT_PRIVATE_DIR`, `CAFF_CHAT_TOOLS_PATH`, auth env values, tokens, or secret-like values must not render those raw values; redact the concrete value inline and keep surrounding context readable.

### UI

- Add a right-side inspector drawer accessible from the conversation/session UI.
- Provide agent and turn selection.
- Show a top summary with total approximate tokens and per-section proportions.
- Render context sections as collapsible cards with title, source, visibility level, token estimate, byte size, hash, and truncation status.
- Default to metadata-only; load/render expanded content on demand.
- Use clear treatment for redacted values and reserve locked/presence treatment for explicitly presence-only sections.

### Export

- Provide readable export, with Markdown as the MVP format.
- Export should preserve sections, metadata, visibility decisions, readable content, redactions, and any presence-only placeholders.
- Raw JSON can remain available for developer/debug workflows but should not be the primary user-facing export.

## Acceptance Criteria

- [ ] A user can open an Agent Context Inspector for a conversation turn.
- [ ] A user can switch by agent and turn.
- [ ] The inspector lists context sections with source, approximate token count, byte size, hash, visibility level, and truncation state.
- [ ] Expanding a section shows the injected content by default, with sensitive values redacted inline.
- [ ] Presence-only sections are used only for explicitly presence-only runtime material and never render raw sensitive content.
- [ ] The displayed snapshot is captured from the actual injected context at turn start, not rebuilt from current mutable sources.
- [ ] Markdown export produces a readable grouped document with section metadata and safe content/placeholders.
- [ ] Full-visibility sections undergo secret-pattern redaction before rendering; no raw tokens/secrets appear in any expanded view.
- [ ] Snapshots are immutable after write; export hash matches stored display hash or a warning is shown.
- [ ] Tests cover visibility policy, snapshot metadata, export redaction, and per-agent/per-turn isolation.

## UX Notes

- Right drawer should avoid blocking the main chat.
- Turn selector should use lightweight turn numbers rather than a calendar metaphor.
- Token proportions should be visible at a glance.
- Sections should be understandable to non-developer users; avoid exposing implementation-only jargon where possible.

## Risks And Mitigations

### Sensitive Context Leakage

Mitigation: centralize section visibility policy and add regression tests for inline secret/env/path redaction without over-hiding full sections.

### Snapshot Inaccuracy

Mitigation: instrument the prompt assembly path and store section-level snapshots before model execution begins.

### Performance Cost

Mitigation: persist metadata eagerly, render content lazily, and avoid serializing large section bodies until expanded/exported.

### Cross-Agent Isolation

Mitigation: key snapshots by conversation/session, agent, and turn; enforce access and redaction rules when reading snapshots.

## Open Questions

- Where should snapshots be persisted: existing session export store, conversation database, or a dedicated context snapshot table/file?
- Should Markdown export be downloadable only, copy-to-clipboard only, or both?
- What exact UI entry point should open the drawer: message action, top-bar button, or agent panel action?
- Do we need HTML export in the first release, or should it follow Markdown after MVP validation?
