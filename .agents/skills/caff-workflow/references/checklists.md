# Workflow checklists and records

## Intake and pre-write gate

- [ ] Classified as Discussion, Change, or Operations.
- [ ] Loaded `caff-workflow` and completed its tracked `grill-with-docs` protocol; loaded an optional richer local Skill if available.
- [ ] User confirmed goal, non-goals, constraints, and acceptance evidence.
- [ ] Declared Direct/Goal/DAG with reason; Goal/DAG explicitly approved.
- [ ] Change room has unique conversation-ID-based branch/worktree; Operations uses the designated persistent worktree.
- [ ] Inspected branch, SHA, worktrees, and dirty state; stopped on ownership conflict.
- [ ] Destructive actions, secrets, process changes, pushes, merges, and deployments have specific authorization where applicable.

## Implementation and integration gate

- [ ] Read applicable specs/skills and original requirements.
- [ ] Change is scoped; dependencies on other unshipped rooms are declared.
- [ ] Bug root cause is evidenced; regression test was red first when feasible.
- [ ] Applicable format/lint/type/test/build/manual checks pass, with exact commands recorded.
- [ ] Diff contains no secrets, environment state, generated junk, or unrelated edits.
- [ ] Non-author reviewer reviewed the exact head SHA and findings are resolved or explicitly accepted.
- [ ] Integration target is `develop`; merge preserves a merge commit (`--no-ff` semantics).

## Commit-pinned review workspace decision

A formal review request must name the exact commit SHA, scope and risks, author validation evidence, and desired response format. The author freezes repository writes for the rest of the trace after sending it.

Choose the review workspace from actual mutation/test risk instead of creating one automatically:

1. Static review through immutable commit objects (`git show <SHA>`, `git diff <SHA>^ <SHA>`) needs no worktree, even if later development continues.
2. If the room worktree is clean, its `HEAD` equals the requested SHA, and the author will not continue modifying it, the reviewer may inspect and run tests there.
3. If tests require the requested SHA while the room worktree may change or points elsewhere, create a detached review worktree outside the author's worktree. Reuse dependencies only when the project supports it; otherwise install them in that review workspace. Use distinct ports, SQLite/database, logs, caches, and external-side-effect configuration.
4. If the reviewer must modify code, use a separate writable branch/worktree rather than the detached review worktree or the author's room worktree.
5. Cleanup is non-destructive: remove only a clean review worktree; on Windows file locks, retry or report and retain it. Never force-remove a dirty or locked worktree.

## Independent handoff

Use this five-part form:

```text
What: branch, head SHA, changed behavior/files, evidence
Why: user-confirmed goal and acceptance criteria
Tradeoff: chosen design and rejected alternatives
Open Questions: known limits, risks, unresolved items
Next Action: exact review/test/merge requested; do not merge yet unless authorized
```

## Acceptance record

Before testing, record:

```text
candidate_sha: <develop SHA actually running>
rooms_and_merges: <room branches and merge commit SHAs>
automated_checks: <commands and results>
manual_acceptance: <items, expected result, actual result>
known_limits: <none or list>
environment: port 3200; isolated database/logs; side effects status
user_decision: pending | rejected | accepted
```

Only the user's explicit acceptance changes `candidate_sha` into `accepted_sha`. Any new commit creates a new candidate and invalidates automatic reuse of the old conclusion. On failure, return to the original room branch, repair, review, merge, and re-test affected items.

## Release gate

- [ ] `accepted_sha` and user acceptance are recorded.
- [ ] `release/*` points exactly to `accepted_sha` and has not moved.
- [ ] `release/* -> main` received non-author approval and required checks.
- [ ] Production data, logs, secrets, side effects, and rollback plan were verified without disclosing secrets.
- [ ] Published `main` SHA and tag are recorded.
- [ ] Published `main` is synchronized back to `develop`.
- [ ] Room branches/worktrees are cleaned only at their approved lifecycle point.

## Operations-only gate

- [ ] User authorized start/stop/observation and named the environment.
- [ ] No tracked file is changed; otherwise transition to Change first.
- [ ] Verified branch/SHA, clean status where required, port, database, logs, credentials, and side effects.
- [ ] Stopped only the process proven to belong to this environment; never kill by port guesswork.
- [ ] Reported health/result evidence and process lifecycle without exposing secrets.

## Mandatory stop conditions

Stop and ask when a worktree/branch belongs to another room, a target is dirty, a port owner is unknown, environment separation is incomplete, acceptance SHA is ambiguous, review independence is unavailable, a requested cleanup can lose work, or instructions would add implementation commits/direct pushes to `main` or `develop`. Authorized reviewed merge commits follow the integration and release gates above.
