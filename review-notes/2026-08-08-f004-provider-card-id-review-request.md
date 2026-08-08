---
feature_ids: [F004]
topics: [review, provider-management, provider-id, ui, hotfix]
doc_kind: review-request
created: 2026-08-08
---

# Review Request: Configured Provider Card Shows Provider ID

Review-Target-ID: f004
Branch: `fix/f004-provider-card-id`
Exact product SHA: `fe430934493c34e2822b7b9348e4b0399ed11dc5`
Base: `origin/main@260ca54602d1f5ebaf3acc2ff670c6a1ec994cd5`

## What

- Changes the configured-provider card metadata from `provider.api` to `provider.id`.
- Keeps model count and validation status unchanged.
- Adds a behavior-level regression test, bug report, and author evidence packet.

## Why

The configured-provider card identifies the saved provider. The acceptance payload correctly contained both `id=kimi-for-coding` and `api=anthropic-messages`, but the UI projected the runtime API dialect as if it were the provider identity.

## Original Requirements

Source: `docs/bug-report/configured-provider-card-shows-api/bug-report.md` and operator acceptance message `0001786159960734-001060-762f8761`.

- A configured-provider card must show the configured provider's stable ID beneath its display name.
- For the acceptance fixture, the visible identity must be `kimi-for-coding`.
- `anthropic-messages` is the runtime API dialect and must not replace the provider identity in the card metadata.
- The runtime API field remains available in the provider detail editor.
- Model count and validation status remain unchanged.
- No API payload, persistence, router, store, or runtime contract changes are authorized by this fix.

## Tradeoff

The fix is intentionally limited to the list-card projection. It does not add another label or duplicate the runtime dialect on the card; the dialect remains in the editor where it is actionable. `provider.id` requires no fallback because the API projection derives it from every configured-provider map key.

## Architecture Ownership

Architecture cell: `public/personas` provider-management surface

Map delta: none

Why: the diff corrects one existing UI projection and does not add or change a Store, Queue, Router, Adapter, Dispatcher, Binding, API, or persistence contract.

## Fresh-Context Decision

Skipped under the `fresh-context-review` trigger table: this is a hotfix-style acceptance correction with one changed product line. Independent cross-family quality-gate coverage is recorded below; formal review is still required.

## Independent Quality Gate

Ragdoll/Opus independently returned `PASS` for exact product SHA `fe43093` with no P1/P2. It verified that `server/domain/models/model-provider-config.ts` derives `provider.id` from every configured-provider map key, that the regression test fails if `provider.api` returns to the card, and that the scope is limited to the intended projection.

Independent reruns:

```text
node --test tests/runtime/model-family-roles-ui.test.js
  PASS 5/5

node --test tests/runtime/model-provider-config.test.js
  PASS

npm run typecheck
  PASS

npm run build
  PASS

git diff --check
  PASS
```

## Author Verification

```text
RED
  Card text was: anthropic-messages · 1 个模型 · 待验证
  Expected provider ID was absent.

GREEN
  node --test tests/runtime/model-family-roles-ui.test.js: 5/5
  npm run test:fast: exit 0
  npm run typecheck: exit 0
  npm run build: exit 0
  git diff --check: clean
```

Browser acceptance on the isolated `3184` instance showed:

```text
kimi-for-coding · 1 个模型 · 待验证
```

The page did not show `anthropic-messages` in the card metadata. Ports 3003/3004 and Redis 6399 were not used. The unrelated untracked `Microsoft/` directory is outside the diff and must remain untouched.

## Open Questions

### Technical OQ

1. Does the final diff consistently treat provider ID as the card identity without hiding or mutating the runtime API setting?
2. Does the regression test exercise rendered behavior strongly enough to fail on a return to `provider.api`?
3. Is the absence of an ID fallback valid under the configured-provider API contract?
4. Is the hotfix scope limited to the reported acceptance defect with no collateral contract change?

### Value OQ

None. The operator directly specified the expected card identity during acceptance.

## Next Action

Please independently review the final branch HEAD and return `APPROVE` or `REQUEST-CHANGES`, with P0/P1/P2/P3 findings and independent evidence. This request does not treat the quality-gate PASS as formal merge approval.

[砚砚/gpt-5.6-sol🐾]
