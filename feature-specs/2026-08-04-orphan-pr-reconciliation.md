---
feature_ids: [CAFF-ORPHAN-PR-RECONCILIATION]
topics: [git, pull-requests, readiness, health-check, feishu, packaging]
doc_kind: implementation-plan
created: 2026-08-04
---

# Orphan PR Reconciliation Implementation Plan

**Feature:** CAFF remote PR/branch reconciliation
**Goal:** Preserve the still-valid newcomer-readiness work from PR #36 on current `main`, prove that retired Skill Tests/OpenSandbox code stays retired, and remove superseded remote branches after merge.
**Acceptance Criteria:** `GET /api/health` reports core and role-aware chat readiness without network probes or secret/path disclosure; CAFF starts and webhook mode works after `npm ci --omit=optional`; Feishu long connection remains an explicit optional lane; startup output points to the health endpoint; user docs match current model-family roles; all remote-only branches are either merged selectively or deleted with their tip SHA recorded.
**Architecture cell:** CAFF `server/app` composition, `server/api` transport, `server/domain/runtime` readiness projection, and integration packaging
**Map delta:** none
**Map delta why:** This adds a bounded read-only projection and packaging/docs correction inside existing ownership boundaries.
**Architecture:** A thin health controller delegates to a stateless readiness projection built from `RoleService`, server address, and Feishu local configuration. The projection consumes current role/model-catalog truth, performs no provider or Feishu network calls, and exposes no credentials or filesystem paths. The Feishu SDK moves to `optionalDependencies`; webhook/core paths remain SDK-independent because long-connection loading is lazy and fail-closed.
**Tech Stack:** Node.js 22, TypeScript/CommonJS, `node:test`, npm lockfile
**Frontend verification:** No

---

## Finish Line And Exclusions

The finish line is one merged reconciliation PR plus deletion of remote branches whose useful deltas are either present on `main` or intentionally superseded.

Not building:

- no Skill Tests, eval-cases, OpenSandbox runtime, setup docs, scripts, dependencies, or archived task resurrection;
- no remote provider/Feishu connectivity probe in `/api/health`;
- no global single-provider readiness model, because current CAFF supports multiple default chat roles and provider configurations;
- no health response fields containing database paths, API keys, auth references, commands, or custom headers.

## Terminal Contract

`GET /api/health` returns HTTP 200 with a fresh payload:

```ts
type ReadinessHealth = {
  ok: boolean;
  core: { ready: true; host: string; port: number };
  chat: {
    ready: boolean;
    defaultRoleCount: number;
    availableDefaultRoleCount: number;
    roles: Array<{
      id: string;
      name: string;
      ready: boolean;
      availability: string;
      provider?: string;
      model?: string;
    }>;
    issue?: { code: 'role_directory_unavailable' };
  };
  optional: {
    feishu: {
      configured: boolean;
      connectionMode: string;
      longConnectionSdkAvailable: boolean;
    };
  };
  timestamp: string;
};
```

`ok` means core server readiness plus at least one locally resolvable default chat role. It does not claim remote provider reachability.

## Data Flow

```text
GET /api/health
  -> health controller
  -> readiness projection
  -> RoleService.getDirectory()
  -> RoleService.resolveRuntimeParticipants() for default roles
  -> credential-blind JSON response
```

Feishu status is derived only from local env/configuration and lazy SDK availability. No request performs network I/O or writes persistent state.

## Invariants

- **INV-1:** Health reads are side-effect free and never call provider or Feishu remote APIs.
- **INV-2:** Health output contains no secret value, secret reference, command, custom header, or local database path.
- **INV-3:** Chat readiness uses `RoleService`/configured-model-catalog truth, not a duplicate provider environment-variable map.
- **INV-4:** Missing/corrupt role catalog data yields `chat.ready=false` with a stable issue code while core remains observable.
- **INV-5:** `npm ci --omit=optional` leaves the core server and webhook path buildable; long connection fails closed when its SDK is absent.
- **INV-6:** No path matching Skill Tests/OpenSandbox production code or setup docs is restored.

## Task 1: Add Readiness Contract Tests (RED)

**Files:**

- Create: `tests/runtime/readiness-health.test.js`
- Create: `tests/http/health-controller.test.js`
- Modify: `package.json`

1. Test multiple default roles, one resolvable and one blocked, and assert the role-aware counts/projections.
2. Test role-directory failure and assert stable fail-closed output without raw error text.
3. Test that serialized output excludes database paths and credential-shaped fields.
4. Test controller GET handling and non-GET fallthrough.
5. Run the new suites after build and verify they fail because the modules do not exist.

## Task 2: Implement The Health Projection And Route (GREEN)

**Files:**

