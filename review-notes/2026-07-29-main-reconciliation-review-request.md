---
feature_ids: [CAFF-MAIN-RECONCILIATION]
topics: [review, git, integration, main, ui, skill-tests, storage-evaluation]
doc_kind: review-request
created: 2026-07-29
---

# Review Request: CAFF Main Reconciliation

Review-Target-ID: main-reconcile
Branch: chore/main-reconcile
Base: `origin/main@b9f3ddfa88b3e8942d0dd095f1dcaeb4c979d451`
Implementation SHA: `c5a4b7e56971c943adeaaac84ab0a18242a312ba`

## What

- Built one clean integration branch from canonical GitHub `main@b9f3ddf`; local `main` and all source worktrees remain untouched.
- Replayed the independently approved Skill Tests/OpenSandbox retirement, AppShell and management pages, light/dark themes and line icons, the approved theme-toggle terminal position, and the Redis-versus-SQLite chat-storage evaluation.
- Preserved the F001 cursor-pagination and F002 pinned Pi SDK host behavior already present on canonical main.
- Added two reconciliation-only compatibility fixes: Feishu's coding-mode expectation now includes the mandatory dynamic `skill-creator`, and string participant IDs are preserved when mode skills are merged.
- Kept unreviewed runtime/session history and stale/superseded branches outside this integration.

## Why

The operator asked whether CAFF still had code that had not reached `main`, then asked us to organize it. The repository had two different concepts called main: canonical GitHub `origin/main@b9f3ddf`, which already contained F001/F002, and a local `main@7bd6511`, whose ancestry also contained an unreviewed runtime/session bundle. Moving or merging the local branch wholesale would therefore import code without bundle-level review provenance.

This reconciliation selects reviewed logical bundles, resolves only their actual integration deltas, and leaves every uncertain branch available for a separate review instead of hiding it inside a broad merge.

## Original Requirements

> “已经完成了，目前CAFF还有其他没合入main的代码吗”
>
> “好，整理一下吧”

Operational interpretation recorded in `feature-specs/2026-07-29-main-reconciliation.md`:

1. Treat GitHub `origin/main`, not the movable local `main`, as canonical.
2. Bring in completed and independently approved CAFF work.
3. Do not import unreviewed ancestry merely because another local branch contains it.
4. Preserve F001 pagination and F002 SDK-host behavior already on canonical main.
5. Keep obsolete, superseded, and still-unreviewed work visibly classified rather than silently dropping or merging it.
6. Require an independent final review of the frozen integration SHA before merge.

Reviewer: judge both correctness of the combined tree and whether the inclusion/exclusion boundary matches this operator intent.

## Provenance and Scope

| Bundle | Reviewed source | Reconciliation action |
|---|---|---|
| Skill Tests retirement | `4560d3e` | Replayed the four approved logical commits; retained normal chat/Pi behavior and removal guards |
| AppShell + management pages | through `3087ef8` | Replayed approved UI commits with semantic conflict resolution around F001 paths |
| Themes/icons + toggle position | approved behavior through `7bd6511` | Replayed implementation; excluded later docs-only `092ffed` |
| Chat-storage evaluation | implementation/review through `feeb074` | Replayed evaluation-only harness and verdict; no production adapter |
| F001/F002 | canonical `origin/main@b9f3ddf` | Preserved as the base; no wholesale replacement from local main |
| Reconciliation deltas | `8faadeb`, `a4f8cc1`, `c5a4b7e` | Required-skill test alignment, string participant regression fix, diff hygiene |

## Explicit Exclusions / Remaining Unmerged Work

| Item | Evidence | Classification |
|---|---|---|
| Runtime/session bundle on `feat/model-observability-model-calls` | 13 commits ending at `1cd4b55`; that head is not an ancestor of this branch | Still unreviewed as a bundle; requires a separate feature review before import |
| Old deployability stack | `a691567`, `f41f16c`, `f91a777`, `70623e2`, `93ba9cc` | Potentially useful but stale; needs fresh applicability/security review |
| Old Skill Tests feature branches | multiple `feat/skill-test-*` branches | Obsolete after the approved module retirement; do not revive by branch merge |
| `fix/theme-toggle-position@092ffed` | docs-only request after approved `7bd6511` behavior | Superseded; no additional implementation to import |
| Production Redis/SQLite integration | absent from the selected diff | Explicit non-goal; evaluation results do not authorize a migration |

Raw `git cherry` counts are not accepted as the decision source because squash merges, replayed commits, and conflict-resolution commits create false remaining results.

## Tradeoff

- The branch is large because it reconciles several previously reviewed bundles, but each source bundle remains separately identifiable in history.
- Old worktrees and branches are deliberately retained until canonical merge and isolated acceptance complete; cleanup now would destroy useful provenance.
- The storage benchmark is included as evidence/tooling only. SQLite remains CAFF's durable runtime source of truth.
- The final reviewer must inspect the reconciliation boundary and the two compatibility fixes, not redo every already-approved component review from zero. Component provenance remains available in existing `review-notes/` files.

## Architecture Ownership

Architecture cell: none
Map delta: none
Why: this branch reconciles already-approved feature boundaries. It adds no new production Store, Queue, Router, Adapter, Dispatcher, or Binding and does not change runtime storage ownership.

Reviewer checks:

- Confirm the chat-storage adapters remain under the evaluation harness and are not wired into production runtime.
- Confirm conflict resolutions did not create a parallel pagination, skill-loading, or shell ownership path.
- Confirm `Map delta: none` matches the combined diff.

## Open Questions

### Technical OQ

