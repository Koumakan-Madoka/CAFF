// Planning-only contracts. All records/paths are synthetic; never authenticate,
// launch Docker or send a model request. Kernel evidence has separate tests.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createWikiStore}=require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const {collectWikiCandidateFiles}=require('../../build/server/domain/runtime/badcase-capture/wiki-candidate-files');
const {getGlobalPromptTarget}=require('../../build/lib/agent-prompt-targets');
const {prepareBatch,runBatch}=require('../../scripts/badcase-capture/batch-comparison.cjs');
const PROFILE='openai-codex/gpt-6.1-sol',digest='a'.repeat(64),controlId='text-7364c69567dcfaa751e631b7dc90ac48f03c9ce3e5d12a0588f7ea93c94338ac';
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function fixture(t,{controlFiles=false,bareReplies=false}={}){
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
 const rules={kind:'public-reply-literals-v1',leadChars:120,conclusionMarkers:['结论'],forbiddenTerms:[],forbiddenPatterns:['priority-code','adr-number','detached-head','commit-hash','acceptance-decision-code']};
 for(const [i,c]of [...marks,store.read().cases.find(c=>c.id===controlId)].entries())store.addReplayCase({sourceCaseId:c.id,category:i<4?'reproduction':'control',task:'Synthetic task',fixture:{commit:'b'.repeat(40),sourceCommit:'b'.repeat(40),sourceSubdirectory:'sample',filesHash:digest},request:{captureRoot:path.join(root,'capture-'+i),association:{projectId:'p1',conversationId:i<4?'room-'+i:'sample-room',messageId:i<4?'msg-'+i:'sample-msg',checkpointId:'cp-'+i,turnId:'turn-'+i,agentId:i<2||i===4?'role-family-gpt':'role-family-deepseek',taskId:'task-'+i,runId:1},flagId:'flag-'+sha('p1\0'+(i<4?'msg-'+i:'sample-msg'))},rules:controlFiles&&i===4?{kind:'file-literals-v1',files:[{path:'REPORT.md',contains:['DONE'],notContains:['TODO']}]}:bareReplies?{kind:'completion-public-reply-v1'}:rules,checkpointHash:digest});
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
test('B rules are mechanically derived from the frozen replay fixture, change rules/plan hashes and retain parent rules',t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const old=h.plan(),before=h.store.read();
 h.config.cases[0].rulesRevision='snapshot-head-exemption-v1';h.config.cases[1].rulesRevision='snapshot-head-exemption-v1';
 const p=h.plan(),row=p.prepared.find(c=>c.sourceCaseId===h.marks[0].id);
 assert.equal(row.comparisonConfig.rules.kind,'public-reply-literals-v2');assert.equal(row.comparisonConfig.rules.snapshotHead,before.replayCases.find(r=>r.sourceCaseId===h.marks[0].id).fixture.commit);
 assert.notEqual(row.comparison.rulesHash,old.prepared.find(c=>c.sourceCaseId===h.marks[0].id).comparison.rulesHash);assert.notEqual(p.summary.planHash,old.summary.planHash);assert.deepEqual(h.store.read(),before);
 assert.ok(p.summary.disclosures.includes('post_observation_snapshot_head_rule_revision'));
 h.config.cases[0].repository.head='c'.repeat(40);assert.throws(h.plan,/evaluation_snapshot_head_mismatch/);
});
test('topic-number exemptions bind explicit pattern names to the immutable task, keep other checks and never rewrite earlier plans',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const old=h.plan(),before=h.store.read(),item=h.config.cases[1],replay=before.replayCases.find(r=>r.sourceCaseId===item.sourceCaseId);
 item.rulesRevision='snapshot-head-exemption-v1';item.topicExemption={patterns:['priority-code','adr-number'],taskHash:sha(replay.task),reason:'题目本身询问按 P1/P2/P3 分阶段的 ADR，豁免主题编号；其他条件不变。'};
 const p=h.plan(),row=p.prepared.find(c=>c.sourceCaseId===item.sourceCaseId);assert.deepEqual(row.topicExemption,item.topicExemption);assert.notEqual(p.summary.planHash,old.summary.planHash);assert.deepEqual(h.store.read(),before);assert.ok(p.summary.disclosures.includes('topic_number_exemption_new_round'));
 assert.equal(row.comparisonConfig.rules.kind,'public-reply-literals-v2');assert.equal(row.comparisonConfig.rules.snapshotHead,replay.fixture.commit);assert.deepEqual(row.comparisonConfig.rules.forbiddenPatterns,['detached-head','commit-hash','acceptance-decision-code']);
 const result=await fakeExecution(h).run(),comparisons=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config),saved=comparisons.save(result);assert.deepEqual(saved.cases.find(c=>c.sourceCaseId===item.sourceCaseId).topicExemption,item.topicExemption);assert.match(require('../../scripts/badcase-capture/staged-batch.cjs').formatStagedBatch(result),/新轮主题编号豁免.*priority-code.*旧轮不改分/);
 for(const mutate of [r=>{r.cases.find(c=>c.topicExemption).topicExemption.taskHash='f'.repeat(64);},r=>{r.cases.find(c=>c.topicExemption).topicExemption.patterns=['acceptance-decision-code'];}]){const changed=structuredClone(result);mutate(changed);assert.throws(()=>comparisons.save(changed),/wiki_comparison_invalid/);}
 for(const patch of [{taskHash:'f'.repeat(64)},{patterns:['commit-hash']},{patterns:[]},{patterns:['priority-code','priority-code']},{reason:''},{extra:true}]){item.topicExemption={...p.prepared.find(c=>c.sourceCaseId===item.sourceCaseId).topicExemption,...patch};assert.throws(h.plan,/evaluation_topic_exemption_invalid/);}
});
test('draft candidates can be inspected in a non-executable plan without pretending to be confirmed',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const before=h.store.read(),original=before.versions[0],guideline='先说明做成了什么及用户影响，编号只在问题本身需要时简释。';
 const v=h.store.reviseGuideline({versionId:original.id,entryId:'entry-1',guideline,expectedRevision:before.revision});assert.equal(v.parentVersionId,original.id);assert.equal(v.origin,'manual-guideline-revision-v1');assert.deepEqual(h.store.read().versions[0],original);assert.equal(v.entries[0].status,'draft');assert.equal(v.entries[0].reviewedAt,undefined);
 h.store.review({versionId:v.id,entryId:'entry-1',expectedRevision:h.store.read().revision,decision:'approved'});const c=h.store.createGlobalCandidate({versionId:v.id,entryIds:['entry-1'],targetId:h.candidate.targetId,files:[]});h.config.candidateId=c.id;
 assert.throws(h.plan,/wiki_candidate_confirmation_required/);const state=h.store.read(),p=prepareBatch(h.config,{...h.options,allowDraftCandidate:true});assert.equal(p.summary.candidateConfirmationRequired,true);assert.equal(p.summary.candidate.id,c.id);assert.deepEqual(h.store.read(),state);
 const configFile=path.join(h.config.repoRoot,'draft-config.json'),output=configFile+'.jsonl';fs.writeFileSync(configFile,JSON.stringify(h.config));const main=require('../../scripts/badcase-capture/compare-wiki-batch.cjs').main,write=process.stdout.write;let preview='';process.stdout.write=s=>{preview+=s;return true;};try{await main(['--config',configFile,'--plan'],h.options);}finally{process.stdout.write=write;}assert.equal(JSON.parse(preview).candidateConfirmationRequired,true);assert.equal(fs.existsSync(path.join(h.config.globalRoot,'batch-executions')),false);
 await assert.rejects(main(['--config',configFile,'--run','--confirmed','--expected-plan',p.summary.planHash,'--output',output],h.options),/wiki_candidate_confirmation_required/);assert.equal(fs.existsSync(output),false);
 const f=fakeExecution({...h,plan:()=>p});await assert.rejects(runBatch(h.config,{...f.options,allowDraftCandidate:true,expectedPlanHash:p.summary.planHash}),/wiki_candidate_confirmation_required/);assert.equal(f.calls.length,0);
 h.store.confirmGlobalCandidate({candidateId:c.id,candidateHash:c.candidateHash,expectedRevision:h.store.read().revision,files:[]});assert.equal(h.plan().summary.candidateConfirmationRequired,undefined);assert.notEqual(h.plan().summary.planHash,p.summary.planHash);
 assert.throws(()=>h.store.reviseGuideline({versionId:original.id,entryId:'entry-1',guideline,expectedRevision:h.store.read().revision}),/wiki_guideline_version_conflict/);
});
test('human non-adoption is immutable, distinct from gate acceptance and blocks only the exact rejected proposal',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const f=fakeExecution(h),execute=f.options.runProductionComparison;
 f.options.runProductionComparison=async(c,o)=>{const r=await execute(c,o);if(c.request.association.checkpointId==='cp-1')for(const row of r.runs)row.status='fail';return r;};
 const result=await f.run(),comparisons=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config),saved=comparisons.save(result);
 const before=h.store.read(),original=fs.readFileSync(path.join(h.config.globalRoot,'comparisons',saved.id.slice(11)+'.json'));
 const input={comparisonId:saved.id,candidateHash:h.candidate.candidateHash,expectedRevision:before.revision,decision:'not-adopted',reason:'test_not_passed',interpretation:'门槛接受、测试未通过、未采纳。只能说修好了本题，不能说模式整体变好了。'};
 assert.equal(result.gateDecision.outcome,'accepted');assert.equal(result.completed,true);
 const controller=require('../../build/server/api/badcase-wiki-controller').createBadcaseWikiController({...h.config,host:'127.0.0.1',port:4313,csrfToken:'synthetic-csrf'});
 const req=new(require('node:stream').PassThrough)();req.method='POST';req.socket={remoteAddress:'127.0.0.1'};req.headers={host:'127.0.0.1:4313',origin:'http://127.0.0.1:4313','content-type':'application/json','x-caff-csrf-token':'synthetic-csrf'};let response;
 const pending=controller({req,pathname:'/api/wikiskill/comparison-review',res:{writeHead(s){assert.equal(s,200);},end(b){response=JSON.parse(b);}}});req.end(JSON.stringify({confirmed:true,...input}));assert.equal(await pending,true);
 const review=response.comparisonReviews[0];assert.equal(review.decision,'not-adopted');assert.equal(review.gateOutcome,'accepted');assert.equal(review.baselineChanged,false);
 assert.equal(h.store.read().revision,before.revision+1);assert.deepEqual(h.store.read().versions,before.versions);assert.deepEqual(h.store.read().candidates,before.candidates);
 assert.deepEqual(comparisons.read()[0],saved);assert.deepEqual(fs.readFileSync(path.join(h.config.globalRoot,'comparisons',saved.id.slice(11)+'.json')),original);
 assert.deepEqual(createWikiStore(h.config).read().comparisonReviews,[review]);
 assert.deepEqual(h.store.reviewComparison({...input,expectedRevision:h.store.read().revision}),review);assert.equal(h.store.read().revision,before.revision+1);
 assert.throws(()=>h.store.reviewComparison({...input,expectedRevision:h.store.read().revision,interpretation:'替换原评审'}),/wiki_comparison_reviewed/);
 const create={versionId:h.candidate.versionId,entryIds:h.candidate.entryIds,targetId:h.candidate.targetId,files:[]};
 assert.throws(()=>h.store.createGlobalCandidate(create),/wiki_candidate_not_adopted/);assert.throws(h.plan,/wiki_candidate_not_adopted/);
 // Different wording, not a blanket ban on the pattern or guideline family.
 const train=before.versions.find(v=>v.id===h.candidate.versionId).caseIds;
 const repeated=h.store.saveDraft({model:'deepseek/deepseek-v4-flash',caseIds:train,entries:[{title:'Renamed pattern',failureMode:'jargon',symptoms:'unclear',rootCauseHypothesis:'audience',guideline:'先讲结论。',caseIds:train}],unclassified:[]});
 h.store.review({versionId:repeated.id,entryId:'entry-1',expectedRevision:h.store.read().revision,decision:'approved'});
 assert.throws(()=>h.store.createGlobalCandidate({...create,versionId:repeated.id}),/wiki_candidate_not_adopted/);
 const version=h.store.saveDraft({model:'deepseek/deepseek-v4-flash',caseIds:train,entries:[{title:'Plain report',failureMode:'jargon',symptoms:'unclear',rootCauseHypothesis:'audience',guideline:'先用白话概括结果和影响。',caseIds:train}],unclassified:[]});
 h.store.review({versionId:version.id,entryId:'entry-1',expectedRevision:h.store.read().revision,decision:'approved'});
 assert.notEqual(h.store.createGlobalCandidate({...create,versionId:version.id}).candidateHash,h.candidate.candidateHash);
});
test('comparison review cannot invent a result, change a frozen rubric, adopt implicitly or overwrite stale state',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const result=await fakeExecution(h).run(),saved=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).save(result),before=h.store.read();
 const input={comparisonId:saved.id,candidateHash:h.candidate.candidateHash,expectedRevision:before.revision,decision:'not-adopted',reason:'user_declined',interpretation:'用户未采纳；不进入生产。'};
 for(const patch of [{comparisonId:'comparison-'+'0'.repeat(64)},{candidateHash:'0'.repeat(64)},{expectedRevision:before.revision-1},{decision:'adopted'},{rules:{}},{reason:'test_not_passed'},{interpretation:'sk-FAKE_SENTINEL_123456'}])assert.throws(()=>h.store.reviewComparison({...input,...patch}));
 assert.deepEqual(h.store.read(),before);
 const file=path.join(h.config.globalRoot,'comparisons',saved.id.slice(11)+'.json'),bytes=fs.readFileSync(file),envelope=JSON.parse(bytes);
 envelope.record.modelConfig.thinking='off';fs.writeFileSync(file,JSON.stringify(envelope));
 assert.throws(()=>h.store.reviewComparison(input),/wiki_comparison_record_invalid/);assert.deepEqual(h.store.read(),before);fs.writeFileSync(file,bytes);
 h.store.reviewComparison(input);assert.equal(h.store.read().comparisonReviews.length,1);
});
test('explicit human adoption stacks an immutable baseline, never confirmation or a gate alone; round two changes only its appended guideline',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const r=await fakeExecution(h).run(),comparisons=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config),saved=comparisons.save(r);
 const before=h.store.read(),input={comparisonId:saved.id,candidateHash:h.candidate.candidateHash,expectedRevision:before.revision,decision:'adopted',reason:'user_accepted',interpretation:'用户审核完整结果后明确采纳；生产合入仍须手动。'};
 assert.equal(before.baselines.length,0);const accepted=h.store.reviewComparison(input),state=h.store.read();assert.equal(accepted.baselineChanged,true);assert.equal(state.baselines.length,1);assert.equal(state.baselines[0].baseText,h.candidate.candidateText);
 assert.deepEqual(h.store.reviewComparison({...input,expectedRevision:state.revision}),accepted);assert.equal(h.store.read().revision,state.revision);
 const {resolveWikiBaseline}=require('../../build/server/domain/runtime/badcase-capture/wiki-baseline');
 for(const corrupt of [s=>{s.baselines[0].parentBaseHash='f'.repeat(64);},s=>{s.baselines[0].baseText+='changed';},s=>{s.comparisonReviews[0].decision='not-adopted';},s=>{s.candidates[0].candidateText+='changed';}]){const forged=structuredClone(state);corrupt(forged);assert.throws(()=>resolveWikiBaseline(forged,h.candidate.targetId),/wiki_candidate_target_mismatch/);}
 const train=before.versions.find(v=>v.id===h.candidate.versionId).caseIds;
 const v=h.store.saveDraft({model:'deepseek/deepseek-v4-flash',caseIds:train,entries:[{title:'Clear report',failureMode:'jargon',symptoms:'unclear',rootCauseHypothesis:'audience',guideline:'再用一句话说明用户影响。',caseIds:train}],unclassified:[]});h.store.review({versionId:v.id,entryId:'entry-1',expectedRevision:h.store.read().revision,decision:'approved'});
 const candidate=h.store.createGlobalCandidate({versionId:v.id,entryIds:['entry-1'],targetId:h.candidate.targetId,files:[]});assert.equal(candidate.baseText,h.candidate.candidateText);assert.equal(candidate.baseHash,h.candidate.candidateHash);assert.equal(candidate.candidateText,candidate.baseText+candidate.appendedSection);assert.equal(candidate.entryIds.length,1);
 h.store.confirmGlobalCandidate({candidateId:candidate.id,candidateHash:candidate.candidateHash,expectedRevision:h.store.read().revision,files:[]});h.config.candidateId=candidate.id;assert.equal(h.plan().summary.candidate.baseHash,h.candidate.candidateHash);
 assert.throws(()=>h.store.confirmGlobalCandidate({candidateId:h.candidate.id,candidateHash:h.candidate.candidateHash,expectedRevision:h.store.read().revision,files:[]}),/wiki_candidate_target_mismatch/);
 const second=comparisons.save(await fakeExecution(h).run());h.store.reviewComparison({comparisonId:second.id,candidateHash:candidate.candidateHash,expectedRevision:h.store.read().revision,decision:'adopted',reason:'user_accepted',interpretation:'用户明确采纳第二轮。'});
 const stacked=h.store.read();assert.equal(stacked.baselines.length,2);assert.equal(stacked.baselines[1].parentBaseHash,h.candidate.candidateHash);assert.equal(stacked.baselines[1].baseText,candidate.candidateText);assert.deepEqual(stacked.baselines[0],state.baselines[0]);assert.deepEqual(comparisons.read().find(c=>c.id===saved.id),saved);
});
test('exact rejected or already accepted appendices cannot be reproposed after a baseline change',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const comparisons=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config),old=comparisons.save(await fakeExecution(h).run());
 h.store.reviewComparison({comparisonId:old.id,candidateHash:h.candidate.candidateHash,expectedRevision:h.store.read().revision,decision:'not-adopted',reason:'user_declined',interpretation:'未采纳此写法。'});
 const train=h.store.read().versions[0].caseIds,make=guideline=>{const v=h.store.saveDraft({model:'deepseek/deepseek-v4-flash',caseIds:train,entries:[{title:'Report',failureMode:'jargon',symptoms:'unclear',rootCauseHypothesis:'audience',guideline,caseIds:train}],unclassified:[]});h.store.review({versionId:v.id,entryId:'entry-1',expectedRevision:h.store.read().revision,decision:'approved'});return h.store.createGlobalCandidate({versionId:v.id,entryIds:['entry-1'],targetId:h.candidate.targetId,files:[]});};
 const accepted=make('先用白话概括结果和用户影响。');h.store.confirmGlobalCandidate({candidateId:accepted.id,candidateHash:accepted.candidateHash,expectedRevision:h.store.read().revision,files:[]});h.config.candidateId=accepted.id;
 const saved=comparisons.save(await fakeExecution(h).run());h.store.reviewComparison({comparisonId:saved.id,candidateHash:accepted.candidateHash,expectedRevision:h.store.read().revision,decision:'adopted',reason:'user_accepted',interpretation:'用户明确采纳不同写法。'});
 assert.throws(()=>make('先讲结论。'),/wiki_candidate_not_adopted/);assert.throws(()=>make('先用白话概括结果和用户影响。'),/wiki_candidate_already_baseline/);
 assert.equal(h.store.read().baselines.length,1);
});
test('adoption refuses missing tests, a rejected gate and any attempt to rewrite a prior non-adoption',async t=>{
 for(const reject of [true,false]){const h=fixture(t);for(const c of h.marks)h.confirm(c);const saved=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).save(await fakeExecution(h,{improve:!reject}).run());
 const input={comparisonId:saved.id,candidateHash:h.candidate.candidateHash,expectedRevision:h.store.read().revision,decision:'adopted',reason:'user_accepted',interpretation:'用户明确决定。'};
 if(reject)assert.throws(()=>h.store.reviewComparison(input),/wiki_comparison_review_invalid/);
 else{h.store.reviewComparison({...input,decision:'not-adopted',reason:'user_declined'});assert.throws(()=>h.store.reviewComparison({...input,expectedRevision:h.store.read().revision}),/wiki_comparison_reviewed/);}
 assert.equal(h.store.read().baselines.length,0);}
});
test('saving a production evaluation automatically drafts safe literal experience, never approves or copies holdout replies',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const f=fakeExecution(h),run=f.options.runProductionComparison;
 f.options.runProductionComparison=async(c,o)=>{const r=await run(c,o);if(c.request.association.checkpointId==='cp-1')for(const row of r.runs)row.status='fail';return r;};
 const r=await f.run();for(const c of r.cases.filter(c=>c.targetReproduction))for(const row of c.runs){const open=row.iteration<=(row.variant==='original'?3:c.stage==='test'?8:10);row.checks={conclusionInLead:open,noForbiddenTerms:row.status==='pass'};row.replyChecks={forbidden:row.status==='pass'?[]:[{kind:'pattern',rule:'priority-code',match:'PRIVATE-HOLDOUT-MATCH'}]};row.finalText='PRIVATE-HOLDOUT-REPLY';row.traceExcerpt='PRIVATE-HOLDOUT-TRACE';}
 const before=h.store.read(),comparisons=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config),saved=comparisons.save(r),state=h.store.read();
 assert.equal(state.experiences.length,1);const draft=state.experiences[0];assert.equal(draft.status,'draft');assert.equal(draft.comparisonId,saved.id);assert.equal(draft.entryId,'entry-1');assert.equal(draft.tracePolicy,'training-only-no-holdout-trajectories');assert.equal(draft.trainingTraceCount,0);
 assert.match(draft.methods,/开头先给结论/);assert.match(draft.methods,/3\/10.*10\/10/);assert.match(draft.methods,/3\/10.*8\/10/);assert.match(draft.methods,/P 编号.*主题/);assert.match(draft.methods,/不能.*整体/);
 assert.match(draft.positiveExamples,/示意.*非回放原文/);assert.doesNotMatch(JSON.stringify(draft),/PRIVATE-HOLDOUT|PRIVATE-WORKER|finalText|traceExcerpt|request|base64/);assert.deepEqual(state.versions,before.versions);assert.deepEqual(state.baselines,before.baselines);
 assert.deepEqual(comparisons.save(r),saved);assert.equal(h.store.read().revision,state.revision);assert.deepEqual(comparisons.save(saved),saved);assert.equal(h.store.read().revision,state.revision);
 const altered=structuredClone(r);altered.cases.find(c=>c.targetReproduction).runs[0].checks.conclusionInLead=false;assert.throws(()=>comparisons.save(altered),/wiki_experience_evidence_conflict/);assert.equal(h.store.read().revision,state.revision);
 h.store.addTextCases([{source:{origin:'http://127.0.0.1:3100',projectId:'old',conversationId:'new-room',messageId:'new-train',agentId:'role-family-gpt'},role:'GPT',actual:'fresh symptom',expected:'fresh expectation',message:'TRAIN-ONLY-MESSAGE',traceExcerpt:'TRAIN-ONLY-TRACE',traceState:'available',messageTruncated:false,traceTruncated:false}]);
 const plan=require('../../scripts/badcase-capture/wiki-induction.cjs').prepareWikiInduction(h.store),input=plan.files.find(f=>f.path==='wiki-induction-input.json').bytes.toString();assert.match(input,/TRAIN-ONLY-TRACE/);assert.doesNotMatch(input,/PRIVATE-HOLDOUT|P 编号|positiveExamples/);
});
test('new literal evidence creates a new experience draft version instead of overwriting an existing draft',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const r=await fakeExecution(h).run(),comparisons=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config),saved=comparisons.save(r),before=h.store.read();assert.equal(before.experiences.length,1);
 for(const c of r.cases.filter(c=>c.targetReproduction))for(const row of c.runs){row.checks={conclusionInLead:true,noForbiddenTerms:row.status==='pass'};row.replyChecks={forbidden:row.status==='pass'?[]:[{kind:'pattern',rule:'priority-code',match:'DO-NOT-COPY'}]};}
 comparisons.save(r);const after=h.store.read();assert.equal(after.experiences.length,2);assert.deepEqual(after.experiences[0],before.experiences[0]);assert.equal(after.experiences[1].parentId,before.experiences[0].id);assert.equal(after.experiences[1].version,2);assert.equal(after.experiences[1].status,'draft');
 comparisons.save(saved);assert.equal(h.store.read().revision,after.revision);assert.equal(h.store.read().experiences.length,2);
});
test('trusted experience recovery checks the exact saved comparison and current revision before any draft write',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const r=await fakeExecution(h).run(),saved=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).save(r),before=h.store.read();
 const config=path.join(h.config.repoRoot,'feedback-config.json'),result=path.join(h.config.repoRoot,'feedback-result.json');fs.writeFileSync(config,JSON.stringify({globalRoot:h.config.globalRoot,sourceWorktree:h.config.sourceWorktree}));fs.writeFileSync(result,JSON.stringify(r));
 const main=require('../../scripts/badcase-capture/draft-wiki-experience.cjs').main,args=['--config',config,'--comparison',saved.id,'--result',result,'--confirmed','--expected-revision',String(before.revision)],write=process.stdout.write;process.stdout.write=()=>true;
 try{assert.equal(main(args).experienceId,before.experiences[0].id);assert.equal(h.store.read().revision,before.revision);
 assert.throws(()=>main(args.slice(0,6)),/wiki_experience_usage/);assert.throws(()=>main([...args.slice(0,8),String(before.revision-1)]),/wiki_revision_conflict/);
 const changed=structuredClone(r);changed.executionId='different-execution';fs.writeFileSync(result,JSON.stringify(changed));assert.throws(()=>main(args),/wiki_experience_result_mismatch/);assert.deepEqual(h.store.read(),before);
 }finally{process.stdout.write=write;}
});
test('an experience write failure retains the immutable result and recovers by re-publication without running a model',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const r=await fakeExecution(h).run(),before=h.store.read(),comparisons=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config),link=fs.linkSync;let injected=false;
 fs.linkSync=(source,target)=>{if(String(target).startsWith(path.join(h.config.globalRoot,'snapshots')+path.sep)){injected=true;throw Error('synthetic-disk-fault');}return link(source,target);};
 try{assert.throws(()=>comparisons.save(r),/wiki_write_failed/);}finally{fs.linkSync=link;}
 assert.equal(injected,true);assert.deepEqual(h.store.read(),before);const saved=comparisons.read()[0];assert.ok(saved);assert.equal(saved.completed,true);
 assert.deepEqual(comparisons.save(r),saved);assert.equal(h.store.read().experiences.length,1);assert.equal(h.store.read().revision,before.revision+1);assert.equal(comparisons.read().length,1);
});
test('only reviewed experience becomes candidate input; revisions preserve approved text and existing candidate provenance',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).save(await fakeExecution(h).run());
 const before=h.store.read(),draft=before.experiences[0],create={versionId:h.candidate.versionId,entryIds:h.candidate.entryIds,targetId:h.candidate.targetId,files:[]};
 assert.equal(h.store.createGlobalCandidate(create).experienceInputs,undefined);
 assert.throws(()=>require('../../build/server/domain/runtime/badcase-capture/wiki-global-candidate').buildGlobalWikiCandidate(h.store.read(),{...create,experienceIds:[draft.id]}),/wiki_experience_review_required/);
 for(const patch of [{methods:'sk-FAKE_SENTINEL_123456'},{positiveExamples:''},{summary:{}}])assert.throws(()=>h.store.reviewExperience({experienceId:draft.id,expectedRevision:h.store.read().revision,decision:'approved',patch}));
 const approved=h.store.reviewExperience({experienceId:draft.id,expectedRevision:h.store.read().revision,decision:'approved'});assert.equal(approved.status,'approved');assert.deepEqual(h.store.read().versions,before.versions);assert.deepEqual(h.store.read().baselines,before.baselines);
 const candidate=h.store.createGlobalCandidate(create);assert.notEqual(candidate.id,h.candidate.id);assert.equal(candidate.candidateText,h.candidate.candidateText);assert.equal(candidate.experienceInputs[0].id,approved.id);assert.equal(candidate.experienceInputs[0].methods,approved.methods);assert.equal(candidate.experienceInputs[0].positiveExamples,approved.positiveExamples);assert.equal(candidate.experienceInputs[0].summary,undefined);
 h.store.confirmGlobalCandidate({candidateId:candidate.id,candidateHash:candidate.candidateHash,expectedRevision:h.store.read().revision,files:[]});
 h.config.candidateId=candidate.id;assert.equal(h.plan().summary.candidate.experienceHash,candidate.experienceHash);
 const withExperience=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).save(await fakeExecution(h).run());assert.equal(withExperience.candidate.experienceHash,candidate.experienceHash);
 const frozen=structuredClone(approved),revision=h.store.read().revision;
 assert.throws(()=>h.store.reviewExperience({experienceId:approved.id,expectedRevision:revision,decision:'approved',patch:{methods:'Overwrite'}}),/wiki_experience_reviewed/);
 const next=h.store.reviseExperience({experienceId:approved.id,expectedRevision:revision});assert.equal(next.status,'draft');assert.equal(next.parentId,approved.id);assert.equal(next.version,2);assert.deepEqual(h.store.read().experiences[0],frozen);
 const again=h.store.reviseExperience({experienceId:approved.id,expectedRevision:h.store.read().revision});assert.equal(again.id,next.id);
 const revised=h.store.reviewExperience({experienceId:next.id,expectedRevision:h.store.read().revision,decision:'approved',patch:{methods:'有效：先说明结果与影响；不能把编号规则当语义判断。',positiveExamples:'示意：结论是……；影响是……。'}});assert.equal(revised.status,'approved');assert.equal(revised.version,3);assert.deepEqual(h.store.read().experiences[0],frozen);assert.equal(h.store.read().experiences.find(e=>e.id===next.id).status,'draft');
 const {resolveGlobalWikiCandidate}=require('../../build/server/domain/runtime/badcase-capture/wiki-global-candidate');assert.equal(resolveGlobalWikiCandidate(h.store.read(),candidate.id,candidate.targetId,candidate.baseHash,[]).experienceInputs[0].id,approved.id);assert.equal(h.store.createGlobalCandidate(create).experienceInputs[0].id,revised.id);
 const tampered=h.store.read();tampered.candidates.find(c=>c.id===candidate.id).experienceInputs[0].methods+='tamper';assert.throws(()=>resolveGlobalWikiCandidate(tampered,candidate.id,candidate.targetId,candidate.baseHash,[]),/wiki_candidate_target_mismatch/);
 h.store.addTextCases([{source:{origin:'http://127.0.0.1:3100',projectId:'old',conversationId:'feedback-room',messageId:'train-after-approval',agentId:'role-family-gpt'},role:'GPT',actual:'new symptom',expected:'new expectation',message:'TRAIN-ONLY-AFTER-APPROVAL',traceExcerpt:'',traceState:'missing',messageTruncated:false,traceTruncated:false}]);const induction=require('../../scripts/badcase-capture/wiki-induction.cjs').prepareWikiInduction(h.store).files[0].bytes.toString();assert.doesNotMatch(induction,/positiveExamples|有效：先说明结果/);
 assert.throws(()=>h.store.reviewExperience({experienceId:next.id,expectedRevision:h.store.read().revision,decision:'approved'}),/wiki_experience_conflict/);
});
function scoringV2Fixture(t,{bareReplies=false}={}) {
 const h=fixture(t,{controlFiles:true,bareReplies});for(const c of h.marks)h.confirm(c);
 // This grandfathered synthetic control had no annotation; populate only this
 // test snapshot, not real wiki records or any historical production reply.
 const state=h.store.read(),control=state.cases.find(c=>c.id===controlId);control.actual='Unclear';control.expected='Clear';state.revision++;
 fs.writeFileSync(path.join(h.config.globalRoot,'snapshots',String(state.revision).padStart(12,'0')+'.json'),JSON.stringify({schemaVersion:1,checksum:sha(JSON.stringify(state)),record:state}));
 const suite=h.plan().prepared.filter(c=>!c.reportOnly),questions=[{id:'q1',question:'Is the result clear?',evidence:'reply'},{id:'q2',question:'Is the next step clear?',evidence:'reply'}];
 for(const row of suite){const rubric=h.store.saveRubricDraft({caseId:row.sourceCaseId,model:'deepseek/deepseek-v4-flash',questions},h.store.read().revision);h.store.confirmRubric({rubricId:rubric.id,hash:rubric.hash,confirmationRecord:'Synthetic user approval'},h.store.read().revision);h.config.cases.find(c=>c.sourceCaseId===row.sourceCaseId).rubricHash=rubric.hash;}
 const definition={kind:'wiki-experiment-v1',variants:[{id:'original',promptHash:h.candidate.baseHash},{id:'candidate',promptHash:h.candidate.candidateHash}],
  runner:{model:PROFILE,settings:{api:'openai-codex-responses',thinking:'xhigh',fast:false,transport:'sse',credentialDelivery:'host-only-mailbox'}},repeats:10,executionPolicy:'alternating-valid-v1',
  decision:{kind:'wikiskill-gate-v1',alpha:.05,noHarmFraction:.05,minimumAllowedLoss:1,maxExtraAttemptsPerCase:5},
  judge:{backend:'deepseek',model:'deepseek/deepseek-v4-flash',settings:{},promptHash:sha('synthetic-descriptor-not-a-judge-prompt')},
  cases:suite.map(c=>({caseId:c.sourceCaseId,stage:c.stage,category:c.category,targetReproduction:c.targetReproduction}))};
 h.config.experiment={definition};h.options.prepareProductionTask=()=> 'ACTUAL-TRIGGERING-USER-TASK';
 const prepare=h.options.prepareProductionComparison;h.options.prepareProductionComparison=c=>{const p=prepare(c);p.summary.scoring=require('../../scripts/badcase-capture/wiki-receipt-scoring.cjs').wikiScoringSummary(c.scoring);return p;};
 const judge={configuration:structuredClone(definition.judge),evaluate:async()=>{throw Error('No real judge call in batch fakes');}};
 return {...h,judge,definition,pin:()=>{h.config.experiment.plan=h.plan().summary.experiment;return h.plan();}};
}
test('v2 batch binds independent experiment and frozen rubrics before execution; original tasks are not synthetic replay labels',t=>{
 const h=scoringV2Fixture(t),before=h.store.read(),p=h.pin();
 assert.equal(p.summary.kind,'wiki-staged-batch-comparison-v2');assert.equal(p.summary.experiment.kind,'wiki-experiment-plan-v1');assert.deepEqual(h.store.read(),before);
 assert.equal(p.summary.disclosures.includes('literal_rules_not_semantic_judgment'),false);assert.ok(p.summary.disclosures.includes('literal_metrics_reference_only'));
 for(const row of p.prepared.filter(c=>c.supported)){assert.equal(row.comparisonConfig.scoring.task,'ACTUAL-TRIGGERING-USER-TASK');assert.equal(row.comparisonConfig.scoring.rubric.hash,row.comparison.scoring.rubricHash);assert.equal(row.comparisonConfig.scoring.expected,h.store.read().cases.find(c=>c.id===row.sourceCaseId).expected);}
 const control=p.prepared.find(c=>c.sourceCaseId===controlId);assert.equal(control.comparisonConfig.rules.kind,'file-literals-v1');assert.equal(p.summary.experiment.cases.find(c=>c.caseId===controlId).hardAssertionsHash,require('../../build/server/domain/runtime/badcase-capture/wiki-rubric').wikiValueHash(control.comparisonConfig.rules));
 assert.equal(JSON.stringify(p.summary).includes('ACTUAL-TRIGGERING-USER-TASK'),false);assert.equal(JSON.stringify(p.summary).includes('Is the result clear?'),false);
 for(const mutate of [x=>x.definition.runner.settings.thinking='low',x=>x.definition.variants[1].promptHash='f'.repeat(64),x=>x.definition.cases[0].stage=x.definition.cases[0].stage==='test'?'gate':'test',x=>x.config.cases[0].topicExemption={},x=>x.config.cases[0].rulesRevision='snapshot-head-exemption-v1']){const x=scoringV2Fixture(t);mutate(x);assert.throws(x.plan);}
});
test('v2 registers and plans new reply-only cases without inventing keyword rules or exemptions',t=>{
 const h=scoringV2Fixture(t,{bareReplies:true}),p=h.pin();
 const row=p.prepared.find(c=>c.sourceCaseId===h.marks[0].id);assert.deepEqual(row.comparisonConfig.rules,{kind:'completion-public-reply-v1'});assert.equal(row.comparisonConfig.scoring.rubric.questions.length,2);
});
test('v2 batch requires pinned experiment and matching judge before any paid execution or events',async t=>{
 for(const mode of ['unpinned','missing','changed']){const h=scoringV2Fixture(t);if(mode!=='unpinned')h.pin();const f=fakeExecution(h);if(mode!=='missing')f.options.judge=h.judge;if(mode==='changed')h.judge.configuration.promptHash='f'.repeat(64);
  await assert.rejects(f.run(),/wiki_(experiment_confirmation_required|judge_adapter_required|judge_binding_changed)/);assert.equal(f.calls.length,0);assert.equal(f.events.length,0);assert.equal(f.legacyReads(),0);}
});
test('v2 staged execution keeps gate formula and test boundary, and CLI distinguishes AI scoring from literal reference metrics',async t=>{
 const h=scoringV2Fixture(t);h.pin();const f=fakeExecution(h);f.options.judge=h.judge;const r=await f.run();assert.equal(r.gateDecision.outcome,'accepted');assert.equal(f.calls.length,3);
 assert.ok(f.calls.every(c=>c.scoring.kind==='wiki-score-v2'));const at=f.events.findIndex(e=>e.event==='gate_decision');assert.ok(f.events.findIndex(e=>e.event==='run'&&e.stage==='test')>at);
 const output=require('../../scripts/badcase-capture/staged-batch.cjs').formatStagedBatch(r);assert.match(output,/硬断言.*AI/);assert.match(output,/deepseek-v4-flash/);assert.doesNotMatch(output,/字面规则不是语义判断|主题编号豁免/);
});
test('v2 frozen experiment rejects drift in task, rubric, scene and judge configuration before executing a reply',async t=>{
 for(const change of ['task','rubric','scene','judge']){const h=scoringV2Fixture(t);h.pin();
  if(change==='task')h.options.prepareProductionTask=()=> 'CHANGED TASK';
  if(change==='rubric'){const d=h.store.saveRubricDraft({caseId:h.marks[0].id,model:'deepseek/deepseek-v4-flash',questions:[{id:'a',question:'New question?',evidence:'reply'},{id:'b',question:'Another question?',evidence:'reply'}]},h.store.read().revision);h.store.confirmRubric({rubricId:d.id,hash:d.hash,confirmationRecord:'Synthetic approval'},h.store.read().revision);h.config.cases[0].rubricHash=d.hash;}
  if(change==='scene'){const prepare=h.options.prepareProductionComparison;h.options.prepareProductionComparison=c=>{const p=prepare(c);p.summary.checkpointHash='f'.repeat(64);return p;};}
  if(change==='judge')h.definition.judge.promptHash='f'.repeat(64);
  assert.throws(h.plan,/wiki_experiment_changed|evaluation_batch_input_changed/);assert.equal(h.store.read().candidates.length,1);
 }
});
function v2Execution(h,settings={}){
 const f=fakeExecution(h,settings);f.options.judge=h.judge;
 f.options.runProductionComparison=async(config,options)=>{
  f.calls.push(config);options.onEvent({event:'plan',runtimeHash:digest});const runs=[];
  for(let i=1;i<=10;i++)for(const variant of ['original','candidate']){
   options.onEvent({event:'run_start',variant,iteration:i});options.onEvent({event:'model_call',variant,iteration:i,model:PROFILE});
   const failed=settings.improve!==false&&config.request.association.checkpointId==='cp-0'&&variant==='original';
   const assessment=await require('../../build/server/domain/runtime/badcase-capture/wiki-scoring-v2').scoreWikiRun({rubric:config.scoring.rubric,binding:config.scoring.binding,
    run:{task:config.scoring.task,expected:config.scoring.expected,completed:true,replySource:'public',publicReply:'RESULT. PRIVATE-WORKER-REPLY-NOT-FOR-PAGE'},hardAssertions:config.rules.kind==='file-literals-v1'?[{id:'files',status:'pass'}]:[],referenceMetrics:{noForbiddenTerms:false}},
    {configuration:h.judge.configuration,evaluate:async()=>{
     if(settings.judgeAllDown||settings.judgeFault&&config.request.association.checkpointId==='cp-0'&&variant==='original'&&i===1){if(settings.judgeFault==='backend')throw Error('PRIVATE-JUDGE-DETAIL');return 'not-json';}
     return {judgments:config.scoring.rubric.questions.map((q,n)=>({criterionId:q.id,verdict:settings.insufficient||failed&&n===0?'not-satisfied':'satisfied',reason:'Synthetic reasoning',evidence:settings.insufficient?[]:[{source:'reply',text:'RESULT.'}]}))};
    }});
   const row={variant,iteration:i,status:assessment.status,...(assessment.reason?{reason:assessment.reason}:{}),assessment,replySource:'public',cleaned:true,finalText:'RESULT. PRIVATE-WORKER-REPLY-NOT-FOR-PAGE'};
   runs.push(row);options.onEvent({event:'run',...row});
   if(assessment.status==='error'&&!['judge_backend_failed','judge_output_invalid'].includes(assessment.reason))return {completed:false,fatal:true,runs,modelCallsKnown:runs.length,callsUnavailable:false};
  }
  return {completed:runs.every(r=>r.status!=='error'),fatal:false,runs,modelCallsKnown:20,callsUnavailable:false};
 };
 return f;
}
test('v2 immutable publication retains criterion votes/citations/reference metrics, not full replies, and rejects forged judgments',async t=>{
 const h=scoringV2Fixture(t);h.pin();const r=await v2Execution(h).run(),store=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config);
 const saved=store.save(r);assert.equal(saved.kind,'wiki-staged-batch-comparison-v2');assert.deepEqual(store.read()[0],saved);assert.deepEqual(store.save(saved),saved);
 const c=saved.cases.find(c=>c.sourceCaseId===h.marks[0].id);assert.equal(c.rubric.status,'frozen');assert.equal(c.runs[0].assessment.votes.length,3);assert.equal(c.runs[0].assessment.judgments[0].verdict,'not-satisfied');assert.equal(c.runs[0].assessment.referenceMetrics.noForbiddenTerms,false);
 const control=saved.cases.find(c=>c.sourceCaseId===controlId);assert.deepEqual(control.hardAssertionIds,['files']);assert.equal(control.runs[0].assessment.hardAssertions.find(a=>a.id==='files').status,'pass');
 assert.equal(c.runs[0].assessment.votes[0][0].evidence[0].text,'RESULT.');assert.equal(JSON.stringify(saved).includes('PRIVATE-WORKER'),false);assert.equal(h.store.read().experiences.length,0,'v2 must not auto-draft a misleading literal-rule experience');
 for(const change of [x=>x.cases.find(c=>!c.reportOnly).runs[0].status='pass',x=>x.cases.find(c=>!c.reportOnly).runs[0].assessment.judgments[0].verdict='satisfied',x=>x.experiment.planHash='f'.repeat(64),x=>x.cases.find(c=>!c.reportOnly).comparison.scoring.binding.promptHash='f'.repeat(64),x=>x.cases.find(c=>!c.reportOnly).rubric.questions[0].question='Forged question?',x=>x.cases.find(c=>c.sourceCaseId===controlId).runs[0].assessment.hardAssertions=x.cases.find(c=>c.sourceCaseId===controlId).runs[0].assessment.hardAssertions.filter(a=>a.id!=='files')]){const x=structuredClone(r);change(x);assert.throws(()=>store.save(x));}
});
test('v2 insufficient evidence is an immutable fail, not an error or replacement answer',async t=>{
 const h=scoringV2Fixture(t);h.pin();const f=v2Execution(h,{insufficient:true}),r=await f.run();assert.equal(f.calls.length,2);assert.equal(r.completed,true);assert.equal(r.gateDecision.outcome,'rejected');
 const saved=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).save(r);
 assert.equal(saved.byStage.gate.original.scored,20);assert.equal(saved.byStage.gate.original.failed,20);assert.equal(saved.byStage.gate.original.errors,0);assert.equal(saved.byStage.test.original.attempted,0);
 assert.equal(saved.cases.flatMap(c=>c.runs)[0].assessment.reason,'rubric_not_satisfied');
 assert.throws(()=>h.store.recordComparisonExperience({comparisonId:saved.id,observations:[]}),/wiki_experience_invalid/);
});
test('v2 judge technical failure leaves a denominator gap, continues other gate cases, blocks test, and persists error unchanged',async t=>{
 for(const judgeFault of ['backend','parse']){
  const h=scoringV2Fixture(t);h.pin();const f=v2Execution(h,{judgeFault}),r=await f.run();
  assert.equal(f.calls.length,2);assert.equal(r.completed,false);assert.equal(r.gateDecision.outcome,'indeterminate');
  const saved=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).save(r);
  assert.equal(saved.byStage.gate.original.scored,19);assert.equal(saved.byStage.gate.original.errors,1);assert.equal(saved.byStage.gate.original.notRun,1);assert.equal(saved.byStage.gate.candidate.scored,20);assert.equal(saved.byStage.test.original.attempted,0);
  assert.equal(saved.cases.find(c=>c.sourceCaseId===controlId).status,'completed');
  assert.equal(saved.cases.flatMap(c=>c.runs)[0].assessment.reason,judgeFault==='backend'?'judge_backend_failed':'judge_output_invalid');
  assert.equal(JSON.stringify(saved).includes('PRIVATE-JUDGE-DETAIL'),false);
 }
});
test('v2 all-down judge processes both gate cases, preserves all forty errors and never enters test',async t=>{
 const h=scoringV2Fixture(t);h.pin();const f=v2Execution(h,{judgeAllDown:true,judgeFault:'backend'}),r=await f.run();
 assert.equal(f.calls.length,2);assert.equal(r.cases.flatMap(c=>c.runs).length,40);assert.equal(r.completed,false);assert.equal(r.gateDecision.outcome,'indeterminate');
 const saved=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).save(r);
 assert.equal(saved.byStage.gate.original.errors,20);assert.equal(saved.byStage.gate.candidate.errors,20);assert.equal(saved.byStage.gate.original.scored,0);assert.equal(saved.byStage.test.original.attempted,0);
});
test('v2 publication validates occupied judge-error slots separately from recoverable environmental replacements',async t=>{
 const h=scoringV2Fixture(t);h.pin();const r=await v2Execution(h,{judgeFault:'backend'}).run();
 const c=r.cases.find(c=>c.sourceCaseId===h.marks[0].id),extra=structuredClone(c.runs[1]);
 // The first original reply has exhausted judge retries; the first candidate
 // failed environmentally. Only the candidate may receive an extra reply.
 delete c.runs[1].assessment;c.runs[1].status='error';c.runs[1].reason='evaluation_codex_proxy_failed';
 c.runs.push({...extra,iteration:11});c.modelCallsKnown++;r.modelCallsKnown++;
 const store=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config),saved=store.save(r);
 assert.equal(saved.cases.find(c=>c.sourceCaseId===h.marks[0].id).runs.length,21);assert.equal(saved.gateDecision.outcome,'indeterminate');
 const forged=structuredClone(r),last=forged.cases.find(c=>c.sourceCaseId===h.marks[0].id).runs.at(-1);last.variant='original';
 assert.throws(()=>store.save(forged),'a judge-error slot must not receive a replacement reply');
});
test('v2 CLI writes progress and immutable results end-to-end with fake judge; no replay of model calls on republish',async t=>{
 const h=scoringV2Fixture(t);h.pin();const f=v2Execution(h),file=path.join(h.config.repoRoot,'v2-config.json'),output=file+'.jsonl';fs.writeFileSync(file,JSON.stringify(h.config));
 const write=process.stdout.write;let text='';process.stdout.write=s=>{text+=s;return true;};
 try{await require('../../scripts/badcase-capture/compare-wiki-batch.cjs').main(['--config',file,'--run','--confirmed','--expected-plan',h.plan().summary.planHash,'--output',output],f.options);}finally{process.stdout.write=write;}
 const saved=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config).read()[0];assert.equal(saved.kind,'wiki-staged-batch-comparison-v2');assert.match(text,/硬断言.*AI/);
 const progress=require('../../build/server/domain/runtime/badcase-capture/wiki-batch-execution-store').createWikiBatchExecutionStore(h.config).read()[0];assert.equal(progress.status,'completed');assert.equal(progress.plan.scoringKind,'wiki-score-v2');assert.equal(progress.plan.experimentHash,saved.experiment.planHash);assert.equal(progress.summary.completedRuns,60);assert.equal(f.calls.length,3);assert.ok(fs.readFileSync(output,'utf8').includes('page_execution_finished'));
});
test('v2 CLI publishes all judge errors and remaining gate progress without aborting or executing test',async t=>{
 const h=scoringV2Fixture(t);h.pin();const f=v2Execution(h,{judgeAllDown:true,judgeFault:'backend'}),file=path.join(h.config.repoRoot,'judge-down-config.json'),output=file+'.jsonl';fs.writeFileSync(file,JSON.stringify(h.config));
 const write=process.stdout.write,exitCode=process.exitCode;process.stdout.write=()=>true;
 try{await require('../../scripts/badcase-capture/compare-wiki-batch.cjs').main(['--config',file,'--run','--confirmed','--expected-plan',h.plan().summary.planHash,'--output',output],f.options);}finally{process.stdout.write=write;process.exitCode=exitCode;}
 const progress=require('../../build/server/domain/runtime/badcase-capture/wiki-batch-execution-store').createWikiBatchExecutionStore(h.config).read()[0];
 assert.equal(progress.status,'stopped');assert.equal(progress.gateOutcome,'indeterminate');assert.equal(progress.summary.completedRuns,40);assert.equal(progress.summary.byStage.gate.original.errors,20);assert.equal(progress.summary.byStage.test.original.attempted,0);assert.ok(progress.comparisonId);assert.equal(f.calls.length,2);
 assert.match(fs.readFileSync(output,'utf8'),/page_execution_finished/);assert.doesNotMatch(fs.readFileSync(output,'utf8'),/PRIVATE-JUDGE-DETAIL/);
});
test('API adds explicit scoring labels without changing old immutable comparison bytes or judgments',async t=>{
 for(const v2 of [false,true]){const h=v2?scoringV2Fixture(t):fixture(t);if(v2)h.pin();else for(const c of h.marks)h.confirm(c);
  const r=await (v2?v2Execution(h):fakeExecution(h)).run(),store=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store').createWikiComparisonStore(h.config),saved=store.save(r);
  const file=path.join(h.config.globalRoot,'comparisons',saved.id.slice(11)+'.json'),bytes=fs.readFileSync(file),controller=require('../../build/server/api/badcase-wiki-controller').createBadcaseWikiController({...h.config,host:'127.0.0.1',port:4313,csrfToken:'synthetic-csrf'});let response;
  const req=new(require('node:stream').PassThrough)();req.method='GET';req.socket={remoteAddress:'127.0.0.1'};req.headers={host:'127.0.0.1:4313'};
  assert.equal(await controller({req,pathname:'/api/wikiskill',res:{writeHead(s){assert.equal(s,200);},end(b){response=JSON.parse(b);}}}),true);
  const record=response.comparisons[0];assert.equal(record.scoringKind,v2?'wiki-score-v2':'literal-rules-v1');assert.equal(record.scoringLabel,v2?'硬断言＋AI 裁判':'字面规则');
  const {scoringKind,scoringLabel,...unchanged}=record;assert.deepEqual(unchanged,saved);assert.deepEqual(fs.readFileSync(file),bytes);
 }
});
test('production model never silently falls back to proxy or accepts caller-drawn stages or missing restore declarations',t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);
 for(const patch of [{repeats:3},{keySource:'caff-deepseek'},{evaluation:{kind:'wikiskill-gate-v1',targetEntryId:'entry-1',gateCaseIds:[]}}])assert.throws(()=>prepareBatch({...h.config,...patch},h.options),/evaluation_gate_config_invalid/);
 delete h.config.cases[0].repository;assert.throws(h.plan,/evaluation_repository_restore_required/);
});
