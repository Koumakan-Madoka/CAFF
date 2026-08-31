# Retire Digest Experience Extraction

## Goal

Restore conversation digests to a single responsibility: bounded summaries of
what happened in the conversation. Remove the unused model-mediated experience
pipeline and its internal-ID provenance boundary.

## Confirmed Scope

- Remove `experience` and `sourceDraftId` from all new digest/model submission
  schemas, prompts, entries, rollups, API create inputs, and prompt formatting.
- Remove the Agent-facing `write-experience` CLI, HTTP route, bridge handler,
  prompt guidance, tool availability projection, telemetry, and tests.
- Remove pending experience draft creation/absorption and the
  `pending_experience` auto-digest trigger, including its idle/cooldown bypass
  and special status UI wording.
- Remove automatic Skill draft review/creation after auto-digest. Keep manual
  digest-to-Skill extraction, pending draft review, confirm/reject, and save.
- Manual Skill extraction uses only `facts`, `decisions`, `nextActions`,
  `artifacts`, and `openQuestions` limitations.
- Preserve historical `digest.experience`, `metadata.experienceDrafts`, existing
  `skillDrafts`, and `skillDraftAutoReviews` as inert readable data. Do not
  migrate, delete, absorb, re-emit, or use those legacy fields to trigger work.
- New rollups and new summary-memory segments must not propagate historical
  `experience`.

## Intentional Behavior Changes

- Pending historical experience drafts no longer bypass the auto-digest message
  budget, idle window, or cooldown.
- Automatic Skill draft creation is retired even when
  `CAFF_SKILL_DRAFT_AUTO_CREATE=true`; no background model/rule review runs
  after a digest.
- `submit_conversation_digest` contains only `summary`, `facts`, `decisions`,
  `openQuestions`, `nextActions`, and `artifacts`.
- The removed `write-experience` route/command is unsupported rather than kept
  as a compatibility alias.

## Non-Goals

- Changing digest message eligibility, high-value signal policy, retention,
  compaction count, summary memory search, title refinement, or Recovery Scribe.
- Removing manual Skill extraction or deleting existing user Skill files and
  pending Skill drafts.
- Destructive migration of stored conversation metadata.
- Fixing DAG cross-conversation worker lease expiry; that remains a separate PR.
- Replacing the removed experience path with another automatic provenance
  protocol.

## Acceptance Criteria

- [x] New digest tool/schema, extractive/model entries, manual create, auto-create,
      and rollups contain no `experience` or `sourceDraftId`.
- [x] Historical experience metadata remains readable but cannot trigger,
      propagate, absorb, or auto-create anything.
- [x] `write-experience` is absent from the CLI, API, bridge, Agent prompt, and
      availability map; focused tests prove the removal.
- [x] Pending experience drafts below the normal digest budget return
      `below_budget` and do not emit special absorption status.
- [x] The create-server hook no longer invokes automatic Skill draft creation;
      manual extract/list/confirm/reject flows still pass using standard digest
      fields.
- [x] Specs identify the removed contract, compatibility boundary, validation
      matrix, and Good/Base/Bad test points.
- [x] Applicable check, typecheck, build, smoke/runtime/UI tests pass, with any
      environment limitation recorded accurately.
- [ ] A reviewer other than the author reviews the exact candidate SHA and all
      findings are resolved or explicitly accepted.

## Code-Spec Contract

Target truth sources:

- `.trellis/spec/backend/conversation-digest.md`
- `.trellis/spec/runtime/agent-runtime.md`
- `.trellis/spec/runtime/skill-extraction.md`
- `.trellis/spec/runtime/conversation-turn-queue.md`
- `.trellis/spec/frontend/ui-structure.md`

Required validation matrix:

| Case | Expected result |
| --- | --- |
| Valid direct digest tool submission | Accepted without an `experience` field |
| Submission includes legacy `experience` | Strict schema rejection and existing extractive fallback |
| Historical digest includes `experience` | Read remains tolerant; new rollup/prompt/new write omits it |
| Pending legacy experience draft below budget | No auto-create; `below_budget` |
| Agent invokes removed command/route | CLI unsupported / HTTP route not found; no metadata mutation |
| Manual extract from facts/decisions/actions/artifacts | Pending Skill draft still created for human review |
| Automatic Skill configuration enabled | No post-digest automatic review or draft creation |

Good: a historical conversation loads normally while every newly generated
artifact uses the six-field digest contract.

Base: a normal auto-digest reaches the existing message/high-value gates and
stores a summary without starting a Skill review.

Bad: silently consuming legacy pending drafts, carrying historical experience
into a new rollup, retaining a hidden Agent command, or deleting historical
metadata during read normalization.
