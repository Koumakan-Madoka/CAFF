---
feature_ids: [F004]
related_features: [F002, F003]
topics: [models, providers, models.dev, catalog, import, provenance, secrets, runtime]
doc_kind: spec
created: 2026-08-06
---

# F004: models.dev Catalog and Runtime-Safe Provider Import

> **Status**: in-progress (P1 merged across #57/#58; provider-only acceptance fix merged in #59; configured-provider identity fix merged in #60; P2/P3 remain) | **Owner**: @cat-ir4rwo6b | **Priority**: P1

## Why

CAFF 的 provider editor 目前只能让 operator 手工维护模型条目。我们需要一个可追溯的模型目录入口，减少重复输入，同时保证外部目录元数据不会变成 CAFF 的运行时真相、不会覆盖用户配置、也不会泄露环境变量值。价值终点是：operator 能从一个固定来源的目录选择模型，清楚看到“目录知道什么”和“Pi runtime 实际支持什么”的边界，并在显式确认后生成合法的 CAFF provider 配置。

## Current State / 现状基线

Baseline: `origin/main@092938a` (2026-08-06).

- `server/domain/models/model-provider-config.ts` merges configured entries but only retains the CAFF provider contract (`id/name/api/baseUrl/family/reasoning`); catalog metadata must not be silently added to that contract.
- `server/domain/models/configured-model-catalog.ts` is the runtime/configured catalog and must remain independent from a models.dev cache.
- `server/domain/models/model-provider-persistence.ts` is the writer for the agent directory `models.json`, including validation, backup, and atomic durability.
- `server/api/model-providers-controller.ts` already owns provider administration routes; a catalog read/import route must be explicit and must not change existing CRUD semantics.
- `public/personas/provider-editor.js` and `public/personas/provider-management.js` are the existing provider UI surfaces.
- Official-source audit found models.dev is an MIT-licensed provider map on the `dev` branch, with multiple provider `env` entries and model-level provider overrides. The exact vendored commit cannot yet be pinned because the current environment cannot complete the official HTTPS/GitHub TLS handshake; no SHA or payload hash is fabricated in this spec.

## What

### Phase P1 — Vendored snapshot and explicit import

- Commit a normalized, vendored `assets/model-catalog.json` generated from models.dev, pinned to an exact upstream commit SHA, with the upstream MIT license and a source declaration.
- Parse provider defaults plus model-level `provider` overrides; only an explicit allowlist may map upstream dialects to CAFF Pi dialects. Unknown dialects remain “manual configuration required”.
- Preserve every upstream `env[]` name for display. Key-like variables are identified only by a provider-specific allowlist; values are never read, uploaded, or persisted. Non-key parameters remain blank/manual.
- Map models to CAFF’s seven families through an explicit table. Unmapped values remain unclassified.
- Keep catalog metadata/provenance in a separate cache and expose it through an import-oriented API. An explicit operator save is the only path that writes `models.json`.
- Preserve provider and model display names as separate catalog fields: importing a model may set the provider title from the catalog provider name, while the reviewed model name applies only to the model entry.
- In the UI, render catalog metadata and Pi runtime controls in separate sections; unsupported `reasoning_options`, cost, limits, or modalities must not be presented as executable CAFF controls.

### Phase P2 — Optional online refresh

Add a fixed HTTPS source, timeout/size/count limits, strict schema validation, ETag, atomic replacement, and last-known-good retention. Online provenance records `etag`, `payloadSha256`, `fetchedAt`, and `sourceUrl`; it records `commitSha` only when independently verified.

### Phase P3 — Usage metadata

Use catalog cost/limit metadata as clearly labelled reference values for token-usage presentation, never as billing truth.

## User Journey

### Primary Journey: import a provider model from the catalog

- **Scope unit**: one provider editor import session.
- **Actor**: operator.
- **Entry**: operator opens provider editor and chooses “从目录导入”.
- **Flow**:
  1. CAFF loads the vendored catalog/cache without reading any environment-variable value.
  2. Operator searches a provider by provider id/name, selects one of its models, and sees dialect, family, env names, and catalog metadata in a read-only catalog section.
  3. CAFF marks unsupported dialects or unmapped families as manual/unclassified instead of inventing a runnable config.
  4. Operator explicitly confirms the mapped fields and fills any required non-key parameters.
  5. CAFF writes only the selected CAFF provider entry through the existing persistence path; catalog provenance remains separate.
  6. Reload/restart shows the same configured model, while the catalog cache remains replaceable independently.
- **Success evidence**: domain/API tests, redaction assertions, isolated `models.json` write assertions, and desktop/mobile provider-editor evidence.

## Requirements Checklist

| ID | Requirement | AC | Verification |
|---|---|---|---|
| R1 | Source snapshot is reproducible and licensed | AC-1 | SHA/source/license fixture |
| R2 | Provider defaults and model overrides merge deterministically | AC-2 | parser tests |
| R3 | Unknown dialects fail closed to manual configuration | AC-3 | allowlist tests |
| R4 | All env names are shown without secret values | AC-4 | multi-env/redaction tests |
| R5 | Catalog cache is isolated from `models.json` | AC-5 | persistence/restart tests |
| R6 | Family mapping is explicit and unknown values stay unclassified | AC-6 | mapping table tests |
| R7 | Operator sees catalog metadata separately from runtime controls | AC-7 | UI contract/browser fixture |
| R8 | Existing provider CRUD and precedence remain intact | AC-8 | regression suite |

## Acceptance Criteria

- [x] **AC-1 — Vendored provenance**: P1 ships `assets/model-catalog.json`, its MIT license, and a source declaration containing the independently verified models.dev `dev` commit `e951706c7e89d932c0814bb53534b1762c2230ea`, source URL, generation date, and raw payload SHA-256 `e9cf5169bf822b9ded99431beea42a34dddc1fa6750732bcc674096fd666349d`.
- [x] **AC-2 — Override merge**: provider defaults are merged with model-level `provider` overrides; override fields win, absent fields inherit, and the normalized result is deterministic.
- [x] **AC-3 — Dialect allowlist**: only reviewed mappings produce a CAFF Pi dialect (`openai-responses`, `openai-completions`, `anthropic-messages`, `google-generative-ai`, or another explicitly registered dialect); all other values are returned with `manualConfigurationRequired: true`.
- [x] **AC-4 — Secret-safe env projection**: every upstream `env[]` name is projected for display; provider-specific key allowlists classify key inputs; no environment value is read, serialized, logged, uploaded, or persisted by catalog discovery/import.
- [x] **AC-5 — Storage isolation and precedence**: catalog cache writes never mutate `models.json`; effective configuration precedence is `models.json > explicit user import > online cache > vendored snapshot`; restart preserves the last-known-good cache.
- [x] **AC-6 — Family mapping**: the explicit mapping table covers CAFF’s seven families; unmapped upstream families produce an empty family plus an “unclassified” marker.
- [x] **AC-7 — Honest UI**: provider editor separates catalog metadata from Pi runtime controls and never renders catalog-only reasoning/cost/limit/modalities as executable controls.
- [x] **AC-8 — Regression safety**: existing provider GET/PUT/DELETE/validate behavior, masked secret behavior, and configured-model catalog behavior remain unchanged; all tests use isolated data and Redis 6398 only.

## Dependencies

- **Evolved from**: F002 (Pi SDK host/runtime dialect boundary).
- **Related**: F003 (provider/runtime capability boundaries and operator-visible provenance).
- **P1 unblock**: the official models.dev snapshot was retrieved through a successful HTTP 200 response and independently pinned to the upstream `dev` commit above; the direct `curl.exe` path remains unavailable in this environment, but no provenance value was inferred from that failed path.

## Architecture

```text
vendored snapshot / online last-known-good cache
        -> schema validation + provenance
        -> provider defaults + model override merge
        -> dialect allowlist + env redaction + family table
        -> catalog projection API
        -> provider-editor import review
        -> explicit save through model-provider-persistence
        -> user models.json / configured-model-catalog
```

Architecture cell: `server/domain/models + model-provider persistence + model-providers controller + public/personas`

Map delta: none

Why: this extends the existing provider/configuration ownership cell and does not introduce a parallel store, queue, or runtime registry.

## Eval / Tracking Contract

- **Primary users + activation**: provider-editor operators; activation is a catalog import attempt.
- **Friction metric**: import attempts that end in manual correction or are rejected for an unknown dialect/family, measured without recording secret values.
- **Regression fixtures**: provider/model override fixture; multi-env redaction fixture; cache-vs-`models.json` isolation fixture; unknown dialect/family fixture; UI metadata/control separation fixture.
- **Sunset signal**: remove or revise the importer if the upstream schema is unavailable for two release cycles or if runtime support makes the explicit allowlist obsolete; a replacement must preserve provenance and storage isolation.

## Risk

| Risk | Mitigation |
|---|---|
| Upstream schema changes | strict schema/version checks, vendored pin, last-known-good cache |
| Wrong dialect inference | explicit allowlist and fail-closed manual state |
| Secret leakage through env metadata | provider-specific allowlist; names only; no value access |
| Catalog metadata mistaken for runtime capability | separate UI sections and typed projection |
| Remote source unavailable | vendored snapshot remains usable; online refresh is optional |

## Open Questions

1. Which exact models.dev commit and payload hash will be used for the first vendored snapshot? **Resolved: `e951706c7e89d932c0814bb53534b1762c2230ea` and `e9cf5169bf822b9ded99431beea42a34dddc1fa6750732bcc674096fd666349d`, documented in `assets/model-catalog.SOURCE.md`.**
2. Which provider-specific env names are key inputs for the initial allowlist? **Must be derived from reviewed provider contracts, not a regex.**
3. Which catalog fields, if any, can be added to token-usage UI in P3 without implying billing accuracy?

## Timeline

| Date | Event |
|---|---|
| 2026-08-05 | v2.1 design revised after source audit; operator questions captured. |
| 2026-08-06 | Operator authorized F004 kickoff and the mapping/domain plus provider-editor UI implementation split. |
| 2026-08-07 | PR #57 squash-merged as `3350b38`: catalog import UI with honest metadata/runtime split, 12/12 browser acceptance, and post-review fix `8aa8dc1` (import merges into existing provider instead of replacing it; provider connection fields fill-only-when-missing). Cross-family review chain: 砚砚 (Maine Coon) + opus (Ragdoll) approvals; cloud Codex gate unavailable (quota), replaced by full cross-provider local review. AC-2–AC-8 marked done on this evidence. |
| 2026-08-07 | AC-1 vendored snapshot generated from `https://models.dev/api.json`, pinned to upstream `dev` commit `e951706c7e89d932c0814bb53534b1762c2230ea`, with raw payload hash, normalized-provider hash, MIT license, and reproducibility fixture; local full `test:fast` gate passed. |
| 2026-08-07 | Phase P1 merged (PR #58): vendored models.dev snapshot and runtime-safe provenance verification. |
| 2026-08-07 | Fixed catalog search caret loss after provider-list rerenders; added a regression test preserving selection range and direction. |
| 2026-08-08 | Acceptance follow-up merged (PR #59, squash `b9c5af0`): catalog search now matches provider id/name only and filters the loaded 180-provider DOM in place; focused 6/6, browser 13/13 (`catalogRequests=1->1`, `inputStable=true`), typecheck/test:fast, and cross-provider fallback review passed. |
| 2026-08-08 | Configured-provider identity hotfix merged (PR #60, squash `09f51fb`): configured-provider cards now show the stable provider ID instead of the runtime API dialect; behavior-level regression, isolated Edge acceptance, full gate, CI, and cross-provider fallback review passed. |

## Review Gate

Cross-family review is required after quality-gate and fresh-context scan. Domain/import mapping and provider-editor UI must be reviewed by a different individual; no self-review or self-merge.

## Links

- [Kickoff discussion and decision record](../../feature-discussions/2026-08-06-F004-models-dev-catalog/README.md)
- [Implementation plan](../../feature-specs/2026-08-06-F004-models-dev-catalog-implementation-plan.md)
- [F002 Pi SDK Host Migration](F002-pi-sdk-host-migration.md)
- [F003 Cross-Conversation Delivery and Pi MCP Bridge](F003-cross-conversation-delivery-pi-mcp-bridge.md)

## Tips Contribution (F244)

- “从目录导入只会展示变量名，密钥值仍由 operator 在本地填写”：sourceRef = AC-4。
- “目录元数据不等于 Pi runtime 能力”：sourceRef = AC-7。

## Non-goals

- 不扩展 `models.json` 契约或把 models.dev 全量目录当作已配置模型。
- P1 不做在线刷新、自动定时抓取、计费真相或自动推断未知方言/族。
- 不读取、上传、日志记录或持久化任何环境变量值、credential、header 或外部 auth 文件。
- 不连接 Redis 6399 或使用生产用户数据。
