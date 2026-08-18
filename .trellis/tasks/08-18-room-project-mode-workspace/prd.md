---
feature_ids:
  - room-project-mode-workspace
topics:
  - conversation
  - project
  - mode
  - git-worktree
  - runtime
  - acceptance
doc_kind: prd
created: 2026-08-18
---

# Room project, mode, and workspace

## Goal

Make the product concept match the domain model: a Room is the existing Conversation entity. Every newly created Room has one immutable Project and one immutable Mode; the Room may later bind exactly one generated Git branch/worktree before implementation begins. Runtime execution uses and displays that Room worktree when bound. Direct/Goal/DAG remains a separate, model-driven orchestration concern. Remove the legacy game and Skill Test product/runtime paths and preserve auditable acceptance evidence.

## Confirmed terminology

- **Room = Conversation**: one message stream with multiple Agent participants. No separate Room table or “join existing Room” flow.
- **Project**: registered repository selected when the Room is created; immutable afterward.
- **Mode**: Skill-backed Room configuration selected before creation; immutable afterward.
- **Orchestration**: model-driven `direct | goal | dag`, derived from the Room’s live Goal/DAG state and injected into future turns. It is not a Mode and is not selected in the create form.
- **Workspace binding**: the same Room’s optional generated `room/<conversation-id-short>-<slug>` branch plus physical worktree. It is created after clarification, immediately before development, with explicit confirmation.
- **Acceptance record**: candidate/accepted SHA evidence owned by the Room, not by an Agent message.

## Requirements

### R1 — Create Room

- The UI says “Room”, not “new conversation/chat”, and submits title, `projectScopeId`, `modeId`, and participants.
- `POST /api/conversations` rejects missing/unknown Project, missing/unknown Mode, unknown fields, and empty participant rosters.
- Project and Mode are written in the same create transaction as the Room and participant roster.
- The Mode’s effective Skills are merged into the explicit participant roster.
- Project and Mode cannot be changed after creation. Do not retain a normal product flow for `null -> project` or Mode switching.
- Internal historical/test compatibility may read the legacy `type` database column during migration, but new public payloads use `modeId`.

### R2 — Workspace preview and binding

- `GET /api/conversations/:id/workspace/preview` returns the server-derived Project repository, baseline `develop` SHA, branch, and worktree path without changing Git or SQLite state.
- `POST /api/conversations/:id/workspace` accepts confirmation only; it does not accept an arbitrary branch/path/base.
- Branch is `room/<first-eight-conversation-id>-<ascii-slug>` and worktree is server-derived from the Project repository.
- Binding is one-time and idempotent. A bound Room cannot switch branch/worktree.
- Existing wrong-branch, dirty, occupied, missing-`develop`, or non-Git targets fail closed and are not cleaned/reset automatically.
- If Git creation succeeds but persistence fails, compensate only artifacts created by that request; never remove pre-existing branches/worktrees.
- Persist `branch`, absolute `worktreePath`, `workspaceBaseSha`, and binding timestamp.

### R3 — Runtime context and orchestration

- A bound ordinary Room executes with cwd equal to its persisted worktree. An unbound Room executes against its immutable Project repository for clarification/read-only work.
- Prompt workspace context includes Project id/path, Mode id/name, branch/worktree state, and current orchestration.
- Orchestration is derived: active/draft DAG plan => `dag`; otherwise active/pending Goal => `goal`; otherwise `direct`. Existing Goal/plan histories remain the audit source.
- Model guidance says orchestration is autonomous and may evolve via existing Goal/DAG tools; it must not imply that Mode changed.
- DAG child worktrees continue to override the ordinary Room worktree for DAG node execution.

### R4 — Legacy destructive retirement

- Do not seed or expose builtin Werewolf, Who Is Undercover, or Skill Test modes.
- Delete legacy game/Skill Test Room data and associated state during migration; the user explicitly accepted a destructive change.
- Remove their create options, panels, dedicated APIs/controllers/services, runtime prompt branches, static pages/assets, and focused tests.
- Preserve the generic Mode + Skill mechanism and custom Skill-backed Modes.
- Remove only legacy product-specific Skills/references that are tracked by this repository; do not mutate unrelated local sandbox state.

### R5 — Acceptance evidence

- A Room can own multiple immutable candidate acceptance records.
- Minimum fields: `candidateSha`, room branch, relevant merge commits, automated checks, manual checks/result, known limitations, environment summary, creator, timestamps, and optional `acceptedSha`/accepted timestamp.
- Candidate creation and acceptance are separate API actions. Acceptance requires explicit action and `acceptedSha === candidateSha`.
- Existing records remain append-only except the one-way pending/rejected -> accepted/rejected decision transition; a new SHA creates a new record.

