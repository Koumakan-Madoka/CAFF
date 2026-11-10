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
test('mode overview requires a current confirmed other-mode control, never another reproduction or favorable unconfirmed precheck', t => {
  const real = fixture(t), data = real.snapshot(), source = data.cases[0], row = data.pipelineStates[0];
  data.cases = [{ ...source, id: 'target-gate', n: 23 }, { ...source, id: 'target-test', n: 24, split: 'test' }, source];
  const options = [{ entryId: 'mode-6', title: '目标模式' }, { entryId: 'mode-1', title: '其他模式' }];
  data.casePatterns = data.cases.map((c, i) => ({ caseId: c.id, confirmed: true, entryId: i === 2 ? 'mode-1' : 'mode-6', patternKey: i === 2 ? 'mode-1' : 'mode-6', options }));
  data.pipelineStates = data.cases.map((c, i) => ({ ...clone(row), caseId: c.id, inLibrary: true, precheck: { ...clone(row.precheck), reproduced: i !== 2 } }));
  const h = setup(t, data); h.root.querySelector('[data-bc-pattern="mode-6"]').click();
  const board = () => h.root.querySelector('[data-board-readiness]').textContent;
  const external = data.pipelineStates[2];
  for (const value of [{ status: 'ineligible', confirmed: false }, { status: 'eligible', confirmed: false }, { status: 'stale', confirmed: false }, null]) {
    external.control = value; h.panel.render(data); assert.match(board(), /尚不能.*已确认.*对照/);
    h.root.querySelector('[data-bc-pattern="all"]').click();
    assert.match(h.root.querySelector('[data-pattern-overview] tbody tr').textContent, /尚不能.*已确认.*对照/);
    h.root.querySelector('[data-bc-pattern="mode-6"]').click();
  }
  external.control = { status: 'confirmed', confirmed: true }; h.panel.render(data); assert.match(board(), /^有可用门槛、测试.*已确认/);
  const oldSplit = source.split; source.split = 'test'; h.panel.render(data); assert.match(board(), /尚不能/); source.split = oldSplit;
  external.inLibrary = false; h.panel.render(data); assert.match(board(), /尚不能/); external.inLibrary = true;
  // A control cannot also stand in as the target mode's reproduction.
  data.pipelineStates[0].precheck.reproduced = false; h.panel.render(data); assert.match(board(), /尚不能.*可用门槛题/);
  assert.equal(h.calls.length, 0);
});
test('run independent precheck can reach library without any legacy raw output; assertions precede precheck in the funnel', t => {
  const real = require('../helpers/wiki-scene-run.cjs')(t, { scene: false }), data = real.store.read();
  data.cases[0].split = 'gate'; // Historical grouped case, before creating/hash-binding the precheck.
  const cache = require(base + 'wiki-pipeline-prechecks').createWikiPipelinePrecheckStore(real.scope);
  cache.getOrCompute({ level: 'run', traceHash: real.item().traceBundle.hash, decisionHash: real.decision.hash }, () => ({ status: 'supported', cutStep: 29 }));
  const replayChecks = require(base + 'wiki-pipeline-prechecks').readWikiPipelineInputs(data, cache);
  const plan = require(base + 'wiki-original-precheck').createWikiOriginalPrecheckPlan({ state: data, caseId: real.c.id, rubricHash: real.rubric.hash, inputHash: 'd'.repeat(64), replayChecks });
  const records = require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(real.scope), r = records.reserve(plan);
  records.finish(r.id, { status: 'completed', reason: null, runs: Array.from({ length: 5 }, (_, i) => ({ iteration: i + 1, variant: 'original', status: 'fail', artifactId: 'synthetic-' + i, artifactHash: 'e'.repeat(64), usageComplete: true })) });
  data.pipelineStates = require(base + 'wiki-pipeline').projectWikiPipelineStates({ state: data, originalPrechecks: records.list(), replayChecks });
  data.cases[0].n = 22; data.casePatterns = require(base + 'wiki-initial-split').projectWikiPatternLabels(data);
  data.casePatterns[0] = { ...data.casePatterns[0], confirmed: true, entryId: null }; // Display-only historical confirmed identity.
  assert.equal(data.pipelineStates[0].inLibrary, true);
  const h = setup(t, data); assert.equal(data.pipelineStates[0].original.outputs, 0);
  assert.match(h.card().querySelector('.next-line').textContent, /测试用例.*等待候选/);
  const steps = [...h.root.querySelectorAll('[data-lane="run"] .f-step')];
  assert.match(steps[2].textContent, /检查已冻结/); assert.match(steps[3].textContent, /原版预检/); assert.equal(steps[3].querySelector('b').textContent, '1');
  assert.equal(h.calls.length, 0);
});
test('precheck approximation disclosure uses recorded markers only, preserving absent and unseeded history', t => {
  const real = fixture(t), data = real.snapshot(), p = data.pipelineStates[0].precheck;
  const h = setup(t, data); assert.equal(h.root.querySelector('[data-goal-approximation]'), null);
  p.current.goalExecutions = [{ iteration: 1, goalState: 'approximate-minimal-v1', goalSeedHash: 'e'.repeat(64), goalExecutionId: '00000000-0000-4000-8000-000000000001' }];
  p.history[0].goalExecutions = clone(p.current.goalExecutions); h.panel.render(data);
  assert.match(h.root.querySelector('[data-goal-approximation]').textContent, /Goal 状态近似.*最小.*不还原历史.*不可直接比较/s);
  assert.ok(h.root.querySelector('[data-original-precheck]').textContent.includes('e'.repeat(64)));
  p.current.goalExecutions[0].goalState = 'unseeded'; p.history[0].goalExecutions = clone(p.current.goalExecutions); h.panel.render(data);
  assert.equal(h.root.querySelector('[data-goal-approximation]'), null); assert.match(h.root.textContent, /未播种 Goal/);
  assert.equal(h.calls.length, 0);
});
for (const stale of [false, true]) test(`saved ${stale ? 'stale' : 'current'} control is not advertised as its own mode target`, t => {
  const real = fixture(t); real.confirm(); const data = real.snapshot();
  if (stale) { data.pipelineStates[0].control.status = 'stale'; data.pipelineStates[0].control.confirmed = false; }
  data.casePatterns[0] = { ...data.casePatterns[0], entryId: 'mode-1', patternKey: 'mode-1', options: [{ entryId: 'mode-1', title: '原归属模式' }] };
  data.pendingPatternLinks = [{ entryId: 'mode-1' }];
  const h = setup(t, data), role = h.root.querySelector('[data-pattern-role]');
  assert.match(role.textContent, stale ? /对照确认已失效/ : /其他模式.*防误伤对照/);
  assert.doesNotMatch(role.textContent, /时算目标复现题/);
  assert.match(h.root.querySelector('[data-pattern-targets]').textContent, /门槛目标复现题：无/);
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
test('precheck Goal approximation is one counted line with exact per-execution evidence in closed details', t => {
  const real = fixture(t, { statuses: ['pass', 'pass', 'pass', 'pass'], policy: { repeats: 4 } }), data = real.snapshot(), p = data.pipelineStates[0].precheck;
  p.current.goalExecutions = Array.from({ length: 4 }, (_, i) => ({ iteration: i + 1, goalState: 'approximate-minimal-v1', goalSeedHash: String(i + 1).repeat(64), goalExecutionId: 'synthetic-' + i }));
  p.history[0].goalExecutions = clone(p.current.goalExecutions);
  const before = JSON.stringify(data), h = setup(t, data), box = h.root.querySelector('[data-original-precheck]');
  const note = box.querySelector(':scope > [data-goal-approximation]'); assert.ok(note);
  assert.match(note.textContent, /^4 次均为 Goal 状态近似.*独立最小种子.*不还原历史 Goal.*不可直接比较/);
  const details = box.querySelector(':scope > [data-goal-details]'); assert.ok(details); assert.equal(details.open, false);
  assert.equal(details.querySelectorAll('[data-goal-execution]').length, 4);
  for (const row of p.current.goalExecutions) { assert.ok(details.textContent.includes(row.goalSeedHash)); assert.ok(details.textContent.includes(row.goalExecutionId)); assert.ok(!note.textContent.includes(row.goalSeedHash)); }
  assert.equal((box.textContent.match(/不还原历史 Goal/g) || []).length, 2, 'one summary for current and one for collapsed history, not one per execution');
  assert.equal(JSON.stringify(data), before); assert.equal(h.calls.length, 0);
});
test('Goal summary counts only recorded approximations and keeps unseeded and unmarked runs distinct with escaped details', t => {
  const real = fixture(t), data = real.snapshot(), p = data.pipelineStates[0].precheck;
  p.current.goalExecutions = [
    { iteration: 1, goalState: 'approximate-minimal-v1', goalSeedHash: 'a'.repeat(64), goalExecutionId: '<img src=x onerror=bad()>' },
    { iteration: 2, goalState: 'unseeded', goalSeedHash: 'b'.repeat(64), goalExecutionId: 'unseeded-execution' },
    { iteration: 3 },
  ];
  const h = setup(t, data), box = h.root.querySelector('[data-original-precheck]');
  assert.match(box.querySelector(':scope > [data-goal-approximation]').textContent, /^1 次为 Goal 状态近似/);
  assert.doesNotMatch(box.querySelector(':scope > [data-goal-approximation]').textContent, /均为/);
  assert.match(box.querySelector(':scope > [data-goal-unseeded]').textContent, /1 次.*未播种 Goal/);
  assert.equal(box.querySelectorAll(':scope > [data-goal-details] [data-goal-execution]').length, 2);
  assert.ok(box.querySelector('[data-goal-details]').textContent.includes('<img src=x onerror=bad()>')); assert.equal(h.root.querySelector('img'), null);
  assert.equal(h.calls.length, 0);
});
test('precheck sparse marker projection never claims every attempt was approximate', t => {
  const real = fixture(t), data = real.snapshot(), p = data.pipelineStates[0].precheck;
  assert.equal(p.current.summary.attempted, 3);
  p.current.goalExecutions = [{ iteration: 2, goalState: 'approximate-minimal-v1', goalSeedHash: 'a'.repeat(64), goalExecutionId: 'synthetic-marked' }];
  const h = setup(t, data), note = h.root.querySelector('[data-original-precheck] > [data-goal-approximation]');
  assert.match(note.textContent, /^1 次为 Goal 状态近似/); assert.doesNotMatch(note.textContent, /均为/); assert.equal(h.calls.length, 0);
});
test('formal result page and per-run detail label recorded Goal approximation, never invent it for old runs', async t => {
  const real = fixture(t), data = real.snapshot(), run = { iteration: 1, variant: 'original', status: 'fail', assessment: null,
    goalState: 'approximate-minimal-v1', goalSeedHash: 'f'.repeat(64), goalExecutionId: '00000000-0000-4000-8000-000000000001' };
  data.comparisons = [{ id: 'synthetic-comparison', kind: 'wiki-staged-batch-comparison-v2', createdAt: '2026-11-10T00:00:00.000Z', completed: true, model: 'openai-codex/gpt-6.1-sol', modelCallsKnown: 1,
    evaluation: { splitPolicy: 'd15-frozen-v1' }, cases: [{ sourceCaseId: real.c.id, stage: 'gate', split: 'gate', category: 'control', rubric: data.rubrics[0], runs: [run] }] }];
  const bytes = JSON.stringify(data.comparisons), h = setup(t, data, { full: true }); await h.panel.load(); await h.click('[data-tab="impact"]');
  assert.match(h.root.querySelector('#impact-runs > [data-goal-approximation]').textContent, /1 次均为 Goal 状态近似.*不可直接比较/s);
  assert.ok(h.root.querySelector('.assertion-run [data-goal-details]').textContent.includes(run.goalSeedHash));
  assert.equal(h.root.querySelector('#impact-runs > [data-goal-details]').open, false);
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
test('frozen preview content drift invalidates pending control consent even if its displayed hash was not updated', t => {
  const real = fixture(t), data = real.snapshot(), sent = [], h = setup(t, data, { onConfirmControl: b => sent.push(b) });
  h.root.querySelector('[data-control-confirm]').click();
  data.rubrics.find(r => r.status === 'frozen').toolCheck.rules[0].max = 999;
  h.root.querySelector('[data-control-lock]').click();
  assert.equal(sent.length, 0); assert.equal(h.root.querySelector('[data-control-lock]'), null);
});
test('control consent uses the editor plain-language preview while exact JSON and bound hashes remain unchanged', async t => {
  const real = fixture(t), data = real.snapshot(), before = JSON.stringify(data), h = setup(t, data, { full: true });
  await h.panel.load(); await h.click('[data-tab="cases"]');
  const toolPreview = [...h.root.querySelectorAll('.rubric-version .rubric-checks section')].find(el => el.textContent.includes('工具调用检查')).querySelector('p').textContent;
  await h.click('[data-tab="badcases"]'); await h.click('[data-control-confirm]');
  const strip = h.root.querySelector('[data-control-consent]'), preview = strip.querySelector('[data-control-check-preview]'); assert.ok(preview);
  assert.ok(preview.textContent.includes(toolPreview)); assert.match(preview.textContent, /调用时参数要对：suggest-goal，reason.*1000/s);
  assert.equal(preview.closest('details'), null, 'plain-language checks are visible before confirmation');
  assert.equal(preview.querySelector('pre'), null);
  const details = strip.querySelector('[data-control-check-json]'); assert.ok(details); assert.equal(details.open, false);
  const r = data.rubrics.find(r => r.status === 'frozen');
  assert.deepEqual(JSON.parse(details.querySelector('pre').textContent), { questions: r.questions, toolCheck: r.toolCheck, scoringModel: r.scoringModel });
  assert.ok(strip.textContent.includes(data.pipelineStates[0].control.proposalHash)); assert.ok(strip.textContent.includes(r.hash));
  assert.equal(JSON.stringify(data), before); assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
});
test('control preview includes every AI question, evidence and model and escapes untrusted text', t => {
  const real = fixture(t), data = real.snapshot(), r = data.rubrics.find(r => r.status === 'frozen');
  r.questions = [{ id: 'q1', question: '<script>公开回复说明结果</script>', evidence: 'reply' }, { id: 'q2', question: '轨迹保留调用', evidence: 'trace' }];
  r.scoringModel = { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' };
  r.toolCheck = { method: 'code', target: { kind: 'native', name: 'read' }, mode: 'forbid', rules: [{ parameter: 'path', kind: 'forbidden-values', values: ['<img src=x onerror=bad()>'] }, { parameter: 'offset', kind: 'allowed-values', values: ['1'] }] };
  const before = JSON.stringify(data), h = setup(t, data, { onConfirmControl() { throw Error('preview must not submit'); } }); h.root.querySelector('[data-control-confirm]').click();
  const preview = h.root.querySelector('[data-control-check-preview]'); assert.ok(preview);
  assert.match(preview.textContent, /公开回复说明结果.*公开回复.*轨迹保留调用.*轨迹.*deepseek\/deepseek-v4-flash/s);
  assert.match(preview.textContent, /不该这样调用：read.*path 不得取.*offset 只能取/s);
  assert.ok(preview.textContent.includes(r.questions[0].question)); assert.equal(h.root.querySelector('script,img'), null);
  assert.equal(JSON.stringify(data), before); assert.equal(h.calls.length, 0);
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
