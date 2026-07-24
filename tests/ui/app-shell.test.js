// AppShell / chat panel UI regression tests (jsdom).
// Locks the contracts from review of ui-redesign-app-shell:
// - goal panel controller must start without legacy toggle/edge buttons
// - shell owns tab/drawer focus; panel modules never grab focus when fromShell
// - conversation list renders ul > li > button (keyboard operable)
// - conditional tab disappearance closes the state machine in both drawer states

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function readPublic(rel) {
  return fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8');
}

function installPolyfills(window) {
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    });
  }
  if (!('inert' in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, 'inert', {
      configurable: true,
      get() {
        return this.hasAttribute('inert');
      },
      set(value) {
        if (value) {
          this.setAttribute('inert', '');
        } else {
          this.removeAttribute('inert');
        }
      },
    });
  }
  if (!window.Element.prototype.scrollTo) {
    window.Element.prototype.scrollTo = function scrollTo() {};
  }
  if (!window.HTMLElement.prototype.scrollTo) {
    window.HTMLElement.prototype.scrollTo = function scrollTo() {};
  }
}

function bootShell() {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  installPolyfills(window);
  window.eval(readPublic('shell/app-shell.js'));
  return { dom, window, document: window.document };
}

function sessionGoalUtilsStub() {
  return {
    goalForConversation: () => null,
    proposalForConversation: () => null,
    runnerForConversation: () => null,
    statusValue: () => 'none',
    formatStatus: () => '当前没有会话目标',
    statusLabel: () => '无',
    formatProposalStatus: () => '',
    proposalActionLabel: () => '',
    proposalAgentName: () => '',
    proposalReasonText: () => '',
    progressForGoal: () => ({ total: 0, done: 0, inProgress: 0, percent: 0, checklist: [] }),
    objectiveText: () => '',
    checklistTextForGoal: () => '',
    defaultChecklistText: () => '',
  };
}

function goalDom(document) {
  const byId = (id) => document.getElementById(id);
  return {
    sessionGoalToggleButton: null, // legacy chrome removed in AppShell
    sessionGoalEdgeButton: null, // legacy chrome removed in AppShell
    sessionGoalCloseButton: null,
    sessionGoalDrawer: byId('session-goal-drawer'),
    sessionGoalDrawerStatus: byId('session-goal-drawer-status'),
    sessionGoalDetails: byId('session-goal-details'),
    sessionGoalProgressCard: byId('session-goal-progress-card'),
    sessionGoalProgressSummary: byId('session-goal-progress-summary'),
    sessionGoalProgressFill: byId('session-goal-progress-fill'),
    sessionGoalChecklistPreview: byId('session-goal-checklist-preview'),
    sessionGoalProposalCard: byId('session-goal-proposal-card'),
    sessionGoalProposalStatus: byId('session-goal-proposal-status'),
    sessionGoalProposalDetails: byId('session-goal-proposal-details'),
    sessionGoalForm: byId('session-goal-form'),
    sessionGoalObjective: byId('session-goal-objective'),
    sessionGoalChecklist: byId('session-goal-checklist'),
    sessionGoalSaveButton: byId('session-goal-save-button'),
    sessionGoalChecklistPresetButton: byId('session-goal-checklist-preset-button'),
    sessionGoalPauseButton: byId('session-goal-pause-button'),
    sessionGoalResumeButton: byId('session-goal-resume-button'),
    sessionGoalCompleteButton: byId('session-goal-complete-button'),
    sessionGoalClearButton: byId('session-goal-clear-button'),
    sessionGoalAcceptProposalButton: byId('session-goal-accept-proposal-button'),
    sessionGoalDismissProposalButton: byId('session-goal-dismiss-proposal-button'),
  };
}

function bootGoalPanel() {
  const { dom, window, document } = bootShell();
  window.CaffShared = { sessionGoal: sessionGoalUtilsStub() };
  window.eval(readPublic('chat/session-goal-panel.js'));
  const controller = window.CaffChat.createSessionGoalPanelController({
    state: { currentConversation: { id: 'conv-1' } },
    dom: goalDom(document),
    helpers: {
      formatDateTime: (value) => String(value || ''),
      submitGoalCommand: async () => ({}),
    },
    showToast: () => {},
  });
  return { dom, window, document, controller };
}

