---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, roles, participants, conversations, feishu, games, accessibility]
doc_kind: review-request
created: 2026-08-03
---

# Review Request: Model-family Explicit Participant Policies

Review-Target-ID: feat-model-family-roles-implementation
Branch: feat/model-family-roles-implementation
Exact review SHA: `02e58cc`
Diff: `01d134f..02e58cc`

## What

- Removes every hidden first-three/default-participant fallback from conversation creation and requires callers to submit an explicit, non-empty final roster.
- Adds layered roster validation in the chat store and `RoleService`, including unknown, duplicate, unavailable and stale-profile rejection.
- Replaces the standard sidebar quick form with an accessible new-conversation dialog / mobile sheet that snapshots runnable default suggestions once, lets the user edit them and writes only after confirmation.
- Keeps game and mode participant policies explicit. Mode Skills merge only into supplied rows; Skill Test maps exactly three selected current roles to planner/critic/scribe duties.
- Requires an explicit Feishu new-room policy through `FEISHU_DEFAULT_ROLE_IDS` / `feishuDefaultRoleIds`; missing or invalid policy returns `setup_required` without conversation or binding writes, while existing bindings retain their roster.
- Makes empty bootstrap read-only and returns `selectedConversationId=null` instead of manufacturing a conversation.

## Why

Original requirements to judge this change against:

- `feature-specs/2026-08-02-model-family-roles.md:23-24`: opening a normal new chat only preselects current default roles as editable suggestions; persistence uses the final submitted participants; default changes do not rewrite existing conversations; games retain their own participant flow.
- `feature-specs/2026-08-02-model-family-roles.md:28`: the new-chat dialog / mobile sheet must make the AppShell inert, enter and trap focus, support Escape/cancel/close without writes, return focus to the trigger and keep visible targets at least 44px.
- `feature-specs/2026-08-02-model-family-roles.md:152-159`: defaults affect only interactive standard creation; the form snapshots them once; empty defaults begin empty; create requires at least one runnable role; games do not consume these defaults.
- `feature-specs/2026-08-03-model-family-roles-implementation-plan.md:188-206`: caller policy owns participant selection; the store accepts only explicit validated non-empty rosters; bootstrap is read-only; Feishu uses adapter configuration; mode Skills do not create participants; no first-three fallback exists anywhere.

Operator experience: a default is a visible suggestion, not hidden execution policy. Before pressing Create, the operator can see and edit the complete participant roster; cancel and close are side-effect free. Game players and external-channel defaults remain separate, explicit policies.

## Tradeoff

Game player configuration is implemented in the same creation dialog as a separate explicit-player policy, with no default preselection. This concretizes the frozen “game uses its own player configuration” requirement while satisfying the backend non-empty roster contract.

Feishu now fails closed for a new room when no adapter policy is configured. This is intentionally stricter than silently choosing roles: existing bound rooms keep their roster, while administrators receive `setup_required` guidance for new rooms.

## Architecture Ownership

Architecture cell: CAFF chat role + conversation domain
Map delta: none
Why: this extends the existing role/conversation boundaries and caller policies; it does not add a parallel runtime, participant store, router or binding architecture.

## Open Questions

### Technical OQ

- Do store and `RoleService` together reject every invalid roster without allowing a bypass at controller or external-adapter call sites?
- Does Feishu `setup_required` guarantee zero conversation and binding writes for missing/invalid new-room policy while preserving existing bindings?
- Do games remain independent of ordinary default suggestions, and do modes merge Skills only into explicitly supplied participants?
- Does Skill Test require exactly three current roles and avoid retired seed role IDs?
- Does the dialog satisfy focus entry/trap/return, inert background, side-effect-free dismissal and 375px layout behavior?

### Value OQ

None. This review is for the authorized Task 5 implementation slice; it does not claim the whole model-family feature is complete.

## Failure-Mode Sweep

Invariant: no creation path may invent participants or silently repair an invalid roster.

- Scanned store, bootstrap, standard controller/UI, games, workbench modes, Skill Test and Feishu new/existing-room paths.
- Covered omitted, empty, unknown, duplicate, unavailable and stale-profile rosters.
- Covered empty bootstrap, standard/mode/game creation, Feishu `/new`, new-room setup-required and existing bindings.
- Removed retired `agent-strategist`, `agent-critic` and `agent-builder` generation from Skill Test.

## Red → Green Evidence

- Storage and smoke tests first froze explicit roster validation and empty-bootstrap purity.
- Feishu tests froze missing/invalid policy as `setup_required` with zero conversation/binding writes and retained existing-room rosters.
- Runtime and UI dialog tests froze snapshot-on-open, editable suggestions, explicit game players, focus/inert/Escape/cancel semantics and 375px behavior.
- Production code then removed fallback selection and implemented the caller-specific policies.

## Self-Check Evidence

```text
npm run typecheck
  PASS

npm test
  PASS full fast suite; smoke 64/64

node tests/ui/model-family-roles-ui-gate.test.js
  PASS model-family roles UI Design Gate contract

node tests/ui/new-conversation-dialog.test.js
  PASS

node tests/runtime/new-conversation-dialog.test.js
  PASS (post-commit)

git diff --check
  PASS
```

Browser evidence from the isolated `02e58cc` worktree at `http://127.0.0.1:3101/`:

```text
C:\Users\ZN\AppData\Local\Temp\cat-cafe-evidence\model-family-roles-task5\new-conversation-defaults-desktop.png
C:\Users\ZN\AppData\Local\Temp\cat-cafe-evidence\model-family-roles-task5\new-conversation-empty-desktop.png
C:\Users\ZN\AppData\Local\Temp\cat-cafe-evidence\model-family-roles-task5\new-conversation-mobile-375.png
```

Desktop and 375px captures were visually inspected. The target commit has no root media/design artifacts and no matching `.pen` file.

An attempted author-side fresh-context scan targeted the design worktree at `aa3b3b8`, not this implementation SHA. Its findings are invalid for this request and are deliberately excluded; reviewer should independently inspect `01d134f..02e58cc`.

## Reviewer Sandbox

Use an isolated reviewer-selected path with a detached/read-only checkout of `02e58cc`. Suggested single server port: `3201`.

```powershell
npm run build
$env:CHAT_APP_PORT='3201'
npm start
```

Do not connect to Redis 6399 or reuse production data. Use an isolated temporary agent directory / SQLite store.

## Next Action

Please return `APPROVE` or `REQUEST-CHANGES` for exact code SHA `02e58cc`, with independent evidence and any findings classified by severity. The review-note commit itself is outside the requested code diff.

[砚砚/gpt-5.6-sol🐾]
