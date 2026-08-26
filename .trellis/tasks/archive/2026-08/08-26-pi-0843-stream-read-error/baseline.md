# Upgrade-Before Baseline Evidence

Baseline SHA: `abf00a112d5455316aef818513b38c2cc65e4137`

Runtime: system Node `v24.13.1`; commands were run serially.

## Quality Gates

- `npm run check`: PASS.
- `npm run typecheck`: PASS.
- `npm run typecheck:public`: PASS.
- `npm run build`: PASS.

## Dependency Tree

`npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai
@mariozechner/pi-ai typebox --all --parseable` resolves:

- root `@earendil-works/pi-coding-agent@0.80.10`;
- coding-agent nested `@earendil-works/pi-ai@0.80.10`;
- root deprecated `@mariozechner/pi-ai@0.68.1`;
- coding-agent nested `typebox`.

This is the pre-upgrade double-family condition PR A must eliminate.

## Controlled Native Retry Probe

A deterministic real `Agent` + `AgentSession` fixture used an in-memory session,
retry settings `{ enabled: true, maxRetries: 3, baseDelayMs: 0 }`, and a custom
stream function. No network, credentials, CAFF outer retry, or production state
was involved.

- Exact `stream_read_error`: provider calls `1`; retry starts `0`; retry ends
  `0`; final assistant `stopReason=error`, `errorMessage=stream_read_error`.
- `connection error: fixture disconnect` followed by success: provider calls
  `2`; retry starts `1` at attempt 1; retry ends `1` with success; final text
  `recovered`.

This is a behavioral reproduction through PI's real agent/session retry path,
not only a regex unit test.

## Focused Runtime Regression

Command: one `node --test --test-concurrency=1` invocation across 22 files:
PI SDK host/runtime/model config/catalog, provider/auth, executor, turn/Goal,
bridge/capabilities, image, cross-conversation, tool trace, context snapshot,
message detail storage, message page, and SSE metadata.

Result: `293 pass / 295 tests`.

The only two failures are the established Windows cleanup-hook failures:

- `turn orchestrator preflight passes when all initial targets support images`:
  test body completed, after-hook `fs.rmSync` failed with `EPERM` on a temporary
  `caff-image-preflight-pass-*` directory.
- `turn orchestrator preflight skips text-only messages entirely`: test body
  completed, after-hook `fs.rmSync` failed with `EPERM` on a temporary
  `caff-image-preflight-text-*` directory.

These exact failures are the accepted comparison baseline; PR A must not add a
new behavioral failure.

## DAG Execution

`npm run test:dag-execution`: PASS.

- scheduler: 55/55;
- worktree: 8/8;
- merge: 8/8;
- execution baseline: 3/3;
- Goal/DAG guard: 3/3.

Total: `77/77`.

## Smoke

`npm run test:smoke`: PASS.

- server smoke: 70/70;
- mode store: 4/4.

The server smoke includes real local HTTP, PI/Trellis host integration, model
digest JSON-mode paths, Goal lifecycle, message pagination, provider
administration, roles, projects, skills, and runtime observability.

## DAG Planning Baseline

`npm run test:dag-planning`: `46 pass / 47 tests`.

The only failure is the established async UI assertion in
`tests/ui/dag-planning-demo.test.js`: expected `/执行中/` but observed the
loading label `规划图加载中…`. Storage 20/20, HTTP 7/7, bridge 5/5, and panel
14/14 pass. This failure is unrelated to PI and is pinned as a baseline
comparison point.

## Production Boundary

No production port 3100 process, database, configuration, credentials, logs, or
external integration was read, written, restarted, or deployed while collecting
this baseline.
