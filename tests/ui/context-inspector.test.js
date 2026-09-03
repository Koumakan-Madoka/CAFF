const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const MESSAGE_TIMELINE_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'chat', 'message-timeline.js'), 'utf8');

function loadContextInspectorRenderer(document, state, dom) {
  const start = APP_SOURCE.indexOf('function formatInspectorNumber');
  const end = APP_SOURCE.indexOf('async function openAgentContextInspector');
  assert.ok(start >= 0 && end > start, 'context inspector renderer source should be discoverable');
  return vm.runInNewContext(
    `${APP_SOURCE.slice(start, end)}\nrenderAgentContextInspector`,
    { document, state, dom },
    { filename: 'public/app.js#context-inspector' }
  );
}

function loadContextInspectorController(document, state, dom, fetchJson) {
  const start = APP_SOURCE.indexOf('function messageTraceInspectorUrl');
  const end = APP_SOURCE.indexOf('function isActiveLiveStage');
  assert.ok(start >= 0 && end > start, 'context inspector controller source should be discoverable');
  const window = {
    caffShell: { openTab() {}, releaseTab() {} },
    setTimeout(callback) { callback(); return 1; },
    URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
  };
  return vm.runInNewContext(
    `${APP_SOURCE.slice(start, end)}\n({ openAgentContextInspector, navigateAgentContextLineageNode, navigateBackAgentContextInspector })`,
    {
      document,
      state,
      dom,
      fetchJson,
      showToast() {},
      copyTextToClipboard: async () => {},
      navigator: { clipboard: null },
      window,
      Intl,
      Date,
      Number,
      String,
      Array,
      Object,
      JSON,
      Promise,
    },
    { filename: 'public/app.js#context-inspector-controller' }
  );
}

function metaValues(document) {
  return new Map(
    [...document.querySelectorAll('.agent-context-meta-grid > div')]
      .map((cell) => [cell.querySelector('span').textContent, cell.querySelector('strong').textContent])
  );
}

