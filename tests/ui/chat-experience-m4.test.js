// CAFF-UI-M4 chat experience regression tests (jsdom + source contracts).
// V3 structural contract (2026-07-29, operator rejected V2 because typical
// message geometry barely moved; current truth source:
// .trellis/spec/frontend/ui-structure.md):
// - assistant/system messages render as full-width transcript rows: no card
//   shell (no background block, no big radius, no card padding), only a thin
//   --agent-color attribution bar and a compact meta row above the content
// - user messages render as right-aligned fit-content bubbles with a light
//   accent fill, capped at 75% of the column (Clowder MessageBubble parity;
//   75% of the 1080px column is ~810px, far above the V1 405px effective cap)
// - content column cap stays at 1080px so the chat area fills the measured
//   available width (~1104px at 1440 with sidebar open)
// - message-list gap compressed to <=8px; list padding tightened
// - composer input column tracks the widened chat column
// - failed messages render as a centered narrow banner, not a full-width card
// - digest status/result messages keep a centered card treatment
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
const CONNECTION_STATUS_JS = readPublic('chat/connection-status.js');
const MESSAGE_TIMELINE_JS = readPublic('chat/message-timeline.js');
const CONVERSATION_PANE_JS = readPublic('chat/conversation-pane.js');

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
  const settingsEnd = INDEX_HTML.indexOf('id="skill-draft-drawer"');
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

test('M4: digest status UI has no pending-experience state or wording', () => {
  const digestStatusSources = [APP_JS, MESSAGE_TIMELINE_JS, CONVERSATION_PANE_JS].join('\n');
  assert.doesNotMatch(digestStatusSources, /pendingExperienceDraftCount/u);
  assert.doesNotMatch(digestStatusSources, /整理本轮经验|经验草稿/u);
  assert.match(digestStatusSources, /会话摘要模型正在生成/u);
});

