# Digest Semantic Retries and Diagnostics

## Goal

Make conversation digest generation recover from semantic/protocol failures without
losing the model's prior context, and retain enough bounded diagnostics on the final
digest to explain every attempt after process logs are gone.

## Confirmed Scope

- Keep the production digest path on `@earendil-works/pi-ai/compat`; do not create a
  Coding Agent session or Pi JSONL session.
- Allow the initial structured digest request plus at most three semantic retries,
  for a hard maximum of four provider calls per entry or rollup generation.
- Build one in-memory Pi `Context` per generation and reuse it across attempts.
- Reuse one non-empty `sessionId` across all attempts for provider cache/routing
  affinity; context messages, not `sessionId`, provide conversational memory.
- Keep the first attempt's configured thinking level and force every retry to
  `thinking='off'` with the same provider, model, tool schema, and output budget.
- For a single expected tool call with object arguments that fails strict local
  validation, append the prior assistant message and a matching `isError=true`
  tool-result message containing only a bounded safe validation diagnostic.
- For empty/length output and protocol failures that cannot be replayed as a valid
  assistant/tool-result pair, append a bounded user correction to the same Context.
- Retry output failures, tool protocol/schema/normalization failures, thrown provider
  failures, and digest-layer internal timeouts. Use short bounded backoff for provider
  failures/timeouts. Never retry an already-aborted caller request or shutdown signal.
- Keep deterministic summary/section clipping before strict revalidation. A repaired
  and valid submission succeeds immediately without spending a retry.
- Persist a bounded `modelDiagnostics` object on the final digest or rollup, whether
  the final outcome is `model` or `extractive`. Retain at most four attempt records.
- Each attempt record may contain only bounded enums/counts: attempt number, outcome,
  diagnostic/submission code, retry decision, configured thinking label, stop reason,
  content block types, visible-text character count, numeric token usage, fixed-schema
  missing field names, recognized field count, unknown field count, and bounded repair
  metadata. Never persist raw model output, tool arguments or values, prompt/source
  text, provider error messages, hidden thinking, credentials, or secrets.
- Preserve existing digest summary/section budgets, one-tool non-execution semantics,
  extractive fallback, prompt behavior, and Recovery Scribe's independent strict
  parser and retry contract.

## Non-Goals

- Introducing `@earendil-works/pi-coding-agent` sessions, JSONL session files, Agent
  tool loops, or executing `submit_conversation_digest`.
- Persisting full server logs, raw provider requests/responses, model prose, tool
  arguments, hidden thinking, or secret-bearing error strings.
- Retrying conversation title generation or changing Recovery Scribe retries.
- Changing provider/model selection, output token budgets, digest text budgets,
  auto-create gates, compaction retention, or summary-memory indexing.
- Coercing invalid fields, filling missing digest content server-side, deleting unknown
  fields, or weakening the complete six-field strict schema.

## Root Cause

The 2026-09-07 19:17 production auto-digest reached the expected schema-only tool but
submitted an object with none of the six required fields. The strict parser correctly
rejected it and the digest fell back extractively, but `submission_schema_invalid` was
not retry-eligible. The direct structured path rebuilt a one-message Context for every
call, had a two-call output-only retry rule, and did not send local validation feedback
to the model. Diagnostics existed only in `console.warn`/transient SSE; the successful
extractive fallback cleared `conversationDigestState.lastFailure`, leaving no durable
explanation in SQLite.

## Data Contract

`ConversationDigestEntry.modelDiagnostics` is optional and normalized on every read:

