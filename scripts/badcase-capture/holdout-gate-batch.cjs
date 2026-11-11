// Trusted v4 gate kernel. Versioned publication independently rechecks its
// evidence. This module never decides validation or adoption.
const crypto=require('node:crypto');
const base='../../build/server/domain/runtime/badcase-capture/';
const {decideWikiHoldoutExperimentGate,validateWikiHoldoutExperimentPlan}=require(base+'wiki-holdout-plan');
const {wikiExperimentRun}=require(base+'wiki-experiment-plan');
const {wikiComparisonTotals:totals}=require(base+'wiki-comparison-totals');
const {wikiObjectiveAssertionIds}=require(base+'wiki-comparison-scoring');
const {assertWikiScoringJudge}=require('./wiki-receipt-scoring.cjs');
const fail=code=>Object.assign(Error(code),{code});
const safeCode=(e,fallback)=>/^(evaluation|wiki)_[a-z_]+$/.test(e?.code||'')?e.code:fallback;
const gateRows=results=>results.map(c=>({caseId:c.sourceCaseId,status:c.status,runs:c.runs.map(wikiExperimentRun)}));
async function runHoldoutGateBatch(config,plan,options={}){
 if(plan?.summary?.kind!=='wiki-mode-holdout-comparison-v1'||options.confirmed!==true||options.expectedPlanHash!==plan.summary.planHash
  ||!config.experiment?.plan)throw fail('wiki_experiment_confirmation_required');
 validateWikiHoldoutExperimentPlan(plan.summary.experiment);
 const fixed=structuredClone(config),prepare=()=>require('./batch-comparison.cjs').prepareBatch(fixed,{...options,allowDraftCandidate:false});
 const current=prepare();
 if(current.summary.planHash!==plan.summary.planHash||JSON.stringify(current.prepared)!==JSON.stringify(plan.prepared))throw fail('evaluation_batch_input_changed');
 // Use only freshly reconstructed execution inputs, not the caller's prepared
 // object. This protects direct staged calls as well as the normal dispatcher.
 plan=current;
 const judgeFor=item=>Object.hasOwn(options.judges||{},item.sourceCaseId)?options.judges[item.sourceCaseId]:undefined;
 for(const item of plan.prepared){
  if(item.stage!=='gate'||item.reportOnly||!item.targetReproduction)throw fail('wiki_experiment_partition_changed');
  if(item.supported)assertWikiScoringJudge(item.comparisonConfig.scoring,judgeFor(item),{runChecks:item.execution?.level==='run'});
 }
 const emit=options.onEvent||(()=>{}),executionId=crypto.randomUUID(),results=[];
 let runtimeHash=null,fatal=false;
 emit({event:'batch_plan',...plan.summary,executionId});
 for(const item of plan.prepared){
  let result={sourceCaseId:item.sourceCaseId,split:item.split,stage:'gate',category:'reproduction',family:'GPT',reportOnly:false,targetReproduction:true,
   ...(item.classification?{classification:structuredClone(item.classification)}:{}),replayId:item.replayId||null,
   ...(item.execution?{execution:structuredClone(item.execution)}:{}),
   ...(item.comparisonConfig?.scoring?{rubric:item.comparisonConfig.scoring.rubric,hardAssertionIds:wikiObjectiveAssertionIds(item.comparisonConfig.rules??{kind:'completion-public-reply-v1'})}:{}),
   comparison:item.comparison||null,status:'not-run',runs:[],modelCallsKnown:0,callsUnavailable:false};
  if(fatal)result.reason='prior_integrity_error';
  else if(!item.supported){result.status='unsupported';result.reason=item.reason;}
  else{
   const runs=[],calls=new Map();
   try{
    if(prepare().summary.planHash!==plan.summary.planHash)throw fail('evaluation_batch_input_changed');
    const compare=item.execution?.level==='run'?options.runProductionRunComparison||require('./single-call-comparison.cjs').runSingleCallComparison
     :options.runProductionComparison||require('./direct-comparison.cjs').runComparison;
    const measured=await compare(item.comparisonConfig,{...options,judge:judgeFor(item),executionId,experimentPlanHash:plan.summary.experiment.planHash,confirmed:true,
     onEvent:event=>{
      if(event.event==='plan'){
       if(runtimeHash!==null&&runtimeHash!==event.runtimeHash)throw fail('evaluation_batch_runtime_changed');
       runtimeHash=event.runtimeHash;
      }
      const slot=event.variant+':'+event.iteration;
      if(event.event==='model_call'){if(!calls.has(slot))calls.set(slot,[]);calls.get(slot).push(event);}
      if(event.event==='run')runs.push({...event,modelCalls:calls.get(slot)||[]});
      emit({...event,sourceCaseId:item.sourceCaseId,stage:'gate',split:item.split,category:'reproduction'});
     }});
    result={...result,status:measured.completed?'completed':'error',runs:measured.runs,modelCallsKnown:measured.modelCallsKnown,callsUnavailable:measured.callsUnavailable===true};
    // Reject broken schedules before sending another case, not only when the
    // final pooled decision is built. No new scoring or judge logic is here.
    decideWikiHoldoutExperimentGate(plan.summary.experiment,gateRows([...results,result]));
    fatal||=measured.fatal===true;
   }catch(e){
    result={...result,status:'error',reason:safeCode(e,'case_execution_failed'),runs,
     modelCallsKnown:[...calls.values()].reduce((n,a)=>n+a.length,0),callsUnavailable:true};
    fatal=true;
   }
  }
  result.totals=totals([result],10);results.push(result);emit({event:'case_summary',...result});
 }
 const gateDecision=decideWikiHoldoutExperimentGate(plan.summary.experiment,gateRows(results));
 emit({event:'gate_decision',executionId,candidate:plan.summary.candidate,gateDecision});
 const result={...plan.summary,executionId,runtimeHash,completed:gateDecision.outcome!=='indeterminate'&&results.every(c=>c.status==='completed'),
  cases:results,gateDecision,byStage:{gate:totals(results,10)},
  // Explicitly not an adoption-capable full evaluation. M2 wires validation
  // after an accepted gate, not a legacy test stage or implicit empty pass.
  validation:{status:'not-planned'},adoptionEligible:false,
  modelCallsKnown:results.reduce((n,c)=>n+c.modelCallsKnown,0),callsUnavailable:results.some(c=>c.callsUnavailable)};
 emit({event:'batch_summary',...result});return result;
}
function formatHoldoutGateBatch(result){
 const d=result.gateDecision,lines=['WikiSkill 门槛（本模式留出题）','计划 '+result.planHash,
  `门槛判定：${{accepted:'通过',rejected:'未通过',indeterminate:'无法判定'}[d.outcome]}`,
  `合计：原版 ${d.repair.original.passed}/${d.repair.original.total}，候选 ${d.repair.candidate.passed}/${d.repair.candidate.total}；单侧 Fisher p=${d.repair.pValue??'N/A'} < 0.05`];
 for(const warning of d.warnings)lines.push(warning);
 for(const level of ['trace','run']){const t=d.byLevel[level];lines.push(`${level} 级：原版 ${t.original.passed}/${t.original.total}，候选 ${t.candidate.passed}/${t.candidate.total}；失败 ${t.original.failed}/${t.candidate.failed}，无效 ${t.original.invalid}/${t.candidate.invalid}，错误 ${t.original.errors}/${t.candidate.errors}`);}
 if(d.ignoredCaseIds.length)lines.push('未参与判定：'+d.ignoredCaseIds.join(', '));
 lines.push('验证尚未规划；本门槛结果不可提交采纳。','已记录模型请求 '+result.modelCallsKnown+(result.callsUnavailable?'（存在未知/不完整记录）':''));
 return lines.join('\n')+'\n';
}
module.exports={runHoldoutGateBatch,formatHoldoutGateBatch};
