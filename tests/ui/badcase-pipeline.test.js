const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(r => setImmediate(r));
function setup(t, fetcher) {
  const dom = new JSDOM('<section id="pipeline"></section>', { runScripts: 'outside-only', url: 'http://127.0.0.1/wikiskill.html' });
  t.after(() => dom.window.close()); dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/badcase-pipeline.js'), 'utf8'));
  const root = dom.window.document.querySelector('#pipeline'), calls = [];
  const packet = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', complete: false, origin: 'backfill', frozenAt: '2026-11-05T00:00:00Z', source: { conversationId: 'room', messageId: 'msg' },
    markedStep: 1, markedMessage: 'actual full reply', missingReasons: ['original_context_unavailable'], context: { trigger: { message: { content: 'original request' } }, systemPrompt: null, loadedSkillPaths: ['test/SKILL.md'] },
    steps: [{ step: 1, entryId: 'a1', output: { content: [{ type: 'text', text: '<script>unsafe</script> full model text' }] }, toolResults: [{ message: { content: [{ type: 'text', text: 'long-result-' + 'x'.repeat(3000) + ' final-needle' }] } }], durationMs: null }], metrics: {}, scene: null };
  const data = { cases: [
    { id: 'c1', n: 1, kind: 'text-only', split: 'train', actual: 'wrong behavior', expected: 'right', message: 'DO NOT USE EXCERPT', source: { agentId: 'role-family-gpt', conversationTitle: 'Source room' }, traceBundle: { hash: 'a'.repeat(64), origin: 'backfill', complete: false, missingReasons: packet.missingReasons, stepCount: 1 } },
    { id: 'c2', n: 19, kind: 'marked-badcase', split: 'gate', actual: 'scene issue', expected: 'fix', source: { agentId: 'role-family-gpt', conversationTitle: 'Scene room' }, sealedCheckpointId: 'cp', traceBundle: { hash: 'b'.repeat(64), origin: 'backfill', complete: false, missingReasons: ['sealed_marked_turn_not_recorded'], stepCount: 0 } },
    { id: 'c3', n: 4, kind: 'text-only', split: 'test', actual: 'old source', source: { agentId: 'role-family-gpt' } },
    { id: 'c4', n: 17, kind: 'marked-badcase', split: 'train', actual: 'other model', source: { agentId: 'role-family-deepseek' } },
  ], caseStates: [], replayCases: [] };
  const panel = dom.window.CaffShared.createBadcasePipeline({ root, fetchJson: async url => { calls.push(url); return fetcher ? fetcher(url, packet) : { traceBundle: JSON.parse(JSON.stringify(packet)) }; } });
  panel.render(data);
  async function expand() { const d = root.querySelector('[data-trace-case="c1"]'); d.open = true; d.dispatchEvent(new dom.window.Event('toggle')); await tick(); await tick(); }
  return { root, data, packet, calls, panel, window: dom.window, expand };
}
test('pipeline has truthful stepper, actor groups, two funnels, backfill states and source-only exclusions without writes', t => {
  const h = setup(t); assert.equal(h.calls.length, 0);
  assert.equal(h.root.querySelectorAll('[data-lane]').length, 2);
  assert.equal(h.root.querySelector('[data-case-id="c1"] .stepper').children.length, 9);
  for (const text of ['按下一步分组', '旧题的来源', '非 GPT 来源', '回填部分完成', '待采集能力合入', '评分 v2', 'JEV 推荐待接入']) assert.ok(h.root.textContent.includes(text), text);
  assert.doesNotMatch(h.root.textContent, /批准补全|示例.*JEV|已成为测试用例.*[1-9]/);
  assert.equal(h.root.querySelector('[data-case-id="c3"]').closest('[data-actor]').dataset.actor, 'source');
});
test('legacy context reason means missing newer archive, not missing recovered input or reused turns', t => {
  const h = setup(t);
  assert.match(h.root.textContent, /没有新版上下文归档；本轮输入和续用前轮已从会话日志恢复/);
  assert.doesNotMatch(h.root.textContent, /未保存当时的原始上下文/);
  h.data.cases[0].traceBundle.missingReasons = ['context_archive_missing', 'system_prompt_display_redacted', 'provider_request_bytes_missing'];
  h.panel.render(h.data);
  for (const text of ['没有新版上下文归档', '系统提示词为历史展示版', '未保存供应商请求原始字节']) assert.ok(h.root.textContent.includes(text), text);
  assert.equal(h.calls.length, 0);
});
test('expand fetches frozen packet lazily, shows full output/results and exports only from its read-only endpoints', async t => {
  const h = setup(t); await h.expand(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0], '/api/wikiskill/cases/c1/trace');
  const trace = h.root.querySelector('[data-trace-case="c1"]');
  assert.equal(trace.querySelectorAll('[data-trace-section]').length, 3);
  assert.match(trace.textContent, /original request|full model text/); assert.match(trace.textContent, /final-needle/);
  assert.doesNotMatch(trace.textContent, /DO NOT USE EXCERPT/); assert.equal(trace.querySelector('script'), null);
  assert.ok([...trace.querySelectorAll('details.trace-value')].some(d => !d.open));
  assert.equal(trace.querySelector('[data-export="json"]').getAttribute('href'), '/api/wikiskill/cases/c1/trace/export.json');
  assert.equal(trace.querySelector('[data-export="md"]').getAttribute('href'), '/api/wikiskill/cases/c1/trace/export.md');
  const q = trace.querySelector('[data-trace-search]'); q.value = 'final-needle'; q.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(trace.querySelector('mark').textContent, 'final-needle'); assert.match(trace.querySelector('[data-trace-matches]').textContent, /1/);
  assert.equal(h.calls.length, 1); assert.equal(h.data.cases[0].message, 'DO NOT USE EXCERPT');
});
test('failed reads never fall back to excerpts and allow an explicit retry', async t => {
  let failing = true; const h = setup(t, (_url, packet) => { if (failing) throw Error('private-path'); return { traceBundle: packet }; });
  await h.expand(); const trace = h.root.querySelector('[data-trace-case="c1"]');
  assert.match(trace.textContent, /读取失败/); assert.doesNotMatch(trace.textContent, /private-path|DO NOT USE EXCERPT/);
  failing = false; trace.querySelector('[data-trace-retry]').click(); await tick(); await tick();
  assert.match(trace.textContent, /full model text/); assert.equal(h.calls.length, 2);
});
test('stale packet responses after a data refresh cannot replace current evidence', async t => {
  const pending = []; const h = setup(t, () => new Promise(r => { pending.push(r); })); await h.expand();
  h.data.cases[0].traceBundle.hash = 'c'.repeat(64); h.panel.render(h.data);
  pending[0]({ traceBundle: { ...h.packet, markedMessage: 'STALE RESPONSE' } }); await tick(); await tick();
  assert.doesNotMatch(h.root.textContent, /STALE RESPONSE/);
});
