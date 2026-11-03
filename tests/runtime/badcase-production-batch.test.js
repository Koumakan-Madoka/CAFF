// Planning-only contracts. All records/paths are synthetic; never authenticate,
// launch Docker or send a model request. Kernel evidence has separate tests.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createWikiStore}=require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const {collectWikiCandidateFiles}=require('../../build/server/domain/runtime/badcase-capture/wiki-candidate-files');
const {getGlobalPromptTarget}=require('../../build/lib/agent-prompt-targets');
const {prepareBatch,runBatch}=require('../../scripts/badcase-capture/batch-comparison.cjs');
const PROFILE='openai-codex/gpt-6.1-sol',digest='a'.repeat(64),controlId='text-7364c69567dcfaa751e631b7dc90ac48f03c9ce3e5d12a0588f7ea93c94338ac';
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'production-batch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const scope={globalRoot:path.join(root,'global'),sourceWorktree:path.join(root,'source')},store=createWikiStore(scope);
 const train=store.addTextCases(Array.from({length:4},(_,n)=>({source:{origin:'http://127.0.0.1:3100',projectId:'old',conversationId:'room',messageId:'m'+n,agentId:'role-family-gpt'},role:'GPT',actual:'jargon',expected:'unique expected '+n,message:'',traceExcerpt:'',traceState:'missing',messageTruncated:false,traceTruncated:false}))).cases;
 store.setReplaySplit({caseIds:train.map(c=>c.id)});
 const version=store.saveDraft({model:'deepseek/deepseek-v4-flash',caseIds:train.map(c=>c.id),entries:[{title:'Plain report',failureMode:'jargon',symptoms:'unclear',rootCauseHypothesis:'audience',guideline:'先讲结论。',caseIds:train.map(c=>c.id)}],unclassified:[]});store.review({versionId:version.id,entryId:'entry-1',expectedRevision:store.read().revision,decision:'approved'});
 const files=collectWikiCandidateFiles(store.read()),candidate=store.createGlobalCandidate({versionId:version.id,entryIds:['entry-1'],targetId:'global-harness-behavior-v1',files});store.confirmGlobalCandidate({candidateId:candidate.id,candidateHash:candidate.candidateHash,expectedRevision:store.read().revision,files});
 const marks=Array.from({length:4},(_,n)=>store.addMarkedCase({source:{projectId:'p1',conversationId:'room-'+n,conversationTitle:'Synthetic '+n,messageId:'msg-'+n,agentId:n<2?'role-family-gpt':'role-family-deepseek'},role:n<2?'role-family-gpt':'role-family-deepseek',actual:'unclear',expected:'clear',message:'',traceExcerpt:'',traceState:'missing',messageTruncated:false,traceTruncated:false,sealedCheckpointId:'cp-'+n,createdAt:`2026-11-03T00:00:0${n}.000Z`}).case);
 store.recordPreclassification({model:'deepseek/deepseek-v4-flash',caseIds:marks.map(c=>c.id),proof:{inputHash:digest,calls:[],cleaned:true},results:marks.map(c=>({caseId:c.id,kind:'assign',entryId:'entry-1',reason:'matching symptoms',confidence:'高'}))},store.read().revision);
 // Trusted historical sample fixture, with the exact grandfathered display ID.
 const s=store.read();s.revision++;s.cases.push({id:controlId,kind:'text-only',role:'GPT',split:'train',source:{agentId:'role-family-gpt'},createdAt:'2026-01-01T00:00:00.000Z'});fs.writeFileSync(path.join(scope.globalRoot,'snapshots',String(s.revision).padStart(12,'0')+'.json'),JSON.stringify({schemaVersion:1,checksum:sha(JSON.stringify(s)),record:s}));
 const rules={kind:'public-reply-literals-v1',leadChars:120,conclusionMarkers:['结论'],forbiddenTerms:[],forbiddenPatterns:[]};
 for(const [i,c]of [...marks,store.read().cases.find(c=>c.id===controlId)].entries())store.addReplayCase({sourceCaseId:c.id,category:i<4?'reproduction':'control',task:'Synthetic task',fixture:{commit:'b'.repeat(40),sourceCommit:'b'.repeat(40),sourceSubdirectory:'sample',filesHash:digest},request:{captureRoot:path.join(root,'capture-'+i),association:{projectId:'p1',conversationId:i<4?'room-'+i:'sample-room',messageId:i<4?'msg-'+i:'sample-msg',checkpointId:'cp-'+i,turnId:'turn-'+i,agentId:i<2||i===4?'role-family-gpt':'role-family-deepseek',taskId:'task-'+i,runId:1},flagId:'flag-'+sha('p1\0'+(i<4?'msg-'+i:'sample-msg'))},rules,checkpointHash:digest});
 const config={...scope,repoRoot:root,dependencyRoot:root,image:{imageId:'sha256:'+'1'.repeat(64)},candidateId:candidate.id,modelProfile:PROFILE,keySource:'caff-codex-access',codexAuthFile:path.join(root,'.pi-sandbox','auth.json'),knownKeySources:{sandboxRoot:path.join(root,'.pi-sandbox'),jevSource:'TYPESAFE_API_KEY'},repeats:10,evaluation:{kind:'wikiskill-gate-v1',targetEntryId:'entry-1'},cases:[...marks.map(c=>({sourceCaseId:c.id,category:'reproduction',repository:{sourceRoot:root,head:'b'.repeat(40)},dependencies:{kind:'npm-ci-linux-v1',cacheRoot:path.join(root,'cache')}})),{sourceCaseId:controlId,category:'control'}]};
 const calls=[];const options={collectProductionCandidateFiles:()=>[],prepareProductionComparison:c=>{calls.push(c);return {supported:true,summary:{checkpointHash:digest,checkpointId:c.request.association.checkpointId,rulesHash:sha(JSON.stringify(c.rules)),model:PROFILE,modelConfig:{api:'openai-codex-responses',thinking:'xhigh',fast:false,transport:'sse',credentialDelivery:'host-only-mailbox'}}};}};
 const confirm=c=>store.assignCase({caseId:c.id,entryId:'entry-1',expectedRevision:store.read().revision});
 return {store,marks,candidate,config,options,calls,confirm,plan:()=>prepareBatch(config,options)};
}
test('production planner blocks every unconfirmed holdout before kernel/auth; confirmed raw GPT roles become target rows',t=>{
 const h=fixture(t);assert.throws(h.plan,/wiki_classification_confirmation_required/);assert.equal(h.calls.length,0);
 for(const c of h.marks.slice(0,3))h.confirm(c);assert.throws(h.plan,/wiki_classification_confirmation_required/);h.confirm(h.marks[3]);
 const before=h.store.read(),p=h.plan();assert.deepEqual(h.store.read(),before);assert.equal(p.summary.model,PROFILE);assert.equal(p.summary.modelConfig.thinking,'xhigh');
 assert.deepEqual(p.summary.evaluation.targetReproductionCaseIds,[h.marks[0].id]);assert.deepEqual(p.summary.evaluation.targetTestReproductionCaseIds,[h.marks[1].id]);
 assert.equal(p.summary.evaluation.reportOnlyCaseIds.length,2);assert.equal(h.calls.length,3);assert.equal(p.summary.preparedReplayableCount,3);
 assert.ok(p.prepared.filter(c=>c.reportOnly).every(c=>c.reason==='non_gpt_source_report_only' && !c.comparisonConfig));
 assert.equal(h.calls.find(c=>c.request.association.checkpointId==='cp-4').repository,undefined);assert.ok(h.calls.find(c=>c.request.association.checkpointId==='cp-0').repository);
 assert.ok(h.calls.every(c=>c.modelProfile===PROFILE && c.keySource==='caff-codex-access' && c.executionPolicy==='alternating-valid-v1'));
 assert.equal(JSON.stringify(p.summary).includes(h.config.codexAuthFile),false);assert.ok(!p.summary.disclosures.includes('proxy_model_deepseek'));
});
function fakeExecution(h,{improve=true}={}){
 const events=[],calls=[];let legacyReads=0;
 const options={...h.options,confirmed:true,expectedPlanHash:h.plan().summary.planHash,onEvent:e=>events.push(e),readKey:()=>{legacyReads++;throw Error('Proxy credential forbidden');},
  runProductionComparison:async(config,options)=>{calls.push(config);const id=config.request.association.checkpointId,runs=[];options.onEvent({event:'plan',runtimeHash:digest});
   for(let i=1;i<=10;i++)for(const variant of ['original','candidate']){const row={variant,iteration:i,status:improve&&id==='cp-0'&&variant==='original'?'fail':'pass',replySource:'public',cleaned:true,finalText:'PRIVATE-WORKER-REPLY-NOT-FOR-PAGE',modelCalls:[{model:PROFILE,durationMs:1,success:true}],durationMs:1};runs.push(row);options.onEvent({event:'run_start',variant,iteration:i});options.onEvent({event:'model_call',variant,iteration:i,model:PROFILE});options.onEvent({event:'run',...row});}
   return {completed:true,runs,modelCallsKnown:20,callsUnavailable:false};}};
 return {events,calls,options,legacyReads:()=>legacyReads,run:()=>runBatch(h.config,options)};
}
test('production staged execution uses only native per-case path, reports other families without pooling and persists safe GPT/config results',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const f=fakeExecution(h),r=await f.run();assert.equal(f.legacyReads(),0);assert.equal(f.calls.length,3);assert.equal(r.modelCallsKnown,60);assert.equal(r.gateDecision.outcome,'accepted');assert.equal(r.completed,true);
 assert.equal(r.byStage.gate.original.planned,20);assert.equal(r.byStage.test.original.planned,10);assert.ok(r.cases.filter(c=>c.reportOnly).every(c=>c.reason==='non_gpt_source_report_only'&&!c.runs.length));
 const gateAt=f.events.findIndex(e=>e.event==='gate_decision'),testAt=f.events.findIndex(e=>e.event==='run'&&e.stage==='test');assert.ok(gateAt>=0&&testAt>gateAt);
 const store=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config),saved=store.save(r);assert.equal(saved.model,PROFILE);assert.equal(saved.modelConfig.thinking,'xhigh');assert.deepEqual(store.read()[0],saved);assert.equal(JSON.stringify(saved).includes('PRIVATE-WORKER-REPLY-NOT-FOR-PAGE'),false);assert.equal(saved.byStage.gate.original.planned,20);
 for(const mutate of [s=>{s.modelConfig.thinking='off';},s=>{s.gateDecision.outcome='rejected';},s=>{s.cases.find(c=>c.sourceCaseId===h.marks[0].id).reportOnly=true;}]){const forged=structuredClone(r);mutate(forged);assert.throws(()=>store.save(forged),/wiki_comparison_invalid/);}
 const output=require('../../scripts/badcase-capture/staged-batch.cjs').formatStagedBatch(r);assert.match(output,/gpt-6.1-sol/);assert.match(output,/xhigh/);assert.doesNotMatch(output,/代理模型 DeepSeek/);
});
test('production gate rejection never executes GPT test or non-GPT rows, and saved stages keep separate denominators',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const f=fakeExecution(h,{improve:false}),r=await f.run();assert.equal(r.gateDecision.outcome,'rejected');assert.equal(f.calls.length,2);assert.equal(r.completed,true);assert.equal(r.byStage.test.original.attempted,0);assert.equal(r.byStage.test.original.notRun,10);
 const saved=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).save(r);assert.deepEqual(saved.byStage,r.byStage);assert.equal(saved.totals,undefined);
});
test('native auth/expiry errors stop the batch, keep a safe cause and never fall back to a proxy or run tests',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const f=fakeExecution(h);let calls=0;
 f.options.runProductionComparison=async()=>{calls++;throw Object.assign(Error('PRIVATE-AUTH-DIAGNOSTIC'),{code:'evaluation_codex_access_expired'});};
 const r=await f.run();assert.equal(calls,1);assert.equal(f.legacyReads(),0);assert.equal(r.completed,false);assert.equal(r.gateDecision.outcome,'indeterminate');
 assert.ok(r.cases.some(c=>c.reason==='evaluation_codex_access_expired'));assert.equal(r.byStage.test.original.attempted,0);assert.equal(JSON.stringify(r).includes('PRIVATE-AUTH-DIAGNOSTIC'),false);
 const store=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config);assert.equal(store.save(r).completed,false);
});
test('stale human classification cannot be hidden by forged report-only/source metadata at publication',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const r=await fakeExecution(h).run();h.store.assignCase({caseId:h.marks[0].id,entryId:null,expectedRevision:h.store.read().revision});
 const store=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config);assert.throws(()=>store.save(r),/wiki_comparison_invalid/);
});
test('production plan pins complete configuration/rules/restore sources and rechecks human classification',t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const p=h.plan();h.config.timeoutMs=2700000;assert.notEqual(h.plan().summary.planHash,p.summary.planHash);
 h.config.cases[0].repository.head='c'.repeat(40);assert.notEqual(h.plan().summary.planHash,p.summary.planHash);
 h.store.assignCase({caseId:h.marks[1].id,entryId:null,expectedRevision:h.store.read().revision});assert.throws(h.plan,/evaluation_gate_config_invalid/);
});
test('production plans explicitly select a registered sample model version; original registration stays unchanged and forged selection is rejected',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const parent=h.store.read().replayCases.find(r=>r.sourceCaseId===controlId),before=structuredClone(parent);
 const version=h.store.addSampleReplayVersion({sourceCaseId:controlId,parentReplayId:parent.id,request:{...parent.request,captureRoot:path.join(h.config.repoRoot,'new-control-closure'),association:{...parent.request.association,checkpointId:'cp-control-gpt'}},checkpointHash:'c'.repeat(64),sourceModelConfig:{provider:'deepseek',model:'deepseek-v4-flash',thinking:'off',fast:false},unchangedInputHash:sha(JSON.stringify({kind:'synthetic-control-input'}))});
 h.config.cases.find(c=>c.sourceCaseId===controlId).replayVersionId=version.id;const prepare=h.options.prepareProductionComparison;
 h.options.prepareProductionComparison=c=>{const result=prepare(c);if(c.request.association.checkpointId==='cp-control-gpt'){result.summary.checkpointHash='c'.repeat(64);result.summary.recordedModelConfig=version.targetModelConfig;result.inputs={original:{kind:'synthetic-control-input',recordedModelConfig:version.targetModelConfig}};}return result;};
 const p=h.plan();assert.equal(p.prepared.find(c=>c.sourceCaseId===controlId).replayId,version.id);assert.equal(h.calls.find(c=>c.request.association.checkpointId==='cp-control-gpt').request.captureRoot,version.request.captureRoot);assert.deepEqual(h.store.read().replayCases.find(r=>r.sourceCaseId===controlId),before);
 const result=await fakeExecution(h).run(),saved=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).save(result);assert.equal(saved.cases.find(c=>c.sourceCaseId===controlId).replayId,version.id);assert.match(require('../../scripts/badcase-capture/staged-batch.cjs').formatStagedBatch(result),/样例.*新版本.*非历史复现/);
 const changed=structuredClone(result);changed.cases.find(c=>c.sourceCaseId===controlId).comparison.checkpointHash='d'.repeat(64);assert.throws(()=>require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).save(changed),/wiki_comparison_invalid/);
 h.config.cases[0].replayVersionId=version.id;assert.throws(h.plan,/wiki_sample_version_invalid/);
});
test('trusted staged CLI publishes partial progress before a case finishes and saves the result without another model call',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const f=fakeExecution(h),file=path.join(h.config.repoRoot,'config.json'),output=file+'.jsonl';fs.writeFileSync(file,JSON.stringify(h.config));
 const {main}=require('../../scripts/badcase-capture/compare-wiki-batch.cjs'),{createWikiBatchExecutionStore}=require('../../build/server/domain/runtime/badcase-capture/wiki-batch-execution-store');
 const progress=createWikiBatchExecutionStore(h.config),compare=f.options.runProductionComparison;let observed=0;
 f.options.runProductionComparison=async(c,o)=>{const r=await compare(c,o);const current=progress.read()[0];assert.equal(current.status,'running');assert.ok(current.summary.completedRuns>=20);observed++;return r;};
 const write=process.stdout.write;process.stdout.write=()=>true;
 try{await main(['--config',file,'--plan'],h.options);assert.deepEqual(progress.read(),[]);
  await assert.rejects(main(['--config',file,'--run','--confirmed','--expected-plan','0'.repeat(64),'--output',output],f.options),/evaluation_batch_confirmation_required/);assert.deepEqual(progress.read(),[]);
  await main(['--config',file,'--run','--confirmed','--expected-plan',h.plan().summary.planHash,'--output',output],f.options);
 }finally{process.stdout.write=write;}
 assert.equal(observed,3);const saved=progress.read()[0];assert.equal(saved.status,'completed');assert.equal(saved.gateOutcome,'accepted');assert.equal(saved.summary.completedRuns,60);assert.ok(saved.comparisonId);assert.doesNotMatch(JSON.stringify(saved),/PRIVATE-WORKER/);
 const evidence=fs.readFileSync(output,'utf8');assert.match(evidence,/page_execution/);assert.match(evidence,/page_execution_finished/);
});
test('staged CLI completes a rejected gate with tests unrun and preserves a stopped auth failure without retry',async t=>{
 for(const mode of ['rejected','auth-failed']){
  const h=fixture(t);for(const c of h.marks)h.confirm(c);const f=fakeExecution(h,{improve:false}),file=path.join(h.config.repoRoot,'config.json'),output=file+'.jsonl';fs.writeFileSync(file,JSON.stringify(h.config));let attempts=0;
  if(mode==='auth-failed')f.options.runProductionComparison=async()=>{attempts++;throw Object.assign(Error('PRIVATE-AUTH-BODY'),{code:'evaluation_codex_access_expired'});};
  const {main}=require('../../scripts/badcase-capture/compare-wiki-batch.cjs'),write=process.stdout.write,exitCode=process.exitCode;process.stdout.write=()=>true;
  try{await main(['--config',file,'--run','--confirmed','--expected-plan',h.plan().summary.planHash,'--output',output],f.options);}finally{process.stdout.write=write;process.exitCode=exitCode;}
  const progress=require('../../build/server/domain/runtime/badcase-capture/wiki-batch-execution-store').createWikiBatchExecutionStore(h.config).read()[0];assert.equal(progress.status,mode==='rejected'?'completed':'stopped');assert.equal(progress.gateOutcome,mode==='rejected'?'rejected':'indeterminate');assert.equal(progress.summary.byStage.test.original.attempted,0);assert.ok(progress.comparisonId);
  if(mode==='auth-failed')assert.equal(attempts,1);assert.doesNotMatch(fs.readFileSync(output,'utf8'),/PRIVATE-AUTH-BODY/);
 }
});
test('a transient progress write failure stops paid execution, retains fsynced evidence and marks the record failed',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const f=fakeExecution(h),file=path.join(h.config.repoRoot,'config.json'),output=file+'.jsonl';fs.writeFileSync(file,JSON.stringify(h.config));
 const {main}=require('../../scripts/badcase-capture/compare-wiki-batch.cjs'),compare=f.options.runProductionComparison,rename=fs.renameSync;let injected=false;
 f.options.runProductionComparison=async(c,o)=>compare(c,{...o,onEvent:e=>{
  if(e.event==='run_start'&&!injected){injected=true;fs.renameSync=(...args)=>{fs.renameSync=rename;throw Object.assign(Error('PRIVATE-FILESYSTEM-CAUSE'),{code:'EIO'});};}
  return o.onEvent(e);
 }});
 await assert.rejects(main(['--config',file,'--run','--confirmed','--expected-plan',h.plan().summary.planHash,'--output',output],f.options),/evaluation_progress_write_failed/);fs.renameSync=rename;
 assert.equal(injected,true);assert.equal(f.calls.length,1);const progress=require('../../build/server/domain/runtime/badcase-capture/wiki-batch-execution-store').createWikiBatchExecutionStore(h.config).read()[0];assert.equal(progress.status,'failed');assert.equal(progress.summary.completedRuns,0);assert.equal(progress.summary.byStage.test.original.attempted,0);
 const evidence=fs.readFileSync(output,'utf8');assert.match(evidence,/run_start/);assert.match(evidence,/page_execution_failed/);assert.doesNotMatch(evidence,/PRIVATE-FILESYSTEM-CAUSE/);
});
test('CLI output collision starts neither progress nor paid execution',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const f=fakeExecution(h),file=path.join(h.config.repoRoot,'config.json'),output=file+'.jsonl';fs.writeFileSync(file,JSON.stringify(h.config));fs.writeFileSync(output,'retained');
 const {main}=require('../../scripts/badcase-capture/compare-wiki-batch.cjs');await assert.rejects(main(['--config',file,'--run','--confirmed','--expected-plan',h.plan().summary.planHash,'--output',output],f.options),/EEXIST/);assert.equal(f.calls.length,0);assert.equal(fs.existsSync(path.join(h.config.globalRoot,'batch-executions')),false);assert.equal(fs.readFileSync(output,'utf8'),'retained');
});
test('production model never silently falls back to proxy or accepts caller-drawn stages or missing restore declarations',t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);
 for(const patch of [{repeats:3},{keySource:'caff-deepseek'},{evaluation:{kind:'wikiskill-gate-v1',targetEntryId:'entry-1',gateCaseIds:[]}}])assert.throws(()=>prepareBatch({...h.config,...patch},h.options),/evaluation_gate_config_invalid/);
 delete h.config.cases[0].repository;assert.throws(h.plan,/evaluation_repository_restore_required/);
});
