---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, models, catalog, providers, dark-mode, roles]
doc_kind: review-request
created: 2026-08-04
---

# Review Request: Model Catalog Visibility and Dark Management Surfaces

Review-Target-ID: model-catalog-dark-mode
Branch: `fix/model-catalog-dark-mode`
PR: https://github.com/Koumakan-Madoka/CAFF/pull/53
Base: `origin/main@1485dde1123164d981e7ff4542b08fc8e916a7e3`
Exact code SHA: `99b22bfebb1f71ca636f24737c571c9f9dba1bf4`

## What

- Restricts user-facing model options to explicit `models.json` entries plus the exact runtime default.
- Keeps Pi's runtime registry metadata-only for display labels and supported thinking levels.
- Shows model name, provider, and source (`已配置` / `运行时默认`) in every model selector.
- Replaces model-family role/provider management white and beige hardcoding with semantic Light/Dark tokens.
- Extends the real-browser theme gate to exercise the role view, provider draft, provider model row, and provider removal confirmation in both themes.
- Adds a direct catalog-to-role regression proving a registry-only model makes an existing role explicitly unavailable rather than leaking back into the directory.

## Why

Post-merge acceptance exposed 1079 Pi built-in routes as if they were configured model services, making the selector look duplicated and hiding route provenance. The same acceptance pass found white cards in Dark mode because the new model-family management CSS bypassed shared theme tokens.

## Original Requirements

> “为什么可选的模型列表中，那么多重复的模型；而且在前端dark模式下，角色与模型管理界面有些卡片依然是白底的，好像没有适配dark模式”
>
> “修一下吧，我都不知道你从哪里拉取下来的模型服务。。”

- Source: operator messages recorded in `feature-discussions/2026-08-02-model-family-roles/README.md` and the current thread.
- Please judge whether the picker now exposes only operator-relevant routes with understandable provenance, and whether both role/provider management paths are genuinely Dark-compatible.

## Tradeoff

- Same-name models from different providers remain distinct because they are different executable routes; this change does not perform name-only deduplication.
- CAFF does not copy Pi's capability table. Registry-only routes stay hidden, while matching visible keys still receive registry labels and thinking capabilities.
- Backend `sourceLabel` remains stable diagnostic metadata (`models.json` / `runtime default`); the shared browser formatter localizes the known `source` enum for user-facing Chinese copy.

## Architecture Ownership

Architecture cell: CAFF configured model catalog + RoleService availability projection + existing management UI/theme verifier
Map delta: none
Why: the diff narrows an existing catalog boundary and updates existing browser surfaces/tests; it adds no parallel Store, Queue, Router, Adapter, Dispatcher, Binding, provider format, or capability registry.

Reviewer checks:

- Registry-only entries cannot reach bootstrap or any model selector.
- Matching registry metadata still enriches configured/default entries.
- Catalog narrowing propagates to explicit role unavailability and cannot silently swap models.
- Both Role and Model Provider views, including hidden danger state and model rows, consume semantic theme surfaces.

## Open Questions

### Technical OQ

1. Is `models.json + exact runtime default` the correct complete visibility boundary without losing metadata enrichment?
2. Can any selector bypass `buildModelOptionLabel()` or make different-provider same-name routes indistinguishable?
3. Does the browser sampling safely exercise provider draft/model/danger states without persisting mutations?
4. Are the Light/Dark luminance thresholds and semantic surface coverage sufficient for future regressions?

### Value OQ

None. The operator explicitly requested this correction.

## Fresh-Context Findings

Agent: `[烁烁/k3-256k🐾]`
SHA scanned: `2e33d43`
Total findings: 5 (0 P1, 2 P2, 3 P3)

