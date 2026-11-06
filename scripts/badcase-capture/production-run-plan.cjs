// Pure trusted-host preflight for no-scene single decisions. Never loads auth,
// calls a model, executes tools or restores a live workspace. Schemas must be
// explicitly supplied by the host's version-checked loadWikiRunTools helper.
const base='../../build/server/domain/runtime/badcase-capture/';
const {buildWikiRunRequest,wikiRunHash}=require(base+'wiki-run-replay');
const {createWikiRunStore}=require(base+'wiki-run-store');
const {pageDehydrationCause}=require(base+'wiki-dehydration');
const {wikiValueHash}=require(base+'wiki-rubric');
const {wikiScoringSummary}=require('./wiki-receipt-scoring.cjs');
const fail=code=>Object.assign(Error(code),{code});
function prepareProductionRun({config,store,source,item,record,candidate,scoringPlan,toolset}) {
 if(!scoringPlan)throw fail('wiki_run_scoring_required');
 if(['repository','dependencies','replayVersionId','rulesRevision','topicExemption'].some(k=>item[k]!==undefined))throw fail('evaluation_batch_cases_invalid');
 const bundle=store.readCaseTrace(source.id),decision=store.getDehydration(source.id)?.decision;
 const input={item:source,bundle,decision,toolset};
 const original=buildWikiRunRequest(input);
 const originals=createWikiRunStore(config).list(source.id).filter(r=>r.traceHash===source.traceBundle.hash && r.decisionHash===decision.hash && r.variant?.kind==='original');
 if(!originals.some(r=>r.status==='reached' && r.caseEligibleForGateAndScreen))throw fail('wiki_run_baseline_required');
 const replacement={id:candidate.id,targetId:candidate.targetId,baseText:candidate.baseText,baseHash:candidate.baseHash,replacement:candidate.candidateText};
 const changed=buildWikiRunRequest({...input,candidate:replacement});
 const originalRequestHash=wikiRunHash(original),candidateRequestHash=wikiRunHash(changed);
 const execution={level:'run',traceBundleHash:source.traceBundle.hash,dehydrationHash:decision.hash,requestHash:originalRequestHash};
 const scoring=scoringPlan.forRun(source,item,pageDehydrationCause(bundle).text);
 const summary={kind:'wikiskill-run-comparison-v1',execution,originalRequestHash,candidateRequestHash,
  commonInputHash:wikiValueHash({originalRequestHash,candidateRequestHash}),scoring:wikiScoringSummary(scoring)};
 scoringPlan.recordRun(source,execution,scoring);
 return {...record,supported:true,execution,comparison:summary,comparisonConfig:{kind:summary.kind,
  globalRoot:config.globalRoot,sourceWorktree:config.sourceWorktree,caseId:source.id,toolset:structuredClone(toolset),candidate:replacement,
  originalRequestHash,candidateRequestHash,scoring,modelProfile:config.modelProfile,codexAuthFile:config.codexAuthFile,
  ...(config.timeoutMs===undefined?{}:{timeoutMs:config.timeoutMs}),
  ...(config.knownKeySources===undefined?{}:{knownKeySources:config.knownKeySources})}};
}
module.exports={prepareProductionRun};
