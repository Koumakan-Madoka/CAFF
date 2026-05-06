# Conversation Digest

## Scenario: Conversation Digest Long-Term Memory + Auto-Compaction

### 1. Scope / Trigger
- Trigger: implementing or modifying `/digest` behavior for CAFF conversations.
- Applies when changes touch conversation metadata, `/api/conversations/:id/digest`, prompt assembly, SSE refresh, or chat composer slash handling.
- Goal: preserve bounded, structured historical conversation context beyond the recent-message prompt window without introducing a heavy evidence index.
- v2 adds bounded auto-compaction of older digest entries into one rollup; model-generated summaries can be enabled explicitly while deterministic extractive summaries remain the fallback.
- Auto-generation can be enabled explicitly so completed assistant replies create a new digest once enough new public messages have accumulated since the latest digest; v3-style gating can also wait for an idle window, cooldown, or high-value signals.

### 2. Signatures
- `GET /api/conversations/:conversationId/digest`
  - Response: `{ conversation, digests, digest, rollup, deleted, compacted, summary, conversations }`
- `POST /api/conversations/:conversationId/digest`
  - Request: `{ action: 'create', summaryMode?: 'model' | 'extractive' | 'auto', provider?: string, model?: string, thinking?: string, summary?: string, facts?: string[], decisions?: string[], openQuestions?: string[], nextActions?: string[], artifacts?: string[] } | { action: 'delete', digestId: string } | { action: 'clear' | 'get' | 'compact', summaryMode?: 'model' | 'extractive' | 'auto', provider?: string, model?: string, thinking?: string }`
  - Response: `{ conversation, digests, digest, rollup, deleted, compacted, summary, conversations }`
- Backend auto-create helper:
  - `maybeAutoCreateConversationDigest(store, conversationId, options)` returns the same digest result shape plus `{ autoCreated, reason?, pendingMessageCount?, pendingTokenEstimate?, signalFlags?, messageBudget?, retryAfterMs?, triggerReason?, stateChanged? }`.
- Conversation metadata fields:
  - `conversation.metadata.conversationDigests?: ConversationDigestEntry[]`
  - `conversation.metadata.conversationDigestState?: { lastDigestMessageId?, lastDigestAt?, lastAutoDigestAt?, pendingPublicMessageCount, pendingTokenEstimate, messageBudget?, highValueMinMessages?, signalFlags, lastTriggerReason?, lastFailure?, updatedAt }`
  - Entry shape: `{ id, kind, createdAt, updatedAt, createdBy, messageRange, summary, facts, decisions, openQuestions, nextActions, artifacts, triggerReason? }`
  - `kind`: `'entry' | 'rollup'`; missing legacy values normalize to `'entry'`.
  - `messageRange`: `{ fromMessageId?, toMessageId?, messageCount }`
  - Rollup-only fields: `{ compactedAt, sourceDigestIds }`.
- Browser slash command:
  - `/digest` sends `{ action: 'create' }` and must not be persisted as a normal user message.
  - `/digest status|list|get` displays local digest status.
  - `/digest compact|rollup|compress` sends `{ action: 'compact' }`; appending `model` or `extractive` sets `summaryMode` for that compaction.
  - `/digest clear` sends `{ action: 'clear' }`.
- Browser digest panel:
  - `public/chat/conversation-digest-panel.js` renders retained metadata entries as a right-side timeline.
  - Generate sends `{ action: 'create' }`; compact sends `{ action: 'compact' }`; delete sends `{ action: 'delete', digestId }`.

