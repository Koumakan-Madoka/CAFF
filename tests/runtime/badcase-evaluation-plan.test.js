const test = require('node:test');
const assert = require('node:assert/strict');
const { planEvaluation, createEvaluationLedger } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const h = n => String(n).repeat(64);
function spec() {
  return { caseId: 'case-1', checkpointHash: h(1), inputHash: h(2), environmentHash: h(3),
    harnessHash: h(4), roleId: 'single-role', baselineRoleHash: h(5), candidateRoleHash: h(6),
    model: { provider: 'test-provider', id: 'test-model', settingsHash: h(7) },
    evaluator: { id: 'reviewed-rule', versionHash: h(8) },
    repetitions: 2, timeoutMs: 1000, perRunLimitMicroUsd: 10, totalLimitMicroUsd: 40 };
}
function approval(plan, extra = {}) { return { confirmed: true, planHash: plan.planHash, approvalId: 'manual-1', expiresAt: 10000, ...extra }; }
function setup(s = spec()) { const p = planEvaluation(s); return { p, ledger: createEvaluationLedger(p, approval(p), 1) }; }
function outcome(run, extra = {}) { return { runId: run.runId, status: 'completed', costMicroUsd: 4,
  outputHash: h(9), score: { expectationMet: false, badcaseReproduced: true }, ...extra }; }

