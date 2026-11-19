// Batch3 shape: verified proxy failure without a worker receipt, followed by
// enough alternating valid outputs. Synthetic scoring only; no model or auth.
const base='../../build/server/domain/runtime/badcase-capture/';
const {wikiValueHash:hash}=require(base+'wiki-rubric');
module.exports=function withUnknownReplacement(h,reason='evaluation_codex_proxy_failed'){
 const id=h.plan().summary.evaluation.gateCaseIds[0];
 const e=require('./wiki-holdout-full-execution.cjs')(h,{prefixes:{[id]:[null,null,null,'error']}});
 e.options.runProductionComparison=async(config,options)=>{
  const events=[],r=await e.compare(config,{...options,onEvent:event=>events.push(event)});
  if(config.scoring.rubric.caseId!==id){events.forEach(options.onEvent);return r;}
  for(const row of r.runs){
   const unknown=row.status==='error';
   Object.assign(row,{modelCalls:unknown?[]:[{usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2}}],
    tokenUsage:{knownCalls:unknown?0:1,callsWithoutUsage:0,callsUnavailable:unknown,knownTokens:unknown?null:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2},complete:!unknown}});
   if(unknown)Object.assign(row,{reason,checks:null,finalText:'',replySource:'unknown',cleaned:true,containerId:'a'.repeat(64),
    isolation:{network:'none'},inputHash:hash('synthetic input'),durationMs:16062,hostRequestAttempts:1});
  }
  for(const event of events){
   const row=r.runs.find(row=>row.variant===event.variant&&row.iteration===event.iteration);
   if(event.event==='model_call'&&row?.status==='error')continue;
   options.onEvent(event.event==='run'?{...event,...row}:event);
  }
  return {...r,completed:true,fatal:false,modelCallsKnown:r.runs.length-1,callsUnavailable:true};
 };
 return e;
};
