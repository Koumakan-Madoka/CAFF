# Widen Digest Summary Submission Limit

## Goal

Accept a structurally valid `submit_conversation_digest` tool submission whose
`summary` is between 801 and 1600 JSON Schema string characters (Unicode code
points), then preserve the existing persisted and prompt-facing 800-character
digest budget through the normal deterministic clipping step.

## Confirmed Scope

- Raise only the digest tool-envelope `summary` acceptance limit from 800 to
  1600.
- Keep the normalized stored digest summary bounded at 800 characters.
- Keep the five section arrays at 8 items and 240 characters per item.
- Keep exactly six required digest fields, `additionalProperties: false`, and
  all existing call-count/name/object/type validation.
- Reject summaries longer than 1600 without a model retry and use the existing
  extractive fallback.
- For an over-limit summary, emit bounded diagnostics containing only
  `field=summary`, `actualLength`, and `acceptedLimit`, never the summary text or
  raw tool arguments.

## Non-Goals

- Increasing persisted digest, prompt, or summary-memory budgets.
- Truncating structurally invalid fields into validity.
- Relaxing Recovery Scribe limits or schemas.
- Changing model retry eligibility, tool execution, or provider configuration.
- Persisting raw model output or tool arguments.

## Root Cause

A production `deepseek-v4-flash` response on 2026-08-31 returned exactly one
correct digest submission tool call, but its `summary` exceeded the tool
schema's 800-character limit. The shared parser rejected the envelope before
`normalizeModelDigestPayload` could apply its existing 800-character clipping,
so the whole result fell back extractively. Provider constrained sampling is
`strict: prefer` and does not guarantee `maxLength` compliance.

## Acceptance Criteria

- [x] A summary of exactly 801 and exactly 1600 characters is accepted and stored
      as an 800-character normalized summary ending in the existing ellipsis.
- [x] A summary of exactly 1601 characters is rejected and uses the extractive
      fallback after exactly one provider call.
- [x] The 1601 rejection logs `field=summary`, `actualLength=1601`, and
      `acceptedLimit=1600` without logging the submitted text or arguments.
- [x] Arrays and all other structural/schema guardrails remain unchanged.
- [x] Digest specs distinguish the 1600 envelope limit from the 800 stored limit.
- [x] Focused tests, check, typecheck, build, and smoke tests pass.
- [x] An independent reviewer approves the exact candidate SHA.

## Validation Matrix

| Tool arguments | Expected result |
| --- | --- |
| `summary.length <= 800` and otherwise valid | Accept unchanged |
| `summary.length = 801..1600` and otherwise valid | Accept, normalize stored summary to 800 |
| `summary.length > 1600` | Invalid output, bounded length diagnostics, extractive fallback |
| Wrong/multiple call or structural/type failure | Existing invalid-output fallback |

## Target Truth Source

- `.trellis/spec/backend/conversation-digest.md`
