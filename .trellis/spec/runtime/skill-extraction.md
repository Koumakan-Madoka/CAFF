# Skill Extraction From Conversation Digests

## Scenario: Manual And Auto-Reviewed Digest-To-Skill Drafts

### 1. Scope / Trigger
- Trigger: turning a conversation digest or rollup into reusable CAFF skill guidance.
- Applies when changes touch digest actions, conversation metadata, project skill file writes, skill draft UI, or skill registry reuse.
- Goal: provide a human-confirmed experience reuse path inspired by Hermes without automatically enabling unreviewed skills.
- Phase 3 adds an optional background review after automatic digest creation: it may create a pending skill draft from the new digest, but it must never write or enable a skill without explicit confirmation.

### 2. Signatures
- `POST /api/conversations/:conversationId/digest`
  - Request: `{ action: 'extract-skill', digestId, skillId?, name?, description?, body? }`
  - Response: `{ conversation, skillDrafts, draft, summary, conversations }`
- `GET /api/conversations/:conversationId/skill-drafts`
  - Response: `{ conversation, skillDrafts, draft: null, skill: null, summary, conversations }`
- `POST /api/conversations/:conversationId/skill-drafts/:draftId/confirm`
  - Request: `{ overwrite?: boolean }`
  - Response: `{ conversation, skillDrafts, draft, skill, summary, conversations }`
- `POST /api/conversations/:conversationId/skill-drafts/:draftId/reject`
  - Request: `{ reason?: string }`
  - Response: `{ conversation, skillDrafts, draft, skill: null, summary, conversations }`
- `maybeAutoCreateConversationSkillDraft(store, conversationId, { digestId, trigger? }, options)`
  - Triggered by `createServerApp` after `maybeAutoCreateConversationDigest(...)` returns an auto-created digest.
  - Enabled by `options.autoCreate === true` or `CAFF_SKILL_DRAFT_AUTO_CREATE=true`; disabled by default.
  - Supports model generation through `skillDraftModelRunner` or `CAFF_SKILL_DRAFT_GENERATION_MODE=model|auto` plus `CAFF_SKILL_DRAFT_PROVIDER` / `CAFF_SKILL_DRAFT_MODEL`; rules remain the fallback.
- Browser UI:
  - Renders conversation digests in the dedicated conversation digest drawer.
  - Renders pending `metadata.skillDrafts` in a separate Skill 草稿 drawer, not mixed into the digest list.
  - Shows a fixed left-bottom `Skill 草稿` shortcut and a main chat alert whenever pending drafts exist, so users do not need to discover drafts through the digest drawer first.
  - Each digest card exposes `extract-skill`; successful extraction opens the separate Skill 草稿 drawer for review.
  - Each draft card exposes preview, confirm, and reject actions.
  - `conversation_skill_draft_updated` SSE events refresh the conversation state so auto-created drafts become visible without manual API calls.

### 3. Metadata Contract
- Drafts are stored only as bounded conversation metadata at `conversation.metadata.skillDrafts`.
- Automatic model/rule skip decisions are stored as bounded conversation metadata at `conversation.metadata.skillDraftAutoReviews` so the same digest is not auto-reviewed repeatedly after a rejection.
- Maximum retained drafts: 5.
- Maximum retained auto-review records: 20.
- Draft shape:
  - `id`: generated `skilldraft-*` id.
  - `status`: `pending` while stored; confirm/reject returns terminal status and removes it from metadata.
  - `source`: `{ type: 'digest', digestId, digestKind, trigger?, createdBy?, autoCreated? }`; manual extraction forces `createdBy: 'user:manual'` and ignores client-supplied `createdBy` / `autoCreated`.
  - `target`: `{ action: 'create' | 'update', skillId?, skillName?, reason? }`; `update` means the pending draft should merge bounded guidance into an existing project Skill after human confirmation.
  - `skill`: `{ id, name, description, body }` normalized for `SKILL.md` creation or merged replacement content.
  - `createdAt`, `updatedAt`, optional `reason`, `confirmedAt`, `rejectedAt`, `savedTo`.
- Auto-review shape:
  - `digestId`: source digest id.
  - `status`: `rejected | skipped`.
  - `reasonCode`: bounded machine reason such as `review_rejected` or `weak_reusable_signal`.
  - `reason`: bounded human-readable reason.
  - `trigger`, `createdBy`, `reviewedAt`, `updatedAt`.

