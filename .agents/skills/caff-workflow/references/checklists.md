# Workflow checklists and records

## Intake and pre-write gate

- [ ] Classified as Discussion, Change, or Operations.
- [ ] Loaded `caff-workflow`; for state changes, loaded `grill-with-docs`.
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

Stop and ask when a worktree/branch belongs to another room, a target is dirty, a port owner is unknown, environment separation is incomplete, acceptance SHA is ambiguous, review independence is unavailable, a requested cleanup can lose work, or instructions would modify `main`/`develop` directly.
