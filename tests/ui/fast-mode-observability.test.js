const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createServiceTierState, recordServiceTierRequest, snapshotServiceTier, normalizeServiceTierRequest } = require('../../build/lib/service-tier');
const readPublic = (name) => fs.readFileSync(path.resolve(__dirname, '../../public', name), 'utf8');

// Production renderers; synthetic data, no instance, auth or network.
test('Fast timeline, per-call tool trace and inspector distinguish configuration/request/unknown execution', async (t) => {
  const browser = await chromium.launch({ ...(process.env.CAFF_UI_BROWSER_PATH ? { executablePath: process.env.CAFF_UI_BROWSER_PATH } : { channel: 'msedge' }), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  await page.route('**/*', (route) => route.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setContent('<!doctype html><html lang="zh-CN"><body class="chat-app"><main id="timeline"></main><section id="trace-summary"></section><section id="trace-events"></section></body></html>');
  await page.addStyleTag({ content: readPublic('styles.css') });
  for (const script of ['shared/icons.js', 'shared/avatar.js', 'shared/conversation-digest.js', 'chat/cross-conversation-ui.js', 'chat/message-images.js', 'chat/message-timeline.js']) await page.addScriptTag({ content: readPublic(script) });
  const app = readPublic('app.js');
  await page.addScriptTag({ content:
    app.slice(app.indexOf('function formatDateTime('), app.indexOf('function conversationById('))
    + app.slice(app.indexOf('function messageSessionInfo('), app.indexOf('function messageSessionExportUrl('))
    + app.slice(app.indexOf('function formatInspectorNumber'), app.indexOf('async function openAgentContextInspector')),
  });
  await page.evaluate(() => {
    const agent = { id: 'gpt', name: 'GPT' };
    window.fastTraceUi = { conversation: { id: 'fast-fixture', agents: [agent], messages: [] }, trace: null };
    window.fastTraceUi.renderer = window.CaffChat.createMessageTimelineRenderer({
      dom: { messageTimeline: document.getElementById('timeline') }, showToast() {},
      helpers: {
        agentById: () => agent, buildAgentAvatarElement: () => document.createElement('span'),
        canInspectToolTrace: () => true, conversationSummaries: () => [], crossConversationBundleForMessage: () => null,
        displayedMessageBody: (m) => m.content, digestStatusForConversation: () => null, formatDateTime: window.formatDateTime,
        isConversationMessageDeletionBlocked: () => false, isPrivateTimelineMessage: () => false,
        liveStageForMessage: () => null, liveStageLabel: () => '', messageSessionInfo: window.messageSessionInfo,
        privateRecipientNames: () => [], renderMessageBody: (el, text) => { el.textContent = text; },
        timelineMessagesForConversation: (c) => c.messages,
        toolTraceSignatureForMessage: () => JSON.stringify(window.fastTraceUi.trace),
        toolTraceStateForMessage: () => ({ open: true, status: 'loaded', data: window.fastTraceUi.trace }),
      },
    });
    window.state = { contextInspector: {} };
    window.dom = { agentTraceSummary: document.getElementById('trace-summary'), agentTraceEventList: document.getElementById('trace-events') };
  });
  const configured = createServiceTierState(true);
  const requested = { status: 'requested', serviceTierRequested: 'priority', supportSource: 'catalog' };
  const render = async (summary, request) => {
    await page.evaluate(({ summary, request }) => {
      const f = window.fastTraceUi;
      f.conversation.messages = [{ id: 'one-message', agentId: 'gpt', role: 'assistant', senderName: 'GPT', status: 'completed', content: '测试回复', createdAt: '2026-10-21T10:00:00Z', metadata: summary ? { fastMode: summary } : {} }];
      f.trace = { timelineEvents: [{ eventId: 'model-one', eventType: 'model_call', sequence: 1, stopReason: 'stop', tokenUsage: { outputTokens: 2 }, serviceTier: request }], summary: { modelCallCount: 1, status: 'completed' } };
      f.renderer.render(f.conversation, null, []);
      window.renderAgentTrace({ data: { session: { label: '复用旧 Session', fastMode: summary }, trace: { summary: { status: 'completed', modelCallCount: 1 }, events: [{ kind: 'model_call', phase: 'model_call', status: 'completed', title: '模型调用 #1', summary: request ? request.label : '档位未知', detail: { serviceTier: request } }] } } });
    }, { summary, request });
  };
  const badge = page.locator('.message-fast-mode');
  await render(snapshotServiceTier(configured), null);
  assert.match(await badge.textContent(), /已配置.*尚未请求/u);
  recordServiceTierRequest(configured, requested);
  await render(snapshotServiceTier(configured), normalizeServiceTierRequest(requested));
  assert.match(await badge.textContent(), /已请求.*执行未确认/u);
  assert.match(await badge.getAttribute('title'), /catalog.*不证明后端执行档位/u);
  assert.match(await page.locator('.model-call').textContent(), /Fast 已请求.*执行未确认/u);
  assert.match(await page.locator('#trace-summary').textContent(), /Fast 已请求.*执行未确认/u);
  const dir = process.env.CAFF_FAST_UI_EVIDENCE_DIR;
  assert.match(await page.locator('#trace-events').textContent(), /Fast 已请求.*执行未确认/u);
  for (const width of [1100, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await badge.evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth), true);
    if (dir) { fs.mkdirSync(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, `fast-requested-${width}.png`), fullPage: true }); }
  }
  for (const [status, label] of [['disabled', /Fast 关闭/u], ['unsupported', /模型不支持/u], ['out_of_scope', /通道不适用/u], ['error', /注入异常/u]]) {
    const s = createServiceTierState(status !== 'disabled');
    const r = { status, supportSource: status === 'unsupported' ? 'catalog' : null };
    recordServiceTierRequest(s, r);
    await render(snapshotServiceTier(s), normalizeServiceTierRequest(r));
    assert.match(await badge.textContent(), label);
    assert.match(await page.locator('.model-call').textContent(), label);
  }
  await render(null, null);
  assert.equal(await badge.count(), 0, 'legacy absent evidence is not labelled Fast off');
  assert.doesNotMatch(await page.locator('.model-call').textContent(), /Fast/u);
  assert.deepEqual(errors, []);
});