test('stable normalized plan pins one common start and changes only role hash between variants', () => {
  const s = spec(), p = planEvaluation(s);
  assert.equal(p.planHash, planEvaluation(Object.fromEntries(Object.entries(s).reverse())).planHash);
  assert.deepEqual(p.runs.map(r => [r.variant, r.repetition]), [['baseline', 1], ['candidate', 1], ['baseline', 2], ['candidate', 2]]);
  assert.equal(new Set(p.runs.map(r => r.commonHash)).size, 1);
  assert.equal(new Set(p.runs.map(r => r.runId)).size, 4);
  assert.equal(p.runs[0].roleHash, s.baselineRoleHash); assert.equal(p.runs[1].roleHash, s.candidateRoleHash);
  s.model.id = 'changed'; assert.equal(p.spec.model.id, 'test-model');
});
test('schema rejects extra keys, malformed hashes, invalid limits and nested model options', () => {
  for (const change of [s => s.productionUrl = 'x', s => s.inputHash = 'bad', s => s.model.apiKey = 'never archive',
    s => s.repetitions = 0, s => s.repetitions = 101, s => s.timeoutMs = Infinity, s => s.perRunLimitMicroUsd = 0,
    s => s.totalLimitMicroUsd = 0, s => s.totalLimitMicroUsd = Number.MAX_SAFE_INTEGER + 1, s => s.evaluator.versionHash = null]) {
    const s = spec(); change(s); assert.throws(() => planEvaluation(s), /evaluation_plan_invalid/);
  }
});
test('approval must bind exact plan; no absent, expired or self-modified approval accepted', () => {
  const p = planEvaluation(spec());
  for (const a of [null, approval(p, { confirmed: false }), approval(p, { planHash: h(0) }), approval(p, { expiresAt: 1 }),
    approval(p, { extra: true })]) assert.throws(() => createEvaluationLedger(p, a, 1), /evaluation_approval_invalid/);
  for (const key of ['inputHash', 'baselineRoleHash', 'candidateRoleHash', 'environmentHash', 'harnessHash']) {
    const s = spec(); s[key] = h(9); assert.throws(() => createEvaluationLedger(planEvaluation(s), approval(p), 1));
  }
  for (const change of [s => s.model.id = 'other', s => s.model.settingsHash = h(0), s => s.evaluator.versionHash = h(0),
    s => s.repetitions = 3, s => s.timeoutMs = 2000, s => s.perRunLimitMicroUsd = 11, s => s.totalLimitMicroUsd = 41]) {
    const s = spec(); change(s); assert.throws(() => createEvaluationLedger(planEvaluation(s), approval(p), 1));
  }
  const changed = structuredClone(p); changed.runs[0].roleHash = h(9);
  assert.throws(() => createEvaluationLedger(changed, approval(p), 1), /evaluation_plan_invalid/);
});
test('reserve before start, one in flight; no reused run IDs or mutable return references', () => {
  const { ledger } = setup(), r = ledger.reserve(2);
  assert.throws(() => ledger.reserve(3), /evaluation_run_active/);
  assert.throws(() => ledger.settle(outcome({ runId: 'wrong' })), /evaluation_result_invalid/);
  const original = r.runId; r.runId = 'edited'; r.roleHash = h(0);
  ledger.settle(outcome({ runId: original }));
  assert.throws(() => ledger.settle(outcome({ runId: original })), /evaluation_result_invalid/);
  assert.notEqual(ledger.reserve(4).runId, original);
});
test('complete report preserves all outcomes and separate baseline/candidate reproduction denominators', () => {
  const { ledger, p } = setup();
  for (let i = 0; i < 4; i++) {
    const r = ledger.reserve(i + 2);
    ledger.settle(outcome(r, { score: { expectationMet: i % 2 === 1, badcaseReproduced: i % 2 === 0 } }));
  }
  const report = ledger.report();
  assert.equal(report.state, 'complete'); assert.equal(report.planHash, p.planHash);
  assert.equal(report.knownCostMicroUsd, 16); assert.equal(report.committedMicroUsd, 16);
  assert.deepEqual(report.summary, { baseline: { attempted: 2, scored: 2, reproduced: 2, expectationMet: 0 }, candidate: { attempted: 2, scored: 2, reproduced: 0, expectationMet: 2 } });
  assert.equal(report.executionVerified, false); assert.equal(report.strictEvalEligible, false);
  report.runs[0].score.badcaseReproduced = false;
  assert.equal(ledger.report().runs[0].score.badcaseReproduced, true);
  assert.throws(() => ledger.reserve(9), /evaluation_stopped/);
});
test('budget is reserved at worst-case cost, not optimistic reported average', () => {
  const s = spec(); s.totalLimitMicroUsd = 13;
  const { ledger } = setup(s), r = ledger.reserve(2);
  assert.equal(ledger.report().committedMicroUsd, 10);
  ledger.settle(outcome(r));
  assert.equal(ledger.reserve(3), null);
  assert.equal(ledger.report().stopReason, 'budget_exhausted');
  assert.equal(ledger.report().runs.length, 1);
});
test('unknown costs retain full reservation and stop, never convert missing cost to zero', () => {
  const { ledger } = setup(), r = ledger.reserve(2);
  ledger.settle(outcome(r, { costMicroUsd: null }));
  const report = ledger.report();
  assert.equal(report.stopReason, 'cost_unknown'); assert.equal(report.committedMicroUsd, 10);
  assert.equal(report.unknownCostRuns, 1); assert.equal(report.knownCostMicroUsd, 0);
  assert.throws(() => ledger.reserve(3), /evaluation_stopped/);
});
test('overspend is reported honestly, halts next run and does not clamp observed cost', () => {
  const { ledger } = setup(), r = ledger.reserve(2);
  ledger.settle(outcome(r, { costMicroUsd: 99 }));
  assert.equal(ledger.report().stopReason, 'cost_limit_exceeded');
  assert.equal(ledger.report().knownCostMicroUsd, 99);
  assert.throws(() => ledger.reserve(3));
});
test('failed and timed out attempts remain in denominator without invented scores', () => {
  for (const status of ['failed', 'timed_out', 'cancelled']) {
    const { ledger } = setup(), r = ledger.reserve(2);
    ledger.settle(outcome(r, { status, outputHash: null, score: null }));
    assert.equal(ledger.report().stopReason, 'run_' + status);
    assert.deepEqual(ledger.report().summary.baseline, { attempted: 1, scored: 0, reproduced: 0, expectationMet: 0 });
  }
});
test('malformed result leaves reservation active for trusted launcher reconciliation', () => {
  for (const change of [o => o.score = null, o => o.costMicroUsd = -1, o => o.costMicroUsd = NaN,
    o => o.costMicroUsd = 0.5, o => o.outputHash = 'bad', o => o.stdout = 'secret',
    o => o.score.expectationMet = 1, o => o.status = 'failed']) {
    const { ledger } = setup(), r = ledger.reserve(2), o = outcome(r); change(o);
    assert.throws(() => ledger.settle(o), /evaluation_result_invalid/);
    assert.equal(ledger.report().state, 'reserved'); assert.equal(ledger.report().committedMicroUsd, 10);
  }
});
test('approval expires before next reservation, not retroactively on accounting', () => {
  const { ledger } = setup(), r = ledger.reserve(2); ledger.settle(outcome(r));
  assert.equal(ledger.reserve(10000), null);
  assert.equal(ledger.report().stopReason, 'approval_expired');
});
