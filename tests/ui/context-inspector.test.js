const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

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

function metaValues(document) {
  return new Map(
    [...document.querySelectorAll('.agent-context-meta-grid > div')]
      .map((cell) => [cell.querySelector('span').textContent, cell.querySelector('strong').textContent])
  );
}

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

  assert.match(dom.agentContextStatus.textContent, /本轮追加 · 约 14 tokens/u);
  const values = metaValues(document);
  assert.equal(values.get('投递方式'), '恢复旧 Session（仅追加增量）');
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
