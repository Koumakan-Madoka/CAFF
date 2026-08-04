---
feature_ids: [CAFF-ORPHAN-PR-RECONCILIATION]
topics: [review, pull-requests, git, readiness, health-check, feishu, packaging]
doc_kind: review-request
created: 2026-08-04
---

# Review Request: CAFF Orphan PR Reconciliation

Review-Target-ID: orphan-pr-reconcile
Branch: chore/orphan-pr-reconcile
Base: `origin/main@77d7211cb2fd1076bfea33dbaa857b96c35fb923`
Implementation SHA: `7bfee08ad89b3cea938d294c2ef925d77f69ba3a`

## What

- Inventories every open and closed GitHub PR plus every remote branch not merged into canonical `main`.
- Selectively ports the durable newcomer-readiness work from PR #36: a role-aware `GET /api/health`, startup readiness output, optional Feishu SDK packaging, and current setup documentation.
- Uses current `RoleService` and configured model catalog truth. It does not restore PR #36's retired Skill Tests/OpenSandbox stack or its legacy provider-to-environment-key readiness model.
- Classifies the four remaining remote branches with their exact pre-delete tip SHAs; branch deletion occurs only after this reconciliation merges.
- Records the two non-obvious PR cases: closed-unmerged PR #1 is byte-for-byte covered by merged PR #2 at the same head SHA, while PR #36 merged only into an orphaned feature base and never reached `main`.

## Why

The operator asked us to process all code that had been proposed remotely but had not reached `main`. Looking only at open PRs would miss PR #36 and stale remote branches; merging those branches wholesale would also revive product areas that were deliberately retired. This reconciliation preserves the still-valid operational value and makes every exclusion explicit and auditable.

## Original Requirements

> "还有其它远端提了PR但是没合入的代码吗，都一起处理一下吧"

Operational interpretation recorded in `feature-specs/2026-08-04-orphan-pr-reconciliation.md`:

1. Inspect open PRs, closed-but-unmerged PRs, and remote-only branches rather than treating any one list as complete.
2. Preserve useful code that never reached canonical `main`.
3. Do not revive Skill Tests/OpenSandbox or other deliberately retired product scope.
4. Do not duplicate code already present through later merges or squash-equivalent changes.
5. Keep an exact provenance record before deleting stale remote branches.
6. Merge and validate the reconciliation before performing remote cleanup.

Reviewer: judge both implementation correctness and whether this inclusion/exclusion boundary fully answers the operator's request.

## Provenance And Classification

| Item | Evidence | Action |
|---|---|---|
| PR #1 | head `f6b1b0a`, identical to merged PR #2 | Already covered; no new code |
| PR #36 / `feat/skill-test-fidelity-and-windows-stack` | five unique commits ending `a413b3b` | Port readiness/docs/packaging only; exclude retired Skill Tests/OpenSandbox |
| `feat/agent-parallel-side-dispatch@79c0a8a` | `git cherry origin/main` is empty | Delete after merge; patch-equivalent to PR #26/#28 history |
| `feat/model-family-roles@cf34e9d` | superseded by PR #50 and R2 PR #51 | Delete after merge; do not import private workspace journals |
| `revert-28-feat/04-12-caff-feishu-integration@6795df6` | one abandoned revert of retained Feishu capability | Delete after merge |

## Tradeoff

- `/api/health` reports local readiness only. It deliberately performs no provider or Feishu network probe, so `chat.ready=true` does not claim remote reachability.
- `ok` requires the HTTP/SQLite core plus at least one locally resolvable default chat role. Core status remains observable when role-catalog resolution fails.
- The Feishu SDK remains installed by default but is in `optionalDependencies`; `npm ci --omit=optional` supports core/webhook, while long connection fails closed until optional dependencies are included.
- Historical branch journals and retired task artifacts are not imported merely for archival completeness; the exact branch tips preserve provenance until post-merge deletion.

## Architecture Ownership

Architecture cell: CAFF `server/app` composition, `server/api` transport, `server/domain/runtime` readiness projection, and integration packaging
Map delta: none
Why: the change adds a bounded read-only projection and corrects packaging/docs inside existing ownership boundaries; it creates no Store, Queue, Router, Adapter, Dispatcher, or Binding.

Reviewer checks:

- Confirm the projection consumes `RoleService` rather than creating a parallel provider/model registry.
- Confirm the endpoint cannot expose secrets, secret references, commands, custom headers, filesystem paths, or raw errors.
- Confirm optional SDK absence cannot break core/webhook startup and cannot be mistaken for remote provider health.
- Confirm the branch classifications justify selective porting and later deletion.

## Open Questions

### Technical OQ

