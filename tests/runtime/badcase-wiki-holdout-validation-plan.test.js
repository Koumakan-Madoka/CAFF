const test = require('node:test'), assert = require('node:assert/strict');
const base = '../../build/server/domain/runtime/badcase-capture/';
const api = () => require(base + 'wiki-holdout-validation-plan');
const gateApi = require(base + 'wiki-holdout-plan');
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
const fixture = require('../helpers/wiki-holdout-full-plan.cjs');
const gateFixture = require('../helpers/wiki-holdout-plan.cjs');
const rehash = p => { const { planHash, ...payload } = p; p.planHash = hash(payload); return p; };
const runs = (repeats, original, candidate) => Array.from({ length: repeats }, (_, i) => ['original', 'candidate'].map(variant => ({ variant, iteration: i + 1,
  status: i < (variant === 'original' ? original : candidate) ? 'pass' : 'fail' }))).flat();
const rows = p => p.cases.map(c => ({ caseId: c.caseId, status: 'completed', runs: runs(c.stage === 'gate' ? 10 : p.validation.policy.repeats,
  c.stage === 'gate' ? 0 : p.validation.policy.repeats, c.stage === 'gate' ? 6 : p.validation.policy.repeats) }));
const gateRows = p => rows(p).filter(r => p.gate.caseIds.includes(r.caseId));
test('full immutable v4 plan binds gate plus one other-mode control with no separate test stage or run/trace quota', () => {
  const h = fixture(), before = JSON.stringify(h.current()), p = h.fullPlan();
  assert.equal(p.kind, 'wiki-experiment-plan-v4'); assert.deepEqual(p.gate, h.gate); assert.deepEqual(p.validation, h.selection);
  assert.deepEqual(p.cases.map(c => c.caseId), [...p.gate.caseIds, ...p.validation.caseIds]);
  assert.deepEqual(p.cases.map(c => c.stage), ['gate', 'gate', 'validation']);
  const c = p.cases.at(-1); assert.equal(c.caseId, h.marked[1].id); assert.equal(c.entryId, 'entry-1');
  assert.equal(c.category, 'control'); assert.equal(c.targetReproduction, false); assert.equal(c.execution.level, 'run');
  assert.equal(c.rubricHash, p.validation.cases[0].precheck.rubricHash); assert.equal(c.judge, null);
  assert.deepEqual(api().validateWikiHoldoutFullExperimentPlan(JSON.parse(JSON.stringify(p))), p);
  api().assertWikiHoldoutFullExperimentPlan(p, h.definition, h.catalog, h.current());
  assert.equal(JSON.stringify(h.current()), before); assert.equal(p.repeats, 10); assert.equal(p.validation.policy.repeats, 5);
});
test('old gate-only v4 remains unchanged and its strict reader/executor refuses full plans until explicitly integrated', () => {
  const full = fixture().fullPlan(), h = gateFixture(), p = h.plan(), before = JSON.stringify(p);
  api().validateWikiHoldoutFullExperimentPlan(full);
  assert.throws(() => gateApi.validateWikiHoldoutExperimentPlan(full));
  assert.throws(() => api().validateWikiHoldoutFullExperimentPlan(p));
  assert.equal(JSON.stringify(gateApi.validateWikiHoldoutExperimentPlan(p)), before);
  assert.deepEqual(h.plan(), p);
});
test('no confirmed controls produces honest uncovered coverage and no invented execution cases', () => {
  const h = fixture(); h.state.controlConfirmations = []; h.selection = h.select(); h.addControls();
  const p = h.fullPlan(), d = api().decideWikiHoldoutFullExperiment(p, rows(p));
  assert.deepEqual(p.cases.map(c => c.stage), ['gate', 'gate']); assert.equal(d.outcome, 'validation-uncovered');
  assert.equal(d.adoptionEligible, true); assert.deepEqual(d.validation.uncovered.map(c => c.entryId), ['entry-1', 'entry-2']);
});
test('full coverage reports validation-passed and a run-only gate plus run-only controls needs no trace quota', () => {
  const h = fixture(); h.state.versions[0].entries = h.state.versions[0].entries.filter(e => e.id !== 'entry-2');
  h.selection = h.select(); h.state.cases.find(c => c.id === h.marked[6].id).split = 'train';
  const { state, records, replayChecks, targetEntryId } = h.current();
  h.gate = require(base + 'wiki-holdout-gate').planWikiHoldoutGate({ state, records, replayChecks, targetEntryId });
  const ids = [...h.gate.caseIds, ...h.selection.caseIds]; h.catalog = h.catalog.filter(c => ids.includes(c.id)); h.definition.cases = h.definition.cases.filter(c => ids.includes(c.caseId));
  const p = h.fullPlan(), d = api().decideWikiHoldoutFullExperiment(p, rows(p));
  assert.ok(p.cases.every(c => c.execution.level === 'run')); assert.equal(d.outcome, 'validation-passed'); assert.equal(d.adoptionEligible, true);
  assert.deepEqual(d.gate.warnings, ['只有 1 道门槛题']); assert.deepEqual(d.validation.uncovered, []);
  assert.equal(d.gate.byLevel.trace.original.total, 0); assert.equal(d.validation.byLevel.trace.original.total, 0);
});
test('a trace control retains structured-tool semantics rather than becoming a run or a target', () => {
  const h = fixture(); h.state.controlConfirmations = h.state.controlConfirmations.filter(c => c.caseId !== h.marked[1].id);
  h.selection = h.select(); h.addControls(); const p = h.fullPlan(), c = p.cases.at(-1);
  assert.equal(c.execution.level, 'trace'); assert.equal(c.traceToolCheck, 'structured-v1');
  const d = api().decideWikiHoldoutFullExperiment(p, rows(p));
  assert.equal(d.validation.byLevel.trace.original.total, 5); assert.equal(d.validation.byLevel.run.original.total, 0);
});
test('rejected or incomplete gate cannot accept any validation outputs', () => {
  const p = fixture().fullPlan();
  for (const incomplete of [false, true]) {
    const r = gateRows(p); r.forEach(c => c.runs = runs(10, 3, 3)); if (incomplete) r[0] = { caseId: r[0].caseId, status: 'not-run', runs: [] };
    const d = api().decideWikiHoldoutFullExperiment(p, r); assert.equal(d.adoptionEligible, false);
    assert.equal(d.outcome, incomplete ? 'indeterminate' : 'gate-rejected'); assert.equal(d.validation.status, 'not-run');
    assert.throws(() => api().decideWikiHoldoutFullExperiment(p, [...r, rows(p).at(-1)]));
  }
});
test('pooled gate and per-control validation decisions compose without compensation; 1 loss fluctuates, 2 degrades', () => {
  const p = fixture().fullPlan();
  for (const [loss, expected] of [[0, 'validation-partial-coverage'], [1, 'validation-partial-coverage'], [2, 'validation-degraded']]) {
    const r = rows(p); r.at(-1).runs = runs(5, 5, 5 - loss); const d = api().decideWikiHoldoutFullExperiment(p, r);
    assert.equal(d.gate.outcome, 'accepted'); assert.equal(d.outcome, expected); assert.equal(d.adoptionEligible, loss < 2);
  }
  const r = gateRows(p); assert.equal(api().decideWikiHoldoutFullExperiment(p, r).outcome, 'indeterminate');
});
test('validation policy, seeded selection, exact control/precheck and historical usage are bound into the full hash', () => {
  const h = fixture(), p = h.fullPlan();
  for (const patch of [{ repeats: 3, degradationThreshold: 1 }, { maxEstimatedTokens: 12345 }]) {
    h.policy = patch; h.selection = h.select(); assert.notEqual(h.fullPlan().planHash, p.planHash);
  }
  h.policy = undefined; h.history.find(c => c.caseId === h.selection.caseIds[0]).totalTokens++;
  h.selection = h.select(); assert.notEqual(h.fullPlan().planHash, p.planHash);
});
test('unknown or over-limit usage can be retained for operator inspection but cannot yield validation or adoption', () => {
  for (const unknown of [false, true]) {
    const h = fixture(); if (unknown) h.history = []; else h.policy = { maxEstimatedTokens: 1 };
    h.selection = h.select(); const p = h.fullPlan(), d = api().decideWikiHoldoutFullExperiment(p, gateRows(p));
    assert.equal(p.validation.budgetStatus, unknown ? 'usage-unknown' : 'over-limit'); assert.equal(d.outcome, 'indeterminate'); assert.equal(d.adoptionEligible, false);
    assert.throws(() => api().decideWikiHoldoutFullExperiment(p, rows(p)));
  }
});
test('explicit skip binds uncovered mode, changes confirmation hash and cannot silently substitute the other control', () => {
  const h = fixture(), old = h.fullPlan(); h.skippedCaseIds = h.selection.caseIds; h.selection = h.select(); h.addControls();
  const p = h.fullPlan(); assert.notEqual(p.planHash, old.planHash); assert.equal(p.validation.caseIds.length, 0);
  assert.deepEqual(p.validation.uncovered[0], { entryId: 'entry-1', reason: 'operator-skipped' });
  assert.equal(api().decideWikiHoldoutFullExperiment(p, rows(p)).outcome, 'validation-uncovered');
});
test('current reconstruction rejects source, assertion, confirmation, precheck, mode, usage and policy drift; retained plans still read', () => {
  const method = api();
  for (const mutate of [h => h.state.cases.find(c => c.id === h.marked[1].id).message += ' changed',
    h => h.state.controlConfirmations = [], h => h.state.rubrics.find(r => r.caseId === h.marked[1].id).status = 'draft',
    h => h.save(18, undefined, { reserve: true, createdAt: '2026-11-11T00:00:02.000Z' }),
    h => h.state.versions[0].entries.find(e => e.id === 'entry-2').status = 'draft', h => h.history[1].totalTokens++,
    h => h.policy = { degradationThreshold: 1 }, h => h.definition.runner.settings.thinking = 'low',
    h => h.catalog.at(-1).task += ' changed', h => h.catalog.at(-1).hardAssertions.changed = true,
    h => h.skippedCaseIds = [h.selection.caseIds[0]]]) {
    const h = fixture(), p = h.fullPlan(), bytes = JSON.stringify(p); mutate(h);
    assert.throws(() => method.assertWikiHoldoutFullExperimentPlan(p, h.definition, h.catalog, h.current()), { code: 'wiki_experiment_changed' });
    assert.equal(JSON.stringify(method.validateWikiHoldoutFullExperimentPlan(p)), bytes);
  }
});
test('selection cannot mix target modes, overlap target/control ids or omit/exceed selected execution cases', () => {
  const method = api();
  for (const mutate of [h => h.selection.targetEntryId = 'entry-1', h => h.definition.cases.pop(),
    h => h.definition.cases.push({ caseId: h.marked[0].id, judge: null }), h => h.catalog.pop(), h => h.catalog.push(h.catalog.at(-1)),
    h => h.definition.cases.at(-1).stage = 'gate', h => h.definition.cases.push(h.definition.cases.at(-1))]) {
    const h = fixture(); mutate(h); assert.throws(h.fullPlan.bind(h));
  }
  // Structurally valid rehashed other-mode proof cannot reuse a gate id.
  const h = fixture(); h.selection.cases[0].caseId = h.gate.caseIds[0]; h.selection.caseIds[0] = h.gate.caseIds[0];
  const { hash: old, ...payload } = h.selection; h.selection.hash = hash(payload);
  assert.throws(() => method.createWikiHoldoutFullExperimentPlan(h.definition, h.catalog, h.gate, h.selection));
});
test('rehashed retained tampering cannot change stage, category, rubric, level, coverage or judge semantics', () => {
  const method = api();
  for (const mutate of [p => p.cases.at(-1).stage = 'test', p => p.cases.at(-1).category = 'reproduction', p => p.cases.at(-1).targetReproduction = true,
    p => p.cases.at(-1).entryId = 'entry-6', p => p.cases.at(-1).rubricHash = hash('other assertion'), p => p.cases.at(-1).execution = { level: 'trace' },
    p => p.cases.at(-1).execution.requestHash = [], p => p.cases.at(-1).sceneHash = hash('other scene'), p => p.cases.at(-1).traceToolCheck = 'structured-v1',
    p => p.cases.pop(), p => p.cases.reverse(), p => p.validation.uncovered = [], p => p.validation.budgetStatus = 'ready-for-real-model',
    p => p.cases.at(-1).judge = { backend: 'unknown' }, p => p.runner.settings.authorization = 'synthetic-not-a-real-key']) {
    const p = fixture().fullPlan(); mutate(p); assert.throws(() => method.validateWikiHoldoutFullExperimentPlan(rehash(p)));
  }
});
test('control catalog binds frozen source assertions and execution scene just as strictly as gate catalog', () => {
  const method = api();
  for (const mutate of [h => h.catalog.at(-1).rubric.status = 'draft', h => h.catalog.at(-1).actual += 'changed', h => h.catalog.at(-1).expected += 'changed',
    h => delete h.catalog.at(-1).execution, h => h.catalog.at(-1).execution.requestHash = [], h => h.catalog.at(-1).extra = true,
    h => h.definition.cases.at(-1).judge = { backend: 'unapproved' }]) {
    const h = fixture(); mutate(h); assert.throws(() => method.createWikiHoldoutFullExperimentPlan(h.definition, h.catalog, h.gate, h.selection));
  }
});
test('AI control assertions require the exact eligible judge; tool-only controls do not read a judge catalog', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const h = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'holdout-control-judge-')), previous = process.env.CAFF_WIKISKILL_JUDGES_CONFIG;
  t.after(() => { if (previous === undefined) delete process.env.CAFF_WIKISKILL_JUDGES_CONFIG; else process.env.CAFF_WIKISKILL_JUDGES_CONFIG = previous; fs.rmSync(root, { recursive: true, force: true }); });
  delete process.env.CAFF_WIKISKILL_JUDGES_CONFIG; assert.ok(h.fullPlan().cases.every(c => c.judge === null));
  const c = h.state.cases.find(c => c.id === h.marked[1].id), old = h.state.rubrics.find(r => r.caseId === c.id);
  const rubric = { ...require(base + 'wiki-rubric').createWikiRubric({ ...old, actual: c.actual, expected: c.expected, version: 2,
    questions: [{ id: 'q1', question: 'The reason is concise.', evidence: 'reply' }], scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' } }),
    status: 'frozen', confirmedAt: old.confirmedAt, confirmationRecord: 'Synthetic AI control assertion approval' };
  h.state.rubrics.push(rubric);
  const configuration = { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', settings: { temperature: 0 }, promptHash: hash('synthetic judge prompt') };
  h.save(18, Array(5).fill('pass'), { createdAt: '2026-11-11T00:00:02.000Z', judge: { backend: configuration.backend, model: configuration.model,
    configurationHash: hash(configuration), freezeHash: hash('synthetic judge freeze'), promptHash: configuration.promptHash } });
  const controlApi = require(base + 'wiki-gate-control'), view = controlApi.projectWikiGateControls(h.state, h.records, h.replayChecks).find(v => v.caseId === c.id);
  h.state.controlConfirmations = h.state.controlConfirmations.filter(r => r.caseId !== c.id);
  h.state.controlConfirmations.push(controlApi.createWikiGateControlConfirmation(h.state, c.id, view.proposalHash, h.records, h.replayChecks));
  h.selection = h.select(); h.addControls(); h.definition.cases.find(r => r.caseId === c.id).judge = configuration;
  assert.throws(h.fullPlan.bind(h), { code: 'wiki_judge_not_eligible' });
  const judges = require('../helpers/wiki-judge-catalog.cjs')(root, [{ configuration, prompt: 'synthetic judge prompt' }]); process.env.CAFF_WIKISKILL_JUDGES_CONFIG = judges.configFile;
  const p = h.fullPlan(); assert.equal(p.cases.at(-1).judge.rubricHash, rubric.hash); assert.deepEqual(api().validateWikiHoldoutFullExperimentPlan(p), p);
  configuration.settings.temperature = 1; assert.throws(h.fullPlan.bind(h), { code: 'wiki_judge_not_eligible' });
});
test('unknown/duplicated result identities and AI-only trace invalid statuses cannot hide behind pooled pass totals', () => {
  const method = api(), p = fixture().fullPlan();
  for (const mutate of [r => r.push(r[0]), r => r[0].caseId = 'unknown', r => r.at(-1).status = 'completed-and-adopted']) {
    const r = rows(p); mutate(r); assert.throws(() => method.decideWikiHoldoutFullExperiment(p, r));
  }
  const h = fixture(); h.state.controlConfirmations = h.state.controlConfirmations.filter(c => c.caseId !== h.marked[1].id); h.selection = h.select(); h.addControls();
  const trace = h.fullPlan(), c = trace.cases.at(-1); delete c.traceToolCheck;
  c.judge = { kind: 'wiki-judge-binding-v1', backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', modelHash: hash('synthetic judge'), promptHash: hash('synthetic prompt'), rubricHash: c.rubricHash, passes: 3 };
  rehash(trace); method.validateWikiHoldoutFullExperimentPlan(trace); const r = rows(trace); r.at(-1).status = 'error'; r.at(-1).runs[0].status = 'invalid';
  assert.throws(() => method.decideWikiHoldoutFullExperiment(trace, r), /wiki_holdout_validation_result_invalid/);
});
