# Optimize skill test dynamic stop and live trace UI

## Goal

Make dynamic-mode skill evaluation focus on one thing only: whether the evaluated agent correctly loads the target skill. Once the target skill load is confirmed, the run should stop immediately instead of continuing the downstream workflow. In parallel, improve the skill testing workspace so evaluators can see the tested agent's live tool activity and outputs while the run is in progress.

## Requirements

- Dynamic mode must treat successful loading of the target `SKILL.md` as the primary success condition.
- When dynamic mode detects the expected skill load evidence, it must stop the running agent loop immediately instead of waiting for the full skill workflow to complete.
- Existing full-mode behavior must remain unchanged.
- Legacy dynamic execution cases must keep their current semantics unless they explicitly depend on the new load-only stop behavior.
- The skill testing frontend must surface live tool invocation state for the currently running agent, including at least current tool name, tool arguments or summarized input, and visible output or result summaries when available.
- The frontend change should reuse existing chat workbench tool-trace UI/state patterns where practical instead of duplicating a second implementation.
- Completed run diagnostics must remain available after the run ends.

## Acceptance Criteria

- [ ] A dynamic-mode run marks trigger success as soon as the target `read` on the expected `SKILL.md` path is observed.
- [ ] A dynamic-mode run stops promptly after that success signal and does not continue collecting irrelevant post-load workflow steps.
- [ ] A dynamic-mode run that never loads the correct skill still finishes with the existing failure diagnostics.
- [ ] Full-mode runs still execute end-to-end and keep their current verdict semantics.
- [ ] The skill test UI shows live tool activity for an active run and finalizes the trace when the run completes or fails.
- [ ] The implementation reuses existing trace rendering/state patterns from the chat workspace where feasible, rather than copy-pasting a separate trace system.
- [ ] Regression coverage exists for dynamic early-stop behavior and any new live-trace payload/UX contracts.

## Non-Goals

- Do not redesign the entire eval/skill testing workspace.
- Do not change the core definition of full-mode execution scoring.
- Do not broaden dynamic mode into a second execution-quality judge.

## Technical Notes

- Likely backend entry point: `server/api/skill-test-controller.ts`.
- Likely runtime/cancel touchpoints: `lib/pi-runtime.ts`, `server/domain/conversation/turn/agent-executor.ts`, and related tool-event plumbing.
- Likely UI reuse candidates: `public/chat/message-timeline.js`, `public/app.js`, and `server/domain/runtime/message-tool-trace.ts`.
- This is a cross-layer task spanning runtime, backend, frontend, and tests, so contracts for tool events and run detail payloads need to stay aligned.
