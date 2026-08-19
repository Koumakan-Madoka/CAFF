const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function boot(conversation) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  window.CaffShared = {
    sessionGoal: {
      goalForConversation: () => null,
      proposalForConversation: () => null,
      formatInlineStatus: () => '',
      formatComposerStatus: () => '',
    },
    conversationDigest: { skillDraftsForConversation: () => [] },
  };
  window.eval(fs.readFileSync(path.join(ROOT, 'public', 'chat', 'conversation-pane.js'), 'utf8'));
  const byId = (id) => window.document.getElementById(id);
  const domRefs = {
    conversationTitleDisplay: byId('conversation-title-display'),
    conversationWorkspaceContext: byId('conversation-workspace-context'),
    conversationWorkspaceBranch: byId('conversation-workspace-branch'),
    conversationWorkspacePath: byId('conversation-workspace-path'),
    conversationModeBadge: byId('conversation-mode-badge'),
    conversationMeta: byId('conversation-meta'),
    deleteConversationButton: byId('delete-conversation-button'),
    skillDraftAlert: byId('skill-draft-alert'),
    skillDraftAlertText: byId('skill-draft-alert-text'),
    skillDraftAlertButton: byId('skill-draft-alert-button'),
    composerInput: byId('composer-input'),
    stopButton: byId('stop-button'),
    sendButton: byId('send-button'),
    composerStatus: byId('composer-status'),
  };
  const state = { currentConversation: conversation, sending: false, stopRequestConversationIds: new Set() };
  const renderer = window.CaffChat.createConversationPaneRenderer({
    state,
    dom: domRefs,
    helpers: {
      activeTurnForConversation: () => null,
      activeAgentSlotsForConversation: () => [],
      agentById: () => null,
      clearLiveDraftFinalizingTimer: () => {},
      closeMentionMenu: () => {},
      conversationTypeLabel: () => '开发',
      isConversationBusy: () => false,
      digestStatusForConversation: () => null,
      liveDraftIdleMs: 100,
      liveStageLabel: () => '',
      queueFailureForConversation: () => null,
      queuedAgentSlotMessageCountForConversation: () => 0,
      queuedUserMessageCountForConversation: () => 0,
      renderMessages: () => {},
      renderParticipantList: () => {},
      scheduleConversationPaneRender: () => {},
      timelineMessagesForConversation: () => [],
    },
  });
  renderer.render();
  return { dom, document: window.document };
}

function room(overrides = {}) {
  return { id: 'room-1', title: '验收 Room', agents: [], privateMessages: [], ...overrides };
}

test('Room header visibly shows bound branch and worktree', () => {
  const { document } = boot(room({ branch: 'room/demo', worktreePath: 'E:/worktrees/room/demo' }));
  const context = document.getElementById('conversation-workspace-context');
  assert.equal(context.classList.contains('is-bound'), true);
  assert.equal(document.getElementById('conversation-workspace-branch').textContent, 'room/demo');
  assert.equal(document.getElementById('conversation-workspace-path').textContent, 'E:/worktrees/room/demo');
  assert.equal(document.getElementById('conversation-workspace-path').title, 'E:/worktrees/room/demo');
});

test('Room header explicitly shows unbound workspace state', () => {
  const { document } = boot(room());
  const context = document.getElementById('conversation-workspace-context');
  assert.equal(context.classList.contains('is-unbound'), true);
  assert.equal(document.getElementById('conversation-workspace-branch').textContent, '未绑定 branch');
  assert.equal(document.getElementById('conversation-workspace-path').textContent, '未绑定 worktree');
});
