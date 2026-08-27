---
feature_ids: [auto-conversation-title]
topics: [conversation, title, digest, model-config, persistence]
doc_kind: code-spec
created: 2026-08-17
---

# Conversation Automatic Title

## Scenario: First-Message Title and First-Digest Refinement

### 1. Scope / Trigger

- Trigger: changing conversation title writes, first-public-message persistence,
  automatic digest creation, digest model configuration, or the conversation
  rename API/UI.
- Applies to `lib/conversation-title-source.ts`,
  `lib/conversation-first-message-title.ts`, `lib/chat-app-store.ts`,
  `server/domain/conversation/conversation-digest.ts`,
  `server/api/conversations-controller.ts`, and `public/app.js`.
- Goal: replace the placeholder title with a useful automatic title while
  making every user rename authoritative and immune to later automatic work.

### 2. Signatures

```ts
type ConversationTitleSource =
  | 'default'
  | 'auto_first_message'
  | 'auto_llm'
  | 'manual';

type ConversationTitleUpdate = {
  title?: string;
  titleSource?: ConversationTitleSource;
  metadata?: Record<string, unknown>;
};

store.updateConversation(conversationId, updates: ConversationTitleUpdate);
store.getConversationTitleSource(conversationId): ConversationTitleSource | null;
store.updateConversationTitleSource(conversationId, titleSource): Conversation | null;

deriveTitleFromFirstMessage(content): string | null;
maybeAutoCreateConversationDigest(store, conversationId, options): Promise<DigestResult>;
```

- Persistent source of truth: `conversation.metadata.titleSource`.
- Successful model refinement also stores
  `conversation.metadata.titleRefinedAt` as an ISO timestamp.
- `PUT /api/conversations/:conversationId` accepts `title` and optional
  top-level `titleSource`; a title write without `titleSource` is a manual
  rename for backward compatibility.

### 3. Contracts

#### Title source state machine

Rank is monotonic:

```text
default (0) < auto_first_message (1) < auto_llm (2) < manual (3)
```

An incoming title write is applied exactly when `incomingRank >= currentRank`.
Same-source rewrites are allowed. Rejected writes preserve both the existing
title and source.

| Current \ Incoming | `default` | `auto_first_message` | `auto_llm` | `manual` |
| --- | --- | --- | --- | --- |
| `default` | apply | apply | apply | apply |
| `auto_first_message` | reject | apply | apply | apply |
| `auto_llm` | reject | reject | apply | apply |
| `manual` | reject | reject | reject | apply |

- Missing or invalid persisted source normalizes to `default` for legacy rows.
  An explicitly supplied invalid incoming source also normalizes to `default`;
  typed callers must use one of the four constants rather than relying on this
  compatibility fallback.
- If `updates.title` exists but top-level `updates.titleSource` is omitted, the
  store treats the write as `manual`.
- `metadata.titleSource` is never an input to the transition. The store writes
  its computed source over any value embedded in `updates.metadata`, so callers
  cannot bypass the state machine.
- Metadata-only updates must omit `title`. They preserve the current title and
  source and may not accidentally promote the source to `manual`.
- `manual` is terminal only against automatic sources; `manual -> manual`
  remains valid so users can rename repeatedly.

#### First user message title

- The trigger runs in public `store.createMessage` only when the incoming role
  is `user`, the conversation source read before insertion is `default`, and
  the conversation has no earlier public user message.
- Assistant, system, and private messages never trigger it.
- Normalize the content by collapsing all Unicode whitespace (including line
  breaks) to one ASCII space and trimming both ends.
- Empty normalized content returns `null` and performs no title write.
- Keep at most 40 Unicode code points. A 41st code point causes truncation to
  the first 40 plus one `…`; use code-point iteration so surrogate-pair emoji
  are not split.
- Persist through `updateConversation(..., { title,
  titleSource: 'auto_first_message' })`; do not write title metadata directly.
  The store transition remains the final race guard.

#### First automatic digest title refinement

- Refinement is attached only to the successful auto-create path in
  `maybeAutoCreateConversationDigest`. It runs after the new digest and summary
  segment are persisted, and only when `digestsBeforeCreate.length === 0`.
