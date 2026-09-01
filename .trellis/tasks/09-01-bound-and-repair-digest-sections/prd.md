# Bound and Repair Digest Sections

## Goal

Preserve more structured digest evidence and avoid extractive fallback when a
valid `submit_conversation_digest` submission exceeds only deterministic section
budgets.

## Confirmed Scope

- Raise all five digest section arrays from 8 to 12 retained items in the
  provider schema, persisted normalization, extractive generation, rollups, and
  prompt-facing digest representation.
- Keep each item limited to 240 characters and `summary` storage limited to 800
  characters; keep the provider-facing summary envelope at 1600 Unicode code
  points.
- After the existing one-call, expected-name, and plain-object guards, repair a
  shallow copy by clipping `summary` as already implemented, retaining the first
  12 items of each correctly typed section array, and clipping correctly typed
  string items longer than 240 characters with the existing ellipsis rule.
- Run the unchanged complete six-field strict schema after preparation. Accept
  the model digest only when the prepared copy passes.
- Keep missing/extra fields, wrong field types, non-string array items, and
  wrong/multiple/non-object tool submissions fail closed with the extractive
  fallback.
- Make one provider call, never execute the schema-only tool, never return a
  tool result, and never schedule a schema-repair model call.
- Log only bounded repair metadata: field, optional item index, original item
  count or Unicode code-point length, accepted limit, and `action=clipped`, plus
  existing bounded attempt metadata. Never log summary/item values, raw
  arguments, companion text, hidden thinking, or secrets.
- Update model and rollup instructions to state the complete limits explicitly:
  summary target at most 800 characters, each main array at most 12 items, and
  each item at most 240 characters.

## Non-Goals

- Increasing the 800-character stored/prompt summary budget or 1600-code-point
  provider summary envelope.
- Coercing field types, converting non-string items, filling missing fields, or
  deleting unknown fields to manufacture validity.
- Relaxing Recovery Scribe schemas or preprocessing its submissions.
- Changing provider/model configuration, output token budgets, retry
  eligibility, compaction entry retention, or raw-output persistence.

## Root Cause

Provider constrained sampling is `strict: prefer`, so array and item limits are
not guaranteed at the server boundary. The prior digest parser rejected a
complete six-field model submission when one section contained a ninth item,
discarding all structured evidence and replacing it with an extractive digest.
The section budget was also duplicated across schema, normalization, prompt,
and tests, making partial limit changes likely to drift.

## Acceptance Criteria

- [x] The tool schema advertises 12 items per digest section and 240 characters
      per item; the model prompt states summary `<=800`, arrays `<=12`, and items
      `<=240`.
- [x] Valid 12-item sections are stored with all 12 items in model, extractive,
      normal read, and rollup normalization paths.
- [x] A 13-item otherwise-valid submission is accepted after one provider call,
      stores the first 12 items, and logs only bounded count repair metadata.
- [x] A 241+-code-point string item is clipped deterministically to schema-valid
      bounded text, preserves the model digest, and logs only field/index/length
      metadata.
- [x] Multiple simultaneous section count/item-length violations are repaired
      on one shallow copy and all safe repair diagnostics are bounded.
- [x] Any repaired submission that also has an extra/missing/mistyped field or
      non-string item fails strict revalidation, uses extractive fallback, and
      emits no successful `action=clipped` warning.
- [x] Existing summary repair, companion text, call/name/object guards, no-tool
      execution, one-call behavior, and Recovery strict parsing remain intact.
- [x] Focused tests, full server smoke, mode-store, Recovery, check, typecheck,
      build, Trellis validation, and diff validation pass.
- [ ] An independent reviewer approves the exact candidate SHA.

## Validation Matrix

| Tool arguments | Expected result |
| --- | --- |
| Five arrays each `<=12`, items `<=240`, otherwise valid | Strict acceptance and 12-item storage |
| Any array `>12`, all retained items strings | Keep first 12, strict revalidate, store model digest |
| Any retained string item `>240` | Clip item to 240, strict revalidate, store model digest |
| Multiple repairable summary/array/item violations | Apply all deterministic repairs, strict revalidate, store model digest |
| Repairable violation plus extra/missing/wrong field or non-string item | Strict rejection and extractive fallback |
| Wrong/multiple call or non-object arguments | Existing rejection and extractive fallback |
| Recovery submission | Existing strict parser behavior without preprocessing |

## Target Truth Source

- `.trellis/spec/backend/conversation-digest.md`
