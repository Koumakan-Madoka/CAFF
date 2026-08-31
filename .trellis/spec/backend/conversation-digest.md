# Conversation Digest

## Scenario: Conversation Digest Long-Term Memory + Auto-Compaction

### 1. Scope / Trigger
- Trigger: implementing or modifying `/digest` behavior for CAFF conversations.
- Applies when changes touch conversation metadata, `/api/conversations/:id/digest`, prompt assembly, SSE refresh, or chat composer slash handling.
- Goal: preserve bounded, structured historical conversation context beyond the recent-message prompt window without introducing a heavy evidence index.
- v2 adds bounded auto-compaction of older digest entries into one rollup; model-generated summaries can be enabled explicitly while deterministic extractive summaries remain the fallback.
- Auto-generation can be enabled explicitly so completed assistant replies create a new digest once enough new public messages have accumulated since the latest digest; v3-style gating can also wait for an idle window, cooldown, or high-value signals.
- The first successful auto-created digest may refine the conversation title once through the shared digest model configuration. The exact trigger, state machine, and manual rename race guards are specified in [Conversation Automatic Title](./conversation-title.md).

### 2. Signatures
- `GET /api/conversations/:conversationId/digest`
  - Response: `{ conversation, digests, digest, rollup, deleted, compacted, summary, conversations }`
- `POST /api/conversations/:conversationId/digest`
  - Request: `{ action: 'create', summaryMode?: 'model' | 'extractive' | 'auto', summary?: string, facts?: string[], decisions?: string[], openQuestions?: string[], nextActions?: string[], artifacts?: string[] } | { action: 'delete', digestId: string } | { action: 'clear' | 'get' | 'compact', summaryMode?: 'model' | 'extractive' | 'auto' }`
  - Response: `{ conversation, digests, digest, rollup, deleted, compacted, summary, conversations }`
- Backend auto-create helper:
  - `maybeAutoCreateConversationDigest(store, conversationId, options)` returns the same digest result shape plus `{ autoCreated, reason?, pendingMessageCount?, pendingTokenEstimate?, signalFlags?, messageBudget?, retryAfterMs?, triggerReason?, stateChanged? }`.
- Conversation metadata fields:
  - `conversation.metadata.conversationDigests?: ConversationDigestEntry[]`
  - `conversation.metadata.conversationDigestState?: { lastDigestMessageId?, lastDigestAt?, lastAutoDigestAt?, pendingPublicMessageCount, pendingTokenEstimate, messageBudget?, highValueMinMessages?, signalFlags, lastTriggerReason?, lastFailure?, updatedAt }`
  - `signalFlags`: `{ decision, code, codeChange, fileArtifact, errorFix }`; `codeChange` is a strong high-value trigger, while `fileArtifact` is a weak diagnostic signal. `code` is retained as a compatibility alias for strong code-change signals.
  - New entry shape: `{ id, kind, createdAt, updatedAt, createdBy, messageRange, summary, facts, decisions, openQuestions, nextActions, artifacts, triggerReason? }`
  - `kind`: `'entry' | 'rollup'`; missing legacy values normalize to `'entry'`.
  - `messageRange`: `{ fromMessageId?, toMessageId?, messageCount }`
  - Rollup-only fields: `{ compactedAt, sourceDigestIds }`.
  - Historical entries may still contain bounded `experience` items with `sourceDraftId`; deserialization preserves them for lossless reads, but new entries, rollups, prompts, summary-memory writes, and Skill extraction do not propagate or consume them.
- Browser slash command:
  - `/digest` sends `{ action: 'create' }` and must not be persisted as a normal user message.
  - `/digest status|list|get` displays local digest status.
  - `/digest compact|rollup|compress` sends `{ action: 'compact' }`; appending `model` or `extractive` sets `summaryMode` for that compaction.
  - `/digest clear` sends `{ action: 'clear' }`.