| # | Finding | Author disposition | Status |
|---|---|---|---|
| FC-1 | Browser luminance sampling did not exercise provider-only model rows or danger confirmation | Fixed in `99b22bf`: the verifier creates an unsaved provider draft when needed, adds a model row, expands removal confirmation, samples both views, then returns to roles without server mutation | ✅ |
| FC-2 | No direct regression connected registry-only catalog narrowing to role unavailability | Fixed in `99b22bf`: actual `ConfiguredModelCatalog` output is fed to `RoleService`; the Kimi role reports `no_family_models` and participant validation rejects it | ✅ |
| FC-3 | Frontend Chinese source labels differ from backend English `sourceLabel` | Dismissed: this is an intentional presentation/diagnostic split; known enum values always use the localized shared formatter and do not render the backend fallback | Closed |
| FC-4 | Static CSS regex is selector-order-sensitive | Dismissed as a secondary guard; the strengthened real-browser computed-style verifier is the primary behavioral contract | Closed |
| FC-5 | Empty-provider runtime-default key is possible in injected test seams | Dismissed as pre-existing and non-production: the production reader resolves `DEFAULT_PROVIDER`; current code also skips empty registry providers | Closed |

Reviewer delta tracking: mark findings `[FC:covered]`, `[FC:new]`, or `[FC:N/A]` where useful. Fresh-context produced no approval verdict.

## Quality Gate Report

### Vision and Delivery Completeness

- The selector no longer exposes Pi's wholesale built-in registry. Isolated acceptance bootstrap returned 8 visible routes: 7 copied configured models plus 1 exact runtime default.
- Every model selector uses the shared provider/source label builder.
- Role and Provider management surfaces use semantic tokens; no white/beige hardcoded management background remains.
- No deferred behavior, follow-up tail, new external dependency, credential boundary change, or persistent-data mutation is introduced.

### Dogfood-Your-Slice

- Worktree: `E:\pythonproject\caff-model-catalog-dark-fix`
- URL: `http://127.0.0.1:3125/personas.html`
- Data: isolated temporary SQLite and a copy of acceptance `models.json`; no authentication files copied; existing 3123 acceptance instance untouched.
- Bootstrap result: `8 = 7 models_json + 1 runtime`.
- Actual role selector label: `Claude Acceptance · anthropic · 已配置`.
- Actual Dark role/provider surface colors: `rgb(37,40,37)`, `rgb(58,41,34)`, `rgb(30,33,31)`, `rgb(58,48,32)`, `rgb(61,38,37)`, `rgb(17,19,18)`.
- Evidence screenshots: `%TEMP%\caff-model-catalog-dark-evidence\personas-dark-roles.png` and `personas-dark-providers.png`.
- Full walkthrough evidence is outside Git under `%TEMP%\caff-ui-verify\`.

### Automated Verification

```text
npm test
  PASS; test:fast all suites green; test:smoke 65 + 20 pass

npm run test:ui
  PASS; 109/109 browser checks; 15/15 structure contract

npm run typecheck
  PASS

git diff --check
  PASS

fresh-context Red→Green
  RED: theme-icons contract failed because provider-state sampling was absent
  GREEN: focused runtime/theme tests pass and verify-ui is 109/109
```

The current repository does not contain the generic hotfix-pattern, fallback-layer, architecture-ownership, or capability-tips scripts. Manual inspection found no new architecture cell, no three-layer fallback, and no root-level media/design artifact. `designs/**/*.pen` has no match; the existing HTML UI gate remains the design source.

## Review Sandbox

- Suggested path: `E:\pythonproject\caff-model-catalog-dark-review-opus`
- Checkout: detached/read-only at exact code SHA `99b22bf`
- Bootstrap: clear inherited `NODE_ENV`, then `npm ci`
- Validation: `npm run typecheck`, `npm test`, `npm run test:ui`
- Optional browser dogfood: use temporary `PI_CODING_AGENT_DIR`/`PI_SQLITE_PATH`, `CAFF_DISABLE_ENV_LOCAL=1`, and loopback port `3126`
- Ports: monolith web/API `3126`; never use reserved 3003/3004 or Redis 6399

## Next Action

Please independently review exact code diff `1485dde..99b22bf` and return `APPROVE`, `REQUEST-CHANGES`, or `COMMENT` for SHA `99b22bf`, with findings first and independently rerun evidence. For PR provenance, publish the logical verdict as a PR #53 issue comment because all cats share one GitHub login.

[砚砚/gpt-5.6-sol🐾]
