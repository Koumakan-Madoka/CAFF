const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_SOURCE = path.join(ROOT, 'public', 'chat', 'image-composer.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function config(overrides = {}) {
  return {
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    maxImageBytes: 1024,
    maxImagesPerUpload: 5,
    maxImagesPerMessage: 5,
    ...overrides,
  };
}

function boot(options = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <form id="composer-form">
      <button id="composer-attach-button" type="button">attach</button>
      <input id="composer-image-input" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" />
      <div id="composer-attachment-strip"></div>
      <textarea id="composer-input"></textarea>
      <button id="send-button" type="submit">send</button>
      <span id="composer-attachment-status"></span>
    </form>
  </body></html>`, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  const uploads = [];
  const revoked = [];
  const toasts = [];
  const requestIds = [];
  let requestSequence = 0;
  let conversationId = options.conversationId || 'conversation-1';

  window.CaffChat = {};
  window.eval(fs.readFileSync(MODULE_SOURCE, 'utf8'));

  const controller = window.CaffChat.createImageComposerController({
    dom: {
      composerForm: document.getElementById('composer-form'),
      composerInput: document.getElementById('composer-input'),
      sendButton: document.getElementById('send-button'),
      attachButton: document.getElementById('composer-attach-button'),
      fileInput: document.getElementById('composer-image-input'),
      strip: document.getElementById('composer-attachment-strip'),
      status: document.getElementById('composer-attachment-status'),
    },
    helpers: {
      createClientRequestId() {
        const id = `upload-${++requestSequence}`;
        requestIds.push(id);
        return id;
      },
      getConversationId() {
        return conversationId;
      },
      fetchConfig: options.fetchConfig || (async () => config()),
      async uploadBatch(input) {
        uploads.push({
          conversationId: input.conversationId,
          clientRequestId: input.clientRequestId,
          files: Array.from(input.files),
        });
        if (options.uploadBatch) {
          return options.uploadBatch(input, uploads.length - 1);
        }
        return {
          images: Array.from(input.files, (_file, index) => ({ imageId: `${input.clientRequestId}-image-${index + 1}` })),
        };
      },
      createObjectURL(file) {
        return `blob:${file.name}:${Math.random().toString(36).slice(2)}`;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
    showToast(message) {
      toasts.push(message);
    },
  });

  controller.bindEvents();

  return {
    dom,
    window,
    document,
    controller,
    uploads,
    revoked,
    toasts,
    requestIds,
    setConversationId(value) {
      conversationId = value;
    },
  };
}

function png(window, name = 'photo.png', bytes = 32) {
  return new window.File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

test('send eligibility follows the exact empty/text/ready/pending matrix', async () => {
  const pendingUpload = deferred();
  const app = boot({ uploadBatch: () => pendingUpload.promise });
  const input = app.document.getElementById('composer-input');
  const send = app.document.getElementById('send-button');

  app.controller.syncBaseAvailability(true);
  await app.controller.loadConfig();
  assert.equal(app.controller.hasPayload(''), false);
  assert.equal(app.controller.canSend(''), false);
  assert.equal(send.disabled, true);

  input.value = 'hello';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  assert.equal(app.controller.hasPayload('hello'), true);
  assert.equal(app.controller.canSend('hello'), true);
  assert.equal(send.disabled, false);

  input.value = '';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  const addPromise = app.controller.addFiles([png(app.window)]);
  assert.equal(app.controller.snapshot().items[0].status, 'pending_validation');
  assert.equal(app.controller.canSend(''), false);
  assert.equal(send.disabled, true);

  pendingUpload.resolve({ images: [{ imageId: 'image-1' }] });
  await addPromise;
  assert.equal(app.controller.snapshot().items[0].status, 'ready');
  assert.equal(app.controller.canSend(''), true);
  assert.equal(send.disabled, false);

  app.controller.syncBaseAvailability(false);
  assert.equal(app.controller.canSend('hello'), false, 'room/game locks remain authoritative');
  assert.equal(send.disabled, true);
});

test('config failure disables attachment entry but preserves text-only sending', async () => {
  const app = boot({ fetchConfig: async () => { throw new Error('config offline'); } });
  const input = app.document.getElementById('composer-input');
  const attach = app.document.getElementById('composer-attach-button');
  const status = app.document.getElementById('composer-attachment-status');

  app.controller.syncBaseAvailability(true);
  const loaded = await app.controller.loadConfig();
  assert.equal(loaded, false);
  assert.equal(attach.disabled, true);
  assert.match(status.textContent, /config offline/u);

  input.value = 'text survives';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  assert.equal(app.controller.canSend(input.value), true);
  assert.equal(app.document.getElementById('send-button').disabled, false);
});

test('picker and paste events feed the same ordered batch path', async () => {
  const app = boot();
  await app.controller.loadConfig();
  app.controller.syncBaseAvailability(true);
  const pickerFile = png(app.window, 'picker.png');
  const pastedFile = png(app.window, 'paste.png');
  const fileInput = app.document.getElementById('composer-image-input');

  Object.defineProperty(fileInput, 'files', { configurable: true, value: [pickerFile] });
  fileInput.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await app.controller.whenIdle();
  assert.deepEqual(app.uploads[0].files.map((file) => file.name), ['picker.png']);

  const paste = new app.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [pastedFile] } });
  app.document.getElementById('composer-input').dispatchEvent(paste);
  await app.controller.whenIdle();
  assert.equal(paste.defaultPrevented, true);
  assert.deepEqual(app.uploads[1].files.map((file) => file.name), ['picker.png', 'paste.png']);
  assert.equal(app.controller.snapshot().items.every((item) => item.status === 'ready'), true);
});

test('local invalid files remain rejected and block send until removed', async () => {
  const app = boot({ uploadBatch: async () => { throw new Error('must not upload invalid files'); } });
  await app.controller.loadConfig();
  app.controller.syncBaseAvailability(true);
  const bad = new app.window.File(['not-image'], 'notes.txt', { type: 'text/plain' });

  await app.controller.addFiles([bad]);
  const snapshot = app.controller.snapshot();
  assert.equal(app.uploads.length, 0);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].status, 'rejected');
  assert.match(snapshot.items[0].error, /image|格式|类型/iu);
  assert.equal(app.controller.canSend('caption'), false);

  await app.controller.removeItem(snapshot.items[0].id);
  assert.equal(app.controller.snapshot().items.length, 0);
  assert.equal(app.controller.canSend('caption'), true);
});

test('every strip mutation creates a new key and reuploads the complete remainder', async () => {
  const app = boot();
  await app.controller.loadConfig();
  app.controller.syncBaseAvailability(true);
  await app.controller.addFiles([png(app.window, 'a.png')]);
  const firstId = app.controller.snapshot().items[0].id;
  await app.controller.addFiles([png(app.window, 'b.png')]);
  await app.controller.removeItem(firstId);

  assert.deepEqual(app.uploads.map((call) => call.clientRequestId), ['upload-1', 'upload-2', 'upload-3']);
  assert.deepEqual(app.uploads.map((call) => call.files.map((file) => file.name)), [
    ['a.png'],
    ['a.png', 'b.png'],
    ['b.png'],
  ]);
  assert.deepEqual(Array.from(app.controller.readyImageIds()), ['upload-3-image-1']);
});

test('unknown upload retry and an actual 202 UPLOAD_IN_PROGRESS payload reuse the same key', async () => {
  let attempt = 0;
  const app = boot({
    uploadBatch: async (input) => {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error('network reset');
        error.status = 0;
        throw error;
      }
      if (attempt === 2) {
        return {
          error: { code: 'UPLOAD_IN_PROGRESS', message: 'upload still running' },
          retryAfterMs: 15000,
        };
      }
      return { images: [{ imageId: `${input.clientRequestId}-done` }] };
    },
  });
  await app.controller.loadConfig();
  app.controller.syncBaseAvailability(true);
  await app.controller.addFiles([png(app.window)]);
  assert.equal(app.controller.snapshot().items[0].status, 'rejected');
  const key = app.controller.snapshot().uploadRequestId;

  await app.controller.retryUpload();
  assert.equal(app.controller.snapshot().uploadRequestId, key);
  assert.equal(app.controller.snapshot().items[0].status, 'rejected');
  assert.equal(app.controller.snapshot().items[0].retryable, true);
  assert.ok(app.document.querySelector('.composer-attachment-retry'));

  await app.controller.retryUpload();
  assert.equal(app.controller.snapshot().items[0].status, 'ready');
  assert.deepEqual(app.uploads.map((call) => call.clientRequestId), [key, key, key]);
});

test('response count mismatch rejects the whole strip without partial imageIds', async () => {
  const app = boot({ uploadBatch: async () => ({ images: [{ imageId: 'only-one' }] }) });
  await app.controller.loadConfig();
  app.controller.syncBaseAvailability(true);
  await app.controller.addFiles([png(app.window, 'a.png'), png(app.window, 'b.png')]);

  assert.equal(app.controller.snapshot().items.every((item) => item.status === 'rejected'), true);
  assert.equal(app.controller.snapshot().items.every((item) => item.retryable === false), true);
  assert.deepEqual(Array.from(app.controller.readyImageIds()), []);
  assert.equal(app.controller.canSend('caption'), false);
  assert.equal(app.document.querySelector('.composer-attachment-retry'), null);
  assert.equal(await app.controller.retryUpload(), false);
  assert.equal(app.uploads.length, 1, 'deterministic response mismatch must require a strip mutation');
});

test('deterministic upload conflicts require a strip mutation instead of offering same-key retry', async () => {
  const app = boot({
    uploadBatch: async () => {
      const error = new Error('payload changed');
      error.status = 409;
      error.payload = { error: { code: 'UPLOAD_IDEMPOTENCY_CONFLICT', message: 'payload changed' } };
      throw error;
    },
  });
  await app.controller.loadConfig();
  app.controller.syncBaseAvailability(true);
  await app.controller.addFiles([png(app.window, 'conflict.png')]);

  const snapshot = app.controller.snapshot();
  assert.equal(snapshot.items[0].status, 'rejected');
  assert.equal(snapshot.items[0].retryable, false);
  assert.equal(app.document.querySelector('.composer-attachment-retry'), null);
  assert.match(app.document.getElementById('composer-attachment-status').textContent, /移除|重新选择|调整/u);
  assert.equal(await app.controller.retryUpload(), false);
  assert.equal(app.uploads.length, 1);
});

test('message failure retains strip while success revokes previews exactly once', async () => {
  const app = boot();
  await app.controller.loadConfig();
  app.controller.syncBaseAvailability(true);
  await app.controller.addFiles([png(app.window, 'a.png'), png(app.window, 'b.png')]);
  const before = app.controller.snapshot();
  const optimisticBlocks = app.controller.optimisticContentBlocks('caption');

  assert.equal(optimisticBlocks[0].type, 'text');
  assert.deepEqual(optimisticBlocks.slice(1).map((block) => block.url), before.items.map((item) => item.previewUrl));
  const input = app.document.getElementById('composer-input');
  input.value = 'caption';
  const sendToken = app.controller.beginMessageSend('caption');
  assert.ok(sendToken);
  assert.ok(sendToken.clientRequestId);
  assert.equal(input.disabled, true, 'caption must be frozen while an image message is in flight');
  input.value = '';
  assert.equal(app.controller.canSend('another message'), false, 'one ready batch cannot be attached twice concurrently');
  assert.equal(app.document.getElementById('composer-attach-button').disabled, true);
  app.controller.handleMessageFailure(sendToken);
  assert.equal(input.disabled, false);
  assert.equal(input.value, 'caption', 'failed send restores the exact frozen caption');
  assert.equal(app.controller.snapshot().items.length, 2);
  assert.equal(app.revoked.length, 0);
  assert.equal(app.controller.canSend('caption'), true);

  const retrySendToken = app.controller.beginMessageSend('caption');
  assert.ok(retrySendToken);
  assert.equal(retrySendToken.clientRequestId, sendToken.clientRequestId, 'same payload retries the same message key');
  app.controller.handleMessageFailure(retrySendToken);

  const editedSendToken = app.controller.beginMessageSend('edited caption');
  assert.ok(editedSendToken);
  assert.notEqual(editedSendToken.clientRequestId, sendToken.clientRequestId, 'caption mutation creates a new message key');
  app.controller.handleMessageFailure(editedSendToken);

  const finalSendToken = app.controller.beginMessageSend('edited caption');
  assert.equal(finalSendToken.clientRequestId, editedSendToken.clientRequestId);
  app.controller.handleMessageSuccess(finalSendToken);
  assert.equal(app.controller.snapshot().items.length, 0);
  assert.equal(input.disabled, false, 'successful send restores the prior composer availability');
  assert.deepEqual(app.revoked.sort(), Array.from(before.items, (item) => item.previewUrl).sort());
  app.controller.handleMessageSuccess(finalSendToken);
  assert.equal(app.revoked.length, 2, 'clearing an empty strip must not revoke twice');
});

test('persisted history confirmation clears the matching pending image message once', async () => {
  const app = boot();
  await app.controller.loadConfig();
  app.controller.syncBaseAvailability(true);
  await app.controller.addFiles([png(app.window, 'confirmed.png')]);
  const previewUrl = app.controller.snapshot().items[0].previewUrl;
  const sendToken = app.controller.beginMessageSend('confirmed caption');

  assert.ok(sendToken);
  assert.equal(app.controller.confirmMessage('conversation-1', sendToken.clientRequestId), true);
  assert.equal(app.controller.wasMessageConfirmed(sendToken), true);
  assert.equal(app.controller.snapshot().items.length, 0);
  assert.deepEqual(app.revoked, [previewUrl]);
  assert.equal(app.controller.confirmMessage('conversation-1', sendToken.clientRequestId), false);
});

test('active image message send rejects new attachment mutations', async () => {
  const app = boot();
  await app.controller.loadConfig();
  app.controller.syncBaseAvailability(true);
  await app.controller.addFiles([png(app.window, 'sending.png')]);
  const sendToken = app.controller.beginMessageSend();
  const uploadCount = app.uploads.length;

  assert.ok(sendToken);
  assert.equal(await app.controller.addFiles([png(app.window, 'too-late.png')]), false);
  assert.equal(await app.controller.removeItem(app.controller.snapshot().items[0].id), false);
  assert.equal(app.controller.snapshot().items.length, 1);
  assert.equal(app.controller.snapshot().items[0].name, 'sending.png');
  assert.equal(app.uploads.length, uploadCount);
  assert.match(app.toasts.at(-1), /sending|发送中|等待/iu);
});

test('late success from a previous conversation cannot clear the new conversation strip', async () => {
  const app = boot();
  await app.controller.loadConfig();
  app.controller.syncBaseAvailability(true);
  await app.controller.addFiles([png(app.window, 'old-room.png')]);
  const sendToken = app.controller.beginMessageSend();

  app.setConversationId('conversation-2');
  app.controller.syncConversation('conversation-2');
  await app.controller.addFiles([png(app.window, 'new-room.png')]);
  app.controller.handleMessageSuccess(sendToken);

  assert.equal(app.controller.snapshot().conversationId, 'conversation-2');
  assert.equal(app.controller.snapshot().items.length, 1);
  assert.equal(app.controller.snapshot().items[0].name, 'new-room.png');
});

test('conversation switch clears staged UI state and revokes previews', async () => {
  const app = boot();
  await app.controller.loadConfig();
  app.controller.syncConversation('conversation-1');
  await app.controller.addFiles([png(app.window)]);
  const previewUrl = app.controller.snapshot().items[0].previewUrl;

  app.setConversationId('conversation-2');
  app.controller.syncConversation('conversation-2');
  assert.equal(app.controller.snapshot().items.length, 0);
  assert.deepEqual(app.revoked, [previewUrl]);
});
