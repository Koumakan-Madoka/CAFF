const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const readPublic = (name) => fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');

// 耗时分析面板的 UI 验证（契约 §10/§12）：真实 DOM 渲染 + app.js 取数状态机，
// 无服务器/网络。模板同 tests/ui/message-trace-stop.test.js。

const ASSISTANT_MESSAGE = {
  id: 'msg-breakdown',
  agentId: 'agent-owner',
  role: 'assistant',
  senderName: 'Owner',
  content: '回复内容',
  status: 'completed',
  createdAt: '2026-10-20T10:00:00.000Z',
};

function emptyTrace(toolExecutionCount) {
  return {
    message: null,
    task: null,
    session: null,
    modelUsageSummary: null,
    modelUsageCalls: [],
    timelineEvents: [],
    timelineWindow: { totalEventCount: 0, retainedEventCount: 0, droppedEventCount: 0, truncated: false },
    sessionToolCalls: [],
    bridgeToolEvents: [],
    steps: [],
    summary: {
      totalSteps: toolExecutionCount,
      toolExecutionCount,
      sessionToolCount: 0,
      bridgeToolCount: 0,
      failedSteps: 0,
      succeededSteps: toolExecutionCount,
      totalDurationMs: 0,
      retryCount: 0,
      hasRetries: false,
      modelCallCount: 0,
      coldStartModelCallCount: 0,
      postColdModelCallCount: 0,
      providerMissCount: 0,
      status: 'observed',
    },
    activity: { status: 'idle', hasCurrentTool: false, currentToolName: '', currentStepId: '', currentStepKind: '', inferred: false, label: '' },
    failureContext: { hasFailure: false, source: '', stepId: '', toolName: '', summary: '', text: '' },
  };
}

function breakdownData(overrides = {}) {
  return {
    status: 'complete',
    categoryMs: {
      read: 61000,
      write: 30000,
      test: 456000,
      'build-check': 5000,
      'process-report': 2000,
      thinking: 320000,
      'exception-retry': 1000,
      unclassified: 0,
    },
    metrics: { firstWriteMs: 183000, sessionReused: true, sessionReuseReason: 'reused', fullRunCount: 2, fullRunFailCount: 1 },
    steps: [
      { stepKey: 'a', toolName: 'read', category: 'read', subcategory: 'cold-start-reread', runKind: null, runFailed: null, jevStatus: null, durationMs: null, startedAt: '2026-10-20T10:00:00.000Z' },
      { stepKey: 'b', toolName: 'bash', category: 'test', subcategory: null, runKind: 'full-regression', runFailed: true, jevStatus: null, durationMs: 456000, startedAt: '2026-10-20T10:01:00.000Z' },
      { stepKey: 'c', toolName: 'bash', category: 'unclassified', subcategory: null, runKind: null, runFailed: null, jevStatus: 'low-confidence', durationMs: 2000, startedAt: '2026-10-20T10:02:00.000Z' },
    ],
    computedAt: '2026-10-20T10:05:00.000Z',
    ...overrides,
  };
}

async function launchHarness(t) {
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
    const conversation = { id: 'breakdown-room', agents: [agent], messages: [] };
    window.breakdownFixture = { conversation, renderer: null, traceState: null, breakdownState: null };
    window.breakdownFixture.renderer = window.CaffChat.createMessageTimelineRenderer({
      dom: { messageTimeline: document.getElementById('timeline') },
      helpers: {
        agentById: (id) => (id === agent.id ? agent : null),
        buildAgentAvatarElement: () => {
          const avatar = document.createElement('span');
          avatar.className = 'agent-avatar tiny';
          avatar.textContent = 'O';
          return avatar;
        },
        canInspectToolTrace: (message) => Boolean(message && message.role === 'assistant'),
        conversationSummaries: () => [],
        crossConversationBundleForMessage: () => null,
        displayedMessageBody: (message) => message.content,
        digestStatusForConversation: () => null,
        formatDateTime: window.formatDateTime,
        isConversationMessageDeletionBlocked: () => false,
        isPrivateTimelineMessage: () => false,
        liveStageForMessage: () => null,
        liveStageLabel: () => '',
        messageSessionInfo: window.messageSessionInfo,
        privateRecipientNames: () => [],
        recoverFailedMessage: () => {},
        renderMessageBody: (container, text) => { container.textContent = text; },
        stopConversationTrace: () => {},
        isTraceStopRequestInFlight: () => false,
        queuedSideDispatchCountForMessage: () => 0,
        timelineMessagesForConversation: (item) => item.messages,
        toolTraceStateForMessage: () => window.breakdownFixture.traceState,
        toolTraceSignatureForMessage: () => JSON.stringify(window.breakdownFixture.traceState || null),
        timeBreakdownStateForMessage: () => window.breakdownFixture.breakdownState,
        timeBreakdownSignatureForMessage: () => JSON.stringify(window.breakdownFixture.breakdownState || null),
      },
      showToast() {},
    });
  });

  const renderWith = (fixture) => page.evaluate((input) => {
    const { conversation, renderer } = window.breakdownFixture;
    window.breakdownFixture.traceState = input.traceState || null;
    window.breakdownFixture.breakdownState = input.breakdownState || null;
    conversation.messages = [input.message];
    renderer.render(conversation, null, []);
  }, fixture);

  return { page, errors, renderWith };
}