- Manual `/digest create`, manual compaction, state-only auto-digest checks,
  failed digest generation, and later auto-created digests do not refine.
- A pre-existing manual digest means the later auto-created digest is not the
  first retained digest and therefore does not refine.
- Before calling the model, the current source must be `default` or
  `auto_first_message`, `titleRefinedAt` must be absent, refinement must be
  enabled, a title/digest model runner or model configuration must exist, and
  normalized source messages must be non-empty.
- The title prompt contains at most the first 12 source messages, each clipped
  to 300 characters. It requests one 5-15 character, language-matched line.
- The production title call uses the same isolated direct `@earendil-works/pi-ai/compat` text completion as digest compatibility generation. It creates no Agent session or tools, sends the resolved provider model's positive `maxTokens` (Pi default `16384` when absent), and keeps the existing title-specific absolute timeout.
- Normalize model output to its first line, strip code fences, a `Title:` /
  `标题：` prefix, surrounding quote marks, and trailing punctuation, collapse
  whitespace, and clip the stored title to 15 UTF-16 code units with
  `String.prototype.slice`. This differs from the code-point-safe first-message
  truncation contract.
- Blank output, a thrown/timeout model call, or invalid normalized output keeps
  the existing title and does not set `titleRefinedAt`. A first `length`,
  thinking-only, or empty-visible-text response may use the single remaining
  system-model call with the same budget and `thinking=off`; provider errors,
  429, aborts, and timeouts do not retry. Digest success is not rolled back and
  the first-digest opportunity is not retried by ordinary later digests.
- Immediately before writing, re-read the conversation and re-check source plus
  `titleRefinedAt`. A user may rename while the model is running; in that race,
  the manual title wins and neither `auto_llm` nor `titleRefinedAt` is written.
- A successful write uses `titleSource: 'auto_llm'` and the same store state
  machine. Never update title and metadata through a lower-level repository.

#### Summary model configuration reuse

Title refinement deliberately reuses the digest model chain; it does not have
a separate provider/model/thinking configuration and does not depend on the
digest `summaryMode`. An extractive digest may still make one title model call.

| Setting | Resolution order, highest priority first |
| --- | --- |
| Enablement | `options.autoTitleRefine` -> `CAFF_DIGEST_AUTO_TITLE_REFINE` -> `true` |
| Runner | `options.titleModelRunner` -> `options.digestModelRunner` -> normal pi run |
| Provider | `options.provider` -> `CAFF_DIGEST_PROVIDER` -> `PI_PROVIDER` -> digest default |
| Model | `options.model` -> `CAFF_DIGEST_MODEL` -> `PI_MODEL` -> digest default |
| Thinking | `options.thinking` -> `CAFF_DIGEST_THINKING` -> digest default |
| Timeout | `options.titleRefineTimeoutMs` -> `CAFF_TITLE_REFINE_TIMEOUT_MS` -> 30000 ms |

- The model-availability gate accepts either runner, explicit digest provider
  or model config, or a configured `PI_PROVIDER` / `PI_MODEL`.
- `resolveDigestModelConfig` remains the single provider/model/thinking
  resolver. Title refinement passes its timeout to the shared direct model
  completion, calls it with `purpose: 'title_refine'` plus the conversation id,
  and shares the two-call output-fallback budget. Injected `titleModelRunner` /
  `digestModelRunner` fixtures receive `{ config, maxTokens, attempt }` and the
  same empty-output retry policy.
- Do not infer title-model availability from `summaryMode: 'model'` alone. Mode
  selects digest generation behavior; provider/model/runner settings provide
  the executable model path.

### 4. Validation & Error Matrix

