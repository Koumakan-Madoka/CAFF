# Experience Write Tool

## Objective
Add a lightweight, model-initiated experience capture path for CAFF agents so reusable lessons discovered during tool use can survive into conversation digests and Skill drafts without storing raw tool transcripts or running expensive automatic evidence extraction every turn.

## Problem
CAFF does not replay an agent's full tool-call process into that same agent's next invocation. As a result, only public replies, digest entries, retrieval traces, and recent raw messages survive. Many valuable reusable lessons live in the tool process itself: failed attempts, file-entry discoveries, validation commands, review pitfalls, and architecture decisions. Pure digest-to-skill extraction therefore often has too little process evidence.

## Scope
- Add a controlled agent tool, tentatively `write-experience`, that writes pending experience drafts into conversation metadata.
- Store drafts in `conversation.metadata.experienceDrafts` with bounded count, bounded field lengths, status metadata, `agentId`, and system-owned source context where available.
- Let agents decide when an experience is worth writing, guided by a concise tool description and prompt instruction.
- Add digest `experience` support so digest generation prioritizes pending experience drafts from the digest message window.
- Mark or clear drafts after digest absorption to avoid duplicate reuse.
- Update Skill draft generation so `digest.experience` is the preferred input; existing facts/decisions/nextActions/artifacts remain fallback.
- Preserve the existing human confirmation step before any Skill file is written to `.agents/skills/`.
- Add regression coverage for tool validation, draft bounds, digest absorption, Skill draft priority, and prompt/tool guidance.

## Non-Goals
- Do not automatically generate evidence cards after every turn or every tool call.
- Do not persist raw tool transcripts, raw long logs, private messages, secrets, credentials, or unbounded command output.
- Do not make pending experience drafts searchable through cross-conversation `search-memory` in the MVP.
- Do not let agents directly create or modify Skill files.
- Do not require a new database table in this iteration; use bounded conversation metadata.
- Do not build a full UI editor for experience drafts unless required by the existing digest/Skill workflow.

## Proposed Schema
Each pending experience draft should be structurally similar to Skill drafts but smaller:

- `id`: system generated.
- `status`: `pending | absorbed | rejected` for MVP lifecycle tracking.
- `title`: short reusable lesson title.
- `category`: `bug_fix | pattern | decision | anti_pattern | tool_usage | other`.
- `scenario`: context where the lesson was learned; preferred over predictive `whenToUse` wording.
- `steps`: at most 5 short steps.
- `pitfalls`: bounded caveats, failed attempts, or limitations.
- `validation`: bounded validation evidence such as test/build/check command names and outcomes.
- `artifacts`: bounded file paths, API names, config keys, or docs touched.
- `confidence`: `low | medium | high`.
- `agentId`: system-owned current agent id.
- `turnId` or source message metadata: system-owned when available; the model should not invent message ids.
- `createdAt`, `updatedAt`, `absorbedAt`, `absorbedDigestId`: system-owned lifecycle fields.

## Tool Guidance
The agent should use `write-experience` only when it has a reusable, validated, or clearly bounded lesson. Good triggers include:

- A non-obvious bug was fixed or root-caused.
- A repeatable project workflow or architecture rule was discovered.
- A failed attempt, edge case, or review pitfall should be remembered.
- The user explicitly made a reusable design decision.
- A validation command confirmed the result.

The agent should not use the tool for simple Q&A, pure summaries, unverified guesses, open questions, or transient TODOs. When the lesson is found during tool use, the agent should write it before the final public reply if possible.

## Acceptance Criteria
- Agents can call `write-experience` and receive a bounded result containing draft id/status plus validation diagnostics.
- Server-side validation rejects empty, overly generic, oversized, transcript-like, or source-forged drafts.
- Each agent turn can create at most one experience draft, and each conversation retains only a small bounded set of recent pending drafts.
- Digest entries support an `experience` array and include relevant pending drafts before model/rule fallback extraction.
- Drafts absorbed into a digest are marked `absorbed` or otherwise excluded from later duplicate absorption.
- Skill draft generation uses `digest.experience` before falling back to facts/decisions/nextActions/artifacts.
- Prompt/tool guidance explains when to write experience and warns not to store secrets, raw logs, private content, or unverified claims.
- Regression tests cover tool persistence, bounds, duplicate prevention, digest absorption, Skill draft priority, and safety rejection.

## Open Questions
- Should absorbed experience drafts remain visible in metadata for diagnostics or be compacted away after a retention limit?
- Should a minimal digest panel marker show experience-backed digests in the MVP?
- Should pending experience drafts lower the automatic digest threshold, or should MVP leave digest triggering unchanged?