### 4. Extraction Contract
- Extraction reads existing digest metadata only; it does not read raw private notes, raw tool transcripts, or full public chat history.
- A digest must contain at least one reusable signal from `experience`, `facts`, `decisions`, `nextActions`, or `artifacts` before extraction/review is attempted.
- Manual extraction remains user-directed: if reusable fields exist, rule fallback may build a bounded draft from all digest fields even when model generation fails or the model would not auto-create it.
- Automatic review is stricter: reusable fields are candidate input, not permission to create a draft. Before model/rule generation, auto-review requires source-backed `digest.experience` whose `sourceDraftId` matches an absorbed `conversation.metadata.experienceDrafts` entry for the same digest; ordinary digest facts/decisions/actions/artifacts remain manual-extraction inputs only. Model mode asks for `shouldCreateSkill` plus `reason`; only an explicit `shouldCreateSkill=true` with a valid skill payload stores a pending draft. Missing, malformed, or ambiguous `shouldCreateSkill` values are treated as skipped auto reviews, not implicit approval.
- Automatic model rejection stores a `skillDraftAutoReviews` record and later auto attempts for the same digest return the stored rejection instead of re-calling the model. Digests without source-backed experience are skipped before calling the model. Manual extraction ignores that auto-review record.
- Rule generation remains deterministic and conservative: `facts`, `decisions`, `nextActions`, and `artifacts` may become skill guidance sections for manual extraction; automatic rule fallback only creates drafts for strong source-backed structured experience absorbed from `write-experience`.
- Model generation receives only the structured digest JSON, requested overrides, and a bounded list of existing project Skill summaries (`id`, `name`, `description`, short body excerpt), never raw chat messages, private notes, hidden instructions, or tool transcripts.
- Manual model output must be schema JSON: `targetAction`, optional `targetSkillId`, optional `targetReason`, `id`, `name`, `description`, `whenToUse`, `steps`, `pitfalls`, `validation`, `artifacts`, and `confidence`. Automatic model output may be `{ shouldCreateSkill: false, reason, targetAction, targetSkillId, skill: null }` or `{ shouldCreateSkill: true, reason, targetAction, targetSkillId, targetReason, skill: { ...manual schema } }`. The server normalizes bounded sections and builds the `SKILL.md` body.
- If `digest.experience` exists, rule and model generation must treat it as the preferred reusable lesson layer. Facts, decisions, nextActions, and artifacts remain fallback/supporting evidence, not the first source of workflow steps. Rule-generated Skill bodies keep each experience item's `confidence` so human review can spot low-confidence lessons.
- Skill draft generation must decide whether to create a new Skill or update an existing project Skill. Model mode uses the bounded existing Skill summaries and may return `targetAction: 'update'` only when a listed project Skill clearly matches the same workflow. Rule fallback may choose `update` only for explicit caller targets or strong local similarity; otherwise it creates a new Skill to avoid destructive merges.
- `openQuestions` must be rendered only as limitations, pitfalls, or guardrails, never as required rules or workflow steps; server filtering removes model steps that exactly promote source open questions.
- Current user instructions, project specs, and recent raw conversation always override extracted skill drafts.
- Auto-review creates at most one pending draft per source digest while that draft remains in metadata; duplicate retries return `already_pending` without storing another draft.
- Auto-review treats digests without reusable fields as `no_reusable_signal` and stores no draft.
- Auto-review treats weak reusable fields as `weak_reusable_signal` when rule mode/fallback has no strong signal, stores a bounded skip review, and creates no draft.

### 5. Confirmation Contract
- Confirm writes `SKILL.md` under the active project root: `<activeProject>/.agents/skills/<skillId>/SKILL.md`; for `target.action === 'update'`, confirmation rewrites the matched existing project Skill with merged content instead of creating a duplicate directory.
- The active project path is resolved by the backend; clients and agents cannot choose arbitrary output paths.
- `skillId` is normalized with the same skill id sanitizer used by the skill registry.
- Path traversal is rejected by checking the resolved skill directory remains within `.agents/skills`.
- Existing project skill files are rejected unless `overwrite: true` is explicitly supplied.
- Rejection and confirmation both remove the pending draft from conversation metadata.

