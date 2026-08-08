---
feature_ids: [F004]
topics: [models-dev, catalog-import, providers, acceptance, regression]
doc_kind: bug-report
created: 2026-08-08
---

# Catalog import stores the model display name as the provider name

## Reporter

The operator found the issue during post-merge F004 acceptance. Importing the Kimi catalog entry produced a configured-provider title of `Kimi K3-256K` instead of the catalog supplier name `Kimi For Coding`.

## Reproduction

1. Start with an isolated CAFF data directory containing no `kimi-for-coding` provider.
2. Import provider `kimi-for-coding`, model `k3-256k`, from the models.dev catalog.
3. Open **角色与模型管理 → 模型供应商**.

Expected: the provider is named `Kimi For Coding`, while the model is named `Kimi K3-256K`.

Actual: both the provider and model were named `Kimi K3-256K`.

## Root cause

The catalog projection exposed only the model display name. `POST /api/model-catalog/import` consequently reused `projection.name` for both the provider-level `name` and the imported model-level `name`, collapsing two distinct catalog concepts.

## Fix

Project the catalog provider name separately as `providerName`. When a provider has no existing configured name, persist `providerName` (falling back to the provider ID); continue using the reviewed import name or model display name only for the model entry. The import UI label is clarified to **模型显示名称**.

## Verification

- RED: importing `openai` / `gpt-5/pro` into an empty document persisted provider name `GPT-5 Pro`; the regression expected `OpenAI`.
- GREEN: the controller regression now asserts provider `OpenAI` and model `GPT-5 Pro` independently.
- Domain/UI regressions assert `providerName` projection and the **模型显示名称** label.
- Isolated live acceptance on port `3185` persisted provider `Kimi For Coding` and model `Kimi K3-256K`; `GET /api/model-providers` returns those separate names.
