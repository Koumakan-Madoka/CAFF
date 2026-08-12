---
feature_ids: [F005]
topics: [review, image, composer, conversation-switch, hotfix]
doc_kind: review_request
created: 2026-08-12
---

# Review Request: F005 destination room lock after a pending image send

Review-Target-ID: f005-room-lock-after-pending-send
Branch: fix/f005-room-lock-after-pending-send
Implementation-HEAD: c273e2d
Base: origin/main@ca74465

## What

Fix the post-merge F005 race where switching conversations during a pending image message could restore the source room's textarea state over the destination room's stricter lock.

- `clearItems({ restoreComposerState = true })` now names the two cleanup semantics.
- Normal message success/history confirmation retains source-state restoration.
- `syncConversation()` clears source attachments with `restoreComposerState: false`, preserving the state already rendered for the destination room.
- A regression test locks the pending-send -> conversation-switch -> destination-lock path.

## Why

Cloud review on merged PR #66 found that `clearItems()` had two responsibilities but one restoration policy. During a room switch, `renderConversationPane()` first applies the destination room's no-agent/game lock. `syncConversation()` then cleared source attachments and restored `activeMessageSendToken.composerInputWasDisabled`, a stale source-room snapshot that is normally `false`. The following base-availability derivation could therefore treat a locked destination as enabled until another render.

Finding: https://github.com/Koumakan-Madoka/CAFF/pull/66#discussion_r3763343159

## Original Requirements

> The attachment controller must compose with the existing room and game locks; those locks remain authoritative.
> An image send freezes the caption and attachment controls while the message request is pending.
> A failed image send restores the source caption and keeps its attachment state available for retry.
> A conversation switch clears staged attachment UI from the room being left.
> Browser verification must cover the real composer state transitions, not only isolated DOM helpers.

- Source: `feature-specs/2026-08-11-f005-phase-c-image-ui.md`
- Source: `docs/features/F005-image-input-and-multimodal-routing.md`
- Source: `feature-discussions/2026-08-09-F005-image-input-multimodal/ui-design-gate.md`
- Please verify that the fix preserves destination-room authority without regressing success, confirmation, failure, or attachment cleanup behavior.

## Tradeoff

- Chose one explicit cleanup option instead of splitting the controller into multiple cleanup functions. The distinction is local, and all three callers remain visible together.
- Did not defer cleanup until after `syncBaseAvailability()`: that would retain source-room attachment UI during navigation and make ordering responsible for correctness.
- Did not add a second room-lock store. The conversation pane remains the lock owner; the image composer only preserves the DOM state it receives on a room switch.

## Architecture Ownership

Architecture cell: `public/chat` (image composer integrated with the existing conversation pane lock)
Map delta: none
Why: this changes one controller transition and its regression test; it adds no Store, Queue, Router, Adapter, Dispatcher, Binding, persistence contract, or ownership boundary.

## Failure-Mode Sweep

`clearItems()` has three semantic call paths, all reviewed and covered:

1. `syncConversation()` - preserve the destination renderer's current disabled state; this is the fixed path.
2. `handleMessageSuccess()` - restore the source room's pre-send state when the token is still active.
3. `confirmMessage()` - clear a persisted matching send and retain the existing success semantics.

Adjacent races were also checked: late success from the previous conversation cannot clear a new-room strip; late failure after switching cannot unlock the destination room; switching still revokes old preview URLs and clears staged UI.

## Open Questions

### Technical OQ

1. Is `restoreComposerState: false` at the conversation boundary the correct ownership expression, with the destination pane remaining authoritative?
2. Do all `clearItems()` callers retain the intended success/confirmation/switch semantics?
3. Browser-operate the exact path: source image message POST pending -> switch to a locked destination -> source request settles late. Verify textarea, attachment entry, hidden file input, and send button all remain disabled.

### Value OQ

None. This is a reversible correctness hotfix for an already-approved workflow.

## Next Action

Independently review `origin/main...c273e2d`. Return APPROVED or CHANGES REQUESTED with severity and exact code/test references. This is a frontend state-boundary hotfix, so the exact browser race must be operated rather than inferred only from the unit test.

## Review Sandbox

- Path: `C:/Users/ZN/AppData/Local/Temp/cat-cafe-review/f005-room-lock-after-pending-send/opus`
- Checkout: detached `c273e2d`
- Bootstrap: clear inherited `NODE_ENV`, then `npm ci`
- Build: `npm run build`
- Start: set `CAFF_DISABLE_ENV_LOCAL=1`, `CHAT_APP_HOST=127.0.0.1`, `CHAT_APP_PORT=3241`, `PI_CODING_AGENT_DIR=<isolated-temp-dir>`, and `PI_SQLITE_PATH=<isolated-temp-dir>/review.sqlite`; then run `node build/lib/app-server.js`
- Ports: `web=3241`, `api=3241` (same-origin app/API); reserved ports 3003/3004/6399 must not be used
- Runtime data: use a fresh temp directory only; never reuse local operator or production data

## Quality Gate

### Spec and scope

- Vision: room/game locks stay authoritative while image send failure/success behavior remains recoverable.
- Diff: 2 product/test files, 21 added/changed lines relative to `origin/main@ca74465`.
- Architecture mismatch scan: no parallel ownership primitive; `Map delta: none` matches the diff.
- Root media gate: no untracked or changed root-level media/design artifact.
- Dependency delta: none.

### Red -> Green

- Red: the new regression failed against the merged implementation because `input.disabled` became `false` after `syncConversation()` restored the source send token; expected destination lock `true`.
- Green: `node --test tests/ui/image-composer.test.js` -> 14/14 passed, including the new pending-send conversation-switch test.

### Final validation on `c273e2d`

```text
cmd /d /s /c "npm test && npm run typecheck && npm run test:ui && npm run check && git diff --check origin/main...HEAD"
exit 0

npm test              exit 0 (fast + smoke)
npm run typecheck     exit 0
npm run test:ui       exit 0 (browser UI checks green; structure contract 15/15)
npm run check         exit 0
git diff --check      exit 0
```

Expected warning output is limited to existing npm config deprecation notices and synthetic failure-path logs asserted by the test suites.

### Targeted real-browser evidence

- Browser: Microsoft Edge through repository-owned `playwright-core`, headless, 1440x900.
- Runtime: current build from `c273e2d`, dynamic non-reserved port, fresh isolated SQLite and agent directory.
- Scenario: upload a real 1x1 GIF in a standard source room; hold the image message POST pending; switch to an unstarted `who_is_undercover` destination room; then settle the source request with an injected 500.
- Pending state: textarea/attachment button/file input/send button all disabled; old strip hidden with zero children.
- Late-failure state: all four controls remain disabled; old strip remains cleared.
- Checks: 5/5 green; no unexpected page errors. The browser console's single HTTP 500 is the deliberate late-failure injection.
- Evidence: `C:/Users/ZN/AppData/Local/Temp/cat-cafe-evidence/f005-room-lock-after-pending-send/c273e2d/evidence.json` plus two screenshots in the same directory.

[砚砚/gpt-5.6-sol🐾]
