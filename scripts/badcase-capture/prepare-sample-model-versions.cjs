#!/usr/bin/env node
// Offline representative-fixture versioning, NOT capture of a new real turn.
// No provider calls, SDK starts or Docker launches. Old seals/tasks stay intact.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const base='../../build/server/domain/runtime/badcase-capture/';
const {createWikiStore}=require(base+'wiki-store');
const {createCaptureStore}=require(base+'capture-store');
const {readSealedCase,saveSealedCase}=require(base+'sealed-case');
const {createCheckpointRetentionStore}=require(base+'checkpoint-retention');
const {buildSampleReplayVersion,SAMPLE_MODEL_CONFIG}=require(base+'wiki-sample-replay-version');
const {prepareSealedOriginalTurn}=require('./sealed-direct-input.cjs');
const {readKnownKeyValues}=require('./known-key-values.cjs');
const fail=code=>Object.assign(Error(code),{code}),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function check(v){if(!v)throw fail('evaluation_sample_version_invalid');}
const withoutModel=input=>{const {recordedModelConfig,...rest}=input;return rest;};
const disjoint=(a,b)=>{const inside=(x,y)=>{const r=path.relative(x,y);return !r||!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);};return !inside(a,b)&&!inside(b,a);};
function prepareSampleVersions(config,options={}){
 config=require('../../build/server/domain/runtime/badcase-capture/wiki-data-directory').resolveWikiStorageOptions(config);
 check(config&&Object.keys(config).sort().join(',')==='caseIds,globalRoot,knownKeySources,outputRoot,sourceWorktree');
 check(path.isAbsolute(config.outputRoot||'')&&Array.isArray(config.caseIds)&&config.caseIds.length>0&&config.caseIds.length<=3&&new Set(config.caseIds).size===config.caseIds.length);
 const store=createWikiStore({globalRoot:config.globalRoot,sourceWorktree:config.sourceWorktree}),state=store.read();
 for(const root of [config.globalRoot,config.sourceWorktree])check(disjoint(path.resolve(root),path.resolve(config.outputRoot)));
 const known=options.knownValues===undefined?readKnownKeyValues(config.knownKeySources).values:options.knownValues;check(Array.isArray(known)&&known.every(v=>typeof v==='string'&&v.length));
 const tasks=config.caseIds.map(sourceCaseId=>{
  const parent=state.replayCases.find(r=>r.sourceCaseId===sourceCaseId);check(parent);
  check(disjoint(path.resolve(parent.request.captureRoot),path.resolve(config.outputRoot)));
  const original=prepareSealedOriginalTurn(parent.request);check(original.supported&&original.provenance.checkpointHash===parent.checkpointHash&&original.input.sessionText===null);
  const source=createCaptureStore({captureRoot:parent.request.captureRoot}),a=parent.request.association,sealed=readSealedCase(parent.request);
  const retained=createCheckpointRetentionStore({captureStore:source}).get({projectId:a.projectId,checkpointId:a.checkpointId,conversationId:a.conversationId,turnId:a.turnId,agentId:a.agentId,referenceId:sealed.referenceId});check(retained);
  const checkpoint=structuredClone(retained.checkpoint),r=checkpoint.replayInput,blobs=new Map(retained.blobHashes.map(h=>[h,source.readBlob(a.projectId,h)]));
  const snapshot=JSON.parse(blobs.get(r.harness.configSnapshotHash).toString('utf8'));
  checkpoint.checkpointId='sample-model-'+hash(parent.id+'\0'+JSON.stringify(SAMPLE_MODEL_CONFIG)).slice(0,40);
  snapshot.sdkStartConfig={...snapshot.sdkStartConfig,...SAMPLE_MODEL_CONFIG};
  r.runConfig={...r.runConfig,provider:SAMPLE_MODEL_CONFIG.provider,model:SAMPLE_MODEL_CONFIG.model};
  const newSnapshot=Buffer.from(JSON.stringify(snapshot));r.harness.configSnapshotHash=hash(newSnapshot);blobs.set(r.harness.configSnapshotHash,newSnapshot);
  const request={captureRoot:path.join(config.outputRoot,hash(sourceCaseId).slice(0,32)),flagId:parent.request.flagId,association:{...a,checkpointId:checkpoint.checkpointId}};
  const versionInput={sourceCaseId,parentReplayId:parent.id,request,checkpointHash:hash(JSON.stringify(checkpoint)),sourceModelConfig:original.input.recordedModelConfig,unchangedInputHash:hash(JSON.stringify(withoutModel(original.input)))};
  const version=buildSampleReplayVersion(state,versionInput);
  // Known values are only compared in memory, never printed or persisted.
  for(const bytes of [...blobs.values(),Buffer.from(JSON.stringify(checkpoint)),Buffer.from(JSON.stringify(version))])for(const v of known)for(const needle of new Set([v,JSON.stringify(v).slice(1,-1),Buffer.from(v).toString('base64')]))if(bytes.includes(needle))throw fail('evaluation_output_contains_key');
  return {parent,original,checkpoint,blobs,versionInput,version};
 });
 const summary={kind:'sample-production-model-version-plan-v1',historicalReproduction:false,configHash:hash(JSON.stringify(config)),modelProfile:'openai-codex/gpt-6.1-sol',modelConfig:{...SAMPLE_MODEL_CONFIG},cases:tasks.map(t=>({sourceCaseId:t.parent.sourceCaseId,parentReplayId:t.parent.id,replayVersionId:t.version.id,sourceCheckpointHash:t.parent.checkpointHash,checkpointHash:t.version.checkpointHash,sourceModelConfig:t.version.sourceModelConfig,unchangedInputHash:t.version.unchangedInputHash,rulesHash:hash(JSON.stringify(t.parent.rules)),filesUnchanged:true,promptUnchanged:true})),modelCalls:0};
 const publicPlan={...summary,planHash:hash(JSON.stringify(summary))},owner={kind:'sample-model-version-output-v1',planHash:publicPlan.planHash,configHash:publicPlan.configHash};
 if(fs.existsSync(config.outputRoot)){
  const stat=fs.lstatSync(config.outputRoot);check(stat.isDirectory()&&!stat.isSymbolicLink());
  let found;try{const marker=path.join(config.outputRoot,'owner.json'),s=fs.lstatSync(marker);check(s.isFile()&&!s.isSymbolicLink()&&s.size<4096);found=JSON.parse(fs.readFileSync(marker,'utf8'));}catch{throw fail('evaluation_sample_output_not_owned');}
  if(JSON.stringify(found)!==JSON.stringify(owner))throw fail('evaluation_sample_output_not_owned');
 }
 return {summary:publicPlan,tasks,store,owner};
}
function materializeSampleVersions(config,options={}){
 if(options.confirmed!==true)throw fail('evaluation_sample_confirmation_required');
 const plan=prepareSampleVersions(config,options);if(plan.summary.planHash!==options.expectedPlanHash)throw fail('evaluation_sample_confirmation_required');
 if(!fs.existsSync(config.outputRoot)){
  fs.mkdirSync(path.dirname(config.outputRoot),{recursive:true});fs.mkdirSync(config.outputRoot);
  fs.writeFileSync(path.join(config.outputRoot,'owner.json'),JSON.stringify(plan.owner)+'\n',{flag:'wx',mode:0o600});
 }
 const versions=[];
 for(const task of plan.tasks){
  const existing=(plan.store.read().replayVersions||[]).find(v=>v.id===task.version.id);
  if(existing){const prepared=prepareSealedOriginalTurn(existing.request);check(prepared.supported&&prepared.provenance.checkpointHash===existing.checkpointHash&&JSON.stringify(prepared.input.recordedModelConfig)===JSON.stringify(SAMPLE_MODEL_CONFIG)&&hash(JSON.stringify(withoutModel(prepared.input)))===existing.unchangedInputHash);versions.push(existing);continue;}
  const destination=createCaptureStore({captureRoot:task.version.request.captureRoot}),project=task.version.request.association.projectId;
  // Only a new private fixture closure is written; source policy/CAS/seals are
  // never edited and no original model output is copied as a fresh result.
  const existingCheckpoint=destination.loadCheckpoint(project,task.checkpoint.checkpointId);
  if(existingCheckpoint)check(JSON.stringify(existingCheckpoint)===JSON.stringify(task.checkpoint));
  for(const [digest,bytes]of task.blobs)destination.writeBlob(project,digest,bytes);
  if(!existingCheckpoint)destination.saveCheckpoint(project,task.checkpoint);saveSealedCase(task.version.request);
  const prepared=prepareSealedOriginalTurn(task.version.request);
  check(prepared.supported&&prepared.provenance.checkpointHash===task.version.checkpointHash&&JSON.stringify(prepared.input.recordedModelConfig)===JSON.stringify(SAMPLE_MODEL_CONFIG));
  check(JSON.stringify(withoutModel(prepared.input))===JSON.stringify(withoutModel(task.original.input)));
  versions.push(plan.store.addSampleReplayVersion(task.versionInput));
 }
 return {preparedOnly:false,...plan.summary,versions:versions.map(v=>({sourceCaseId:v.sourceCaseId,replayVersionId:v.id,checkpointHash:v.checkpointHash,historicalReproduction:false}))};
}
function argumentsFor(argv){
 const args={};for(let i=0;i<argv.length;i++){const k=argv[i];check(['--config','--plan','--materialize','--confirmed','--expected-plan'].includes(k)&&!Object.hasOwn(args,k));args[k]=['--config','--expected-plan'].includes(k)?argv[++i]:true;}
 check(path.isAbsolute(args['--config']||'')&&!!args['--plan']!==!!args['--materialize']);
 check(args['--plan']?!args['--confirmed']&&!args['--expected-plan']:args['--confirmed']===true&&/^[a-f0-9]{64}$/.test(args['--expected-plan']||''));return args;
}
function main(argv=process.argv.slice(2)){
 const args=argumentsFor(argv),stat=fs.lstatSync(args['--config']);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=1024*1024);const config=JSON.parse(fs.readFileSync(args['--config'],'utf8'));
 const result=args['--plan']?{preparedOnly:true,...prepareSampleVersions(config).summary}:materializeSampleVersions(config,{confirmed:true,expectedPlanHash:args['--expected-plan']});process.stdout.write(JSON.stringify(result,null,2)+'\n');return result;
}
if(require.main===module)try{main();}catch(e){process.stderr.write(JSON.stringify({error:/^(evaluation|wiki)_[a-z_]+$/.test(e?.code||'')?e.code:'evaluation_sample_version_failed'})+'\n');process.exitCode=1;}
module.exports={prepareSampleVersions,materializeSampleVersions,argumentsFor,main};
