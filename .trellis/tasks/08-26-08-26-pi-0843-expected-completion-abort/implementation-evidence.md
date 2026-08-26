# Implementation Evidence

## Baseline

- Room branch synchronized to `origin/develop` at
  `3adeb3acc56cfd8a14d1ce287453275d71b2cc8f`.
- PI package baseline: `@earendil-works/pi-coding-agent` and PI AI 0.84.3.
- Historical run 10437, message
  `0b6f885a-b43c-45a7-a621-a43055d3b8cd`, and task records were not modified.
- Production port 3100 was not deployed, restarted, reconfigured, or used for
  task verification.

## Red Evidence

Command:

`node --test --test-name-pattern="abort tail|provider error recorded before caller expected completion" tests/runtime/pi-runtime.test.js`

Baseline result: 1 pass / 2 fail.

- Expected-completion case actual unresolved errors:
  `["This operation was aborted"]`; expected `[]`.
- Pre-completion provider-error case actual unresolved errors:
  `["provider failed before public completion", "This operation was aborted"]`;
  expected only the first error.
- User-cancel control passed and retained `terminationReason.type='cancelled'`
  plus the abort-tail assistant diagnosis.

## Implementation

`lib/pi-runtime.ts` now sets `ignoreFurtherAssistantOutput=true` at the start of
`beginTermination` only when `reason.type === 'expected_completion'`, before
abort IPC. No error-text match, pending-error deletion, executor suppression,
provider mapping, or retry change was added.

## Green Evidence So Far

- Build plus new regression matrix: 3/3.
- Full `tests/runtime/pi-runtime.test.js`: 38/38.
- PI SDK/executor/bridge/tool-trace/real PI retry focused batch: 88/88.
- `tests/runtime/turn-orchestrator.test.js`: 100 behavioral assertions passed;
  two known Windows EPERM failures occurred only in temporary-directory cleanup
  after-hooks, matching the pre-existing accepted baseline.

## Complete Regression Evidence

System Node v24 was used directly and shared runtime/SQLite suites were run with
`--test-concurrency=1`.

- `npm run check`: pass.
- `npm run typecheck`: pass for source and public TypeScript projects.
- `npm run build`: pass.
- `git diff --check`: pass.
- Runtime/http/storage/ui full batch: 981 pass / 4 fail / 4 skip out of
  989. The four failures exactly match the accepted baseline:
  - two Windows `rmSync` EPERM temporary-directory cleanup after-hooks in
    turn-orchestrator image preflight tests; both test bodies passed;
  - the DAG planning demo async projection still reads `规划图加载中...`
    instead of `执行中`;
  - the production model-family terminology test still finds the existing
    `人格` text in `public/index.html`.
- Server smoke: 70/70; mode store: 4/4.
- DAG execution: `55 + 8 + 8 + 3 + 3 = 77/77`.
- DAG planning: 46/47 with only the same existing demo async failure above.
- Dependency tree: coding-agent and every PI AI node are 0.84.3; every TypeBox
  node is 1.3.7; no `@mariozechner/pi-ai` node is present.
- `npm audit --omit=dev`: five existing transitive findings, two moderate and
  three high (Axios/fast-uri/DOMPurify/Mermaid). This task has no dependency
  diff and did not run `npm audit fix`.
- Added-lines secret scan: no credential/private-key pattern match.
- Trellis validation: pass.

No generated build output, SQLite database, logs, temporary fixture, production
configuration, or credential is included in the diff.

## Independent Review And Acceptance Failure

- GLM independently approved exact SHA
  `d12d6fe318dbde08ad0413c60ecf65f87dfa0388` (tree
  `e601c4f258a90c58341e406d2402889e7376a5c1`) with no blocking findings.
- Exact-candidate room preview on port 3238 used isolated SQLite, agentDir,
  project, uploads, temp, logs, and copied provider configuration with all
  Feishu variables cleared. The real model called `send-public`; message/task/
  run succeeded, run `assistant_errors_json=[]`, persisted usage retained one
  pre-completion model call, SSE emitted completed and no failed state, and the
  PI session retained a second zero-usage `stopReason='error' / This operation
  was aborted` record.
- Acceptance rejected `d12d6fe3`: tool-trace reparsed the raw child session and
  returned `failureContext.hasFailure=true` despite the authoritative success.
  This was not covered by the original synthetic trace fixture, which modeled
  the older `stopReason='aborted' / Request was aborted.` cleanup shape.

## Acceptance Revision Evidence

- New real-SQLite red test: completed message + succeeded task/run + empty run
  assistant errors + persisted `expected_completion` event still produced
  `failureContext.hasFailure=true`.
