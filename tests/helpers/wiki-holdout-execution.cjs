// Real scoring/selection with fake receipts only; no model, key or container.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const base='../../build/server/domain/runtime/badcase-capture/';
const {wikiValueHash:hash}=require(base+'wiki-rubric');
module.exports=function execution(h,{candidatePasses=6,prefix=[]}={}){
 h.config.experiment.plan=h.plan().summary.experiment;
 const pinned=h.plan(),events=[];
 const compare=async(config,options)=>{
  assert.notEqual(config.kind,'wikiskill-run-comparison-v1','This fake is trace only');
  options.onEvent({event:'plan',runtimeHash:hash('synthetic runtime')});
  const runs=[],valid={original:0,candidate:0},attempts={original:0,candidate:0};let next='original';
  while(valid.original<10||valid.candidate<10){
   if(valid[next]===10)next=next==='original'?'candidate':'original';
   const variant=next,iteration=++attempts[variant],injected=prefix[runs.length];
   const pass=variant==='candidate'&&valid.candidate<candidatePasses&&config.scoring.rubric.caseId===pinned.prepared.find(c=>c.execution?.level!=='run')?.sourceCaseId;
   const reason=pass?'Synthetic bounded reason':'x'.repeat(1001),executionId=crypto.randomUUID();
   const receipt={success:true,finalText:'Synthetic public result. PRIVATE-REPLY',replySource:'public',modelCalls:[{success:true}],toolCalls:[],
    goalEvidence:{kind:'evaluation-goal-evidence-v1',executionId,goalState:'unseeded',seed:null,seedHash:hash(null),calls:injected==='invalid'?[]:
     [{executionId,sequence:1,endpoint:'goal/suggest',parameters:{action:'pause',reason},statusCode:pass?200:400,errorCode:null,response:{ok:pass}}]}};
   const assessment=injected==='error'?undefined:await require('../../scripts/badcase-capture/wiki-receipt-scoring.cjs').scoreWikiReceipt({receipt,rules:config.rules,scoring:config.scoring});
   const status=injected==='error'?'error':assessment.status;
   const row={variant,iteration,status,...(injected==='error'?{reason:'model_error'}:assessment.reason?{reason:assessment.reason}:{}),
    ...(assessment?{assessment}:{}),replySource:'public',cleaned:true,finalText:receipt.finalText,
    tokenUsage:{complete:true,knownTokens:{totalTokens:2}}};
   if(['pass','fail'].includes(status))valid[variant]++;
   options.onEvent({event:'run_start',variant,iteration});options.onEvent({event:'model_call',variant,iteration,model:h.config.modelProfile});
   runs.push(row);options.onEvent({event:'run',...row});next=next==='original'?'candidate':'original';
   if(runs.filter(r=>['error','invalid'].includes(r.status)).length===5)break;
  }
  return {completed:valid.original===10&&valid.candidate===10,runs,modelCallsKnown:runs.length,callsUnavailable:false};
 };
 const options={...h.options,confirmed:true,expectedPlanHash:pinned.summary.planHash,onEvent:e=>events.push(e),
  runProductionComparison:compare,readKey:()=>assert.fail('No credential read')};
 return {pinned,events,options,run:()=>require('../../scripts/badcase-capture/batch-comparison.cjs').runBatch(h.config,options)};
};
