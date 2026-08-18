# DAG Planning (Backend)

## Scenario: Conversation Tree DAG Plan

### 1. Scope / Trigger
- Trigger: implementing or modifying plan storage, plan lifecycle, or the plan REST API.
- Applies when changes touch `chat_plans` schema, `chat_conversations.branch`, `storage/chat/plan.repository.ts`, plan methods in `lib/chat-app-store.ts`, `lib/plan-dag.ts`, or `server/api/conversation-plan-controller.ts`.
- PRD of record: `.trellis/tasks/dag-planning/prd.md` (decisions D1–D9).
- Goal: one DAG plan per conversation tree, hung on the root conversation; draft editable, active structurally locked; every write validated and version-guarded.

### 2. Signatures
- DB (see `ensureChatPlanSchema` in `storage/sqlite/migrations.ts`):
  - `chat_plans(id TEXT PK, owner_conversation_id TEXT NOT NULL UNIQUE, status TEXT CHECK IN ('draft','active','done','archived') DEFAULT 'draft', version INTEGER CHECK (version >= 1), doc_json TEXT NOT NULL, activated_at TEXT, created_at TEXT, updated_at TEXT, FK owner → chat_conversations(id) ON DELETE CASCADE)`
  - `chat_conversations.branch TEXT` (nullable; covered by CREATE TABLE template, `ensureColumn` for existing DBs, and lineage-rebuild INSERT).
- Shared validation (`lib/plan-dag.ts`, pure functions, no server-only deps — the frontend may reuse it):
  - `validatePlanDoc(doc) → { ok, issues[], warnings[] }`
  - `validateStatusOnlyUpdate(oldDoc, newDoc) → { ok, issues[], warnings[] }`
  - `appendPlanHistory(doc, entry) → doc'` — D18 append + 200-entry rolling cap.
  - `diffNodeStatusTransitions(oldDoc, newDoc) → [{ nodeId, from, to }]`.
  - `findBlockedUpstreams(doc, nodeId) → string[]` — D16 transitive upstream scan.
  - `derivePlanEdges(doc) → [{from, to}]` (edges are derived from `depends_on`; `edges[]` in the doc is optional but must match when present).
- Store (`lib/chat-app-store.ts`):
  - `resolvePlanOwnerConversation(conversationId)` — walks `origin_conversation_id` to the root; returns null on missing conversation or lineage cycle.
  - `getPlanForConversation(conversationId) → { ownerConversationId, plan | null }`
  - `savePlanForConversation(conversationId, { doc, version? }, { actor }) → { ownerConversationId, plan, warnings }`
  - `activatePlanForConversation(conversationId, actor)` / `revertPlanForConversation(conversationId, actor)`
  - `writePlanNodeExecution(conversationId, updates, { reason? })` — system-actor internal channel for the scheduler (may bind `spawned_conversation_id`); see `dag-execution.md`.
  - `createPlanError(statusCode, code, message, details)` — errors carry `{ statusCode, code, issues[] }`.
- Actor model (D15): `{ type: 'user' }` (REST/UI trusted channel), `{ type: 'agent', agentId, conversationId }` (tool bridge, invocation-authenticated), `{ type: 'system' }` (scheduler internal). `activate`/`revert` with an agent actor require the agent to be a participant of the ROOT conversation and the call to originate from the root — otherwise `403 plan_forbidden`. User/system actors pass.
- Repository (`storage/chat/plan.repository.ts`):
  - `updateWithVersionGuard(payload)` — `UPDATE ... WHERE id = @id AND version = @expectedVersion`; returns null when the guard rejects (0 changes).
- REST (`server/api/conversation-plan-controller.ts`, route pattern `/api/conversations/:id/plan[/activate|/revert]`, registered before the generic conversations controller in `create-server.ts`):
  - `GET /api/conversations/:id/plan` → `200 { ownerConversationId, participants:[{id,name}], plan }`; participant choices always come from the root owner and expose only id/name for the node-role dropdowns; `404 plan_not_found` when the tree has no plan.
  - `PUT /api/conversations/:id/plan` — body `{ doc, version? }`; `200 { ownerConversationId, plan, warnings }`.
  - `POST /api/conversations/:id/plan/activate` / `POST .../revert` → `200 { ownerConversationId, plan }`.

