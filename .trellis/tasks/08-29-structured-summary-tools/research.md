# Research

## Relevant Specs

- `.trellis/spec/backend/conversation-digest.md`: authoritative digest model,
  validation, fallback, retry, persistence, and smoke-test contract. It currently
  mandates JSON Mode/no tools and must be revised.
- `.trellis/spec/backend/message-recovery.md`: authoritative recovery scribe
  isolation, fixed-section output, retry, mechanical fallback, and runtime-test
  contract. It currently mandates `tools: []` and model-authored headings.
- `.trellis/spec/runtime/agent-runtime.md`: direct PI AI consumer boundary and
  no-Agent-session rule. JSON-schema-shaped tool data may cross the isolated
  direct/runtime consumers, while runtime objects must not.
- `.trellis/spec/unit-test/runtime-tests.md`: fake-provider, retry-budget,
  hidden-thinking, real-store, and fallback regression patterns.
- `.trellis/spec/guides/cross-layer-thinking-guide.md`: the provider response ->
  domain validation -> persisted artifact boundary needs one authority.
- `.trellis/spec/guides/code-reuse-thinking-guide.md`: share the single-call
  extraction/cardinality/schema check instead of duplicating it in digest and
  recovery.

## Data Flow

1. Digest: bounded messages/digests -> prompt -> `pi-ai/compat complete()` with
   one schema-only tool -> assistant content blocks -> shared single-submission
   extractor -> existing digest normalization -> metadata/summary-memory.
2. Recovery: bounded redacted Capsule -> `ModelRuntime.completeSimple()` with
   one schema-only tool -> assistant content blocks -> shared extractor ->
   deterministic Markdown renderer -> existing recovery row/run/message flow.
3. Neither submission is executed. A `toolCall` block is treated as a provider-
   serialized return envelope, not dispatched to Agent/session/bridge code.
4. Tool schemas and local validation are authoritative at the provider/domain
   boundary. Existing downstream clipping and persistence bounds remain a
   defense-in-depth layer.

## Existing Patterns

- `server/domain/conversation/system-model-output.ts` centralizes visible text,
  output-budget, retry eligibility, safe diagnostics, and invalid-output
  classification for both consumers.
- `@earendil-works/pi-ai` represents tools under `Context.tools` and returns
  `{ type: 'toolCall', id, name, arguments }` content blocks. The installed PI
  AI exposes `validateToolCall`, but its validator may coerce values; CAFF needs
  strict schema checks for this return protocol.
- `lib/pi-extensions/caff-capabilities.mjs` defines TypeBox object schemas with
  `additionalProperties: false`; the new submission definitions should follow
  that shape without adding execute handlers.
- `conversation-digest.ts` direct JSON Mode path already owns provider lookup,
  DeepSeek configured-model construction, timeout, output budget, progress, and
  two-attempt exhaustion retry. Replace only response-format/context/output
  parsing while preserving those owners.
- `message-recovery.ts` already uses `ModelRuntime.completeSimple` directly and
  never starts an Agent session. Add one context tool and consume its arguments;
  do not route it through the tool bridge.

## Contract Decisions

- Expected tools: `submit_conversation_digest` and `submit_recovery_note`.
- Success requires exactly one tool-call block, exact expected name, an object
  argument payload, no visible正文 text, and strict schema validity. Thinking
  blocks may coexist but are never persisted.
- Wrong tool, zero/multiple calls, visible正文 JSON/prose, unknown fields, missing
  fields, or wrong field types become `invalid_output` and use the existing
  final fallback. They do not trigger a third call or a JSON-repair prompt.
- Digest fields remain `summary`, `facts`, `decisions`, `openQuestions`,
  `nextActions`, `artifacts`, and `experience`. All are required; `experience`
  can be empty and retains optional `sourceDraftId` in each item.
- Recovery fields are six bounded string arrays: `alreadyCompleted`,
  `failureLocation`, `possiblyEffective`, `notCompleted`, `recoveryPoint`, and
  `unknown`. CAFF renders the six Chinese headings and exact non-execution
  statement. Empty arrays render as `- 无。`.
- `toolChoice: 'auto'` is the portable PI AI contract; the prompt and the single
  offered tool require submission. Named forced tool choice is not available in
  the provider-neutral `SimpleStreamOptions` type.
- Injected `digestModelRunner` object fixtures remain a trusted deterministic
  seam, not provider output. Direct PI provider output is tool-only. Legacy text
  JSON repair remains only behind that injected/legacy seam until it is removed
  separately.

## Files To Modify

- `server/domain/conversation/system-model-submission.ts`: new shared tool
  definitions, strict extraction, and recovery-note renderer.
- `server/domain/conversation/conversation-digest.ts`: tool context/completion,
  tool-argument validation, diagnostics/progress wording, and removal of direct
  JSON Mode payload handling.
- `server/domain/conversation/message-recovery.ts`: recovery tool context and
  deterministic Markdown rendering.
- `tests/smoke/server-smoke.test.js`: direct provider tool-call success and
  invalid cardinality/name/body/schema/fallback/retry regressions.
- `tests/runtime/message-recovery.test.js`: schema-only tool, deterministic
  rendering, invalid-call fallback, retry and provider-error regressions.
- `tests/runtime/agent-executor-hook.test.js`: retain direct non-Agent/no-progress-
  recovery assertion while acknowledging schema-only submission tools.
- `.trellis/spec/backend/conversation-digest.md` and
  `.trellis/spec/backend/message-recovery.md`: replace obsolete JSON Mode and
  model-authored heading contracts with executable tool schemas/matrices.
- `.trellis/spec/runtime/agent-runtime.md`: clarify that direct system-model
  submission tools are non-executed JSON-schema return envelopes.
