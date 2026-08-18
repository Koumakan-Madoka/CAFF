// AppShell / chat panel UI regression tests (jsdom).
// Locks the contracts from review of ui-redesign-app-shell:
// - goal panel controller must start without legacy toggle/edge buttons
// - shell owns tab/drawer focus; panel modules never grab focus when fromShell
// - conversation list renders ul > li > button (keyboard operable)
// - conditional tab disappearance closes the state machine in both drawer states
// - shell-owned new-message affordance survives renderer replacement and ignores trace-only mutations
// - programmatic composer changes share one height-synchronizing setter
// - active mock truth matches the v5 6-permanent + 2-conditional tab IA

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const MOCK_HTML = fs.readFileSync(path.join(ROOT, 'designs', 'mock-app-shell-a.html'), 'utf8');
const BRIEF_MD = fs.readFileSync(path.join(ROOT, 'designs', 'caff-ui-redesign-brief.md'), 'utf8');

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

function setScrollBox(window, list, { scrollTop = 0, clientHeight = 200, scrollHeight = 1000 } = {}) {
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: scrollHeight });
  list.scrollTop = scrollTop;
  list.dispatchEvent(new window.Event('scroll'));
}

function messageCard(document, id) {
  const card = document.createElement('article');
  card.className = 'message-card assistant';
  card.dataset.messageId = id;
  card.innerHTML = '<div class="message-body"><p>message</p><div class="message-tool-trace"></div></div>';
  return card;
}

function pillIsVisible(document) {
  const pill = document.querySelector('.new-msg-pill');
  return Boolean(pill && !pill.hidden);
}

async function flushMutations() {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  window.eval(readPublic('chat/cross-conversation-ui.js'));
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

  shell.setTabVisible('skill-draft-drawer', true);
  shell.openTab('skill-draft-drawer');
  assert.equal(shell.activeTab(), 'skill-draft-drawer');

  document.getElementById('tab-drafts').focus();
  shell.setTabVisible('skill-draft-drawer', false);

  const active = document.activeElement;
  assert.equal(shell.activeTab() !== 'skill-draft-drawer', true, 'active tab must move off the hidden tab');
  assert.equal(active && active.id, 'tab-participants', 'focus must land on the fallback tab, not a hidden element or BODY');
  assert.equal(document.getElementById('tab-participants').getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('skill-draft-drawer').hidden, true, 'hidden tab panel must be hidden');
});

test('conditional tab hidden while drawer closed: reopen leaves no hidden active panel', () => {
  const { window, document } = bootShell();
  const shell = window.caffShell;

  shell.setTabVisible('skill-draft-drawer', true);
  shell.openTab('skill-draft-drawer');
  shell.closeDrawer();
  shell.setTabVisible('skill-draft-drawer', false);

  document.getElementById('drawerToggle').click();

  assert.equal(shell.activeTab() !== 'skill-draft-drawer', true, 'current tab must not be the hidden tab');
  assert.equal(document.getElementById('tab-drafts').hidden, true);
  assert.equal(document.getElementById('skill-draft-drawer').hidden, true, 'hidden tab panel must stay hidden');
  const visibleSelected = Array.from(document.querySelectorAll('.drawer-tabs [role="tab"]'))
    .filter((tab) => !tab.hidden && tab.getAttribute('aria-selected') === 'true');
  assert.equal(visibleSelected.length, 1, 'exactly one visible tab must be selected');
});

test('new-message pill stays outside renderer ownership and survives consecutive replacements', async () => {
  const { window, document } = bootShell();
  const list = document.getElementById('message-list');
  setScrollBox(window, list, { scrollTop: 0 });

  list.appendChild(messageCard(document, 'm-1'));
  await flushMutations();

  const pill = document.querySelector('.new-msg-pill');
  assert.equal(pillIsVisible(document), true, 'first new message while off-bottom must show the pill');
  assert.equal(list.contains(pill), false, 'shell-owned pill must live outside the renderer-owned message list');

  list.replaceChildren(messageCard(document, 'm-1'));
  await flushMutations();
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 200 });
  list.dispatchEvent(new window.Event('scroll'));
  assert.equal(pillIsVisible(document), true, 'renderer replacement must not delete the shell-owned pill');

  setScrollBox(window, list, { scrollTop: 800, scrollHeight: 1000 });
  assert.equal(pillIsVisible(document), false, 'returning to the bottom clears the pill');

  setScrollBox(window, list, { scrollTop: 0 });
  list.replaceChildren(messageCard(document, 'm-1'), messageCard(document, 'm-2'));
  await flushMutations();
  assert.equal(pillIsVisible(document), true, 'a later message id must show the pill after replacement');
});

test('tool-trace subtree mutations do not masquerade as new messages', async () => {
  const { window, document } = bootShell();
  const list = document.getElementById('message-list');
  const card = messageCard(document, 'm-1');
  list.appendChild(card);
  await flushMutations();

  setScrollBox(window, list, { scrollTop: 0 });
  const trace = card.querySelector('.message-tool-trace');
  trace.appendChild(document.createElement('button'));
  await flushMutations();

  assert.equal(pillIsVisible(document), false, 'trace-only DOM changes must not create a new-message signal');
});

