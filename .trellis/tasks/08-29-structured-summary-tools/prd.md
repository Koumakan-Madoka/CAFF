# Structured Tool Output for Digests and Recovery Scribe

## Goal

Replace model-authored JSON and fixed-heading prose with two no-side-effect
submission tools. Providers serialize the tool arguments; CAFF validates the
arguments and renders persisted output deterministically.

## Confirmed Scope

- Conversation digest and digest rollup generation expose
  `submit_conversation_digest` with the complete structured digest payload.
- Failed-trace recovery scribe generation exposes `submit_recovery_note` with
  six semantic sections; CAFF renders the required Markdown headings and the
  read-only/no-execution declaration.
- Conversation title generation remains short-text output and is unchanged.
- Submission tools perform no shell, network, filesystem, chat, or external
  side effect.
- A successful model result contains exactly one call to the expected tool and
  arguments that pass the authoritative schema.
- Plain-text JSON, a wrong tool, multiple tool calls, missing fields, or invalid
  field values are rejected. The model is not asked to hand-write JSON as a
  compatibility fallback.
- Existing deterministic digest extraction and mechanical recovery note remain
  the final fallbacks.
- Provider fixtures are used for verification; no paid or external real-model
  call is required.

## Failure And Retry Contract

- Tool-call protocol or schema failure is classified explicitly and must not
  persist partial model output.
- Recovery scribe keeps its bounded second-call policy for recoverable
  exhaustion/empty-result cases; provider and rate-limit failures are not
  multiplied.
- Digest generation keeps its current bounded fallback behavior, with no new
  unbounded repair loop.
- At most one accepted submission call contributes to a generated artifact.

## Acceptance Criteria

- [x] Digest and rollup prompts provide only `submit_conversation_digest` for
      structured submission and consume validated tool arguments.
- [x] Recovery scribe prompts provide only `submit_recovery_note`; server-side
      rendering always includes all six required headings and the read-only
      declaration.
- [x] Regression tests reject plain-text JSON, wrong tools, multiple calls,
      missing/invalid arguments, and partial results without persisting them.
- [x] Tests cover length/empty output retry limits, provider/rate-limit behavior,
      and both existing final fallback paths.
- [x] Existing digest metadata, rollup, summary-memory, recovery task/run, API,
      SSE, and UI contracts do not regress.
- [x] Applicable lint, typecheck, build, focused tests, and broader project tests
      pass, with any environment limitation recorded accurately.
- [ ] A reviewer other than the author reviews the exact candidate SHA and all
      findings are resolved or explicitly accepted.

## Non-Goals

- Changing title generation, digest eligibility/compaction policy, or recovery
  eligibility and capsule construction.
- Adding a general-purpose agent tool or granting the model operational
  capabilities.
- Retaining raw invalid model output in persisted metadata or logs.
- Changing frontend presentation except where a contract test requires proof
  that the rendered persisted shape is unchanged.

## Code-Spec Contract

Target truth sources:

- `.trellis/spec/backend/conversation-digest.md`
- `.trellis/spec/backend/message-recovery.md`
- `.trellis/spec/runtime/agent-runtime.md` if the provider completion/tool-call
  boundary changes.

The implementation must document tool names, argument fields, cardinality,
validation failures, retry decisions, fallback behavior, and Good/Base/Bad
Test points before completion.
