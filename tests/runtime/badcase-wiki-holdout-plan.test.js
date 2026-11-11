const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const api = () => require(base + 'wiki-holdout-plan');
const { wikiValueHash: hash, createWikiRubric } = require(base + 'wiki-rubric');
const fixture = require('../helpers/wiki-holdout-plan.cjs');
const rehash = plan => { const { planHash, ...payload } = plan; plan.planHash = hash(payload); return plan; };
const reselect = h => {
  h.gate = require(base + 'wiki-holdout-gate').planWikiHoldoutGate(h.input());
  h.definition.cases = h.gate.caseIds.map(caseId => ({ caseId, judge: null }));
  h.catalog = h.catalog.filter(c => h.gate.caseIds.includes(c.id));
};
const results = plan => plan.cases.map((c, n) => ({ caseId: c.caseId, status: 'completed', runs: Array.from({ length: 10 }, (_, i) => ['original', 'candidate'].map(variant => ({ variant, iteration: i + 1,
  status: variant === 'candidate' && n === 0 && i < 6 ? 'pass' : 'fail' }))).flat() }));
test('v4 binds both mode-6 holdouts and current prechecks without changing frozen membership or requiring controls/test', () => {
  const h = fixture(), before = JSON.stringify({ input: h.input(), catalog: h.catalog, definition: h.definition }), p = h.plan();
  assert.equal(p.kind, 'wiki-experiment-plan-v4'); assert.deepEqual(p.gate, h.gate);
  assert.deepEqual(p.cases.map(c => c.caseId), h.gate.caseIds);
  assert.ok(p.cases.every(c => c.stage === 'gate' && c.targetReproduction && c.category === 'reproduction'));
  assert.deepEqual(p.cases.map(c => c.originalSplit).sort(), ['gate', 'test']);
  assert.ok(p.cases.every(c => c.judge === null));
  assert.equal(p.cases.find(c => c.execution.level === 'trace').traceToolCheck, 'structured-v1');
  assert.ok(!Object.hasOwn(p.cases.find(c => c.execution.level === 'run'), 'traceToolCheck'));
  assert.deepEqual(api().validateWikiHoldoutExperimentPlan(JSON.parse(JSON.stringify(p))), p);
  assert.equal(JSON.stringify({ input: h.input(), catalog: h.catalog, definition: h.definition }), before);
  assert.equal(api().decideWikiHoldoutExperimentGate(p, results(p)).outcome, 'accepted');
  assert.equal(Object.hasOwn(api().decideWikiHoldoutExperimentGate(p, results(p)), 'noHarm'), false);
  assert.deepEqual(api().decideWikiHoldoutExperimentGate(p, results(p)).byLevel.run.caseIds, p.cases.filter(c => c.execution.level === 'run').map(c => c.caseId));
});
test('single run-only former-test holdout is permitted; no run-to-trace ratio and single-target warning retained', () => {
  const h = fixture(); h.state.cases.find(c => c.id === h.marked[6].id).split = 'train'; reselect(h);
  const p = h.plan(); assert.equal(p.cases.length, 1); assert.equal(p.cases[0].execution.level, 'run');
  assert.equal(p.cases[0].originalSplit, 'test'); assert.equal(p.cases[0].stage, 'gate');
  const d = api().decideWikiHoldoutExperimentGate(p, results(p));
  assert.equal(d.outcome, 'accepted'); assert.deepEqual(d.warnings, ['只有 1 道门槛题']); assert.deepEqual(d.byLevel.trace.caseIds, []);
});
test('excluded holdouts remain in the immutable selection but never acquire catalog or result slots', () => {
  const h = fixture(); h.save(24, ['pass', 'pass', 'pass', 'pass', 'pass'], { createdAt: '2026-11-11T00:00:01.000Z' }); reselect(h);
  const p = h.plan(); assert.equal(p.cases.length, 1); assert.equal(p.gate.cases.length, 2);
  assert.equal(api().decideWikiHoldoutExperimentGate(p, results(p)).ignoredCaseIds.length, 1);
  assert.throws(() => api().decideWikiHoldoutExperimentGate(p, [...results(p), { caseId: h.marked[7].id, status: 'not-run', runs: [] }]));
});
test('zero reproduced targets cannot create a v4 plan or borrow another mode', () => {
  const h = fixture(); h.state.patternLabels.filter(l => [h.marked[6].id, h.marked[7].id].includes(l.caseId)).forEach(l => l.entryId = 'entry-1'); reselect(h);
  assert.throws(h.plan.bind(h), { code: 'wiki_holdout_plan_targets_required' });
});
test('host current-evidence assertion rejects new reservations, changed source, split, scene and rubric, even when old plan remains readable', () => {
  for (const mutate of [h => h.save(23, undefined, { reserve: true, createdAt: '2026-11-11T00:00:02.000Z' }),
    h => h.state.cases.find(c => c.id === h.marked[6].id).message += 'changed',
    h => h.state.cases.find(c => c.id === h.marked[6].id).split = 'train',
    h => h.state.replayCases.find(c => c.sourceCaseId === h.marked[6].id).checkpointHash = hash('new scene'),
    h => h.state.rubrics.find(c => c.caseId === h.marked[6].id).status = 'draft']) {
    const h = fixture(), p = h.plan(), bytes = JSON.stringify(p);
    api().assertWikiHoldoutExperimentPlan(p, h.definition, h.catalog, h.input()); mutate(h);
    assert.throws(() => api().assertWikiHoldoutExperimentPlan(p, h.definition, h.catalog, h.input()), { code: 'wiki_experiment_changed' });
    assert.equal(JSON.stringify(api().validateWikiHoldoutExperimentPlan(p)), bytes);
  }
});
test('v4 refuses caller-selected subsets, training/other-mode targets, duplicate catalog entries, and caller stage/category overrides', () => {
  for (const mutate of [h => h.definition.cases.pop(), h => h.definition.cases.push({ caseId: h.marked[5].id, judge: null }),
    h => h.definition.cases.push({ caseId: h.marked[0].id, judge: null }), h => h.definition.cases.push(h.definition.cases[0]),
    h => h.catalog.push(h.catalog[0]), h => h.definition.cases[0].stage = 'test', h => h.definition.cases[0].category = 'control',
    h => h.definition.cases[0].targetReproduction = false]) {
    const h = fixture(); mutate(h); assert.throws(h.plan.bind(h));
  }
});
test('bindings reject draft/source-mismatched assertions, precheck-rubric drift, and trace-to-run masquerading', () => {
  for (const mutate of [h => h.catalog[0].rubric.status = 'draft', h => h.catalog[0].actual += ' changed', h => h.catalog[0].expected += ' changed',
    h => { const c = h.catalog[0]; c.rubric = { ...createWikiRubric({ ...c.rubric, actual: c.actual, expected: c.expected, version: 2 }), status: 'frozen', confirmedAt: c.rubric.confirmedAt, confirmationRecord: 'New synthetic approval' }; },
    h => delete h.catalog.find(c => c.execution).execution,
    h => { const c = h.catalog.find(c => !c.execution); c.execution = structuredClone(h.catalog.find(c => c.execution).execution); c.sceneHash = require(base + 'wiki-experiment-plan').wikiExperimentRunSceneHash(c.execution); },
    h => h.catalog.find(c => c.execution).execution.requestHash = ['a'.repeat(64)], h => h.catalog.find(c => c.execution).sceneHash = hash('forged scene')]) {
    const h = fixture(); mutate(h); assert.throws(h.plan.bind(h));
  }
});
test('unmarked trace invalid outputs remain forbidden rather than gaining run/tool semantics through v4', () => {
  const p = fixture().plan(), trace = p.cases.find(c => c.execution.level === 'trace');
  // A structurally valid retained AI-only trace binding. Full host recreation
  // also checks its rubric; the pure gate must not permit an invalid status.
  delete trace.traceToolCheck;
  trace.judge = { kind: 'wiki-judge-binding-v1', backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', modelHash: hash('synthetic judge configuration'),
    promptHash: hash('synthetic judge prompt'), rubricHash: trace.rubricHash, passes: 3 };
  rehash(p); assert.deepEqual(api().validateWikiHoldoutExperimentPlan(p), p);
  const rows = results(p), row = rows.find(c => c.caseId === trace.caseId); row.status = 'error'; row.runs[0].status = 'invalid';
  assert.throws(() => api().decideWikiHoldoutExperimentGate(p, rows), { code: 'wiki_holdout_gate_result_invalid' });
});
test('every v4 input binding changes the plan and refuses old confirmation reuse', () => {
  for (const mutate of [h => h.definition.variants[1].promptHash = hash('new prompt'), h => h.definition.runner.settings.thinking = 'low',
    h => h.catalog[0].task += ' changed', h => h.catalog[0].hardAssertions.changed = true,
    h => h.catalog.find(c => c.execution).execution.requestHash = hash('new frozen request')]) {
    const h = fixture(), p = h.plan(); mutate(h); assert.notEqual(h.plan().planHash, p.planHash);
    assert.throws(() => api().assertWikiHoldoutExperimentPlan(p, h.definition, h.catalog, h.input()), { code: 'wiki_experiment_changed' });
  }
});
test('rehashed tampering cannot add a test/control stage, hide selected targets, change policy, or break rubric/level associations', () => {
  for (const mutate of [p => p.cases[0].stage = 'test', p => p.cases[0].category = 'control', p => p.cases[0].targetReproduction = false,
    p => p.cases[0].rubricHash = hash('unmatched rubric'), p => p.cases[0].originalSplit = 'train', p => p.cases.pop(),
    p => p.cases[0].execution = { level: 'other' }, p => p.cases.find(c => c.execution.level === 'run').traceToolCheck = 'structured-v1',
    p => p.repeats = 9, p => p.decision.alpha = .1, p => p.decision.noHarmFraction = .05,
    p => p.cases[0].judge = { backend: 'unapproved' }, p => p.runner.settings.authorization = 'synthetic-not-a-real-key',
    p => p.gate.hash = hash('other selection')]) {
    const p = fixture().plan(); mutate(p); assert.throws(() => api().validateWikiHoldoutExperimentPlan(rehash(p)));
  }
});
for (const mutate of [h => h.definition.kind = 'wiki-experiment-v2', h => h.definition.variants[0].id = 'candidate',
  h => h.definition.variants[0].promptHash = ['a'.repeat(64)], h => h.definition.runner.settings.bad = {}, h => h.definition.runner.settings.temperature = Infinity,
  h => h.definition.repeats = 5, h => h.definition.executionPolicy = 'all-original-first', h => h.definition.decision.alpha = .1])
  test('definition shape and fixed execution/gate policy are fail-closed: ' + mutate.toString(), () => { const h = fixture(); mutate(h); assert.throws(h.plan.bind(h)); });
