---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, ui-design-gate, thinking-capability, pi-runtime]
doc_kind: review_request
created: 2026-08-03
---

# Model-family Thinking Capability Delta Recheck Request

Review-Target-ID: model-family-roles
Branch: `feat/model-family-roles`
Delta base: `3235911`
Target commit: `547e8fe`

## Original Requirements

Source: [Kickoff and Design Gate](../feature-discussions/2026-08-02-model-family-roles/README.md)

- operator asked why the Kimi thinking-strength select exposed only `max`.
- The production contract is capability-aware: options come from the selected catalog model, empty means inherit, and unsupported values never silently clamp.
- The global user-level Pi domain keeps `max`; the defect is model-specific capability data, not the global enum.
- The frozen UI must be trustworthy enough to guide implementation without becoming a second production capability table.

## Architecture Ownership

Architecture cell: CAFF chat role + conversation domain
Map delta: none
Why: This delta corrects a Design Gate fixture and provenance assertions; it does not create or move an ownership boundary.

## What Changed

- Corrected `moonshot/kimi-k2.5` from `['max']` to `['off','minimal','low','medium','high']` and changed its valid demo default to `high`.
- Swept every handwritten model capability entry rather than point-fixing Kimi: GPT mini, Claude Sonnet/Opus, DeepSeek and GLM snapshots were corrected too.
- Added an executable snapshot guard that loads the repo-pinned nested `@earendil-works/pi-ai` and compares all eight fixture entries against audited provider/model sources.
- Documented that Agent runtime truth is `@earendil-works/pi-coding-agent@0.80.10` plus its nested `@earendil-works/pi-ai`; global CLI and root deprecated `@mariozechner/pi-ai` are not capability sources.

## Why

The old fixture mixed the global legal value domain with per-model support. That made Kimi appear to support only `max`, while the actual pinned runtime returns `off/minimal/low/medium/high`, and allowed other handwritten entries to drift silently.

## Tradeoff

The Design Gate remains a self-contained HTML fixture, but its example snapshots are now guarded by the installed pinned Pi package. Production still receives `supportedThinkingLevels` through `ConfiguredModelCatalog`; it does not import the fixture table.

## Failure-Mode Sweep

Pattern: handwritten model capability data diverges from the runtime catalog.

| Fixture key | Audited Pi source | Corrected support |
|---|---|---|
| `openai/gpt-5.4` | `openai/gpt-5.4` | `off,minimal,low,medium,high,xhigh` |
| `openai/gpt-5-mini` | `openai/gpt-5-mini` | `minimal,low,medium,high` |
| `anthropic/claude-sonnet-4.5` | `anthropic/claude-sonnet-4-5` | `off,minimal,low,medium,high` |
| `anthropic/claude-opus-4.1` | `anthropic/claude-opus-4-1` | `off,minimal,low,medium,high` |
| `google/gemini-2.5-pro` | `google/gemini-2.5-pro` | `off,minimal,low,medium,high` |
| `deepseek/deepseek-v3.2` | `openrouter/deepseek/deepseek-v3.2` | `off,minimal,low,medium,high` |
| `zhipu/glm-5` | `openrouter/z-ai/glm-5` | `off,minimal,low,medium,high` |
| `moonshot/kimi-k2.5` | `moonshotai/kimi-k2.5` | `off,minimal,low,medium,high` |

## Red → Green Evidence

- RED: `node tests/ui/model-family-roles-ui-gate.test.js` failed on Kimi options, all stale fixture snapshots, and missing package provenance.
- GREEN: the same command returns `PASS model-family roles UI Design Gate contract` and exercises Microsoft Edge through CDP at 375px.
- Full repository: `npm test` passed (`test:fast` + `test:smoke`, 0 failures).
- Type safety: `npm run typecheck` passed.
- Diff hygiene: `git diff --check` passed; no repository-root media/design artifacts.
- `scripts/check-fallback-layers.mjs` is absent on this baseline; this delta adds no fallback branch.

## Open Questions

Technical OQ: Does the executable alias-to-source snapshot mapping adequately demonstrate the sweep without implying those aliases are production catalog identities?

Value OQ: none.

## Next Action

[BLOCKING] Please recheck only `3235911..547e8fe` against the narrowed P2/P3 criteria already accepted: preserve global `max`, verify Kimi/model-specific sets, confirm the complete handwritten-fixture sweep, and confirm package/source provenance.

