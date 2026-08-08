---
feature_ids: [F004]
topics: [providers, management-ui, acceptance, regression]
doc_kind: bug-report
created: 2026-08-08
---

# Configured provider card shows runtime API dialect instead of provider ID

## Reporter

The operator found the issue during post-merge F004 acceptance on the isolated `3184` instance. The configured provider card for `Kimi K3-256K` showed `anthropic-messages` below the display name.

## Reproduction

1. Open **角色与模型管理 → 模型供应商**.
2. Configure a provider whose ID is `kimi-for-coding` and whose runtime API dialect is `anthropic-messages`.
3. Observe the configured-provider list card.

Expected: the secondary line starts with the provider ID, `kimi-for-coding`.

Actual: the secondary line starts with the runtime API dialect, `anthropic-messages`.

## Root cause

`GET /api/model-providers` returns both fields correctly. The acceptance payload contained `id=kimi-for-coding` and `api=anthropic-messages`. `public/personas/provider-management.js` selected `provider.api` for the list-card metadata even though the card identifies a provider, not a runtime protocol.

## Fix

Render `provider.id` as the first metadata field. Keep the model count and validation status unchanged. Do not change the editor's runtime API field or the API payload contract.

## Verification

- RED: the focused jsdom regression received `anthropic-messages · 1 个模型 · 待验证` and failed because `kimi-for-coding` was absent.
- GREEN: `node --test tests/runtime/model-family-roles-ui.test.js` passes 5/5 and asserts the provider ID is present while the API dialect is absent from the card metadata.
- Browser acceptance confirmed the live `3184` card reads `kimi-for-coding · 1 个模型 · 待验证` and does not contain `anthropic-messages` after rebuilding the repository-owned static assets.
