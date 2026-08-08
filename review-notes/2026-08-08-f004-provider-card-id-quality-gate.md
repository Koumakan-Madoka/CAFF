---
feature_ids: [F004]
topics: [quality-gate, provider-management, provider-id, ui, hotfix]
doc_kind: quality-gate
created: 2026-08-08
---

# F004 Configured Provider Card ID — Author Evidence Packet

Branch: `fix/f004-provider-card-id`
Baseline: `origin/main@260ca54`
Worktree: `E:\pythonproject\caff-acceptance-f004`

## Original requirement and vision coverage

Operator acceptance feedback: “已配置供应商，下面应该展示供应商ID，而不是模型AI啊”.

The configured-provider card identifies a provider. Its secondary line must therefore begin with the provider's stable ID, while the runtime API dialect remains editable in the provider detail form. The fix does not remove or rename the runtime API field.

## Root cause and implementation

The isolated acceptance API returned `id=kimi-for-coding` and `api=anthropic-messages`. `public/personas/provider-management.js` selected `provider.api` for list-card metadata. The implementation changes that single projection to `provider.id`; model count and validation status are unchanged.

## TDD and verification

| Check | Result |
|---|---|
| RED | focused test failed with actual text `anthropic-messages · 1 个模型 · 待验证` because `kimi-for-coding` was absent |
| GREEN | `node --test tests/runtime/model-family-roles-ui.test.js` — 5/5 |
| Full gate | `npm run test:fast` — exit 0 |
| TypeScript | `npm run typecheck` — exit 0 |
| Build | `npm run build` — exit 0 |
| Diff hygiene | `git diff --check` — clean |

## Dogfood-Your-Slice

Scope verdict: required; this changes user-visible provider-management output.

Target: `E:\pythonproject\caff-acceptance-f004` → `http://127.0.0.1:3184/personas.html#providers`.

The repository-owned static assets were rebuilt, then a fresh headless Edge session opened the real isolated acceptance page and selected provider management. Observed card metadata:

```text
kimi-for-coding · 1 个模型 · 待验证
```

The text contains the provider ID and does not contain `anthropic-messages`.

## Spec, design, and architecture

- F004 AC-7 requires an honest separation between catalog/provider identity and runtime controls; the correction aligns the list card with that boundary.
- `designs/**/*.pen`: no matching files exist, so no visual-design comparison is applicable.
- Architecture cell: `public/personas` inside the existing provider-management surface.
- Map delta: none. No API, store, router, persistence, dependency, or runtime contract changed.
- Capability tips: exempt because this corrects an existing label projection and adds no new capability or workflow.

## Hygiene and governance

- Root media/design artifact scan: clean.
- No fallback layer was added; the repository has no `check-fallback-layers` script.
- The conventional `fix`/acceptance-bug scope is treated as hotfix governance. The author does not self-pass the quality gate; this packet requires an independent cross-cat quality-gate verdict before formal review/merge.
- The unrelated untracked `Microsoft/` directory is preserved and excluded from the diff.

## Author verdict

Evidence is complete and the implementation is ready for independent hotfix quality-gate review. This document is not a self-approval.

[砚砚/gpt-5.6-sol🐾]
