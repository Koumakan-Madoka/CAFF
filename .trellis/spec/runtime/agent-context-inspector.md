# Agent Context Inspector

## Scenario: Context Snapshot Capture And Safe Rendering

### 1. Scope / Trigger

- Trigger: features that expose agent prompt/context data to users, export files, or UI drawers.
- Applies to `server/domain/conversation/turn/agent-prompt.ts`, `server/domain/conversation/turn/agent-executor.ts`, `server/domain/conversation/turn/context-snapshot.ts`, `server/api/conversations-controller.ts`, and `public/` chat UI.
- Goal: show what an agent actually received per agent turn, with section content visible by default and only concrete secret values, token values, or sensitive local paths redacted inline.

### 2. Signatures

- Prompt section builder: `buildAgentTurnPromptSections(input) -> ContextPromptSectionInput[]`.
- Prompt formatter: `formatAgentTurnPromptSections(sections) -> string`.
- Snapshot builder: `createAgentContextSnapshot({ conversationId, turnId, messageId, agentId, agentName, promptVersion, sections }) -> AgentContextSnapshot`.
- Snapshot read API: `GET /api/conversations/:conversationId/messages/:messageId/context-snapshot` returns `{ snapshot }` with safe display content only.
- Snapshot list API: `GET /api/conversations/:conversationId/context-snapshots` returns `{ conversationId, snapshots }` with metadata summaries.
- Markdown export API: `GET /api/conversations/:conversationId/messages/:messageId/context-snapshot-export` downloads `text/markdown`.
- Assistant message metadata key: `metadata.agentContextSnapshot` stores the immutable safe snapshot for that message.

### 3. Contracts

- Snapshot capture happens after prompt sections are assembled and before `startRun(...)` is invoked.
- The exact prompt sent to the model must be produced from the same `promptSections` object passed into `createAgentContextSnapshot`; do not rebuild prompt context a second time for snapshot capture.
- Prompt assembly should omit optional sections that have no material body instead of emitting placeholder-only content such as `- none`, `No private mailbox items.`, legacy `No saved memory cards.`, or `No prior messages.`; omitted sections must also be absent from Inspector snapshots. Memory Cards are deprecated and must not be newly injected even when stored cards exist.
- Every section stores `sectionKey`, `title`, `source`, `visibility`, `contentHash`, `displayContentHash`, `approxTokens`, `byteSize`, `truncated`, `truncationNote`, `redacted`, `policyNote`, and safe display fields.
- Visibility values are exactly `full`, `summary`, or `presence`:
  - `full`: render full content after inline secret/path redaction.
  - `summary`: render metadata plus a clipped/redacted summary only; use only when a caller intentionally wants a summary view.
  - `presence`: render a Chinese protected-content explanation plus metadata only; reserve this for sections explicitly marked presence-only by the runtime.
- Sections such as persona instructions, private mailbox, routing rules, tool instructions, memory excerpts, and sandbox guidance are user-inspectable when they were actually injected for the selected agent turn.
- Concrete sensitive values such as `PI_AGENT_PRIVATE_DIR`, `CAFF_CHAT_TOOLS_PATH`, callback/auth/token values, API keys, and secret-like strings must be redacted inline rather than hiding the whole section.
- Export uses materialized safe snapshot content and never reads raw session JSONL or recomputes current prompt context.
- Snapshot integrity is checked by recomputing `displayContentHash`; mismatches render an integrity warning placeholder.

### 4. Validation & Error Matrix

| Case | Expected behavior |
| --- | --- |
| Assistant message has `metadata.agentContextSnapshot` | Read API returns materialized safe snapshot. |
| Assistant message lacks snapshot | Read/export API returns `404 No context snapshot is available for this message`. |
| Message is not assistant role | Read/export API returns `400 Only assistant messages can inspect context snapshots`. |
| Section contains private dir/tool path markers | Section stays visible, but the concrete path/value is replaced with `[REDACTED]`; surrounding explanatory text remains readable. |
| Full section contains `sk-`, `ghp_`, hex/base64-like token, or key/value secret | Rendered/exported content contains `[REDACTED]`, not raw secret text. |
| Stored display hash differs from display content | Materialized section sets `integrityOk=false` and shows warning placeholder. |
| Optional persona skill, room skill, participant, private mailbox, deprecated memory card, or history input is empty | Prompt and snapshot omit the whole section rather than rendering placeholder-only body text; deprecated memory cards stay omitted even when stored cards exist. |
| Markdown export requested | Response is a grouped `.md` document with metadata table and safe content/placeholders. |

### 5. Good/Base/Bad Cases

- Good: `const prompt = formatAgentTurnPromptSections(promptSections); createAgentContextSnapshot({ sections: promptSections, ... })`.
- Base: older assistant messages without snapshots keep existing session JSON export behavior and show no context button content.
- Bad: building the model prompt from one call to `buildAgentTurnPrompt(...)` and building the snapshot from a second call that re-reads mutable Trellis/spec/memory sources.
- Bad: hiding an entire user-inspectable prompt section only because its title contains words like `private`, `rules`, or `tools`; redact concrete sensitive values instead.

### 6. Tests Required

- Redaction: full-visibility sections containing known token/secret patterns render `[REDACTED]`.
- Redaction policy: sandbox/private/env/tool-path values never expose raw values while their sections remain readable.
- Export: Markdown preserves section metadata and readable content while omitting or redacting concrete sensitive values.
- Isolation: snapshots are keyed by message/agent/turn and do not mix one agent turn's content into another.
- Prompt assembly: existing prompt ordering tests should keep passing after section refactors.
- Empty optional sections: prompt tests assert placeholder-only optional sections are omitted from the assembled prompt.

### 7. Wrong vs Correct

#### Wrong

```typescript
const prompt = buildAgentTurnPrompt(input);
const snapshot = createAgentContextSnapshot({ sections: buildAgentTurnPromptSections(input) });
```

This can re-read mutable Trellis, memory, and conversation state, so the snapshot may not match the actual injected prompt.

#### Correct

```typescript
const promptSections = buildAgentTurnPromptSections(input);
const prompt = formatAgentTurnPromptSections(promptSections);
const snapshot = createAgentContextSnapshot({ sections: promptSections });
```

One section array is the single source for both model input and the inspector snapshot.