### 3. Contracts
- Plan doc JSON: `{ nodes: [{ id, title?, goal?, status?, depends_on?, branch?, spawned_conversation_id?, kind?, verify?, base_branch?, worker?, verifier?, result? }], edges?, history? }`.
  - Node enums: `status ∈ pending|doing|done|blocked` (default pending), `kind ∈ work|merge` (default work).
  - `branch`: named at graph-build time, checked out lazily at execution into per-node worktrees (see `dag-execution.md`).
  - `verify?` (D19): optional shell command; merge nodes run it inside the integration worktree before `done` is accepted.
  - `base_branch?` (D11): explicit checkout baseline; when set it must equal a parent node's branch (`plan_node_base_branch_mismatch`); nodes without parents must omit it (inherit the conversation branch).
  - `worker?` / `verifier?` (D28/D29): optional participant references represented as strings; execution resolves either canonical agent id or unique display name. Both are structural and locked while active. See `dag-execution.md` for defaults, ambiguity handling, and self-review enforcement.
  - `result?` (D23): ≤2000-char outcome summary, written back with status transitions; a transition to `done` without `result` produces a `plan_done_result_missing` **warning** (never blocks — manual POC-style status flips stay legal; the scheduler path always carries one).
  - `spawned_conversation_id`: bound by the scheduler via the system channel only; locked for all other writers while active.
  - `history?` (D18): append-only audit trail `[{ node_id, from, to, at, actor, reason? }]`, rolling-capped at 200 entries. **Server-owned**: a caller that omits the field inherits the stored entries; a caller that carries it must preserve the existing prefix exactly (append-only while active). Status transitions are auto-appended by the server with actor attribution (`user` / `agent:<id>` / `system`); caller-pre-recorded transitions are deduped on `(node_id, from, to)` so nothing double-writes.
- Ownership: exactly one plan per conversation tree (`UNIQUE(owner_conversation_id)`); child conversations read/write the root plan through origin-chain resolution. Never key plans by the requesting child id.
- Lifecycle state machine:
  - First write creates the plan as `draft` with `version = 1`.
  - `draft → active` via activate (user-only entry point; sets `activated_at`); `active → draft` via revert (doc preserved, including node status history; `activated_at` kept).
  - `done`/`archived` reject all writes with `409 plan_locked`.
- Write semantics by status:
  - `draft`: full-doc replace accepted after `validatePlanDoc`.
  - `active`: `validateStatusOnlyUpdate` diff — only node `status`/`result` may change and `history` may only grow by appending; adding/removing nodes or changing `title/goal/depends_on/branch/kind/verify/base_branch/worker/verifier/spawned_conversation_id` is rejected with `plan_locked_*` issues.
  - D16 fail-closed: on active plans, `pending → doing` while any transitive upstream is `blocked` is rejected with `409 plan_upstream_blocked` + `{ nodeId, blockedUpstreams[] }`. The check evaluates the incoming doc, so unblocking an upstream in the same write unblocks the downstream. `blocked → doing` retries are deliberately not gated (D12 retry flow needs them).
