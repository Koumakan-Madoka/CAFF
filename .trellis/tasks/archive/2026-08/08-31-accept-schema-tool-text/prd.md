# Accept Schema Tool Calls With Companion Text

## Goal

Treat a unique, correctly named, schema-valid schema-only system-model tool call
as the final structured result even when the provider includes companion visible
text in the same assistant response.

## Confirmed Scope

- Apply the shared behavior to conversation digest/rollup submissions and
  Recovery Scribe submissions.
- Validate the tool call count, name, object arguments, and strict TypeBox schema
  before accepting it.
- Ignore companion visible text after a valid tool call is found. Do not execute
  the schema-only tool and do not send a tool result back to the model.
- Preserve the existing extractive/mechanical fallback for zero calls, multiple
  calls, wrong tool names, non-object arguments, and schema-invalid arguments.
- Keep hidden thinking, companion text, and raw tool arguments out of persisted
  diagnostics and metadata except for the validated normalized result.

## Non-Goals

- Restoring digest `experience`, `sourceDraftId`, `write-experience`, or automatic
  Skill draft creation.
- Relaxing the six-field digest schema or six-section Recovery schema.
- Changing retry eligibility for length, thinking-only, empty, provider error,
  timeout, or abort responses.
- Persisting model response bodies or tool arguments for observability.

## Root Cause

A real `deepseek-v4-flash` probe returned `stopReason=toolUse` with exactly one
correct `submit_conversation_digest` call plus 61 visible characters. The shared
submission parser rejected visible text before validating the usable tool call,
producing `submission_visible_text_not_allowed` and an extractive fallback.

## Acceptance Criteria

- [x] Digest `text + one valid submit_conversation_digest call` stores the model
      digest and makes exactly one provider call.
- [x] Recovery `text + one valid submit_recovery_note call` stores the rendered
      Recovery note and makes exactly one provider call.
- [x] Wrong, multiple, missing, non-object, and schema-invalid calls still fail
      closed without a protocol-repair request.
- [x] Plain text without a tool call still falls back.
- [x] Specs describe companion text as ignored only after strict tool validation.
- [x] Focused tests, check, typecheck, build, and applicable smoke tests pass.
- [ ] An independent reviewer approves the exact candidate SHA.

## Validation Matrix

| Response | Expected result |
| --- | --- |
| One correct schema-valid call, no text | Accept validated arguments |
| One correct schema-valid call plus text | Accept validated arguments; ignore text |
| Text only | Invalid output; existing fallback |
| Zero, multiple, or wrong-name calls | Invalid output; existing fallback |
| Correct call with invalid arguments | Invalid output; existing fallback |

## Good / Base / Bad

- Good: V4 Flash returns a short acknowledgement beside one valid digest tool
  call; CAFF stores the validated six-field digest and stops after that response.
- Base: a provider returns only one valid tool call; existing behavior is unchanged.
- Bad: companion text causes a valid tool envelope to be discarded, or text is
  accepted without a valid tool call.

## Target Truth Sources

- `.trellis/spec/backend/conversation-digest.md`
- `.trellis/spec/backend/message-recovery.md`
