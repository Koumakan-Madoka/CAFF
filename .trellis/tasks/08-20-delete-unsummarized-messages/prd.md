# Delete Unsummarized Conversation Messages

## Goal

Allow a user to permanently delete one or more eligible public messages from the current conversation while preserving digest provenance, runtime safety, cross-conversation integrity, and consistent UI/prompt/storage state.

## Orchestration

- Mode: Goal
- Reason: the change is sequential but spans SQLite storage, digest concurrency, turn lifecycle, HTTP/SSE contracts, frontend interaction, attachments, and regression coverage.

## Requirements

### Eligibility

- Only public `user` messages and terminal `assistant` messages may be selected.
- Terminal assistant statuses are `completed` and `failed`.
- `system`, `external_agent`, private, queued, and streaming messages are not deletable.
- A message covered by the latest digest boundary is never deletable.
- A message participating in cross-conversation delivery, whether detected by metadata or relational references, is never deletable.
- Deletion is allowed only while the conversation is fully idle: no active or dispatching turn, queued main-lane or side-lane work, active agent slot, scheduled/running digest, or conflicting conversation mutation.

### Deletion Semantics

- Support a single-message action and an explicit multi-select mode.
- Require user confirmation before every deletion request.
- Delete the selected message rows permanently; no tombstone, undo, or recycle bin.
- Batch deletion is atomic. If any selected message fails validation at commit time, delete none and return structured per-message reasons.
- Do not automatically delete paired user/assistant messages or later messages.
- Do not revert files, commits, Goal/DAG state, tool side effects, private messages, or external operations.
- Deleting a message with attached images removes its image database records in the same database transaction, then removes its dedicated disk batches after commit. Disk cleanup failure is logged for retry and does not falsify database rollback.

### Concurrency

- Auto digest, manual digest, and message deletion share one conversation-scoped mutation guard.
- A deletion request never waits for a long digest run; it returns `409` with a stable reason and retry guidance.
- Eligibility and idle state are checked again inside the authoritative server operation immediately before the transaction.
- Turn dispatch must not race between idle validation and deletion. The runtime exposes one authoritative mutation-idle check/guard rather than duplicating partial state checks in the controller.

### API And Events

- Add an authenticated conversation-scoped batch endpoint accepting a non-empty, de-duplicated `messageIds` array with a bounded maximum.
- Success returns only deleted identifiers and cleanup state; it never echoes message content.
- Validation failures use stable reason codes including invalid selection, not found, role/status not deletable, summarized, cross-conversation, conversation busy, digest running, and attachment cleanup warning.
- Broadcast a deletion event containing conversation and deleted message IDs only.
- Recompute conversation `last_message_at`, sidebar preview inputs, and digest pending metadata after deletion.

### UI

- Eligible messages expose a hover/focus delete action using the existing icon library and an accessible label/tooltip.
- Touch and keyboard users can reach the same action without hover.
- Multi-select mode uses checkboxes, a stable selected count, delete command, and cancel command.
- Ineligible messages are not silently accepted; selection controls are disabled or omitted with a discoverable reason where appropriate.
- The confirmation dialog states the exact count, permanence, lack of side-effect rollback, and attachment deletion when relevant.
- Success removes the messages through the normal conversation refresh path. Conflict/error responses keep the selection and explain why nothing was deleted.

## Non-Goals

- Deleting summarized messages or rebuilding/invalidating existing digests.
- Deleting private, system, external-agent, or cross-conversation messages.
- Cascading to related chat messages or undoing code/external effects.
- Interrupting an active Agent to make deletion possible.
- Soft deletion, restoration, moderation/audit retention, or cross-device offline conflict resolution.
- Recomputing a conversation title when its first user message is deleted.

## Contract Matrix

| Case | Result |
| --- | --- |
| One eligible unsummarized user message in an idle conversation | `200`, message and owned attachment records removed |
| Eligible completed/failed assistant message | `200`, message removed without side-effect rollback |
| Any selected ID is summarized, cross-conversation, missing, wrong role/status, or from another conversation | `409`/`422`, entire batch preserved, structured reasons |
| Conversation gains active/queued/side-lane/digest work before commit | `409`, entire batch preserved |
| Disk attachment cleanup fails after DB commit | `200` with cleanup warning, durable retry/log evidence |
| Repeated request after successful deletion | Clean not-found/conflict response, no unrelated deletion |

## Acceptance Criteria

- [x] Single-message deletion and multi-select deletion work from the public timeline with confirmation.
- [x] Only unsummarized `user` and terminal `assistant` messages are deletable.
- [x] Summarized, running, system, external, private, and cross-conversation messages are rejected server-side.
- [x] Any invalid member makes a batch deletion fully atomic with zero rows removed.
- [x] Active/queued/side-lane Agent work and scheduled/running digest work block deletion without race windows.
- [x] Auto digest, manual digest, and deletion cannot concurrently mutate the same conversation range.
- [x] Attached image rows are removed transactionally and dedicated files are cleaned after commit with failure logging/retry semantics.
- [x] Deleted messages disappear from refreshed UI, future prompts, pagination, sidebar preview, and digest pending calculations.
- [x] `last_message_at` falls back correctly when the newest message is deleted.
- [x] Deletion survives server restart and SSE payloads/telemetry do not expose deleted content.
- [x] Focus, keyboard, touch, confirmation, conflict, and multi-select states have UI regression coverage.
- [x] Relevant runtime, digest, cross-conversation, storage, controller, and UI suites remain green.
- [x] `npm run check`, `npm run typecheck`, `npm run build`, and `git diff --check` pass.
- [ ] A non-author reviews the exact implementation commit before user acceptance.

## Code-Spec Targets

- `.trellis/spec/backend/`: storage/controller transaction and error contracts.
- `.trellis/spec/runtime/`: conversation idle state, digest mutual exclusion, prompt/digest visibility.
- `.trellis/spec/frontend/`: message timeline selection, confirmation, refresh, and accessibility contracts.
- `.trellis/spec/unit-test/`: storage, runtime concurrency, API, and UI regression patterns.

## Initial Test Plan

1. Prove summarized boundary rejection, including exact-boundary and timestamp fallback cases.
2. Prove role/status and cross-conversation restrictions, including database FK fallback.
3. Prove batch rollback when any selected item is invalid.
4. Prove active turn, queued turn, active slot, side-lane queue, scheduled/running digest, and mutation lock each reject deletion.
5. Prove attached-image row deletion, post-commit disk cleanup, and cleanup failure reporting.
6. Prove newest-message deletion recomputes `last_message_at`, page cursors remain stable, and pending digest metadata refreshes.
7. Prove future prompts and restarted stores omit deleted messages.
8. Prove SSE contains IDs only and UI single/multi-select flows remain accessible and coherent.
