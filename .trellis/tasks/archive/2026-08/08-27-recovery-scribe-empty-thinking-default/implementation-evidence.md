# Implementation Evidence

## Scope

- Base: `origin/develop@d03b3fc4b6d11f1e84a255e79c96d01ec7442720`.
- Branch: `room/c2fab452-caff-bug-bug`.
- Production behavior change: only `server/domain/conversation/message-recovery.ts`
  materializes an exact empty resolved Recovery Scribe startup thinking value as
  `off`.
- Explicit non-goals preserved: `lib/pi-runtime.ts` global
  `DEFAULT_THINKING=''`, generic `resolveThinkingSetting`,
  `recovery-scribe-config.ts` persisted/admin validation, provider/model,
  credentials, schema, API, UI, dependencies, and production configuration.

## Reproduction And Root Cause

System Node: `v24.13.1`.

With `CAFF_RECOVERY_{PROVIDER,MODEL,THINKING,TIMEOUT_MS}`,
`CAFF_DIGEST_{PROVIDER,MODEL,THINKING}`, and
`PI_{PROVIDER,MODEL,THINKING}` absent:

- Baseline `cross-conversation-delivery-wiring.test.js`: `0/2`, both fail with
  `Recovery scribe runtime defaults are invalid`.
- Baseline stale-restart selection in `message-recovery.test.js`: `0/1`, same
  error.
- Exact stack:
  `validateDefaults -> createRecoveryScribeConfigManager ->
  createMessageRecoveryService -> createServerApp`.
- `resolveThinkingSetting` returns the global empty sentinel for the default
  `kimi-coding` provider; Recovery Scribe strict defaults accept only
  `off|minimal|low|medium|high|xhigh|max`.
- The explicit `thinking='bogus'` and `timeoutMs=60001` controls pass on the
  baseline by throwing the existing validation errors, proving the regression
  is specific to the empty default.

## Red/Green Contract

- Added `tests/helpers/recovery-runtime-env.js` to clear and restore the relevant
  environment only around synchronous service/server construction.
- Both server-composition tests now construct without ambient runtime defaults.
- Stale restart constructs a fresh service under the same boundary and asserts
  `getConfiguration().config.thinking === 'off'`.
- Existing config-manager coverage continues to reject unavailable models,
  unsupported model thinking, unknown fields, and invalid limits.
- After the source fix: wiring `2/2`; message recovery `7/7`.

## Verification

All commands used system Node directly and shared-state suites ran serially.

- `npm run check`: PASS.
- `npm run typecheck`: PASS (server and public projects).
- `npm run build`: PASS.
- Focused Recovery/config/HTTP/UI/storage/delivery/composition batch: `57/57`
  PASS.
- `npm run test:smoke`: `71 + 4 = 75/75` PASS.
- Complete `test:fast` file traversal: `828` total, `822` pass, `2` fail,
  `4` skip. The two failures are the exact pre-existing Windows after-hook
  signatures in `tests/runtime/turn-orchestrator.test.js`: behavior assertions
  pass, then `fs.rmSync` returns `EPERM` for the temporary
  `caff-image-preflight-pass-*` and `caff-image-preflight-text-*` directories.
  This task has no diff in that test or image preflight production code.
- `npm run test:dag-execution`: `56 + 8 + 8 + 3 + 3 = 78/78` PASS.
- `npm run test:dag-planning`: `20 + 7 + 5 + 14 = 46` PASS; the one existing
  demo failure remains `tests/ui/dag-planning-demo.test.js`, where the
  asynchronous text is still `规划图加载中…` instead of matching `执行中`.
  This task has no DAG/UI production or test diff.
- `npm ls --depth=0`: PASS; PI family remains exactly `0.84.3` and TypeBox
  remains `1.3.7`.
- `npm audit --omit=dev`: reports the existing `5` transitive findings
  (`3 high`, `2 moderate`); package and lock files have zero task diff.
- `git diff --check`: PASS.
- Trellis context validation: `5 implement / 6 check / 1 debug` PASS before
  final evidence additions.

## Environment Boundary

- No server, deployment, database migration, external delivery, or production
  configuration command was issued by this task.
- Production port `3100` remained listening during the read-only check (PID
  observed as `9860`); the task did not start, stop, signal, or replace it.
- Candidate acceptance has not started. It will require an isolated port,
  SQLite path, agent/uploads/temp/log directories, side effects disabled, and
  an exact committed SHA after independent review.