test('breakdown toggle visibility follows the pinned §10 rule', async (t) => {
  const { page, errors, renderWith } = await launchHarness(t);

  // Trace not yet loaded → discoverable.
  await renderWith({ message: ASSISTANT_MESSAGE, traceState: null, breakdownState: null });
  assert.equal(await page.locator('.message-time-breakdown-toggle').count(), 1);

  // Trace loaded with tool steps → visible.
  await renderWith({
    message: ASSISTANT_MESSAGE,
    traceState: { open: false, status: 'ready', data: emptyTrace(3) },
    breakdownState: null,
  });
  assert.equal(await page.locator('.message-time-breakdown-toggle').count(), 1);

  // Trace loaded with zero tool steps → hidden.
  await renderWith({
    message: ASSISTANT_MESSAGE,
    traceState: { open: false, status: 'ready', data: emptyTrace(0) },
    breakdownState: null,
  });
  assert.equal(await page.locator('.message-time-breakdown-toggle').count(), 0);

  // A 404 (empty) with no trace loaded → hidden (no permanently empty button).
  await renderWith({
    message: ASSISTANT_MESSAGE,
    traceState: null,
    breakdownState: { open: false, status: 'empty', data: null },
  });
  assert.equal(await page.locator('.message-time-breakdown-toggle').count(), 0);

  // An open panel always keeps its toggle so it can be closed.
  await renderWith({
    message: ASSISTANT_MESSAGE,
    traceState: { open: false, status: 'ready', data: emptyTrace(0) },
    breakdownState: { open: true, status: 'empty', data: null },
  });
  assert.equal(await page.locator('.message-time-breakdown-toggle').count(), 1);
  assert.deepEqual(errors, []);
});

test('open panel renders category bars in contract order, metrics, and step rows', async (t) => {
  const { page, errors, renderWith } = await launchHarness(t);

  await renderWith({
    message: ASSISTANT_MESSAGE,
    traceState: { open: false, status: 'ready', data: emptyTrace(3) },
    breakdownState: { open: true, status: 'ready', data: breakdownData() },
  });

  const barLabels = await page.locator('.message-time-breakdown-bar-label').allTextContents();
  assert.deepEqual(barLabels, ['读', '改', '测', '构建与检查', '流程与汇报', '模型思考', '异常与重试', '未分类']);

  const barAmounts = await page.locator('.message-time-breakdown-bar-amount').allTextContents();
  assert.equal(barAmounts[2].startsWith('7 分 36 秒 · '), true);
  assert.equal(barAmounts[7], '0');

  const metrics = await page.locator('.message-time-breakdown-metric').allTextContents();
  assert.deepEqual(metrics, ['首次改文件：3 分 3 秒', '会话复用：已复用', '全量回归：2 遍，失败 1 次']);

  const steps = page.locator('.message-time-breakdown-step');
  assert.equal(await steps.count(), 3);
  // Steps are sorted by startedAt: read (no end) → test → unclassified.
  assert.match(await steps.nth(0).textContent(), /读 · 上下文重读/u);
  assert.equal(await steps.nth(0).locator('.message-time-breakdown-step-duration').textContent(), '无终点');
  assert.match(await steps.nth(1).textContent(), /测/u);
  assert.match(await steps.nth(1).locator('.message-time-breakdown-step-extra').textContent(), /全量回归 · 失败/u);
  assert.match(await steps.nth(2).textContent(), /未分类/u);
  assert.match(await steps.nth(2).locator('.message-time-breakdown-step-extra').textContent(), /JEV 低置信度/u);

  // Terminal breakdown: no live refresh hint.
  assert.equal(await page.locator('.message-time-breakdown-note', { hasText: '轮次仍在进行' }).count(), 0);
  assert.deepEqual(errors, []);
});

