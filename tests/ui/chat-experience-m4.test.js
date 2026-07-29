// CAFF-UI-M4 chat experience regression tests (jsdom + source contracts).
// Locks the Clowder-parity directions approved at Design Gate (2026-07-29):
// - directional message bubbles: user right (75%), assistant left (85%)
// - compact meta row; message-level actions hover-reveal only
// - failed messages render as a centered narrow banner, not a full-width card
// - sidebar conversation list = two-line density (title + meta line)
// - new-conversation form collapsed behind a + toggle
// - chat header slimmed: runtime/meta pills live in drawer settings tab,
//   header keeps a compact connection status dot
// - mobile (<=767px): new-message pill anchored bottom-right, not centered over content

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

function readPublic(rel) {
  return fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8');
}

const INDEX_HTML = readPublic('index.html');
const STYLES = readPublic('styles.css');
const APP_JS = readPublic('app.js');
const CONVERSATION_LIST_JS = readPublic('chat/conversation-list.js');

const M4_SECTION_START = STYLES.indexOf('CAFF-UI-M4 · Clowder-parity chat experience');
const M4_STYLES = M4_SECTION_START > -1 ? STYLES.slice(M4_SECTION_START) : '';

function cssBlock(selector) {
  const start = M4_STYLES.indexOf(selector);
  assert.notEqual(start, -1, `missing selector in M4 section: ${selector}`);
  const open = M4_STYLES.indexOf('{', start);
  const close = M4_STYLES.indexOf('}', open);
  return M4_STYLES.slice(open + 1, close);
}

test('M4: runtime/meta pills live inside drawer settings tab, header keeps connection dot', () => {
  const settingsStart = INDEX_HTML.indexOf('id="panel-settings"');
  const settingsEnd = INDEX_HTML.indexOf('id="panel-game"');
  const runtimePill = INDEX_HTML.indexOf('id="runtime-pill"');
  const conversationMeta = INDEX_HTML.indexOf('id="conversation-meta"');
  assert.ok(settingsStart > -1 && settingsEnd > settingsStart, 'settings panel missing');
  assert.ok(runtimePill > settingsStart && runtimePill < settingsEnd, 'runtime-pill must move into settings drawer tab');
  assert.ok(conversationMeta > settingsStart && conversationMeta < settingsEnd, 'conversation-meta must move into settings drawer tab');

  const headerStart = INDEX_HTML.indexOf('class="chat-header"');
  const headerEnd = INDEX_HTML.indexOf('</header>', headerStart);
  const headerHtml = INDEX_HTML.slice(headerStart, headerEnd);
  assert.ok(headerHtml.includes('id="connection-dot"'), 'chat header must keep a compact connection status dot');
  assert.ok(!headerHtml.includes('id="runtime-pill"'), 'header must not keep the runtime pill');
});

test('M4: app.js keeps connection dot in sync with runtime status', () => {
  assert.match(APP_JS, /connection-dot/, 'app.js must reference #connection-dot');
});

test('M4: sidebar new-conversation form is collapsed behind a + toggle', () => {
  const headStart = INDEX_HTML.indexOf('class="sidebar-head"');
  const headEnd = INDEX_HTML.indexOf('</div>', headStart);
  const headHtml = INDEX_HTML.slice(headStart, headEnd);
  assert.ok(headHtml.includes('id="new-conversation-toggle"'), 'sidebar head must expose a + toggle button');

  const formStart = INDEX_HTML.indexOf('id="new-conversation-form"');
  const formTag = INDEX_HTML.slice(INDEX_HTML.lastIndexOf('<form', formStart), INDEX_HTML.indexOf('>', formStart) + 1);
  assert.ok(/\bhidden\b/.test(formTag), 'new-conversation form must be hidden by default');

  assert.match(APP_JS, /new-conversation-toggle/, 'app.js must wire the + toggle');
});

