# F005 Phase C Image Composer and Timeline Implementation Plan

**Feature:** F005 — `docs/features/F005-image-input-and-multimodal-routing.md`
**Goal:** Operator can select or paste images, preview/remove them, send them with or without text, and reliably see image messages after SSE updates, history loading, and refresh without any silent image loss.
**Acceptance Criteria:** AC-C1 file selection + paste + preview + remove + image-only/text+image send + fail-closed validation/upload feedback; AC-C2 one rendering path for optimistic, SSE, history, and refresh with visible missing-image fallback.
**Architecture cell:** `public/chat (composer/timeline)` consuming the existing image upload and message APIs.
**Map delta:** none
**Map delta why:** CAFF has no centralized ownership map; Phase C stays inside the existing `public/chat` browser ownership cell and does not add a store, router, or backend contract.
**Architecture:** Add a focused `public/chat/image-composer.js` controller that owns attachment lifecycle, batch identity, previews, upload retries, and composer send eligibility. Add a focused `public/chat/message-images.js` renderer used by the existing timeline so persisted and optimistic messages share one image path. `public/app.js` remains the composition boundary for submission and optimistic rollback.
**Tech Stack:** Plain browser JavaScript, FormData/fetch, jsdom + `node:test`, existing CSS tokens and AppShell primitives.
**前端验证:** Yes — focused jsdom tests plus Playwright/Edge proof at desktop and 375px.

---

## Finish line and non-goals

The finished composer accepts file-picker and clipboard images, uploads the current ordered strip as one batch, sends the returned ordered `imageIds`, preserves the strip on message failure, and clears/revokes previews only after message success. The timeline renders all image content blocks before text, with one-column/single-image and two-column/multi-image layouts and a visible load-failure placeholder.

Not building: drag-and-drop, lightbox, attachment reordering, arbitrary files, client-side image decoding, or a new attachment persistence layer.

## Cross-layer data flow

```text
GET /api/image-upload/config
  -> ImageComposer validation config
File[] from picker/paste
  -> ordered AttachmentStrip
  -> FormData(client_request_id, files[])
  -> POST /api/conversations/:id/images
  -> ordered imageIds
content + imageIds + message clientRequestId
  -> POST /api/conversations/:id/messages
  -> metadata.contentBlocks
  -> MessageTimeline -> MessageImages renderer
```

Validation ownership: browser performs config-backed MIME/size/count checks for immediate feedback; the server remains authoritative for magic bytes, structure, dimensions, ownership, capability, and batch integrity.

## Stateful object census

### 1. AttachmentStrip

Lifecycle owner: `createImageComposerController`. Generic form submission must not mutate it directly; `public/app.js` may only read a snapshot, report send success, or report send failure.

| Current | Event | Next | Side effects |
| --- | --- | --- | --- |
| empty | picker/paste files | pending_validation or rejected | create object URLs; create a new upload key if every item is locally valid |
| ready | add/remove item | pending_validation or empty | invalidate all old imageIds; create a new upload key; re-upload the complete ordered remainder |
| pending_validation | upload success | ready | assign ordered imageIds only when response count matches strip count |
| pending_validation | upload/network/server failure | rejected | retain files/previews; expose batch error and retry |
| rejected | retry without strip mutation | pending_validation | reuse the same upload key |
| rejected | add/remove item | pending_validation, rejected, or empty | create a new upload key; deterministic local rejects remain visible |
| ready | message send failure/422 | ready | keep files, previews, imageIds, and upload key |
| ready | message send success | empty | revoke every object URL and clear file input |
| any | conversation changes | empty | revoke every object URL so staged images cannot be attached to another conversation |

### 2. UploadBatchAttempt

Lifecycle owner: `ImageComposer`; derived from the exact ordered strip, never persisted independently in DOM attributes.

| State | Event | Next | Rule |
| --- | --- | --- | --- |
| idle | valid non-empty strip mutation | uploading | generate a fresh `client_request_id` before the first request |
| uploading | unknown network outcome | retryable_error | retain the key because the server outcome is unknown |
| uploading | `UPLOAD_IN_PROGRESS` | retryable_error | retain the key and surface retry guidance |
| uploading | deterministic reject/conflict | rejected | retain evidence; a strip mutation is required for a new key |
| uploading | ordered response matches | complete | publish imageIds atomically to the strip |
| retryable_error | retry, unchanged strip | uploading | reuse key and exact FormData payload order |
| any | strip mutation | idle | discard old result/key and start a fresh batch |

### 3. OptimisticImageMessage

Lifecycle owner: existing optimistic-message map in `public/app.js`. It is a projection of the ready strip, not a second attachment state store.

| State | Event | Next | Rule |
| --- | --- | --- | --- |
| absent | valid submit | pending | copy content blocks with current preview URLs; never take ownership of URLs |
| pending | server accepted | absent | persisted accepted message becomes timeline truth |
| pending | send failure | absent | remove optimistic card; composer restores text and retains strip |

## Invariants

