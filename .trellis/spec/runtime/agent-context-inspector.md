# Agent Context Inspector

## Scenario: Context Snapshot Capture And Safe Rendering

### 1. Scope / Trigger

- Trigger: features that expose agent prompt/context data to users, export files, or UI drawers.
- Applies to `server/domain/conversation/turn/agent-prompt.ts`, `server/domain/conversation/turn/agent-executor.ts`, `server/domain/conversation/turn/context-snapshot.ts`, `server/api/conversations-controller.ts`, and `public/` chat UI.
- Goal: show what an agent actually received per agent turn, with section content visible by default and only concrete secret values, token values, or sensitive local paths redacted inline.

### 2. Signatures

- Prompt section builder: `buildAgentTurnPromptSections(input) -> ContextPromptSectionInput[]`.
- Prompt formatter: `formatAgentTurnPromptSections(sections) -> string`.
- Snapshot builder: `createAgentContextSnapshot({ conversationId, turnId, messageId, agentId, agentName, promptVersion, deliveryMode, retainedSessionPrefix?, sections }) -> AgentContextSnapshot`；schema v2 的生产写入 `deliveryMode` 为 `fresh|resume`，resume 时 `retainedSessionPrefix` 保存 session name、静态段 hash 和游标引用；缺少该字段的 schema v1 存量快照在读取时归一为 `unknown`，不得臆断成 fresh。
- Snapshot read API: `GET /api/conversations/:conversationId/messages/:messageId/context-snapshot` returns `{ snapshot, runEvidence }` with safe display content plus post-run token evidence (`cacheReadTokens`, `uncachedInputTokens`, etc.).
- Snapshot list API: `GET /api/conversations/:conversationId/context-snapshots?limit=<1..100>&before=<opaque>` returns `{ conversationId, snapshots, pageInfo: { hasMore, nextCursor } }` with newest-first metadata summaries; default limit is 50 and maximum is 100.
- Markdown export API: `GET /api/conversations/:conversationId/messages/:messageId/context-snapshot-export` downloads `text/markdown`.
- Assistant message metadata key: `metadata.agentContextSnapshot` stores the immutable safe snapshot for that message during P2C-Expand.
- Expand table: `chat_message_context_snapshots.message_id` stores the same full safe snapshot plus a lightweight summary. Reads prefer this row and fall back to message metadata.

### 3. Contracts

- Snapshot capture happens after prompt sections are assembled and before `startRun(...)` is invoked.
- Queued message creation persists the message and snapshot in one SQLite transaction. Streaming/tool/completed/failed updates carrying the same immutable `snapshotId` must not rewrite the snapshot row.
- Detail/export and list reads are table-first with legacy metadata fallback. The list is driven by a single bounded `chat_messages` cursor query, never `getConversation()` or unbounded `listMessages()`.
- The exact prompt sent to the model must be produced from the same **delivered** sections object passed into `createAgentContextSnapshot`; do not rebuild prompt context a second time for snapshot capture. Fresh runs use the complete prompt sections. Resume runs replace the fresh candidate sections with one `session_delta` section (`source=session/resume-delta`) and derive the actual appended user prompt from that section; cursor-prefix history must not reappear in the current snapshot.
- Resume snapshots set `deliveryMode=resume` and retain only a `retainedSessionPrefix` reference (`sessionName`, `staticSegmentHash`, cursor id/count/first/max-updated-at, `lastReplyAt`). The prefix reference proves what the provider session already retains without re-rendering that content as a current prompt section. Fresh snapshots set `deliveryMode=fresh` and have no retained prefix.
- `runEvidence` is computed at detail-read time from the completed assistant message's lightweight `sessionReused`, `sessionReuseReason`, `tokenUsage`, and `modelUsage`. It is not written back into the immutable pre-run snapshot because cache-read evidence does not exist until the provider run finishes. For legacy schema v1 snapshots, the UI may use `runEvidence.sessionReused=true` only to label the record as a legacy Resume snapshot whose old section projection is unreliable; it must not relabel those sections as an exact delta.
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
| Resume run | Snapshot `deliveryMode=resume`; exactly one `session_delta` section matches the actual appended prompt (subject only to Inspector redaction); retained prefix is reference metadata, not a duplicated section. |
| Fresh run or fail-safe fallback | Snapshot `deliveryMode=fresh`; sections remain the full prompt sections and no retained prefix is present. |
| Completed resume run has token usage | Detail API returns `runEvidence.cacheReadTokens`/`uncachedInputTokens`; the stored snapshot remains unchanged. |
| Resume snapshot contains cursor-prefix history in sections | Regression failure: Inspector is reporting the fresh candidate rather than actual delivery. |
| Legacy schema v1 snapshot lacks `deliveryMode` | Materialize as `unknown`; if message evidence says `sessionReused=true`, label “legacy Resume / section projection unreliable”, never fresh or exact delta. |
| Assistant message has `metadata.agentContextSnapshot` | Read API returns materialized safe snapshot. |
| Assistant message lacks snapshot | Read/export API returns `404 No context snapshot is available for this message`. |
| Message is not assistant role | Read/export API returns `400 Only assistant messages can inspect context snapshots`. |
| Section contains private dir/tool path markers | Section stays visible, but the concrete path/value is replaced with `[REDACTED]`; surrounding explanatory text remains readable. |
| Full section contains `sk-`, `ghp_`, hex/base64-like token, or key/value secret | Rendered/exported content contains `[REDACTED]`, not raw secret text. |
| Stored display hash differs from display content | Materialized section sets `integrityOk=false` and shows warning placeholder. |
| Optional persona skill, room skill, participant, private mailbox, deprecated memory card, or history input is empty | Prompt and snapshot omit the whole section rather than rendering placeholder-only body text; deprecated memory cards stay omitted even when stored cards exist. |
| Markdown export requested | Response is a grouped `.md` document with metadata table and safe content/placeholders. |
| Detail table row exists but message metadata is lightweight or differs | Table snapshot is authoritative for Inspector/export. |
| Detail table row is absent | Read the legacy `metadata.agentContextSnapshot` object. |
| Snapshot list omits `limit` | Return at most 50 newest summaries plus `pageInfo`. |
| Snapshot list requests `limit=100` | Return at most 100 summaries. |
| Limit/cursor is malformed, over bound, or cross-conversation | Return HTTP 400; do not reset or widen the page. |
| Snapshot list runs on a large mixed database | No `getConversation()` or unbounded `listMessages()` call; old/new rows share one stable cursor order. |

