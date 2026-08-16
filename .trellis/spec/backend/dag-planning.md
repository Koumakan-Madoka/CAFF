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
  - `derivePlanEdges(doc) → [{from, to}]` (edges are derived from `depends_on`; `edges[]` in the doc is optional but must match when present).
- Store (`lib/chat-app-store.ts`):
  - `resolvePlanOwnerConversation(conversationId)` — walks `origin_conversation_id` to the root; returns null on missing conversation or lineage cycle.
  - `getPlanForConversation(conversationId) → { ownerConversationId, plan | null }`
  - `savePlanForConversation(conversationId, { doc, version? }) → { ownerConversationId, plan, warnings }`
  - `activatePlanForConversation(conversationId)` / `revertPlanForConversation(conversationId)`
  - `createPlanError(statusCode, code, message, details)` — errors carry `{ statusCode, code, issues[] }`.
- Repository (`storage/chat/plan.repository.ts`):
  - `updateWithVersionGuard(payload)` — `UPDATE ... WHERE id = @id AND version = @expectedVersion`; returns null when the guard rejects (0 changes).
- REST (`server/api/conversation-plan-controller.ts`, route pattern `/api/conversations/:id/plan[/activate|/revert]`, registered before the generic conversations controller in `create-server.ts`):
  - `GET /api/conversations/:id/plan` → `200 { ownerConversationId, plan }`; `404 plan_not_found` when the tree has no plan.
  - `PUT /api/conversations/:id/plan` — body `{ doc, version? }`; `200 { ownerConversationId, plan, warnings }`.
  - `POST /api/conversations/:id/plan/activate` / `POST .../revert` → `200 { ownerConversationId, plan }`.

### 3. Contracts
- Plan doc JSON: `{ nodes: [{ id, title?, goal?, status?, depends_on?, branch?, spawned_conversation_id?, kind? }], edges? }`.
  - Node enums: `status ∈ pending|doing|done|blocked` (default pending), `kind ∈ work|merge` (default work).
  - `branch`: named at graph-build time, checked out lazily at execution; child node branches derive from the parent conversation branch. POC stores the name only — no git operations.
  - `spawned_conversation_id`: link to a bound child conversation; POC renders it read-only.
- Ownership: exactly one plan per conversation tree (`UNIQUE(owner_conversation_id)`); child conversations read/write the root plan through origin-chain resolution. Never key plans by the requesting child id.
- Lifecycle state machine:
  - First write creates the plan as `draft` with `version = 1`.
  - `draft → active` via activate (user-only entry point; sets `activated_at`); `active → draft` via revert (doc preserved, including node status history; `activated_at` kept).
  - `done`/`archived` reject all writes with `409 plan_locked`.
- Write semantics by status:
  - `draft`: full-doc replace accepted after `validatePlanDoc`.
  - `active`: `validateStatusOnlyUpdate` diff — only node `status` may change; adding/removing nodes or changing `title/goal/depends_on/branch/kind/spawned_conversation_id` is rejected with `plan_locked_*` issues.
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
