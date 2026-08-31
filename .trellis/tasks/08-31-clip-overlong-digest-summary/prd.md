# Clip Overlong Digest Summary Submissions

## Goal

Preserve a structurally valid `submit_conversation_digest` submission when only
its string `summary` exceeds the advertised 1600-code-point envelope limit by
applying the existing deterministic 800-character digest clipping before final
strict schema validation.

## Confirmed Scope

- Keep the provider-facing tool schema at `summary.maxLength = 1600`.
- After the existing one-call, expected-name, and plain-object guards, repair
  only a string `summary` longer than 1600 Unicode code points.
- Repair by applying the existing 800-character digest clipping rule to a
  shallow copy, then validate all six fields with the unchanged strict schema.
- Accept the repaired submission only if the complete copied object passes that
  schema; missing/extra/mistyped fields and arrays beyond `8 x 240` still fail
  closed and use the extractive fallback.
- Make one provider call, do not execute the schema-only tool, do not return a
  tool result, and do not schedule a model repair call.
- Log only bounded metadata for successful repair: `field=summary`, Unicode
  code-point `actualLength`, `acceptedLimit=1600`, and `action=clipped`; never
  log the summary value, raw arguments, companion text, or hidden thinking.

## Non-Goals

- Raising the persisted or prompt-facing 800-character summary budget.
- Clipping arrays, array items, missing fields, extra fields, or wrong types
  into validity.
- Relaxing Recovery Scribe schemas or preprocessing its submissions.
- Changing provider configuration, output token budgets, or retry eligibility.
- Persisting raw model output or tool arguments.

## Root Cause

The provider-facing JSON Schema is a preferred constrained-sampling contract,
not a guaranteed server boundary. Rejecting a complete model digest solely
because `summary` exceeded 1600 discarded five otherwise useful structured
sections and replaced them with a lower-quality extractive fallback, even
though the normal digest path already clips accepted summaries to 800.

## Acceptance Criteria

- [x] A 1601-code-point summary with otherwise valid arguments is accepted after
      one provider call and stored as an 800-character model summary ending in
      the existing ellipsis.
- [x] A substantially larger summary, including non-BMP Unicode, follows the
      same repair path and reports its Unicode code-point length safely.
- [x] The successful repair warning includes only `field=summary`,
      `actualLength`, `acceptedLimit=1600`, and `action=clipped` plus existing
      bounded attempt metadata; it excludes the submitted marker and arguments.
- [x] Overlong summary plus an extra/missing/mistyped field still falls back.
- [x] Overlong summary plus an oversized array or item still falls back.
- [x] Summaries through 1600, strict six-field validation, arrays `8 x 240`,
      companion text handling, and Recovery behavior remain unchanged.
- [x] Focused tests, smoke, Recovery, check, typecheck, build, Trellis, and diff
      validation pass.
- [ ] An independent reviewer approves the exact candidate SHA.

## Validation Matrix

| Tool arguments | Expected result |
| --- | --- |
| `summary.length <= 1600`, otherwise valid | Existing strict acceptance and 800 storage normalization |
| `summary.length > 1600`, otherwise valid | Clip copied summary to 800, strict revalidate, store model digest |
| Overlong summary plus any other schema violation | Strict rejection and extractive fallback |
| Wrong/multiple call or non-object arguments | Existing rejection and extractive fallback |
| Recovery submission | Existing shared parser behavior without preprocessing |

## Target Truth Source

- `.trellis/spec/backend/conversation-digest.md`
