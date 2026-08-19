---
feature_ids:
  - room-project-mode-workspace
topics:
  - conversation
  - project
  - mode
  - git-worktree
  - acceptance
doc_kind: code-spec
created: 2026-08-18
---

# Room Context, Workspace, and Acceptance

## Scenario: Project-bound Room lifecycle

### 1. Scope / Trigger

Use this contract when changing Room creation, Project/Mode binding, ordinary Room Git worktrees, execution cwd/prompt context, legacy product-mode retirement, or acceptance evidence.

A product **Room is the existing Conversation entity**. Do not add a second Room table or a Room-to-Conversation join. Project and Mode are creation-time identity; Direct/Goal/DAG is derived runtime orchestration; a Git workspace is an optional one-time binding on the same Conversation.

Primary mirrored paths:

- UI: `public/chat/new-conversation-dialog.js`, `public/index.html`, `public/app.js`
- HTTP: `server/api/conversations-controller.ts`
- Workspace domain: `server/domain/conversation/room-workspace.ts`
- Storage: `storage/sqlite/migrations.ts`, `storage/chat/conversation.repository.ts`, `lib/chat-app-store.ts`
- Runtime: `server/app/create-server.ts`, `server/domain/conversation/turn/agent-executor.ts`, `server/domain/conversation/turn/agent-prompt.ts`
- Mode retirement: `lib/mode-store.ts`

### 2. Signatures

#### Create Room

`POST /api/conversations`

Exact request fields (unknown fields fail):

```json
{
  "title": "Room title",
  "projectScopeId": "registered-project-id",
  "modeId": "registered-mode-id",
  "participants": [
    {
      "agentId": "role-family-gpt",
      "modelProfileId": null,
      "conversationSkillIds": []
    }
  ]
}
```

The public payload uses `modeId`. SQLite currently persists that identity in the legacy `chat_conversations.type` column and projects it back as both `modeId` and the compatibility `type`; do not expose `type` in new create/update contracts.

#### Preview and bind workspace

- `GET /api/conversations/:conversationId/workspace/preview`
- `POST /api/conversations/:conversationId/workspace` with exact confirmation intent `{ "confirm": true }`
- Domain helpers:
  - `deriveRoomWorkspaceIdentity(conversation, project)`
  - `previewRoomWorkspace({ conversation, project })`
  - `bindRoomWorkspace({ conversation, project })`
  - `rollbackCreatedRoomWorkspace(binding)`
- Store CAS: `bindConversationWorkspace(conversationId, { branch, worktreePath, workspaceBaseSha, workspaceBoundAt })`

Persisted Conversation fields:

- `branch TEXT NULL`
- `worktree_path TEXT NULL`
- `workspace_base_sha TEXT NULL`
- `workspace_bound_at TEXT NULL`

- Model-visible Room workspace capability facades are defined in `server/domain/runtime/pi-capability-bridge.ts` and wired by `server/domain/runtime/agent-tool-bridge.ts`.
- `room_workspace_preview` accepts `{}` and is read-only; when unbound it issues a short-lived authorization-card request. The UI lists pending requests at `GET /api/conversations/:conversationId/workspace/authorizations` and renders a system card; user decisions use a one-time token plus preview fingerprint at `POST /api/conversations/:conversationId/workspace/authorizations/:authorizationId/decision`. The normal UI path performs binding directly after user approval, so the model does not need a second bind turn.
- `room_workspace_bind` remains a non-UI fallback and accepts `{ confirm: true }` only. Both capabilities derive Room identity from the authenticated invocation principal and never accept a conversation id, branch, path, repository, or base ref from the model.
- Git creation and Conversation CAS persistence are shared through `bindAndPersistRoomWorkspace(...)`; persistence failure rolls back only artifacts created by that request.


- `GET /api/conversations/:conversationId/acceptance-records`
- `POST /api/conversations/:conversationId/acceptance-records`
- `POST /api/conversations/:conversationId/acceptance-records/:recordId/decision`

Candidate request fields:

```json
{
  "candidateSha": "40-character-lowercase-git-sha",
  "mergeCommits": [],
  "automatedChecks": [],
  "manualChecks": [],
  "knownLimitations": [],
  "environment": {},
  "createdBy": "operator"
}
```

Decision request:

```json
{ "decision": "accepted", "acceptedSha": "same-as-candidateSha", "note": "manual approval" }
```

Storage is `chat_acceptance_records`; records are Room-owned through `conversation_id`.