### 3. Contracts
- Store digest entries under `conversation.metadata.conversationDigests`; do not add a dedicated table until search or cross-conversation merge requires it.
- Keep controllers thin: route parsing belongs in `server/api/conversations-controller.ts`; normalization, bounded retention, creation, compaction, deletion, and prompt formatting belong in `server/domain/conversation/conversation-digest.ts`.
- `create` reads public messages from `store.listMessages(conversationId)` and creates one structured digest `entry`; model mode asks the configured cheap model for JSON, while extractive mode uses the deterministic classifier.
- Auto-create runs from `createServerApp` after completed assistant messages, counts only public messages after the latest digest `messageRange.toMessageId`, falls back to the digest timestamp if that covered message id is no longer present, updates `conversationDigestState` only when the lightweight waterline state materially changes, and does nothing until the configured message budget is reached or enabled high-value signals reach their minimum message count.
- After manual `create` or auto-create, the domain automatically compacts old detailed entries when the recent-entry budget is exceeded.
- Compaction keeps at most one `rollup` plus the bounded recent `entry` set; existing rollups are merged forward instead of accumulating multiple rollups.
- Model mode also applies to rollup creation, so `/digest compact model` can merge older summaries semantically; model failure logs a warning and falls back to deterministic rollup.
- `compact` manually compacts older detailed entries while preserving the latest detailed entry for recency.
- `delete` removes exactly one digest by id; deleting a rollup is allowed and does not delete recent entries.
- `clear` removes the whole metadata key when no digests remain.
- Prompt assembly injects a `Conversation digest memory:` section before recent raw conversation history, with rollup first and recent entries after it.
- Prompt text must explicitly state that recent raw messages override digest content.
- Frontend slash handling must intercept `/digest...` before optimistic user-message rendering so slash commands do not pollute history.
- The panel and slash command must call the same `/digest` API path; do not introduce a second local-only persistence path.
- `POST` mutations should broadcast `conversation_digest_updated` or `conversation_digest_deleted` plus `conversation_summary_updated` so other clients refresh; auto-create state-only updates can broadcast `conversation_digest_updated` with `digest: null` only when `stateChanged` is true, so updatedAt-only checks and retry polls do not refresh panels unnecessarily.
- Keep retention and text bounded: one rollup, default 3 recent entries, prompt latest 3 entries plus rollup, auto-create default 24 new public messages, model prompt latest 80 public messages, and section item/summary clipping in the domain helper.
- Keep `conversationDigestState` lightweight: store only waterline metadata, counts, token estimates, trigger flags, timestamps, and short failure strings; never store raw message content in the state object.
- Model configuration uses `CAFF_DIGEST_SUMMARY_MODE=model|extractive|auto`, `CAFF_DIGEST_PROVIDER`, `CAFF_DIGEST_MODEL`, `CAFF_DIGEST_THINKING`, and `CAFF_DIGEST_MODEL_TIMEOUT_MS`; without digest-specific provider/model or explicit `summaryMode: 'model'`, default behavior remains extractive.
- Auto-create configuration uses `CAFF_DIGEST_AUTO_CREATE=true|false`, `CAFF_DIGEST_AUTO_CREATE_MESSAGE_BUDGET`, `CAFF_DIGEST_AUTO_IDLE_MS`, `CAFF_DIGEST_AUTO_COOLDOWN_MS`, `CAFF_DIGEST_AUTO_HIGH_VALUE=true|false`, and `CAFF_DIGEST_AUTO_HIGH_VALUE_MIN_MESSAGES`; auto-create remains disabled unless explicitly enabled.

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| `GET /digest` | conversation exists without digests | `200`, `digests: []`, `digest: null`, `deleted: false`, `compacted: false` |
| `POST /digest create` | no public messages to summarize | `400 No public conversation messages are available to digest` |
| `POST /digest create` | public messages exist below compaction budget | `200`, appends one `entry` under `metadata.conversationDigests`, `compacted: false` |
| `POST /digest create` | `summaryMode: 'model'` with model JSON output | `200`, stores model-generated summary/sections and `createdBy: model:<provider>/<model>` |
| `POST /digest create` | model call fails or returns invalid JSON | `200`, logs warning and stores extractive fallback digest |
| Auto-create helper | `CAFF_DIGEST_AUTO_CREATE` disabled | no mutation, `autoCreated: false`, `reason: disabled` |
| Auto-create helper | enabled but new public messages below budget and no high-value trigger | updates `conversationDigestState` when counts/signals/config changed, `autoCreated: false`, `reason: below_budget` |
| Auto-create helper | enabled and budget/high-value trigger is reached but idle window has not elapsed | updates `conversationDigestState` when counts/signals/config changed, `autoCreated: false`, `reason: idle_wait`, `retryAfterMs > 0` |
| Auto-create helper | enabled and trigger is reached but cooldown has not elapsed since the last auto digest | updates `conversationDigestState` when counts/signals/config changed, `autoCreated: false`, `reason: cooldown`, `retryAfterMs > 0` |
| Auto-create helper | enabled and new public messages reach budget or high-value trigger | stores one `entry`, `autoCreated: true`, then applies normal compaction |
| `POST /digest create` | detailed entries exceed recent-entry budget | `200`, stores one `rollup` plus recent `entry` digests, `compacted: true` |
| `POST /digest compact` | fewer than two detailed entries | `200`, no mutation, `compacted: false` |
| `POST /digest compact` | two or more detailed entries | `200`, stores a `rollup` plus latest `entry`, `compacted: true` |
| `POST /digest delete` | missing `digestId` | `400 Digest id is required` |
| `POST /digest delete` | id not found | `404 Conversation digest not found` |
| `POST /digest delete` | last digest removed | `200`, removes `metadata.conversationDigests` key |
| `POST /digest clear` | no digests exist | `200`, metadata still has no `conversationDigests` key |
| `POST /digest unknown` | unsupported action | `400 Unsupported digest action` |

