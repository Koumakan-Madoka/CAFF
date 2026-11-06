// Trusted host executor: one model request per durable attempt, zero tools.
// This is NOT Docker replay or restoration of a live cut-point workspace.
const path=require('node:path');
const base='../../build/server/domain/runtime/badcase-capture/';
const {createWikiStore}=require(base+'wiki-store');
const {createWikiRunStore}=require(base+'wiki-run-store');
const {buildWikiRunRequest,replayWikiRun,wikiRunHash}=require(base+'wiki-run-replay');
const {pageDehydrationCause}=require(base+'wiki-dehydration');
const {scoreWikiRun,isWikiJudgeTechnicalError}=require(base+'wiki-scoring-v2');
const {wikiValueHash}=require(base+'wiki-rubric');
const {redactTraceKnownValues}=require(base+'wiki-trace');
const {validateWikiScoring,assertWikiScoringJudge}=require('./wiki-receipt-scoring.cjs');
const {readKnownKeyValues}=require('./known-key-values.cjs');
const {createWikiRunClient}=require('./wiki-run-client.cjs');
const {tokenUsage}=require('./replay-measurements.cjs');
const fail=code=>Object.assign(Error(code),{code});
const safeCode=(code,fallback)=>typeof code==='string'&&/^(?:evaluation_codex_|wiki_)[a-z_]{1,80}$/.test(code)?code:fallback;
const retryable=new Set(['evaluation_codex_proxy_failed','evaluation_codex_gateway_unavailable','evaluation_codex_request_timeout']);
function knownValues(config,options){
 if(Object.hasOwn(options,'knownValues')){
  if(!Array.isArray(options.knownValues)||options.knownValues.some(v=>typeof v!=='string'))throw fail('evaluation_config_invalid');
  return options.knownValues;
 }
 if(!config.knownKeySources)throw fail('evaluation_known_sources_required');
 if(path.resolve(config.knownKeySources.sandboxRoot||'')!==path.dirname(path.resolve(config.codexAuthFile||'')))throw fail('evaluation_known_sources_mismatch');
 return readKnownKeyValues(config.knownKeySources).values;
}
async function runSingleCallComparison(config,options={}){
 if(options.confirmed!==true)throw fail('wiki_run_confirmation_required');
 if(config?.kind!=='wikiskill-run-comparison-v1'||config.modelProfile!=='openai-codex/gpt-6.1-sol'
  ||!/^[a-f0-9]{64}$/.test(options.experimentPlanHash||'')
  ||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.executionId||''))throw fail('wiki_run_confirmation_required');
 const fixed=structuredClone(config),scoring=validateWikiScoring(fixed.scoring),values=knownValues(fixed,options);
 if(scoring.rubric.questions.some(q=>q.evidence!=='reply'))throw fail('wiki_rubric_run_evidence_invalid');
 assertWikiScoringJudge(scoring,options.judge);
 const store=createWikiStore(fixed),packets=createWikiRunStore(fixed),emit=options.onEvent||(()=>{});
 function verify(){
  const item=store.read().cases.find(c=>c.id===fixed.caseId),bundle=store.readCaseTrace(fixed.caseId),decision=store.getDehydration(fixed.caseId)?.decision;
  if(!item||wikiValueHash(store.getFrozenRubric(fixed.caseId,scoring.rubric.hash))!==wikiValueHash(scoring.rubric)
   ||scoring.expected!==item.expected||scoring.task!==pageDehydrationCause(bundle).text)throw fail('wiki_run_stale');
  for(const variant of ['original','candidate']){
   const request=buildWikiRunRequest({item,bundle,decision,toolset:fixed.toolset,...(variant==='candidate'?{candidate:fixed.candidate}:{})});
   if(wikiRunHash(request)!==fixed[variant+'RequestHash'])throw fail('wiki_run_stale');
   if(redactTraceKnownValues(request,values).count)throw fail('wiki_run_input_contains_known_key');
  }
  assertWikiScoringJudge(scoring,options.judge);
 }
 verify();
 const runs=[],attempts={original:0,candidate:0},slots={original:0,candidate:0};
 let next='original',replacements=0,fatal=false,modelCallsKnown=0,callsUnavailable=false;
 while(slots.original<10||slots.candidate<10){
  if(slots[next]===10)next=next==='original'?'candidate':'original';
  const variant=next,iteration=++attempts[variant];verify();
  emit({event:'run_start',variant,iteration});
  // Client construction/auth occurs lazily INSIDE complete, after replayWikiRun
  // durably claims this logical slot. A duplicate cannot open auth or send.
  let client,clientReason=null,cleanupFailed=false,stateInvalid=false;
  const started=Date.now();
  let packet;
  try{
   packet=await replayWikiRun({store,runs:packets,caseId:fixed.caseId,toolset:fixed.toolset,
    ...(variant==='candidate'?{candidate:fixed.candidate}:{}),approvedRequestHash:fixed[variant+'RequestHash'],
    attempt:{planHash:options.experimentPlanHash,executionId:options.executionId,iteration}},
   {knownKeyValues:values,client:{complete:async request=>{
    try{
     client=await (options.createRunClient||createWikiRunClient)({authFile:fixed.codexAuthFile,knownKeyValues:values,...(fixed.timeoutMs===undefined?{}:{timeoutMs:fixed.timeoutMs})});
     return await client.complete(request);
    }catch(e){clientReason=safeCode(e?.code,null);throw e;}
   }}});
  }finally{
   try{clientReason=safeCode(client?.state?.()?.reason,clientReason);}catch{stateInvalid=true;}
   finally{try{if(client)await client.close();}catch{cleanupFailed=true;}}
  }
  const calls=packet.modelCalls===1?[{model:fixed.modelProfile,success:packet.outcome.status!=='error',durationMs:packet.durationMs,usage:packet.message?.usage}]:[];
  modelCallsKnown+=calls.length;callsUnavailable||=packet.modelCalls!==1;
  const row={variant,iteration,runReplayId:packet.id,requestHash:packet.requestHash,status:packet.outcome.status==='invalid'?'invalid':'error',
   ...(packet.outcome.reason?{reason:packet.outcome.reason}:{}),replySource:packet.outcome.status==='reached'?'public':'none',
   cleaned:!cleanupFailed,toolExecutions:0,durationMs:Date.now()-started,modelCalls:calls,
   tokenUsage:tokenUsage(calls,{callsUnavailable:packet.modelCalls!==1}),finalText:packet.outcome.reply};
  for(const call of calls)emit({event:'model_call',variant,iteration,...call});
  if(cleanupFailed||stateInvalid){row.reason=cleanupFailed?'wiki_run_client_cleanup_failed':'wiki_run_client_state_invalid';fatal=true;}
  else if(packet.outcome.status==='reached'){
   try{
    row.assessment=await scoreWikiRun({rubric:scoring.rubric,binding:scoring.binding,hardAssertions:[],
     run:{completed:true,replySource:'public',publicReply:packet.outcome.reply,task:scoring.task,expected:scoring.expected}},options.judge);
    row.status=row.assessment.status;delete row.reason;if(row.assessment.reason)row.reason=row.assessment.reason;
    if(row.status==='error'&&!isWikiJudgeTechnicalError(row.assessment))fatal=true;
   }catch(e){row.reason=safeCode(e?.code,'wiki_run_scoring_failed');fatal=true;}
  }else if(packet.outcome.status==='error'){
   row.reason=clientReason||'model_request_failed';fatal=!retryable.has(row.reason);
  }
  if(row.status==='invalid'||row.status==='error'&&!isWikiJudgeTechnicalError(row.assessment))replacements++;
  else slots[variant]++;
  runs.push(row);emit({event:'run',...row});
  next=variant==='original'?'candidate':'original';
  if(fatal||replacements>=5)break;
 }
 return {kind:fixed.kind,completed:['original','candidate'].every(v=>runs.filter(r=>r.variant===v&&['pass','fail'].includes(r.status)).length===10),fatal,runs,modelCallsKnown,callsUnavailable};
}
module.exports={runSingleCallComparison};
