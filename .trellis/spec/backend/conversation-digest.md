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
  - Request: `{ action: 'create', summaryMode?: 'model' | 'extractive' | 'auto', summary?: string, facts?: string[], decisions?: string[], openQuestions?: string[], nextActions?: string[], artifacts?: string[], experience?: ExperienceDigestItem[] } | { action: 'delete', digestId: string } | { action: 'clear' | 'get' | 'compact', summaryMode?: 'model' | 'extractive' | 'auto' }`
  - Response: `{ conversation, digests, digest, rollup, deleted, compacted, summary, conversations }`
- Backend auto-create helper:
  - `maybeAutoCreateConversationDigest(store, conversationId, options)` returns the same digest result shape plus `{ autoCreated, reason?, pendingMessageCount?, pendingTokenEstimate?, signalFlags?, messageBudget?, retryAfterMs?, triggerReason?, stateChanged? }`.
- Conversation metadata fields:
  - `conversation.metadata.conversationDigests?: ConversationDigestEntry[]`
  - `conversation.metadata.conversationDigestState?: { lastDigestMessageId?, lastDigestAt?, lastAutoDigestAt?, pendingPublicMessageCount, pendingTokenEstimate, messageBudget?, highValueMinMessages?, signalFlags, lastTriggerReason?, lastFailure?, updatedAt }`
  - `signalFlags`: `{ decision, code, codeChange, fileArtifact, errorFix }`; `codeChange` is a strong high-value trigger, while `fileArtifact` is a weak diagnostic signal. `code` is retained as a compatibility alias for strong code-change signals.
  - Entry shape: `{ id, kind, createdAt, updatedAt, createdBy, messageRange, summary, facts, decisions, openQuestions, nextActions, artifacts, experience?, triggerReason? }`
  - `kind`: `'entry' | 'rollup'`; missing legacy values normalize to `'entry'`.
  - `messageRange`: `{ fromMessageId?, toMessageId?, messageCount }`
  - Rollup-only fields: `{ compactedAt, sourceDigestIds }`.
  - `ExperienceDigestItem`: `{ sourceDraftId?, title, category, scenario, steps, pitfalls, validation, artifacts, confidence }`; bounded to 5 items, nested arrays bounded to 5, and text is clipped like other digest sections.
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
  - `conversation_digest_status` payload: `{ conversationId, status: 'running' | 'idle', reason?: string, phase?: string, pendingExperienceDraftCount?: number, message?: string, model?: { provider?: string, model?: string, thinking?: string, label?: string }, modelTrace?: { eventCount?: number, outputPreview?: string, thinkingPreview?: string, runId?: string, updatedAt?: string } }`.