### 5. Good / Base / Bad Cases
- Good: `/digest` creates a structured entry and refreshes conversation summaries without creating a visible user message.
- Good: `/digest model` or `POST { action: 'create', summaryMode: 'model' }` uses the configured model to write the structured digest JSON.
- Good: with auto-create enabled, completed assistant replies create a digest only after enough new public messages accumulate, or after enough high-value messages appear when high-value triggering is enabled.
- Good: creating enough detailed entries automatically produces a rollup instead of dropping old digest memory.
- Good: `/digest compact` and the panel compact button use the same API action and show a compacted status.
- Good: prompt includes rollup historical context before recent digest entries and explicitly prioritizes raw recent messages for conflicts.
- Good: deleting the final digest removes `metadata.conversationDigests` instead of leaving an empty sentinel.
- Base: digest generation supports model mode but remains bounded and extractive-fallback safe behind the same domain/API contract.
- Base: deterministic rollup remains the safety fallback; model rollup improves semantic merge but is not evidence search.
- Bad: auto-generating digests on every turn, because low-quality summaries can silently pollute future prompts and create unnecessary model calls.
- Bad: mixing digest results into `search-messages` before provenance and ranking are designed.
- Bad: persisting `/digest` as a normal chat message, because it pollutes source messages and can trigger agents.

### 6. Tests Required
- `tests/smoke/server-smoke.test.js`
  - Create a digest from public messages and assert metadata, summary metadata, sections, and broadcast events.
  - Create a model-mode digest with an injected fake model runner and assert provider/model config, model sections, and `createdBy`.
  - Auto-create a model-mode digest after the message budget and assert it does not retrigger or mark `stateChanged` until more public messages or state fields change.
  - Create a model-mode digest with a runner that throws or returns invalid JSON and assert the request succeeds with extractive fallback metadata.
  - Assert auto-create idle windows, cooldowns, and high-value signal gates update `conversationDigestState` and trigger only when eligible.
  - Assert auto-create falls back to digest timestamps instead of re-summarizing all messages when the latest covered message id is missing.
  - Auto-create enough digests to trigger automatic rollup and assert one `rollup` plus recent `entry` digests.
  - Manually compact with `{ action: 'compact' }` and assert rollup metadata.
  - Manually compact with `{ action: 'compact', summaryMode: 'model' }` and assert model rollup metadata with fake model runner.
  - Delete a digest and assert metadata key cleanup plus delete broadcast.
  - Reject unsupported actions and missing ids when coverage expands.
- `tests/runtime/turn-orchestrator.test.js`
  - Prompt includes `Conversation digest memory`, summary, structured sections, artifacts, and conflict guidance.
  - Prompt places digest memory before `Conversation history`.
  - Prompt places rollup digest before recent digest entries.
- Manual browser validation:
  - Send `/digest`; verify no `/digest` user message appears, toast reports digest count, and the right-side digest panel updates.
  - Send `/digest compact`; verify the panel shows a compressed summary plus recent entries.
  - Generate, compact, and delete from the panel; verify another open client receives SSE refresh.
- Validation commands:
  - `npm run check`
  - `npm run typecheck`
  - `npm run build`
  - `node --test tests/smoke/server-smoke.test.js tests/runtime/turn-orchestrator.test.js`

### 7. Wrong vs Correct
#### Wrong
```js
applyOptimisticUserMessage(conversationId, '/digest compact', clientRequestId);
await fetchJson(`/api/conversations/${conversationId}/messages`, {
  method: 'POST',
  body: { content: '/digest compact', clientRequestId },
});
```
- This stores `/digest compact` as source material and may trigger agents.

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

#### Wrong
```ts
return [...oldDigests, newDigest].slice(-3);
```
- This silently drops old memory instead of preserving it in a rollup.

#### Correct
```ts
const compacted = compactDigestEntries([...oldDigests, newDigest], timestamp);
return buildMetadataWithDigests(conversation, compacted.digests);
```
- This keeps one compacted historical rollup plus recent detailed entries.
