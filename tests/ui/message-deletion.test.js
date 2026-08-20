const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

function readPublic(relativePath) {
  return fs.readFileSync(path.join(ROOT, 'public', relativePath), 'utf8');
}

function bootTimeline(messages, options = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="timeline"></div>
    <div id="delete-toolbar" hidden>
      <span data-message-delete-count></span>
      <button type="button" data-message-delete-confirm>Delete</button>
      <button type="button" data-message-delete-cancel>Cancel</button>
    </div>
  </body></html>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const { document } = window;
  const deleteCalls = [];
  const toasts = [];
  window.CaffShared = {
    conversationDigest: {
      digestsForConversation: () => [],
      digestKindLabel: () => '',
      digestKindHelp: () => '',
      createDigestSourceLocator: () => ({ focusSourceMessage() {} }),
    },
  };
  window.CaffIcons = {
    create(name) {
      const icon = document.createElement('span');
      icon.dataset.icon = name;
      return icon;
    },
  };
  window.CaffChat = {
    crossConversationUi: {
      receiptModel: () => null,
      provenanceModel: () => null,
      birthModel: () => null,
    },
  };
  window.eval(readPublic('chat/message-images.js'));
  window.eval(readPublic('chat/message-timeline.js'));
  window.confirm = options.confirm || (() => true);

  const conversation = { id: 'conversation-1', agents: [], messages };
  const renderer = window.CaffChat.createMessageTimelineRenderer({
    dom: {
      messageTimeline: document.getElementById('timeline'),
      messageDeleteToolbar: document.getElementById('delete-toolbar'),
    },
    helpers: {
      agentById: () => null,
      buildAgentAvatarElement: () => document.createElement('span'),
      canInspectToolTrace: () => false,
      conversationSummaries: () => [],
      crossConversationBundleForMessage: () => null,
      deleteConversationMessages: async (conversationId, messageIds) => {
        deleteCalls.push({ conversationId, messageIds });
        if (options.deleteError) {
          throw options.deleteError;
        }
        return { deletedMessageIds: messageIds };
      },
      displayedMessageBody: (message) => message.content,
      digestStatusForConversation: () => null,
      formatDateTime: () => 'now',
      isConversationMessageDeletionBlocked: () => Boolean(options.busy),
      isPrivateTimelineMessage: () => false,
      liveStageForMessage: () => null,
      liveStageLabel: () => '',
      messageSessionInfo: () => ({ sessionPath: '', sessionName: '', canExport: false }),
      privateRecipientNames: () => [],
      renderMessageBody: (container, text) => { container.textContent = text; },
      timelineMessagesForConversation: (item) => item.messages,
      toolTraceSignatureForMessage: () => '',
      toolTraceStateForMessage: () => null,
    },
    showToast(message) {
      toasts.push(String(message));
    },
  });
  renderer.render(conversation, null, []);
  return { dom, window, document, renderer, conversation, deleteCalls, toasts };
}

function deletableMessage(id, overrides = {}) {
  return {
    id,
    role: 'user',
    senderName: 'You',
    content: id,
    status: 'completed',
    createdAt: '2026-08-20T10:00:00.000Z',
    deletionEligibility: { eligible: true, reasonCode: '', reason: '' },
    ...overrides,
  };
}

test('message deletion controls keep 44px targets and a viewport-owned batch toolbar', () => {
  const styles = readPublic('styles.css');
  const html = readPublic('index.html');

  assert.match(styles, /\.message-delete-select-target,[\s\S]*?\.message-delete-button[\s\S]*?width:\s*44px[\s\S]*?min-height:\s*44px/u);
  assert.match(styles, /@media \(hover: none\)[\s\S]*?\.message-delete-controls[\s\S]*?opacity:\s*1/u);
  assert.match(html, /id="message-delete-toolbar"[\s\S]*?data-message-delete-confirm[\s\S]*?icon-trash/u);
  assert.ok(html.indexOf('id="message-delete-toolbar"') > html.indexOf('id="message-list"'));
  assert.ok(html.indexOf('id="message-delete-toolbar"') < html.indexOf('id="new-message-pill"'));
});

test('eligible messages expose single-delete and multi-select controls with accessible labels', () => {
  const { document } = bootTimeline([deletableMessage('message-1')]);
  const card = document.querySelector('[data-message-id="message-1"]');
  const deleteButton = card.querySelector('.message-delete-button');
  const checkbox = card.querySelector('.message-delete-checkbox');

  assert.ok(deleteButton);
  assert.equal(deleteButton.getAttribute('aria-label'), '永久删除这条消息');
  assert.ok(checkbox);
  assert.equal(checkbox.getAttribute('aria-label'), '选择这条消息');
  assert.equal(deleteButton.querySelector('[data-icon="trash"]') !== null, true);
});

test('single delete confirms permanence and submits exactly one message id', async () => {
  let confirmText = '';
  const context = bootTimeline([deletableMessage('message-1')], {
    confirm(message) {
      confirmText = String(message);
      return true;
    },
  });

  context.document.querySelector('.message-delete-button').click();
  await new Promise((resolve) => context.window.setTimeout(resolve, 0));

  assert.match(confirmText, /永久|不可恢复/u);
  assert.match(confirmText, /副作用|文件/u);
  assert.deepEqual(JSON.parse(JSON.stringify(context.deleteCalls)), [
    { conversationId: 'conversation-1', messageIds: ['message-1'] },
  ]);
});

test('multi-select keeps selection after an atomic server rejection and supports cancel', async () => {
  const rejection = Object.assign(new Error('Nothing was deleted'), { status: 409 });
  const context = bootTimeline([
    deletableMessage('message-1'),
    deletableMessage('message-2', { createdAt: '2026-08-20T10:01:00.000Z' }),
  ], { deleteError: rejection });
  const checkboxes = Array.from(context.document.querySelectorAll('.message-delete-checkbox'));

  checkboxes.forEach((checkbox) => checkbox.click());
  assert.equal(context.document.getElementById('delete-toolbar').hidden, false);
  assert.equal(context.document.querySelector('[data-message-delete-count]').textContent, '已选择 2 条');

  context.document.querySelector('[data-message-delete-confirm]').click();
  await new Promise((resolve) => context.window.setTimeout(resolve, 0));

  assert.equal(checkboxes.every((checkbox) => checkbox.checked), true);
  assert.equal(context.document.getElementById('delete-toolbar').hidden, false);
  assert.match(context.toasts.at(-1), /Nothing was deleted/u);

  context.document.querySelector('[data-message-delete-cancel]').click();
  assert.equal(checkboxes.every((checkbox) => !checkbox.checked), true);
  assert.equal(context.document.getElementById('delete-toolbar').hidden, true);
});

test('summarized or busy messages cannot be selected or deleted', () => {
  const summarized = deletableMessage('summarized', {
    deletionEligibility: {
      eligible: false,
      reasonCode: 'message_summarized',
      reason: 'This message is covered by a conversation digest',
    },
  });
  const summarizedContext = bootTimeline([summarized]);
  const summarizedButton = summarizedContext.document.querySelector('.message-delete-button');
  assert.ok(summarizedButton);
  assert.equal(summarizedButton.disabled, true);
  assert.match(summarizedButton.title, /摘要/u);
  assert.equal(summarizedContext.document.querySelector('.message-delete-checkbox').disabled, true);

  const busyContext = bootTimeline([deletableMessage('busy')], { busy: true });
  assert.equal(busyContext.document.querySelector('.message-delete-button').disabled, true);
  assert.equal(busyContext.document.querySelector('.message-delete-checkbox').disabled, true);
});
