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
test('production plan cannot spend quota before production result publication is implemented',async t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);let auth=0,models=0;
 await assert.rejects(runBatch(h.config,{...h.options,confirmed:true,expectedPlanHash:h.plan().summary.planHash,readKey:()=>{auth++;throw Error('forbidden');},executeCodex:()=>{models++;throw Error('forbidden');}}),/evaluation_production_publication_not_ready/);assert.equal(auth,0);assert.equal(models,0);
});
test('production plan pins complete configuration/rules/restore sources and rechecks human classification',t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);const p=h.plan();h.config.timeoutMs=2700000;assert.notEqual(h.plan().summary.planHash,p.summary.planHash);
 h.config.cases[0].repository.head='c'.repeat(40);assert.notEqual(h.plan().summary.planHash,p.summary.planHash);
 h.store.assignCase({caseId:h.marks[1].id,entryId:null,expectedRevision:h.store.read().revision});assert.throws(h.plan,/evaluation_gate_config_invalid/);
});
test('production model never silently falls back to proxy or accepts caller-drawn stages or missing restore declarations',t=>{
 const h=fixture(t);for(const c of h.marks)h.confirm(c);
 for(const patch of [{repeats:3},{keySource:'caff-deepseek'},{evaluation:{kind:'wikiskill-gate-v1',targetEntryId:'entry-1',gateCaseIds:[]}}])assert.throws(()=>prepareBatch({...h.config,...patch},h.options),/evaluation_gate_config_invalid/);
 delete h.config.cases[0].repository;assert.throws(h.plan,/evaluation_repository_restore_required/);
});
