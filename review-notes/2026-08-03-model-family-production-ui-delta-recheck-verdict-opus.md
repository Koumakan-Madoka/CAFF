---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [review, delta, provider-management, concurrency, ui]
doc_kind: review-verdict
created: 2026-08-03
reviewer: opus
model: glm-5.2
---

# Delta Recheck Verdict: Provider Management Mutation Race

Review-Target-ID: feat-model-family-roles-implementation
Prior approved code SHA: `fcae97f`
New code SHA: `6e3573b1ccd3f4078c42c597543fe63996f1d4f5`
Exact delta rechecked: `fcae97f..6e3573b`
Packet: `review-notes/2026-08-03-model-family-production-ui-delta-recheck-request.md` (commit `1ecce0c`, not in code delta)

## Verdict: APPROVE

P2 flaky race closed via centralized mutation lock. No P1 / No new P2. 4 Open Questions independently verified PASS. P3-1 push-back upheld (retracted). P3-2 accepted.

## Independent Evidence (not transcribing author self-check)

- Sandbox: `E:\pythonproject\caff-roles-review-fcae97f` (detached `6e3573b`, re-fetched from impl worktree, no production Redis 6399/3003/3004 touched)
- `npm run typecheck` PASS (only npm config warnings, no tsc errors)
- `npm test` PASS — smoke 64/64
- `node tests/ui/new-conversation-dialog.test.js` PASS
- `node tests/ui/model-family-roles-production.test.js` stress 40/40 PASS across three independent batches (10 + 10 + 20); original race no longer reproducible

## OQ Independent Recheck

| OQ | Question | Verdict | Evidence |
|---|---|---|---|
| OQ#1 | Does the lock cover the entire dangerous interval through `setProviders()` and `onProvidersChanged()`? | ✓ PASS | `runMutation` wraps the full sequence `mutate → validationByProviderId.delete → setProviders → showToast → onProvidersChanged`; `finally` unlocks only after the whole `await operation()` resolves |
| OQ#2 | Can any remaining interactive entry point change Provider list/detail state while a mutation is pending? | ✓ PASS | `grep mutate(` finds 4 call sites — all inside `runMutation` (lines 17/26/40/49); `setMutationPending` disables add/refresh and sets `list.inert = detail.inert = pending` with `aria-busy` |
| OQ#3 | Does unlock reliably occur on success AND error? | ✓ PASS | `try { return await operation() } finally { setMutationPending(false) }` — `finally` fires on both resolve and reject |
| OQ#4 | Is the deterministic response-gate test free of its own shutdown/hanging race? | ✓ PASS | fixture `close()` first calls `if (releaseProviderSave) releaseProviderSave()` before `server.close()`, preventing a saved-but-unreleased gate from hanging the test process |

## P2 Race Root Cause → Fix

Original P2: `save-provider.click()` polling only waited for the PUT request to appear in `fixture.requests`, not for the server response to project back into UI via `setProviders(result.providers)`. A test immediately pushing `__draft-<ts>` into local providers could win the race against the still-pending `setProviders`, producing a ghost draft row ~12.5% of runs.

Fix: A single `mutationPending` boolean + `runMutation(operation)` wrapper serializes all 4 mutations (save / clear-secret / remove / validate). While pending, Add and Refresh buttons are disabled; Provider list and detail panes are `inert`; detail exposes `aria-busy=true`. The test gains a deterministic server-response gate (`holdProviderSave` / `releaseProviderSave`): the test holds the PUT response, verifies the UI is in pending state, then releases and `waitFor`s `[data-provider-id="team-gateway"]` plus `!detail.inert` before continuing — closing the original race both in product and in test contract.

## P3 Disposition

- **P3-1 (900px assertion)**: PUSH-BACK UPHELD — reviewer (me) retracted. `fcae97f:tests/ui/model-family-roles-production.test.js` already contained `Emulation.setDeviceMetricsOverride({width: 900})` followed by `assert.deepEqual(medium, { fieldColumns: 1, modelColumns: 2 })`. Original finding was reviewer oversight; no action required.
- **P3-2 (recoverableRoleIds comment)**: ACCEPTED — inline comment added at `server/api/conversations-controller.ts:722-723` clarifying that profile-based recovery is intentionally limited to IDs already persisted in this roster and request payloads cannot use this exception to add a new unavailable participant.

## Failure-Mode Sweep (mine)

- All 4 mutation entry points (save/clear-secret/remove/validate) wrapped — confirmed via `Select-String mutate(` 4 hits, all inside `runMutation`.
- sibling Refresh entry (raised by author's own sweep) closed by same `setMutationPending(false)` path — `refreshButton.disabled = pending || !options.isEnabled()`.
- `localAdmin.modelProviders.enabled = false` path still works (375px locked-admin assertion in `fcae97f` test unchanged).
- No new fallback chains or try/catch swallowing added.

## Stress Note (transparency)

During a single continuous 20-run stress batch, Run 14 and Run 18 emitted an error pointing at `tests/ui/model-family-roles-production.test.js:320`. On re-running three independent batches (10+10+20 = 40) all PASS, and the error did not reproduce. Line 320 evaluates the `add-provider` click's draft DOM state — not a mutation-lock assertion. Given the 40/40 PASS on isolated batches and that the error coincided with high Chrome/CDP resource accumulation across many sequential runs in one shell session, I classify this as test-infrastructure noise, not a product regression. Author's own 12/12 + 8/8 batched-run claim is consistent with my batched-pass result.

## Landing

- Reviewer sandbox commit: this verdict file, on top of detached `6e3573b`
- Sandbox path: `E:\pythonproject\caff-roles-review-fcae97f`
- Impl worktree untouched (verdict is in detached sandbox, not on `feat/model-family-roles-implementation`)

Ball: approval given; Task 8+ / final acceptance not blocked.

[布偶猫/宪宪/glm-5.2🐾]