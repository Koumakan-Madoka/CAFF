---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [baseline, worktree, tests, provenance]
doc_kind: evidence
created: 2026-08-03
---

# CAFF Model-family Roles Implementation Baseline

## Provenance

- Implementation worktree: `E:\pythonproject\caff-model-family-roles-implementation`
- Branch: `feat/model-family-roles-implementation`
- Exact base: `origin/main@b9f3ddfa88b3e8942d0dd095f1dcaeb4c979d451`
- Frozen design source: `feat/model-family-roles@aa3b3b8`
- Capability implementation delta: `3235911..547e8fe`
- Cross-individual delta verdict: APPROVE, message `0001785727907116-000305-fdd2f496`
- Operator authorization: “好，现在开始落地吧”

The design branch was not merged or cherry-picked. Only the frozen discussion/spec/plan, HTML fixture, UI Gate contract test, and model-family review packets were restored by path.

## Exact-main Inspection

The following current-state anchors were re-read at the exact base before implementation:

- `storage/sqlite/migrations.ts`: `chat_agents` still combines runnable config and Persona; participant/memory FKs cascade on Agent deletion.
- `storage/chat/agent.repository.ts`: delete is a naked `DELETE FROM chat_agents`.
- `lib/chat-app-store.ts`: old nine seeds are inserted on startup, `saveAgent()` requires Persona, `pickDefaultParticipants()` selects the first three Agents, and bootstrap ensures a starter conversation.
- `server/api/bootstrap-payload.ts`: catalog inputs include Agent/Profile references and reads two possible `models.json` paths.
- `server/api/conversations-controller.ts` and Feishu service: several create paths omit final participants and rely on store fallback.
- `lib/pi-sdk-host.mjs`: runtime imports repo-pinned `@earendil-works/pi-coding-agent`.
- Nested `@earendil-works/pi-ai@0.80.10`: `getSupportedThinkingLevels()` is the capability truth; global/root deprecated Pi packages are not used for this contract.

## Baseline Gates

Executed after `npm ci`, before any production source edit:

| Command | Result |
|---|---|
| `npm test` | PASS; fast and smoke suites, zero failures |
| `npm run typecheck` | PASS |
| `node tests/ui/model-family-roles-ui-gate.test.js` | `PASS model-family roles UI Design Gate contract` |
| `git diff --check` | PASS |

`npm ci` reported 12 pre-existing dependency audit findings (4 moderate, 7 high, 1 critical) and the existing deprecation notice for root `@mariozechner/pi-ai@0.68.1`. No `npm audit fix` was run because dependency remediation is outside this feature and `--force` would introduce unrelated breaking changes.

## Safety Boundary

- No production schema/API/runtime/UI file changed in this baseline commit.
- Tests use isolated temporary agentDir/SQLite data.
- Reserved ports 3003/3004 and Redis 6399 were not used.
- Environment/governance bootstrap files were not transferred or staged.

[砚砚/gpt-5.6-sol🐾]
