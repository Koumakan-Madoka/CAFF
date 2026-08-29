# Trellis Ledger Convergence

## Goal

Converge CAFF's legacy process-document directories and stale Trellis task ledger so the current tree keeps only traceable task archives, accurate statuses, and explicit truth sources.

## Scope

- Inventory `review-notes/`, `feature-discussions/`, `project-evidence/`, `project-reflections/`, and `feature-specs/` against Git history and current documentation.
- Condense durable historical value into task-oriented archives under `.trellis/tasks/archive/` instead of moving every source file verbatim.
- Remove raw screenshots, videos, measurements, repeated review exchanges, and superseded plans from the current tree while retaining their Git-history provenance.
- Reconcile all legacy top-level `.trellis/tasks/` entries against `develop` commits and archived follow-up tasks.
- Repair live documentation, test, and script references to removed process directories.
- Define durable repository rules for task archives, current specifications, and ephemeral evidence.

## Non-Goals

- No business-source cleanup, dependency cleanup, package-manager cleanup, or local untracked-file cleanup.
- No Git history rewriting; removed files remain recoverable from their original commits.
- No application behavior, database, production process, port, credential, or external-system changes.
- No claim that a task completed unless `develop` history or an accepted archived child task proves delivery.

## Status Rules

- `completed`: the task's stated deliverable exists on `develop`, with exact commit evidence.
- `superseded`: the original task was replaced by a later task or split into archived child deliveries; the replacement is named.
- `abandoned`: no delivery evidence exists and the task is no longer intended to continue.
- Historical planning-only tasks may be `completed` when their explicit deliverable was the plan itself.

## Acceptance Criteria

- [x] The five legacy root process directories no longer exist in the current tree.
- [x] Each condensed archive identifies source directories/files, final status, delivery commits, current truth sources, and Git-history recovery instructions.
- [ ] `.trellis/tasks/` contains no stale historical tasks after this task is archived.
- [x] Live docs, tests, and scripts have no links or runtime dependencies on the five removed root directories; governance and Git-history prose may still name them.
- [x] Durable rules prohibit new root process-document directories and keep raw evidence under ignored temporary or CI artifact storage.
- [x] Markdown links, JSON/JSONL syntax, repository reference sweeps, targeted tests, and applicable project checks pass.
- [ ] An independent model reviews the exact final commit and all findings are resolved or explicitly accepted.

## Execution Mode

Goal mode. The work is sequential but spans historical research, task migration, reference repair, validation, and exact-commit independent review.