- Browser digest panel:
  - `public/chat/conversation-digest-panel.js` renders retained metadata entries as a right-side timeline.
  - Generate sends `{ action: 'create' }`; compact sends `{ action: 'compact' }`; delete sends `{ action: 'delete', digestId }`.
  - Manual create and successful compact responses should open the digest panel and focus the newly created digest or compacted rollup so users can inspect the stored summary immediately. A no-op compact response (`compacted: false`) should not open/focus an old rollup because no model/extractive compaction actually ran.
  - After a digest run settles, the chat timeline should replace the temporary running status with a persisted UI-only summary card for the latest updated digest or rollup; this card reads from retained digest metadata, is sorted by its digest timestamp in the message timeline, and is not stored as a chat message.
  - Digest cards may use `messageRange.fromMessageId` to offer a UI-only "locate first message" action; missing or no-longer-rendered source messages should show a toast instead of mutating digest metadata.
- SSE status event:
  - `conversation_digest_status` payload: `{ conversationId, status: 'running' | 'idle', reason?: string, phase?: string, message?: string, model?: { provider?: string, model?: string, thinking?: string, label?: string }, modelTrace?: { eventCount?: number, outputPreview?: string, thinkingPreview?: string, runId?: string, updatedAt?: string } }`.

### 3. Contracts
- Store digest entries under `conversation.metadata.conversationDigests`; do not add a dedicated table until search or cross-conversation merge requires it.
- Keep controllers thin: route parsing belongs in `server/api/conversations-controller.ts`; normalization, bounded retention, creation, compaction, deletion, and prompt formatting belong in `server/domain/conversation/conversation-digest.ts`.
- `create` reads public messages from `store.listMessages(conversationId)` and creates one structured digest `entry`; model mode asks the configured cheap model for JSON, while extractive mode uses the deterministic classifier.
- Historical `conversation.metadata.experienceDrafts` and `digest.experience` are inert compatibility data. Digest creation never projects, absorbs, rejects, or deletes them; their stored status and ids remain unchanged.
- Auto-create runs from `createServerApp` after completed assistant messages. The completed assistant message is broadcast first, then the assistant-completion hook applies only the normal message-budget/high-value/idle/cooldown policy. Historical pending experience drafts do not bypass any gate or block same-turn routing.
- High-value triggering is conservative: `decision`, `codeChange`, or `errorFix` may bypass the message budget when enabled; weak `fileArtifact` matches such as file paths, extensions, `配置`, or `测试` update state/UI only and must not trigger auto-create by themselves.
- Deterministic extractive digests must not classify all assistant text as facts. `facts` are limited to user-stated facts and verified implementation/test/result statements; unconfirmed assistant speculation/proposals go to `openQuestions` or `nextActions` instead.
- After manual `create` or auto-create, the domain automatically compacts old detailed entries when the recent-entry budget is exceeded.
- Compaction keeps at most one `rollup` plus the bounded recent `entry` set; existing rollups are merged forward instead of accumulating multiple rollups.
- When compaction removes old metadata entries, their searchable summary-memory segments are deleted so cross-conversation memory search sees the retained rollup plus recent entries, not stale compacted entries.
- Model mode also applies to rollup creation, so `/digest compact model` can merge older summaries semantically; model failure logs a warning and falls back to deterministic rollup.
- Rollups contain only summary plus the five normal structured arrays. Historical `experience` on source entries is never copied into a new rollup.
- `compact` manually compacts older detailed entries while preserving the latest detailed entry for recency.
- `delete` removes exactly one digest by id; deleting a rollup is allowed and does not delete recent entries.
- `clear` removes the whole metadata key when no digests remain.
- Prompt assembly injects a `Current Conversation Digest / 当前聊天室摘要:` section before recent raw conversation history, with rollup first and recent entries after it. The section is current-conversation continuity context, not instructions or long-term memory.
- Prompt formatting includes summary, decisions, facts, open questions, next actions, and artifacts only. Historical `experience` remains API-readable but is omitted from Agent prompts.
- Prompt text must explicitly state that recent raw messages override digest content.
- Frontend slash handling must intercept `/digest...` before optimistic user-message rendering so slash commands do not pollute history.
- The panel and slash command must call the same `/digest` API path; do not introduce a second local-only persistence path.
- `POST` mutations should broadcast `conversation_digest_updated` or `conversation_digest_deleted` plus `conversation_summary_updated` so other clients refresh; auto-create state-only updates can broadcast `conversation_digest_updated` with `digest: null` only when `stateChanged` is true, so updatedAt-only checks and retry polls do not refresh panels unnecessarily.
- Model-mode digest/rollup generation may broadcast bounded `conversation_digest_status` model/modelTrace previews while pi emits events. No pending-experience absorption status exists.
- Keep retention and persisted text bounded: one rollup, default 3 recent entries, prompt latest 3 entries plus rollup, auto-create default 24 new public messages, model prompt latest 80 public messages, normalized stored summaries at 800 characters, and section item/summary clipping in the domain helper. The digest submission envelope may accept a summary up to 1600 characters only so that normalization can preserve the existing 800-character storage and prompt budget.
- Keep `conversationDigestState` lightweight: store only waterline metadata, counts, token estimates, trigger flags, timestamps, and short failure strings; never store raw message content in the state object.
- Model digest and rollup prompts require exactly one `submit_conversation_digest` call and instruct the assistant body to contain no visible prose, Markdown, code fence, or hand-written JSON; missing evidence uses empty arrays in the tool arguments. Providers may still attach companion text, which is ignored only after the tool envelope passes strict validation.
- Direct model generation passes exactly one schema-only tool in `Context.tools` and portable `toolChoice: 'auto'`. The tool has no execute handler and is never registered with an Agent, extension, chat bridge, shell, filesystem, or network boundary; its arguments are a provider-serialized return envelope only.
- The strict local schema requires exactly `summary`, `facts`, `decisions`, `openQuestions`, `nextActions`, and `artifacts`. The submission envelope accepts a non-empty `summary` of at most 1600 JSON Schema string characters (Unicode code points); after validation, the normal digest normalization clips it to the existing 800-character stored limit. The five sections remain bounded string arrays with at most 8 items of 240 characters each. Unknown fields, including legacy `experience`, and type coercion are rejected.
- Every direct system-model request sends an explicit generation budget equal to the resolved provider model's positive `maxTokens`; a missing model value uses the Pi custom-provider default `16384`. The old feature-local JSON Mode default `4096` and `CAFF_DIGEST_JSON_MODE_MAX_TOKENS` override are not part of the runtime contract.
- Direct submission parsing ignores `thinking`/`reasoning` blocks and companion visible text, but requires exactly one `toolCall` block with the expected name, an object argument payload, and strict schema-valid arguments. The validated tool arguments are the final result; CAFF does not execute the tool, return a tool result, or call the model again. Zero/multiple calls, a wrong tool, plain-text JSON/prose without a valid call, malformed arguments, missing/unknown fields, or a non-object argument payload are `invalid_output` and never reach digest metadata.
- If a direct DeepSeek digest model such as `provider: 'deepseek'`, `model: 'deepseek-v4-flash'` is not present in the pi-ai registry, the digest runner may construct a bounded OpenAI-compatible model object from `.pi-sandbox/models.json`, including `baseUrl`, model compat, and API key, then call it with the same schema-only submission tool and local validation contract.
- The first digest/title invocation uses the configured shared thinking level. If it returns `stopReason=length`, thinking-only content, or empty content with no tool call, CAFF may make exactly one second request with the same provider/model/output budget and `thinking=off`. Thrown provider errors, 429 responses, aborts, and timeouts never trigger this fallback.
- A digest/title system task has a two-call hard maximum. Direct tool protocol/schema failures do not schedule a repair call. The existing missing-escaped-quote JSON repair remains only for injected/legacy text runners, may consume their second call with thinking off, and never creates a third request.
- Direct digest submission and plain title/legacy text generation both use isolated `@earendil-works/pi-ai/compat` completion without an Agent session. The digest call carries one non-executed schema tool; title generation carries none. Direct output is not written to Pi session JSONL. Hidden thinking and raw tool arguments must not enter logs, persisted digest metadata beyond the validated normalized payload, diagnostic metadata, or fallback errors.
- Safe diagnostics distinguish `empty_text`, `length_exhausted`, and `invalid_output` and log only attempt, selected budget/thinking, stop reason, content-block types, visible-text length, retry decision, and bounded numeric usage. A top-level string that exceeds its trusted schema limit may additionally log only the schema field name, actual Unicode code-point length, and accepted limit; it never logs the field value or raw arguments. `CAFF_DIGEST_LOG_RAW_OUTPUT=true` may log full redacted visible invalid text only; it never authorizes tool arguments, hidden thinking, secrets, or raw assistant wrappers.
- If the direct submission is missing or invalid, log only a bounded safe protocol reason and fall back to the deterministic extractive digest without storing body text or tool arguments.
- If injected/legacy model JSON parsing fails with a likely missing escape for an inner double quote in a JSON string, the backend may run one bounded repair retry that returns the diagnostic, original digest prompt, and bounded invalid output to the same digest model. A successful repair still stores `createdBy: model:<provider>/<model>`; a failed repair falls back normally.
- If injected/legacy model JSON parsing fails, backend warning logs include a bounded redacted visible-output preview for diagnosis plus any detected syntax diagnostic. Setting `CAFF_DIGEST_LOG_RAW_OUTPUT=true` logs the full redacted visible model output to the local server console only; hidden thinking, secrets, tool arguments, and raw assistant wrappers remain excluded, and no diagnostic output is persisted into conversation metadata or digest memory.
- Model selection is shared with the platform `recovery_scribe` system service. When a complete persisted system-service row exists, its `provider/model/thinking` snapshot is authoritative for model digest entries, rollups, and title refinement. The row's `enabled` flag controls only failed-trace recovery, and its `timeoutMs` controls only scribe execution; digest and title calls keep their own timeout budgets.
- Without a persisted system-service row, the existing startup chain remains: `CAFF_DIGEST_PROVIDER`, `CAFF_DIGEST_MODEL`, `CAFF_DIGEST_THINKING`, and Pi defaults. `CAFF_DIGEST_SUMMARY_MODE=model|extractive|auto`, `CAFF_DIGEST_MODEL_TIMEOUT_MS`, and optional diagnostic `CAFF_DIGEST_LOG_RAW_OUTPUT=true|false` remain digest-specific.
- `POST /digest` never accepts request-scoped `provider`, `model`, or `thinking`. Any of those own fields returns `400 conversation_digest_model_override_not_allowed` before a model call or digest mutation. `summaryMode` may still select model versus extractive behavior.
- Each digest/title model invocation resolves one immutable shared model snapshot before awaiting the runner. A concurrent system-service save affects the next model invocation and never mutates the provider/model/thinking of a call already in progress.
- Title refinement reuses the resolved shared provider/model/thinking (or injected digest runner) independently of digest summary mode; title-specific enablement and timeout are `CAFF_DIGEST_AUTO_TITLE_REFINE` and `CAFF_TITLE_REFINE_TIMEOUT_MS`. See `conversation-title.md` before changing this shared configuration chain.
- Auto-create configuration uses `CAFF_DIGEST_AUTO_CREATE=true|false`, `CAFF_DIGEST_AUTO_CREATE_MESSAGE_BUDGET`, `CAFF_DIGEST_AUTO_IDLE_MS`, `CAFF_DIGEST_AUTO_COOLDOWN_MS`, `CAFF_DIGEST_AUTO_HIGH_VALUE=true|false`, and `CAFF_DIGEST_AUTO_HIGH_VALUE_MIN_MESSAGES`; auto-create remains disabled unless explicitly enabled.

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| `GET /digest` | conversation exists without digests | `200`, `digests: []`, `digest: null`, `deleted: false`, `compacted: false` |
| `POST /digest create` | no public messages to summarize | `400 No public conversation messages are available to digest` |
| `POST /digest create` | public messages exist below compaction budget | `200`, appends one `entry` under `metadata.conversationDigests`, `compacted: false` |
| Historical `experienceDrafts` or `digest.experience` exists | Preserve on read; new digest contains neither field and historical draft status is unchanged |
| `POST /digest create` | `summaryMode: 'model'` with one valid `submit_conversation_digest` call | `200`, stores model-generated summary/sections and `createdBy: model:<provider>/<model>` |
| `POST /digest create|compact` | body contains `provider`, `model`, or `thinking` | `400 conversation_digest_model_override_not_allowed`; no model call or digest mutation |
| model digest/rollup/title call | persisted `recovery_scribe` row exists with `enabled=false` | use its `provider/model/thinking`; recovery remains disabled, digest execution remains enabled with digest/title timeout |
| model digest/rollup/title call | provider model declares positive `maxTokens` | send that value explicitly; missing value sends Pi default `16384` |
| first model response | `length`, thinking-only, or empty visible text with thinking enabled | one retry with the same budget and `thinking=off` |
| first model response | thrown provider error, 429, abort, or timeout | no output fallback retry; preserve existing extractive/title fallback |
| invalid JSON repair | first call produced the recognized missing-escape diagnostic | the repair may use the one remaining call with thinking off; never make a third call |
| direct digest/rollup response | exactly one expected tool call with otherwise-strict arguments whose `summary` is at most 800 characters, with or without companion visible text | store the normalized model digest unchanged and `createdBy: model:<provider>/<model>`; ignore companion text and make no further model call |
| direct digest/rollup response | otherwise-valid tool arguments whose `summary` is 801 through 1600 characters | accept the envelope, clip the stored summary to 800 characters through normal normalization, preserve the remaining validated sections, and make no further model call |
| direct digest/rollup response | `summary` exceeds 1600 characters | mark `invalid_output`, log only `field=summary`, numeric actual length, and accepted limit, make no protocol-repair request, and store the extractive fallback |
| direct digest/rollup response | plain-text JSON/prose without a valid call, zero/multiple calls, or wrong tool | mark `invalid_output`, make no protocol-repair request, and store the extractive fallback |
| direct digest/rollup response | tool arguments omit/extend/mistype a field or are not an object | mark `invalid_output`, do not persist arguments, and store the extractive fallback |
| `POST /digest create` | DeepSeek direct digest model is constructed from `.pi-sandbox/models.json` and returns a valid submission call | `200`, stores normalized model digest and `createdBy: model:deepseek/<model>` |
| injected/legacy model runner | output likely misses an escape before an inner `"` and repair retry returns valid JSON | `200`, stores repaired model digest and logs the missing-escape diagnostic |
| injected/legacy model runner | call fails, returns invalid JSON without a repairable diagnostic, or repair remains invalid | `200`, logs warning and stores extractive fallback digest |
| Auto-create helper | `CAFF_DIGEST_AUTO_CREATE` disabled | no mutation, `autoCreated: false`, `reason: disabled` |
| Auto-create helper | enabled but new public messages below budget and no strong high-value trigger | updates `conversationDigestState` when counts/signals/config changed, `autoCreated: false`, `reason: below_budget`; historical pending experience does not change the result |
| Auto-create helper | enabled and budget/high-value trigger is reached but idle window has not elapsed | updates `conversationDigestState` when counts/signals/config changed, `autoCreated: false`, `reason: idle_wait`, `retryAfterMs > 0` |
| Auto-create helper | enabled and trigger is reached but cooldown has not elapsed since the last auto digest | updates `conversationDigestState` when counts/signals/config changed, `autoCreated: false`, `reason: cooldown`, `retryAfterMs > 0` |
| Auto-create helper | enabled and new public messages reach budget or a strong high-value trigger | stores one `entry`, `autoCreated: true`, then applies normal compaction |
| Auto-create helper | enabled high-value gate sees only weak file/artifact mentions below budget | updates `conversationDigestState.signalFlags.fileArtifact`, returns `autoCreated: false`, `reason: below_budget` |
| `POST /digest create` | detailed entries exceed recent-entry budget | `200`, stores one `rollup` plus recent `entry` digests, deletes obsolete entry summary-memory segments, `compacted: true` |
| `POST /digest compact` | fewer than two detailed entries | `200`, no mutation, `compacted: false` |
| `POST /digest compact` | two or more detailed entries | `200`, stores a `rollup` plus latest `entry`, deletes obsolete entry summary-memory segments, `compacted: true` |
| `POST /digest delete` | missing `digestId` | `400 Digest id is required` |
| `POST /digest delete` | id not found | `404 Conversation digest not found` |
| `POST /digest delete` | last digest removed | `200`, removes `metadata.conversationDigests` key |
| `POST /digest clear` | no digests exist | `200`, metadata still has no `conversationDigests` key |
| `POST /digest unknown` | unsupported action | `400 Unsupported digest action` |