- Create: `server/domain/runtime/readiness-health.ts`
- Create: `server/api/health-controller.ts`
- Modify: `server/app/create-server.ts`
- Modify: `.trellis/spec/backend/index.md`
- Create: `.trellis/spec/backend/health-endpoint.md`

1. Implement the credential-blind projection using injected role-service/address/env/SDK resolvers.
2. Register the thin controller before other API controllers.
3. Return the actual bound port when the server was configured with port `0`.
4. Expose `getHealthStatus()` on the app object for startup logging and tests.
5. Run the focused runtime/controller suites and typecheck.

## Task 3: Prove Integration Behavior

**Files:**

- Modify: `tests/smoke/server-smoke.test.js`
- Modify: `lib/app-server.ts`

1. Add a smoke assertion for the HTTP response shape and current role-aware semantics.
2. Log the actual listening URL, core/chat readiness summary, Feishu local status, and `/api/health` URL at startup.
3. Run the smoke suite and confirm unsupported methods still use the standard API 404 path.

## Task 4: Restore The Minimal Install Lane Without Retired Modules

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/runtime/feishu-long-connection.test.js`
- Modify: `tests/runtime/skill-tests-removal-guards.test.js`

1. Add a failing packaging assertion that `@larksuiteoapi/node-sdk` is optional and `opensandbox` is absent from all dependency groups.
2. Add a missing-SDK long-connection test that verifies graceful `false` startup and a diagnostic warning.
3. Move only the Feishu SDK to `optionalDependencies` and update the lockfile.
4. Run `npm ci --omit=optional` in an isolated temporary checkout/copy, then build and run the focused core/webhook tests.

## Task 5: Reconcile Durable Documentation

**Files:**

- Modify: `.env.example`
- Modify: `.gitattributes`
- Modify: `README.md`
- Create: `docs/feishu-integration.md`
- Modify: `docs/local-chat-ui.md`

1. Add the role-aware health verification step and a clear minimal-install command.
2. Move detailed Feishu setup/troubleshooting into its own user guide and link it from README.
3. State that long connection needs the optional SDK while webhook/core do not.
4. Add `.jsonl` LF normalization retained from PR #36.
5. Keep all OpenSandbox/Skill Tests references out of active setup lanes.

## Task 6: Reconcile Branch Truth And Quality Gates

1. Verify the GitHub closed-but-unmerged inventory: PR #1 has the same `f6b1b0a` head as merged PR #2, while PR #36 merged only into the orphaned Skill Tests feature base and supplies this reconciliation's selective source.
2. Verify `feat/model-family-roles` has no durable source-only artifact beyond private workspace journals; classify it as superseded by PR #50/#51.
3. Verify `feat/agent-parallel-side-dispatch` has no unmatched patch and classify it as stale after PR #26/#28.
4. Verify the Feishu revert branch conflicts with the retained product direction and classify it as abandoned.
5. Run `npm run check`, `npm run typecheck`, `npm test`, `git diff --check`, and the Skill Tests removal guard.
6. Run quality gate, fresh-context review if needed, and cross-individual review before merge-gate.

## Task 7: Merge And Remote Cleanup

1. Open the reconciliation PR from a frozen SHA and complete CI/review/merge-gate.
2. After merge, delete only the four classified stale remote branches, recording these pre-delete tips:
   - `feat/agent-parallel-side-dispatch` at `79c0a8a984d3a1e3d14165bca571438fb5e440a2`
   - `feat/model-family-roles` at `cf34e9d0bc3a1823c6348698ca22b47d1dd1b75f`
   - `feat/skill-test-fidelity-and-windows-stack` at `a413b3bf2a3a558d2e5bd918ef7afbdbde8c88e1`
   - `revert-28-feat/04-12-caff-feishu-integration` at `6795df64f59d055286f0ffa77d69416e10d01f00`
3. Remove the integration worktree only after merge and confirm no open PR remains.

## Completion Truth

- PR #52 was squash-merged into `main` as `0231d0ca188959567ea7f5f7ec07758fb72866fb` on 2026-08-04 after both CI `unit` jobs passed and the frozen `88eec961983da9b8a1742d2a92bc9eca3644600e` received cross-family approval. Cloud review was unavailable because the connector explicitly reported exhausted review quota; the PR records the downgrade provenance.
- The four classified stale remote branches were deleted only after their tips were re-read from GitHub and matched the frozen SHAs recorded above. Those full SHAs remain the recovery anchors.
- After deletion and `fetch --prune`, GitHub reported zero open PRs and Git reported zero remote branches outside the `origin/main` ancestry. Local branches and unrelated worktrees were intentionally left untouched.

## Open Questions

None. The implementation uses an injected resolver for deterministic tests and `require.resolve` at runtime, while the selective reconciliation keeps retired product scope excluded.
