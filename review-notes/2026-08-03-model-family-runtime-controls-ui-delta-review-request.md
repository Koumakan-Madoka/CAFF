---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, roles, thinking, model-profiles, design-gate, ui]
doc_kind: review-request
created: 2026-08-03
---

# Review Request: Model-family Role Runtime Controls UI Delta

Review-Target-ID: model-family-roles
Branch: feat/model-family-roles
Review target SHA: `e7bbd71`
Base UI verdict SHA: `4bfd529`

## What

- Replaces the role detail's free-text `Thinking=medium` placeholder with a capability-aware “默认思考强度” select.
- Exposes editable runtime Profiles: `name/description/model/thinking`; family Profiles remain same-family and Persona-free, while custom Profiles retain cross-family model choice and Persona.
- Makes custom role Persona Prompt and Skills visible in the executable Gate instead of deferring them to a production-only note.
- Freezes `supportedThinkingLevels`, inherit-empty semantics and no-silent-clamp behavior in the Feature Spec and Architecture Gate.

No production schema, API, runtime or UI implementation is included.

## Why

Operator acceptance feedback:

> “看着很不错，但是感觉少了一些可配置的字段，比如目前最常用的思考强度等”

Source message: `0001785721844031-000234-a09deb9b`.

The existing fixture technically showed “Thinking”, but it was a free-text value with no model capability, inheritance or Profile semantics. CAFF's real role runtime contract is model + thinking, with Profiles adding name/description/model/thinking and custom Persona; the delta exposes that complete set without inventing unsupported role-level temperature/max-token controls.

## Tradeoff

- Thinking options come from Pi's `off/minimal/low/medium/high/xhigh/max` contract and the selected model's `supportedThinkingLevels`; unsupported levels are hidden.
- Empty means “跟随运行时默认”. Switching to a model that cannot support the current value resets to inheritance with an explicit notice rather than silently clamping.
- Model capability metadata belongs to `ConfiguredModelCatalog`; the fixture contains representative data only. Production UI must not maintain a second hard-coded capability registry.

## Architecture Ownership

Architecture cell: CAFF chat role + conversation domain
Map delta: none
Why: this extends the existing role/profile projection over the configured model catalog; it does not introduce a new settings store, model registry or runtime.

## Open Questions

### Technical OQ

- Does the role detail make default thinking and runtime Profiles discoverable without crowding the system-family experience?
- Is the family/custom field boundary legible: family Profiles are same-family and Persona-free; custom retains full Persona/Skills?
- Is inherit/reset behavior understandable, including model-specific absence of `max` for GPT in this fixture?
- Are Profile add/focus and the 375px long-form role detail usable?

### Value OQ

None. Operator will perform the final UI acceptance after this delta review.

## Failure-Mode Sweep

Invariant: every persisted role runtime control must correspond to a real CAFF executor field and a model-supported value.

- Scanned base role fields, Profile fields, provider model-entry fields and Pi settings/model metadata.
- Exposed model + thinking at base level; name/description/model/thinking at Profile level; custom-only Persona/Skills.
- Did not add role-level temperature, max tokens, context window or cost because CAFF's role executor does not consume them.
- Provider remains derived from the selected catalog option, preventing provider/model mismatch.

## Red -> Green Evidence

1. Extended `tests/ui/model-family-roles-ui-gate.test.js` first.
2. Red failures: missing `supportedThinkingLevels` docs, missing runtime controls, missing capability-aware reset notice.
3. Green target:
   - GPT thinking is a `SELECT`, selected `medium`, includes inherit/off/xhigh and excludes unsupported `max`.
   - family Profile model options are GPT-only and contain no Persona.
   - “添加 Profile” adds a second editor and focuses `runtime-profile-name-1`.
   - custom Profile includes Claude/OpenAI options plus Persona; custom detail shows Persona Prompt and Skills.
   - incompatible custom model switch resets thinking to inherit and announces the reset.
   - role detail remains `scrollWidth=375` at the mobile viewport.

## Self-Check Evidence

```text
node tests/ui/model-family-roles-ui-gate.test.js
  PASS model-family roles UI Design Gate contract

npm test
  exit 0; test:fast + test:smoke passed on e7bbd71 working tree

npm run check
  exit 0

npm run typecheck
  exit 0

git diff --check
  exit 0
```

Dogfood path: Hub Browser Preview `http://127.0.0.1:3100/model-family-roles-ui-gate.html#clean` -> GPT default thinking -> add runtime Profile -> 架构评审 custom Persona/Skills -> switch to Kimi and observe inherit-reset notice.

No matching `.pen`; no root media artifacts; repository fallback-layer script is absent. Unrelated pre-existing untracked governance files are outside the target.

## Next Action

Please return `APPROVE` or `REQUEST-CHANGES` for the UI delta at `e7bbd71`. Architecture/security approval remains a separate implementation gate.

[砚砚/gpt-5.6-sol🐾]
