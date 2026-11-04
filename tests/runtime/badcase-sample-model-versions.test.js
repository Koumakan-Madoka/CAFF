// Synthetic offline closures only. No provider, Docker, SDK, SQLite or live data.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fixture=require('../helpers/badcase-initialization-fixture.cjs'),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const controlId='text-7364c69567dcfaa751e631b7dc90ac48f03c9ce3e5d12a0588f7ea93c94338ac';
function setup(t){
 const f=fixture(t,'fresh',({cp,r,config,put})=>{
  cp.agentId='role-family-gpt';r.runConfig.provider='deepseek';r.runConfig.model='deepseek-v4-flash';config.agentName='GPT';config.toolBridgeEnabled=true;
  config.portableRuntime={schemaVersion:1,kind:'portable-default-resources-v1',supported:true};config.sdkStartConfig={cwd:cp.targetDir,provider:'deepseek',model:'deepseek-v4-flash',thinking:'off',fast:false,resume:false,retireUserScopeSkills:true};
  const prompt='Archived identical sample task: read source.txt.';r.promptBlobHash=r.normalizedPromptHash=put(prompt);
  const association={projectId:'p1',conversationId:'c1',turnId:'t1',agentId:cp.agentId,userMessageId:'u1',assistantMessageId:'msg1'};
  const trace={schemaVersion:1,kind:'caff-evaluation-callback-input-v1',association,assistantCreatedAt:'2026-01-01T00:00:01.000Z',conversation:{title:'Sample',type:'standard',metadata:{}},participants:[{id:cp.agentId,name:'GPT',description:'GPT'}],publicMessages:[{id:'u1',turnId:'t0',role:'user',agentId:null,senderName:'User',content:'Read files.',status:'completed',createdAt:'2026-01-01T00:00:00.000Z',publicPostedAt:'',publicPostCount:0,publicPostMode:'',mentions:[]}],privateMessages:[],pendingDelegations:[]};
  r.callbackInput={schemaVersion:1,kind:'caff-evaluation-callback-input-reference-v1',blobHash:put(JSON.stringify(trace)),association};r.harness.configSnapshotHash=put(JSON.stringify(config));
 });
 const scope={globalRoot:path.join(f.root,'global'),sourceWorktree:path.join(f.root,'source')},store=require('../../build/server/domain/runtime/badcase-capture/wiki-store').createWikiStore(scope),state=store.read();state.revision=1;state.replaySplit={};state.cases.push({id:controlId,kind:'text-only',role:'GPT',split:'train',source:{agentId:'role-family-gpt'}});fs.mkdirSync(path.join(scope.globalRoot,'snapshots'),{recursive:true});fs.writeFileSync(path.join(scope.globalRoot,'snapshots','000000000001.json'),JSON.stringify({schemaVersion:1,record:state,checksum:hash(JSON.stringify(state))}));
 const prepared=require('../../scripts/badcase-capture/sealed-direct-input.cjs').prepareSealedOriginalTurn(f.request);assert.equal(prepared.supported,true,JSON.stringify(prepared));
 const parent=store.addReplayCase({sourceCaseId:controlId,category:'control',task:'Frozen approved task',fixture:{commit:'b'.repeat(40),sourceCommit:'b'.repeat(40),sourceSubdirectory:'sample',filesHash:'a'.repeat(64)},request:f.request,rules:{kind:'file-literals-v1',files:[{path:'source.txt',contains:['retained bytes'],notContains:[]}]},checkpointHash:prepared.provenance.checkpointHash});
 // The new output root is a sibling, never a child of the original capture root.
 const output=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'sample-model-output-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const config={...scope,outputRoot:path.join(output,'derived'),caseIds:[controlId],knownKeySources:{sandboxRoot:path.join(f.root,'.pi-sandbox'),jevSource:'TYPESAFE_API_KEY'}};
 return {f,scope,store,parent,prepared,config};
}
test('offline production fixture versions preserve task/files/rules/input, old seals and frozen splits; rerun is idempotent',t=>{
 const h=setup(t),{prepareSampleVersions,materializeSampleVersions}=require('../../scripts/badcase-capture/prepare-sample-model-versions.cjs'),options={knownValues:[]},before=h.store.read(),source=fs.readFileSync(h.f.source);
 const plan=prepareSampleVersions(h.config,options);assert.equal(plan.summary.modelCalls,0);assert.equal(plan.summary.historicalReproduction,false);assert.equal(fs.existsSync(h.config.outputRoot),false);assert.deepEqual(h.store.read(),before);
 assert.throws(()=>materializeSampleVersions(h.config,{...options,confirmed:true,expectedPlanHash:'0'.repeat(64)}),/evaluation_sample_confirmation_required/);assert.equal(fs.existsSync(h.config.outputRoot),false);
 const result=materializeSampleVersions(h.config,{...options,confirmed:true,expectedPlanHash:plan.summary.planHash}),state=h.store.read();assert.equal(state.replayVersions.length,1);const version=state.replayVersions[0];
 assert.equal(result.versions[0].replayVersionId,version.id);assert.equal(version.historicalReproduction,false);assert.equal(version.sourceModelConfig.thinking,'off');assert.equal(version.targetModelConfig.thinking,'xhigh');
 for(const key of ['cases','versions','replayCases','replaySplit','classifications'])assert.deepEqual(state[key],before[key]);assert.deepEqual(fs.readFileSync(h.f.source),source);
 const prepared=require('../../scripts/badcase-capture/sealed-direct-input.cjs').prepareSealedOriginalTurn(version.request);assert.equal(prepared.supported,true);assert.deepEqual(prepared.input.recordedModelConfig,version.targetModelConfig);
 assert.deepEqual({...prepared.input,recordedModelConfig:null},{...h.prepared.input,recordedModelConfig:null});
 const again=materializeSampleVersions(h.config,{...options,confirmed:true,expectedPlanHash:plan.summary.planHash});assert.deepEqual(again,result);assert.equal(h.store.read().revision,state.revision);
 assert.equal(require('../../build/server/domain/runtime/badcase-capture/wiki-sample-replay-version').resolveSampleReplayVersion(state,controlId,version.id).id,version.id);
});
test('migrated sample parents read only imports when the original capture root is unavailable',t=>{
 const h=setup(t),root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'sample-migration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sourceGlobal=path.join(root,'source-global');fs.cpSync(h.scope.globalRoot,sourceGlobal,{recursive:true});
 const migration=require('../../scripts/badcase-capture/migrate-wiki-layout.cjs'),config={globalRoot:sourceGlobal,sourceWorktree:h.scope.sourceWorktree,captureRoots:[h.f.root],destinationAgentDir:path.join(root,'copy')};
 const p=migration.prepareMigration(config);migration.migrateWikiLayout(config,{confirmed:true,expectedPlanHash:p.summary.planHash});
 const old=process.env.CAFF_WIKISKILL_DATA_DIR;process.env.CAFF_WIKISKILL_DATA_DIR=config.destinationAgentDir;
 const scope={...h.scope,globalRoot:path.join(config.destinationAgentDir,'badcase-global')},store=require('../../build/server/domain/runtime/badcase-capture/wiki-store').createWikiStore(scope),before=store.read();
 const imported=require('../../build/server/domain/runtime/badcase-capture/wiki-replay-location').resolveWikiReplayRequest(scope,h.parent.request);
 assert.ok(imported.captureRoot.startsWith(path.join(config.destinationAgentDir,'badcase-capture/imports')+path.sep));
 const offline=h.f.root+'-offline';fs.renameSync(h.f.root,offline);
 try{
  const {prepareSampleVersions,materializeSampleVersions}=require('../../scripts/badcase-capture/prepare-sample-model-versions.cjs'),options={knownValues:[]};
  const plan=prepareSampleVersions(h.config,options);assert.equal(plan.tasks[0].original.supported,true);assert.equal(plan.tasks[0].original.provenance.checkpointHash,h.parent.checkpointHash);
  assert.throws(()=>prepareSampleVersions({...h.config,outputRoot:path.join(imported.captureRoot,'derived')},options),/evaluation_sample_version_invalid/);
  const run=()=>materializeSampleVersions(h.config,{...options,confirmed:true,expectedPlanHash:plan.summary.planHash});
  assert.deepEqual(run(),run());assert.deepEqual(store.read().replayCases,before.replayCases);
  assert.deepEqual(plan.tasks[0].original.input,h.prepared.input);assert.equal(fs.existsSync(h.f.root),false,'no old-root reads recreate source directories');
  fs.renameSync(offline,h.f.root);
  const blob=h.f.cp.files['source.txt'].hash;fs.unlinkSync(path.join(imported.captureRoot,'projects/p1/blobs',blob.slice(0,2),blob));
  assert.throws(()=>prepareSampleVersions(h.config,options),/evaluation_sample_version_invalid/,'never fall back to the readable original when imports are damaged');
 }finally{if(fs.existsSync(offline))fs.renameSync(offline,h.f.root);if(old===undefined)delete process.env.CAFF_WIKISKILL_DATA_DIR;else process.env.CAFF_WIKISKILL_DATA_DIR=old;}
});
test('known values, unrelated sources, overlapping output roots and forged parent/version metadata fail before materialization',t=>{
 const h=setup(t),{prepareSampleVersions,materializeSampleVersions}=require('../../scripts/badcase-capture/prepare-sample-model-versions.cjs'),{resolveSampleReplayVersion}=require('../../build/server/domain/runtime/badcase-capture/wiki-sample-replay-version');
 assert.throws(()=>prepareSampleVersions(h.config,{knownValues:['retained bytes']}),/evaluation_output_contains_key/);assert.throws(()=>prepareSampleVersions({...h.config,outputRoot:path.join(h.f.root,'derived')},{knownValues:[]}),/evaluation_sample_version_invalid/);assert.equal(fs.existsSync(h.config.outputRoot),false);
 const plan=prepareSampleVersions(h.config,{knownValues:[]});materializeSampleVersions(h.config,{knownValues:[],confirmed:true,expectedPlanHash:plan.summary.planHash});
 for(const mutate of [s=>{s.cases[0].kind='marked-badcase';},s=>{s.replayVersions[0].rules.files[0].contains=['changed'];},s=>{s.replayVersions[0].sourceModelConfig.thinking='xhigh';},s=>{s.replayCases[0].checkpointHash='c'.repeat(64);}]){const s=h.store.read();mutate(s);assert.throws(()=>resolveSampleReplayVersion(s,controlId,s.replayVersions[0].id),/wiki_sample_version_invalid/);}
});
test('unowned output directories and missing CLI confirmation cannot be adopted or written',t=>{
 const h=setup(t),{prepareSampleVersions,materializeSampleVersions,argumentsFor}=require('../../scripts/badcase-capture/prepare-sample-model-versions.cjs');
 assert.throws(()=>materializeSampleVersions(h.config,{knownValues:[]}),/evaluation_sample_confirmation_required/);assert.equal(fs.existsSync(h.config.outputRoot),false);
 fs.mkdirSync(h.config.outputRoot);fs.writeFileSync(path.join(h.config.outputRoot,'foreign.txt'),'do not replace');assert.throws(()=>prepareSampleVersions(h.config,{knownValues:[]}),/evaluation_sample_output_not_owned/);assert.equal(fs.readFileSync(path.join(h.config.outputRoot,'foreign.txt'),'utf8'),'do not replace');assert.deepEqual(fs.readdirSync(h.config.outputRoot),['foreign.txt']);
 for(const argv of [['--config',path.resolve('x'),'--materialize'],['--config',path.resolve('x'),'--plan','--confirmed'],['--config',path.resolve('x'),'--plan','--unknown']])assert.throws(()=>argumentsFor(argv),/evaluation_sample_version_invalid/);
});
test('legacy thinking mismatch remains refused; only a newly sealed model-specific fixture is GPT compatible',t=>{
 const h=setup(t),{prepareSampleVersions,materializeSampleVersions}=require('../../scripts/badcase-capture/prepare-sample-model-versions.cjs'),{prepareComparison}=require('../../scripts/badcase-capture/direct-comparison.cjs');
 const config={request:h.parent.request,variants:['original'],repeats:1,repoRoot:path.resolve('.'),dependencyRoot:path.resolve('.'),image:{imageId:'sha256:'+'1'.repeat(64)},modelProfile:'openai-codex/gpt-6.1-sol',keySource:'caff-codex-access',codexAuthFile:path.join(h.f.root,'.pi-sandbox/auth.json'),rules:h.parent.rules};
 assert.deepEqual(prepareComparison(config),{supported:false,reason:'replay_thinking_profile_mismatch'});const p=prepareSampleVersions(h.config,{knownValues:[]});materializeSampleVersions(h.config,{knownValues:[],confirmed:true,expectedPlanHash:p.summary.planHash});const version=h.store.read().replayVersions[0];assert.equal(prepareComparison({...config,request:version.request}).supported,true);
});
