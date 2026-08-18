const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function loadRenderer({ state, dom }) {
  const domInstance = new JSDOM('<ul id="conversation-list"></ul>');
  const window = domInstance.window;
  window.CaffChat = {};
  const context = {
    window,
    document: window.document,
    console,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../../public/chat/cross-conversation-ui.js'), 'utf8'),
    context,
    { filename: 'cross-conversation-ui.js' }
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../../public/chat/conversation-list.js'), 'utf8'),
    context,
    { filename: 'conversation-list.js' }
  );
  dom.conversationList = window.document.getElementById('conversation-list');
  const renderer = context.window.CaffChat.createConversationListRenderer({
    state,
    dom,
    helpers: {
      conversationTypeLabel: () => '标准',
      isConversationBusy: () => false,
      isUndercoverConversation: () => false,
      isWerewolfConversation: () => false,
    },
  });
  return { renderer, listEl: dom.conversationList, document: window.document };
}

function baseState() {
  return {
    selectedConversationId: '',
    conversations: [
      {
        id: 'conv-1',
        title: '第一个会话',
        type: 'standard',
        agentCount: 1,
        messageCount: 0,
        lastMessageAt: null,
      },
    ],
    conversationDirectory: { loading: false, query: '', error: '' },
  };
}

test('conversation list renders a rename button per row', () => {
  const state = baseState();
  const { renderer, listEl } = loadRenderer({ state, dom: {} });

  renderer.render();

  const button = listEl.querySelector('.conversation-rename-button');
  assert.ok(button, 'rename button should exist');
  assert.equal(button.dataset.renameConversationId, 'conv-1');
  assert.match(button.getAttribute('aria-label'), /重命名/);
});

test('startRename renders an inline rename form prefilled with the current title', () => {
  const state = baseState();
  const { renderer, listEl } = loadRenderer({ state, dom: {} });

  renderer.render();
  renderer.startRename('conv-1');

  const form = listEl.querySelector('.conversation-rename-form');
  assert.ok(form, 'rename form should exist after startRename');
  assert.equal(form.dataset.renameConversationId, 'conv-1');
  const input = form.querySelector('input[name="title"]');
  assert.ok(input);
  assert.equal(input.value, '第一个会话');
  assert.ok(form.querySelector('.conversation-rename-save'));
  assert.ok(form.querySelector('.conversation-rename-cancel'));
});

test('cancelRename restores the normal row rendering', () => {
  const state = baseState();
  const { renderer, listEl } = loadRenderer({ state, dom: {} });

  renderer.render();
  renderer.startRename('conv-1');
  renderer.cancelRename();

  assert.equal(listEl.querySelector('.conversation-rename-form'), null);
  assert.ok(listEl.querySelector('.conversation-item'), 'normal item should be back');
  assert.ok(listEl.querySelector('.conversation-rename-button'));
});

test('startRename with empty id is a no-op', () => {
  const state = baseState();
  const { renderer, listEl } = loadRenderer({ state, dom: {} });

  renderer.render();
  renderer.startRename('');

  assert.equal(listEl.querySelector('.conversation-rename-form'), null);
});
