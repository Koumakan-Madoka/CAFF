// Production-shaped frozen records; all precheck outputs are synthetic. No
// provider, judge, replay, HTTP listener or production directory is used.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const base = '../../build/server/domain/runtime/badcase-capture/';
const clone = v => JSON.parse(JSON.stringify(v)), tick = () => new Promise(r => setImmediate(r));
function fixture(t, config = {}) {
  const real = require('../helpers/wiki-gate-control.cjs')(t, config);
  const snapshot = () => {
    const s = real.store.read();
    s.casePatterns = require(base + 'wiki-initial-split').projectWikiPatternLabels(s);
    s.pipelineStates = require(base + 'wiki-pipeline').projectWikiPipelineStates({ state: s,
      originalPrechecks: real.records.list(), replayChecks: require(base + 'wiki-pipeline-prechecks').readWikiPipelineInputs(s, real.cache) });
    s.cases[0].n = s.cases[0].displayNumber = 22; // Display fields are added AFTER pure binding projection, as in HTTP.
    s.replayCases = s.replayCases.map(r => ({ ...r, task: 'Synthetic scene task', category: 'control', split: s.cases[0].split, fixture: { commit: 'a'.repeat(40) } }));
    s.caseStates = real.store.getCaseStates(); s.comparisons = []; s.runReplays = [];
    s.targets = require(base + 'wiki-targets').listWikiTargets();
    return s;
  };
  return { ...real, snapshot };
}
function setup(t, data, { full = false, onConfirmControl, handler } = {}) {
  const dom = new JSDOM('<section id="root"></section>', { runScripts: 'outside-only', url: 'http://127.0.0.1/wikiskill.html#bc-22' });
  t.after(() => dom.window.close()); dom.window.HTMLElement.prototype.scrollIntoView = function() {}; dom.window.TextEncoder = TextEncoder;
  dom.window.matchMedia = () => ({ matches: false });
  const root = dom.window.document.querySelector('#root'), calls = [];
  dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/badcase-pipeline.js'), 'utf8'));
  const fetchJson = async (url, options = {}) => { calls.push({ url, ...options }); return handler ? handler(url, options) : clone(data); };
  let panel;
  if (full) {
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/badcase-wiki.js'), 'utf8'));
    panel = dom.window.CaffShared.createBadcaseWikiPanel({ root, fetchJson, confirm() { throw Error('no browser dialog'); } });
  } else {
    panel = dom.window.CaffShared.createBadcasePipeline({ root, fetchJson, onConfirmControl, confirm() { throw Error('no browser dialog'); } });
    panel.render(data); panel.focus(22);
  }
  return { root, panel, calls, window: dom.window, card: () => root.querySelector('[data-case-id]'),
    click: async selector => { const el = root.querySelector(selector); assert.ok(el, selector); el.click(); await tick(); await tick(); } };
}
test('precheck approximation disclosure uses recorded markers only, preserving absent and unseeded history', t => {
  const real = fixture(t), data = real.snapshot(), p = data.pipelineStates[0].precheck;
  const h = setup(t, data); assert.equal(h.root.querySelector('[data-goal-approximation]'), null);
  p.current.goalExecutions = [{ iteration: 1, goalState: 'approximate-minimal-v1', goalSeedHash: 'e'.repeat(64), goalExecutionId: '00000000-0000-4000-8000-000000000001' }];
  p.history[0].goalExecutions = clone(p.current.goalExecutions); h.panel.render(data);
  assert.match(h.root.querySelector('[data-goal-approximation]').textContent, /Goal 状态近似.*最小.*不还原历史.*不同回放条件/s);
  assert.ok(h.root.querySelector('[data-original-precheck]').textContent.includes('e'.repeat(64)));
  p.current.goalExecutions[0].goalState = 'unseeded'; p.history[0].goalExecutions = clone(p.current.goalExecutions); h.panel.render(data);
  assert.equal(h.root.querySelector('[data-goal-approximation]'), null); assert.match(h.root.textContent, /未播种 Goal/);
  assert.equal(h.calls.length, 0);
});
for (const stale of [false, true]) test(`saved ${stale ? 'stale' : 'current'} control makes case assertions read-only without paid draft controls`, async t => {
  const real = fixture(t); real.confirm(); const data = real.snapshot();
  if (stale) data.pipelineStates[0].control.status = 'stale';
  const h = setup(t, data, { full: true }); await h.panel.load(); await h.click('[data-tab="cases"]');
  const panel = h.root.querySelector('[data-rubric-panel]'); assert.ok(panel);
  assert.match(panel.textContent, /已冻结为对照.*不能修改/s);
  assert.equal(panel.querySelector('[data-edit-rubric],[data-draft-rubric],[data-save-rubric],[data-freeze-rubric],textarea'), null);
  assert.match(panel.textContent, /suggest-goal.*reason.*1000/s);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
});
test('formal result page and per-run detail label recorded Goal approximation, never invent it for old runs', async t => {
  const real = fixture(t), data = real.snapshot(), run = { iteration: 1, variant: 'original', status: 'fail', assessment: null,
    goalState: 'approximate-minimal-v1', goalSeedHash: 'f'.repeat(64), goalExecutionId: '00000000-0000-4000-8000-000000000001' };
  data.comparisons = [{ id: 'synthetic-comparison', kind: 'wiki-staged-batch-comparison-v2', createdAt: '2026-11-10T00:00:00.000Z', completed: true, model: 'openai-codex/gpt-6.1-sol', modelCallsKnown: 1,
    evaluation: { splitPolicy: 'd15-frozen-v1' }, cases: [{ sourceCaseId: real.c.id, stage: 'gate', split: 'gate', category: 'control', rubric: data.rubrics[0], runs: [run] }] }];
  const bytes = JSON.stringify(data.comparisons), h = setup(t, data, { full: true }); await h.panel.load(); await h.click('[data-tab="impact"]');
  assert.match(h.root.querySelector('#impact-runs > [data-goal-approximation]').textContent, /Goal 状态近似.*不同回放条件/s);
  assert.ok(h.root.querySelector('.assertion-run [data-goal-approximation]').textContent.includes(run.goalSeedHash));
  assert.equal(JSON.stringify(data.comparisons), bytes);
  delete run.goalState; delete run.goalSeedHash; delete run.goalExecutionId;
  await h.panel.load(); await h.click('[data-tab="impact"]'); assert.equal(h.root.querySelector('[data-goal-approximation]'), null);
});
test('current independent precheck shows counts, configured strict threshold and provenance without formal results or launch controls', t => {
  const real = fixture(t, { statuses: ['pass', 'fail', 'invalid', 'error'], policy: { repeats: 4, failureThreshold: .4 } }), data = real.snapshot(), h = setup(t, data);
  const box = h.root.querySelector('[data-original-precheck]'); assert.ok(box);
  assert.match(box.textContent, /通过 1.*失败 1.*无效 1.*错误 1/s);
  assert.match(box.textContent, /失败比例 50%.*严格超过 40%/s); assert.match(box.textContent, /已复现/);
  assert.match(box.textContent, /不进入正式门槛或测试统计.*无效和错误不进分母/s);
  assert.match(box.textContent, /v1/); assert.ok(box.textContent.includes(data.pipelineStates[0].precheck.current.rubricHash));
  assert.equal(h.card().querySelector('.stepper').children[7].className, 'done');
  assert.equal(h.root.querySelector('[data-start-replay],[data-run-precheck],[data-start-precheck]'), null);
  assert.equal(h.calls.length, 0);
});
test('old formal majority never lights the precheck step; missing/stopped latest prechecks do not fallback to older success', t => {
  const real = fixture(t), data = real.snapshot(), row = data.pipelineStates[0];
  row.original = { valid: 10, pass: 0, fail: 10, reproduced: true, invalid: 0, errors: 0, unscored: 0 };
  row.inLibrary = false; row.control = { status: 'ineligible', eligible: false };
  const history = clone(row.precheck.history); row.precheck = { status: 'missing', current: null, history: [], reproduced: false };
  const h = setup(t, data); assert.notEqual(h.card().querySelector('.stepper').children[7].className, 'done');
  assert.match(h.card().textContent, /尚无.*原版预检/);
  row.precheck = { status: 'stopped', reproduced: false, current: { ...history[0], id: 'stopped-new', status: 'stopped', reason: 'usage_unknown', summary: { ...history[0].summary, attempted: 1, valid: 1, pass: 0, fail: 1, complete: false, reproduced: false } }, history };
  h.panel.render(data); assert.match(h.root.querySelector('[data-original-precheck]').textContent, /已停止.*用量不明/s);
  assert.match(h.root.querySelector('[data-original-precheck]').textContent, /未复现|不能.*入库/);
  assert.notEqual(h.card().querySelector('.stepper').children[7].className, 'done'); assert.equal(h.calls.length, 0);
});
test('history retains each version and report scope without pooling or calling stale data current', t => {
  const real = fixture(t), data = real.snapshot(), row = data.pipelineStates[0];
  row.precheck.history.push({ ...clone(row.precheck.history[0]), id: 'old-version', rubricVersion: 2, rubricHash: 'e'.repeat(64), current: false, reportOnly: true });
  const h = setup(t, data), history = h.root.querySelector('[data-precheck-history]'); assert.ok(history);
  assert.equal(history.querySelectorAll('[data-precheck-record]').length, 2);
  assert.match(history.textContent, /v2.*仅切点报告.*不作准入/s);
  assert.match(history.textContent, /各批次独立.*不拼接/s); assert.equal(h.calls.length, 0);
});
test('control is exact in-panel consent, not browser confirmation or execution; refresh and binding changes invalidate it', t => {
  const real = fixture(t), data = real.snapshot(), sent = [], h = setup(t, data, { onConfirmControl: b => sent.push(clone(b)) });
  const host = () => h.root.querySelector('[data-gate-control]'); assert.match(host().textContent, /可作对照/);
  host().querySelector('[data-control-confirm]').click(); assert.equal(sent.length, 0);
  const strip = host().querySelector('[data-control-consent]'); assert.ok(strip);
  assert.match(strip.textContent, /门槛组.*其他模式.*防误伤.*冻结.*不能修改.*不启动/s);
  assert.ok(strip.textContent.includes(data.pipelineStates[0].control.proposalHash));
  assert.match(strip.textContent, /通过 3.*suggest-goal.*reason.*1000/s);
  const stale = host().querySelector('[data-control-lock]'); h.panel.render(data);
  assert.equal(host().querySelector('[data-control-lock]'), null); stale.click(); assert.equal(sent.length, 0);
  host().querySelector('[data-control-confirm]').click(); data.pipelineStates[0].control.proposalHash = 'f'.repeat(64); h.panel.render(data);
  assert.equal(host().querySelector('[data-control-consent]'), null);
  host().querySelector('[data-control-confirm]').click(); host().querySelector('[data-control-lock]').click();
  assert.deepEqual(sent, [{ caseId: real.c.id, proposalHash: 'f'.repeat(64) }]); assert.equal(h.calls.length, 0);
});
test('read-only, ineligible and already-frozen/stale controls never offer a writable confirmation', t => {
  const real = fixture(t), data = real.snapshot(), sent = [], h = setup(t, data, { onConfirmControl: b => sent.push(b) });
  const host = () => h.root.querySelector('[data-gate-control]'); host().querySelector('[data-control-confirm]').click();
  h.panel.setWritable(false); assert.equal(host().querySelector('[data-control-lock]'), null);
  assert.equal(host().querySelector('[data-control-confirm]').disabled, true); h.panel.setWritable(true);
  assert.equal(host().querySelector('[data-control-lock]'), null, 'read-only transition cannot revive earlier consent');
  for (const status of ['ineligible', 'confirmed', 'stale']) {
    data.pipelineStates[0].control = { ...data.pipelineStates[0].control, status, confirmed: status === 'confirmed', eligible: status !== 'ineligible' };
    h.panel.render(data); assert.equal(host().querySelector('[data-control-confirm],[data-control-lock]'), null);
    assert.match(host().textContent, new RegExp({ ineligible: '暂不可作对照', confirmed: '已冻结为对照', stale: '确认已失效.*不能重新确认' }[status]));
  }
  assert.equal(sent.length, 0);
});
test('cancel, local content drift and hostile display strings cannot submit old consent or render HTML', t => {
  const real = fixture(t), data = real.snapshot(), sent = [], h = setup(t, data, { onConfirmControl: b => sent.push(b) });
  const host = () => h.root.querySelector('[data-gate-control]');
  host().querySelector('[data-control-confirm]').click(); host().querySelector('[data-control-cancel]').click();
  assert.equal(host().querySelector('[data-control-lock]'), null);
  host().querySelector('[data-control-confirm]').click(); data.cases[0].expected = '<script>changed</script>';
  host().querySelector('[data-control-lock]').click(); assert.equal(sent.length, 0); assert.equal(host().querySelector('[data-control-lock]'), null);
  const history = data.pipelineStates[0].precheck.history[0]; history.id = '<img src=x onerror=bad()>that-id';
  history.reason = '<script>unsafe</script>'; data.pipelineStates[0].precheck.current.reason = history.reason;
  data.pipelineStates[0].control.binding.pattern.entryId = '<b>unsafe-name</b>'; h.panel.render(data);
  host().querySelector('[data-control-confirm]').click();
  assert.equal(h.root.querySelector('script,img,[data-control-consent] b b'), null);
  assert.ok(h.root.querySelector('[data-precheck-history]').textContent.includes(history.id));
  assert.ok(host().querySelector('[data-control-consent]').textContent.includes('<b>unsafe-name</b>'));
  assert.equal(sent.length, 0); assert.equal(h.calls.length, 0);
});
test('full panel sends revision/hash protected control confirmation and re-GETs complete state, ignoring partial POST state', async t => {
  const real = fixture(t); let current = real.snapshot();
  const h = setup(t, current, { full: true, handler: (url, options) => {
    if (options.method === 'POST') { assert.equal(url, '/api/wikiskill/control-confirm'); real.confirm({ expectedRevision: options.body.expectedRevision, proposalHash: options.body.proposalHash }); current = real.snapshot(); return { partialPostResponse: true }; }
    return clone(current);
  } });
  await h.panel.load(); await h.click('[data-tab="badcases"]');
  await h.click('[data-control-confirm]'); assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  const revision = current.revision, hash = current.pipelineStates[0].control.proposalHash;
  await h.click('[data-control-lock]'); const post = h.calls.find(c => c.method === 'POST'); assert.ok(post);
  assert.deepEqual(clone(post.body), { confirmed: true, expectedRevision: revision, caseId: real.c.id, proposalHash: hash });
  assert.equal(h.calls[h.calls.indexOf(post) + 1].url, '/api/wikiskill');
  assert.match(h.root.querySelector('[data-gate-control]').textContent, /已冻结为对照/);
  assert.equal(h.root.querySelector('[data-control-confirm]'), null);
});
test('failed/unknown confirmation locks all actions with no automatic retry', async t => {
  const real = fixture(t), h = setup(t, real.snapshot(), { full: true, handler: (url, options) => { if (options.method === 'POST') throw Error('unknown'); return clone(real.snapshot()); } });
  await h.panel.load(); await h.click('[data-tab="badcases"]'); await h.click('[data-control-confirm]'); await h.click('[data-control-lock]');
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1); assert.equal(h.root.querySelector('[data-control-confirm]').disabled, true);
  assert.equal(h.root.querySelector('[data-control-lock]'), null); assert.match(h.root.querySelector('#toast').textContent, /结果未知.*未自动重试/);
});
