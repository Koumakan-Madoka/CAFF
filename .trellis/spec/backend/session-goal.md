# Session Goal

## Scenario: Conversation Session Goal

### 1. Scope / Trigger
- Trigger: implementing or modifying `/goal` behavior for CAFF conversations.
- Applies when changes touch conversation metadata, `/api/conversations/:id/goal`, prompt assembly, SSE refresh, or chat composer slash handling.
- Goal: keep a lightweight user-defined completion target available to the UI and agents, with bounded automatic continuation for active goals.

### 2. Signatures
- `GET /api/conversations/:conversationId/goal`
  - Response: `{ conversation, goal, cleared, summary, conversations }`
- `POST /api/conversations/:conversationId/goal`
  - Request: `{ action: 'set', objective: string, checklistText?: string, checklist?: SessionGoalChecklistItem[] } | { action: 'update-checklist', checklistText?: string, checklist?: SessionGoalChecklistItem[] } | { action: 'pause' | 'resume' | 'complete' | 'clear' | 'get' | 'accept-proposal' | 'dismiss-proposal' }`
  - Response: `{ conversation, goal, proposal, cleared, autoContinuation?, summary, conversations }`
- Agent bridge command:
  - `suggest-goal --action set|pause|resume|complete|clear [--objective "..."] [--reason "..."]`
  - Writes a pending proposal only; it never mutates `sessionGoal` directly.
  - `update-goal-checklist --content-stdin` writes factual checklist progress lines such as `[ ] todo`, `[~] doing`, and `[x] done`.
- Conversation metadata field:
  - `conversation.metadata.sessionGoal?: { objective: string, status: 'active' | 'paused' | 'complete', createdAt: string, updatedAt: string, completedAt?: string, checklist?: { id: string, text: string, status: 'todo' | 'in_progress' | 'done', createdAt: string, updatedAt: string, completedAt?: string }[] }`
  - `conversation.metadata.sessionGoalProposal?: { action: 'set' | 'pause' | 'resume' | 'complete' | 'clear', status: 'pending', objective?: string, reason?: string, proposedBy: { agentId: string, agentName: string }, createdAt: string, updatedAt: string }`
  - `conversation.metadata.sessionGoalRunner?: { status: 'running' | 'budget_limited' | string, goalUpdatedAt: string, iteration: number, maxIterations: number, updatedAt: string, lastContinuedAt?: string }`
- Browser slash commands:
  - `/goal` reads the selected conversation metadata and displays current status.
  - `/goal <objective>` sends `action: 'set'`.
  - `/goal pause|resume|complete|clear` sends the matching action.
- Browser goal management panel:
  - `public/chat/session-goal-panel.js` renders the selected conversation goal, checklist progress, and pending proposal from metadata.
  - Save sends `{ action: 'set', objective, checklistText }`; empty new-goal forms prefill the Trellis long-task checklist and expose a one-click preset restore button.
  - Pause/resume/complete/clear buttons send the same lifecycle actions as slash commands.
  - Confirm/ignore proposal buttons send `{ action: 'accept-proposal' }` or `{ action: 'dismiss-proposal' }`.

### 3. Contracts
- Store the goal under `conversation.metadata.sessionGoal`; do not add a dedicated table unless the feature grows beyond one current goal per conversation.
- Keep controllers thin: route parsing belongs in `server/api/conversations-controller.ts`; lifecycle rules belong in `server/domain/conversation/session-goal.ts`.
- `set` must trim and validate `objective`, create an `active` goal, preserve `createdAt` when replacing an existing goal, refresh `updatedAt`, remove stale `completedAt`, and normalize optional checklist lines/items.
- `set` without explicit checklist input must seed a Trellis long-task checklist covering multi-agent brainstorm, Trellis task/PRD creation, Trellis/spec validation, `before-dev`, implementation, tests, quality checks, `update-spec`, `finish-work`, and Trellis archive/session recording.
- `pause`, `resume`, and `complete` require an existing goal; `complete` adds `completedAt`, while `pause`/`resume` remove stale `completedAt`.
- `clear` removes `sessionGoal`, stale `sessionGoalProposal`, and stale `sessionGoalRunner` from metadata instead of leaving empty objects.
- Setting or resuming an active goal may schedule bounded automatic continuation through transparent `Goal Runner` user messages.
- Automatic continuation must not run while a conversation is busy, while user messages are queued, while the goal is paused/complete/cleared, or while any proposal is pending.
- The runner increments `sessionGoalRunner.iteration` per automatic continuation and creates a pending pause proposal when `maxIterations` is reached; default max is 20 unless `CAFF_SESSION_GOAL_AUTO_CONTINUE_MAX_TURNS` overrides it.
- Agents may propose lifecycle changes via `suggest-goal`; the proposal is stored as `sessionGoalProposal` and must wait for user confirmation.
- Accepting a proposal applies the proposed action through the same domain state machine and clears `sessionGoalProposal`; dismissing only clears the proposal.
- Prompt assembly injects a `Session goal:` section when metadata contains a valid objective or pending proposal, including checklist progress when present.
- Frontend slash handling must intercept `/goal...` before optimistic user-message rendering so slash commands are not persisted as chat messages.
- Frontend UI management must reuse shared `public/shared/session-goal.js` helpers for goal lookup, labels, and objective text so the composer, metadata line, and drawer do not drift.
- The goal panel must call the same `submitGoalCommand`/`POST /goal` path as slash commands; do not introduce a second persistence path for user-confirmed mutations.
- `POST` updates should broadcast `conversation_goal_updated` or `conversation_goal_cleared` plus `conversation_summary_updated` so other clients can refresh.
- Checklist-only updates should broadcast `conversation_goal_updated` but must not schedule another auto-continuation by themselves.
- Proposal writes/clears should broadcast `conversation_goal_proposal_updated` or `conversation_goal_proposal_cleared` plus `conversation_summary_updated`.

