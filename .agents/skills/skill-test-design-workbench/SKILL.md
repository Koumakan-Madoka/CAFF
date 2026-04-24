---
name: "Skill Test Design Workbench"
description: "Skill Test 设计聊天工作台模式的全量挂载指令，用于追问、测试矩阵规划、确认门禁和 draft-first 导出。"
---

# Skill Test Design Workbench

This skill is active in `skill_test_design` conversations.

Use the prompt's `Mode state context` as the runtime source of truth for:

- target skill id, name, description, and path
- current phase
- current agent role
- existing case summary and recent prompts
- latest matrix and confirmation status

## Core Contract

- Design tests through conversation first; do not jump straight to canonical case JSON.
- Before matrix confirmation, focus on clarification, scenario discovery, and matrix refinement.
- Treat the test matrix as a planning object, not as the final `skill_test_cases` storage format.
- Formal draft creation/export only happens through the guarded UI/API flow; chat text alone never writes cases.
- Exported cases must remain draft-first: `case_status = draft` and no automatic run.
- Default to complete `full + execution` test-case design for the selected target skill. Do not ask the user to choose a loading mode; use load/trigger-only coverage only when the user explicitly asks for it.
- Treat the user-facing scope as the current export scope / coverage scope. Do not ask whether to make a smaller minimum set; design a complete useful test set unless the user explicitly narrows it.
- Skill Tests run in an isolated sandbox case world by default (`host-loop + sandbox-tools`). Do not ask the user to confirm whether sandboxing is enabled; only ask about target-skill-specific extra dependencies, credentials, external services, egress, GUI, persistence, or setup/teardown requirements beyond that baseline.
- Do not invent environment, mock, isolation, or regression details that the user has not provided.
- For environment setup, prefer durable contracts in this order: target skill `TESTING.md` -> target `SKILL.md` -> stable related spec.
- If no actionable environment contract exists, mark matrix rows with `environmentSource: "missing"`; if the user supplies temporary setup in chat, use `environmentSource: "user_supplied"`, not `skill_contract`.
- When the target skill has no `TESTING.md`, expect the UI/API to automatically create a guarded preview draft; do not ask the user whether to preview first.
- When an existing `TESTING.md` is insufficient, offer the guarded draft-refresh workflow instead of silently overwriting it.
- Treat `TESTING.md` drafts as guarded API/UI artifacts: preview first, user confirms, then fixed-path apply writes `TESTING.md`; chat prose alone never upgrades `user_supplied` to `skill_contract`.
- For normal behavior coverage, use `testType: "execution"` with `loadingMode: "full"`. `environment-build` is allowed for reusable environment assets; `trigger` is reserved for explicit load-only checks.

## Agent Roles

### planner

- Lead discovery and ask the next high-value clarification.
- Summarize user goals, non-goals, risks, and phase progress.
- Keep the conversation moving toward a confirmable matrix.
- Do not output final canonical test-case JSON or export instructions before confirmation.

### critic

- Find missing boundaries, negative cases, duplicate coverage, and weak assertions.
- Challenge weak goals, missing expected steps, mocks, and environment needs without reopening Full vs Dynamic unless the user explicitly asks.
- Prefer short review bullets that sharpen the matrix instead of rewriting the whole plan.

### scribe

- Consolidate the official matrix from agreed scope.
- Keep row fields structured and export-friendly.
- Only the `scribe` should create the official machine-readable matrix artifact for UI import.
- When revising an existing matrix, replace it deliberately instead of emitting multiple conflicting official matrices or artifact pointers in one reply.

## Phase Behavior

### collecting_context

- Ask targeted follow-up questions.
- Identify missing constraints, priority paths, known regressions, and non-goals.
- Avoid official matrix output until enough context exists.

### planning_matrix

- Refine scenarios, priorities, risk points, and key assertions.
- Produce a structured matrix candidate when scope is clear enough.
- Do not export drafts.

### awaiting_confirmation

- Answer questions about the matrix.
- Tighten rows based on user edits.
- If rows are blocked because `TESTING.md` is missing, point to the auto-created draft preview and ask for any missing facts shown in Open Questions.
- If rows are blocked because an existing contract is insufficient, offer a guarded draft refresh before trying execution export.
- Wait for explicit confirmation before export.

### generating_drafts

- Stay aligned to the confirmed matrix.
- Produce export-ready drafting hints only for confirmed scope.
- Do not add unconfirmed scenarios.

### exported

- Focus on duplicate review, failures, follow-up fixes, and next steps.
- Do not restart planning unless the user asks for another matrix iteration.

## Official Matrix Output

When you are the `scribe` and you propose the official matrix, do not paste the full matrix JSON into chat. Large matrices can exceed the chat message limit.

Instead:

1. Use the `write` tool to save exactly one JSON object to a workspace-relative artifact path:
   `.tmp/skill-test-design/<skillId>/<matrixId>.json`
2. Keep the chat message short: summarize the matrix and include exactly one standalone pointer line:
   `MATRIX_ARTIFACT: .tmp/skill-test-design/<skillId>/<matrixId>.json`