### 3. Contracts
- Store digest entries under `conversation.metadata.conversationDigests`; do not add a dedicated table until search or cross-conversation merge requires it.
- Keep controllers thin: route parsing belongs in `server/api/conversations-controller.ts`; normalization, bounded retention, creation, compaction, deletion, and prompt formatting belong in `server/domain/conversation/conversation-digest.ts`.
- `create` reads public messages from `store.listMessages(conversationId)` and creates one structured digest `entry`; model mode asks the configured cheap model for JSON, while extractive mode uses the deterministic classifier.
- When pending `conversation.metadata.experienceDrafts` exist, create/auto-create adds up to 5 bounded `ExperienceDigestItem` projections to the digest input, stores them under `digest.experience`, and marks the projected source drafts `absorbed` with `absorbedDigestId` after the digest metadata write succeeds. Extra pending drafts remain pending for a later digest instead of being silently marked absorbed.
- Auto-create runs from `createServerApp` after completed assistant messages. The completed assistant message is broadcast first so the browser can show the full reply, then the assistant-completion hook is awaited without an application timeout before Feishu delivery and any same-turn handoff routing continue. Digest counting uses only public messages after the latest digest `messageRange.toMessageId`, falls back to the digest timestamp if that covered message id is no longer present, updates `conversationDigestState` only when the lightweight waterline state materially changes, and does nothing until the configured message budget is reached, enabled strong high-value signals reach their minimum message count, or pending experience drafts exist with at least one new public source message.
- High-value triggering is conservative: `decision`, `codeChange`, or `errorFix` may bypass the message budget when enabled; weak `fileArtifact` matches such as file paths, extensions, `配置`, or `测试` update state/UI only and must not trigger auto-create by themselves. Pending `write-experience` drafts are treated as explicit reusable evidence and may trigger the next auto-created digest below the normal message budget; this pending-experience trigger bypasses idle/cooldown gates so the awaited assistant-completion hook can absorb the draft before chat routing continues.
- Deterministic extractive digests must not classify all assistant text as facts. `facts` are limited to user-stated facts and verified implementation/test/result statements; unconfirmed assistant speculation/proposals go to `openQuestions` or `nextActions` instead.
- After manual `create` or auto-create, the domain automatically compacts old detailed entries when the recent-entry budget is exceeded.
- Compaction keeps at most one `rollup` plus the bounded recent `entry` set; existing rollups are merged forward instead of accumulating multiple rollups.
- When compaction removes old metadata entries, their searchable summary-memory segments are deleted so cross-conversation memory search sees the retained rollup plus recent entries, not stale compacted entries.
- Model mode also applies to rollup creation, so `/digest compact model` can merge older summaries semantically; model failure logs a warning and falls back to deterministic rollup.
- Rollups may carry bounded `experience` only when source entries already contain experience items; compaction must not invent reusable lessons from unsupported summary text.
- `compact` manually compacts older detailed entries while preserving the latest detailed entry for recency.
- `delete` removes exactly one digest by id; deleting a rollup is allowed and does not delete recent entries.
- `clear` removes the whole metadata key when no digests remain.
- Prompt assembly injects a `Current Conversation Digest / 当前聊天室摘要:` section before recent raw conversation history, with rollup first and recent entries after it. The section is current-conversation continuity context, not instructions or long-term memory.
- Prompt formatting shows `Experience:` before normal digest sections so reusable lessons are visible while preserving raw recent messages as the conflict winner.
- Prompt text must explicitly state that recent raw messages override digest content.
- Frontend slash handling must intercept `/digest...` before optimistic user-message rendering so slash commands do not pollute history.
- The panel and slash command must call the same `/digest` API path; do not introduce a second local-only persistence path.
- `POST` mutations should broadcast `conversation_digest_updated` or `conversation_digest_deleted` plus `conversation_summary_updated` so other clients refresh; auto-create state-only updates can broadcast `conversation_digest_updated` with `digest: null` only when `stateChanged` is true, so updatedAt-only checks and retry polls do not refresh panels unnecessarily.
- When an auto-create run starts with pending experience drafts, broadcast `conversation_digest_status` with `status: 'running'` before digest generation and `status: 'idle'` after the run settles. Model-mode digest/rollup generation may also broadcast bounded `model` and `modelTrace` previews while the pi run emits events; previews are transient SSE/UI diagnostics, not stored digest evidence. The browser should show this in the composer status and as a compact temporary timeline card while routing is waiting for digest absorption.
- Keep retention and text bounded: one rollup, default 3 recent entries, prompt latest 3 entries plus rollup, auto-create default 24 new public messages, model prompt latest 80 public messages, and section item/summary clipping in the domain helper.
- Keep `conversationDigestState` lightweight: store only waterline metadata, counts, token estimates, trigger flags, timestamps, and short failure strings; never store raw message content in the state object.
- Model digest and rollup prompts must include hard JSON-only output rules plus a minimal few-shot example: exactly one object, no markdown/code fences/prose/comments/multiple objects, all top-level keys present, double-quoted JSON, escaped newlines, escaped literal double quotes inside string values, no trailing commas or placeholders, and empty arrays when evidence is missing.
- When CAFF calls pi-mono directly for model digest generation, use OpenAI-compatible JSON Mode by sending `response_format: { type: 'json_object' }` through the direct `pi-ai` payload hook. Do not register digest-only virtual tools or force `toolChoice` for this path. Direct JSON Mode runs must emit an initial `conversation_digest_status` running update via the shared model progress reporter so manual `/digest model` and `/digest compact model` requests show a temporary timeline card before the model returns its final JSON.
- Direct JSON Mode output must still pass local schema validation before storage: `summary` is a non-empty string, `facts`, `decisions`, `openQuestions`, `nextActions`, and `artifacts` are present string arrays, and optional `experience` is an array when present.
- Direct JSON Mode parsing must extract visible text/output text blocks from pi-ai assistant messages and ignore `thinking`/`reasoning` blocks; an assistant response that contains only hidden reasoning is invalid and must fall back instead of treating the message wrapper as a digest object.
- If a direct DeepSeek digest model such as `provider: 'deepseek'`, `model: 'deepseek-v4-flash'` is not present in the pi-ai registry, the digest runner may construct a bounded OpenAI-compatible model object from `.pi-sandbox/models.json`, including `baseUrl`, model compat, and API key, then call it with the same JSON Mode and local schema-validation contract.
- DeepSeek JSON Mode payloads should disable provider thinking when supported, while still omitting digest-only tools and `toolChoice`, so reasoning tokens do not consume the whole bounded output before the digest JSON appears.
- If JSON Mode output is missing, malformed, or fails validation, log the bounded raw assistant output through the existing invalid-output warning path and fall back to the deterministic extractive digest without storing the bad model output.
- If model JSON parsing fails with a likely missing escape for an inner double quote in a JSON string, the backend may run one bounded repair retry that returns the diagnostic, original digest prompt, and bounded invalid output to the same digest model. A successful repair still stores `createdBy: model:<provider>/<model>`; a failed repair falls back normally. This text JSON repair path remains for injected/non-structured model runners and non-migrated providers.
- If model JSON parsing fails, backend warning logs include a bounded raw-output preview for diagnosis plus any detected syntax diagnostic. Setting `CAFF_DIGEST_LOG_RAW_OUTPUT=true` logs the full raw model output to the local server console only; it must not be persisted into conversation metadata or digest memory.
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
| `POST /digest create` | pending experience drafts exist | `200`, stores bounded `digest.experience`, marks source drafts `absorbed`, and records `absorbedDigestId` |
| `POST /digest create` | `summaryMode: 'model'` with model JSON output | `200`, stores model-generated summary/sections and `createdBy: model:<provider>/<model>` |
| `POST /digest create|compact` | body contains `provider`, `model`, or `thinking` | `400 conversation_digest_model_override_not_allowed`; no model call or digest mutation |
| model digest/rollup/title call | persisted `recovery_scribe` row exists with `enabled=false` | use its `provider/model/thinking`; recovery remains disabled, digest execution remains enabled with digest/title timeout |
| `POST /digest create` | direct pi-mono JSON Mode digest returns valid schema JSON | `200`, stores normalized model digest and `createdBy: model:<provider>/<model>` |
| `POST /digest create` | direct pi-mono JSON Mode digest omits a required field or returns a malformed section | `200`, logs invalid structured output and stores extractive fallback digest |
| `POST /digest create` | direct pi-mono JSON Mode output is not a JSON object | `200`, logs invalid structured output and stores extractive fallback digest |
| `POST /digest create` | DeepSeek direct digest model is constructed from `.pi-sandbox/models.json` and returns valid JSON Mode output | `200`, stores normalized model digest and `createdBy: model:deepseek/<model>` |
| `POST /digest create` | model output likely misses an escape before an inner `"` in a string and repair retry returns valid JSON | `200`, stores repaired model digest and logs the missing-escape diagnostic |
| `POST /digest create` | model call fails, returns invalid JSON without a repairable missing-escape diagnostic, or repair retry is still invalid | `200`, logs warning and stores extractive fallback digest |
| Auto-create helper | `CAFF_DIGEST_AUTO_CREATE` disabled | no mutation, `autoCreated: false`, `reason: disabled` |
| Auto-create helper | enabled but new public messages below budget, no high-value trigger, and no pending experience draft | updates `conversationDigestState` when counts/signals/config changed, `autoCreated: false`, `reason: below_budget` |
| Auto-create helper | enabled and budget/high-value trigger is reached but idle window has not elapsed | updates `conversationDigestState` when counts/signals/config changed, `autoCreated: false`, `reason: idle_wait`, `retryAfterMs > 0` |
| Auto-create helper | enabled and trigger is reached but cooldown has not elapsed since the last auto digest | updates `conversationDigestState` when counts/signals/config changed, `autoCreated: false`, `reason: cooldown`, `retryAfterMs > 0` |
| Auto-create helper | enabled and new public messages reach budget, strong high-value trigger, or a pending experience draft with a new public source message exists | stores one `entry`, `autoCreated: true`, then applies normal compaction; pending-experience triggers report `triggerReason: pending_experience` |
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
- Good: a pending `write-experience` draft becomes `digest.experience` once and is marked absorbed so later digests do not duplicate it.
- Good: `/digest model` or `POST { action: 'create', summaryMode: 'model' }` uses the configured model to write the structured digest JSON.
- Good: with auto-create enabled, completed assistant replies broadcast their full final message first, then synchronously create a digest before handoff routing after enough new public messages accumulate, after enough strong high-value messages appear when high-value triggering is enabled, or after a pending experience draft exists with new public source material.
- Good: creating enough detailed entries automatically produces a rollup instead of dropping old digest memory.
- Good: `/digest compact` and the panel compact button use the same API action; successful compaction shows a compacted status, while no-op compaction tells the user there are no older entries to compact.
- Good: prompt includes rollup historical context before recent digest entries and explicitly prioritizes raw recent messages for conflicts.
- Good: deleting the final digest removes `metadata.conversationDigests` instead of leaving an empty sentinel.
- Base: digest generation supports model mode but remains bounded and extractive-fallback safe behind the same domain/API contract.
- Base: deterministic rollup remains the safety fallback; model rollup improves semantic merge but is not evidence search.
- Bad: auto-generating digests on every turn, because low-quality summaries can silently pollute future prompts and create unnecessary model calls.
- Bad: treating an assistant suggestion like `I think maybe we should edit file.ts` as a durable `facts` item.
- Bad: copying raw tool output or full logs into `digest.experience`; experience must remain bounded reusable lesson metadata.
- Bad: letting weak file-path/config/test mentions alone bypass the message budget through `high_value_signal`.
- Bad: mixing digest results into `search-messages` before provenance and ranking are designed.
- Bad: persisting `/digest` as a normal chat message, because it pollutes source messages and can trigger agents.

