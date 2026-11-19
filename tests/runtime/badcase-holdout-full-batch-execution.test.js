const test = require('node:test'), assert = require('node:assert/strict');
const fixture = require('../helpers/wiki-holdout-full-batch.cjs'), execution = require('../helpers/wiki-holdout-full-execution.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
test('full kernel routes pooled 0→6 + 0→0 gate before validation; reports stage-specific counts and partial coverage', async t => {
  const h = fixture(t), e = execution(h), before = JSON.stringify(h.store.read()), r = await e.run();
  assert.equal(r.kind, 'wiki-mode-holdout-comparison-v2'); assert.equal(r.gateDecision.outcome, 'accepted'); assert.equal(r.outcome, 'validation-partial-coverage');
  assert.equal(r.adoptionEligible, true); assert.equal(r.completed, true); assert.equal(r.modelCallsKnown, 50); assert.equal(r.callsUnavailable, false);
  assert.deepEqual(e.executions.map(c => [c.stage, c.repeats]), [['gate', 10], ['gate', 10], ['validation', 5]]);
  assert.equal(r.byStage.gate.original.planned, 20); assert.equal(r.byStage.validation.original.planned, 5);
  assert.equal(r.validation.cases[0].original.passed, 5); assert.equal(r.validation.cases[0].candidate.passed, 5);
  assert.deepEqual(r.validation.uncovered.map(c => c.entryId), ['entry-2']); assert.equal(JSON.stringify(h.store.read()), before);
  const gateIndex = e.events.findIndex(e => e.event === 'gate_decision'), validationIndex = e.events.findIndex(e => e.event === 'run_start' && e.stage === 'validation');
  assert.ok(gateIndex >= 0 && validationIndex > gateIndex); assert.equal(e.events.filter(e => e.event === 'batch_summary').length, 1);
});
test('gate rejection retains untouched validation slots and never starts their fake executor or reads credentials', async t => {
  const h = fixture(t), e = execution(h, { gateCandidatePasses: 0 }), r = await e.run();
  assert.equal(r.gateDecision.outcome, 'rejected'); assert.equal(r.outcome, 'gate-rejected'); assert.equal(r.completed, true); assert.equal(r.adoptionEligible, false);
  assert.equal(e.executions.length, 2); assert.equal(r.cases.at(-1).status, 'not-run'); assert.equal(r.cases.at(-1).runs.length, 0);
  assert.equal(r.validation.status, 'not-run'); assert.equal(r.byStage.validation.original.notRun, 5); assert.equal(r.modelCallsKnown, 40);
});
for (const [loss, outcome, eligible] of [[1, 'validation-partial-coverage', true], [2, 'validation-degraded', false]]) test(`validation ${loss}-pass loss yields ${outcome}, independent of pooled gate improvement`, async t => {
  const e = execution(fixture(t), { validationLoss: loss }), r = await e.run();
  assert.equal(r.outcome, outcome); assert.equal(r.validation.cases[0].loss, loss); assert.equal(r.validation.cases[0].degraded, !eligible);
  assert.equal(r.adoptionEligible, eligible); assert.equal(r.completed, true);
});
test('first degraded control stops later trace/run controls without extra requests, preserving not-run reason and a completed degraded decision', async t => {
  for (const run of [false, true]) {
    const h = fixture(t); h.twoControls(); if (run) h.run18();
    const e = execution(h, { validationLoss: 2 }), r = await e.run();
    assert.deepEqual(e.executions.map(c => c.caseId), [...r.evaluation.gateCaseIds, h.marked[0].id]);
    assert.equal(r.outcome, 'validation-degraded'); assert.equal(r.completed, true); assert.equal(r.adoptionEligible, false);
    assert.equal(r.modelCallsKnown, 50); assert.equal(r.callsUnavailable, false);
    const skipped = r.cases.at(-1); assert.equal(skipped.sourceCaseId, h.marked[1].id);
    assert.equal(skipped.status, 'not-run'); assert.equal(skipped.reason, 'wiki_validation_prior_degradation');
    assert.deepEqual(skipped.runs, []); assert.equal(skipped.modelCallsKnown, 0);
    assert.equal(r.validation.cases[0].degraded, true); assert.equal(r.validation.cases[1].degraded, null);
    assert.equal(r.validation.cases[1].status, 'not-run'); assert.equal(r.byStage.validation.original.notRun, 5);
    assert.equal(e.events.filter(c => c.event === 'case_summary' && c.reason === 'wiki_validation_prior_degradation').length, 1);
  }
});
test('one-pass fluctuation does not stop later validation; configured one-loss threshold does', async t => {
  for (const threshold of [2, 1]) {
    const h = fixture(t); h.twoControls(); h.config.evaluation.validation.policy = { degradationThreshold: threshold };
    const e = execution(h, { validationLoss: 1 }), r = await e.run();
    assert.equal(e.executions.length, threshold === 2 ? 4 : 3); assert.equal(r.completed, true);
    assert.equal(r.outcome, threshold === 2 ? 'validation-passed' : 'validation-degraded');
    assert.equal(r.adoptionEligible, threshold === 2);
  }
});
test('technical failure with later controls stops as incomplete, never disguised as decisive degradation', async t => {
  const h = fixture(t); h.twoControls(); const e = execution(h);
  e.options.runProductionComparison = async (c, o) => {
    if (c.scoring.rubric.caseId === h.marked[0].id) throw Error('Synthetic validation failure');
    return e.compare(c, o);
  };
  const r = await e.run(); assert.equal(r.outcome, 'indeterminate'); assert.equal(r.completed, false); assert.equal(r.adoptionEligible, false);
  assert.equal(r.validation.status, 'incomplete'); assert.equal(r.cases.at(-1).status, 'not-run');
  assert.equal(r.cases.at(-1).reason, 'prior_integrity_error'); assert.equal(r.modelCallsKnown, 40);
  assert.equal(e.executions.length, 2); assert.equal(r.callsUnavailable, true);
});
test('configured three-output validation and one-loss threshold are honored by the execution dispatcher', async t => {
  const h = fixture(t); h.config.evaluation.validation.policy = { repeats: 3, degradationThreshold: 1 }; const e = execution(h, { validationLoss: 1 }), r = await e.run();
  assert.equal(r.outcome, 'validation-degraded'); assert.equal(r.validation.cases[0].original.total, 3); assert.equal(r.byStage.validation.original.planned, 3);
  assert.equal(e.executions.at(-1).repeats, 3); assert.equal(r.modelCallsKnown, 46);
});
test('run-level targets and controls route to single-call kernel with five outputs per validation arm; per-level stats remain separate', async t => {
  const h = fixture(t); h.makeRun24(); h.run18(); const e = execution(h), r = await e.run();
  assert.deepEqual(e.executions.map(c => [c.stage, c.level]), e.pinned.prepared.map(c => [c.stage, c.execution?.level ?? 'trace']));
  assert.deepEqual(e.executions.slice(0, 2).map(c => c.level).sort(), ['run', 'trace']); assert.equal(e.executions.at(-1).level, 'run');
  assert.equal(r.gateDecision.byLevel.run.original.total, 10); assert.equal(r.gateDecision.byLevel.trace.original.total, 10);
  assert.equal(r.validation.byLevel.run.original.total, 5); assert.equal(r.validation.byLevel.trace.original.total, 0); assert.equal(r.adoptionEligible, true);
});
test('over-limit estimate blocks validation after a passed gate with no automatic skip, substitution or extra request', async t => {
  const h = fixture(t); h.config.evaluation.validation.policy = { maxEstimatedTokens: 1499 }; const e = execution(h), r = await e.run();
  assert.equal(r.gateDecision.outcome, 'accepted'); assert.equal(r.outcome, 'indeterminate'); assert.equal(r.validation.status, 'over-limit');
  assert.equal(r.completed, false); assert.equal(r.adoptionEligible, false); assert.equal(e.executions.length, 2); assert.equal(r.modelCallsKnown, 40);
  assert.equal(r.cases.at(-1).reason, 'validation_token_estimate_exceeded'); assert.equal(r.cases.at(-1).runs.length, 0);
});
test('unknown historical usage also blocks validation rather than spending or silently switching to another control', async t => {
  const h = fixture(t), id = h.marked[0].id; h.mutate(s => s.controlConfirmations = []);
  const old = h.records.list().find(r => r.reservation.plan.caseId === id), claim = h.records.reserve(old.reservation.plan);
  h.records.finish(claim.id, { status: 'completed', reason: null, runs: old.result.runs.map(({ usage, ...r }) => ({ ...r, status: 'pass' })) });
  h.confirm(id); h.sync(); const e = execution(h), r = await e.run();
  assert.equal(r.validation.status, 'usage-unknown'); assert.equal(r.outcome, 'indeterminate'); assert.equal(r.cases.at(-1).reason, 'validation_usage_unknown');
  assert.equal(r.adoptionEligible, false); assert.equal(e.executions.length, 2); assert.equal(r.modelCallsKnown, 40);
});
test('explicit operator skip produces uncovered results without replacement; zero controls does not fabricate validation output', async t => {
  const h = fixture(t); h.config.evaluation.validation.skippedCaseIds = [h.marked[0].id]; h.sync(); const e = execution(h), r = await e.run();
  assert.equal(r.outcome, 'validation-uncovered'); assert.equal(r.adoptionEligible, true); assert.equal(r.validation.cases.length, 0); assert.equal(e.executions.length, 2);
  assert.equal(r.validation.uncovered[0].reason, 'operator-skipped'); assert.equal(r.completed, true);
});
test('invalid/error replacements are outside validation denominators and counted by level', async t => {
  const h = fixture(t); h.run18(); const e = execution(h, { prefixes: { [h.marked[1].id]: ['invalid', 'error'] } }), r = await e.run();
  assert.equal(r.completed, true); assert.equal(r.validation.cases[0].original.total, 5); assert.equal(r.validation.cases[0].candidate.total, 5);
  assert.equal(r.validation.byLevel.run.original.invalid, 1); assert.equal(r.validation.byLevel.run.candidate.errors, 1); assert.equal(r.modelCallsKnown, 52);
});
test('fatal or incomplete gate stops later gate/validation work, preserves known observations and marks unknown calls', async t => {
  const h = fixture(t), e = execution(h); let sent = 0;
  e.options.runProductionComparison = async (_config, options) => { sent++; options.onEvent({ event: 'model_call', variant: 'original', iteration: 1, model: h.config.modelProfile }); throw Object.assign(Error('private failure'), { code: 'evaluation_codex_auth_failed' }); };
  const r = await e.run(); assert.equal(sent, 1); assert.equal(r.completed, false); assert.equal(r.outcome, 'indeterminate'); assert.equal(r.adoptionEligible, false);
  assert.equal(r.callsUnavailable, true); assert.equal(r.modelCallsKnown, 1); assert.equal(r.cases[0].reason, 'evaluation_codex_auth_failed'); assert.equal(r.cases.at(-1).status, 'not-run');
  assert.ok(!JSON.stringify(r).includes('private failure'));
});
test('D8 dispatcher consumes batch5-shaped judge error without a new worker, but never pads validation or fatal cases', async t => {
  for(const scenario of ['gate','validation','fatal']){
    const h=fixture(t),e=execution(h),id=scenario==='validation'?e.pinned.summary.evaluation.validationCaseIds[0]:e.pinned.summary.evaluation.gateCaseIds[0];
    const convert=row=>row.variant==='candidate'&&row.iteration===3?{...row,...require('../fixtures/wikiskill-judge-shortfall.json')}:row;
    e.options.runProductionComparison=async(c,o)=>{
      if(c.scoring.rubric.caseId!==id)return e.compare(c,o);
      const r=await e.compare(c,{...o,onEvent:event=>o.onEvent(event.event==='run'?convert(event):event)});
      return {...r,completed:false,fatal:scenario==='fatal',runs:r.runs.map(convert)};
    };
    const r=await e.run();
    assert.equal(r.cases.find(c=>c.sourceCaseId===id).runs.filter(r=>r.reason==='judge_backend_failed').length,1);
    if(scenario==='gate'){
      assert.equal(r.completed,true);assert.equal(r.gateDecision.outcome,'accepted');assert.equal(r.gateDecision.imputation.total,1);
      assert.equal(r.modelCallsKnown,50,'no replacement worker/judge calls are added by padding');
      assert.equal(r.cases[0].totals.candidate.scored,9);assert.equal(r.cases[0].totals.candidate.errors,1);
    }else{
      assert.equal(r.completed,false);assert.equal(r.outcome,'indeterminate');assert.equal(r.adoptionEligible,false);
      assert.equal(r.gateDecision.imputation.total,0);assert.equal(r.cases.find(c=>c.sourceCaseId===id).status,'error');
    }
  }
});
test('validation technical failure after an accepted gate is indeterminate, not a no-degradation pass', async t => {
  const h = fixture(t), e = execution(h), id = e.pinned.summary.evaluation.validationCaseIds[0];
  e.options.runProductionComparison = async (c, o) => {
    if (c.scoring.rubric.caseId !== id) return e.compare(c, o);
    o.onEvent({ event: 'model_call', variant: 'original', iteration: 1, model: h.config.modelProfile }); throw Error('private validation failure');
  };
  const r = await e.run(); assert.equal(r.gateDecision.outcome, 'accepted'); assert.equal(r.validation.status, 'incomplete'); assert.equal(r.outcome, 'indeterminate');
  assert.equal(r.adoptionEligible, false); assert.equal(r.completed, false); assert.equal(r.modelCallsKnown, 41); assert.equal(r.callsUnavailable, true);
  assert.equal(r.cases.at(-1).reason, 'case_execution_failed'); assert.ok(!JSON.stringify(r).includes('private validation failure'));
});
test('current confirmation or source drift between cases refuses further execution before spending validation tokens', async t => {
  for (const mutate of [h => h.records.reserve(h.records.list().find(r => r.reservation.plan.caseId === h.marked[0].id).reservation.plan),
    h => h.mutate(s => s.cases.find(c => c.id === h.marked[0].id).message += 'changed')]) {
    const h = fixture(t), e = execution(h); let sent = 0;
    e.options.runProductionComparison = async (...args) => { const measured = await e.compare(...args); if (++sent === 1) mutate(h); return measured; };
    const r = await e.run(); assert.equal(sent, 1); assert.equal(r.outcome, 'indeterminate'); assert.equal(r.adoptionEligible, false); assert.equal(r.cases.at(-1).status, 'not-run');
  }
});
test('fresh direct staged inputs and exact confirmation are mandatory before any event/model dispatch', async t => {
  const h = fixture(t), e = execution(h), direct = require('../../scripts/badcase-capture/staged-batch.cjs').runStagedBatch;
  const p = structuredClone(e.pinned); p.prepared[0].comparisonConfig.scoring.task += 'substitution';
  await assert.rejects(direct(h.config, p, e.options), { code: 'evaluation_batch_input_changed' }); assert.deepEqual(e.events, []); assert.deepEqual(e.executions, []);
  await assert.rejects(require('../../scripts/badcase-capture/batch-comparison.cjs').runBatch(h.config, { ...e.options, expectedPlanHash: hash('wrong') }), { code: 'evaluation_batch_confirmation_required' });
});
for (const reason of ['evaluation_codex_proxy_failed', 'evaluation_codex_gateway_unavailable', 'evaluation_codex_server_overloaded']) test(`batch3 unknown replacement ${reason} completes scoring without hiding unknown usage or stopping later cases`, async t => {
  const h=fixture(t),e=require('../helpers/wiki-holdout-unknown-replacement.cjs')(h,reason),r=await e.run();
  assert.equal(r.cases[0].status,'completed'); assert.equal(r.cases[0].callsUnavailable,true);
  assert.equal(r.cases[0].totals.candidate.errors,1); assert.equal(r.cases[0].totals.candidate.scored,10);
  assert.equal(r.completed,true); assert.equal(r.callsUnavailable,true); assert.equal(r.adoptionEligible,true);
  assert.match(require('../../scripts/badcase-capture/holdout-validation-batch.cjs').formatHoldoutValidationBatch(r),/用量不完整/);
  assert.equal(e.executions.length,3); assert.equal(r.modelCallsKnown,50);
  const row=r.cases[0].runs.find(row=>row.status==='error');
  assert.equal(row.reason,reason); assert.equal(row.tokenUsage.complete,false); assert.equal(row.tokenUsage.knownTokens,null);
});
test('batch3 unavailable calls outside recoverable error replacements still stop the full kernel', async t => {
  for(const fault of ['auth','unexplained','valid-row','missing-row-usage','unclean','fatal','call-count']){
    const h=fixture(t),e=require('../helpers/wiki-holdout-unknown-replacement.cjs')(h),compare=e.options.runProductionComparison;
    e.options.runProductionComparison=async(...args)=>{const r=await compare(...args),bad=r.runs.find(row=>row.status==='error');
      if(fault==='auth')bad.reason='evaluation_codex_access_expired';
      if(fault==='unexplained')bad.tokenUsage.callsUnavailable=false;
      if(fault==='valid-row')r.runs[0].tokenUsage={...bad.tokenUsage};
      if(fault==='missing-row-usage')delete r.runs[0].tokenUsage;
      if(fault==='unclean')bad.cleaned=false;
      if(fault==='fatal')r.fatal=true;
      if(fault==='call-count')r.modelCallsKnown--;
      return r;};
    const r=await e.run(); assert.equal(r.cases[0].status,'error',fault); assert.equal(r.completed,false,fault);
    assert.equal(r.cases[1].status,'not-run',fault); assert.equal(r.adoptionEligible,false,fault);
  }
});
test('malformed schedules, fatal or unknown/mismatched call accounting cannot claim completion or enable adoption', async t => {
  for (const fault of ['schedule', 'fatal', 'unknown-calls', 'call-count']) {
    const h = fixture(t), e = execution(h); let sent = 0;
    e.options.runProductionComparison = async (...args) => { sent++; const r = await e.compare(...args);
      if (fault === 'schedule') r.runs[0].iteration = 2; else if (fault === 'fatal') r.fatal = true;
      else if (fault === 'unknown-calls') r.callsUnavailable = true; else r.modelCallsKnown--;
      return r; };
    const r = await e.run(); assert.equal(sent, 1); assert.equal(r.outcome, 'indeterminate'); assert.equal(r.completed, false); assert.equal(r.adoptionEligible, false); assert.equal(r.callsUnavailable, true);
  }
});