test('M4: SSE transport failure overrides busy/ok dot until the stream reopens', () => {
  const dom = new JSDOM('', { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  window.eval(CONNECTION_STATUS_JS);

  assert.equal(typeof window.CaffChat.createConnectionStatus, 'function', 'connection status module must register on CaffChat');
  const status = window.CaffChat.createConnectionStatus();

  status.markOpen();
  assert.equal(
    status.resolveDot({ busy: true, runtimeLabel: 'h:1 · 9 Agent · 1 个房间处理中', connectingLabel: 'c' }).status,
    'busy',
    'open stream + busy rooms must show busy'
  );
  assert.equal(status.resolveDot({ busy: false, runtimeLabel: 'x', connectingLabel: 'c' }).status, 'ok', 'open stream + idle must show ok');

  status.markFailed();
  const failed = status.resolveDot({ busy: true, runtimeLabel: 'x', connectingLabel: 'c' });
  assert.equal(failed.status, 'failed', 'dropped stream must override busy with failed');
  assert.match(failed.label, /断开|重连/, 'failed label must explain the disconnect');

  status.markOpen();
  assert.equal(
    status.resolveDot({ busy: false, runtimeLabel: 'x', connectingLabel: 'c' }).status,
    'ok',
    'reopened stream must restore runtime-derived status'
  );
});

test('M4: app.js wires SSE error/open paths to the transport state', () => {
  const errorStart = APP_JS.indexOf("source.addEventListener('error'");
  assert.notEqual(errorStart, -1, 'EventSource error listener missing');
  const errorBlock = APP_JS.slice(errorStart, APP_JS.indexOf('});', errorStart) + 3);
  assert.match(errorBlock, /markFailed\(\)/, 'SSE error path must mark the transport as failed');
  assert.match(errorBlock, /renderRuntime\(\)/, 'SSE error path must re-render so the dot reflects the failure');

  const openStart = APP_JS.indexOf("source.addEventListener('open'");
  assert.notEqual(openStart, -1, 'EventSource open listener missing');
  const openBlock = APP_JS.slice(openStart, APP_JS.indexOf('});', openStart) + 3);
  assert.match(openBlock, /markOpen\(\)/, 'SSE open path must clear the transport failure');
  assert.match(openBlock, /renderRuntime\(\)/, 'SSE open path must re-render the restored status');
});

test('M4: sidebar new-conversation form is collapsed behind a + toggle', () => {
  const headStart = INDEX_HTML.indexOf('class="sidebar-head"');
  const headEnd = INDEX_HTML.indexOf('</div>', headStart);
  const headHtml = INDEX_HTML.slice(headStart, headEnd);
  assert.ok(headHtml.includes('id="open-new-conversation-button"'), 'sidebar head must expose a + button that opens the creation dialog');

  const backdropStart = INDEX_HTML.indexOf('id="new-conversation-backdrop"');
  const backdropTag = INDEX_HTML.slice(INDEX_HTML.lastIndexOf('<div', backdropStart), INDEX_HTML.indexOf('>', backdropStart) + 1);
  assert.ok(/\bhidden\b/.test(backdropTag), 'new-conversation dialog must be hidden by default');

  assert.match(APP_JS, /open-new-conversation-button|createNewConversationDialogController/, 'app.js must wire the + button to the creation dialog');
});

test('M4: assistant/system messages are full-width transcript rows without card chrome', () => {
  const cardBlock = cssBlock('body.chat-app .message-card {');
  assert.match(cardBlock, /width:\s*100%/, 'transcript row must span the full column');
  assert.match(cardBlock, /background:\s*(transparent|none)/, 'transcript row must not paint a card background');
  assert.match(cardBlock, /border-radius:\s*0/, 'transcript row must drop the card radius');
  assert.match(cardBlock, /border-left:[^;}]*--agent-color/, 'transcript row keeps a thin --agent-color attribution bar');
  assert.doesNotMatch(cardBlock, /padding:\s*0\.65rem 0\.9rem/, 'transcript row must not keep V1 card padding');

  const assistantBlock = cssBlock('body.chat-app .message-card.assistant {');
  assert.doesNotMatch(assistantBlock, /max-width:\s*85%/, 'assistant row must not be capped at 85% (V1 rejection point)');
});

test('M4: user messages are right-aligned fit-content bubbles without a fixed percentage cap', () => {
  const userBlock = cssBlock('body.chat-app .message-card.user {');
  assert.match(userBlock, /justify-self:\s*end/, 'user bubble must right-align within the message column');
  assert.match(userBlock, /width:\s*fit-content/, 'user bubble keeps natural content width');
  assert.doesNotMatch(userBlock, /max-width:\s*(?!100%)[0-9]+%/, 'user bubble must not reintroduce a fixed percentage cap (operator rejected the 75% narrowing)');
  assert.match(userBlock, /background:\s*var\(--caff-accent-soft\)/, 'user bubble keeps a light accent fill');

  const mobileStart = M4_STYLES.indexOf('@media (max-width: 767px)');
  assert.notEqual(mobileStart, -1, 'mobile media query missing in M4 section');
  const mobileCss = M4_STYLES.slice(mobileStart);
  const mobileUserStart = mobileCss.indexOf('.message-card.user');
  if (mobileUserStart !== -1) {
    const mobileUserBlock = mobileCss.slice(mobileUserStart, mobileCss.indexOf('}', mobileUserStart));
    assert.doesNotMatch(mobileUserBlock, /max-width:\s*(?!100%)[0-9]+%/, 'mobile user bubble must not be capped below full column either');
  }
});

test('M4: V2 density contract - wide column, compressed gap, tight padding', () => {
  const listBlock = cssBlock('body.chat-app .message-list {');
  assert.match(listBlock, /grid-template-columns:\s*minmax\(0,\s*(9[6-9][0-9]|1[0-9]{3})px\)/,
    'content column cap must widen beyond V1 780px (measured available width 1104px at 1440)');
  assert.match(listBlock, /gap:\s*var\(--caff-space-[12]\)/, 'message-list gap must compress to <=8px (space-1/space-2)');
  assert.doesNotMatch(listBlock, /padding:\s*var\(--caff-space-5\)/, 'list vertical padding must shrink below space-5 (V1 measured 48px total)');

  const cardBlock = cssBlock('body.chat-app .message-card {');
  assert.doesNotMatch(cardBlock, /padding:\s*0\.65rem 0\.9rem/, 'card padding must tighten below V1 0.65rem/0.9rem (measured 28.8x20.8px)');

  const composerBlock = cssBlock('body.chat-app .composer-inner {');
  assert.match(composerBlock, /max-width:\s*(9[6-9][0-9]|1[0-9]{3})px/,
    'composer input column must track the widened chat column, not stay at 780px');
});

test('M4: meta row is compact (no full-width sender/time split)', () => {
  const metaBlock = cssBlock('body.chat-app .message-card .message-meta {');
  assert.match(metaBlock, /justify-content:\s*flex-start/, 'meta row must cluster sender+time together');
});

test('M4: message-level actions stay visible, light up on hover/focus', () => {
  const idleBlock = cssBlock('body.chat-app .message-card :is(.message-export-button, .message-context-button) {');
  assert.match(idleBlock, /opacity:\s*0\.[1-9]\d*/, 'message actions must stay visible by default (idle opacity > 0)');

  const disabledBlock = cssBlock('body.chat-app .message-card :is(.message-export-button, .message-context-button):disabled {');
  assert.match(disabledBlock, /opacity:\s*0\.[1-9]\d*/, 'disabled message actions must render dimmed');

  const hoverStart = M4_STYLES.indexOf('body.chat-app .message-card:hover :is(.message-export-button, .message-context-button):not(:disabled)');
  assert.notEqual(hoverStart, -1, 'hover reveal rule must exist and exclude :disabled');
});

test('M4: context button shares export button compact sizing', () => {
  const compactStart = STYLES.indexOf(':is(.message-export-button, .message-context-button) {');
  assert.notEqual(compactStart, -1, 'shared compact sizing selector missing');
  const open = STYLES.indexOf('{', compactStart);
  const close = STYLES.indexOf('}', open);
  const compactBlock = STYLES.slice(open + 1, close);
  assert.match(compactBlock, /padding:\s*0\.28rem 0\.7rem/, 'context button must share the export button compact padding');
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

test('M4: conversation tree uses aligned flat rows with compact guides and one action menu', () => {
  const treeRow = cssBlock('body.chat-app .conversation-tree-row');
  assert.match(treeRow, /position:\s*relative/, 'flat row must own its full hover/active/action surface');
  assert.match(
    treeRow,
    /grid-template-columns:\s*44px\s+minmax\(0,\s*1fr\)\s+44px/,
    'every row must use the same accessible guide, content, and compact action tracks'
  );
  assert.match(
    treeRow,
    /padding-left:\s*calc\(6px\s*\+\s*var\(--tree-depth,\s*0\)\s*\*\s*14px\)/,
    'tree depth must use compact 14px indentation while guide targets remain accessible'
  );

  const itemBlock = cssBlock('body.chat-app .conversation-tree-row .conversation-item');
  assert.match(itemBlock, /grid-column:\s*2\s*\/\s*3/, 'parent and leaf content must share one aligned track');
  assert.match(itemBlock, /background:\s*transparent/, 'the primary item must not paint an independent card');
  assert.doesNotMatch(itemBlock, /padding-right:\s*calc\(44px/, 'the action track must not also shorten item content');

  const hoverBlock = cssBlock('body.chat-app .conversation-tree-row:hover');
  assert.match(hoverBlock, /background:\s*var\(--caff-surface-hover\)/, 'hover belongs to the whole flat row');
  const activeBlock = cssBlock('body.chat-app .conversation-tree-row:has\(\.conversation-item\.active\)');
  assert.match(activeBlock, /background:\s*var\(--caff-accent-soft\)/, 'active state belongs to the whole flat row');

  const guideBlock = cssBlock('body.chat-app .conversation-tree-guide');
  assert.match(guideBlock, /grid-column:\s*1/, 'parent toggles and leaf endpoints must share the guide track');
  assert.match(guideBlock, /width:\s*44px/, 'parent disclosure controls retain a 44px touch target');
  assert.match(guideBlock, /min-height:\s*44px/, 'guide controls retain a 44px touch target');
  const continuationBlock = cssBlock('body.chat-app .conversation-tree-row::before');
  assert.match(
    continuationBlock,
    /left:\s*calc\(28px\s*\+\s*\(var\(--tree-depth,\s*0\)\s*-\s*1\)\s*\*\s*14px\)/,
    'continuation guides must share the compact 14px depth step and align with the parent guide center'
  );
  const branchBlock = cssBlock('body.chat-app .conversation-tree-guide::after');
  assert.match(branchBlock, /left:\s*8px/, 'branch ticks must begin at the parent continuation line');
  assert.match(branchBlock, /width:\s*14px/, 'branch ticks must reach the current guide center');
  const leafMarkerBlock = cssBlock('body.chat-app .conversation-tree-leaf-marker');
  assert.match(leafMarkerBlock, /pointer-events:\s*none/, 'leaf endpoints are decorative, never fake controls');

  const actionTriggerBlock = cssBlock('body.chat-app .conversation-actions-trigger');
  assert.match(actionTriggerBlock, /width:\s*44px/, 'compact dots still need a 44px pointer target');
  assert.match(actionTriggerBlock, /height:\s*44px/, 'compact dots still need a 44px touch target');
  const actionMenuBlock = cssBlock('body.chat-app .conversation-actions-menu');
  assert.match(actionMenuBlock, /position:\s*absolute/, 'row menu must overlay rather than compress the title');
  const openMenuRowBlock = cssBlock(
    'body.chat-app .conversation-tree-row:has(.conversation-actions-menu:not([hidden]))'
  );
  assert.match(
    openMenuRowBlock,
    /z-index:\s*1/,
    'a row with an open menu must lift above following isolated rows so the menu stays clickable'
  );
  const actionItemBlock = cssBlock('body.chat-app .conversation-action-menu-item');
  assert.match(actionItemBlock, /min-height:\s*44px/, 'menu actions must remain touch accessible');

  const metaBlock = cssBlock('body.chat-app .conversation-meta-line');
  assert.match(metaBlock, /text-overflow:\s*ellipsis/, 'narrow metadata must use an ellipsis instead of a hard clip');

  const participantsBlock = cssBlock('body.chat-app .conversation-meta-line .conversation-participants');
  assert.match(participantsBlock, /min-width:\s*0/, 'participant metadata must be shrinkable');
  assert.match(participantsBlock, /text-overflow:\s*ellipsis/, 'participant metadata must show its truncation');

  const titleLine = cssBlock('body.chat-app .sidebar-list .conversation-title-line');
  assert.match(titleLine, /min-width:\s*0/, 'title line must be shrinkable inside the row');

  const titleBlock = cssBlock('body.chat-app .sidebar-list .conversation-title-line strong');
  assert.match(titleBlock, /min-width:\s*0/, 'long titles must shrink before applying ellipsis');
  assert.match(titleBlock, /flex:\s*1\s+1\s+auto/, 'title must own the row remainder while status stays visible');
});

test('M4: sidebar conversation items render two-line density', () => {
  const dom = new JSDOM('<ul id="conversation-list" class="conversation-list sidebar-list"></ul>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.eval(readPublic('chat/cross-conversation-ui.js'));
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
  assert.equal(
    metaLine.querySelector('.conversation-participants')?.textContent,
    '3 个 Agent',
    'participant text needs its own shrinkable ellipsis target'
  );
  assert.ok(!item.querySelector('.section-row'), 'legacy footer row must be gone');
  assert.ok(!item.querySelector('.conversation-preview'), 'preview paragraph must not render as a third line');
});
