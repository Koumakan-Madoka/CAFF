# PRD: 08-24-default-route-last-agent

## Goal

Route an unmentioned user message to the current conversation's most recent qualifying public-reply Agent instead of always selecting the first participant. Text routing and image capability preflight must use one shared target-resolution contract.

## Confirmed Contract

A qualifying default Agent is the Agent on the latest message, by persisted `(createdAt, id)` order, that satisfies all of the following:

- `role === 'assistant'`
- `status === 'completed'`
- `content.trim()` is non-empty
- the message is public, not `metadata.privateOnly`, `metadata.visibility === 'private'`, or another private-only projection
- `agentId` still belongs to the conversation participant roster

Private messages, private-only assistant records, queued/streaming/failed assistant records, empty silent replies, and replies from removed Agents do not become the default target.

Target priority is:

1. explicit `initialAgentIds`
2. actionable user mentions
3. most recent qualifying public-reply Agent
4. first participant fallback

The resolver reports `default_last_agent` for priority 3 and `default_first_agent` for priority 4. Explicit targets and mentions preserve their existing strategy, execution-mode, and cleaned-text behavior.

For queued main-lane messages, resolution uses an execution-time snapshot when the batch actually starts. A qualifying public reply completed after the user message was accepted may therefore become the default. Persisted ordering must produce the same result after restart.

## Scope

### In scope

- Extract one shared initial-target resolver owned by the conversation turn domain.
- Use it from ordinary main-lane text routing and image capability preflight.
- Keep submission-time image preflight as an early failure check where useful, but make execution-time resolution and image validation authoritative for queued batches.
- Preserve explicit `initialAgentIds`, actionable mention, execution mode, cleaned content, first-participant fallback, and current side-lane routing semantics.
- Add regression coverage for filtering, ordering, queued execution-time snapshots, restart persistence, and text/image target parity.
- Update runtime and unit-test specifications with the executable contract.

### Out of scope

- Changing actionable mention syntax or mention parsing.
- Changing explicit single-mention side-lane dispatch.
- Routing to private-message senders or failed/silent replies.
- Adding a new database column or cached last-speaker field.
- Changing participant order, Goal lifecycle rules, Stop behavior, cross-conversation delivery, or Agent-to-Agent handoff routing.
- Publishing to `main`.

## Validation Matrix

| Case | Expected initial target |
| --- | --- |
| explicit valid `initialAgentIds` | explicit ids, existing order |
| actionable user mentions | mentioned Agent ids, existing order/mode |
| no explicit target; latest qualifying public reply is B | B with `default_last_agent` |
| newer failed/streaming/empty/private-only reply from C | prior qualifying Agent remains selected |
| latest qualifying reply Agent was removed | prior qualifying current participant, otherwise first participant |
| no qualifying reply | first participant with `default_first_agent` |
| queued message; B publicly completes before batch starts | B at execution time |
| image message without mention | preflight and text execution resolve the same target |
| restart with equal timestamps | persisted `(createdAt, id)` order selects deterministically |
| side-lane explicit single mention | existing side target behavior unchanged |

## Acceptance Criteria

- [x] Baseline regression tests fail because unmentioned text and image preflight still select the first participant.
- [x] One shared resolver implements the confirmed priority and qualification contract.
- [x] Main-lane text routing uses the shared resolver at execution time.
- [x] Image preflight validates the same execution-time target used by routing, including queued image batches.
- [x] Explicit `initialAgentIds` and actionable mentions retain priority and behavior.
- [x] Failed, incomplete, empty, private/private-only, and removed-Agent replies are excluded.
- [x] First-conversation fallback remains the first participant.
- [x] Persistent message order and restart behavior are deterministic.
- [x] Existing side-lane, Goal continuation, Stop, handoff, and image-only behavior remain green.
- [ ] Specs, Trellis evidence, build, check, typecheck, targeted tests, independent review, and isolated user acceptance are complete before integration.
