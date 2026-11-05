const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const api = () => require(base + 'wiki-experiment-plan');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function fixture() {
  const { createWikiRubric } = require(base + 'wiki-rubric');
  const catalog = ['repair', 'control', 'held'].map(id => ({ id, sceneHash: hash('scene-' + id), task: 'Task ' + id, actual: 'Unclear', expected: 'Clear result',
    hardAssertions: { kind: 'synthetic-objective-checks', files: ['a.txt'] }, rubric: { ...createWikiRubric({ caseId: id, version: 1,
      model: 'deepseek/deepseek-v4-flash', scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' }, actual: 'Unclear', expected: 'Clear result', questions: [
        { id: 'q1', question: 'The result is clear.', evidence: 'reply' }, { id: 'q2', question: 'The next step is clear.', evidence: 'reply' },
      ] }), status: 'frozen', confirmedAt: '2026-11-04T00:00:00.000Z', confirmationRecord: 'Synthetic user confirmation' } }));
  const definition = { kind: 'wiki-experiment-v1', variants: [{ id: 'original', promptHash: hash('original') }, { id: 'candidate', promptHash: hash('candidate') }],
    runner: { model: 'openai-codex/gpt-6.1-sol', settings: { thinking: 'xhigh', fast: false } }, repeats: 10, executionPolicy: 'alternating-valid-v1',
    decision: { kind: 'wikiskill-gate-v1', alpha: .05, noHarmFraction: .05, minimumAllowedLoss: 1, maxExtraAttemptsPerCase: 5 },
    judge: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', settings: { temperature: 0 }, promptHash: hash('synthetic-not-a-judge-prompt') },
    cases: [{ caseId: 'repair', stage: 'gate', category: 'reproduction', targetReproduction: true },
      { caseId: 'control', stage: 'gate', category: 'control', targetReproduction: false },
      { caseId: 'held', stage: 'test', category: 'reproduction', targetReproduction: true }] };
  return { catalog, definition, plan: () => api().createWikiExperimentPlan(definition, catalog) };
}
const runs = (original, candidate) => Array.from({ length: 10 }, (_, i) => ['original', 'candidate'].map(variant => ({ variant, iteration: i + 1,
  status: i < (variant === 'original' ? original : candidate) ? 'pass' : 'fail' }))).flat();