test('M4: message bubbles are directional (user right 75% / assistant left 85%)', () => {
  const userBlock = cssBlock('body.chat-app .message-card.user {');
  assert.match(userBlock, /justify-self:\s*end/, 'user bubble must right-align within the message column');
  assert.match(userBlock, /max-width:\s*75%/, 'user bubble max-width 75%');

  const assistantBlock = cssBlock('body.chat-app .message-card.assistant {');
  assert.match(assistantBlock, /justify-self:\s*start/, 'assistant bubble must left-align within the message column');
  assert.match(assistantBlock, /max-width:\s*85%/, 'assistant bubble max-width 85%');
});

test('M4: meta row is compact (no full-width sender/time split)', () => {
  const metaBlock = cssBlock('body.chat-app .message-card .message-meta {');
  assert.match(metaBlock, /justify-content:\s*flex-start/, 'meta row must cluster sender+time together');
});

test('M4: message-level actions only reveal on hover/focus', () => {
  const idleBlock = cssBlock('body.chat-app .message-card :is(.message-export-button, .message-context-button) {');
  assert.match(idleBlock, /opacity:\s*0/, 'message actions must be invisible by default');

  const hoverStart = M4_STYLES.indexOf('body.chat-app .message-card:hover :is(.message-export-button, .message-context-button)');
  assert.notEqual(hoverStart, -1, 'hover reveal rule missing');
});

test('M4: failed messages render as a centered narrow banner', () => {
  const failedBlock = cssBlock('body.chat-app .message-card.failed {');
  assert.match(failedBlock, /justify-self:\s*center/, 'failed banner must be centered');
  assert.match(failedBlock, /max-width:\s*(5[0-9]|6[0-9])%/, 'failed banner must be narrower than a bubble');
});

test('M4: mobile anchors the new-message pill bottom-right', () => {
  const mobileStart = M4_STYLES.indexOf('@media (max-width: 767px)');
  assert.notEqual(mobileStart, -1, 'mobile media query missing in M4 section');
  const mobileCss = M4_STYLES.slice(mobileStart);
  const pillStart = mobileCss.indexOf('.new-msg-pill');
  assert.notEqual(pillStart, -1, 'mobile pill override missing');
  const pillBlock = mobileCss.slice(mobileCss.indexOf('{', pillStart) + 1, mobileCss.indexOf('}', pillStart));
  assert.match(pillBlock, /left:\s*auto/, 'mobile pill must not stay horizontally centered');
  assert.match(pillBlock, /right:/, 'mobile pill must anchor to the right edge');
});

test('M4: sidebar conversation items render two-line density', () => {
  const dom = new JSDOM('<ul id="conversation-list" class="conversation-list sidebar-list"></ul>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.eval(CONVERSATION_LIST_JS);

  const list = window.document.getElementById('conversation-list');
  const renderer = window.CaffChat.createConversationListRenderer({
    state: {
      conversations: [
        {
          id: 'c1',
          type: 'standard',
          title: 'M4 设计讨论',
          agentCount: 3,
          messageCount: 42,
          lastMessagePreview: '第三夜的关键节点',
          lastMessageAt: '2026-07-29T07:02:00.000Z',
        },
      ],
      selectedConversationId: 'c1',
    },
    dom: { conversationList: list },
    helpers: {
      conversationPreviewText: (value) => String(value || '').trim(),
      conversationTypeLabel: () => '普通对话',
      formatDateTime: () => '07:02',
      isConversationBusy: () => false,
      isUndercoverConversation: () => false,
      isWerewolfConversation: () => false,
    },
  });

  renderer.render();

  const item = list.querySelector('.conversation-item');
  assert.ok(item, 'conversation item missing');
  assert.equal(item.tagName, 'BUTTON', 'item must stay a button (keyboard operable)');

  const metaLine = item.querySelector('.conversation-meta-line');
  assert.ok(metaLine, 'two-line density requires a single meta line');
  assert.ok(metaLine.textContent.includes('普通对话'), 'type label demoted into the meta line text');
  assert.ok(metaLine.textContent.includes('3'), 'agent count stays in the meta line');
  assert.ok(!item.querySelector('.section-row'), 'legacy footer row must be gone');
  assert.ok(!item.querySelector('.conversation-preview'), 'preview paragraph must not render as a third line');
});
