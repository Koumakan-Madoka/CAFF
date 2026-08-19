const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const STYLES_CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

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

test('workspace authorization cards are rendered inside the message flow and use theme tokens', () => {
  assert.match(INDEX_HTML, /id="message-list"[^>]*>[\s\S]*id="message-timeline"[\s\S]*id="workspace-authorization-cards"/u);
  assert.doesNotMatch(INDEX_HTML, /<div id="workspace-authorization-cards"[^>]*>[^<]*<\/div>\s*<div class="message-viewport"/u);
  assert.match(STYLES_CSS, /body\.chat-app \.workspace-authorization-card[\s\S]*background: var\(--caff-info-soft\)/u);
  assert.match(STYLES_CSS, /body\.chat-app \.new-conversation-dialog[\s\S]*background: var\(--caff-surface-elevated\)/u);
  assert.match(STYLES_CSS, /body\.chat-app \.new-conversation-role-badge\.warning[\s\S]*background: var\(--caff-warning-soft\)[\s\S]*color: var\(--caff-warning\)/u);
});

test('workspace authorization response merges the header without replacing loaded history', () => {
  assert.match(APP_JS, /const projection = \{ \.\.\.summary \};\s*delete projection\.messages;/u);
  assert.match(APP_JS, /mergeConversationSummary\(result\.conversation\);\s*renderAll\(\);/u);
  assert.doesNotMatch(APP_JS, /state\.currentConversation\s*=\s*\{\s*\.\.\.state\.currentConversation,\s*\.\.\.result\.conversation\s*\};\s*mergeConversationSummary\(result\.conversation\);/u);
});

test('summary merge ignores an empty messages projection at runtime', () => {
  const start = APP_JS.indexOf('function mergeConversationSummary(summary) {');
  const end = APP_JS.indexOf('\nfunction applyNewConversationResult(result) {', start);
  assert.ok(start >= 0 && end > start);
  const history = [{ id: 'message-1', content: '历史消息' }];
  const state = {
    conversations: [{ id: 'room-1', title: '旧标题' }],
    currentConversation: { id: 'room-1', title: '旧标题', messages: history },
    conversationDirectory: {
      query: '',
      mergeItems: (items, incoming) => items.map((item) => ({ ...item, ...incoming.find((next) => next.id === item.id) })),
      sortByActivity: (items) => items,
    },
  };
  const mergeConversationSummary = vm.runInNewContext(`(${APP_JS.slice(start, end)})`, {
    state,
    conversationDirectory: state.conversationDirectory,
  });
  mergeConversationSummary({ id: 'room-1', title: '新标题', messages: [] });
  assert.deepEqual(state.currentConversation.messages, history);
  assert.equal(state.currentConversation.title, '新标题');
  assert.equal(Object.prototype.hasOwnProperty.call(state.conversations[0], 'messages'), false);
});
test('Room workspace header preserves the chat title CSS rule', () => {
  assert.match(STYLES_CSS, /body\.chat-app \.chat-header h2\s*\{[\s\S]*?margin:\s*0;/);
  assert.equal((STYLES_CSS.match(/body\.chat-app \.chat-header \.titles\s*\{/g) || []).length, 1);
});

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