### 5. Good/Base/Bad Cases

- Good: `const prompt = formatAgentTurnPromptSections(promptSections); createAgentContextSnapshot({ sections: promptSections, ... })`.
- Base: older assistant messages without snapshots keep existing session JSON export behavior and show no context button content.
- Bad: building the model prompt from one call to `buildAgentTurnPrompt(...)` and building the snapshot from a second call that re-reads mutable Trellis/spec/memory sources.
- Bad: hiding an entire user-inspectable prompt section only because its title contains words like `private`, `rules`, or `tools`; redact concrete sensitive values instead.

### 6. Tests Required

- Delivery parity: session-reuse A/B asserts resume snapshot section content equals the exact `startRun` prompt and excludes pre-cursor history; fresh behavior remains unchanged.
- Delivery metadata: context snapshot tests assert schema v2 `deliveryMode`, retained-prefix round trip, safe materialization, and Markdown export.
- Post-run evidence: detail API test asserts cache-read/uncached token counts are projected from message metadata without mutating the snapshot.
- UI: jsdom renders resume as “恢复旧 Session（仅追加增量）”, labels totals as this-turn appended values, shows retained prefix/cache evidence, never uses the old “系统提示词 tokens 总数” label, and does not mislabel schema v1 reused snapshots as fresh.
- Redaction: full-visibility sections containing known token/secret patterns render `[REDACTED]`.
- Redaction policy: sandbox/private/env/tool-path values never expose raw values while their sections remain readable.
- Export: Markdown preserves section metadata and readable content while omitting or redacting concrete sensitive values.
- Isolation: snapshots are keyed by message/agent/turn and do not mix one agent turn's content into another.
- Prompt assembly: existing prompt ordering tests should keep passing after section refactors.
- Empty optional sections: prompt tests assert placeholder-only optional sections are omitted from the assembled prompt.
- Expand storage: real SQLite tests assert queued/completed/failed atomic writes, same-snapshot no-rewrite, rollback injection, new-table priority, metadata fallback, restart, and delete cascade.
- Pagination: mixed old/new/table-only rows cover default 50, maximum 100, stable tie ordering, opaque cursor isolation, invalid inputs, and full-hydration poison.
- Rollback: a pre-P2C build reads/updates an Expand-era message from full metadata; Expand can reopen it and still read the detail row.
- Contract storage: future assistant metadata keeps only the lightweight
  snapshot reference (including `snapshotId` and `sectionCount`), while the
  explicit full snapshot input is written to the Expand detail table in the
  same transaction.
- Contract transport: message pages and created/updated SSE events project
  legacy, Expand, and Contract metadata without `sections.displayContent`;
  Inspector detail and Markdown export remain table-first/legacy-fallback and
  therefore still materialize full safe content.
- Contract rollback: the accepted Expand build must read Contract-era full
  table snapshots even though message metadata is lightweight.

### 7. Wrong vs Correct

#### Wrong

```typescript
const prompt = buildAgentTurnPrompt(input);
const snapshot = createAgentContextSnapshot({ sections: buildAgentTurnPromptSections(input) });
```

This can re-read mutable Trellis, memory, and conversation state, so the snapshot may not match the actual injected prompt.

#### Correct

```typescript
const freshSections = buildAgentTurnPromptSections(input);
const deliveredSections = resume
  ? [{ sectionKey: 'session_delta', content: buildSessionReuseDeltaPrompt(delta) }]
  : freshSections;
const prompt = formatAgentTurnPromptSections(deliveredSections);
const snapshot = createAgentContextSnapshot({
  deliveryMode: resume ? 'resume' : 'fresh',
  retainedSessionPrefix: resume ? prefixReference : null,
  sections: deliveredSections,
});
```

One section array is the single source for both model input and the inspector snapshot.
