const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
const api = () => require(base + 'wiki-holdout-usage');
const controls = require(base + 'wiki-gate-control');
const tokens = n => ({ input: n - 3, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: n });
function setup() {
  const h = require('../helpers/wiki-holdout-full-plan.cjs')();
  h.state.controlConfirmations = [];
  for (const number of [17, 18]) {
    const c = h.marked[number - 17], record = h.records.filter(r => r.reservation.plan.caseId === c.id).at(-1);
    record.result.runs.forEach((r, i) => r.usage = tokens((number === 17 ? 100 : 200) + i));
    const view = controls.projectWikiGateControls(h.state, h.records, h.replayChecks).find(r => r.caseId === c.id);
    h.state.controlConfirmations.push(controls.createWikiGateControlConfirmation(h.state, c.id, view.proposalHash, h.records, h.replayChecks));
  }
  h.usageInput = () => ({ state: h.state, records: h.records, replayChecks: h.replayChecks });
  return h;
}
test('trusted current control prechecks yield whole-output means including cache and all judge/worker exchanges', () => {
  const method = api(), h = setup(), before = JSON.stringify(h.usageInput()), result = method.projectWikiHoldoutUsageHistory(h.usageInput());
  assert.equal(result.length, 2); assert.deepEqual(result.map(c => c.caseId), result.map(c => c.caseId).sort());
  const trace = result.find(c => c.caseId === h.marked[0].id), run = result.find(c => c.caseId === h.marked[1].id);
  assert.equal(trace.executions, 3); assert.equal(trace.totalTokens, 303); assert.equal(trace.level, 'trace');
  assert.equal(run.executions, 5); assert.equal(run.totalTokens, 1010); assert.equal(run.level, 'run');
  assert.equal(run.caseHash, hash(h.marked[1])); assert.match(run.evidenceHash, /^[a-f0-9]{64}$/);
  const selected = require(base + 'wiki-holdout-validation').planWikiHoldoutValidation({ ...h.current(), history: result });
  assert.equal(selected.caseIds[0], run.caseId); assert.equal(selected.cases[0].tokensPerExecution, 202); assert.equal(selected.estimatedTokens, 202 * 15);
  assert.equal(JSON.stringify(h.usageInput()), before);
});
test('legacy controls without recorded token counts remain usage-unknown, never invented zero or old comparison-derived costs', () => {
  const method = api(), h = require('../helpers/wiki-holdout-full-plan.cjs')();
  assert.deepEqual(method.projectWikiHoldoutUsageHistory({ state: h.state, records: h.records, replayChecks: h.replayChecks }), []);
  assert.equal(require(base + 'wiki-holdout-validation').planWikiHoldoutValidation({ ...h.current(), history: [] }).budgetStatus, 'usage-unknown');
});
test('stale, unconfirmed, incomplete, source-changed and unsupported controls do not contribute usage', () => {
  const method = api();
  for (const mutate of [h => h.state.controlConfirmations = [], h => h.state.cases.forEach(c => c.message += ' changed'),
    h => h.replayChecks = [], h => h.state.rubrics.forEach(r => r.status = 'draft'),
    h => { for (const number of [17, 18]) h.save(number, undefined, { reserve: true, createdAt: '2026-11-11T00:00:02.000Z' }); }]) {
    const h = setup(); mutate(h); assert.deepEqual(method.projectWikiHoldoutUsageHistory(h.usageInput()), []);
  }
});
test('only the confirmed exact current result is used; no cheaper old result, native-call denominator or partial usage averaging', () => {
  const method = api(), h = setup(), selected = h.state.controlConfirmations.find(c => c.caseId === h.marked[1].id);
  const record = h.records.find(r => r.reservation.id === selected.binding.precheckId);
  // A legacy precheck record can still qualify with usageComplete=true, but a
  // missing numeric field makes this whole historical cost unknown.
  delete record.result.runs[0].usage; h.state.controlConfirmations = h.state.controlConfirmations.filter(c => c.caseId !== h.marked[1].id);
  const view = controls.projectWikiGateControls(h.state, h.records, h.replayChecks).find(r => r.caseId === h.marked[1].id);
  h.state.controlConfirmations.push(controls.createWikiGateControlConfirmation(h.state, h.marked[1].id, view.proposalHash, h.records, h.replayChecks));
  assert.deepEqual(method.projectWikiHoldoutUsageHistory(h.usageInput()).map(c => c.caseId), [h.marked[0].id]);
  const plan = require(base + 'wiki-holdout-validation').planWikiHoldoutValidation({ ...h.current(), history: method.projectWikiHoldoutUsageHistory(h.usageInput()) });
  assert.equal(plan.cases[0].caseId, h.marked[1].id); assert.equal(plan.budgetStatus, 'usage-unknown', 'run priority must not silently switch to cheaper trace');
});
test('history is deterministic under record/source ordering, binds exact evidence, and rejects overflow instead of rounding to zero', () => {
  const method = api(), h = setup(), result = method.projectWikiHoldoutUsageHistory(h.usageInput());
  h.records.reverse(); h.state.cases.reverse(); h.state.controlConfirmations.reverse(); assert.deepEqual(method.projectWikiHoldoutUsageHistory(h.usageInput()), result);
  const record = h.records.find(r => r.reservation.id === h.state.controlConfirmations[0].binding.precheckId);
  record.result.runs.forEach(r => r.usage = { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: Number.MAX_SAFE_INTEGER });
  const id = record.reservation.plan.caseId; h.state.controlConfirmations = h.state.controlConfirmations.filter(c => c.caseId !== id);
  const view = controls.projectWikiGateControls(h.state, h.records, h.replayChecks).find(c => c.caseId === id);
  h.state.controlConfirmations.push(controls.createWikiGateControlConfirmation(h.state, id, view.proposalHash, h.records, h.replayChecks));
  assert.throws(() => method.projectWikiHoldoutUsageHistory(h.usageInput()), /wiki_holdout_usage_invalid/);
});
test('host reads exact immutable prechecks, never operator JSONL/auth/ordinary comparisons; explicit validation settings are closed', t => {
  const method = require('../../scripts/badcase-capture/production-holdout-suite.cjs');
  assert.equal(typeof method.readProductionHoldoutValidationEvidence, 'function');
  const h = require('../helpers/wiki-holdout-batch.cjs')(t), id = h.marked[0].id, old = h.records.list().find(r => r.reservation.plan.caseId === id);
  const claim = h.records.reserve(old.reservation.plan); h.records.finish(claim.id, { status: 'completed', reason: null,
    runs: old.result.runs.map((r, i) => ({ ...r, status: 'pass', usage: tokens(100 + i) })) });
  const view = h.store.getGateControls().find(v => v.caseId === id);
  h.store.confirmGateControl({ caseId: id, proposalHash: view.proposalHash, expectedRevision: h.store.read().revision });
  const before = JSON.stringify(h.store.read()), recordFiles = fs.readdirSync(path.join(h.scope.globalRoot, 'original-prechecks')).map(f => [f, fs.readFileSync(path.join(h.scope.globalRoot, 'original-prechecks', f))]);
  fs.mkdirSync(path.join(h.scope.globalRoot, 'comparisons')); fs.writeFileSync(path.join(h.scope.globalRoot, 'comparisons', 'not-a-comparison.json'), 'must-not-be-opened');
  const current = method.readProductionHoldoutValidationEvidence(h.scope, h.store.read(), 'entry-6', { seed: 'fixed-validation-seed', policy: { maxEstimatedTokens: 99999 } });
  assert.deepEqual(Object.keys(current).sort(), ['state', 'records', 'replayChecks', 'targetEntryId', 'seed', 'history', 'policy'].sort());
  assert.equal(current.history.length, 1); assert.equal(current.history[0].executions, 3); assert.equal(current.history[0].totalTokens, 303);
  assert.equal(current.policy.maxEstimatedTokens, 99999); assert.equal(h.calls.length, 0); assert.equal(fs.existsSync(h.config.codexAuthFile), false);
  assert.equal(JSON.stringify(h.store.read()), before);
  for (const [f, bytes] of recordFiles) assert.deepEqual(fs.readFileSync(path.join(h.scope.globalRoot, 'original-prechecks', f)), bytes);
  for (const settings of [{ seed: '' }, { seed: 'valid', history: [] }, { seed: 'valid', policy: null }, { seed: 'valid', skippedCaseIds: ['unknown'] }])
    assert.throws(() => method.readProductionHoldoutValidationEvidence(h.scope, h.store.read(), 'entry-6', settings));
});
