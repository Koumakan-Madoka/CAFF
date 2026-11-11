const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const fixture = require('../helpers/wiki-holdout-batch.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
const batch = () => require('../../scripts/badcase-capture/batch-comparison.cjs');
test('trusted v4 host planning pools mode-6 #23/#24 as gate without a control; preserves frozen groups, state and original task', t => {
  const h = fixture(t), before = JSON.stringify(h.store.read()), plan = h.plan();
  assert.equal(plan.summary.kind, 'wiki-mode-holdout-comparison-v1'); assert.equal(plan.summary.experiment.kind, 'wiki-experiment-plan-v4');
  assert.equal(plan.summary.evaluation.kind, 'wikiskill-holdout-gate-v1');
  assert.deepEqual(plan.summary.evaluation.gateCaseIds, h.config.cases.map(c => c.sourceCaseId).sort());
  assert.equal(Object.hasOwn(plan.summary.evaluation, 'testCaseIds'), false);
  assert.equal(Object.hasOwn(plan.summary.split, 'testCaseIds'), false);
  assert.deepEqual(plan.summary.split.rows.map(r => r.split).sort(), ['gate', 'test']);
  assert.ok(plan.prepared.every(c => c.stage === 'gate' && c.category === 'reproduction' && !c.reportOnly));
  assert.ok(plan.prepared.every(c => c.comparisonConfig.scoring.task === 'Synthetic original triggering user task'));
  assert.equal(plan.summary.preparedReplayableCount, 2); assert.equal(h.calls.length, 2);
  assert.equal(JSON.stringify(h.store.read()), before); assert.equal(fs.existsSync(h.config.codexAuthFile), false);
  assert.ok(!JSON.stringify(plan.summary).includes(h.config.codexAuthFile));
  h.config.experiment.plan = plan.summary.experiment;
  assert.deepEqual(h.plan().summary.experiment, plan.summary.experiment);
});
test('trusted host permits a sole run-level former-test #24 with no trace quota and one frozen single-call request per variant', t => {
  const h = fixture(t), r = h.makeRun24(), traceId = h.marked[6].id;
  const old = h.records.list().find(r => r.reservation.plan.caseId === traceId), claim = h.records.reserve(old.reservation.plan);
  h.records.finish(claim.id, { status: 'completed', reason: null, runs: old.result.runs.map(r => ({ ...r, status: 'pass' })) });
  h.config.cases = h.config.cases.filter(c => c.sourceCaseId !== traceId); h.config.experiment.definition.cases = h.config.experiment.definition.cases.filter(c => c.caseId !== traceId);
  const before = JSON.stringify(h.store.read()), p = h.plan();
  assert.equal(p.prepared.length, 1); assert.equal(p.prepared[0].stage, 'gate'); assert.equal(p.prepared[0].split, 'test');
  assert.equal(p.prepared[0].execution.level, 'run'); assert.equal(p.prepared[0].comparisonConfig.scoring.task, r.task);
  assert.equal(p.prepared[0].comparisonConfig.kind, 'wikiskill-run-comparison-v1');
  assert.notEqual(p.prepared[0].comparisonConfig.originalRequestHash, p.prepared[0].comparisonConfig.candidateRequestHash);
  assert.equal(p.summary.experiment.cases[0].execution.dehydrationHash, r.decision.hash);
  assert.equal(p.summary.experiment.cases[0].execution.traceBundleHash, r.item().traceBundle.hash);
  assert.equal(p.summary.experiment.cases[0].judge, null); assert.equal(h.calls.length, 0);
  assert.equal(JSON.stringify(h.store.read()), before); assert.equal(fs.existsSync(h.config.codexAuthFile), false);
});
test('trusted planning does not let caller drop a difficult target, add training/another mode, or relabel it as control', t => {
  for (const mutate of [h => h.config.cases.pop(), h => h.config.cases.push({ ...h.config.cases[0], sourceCaseId: h.marked[5].id }),
    h => h.config.cases.push({ ...h.config.cases[0], sourceCaseId: h.marked[0].id }), h => h.config.cases[0].category = 'control',
    h => h.config.cases.push(h.config.cases[0]), h => h.config.experiment.definition.cases.pop()]) {
    const h = fixture(t); mutate(h); assert.throws(h.plan); assert.equal(h.calls.length, 0);
  }
});
test('non-reproduced holdouts remain visible but are not prepared, counted or used to fill the gate', t => {
  const h = fixture(t), id = h.marked[7].id;
  const old = h.records.list().find(r => r.reservation.plan.caseId === id), r = h.records.reserve(old.reservation.plan);
  h.records.finish(r.id, { status: 'completed', reason: null, runs: old.result.runs.map(r => ({ ...r, status: 'pass' })) });
  h.config.cases = h.config.cases.filter(c => c.sourceCaseId !== id); h.config.experiment.definition.cases = h.config.experiment.definition.cases.filter(c => c.caseId !== id);
  const p = h.plan(); assert.equal(p.prepared.length, 1); assert.equal(p.summary.experiment.gate.cases.length, 2);
  assert.equal(p.summary.experiment.gate.cases.find(c => c.caseId === id).reason, 'precheck_not_reproduced');
});
test('stale/reserved prechecks stop host preparation before any comparison preflight', t => {
  for (const mutate of [h => { const old = h.records.list().find(r => r.reservation.plan.caseId === h.marked[6].id); h.records.reserve(old.reservation.plan); },
    h => h.mutate(s => s.rubrics.find(r => r.caseId === h.marked[6].id).status = 'draft'),
    h => h.mutate(s => s.replayCases.find(r => r.sourceCaseId === h.marked[6].id).checkpointHash = hash('different checkpoint'))]) {
    const h = fixture(t); mutate(h); assert.throws(h.plan); assert.equal(h.calls.length, 0);
  }
});
test('v4 current reconstruction rejects a pinned selection after classification/split changes before preflight', t => {
  for (const mutate of [h => h.mutate(s => s.cases.find(c => c.id === h.marked[6].id).split = 'train'),
    h => h.mutate(s => s.patternLabels.find(c => c.caseId === h.marked[6].id).entryId = 'entry-1')]) {
    const h = fixture(t); h.config.experiment.plan = h.plan().summary.experiment; h.calls.length = 0; mutate(h);
    assert.throws(h.plan); assert.equal(h.calls.length, 0);
  }
});
test('evidence changed during comparison preparation cannot publish an already-stale v4 plan', t => {
  const h = fixture(t), prepare = h.options.prepareProductionComparison;
  let changed = false;
  h.options.prepareProductionComparison = c => {
    const result = prepare(c);
    if (!changed) { changed = true; const old = h.records.list().find(r => r.reservation.plan.caseId === h.marked[6].id); h.records.reserve(old.reservation.plan); }
    return result;
  };
  assert.throws(h.plan, { code: 'wiki_experiment_changed' });
});
test('new evaluation cannot silently downgrade to legacy/literal plans or accept a legacy pinned plan', t => {
  for (const mutate of [h => delete h.config.experiment, h => h.config.experiment.definition.kind = 'wiki-experiment-v2',
    h => h.config.evaluation.kind = 'wikiskill-gate-v1', h => h.config.experiment.plan = { kind: 'wiki-experiment-plan-v3' }]) {
    const h = fixture(t); mutate(h); assert.throws(h.plan); assert.equal(h.calls.length, 0);
  }
});
test('until staged v4 execution/publication is wired, both public and direct staged entry points fail closed before any event/send', async t => {
  const h = fixture(t), p = h.plan(); h.config.experiment.plan = p.summary.experiment;
  const pinned = h.plan(), events = [], options = { ...h.options, confirmed: true, expectedPlanHash: pinned.summary.planHash,
    onEvent: e => events.push(e), runProductionComparison: () => assert.fail('No execution in this planning slice') };
  await assert.rejects(batch().runBatch(h.config, options), { code: 'wiki_holdout_execution_not_ready' });
  await assert.rejects(require('../../scripts/badcase-capture/staged-batch.cjs').runStagedBatch(h.config, pinned, options), { code: 'wiki_holdout_execution_not_ready' });
  assert.deepEqual(events, []); assert.equal(fs.existsSync(h.config.codexAuthFile), false);
});