- **INV-1:** `hasPayload = content.trim().length > 0 || strip.length > 0`.
- **INV-2:** `canSend = baseComposerEnabled && hasPayload && strip.every(item => item.status === 'ready')`.
- **INV-3:** The ordered `imageIds` list exists only when every current strip item is ready and the response count equals the strip count.
- **INV-4:** Every strip add/remove mutation invalidates prior imageIds and creates a new upload key; retry without mutation reuses the existing key.
- **INV-5:** Message failure never clears or revokes the strip; message success clears and revokes it exactly once.
- **INV-6:** Conversation changes clear the strip before the new conversation can send.
- **INV-7:** `metadata.contentBlocks` is the only timeline image input; image blocks render before text through one renderer for optimistic, SSE, history, and refresh data.
- **INV-8:** Every image tile has either a loaded image or a visible fallback; load failure cannot leave a blank tile.
- **INV-9:** Attachment entry is disabled until config is loaded and remains disabled after config failure.
- **INV-10:** Browser MIME/size/count checks are advisory only; server errors remain visible and are never translated into success.

## Adversarial scenarios and test mapping

| Scenario | Expected proof |
| --- | --- |
| Config request fails | attachment button disabled, reason visible, text-only send still works |
| Empty text + empty strip | send disabled/rejected |
| Text + empty strip | send allowed |
| Empty text + all ready | image-only send allowed |
| Text + pending/rejected item | send disabled |
| Add/remove after successful upload | old imageIds disappear; a new key uploads the entire current strip |
| Unknown upload failure then retry | same upload key and same ordered files |
| Upload response count mismatch | whole strip rejected; no partial ready state |
| `UPLOAD_IN_PROGRESS` | retryable error remains visible; retry uses same key |
| Message 422 or network failure | optimistic card removed, text restored, strip retained |
| Message success | strip cleared and all preview URLs revoked |
| Conversation switch with pending/ready files | strip cleared and URLs revoked |
| Persisted single/multiple images | image before text; max 320px single; two-column multi layout |
| Image load failure | visible placeholder with alt/retry-open context |
| Renderer rerun/SSE/history | no duplicate image gallery; same content-block path |

## Implementation tasks

### Task 1: Lock AttachmentStrip and upload semantics with RED tests

**Files:**
- Create: `tests/ui/image-composer.test.js`
- Create: `public/chat/image-composer.js`
- Modify: `package.json`

1. Write jsdom tests for the four send quadrants, config fail-closed, picker/paste intake, local rejects, add/remove invalidation, same-key retry, response mismatch, `UPLOAD_IN_PROGRESS`, message failure retention, success URL cleanup, and conversation-switch cleanup.
2. Run `node tests/ui/image-composer.test.js`; expect failures because the module does not exist.
3. Implement the smallest controller API required by the tests: `bindEvents`, `loadConfig`, `syncBaseAvailability`, `hasPayload`, `canSend`, `readyImageIds`, `optimisticContentBlocks`, `handleMessageSuccess`, `handleMessageFailure`, `syncConversation`, and `snapshot`.
4. Run the focused test until green, then add the module to `npm run check` and `test:fast`.

### Task 2: Lock content-block image rendering with RED tests

**Files:**
- Create: `tests/ui/message-images.test.js`
- Create: `public/chat/message-images.js`
- Modify: `public/chat/message-timeline.js`

1. Write tests for metadata image extraction, image-before-text DOM order, single/multi classes, safe new-tab links, missing/invalid URL fallback, load-error fallback, and idempotent rerender without duplicate galleries.
2. Run `node tests/ui/message-images.test.js`; expect failures because the renderer does not exist.
3. Implement `messageImageBlocks`, `imageBlockSignature`, and `syncMessageImages` in the focused module; wire one gallery node into each message card and include the image signature in timeline reconciliation.
4. Run both focused UI suites until green.

### Task 3: Integrate composer submission and shell UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/chat/conversation-pane.js`
- Modify: `public/styles.css`
- Modify: `public/assets/icons.svg`
- Modify: `public/shared/icons.js`
- Test: `tests/ui/image-composer.test.js`
- Test: `tests/ui/app-shell.test.js`

1. Add the hidden multiple image input, attachment button, strip, and attachment status using existing button/tokens; load the two new chat modules before `app.js`.
2. Compose the controller in `app.js`, pass base room/game lock state from `conversation-pane`, and bind config/input/paste events.
3. Change submit flow to accept image-only payloads, skip local slash-command interception when attachments exist, send `imageIds`, build image-aware optimistic messages, preserve text+strip on failure, and clear only on success.
4. Add responsive strip/gallery styles and 44px interactive targets; no drag/drop or lightbox styles.
5. Run focused tests plus `tests/ui/app-shell.test.js` and `npm run check`.

### Task 4: Cross-layer and browser verification

**Files:**
- Modify if needed: `scripts/verify-ui.mjs`
- Evidence only: temporary runner output under `.tmp/`

1. Run `npm run typecheck` and `npm test`.
2. Run `git diff --check`.
3. Start an isolated acceptance app on a dynamic non-reserved loopback port with `CAFF_DISABLE_ENV_LOCAL=1`, temporary SQLite, and isolated uploads.
4. Verify desktop and 375px: config success, select/paste, preview/remove, image-only send, text+image send, visible 422 feedback with retained strip, persisted timeline image, and missing-image fallback. Keep evidence bounded to at most three screenshots and one short walkthrough.
5. Run `quality-gate`, commit with a Why body, then request cross-individual review from `@opus`.

## Open questions

- **Technical OQ:** Whether the existing UI verification runner can inject a deterministic clipboard image. Resolve during Task 4; if browser clipboard permissions are unavailable, keep paste covered by jsdom and verify picker golden path in the browser.
- **Value OQ:** none. The UI gate already fixed picker + paste in scope and drag/drop/lightbox/reordering out of scope.
