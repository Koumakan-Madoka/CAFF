# PR A Candidate Evidence

## Scope

PR A upgrades the audited PI package family only. It contains no
`stream_read_error` mapping, retry classifier modification, CAFF outer retry,
provider fork, or streaming-mode change.

Production changes:

- exact `@earendil-works/pi-coding-agent@0.84.3`;
- exact direct `@earendil-works/pi-ai@0.84.3` for isolated digest completion;
- exact direct `typebox@1.3.7` for CAFF extension schemas;
- removed deprecated `@mariozechner/pi-ai@0.68.1`;
- digest uses the official `/compat` completion entry;
- Agent runtime/config validation continues to use coding-agent and its nested
  same-version PI AI;
- capability extension no longer imports PI AI to build schemas;
- audited model-capability fixtures reflect the 0.84.3 catalog.

## Dependency Evidence

`npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai
@mariozechner/pi-ai typebox --all` resolves:

- direct coding-agent 0.84.3;
- direct PI AI 0.84.3;
- coding-agent nested PI AI 0.84.3 retained by its published shrinkwrap;
- every visible TypeBox node at 1.3.7;
- no deprecated `@mariozechner/pi-ai` node.

The executable lockfile test enumerates every PI AI package entry and requires
one version set: `[0.84.3]`. Source-boundary assertions require digest `/compat`
and extension `typebox` imports and reject the deprecated package.

`npm audit --omit=dev` reports 5 existing findings (2 moderate, 3 high) in
optional Feishu Axios, Mermaid/DOMPurify, and fast-uri dependency paths. No
finding is in PI/coding-agent/PI AI/TypeBox. No `npm audit fix` was run because
it would introduce unrelated dependency changes.

## Native Retry Control

The same private real `AgentSession` fixture was rerun after the upgrade:

- exact `stream_read_error`: one model call, no retry events, final error;
- ordinary `connection error` then success: two calls, one native retry start,
  one successful retry end.

This proves PR A did not accidentally implement PR B.

## Author Validation

System Node `v24.13.1`; commands serial unless a command explicitly uses Node's
single-test concurrency.

- `npm run check`: PASS.
- `npm run typecheck`: PASS.
- `npm run typecheck:public`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.
- Trellis validation: PASS (`implement 8`, `check 7`, `debug 1`).
- Added-lines high-confidence credential regex: no match.
- Model-family real Edge UI gate: PASS.

Focused PI/runtime/provider/session/tool/Goal/private/image/handoff/message-detail
batch: `294 pass / 296 tests`. The only failures are the exact two baseline
Windows after-hook `rmSync EPERM` failures for `caff-image-preflight-pass-*` and
`caff-image-preflight-text-*`; both test bodies completed.

Additional model/provider/catalog/storage/bridge batch: `112 pass / 113 tests`.
The only failure is unrelated and pre-existing: `public/index.html` still
contains the legacy `人格` label asserted against by
`model-family-roles-production.test.js`; PR A changes neither file, and the exact
baseline file contains the same text.

- Server smoke: `70/70` PASS.
- Mode store: `4/4` PASS.
- DAG execution: `55 + 8 + 8 + 3 + 3 = 77/77` PASS.
- DAG planning: `46/47`, identical to baseline. The sole failure is the existing
  async demo assertion observing `规划图加载中…` instead of `执行中`; storage,
  controller, bridge, and panel suites pass `20 + 7 + 5 + 14`.

## Cross-Layer Review

- Dependency/config dimension: every hardcoded audited version and all direct
  production imports were searched and updated.
- Runtime identity dimension: Agent classes, streams, providers, messages, and
  credentials stay within coding-agent's package graph; digest uses a separate
  same-version compat graph and returns only normalized CAFF data.
- Event dimension: CAFF consumes native `AgentSessionEvent`; the 0.84 JSON/RPC
  delta-only breaking change does not alter the native subscription contract.
- Session/tool/image dimension: focused SDK host, native session path, image
  transform, capability facade, tool trace, model usage, and smoke tests pass.
- UI/catalog dimension: only audited capability fixture data changed; persisted
  user provider configuration and production role behavior did not.

## Production Boundary

Production port 3100 was not read, written, restarted, reconfigured, or
deployed. The room replaced only its own `node_modules` symlink with an isolated
local install; the symlink target in the repository root was not modified.