test('goal panel controller starts without legacy toggle/edge buttons', () => {
  const { window, document, controller } = bootGoalPanel();
  const status = document.getElementById('session-goal-drawer-status');
  status.textContent = 'UNTOUCHED';

  controller.render();
  assert.notEqual(status.textContent, 'UNTOUCHED', 'render() must run past the startup guard');
  assert.equal(document.getElementById('session-goal-save-button').disabled, false);

  controller.bindEvents();
  const submit = new window.Event('submit', { cancelable: true, bubbles: true });
  document.getElementById('session-goal-form').dispatchEvent(submit);
  assert.equal(submit.defaultPrevented, true, 'submit handler must be bound (cancelable submit prevented)');
});

test('goal panel never grabs focus when opened from shell (APG roving focus intact)', async () => {
  const { window, document, controller } = bootGoalPanel();
  controller.bindEvents();

  window.caffShell.openTab('session-goal-drawer');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(window.caffShell.activeTab(), 'session-goal-drawer');
  assert.notEqual(
    document.activeElement && document.activeElement.id,
    'session-goal-objective',
    'fromShell open must not steal focus into the objective textarea',
  );
});

test('conversation list renders ul > li > button semantics (keyboard operable)', () => {
  const { window, document } = bootShell();
  window.eval(readPublic('chat/conversation-list.js'));
  const renderer = window.CaffChat.createConversationListRenderer({
    state: {
      conversations: [
        { id: 'conv-1', title: 'Alpha room', type: 'standard', agentCount: 2, messageCount: 5, metadata: {} },
      ],
      selectedConversationId: 'conv-1',
    },
    dom: { conversationList: document.getElementById('conversation-list') },
    helpers: {
      conversationPreviewText: (text) => text,
      conversationTypeLabel: () => '标准',
      formatDateTime: () => '-',
      isConversationBusy: () => false,
      isUndercoverConversation: () => false,
      isWerewolfConversation: () => false,
    },
  });

  renderer.render();

  const list = document.getElementById('conversation-list');
  assert.equal(list.tagName, 'UL', '#conversation-list must be a list');
  const li = list.firstElementChild;
  assert.equal(li && li.tagName, 'LI', 'items must be list elements');
  const button = li && li.firstElementChild;
  assert.equal(button && button.tagName, 'BUTTON', 'item action must be a real button');
  assert.equal(button.dataset.id, 'conv-1');
  assert.equal(button.tabIndex, 0, 'button must be keyboard focusable');
  assert.equal(button.classList.contains('conversation-item'), true);
  assert.equal(button.classList.contains('active'), true);
});

test('conditional tab hidden while drawer open: focus migrates to a visible fallback tab', () => {
  const { window, document } = bootShell();
  const shell = window.caffShell;

  shell.setTabVisible('panel-game', true);
  shell.openTab('panel-game');
  assert.equal(shell.activeTab(), 'panel-game');

  document.getElementById('tab-game').focus();
  shell.setTabVisible('panel-game', false);

  const active = document.activeElement;
  assert.equal(shell.activeTab() !== 'panel-game', true, 'active tab must move off the hidden tab');
  assert.equal(active && active.id, 'tab-participants', 'focus must land on the fallback tab, not a hidden element or BODY');
  assert.equal(document.getElementById('tab-participants').getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('panel-game').hidden, true, 'hidden tab panel must be hidden');
});

test('conditional tab hidden while drawer closed: reopen leaves no hidden active panel', () => {
  const { window, document } = bootShell();
  const shell = window.caffShell;

  shell.setTabVisible('panel-game', true);
  shell.openTab('panel-game');
  shell.closeDrawer();
  shell.setTabVisible('panel-game', false);

  document.getElementById('drawerToggle').click();

  assert.equal(shell.activeTab() !== 'panel-game', true, 'current tab must not be the hidden tab');
  assert.equal(document.getElementById('tab-game').hidden, true);
  assert.equal(document.getElementById('panel-game').hidden, true, 'hidden tab panel must stay hidden');
  const visibleSelected = Array.from(document.querySelectorAll('.drawer-tabs [role="tab"]'))
    .filter((tab) => !tab.hidden && tab.getAttribute('aria-selected') === 'true');
  assert.equal(visibleSelected.length, 1, 'exactly one visible tab must be selected');
});