### 4. Validation & Error Matrix
| Operation | Condition | Expected result |
| --- | --- | --- |
| `GET /goal` | conversation exists without goal | `200`, `goal: null`, `cleared: false` |
| `POST /goal set` | objective is empty after trim | `400 Goal objective is required` |
| `POST /goal set` | objective is longer than 2000 chars | `400 Goal objective must be 2000 characters or fewer` |
| `POST /goal set` | checklist is omitted | `200`, goal stores the default Trellis long-task checklist |
| `POST /goal pause` | no existing goal | `404 No session goal is set` |
| `POST /goal resume` | existing paused/complete goal | `200`, goal status becomes `active`, stale `completedAt` is removed |
| `POST /goal complete` | existing goal | `200`, goal status becomes `complete`, `completedAt` is set |
| `POST /goal clear` | no existing goal | `200`, metadata still has no `sessionGoal` |
| `POST /goal unknown` | unsupported action | `400 Unsupported goal action` |
| `POST /goal update-checklist` | existing goal and checklist lines | `200`, goal keeps lifecycle status and stores normalized checklist items |
| `suggest-goal complete` | existing active goal | proposal is persisted, goal remains unchanged until accepted |
| `POST /goal accept-proposal` | pending complete proposal | goal status becomes `complete`, proposal metadata is removed |
| `POST /goal dismiss-proposal` | pending proposal | proposal metadata is removed, goal remains unchanged |
| auto continuation | active goal, idle conversation, no pending proposal | creates a `Goal Runner` user message and drains the main turn queue |
| auto continuation | max runner iterations reached | creates pending `pause` proposal by `Goal Runner`, goal remains active until user confirms |

### 5. Good / Base / Bad Cases
- Good: `/goal Implement X` updates conversation metadata, summary metadata, and future prompts include `Session goal` with `Status: active` plus the default Trellis long-task checklist.
- Good: `/goal pause` keeps the objective visible but prompt guidance says not to actively drive new work until resumed.
- Good: `/goal clear` removes the metadata key and future prompts omit the entire session goal section.
- Base: `/goal` with no argument reads local selected-conversation metadata and shows a toast/status without creating a message.
- Base: the right-side goal panel reads the same selected-conversation metadata and offers mouse-driven lifecycle controls without adding new storage.
- Base: a completed goal remains visible as completed context but should not instruct agents to continue work.
- Base: an agent can suggest `complete` when it believes work is done, but the UI must show it as pending until the user confirms.
- Base: a newly set active goal starts bounded auto-continuation when the conversation is idle and agents exist.
- Base: auto-continuation stops when any proposal is pending so the user remains in control.
- Bad: allowing `/goal pause` to be sent through `POST /messages`, because it pollutes history and can trigger agents.
- Bad: making the drawer write metadata locally without the goal API, because other clients and summaries will not receive SSE refreshes.
- Bad: letting `suggest-goal` directly apply `complete`, `clear`, or `set`, because the user loses confirmation control.
- Bad: auto-continuing without a max iteration cap or while a pending proposal exists, because it can create runaway turns.
- Bad: leaving `metadata.sessionGoal = {}` on clear, because prompt/UI consumers may diverge on empty-object handling.

### 6. Tests Required
- `tests/smoke/server-smoke.test.js`
  - Set/pause/resume/complete/clear lifecycle persists expected metadata.
  - Invalid set and missing-goal state actions reject with explicit errors.
  - Goal updates broadcast goal and summary events.
  - Pending proposal accept/dismiss behavior updates metadata and broadcasts proposal events.
- `tests/runtime/agent-tool-bridge.test.js`
  - `suggest-goal` persists a pending proposal without mutating the active goal.
- `tests/runtime/agent-chat-tools.test.js`
  - CLI forwards `suggest-goal` action/reason/objective payloads to the agent tool endpoint.
- `tests/runtime/turn-orchestrator.test.js`
  - Prompt includes `Session goal` and objective for active goals.
  - Prompt includes status-specific guidance for paused and complete goals.
  - Prompt omits the section when the goal is cleared/missing.
  - Auto-continuation schedules bounded `Goal Runner` messages and creates a pending pause proposal at the safety budget.
- Manual browser validation:
  - Open the goal drawer with the chat-header `目标 ▸` button.
  - Save, pause, resume, complete, and clear a goal; verify the drawer, conversation metadata line, composer status, and toast stay in sync.
- Validation commands:
  - `npm run build`
  - `npm run check`
  - `npm run typecheck`

### 7. Wrong vs Correct
#### Wrong
```js
// Browser submit path treats slash commands as normal chat.
applyOptimisticUserMessage(conversationId, content, clientRequestId);
await fetchJson(`/api/conversations/${conversationId}/messages`, {
  method: 'POST',
  body: { content, clientRequestId },
});
```
- This persists `/goal ...` in conversation history and may start an agent turn.

#### Correct
```js
const goalCommand = parseGoalCommand(content);
if (goalCommand) {
  await submitGoalCommand(conversationId, goalCommand);
  return;
}
```
- Intercept goal commands before optimistic rendering and before `POST /messages`.

#### Wrong
```ts
metadata.sessionGoal = {};
```
- Empty objects force every consumer to guess whether a goal exists.

#### Correct
```ts
const { sessionGoal, ...remainingMetadata } = metadata;
return remainingMetadata;
```
- Clearing removes the metadata key and keeps prompt/UI checks consistent.
