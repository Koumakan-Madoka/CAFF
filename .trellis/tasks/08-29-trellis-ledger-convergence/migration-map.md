# Migration Map

## Inventory Baseline

The legacy root process-document system contained 111 tracked files:

| Source directory | Tracked files | Disposition |
| --- | ---: | --- |
| `review-notes/` | 53 | Condensed to final review/acceptance outcomes; request/response chains removed. |
| `feature-discussions/` | 22 | Final decisions retained; screenshots and measurement JSON removed. |
| `project-evidence/` | 19 | Commands/results summarized; 13 PNG/WebM artifacts removed from the current tree. |
| `project-reflections/` | 3 | Reusable conclusions folded into task summaries or current rules. |
| `feature-specs/` | 14 | Current contracts kept in `docs/features/` or `.trellis/spec/`; superseded plans removed. |

All source bytes remain in Git history. Exact recovery uses `git log --all -- <path>` followed by `git show <commit>:<path>`.

## Legacy Process Material To Trellis Archives

| Historical task | Legacy source patterns | Delivery evidence | Current truth source |
| --- | --- | --- | --- |
| `07-25-caff-ui-foundation` | UI management/theme specs; app-shell/theme review notes; theme reflection | `a26a2a7`, integrated by `7a73aad` | `.trellis/spec/frontend/ui-structure.md`, UI code/tests |
| `07-28-chat-storage-evaluation` | Chat-storage spec and review pair | approved target `2718dd1` | `docs/evaluations/chat-storage/2026-07-28-verdict.md` |
| `07-28-f001-long-conversation-pagination` | F001 specs, reviews, evidence, browser media, reflection | `241a42e`, closure `968e7e5` | `docs/features/F001-long-conversation-cursor-pagination.md` |
| `07-28-f002-pi-sdk-host-migration` | SDK-host review request and F002 quality gate | `6e6af44`, closure `b9f3ddf` | `docs/features/F002-pi-sdk-host-migration.md`, runtime spec |
| `07-29-caff-ui-m4` | M4 discussion tree, measurements, screenshots, Clowder-experience spec | `7a73aad` | frontend spec, M4 code/tests |
| `07-29-main-reconciliation` | Main reconciliation plan/review | `7a73aad`, truth sync `77d7211` | Git history plus M4/model-family archives |
| `08-03-model-family-roles` | Model-family discussions/specs, 15 review packets, evidence/media, reflection | `4bbc260`, closure `454f828` | model-provider/runtime/frontend specs and tests |
| `08-04-orphan-pr-reconciliation` | Orphan PR plan/review | `0231d0c`, closure `1485dde` | health/readiness spec, package/CI code/tests |
| `08-05-f003-cross-conversation` | F003 discussion/design/plan and UI review chain | `e030fe8`, sync `092938a` | `docs/features/F003-cross-conversation-delivery-pi-mcp-bridge.md` |
| `08-06-f004-models-dev-catalog` | F004 kickoff/plan and review/quality packets | PRs #57-#61 (`3350b38` through `9ca33d1`) | F004 feature doc and model-provider spec |
| `08-09-f005-multimodal-and-provider-followups` | F005 discussion/UI plan, provider review pairs, F005 repair reviews | `eb96a4f`, `92d8225`, `9f5319d`, `6daeaff`, `fe35b24`, `0dea0f4`, `6d481de` | F005 feature doc, runtime/model-provider specs and tests |

## Stale Top-Level Trellis Tasks

Status was derived from `develop@ae8f6f86e13c1445734c4870a8ffabcdac3af754`, task PRDs/JSONL records, and archived follow-up tasks.

| Former top-level task | Recorded status | Corrected status | Evidence and rationale |
| --- | --- | --- | --- |
| `05-11-pi-mono-digest-tool-use` | active | completed | Delivered by `2fe879a`; PRD acceptance and JSONL records were already complete. |
| `05-12-model-observability-model-calls` | active | completed | Delivered by `f63d699`; current runtime still contains the timeline. |
| `08-16-agent-stall-watchdogs` | planning | completed | Task changes and tests were included in consolidated delivery `33d3894`. |
| `08-17-model-token-limits-ui` | review | completed | Model limits, catalog mapping, UI, and tests were delivered by `33d3894`. |
| `dag-execution` | discussion | completed | DAG planning/execution and tests were delivered by PR #72, `33d3894`. |
| `08-18-room-project-mode-workspace` | review | completed | Candidate `188d7f9` was independently approved; develop integration is `74a62d5`. |
| `08-20-session-failure-summary` | planning | completed | Delivered by `47f897a`. |
| `08-24-develop-oom-remediation-plan` | planning | completed | The explicit planning-only deliverable completed in `a2d3713`, `3d8e744`, and `a9f9eec`; implementation lives in separately archived P0/P1/P2 tasks. |
| `08-26-recovery-capsule-mvp` | planning | completed | Delivered across `78f4684` through `8244452`, including follow-up eligibility and output-budget repairs. |

No task was marked completed solely because code with a similar name exists. No remaining item lacked enough evidence to require `superseded` or `abandoned`.

## Live Reference Migration

- F001-F004 feature docs now link to one Trellis archive summary each.
- The F002 quality-gate reference now points to its task archive.
- The model-family UI gate now reads `.trellis/spec/frontend/model-family-management.md`, not historical process documents.
- M4 measurement scripts default to ignored `.tmp/ui-evidence/caff-ui-m4/` paths.
- Historical bug/harness documents retain Git-history provenance without live links into deleted directories.

## Persistence Rule

`AGENTS.md` and `.trellis/workflow.md` now define three storage classes:

1. Current truth: `.trellis/spec/` or `docs/`.
2. Task lifecycle: `.trellis/tasks/<task>/`, then `.trellis/tasks/archive/<year-month>/`.
3. Raw media/logs/measurements: ignored `.tmp/` or CI artifacts.

Root-level process-document directories are prohibited.