```ts
{
  version: 1,
  finalOutcome: 'model' | 'extractive',
  attempts: Array<{
    attempt: 1 | 2 | 3 | 4,
    outcome: 'accepted' | 'rejected' | 'provider_error' | 'timeout' | 'cancelled',
    diagnosticCode?: string,
    submissionCode?: string,
    retryScheduled: boolean,
    thinking: string,
    stopReason?: string,
    contentBlockTypes?: string[],
    visibleTextChars?: number,
    usage?: {
      inputTokens?: number,
      outputTokens?: number,
      reasoningTokens?: number,
      totalTokens?: number,
    },
    missingFields?: Array<'summary' | 'facts' | 'decisions' | 'openQuestions' | 'nextActions' | 'artifacts'>,
    recognizedFieldCount?: number,
    unknownFieldCount?: number,
    repairs?: Array<{
      field: string,
      actualLength?: number,
      acceptedLimit?: number,
      actualItems?: number,
      acceptedItems?: number,
      action: 'clipped'
    }>
  }>
}
```

Unknown diagnostic fields are discarded. Strings use fixed allowlists or existing
sanitization and length caps; numbers must be bounded non-negative safe integers.
Rollups keep only diagnostics for their own generation and do not absorb source digest
diagnostics. Prompt formatting and summary-memory search do not consume diagnostics.

## Retry Matrix

| Attempt result | Context feedback | Retry while budget remains |
| --- | --- | --- |
| Valid or deterministically repaired six-field submission | None | No, accept model digest |
| One expected tool call with object arguments, strict schema/normalization failure | Prior assistant + matching error tool result | Yes |
| Empty, thinking-only, or length-exhausted output | Prior assistant + bounded user correction | Yes |
| Zero/multiple/wrong tool calls or non-object arguments | Bounded user correction; never replay malformed tool protocol | Yes |
| Thrown provider failure or provider stop error | No fabricated assistant response; same Context after short backoff | Yes |
| Digest-owned timeout | No fabricated assistant response; same Context after short backoff | Yes |
| Caller cancellation/shutdown | None | No |
| Fourth failed attempt | Persist failed attempt and use extractive fallback | No |

## Acceptance Criteria

- [x] The empty-shell `{}` regression makes a second call, and that call receives the
      same Context containing the first assistant tool call plus a matching safe error
      tool result that names all six missing fields without values.
- [x] The first call plus three retries is a strict four-call maximum across schema,
      output, provider, and timeout failures; a fifth call is impossible.
- [x] All retries use `thinking='off'`, preserve provider/model/maxTokens/tool schema,
      and share one non-empty `sessionId`.
- [x] A later valid submission stores the model digest; four failed attempts store the
      extractive fallback. Both persist normalized attempt diagnostics and final outcome.
- [x] Diagnostics survive store readback and process-independent GET, remain bounded,
      and contain no raw arguments, content markers, hidden thinking, error messages,
      source prompt text, or credentials.
- [x] Missing fields are limited to the six fixed schema names; recognized/unknown
      counts explain `{}`, nested/unknown envelopes, and compound invalid objects
      without retaining unknown names or values.
- [x] Internal timeout/provider failures retry with bounded backoff; caller cancellation
      and shutdown do not retry. No timer/listener survives settlement.
- [x] Deterministic clipping, direct-tool non-execution, extractive fallback, model and
      rollup behavior, title behavior, and Recovery strict parsing remain intact.
- [x] Focused regression tests, server smoke, mode-store, Recovery, check, typecheck,
      build, Trellis validation, and diff validation pass.
- [ ] An independent reviewer approves the exact candidate SHA.

## Validation Evidence Plan

1. Run new focused tests against exact `develop@bb13875` and record failures proving
   `{}` still falls back after one call, max retry/context/session assertions fail, and
   diagnostics are absent after SQLite readback.
2. Implement the direct structured retry state machine and bounded normalizers.
3. Re-run focused cases for schema, protocol, output, provider, timeout, cancellation,
   successful deterministic repair, exhausted fallback, entry, rollup, and readback.
4. Run full server smoke, mode-store, Recovery, static checks, build, Trellis validation,
   and diff checks before freezing the candidate for independent review.

## Target Truth Source

- `.trellis/spec/backend/conversation-digest.md`
