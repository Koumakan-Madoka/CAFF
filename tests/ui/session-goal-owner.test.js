const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const SHARED_PATH = path.join(__dirname, '../../public/shared/session-goal.js');
const PANEL_PATH = path.join(__dirname, '../../public/chat/session-goal-panel.js');

const FIXTURE_IDS = [
  'session-goal-drawer',
  'session-goal-close-button',
  'session-goal-drawer-status',
  'session-goal-details',
  'session-goal-owner-card',
  'session-goal-owner-select',
  'session-goal-progress-card',
  'session-goal-progress-summary',
  'session-goal-progress-fill',
  'session-goal-checklist-preview',
  'session-goal-proposal-card',
  'session-goal-proposal-status',
  'session-goal-proposal-details',
  'session-goal-accept-proposal-button',
  'session-goal-dismiss-proposal-button',
  'session-goal-form',
  'session-goal-objective',
  'session-goal-checklist',
  'session-goal-checklist-preset-button',
  'session-goal-save-button',
  'session-goal-pause-button',
  'session-goal-resume-button',
  'session-goal-complete-button',
  'session-goal-clear-button',
  'session-goal-toggle-button',
  'session-goal-edge-button',
];

function buildWindow() {
  const fixture = FIXTURE_IDS.map((id) => {
    if (id === 'session-goal-objective' || id === 'session-goal-checklist') {
      return `<textarea id="${id}"></textarea>`;
    }
    if (id === 'session-goal-owner-select') {
      return `<select id="${id}"></select>`;
    }
    if (id.endsWith('button')) {
      return `<button id="${id}" type="button"></button>`;
    }
    if (id === 'session-goal-form') {
      return `<form id="${id}"></form>`;
    }
    return `<div id="${id}"></div>`;
  }).join('\n');
  const dom = new JSDOM(`<!doctype html><html><body>${fixture}</body></html>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  dom.window.eval(fs.readFileSync(SHARED_PATH, 'utf8'));
  dom.window.eval(fs.readFileSync(PANEL_PATH, 'utf8'));
  return dom.window;
}

function domRefs(window) {
  const refs = {};
  for (const id of FIXTURE_IDS) {
    const key = id.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    refs[key] = window.document.getElementById(id);
  }
  return refs;
}

function buildController(window, conversation) {
  const submitted = [];
  const state = { currentConversation: conversation };
  const controller = window.CaffChat.createSessionGoalPanelController({
    state,
    dom: domRefs(window),
    helpers: {
      formatDateTime: (value) => String(value || ''),
      submitGoalCommand: async (conversationId, command) => {
        submitted.push({ conversationId, command });
      },
    },
    showToast: () => {},
  });
  controller.bindEvents();
  controller.render();
  return { controller, submitted, state };
}

function conversationWithGoal(goalOverrides = {}, metadataOverrides = {}) {
  return {
    id: 'conv-1',
    agents: [
      { id: 'agent-a', name: 'Alpha' },
      { id: 'agent-b', name: 'Bravo' },
    ],
    metadata: {
      sessionGoal: {
        objective: '推进 goal 主理人特性',
        status: 'active',
        checklist: [],
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
        ...goalOverrides,
      },
      ...metadataOverrides,
    },
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('ownerForGoal normalizes the persisted goal owner', () => {
  const window = buildWindow();
  const { ownerForGoal } = window.CaffShared.sessionGoal;

  assert.equal(ownerForGoal(null), null);
  assert.equal(ownerForGoal({ objective: 'x' }), null);
  const owner = ownerForGoal({ objective: 'x', owner: { agentId: 'agent-b', agentName: 'Bravo' } });
  assert.equal(owner.agentId, 'agent-b');
  assert.equal(owner.agentName, 'Bravo');
  assert.equal(ownerForGoal({ objective: 'x', owner: { agentName: 'Bravo' } }), null);
});

test('owner card is hidden when there is no goal or conversation', () => {
  const window = buildWindow();

  const noGoal = buildController(window, { id: 'conv-1', agents: [], metadata: {} });
  assert.ok(window.document.getElementById('session-goal-owner-card').classList.contains('hidden'));

  const noConversation = buildController(window, null);
  assert.ok(window.document.getElementById('session-goal-owner-card').classList.contains('hidden'));
  assert.equal(noGoal.submitted.length, 0);
  assert.equal(noConversation.submitted.length, 0);
});

test('owner select lists participants plus unset default and reflects persisted owner', () => {
  const window = buildWindow();
  buildController(window, conversationWithGoal({ owner: { agentId: 'agent-b', agentName: 'Bravo' } }));

  const card = window.document.getElementById('session-goal-owner-card');
  const select = window.document.getElementById('session-goal-owner-select');
  assert.ok(!card.classList.contains('hidden'), 'owner card visible with an active goal');

  const options = Array.from(select.options).map((option) => option.value);
  assert.deepEqual(options, ['', 'agent-a', 'agent-b']);
  assert.equal(select.options[0].textContent, '未设置');
  assert.equal(select.value, 'agent-b');

  const detailsText = window.document.getElementById('session-goal-details').textContent;
  assert.ok(detailsText.includes('主理人'), 'details list renders the owner row');
  assert.ok(detailsText.includes('Bravo'));
});

test('goal without owner defaults the select to unset', () => {
  const window = buildWindow();
  buildController(window, conversationWithGoal());

  const select = window.document.getElementById('session-goal-owner-select');
  assert.equal(select.value, '');
});

test('changing the owner select submits a set-owner goal command', async () => {
  const window = buildWindow();
  const { submitted, state } = buildController(window, conversationWithGoal());

  const select = window.document.getElementById('session-goal-owner-select');
  select.value = 'agent-a';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].conversationId, 'conv-1');
  assert.equal(submitted[0].command.action, 'set-owner');
  assert.equal(submitted[0].command.ownerAgentId, 'agent-a');

  state.currentConversation = conversationWithGoal({ owner: { agentId: 'agent-a', agentName: 'Alpha' } });
  const event = new window.Event('test-rerender');
  window.document.dispatchEvent(event);
});

test('owner missing from the roster is still displayed instead of silently resetting', () => {
  const window = buildWindow();
  buildController(window, conversationWithGoal({ owner: { agentId: 'agent-z', agentName: 'Zulu' } }));

  const select = window.document.getElementById('session-goal-owner-select');
  assert.equal(select.value, 'agent-z');
  const missingOption = Array.from(select.options).find((option) => option.value === 'agent-z');
  assert.ok(missingOption, 'removed owner keeps a selectable option');
  assert.match(missingOption.textContent, /Zulu/);
});

test('a failed set-owner submit reverts the select to the persisted owner', async () => {
  const window = buildWindow();
  const toasts = [];
  const state = {
    currentConversation: conversationWithGoal({ owner: { agentId: 'agent-b', agentName: 'Bravo' } }),
  };
  const controller = window.CaffChat.createSessionGoalPanelController({
    state,
    dom: domRefs(window),
    helpers: {
      formatDateTime: (value) => String(value || ''),
      submitGoalCommand: async () => {
        throw new Error('500 set-owner failed');
      },
    },
    showToast: (message) => toasts.push(message),
  });
  controller.bindEvents();
  controller.render();

  const select = window.document.getElementById('session-goal-owner-select');
  assert.equal(select.value, 'agent-b');

  select.value = 'agent-a';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();

  assert.equal(
    select.value,
    'agent-b',
    'a failed owner change must not linger as if it were persisted'
  );
  assert.ok(toasts.length > 0, 'the failure is surfaced through a toast');
});

test('DAG execution lock disables the owner select', () => {
  const window = buildWindow();
  buildController(
    window,
    conversationWithGoal(
      { owner: { agentId: 'agent-a', agentName: 'Alpha' } },
      { dagNodeGoalBinding: { planId: 'plan-1', nodeId: 'n1' } }
    )
  );

  const select = window.document.getElementById('session-goal-owner-select');
  assert.equal(select.disabled, true);
});