3. Do not use system temp directories, private agent directories, or absolute paths; the importer only trusts project-local `.tmp/skill-test-design/` artifacts.
4. If the `write` tool is unavailable, fall back to a fenced JSON block only for a very small matrix and warn that automatic import may fail for oversized content.

The artifact file must contain this top-level shape:

```json
{
  "kind": "skill_test_matrix",
  "matrixId": "matrix-<short-stable-id>",
  "skillId": "<target-skill-id>",
  "phase": "awaiting_confirmation",
  "rows": []
}
```

Each `rows[]` entry must include:

- `rowId`
- `scenario`
- `priority`: `P0`, `P1`, or `P2`
- `coverageReason`
- `testType`: `execution` by default, or `environment-build`; use `trigger` only for explicit load-only checks
- `loadingMode`: `full` by default; use `dynamic` only for explicit load-only checks
- `environmentContractRef`: optional `<relative-path>#<heading-or-contract-id>`, e.g. `TESTING.md#Bootstrap`
- `environmentSource`: `skill_contract`, `user_supplied`, or `missing`
- `riskPoints[]`
- `keyAssertions[]`
- `includeInExport`: boolean for the current export scope; omit only when true
- `draftingHints`

For lifecycle-chain planning rows, also include:

- `scenarioKind`: `chain_step`
- `chainId`
- `chainName`
- `sequenceIndex`
- `dependsOnRowIds[]`
- `inheritance[]`: only `filesystem`, `artifacts`, `conversation`, or `externalState`

`inheritance[]` only describes reuse intent between chain steps. Never put install, bootstrap, teardown, credentials, or sandbox commands inside `inheritance[]`.

## TESTING.md Draft Workflow

Use this branch when the target skill lacks a durable environment contract. If `TESTING.md` is missing, the workbench should automatically prepare the preview draft; explicit user confirmation is still required before applying it.

- Source material may only come from target `SKILL.md`, stable related spec, or user-supplied chat details.
- Keep section source tags within `skill_md`, `stable_spec`, `user_supplied`, or `missing`; do not invent `inferred` or `auto_generated` source kinds.
- Required sections are `Prerequisites`, `Setup` / `Bootstrap`, `Verification`, `Teardown`, and `Open Questions`.
- If `Prerequisites` or `Setup` remain missing, or Open Questions affect execution, warn that execution rows remain fail-closed after apply.
- If the user accepts a preview and it is applied, tell them to regenerate or re-confirm affected matrix rows instead of silently editing existing rows to `skill_contract`.

## Drafting Hints

Keep `draftingHints` compatible with existing canonical skill-test fields.

For default `full + execution`, add complete canonical hints:

- `triggerPrompt` / `userPrompt`: the actual user task the agent should execute
- `expectedGoal`
- `expectedSteps`
- `expectedSequence`
- `evaluationRubric`
- `environmentConfig`
- `expectedBehavior`
- `note`

For `dynamic + trigger`, only when the user explicitly requests load-only coverage, prefer:

- `triggerPrompt`
- `expectedBehavior`
- `expectedTools`
- `note`

For `environment-build`, the case is contract-driven and does not need a trigger prompt. Prefer:

- `environmentConfig`: bootstrap and verify configuration (or leave empty to read from `TESTING.md` contract)
- `expectedBehavior`: describe the expected manifest/image outcome
- `note`: cover rationale and risk points
- Do not fill `triggerPrompt`, `expectedGoal`, `expectedSteps`, or `expectedTools`; the draft builder will set sensible defaults.

When the scenario expects the agent to modify artifacts, keep every field aligned on that edit/apply outcome:

- `triggerPrompt`, `expectedGoal`, `expectedBehavior`, and `expectedSteps` should all describe the same write path.
- Do not mix a review-only prompt with an edit/apply goal.
- For tracked-change or redline work, prefer verbs such as `apply`, `edit`, `redline`, `insert`, `delete`, or `mark up`; reserve `review`, `analyze`, `summarize`, or `report` for genuinely read-only cases.

## Guardrails

- If no confirmed matrix exists, do not claim that drafts have been generated or exported.
- If the user asks to skip confirmation, explain that confirmation is the write gate, but the UI may combine confirm and export in one action.
- If a row seems duplicate, mention it as a warning; duplication hints should not block export by default.
- Keep user-facing wording on 导出范围 / coverage scope; do not ask whether the user wants a smaller minimum set.
- If a row expects tracked changes or redlines, do not let the official matrix or drafting hints drift into review-only wording unless the user explicitly asked for review instead of edits.
- If `environmentSource` is `missing` for an execution row or a row that depends on real external environment, warn that formal generation/export must fail closed until the contract is supplied.
- For `environment-build` rows, `environmentContractRef` should point to a valid `TESTING.md#skill-test-environment` contract; if missing, the row should still be plannable but export will warn that environment setup will be empty until the contract is provided or `environmentConfig` is manually filled.
- If a `TESTING.md` draft exists but is not applied, do not treat it as `skill_contract`; if it was applied, still require matrix refresh/re-confirmation before export.
- If chain rows are present, say clearly that Phase 1 chain metadata is planning/export metadata only; runner execution remains independent case-by-case.
- If schema details are uncertain, leave the hint empty or mark it for user follow-up instead of hallucinating required fields.
