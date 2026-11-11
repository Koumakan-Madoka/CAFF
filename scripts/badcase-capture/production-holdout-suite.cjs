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
 const full=config.evaluation?.kind==='wikiskill-mode-holdout-v1',scope={globalRoot:config.globalRoot,sourceWorktree:config.sourceWorktree};
 const input=full?readProductionHoldoutValidationEvidence(scope,state,targetEntryId,config.evaluation.validation):readProductionHoldoutEvidence(scope,state,targetEntryId);
 const gate=planWikiHoldoutGate({state,targetEntryId,records:input.records,replayChecks:input.replayChecks});
 const validation=full?require(base+'wiki-holdout-validation').planWikiHoldoutValidation(input):null;
 if(!gate.caseIds.length)throw fail('wiki_holdout_plan_targets_required');
 const selectedIds=[...gate.caseIds,...(validation?.caseIds||[])];
 if(!Array.isArray(config.cases)||config.cases.length!==selectedIds.length
  ||new Set(config.cases.map(c=>c.sourceCaseId)).size!==config.cases.length
  ||config.cases.some(c=>!selectedIds.includes(c.sourceCaseId)||c.category!==(gate.caseIds.includes(c.sourceCaseId)?'reproduction':'control')))throw fail('wiki_experiment_partition_changed');
 if(config.experiment.plan!==undefined){
  const retained=full?require(base+'wiki-holdout-validation-plan').validateWikiHoldoutFullExperimentPlan(config.experiment.plan):validateWikiHoldoutExperimentPlan(config.experiment.plan);
  if(retained.gate.hash!==gate.hash||full&&retained.validation.hash!==validation.hash)throw fail('wiki_experiment_changed');
 }
 const cases=selectedIds.map(sourceCaseId=>{
  const source=state.cases.find(c=>c.id===sourceCaseId),classification=wikiConfirmedClassification(state,source),control=validation?.caseIds.includes(sourceCaseId);
  return {sourceCaseId,category:control?'control':'reproduction',split:source.split,stage:control?'validation':'gate',family:'GPT',reportOnly:false,targetReproduction:!control,
   classification:{entryId:classification.entryId,source:classification.source,confirmedAt:classification.confirmedAt}};
 });
 return {gate,...(validation?{validation}:{}),cases,gateCaseIds:gate.caseIds.slice(),...(validation?{validationCaseIds:validation.caseIds.slice()}:{}),targetReproductionCaseIds:gate.caseIds.slice(),reportOnlyCaseIds:[]};
}
module.exports={prepareProductionHoldoutSuite,readProductionHoldoutEvidence,readProductionHoldoutValidationEvidence};
