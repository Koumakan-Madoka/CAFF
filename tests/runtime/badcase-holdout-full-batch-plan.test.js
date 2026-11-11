const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const fixture = require('../helpers/wiki-holdout-full-batch.cjs');
const batch = require('../../scripts/badcase-capture/batch-comparison.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
test('full trusted host plan binds canonical gate plus one measured control per other mode without mutating frozen replay categories', t => {
  const h = fixture(t), before = JSON.stringify(h.store.read()), p = h.plan();
  assert.equal(p.summary.kind, 'wiki-mode-holdout-comparison-v2'); assert.equal(p.summary.evaluation.kind, 'wikiskill-mode-holdout-v1');
  assert.equal(p.summary.experiment.kind, 'wiki-experiment-plan-v4'); assert.ok(p.summary.experiment.validation);
  assert.deepEqual(p.prepared.map(c => c.stage), ['gate', 'gate', 'validation']);
  assert.deepEqual(p.summary.evaluation.validationCaseIds, [h.marked[0].id]);
  assert.equal(p.prepared.at(-1).category, 'control'); assert.equal(p.prepared.at(-1).targetReproduction, false);
  assert.equal(p.prepared.at(-1).comparisonConfig.repeats, 5); assert.ok(p.prepared.slice(0, 2).every(c => c.comparisonConfig.repeats === 10));
  assert.deepEqual(p.summary.experiment.validation.uncovered, [{ entryId: 'entry-2', reason: 'no-confirmed-control' }]);
  assert.equal(p.summary.experiment.validation.estimatedTokens, 1500); assert.equal(p.summary.experiment.validation.budgetStatus, 'ready');
  assert.equal(Object.hasOwn(p.summary.evaluation, 'testCaseIds'), false); assert.equal(Object.hasOwn(p.summary.split, 'testCaseIds'), false);
  assert.equal(h.store.read().replayCases.find(r => r.sourceCaseId === h.marked[0].id).category, 'reproduction');
  assert.equal(JSON.stringify(h.store.read()), before); assert.equal(fs.existsSync(h.config.codexAuthFile), false); assert.equal(h.calls.length, 3);
  h.config.experiment.plan = p.summary.experiment; assert.deepEqual(h.plan().summary.experiment, p.summary.experiment);
});
test('run validation is preferred despite higher cost, uses one frozen request per attempt and keeps stage-specific repeats', t => {
  const h = fixture(t); h.makeRun24(); const run = h.run18(), p = h.plan(), c = p.prepared.at(-1);
  assert.equal(c.stage, 'validation'); assert.equal(c.execution.level, 'run'); assert.equal(c.sourceCaseId, run.id); assert.equal(c.split, 'gate');
  assert.equal(c.comparisonConfig.repeats, 5); assert.equal(c.comparisonConfig.scoring.task, run.task); assert.equal(c.comparisonConfig.caseId, run.id);
  assert.notEqual(c.comparisonConfig.originalRequestHash, c.comparisonConfig.candidateRequestHash);
  assert.deepEqual(p.summary.evaluation.validationCaseIds, [run.id]); assert.equal(p.summary.experiment.validation.estimatedTokens, 3000);
  assert.equal(p.summary.experiment.cases.at(-1).execution.traceBundleHash, run.item().traceBundle.hash);
  assert.equal(p.summary.experiment.cases.at(-1).execution.dehydrationHash, run.decision.hash);
});
test('configurable validation repeats/threshold/token limit are bound, while gate remains ten outputs per version', t => {
  const h = fixture(t); h.config.evaluation.validation.policy = { repeats: 3, degradationThreshold: 1, maxEstimatedTokens: 2000 };
  const p = h.plan(); assert.equal(p.summary.experiment.validation.policy.repeats, 3); assert.equal(p.prepared.at(-1).comparisonConfig.repeats, 3);
  assert.equal(p.summary.experiment.validation.policy.degradationThreshold, 1); assert.equal(p.summary.experiment.validation.estimatedTokens, 1100);
  assert.equal(p.summary.repeats, 10); assert.ok(p.prepared.slice(0, 2).every(c => c.comparisonConfig.repeats === 10));
});
test('over-limit plan stops validation rather than silently dropping controls; explicit skip creates uncovered mode and changes confirmation', t => {
  const h = fixture(t), p = h.plan(); h.config.evaluation.validation.policy = { maxEstimatedTokens: 1499 };
  const over = h.plan(); assert.equal(over.summary.experiment.validation.budgetStatus, 'over-limit'); assert.equal(over.prepared.length, 3);
  assert.notEqual(over.summary.planHash, p.summary.planHash);
  h.config.evaluation.validation.skippedCaseIds = [h.marked[0].id]; h.sync(); const skipped = h.plan();
  assert.equal(skipped.summary.experiment.validation.budgetStatus, 'ready'); assert.equal(skipped.prepared.length, 2);
  assert.deepEqual(skipped.summary.experiment.validation.uncovered[0], { entryId: 'entry-1', reason: 'operator-skipped' });
  assert.notEqual(skipped.summary.experiment.planHash, over.summary.experiment.planHash);
});
test('legacy confirmed controls without numeric historical usage stay inspectably unknown and are not estimated as free', t => {
  const h = fixture(t), id = h.marked[0].id;
  h.mutate(s => s.controlConfirmations = []);
  const old = h.records.list().find(r => r.reservation.plan.caseId === id), claim = h.records.reserve(old.reservation.plan);
  h.records.finish(claim.id, { status: 'completed', reason: null, runs: old.result.runs.map(({ usage, ...r }) => ({ ...r, status: 'pass' })) });
  h.confirm(id); h.sync(); const p = h.plan();
  assert.equal(p.summary.experiment.validation.estimatedTokens, null); assert.equal(p.summary.experiment.validation.budgetStatus, 'usage-unknown');
  assert.deepEqual(p.summary.evaluation.validationCaseIds, [id]); assert.equal(fs.existsSync(h.config.codexAuthFile), false);
});
test('no controls leaves every other approved mode uncovered without borrowing target-mode or unconfirmed holdouts', t => {
  const h = fixture(t); h.mutate(s => s.controlConfirmations = []); h.sync(); const p = h.plan();
  assert.equal(p.prepared.length, 2); assert.equal(p.summary.experiment.validation.estimatedTokens, 0);
  assert.deepEqual(p.summary.experiment.validation.uncovered.map(c => c.entryId), ['entry-1', 'entry-2']);
});
test('caller cannot omit selected controls, add all controls/training/other mode tasks, duplicate identities or relabel stages', t => {
  for (const mutate of [h => h.config.cases.pop(), h => h.config.cases.push({ ...h.config.cases.at(-1), sourceCaseId: h.marked[1].id }),
    h => h.config.cases.push({ ...h.config.cases.at(-1), sourceCaseId: h.marked[5].id }), h => h.config.cases.at(-1).category = 'reproduction',
    h => h.config.cases.push(h.config.cases.at(-1)), h => h.config.experiment.definition.cases.pop(),
    h => h.config.experiment.definition.cases.at(-1).stage = 'validation']) {
    const h = fixture(t); mutate(h); assert.throws(h.plan); assert.equal(h.calls.length, 0);
  }
});
test('stale control binding or selection/policy/coverage drift rejects pinned full plan before comparison preparation', t => {
  for (const mutate of [h => h.mutate(s => s.cases.find(c => c.id === h.marked[0].id).message += 'changed'),
    h => h.config.evaluation.validation.policy = { degradationThreshold: 1 },
    h => h.config.evaluation.validation.seed = 'other-fixed-seed', h => h.mutate(s => s.versions[0].entries.find(e => e.id === 'entry-2').status = 'draft'),
    h => h.records.reserve(h.records.list().find(r => r.reservation.plan.caseId === h.marked[0].id).reservation.plan)]) {
    const h = fixture(t); h.config.experiment.plan = h.plan().summary.experiment; h.calls.length = 0; mutate(h);
    assert.throws(h.plan); assert.equal(h.calls.length, 0);
  }
});
test('evidence drift during preparation refuses a full stale plan instead of retaining old control evidence', t => {
  const h = fixture(t), prepare = h.options.prepareProductionComparison; let changed = false;
  h.options.prepareProductionComparison = c => { const result = prepare(c); if (!changed) {
    changed = true; h.records.reserve(h.records.list().find(r => r.reservation.plan.caseId === h.marked[0].id).reservation.plan);
  } return result; };
  assert.throws(h.plan, { code: 'wiki_experiment_changed' });
});
test('fresh snapshot is re-read after preflight so mid-prepare source or mode changes cannot publish stale selection', t => {
  for (const mutate of [s => s.cases.find(c => c.id === s.controlConfirmations[0].caseId).message += ' changed',
    s => s.versions[0].entries.find(e => e.id === 'entry-2').status = 'draft']) {
    const h = fixture(t), prepare = h.options.prepareProductionComparison; let changed = false;
    h.options.prepareProductionComparison = c => { const result = prepare(c); if (!changed) { changed = true; h.mutate(mutate); } return result; };
    assert.throws(h.plan, { code: 'wiki_experiment_changed' });
  }
});
test('full evaluation cannot silently downgrade to gate-only, legacy or caller-supplied historical usage', t => {
  for (const mutate of [h => delete h.config.experiment, h => h.config.experiment.definition.kind = 'wiki-experiment-v2',
    h => h.config.evaluation.validation.history = [], h => h.config.evaluation.validation.policy = { repeats: 0 },
    h => h.config.evaluation.extra = true, h => h.config.experiment.plan = { kind: 'wiki-experiment-plan-v3' },
    h => h.config.evaluation.kind = 'wikiskill-holdout-gate-v1']) {
    const h = fixture(t); mutate(h); assert.throws(h.plan); assert.equal(h.calls.length, 0);
  }
});
test('full kernel requires a pinned confirmation and CLI remains disabled until progress/publication is ready', async t => {
  const h = fixture(t), p = h.plan(), events = [];
  const options = { ...h.options, confirmed: true, expectedPlanHash: p.summary.planHash, onEvent: e => events.push(e),
    runProductionComparison: () => assert.fail('No execution before exact confirmation'), runProductionRunComparison: () => assert.fail('No run execution before exact confirmation') };
  await assert.rejects(batch.runBatch(h.config, options), { code: 'wiki_experiment_confirmation_required' });
  await assert.rejects(require('../../scripts/badcase-capture/staged-batch.cjs').runStagedBatch(h.config, p, options), { code: 'wiki_experiment_confirmation_required' });
  h.config.experiment.plan = p.summary.experiment; const pinned = h.plan(); options.expectedPlanHash = pinned.summary.planHash;
  const file = path.join(h.root, 'full-config.json'), output = path.join(h.root, 'must-not-create.jsonl'); fs.writeFileSync(file, JSON.stringify(h.config));
  await assert.rejects(require('../../scripts/badcase-capture/compare-wiki-batch.cjs').main(['--config', file, '--run', '--confirmed', '--expected-plan', pinned.summary.planHash, '--output', output], options), { code: 'wiki_holdout_validation_publication_not_ready' });
  assert.deepEqual(events, []); assert.equal(fs.existsSync(output), false); assert.equal(fs.existsSync(h.config.codexAuthFile), false);
  assert.equal(fs.existsSync(path.join(h.scope.globalRoot, 'batch-executions')), false); assert.equal(fs.existsSync(path.join(h.scope.globalRoot, 'comparisons')), false);
});
