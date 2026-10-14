const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const readPublic = (name) => fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');

// Per-trace 停止按钮的 UI 验证（AC2/AC3）：真实 DOM 渲染，无服务器/网络。
test('trace stop buttons render per live stage/slot and cancel queued side dispatches', async (t) => {
  const browser = await chromium.launch({
    ...(process.env.CAFF_UI_BROWSER_PATH
      ? { executablePath: process.env.CAFF_UI_BROWSER_PATH }
      : { channel: 'msedge' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setContent('<!doctype html><html><body class="chat-app"><main id="timeline"></main></body></html>');
  await page.addStyleTag({ content: readPublic('styles.css') });
  for (const script of ['shared/icons.js', 'shared/avatar.js', 'shared/conversation-digest.js', 'chat/cross-conversation-ui.js', 'chat/message-images.js', 'chat/message-timeline.js']) {
    await page.addScriptTag({ content: readPublic(script) });
  }
  const app = readPublic('app.js');
  await page.addScriptTag({ content:
    app.slice(app.indexOf('function formatDateTime('), app.indexOf('function conversationById('))
    + app.slice(app.indexOf('function messageSessionInfo('), app.indexOf('function messageSessionExportUrl(')),
  });

  await page.evaluate(() => {
    const agent = { id: 'agent-owner', name: 'Owner', accentColor: '#336699' };
    const conversation = { id: 'stop-room', agents: [agent], messages: [] };
    window.stopFixture = { conversation, renderer: null, liveStage: null, queuedSideCount: 0, calls: [] };
    window.stopFixture.renderer = window.CaffChat.createMessageTimelineRenderer({
      dom: { messageTimeline: document.getElementById('timeline') },
      helpers: {
        agentById: (id) => (id === agent.id ? agent : null),
        buildAgentAvatarElement: () => {
          const avatar = document.createElement('span');
          avatar.className = 'agent-avatar tiny';
          avatar.textContent = 'O';
          return avatar;
        },
        canInspectToolTrace: () => false,
        conversationSummaries: () => [],
        crossConversationBundleForMessage: () => null,
        displayedMessageBody: (message) => message.content,
        digestStatusForConversation: () => null,
        formatDateTime: window.formatDateTime,
        isConversationMessageDeletionBlocked: () => false,
        isPrivateTimelineMessage: () => false,
        liveStageForMessage: (conversationId, activeTurn, activeAgentSlots, messageId) => {
          const stage = window.stopFixture.liveStage;
          return stage && stage.messageId === messageId ? stage : null;
        },
        liveStageLabel: () => '实时生成中',
        messageSessionInfo: window.messageSessionInfo,
        privateRecipientNames: () => [],
        recoverFailedMessage: () => {},
        renderMessageBody: (container, text) => { container.textContent = text; },
        stopConversationTrace: (conversationId, target) => {
          window.stopFixture.calls.push({ conversationId, target });
        },
        isTraceStopRequestInFlight: () => false,
        queuedSideDispatchCountForMessage: () => window.stopFixture.queuedSideCount,
        timelineMessagesForConversation: (item) => item.messages,
        toolTraceSignatureForMessage: () => '',
        toolTraceStateForMessage: () => null,
      },
      showToast() {},
    });
  });

  const renderWith = (fixture) => page.evaluate((input) => {
    const { conversation, renderer } = window.stopFixture;
    window.stopFixture.liveStage = input.liveStage || null;
    window.stopFixture.queuedSideCount = input.queuedSideCount || 0;
    window.stopFixture.calls = [];
    conversation.messages = [input.message];
    renderer.render(conversation, null, []);
  }, fixture);

  // 1. 运行中的主 turn stage → “停止”按钮，点击发出 kind:'stage'。
  await renderWith({
    message: {
      id: 'msg-stage', agentId: 'agent-owner', role: 'assistant', senderName: 'Owner',
      content: '部分回复', status: 'streaming', createdAt: '2026-09-27T07:26:42.909Z',
    },
    liveStage: { messageId: 'msg-stage', agentId: 'agent-owner', status: 'running', stopRequested: false },
  });
  let button = page.locator('.message-trace-stop-button');
  assert.equal(await button.count(), 1);
  assert.equal(await button.textContent(), '停止');
  assert.equal(await button.isDisabled(), false);
  await button.click();
  assert.deepEqual(await page.evaluate(() => window.stopFixture.calls), [
    { conversationId: 'stop-room', target: { kind: 'stage', agentId: 'agent-owner' } },
  ]);

  // 2. 旁路 slot（带 slotId）→ kind:'slot'。
  await renderWith({
    message: {
      id: 'msg-slot', agentId: 'agent-owner', role: 'assistant', senderName: 'Owner',
      content: '旁路回复', status: 'streaming', createdAt: '2026-09-27T07:27:42.909Z',
    },
    liveStage: { messageId: 'msg-slot', slotId: 'stop-room:agent-owner', agentId: 'agent-owner', status: 'running', stopRequested: false },
  });
  button = page.locator('.message-trace-stop-button');
  assert.equal(await button.count(), 1);
  await button.click();
  assert.deepEqual(await page.evaluate(() => window.stopFixture.calls), [
    { conversationId: 'stop-room', target: { kind: 'slot', slotId: 'stop-room:agent-owner' } },
  ]);

  // 3. stopRequested 的 stage → 按钮禁用并显示“停止中…”。
  await renderWith({
    message: {
      id: 'msg-stopping', agentId: 'agent-owner', role: 'assistant', senderName: 'Owner',
      content: '即将停止', status: 'streaming', createdAt: '2026-09-27T07:28:42.909Z',
    },
    liveStage: { messageId: 'msg-stopping', agentId: 'agent-owner', status: 'running', stopRequested: true },
  });
  button = page.locator('.message-trace-stop-button');
  assert.equal(await button.count(), 1);
  assert.equal(await button.textContent(), '停止中…');
  assert.equal(await button.isDisabled(), true);

  // 4. 排队中的旁路派发源消息 → “取消排队”按钮，发出 kind:'queued-side'。
  await renderWith({
    message: {
      id: 'msg-queued-side', role: 'user', senderName: 'You',
      content: '@Owner 插队问题', status: 'completed', createdAt: '2026-09-27T07:29:42.909Z',
      metadata: { dispatchLane: 'side', dispatchTargetAgentId: 'agent-owner' },
    },
    queuedSideCount: 1,
  });
  button = page.locator('.message-trace-stop-button');
  assert.equal(await button.count(), 1);
  assert.equal(await button.textContent(), '取消排队');
  await button.click();
  assert.deepEqual(await page.evaluate(() => window.stopFixture.calls), [
    { conversationId: 'stop-room', target: { kind: 'queued-side', agentId: 'agent-owner' } },
  ]);

  // 5. 终态消息无停止按钮。
  await renderWith({
    message: {
      id: 'msg-done', agentId: 'agent-owner', role: 'assistant', senderName: 'Owner',
      content: '完成的回复', status: 'completed', createdAt: '2026-09-27T07:30:42.909Z',
    },
  });
  assert.equal(await page.locator('.message-trace-stop-button').count(), 0);

  assert.deepEqual(errors, []);
});