### 5. Good / Base / Bad Cases
- Good: `/digest` creates a structured entry and refreshes conversation summaries without creating a visible user message.
- Good: an old conversation with `experienceDrafts` and `digest.experience` loads without mutation while the next digest/rollup uses only the six current fields.
- Good: `/digest model` or `POST { action: 'create', summaryMode: 'model' }` uses the configured model to write the structured digest JSON.
- Good: with auto-create enabled, completed assistant replies can create a digest after enough new public messages accumulate or after enough strong high-value messages appear when high-value triggering is enabled.
- Good: creating enough detailed entries automatically produces a rollup instead of dropping old digest memory.
- Good: `/digest compact` and the panel compact button use the same API action; successful compaction shows a compacted status, while no-op compaction tells the user there are no older entries to compact.
- Good: prompt includes rollup historical context before recent digest entries and explicitly prioritizes raw recent messages for conflicts.
- Good: deleting the final digest removes `metadata.conversationDigests` instead of leaving an empty sentinel.
- Base: digest generation supports model mode but remains bounded and extractive-fallback safe behind the same domain/API contract.
- Base: deterministic rollup remains the safety fallback; model rollup improves semantic merge but is not evidence search.
- Bad: auto-generating digests on every turn, because low-quality summaries can silently pollute future prompts and create unnecessary model calls.
- Bad: treating an assistant suggestion like `I think maybe we should edit file.ts` as a durable `facts` item.
- Bad: copying historical `digest.experience` into a new entry, rollup, model prompt, or manual Skill draft.
- Bad: letting weak file-path/config/test mentions alone bypass the message budget through `high_value_signal`.
- Bad: mixing digest results into `search-messages` before provenance and ranking are designed.
- Bad: persisting `/digest` as a normal chat message, because it pollutes source messages and can trigger agents.