### 3. Contracts

#### Room identity and immutability

- New external Rooms require a registered Project, an existing Mode, and at least one valid participant before any Room row is persisted.
- Project and Mode are written with the Room and participant roster in the same create transaction.
- A Mode's effective Skill IDs are merged into each participant's explicit conversation Skills during creation.
- Product UI does not offer Project or Mode switching. Generic Room update rejects any `projectScopeId`, `modeId`, or `type` field with `409 room_context_immutable`.
- The legacy `/project-scope` endpoint may remain for old unbound rows and internal compatibility, but it is not part of the normal new-Room flow. It must never switch one non-empty Project id to another.
- Spawned child Rooms inherit the source Room's immutable Mode and must use the same Project permission boundary.

#### Workspace identity and mutation

- Baseline is the local `develop` branch. Current MVP intentionally has no project-level baseline configuration.
- Generated branch: `room/<first-8-alphanumeric-conversation-id>-<ascii-title-slug>`.
- Generated path: `<repository-parent>/worktrees/room/<branch-suffix>`.
- Preview is deterministic and read-only: it resolves the Project Git root and `develop` SHA but creates no branch, directory, worktree, or database binding.
- Confirmation accepts no arbitrary base, branch, repository, or path. All identity is server-derived.
- Binding is one-time and idempotent. A complete existing binding is returned as reused; a partial binding fails closed.
- Existing branch or occupied target path is a conflict, never an invitation to attach, reset, clean, or delete it.
- Git worktree creation occurs before the storage CAS. If persistence fails, rollback removes only the worktree and branch created by that request. Pre-existing artifacts must never be removed.

#### Runtime cwd and prompt

Cwd precedence is:

1. DAG node worktree resolved by the DAG scheduler.
2. Bound ordinary Room `worktreePath`.
3. Immutable Room Project repository path.
4. Process-wide active Project fallback for legacy/internal contexts only.

The prompt workspace section contains Project id/path, fixed Mode id/name, branch, worktree, and derived orchestration. An unbound Room reports `[unbound]` worktree. There is intentionally no server-level write lock or read-only tool gate for an unbound Room.

Orchestration is derived on every turn and is not stored as Mode:

- `dag`: plan status is `draft` or `active`.
- `goal`: otherwise session Goal status is `active`, `pending`, or `paused`.
- `direct`: otherwise.

Model guidance may evolve Goal/DAG state through the existing governance tools, but must not claim that this changes the Room's Mode.

#### Acceptance evidence state machine

- Candidate creation appends a new immutable evidence row with status `pending`.
- Decision uses a compare-and-set update restricted to `status = 'pending'`.
- Legal first decisions are `pending -> accepted` and `pending -> rejected`.
- Accept requires `acceptedSha === candidateSha`; the SQLite CHECK repeats this invariant.
- Replaying the same already-recorded decision is idempotent at HTTP level. A conflicting second decision returns `409`.
- A new candidate SHA creates another record; it never rewrites prior evidence.

#### Destructive legacy retirement

- Werewolf, Who Is Undercover, and Skill Test are not seeded or exposed as product Modes.
- `ModeStore` retirement deletes legacy Room subtrees depth-first, including dependent cross-conversation delivery events/deliveries, then removes retired Mode rows and legacy conversation Skill IDs.
- When append-only delivery delete triggers block the authorized destructive migration, drop and recreate only the matching delete guard inside the same SQLite transaction. Keep the recreated trigger name, timing, and error text aligned with `storage/sqlite/migrations.ts`.
- Generic custom Mode + Skill behavior remains supported.
- Historical `agentDir` game JSON files are not removed. They have no remaining execution/API/UI entry point and are an accepted filesystem residue.

### 4. Validation & Error Matrix

