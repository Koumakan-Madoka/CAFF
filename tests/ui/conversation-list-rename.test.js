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

test('conversation list renders one accessible overflow menu per row', () => {
  const state = baseState();
  const { renderer, listEl } = loadRenderer({ state, dom: {} });

  renderer.render();

  const trigger = listEl.querySelector('.conversation-actions-trigger');
  assert.ok(trigger, 'overflow trigger should exist');
  assert.equal(trigger.dataset.conversationActionsId, 'conv-1');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');

  const menu = listEl.querySelector('.conversation-actions-menu');
  assert.ok(menu, 'row menu should exist');
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.equal(menu.hidden, true);
  assert.ok(menu.querySelector('[data-conversation-action="rename"][role="menuitem"]'));
  const spawn = menu.querySelector('[data-conversation-action="spawn"][role="menuitem"]');
  assert.ok(spawn);
  assert.equal(spawn.disabled, true, 'project-less conversations keep spawn unavailable');
});

test('opening actions keeps only one row menu open and closing restores the trigger state', () => {
  const state = baseState();
  state.conversations.push({
    id: 'conv-2',
    title: '第二个会话',
    type: 'standard',
    projectScopeId: 'project-1',
    agentCount: 2,
    messageCount: 0,
    lastMessageAt: null,
  });
  const { renderer, listEl } = loadRenderer({ state, dom: {} });

  renderer.render();
  renderer.toggleActions('conv-1');
  let firstTrigger = listEl.querySelector('[data-conversation-actions-id="conv-1"]');
  let secondTrigger = listEl.querySelector('[data-conversation-actions-id="conv-2"]');
  let firstMenu = listEl.querySelector('[data-conversation-actions-menu="conv-1"]');
  let secondMenu = listEl.querySelector('[data-conversation-actions-menu="conv-2"]');
  assert.equal(firstTrigger.getAttribute('aria-expanded'), 'true');
  assert.equal(firstMenu.hidden, false);
  assert.equal(secondMenu.hidden, true);

  renderer.toggleActions('conv-2');
  firstTrigger = listEl.querySelector('[data-conversation-actions-id="conv-1"]');
  secondTrigger = listEl.querySelector('[data-conversation-actions-id="conv-2"]');
  firstMenu = listEl.querySelector('[data-conversation-actions-menu="conv-1"]');
  secondMenu = listEl.querySelector('[data-conversation-actions-menu="conv-2"]');
  assert.equal(firstTrigger.getAttribute('aria-expanded'), 'false');
  assert.equal(firstMenu.hidden, true);
  assert.equal(secondTrigger.getAttribute('aria-expanded'), 'true');
  assert.equal(secondMenu.hidden, false);

  renderer.closeActions();
  assert.equal(listEl.querySelectorAll('.conversation-actions-menu:not([hidden])').length, 0);
});

test('moving focus outside an open actions region closes its menu', () => {
  const state = baseState();
  const { renderer, listEl, document } = loadRenderer({ state, dom: {} });
  const outside = document.createElement('button');
  document.body.appendChild(outside);

  renderer.render();
  renderer.toggleActions('conv-1');
  const menuItem = listEl.querySelector('[role="menuitem"]');
  assert.equal(listEl.querySelector('.conversation-actions-menu').hidden, false);

  menuItem.dispatchEvent(new document.defaultView.FocusEvent('focusout', {
    bubbles: true,
    relatedTarget: outside,
  }));

  assert.equal(listEl.querySelector('.conversation-actions-menu').hidden, true);
  assert.equal(listEl.querySelector('.conversation-actions-trigger').getAttribute('aria-expanded'), 'false');
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
  assert.ok(listEl.querySelector('.conversation-actions-trigger'));
});

test('starting rename closes the overflow menu', () => {
  const state = baseState();
  const { renderer, listEl } = loadRenderer({ state, dom: {} });

  renderer.render();
  renderer.toggleActions('conv-1');
  renderer.startRename('conv-1');

  assert.ok(listEl.querySelector('.conversation-rename-form'));
  assert.equal(listEl.querySelector('.conversation-actions-menu'), null);
});

test('startRename with empty id is a no-op', () => {
  const state = baseState();
  const { renderer, listEl } = loadRenderer({ state, dom: {} });

  renderer.render();
  renderer.startRename('');

  assert.equal(listEl.querySelector('.conversation-rename-form'), null);
});