test('programmatic composer clear and restore both recalculate height through the shell setter', () => {
  const { window, document } = bootShell();
  const input = document.getElementById('composer-input');
  Object.defineProperty(input, 'scrollHeight', {
    configurable: true,
    get() {
      return input.value.length > 100 ? 240 : 44;
    },
  });

  assert.equal(typeof window.caffShell.setComposerValue, 'function', 'shell must expose the shared programmatic setter');
  window.caffShell.setComposerValue('x'.repeat(200));
  assert.equal(input.style.height, '160px');
  window.caffShell.setComposerValue('');
  assert.equal(input.style.height, '44px', 'successful clear must collapse the composer');
  window.caffShell.setComposerValue('y'.repeat(200));
  assert.equal(input.style.height, '160px', 'failure restore must expand the composer again');
});

test('app and mention-menu composer writes use the shell setter', () => {
  const appSource = readPublic('app.js');
  const mentionSource = readPublic('chat/mention-menu.js');

  assert.doesNotMatch(appSource, /dom\.composerInput\.value\s*=/, 'app.js must not bypass the shared setter');
  assert.doesNotMatch(mentionSource, /dom\.composerInput\.value\s*=/, 'mention-menu must not bypass the shared setter');
  assert.match(appSource, /setComposerValue\(/, 'app.js must route programmatic writes through one helper');
  assert.match(mentionSource, /caffShell\.setComposerValue\(/, 'mention insertion must resync composer height');
});

test('conversation selection closes the overlay sidebar at the AppShell breakpoint', () => {
  const source = readPublic('app.js');

  assert.match(
    source,
    /!window\.matchMedia\('\(min-width: 1280px\)'\)\.matches && document\.body\.dataset\.sidebar === 'open'/,
    'conversation selection must use the AppShell desktop breakpoint',
  );
  assert.doesNotMatch(
    source,
    /matchMedia\('\(max-width: 900px\)'\)/,
    'conversation selection must not use a second, narrower sidebar breakpoint',
  );
});

test('v5 mock exposes six permanent and two conditional drawer tabs', () => {
  const dom = new JSDOM(MOCK_HTML);
  const { document } = dom.window;
  const tabs = Array.from(document.querySelectorAll('.drawer-tabs [role="tab"]'));
  assert.deepEqual(
    tabs.map((tab) => tab.textContent.trim()),
    ['参与者', '目标', '记忆', '摘要', '设置', '游戏', '草稿', '上下文'],
  );

  const conditionalIds = tabs
    .filter((tab) => tab.dataset.visibility === 'conditional')
    .map((tab) => tab.id);
  assert.deepEqual(conditionalIds, ['tab-game', 'tab-drafts']);
  tabs.forEach((tab) => {
    assert.ok(document.getElementById(tab.getAttribute('aria-controls')), `${tab.id} must own a real panel`);
  });
});

test('test:ui is repository-owned and starts an isolated app by default', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-ui.mjs'), 'utf8');

  assert.ok(pkg.devDependencies && pkg.devDependencies['playwright-core'], 'playwright-core must be a declared devDependency');
  assert.match(pkg.scripts['test:ui'], /npm run build/, 'clean checkout test:ui must build before launching');
  assert.match(runner, /CAFF_DISABLE_ENV_LOCAL:\s*'1'/);
  assert.match(runner, /PI_SQLITE_PATH/);
  assert.match(runner, /CHAT_APP_PORT/);
  assert.match(runner, /windowsHide:\s*true/);
  assert.doesNotMatch(runner, /localhost:3210/, 'default test gate must not target a mutable fixed-port service');
});

test('test:ui evidence stays bounded and includes a browser walkthrough video', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-ui.mjs'), 'utf8');
  const screenshotNames = new Set(runner.match(/ui-v2-[\w-]+\.png/g) || []);

  assert.ok(screenshotNames.size > 0 && screenshotNames.size <= 3, 'quality-gate evidence must contain at most three screenshots');
  assert.match(runner, /recordVideo\s*:/, 'browser walkthrough must use Playwright video capture');
  assert.match(runner, /ui-v2-walkthrough\.webm/, 'walkthrough video must have a stable evidence filename');
  assert.match(runner, /renderEvidenceConversation\(/, 'screenshots must render a deterministic long-conversation state');
  assert.match(runner, /toast\.classList\.add\('hidden'\)/, 'expected-failure toast must be cleared before screenshots');
});

test('test:ui rejects non-loopback mutation targets and surfaces emergency cleanup failures', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-ui.mjs'), 'utf8');

  assert.match(runner, /assertLoopbackTarget\(/, 'explicit app overrides must remain local-only');
  assert.match(runner, /emergencyCleanupRun\(/, 'aborted runs must clean all run-owned conversations');
  assert.doesNotMatch(
    runner,
    /deleteVerificationConversation\(APP, baselineConversationId\)\.catch\(\(\) => \{\}\)/,
    'verification conversation cleanup must never fail open',
  );
});

test('active design brief preserves v5 approval and records the v7 M3 review state', () => {
  assert.doesNotMatch(BRIEF_MD, /^status:.*待 Gate #2.*$/m);
  assert.match(BRIEF_MD, /^status:.*v7.*Milestone 3.*implementation review.*$/m);
  assert.match(BRIEF_MD, /v5 聊天 AppShell.*已落地/);
  assert.match(BRIEF_MD, /Gate #2 APPROVED/);
});