| Boundary / condition | Expected behavior |
| --- | --- |
| Legacy metadata has no/invalid `titleSource` | Read as `default`; next valid write follows the matrix. |
| Explicit incoming source is invalid | Normalize it to `default`; apply/reject that normalized transition. |
| Any title write omits top-level source | Treat as `manual`; persist title and terminal source. |
| Metadata-only write embeds a different source | Ignore embedded source and preserve computed state. |
| First public user message, source `default`, non-blank | Store normalized/truncated title as `auto_first_message`. |
| First content is assistant/system/private or blank user text | Keep title/source unchanged. |
| Second public user message | Never rerun first-message title derivation. |
| First successful auto digest, eligible source, model available | Call once with `purpose: 'title_refine'`; store valid output as `auto_llm`. |
| First auto digest but source is `auto_llm` or `manual` | Skip model call. |
| First auto digest but refinement disabled/model unavailable | Keep digest and title; skip model call. |
| Later auto digest | Keep digest behavior; do not call title refinement. |
| Title model returns `length`, thinking-only, or blank visible output | Retry once with the same output budget and `thinking=off`; if still invalid, keep title/marker unchanged. |
| Title model throws, returns provider error/429, aborts, or times out | Do not retry; keep title/marker unchanged and log only safe diagnostics. |
| Title model returns visible text after fallback | Normalize once, write `auto_llm`, and preserve the manual-rename race guard. |
| User renames during model call | Write-time re-read sees `manual`; discard model title. |
| Automatic write races after manual rename | Store matrix rejects it and preserves manual title/source. |

### 5. Good / Base / Bad Cases

- Good: first user message creates a readable bounded title, the first automatic
  digest upgrades it once, and a later user rename permanently wins.
- Base: no digest model is configured; first-message title remains useful and
  digest generation proceeds without refinement.
- Bad: a caller writes `{ metadata: { titleSource: 'default' } }` to unlock a
  manual title, omits `titleSource` on an automatic title write, or writes title
  data directly through a repository.
- Bad: running title refinement after every digest or retrying it after the
  first digest's model failure; this violates the one-shot cost and stability
  contract.

### 6. Tests Required

- `tests/storage/conversation-title-source.test.js`
  - Assert normalization and the full helper plus persisted 4x4 matrix.
  - Assert omitted source means manual, same-source rewrites work, lower ranks
    preserve title/source, and metadata embedding cannot bypass the guard.
- `tests/storage/conversation-first-message-title.test.js`
  - Assert whitespace normalization, empty input, exactly 40 versus 41 code
    points, emoji safety, public role/first-user gates, and store persistence.
- `tests/storage/conversation-title-refine.test.js`
  - Assert first-auto-digest-only invocation, `purpose: 'title_refine'`,
    `auto_first_message -> auto_llm`, successful marker persistence, second
    digest skip, manual skip, model failure/blank fallback, provider max-token
    propagation, one thinking-off retry for length/empty output, no hidden
    thinking text in diagnostics, output clipping, metadata-only digest writes,
    and rename-during-model race protection.
- `tests/storage/conversation-rename-guard.test.js` and
  `tests/http/conversation-rename-guard.test.js`
  - Assert explicit and implicit manual rename semantics and both automatic
    writers losing after manual rename across store and HTTP boundaries.
- `tests/smoke/server-smoke.test.js`
  - Assert a model-backed first auto digest makes the digest model call and one
    subsequent `title_refine` call through the same provider/model chain.
- Keep `npm run test:auto-conv-title` as the bounded regression entry point and
  include all title suites in `test:fast`.

### 7. Wrong vs Correct

#### Wrong

```ts
store.updateConversation(id, { title: generatedTitle });
```

An automatic writer without a source is classified as a manual rename and can
lock out legitimate later refinement.

```ts
store.updateConversation(id, { metadata: { titleSource: 'default' } });
```

Metadata is not an authority for transitions and cannot unlock a manual title.

#### Correct

```ts
store.updateConversation(id, {
  title: generatedTitle,
  titleSource: 'auto_first_message', // or 'auto_llm' for digest refinement
});
```

```ts
const latest = store.getConversation(id);
if (titleRefineAllowedForConversation(latest)) {
  store.updateConversation(id, {
    title: refinedTitle,
    titleSource: 'auto_llm',
    metadata: { ...latest.metadata, titleRefinedAt: timestamp },
  });
}
```

The explicit source lets the shared store state machine enforce priority, and
the write-time re-read protects a user rename made during model execution.
