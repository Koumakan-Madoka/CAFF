# PRD: session-goal

## Goal
- Port Codex-style `/goal` behavior into CAFF as a lightweight session goal for a multi-agent conversation.

## Requirements
- Support `/goal` in the chat composer without sending it as a normal user message.
- Allow `/goal <objective>` to create or replace the active session goal.
- Allow `/goal pause`, `/goal resume`, `/goal complete`, and `/goal clear` to manage the goal lifecycle.
- Persist the goal in conversation metadata so it survives reloads and is included in conversation summaries.
- Inject the current non-cleared goal into agent prompts so replies can stay aligned with the user’s target.
- Show concise UI feedback/status for the current goal and slash command results.
- Provide a right-side chat UI goal panel for mouse-driven create/replace, read, pause, resume, complete, and clear actions.
- Allow agents to create pending goal lifecycle proposals, while requiring user confirmation before any goal state changes.
- Automatically continue active goals through bounded background turns until completion/proposal, pause, clear, or safety budget.
- Support an optional subtask checklist on the session goal and visualize completion progress in the right-side goal panel.
- Default bounded auto-continuation safety budget should be 20 turns.

## Out of Scope
- Full Codex token-budget accounting or unbounded `budget_limited` behavior.
- Direct model-side goal mutation without user confirmation.
- Database schema changes beyond existing conversation metadata storage.

## Technical Notes
- Store the goal under `conversation.metadata.sessionGoal`.
- Store pending agent proposals under `conversation.metadata.sessionGoalProposal`.
- Store bounded auto-continue progress under `conversation.metadata.sessionGoalRunner`.
- Goal shape: `{ objective, status, createdAt, updatedAt, completedAt?, checklist? }`.
- Checklist item shape: `{ id, text, status: 'todo' | 'in_progress' | 'done', createdAt, updatedAt, completedAt? }`.
- Proposal shape: `{ action, status: 'pending', objective?, reason?, proposedBy, createdAt, updatedAt }`.
- Runner shape: `{ status, goalUpdatedAt, iteration, maxIterations, updatedAt, lastContinuedAt? }`.
- Supported statuses: `active`, `paused`, `complete`.
- Add a focused conversation goal domain helper and keep HTTP route parsing thin.
- Add regression coverage for goal API behavior and prompt injection.
- Reuse the same `/api/conversations/:id/goal` endpoint from both slash commands and the UI panel.
- Expose an agent-only `suggest-goal` bridge command that records a proposal but never applies it directly.
- Auto-continuation should schedule transparent `Goal Runner` user turns and stop when a pending proposal exists.
- Agent bridge should allow factual checklist progress updates without directly changing goal lifecycle status.

## Acceptance Criteria
- [x] `/goal` displays the current goal status or an empty-state message.
- [x] `/goal <objective>` persists an active goal and returns updated conversation data.
- [x] `/goal pause|resume|complete|clear` updates metadata and UI state correctly.
- [x] Active, paused, or completed non-cleared goals are included in agent prompt context with status-specific guidance; cleared goals are not.
- [x] Conversation summaries expose updated goal metadata after slash commands.
- [x] Tests cover API lifecycle, agent proposals, and prompt injection behavior.
- [x] Chat UI exposes a goal management panel that stays synced with selected conversation metadata and SSE refreshes.
- [x] Agent-created proposals appear in the goal panel and require user confirm/dismiss before affecting `sessionGoal`.
- [x] Setting or resuming an active goal starts bounded auto-continuation when the conversation is idle.
- [x] Auto-continuation stops on pending proposal and creates a pause proposal when the safety turn budget is reached.
- [x] Goal panel shows checklist items and a completion progress bar when subtasks exist.
- [x] Agent prompt includes checklist progress and exposes a bridge command to keep it current.