- The trace projection now treats the child-session error as resolved only when
  those authoritative persisted signals all agree. It keeps the raw session
  stop/error and exposes `session.expectedCompletionTailIgnored=true`; it does
  not match error text or modify runtime/executor state.
- Fail-closed controls keep failure context when run assistant errors are
  non-empty or the expected-completion event is absent.
- Focused green: four completion/retry/session-error trace cases 4/4; complete
  message-tool-trace suite 20/20. The focused runtime/executor/bridge/trace/turn
  batch passed 227 behavior tests with only the same two accepted Windows EPERM
  cleanup-hook failures.
- `npm run check`, `npm run typecheck`, and `npm run build` passed. The complete
  runtime/http/storage/ui batch was 982 pass / 4 fail / 4 skip out of 990; the
  four failures exactly matched the accepted baseline (two EPERM cleanup hooks,
  DAG demo async loading text, and the existing `人格` terminology assertion).
  Smoke was 70/70 plus mode 4/4; DAG execution passed; DAG planning retained only
  the same existing demo failure.
- Replaying the rejected preview's real SQLite/session JSONL against the
  revision produced `hasFailure=false`, `expectedCompletionTailIgnored=true`,
  raw session stop `error`, raw assistant error retained, and two diagnostic
  session model calls.
- A fresh real-model exploratory preview of the uncommitted revision reproduced
  the exact abort tail and passed message/task/run/usage/SSE/UI/SQLite checks:
  persisted model calls 1, diagnostic session calls 2, run assistant errors
  empty, trace failure false, UI completed with no failed class,
  `integrity_check=ok`, and zero foreign-key violations. Because the revision
  was not yet committed, this is behavioral evidence only; exact-SHA acceptance
  must be repeated after the new candidate is frozen and independently
  reviewed.
- Preview 3238 was closed after each attempt. Production 3100 remained on PID
  23276 and was not deployed, restarted, or reconfigured.

## Develop Synchronization And Combination Regression

- While PR 106 was waiting for CI, `origin/develop` advanced from the task-start
  base `3adeb3acc56cfd8a14d1ce287453275d71b2cc8f` to PR 107 merge
  `6c3210222d908a9097809f83a9712a7fc5075ba7`. The new baseline changes 64
  paths, including executor, bridge, turn tests, and runtime spec surfaces.
- PR 106 was left draft. After explicit user authorization, the room merged the
  new develop with `--no-ff`, producing combination merge
  `d278ae9446116ae74a5e47f0fd58cad2d6871a1e` with exact parents
  `045542f6f1e36790a1356301eca0194a88c9abdf` and
  `6c3210222d908a9097809f83a9712a7fc5075ba7`. The merge was conflict-free.
- The original candidate's `lib/pi-runtime.ts`,
  `server/domain/runtime/message-tool-trace.ts`, and both dedicated regression
  test blobs are byte-identical after the merge. The combined diff against the
  new develop remains the same 13 task paths and 896 insertions / 3 deletions.
- System Node v24.13.1 was used directly. `npm run check`, `npm run typecheck`,
  and `npm run build` passed. The focused runtime/executor/bridge/trace/retry
  batch passed 128/128. The new develop recovery/system-actor focused batch
  passed 71/71.
- Turn-orchestrator passed 101 behavior tests with only the same two accepted
  Windows EPERM cleanup-hook failures. The full runtime/http/storage/UI batch
  was 1024 pass / 4 fail / 4 skip out of 1032; the four failures retain the
  exact accepted signatures: two EPERM after-hooks, the DAG demo async loading
  assertion, and the existing `人格` terminology assertion.
- Server smoke and mode-store passed 75/75. DAG execution passed
  `56 + 8 + 8 + 3 + 3 = 78/78`. DAG planning passed 46 behavior tests and
  retained only the same accepted demo async failure.
- Trellis validation passed with 7 implement, 10 check, and 6 debug entries
  before this synchronization evidence append. `git diff --check`, generated/
  temporary artifact scan, and added-lines credential pattern scan passed.
  Coding-agent and all PI AI nodes remain 0.84.3; all TypeBox nodes remain
  1.3.7.
- Production 3100 remained on PID 23276. Historical run 10437 was not rewritten,
  no preview was started during automated regression, and the upstream draft
  remains unpublished.

## Pending Evidence

A new exact post-synchronization candidate, independent commit-pinned review,
and isolated real `send-public` acceptance are still required before renewed
user acceptance and merge authorization. The upstream regression wording
remains in `upstream-draft.md` and has not been published.