| Operation / condition | Required result |
| --- | --- |
| Create omits Project or Mode | `400 room_project_required` / `400 room_mode_required`; no Room rows |
| Project or Mode id is unknown | `404 room_project_not_found` / `404 room_mode_not_found`; no Room rows |
| Create has unknown field | `400 room_unknown_field` |
| Create has invalid/empty participants | Existing participant validation error; no partial Room |
| Update carries Project/Mode/type | `409 room_context_immutable` |
| Preview Project does not match Room | `409 room_workspace_project_mismatch` |
| Project path missing/not Git | `409 room_workspace_repository_invalid` |
| Local `develop` missing | `409 room_workspace_base_missing` |
| Generated branch exists | `409 room_workspace_branch_exists`; do not attach/delete |
| Generated path exists | `409 room_workspace_path_occupied`; do not clean/delete |
| Confirm body is not `{ confirm: true }` intent | `400 room_workspace_confirmation_required` |
| Complete binding already exists | `200`, exact binding returned, no Git mutation |
| Git creation fails | `409 room_workspace_create_failed`; no DB binding |
| DB bind loses CAS/fails after Git creation | error surfaces; remove only request-created worktree/branch |
| Candidate SHA is not full Git SHA, or evidence arrays absent | `400 acceptance_record_invalid` |
| Decision is neither accepted nor rejected | `400 acceptance_decision_invalid` |
| Accepted SHA differs from candidate | `409 acceptance_sha_mismatch` |
| Conflicting second decision | `409 acceptance_record_decided` |
| Legacy game Room is parent/child or has deliveries | Delete full retired subtree and dependent delivery rows without violating FK/append-only guards |

### 5. Good / Base / Bad Cases

- **Good:** create with a registered Project and custom Skill-backed Mode; preview; explicitly confirm; execute in the generated worktree; append automated/manual evidence; accept the exact candidate SHA.
- **Base:** create and clarify in the Project repository without binding a worktree. Prompt says the workspace is unbound and orchestration is direct until Goal/DAG state exists.
- **Base:** repeat workspace confirmation or the same acceptance decision and receive the canonical existing result without duplicate mutation.
- **Bad:** accept client-provided branch/path/base fields, infer a bound Room cwd from the global active Project, mutate `type` to switch Mode, reuse an existing worktree silently, or store acceptance only in replaceable Conversation metadata.
- **Bad:** delete a legacy parent Room before children/delivery records, or permanently remove the append-only guard merely to make migration pass.

### 6. Tests Required

- `tests/http/room-conversation-create.test.js`: required Project/Mode validation happens before persistence.
- `tests/runtime/pi-capability-bridge.test.js`: facade schemas, principal-scoped preview/bind, explicit confirmation, safe projection, and rollback-scoped wiring.
- `tests/runtime/turn-orchestrator.test.js`: prompt advertises preview-first and explicit-confirmation workspace flow.
- `tests/ui/new-conversation-dialog.test.js` and `tests/runtime/new-conversation-dialog.test.js`: Room form requires/submits Project + Mode and has no legacy game selector.
- `tests/runtime/room-workspace.test.js`: preview is read-only, confirmation uses `develop`, generated branch/path are deterministic, and existing-branch conflict fails closed.
- `tests/storage/chat-store.test.js`: acceptance rows append, candidate-SHA equality is DB-enforced, and one-way decision CAS rejects a second mutation.
- `tests/runtime/turn-orchestrator.test.js`: prompt separates fixed Mode from derived Direct/Goal/DAG and cwd precedence remains DAG > Room > Project.
- `tests/smoke/mode-store.test.js`: destructive retirement covers multi-level lineage, orphan retired Rooms, cross-conversation delivery events/deliveries, healthy custom Rooms, and trigger recreation.
- `tests/runtime/skill-tests-removal-guards.test.js`: legacy product/runtime files and identifiers cannot return.
- Both new Room contract tests must remain wired into an executed npm script (`test:fast`), not only exist as standalone files.
- Required quality evidence: `npm run test:fast`, `npm run test:smoke`, `npm run typecheck`, `npm run check`, `npm run build`, and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```typescript
// Client chooses arbitrary Git state and the controller trusts it.
bindWorkspace({
  branch: body.branch,
  worktreePath: body.worktreePath,
  base: body.base,
});
```

#### Correct

```typescript
// The client confirms intent only. Project + Room identity derive Git state.
if (!body || body.confirm !== true) {
  throw roomCreationError(400, 'room_workspace_confirmation_required', 'confirm=true is required', 'confirm');
}
const binding = bindRoomWorkspace({ conversation, project });
store.bindConversationWorkspace(conversation.id, {
  branch: binding.branch,
  worktreePath: binding.worktreePath,
  workspaceBaseSha: binding.baseSha,
  workspaceBoundAt: new Date().toISOString(),
});
```

#### Wrong

```typescript
// Mode and orchestration are treated as one user-switchable selector.
conversation.type = body.directGoalOrDag;
```

#### Correct

```typescript
// Mode is immutable Room configuration; orchestration is derived per turn.
const orchestrationMode = activePlan
  ? 'dag'
  : activeGoal
    ? 'goal'
    : 'direct';
```
