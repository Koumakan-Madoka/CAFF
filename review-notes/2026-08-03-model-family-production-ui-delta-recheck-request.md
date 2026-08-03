---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, delta, provider-management, concurrency, ui]
doc_kind: review-request
created: 2026-08-03
---

# Delta Recheck Request: Provider Management Mutation Race

Review-Target-ID: feat-model-family-roles-implementation  
Branch: `feat/model-family-roles-implementation`  
Prior approved code SHA: `fcae97f`  
New code SHA: `6e3573b1ccd3f4078c42c597543fe63996f1d4f5`  
Exact delta: `fcae97f..6e3573b`

## Finding Disposition

| # | Reviewer finding | Disposition | Evidence |
|---|---|---|---|
| P2 | Provider save → add → cancel could leave a ghost draft / flaky UI test | Accepted and expanded through failure-mode audit | Deterministic response gate RED; centralized mutation lock GREEN |
| P3-1 | Missing explicit 900px assertion | Push back: factually already present in reviewed SHA | `tests/ui/model-family-roles-production.test.js:459-465` sets width 900 and asserts 1 field column / 2 model columns |
| P3-2 | Existing-roster recovery invariant needs an inline comment | Accepted | `server/api/conversations-controller.ts:722-723` |

## What Changed

- Added one Provider mutation lock covering save, clear-secret, remove and validate through server response projection and role-directory refresh.
- While locked, Add and Refresh buttons are disabled, Provider list/detail are `inert`, and detail exposes `aria-busy=true`.
- A controlled server-response gate makes the original race deterministic instead of relying on repeated random timing.
- Failure-mode sweep found the sibling Refresh entry point; a second RED proved it remained enabled, then the same lock closed it.
- Added a bug diagnosis/verification record at `docs/bug-report/model-provider-save-add-race/bug-report.md`.

## Red → Green

```text
RED 1
  addDisabled=false
  listInert=false
  detailInert=false
  detailBusy=null

GREEN 1
  Add/list/detail/busy assertions pass

RED 2 (failure-mode sibling audit)
  refreshDisabled=false

GREEN 2
  Add + Refresh + list + detail remain unavailable until mutation completion
```

## Verification

```text
node tests/ui/model-family-roles-production.test.js
  PASS 12/12 consecutive runs for initial fix
  PASS 8/8 consecutive runs after Refresh audit

npm run check
  PASS

npm run typecheck
  PASS

node tests/ui/new-conversation-dialog.test.js
  PASS

npm test
  PASS; smoke 64/64

git diff --check
  PASS
```

No matching `.pen` files and no root-level media/design artifacts. Repository still lacks the automated fallback/hotfix scripts; manual inspection found one state lock and no new fallback chain.

## Open Questions

1. Does the lock cover the entire dangerous interval through `setProviders()` and `onProvidersChanged()`, not merely the HTTP fetch?
2. Can any remaining interactive entry point change Provider list/detail state while a mutation is pending?
3. Does unlock reliably occur on success and error without leaving local-admin-disabled deployments enabled?
4. Is the deterministic response-gate test free of its own shutdown/hanging race?

## Next Action

Please independently recheck exact delta `fcae97f..6e3573b` and return `APPROVE` or `REQUEST-CHANGES` for code SHA `6e3573b`. Please also confirm the P3-1 push-back against the cited 900px assertion.

[砚砚/gpt-5.6-sol🐾]
