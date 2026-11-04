// Host-only bridge between experiment choices, frozen case rubrics and replay.
// No judge implementation/prompt/auth here. Never substitutes replay.task (an
// operator label) or a whole runtime prompt for the triggering user message.
const base='../../build/server/domain/runtime/badcase-capture/';
const {createWikiExperimentPlan,assertWikiExperimentPlan}=require(base+'wiki-experiment-plan');
const {resolveFrozenWikiRubric,wikiExactKeys,wikiValueHash}=require(base+'wiki-rubric');
const {bindWikiJudge}=require(base+'wiki-scoring-v2');
const {prepareEvaluationCallbackTrace}=require(base+'evaluation-trace');
const {resolveWikiReplayRequest}=require(base+'wiki-replay-location');
const {prepareSealedOriginalTurn}=require('./sealed-direct-input.cjs');
const {wikiScoringSummary}=require('./wiki-receipt-scoring.cjs');
const fail=code=>Object.assign(Error(code),{code});
const same=(a,b)=>wikiValueHash(a)===wikiValueHash(b);
function readProductionScoringTask(replay,scope){
 const turn=prepareSealedOriginalTurn(resolveWikiReplayRequest(scope,replay.request));
 if(!turn.supported || turn.provenance.checkpointHash!==replay.checkpointHash)throw fail('evaluation_batch_task_unavailable');
 const callback=turn.input.callback;
 const prepared=prepareEvaluationCallbackTrace(callback.trace,callback.expectedTraceHash,callback.association);
 return prepared.seed.userMessage.content;
}
// Only objective checks belong in this hash. Legacy reply markers remain
// bound by the surrounding batch config but cannot determine semantic pass.
function objectiveRules(rules){
 if(rules.kind==='file-literals-v1')return structuredClone(rules);
 if(rules.kind==='read-only-files-v1')return {kind:rules.kind,readPaths:rules.readPaths,absentPaths:rules.absentPaths};
 return {kind:'completion-public-reply-v1'};
}
function prepareProductionScoring(config,state,candidate,suite,options,modelConfig){
 if(config.experiment===undefined)return null;
 const experiment=config.experiment;
 wikiExactKeys(experiment,['definition',...(experiment?.plan===undefined?[]:['plan'])]);
 const definition=experiment.definition,catalog=[],scope={globalRoot:config.globalRoot,sourceWorktree:config.sourceWorktree};
 const selections=suite.cases.filter(c=>!c.reportOnly).map(c=>({caseId:c.sourceCaseId,stage:c.stage,category:c.category,targetReproduction:c.targetReproduction}));
 if(!same(definition?.variants,[{id:'original',promptHash:candidate.baseHash},{id:'candidate',promptHash:candidate.candidateHash}])
   || !same(definition?.runner,{model:config.modelProfile,settings:modelConfig}) || !same(definition?.cases,selections))throw fail('wiki_experiment_changed');
 return {
  forCase(source,replay,item){
   if(item.topicExemption!==undefined || item.rulesRevision!==undefined)throw fail('evaluation_batch_cases_invalid');
   const rubric=resolveFrozenWikiRubric(state,source.id,item.rubricHash);
   const task=(options.prepareProductionTask || readProductionScoringTask)(replay,scope);
   return {kind:'wiki-score-v2',rubric,binding:bindWikiJudge(definition.judge,rubric),task,expected:source.expected};
  },
  recordCase(source,replay,comparison,scoring){
   if(!comparison.supported)throw fail('evaluation_batch_task_unavailable');
   if(!same(comparison.summary.scoring,wikiScoringSummary(scoring)))throw fail('evaluation_batch_input_changed');
   catalog.push({id:source.id,sceneHash:wikiValueHash({checkpointHash:replay.checkpointHash,fixture:replay.fixture,
    commonInputHash:comparison.summary.commonInputHash??null}),task:scoring.task,actual:source.actual,expected:source.expected,
    hardAssertions:objectiveRules(replay.rules),rubric:scoring.rubric});
  },
  finish(){
   const plan=createWikiExperimentPlan(definition,catalog);
   if(experiment.plan!==undefined)assertWikiExperimentPlan(experiment.plan,definition,catalog);
   return plan;
  },
 };
}
module.exports={prepareProductionScoring,readProductionScoringTask};
