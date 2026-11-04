// Production-model D15 planning. Pure preflight: never opens GPT auth, starts
// containers or mutates a frozen group. Repository/dependency restoration is
// per task; sample controls do not inherit a real repository's working tree.
const base='../../build/server/domain/runtime/badcase-capture/';
const {createWikiStore}=require(base+'wiki-store');
const {resolveWikiStorageOptions}=require(base+'wiki-data-directory');
const {resolveGlobalWikiCandidate}=require(base+'wiki-global-candidate');
const {collectWikiCandidateFiles}=require(base+'wiki-candidate-files');
const {planWikiEvaluationSuite}=require(base+'wiki-evaluation-suite');
const {resolveSampleReplayVersion}=require(base+'wiki-sample-replay-version');
const {prepareComparison,CODEX_CONFIG}=require('./direct-comparison.cjs');
const {CODEX_PROFILE}=require('./direct-model.cjs');
const {reviseSnapshotHeadRules,reviseTopicNumberRules}=require('./public-reply-literal-rules.cjs');
const {containsSecretSentinel}=require(base+'secrets');
const textHash=text=>require('node:crypto').createHash('sha256').update(text).digest('hex');
const fail=code=>Object.assign(Error(code),{code});
const {hashJson:hash}=require('./replay-streams.cjs');
function prepareProductionBatch(config,options={}){
 config=resolveWikiStorageOptions(config);
 const scope={globalRoot:config.globalRoot,sourceWorktree:config.sourceWorktree},state=createWikiStore(scope).read();
 if(config.modelProfile!==CODEX_PROFILE || config.keySource!=='caff-codex-access' || config.repeats!==10
   || !config.evaluation || Object.keys(config.evaluation).sort().join(',')!=='kind,targetEntryId'
   || config.evaluation.kind!=='wikiskill-gate-v1')throw fail('evaluation_gate_config_invalid');
 const saved=state.candidates.find(c=>c.id===config.candidateId && c.kind==='global-wiki-candidate-v1');
 if(!saved || !(saved.status==='confirmed' || options.allowDraftCandidate===true && saved.status==='draft'))throw fail('wiki_candidate_confirmation_required');
 if(saved.target?.kind!=='global-system-prompt')throw fail('evaluation_target_unsupported');
 if(saved.entryIds.length!==1 || saved.entryIds[0]!==config.evaluation.targetEntryId)throw fail('evaluation_gate_config_invalid');
 for(const item of config.cases)if(!item || Object.keys(item).some(k=>!['sourceCaseId','category','repository','dependencies','replayVersionId','rulesRevision','topicExemption'].includes(k))
   || item.rulesRevision!==undefined && item.rulesRevision!=='snapshot-head-exemption-v1')throw fail('evaluation_batch_cases_invalid');
 const suite=planWikiEvaluationSuite(state,config.cases,saved.entryIds[0]);
 // Require a genuine GPT target in each frozen stage. Other model families are
 // visible report-only rows, not GPT failures or favorable denominator slots.
 if(!suite.targetReproductionCaseIds.length || !suite.targetTestReproductionCaseIds.length
   || !suite.cases.some(c=>c.stage==='gate' && c.category==='control' && !c.reportOnly))throw fail('evaluation_gate_config_invalid');
 const candidate=resolveGlobalWikiCandidate(state,saved.id,saved.targetId,saved.baseHash,(options.collectProductionCandidateFiles || collectWikiCandidateFiles)(state,scope),{allowDraft:options.allowDraftCandidate===true});
 const version=state.versions.find(v=>v.id===candidate.versionId);
 if(version.caseIds.some(id=>suite.cases.some(c=>c.sourceCaseId===id && ['gate','test'].includes(c.stage)
   && state.cases.find(s=>s.id===id)?.kind==='marked-badcase')))throw fail('evaluation_batch_holdout_exposed');
 const seenSeals=new Set();
 const prepared=suite.cases.map(record=>{
  const source=state.cases.find(c=>c.id===record.sourceCaseId),item=config.cases.find(c=>c.sourceCaseId===source.id);
  const replay=item.replayVersionId===undefined?state.replayCases.find(c=>c.sourceCaseId===source.id):resolveSampleReplayVersion(state,source.id,item.replayVersionId);
  if(item.replayVersionId!==undefined&&(record.category!=='control'||item.repository!==undefined||item.dependencies!==undefined))throw fail('evaluation_batch_cases_invalid');
  if(record.reportOnly)return {...record,supported:false,reason:'non_gpt_source_report_only'};
  if(!replay)return {...record,supported:false,reason:'no_sealed_replay'};
  if(replay.category!==record.category || replay.split!==source.split)throw fail('evaluation_batch_cases_invalid');
  const a=replay.request.association,sealKey=JSON.stringify([replay.request.captureRoot,a.projectId,a.checkpointId]);
  if(seenSeals.has(sealKey))throw fail('evaluation_batch_cases_invalid');seenSeals.add(sealKey);
  if(source.kind==='marked-badcase' && (source.sealedCheckpointId!==a.checkpointId
    || ['projectId','conversationId','messageId','agentId'].some(k=>source.source[k]!==a[k])))throw fail('evaluation_batch_input_changed');
  if(source.kind==='marked-badcase' && (!item.repository || !item.dependencies))throw fail('evaluation_repository_restore_required');
  let rules=replay.rules;
  if(item.rulesRevision!==undefined){
   if(source.kind!=='marked-badcase' || rules.kind!=='public-reply-literals-v1')throw fail('evaluation_batch_cases_invalid');
   // Fixture commit was registered with this sealed checkpoint; never inspect
   // a live HEAD or accept a caller-written list of favorable hashes.
   if(item.repository?.head!==replay.fixture.commit)throw fail('evaluation_snapshot_head_mismatch');
   rules=reviseSnapshotHeadRules(rules,replay.fixture.commit);
  }
  let topicExemption;
  if(item.topicExemption!==undefined){
   const e=item.topicExemption;
   if(source.kind!=='marked-badcase' || record.category!=='reproduction' || !e || typeof e!=='object' || Array.isArray(e)
     || Object.keys(e).sort().join(',')!=='patterns,reason,taskHash' || e.taskHash!==textHash(replay.task)
     || typeof e.reason!=='string' || !e.reason.trim() || e.reason.includes('\0') || Buffer.byteLength(e.reason)>2048 || containsSecretSentinel(e.reason))throw fail('evaluation_topic_exemption_invalid');
   rules=reviseTopicNumberRules(rules,e.patterns);topicExemption=structuredClone(e);
  }
  const comparisonConfig={repoRoot:config.repoRoot,dependencyRoot:config.dependencyRoot,image:config.image,request:replay.request,rules,
    repeats:10,executionPolicy:'alternating-valid-v1',globalWikiCandidate:{...scope,candidateId:candidate.id},
    modelProfile:CODEX_PROFILE,keySource:config.keySource,codexAuthFile:config.codexAuthFile,knownKeySources:config.knownKeySources,
    ...(config.dockerBackend===undefined?{}:{dockerBackend:config.dockerBackend}),
    ...(config.timeoutMs===undefined?{}:{timeoutMs:config.timeoutMs}),
    ...(item.repository===undefined?{}:{repository:item.repository}),...(item.dependencies===undefined?{}:{dependencies:item.dependencies})};
  const plan=(options.prepareProductionComparison || prepareComparison)(comparisonConfig,options);
  if(plan.supported && plan.summary.checkpointHash!==replay.checkpointHash)throw fail('evaluation_batch_input_changed');
  if(plan.supported && item.replayVersionId!==undefined){
   const {recordedModelConfig,fileEvidencePaths,...unchanged}=plan.inputs?.original||{};
   if(JSON.stringify(recordedModelConfig)!==JSON.stringify(replay.targetModelConfig)||hash(unchanged)!==replay.unchangedInputHash)throw fail('evaluation_batch_input_changed');
  }
  return {...record,replayId:replay.id,fixture:replay.fixture,...(topicExemption?{topicExemption}:{}),...(plan.supported?{supported:true,comparison:plan.summary,comparisonConfig}:{supported:false,reason:plan.reason})};
 });
 const evaluation={kind:'wikiskill-gate-v1',splitPolicy:'d15-frozen-v1',targetEntryId:candidate.entryIds[0],
  gateCaseIds:suite.gateCaseIds,testCaseIds:suite.testCaseIds,targetReproductionCaseIds:suite.targetReproductionCaseIds,
  targetTestReproductionCaseIds:suite.targetTestReproductionCaseIds,reportOnlyCaseIds:suite.reportOnlyCaseIds,maxExtraAttemptsPerCase:5};
 const summary={kind:'wiki-staged-batch-comparison-v1',scope:'global',evaluation,configHash:hash(config),model:CODEX_PROFILE,modelConfig:{...CODEX_CONFIG},
  candidate:{id:candidate.id,targetId:candidate.targetId,baseHash:candidate.baseHash,candidateHash:candidate.candidateHash,versionId:candidate.versionId,entryIds:candidate.entryIds,...(candidate.experienceHash?{experienceHash:candidate.experienceHash}:{})},
  ...(saved.status==='draft'?{candidateConfirmationRequired:true}:{}),
  split:{policy:'d15-frozen-v1',caseIds:suite.cases.map(c=>c.sourceCaseId),gateCaseIds:suite.gateCaseIds,testCaseIds:suite.testCaseIds},
  additionalTrainingCaseIds:[],excludedSplitTrainingCaseIds:[],repeats:10,wikiTrainingCount:version.caseIds.length,
  preparedReplayableCount:prepared.filter(c=>c.supported).length,
  disclosures:['literal_rules_not_semantic_judgment','small_sample','model_configuration_bound','non_gpt_sources_report_only',
   ...(config.cases.some(c=>c.rulesRevision!==undefined)?['post_observation_snapshot_head_rule_revision']:[]),
   ...(config.cases.some(c=>c.topicExemption!==undefined)?['topic_number_exemption_new_round']:[])],
  cases:prepared.map(({comparisonConfig,...record})=>record)};
 return {summary:{...summary,planHash:hash(summary)},prepared};
}
module.exports={prepareProductionBatch};
