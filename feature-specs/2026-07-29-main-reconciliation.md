---
feature_ids: [CAFF-MAIN-RECONCILIATION]
topics: [git, integration, main, ui, skill-tests, evaluation]
doc_kind: plan
created: 2026-07-29
status: in_progress
---

# CAFF Main Reconciliation Implementation Plan

**Feature:** CAFF-MAIN-RECONCILIATION — reconcile reviewed local-only work with canonical GitHub main
**Goal:** Produce one reviewed branch based on GitHub `main@b9f3ddf` that contains every completed, independently approved CAFF change without importing unreviewed historical commits or regressing F001/F002.
**Acceptance Criteria:**
1. The integration branch is based on exact GitHub `main@b9f3ddf` and contains F001/F002 unchanged except for intentional compatibility fixes required by later approved work.
2. The four approved Skill Tests retirement commits are ported, including removal of any Skill Tests-only files introduced later by F002.
3. The approved AppShell, management-page, theme/icon, and theme-toggle implementation through `7bd6511` is ported while preserving F001 cursor pagination and scroll anchoring.
4. The approved chat-storage evaluation through `feeb074` is ported without changing runtime storage or reading production data.
5. No commit from the unreviewed `02e95ab..1cd4b55` runtime/session queue bundle is imported merely because it is an ancestor of local `main`.
6. Targeted integration regressions, repository checks, typecheck, build, fast/smoke/UI tests, F001/F002 tests, and chat-storage-eval tests pass.
7. An independent cat reviews the final frozen SHA before any PR merge.
**Architecture cell:** none (this repository does not define an ownership-cell map)
**Map delta:** none
**Map delta why:** This work reconciles already-approved feature boundaries; it does not create a new runtime ownership cell.
**Architecture:** Start from canonical GitHub main and replay only reviewed logical commit bundles. Treat every cross-feature conflict as a new delta requiring behavioral tests and independent review; never resolve by preferring an entire old branch tree.
**Tech Stack:** Git, Node.js, node:test, browser JavaScript, SQLite, pinned Pi SDK host
**Frontend verification:** Yes — F001 history pagination and the final AppShell/theme surfaces require UI regression and browser acceptance.

---

## Finish Line

One integration branch is review-ready and contains the approved local work plus the approved storage evaluation on top of F001/F002. Old worktrees remain intact until the branch is merged and independently verified.

### Non-goals

- Do not delete old branches or worktrees before merge truth is established.
- Do not import the historical runtime/session bundle without its own provenance audit.
- Do not redesign UI, storage, pagination, or Pi SDK behavior during reconciliation.
- Do not connect tests to production Redis 6399 or production user databases.
- Do not introduce an automatic runtime fallback or revive the removed Skill Tests module.

## Provenance Ledger

| Bundle | Reviewed target | Verdict | Integration action |
|---|---|---|---|
| Skill Tests retirement | `4560d3e` over base `1cd4b55` | Formal cross-family APPROVE | Replay only `df76468`, `c40ec98`, `13342af`, `4560d3e`; audit F002 additions for newly orphaned Skill Tests code |
| AppShell M1/M2 | through `3087ef8` | Independent APPROVE + post-merge acceptance | Replay `4560d3e..3087ef8` UI commits only |
| Theme/icons + toggle | through `7bd6511` | Code APPROVE + visual guardian approval | Replay `3087ef8..7bd6511`; exclude later review-request-only `092ffed` |
| Chat storage evaluation | implementation `2718dd1`, review metadata `feeb074` | Independent APPROVE | Replay `4c84a32..feeb074`; preserve evaluation-only boundary |
| Historical runtime/session bundle | `02e95ab..1cd4b55` | No current bundle-level review provenance | Exclude and preserve on old branch for a separate audit |

## Stateful Object Census

| Object | Lifecycle owner | Invariants | Adversarial coverage |
|---|---|---|---|
| `chore/main-reconcile` branch | this integration thread | starts at `b9f3ddf`; only reviewed bundles plus explicit compatibility fixes | verify ancestry, range-diff, and file-level scope before review |
| Local `main@7bd6511` | legacy local integration history | read-only input; never force-move during this task | compare selected ranges; no reset/push |
| Old feature worktrees | original feature threads | retained until canonical merge truth | no cleanup before final merge and acceptance |
| `package-lock.json` | integration branch | one coherent dependency graph; pinned Pi SDK remains exact | clean install + build/typecheck/runtime tests |
| Test databases/Redis | test harness | synthetic/temp only; Redis 6399 forbidden | reserved-port guards and disposable paths |

### Invariants

- **INV-1:** `git merge-base --is-ancestor b9f3ddf HEAD` remains true.
- **INV-2:** No selected commit depends on an excluded runtime commit without that dependency being made explicit and reviewed.
- **INV-3:** No `skill-test`, `eval-cases`, OpenSandbox Skill Tests runtime, or Skill Tests UI production entry survives retirement unless a current non-Skill-Tests consumer is proven.
- **INV-4:** F001 latest/before cursor APIs, frontend prepend behavior, and scroll anchors remain green after AppShell migration.
- **INV-5:** F002 default runtime remains the pinned SDK host; no global Pi CLI resolution returns.
- **INV-6:** Chat storage evaluation remains isolated and cannot mutate configured CAFF runtime data.

## Task 1: Port Skill Tests Retirement and Expose F002 Delta

1. Cherry-pick the four approved retirement commits in original order.
2. Run the retirement guards and targeted runtime/smoke suites.
3. Treat references introduced by F002 after the approved retirement base as a required Red integration failure.
4. Remove or remap only those newly exposed F002 Skill Tests paths; preserve the normal Pi SDK host.
5. Re-run targeted tests and commit the compatibility fix with Why and thread provenance.

## Task 2: Port Approved UI Stack Without Losing F001

1. Replay the reviewed UI range from `138154a` through `7bd6511` in original order.
2. Resolve conflicts at semantic ownership boundaries; never take an entire side for `public/app.js`, chat history modules, HTML, or package scripts.
3. Add or update regression coverage where F001 pagination and AppShell composition intersect.
4. Run F001 storage/API tests, UI tests, browser syntax checks, and scroll-anchor acceptance.
5. Commit only new compatibility deltas; preserve original replay commits separately.

## Task 3: Port Approved Chat Storage Evaluation

1. Replay `4c84a32` through `feeb074` in original order.
2. Resolve package scripts and lockfile against the pinned SDK host and retired Skill Tests surface.
3. Run the evaluation contract test and quick synthetic workload.
4. Confirm the harness rejects Redis 6398/6399 and never resolves the configured production SQLite path.

## Task 4: Integration Verification

Run, at minimum:

```text
npm ci
npm run check
npm run build
npm run typecheck
npm run test:fast
npm run test:smoke
npm run test:ui
npm run eval:chat-storage:test
npm run eval:chat-storage:quick
git diff --check origin/main...HEAD
```

Also run targeted F001 pagination/scroll-anchor tests, F002 SDK-host tests, and Skill Tests retirement guards by exact file path.

## Task 5: Review and Merge

1. Freeze the final SHA and produce a findings-first review packet with original provenance and new compatibility deltas separated.
2. Request independent cross-family review; the author cannot review this integration.
3. Address findings with Red→Green evidence and refresh review if SHA changes.
4. Enter merge-gate only after approval; create a PR to GitHub main and verify remote checks.
5. After merge and isolated acceptance, clean only worktrees/branches proven merged or obsolete; preserve excluded runtime history until separately adjudicated.
