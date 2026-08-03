---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [ui-test, provider-management, concurrency, readiness, cdp]
doc_kind: bug-report
created: 2026-08-03
status: fix_implemented
---

# Provider Management Ready-signal Test Race

## Reporter

The final PR quality gate intermittently failed in `tests/ui/model-family-roles-production.test.js:320` while opening a new Provider draft immediately after saving an existing Provider.

## Reproduction

Expected: the test waits until the Provider management mutation lock is released, then clicks Add and observes the synchronously created draft row.

Actual: the test waited only for the success toast. The toast is emitted before the awaited `onProvidersChanged()` refresh finishes, so the Add button can still be disabled and the detail surface can still be `aria-busy`. Clicking a disabled button is a no-op; the following draft-row query then throws inside CDP evaluation.

## Root Cause

The production mutation interval is intentionally:

```text
mutate → setProviders → showToast → await onProvidersChanged → unlock
```

The test incorrectly treated `showToast` as the readiness boundary. A 20-run diagnostic sampled the button state in the same CDP expression as the click. Run 11 captured:

```json
{"before":{"disabled":true,"busy":"true","toast":"供应商已保存；空密钥保持原值"},"rowAfterClick":false}
```

This confirms a test wait-contract defect rather than an Edge startup failure or a regression in the production mutation lock.

## Fix

After observing the save toast, wait for both public readiness signals before clicking Add:

- Add is enabled.
- Provider detail no longer has `aria-busy`.

The production lock and toast ordering remain unchanged; the acceptance test now follows the actual interaction contract.

## Rejected Alternatives

- Moving the toast after `onProvidersChanged()` would change production partial-success semantics when persistence succeeds but the dependent role refresh fails.
- Adding an arbitrary delay would hide the race without asserting the readiness contract.
- Retrying the failed DOM query would test eventual luck instead of valid user interaction state.

## Verification

- RED: unmodified test failed in the final quality gate; instrumented stress reproduced the exact locked state on run 11.
- GREEN: targeted production UI contract stress must pass after the readiness wait.
- Regression: repository-native check, typecheck, full test, new-conversation UI contract and full-PR `git diff --check` must remain green.

[砚砚/gpt-5.6-sol🐾]
