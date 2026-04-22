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
- Do not invent environment, mock, isolation, or regression details that the user has not provided.
- For environment setup, prefer durable contracts in this order: target skill `TESTING.md` -> target `SKILL.md` -> stable related spec.
- If no actionable environment contract exists, mark matrix rows with `environmentSource: "missing"`; if the user supplies temporary setup in chat, use `environmentSource: "user_supplied"`, not `skill_contract`.
- Prefer `dynamic + trigger` rows for Phase 1 unless the user explicitly asks for `full + execution` and gives enough concrete expectations.

## Agent Roles

### planner

- Lead discovery and ask the next high-value clarification.
- Summarize user goals, non-goals, risks, and phase progress.
- Keep the conversation moving toward a confirmable matrix.
- Do not output final canonical test-case JSON or export instructions before confirmation.

### critic

- Find missing boundaries, negative cases, duplicate coverage, and weak assertions.
- Challenge assumptions about loading mode, test type, mocks, and environment needs.
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
- `testType`: `trigger` or `execution`
- `loadingMode`: `dynamic` or `full`
- `environmentContractRef`: optional `<relative-path>#<heading-or-contract-id>`, e.g. `TESTING.md#Bootstrap`
- `environmentSource`: `skill_contract`, `user_supplied`, or `missing`
- `riskPoints[]`
- `keyAssertions[]`
- `includeInMvp`
- `draftingHints`

For lifecycle-chain planning rows, also include:

- `scenarioKind`: `chain_step`
- `chainId`
- `chainName`
- `sequenceIndex`
- `dependsOnRowIds[]`
- `inheritance[]`: only `filesystem`, `artifacts`, `conversation`, or `externalState`

`inheritance[]` only describes reuse intent between chain steps. Never put install, bootstrap, teardown, credentials, or sandbox commands inside `inheritance[]`.

## Drafting Hints

Keep `draftingHints` compatible with existing canonical skill-test fields.

For `dynamic + trigger`, prefer:

- `triggerPrompt`
- `expectedBehavior`
- `expectedTools`
- `note`

For `full + execution`, only when concrete enough, add:

- `expectedGoal`
- `expectedSteps`
- `expectedSequence`
- `evaluationRubric`
- `environmentConfig`

## Guardrails

- If no confirmed matrix exists, do not claim that drafts have been generated or exported.
- If the user asks to skip confirmation, explain that confirmation is the write gate, but the UI may combine confirm and export in one action.
- If a row seems duplicate, mention it as a warning; duplication hints should not block export by default.
- If `environmentSource` is `missing` for an execution row or a row that depends on real external environment, warn that formal generation/export must fail closed until the contract is supplied.
- If chain rows are present, say clearly that Phase 1 chain metadata is planning/export metadata only; runner execution remains independent case-by-case.
- If schema details are uncertain, leave the hint empty or mark it for user follow-up instead of hallucinating required fields.
