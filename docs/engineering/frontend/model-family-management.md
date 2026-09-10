# Model-Family Management UI

## Scope

This document is the current UI contract for model-family roles and local provider management. Backend persistence and validation remain authoritative in `../backend/model-provider-config.md`; runtime model/capability resolution remains authoritative in `../runtime/agent-runtime.md`.

## Navigation And Modal Contract

- The chat sidebar opens management through the production management entry; the inline quick-create form is not a second role editor.
- Provider management is a first-class sibling of role management and exposes Provider ID, Base URL, API protocol, credential controls, configured models, and explicit model-family classification.
- Dialogs implement a focus trap, close on the supported Escape/cancel paths, and guarantee `焦点归还` to the invoking control.
- The canonical participant-layout breakpoints remain:

| Viewport | Contract |
| --- | --- |
| 861–1023px | Compact participant layout with the desktop management shell intact. |
| 701–860px | Narrow participant layout before the mobile drawer transition. |
| <=700px | Mobile layout; controls wrap without horizontal overflow. |

## Provider Secret And Durability Contract

- `读取接口永不返回明文密钥`; credential inputs are always blank on read.
- `留空保留现有密钥`; a blank edit is not a clear request.
- `显式清除` requires a confirmation step and an explicit clear intent.
- Provider configuration uses `原子替换` and a `可恢复备份`; partial writes are forbidden.
- Provider mutation endpoints are `local-admin-only`, require CSRF protection, and never expose secret values to browser logs or response payloads.
- `验证连接` may exercise the selected network provider but must `禁止执行 command` credential sources.
- Environment and command references are resolved by the server with `platform-aware` handling. Unsupported external directory synchronization fails as `directory_sync_unsupported`.
- `DELETE /api/model-providers/:id` reports affected roles/models, requires confirmation, and `不删除历史` conversation messages.

## Role Capability Contract

- Thinking choices come from Pi `supportedThinkingLevels`; the visible canonical ordering is `off / minimal / low / medium / high / xhigh / max` filtered to values supported by the selected model.
- Persisted unsupported thinking values fail validation; the UI is `不允许静默 clamp`.
- Capability lookup is pinned to `@earendil-works/pi-coding-agent@0.84.3` and its `nested @earendil-works/pi-ai`, not a separately installed `global CLI`.
- Provider/model selection and thinking selection round-trip without silently changing model family, provider identity, custom API dialect, or historical extension values.

## Test Points

- `tests/ui/model-family-roles-ui-gate.test.js` verifies this contract and the isolated browser fixture.
- `tests/ui/model-family-roles-production.test.js` verifies the production management UI.
- Provider controller/runtime tests verify blind secret reads, explicit clearing, atomic persistence, capability projection, and validation failures.

## Historical Provenance

This current contract was condensed from the 2026-08-02/03 model-family design gates after delivery in `4bbc260`. The original review chain is recoverable from Git history and is summarized in `.trellis/tasks/archive/2026-08/08-03-model-family-roles/`; it is not a second truth source.