## Non-goals

- No separate Room table, Room sharing/joining, or multi-Conversation Room abstraction.
- No write lease, concurrency lock, branch protection implementation, or special main/develop runtime restriction.
- No arbitrary branch picker, branch rename, worktree relocation, cleanup/delete UI, push, merge, service startup, or deployment.
- No Mode switching after Room creation.
- No Direct/Goal/DAG selector in Room creation.
- No compatibility execution for retired game/Skill Test Rooms.

## Cross-layer contracts

### Create request

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

Success: `201` with `conversation.modeId`, immutable `projectScopeId`, and `workspace` (`null` until bound).

### Workspace preview

`GET /api/conversations/:id/workspace/preview`

```json
{
  "preview": {
    "conversationId": "...",
    "projectScopeId": "...",
    "repositoryPath": "...",
    "baseBranch": "develop",
    "baseSha": "40-hex",
    "branch": "room/12345678-room-title",
    "worktreePath": "absolute path",
    "alreadyBound": false
  }
}
```

### Workspace confirmation

`POST /api/conversations/:id/workspace` with `{ "confirm": true }`.

Success: `201` for a newly created binding or `200` for an idempotent existing binding.

### Acceptance record

- `GET /api/conversations/:id/acceptance-records`
- `POST /api/conversations/:id/acceptance-records` creates a candidate record.
- `POST /api/conversations/:id/acceptance-records/:recordId/decision` with `{ "decision": "accepted" | "rejected", "acceptedSha"?: "...", "note"?: "..." }`.

## Validation and error matrix

| Case | Result |
|---|---|
| Create omits Project/Mode | `400 room_project_required` / `room_mode_required`; no rows |
| Project or Mode does not exist | `404 room_project_not_found` / `room_mode_not_found`; no rows |
| Update attempts Project/Mode change | `409 room_project_immutable` / `room_mode_immutable` |
| Preview before binding | Read-only deterministic preview |
| Project path is not Git or lacks local `develop` | `409 room_workspace_repository_invalid` / `room_workspace_base_missing` |
| Branch/path already belongs to another context | `409 room_workspace_branch_exists` / `room_workspace_path_occupied` |
| Confirm repeated after success | Return existing exact binding, no Git mutation |
| Git worktree creation fails | `409 room_workspace_create_failed`; no binding row |
| Persistence fails after Git creation | Remove only request-created worktree/branch; surface `500` |
| Runtime Room bound | cwd and prompt identify persisted worktree |
| Runtime Room unbound | cwd is immutable Project repo; prompt says workspace unbound |
| Candidate SHA malformed or evidence absent | `400 acceptance_record_invalid` |
| Accept with SHA different from candidate | `409 acceptance_sha_mismatch` |
| Accept already decided record | idempotent same decision or `409 acceptance_record_decided` |
| Legacy game/Skill Test rows | Deleted by destructive migration; modes/routes absent |

## Good / base / bad cases

- **Good**: create Room with a registered Project/custom Skill-backed Mode, clarify, preview deterministic workspace, confirm once, execute in that worktree, and append acceptance evidence.
- **Base**: create Room and discuss indefinitely without workspace binding; prompt clearly reports unbound workspace and direct orchestration.
- **Bad**: accept arbitrary client branch/path, silently switch Project/Mode, infer cwd from global active Project after binding, or leave Git artifacts after failed persistence.

## Acceptance criteria

- [ ] New Room form requires and submits Project and fixed Mode; legacy types are absent.
- [ ] Backend contract tests prove create validation, immutable context, and Skill merge.
- [ ] Workspace tests prove preview is read-only, confirmation creates the expected branch/worktree, repeat is idempotent, and conflicts/rollback fail closed.
- [ ] Runtime tests prove cwd precedence: DAG node > Room worktree > Room Project repository.
- [ ] Prompt tests prove Mode and orchestration are distinct and injected.
- [ ] Migration tests prove legacy game/Skill Test modes and Rooms are removed without deleting ordinary/custom Mode Rooms.
- [ ] Acceptance storage/API tests cover candidate, rejection, accepted SHA equality, idempotency, and append-only records.
- [ ] Legacy game/Skill Test routes/assets and startup wiring are removed.
- [ ] Applicable targeted tests, `npm run check`, `npm run typecheck`, `npm run build`, and `git diff --check` pass.
- [ ] Exact HEAD receives independent non-author review before any merge request.

## Constraints

- Branch/worktree: `room/b6fae6e6-room-project-mode-workspace` at base `develop@c305adf1423fb3125bb65c2a88b48df5a1e4e952`.
- Do not push, merge, start services, deploy, or touch the main worktree’s untracked files without separate authorization.
- No self-review; review must be performed by another participant/model family.