test('model call UI uses Session actions while preserving provider cache wording', () => {
  assert.doesNotMatch(MESSAGE_TIMELINE_SOURCE, /['"`]冷启动/u);
  assert.match(MESSAGE_TIMELINE_SOURCE, /复用旧 Session/u);
  assert.match(MESSAGE_TIMELINE_SOURCE, /新建 Session/u);
  assert.match(MESSAGE_TIMELINE_SOURCE, /provider miss/u);
  assert.match(MESSAGE_TIMELINE_SOURCE, /缓存命中/u);
});

test('lineage navigation scrolls current-page parents and lazy-loads messages outside the page', async () => {
  const page = new JSDOM(`<!doctype html><body>
    <article class="message-card" data-message-id="assistant-parent"></article>
    <p id="status"></p><button id="back"></button><button id="trace-button"></button>
    <button id="context-button"></button><button id="copy"></button><button id="export"></button>
    <p id="notice"></p><section id="lineage"></section>
    <div id="trace-view"><div id="trace-summary"></div><div id="trace-events"></div></div>
    <div id="context-view"><div id="summary"></div><div id="sections"></div></div>
  </body>`);
  const { document } = page.window;
  let scrolled = false;
  document.querySelector('[data-message-id="assistant-parent"]').scrollIntoView = () => { scrolled = true; };
  const requests = [];
  const payloadFor = (messageId) => ({
    message: { id: messageId, agentName: 'GPT', status: 'completed' },
    session: { label: messageId === 'assistant-root' ? '新建 Session' : '复用旧 Session', mode: messageId === 'assistant-root' ? 'fresh' : 'resume' },
    snapshot: { agentName: 'GPT', messageId, deliveryMode: messageId === 'assistant-root' ? 'fresh' : 'resume', totalApproxTokens: 1, totalByteSize: 4, sections: [] },
    runEvidence: {},
    lineage: { maxDepth: 8, nodes: [{ relation: 'current', depth: 0, messageId, deliveryMode: 'resume' }], termination: { code: 'fresh_root' } },
    trace: { summary: { status: 'completed', modelCallCount: 0, toolExecutionCount: 0, providerMissCount: 0 }, events: [] },
  });
  const state = {
    contextInspector: {
      open: true,
      loading: false,
      errorMessage: '',
      conversationId: 'conversation-1',
      messageId: 'assistant-current',
      data: payloadFor('assistant-current'),
      snapshot: payloadFor('assistant-current').snapshot,
      runEvidence: {},
      view: 'trace',
      navigationStack: [],
    },
  };
  const dom = {
    agentContextStatus: document.getElementById('status'),
    agentContextBackButton: document.getElementById('back'),
    agentTraceViewButton: document.getElementById('trace-button'),
    agentContextViewButton: document.getElementById('context-button'),
    agentContextCopyButton: document.getElementById('copy'),
    agentContextExportButton: document.getElementById('export'),
    agentContextPageNotice: document.getElementById('notice'),
    agentSessionLineage: document.getElementById('lineage'),
    agentTraceView: document.getElementById('trace-view'),
    agentTraceSummary: document.getElementById('trace-summary'),
    agentTraceEventList: document.getElementById('trace-events'),
    agentContextView: document.getElementById('context-view'),
    agentContextSummary: document.getElementById('summary'),
    agentContextSectionList: document.getElementById('sections'),
  };
  const controller = loadContextInspectorController(document, state, dom, async (url) => {
    requests.push(url);
    const match = url.match(/messages\/([^/]+)\/trace-inspector$/u);
    return payloadFor(decodeURIComponent(match[1]));
  });

  await controller.navigateAgentContextLineageNode('assistant-parent');
  assert.equal(scrolled, true);
  assert.equal(state.contextInspector.messageId, 'assistant-parent');
  assert.deepEqual(Array.from(state.contextInspector.navigationStack), ['assistant-current']);
  assert.equal(dom.agentContextPageNotice.hidden, true);

  await controller.navigateAgentContextLineageNode('assistant-root');
  assert.equal(state.contextInspector.messageId, 'assistant-root');
  assert.deepEqual(Array.from(state.contextInspector.navigationStack), ['assistant-current', 'assistant-parent']);
  assert.equal(dom.agentContextPageNotice.hidden, false);
  assert.match(dom.agentContextPageNotice.textContent, /不在当前分页/u);

  await controller.navigateBackAgentContextInspector();
  assert.equal(state.contextInspector.messageId, 'assistant-parent');
  assert.deepEqual(Array.from(state.contextInspector.navigationStack), ['assistant-current']);
  assert.equal(requests.length, 3);
});

test('Context Inspector distinguishes resumed delta from the retained session prefix', () => {
  const page = new JSDOM(`<!doctype html><body>
    <p id="status"></p>
    <button id="export"></button>
    <div id="summary"></div>
    <div id="sections"></div>
  </body>`);
  const { document } = page.window;
  const snapshot = {
    agentName: 'GLM',
    turnId: 'turn-resume',
    capturedAt: '2026-09-02T17:07:40.000Z',
    deliveryMode: 'resume',
    totalApproxTokens: 14,
    totalByteSize: 55,
    retainedSessionPrefix: {
      sessionName: 'chat-reused-session',
      cursorMessageCount: 3,
      cursorMessageId: 'assistant-first',
      staticSegmentHash: 'abcdef0123456789',
    },
    sections: [{
      sectionKey: 'session_delta',
      displayTitle: '本轮追加内容 / Session Resume Delta',
      source: 'session/resume-delta',
      visibility: 'full',
      approxTokens: 14,
      byteSize: 55,
      contentHash: 'delta-hash',
      truncated: false,
      redacted: false,
      policyNote: '本轮实际追加内容。',
      displayContent: 'New messages since your last reply:\nUser: 第二轮问题',
    }],
  };
  const state = {
    contextInspector: {
      loading: false,
      errorMessage: '',
      snapshot,
      runEvidence: {
        cacheReadTokens: 54581,
        uncachedInputTokens: 2234,
      },
    },
  };
  const dom = {
    agentContextStatus: document.getElementById('status'),
    agentContextExportButton: document.getElementById('export'),
    agentContextSummary: document.getElementById('summary'),
    agentContextSectionList: document.getElementById('sections'),
  };

  loadContextInspectorRenderer(document, state, dom)();

  assert.match(dom.agentContextStatus.textContent, /复用旧 Session · 约 14 tokens/u);
  const values = metaValues(document);
  assert.equal(values.get('投递方式'), '复用旧 Session（仅追加增量）');
  assert.equal(values.get('本轮追加 tokens'), '14');
  assert.equal(values.get('本轮追加字节数'), '55');
  assert.equal(values.get('保留前缀 Session'), 'chat-reused-session');
  assert.equal(values.get('保留前缀游标'), '3 条 · assistant-first');
  assert.equal(values.get('静态段 Hash'), 'abcdef0123456789');
  assert.equal(values.get('Cache read tokens'), '54,581');
  assert.equal(values.get('未缓存 input tokens'), '2,234');
  assert.equal(dom.agentContextSummary.textContent.includes('系统提示词 tokens 总数'), false);
  assert.match(dom.agentContextSectionList.textContent, /New messages since your last reply/u);
  assert.doesNotMatch(dom.agentContextSectionList.textContent, /第一次完整历史/u);
});

test('Context Inspector does not mislabel a legacy reused snapshot as fresh', () => {
  const page = new JSDOM(`<!doctype html><body>
    <p id="status"></p>
    <button id="export"></button>
    <div id="summary"></div>
    <div id="sections"></div>
  </body>`);
  const { document } = page.window;
  const state = {
    contextInspector: {
      loading: false,
      errorMessage: '',
      snapshot: {
        agentName: 'GLM',
        turnId: 'legacy-turn',
        deliveryMode: 'unknown',
        totalApproxTokens: 4403,
        totalByteSize: 17611,
        sections: [],
      },
      runEvidence: {
        sessionReused: true,
        sessionReuseReason: 'reused',
        cacheReadTokens: 54581,
        uncachedInputTokens: 2234,
      },
    },
  };
  const dom = {
    agentContextStatus: document.getElementById('status'),
    agentContextExportButton: document.getElementById('export'),
    agentContextSummary: document.getElementById('summary'),
    agentContextSectionList: document.getElementById('sections'),
  };

  loadContextInspectorRenderer(document, state, dom)();

  const values = metaValues(document);
  assert.match(dom.agentContextStatus.textContent, /旧版 Session/u);
  assert.equal(values.get('投递方式'), '旧版 Resume 快照（分区口径不可靠）');
  assert.equal(values.get('快照 tokens'), '4,403');
  assert.equal(values.get('Cache read tokens'), '54,581');
  assert.equal(dom.agentContextSummary.textContent.includes('新建 Session（完整注入）'), false);
});

test('Trace Inspector renders bounded lineage and full lifecycle separately from context sections', () => {
  const page = new JSDOM(`<!doctype html><body>
    <p id="status"></p>
    <button id="back"></button>
    <button id="trace-button"></button>
    <button id="context-button"></button>
    <button id="copy"></button>
    <button id="export"></button>
    <p id="notice"></p>
    <section id="lineage"></section>
    <div id="trace-view"><div id="trace-summary"></div><div id="trace-events"></div></div>
    <div id="context-view"><div id="summary"></div><div id="sections"></div></div>
  </body>`);
  const { document } = page.window;
  const snapshot = {
    agentName: 'GPT',
    turnId: 'turn-current',
    capturedAt: '2026-09-03T10:00:00.000Z',
    deliveryMode: 'resume',
    totalApproxTokens: 12,
    totalByteSize: 48,
    sections: [],
  };
  const data = {
    session: { label: '复用旧 Session', mode: 'resume' },
    lineage: {
      maxDepth: 8,
      nodes: [
        { relation: 'current', depth: 0, messageId: 'assistant-current', deliveryMode: 'resume' },
        { relation: 'parent', depth: 1, messageId: 'assistant-parent', deliveryMode: 'resume' },
        { relation: 'ancestor', depth: 2, messageId: 'assistant-root', deliveryMode: 'fresh' },
      ],
      termination: { code: 'fresh_root', atDepth: 2 },
    },
    trace: {
      summary: { status: 'completed', totalDurationMs: null, modelCallCount: 1, toolExecutionCount: 1, providerMissCount: 0 },
      events: [
        { sequence: 1, kind: 'lifecycle', phase: 'trigger', status: 'observed', title: '触发回复', summary: 'user 触发' },
        { sequence: 2, kind: 'lifecycle', phase: 'claim', status: 'completed', title: 'Session claim', summary: '原子 claim 成功' },
        { sequence: 3, kind: 'model_call', phase: 'model_call', status: 'completed', title: '复用旧 Session', summary: '复用旧 Session · 缓存命中', detail: { providerCacheStatus: 'cache_hit' } },
        { sequence: 4, kind: 'tool_execution', phase: 'tool', status: 'completed', title: 'bash', summary: '执行完成' },
        { sequence: 5, kind: 'lifecycle', phase: 'persistence', status: 'completed', title: '消息落库', summary: 'completed' },
      ],
    },
  };
  const state = {
    contextInspector: {
      loading: false,
      errorMessage: '',
      messageId: 'assistant-current',
      snapshot,
      runEvidence: {},
      data,
      view: 'trace',
      navigationStack: [],
    },
  };
  const dom = {
    agentContextStatus: document.getElementById('status'),
    agentContextBackButton: document.getElementById('back'),
    agentTraceViewButton: document.getElementById('trace-button'),
    agentContextViewButton: document.getElementById('context-button'),
    agentContextCopyButton: document.getElementById('copy'),
    agentContextExportButton: document.getElementById('export'),
    agentContextPageNotice: document.getElementById('notice'),
    agentSessionLineage: document.getElementById('lineage'),
    agentTraceView: document.getElementById('trace-view'),
    agentTraceSummary: document.getElementById('trace-summary'),
    agentTraceEventList: document.getElementById('trace-events'),
    agentContextView: document.getElementById('context-view'),
    agentContextSummary: document.getElementById('summary'),
    agentContextSectionList: document.getElementById('sections'),
  };

  loadContextInspectorRenderer(document, state, dom)();

  assert.equal(dom.agentSessionLineage.querySelectorAll('.agent-session-lineage-node').length, 3);
  assert.match(dom.agentSessionLineage.textContent, /父 Session/u);
  assert.match(dom.agentSessionLineage.textContent, /已到达新建 Session 根节点/u);
  assert.match(dom.agentTraceSummary.textContent, /模型调用1/u);
  assert.match(dom.agentTraceSummary.textContent, /总耗时-/u);
  assert.match(dom.agentTraceEventList.textContent, /触发回复/u);
  assert.match(dom.agentTraceEventList.textContent, /Session claim/u);
  assert.match(dom.agentTraceEventList.textContent, /复用旧 Session/u);
  assert.match(dom.agentTraceEventList.textContent, /缓存命中/u);
  assert.match(dom.agentTraceEventList.textContent, /消息落库/u);
  assert.equal(dom.agentTraceView.hidden, false);
  assert.equal(dom.agentContextView.hidden, true);
  assert.equal(dom.agentContextPageNotice.hidden, false);
  assert.match(dom.agentContextPageNotice.textContent, /不在当前分页/u);
  assert.doesNotMatch(dom.agentTraceEventList.textContent, /冷启动/u);
});