const results = repaired => [{ caseId: 'repair', status: 'completed', runs: runs(0, repaired) }, { caseId: 'control', status: 'completed', runs: runs(10, 10) }];
test('independent plan binds version inputs, runner, objective checks, rubric and judge without mutating case registration', () => {
  const h = fixture(), before = structuredClone(h.catalog), plan = h.plan();
  assert.match(plan.planHash, /^[a-f0-9]{64}$/); assert.equal(plan.cases.length, 3); assert.equal(plan.cases[0].judge.rubricHash, h.catalog[0].rubric.hash);
  assert.deepEqual(h.catalog, before); assert.equal(JSON.stringify(plan).includes('The result is clear.'), false);
  h.definition.runner.settings.thinking = 'low'; assert.equal(plan.runner.settings.thinking, 'xhigh');
});
test('plan rejects draft rubrics, mismatched source/case identity, duplicates, invalid partitions and policy drift', () => {
  assert.equal(typeof api().createWikiExperimentPlan, 'function');
  for (const mutate of [
    h => { const { confirmedAt, confirmationRecord, ...draft } = h.catalog[0].rubric; h.catalog[0].rubric = { ...draft, status: 'draft' }; },
    h => h.catalog[0].expected = 'Changed expectation', h => h.catalog[0].id = 'other-case', h => h.catalog[0].sceneHash = 'invalid',
    h => h.definition.cases.push(h.definition.cases[0]), h => h.definition.cases[1].targetReproduction = true,
    h => h.definition.cases[2].stage = 'gate', h => h.definition.repeats = 9, h => h.definition.decision.alpha = .1,
    h => h.definition.variants[1].id = 'original', h => h.definition.variants[1].promptHash = 'invalid',
  ]) { const h = fixture(); mutate(h); assert.throws(h.plan); }
});
test('any bound experiment or case drift refuses reuse, including correctly rehashed plan tampering', () => {
  for (const mutate of [h => h.catalog[0].task += ' changed', h => h.catalog[0].sceneHash = hash('new-scene'), h => h.catalog[0].hardAssertions.files.push('b.txt'),
    h => h.definition.judge.promptHash = hash('new prompt'), h => h.definition.judge.settings.temperature = 1,
    h => h.definition.runner.settings.thinking = 'low', h => h.definition.variants[1].promptHash = hash('new candidate')]) {
    const h = fixture(), plan = h.plan(); mutate(h); assert.throws(() => api().assertWikiExperimentPlan(plan, h.definition, h.catalog), /wiki_experiment_changed/);
  }
  const h = fixture(), plan = h.plan(); plan.cases[0].rubricHash = hash('changed');
  const { planHash, ...payload } = plan; plan.planHash = require(base + 'wiki-rubric').wikiValueHash(payload);
  assert.throws(() => api().assertWikiExperimentPlan(plan, h.definition, h.catalog), /wiki_experiment_changed/);
});
test('D7 gate formula is delegated unchanged and only an accepted gate permits test execution', () => {
  const h = fixture(), plan = h.plan(), { decideWikiGate } = require(base + 'wiki-gate-policy');
  for (const n of [0, 4, 6, 10]) {
    const rows = results(n), actual = api().decideWikiExperimentGate(plan, rows);
    const legacy = decideWikiGate(rows.map(r => ({ ...r, sourceCaseId: r.caseId, stage: 'gate', category: r.caseId === 'repair' ? 'reproduction' : 'control' })), ['repair'], 10);
    assert.deepEqual(actual, legacy);
    if (actual.outcome === 'accepted') assert.doesNotThrow(() => api().assertWikiExperimentStage(plan, rows, 'test'));
    else assert.throws(() => api().assertWikiExperimentStage(plan, rows, 'test'), /wiki_experiment_gate_not_accepted/);
  }
  assert.doesNotThrow(() => api().assertWikiExperimentStage(plan, [], 'gate'));
});
test('terminal judge errors consume planned slots, not the environmental replacement budget or denominator', () => {
  const h = fixture(), plan = h.plan(), rows = results(6); rows[0].status = 'error';
  for (const row of rows[0].runs) { row.status = 'error'; row.judgeError = true; }
  assert.equal(api().decideWikiExperimentGate(plan, rows).outcome, 'indeterminate');
  const mixed = results(6); mixed[0].status = 'error'; mixed[0].runs[0] = { variant: 'original', iteration: 1, status: 'error', judgeError: true };
  mixed[0].runs[1].status = 'error'; mixed[0].runs.push({ variant: 'candidate', iteration: 11, status: 'pass' });
  assert.equal(api().decideWikiExperimentGate(plan, mixed).outcome, 'indeterminate');
  mixed[0].runs.at(-1).variant = 'original'; assert.throws(() => api().decideWikiExperimentGate(plan, mixed));
  for (const patch of [{ status: 'pass', judgeError: true }, { status: 'error', judgeError: false }]) {
    const invalid = results(6); Object.assign(invalid[0].runs[0], patch); assert.throws(() => api().decideWikiExperimentGate(plan, invalid));
  }
});
test('unavailable evidence/errors never become passes; extra/duplicate results and nonalternating attempts are refused', () => {
  const h = fixture(), plan = h.plan();
  assert.equal(api().decideWikiExperimentGate(plan, []).outcome, 'indeterminate');
  const incomplete = results(6); incomplete[0].status = 'error'; incomplete[0].runs[0].status = 'error';
  assert.equal(api().decideWikiExperimentGate(plan, incomplete).outcome, 'indeterminate');
  for (const rows of [[...results(6), results(6)[0]], [...results(6), { caseId: 'unknown', status: 'not-run', runs: [] }],
    [{ ...results(6)[0], runs: [...runs(0, 6)].reverse() }, results(6)[1]]]) assert.throws(() => api().decideWikiExperimentGate(plan, rows));
});