- Optimistic concurrency: updates require the caller's read version; mismatch → `409 plan_version_conflict`. First write (create) does not require a version. Every successful write bumps `version` by 1.
- `edges[]` consistency: when present, every edge must be backed by a `depends_on` entry and vice versa (`plan_edge_mismatch`); the derived edge set is authoritative.
- Merge nodes with in-degree < 2 produce a `plan_merge_indegree` **warning** (surfaced in `warnings[]`, never blocks the write).
- Every successful mutation (PUT/activate/revert) must broadcast SSE `conversation_plan_updated` with `{ conversationId, ownerConversationId, plan }` so other panels (including child conversations) refresh.
- Controllers stay thin: request parsing only; validation, origin resolution, and concurrency live in the store so the agent tool bridge reuses the exact same path.

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| `GET /plan` | conversation does not exist | `404 conversation_not_found` |
| `GET /plan` | tree has no plan | `404 plan_not_found` |
| `GET /plan` | called from a child conversation | `200`, root `ownerConversationId`, shared plan |
| `PUT /plan` | body not a JSON object / `doc` missing | `400 invalid_body` / `plan_doc_required` |
| `PUT /plan` | unknown body field | `400 Unknown plan field: <field>` |
| `PUT /plan` | duplicate node id | `422 plan_validation_failed` + `plan_node_id_duplicate` |
| `PUT /plan` | `depends_on` references unknown node | `422` + `plan_dependency_missing` |
| `PUT /plan` | node depends on itself | `422` + `plan_node_self_dependency` |
| `PUT /plan` | dependency cycle | `422` + `plan_cycle` (issue message includes the cycle path) |
| `PUT /plan` | bad enum (`status`/`kind`) | `422` + `plan_node_status_invalid` / `plan_node_kind_invalid` |
| `PUT /plan` | merge node in-degree < 2 | `200`, `warnings[]` contains `plan_merge_indegree` |
| `PUT /plan` | first write on a tree | creates `draft` plan, `version = 1` |
| `PUT /plan` | existing plan, version omitted or stale | `409 plan_version_conflict` (message states expected version) |
| `PUT /plan` | active plan, only node `status` changed | `200`, version bumped |
| `PUT /plan` | active plan, structural change | `409 plan_locked` + `plan_locked_node_added/removed/field_changed` |
| `PUT /plan` | done/archived plan | `409 plan_locked` |
| `PUT /plan` | active plan, `pending→doing` with blocked transitive upstream | `409 plan_upstream_blocked` + `{ nodeId, blockedUpstreams[] }` (D16) |
| `PUT /plan` | active plan, caller-mutated `history` prefix | `409 plan_locked` + `plan_locked_history_*` |
| `POST /activate` `/revert` | agent actor not root participant / from child conversation | `403 plan_forbidden` (D15) |
| `POST /activate` | no plan | `404 plan_not_found` |
| `POST /activate` | plan not in `draft` | `409 plan_not_activatable` |
| `POST /revert` | plan not in `active` | `409 plan_not_revertible` |
| origin resolution | lineage cycle | treated as unresolvable → `404 conversation_not_found` |

### 5. Good / Base / Bad Cases
- Good: child conversation PUTs a status-only update with the current version → root plan version bumps, `conversation_plan_updated` broadcast reaches both panels.
- Good: model submits a cyclic graph → `422` with `plan_cycle` and the cycle path; nothing is persisted; the model can self-repair and retry.
- Base: activate → revert round-trip preserves the doc exactly (node statuses gathered during active survive the revert).
- Bad: writing `spawned_conversation_id` from the model tool — the field is reserved for the spawn flow; models proposing it will pass validation but the link is only meaningful when created by the spawn UI/service.

### 6. Tests Required
- `tests/storage/chat-plan.test.js`: migration creates `chat_plans` + `branch` column (fresh DB, existing-DB upgrade via `ensureColumn`, lineage rebuild keeps the column, idempotent rerun); status CHECK and owner UNIQUE enforced.
- Store integration: child conversation resolves the root plan; version conflict → 409; lifecycle lock (active rejects structural edits, accepts status-only; revert reopens draft).
- `tests/http/conversation-plan-controller.test.js`: routing, 400 body validation, broadcast payload on each mutation.
- Assertion points: error `code` fields (not just HTTP status), `warnings` passthrough, version increments, `activated_at` set on activate only.

### 7. Wrong vs Correct
#### Wrong
```typescript
// Controller does its own cycle check and writes via planRepository directly,
// while the agent tool bridge calls the store — two validation paths drift.
```
#### Correct
```typescript
// All writes funnel through store.savePlanForConversation(...), which calls
// the shared lib/plan-dag.ts validators. Controller and tool bridge are thin.
const result = store.savePlanForConversation(conversationId, { doc, version });
broadcastEvent('conversation_plan_updated', { conversationId, ownerConversationId: result.ownerConversationId, plan: result.plan });
```