1. Is `ok = core.ready && availableDefaultRoleCount > 0` the correct local-readiness boundary, including zero-role and role-directory-failure cases?
2. Does the health response remain credential-blind across every success/failure branch and avoid network side effects?
3. Is lazy SDK resolution sufficient to keep `npm ci --omit=optional` core/webhook paths buildable and long connection fail-closed?
4. Do the PR/branch classifications prove there is no remaining durable source delta outside this reconciliation?

### Value OQ

None. The operator explicitly asked for complete remote-leftover reconciliation; the implementation makes the lowest-risk selective merge within that scope.

## Fresh-Context Findings

No valid fresh-context finding is claimed.

- Attempt 1 scanned the wrong worktree (`E:\pythonproject\caff@1cd4b55`) and reported an agent-slot issue in files absent from this diff. The finding is dismissed as out of scope and was not used as evidence.
- Attempt 2 was pinned to `77d7211...7bfee08` but did not return within the bounded review window and was interrupted.
- During author quality-gate review, the install guide was corrected from dependency-mutating `npm install` commands to the verified `npm ci --omit=optional` / `npm ci --include=optional` lanes in `7bfee08`. This is author self-check evidence, not fresh-context or approval evidence.

The named reviewer must inspect the target independently and provide the only local approval verdict.

## Next Action

Perform a formal cross-family, read-only review of implementation SHA `7bfee08`. Return `APPROVE`, `REQUEST-CHANGES`, or `COMMENT` with the reviewed SHA, independent evidence, and findings first.

## Review Sandbox

- Path: `E:\pythonproject\caff-orphan-pr-review-opus`
- Checkout: detached at the review metadata HEAD; implementation diff target is `7bfee08`
- Bootstrap: clear inherited `NODE_ENV`, then run `npm ci`
- Start command: `npm run build`; use `npm test` and `npm run typecheck` for the full gate
- Optional API dogfood: use an isolated temp `PI_CODING_AGENT_DIR`/`PI_SQLITE_PATH` and a free loopback port such as 3138
- Ports: never use reserved 3003/3004; never connect to Redis 6399

## Quality Gate Report

Spec: `feature-specs/2026-08-04-orphan-pr-reconciliation.md`
Checked: 2026-08-04 on implementation SHA `7bfee08`

### Spec Compliance

| Requirement | Evidence | Status |
|---|---|---|
| Complete remote inventory | open PRs `[]`; all closed PRs inspected; four remote-only branches recorded | Pass |
| Preserve useful PR #36 delta | health/readiness, startup output, optional SDK, docs selectively ported | Pass |
| Keep retired product scope retired | removal guard covers every dependency group; no Skill Tests/OpenSandbox runtime restored | Pass |
| Role-aware, side-effect-free readiness | current `RoleService` projection; no remote probe or persistent write | Pass |
| Minimal core/webhook install | exact omit/include commands verified in a detached clean worktree | Pass |
| Safe cleanup ordering | branch tips recorded; deletion deferred until after merge | Pass |

### Dogfood-Your-Slice

Scope verdict: required because `/api/health` is a new user-visible REST capability.

End-to-end path: build target checkout, start an isolated CAFF instance with temporary agent directory and SQLite on `127.0.0.1:3137`, request `GET /api/health`, inspect headers/body/startup logs, stop the process, and delete the temporary data.

Observed result:

```text
HTTP 200
Cache-Control: no-store
core = { ready: true, host: "127.0.0.1", port: 3137 }
chat = { ready: false, defaultRoleCount: 0, availableDefaultRoleCount: 0, roles: [] }
optional.feishu = { configured: false, connectionMode: "webhook", longConnectionSdkAvailable: false }
startup log includes Health: http://127.0.0.1:3137/api/health
stderr empty
```

### Verification

```text
npm test
  exit 0; test:fast all suites green; test:smoke 65 + 20 pass

npm run typecheck
  exit 0

npm ci --omit=optional (NODE_ENV cleared, detached clean worktree)
  exit 0; @larksuiteoapi/node-sdk absent; npm run build exit 0

npm ci --include=optional (same detached clean worktree)
  exit 0; @larksuiteoapi/node-sdk resolves

focused minimal-install tests
  readiness-health 2/2; health-controller 2/2; Feishu long-connection 4/4; server smoke 1/1

git diff --check origin/main...HEAD
  exit 0

root media/design artifact gate
  clean; no matching .pen and no frontend implementation change
```

Repository-specific hotfix, fallback-layer, architecture-ownership, and capability-tips scripts are not present. Manual diff inspection found no new architecture ownership cell and no three-layer fallback in one file.

## Related Documents

- Implementation plan and branch ledger: `feature-specs/2026-08-04-orphan-pr-reconciliation.md`
- Health endpoint contract: `.trellis/spec/backend/health-endpoint.md`
- Feishu setup guide: `docs/feishu-integration.md`
- Prior reconciliation truth: `feature-specs/2026-07-29-main-reconciliation.md`

[砚砚/gpt-5.6-sol🐾]
