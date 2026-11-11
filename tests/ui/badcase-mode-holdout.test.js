const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { JSDOM } = require('jsdom');
const fixture = require('../helpers/wiki-holdout-ui.cjs');
const tick = () => new Promise(r => setImmediate(r));
async function setup(t, options) {
  const h = await fixture(t, options), saved = h.data(), before = JSON.stringify(saved), calls = [];
  const dom = new JSDOM('<main id="root"></main>', { runScripts: 'outside-only', url: 'http://127.0.0.1/wikiskill.html' });
  t.after(() => dom.window.close()); dom.window.TextEncoder = TextEncoder;
  dom.window.matchMedia = () => ({ matches: false }); dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  for (const file of ['badcase-pipeline', 'badcase-wiki']) dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/' + file + '.js'), 'utf8'));
  const root = dom.window.document.querySelector('#root');
  const panel = dom.window.CaffShared.createBadcaseWikiPanel({ root, fetchJson: async (url, options = {}) => { calls.push({ url, ...options }); return structuredClone(saved); } });
  const click = async selector => { const el = root.querySelector(selector); assert.ok(el, selector); el.click(); await tick(); await tick(); };
  const readonly = () => {
    assert.equal(calls.filter(c => c.method === 'POST').length, 0); assert.equal(JSON.stringify(saved), before);
    assert.equal(root.querySelector('#view-impact form, #view-impact [data-adopt], #view-impact [data-run], #view-impact [data-retry]'), null);
  };
  return { ...h, root, panel, saved, calls, click, readonly };
}
test('v4 result shows aggregate local gate then per-other-mode validation, uncovered warning and level reports read-only', async t => {
  const h = await setup(t); await h.panel.load(); await h.click('[data-tab="impact"]');
  const box = h.root.querySelector('#impact-runs'), gate = box.querySelector('[data-evaluation-stage="gate"]'), validation = box.querySelector('[data-evaluation-stage="validation"]');
  assert.deepEqual([...box.querySelectorAll('[data-evaluation-stage]')].map(e => e.dataset.evaluationStage), ['gate', 'validation']);
  assert.match(gate.textContent, /门槛（本模式）.*合计.*Fisher/s); assert.match(gate.textContent, /0\/20.*6\/20/s);
  assert.match(gate.textContent, /trace 级.*run 级/s); assert.match(gate.textContent, /失败.*无效.*错误/s);
  assert.match(validation.textContent, /验证（其他模式对照题）.*每题每版 5 次.*少通过 2 次/s);
  assert.match(validation.querySelector('tbody').textContent, /#17.*5\/5.*5\/5.*未劣化/s);
  assert.match(validation.textContent, /未覆盖.*模式 2.*未覆盖不等于验证通过/s);
  assert.match(box.textContent, /门槛通过、验证部分未覆盖.*人工/s);
  assert.match(box.textContent, /硬断言＋AI 裁判/);
  assert.doesNotMatch(box.textContent, /测试阶段|无误伤：|代理模型 DeepSeek|noHarm|entry-2/);
  h.readonly();
});
for (const scenario of ['rejected', 'degraded', 'uncovered', 'budget']) test(`v4 ${scenario} never calls missing noHarm or claims unexecuted validation passed`, async t => {
  const h = await setup(t, { scenario }); await h.panel.load(); await h.click('[data-tab="impact"]');
  const box = h.root.querySelector('#impact-runs'), validation = box.querySelector('[data-evaluation-stage="validation"]'); assert.ok(validation);
  if (scenario === 'rejected') { assert.match(box.textContent, /门槛未通过/); assert.match(validation.textContent, /门槛未通过.*验证未运行/s); }
  if (scenario === 'degraded') {
    assert.match(box.textContent, /门槛通过、验证劣化/); const rows = [...validation.querySelectorAll('tbody tr')];
    assert.match(rows[0].textContent, /#17.*5\/5.*3\/5.*劣化/s);
    assert.match(rows[1].textContent, /#18.*0\/5.*0\/5.*not-run.*已有劣化而停止/s);
    assert.doesNotMatch(rows[1].textContent, /未劣化/); assert.match(box.textContent, /不可提交采纳/);
    assert.match(h.root.querySelector('#impact-log').textContent, /验证劣化/);
  }
  if (scenario === 'uncovered') { assert.match(box.textContent, /门槛通过、验证全部未覆盖/); assert.match(validation.textContent, /未覆盖不等于验证通过/); }
  if (scenario === 'budget') { assert.match(validation.textContent, /用量估算超上限.*验证未运行/s); assert.match(box.textContent, /不可提交采纳/); }
  assert.equal(box.querySelector('[data-evaluation-stage="test"]'), null); h.readonly();
});
for (const [reason, label, scenario] of [['gate_rejected', '门槛未通过、未采纳', 'rejected'], ['validation_degraded', '门槛通过、验证劣化、未采纳', 'degraded'], ['user_declined', '用户拒绝、未采纳', 'partial']]) test(`v4 review, timeline and candidate label ${reason} without adding a review form`, async t => {
  const h = await fixture(t, { scenario });
  h.store.reviewComparison({ comparisonId: h.result.id, decision: 'not-adopted', reason, candidateHash: h.result.candidate.candidateHash,
    interpretation: '合成裁决 <script>not-html</script>', expectedRevision: h.store.read().revision });
  const saved = h.data(), dom = new JSDOM('<main id="root"></main>', { runScripts: 'outside-only', url: 'http://127.0.0.1/wikiskill.html#impact' });
  t.after(() => dom.window.close()); dom.window.TextEncoder = TextEncoder; dom.window.matchMedia = () => ({ matches: false });
  dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  for (const file of ['badcase-pipeline', 'badcase-wiki']) dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/' + file + '.js'), 'utf8'));
  const root = dom.window.document.querySelector('#root'), calls = [], panel = dom.window.CaffShared.createBadcaseWikiPanel({ root, fetchJson: async (url, o = {}) => { calls.push(o); return structuredClone(saved); } });
  await panel.load();
  for (const selector of ['.comparison-review', '#impact-log']) assert.ok(root.querySelector(selector).textContent.includes(label), selector + ': ' + label);
  root.querySelector('[data-tab="targets"]').click(); await tick(); await tick();
  assert.ok(root.querySelector('.cand-foot').textContent.includes(label), 'candidate: ' + label);
  assert.equal(root.querySelector('#view-impact form, #view-impact script, [data-adopt]'), null);
  assert.doesNotMatch(root.querySelector('#view-impact').textContent, /test_not_passed|测试未通过/); assert.equal(calls.filter(c => c.method === 'POST').length, 0);
});
test('candidate confirmation describes v4 gate and validation, not a separate test stage', async t => {
  const h = await setup(t); await h.panel.load(); await h.click('[data-tab="targets"]');
  const text = h.root.querySelector('.cand-foot').textContent;
  assert.match(text, /门槛每题每版 10 次.*门槛通过后才跑.*验证.*每题每版 5 次.*未覆盖不等于验证通过/s);
  assert.doesNotMatch(text, /才跑测试|不跑测试/); h.readonly();
});
test('v4 progress supports validation repeats and stages rather than falling through to single-case or old test UI', async t => {
  const h = await setup(t, { scenario: 'degraded' }), r = h.result;
  h.saved.executions = [{ id: 'batch-execution-ui', status: 'completed', updatedAt: new Date().toISOString(), reason: 'wiki_validation_prior_degradation',
    plan: { kind: r.kind, model: r.model, modelConfig: r.modelConfig, variants: ['original', 'candidate'], scoringKind: 'wiki-score-v2', validationRepeats: 5, cases: [] },
    current: { sourceCaseId: r.cases.at(-1).sourceCaseId, stage: 'validation', variant: 'candidate', iteration: 1 }, gateOutcome: 'accepted',
    summary: { plannedRuns: 60, completedRuns: 50, knownTokens: null, usageComplete: false, byStage: r.byStage }, cases: r.cases }];
  await h.panel.load(); await h.click('[data-tab="impact"]'); const text = h.root.querySelector('#execution-progress').textContent;
  assert.match(text, /正式批量.*门槛（本模式）.*验证（其他模式对照题）/s); assert.match(text, /验证每题每版 5 次/);
  assert.match(text, /已有劣化而停止/); assert.doesNotMatch(text, /测试|字面对照观察/); assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
});
test('Badcase mode6 shows both holdout groups in gate and missing other-mode controls as coverage, not as a gate blocker', async t => {
  const h = await setup(t, { scenario: 'uncovered' }); await h.panel.load(); await h.click('[data-tab="badcases"]');
  await h.click('[data-bc-pattern="entry-6"]');
  const gate = h.root.querySelector('[data-holdout-stage="gate"]'), validation = h.root.querySelector('[data-holdout-stage="validation"]');
  assert.match(gate.textContent, /门槛（本模式）.*#23.*#24/s); assert.doesNotMatch(gate.textContent, /#22/);
  assert.match(validation.textContent, /验证（其他模式对照题）.*模式1.*未覆盖.*模式2.*未覆盖/s);
  assert.match(validation.textContent, /未覆盖不等于验证通过/);
  assert.match(h.root.querySelector('[data-board-readiness]').textContent, /有可用本模式留出目标题/);
  assert.doesNotMatch(h.root.querySelector('[data-grouping]').textContent, /run 不超过 trace|测试只收 trace|缺可用 trace 测试题/);
  h.readonly();
});
