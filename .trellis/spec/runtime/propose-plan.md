# propose-plan Tool (Runtime Bridge)

## Scenario: Agent Proposes or Updates a DAG Plan

### 1. Scope / Trigger
- Trigger: implementing or modifying the `propose-plan` agent tool, its bridge handler, or the dag-planning skill.
- Applies when changes touch `lib/agent-chat-tools.ts` (`proposePlan` command), `server/api/agent-tools-controller.ts` (`/api/agent-tools/propose-plan`), `server/domain/runtime/agent-tool-bridge.ts` (`handleProposePlan`), or `.agents/skills/dag-planning/SKILL.md`.
- PRD of record: `.trellis/tasks/dag-planning/prd.md` §5 (D5).
- Goal: agents create/update the shared plan through a thin CLI wrapper; the store's validation + optimistic concurrency stay the single authority; failures come back with issue details so the model can self-repair.

### 2. Signatures
- CLI (`build/lib/agent-chat-tools.js`, from repo root; `$CAFF_CHAT_TOOLS_PATH` elsewhere):
  - `propose-plan --content-stdin | --content '<json>'` — plan doc JSON (object with `nodes`, optional `edges`).
  - `--version <n>` — optional positive integer; required in practice when updating an existing plan.
- HTTP: `POST /api/agent-tools/propose-plan`, body `{ invocationId, callbackToken, doc, version? }` → `200 { ok, ownerConversationId, plan, warnings }`.
- Bridge: `handleProposePlan(body)` in `agent-tool-bridge.ts`; resolves the invocation (conversation/agent/turn), then calls `store.savePlanForConversation(context.conversationId, { doc, version })`.
- Skill: `.agents/skills/dag-planning/SKILL.md` teaches doc format, merge-node semantics, branch naming convention (named at graph build, checked out lazily), and lifecycle permissions.

### 3. Contracts
- The tool is a **thin wrapper**: it never validates the DAG itself. All rules (`validatePlanDoc`, `validateStatusOnlyUpdate`, version guard, lifecycle gates) come from the store path shared with the REST API.
- First write creates the plan as `draft` (no version needed); subsequent writes must pass the current `version` or get `409 plan_version_conflict` — the model should GET the plan (or read the panel payload) and retry with the fresh version.
- Active plans: only node `status` transitions pass; structural attempts fail with `plan_locked_*` issue codes. `activate` is user-only — the tool must never offer an activate command.
- On success the bridge broadcasts `conversation_plan_updated` (same payload as the REST controller) so every open panel refreshes.
- Every call (success or failure) appends an `agent_tool_call` invocation event with `schemaVersion: 1`, a `request` summary (`nodeCount`/`edgeCount`/`version`, never the full doc), and a `result` summary (`planId`/`planStatus`/`planVersion`/`warningCount`) or an `error` summary (`statusCode` + clipped message).
- Error responses keep the HTTP `statusCode` and `issues[]` so the model can branch on `plan_cycle`, `plan_dependency_missing`, `plan_node_id_duplicate`, `plan_version_conflict`, `plan_locked_*` and repair its next attempt.

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| CLI | no `--content`/`--content-stdin` | throws `propose-plan requires --content or --content-stdin...` |
| CLI | content is not JSON / not an object | throws before any HTTP call |
| CLI | `--version` not a positive integer | throws `propose-plan --version must be a positive integer.` |
| bridge | `doc` missing/not an object | `400 plan_doc_required`, failure event recorded |
| bridge | `version` present but invalid | `400 plan_version_invalid` |
| bridge | doc fails DAG validation | `422 plan_validation_failed` + `issues[]`, nothing persisted |
| bridge | stale/missing version on existing plan | `409 plan_version_conflict` |
| bridge | active plan, structural edit | `409 plan_locked` + `plan_locked_*` issues |
| bridge | valid write | `200 ok`, version bumped, SSE broadcast, success event |

### 5. Good / Base / Bad Cases
- Good: model submits a plan with a cycle → receives `plan_cycle` with the cycle path → emits a corrected doc on the next attempt; the store never saw a partial write.
- Good: model flips a node to `done` on an active plan with the current version → status-only update accepted, both panels refresh via SSE.
- Base: first `propose-plan` in a session creates the draft; the response's `plan.version` is what the model passes as `--version` on the next update.
- Bad: model invents node ids that duplicate existing ones → `plan_node_id_duplicate`; the fix is to read the current plan first, not to retry blindly.

### 6. Tests Required
- `tests/runtime/propose-plan.test.js`: create + broadcast, cycle/empty-doc rejection without persistence, version conflict 409, active-mode status allowed + structural change `plan_locked`, CLI flag parsing.
- Assertion points: `agent_tool_call` events for both success and failure paths; broadcast payload matches the REST controller shape; error issues survive the HTTP round-trip.

### 7. Wrong vs Correct
#### Wrong
```typescript
// handleProposePlan writes planRepository directly and does its own
// JSON.parse + cycle check, bypassing the store lifecycle gates.
```
#### Correct
```typescript
// Thin wrapper: resolve invocation, delegate to the store, broadcast, record.
const result = store.savePlanForConversation(context.conversationId, { doc, version: normalizedVersion });
broadcastEvent('conversation_plan_updated', { conversationId: context.conversationId, ownerConversationId: result.ownerConversationId, plan: result.plan });
```
