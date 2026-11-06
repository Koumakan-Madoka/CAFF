// Allowlisted D13 result projection. Never persist replies, file evidence,
// arbitrary worker fields or caller-provided aggregate/decision conclusions.
import { decideWikiGate } from './wiki-gate-policy';
import { projectProductionResult } from './wiki-production-result';
import { projectProductionResultV2 } from './wiki-production-result-v2';
const fail=()=>Object.assign(Error('wiki_comparison_invalid'),{code:'wiki_comparison_invalid'});
function check(c:any):asserts c {if(!c) throw fail();}
const id=(s:any)=>{check(typeof s==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(s));return s;};
const digest=(s:any)=>{check(typeof s==='string' && /^[a-f0-9]{64}$/.test(s));return s;};
const count=(n:any)=>{check(Number.isSafeInteger(n) && n>=0);return n;};
const code=(s:any)=>{check(typeof s==='string' && /^[a-z_]{1,100}$/.test(s));return s;};
const ids=(a:any)=>{check(Array.isArray(a) && a.length<=1000);const b=a.map(id);check(new Set(b).size===b.length);return b;};
export function projectStagedResult(input:any,totals:(cases:any[],repeats:number)=>any):any {
  if (input?.kind === 'wiki-staged-batch-comparison-v2') return projectProductionResultV2(input, totals);
  if (input?.evaluation?.splitPolicy === 'd15-frozen-v1') return projectProductionResult(input, totals);
  check(input.scope==='global' && input.model==='deepseek/deepseek-v4-flash' && input.repeats===10);
  check(typeof input.completed==='boolean' && typeof input.callsUnavailable==='boolean');
  const e=input.evaluation;check(e?.kind==='wikiskill-gate-v1' && e.maxExtraAttemptsPerCase===5);
  const evaluation={kind:e.kind,targetEntryId:id(e.targetEntryId),gateCaseIds:ids(e.gateCaseIds),testCaseIds:ids(e.testCaseIds),
    targetReproductionCaseIds:ids(e.targetReproductionCaseIds),maxExtraAttemptsPerCase:5};
  check(evaluation.gateCaseIds.length>0 && evaluation.testCaseIds.length>0 && evaluation.targetReproductionCaseIds.length>0);
  const suite=[...evaluation.gateCaseIds,...evaluation.testCaseIds];check(new Set(suite).size===suite.length);
  const split={caseIds:ids(input.split?.caseIds),trainCaseIds:ids(input.split?.trainCaseIds),testCaseIds:ids(input.split?.testCaseIds)};
  check(split.trainCaseIds.length+split.testCaseIds.length===split.caseIds.length && split.caseIds.every(x=>split.trainCaseIds.includes(x)!==split.testCaseIds.includes(x)));
  check(evaluation.testCaseIds.length===split.testCaseIds.length && split.testCaseIds.every(x=>evaluation.testCaseIds.includes(x)));
  check(Array.isArray(input.cases) && input.cases.length===suite.length && suite.length<=20);
  const seen=new Set(),cases=input.cases.map((c:any)=>{
    const sourceCaseId=id(c.sourceCaseId);check(suite.includes(sourceCaseId) && !seen.has(sourceCaseId));seen.add(sourceCaseId);
    check(['gate','test'].includes(c.stage) && (c.stage==='gate')===evaluation.gateCaseIds.includes(sourceCaseId));
    check(['train','test'].includes(c.split) && (c.split==='test')===split.testCaseIds.includes(sourceCaseId));
    check(['reproduction','probe','control'].includes(c.category) && ['completed','error','unsupported','not-run'].includes(c.status));
    check(Array.isArray(c.runs) && c.runs.length<=25 && typeof c.callsUnavailable==='boolean');
    const attempts:any={original:0,candidate:0},scored:any={original:0,candidate:0};let next='original';
    const runs=c.runs.map((r:any)=>{
      check(['original','candidate'].includes(r.variant) && ['pass','fail','error'].includes(r.status));
      if(scored[next]===10) next=next==='original'?'candidate':'original';
      check(r.variant===next);next=next==='original'?'candidate':'original';
      check(r.iteration===++attempts[r.variant] && scored[r.variant]<10);
      if(r.status!=='error') scored[r.variant]++;
      return {variant:r.variant,iteration:r.iteration,status:r.status,...(r.reason===undefined?{}:{reason:code(r.reason)}),
        replySource:['public','internal','none'].includes(r.replySource)?r.replySource:'unknown',cleaned:r.cleaned===true};
    });
    check(c.status!=='completed' || scored.original===10 && scored.candidate===10);
    check(!['unsupported','not-run'].includes(c.status) || !runs.length);
    const comparison=c.comparison?Object.fromEntries(['checkpointId','checkpointHash','rulesHash','planHash'].filter(k=>c.comparison[k]!==undefined).map(k=>[k,k==='checkpointId'?id(c.comparison[k]):digest(c.comparison[k])])):null;
    const record={sourceCaseId,split:c.split,stage:c.stage,category:c.category,status:c.status,replayId:c.replayId?id(c.replayId):null,comparison,
      ...(c.reason===undefined?{}:{reason:code(c.reason)}),runs,modelCallsKnown:count(c.modelCallsKnown),callsUnavailable:c.callsUnavailable};
    return {...record,totals:totals([record],10)};
  });
  check(evaluation.targetReproductionCaseIds.every(x=>cases.some((c:any)=>c.sourceCaseId===x && c.stage==='gate' && c.category==='reproduction')));
  const gateDecision=decideWikiGate(cases,evaluation.targetReproductionCaseIds,10);
  check(JSON.stringify(input.gateDecision)===JSON.stringify(gateDecision));
  if(gateDecision.outcome!=='accepted') check(cases.filter((c:any)=>c.stage==='test').every((c:any)=>c.status==='not-run' && c.reason==='gate_'+gateDecision.outcome));
  check(input.completed===(gateDecision.outcome!=='indeterminate' && cases.filter((c:any)=>c.stage==='gate' || gateDecision.outcome==='accepted').every((c:any)=>c.status==='completed')));
  const modelCallsKnown=cases.reduce((n:number,c:any)=>n+c.modelCallsKnown,0),callsUnavailable=cases.some((c:any)=>c.callsUnavailable);
  check(input.modelCallsKnown===modelCallsKnown && input.callsUnavailable===callsUnavailable);
  const candidate=input.candidate;check(candidate && Array.isArray(candidate.entryIds) && candidate.entryIds.length===1 && candidate.entryIds[0]===evaluation.targetEntryId);
  const disclosures=ids(input.disclosures);for(const d of ['baseline_screening_selection_bias','only_reporting_failures_reproduced','proxy_model_deepseek','small_sample','not_adoption_evidence']) check(disclosures.includes(d));
  const preparedReplayableCount=count(input.preparedReplayableCount);check(preparedReplayableCount<=cases.length);
  return {kind:input.kind,scope:'global',evaluation,executionId:id(input.executionId),planHash:digest(input.planHash),configHash:digest(input.configHash),
    runtimeHash:input.runtimeHash===null?null:digest(input.runtimeHash),model:input.model,
    candidate:{id:id(candidate.id),targetId:id(candidate.targetId),baseHash:digest(candidate.baseHash),candidateHash:digest(candidate.candidateHash),versionId:id(candidate.versionId),entryIds:ids(candidate.entryIds)},
    repeats:10,split,additionalTrainingCaseIds:ids(input.additionalTrainingCaseIds),excludedSplitTrainingCaseIds:ids(input.excludedSplitTrainingCaseIds),
    wikiTrainingCount:count(input.wikiTrainingCount),preparedReplayableCount,disclosures,completed:input.completed,cases,gateDecision,
    byStage:Object.fromEntries(['gate','test'].map(s=>[s,totals(cases.filter((c:any)=>c.stage===s),10)])),modelCallsKnown,callsUnavailable};
}