test('tool-only v4 requires no judge catalog; AI assertions still require the exact eligible frozen judge and run reply evidence', t => {
  const h = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'holdout-plan-judges-')), previous = process.env.CAFF_WIKISKILL_JUDGES_CONFIG;
  t.after(() => { if (previous === undefined) delete process.env.CAFF_WIKISKILL_JUDGES_CONFIG; else process.env.CAFF_WIKISKILL_JUDGES_CONFIG = previous; fs.rmSync(root, { recursive: true, force: true }); });
  delete process.env.CAFF_WIKISKILL_JUDGES_CONFIG;
  assert.ok(h.plan().cases.every(c => c.judge === null));
  const c = h.catalog.find(c => c.execution);
  c.rubric = { ...createWikiRubric({ ...c.rubric, actual: c.actual, expected: c.expected, version: 2,
    questions: [{ id: 'q1', question: 'The reason is concise.', evidence: 'reply' }], scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' } }),
    status: 'frozen', confirmedAt: c.rubric.confirmedAt, confirmationRecord: 'Synthetic dual-check approval' };
  const configuration = { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', settings: { temperature: 0 }, promptHash: hash('synthetic judge prompt') };
  h.state.rubrics.push(c.rubric); h.save(24, ['fail', 'fail', 'fail', 'pass', 'pass'], { createdAt: '2026-11-11T00:00:02.000Z', judge: { backend: configuration.backend, model: configuration.model, configurationHash: hash(configuration), freezeHash: hash('synthetic judge freeze'), promptHash: configuration.promptHash } });
  h.gate = require(base + 'wiki-holdout-gate').planWikiHoldoutGate(h.input());
  h.definition.cases.find(s => s.caseId === c.id).judge = configuration;
  assert.throws(h.plan.bind(h), { code: 'wiki_judge_not_eligible' });
  const judges = require('../helpers/wiki-judge-catalog.cjs')(root, [{ configuration, prompt: 'synthetic judge prompt' }]); process.env.CAFF_WIKISKILL_JUDGES_CONFIG = judges.configFile;
  const p = h.plan(); assert.ok(p.cases.find(s => s.caseId === c.id).judge); assert.deepEqual(api().validateWikiHoldoutExperimentPlan(p), p);
  configuration.settings.temperature = 1; assert.throws(h.plan.bind(h), { code: 'wiki_judge_not_eligible' }); configuration.settings.temperature = 0;
  c.rubric = { ...createWikiRubric({ ...c.rubric, actual: c.actual, expected: c.expected, version: 3,
    questions: [{ id: 'q1', question: 'The trace is concise.', evidence: 'trace' }] }), status: 'frozen', confirmedAt: c.rubric.confirmedAt, confirmationRecord: 'Synthetic trace-evidence approval' };
  // Even a locally rehashed proof cannot bypass the run-only reply-evidence
  // check. A real trusted precheck would already refuse this rubric.
  h.gate.cases.find(s => s.caseId === c.id).precheck.rubricHash = c.rubric.hash;
  const { hash: old, ...payload } = h.gate; h.gate.hash = hash(payload);
  assert.throws(h.plan.bind(h), { code: 'wiki_rubric_run_evidence_invalid' });
});
