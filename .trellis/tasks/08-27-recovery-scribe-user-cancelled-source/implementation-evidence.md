# Implementation Evidence

## Scope

- Base: `origin/develop@e2bff2fd7332c0b97d908cadf09e43490d5c2554`
  (PR #111/#112 integrated).
- Branch: `room/c2fab452-caff-bug-bug`.
- Goal mode: one serial cross-layer candidate covering Recovery source
  classification, HTTP projection, timeline/management copy, tests, and specs.
- Production 3100 was not deployed, restarted, signalled, configured, or given
  any task-owned database/external-delivery operation.

## Reproduction And Root Cause

System Node: `v24.13.1`.

A real `ChatAppStore + SqliteRunStore` fixture reproduced the persisted active
user-Stop tuple:

- assistant message: `status=failed`, `metadata.cancelled=true`, and
  `invocationFailure.kind/code/terminationType=cancelled`, `eligible=false`;
- task: `status=cancelled`;
- run: `status=failed`, `termination_type=cancelled`;
- message/task/run/session/context associations matched.

On the unmodified `e2bff2fd` build:

- Recovery capability returned `eligible=false` with
  `conversation_recovery_source_task_not_failed`;
- the same POST was rejected with that code;
- the browser still rendered `整理失败现场` for a synthetic approved cancelled
  capability and rendered a button for missing/unknown source kind.

Root cause: `inspectSourceIntegrity()` required `task.status=failed` before it
classified structured cancellation evidence. The failed-source rule also
accepted some partial cancellation tuples (for example message-only or
run-only signals), so merely adding `task=cancelled` as an alternative would
have widened authority unsafely.

## Implementation Contract

- `message-recovery.ts` classifies exactly one `sourceKind`:
  - `failed` keeps the existing task/run and historical assistant-error rules;
  - `user_cancelled` requires the complete structured message/task/run tuple.
- Any cancellation signal is absorbing. A partial or contradictory tuple
  returns `conversation_recovery_source_cancellation_mismatch` and cannot fall
  through to the failed-source branch.
- `projectMessages()` and POST share the same inspection. Capability adds the
  closed field `sourceKind: failed|user_cancelled|null`.
- Timeline shows `整理失败现场` or `整理停止现场` only for exact supported eligible
  kinds. Missing/unknown kinds fail closed.
- Stop remains producer-only. It never invokes the scribe. Recovery remains one
  explicit user POST, durable/idempotent, direct no-tools, non-routable, and
  does not retry/continue/replay/rollback source work.
- The source message/task/run stay unchanged. Scribe task/run/result audit
  metadata records the accepted source kind.

## Red And Green Evidence

Baseline red after adding tests but before production changes:

- `message-recovery`: `15/18`; exact user Stop exposed the current
  `conversation_recovery_source_task_not_failed`; partial evidence and missing
  source-kind controls failed as designed.
- `message-recovery` UI: `10/12`; wrong stop label and unknown-kind action.

Green after the fix:

- `message-recovery`: `20/20`.
- executor hook: `12/12`, including
  `createTurnStopper -> handle.cancel -> agent-executor catch` producer evidence.
- Pi cancellation-focused tests: `2/2`.
- Recovery Capsule `5/5`, storage `2/2`, HTTP `2/2`, timeline `12/12`.
- Restart: a user-stopped source remains eligible after service reconstruction,
  creates no work automatically, and schedules exactly one job only after POST.
- Negative matrix: message-only, task/run-only, run-only, provider-abort
  impersonation, and eligible-cancelled contradictions fail closed; ordinary
  success and queued cancellation without a run remain ineligible. Watchdog and
  provider failures without cancellation signals retain `sourceKind=failed`.

## Verification

All shared-state suites ran serially with system Node.

- `npm run check`: PASS.
- `npm run typecheck`: PASS (server and public projects).
- `npm run build`: PASS.
- Focused config/HTTP/storage/composition: `4+5+3+1+2` PASS.
- Cross-conversation delivery/routing/Goal/DAG actor guards:
  `18+5+5+6+56` PASS.
- `tests/smoke/server-smoke.test.js`: `71/71` PASS.
- `tests/smoke/mode-store.test.js`: `4/4` PASS.
- Complete `test:fast` file traversal: 89 files, `847` total, `841` pass,
  `2` fail, `4` skip. The two failures are the exact existing Windows after-hook
  `fs.rmSync EPERM` cases in `turn-orchestrator`; its 103 behavior tests report
  `101` pass before those two cleanup-hook failures. This task has no image
  preflight production/test diff.
- DAG execution: `56+8+8+3+3 = 78/78` PASS.
- DAG planning: `20+7+5+14` PASS; the existing demo async copy test still fails
  because it observes `规划图加载中…` instead of `执行中`. This task has no plan
  code/test diff.
- Isolated `npm run test:ui` could not reach page checks: the repository runner
  sent obsolete Room field `type` and current API returned
  `400 room_unknown_field`. This task has no `scripts/verify-ui.mjs`, Room create
  schema, or API contract diff. The temporary port was released.
- `npm ls --depth=0`: PASS; PI family remains exact `0.84.3`, TypeBox `1.3.7`.
- `npm audit --omit=dev`: existing 5 transitive findings (3 high, 2 moderate);
  package and lock files have zero task diff.
- `gitleaks`, `shipguard`, and the wrapper scanner are unavailable in this
  environment. A targeted added-line credential/private-key scan found zero
  matches.
- `git diff --check`: PASS.
- Trellis context validation: `13 implement / 13 check / 3 debug` PASS.

## Cross-Layer Review

- Data flow checked: executor/PI persisted evidence -> domain classifier ->
  controller message projection -> browser closed enum -> existing manual scribe.
- One domain inspection owns capability and POST; no duplicated UI eligibility.
- Search covered all `recoveryCapability`, `整理失败现场`, and system-service copy
  sites. Management copy now describes both failure and user-stop actions.
- No schema, dependency, provider/model, credential, timeout, Stop semantics,
  routing identity, or source lifecycle changes.

## Pending Gates

- Freeze and commit the candidate.
- Obtain independent commit-pinned review of the exact SHA.
- Run exact-SHA isolated acceptance with a real active user Stop, manual button
  click, completed no-tools scribe, restart projection, negative controls,
  isolated port/SQLite/agentDir/uploads/temp/logs/credentials, and external
  delivery disabled.
- User acceptance and explicit merge authorization remain required before any
  PR merge to develop.
