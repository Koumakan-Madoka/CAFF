const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const api = () => require(base + 'wiki-experiment-plan');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function fixture(t) {
  const { createWikiRubric } = require(base + 'wiki-rubric');
  const catalog = ['repair', 'control', 'held'].map(id => ({ id, sceneHash: hash('scene-' + id), task: 'Task ' + id, actual: 'Unclear', expected: 'Clear result',
    hardAssertions: { kind: 'synthetic-objective-checks', files: ['a.txt'] }, rubric: { ...createWikiRubric({ caseId: id, version: 1,
      model: 'deepseek/deepseek-v4-flash', scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' }, actual: 'Unclear', expected: 'Clear result', questions: [
        { id: 'q1', question: 'The result is clear.', evidence: 'reply' }, { id: 'q2', question: 'The next step is clear.', evidence: 'reply' },
      ] }), status: 'frozen', confirmedAt: '2026-11-04T00:00:00.000Z', confirmationRecord: 'Synthetic user confirmation' } }));
  const definition = { kind: 'wiki-experiment-v1', variants: [{ id: 'original', promptHash: hash('original') }, { id: 'candidate', promptHash: hash('candidate') }],
    runner: { model: 'openai-codex/gpt-6.1-sol', settings: { thinking: 'xhigh', fast: false } }, repeats: 10, executionPolicy: 'alternating-valid-v1',
    decision: { kind: 'wikiskill-gate-v1', alpha: .05, noHarmFraction: .05, minimumAllowedLoss: 1, maxExtraAttemptsPerCase: 5 },
    judge: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', settings: { temperature: 0 }, promptHash: require(base + 'wiki-rubric').wikiValueHash('synthetic-not-a-judge-prompt') },
    cases: [{ caseId: 'repair', stage: 'gate', category: 'reproduction', targetReproduction: true },
      { caseId: 'control', stage: 'gate', category: 'control', targetReproduction: false },
      { caseId: 'held', stage: 'test', category: 'reproduction', targetReproduction: true }] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-plan-judges-')), previous = process.env.CAFF_WIKISKILL_JUDGES_CONFIG;
  const judges = require('../helpers/wiki-judge-catalog.cjs')(root, [{ configuration: definition.judge, prompt: 'synthetic-not-a-judge-prompt' }]);
  process.env.CAFF_WIKISKILL_JUDGES_CONFIG = judges.configFile;
  t.after(() => { if (previous === undefined) delete process.env.CAFF_WIKISKILL_JUDGES_CONFIG; else process.env.CAFF_WIKISKILL_JUDGES_CONFIG = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return { catalog, definition, judges, plan: () => api().createWikiExperimentPlan(definition, catalog) };
}
const runs = (original, candidate) => Array.from({ length: 10 }, (_, i) => ['original', 'candidate'].map(variant => ({ variant, iteration: i + 1,
  status: i < (variant === 'original' ? original : candidate) ? 'pass' : 'fail' }))).flat();
const results = repaired => [{ caseId: 'repair', status: 'completed', runs: runs(0, repaired) }, { caseId: 'control', status: 'completed', runs: runs(10, 10) }];
// Run inputs are trusted host projections of the frozen packet, decision and
// original request. No live scene, caller task or trace/file evidence is implied.
function runFixture(t) {
  const h = fixture(t), c = structuredClone(h.catalog[0]); c.id = 'single';
  const { createWikiRubric, wikiValueHash } = require(base + 'wiki-rubric');
  c.execution = { level: 'run', traceBundleHash: hash('packet'), dehydrationHash: hash('decision'), requestHash: hash('frozen-prefix-request') };
  c.sceneHash = wikiValueHash({ kind: 'wikiskill-run-scene-v1', traceBundleHash: c.execution.traceBundleHash, dehydrationHash: c.execution.dehydrationHash });
  const rubric = evidence => ({ ...createWikiRubric({ ...h.catalog[0].rubric, caseId: c.id, actual: c.actual, expected: c.expected,
    questions: [{ id: 'q1', question: 'The result is clear.', evidence }] }), status: 'frozen', confirmedAt: '2026-11-06T00:00:00.000Z', confirmationRecord: 'Synthetic run approval' });
  c.rubric = rubric('reply'); c.hardAssertions = { kind: 'completion-public-reply-v1' };
  h.catalog.push(c); h.definition.cases.push({ ...h.definition.cases[0], caseId: c.id });
  return { ...h, single: c, rubric };
}
const rehash = plan => { const { planHash, ...payload } = plan; plan.planHash = require(base + 'wiki-rubric').wikiValueHash(payload); return plan; };
const mixedResults = () => [...results(6), { caseId: 'single', status: 'completed', runs: runs(0, 6) }];
const replacementRuns = statuses => {
  const attempts = { original: 0, candidate: 0 }, valid = { original: 0, candidate: 0 }, rows = [];
  let next = 'original', extra = 0;
  while (valid.original < 10 || valid.candidate < 10) {
    if (valid[next] === 10) next = next === 'original' ? 'candidate' : 'original';
    const status = statuses[rows.length] || 'pass';
    if (['error', 'invalid'].includes(status)) { if (extra === 5) break; extra++; } else valid[next]++;
    rows.push({ variant: next, iteration: ++attempts[next], status });
    next = next === 'original' ? 'candidate' : 'original';
  }
  return rows;
};
test('run plans bind frozen packet, decision and exact prefix request without rewriting legacy trace plans', t => {
  const h = runFixture(t), before = structuredClone(h.catalog), plan = h.plan();
  assert.equal(plan.kind, 'wiki-experiment-plan-v3');
  assert.deepEqual(plan.cases.find(c => c.caseId === 'single').execution, h.single.execution);
  assert.deepEqual(plan.cases.filter(c => c.caseId !== 'single').map(c => c.execution), Array(3).fill({ level: 'trace' }));
  assert.deepEqual(api().validateWikiExperimentPlan(plan), plan); api().assertWikiExperimentPlan(plan, h.definition, h.catalog);
  assert.deepEqual(h.catalog, before);
  const legacy = fixture(t), old = legacy.plan(); assert.equal(old.kind, 'wiki-experiment-plan-v1');
  assert.ok(old.cases.every(c => !Object.hasOwn(c, 'execution')));
  assert.deepEqual(api().validateWikiExperimentPlan(JSON.parse(JSON.stringify(old))), old);
});
test('new run plan also binds per-case judges without changing the experiment definition schema', t => {
  const h = runFixture(t); h.definition.kind = 'wiki-experiment-v2';
  for (const c of h.definition.cases) c.judge = structuredClone(h.definition.judge); delete h.definition.judge;
  const p = h.plan(); assert.equal(p.kind, 'wiki-experiment-plan-v3'); assert.deepEqual(api().validateWikiExperimentPlan(p), p);
  assert.ok(p.cases.every(c => c.judge.rubricHash === h.catalog.find(x => x.id === c.caseId).rubric.hash));
});
for (const reply of [false, true]) test(`v3 independent tool check plan (${reply ? 'dual' : 'tool only'}) binds rubric hash and only binds a judge for reply assertions`, t => {
  const h = runFixture(t), { createWikiRubric } = require(base + 'wiki-rubric');
  h.definition.kind = 'wiki-experiment-v2';
  for (const c of h.definition.cases) c.judge = structuredClone(h.definition.judge); delete h.definition.judge;
  const toolCheck = { method: 'code', target: { kind: 'caff-chat', name: 'suggest-goal' }, mode: 'on-call', rules: [{ parameter: 'reason', kind: 'max-chars', max: 1000 }] };
  h.single.rubric = { ...createWikiRubric({ ...h.single.rubric, actual: h.single.actual, expected: h.single.expected, questions: reply ? h.single.rubric.questions : [], scoringModel: reply ? h.single.rubric.scoringModel : null, toolCheck }), status: 'frozen', confirmedAt: h.single.rubric.confirmedAt, confirmationRecord: 'Synthetic tool check approval' };
  if (!reply) delete h.definition.cases.find(c => c.caseId === 'single').judge;
  const plan = h.plan(), selected = plan.cases.find(c => c.caseId === 'single');
  assert.equal(plan.kind, 'wiki-experiment-plan-v3'); assert.equal(selected.rubricHash, h.single.rubric.hash);
  assert.equal(selected.judge === null, !reply); assert.deepEqual(api().validateWikiExperimentPlan(plan), plan);
  api().assertWikiExperimentPlan(plan, h.definition, h.catalog);
  assert.deepEqual(api().decideWikiExperimentGate(plan, mixedResults()), api().decideWikiExperimentGate(runFixture(t).plan(), mixedResults()));
  const changed = structuredClone(h.single.rubric.toolCheck); changed.rules[0].max = 999;
  h.single.rubric = { ...createWikiRubric({ ...h.single.rubric, actual: h.single.actual, expected: h.single.expected, toolCheck: changed }), status: 'frozen', confirmedAt: h.single.rubric.confirmedAt, confirmationRecord: 'New approval' };
  assert.throws(() => api().assertWikiExperimentPlan(plan, h.definition, h.catalog), { code: 'wiki_experiment_changed' });
});
test('trace-only plans ignore a co-frozen tool check when questions exist, but still reject tool-only rubrics', t => {
  const h = fixture(t), c = h.catalog[0];
  c.rubric = { ...require(base + 'wiki-rubric').createWikiRubric({ ...c.rubric, actual: c.actual, expected: c.expected, toolCheck: { method: 'code', target: { kind: 'native', name: 'read' }, mode: 'on-call', rules: [{ parameter: 'path', kind: 'max-chars', max: 1000 }] } }), status: 'frozen', confirmedAt: c.rubric.confirmedAt, confirmationRecord: 'Synthetic approval' };
  const plan = h.plan(); assert.equal(plan.kind, 'wiki-experiment-plan-v1'); assert.equal(plan.cases[0].rubricHash, c.rubric.hash);
  c.rubric = { ...require(base + 'wiki-rubric').createWikiRubric({ ...c.rubric, actual: c.actual, expected: c.expected, questions: [], scoringModel: null }), status: 'frozen', confirmedAt: c.rubric.confirmedAt, confirmationRecord: 'Synthetic tool-only approval' };
  assert.throws(h.plan, { code: 'wiki_tool_check_run_only' });
});
test('run bindings reject malformed/extra fields, scene mismatch and all bound-input drift', t => {
  for (const key of ['traceBundleHash', 'dehydrationHash', 'requestHash']) {
    const h = runFixture(t), plan = h.plan(); h.single.execution[key] = hash('changed');
    assert.throws(() => api().assertWikiExperimentPlan(plan, h.definition, h.catalog), { code: 'wiki_experiment_changed' });
    const x = runFixture(t); x.single.execution[key] = 'invalid'; assert.throws(x.plan);
    const tampered = structuredClone(plan); tampered.cases.find(c => c.caseId === 'single').execution[key] = 'invalid';
    assert.throws(() => api().validateWikiExperimentPlan(rehash(tampered)));
  }
  const arrayHash = runFixture(t); arrayHash.single.execution.requestHash = [arrayHash.single.execution.requestHash];
  assert.throws(arrayHash.plan, 'hash fields must be strings, not coercible containers');
  for (const mutate of [x => x.single.execution.other = true, x => x.single.execution.level = 'trace',
    x => x.single.execution.level = 'other', x => x.single.sceneHash = hash('arbitrary-scene')]) {
    const h = runFixture(t); mutate(h); assert.throws(h.plan);
  }
});
test('run plan refuses non-reply frozen assertions, test-stage entries and excess gate run cases', t => {
  for (const evidence of ['trace', 'files']) {
    const h = runFixture(t); h.single.rubric = h.rubric(evidence);
    assert.throws(h.plan, { code: 'wiki_rubric_run_evidence_invalid' });
  }
  const held = runFixture(t); held.definition.cases.find(c => c.caseId === 'single').stage = 'test';
  assert.throws(held.plan, { code: 'wiki_experiment_run_test_unsupported' });
  const excess = runFixture(t); // three run gates, only two trace gates
  for (let i = 0; i < 2; i++) {
    const c = structuredClone(excess.single); c.id = 'single-' + i; c.rubric = { ...require(base + 'wiki-rubric').createWikiRubric({ ...c.rubric,
      caseId: c.id, actual: c.actual, expected: c.expected }), status: 'frozen', confirmedAt: '2026-11-06T00:00:00.000Z', confirmationRecord: 'Synthetic approval' };
    excess.catalog.push(c); excess.definition.cases.push({ ...excess.definition.cases.at(-1), caseId: c.id });
  }
  assert.throws(excess.plan, { code: 'wiki_experiment_run_gate_quota' });
});
test('stored run plans enforce stage, quota and derived scene hash even after caller rehashing', t => {
  for (const mutate of [p => p.cases.find(c => c.caseId === 'single').stage = 'test',
    p => p.cases.find(c => c.caseId === 'single').sceneHash = hash('forged'),
    p => p.cases.find(c => c.caseId === 'single').execution.other = 1,
    p => { for (const c of p.cases) if (c.stage === 'gate') c.execution = structuredClone(p.cases.at(-1).execution); },
    p => { for (const c of p.cases) c.execution = { level: 'trace' }; }]) {
    const h = runFixture(t), p = h.plan(); mutate(p); assert.throws(() => api().validateWikiExperimentPlan(rehash(p)));
  }
});
test('mixed gate reports trace/run separately but applies the unchanged pooled Fisher and no-harm formula', t => {
  const h = runFixture(t), p = h.plan(), rows = mixedResults(), { decideWikiGate } = require(base + 'wiki-gate-policy');
  const d = api().decideWikiExperimentGate(p, rows), { byLevel, ...pooled } = d;
  const legacy = decideWikiGate(rows.map(c => ({ ...c, sourceCaseId: c.caseId, stage: 'gate', category: c.caseId === 'control' ? 'control' : 'reproduction' })), ['repair', 'single'], 10);
  assert.deepEqual(pooled, legacy); assert.equal(d.outcome, 'accepted');
  // With zero original successes the one-sided tail has a single cell:
  // P(all 12 successes among the 20 candidate draws) = C(20,12)/C(40,12).
  const choose = (n, k) => Array.from({ length: k }, (_, i) => (n - i) / (i + 1)).reduce((a, b) => a * b, 1);
  assert.ok(Math.abs(d.repair.pValue - choose(20, 12) / choose(40, 12)) < 1e-12);
  assert.equal(d.noHarm.allowedLoss, 1); assert.equal(d.noHarm.loss, 0); assert.equal(d.noHarm.passed, true);
  assert.deepEqual(byLevel.trace.caseIds, ['repair', 'control']); assert.deepEqual(byLevel.run.caseIds, ['single']);
  assert.deepEqual(byLevel.trace.original, { passed: 10, total: 20, invalid: 0, errors: 0 });
  assert.deepEqual(byLevel.run.candidate, { passed: 6, total: 10, invalid: 0, errors: 0 });
});
test('invalid tools/empty replies are run-only non-denominator attempts sharing the five replacements with errors', t => {
  const h = runFixture(t), p = h.plan(), rows = mixedResults(), single = rows.at(-1);
  single.runs = replacementRuns({ 0: 'invalid', 1: 'error', 2: 'invalid', 3: 'error', 4: 'invalid' });
  assert.equal(single.runs.length, 25);
  const d = api().decideWikiExperimentGate(p, rows);
  assert.deepEqual(d.byLevel.run.original, { passed: 10, total: 10, invalid: 3, errors: 0 });
  assert.deepEqual(d.byLevel.run.candidate, { passed: 10, total: 10, invalid: 0, errors: 2 });
  assert.equal(d.repair.original.total, 20); assert.equal(d.repair.candidate.total, 20);
  const over = structuredClone(rows); over.at(-1).status = 'error'; over.at(-1).runs[5].status = 'invalid';
  assert.throws(() => api().decideWikiExperimentGate(p, over));
  const traceInvalid = mixedResults(); traceInvalid[0].status = 'error'; traceInvalid[0].runs[0].status = 'invalid';
  assert.throws(() => api().decideWikiExperimentGate(p, traceInvalid));
});
test('exhausted run replacements and zero-valid originals report an indeterminate gate, never failures or passes', t => {
  const h = runFixture(t), p = h.plan(), rows = mixedResults(), single = rows.at(-1);
  single.status = 'error'; single.runs = replacementRuns(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i, 'invalid'])));
  assert.equal(single.runs.length, 5);
  const d = api().decideWikiExperimentGate(p, rows);
  assert.equal(d.outcome, 'indeterminate'); assert.equal(d.byLevel.run.original.total, 0); assert.equal(d.byLevel.run.original.passed, 0);
  assert.equal(d.byLevel.run.original.invalid, 3); assert.equal(d.byLevel.run.candidate.invalid, 2);
  single.status = 'completed'; assert.throws(() => api().decideWikiExperimentGate(p, rows));
});
test('independent plan binds version inputs, runner, objective checks, rubric and judge without mutating case registration', t => {
  const h = fixture(t), before = structuredClone(h.catalog), plan = h.plan();
  assert.match(plan.planHash, /^[a-f0-9]{64}$/); assert.equal(plan.cases.length, 3); assert.equal(plan.cases[0].judge.rubricHash, h.catalog[0].rubric.hash);
  assert.deepEqual(h.catalog, before); assert.equal(JSON.stringify(plan).includes('The result is clear.'), false);
  h.definition.runner.settings.thinking = 'low'; assert.equal(plan.runner.settings.thinking, 'xhigh');
});
test('new plans require the entire eligible frozen configuration, not just backend/model', t => {
  for (const mutate of [h => h.definition.judge.settings.temperature = 1,
    h => h.definition.judge.settings.maxTokens = 1024, h => h.definition.judge.promptHash = hash('uncalibrated prompt')]) {
    const h = fixture(t); mutate(h);
    assert.throws(h.plan, { code: 'wiki_judge_not_eligible' });
  }
});
test('new plans fail closed without a readable valid catalog; old plans remain readable independently', t => {
  const h = fixture(t), plan = h.plan();
  for (const file of [undefined, path.join(path.dirname(h.judges.configFile), 'absent.json')]) {
    if (file === undefined) delete process.env.CAFF_WIKISKILL_JUDGES_CONFIG; else process.env.CAFF_WIKISKILL_JUDGES_CONFIG = file;
    assert.throws(h.plan, { code: file === undefined ? 'wiki_judge_not_eligible' : 'wiki_judge_catalog_invalid' });
    assert.deepEqual(api().validateWikiExperimentPlan(plan), plan);
  }
  process.env.CAFF_WIKISKILL_JUDGES_CONFIG = h.judges.configFile;
  h.judges.frozen.configuration.settings.temperature = 1; h.judges.save();
  assert.throws(h.plan, { code: 'wiki_judge_catalog_invalid' });
  assert.deepEqual(api().validateWikiExperimentPlan(plan), plan);
});
test('plan rejects draft rubrics, mismatched source/case identity, duplicates, invalid partitions and policy drift', t => {
  assert.equal(typeof api().createWikiExperimentPlan, 'function');
  for (const mutate of [
    h => { const { confirmedAt, confirmationRecord, ...draft } = h.catalog[0].rubric; h.catalog[0].rubric = { ...draft, status: 'draft' }; },
    h => h.catalog[0].expected = 'Changed expectation', h => h.catalog[0].id = 'other-case', h => h.catalog[0].sceneHash = 'invalid',
    h => h.definition.cases.push(h.definition.cases[0]), h => h.definition.cases[1].targetReproduction = true,
    h => h.definition.cases[2].stage = 'gate', h => h.definition.repeats = 9, h => h.definition.decision.alpha = .1,
    h => h.definition.variants[1].id = 'original', h => h.definition.variants[1].promptHash = 'invalid',
  ]) { const h = fixture(t); mutate(h); assert.throws(h.plan); }
});
test('any bound experiment or case drift refuses reuse, including correctly rehashed plan tampering', t => {
  for (const mutate of [h => h.catalog[0].task += ' changed', h => h.catalog[0].sceneHash = hash('new-scene'), h => h.catalog[0].hardAssertions.files.push('b.txt'),
    h => h.definition.judge.promptHash = hash('new prompt'), h => h.definition.judge.settings.temperature = 1,
    h => h.definition.runner.settings.thinking = 'low', h => h.definition.variants[1].promptHash = hash('new candidate')]) {
    const h = fixture(t), plan = h.plan(); mutate(h); assert.throws(() => api().assertWikiExperimentPlan(plan, h.definition, h.catalog), /wiki_experiment_changed/);
  }
  const h = fixture(t), plan = h.plan(); plan.cases[0].rubricHash = hash('changed');
  const { planHash, ...payload } = plan; plan.planHash = require(base + 'wiki-rubric').wikiValueHash(payload);
  assert.throws(() => api().assertWikiExperimentPlan(plan, h.definition, h.catalog), /wiki_experiment_changed/);
});
test('D7 gate formula is delegated unchanged and only an accepted gate permits test execution', t => {
  const h = fixture(t), plan = h.plan(), { decideWikiGate } = require(base + 'wiki-gate-policy');
  for (const n of [0, 4, 6, 10]) {
    const rows = results(n), actual = api().decideWikiExperimentGate(plan, rows);
    const legacy = decideWikiGate(rows.map(r => ({ ...r, sourceCaseId: r.caseId, stage: 'gate', category: r.caseId === 'repair' ? 'reproduction' : 'control' })), ['repair'], 10);
    assert.deepEqual(actual, legacy);
    if (actual.outcome === 'accepted') assert.doesNotThrow(() => api().assertWikiExperimentStage(plan, rows, 'test'));
    else assert.throws(() => api().assertWikiExperimentStage(plan, rows, 'test'), /wiki_experiment_gate_not_accepted/);
  }
  assert.doesNotThrow(() => api().assertWikiExperimentStage(plan, [], 'gate'));
});
test('terminal judge errors consume planned slots, not the environmental replacement budget or denominator', t => {
  const h = fixture(t), plan = h.plan(), rows = results(6); rows[0].status = 'error';
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
test('unavailable evidence/errors never become passes; extra/duplicate results and nonalternating attempts are refused', t => {
  const h = fixture(t), plan = h.plan();
  assert.equal(api().decideWikiExperimentGate(plan, []).outcome, 'indeterminate');
  const incomplete = results(6); incomplete[0].status = 'error'; incomplete[0].runs[0].status = 'error';
  assert.equal(api().decideWikiExperimentGate(plan, incomplete).outcome, 'indeterminate');
  for (const rows of [[...results(6), results(6)[0]], [...results(6), { caseId: 'unknown', status: 'not-run', runs: [] }],
    [{ ...results(6)[0], runs: [...runs(0, 6)].reverse() }, results(6)[1]]]) assert.throws(() => api().decideWikiExperimentGate(plan, rows));
});
