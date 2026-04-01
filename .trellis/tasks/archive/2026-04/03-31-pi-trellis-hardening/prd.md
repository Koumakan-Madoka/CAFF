# PRD: pi Trellis hardening

## Goal

Raise the Trellis integration quality for CAFF's pi-mono runtime so the repo has
project-specific spec indexes, a real active task, and less leftover bootstrap
state.

## Requirements

- Replace the placeholder `.trellis/spec/index.md` with CAFF-specific guidance
- Add spec indexes for backend, frontend, runtime, and tests
- Make the active task list reflect real work rather than leaving the demo task
  as the main active task
- Keep the changes aligned with CAFF's current Trellis scope:
  prompt context injection plus `.trellis` read/write tools for pi-mono agents

## Acceptance Criteria

- [x] `.trellis/spec/index.md` describes CAFF's actual repo structure
- [x] Relevant area indexes contain usable pre-development checklists
- [x] A real Trellis task exists for this integration hardening work
- [x] The demo task is no longer the primary active task

## Technical Notes

- Do not add Codex- or Claude-specific compatibility files as part of this task
- Prefer documentation and task-state hardening over expanding runtime surface
  area
