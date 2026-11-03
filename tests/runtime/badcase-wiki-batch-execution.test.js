// Synthetic progress only; no authentication, Docker, SDK or model calls.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const load=()=>require('../../build/server/domain/runtime/badcase-capture/wiki-batch-execution-store');
const model='openai-codex/gpt-6.1-sol',hash='a'.repeat(64);
const plan=()=>({kind:'wiki-staged-batch-comparison-v1',model,modelConfig:{api:'openai-codex-responses',thinking:'xhigh',fast:false,transport:'sse',credentialDelivery:'host-only-mailbox'},planHash:hash,repeats:10,evaluation:{splitPolicy:'d15-frozen-v1'},cases:[{sourceCaseId:'gate',stage:'gate',category:'reproduction',reportOnly:false},{sourceCaseId:'control',stage:'gate',category:'control',reportOnly:false},{sourceCaseId:'other',stage:'gate',category:'reproduction',reportOnly:true},{sourceCaseId:'test',stage:'test',category:'reproduction',reportOnly:false}],privateText:'PRIVATE-PLAN'});
function scope(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'batch-progress-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {globalRoot:path.join(root,'global'),sourceWorktree:path.join(root,'source')};}
function row(store,id,caseId,variant,iteration,status='pass'){
 store.event(id,{event:'run_start',sourceCaseId:caseId,variant,iteration});
 store.event(id,{event:'run',sourceCaseId:caseId,variant,iteration,status,cleaned:true,durationMs:10,tokenUsage:{knownCalls:1,callsWithoutUsage:0,knownTokens:{totalTokens:7},complete:true},finalText:'PRIVATE-REPLY',fileEvidence:[{path:'/private/path'}]});
}
test('durable staged progress separates holdouts, report-only rows, valid scores and environment replacements',t=>{
 const scopeValue=scope(t),store=load().createWikiBatchExecutionStore(scopeValue);assert.deepEqual(store.read(),[]);assert.equal(fs.existsSync(scopeValue.globalRoot),false);
 const r=store.start(plan());assert.equal(r.summary.plannedRuns,60);assert.equal(r.plan.cases.find(c=>c.reportOnly).sourceCaseId,'other');
 row(store,r.id,'gate','original',1,'error');row(store,r.id,'gate','candidate',1);row(store,r.id,'gate','original',2,'fail');
 const saved=store.read()[0];assert.equal(saved.summary.completedRuns,3);assert.equal(saved.summary.byStage.gate.original.errors,1);assert.equal(saved.summary.byStage.gate.original.notRun,19);assert.equal(saved.summary.byStage.test.candidate.attempted,0);assert.equal(saved.summary.knownTokens,21);
 assert.equal(saved.cases[0].totals.original.attempted,2);assert.equal(saved.cases[0].totals.original.notRun,9);assert.doesNotMatch(JSON.stringify(saved),/PRIVATE|\/private/);
 assert.equal(require('../../build/server/domain/runtime/badcase-capture/wiki-store').createWikiStore(scopeValue).read().revision,0);
 assert.deepEqual(load().createWikiBatchExecutionStore(scopeValue).read()[0],saved);
});
test('test execution before gate acceptance, duplicate slots, excess replacements and report-only runs fail closed',t=>{
 const store=load().createWikiBatchExecutionStore(scope(t)),r=store.start(plan());
 for(const sourceCaseId of ['test','other','missing'])assert.throws(()=>store.event(r.id,{event:'run_start',sourceCaseId,variant:'original',iteration:1}),/wiki_execution_invalid/);
 row(store,r.id,'gate','original',1);const before=store.read();assert.throws(()=>row(store,r.id,'gate','original',1),/wiki_execution_invalid/);assert.deepEqual(store.read(),before);
 for(let i=1;i<=25;i++)row(store,r.id,'control',i%2?'original':'candidate',Math.ceil(i/2),'error');
 assert.throws(()=>store.event(r.id,{event:'run_start',sourceCaseId:'control',variant:'candidate',iteration:13}),/wiki_execution_invalid/);
 store.fail(r.id,'PRIVATE-PROVIDER-ERROR');assert.equal(store.read()[0].reason,'evaluation_failed');assert.equal(store.read()[0].status,'failed');assert.throws(()=>store.heartbeat(r.id),/wiki_execution_invalid/);
});
test('a saved gate rejection completes progress without tests or prompt-adoption claims; separate executions never pool',t=>{
 const store=load().createWikiBatchExecutionStore(scope(t)),r=store.start(plan()),other=store.start(plan());
 for(const caseId of ['gate','control']){for(let i=1;i<=10;i++)for(const v of ['original','candidate'])row(store,r.id,caseId,v,i);store.event(r.id,{event:'case_summary',sourceCaseId:caseId,status:'completed'});}
 store.event(r.id,{event:'case_summary',sourceCaseId:'other',status:'not-run'});store.event(r.id,{event:'gate_decision',gateDecision:{outcome:'rejected'}});store.event(r.id,{event:'case_summary',sourceCaseId:'test',status:'not-run'});
 const done=store.finish(r.id,{id:'comparison-1',planHash:hash,model,completed:true,gateDecision:{outcome:'rejected'}});assert.equal(done.status,'completed');assert.equal(done.gateOutcome,'rejected');assert.equal(done.comparisonId,'comparison-1');assert.equal(done.summary.completedRuns,40);assert.equal(store.read().find(x=>x.id===other.id).summary.completedRuns,0);
 assert.doesNotMatch(JSON.stringify(done),/adopted|accepted_prompt/);
});
test('checksums and allowlist projection reject corruption, arbitrary fields and invalid model configs',t=>{
 const config=scope(t),store=load().createWikiBatchExecutionStore(config);
 assert.throws(()=>store.start({...plan(),modelConfig:{...plan().modelConfig,thinking:'off'}}),/wiki_execution_invalid/);
 const r=store.start(plan()),file=path.join(config.globalRoot,'batch-executions',r.id+'.json'),envelope=JSON.parse(fs.readFileSync(file));envelope.record.privateText='PRIVATE-INSERT';envelope.checksum=crypto.createHash('sha256').update(JSON.stringify(envelope.record)).digest('hex');fs.writeFileSync(file,JSON.stringify(envelope));assert.throws(()=>store.read(),/wiki_execution_record_invalid/);
});
test('read-only executions endpoint includes both single and staged progress and completed comparison refresh',async t=>{
 const config=scope(t),store=load().createWikiBatchExecutionStore(config);store.start(plan());const {createBadcaseWikiController}=require('../../build/server/api/badcase-wiki-controller');
 let body;const controller=createBadcaseWikiController({...config,host:'127.0.0.1',port:3268}),res={writeHead(){},end(text){body=JSON.parse(text);}};
 await controller({req:{method:'GET',headers:{host:'127.0.0.1:3268'},socket:{remoteAddress:'127.0.0.1'}},res,pathname:'/api/wikiskill/executions'});assert.equal(body.executions.length,1);assert.equal(body.executions[0].plan.kind,'wiki-staged-batch-comparison-v1');assert.deepEqual(body.comparisons,[]);
});
