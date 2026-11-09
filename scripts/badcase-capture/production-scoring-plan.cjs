// Host-only bridge between experiment choices, frozen case rubrics and replay.
// No judge implementation/prompt/auth here. Never substitutes replay.task (an
// operator label) or a whole runtime prompt for the triggering user message.
const base='../../build/server/domain/runtime/badcase-capture/';
const {createWikiExperimentPlan,assertWikiExperimentPlan,wikiExperimentRunSceneHash}=require(base+'wiki-experiment-plan');
const {resolveFrozenWikiRubric,wikiExactKeys,wikiValueHash}=require(base+'wiki-rubric');
const {bindWikiJudge}=require(base+'wiki-scoring-v2');
const {readWikiEligibleJudges,assertWikiEligibleConfiguration}=require(base+'wiki-judge-catalog');
const {prepareEvaluationCallbackTrace}=require(base+'evaluation-trace');
const {resolveWikiReplayRequest}=require(base+'wiki-replay-location');
const {prepareSealedOriginalTurn}=require('./sealed-direct-input.cjs');
const {wikiScoringSummary}=require('./wiki-receipt-scoring.cjs');
const {wikiObjectiveRules}=require(base+'wiki-comparison-scoring');
const fail=code=>Object.assign(Error(code),{code});
const same=(a,b)=>wikiValueHash(a)===wikiValueHash(b);
function readProductionScoringTask(replay,scope){
 const turn=prepareSealedOriginalTurn(resolveWikiReplayRequest(scope,replay.request));
 if(!turn.supported || turn.provenance.checkpointHash!==replay.checkpointHash)throw fail('evaluation_batch_task_unavailable');
 const callback=turn.input.callback;
 const prepared=prepareEvaluationCallbackTrace(callback.trace,callback.expectedTraceHash,callback.association);
 return prepared.seed.userMessage.content;
}
function prepareProductionScoring(config,state,candidate,suite,options,modelConfig){
 if(config.experiment===undefined)return null;
 const experiment=config.experiment;
 wikiExactKeys(experiment,['definition',...(experiment?.plan===undefined?[]:['plan'])]);
 const definition=experiment.definition,catalog=[],scope={globalRoot:config.globalRoot,sourceWorktree:config.sourceWorktree};
 const selections=suite.cases.filter(c=>!c.reportOnly).map(c=>({caseId:c.sourceCaseId,stage:c.stage,category:c.category,targetReproduction:c.targetReproduction}));
 if(!same(definition?.variants,[{id:'original',promptHash:candidate.baseHash},{id:'candidate',promptHash:candidate.candidateHash}])
   || !same(definition?.runner,{model:config.modelProfile,settings:modelConfig})
   || !same(definition?.cases?.map(({judge,...selection})=>selection),selections))throw fail('wiki_experiment_changed');
 const eligibleJudges=readWikiEligibleJudges(process.env.CAFF_WIKISKILL_JUDGES_CONFIG);
 for(const selection of definition.cases){
  const source=state.cases.find(c=>c.id===selection.caseId),item=config.cases.find(c=>c.sourceCaseId===selection.caseId);
  const rubric=resolveFrozenWikiRubric(state,selection.caseId,item?.rubricHash);
  if(!(source.kind==='marked-badcase'&&!source.sealedCheckpointId&&rubric.toolCheck&&!rubric.questions.length))assertWikiEligibleConfiguration(definition.kind==='wiki-experiment-v2'?selection.judge:definition.judge,eligibleJudges);
 }
 function scoringFor(source,item,task,run=false){
  if(item.topicExemption!==undefined || item.rulesRevision!==undefined)throw fail('evaluation_batch_cases_invalid');
  const rubric=resolveFrozenWikiRubric(state,source.id,item.rubricHash);
  const judge=definition.kind==='wiki-experiment-v2'?definition.cases.find(c=>c.caseId===source.id)?.judge:definition.judge;
  if(rubric.toolCheck&&!run)throw fail('wiki_tool_check_run_only');
  return {kind:'wiki-score-v2',rubric,binding:run&&rubric.toolCheck&&!rubric.questions.length?null:bindWikiJudge(judge,rubric),task,expected:source.expected};
 }
 return {
  forCase(source,replay,item){return scoringFor(source,item,(options.prepareProductionTask || readProductionScoringTask)(replay,scope));},
  forRun(source,item,task){
   const scoring=scoringFor(source,item,task,true);
   if(scoring.rubric.questions.some(q=>q.evidence!=='reply'))throw fail('wiki_rubric_run_evidence_invalid');
   return scoring;
  },
  recordRun(source,execution,scoring){
   catalog.push({id:source.id,sceneHash:wikiExperimentRunSceneHash(execution),execution:structuredClone(execution),
    task:scoring.task,actual:source.actual,expected:source.expected,hardAssertions:{kind:'completion-public-reply-v1'},rubric:scoring.rubric});
  },
  recordCase(source,replay,comparison,scoring){
   if(!comparison.supported)throw fail('evaluation_batch_task_unavailable');
   if(!same(comparison.summary.scoring,wikiScoringSummary(scoring)))throw fail('evaluation_batch_input_changed');
   catalog.push({id:source.id,sceneHash:wikiValueHash({checkpointHash:replay.checkpointHash,fixture:replay.fixture,
    commonInputHash:comparison.summary.commonInputHash??null}),task:scoring.task,actual:source.actual,expected:source.expected,
    hardAssertions:wikiObjectiveRules(replay.rules),rubric:scoring.rubric});
  },
  finish(){
   const plan=createWikiExperimentPlan(definition,catalog);
   if(experiment.plan!==undefined)assertWikiExperimentPlan(experiment.plan,definition,catalog);
   return plan;
  },
 };
}
module.exports={prepareProductionScoring,readProductionScoringTask};
