const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('../helpers/wiki-holdout-batch.cjs');
const base='../../build/server/domain/runtime/badcase-capture/';
const {wikiValueHash:hash}=require(base+'wiki-rubric');
const batch=()=>require('../../scripts/badcase-capture/batch-comparison.cjs');
function execution(h,{candidatePasses=6,prefix=[]}={}){
 h.config.experiment.plan=h.plan().summary.experiment;
 const pinned=h.plan(),events=[],calls=[];
 const compare=async(c,o)=>{
  calls.push({c,o});o.onEvent({event:'plan',runtimeHash:hash('synthetic runtime')});
  const rows=[],attempts={original:0,candidate:0},valid={original:0,candidate:0};let next='original';
  while(valid.original<10||valid.candidate<10){
   if(valid[next]===10)next=next==='original'?'candidate':'original';
   const variant=next,iteration=++attempts[variant],status=prefix[rows.length]||
    (variant==='candidate'&&valid[variant]<candidatePasses&&(c.kind==='wikiskill-run-comparison-v1'||c.scoring.rubric.caseId===pinned.prepared[0].sourceCaseId)?'pass':'fail');
   if(['pass','fail'].includes(status))valid[variant]++;
   const row={variant,iteration,status,replySource:'public',cleaned:true,modelCalls:[{model:h.config.modelProfile,success:true}]};
   rows.push(row);o.onEvent({event:'run_start',variant,iteration});o.onEvent({event:'model_call',variant,iteration,model:h.config.modelProfile});o.onEvent({event:'run',...row});
   next=next==='original'?'candidate':'original';
  }
  return {completed:true,runs:rows,modelCallsKnown:rows.length,callsUnavailable:false};
 };
 const options={...h.options,confirmed:true,expectedPlanHash:pinned.summary.planHash,onEvent:e=>events.push(e),
  runProductionComparison:compare,runProductionRunComparison:compare,readKey:()=>assert.fail('No credential read')};
 return {pinned,events,calls,compare,options,run:()=>batch().runBatch(h.config,options)};
}
test('public trusted batch route executes v4 pooled gate 0→6 + 0→0 without legacy controls, no-harm or a test stage',async t=>{
 const h=fixture(t),f=execution(h),before=JSON.stringify(h.store.read()),r=await f.run();
 assert.equal(r.kind,'wiki-mode-holdout-comparison-v1');assert.equal(r.gateDecision.outcome,'accepted');
 assert.equal(r.gateDecision.repair.candidate.passed,6);assert.equal(r.gateDecision.repair.original.total,20);
 assert.equal(Object.hasOwn(r.gateDecision,'noHarm'),false);assert.equal(r.completed,true);assert.equal(f.calls.length,2);
 assert.ok(f.events.filter(e=>e.event==='run').every(e=>e.stage==='gate'));assert.equal(r.cases.find(c=>c.sourceCaseId===h.marked[7].id).split,'test');
 assert.deepEqual(Object.keys(r.byStage),['gate']);assert.deepEqual(r.validation,{status:'not-planned'});assert.equal(r.adoptionEligible,false);
 assert.equal(JSON.stringify(h.store.read()),before);assert.equal(r.modelCallsKnown,40);assert.equal(r.callsUnavailable,false);
 const report=require('../../scripts/badcase-capture/holdout-gate-batch.cjs').formatHoldoutGateBatch(r);
 assert.match(report,/门槛（本模式留出题）/);assert.match(report,/Fisher/);assert.match(report,/trace 级/);assert.match(report,/run 级/);
 assert.match(report,/验证尚未规划/);assert.match(report,/不可提交采纳/);assert.doesNotMatch(report,/无误伤：|测试题仅/);
});
test('rejected complete gate still records every target, but never validates or offers adoption',async t=>{
 const h=fixture(t),f=execution(h,{candidatePasses:0}),r=await f.run();assert.equal(r.gateDecision.outcome,'rejected');assert.equal(r.completed,true);
 assert.equal(f.calls.length,2);assert.equal(r.adoptionEligible,false);assert.deepEqual(r.validation,{status:'not-planned'});
});
test('v4 human Fisher summary labels the threshold without claiming every p value is below it',async t=>{
 const h=fixture(t),r=await execution(h,{candidatePasses:0}).run();
 for(const pValue of [0.63,0.01,null]){
  const report=batch().formatBatch({...r,gateDecision:{...r.gateDecision,repair:{...r.gateDecision.repair,pValue}}});
  assert.ok(report.includes(`p=${pValue??'N/A'}（阈值 0.05）`));assert.doesNotMatch(report,/< 0\.05/);
 }
});
test('v4 ignored-case labels use wikiDisplayCases over the full source snapshot, never the selected-array index',async t=>{
 const h=fixture(t),id=h.marked[7].id,old=h.records.list().find(r=>r.reservation.plan.caseId===id),claim=h.records.reserve(old.reservation.plan);
 h.records.finish(claim.id,{status:'completed',reason:null,runs:old.result.runs.map(r=>({...r,status:'pass'}))});
 h.config.cases=h.config.cases.filter(c=>c.sourceCaseId!==id);h.config.experiment.definition.cases=h.config.experiment.definition.cases.filter(c=>c.caseId!==id);
 const r=await execution(h).run(),report=batch().formatBatch(r,h.store.read().cases);
 assert.match(report,/未参与判定：#24\n/);assert.ok(!report.includes(id));assert.doesNotMatch(report,/未参与判定：#2\n/);
 // A standalone caller without the full snapshot must not invent a number.
 const unavailable=batch().formatBatch(r);assert.match(unavailable,/未参与判定：编号不可用/);assert.ok(!unavailable.includes(id));
});
test('scene and no-scene cases route to their unchanged respective kernels and report valid/failure counts separately',async t=>{
 const h=fixture(t);h.makeRun24();const f=execution(h);let traces=0,runs=0;
 f.options.runProductionComparison=async(c,o)=>{traces++;return f.compare(c,o);};
 f.options.runProductionRunComparison=async(c,o)=>{runs++;return f.compare(c,o);};
 const r=await f.run();assert.equal(traces,1);assert.equal(runs,1);assert.equal(r.gateDecision.outcome,'accepted');
 assert.equal(r.gateDecision.byLevel.run.original.failed,10);assert.equal(r.gateDecision.byLevel.trace.original.failed,10);
 assert.equal(r.gateDecision.byLevel.run.original.total,10);assert.equal(r.gateDecision.byLevel.trace.original.total,10);
});
test('v4 run/structured-trace invalid replacements stay outside the denominator with distinct errors and invalid counts',async t=>{
 const h=fixture(t),f=execution(h,{prefix:['invalid','error','invalid','error','invalid']}),r=await f.run();
 assert.equal(r.gateDecision.outcome,'accepted');assert.equal(r.modelCallsKnown,50);
 assert.equal(r.gateDecision.byLevel.trace.original.invalid,6);assert.equal(r.gateDecision.byLevel.trace.candidate.errors,4);
 assert.equal(r.gateDecision.repair.original.total,20);assert.equal(r.gateDecision.repair.candidate.total,20);
});
test('auth/integrity failure preserves observed attempts and safe reason, stops subsequent cases and cannot pass',async t=>{
 const h=fixture(t),f=execution(h);let sent=0;
 f.options.runProductionComparison=async(c,o)=>{sent++;o.onEvent({event:'model_call',variant:'original',iteration:1,model:h.config.modelProfile});
  o.onEvent({event:'run',variant:'original',iteration:1,status:'error'});throw Object.assign(Error('PRIVATE-AUTH-DETAIL'),{code:'evaluation_codex_auth_failed'});};
 const r=await f.run();assert.equal(sent,1);assert.equal(r.completed,false);assert.equal(r.gateDecision.outcome,'indeterminate');
 assert.equal(r.cases[0].reason,'evaluation_codex_auth_failed');assert.equal(r.cases[1].reason,'prior_integrity_error');
 assert.equal(r.cases[1].status,'not-run');assert.equal(r.modelCallsKnown,1);assert.equal(r.callsUnavailable,true);
 assert.equal(JSON.stringify(r).includes('PRIVATE-AUTH-DETAIL'),false);
});
test('current evidence drift between cases stops before the next model comparison',async t=>{
 const h=fixture(t),f=execution(h);let sent=0;
 f.options.runProductionComparison=async(c,o)=>{sent++;const r=await f.compare(c,o);
  const old=h.records.list().find(r=>r.reservation.plan.caseId===h.marked[7].id);h.records.reserve(old.reservation.plan);return r;};
 const r=await f.run();assert.equal(sent,1);assert.equal(r.gateDecision.outcome,'indeterminate');assert.equal(r.completed,false);
 assert.equal(r.cases[1].status,'error');assert.match(r.cases[1].reason,/^(wiki|evaluation)_/);assert.equal(r.adoptionEligible,false);
});
test('missing/mismatched confirmation and changed current membership reject before any event or model comparison',async t=>{
 for(const mode of ['unconfirmed','wrong-hash','unpinned','membership']){
  const h=fixture(t),f=execution(h);
  if(mode==='unconfirmed')f.options.confirmed=false;if(mode==='wrong-hash')f.options.expectedPlanHash=hash('other');
  if(mode==='unpinned')delete h.config.experiment.plan;
  if(mode==='membership')h.mutate(s=>s.cases.find(c=>c.id===h.marked[6].id).split='train');
  await assert.rejects(f.run());assert.equal(f.calls.length,0);assert.deepEqual(f.events,[]);
 }
});
test('direct staged entry cannot substitute prepared task/inputs outside the hash-checked current host plan',async t=>{
 const h=fixture(t),f=execution(h);f.pinned.prepared[0].comparisonConfig.scoring.task+=' FORGED';
 await assert.rejects(require('../../scripts/badcase-capture/staged-batch.cjs').runStagedBatch(h.config,f.pinned,f.options),{code:'evaluation_batch_input_changed'});
 assert.deepEqual(f.events,[]);assert.equal(f.calls.length,0);
});
test('malformed child schedule is rejected before any subsequent case instead of spending more calls',async t=>{
 const h=fixture(t),f=execution(h);let sent=0;
 f.options.runProductionComparison=async()=>{sent++;return {completed:true,runs:[{variant:'candidate',iteration:1,status:'pass'}],modelCallsKnown:1,callsUnavailable:false};};
 const r=await f.run();assert.equal(sent,1);assert.equal(r.gateDecision.outcome,'indeterminate');
 assert.equal(r.cases[0].reason,'wiki_holdout_gate_result_invalid');assert.equal(r.cases[1].status,'not-run');
});
