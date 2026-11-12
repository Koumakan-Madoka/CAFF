// Trusted full v4 kernel. Gate then other-mode controls, never legacy test/no-
// harm rules. Publication/review remain separate current-evidence boundaries.
const crypto=require('node:crypto');
const base='../../build/server/domain/runtime/badcase-capture/';
const {validateWikiHoldoutFullExperimentPlan,decideWikiHoldoutFullExperiment}=require(base+'wiki-holdout-validation-plan');
const {wikiExperimentRun}=require(base+'wiki-experiment-plan');
const {wikiComparisonTotals}=require(base+'wiki-comparison-totals');
const {wikiObjectiveAssertionIds}=require(base+'wiki-comparison-scoring');
const {assertWikiScoringJudge}=require('./wiki-receipt-scoring.cjs');
const fail=code=>Object.assign(Error(code),{code});
const safeCode=(e,fallback)=>/^(evaluation|wiki)_[a-z_]+$/.test(e?.code||'')?e.code:fallback;
const decisionRows=results=>results.map(c=>({caseId:c.sourceCaseId,status:c.status,runs:c.runs.map(wikiExperimentRun)}));
// Preserve the historical counter contract; only this new stage uses the
// existing valid-output denominator, not attempted/replacement counts.
const totals=(rows,repeats)=>wikiComparisonTotals(rows.map(c=>c.stage==='validation'?{...c,stage:'gate'}:c),repeats);
async function runHoldoutValidationBatch(config,plan,options={}){
 if(plan?.summary?.kind!=='wiki-mode-holdout-comparison-v2'||options.confirmed!==true||options.expectedPlanHash!==plan.summary.planHash
  ||!config.experiment?.plan)throw fail('wiki_experiment_confirmation_required');
 validateWikiHoldoutFullExperimentPlan(plan.summary.experiment);
 const fixed=structuredClone(config),prepare=()=>require('./batch-comparison.cjs').prepareBatch(fixed,{...options,allowDraftCandidate:false});
 const fresh=prepare();
 if(fresh.summary.planHash!==plan.summary.planHash||JSON.stringify(fresh.prepared)!==JSON.stringify(plan.prepared))throw fail('evaluation_batch_input_changed');
 plan=fresh;
 const experiment=plan.summary.experiment,selection=experiment.validation,judgeFor=item=>Object.hasOwn(options.judges||{},item.sourceCaseId)?options.judges[item.sourceCaseId]:undefined;
 const emit=options.onEvent||(()=>{}),executionId=crypto.randomUUID(),results=[];
 let runtimeHash=null,fatal=false;
 emit({event:'batch_plan',...plan.summary,executionId});
 async function executeCase(item,skipReason){
  const repeats=item.stage==='gate'?10:selection.policy.repeats;
  let result={sourceCaseId:item.sourceCaseId,split:item.split,stage:item.stage,category:item.category,family:'GPT',reportOnly:false,targetReproduction:item.stage==='gate',
   ...(item.classification?{classification:structuredClone(item.classification)}:{}),replayId:item.replayId||null,
   ...(item.execution?{execution:structuredClone(item.execution)}:{}),
   ...(item.comparisonConfig?.scoring?{rubric:item.comparisonConfig.scoring.rubric,hardAssertionIds:wikiObjectiveAssertionIds(item.comparisonConfig.rules??{kind:'completion-public-reply-v1'})}:{}),
   comparison:item.comparison||null,status:'not-run',runs:[],modelCallsKnown:0,callsUnavailable:false};
  if(skipReason||fatal)result.reason=skipReason||'prior_integrity_error';
  else if(!item.supported){result.status='unsupported';result.reason=item.reason;}
  else{
   const observed=[],calls=new Map();
   try{
    if(prepare().summary.planHash!==plan.summary.planHash)throw fail('evaluation_batch_input_changed');
    assertWikiScoringJudge(item.comparisonConfig.scoring,judgeFor(item),{runChecks:item.execution?.level==='run'});
    const compare=item.execution?.level==='run'?options.runProductionRunComparison||require('./single-call-comparison.cjs').runSingleCallComparison
     :options.runProductionComparison||require('./direct-comparison.cjs').runComparison;
    const measured=await compare(item.comparisonConfig,{...options,judge:judgeFor(item),executionId,experimentPlanHash:experiment.planHash,confirmed:true,
     onEvent:event=>{
      if(event.event==='plan'){
       if(runtimeHash!==null&&runtimeHash!==event.runtimeHash)throw fail('evaluation_batch_runtime_changed');
       runtimeHash=event.runtimeHash;
      }
      const slot=event.variant+':'+event.iteration;
      if(event.event==='model_call'){if(!calls.has(slot))calls.set(slot,[]);calls.get(slot).push(event);}
      if(event.event==='run')observed.push({...event,modelCalls:calls.get(slot)||[]});
      emit({...event,sourceCaseId:item.sourceCaseId,stage:item.stage,split:item.split,category:item.category});
     }});
    const observedCalls=[...calls.values()].reduce((n,a)=>n+a.length,0);
    if(!Array.isArray(measured.runs)||!Number.isSafeInteger(measured.modelCallsKnown)||measured.modelCallsKnown<0||typeof measured.callsUnavailable!=='boolean'
     ||!measured.callsUnavailable&&measured.modelCallsKnown!==observedCalls
     ||measured.completed===true&&(measured.fatal===true||measured.callsUnavailable))throw fail('wiki_holdout_execution_result_invalid');
    result={...result,status:measured.completed?'completed':'error',runs:measured.runs,modelCallsKnown:measured.modelCallsKnown,callsUnavailable:measured.callsUnavailable===true};
    // Check schedules/eligibility before spending another case. Scoring remains
    // owned by the unchanged trace/single-call scorers and later projection.
    decideWikiHoldoutFullExperiment(experiment,decisionRows([...results,result]));
    fatal||=measured.fatal===true||measured.callsUnavailable;
   }catch(e){
    result={...result,status:'error',reason:safeCode(e,'case_execution_failed'),runs:observed,
     modelCallsKnown:[...calls.values()].reduce((n,a)=>n+a.length,0),callsUnavailable:true};fatal=true;
   }
  }
  result.totals=totals([result],repeats);results.push(result);emit({event:'case_summary',...result});
 }
 for(const item of plan.prepared.filter(c=>c.stage==='gate'))await executeCase(item);
 const gate=decideWikiHoldoutFullExperiment(experiment,decisionRows(results)).gate;
 emit({event:'gate_decision',executionId,candidate:plan.summary.candidate,gateDecision:gate});
 const skipReason=gate.outcome!=='accepted'?'gate_'+gate.outcome:selection.budgetStatus==='over-limit'?'validation_token_estimate_exceeded'
  :selection.budgetStatus==='usage-unknown'?'validation_usage_unknown':null;
 let validationSkip=skipReason;
 for(const item of plan.prepared.filter(c=>c.stage==='validation')){
  await executeCase(item,validationSkip);
  if(!validationSkip&&decideWikiHoldoutFullExperiment(experiment,decisionRows(results)).validation.status==='degraded')validationSkip='wiki_validation_prior_degradation';
 }
 const decision=decideWikiHoldoutFullExperiment(experiment,decisionRows(results));
 // A decisive degradation is a finished negative evaluation, even though the
 // remaining controls were deliberately not run. Never count them as passes.
 const completed=gate.outcome==='rejected'||gate.outcome==='accepted'&&selection.budgetStatus==='ready'&&results.every(c=>c.status==='completed'
  ||decision.outcome==='validation-degraded'&&c.stage==='validation'&&c.status==='not-run'&&c.reason==='wiki_validation_prior_degradation');
 const result={...plan.summary,executionId,runtimeHash,completed,cases:results,gateDecision:decision.gate,outcome:decision.outcome,validation:decision.validation,adoptionEligible:decision.adoptionEligible,
  byStage:{gate:totals(results.filter(c=>c.stage==='gate'),10),validation:totals(results.filter(c=>c.stage==='validation'),selection.policy.repeats)},
  modelCallsKnown:results.reduce((n,c)=>n+c.modelCallsKnown,0),callsUnavailable:results.some(c=>c.callsUnavailable)};
 emit({event:'validation_decision',executionId,outcome:decision.outcome,validation:decision.validation,adoptionEligible:decision.adoptionEligible});
 emit({event:'batch_summary',...result});return result;
}
function formatHoldoutValidationBatch(result,sourceCases=[],deletedCases=[]){
 const numbers=new Map([...require(base+'wiki-suite').wikiDisplayCases(sourceCases,deletedCases).map(c=>[c.id,'#'+c.displayNumber]),...deletedCases.map(r=>[r.case.id,'#'+r.caseNumber+' · 已删除'])]);
 const label=id=>numbers.get(id)||'编号不可用';
 const lines=require('./holdout-gate-batch.cjs').holdoutGateReportLines(result,sourceCases,deletedCases);
 lines[0]='WikiSkill 门槛（本模式）';
 for(const c of result.cases.filter(c=>c.stage==='gate'))lines.push(`${label(c.sourceCaseId)} 原版 ${c.totals.original.passed}/${c.totals.original.scored}，候选 ${c.totals.candidate.passed}/${c.totals.candidate.scored}；${c.status}`);
 const v=result.validation;
 lines.push('验证（其他模式对照题）',`每题每版 ${v.repeats} 次；少通过 ${v.degradationThreshold} 次及以上算劣化`,
  `总 token 估算：${v.estimatedTokens??'未知'}；上限 ${v.maxEstimatedTokens}`);
 if(result.gateDecision.outcome!=='accepted')lines.push('门槛未通过；验证未运行。');
 else if(v.status==='over-limit')lines.push('用量估算超上限；验证未运行。操作方可明确跳过最贵的题后重新确认计划，不自动跳题。');
 else if(v.status==='usage-unknown')lines.push('历史用量未知；验证未运行。');
 for(const c of v.cases){
  const stopped=result.cases.find(row=>row.sourceCaseId===c.caseId)?.reason==='wiki_validation_prior_degradation';
  lines.push(`${label(c.caseId)}（${c.entryId} / ${c.level}）原版 ${c.original.passed}/${c.original.total}，候选 ${c.candidate.passed}/${c.candidate.total}；${stopped?'not-run（已有劣化而停止）':c.degraded===null?'未完成':(c.degraded?'劣化':'未劣化')+`（少通过 ${c.loss} 次）`}`);
 }
 for(const level of ['trace','run']){const t=v.byLevel[level];lines.push(`${level} 级验证：原版 ${t.original.passed}/${t.original.total}，候选 ${t.candidate.passed}/${t.candidate.total}；失败 ${t.original.failed}/${t.candidate.failed}，无效 ${t.original.invalid}/${t.candidate.invalid}，错误 ${t.original.errors}/${t.candidate.errors}`);}
 lines.push('未覆盖：'+(v.uncovered.length?v.uncovered.map(c=>c.entryId+(c.reason==='operator-skipped'?'（操作方跳过）':'（无已确认对照题）')).join(', '):'无'),
  '结果：'+({'gate-rejected':'门槛未通过','validation-passed':'门槛通过、验证通过','validation-degraded':'门槛通过、验证劣化',
   'validation-uncovered':'门槛通过、验证全部未覆盖','validation-partial-coverage':'门槛通过、验证部分未覆盖',indeterminate:'无法判定'}[result.outcome]),
  result.adoptionEligible?'可提交人工评审；是否采纳由人决定，未覆盖不等于验证通过。':'不可提交采纳；未完成不等于没有劣化。',
  '已记录模型请求 '+result.modelCallsKnown+(result.callsUnavailable?'（存在未知/不完整记录）':''));
 return lines.join('\n')+'\n';
}
module.exports={runHoldoutValidationBatch,formatHoldoutValidationBatch};