test('live breakdown shows the refresh affordance; failed refresh keeps last result with a note', async (t) => {
  const { page, errors, renderWith } = await launchHarness(t);

  await renderWith({
    message: ASSISTANT_MESSAGE,
    traceState: { open: false, status: 'ready', data: emptyTrace(3) },
    breakdownState: { open: true, status: 'ready', data: breakdownData({ status: 'live' }) },
  });

  assert.equal(await page.locator('.message-time-breakdown-refresh').count(), 1);
  assert.equal(await page.locator('.message-time-breakdown-note', { hasText: '轮次仍在进行' }).count(), 1);

  // Refresh failed but previous data exists → stale note, no silent data.
  await renderWith({
    message: ASSISTANT_MESSAGE,
    traceState: { open: false, status: 'ready', data: emptyTrace(3) },
    breakdownState: {
      open: true,
      status: 'error',
      errorMessage: '网络错误',
      data: breakdownData({ status: 'live' }),
    },
  });
  assert.equal(await page.locator('.message-time-breakdown-note.failed', { hasText: '刷新失败，显示上次结果' }).count(), 1);
  assert.equal(await page.locator('.message-time-breakdown-bar-label').count(), 8);
  assert.deepEqual(errors, []);
});

function loadBreakdownStateMachine(fetchJson) {
  const app = readPublic('app.js');
  const slice = app.slice(
    app.indexOf('function timeBreakdownStateForMessage'),
    app.indexOf('function renderConversationList')
  );
  const state = { messageTimeBreakdownById: new Map(), selectedConversationId: 'c1' };
  const context = {
    state,
    fetchJson,
    canInspectToolTrace: (message) => Boolean(message && message.role === 'assistant'),
    scheduleConversationPaneRender: () => {},
    Number, String, Array, Object, JSON, Map, Promise, Error, Boolean, encodeURIComponent,
  };
  vm.runInNewContext(`${slice}; this.__api = { toggleMessageTimeBreakdown, fetchMessageTimeBreakdown, getMessageTimeBreakdownState, timeBreakdownStateForMessage };`, context);
  return context.__api;
}

const BREAKDOWN_MESSAGE = { id: 'm1', role: 'assistant' };

test('fetch state machine: toggle fetches once, terminal reopen is cached, live reopen refetches, 404 is an honest empty state', async () => {
  const calls = [];
  let responder = async () => ({ breakdown: breakdownData() });
  const api = loadBreakdownStateMachine((url) => {
    calls.push(url);
    return responder();
  });

  // First open → exactly one fetch against the contract route.
  await api.toggleMessageTimeBreakdown('c1', BREAKDOWN_MESSAGE);
  assert.deepEqual(calls, ['/api/conversations/c1/messages/m1/time-breakdown']);
  assert.equal(api.timeBreakdownStateForMessage('m1').status, 'ready');

  // Close + reopen with a terminal breakdown → cached, no new request.
  api.toggleMessageTimeBreakdown('c1', BREAKDOWN_MESSAGE);
  await api.toggleMessageTimeBreakdown('c1', BREAKDOWN_MESSAGE);
  assert.equal(calls.length, 1);

  // Live breakdown → reopening forces a refetch.
  api.getMessageTimeBreakdownState('m1').data = breakdownData({ status: 'live' });
  api.toggleMessageTimeBreakdown('c1', BREAKDOWN_MESSAGE);
  await api.toggleMessageTimeBreakdown('c1', BREAKDOWN_MESSAGE);
  assert.equal(calls.length, 2);

  // 404 → honest empty state (not an error), and reopening retries.
  responder = async () => {
    const error = new Error('Request failed with status 404');
    error.status = 404;
    throw error;
  };
  api.getMessageTimeBreakdownState('m1').data = null;
  await api.fetchMessageTimeBreakdown('c1', BREAKDOWN_MESSAGE, { force: true });
  assert.equal(api.timeBreakdownStateForMessage('m1').status, 'empty');
  assert.equal(api.timeBreakdownStateForMessage('m1').errorMessage, '');
  api.toggleMessageTimeBreakdown('c1', BREAKDOWN_MESSAGE);
  await api.toggleMessageTimeBreakdown('c1', BREAKDOWN_MESSAGE);
  assert.equal(calls.length, 4);
});

test('source wiring guards: click delegation and category bar styles', () => {
  const appSource = readPublic('app.js');
  const stylesSource = readPublic('styles.css');

  assert.match(appSource, /event\.target\.closest\('\.message-time-breakdown-toggle'\)/u);
  assert.match(appSource, /event\.target\.closest\('\.message-time-breakdown-refresh'\)/u);
  assert.match(appSource, /toggleMessageTimeBreakdown\(state\.currentConversation\.id, message\)/u);
  assert.match(appSource, /fetchMessageTimeBreakdown\(state\.currentConversation\.id, message, \{ force: true \}\)/u);
  assert.match(appSource, /messageTimeBreakdownById: new Map\(\)/u);

  assert.match(stylesSource, /\.message-time-breakdown\.hidden\s*\{\s*display:\s*none/u);
  for (const category of ['read', 'write', 'test', 'build-check', 'process-report', 'thinking', 'exception-retry', 'unclassified']) {
    assert.match(
      stylesSource,
      new RegExp(`\\.message-time-breakdown-bar\\.category-${category} \\.message-time-breakdown-bar-fill`, 'u'),
      `missing bar color for category ${category}`
    );
  }
});
