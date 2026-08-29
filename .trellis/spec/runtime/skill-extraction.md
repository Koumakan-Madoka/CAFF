# Manual Skill Extraction From Conversation Digests

## Scenario: Human-Confirmed Digest-To-Skill Drafts

### 1. Scope / Trigger

- Trigger: turning a retained conversation digest or rollup into reusable CAFF
  Skill guidance through an explicit user action.
- Applies to digest actions, `server/domain/conversation/skill-draft.ts`, pending
  Skill metadata, project Skill writes, and Skill draft UI.
- Goal: keep Skill extraction visible and human-directed. Conversation digest
  generation never starts a Skill review or draft in the background.

### 2. Signatures

- `POST /api/conversations/:conversationId/digest`
  - Request: `{ action: 'extract-skill', digestId, skillId?, name?, description?, body? }`
  - Response: `{ conversation, skillDrafts, draft, summary, conversations }`
- `GET /api/conversations/:conversationId/skill-drafts`
  - Response: `{ conversation, skillDrafts, draft: null, skill: null, summary, conversations }`
- `POST /api/conversations/:conversationId/skill-drafts/:draftId/confirm`
  - Request: `{ overwrite?: boolean }`
- `POST /api/conversations/:conversationId/skill-drafts/:draftId/reject`
  - Request: `{ reason?: string }`
- Retained metadata: `conversation.metadata.skillDrafts?: SkillDraft[]`.
- Retired inert metadata may still exist on historical conversations:
  `conversation.metadata.skillDraftAutoReviews` and
  `conversation.metadata.experienceDrafts`.

### 3. Contracts

- Only explicit `extract-skill` creates a pending Skill draft. The create-server
  auto-digest hook must not call a Skill draft model/rule generator, regardless
  of `CAFF_SKILL_DRAFT_AUTO_CREATE` or historical auto-review metadata.
- Extraction reads the selected structured digest only. It never reads raw chat,
  private notes, hidden instructions, or tool transcripts.
- Reusable input fields are `facts`, `decisions`, `nextActions`, and `artifacts`.
  `openQuestions` may become limitations/pitfalls and must never become required
  workflow steps.
- Historical `digest.experience` is tolerated by digest deserialization but is
  ignored by manual Skill extraction and omitted from the model prompt. A digest
  containing only historical `experience` has no reusable signal.
- Rule mode builds a bounded body from summary, facts, decisions, actions,
  artifacts, and limitations. Model mode receives the same six-field digest
  projection plus bounded existing Skill summaries.
- Model output is bounded JSON with `targetAction`, optional target fields, id,
  name, description, `whenToUse`, steps, pitfalls, validation, artifacts, and
  confidence. Model failure falls back to rules for the same manual request.
- Drafts remain bounded conversation metadata (`skillDrafts`, maximum 5). Draft
  source is `{ type: 'digest', digestId, digestKind, trigger: 'manual',
  createdBy: 'user:manual' }`.
- Confirm is the only operation that writes `SKILL.md`. It resolves the active
  project server-side, sanitizes the Skill id, rejects traversal, and requires
  explicit overwrite for an existing create target.
- Reject/confirm remove the pending metadata draft. Historical Skill drafts and
  auto-review records remain readable and are not migrated or deleted.

### 4. Validation & Error Matrix

| Case | Expected behavior |
| --- | --- |
| Missing/unknown digest id | `400 Digest id is required` / `404 Conversation digest not found` |
| Digest has facts/decisions/actions/artifacts | `200`, store one pending manual draft |
| Digest has only historical `experience` | `400`, no draft/model call |
| Historical auto-review or pending experience metadata exists | Ignore it; no background review, mutation, or draft |
| Model returns invalid JSON or throws | Log bounded warning; manual rule fallback |
| Model promotes an open question as a step | Remove the step; retain as limitation/pitfall |
| Confirm without active project | `409`, no file written |
| Confirm create target already exists without overwrite | `409`, draft remains pending |
| Confirm update target disappeared | `404`, draft remains pending |
| Confirm valid draft | Write/merge `SKILL.md`, remove pending draft |
| Reject valid draft | Remove pending draft and return terminal preview |

### 5. Good / Base / Bad Cases

- Good: the user clicks `提炼 Skill` on a digest with a confirmed decision and
  validation artifact, reviews the pending draft, then confirms it.
- Base: an old conversation contains `digest.experience`, `experienceDrafts`,
  and `skillDraftAutoReviews`; loading it is lossless, but those fields cause no
  prompt content, model call, mutation, or SSE event.
- Bad: auto-creating a draft after digest generation, treating historical
  experience as current provenance, promoting open questions into workflow
  rules, or writing a Skill before confirmation.

### 6. Tests Required

- `tests/smoke/server-smoke.test.js`:
  - manual extract/list/reject/confirm and project Skill loading;
  - model-selected update target and preservation of existing Skill content;
  - no reusable fields rejects without a model call;
  - historical `experience` does not satisfy reusable-signal validation;
  - no create-server auto-digest hook emits `conversation_skill_draft_updated`.
- Browser tests keep the Skill draft drawer, pending alert, preview,
  confirm/reject, and digest-card manual extraction action working.
- `npm run check`, `npm run typecheck`, `npm run build`, and focused smoke tests
  cover controller/domain/UI wiring.

### 7. Wrong vs Correct

#### Wrong

```ts
if (autoDigest.digest) {
  await maybeAutoCreateConversationSkillDraft(store, conversationId, {
    digestId: autoDigest.digest.id,
  });
}
```

This hides a second semantic pipeline behind digest generation and can create
review state without a user action.

#### Correct

```ts
if (input.action === 'extract') {
  const digest = findDigestForDraft(conversation, input.digestId);
  return createPendingManualSkillDraft(digest);
}
```

The user-selected digest is the explicit boundary; confirmation remains the
only filesystem write.
