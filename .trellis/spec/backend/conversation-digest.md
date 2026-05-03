# Conversation Digest

## Scenario: Conversation Digest Long-Term Memory MVP

### 1. Scope / Trigger
- Trigger: implementing or modifying `/digest` behavior for CAFF conversations.
- Applies when changes touch conversation metadata, `/api/conversations/:id/digest`, prompt assembly, SSE refresh, or chat composer slash handling.
- Goal: preserve bounded, structured historical conversation context beyond the recent-message prompt window without introducing a heavy evidence index.

### 2. Signatures
- `GET /api/conversations/:conversationId/digest`
  - Response: `{ conversation, digests, digest, deleted, summary, conversations }`
- `POST /api/conversations/:conversationId/digest`
  - Request: `{ action: 'create', summary?: string, facts?: string[], decisions?: string[], openQuestions?: string[], nextActions?: string[], artifacts?: string[] } | { action: 'delete', digestId: string } | { action: 'clear' | 'get' }`
  - Response: `{ conversation, digests, digest, deleted, summary, conversations }`
- Conversation metadata field:
  - `conversation.metadata.conversationDigests?: ConversationDigestEntry[]`
  - Entry shape: `{ id, createdAt, updatedAt, createdBy, messageRange, summary, facts, decisions, openQuestions, nextActions, artifacts }`
  - `messageRange`: `{ fromMessageId?, toMessageId?, messageCount }`
- Browser slash command:
  - `/digest` sends `{ action: 'create' }` and must not be persisted as a normal user message.
  - `/digest status|list|get` displays local digest status.
  - `/digest clear` sends `{ action: 'clear' }`.
- Browser digest panel:
  - `public/chat/conversation-digest-panel.js` renders retained metadata entries as a right-side timeline.
  - Generate sends `{ action: 'create' }`; delete sends `{ action: 'delete', digestId }`.

### 3. Contracts
- Store digest entries under `conversation.metadata.conversationDigests` for the MVP; do not add a dedicated table until search or cross-conversation merge requires it.
- Keep controllers thin: route parsing belongs in `server/api/conversations-controller.ts`; normalization, bounded retention, creation, deletion, and prompt formatting belong in `server/domain/conversation/conversation-digest.ts`.
- `create` reads public messages from `store.listMessages(conversationId)` and creates one structured extractive digest entry.
- Digest entries are append-only from the user point of view; creating a digest appends a new entry and keeps only the latest bounded set.
- `delete` removes exactly one digest by id; `clear` removes the whole metadata key when no digests remain.
- Prompt assembly injects a `Conversation digest memory:` section when retained entries exist, before recent raw conversation history, and explicitly states recent raw messages override digest content.
- Frontend slash handling must intercept `/digest...` before optimistic user-message rendering so slash commands do not pollute history.
- The panel and slash command must call the same `/digest` API path; do not introduce a second local-only persistence path.
- `POST` mutations should broadcast `conversation_digest_updated` or `conversation_digest_deleted` plus `conversation_summary_updated` so other clients refresh.
- Keep retention and text bounded: default latest 5 entries, prompt latest 3 entries, and section item/summary clipping in the domain helper.

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| `GET /digest` | conversation exists without digests | `200`, `digests: []`, `digest: null`, `deleted: false` |
| `POST /digest create` | no public messages to summarize | `400 No public conversation messages are available to digest` |
| `POST /digest create` | public messages exist | `200`, appends one entry under `metadata.conversationDigests` |
| `POST /digest delete` | missing `digestId` | `400 Digest id is required` |
| `POST /digest delete` | id not found | `404 Conversation digest not found` |
| `POST /digest delete` | last digest removed | `200`, removes `metadata.conversationDigests` key |
| `POST /digest clear` | no digests exist | `200`, metadata still has no `conversationDigests` key |
| `POST /digest unknown` | unsupported action | `400 Unsupported digest action` |

### 5. Good / Base / Bad Cases
- Good: `/digest` creates a structured entry and refreshes conversation summaries without creating a visible user message.
- Good: prompt includes digest historical context and explicitly prioritizes recent raw messages for conflicts.
- Good: deleting the final digest removes `metadata.conversationDigests` instead of leaving an empty object-like sentinel.
- Base: digest generation is extractive and bounded in MVP; it can be replaced by model-generated summaries later behind the same domain/API contract.
- Base: the right-side digest panel reads selected-conversation metadata and reuses the same API mutation path as slash commands.
- Bad: auto-generating digests every N turns in MVP, because low-quality summaries can silently pollute future prompts.
- Bad: mixing digest results into `search-messages` before provenance and ranking are designed.
- Bad: persisting `/digest` as a normal chat message, because it pollutes source messages and can trigger agents.

### 6. Tests Required
- `tests/smoke/server-smoke.test.js`
  - Create a digest from public messages and assert metadata, summary metadata, sections, and broadcast events.
  - Delete a digest and assert metadata key cleanup plus delete broadcast.
  - Reject unsupported actions and missing ids when coverage expands.
- `tests/runtime/turn-orchestrator.test.js`
  - Prompt includes `Conversation digest memory`, summary, structured sections, artifacts, and conflict guidance.
  - Prompt places digest memory before `Conversation history`.
- Manual browser validation:
  - Send `/digest`; verify no `/digest` user message appears, toast reports digest count, and the right-side digest panel updates.
  - Generate and delete from the panel; verify another open client receives SSE refresh.
- Validation commands:
  - `npm run build`
  - `node --test tests/smoke/server-smoke.test.js tests/runtime/turn-orchestrator.test.js`

### 7. Wrong vs Correct
#### Wrong
```js
applyOptimisticUserMessage(conversationId, '/digest', clientRequestId);
await fetchJson(`/api/conversations/${conversationId}/messages`, {
  method: 'POST',
  body: { content: '/digest', clientRequestId },
});
```
- This stores `/digest` as source material and may trigger agents.

#### Correct
```js
const digestCommand = parseDigestCommand(content);
if (digestCommand) {
  await submitDigestCommand(conversationId, digestCommand);
  return;
}
```
- This intercepts the slash command before optimistic rendering and uses the digest API.

#### Wrong
```ts
metadata.conversationDigests = [];
```
- Empty sentinel values force prompt/UI consumers to guess whether digest memory exists.

#### Correct
```ts
const { conversationDigests, ...remainingMetadata } = metadata;
return remainingMetadata;
```
- Clearing removes the metadata key and keeps consumers consistent.