### 6. Tests Required
- `tests/smoke/server-smoke.test.js`
  - Create a digest from public messages and assert metadata, summary metadata, sections, and broadcast events.
  - Create a model-mode digest after saving a persisted `recovery_scribe` configuration and assert the next manual/automatic digest, rollup, and title refinement use the shared `provider/model/thinking` even when recovery is disabled; assert digest/title timeouts remain independent.
  - Reject request bodies containing `provider`, `model`, or `thinking` with the stable override error before the runner is called.
  - Create a direct pi-mono model digest with a fake pi-ai module and assert `Context.tools` contains only `submit_conversation_digest`, `toolChoice='auto'`, no payload/JSON Mode hook is used, provider `maxTokens` is preserved, strict arguments are normalized, and `createdBy` is stored.
  - Return `length` with thinking-only/empty content, then a valid submission call; assert exactly two calls, unchanged output budget, second-call `thinking=off`, safe diagnostics, and no hidden thinking text in logs or metadata. Return a provider/429 error and assert exactly one call plus the existing fallback.
  - Assert direct plain-text JSON without a call, wrong tools, zero/multiple calls, non-object arguments, unknown/missing fields, and wrong field types are `invalid_output`, make no protocol repair call, persist no raw output/arguments, and store extractive fallback digests.
  - Create a direct submission containing companion visible text plus one valid call and assert exactly one model call, only validated tool arguments enter the digest, and companion text is not persisted.
  - Create direct digest submissions with summaries of exactly 801 and 1600 characters; assert the offered tool schema accepts 1600 while section limits remain 8 items of 240 characters, each result is model-created, and the stored summary uses the existing 800-character ellipsis clipping. Submit 1601 characters and assert one provider call, extractive fallback, bounded field/actual/limit diagnostics, and absence of the submitted marker from logs.
  - Create a DeepSeek model-mode digest with a fake pi-ai module whose registry lacks the requested model, and assert the runner constructs an OpenAI-compatible DeepSeek model, passes the configured API key, provides the schema-only tool, and preserves the requested thinking/output budget.
  - Auto-create a model-mode digest after the message budget and assert it does not retrigger or mark `stateChanged` until more public messages or state fields change.
  - Create an injected/legacy model digest where the first text response has an unescaped inner double quote, assert a second prompt includes the missing-escape diagnostic and bounded invalid output, and assert valid repair output stores a model-created digest.
  - Create a model-mode digest with a runner that throws or returns invalid JSON and assert the request succeeds with extractive fallback metadata and invalid-output diagnostics.
  - Assert auto-create idle windows, cooldowns, and high-value signal gates update `conversationDigestState` and trigger only when eligible, including weak `fileArtifact` signals and historical pending experience that do not auto-create below budget.
  - Assert deterministic extractive digests keep assistant speculation out of `facts` while preserving user facts, verified results, artifacts, and unresolved proposals.
  - Assert historical `experienceDrafts` stay unchanged and historical `digest.experience` is readable but omitted from new entries, rollups, tool schemas, and prompt formatting.
  - Assert auto-create falls back to digest timestamps instead of re-summarizing all messages when the latest covered message id is missing.
  - Auto-create enough digests to trigger automatic rollup and assert one `rollup` plus recent `entry` digests, with compacted entry segments removed from summary-memory search.
  - Manually compact with `{ action: 'compact' }` and assert rollup metadata plus stale entry segment cleanup.
  - Manually compact with `{ action: 'compact', summaryMode: 'model' }` and assert model rollup metadata with fake model runner.
  - Delete a digest and assert metadata key cleanup plus delete broadcast.
  - Reject unsupported actions and missing ids when coverage expands.
- `tests/runtime/turn-orchestrator.test.js`
  - Prompt includes `Current Conversation Digest / 当前聊天室摘要`, summary, structured sections, artifacts, current-conversation provenance wording, and conflict guidance.
  - Prompt places digest memory before `Conversation history`.
  - Prompt places rollup digest before recent digest entries.
- Manual browser validation:
  - Send `/digest`; verify no `/digest` user message appears, toast reports digest count, the right-side digest panel opens with the new digest focused, and the timeline keeps a completed digest summary card after the running status disappears.
  - Send `/digest compact`; verify the panel and completed timeline card show the compressed rollup summary, focus that rollup, and their "定位首条" action scrolls to `messageRange.fromMessageId` when the message is rendered.
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