### 6. Validation & Error Matrix
| Case | Expected behavior |
| --- | --- |
| Missing digest id | 400 `Digest id is required` |
| Unknown digest id | 404 `Conversation digest not found` |
| Digest has no reusable fields | 400 and no draft is stored |
| Digest has `experience` but no facts/decisions/actions/artifacts | 200, draft can be generated from bounded reusable experience items |
| Confirm with no active project | 409 and no file is written |
| Confirm new-skill draft where the target file already exists without overwrite | 409 and draft remains pending |
| Confirm update-target draft where the target Skill exists | 200, existing `SKILL.md` is rewritten with merged draft content, and draft is removed |
| Confirm update-target draft where the target Skill disappeared | 404 and draft remains pending |
| Reject pending draft | Removes metadata draft and returns terminal `rejected` preview |
| Confirm pending draft | Writes project `SKILL.md`, removes metadata draft, returns terminal `confirmed` preview |
| Auto-review disabled | Returns `autoCreated: false`, `reason: 'disabled'`, and stores no draft |
| Auto-review sees existing pending draft for digest | Returns `reason: 'already_pending'` and stores no duplicate |
| Auto-review sees existing rejected/skipped review for digest | Returns stored `reasonCode`, does not re-call the model, and stores no duplicate draft |
| Auto-review sees no reusable digest fields | Returns `reason: 'no_reusable_signal'` and stores no draft |
| Auto-review sees reusable fields but no absorbed source-backed experience | Returns `reason: 'weak_reusable_signal'`, stores a bounded skip review, does not call the model, and stores no draft |
| Auto-review model returns `shouldCreateSkill: false` | Returns `reason: 'review_rejected'`, stores a bounded rejected review, and stores no draft |
| Auto-review model omits or mangles `shouldCreateSkill` | Returns `reason: 'review_missing_decision'`, stores a bounded skipped review, and stores no draft |
| Auto-review model returns `shouldCreateSkill: true` with valid skill | Stores a pending schema-derived draft with `When To Use`, `Workflow Steps`, `Pitfalls`, `Validation`, artifacts, and limitations sections. |
| Model returns invalid JSON or throws | Logs a warning; manual extraction falls back to rules, while auto-review falls back only when the digest has strong source-backed structured experience. |
| Model promotes an `openQuestions` item as a step | Removes that step from workflow steps and keeps the item under pitfalls or limitations. |

### 7. Tests Required
- Smoke tests cover extracting a draft from a digest, listing pending drafts, rejecting a draft, confirming a draft into `.agents/skills`, and loading that project skill through `SkillRegistry`.
- Smoke tests cover model-selected `targetAction: 'update'` with bounded existing Skill summaries, preservation of existing Skill content, and confirmation updating the matched Skill rather than creating a duplicate.
- Smoke tests cover edge cases: no reusable digest fields rejects without storing a draft, existing project skill files reject without explicit overwrite, and metadata retains only the newest 5 pending drafts.
- Smoke tests cover optional auto-review creating a pending draft from an auto-created digest, preserving trigger provenance, avoiding duplicate drafts, and the create-server auto-digest hook broadcasting `conversation_skill_draft_updated` before `conversation_digest_updated`.
- Smoke tests cover auto-review model approval, model rejection with stable `skillDraftAutoReviews`, missing review-decision skips, no-model-call skips when source-backed experience is absent, model-generated skill drafts from structured digest schema, model failure fallback to rules, and `openQuestions` not being promoted into workflow steps.
- Smoke tests cover `digest.experience` becoming a `Reusable Experience` section in rule-generated Skill drafts and being present in model prompt input.
- Build/typecheck must cover the new domain module, controller route wiring, auto-digest hook wiring, and browser digest-panel UI wiring.
- Manual browser validation covers seeing the left-bottom `Skill 草稿` shortcut and main chat alert for pending drafts, opening the separate Skill 草稿 drawer from either entry point, keeping the digest drawer focused on digest entries only, extracting a draft from a digest card, previewing the draft, confirming it into `.agents/skills`, rejecting a pending draft, and seeing auto-created drafts refresh after `conversation_skill_draft_updated`.

### 8. Wrong vs Correct
#### Wrong
- Automatically save a skill without human confirmation.
- Treat `openQuestions` as mandatory workflow rules.
- Let a request body choose an absolute filesystem path for the generated skill.
- Store unbounded raw transcript content in metadata.

#### Correct
- Prefer `digest.experience` when present; it is the curated lesson layer between raw digest facts and human-confirmed Skill files.
- Store only bounded draft previews in conversation metadata.
- Require explicit confirm before writing `SKILL.md`.
- Save into the active project's `.agents/skills` root.
- Reuse the existing skill registry dynamic loading path after confirmation.
