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
  - `deriveRoomWorkspaceIdentity(conversation, project, { branchName })`
  - `previewRoomWorkspace({ conversation, project, branchName })`
  - `bindRoomWorkspace({ conversation, project, branchName })`
  - `previewRoomWorkspaceRename({ conversation, project, branchName, pendingOperation })`
  - `renameAndPersistRoomWorkspace({ store, conversation, project, branchName, hasActiveExecution, expectedFingerprint, fingerprintOf })`
  - `rollbackCreatedRoomWorkspace(binding)`
- Store CAS: `bindConversationWorkspace(conversationId, { branch, worktreePath, workspaceBaseSha, workspaceBoundAt })` and `renameConversationWorkspaceBranch(conversationId, { oldBranch, newBranch, updatedAt })`
- Durable rename intent: `chat_workspace_operations` rows (create/complete/fail via `createWorkspaceOperation`, `getPendingWorkspaceOperation`, `getWorkspaceOperation`, `completeWorkspaceOperation`, `failWorkspaceOperation`) record the authorized old→new branch pair and card fingerprint before any Git mutation (write-ahead). `replacePendingWorkspaceOperation(operation, errorCode)` atomically supersedes any stale pending row when a new operation is recorded, and `renameConversationWorkspaceBranchAndCompleteOperation(conversationId, rename, operationId)` commits the branch CAS and the journal close-out in ONE SQLite transaction, so a close-out failure can never split the binding from the journal.
- Active-execution probe: `hasActiveConversationTurn(conversationId, { excludeMessageId })` counts non-terminal (`queued`/`running`/`streaming`) assistant messages, optionally excluding a single assistant message — never the whole turn. Only the non-UI fallback uses the exclusion (it excludes the calling invocation's own assistant message, its own in-flight tool call). The UI approval path checks every active message INCLUDING the card issuer: after issuing a card the agent may still run tools on the workspace, so a rename may execute only in a fully idle Room; the transient block keeps the card pending so the user retries the same card once the execution finishes.

Persisted Conversation fields:

- `branch TEXT NULL`
- `worktree_path TEXT NULL`
- `workspace_base_sha TEXT NULL`
- `workspace_bound_at TEXT NULL`

- Model-visible Room workspace capability facades are defined in `server/domain/runtime/pi-capability-bridge.ts` and wired by `server/domain/runtime/agent-tool-bridge.ts`.
- `room_workspace_preview` accepts `{}` or `{ "branchName": "full/branch-name" }` and is read-only; when unbound it issues a short-lived authorization-card request. The UI lists pending requests at `GET /api/conversations/:conversationId/workspace/authorizations` and renders a system card; user decisions use a one-time token plus preview fingerprint at `POST /api/conversations/:conversationId/workspace/authorizations/:authorizationId/decision`. The normal UI path performs binding directly after user approval, so the model does not need a second bind turn.
- `room_workspace_bind` remains a non-UI fallback and accepts `{ "confirm": true }` with an optional `branchName`.
- `room_workspace_rename_preview` requires `{ "branchName": "new/full-name" }` and is read-only; on a bound Room it issues a rename authorization card showing `branch → newBranch`. `room_workspace_rename_bind` is the non-UI fallback and requires `{ "confirm": true, "branchName": "new/full-name" }`.
- The authorization fingerprint binds the operation kind (`bind`/`rename`) and the exact branch name(s); bind previews also record `requestedBranchName` so approval replays the exact naming plan (custom name + stable directory mode, or automatic naming). Cards also record the `sourceMessageId` of the assistant message that issued them. Issuing a new plan supersedes every still-pending card of the Room (`superseded`), so an old card can never execute a replaced plan. Both capabilities derive Room identity from the authenticated invocation principal and never accept a conversation id, path, repository, or base ref from the model. A transient execution failure (`room_workspace_execution_active`, blocked by another execution with no Git/DB mutation yet) returns the card to `pending` so the user can retry the same card; any other execution failure marks it `failed` terminally, the failure is broadcast as a `room_workspace_authorization_updated` event, and a later decide on the terminal card reports `room_workspace_authorization_decided` with the original `errorCode` and a remediation hint.
- Git creation and Conversation CAS persistence are shared through `bindAndPersistRoomWorkspace(...)`; persistence failure rolls back only artifacts created by that request. Rename previews are read-only and never blocked by active executions. Rename execution checks the Room is fully idle on the approval path (the card issuer included; a transient block keeps the card pending for retry) and excludes only the caller's own message on the non-UI fallback, records a durable `chat_workspace_operations` row (superseding any stale pending row), executes `git branch -m` inside the bound worktree, then applies the branch CAS and the journal close-out in one SQLite transaction; a failure compensates the Git rename and fails the operation row, and if the Git rollback itself fails the row stays PENDING as the recovery handle (`room_workspace_compensation_failed`). Every rejection condition (name unchanged, conflict, stale fingerprint, active execution) runs before any Git or DB mutation. A crash between the Git rename and the DB commit leaves a mismatch that can only be resumed through the recorded operation: ownership is verified first, the requested name must match the record, and a card-based completion requires the card fingerprint to equal a freshly recomputed resume-preview fingerprint — this re-authorization protocol also covers fallback-originated records whose stored fingerprint is null (re-preview after restart issues a fresh executable card). Arbitrary external renames without a record fail with `room_workspace_state_mismatch` for manual reconciliation.


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
- Default generated branch: `room/<first-8-alphanumeric-conversation-id>-<ascii-title-slug>`; default generated path: `<repository-parent>/worktrees/room/<branch-suffix>`. Omitting `branchName` keeps this behavior exactly.
- A custom `branchName` is a complete branch name (no enforced `room/` prefix), validated **literally** (max 200 chars): the full ref `refs/heads/<name>` must pass `git check-ref-format`, and reflog expansion expressions (`@{-n}`, any `@{` sequence), a lone `@`, `HEAD`, and leading `-` are rejected. `git check-ref-format --branch` is deliberately NOT used because it expands `@{-n}` to a previously checked-out branch, which would let the authorized name differ from the created one. Custom-name bindings use the stable directory `<repository-parent>/worktrees/room/<first-8-alphanumeric-conversation-id>` so the path never depends on the (changeable) branch name. Room ownership is recognized from the database binding plus actual worktree verification, never from a branch-name prefix.
- Preview is deterministic and read-only: it resolves the Project Git root and `develop` SHA but creates no branch, directory, worktree, or database binding.
- Confirmation accepts no arbitrary base, repository, or path. The branch name is the only client-proposable identity and is always revalidated server-side.
- Binding is one-time and idempotent. A complete existing binding is returned as reused; a partial binding fails closed. A bound Room previewed with a different `branchName` fails with `409 room_workspace_already_bound` and must use the rename flow.
- Existing branch (including a matching remote-tracking ref) or occupied target path is a conflict, never an invitation to attach, reset, clean, or delete it.
- Git worktree creation occurs before the storage CAS. If persistence fails, rollback removes only the worktree and branch created by that request. Pre-existing artifacts must never be removed.
- Rename (`git branch -m`) never moves the worktree directory and never changes HEAD, file contents, or the baseline. It requires the Git worktree state to match the binding record (or a resumable recorded operation), an idle Room at execution time, a conflict-free target name, and a verifiably unpublished branch: an upstream association in branch config (`branch.<name>.remote` + `.merge`, even when the tracking ref is missing), a matching remote-tracking ref, or any unverifiable query (config/refs/remote enumeration/`git ls-remote`) blocks the rename with a clear error. Remote probes are read-only; remotes are never modified.

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
| Custom branch name invalid/empty | `400 room_workspace_branch_name_invalid` / `400 room_workspace_branch_name_required`; no Git or DB mutation |
| Bound Room previewed with a different branch name | `409 room_workspace_already_bound`; use rename |
| Generated path exists | `409 room_workspace_path_occupied`; do not clean/delete |
| Confirm body is not `{ confirm: true }` intent | `400 room_workspace_confirmation_required` |
| Complete binding already exists | `200`, exact binding returned, no Git mutation |
| Git creation fails | `409 room_workspace_create_failed`; no DB binding |
| DB bind loses CAS/fails after Git creation | error surfaces; remove only request-created worktree/branch |
| Rename on an unbound Room | `409 room_workspace_not_bound` |
| Rename target unchanged/invalid | `400 room_workspace_branch_name_unchanged` / `400 room_workspace_branch_name_invalid` |
| Rename target exists locally or as remote-tracking ref | `409 room_workspace_branch_exists` |
| Worktree missing, unregistered, or on another branch | `409 room_workspace_worktree_missing` / `room_workspace_worktree_mismatch` / `room_workspace_state_mismatch`; mismatch without a recorded operation requires manual reconciliation |
| Rename target does not match the recorded pending operation | `409 room_workspace_operation_pending`; retry with the recorded target |
| Rename during an active execution | `409 room_workspace_execution_active`; checked at execution time, never at read-only preview. The approval path checks every active message including the card issuer; the block keeps the card pending so the user retries the same card once idle (the UI shows a wait-and-retry hint) |
| Branch has upstream config or remote-tracking ref | `409 room_workspace_branch_published`; remote untouched |
| Upstream config/refs/remote state unverifiable | `409 room_workspace_remote_state_unknown`; remote untouched |
| Rename authorization fingerprint stale | `409 room_workspace_authorization_stale`; no Git or DB mutation |
| New plan issued while a card is pending | old card becomes `superseded`; deciding it returns `409 room_workspace_authorization_decided` with no side effects |
| DB rename CAS or journal close-out fails after Git rename | error surfaces; the CAS and close-out roll back atomically, the Git rename is compensated back to the old name, and the operation row is marked failed |
| Git rollback of a failed rename also fails | `500 room_workspace_compensation_failed`; the operation row stays `pending` as the recovery handle (Git new / DB old) |
| Crash between Git rename and DB commit | public preview exposes the recorded resumable plan; approval requires a fresh resume-preview fingerprint and completes the DB CAS + journal close-out atomically |
| Crash after write-ahead journal but before Git rename | rejected requests (stale fingerprint, active execution, conflict, unchanged name) leave the journal and all state untouched; the next validated rename supersedes the stale row atomically |
| Candidate SHA is not full Git SHA, or evidence arrays absent | `400 acceptance_record_invalid` |
| Decision is neither accepted nor rejected | `400 acceptance_decision_invalid` |
| Accepted SHA differs from candidate | `409 acceptance_sha_mismatch` |
| Conflicting second decision | `409 acceptance_record_decided` |
| Legacy game Room is parent/child or has deliveries | Delete full retired subtree and dependent delivery rows without violating FK/append-only guards |

### 5. Good / Base / Bad Cases

- **Good:** create with a registered Project and custom Skill-backed Mode; preview; explicitly confirm; execute in the generated worktree; append automated/manual evidence; accept the exact candidate SHA.
- **Base:** create and clarify in the Project repository without binding a worktree. Prompt says the workspace is unbound and orchestration is direct until Goal/DAG state exists.
- **Base:** repeat workspace confirmation or the same acceptance decision and receive the canonical existing result without duplicate mutation.
- **Bad:** accept client-provided path/base fields, infer a bound Room cwd from the global active Project, mutate `type` to switch Mode, reuse an existing worktree silently, store acceptance only in replaceable Conversation metadata, recognize Room ownership from a branch-name prefix, move the worktree directory on rename, or rename a branch with an upstream/remote-tracking ref or an unverifiable remote.
- **Bad:** delete a legacy parent Room before children/delivery records, or permanently remove the append-only guard merely to make migration pass.

### 6. Tests Required

- `tests/http/room-conversation-create.test.js`: required Project/Mode validation happens before persistence.
- `tests/runtime/pi-capability-bridge.test.js`: facade schemas, principal-scoped preview/bind, explicit confirmation, safe projection, and rollback-scoped wiring.
- `tests/runtime/turn-orchestrator.test.js`: prompt advertises preview-first and explicit-confirmation workspace flow.
- `tests/ui/new-conversation-dialog.test.js` and `tests/runtime/new-conversation-dialog.test.js`: Room form requires/submits Project + Mode and has no legacy game selector.
- `tests/runtime/room-workspace.test.js`: preview is read-only, confirmation uses `develop`, generated branch/path are deterministic, and existing-branch conflict fails closed.
- `tests/runtime/room-workspace-rename.test.js`: custom full branch names bind verbatim with a stable directory; invalid names/conflicts have no side effects; rename keeps directory/HEAD/files/baseline while updating Git and the store; upstream config (even without a tracking ref), partial config, remote-tracking refs, and unverifiable remotes are blocked; persistence failure, lost CAS and journal close-out failure compensate the Git rename atomically; a failed Git rollback keeps the operation row pending as the recovery handle; a journaled-but-never-executed operation is never mutated by rejected requests (stale fingerprint, active execution, conflict, unchanged name) and is superseded by the next validated rename; interrupted renames resume only through their recorded operation with the fresh resume-preview fingerprint verified before any DB write, including fallback-originated records with no stored fingerprint; stale fingerprints change nothing.
- `tests/runtime/room-workspace-bridge.test.js`: end-to-end bridge flows — custom-name and default cards replay the exact approved plan into Git/DB; rename approval requires a fully idle Room (a block while the issuer is still streaming leaves zero Git/DB/journal side effects, keeps the card pending, broadcasts the failure, and the SAME card succeeds once idle); a peer execution blocks approval the same way; the non-UI fallback excludes only the caller's own assistant message so another agent in the same turn still blocks; an interrupted rename resumes through the public preview-and-approve entry; a fallback-originated interruption recovers after a real store restart and bridge rebuild via a freshly issued resume card; a newer plan supersedes the pending card.
- `tests/runtime/room-workspace-capability.test.js`: `branchName` validation on preview/bind/rename facades, rename result projection, and optional rename wiring.
- `tests/runtime/room-workspace-authorization.test.js`: bound Rooms cannot issue bind cards but can issue rename cards; fingerprints bind kind and target branch name; a newer plan supersedes pending cards and old cards execute nothing; a transient execution-active failure returns the card to pending and the same card re-decides, while a non-retryable failure burns the card terminally and the decided error carries the original cause.
- `tests/storage/conversation-workspace-rename.test.js`: branch rename CAS keeps the rest of the binding, stale writers lose, the branch CAS and journal close-out commit atomically (a lost CAS or unknown operation id rolls both back), replacement supersedes stale pending rows atomically, active-execution detection follows non-terminal assistant messages with per-message caller exclusion, and workspace operation records persist the authorized rename intent.
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