1. Does the final tree preserve F001's bounded latest/before cursor path, stable prepend behavior, and scroll ownership after AppShell integration?
2. Does the final tree preserve F002's pinned SDK-host execution path without reintroducing global Pi CLI resolution or removed Skill Tests sandbox plumbing?
3. Is `a4f8cc1` correct for all supported participant shapes: string IDs survive, object participants retain their fields, and mode skills are merged without duplicates?
4. Is `8faadeb` a faithful test correction for the mandatory dynamic `skill-creator`, rather than masking a runtime regression?
5. Are all Skill Tests/eval-cases/OpenSandbox production entry points removed while legacy data remains non-destructively preserved?
6. Is the chat-storage evaluation isolated from configured CAFF data and reserved Redis ports 6398/6399?
7. Are any excluded runtime/session or stale deployability changes accidentally present through conflict resolution rather than ancestry?

### Value OQ

None. Importing any excluded bundle remains a separate decision and review, not part of this merge.

## Next Action

Perform formal cross-family, read-only review of implementation SHA `c5a4b7e`. Return `APPROVE`, `REQUEST-CHANGES`, or `COMMENT` with the reviewed SHA, independent commands, and findings-first evidence. Prior component approvals establish provenance but do not replace review of the combined tree and new compatibility deltas.

## Review Sandbox

- Path: `C:\Users\ZN\AppData\Local\Temp\cat-cafe-review\main-reconcile\opus`
- Bootstrap: remove inherited `NODE_ENV=production`, then run `npm ci --include=dev`
- Ports: do not use reserved 3003/3004; `npm run test:ui` allocates an isolated dynamic loopback port
- Redis: never use 6399; the evaluation harness rejects 6398/6399 and starts its own dynamic-port process
- Source worktrees: read-only inputs; do not delete or reset them during review

## Quality Gate Report

Spec: `feature-specs/2026-07-29-main-reconciliation.md`
Checked: 2026-07-29 on `c5a4b7e`

### Spec Compliance

| AC | Evidence | Status |
|---|---|---|
| Exact canonical base and F001/F002 preservation | `b9f3ddf` is an ancestor; targeted pagination and Pi runtime suites pass | Pass |
| Reviewed Skill Tests retirement | removal guards 15/15; deleted entry points remain absent | Pass |
| Approved UI stack through toggle positioning | component provenance plus current 109/109 isolated browser gate | Pass |
| Approved chat-storage evaluation | contract 18/18 and quick live SQLite/Redis run | Pass |
| Exclude unreviewed runtime/session bundle | `1cd4b55` is not an ancestor; no wholesale local-main merge | Pass |
| Repository and integration verification | check, build, typecheck, fast/smoke, UI, evaluation, targeted suites, diff check | Pass |
| Independent final review | this request; not yet satisfied | Pending reviewer |

### Fresh-Context Findings

The first fresh-context attempt scanned the wrong worktree, `E:\pythonproject\caff@1cd4b55`, and reported two findings in the explicitly excluded runtime/session bundle. Both are dismissed for this review target because neither file delta is present in `caff-main-reconcile@c5a4b7e`. A corrected follow-up could not be transmitted reliably across the agent boundary, so no valid fresh-context finding is claimed. This is not approval evidence; the named reviewer must inspect the actual target independently.

### Dogfood-Your-Slice

Scope verdict: required because the reconciled branch contains user-visible UI.

End-to-end path: `npm run test:ui` built the target checkout, started an isolated app on a dynamic loopback port, exercised chat plus four management routes at desktop/820/375 widths and both themes, created/deleted verification conversations, and checked console/page/network errors.

Result: `109/109 PASS`; cleanup reported zero verification-conversation residue. No reserved Clowder runtime port was used.

Prior visual evidence remains in `review-notes/2026-07-25-caff-ui-theme-icons-close-gate.md`: author 3 PNG + 1 WebM, guardian viewport/theme screenshots, cross-individual code approval, and vision approval. Reconciliation introduced no intentional visual delta.

### Verification

```text
npm run check                         exit 0
npm run build                         exit 0
npm run typecheck                     exit 0
npm test                              fast + smoke exit 0
npm run test:ui                       109/109 pass
npm run eval:chat-storage:test        18/18 pass
npm run eval:chat-storage:quick       exit 0; temp JSON written

tests/storage/chat-store.test.js                    17/17 pass
tests/runtime/pi-runtime.test.js                    16/16 pass
tests/runtime/skill-tests-removal-guards.test.js    15/15 pass
tests/ui/app-shell.test.js                          14/14 pass
tests/ui/management-shell.test.js                    9/9 pass
tests/ui/theme-icons.test.js                        16/16 pass

git diff --check origin/main...HEAD    exit 0
base ancestry                         pass
root media/design artifact gate       clean
*.pen scan                             clean
```

Environment note: this machine inherits `NODE_ENV=production`; reviewers must remove it or use `npm ci --include=dev`, otherwise `playwright-core` is omitted and UI verification cannot start.

### Branch Boundary Evidence

```text
base-main ancestor                    true
excluded-runtime-head ancestor        false
superseded-theme-position ancestor    false
conversation-project paths in diff    none
production Redis integration paths    none
```

## Related Documents

- Plan and provenance ledger: `feature-specs/2026-07-29-main-reconciliation.md`
- AppShell review: `review-notes/2026-07-24-caff-app-shell-review-request.md`
- Management review: `review-notes/2026-07-25-caff-management-app-shell-review-request.md`
- Theme/icon close gate: `review-notes/2026-07-25-caff-ui-theme-icons-close-gate.md`
- Storage evaluation review/verdict: `review-notes/2026-07-28-chat-storage-evaluation-review-request.md`, `review-notes/2026-07-28-chat-storage-evaluation-verdict.md`

[砚砚/gpt-5.6-sol🐾]