### 6. Tests Required
- `tests/smoke/server-smoke.test.js`
  - Create a digest from public messages and assert metadata, summary metadata, sections, and broadcast events.
  - Create a model-mode digest after saving a persisted `recovery_scribe` configuration and assert the next manual/automatic digest, rollup, and title refinement use the shared `provider/model/thinking` even when recovery is disabled; assert digest/title timeouts remain independent.
  - Reject request bodies containing `provider`, `model`, or `thinking` with the stable override error before the runner is called.
  - Create a direct pi-mono JSON Mode model digest with a fake pi-ai module and assert it sends `response_format: { type: 'json_object' }`, does not send tools or `toolChoice`, validates schema JSON, and stores `createdBy`.
  - Create direct pi-mono JSON Mode model digests where required fields are missing, the output is not a JSON object, or the assistant message contains only thinking blocks, and assert each case logs warnings and stores extractive fallback digests.
  - Create a direct JSON Mode digest whose assistant message contains both thinking and text/output text blocks, and assert only the visible JSON text is parsed.
  - Create a DeepSeek model-mode digest with a fake pi-ai module whose registry lacks the requested model, and assert the runner constructs an OpenAI-compatible DeepSeek model, passes the configured API key, sends JSON Mode, disables provider thinking when supported, and does not send `toolChoice`.
  - Auto-create a model-mode digest after the message budget and assert it does not retrigger or mark `stateChanged` until more public messages or state fields change.
  - Create a model-mode digest where the first runner response has an unescaped inner double quote, assert a second prompt includes the missing-escape diagnostic and bounded invalid output, and assert valid repair output stores a model-created digest.
  - Create a model-mode digest with a runner that throws or returns invalid JSON and assert the request succeeds with extractive fallback metadata and invalid-output diagnostics.
  - Assert auto-create idle windows, cooldowns, high-value signal gates, pending-experience triggers, and pending-experience status broadcasts update `conversationDigestState` and trigger only when eligible, including weak `fileArtifact` signals that do not auto-create below budget.
  - Assert deterministic extractive digests keep assistant speculation out of `facts` while preserving user facts, verified results, artifacts, and unresolved proposals.
  - Assert pending `experienceDrafts` are projected into `digest.experience`, marked `absorbed`, and not reabsorbed into later digest entries.
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
