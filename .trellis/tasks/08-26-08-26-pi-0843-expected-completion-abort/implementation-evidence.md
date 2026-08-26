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

## Pending Evidence

Independent commit-pinned review and isolated real `send-public` acceptance are
still required before user acceptance and merge authorization. The upstream
regression wording remains in `upstream-draft.md` and has not been published.
