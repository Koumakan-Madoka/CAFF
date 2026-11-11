// Host-only v4 membership preflight. Reads only small current evidence records;
// never starts a precheck, opens credentials or materializes a model request.
const base='../../build/server/domain/runtime/badcase-capture/';
const {planWikiHoldoutGate}=require(base+'wiki-holdout-gate');
const {validateWikiHoldoutExperimentPlan}=require(base+'wiki-holdout-plan');
const {wikiConfirmedClassification}=require(base+'wiki-evaluation-suite');
const {createWikiOriginalPrecheckStore}=require(base+'wiki-original-precheck-store');
const {createWikiPipelinePrecheckStore,readWikiPipelineInputs}=require(base+'wiki-pipeline-prechecks');
const fail=code=>Object.assign(Error(code),{code});
function readProductionHoldoutEvidence(scope,state,targetEntryId){
 return {state,targetEntryId,records:createWikiOriginalPrecheckStore(scope).list(),
  replayChecks:readWikiPipelineInputs(state,createWikiPipelinePrecheckStore(scope))};
}
function readProductionHoldoutValidationEvidence(scope,state,targetEntryId,settings){
 const {wikiExactKeys}=require(base+'wiki-rubric');
 const {projectWikiHoldoutUsageHistory}=require(base+'wiki-holdout-usage');
 const {planWikiHoldoutValidation}=require(base+'wiki-holdout-validation');
 wikiExactKeys(settings,['seed',...(Object.hasOwn(settings,'policy')?['policy']:[]),...(Object.hasOwn(settings,'skippedCaseIds')?['skippedCaseIds']:[])]);
 const current=readProductionHoldoutEvidence(scope,state,targetEntryId);
 const {records,replayChecks}=current;
 const history=projectWikiHoldoutUsageHistory({state,records,replayChecks});
 const input={...current,...structuredClone(settings),history};
 planWikiHoldoutValidation(input); // Closed settings/selection, never execution.
 return input;
}
function prepareProductionHoldoutSuite(config,state,targetEntryId){
 if(config.experiment?.definition?.kind!=='wiki-experiment-v3')throw fail('evaluation_gate_config_invalid');
 const input=readProductionHoldoutEvidence({globalRoot:config.globalRoot,sourceWorktree:config.sourceWorktree},state,targetEntryId);
 const gate=planWikiHoldoutGate(input);
 if(!gate.caseIds.length)throw fail('wiki_holdout_plan_targets_required');
 if(!Array.isArray(config.cases)||config.cases.length!==gate.caseIds.length
  ||new Set(config.cases.map(c=>c.sourceCaseId)).size!==config.cases.length
  ||config.cases.some(c=>c.category!=='reproduction'||!gate.caseIds.includes(c.sourceCaseId)))throw fail('wiki_experiment_partition_changed');
 if(config.experiment.plan!==undefined){
  const retained=validateWikiHoldoutExperimentPlan(config.experiment.plan);
  if(retained.gate.hash!==gate.hash)throw fail('wiki_experiment_changed');
 }
 const cases=gate.caseIds.map(sourceCaseId=>{
  const source=state.cases.find(c=>c.id===sourceCaseId),classification=wikiConfirmedClassification(state,source);
  return {sourceCaseId,category:'reproduction',split:source.split,stage:'gate',family:'GPT',reportOnly:false,targetReproduction:true,
   classification:{entryId:classification.entryId,source:classification.source,confirmedAt:classification.confirmedAt}};
 });
 return {gate,cases,gateCaseIds:gate.caseIds.slice(),targetReproductionCaseIds:gate.caseIds.slice(),reportOnlyCaseIds:[]};
}
module.exports={prepareProductionHoldoutSuite,readProductionHoldoutEvidence,readProductionHoldoutValidationEvidence};
