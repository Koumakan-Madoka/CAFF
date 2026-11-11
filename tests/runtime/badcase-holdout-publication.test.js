const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const fixture=require('../helpers/wiki-holdout-batch.cjs'),execution=require('../helpers/wiki-holdout-execution.cjs');
const base='../../build/server/domain/runtime/badcase-capture/';
const comparisons=h=>require(base+'wiki-comparison-store').createWikiComparisonStore(h.config);
function client(f){
 f.options.knownValues=[];f.options.createRunClient=async()=>({state:()=>({reason:null}),close:async()=>{},complete:async request=>{
  const shape=require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items.find(x=>x.case===22&&x.step===(request.variant.kind==='original'?29:30));
  return {networkRequests:1,durationMs:1,wireRequest:require(base+'wiki-run-wire').buildWikiRunWireRequest(request),message:{role:'assistant',stopReason:'toolUse',content:shape.toolCalls.map((c,i)=>({type:'toolCall',id:'synthetic-'+i,...c}))}};
 }});
}
test('v4 immutable comparison store publishes/lists exactly, keeps bytes/hashes, and blocks experience/adoption',async t=>{
 const h=fixture(t),r=await execution(h).run(),s=comparisons(h),before=h.store.read(),saved=s.save(r);
 assert.equal(saved.gateDecision.outcome,'accepted');assert.equal(saved.adoptionEligible,false);assert.deepEqual(s.read(),[saved]);
 const file=path.join(h.scope.globalRoot,'comparisons',saved.id.slice(11)+'.json'),bytes=fs.readFileSync(file);
 assert.deepEqual(s.save(r),saved);assert.deepEqual(s.save(saved),saved);assert.deepEqual(fs.readFileSync(file),bytes);assert.deepEqual(h.store.read(),before);
 assert.doesNotMatch(JSON.stringify(saved),/PRIVATE-REPLY|Synthetic bounded reason/);
 assert.throws(()=>h.store.recordComparisonExperience({comparisonId:saved.id}),{code:'wiki_experience_invalid'});
 assert.throws(()=>h.store.reviewComparison({comparisonId:saved.id,candidateHash:saved.candidate.candidateHash,expectedRevision:before.revision,decision:'adopted',reason:'user_accepted',interpretation:'Synthetic review'}),{code:'wiki_comparison_review_invalid'});
 assert.deepEqual(h.store.read(),before);
});
test('v4 NEW publication rechecks prechecks, membership, assertions and scenes while retained reads never refresh consent',async t=>{
 const h=fixture(t),f=execution(h),r=await f.run(),s=comparisons(h),saved=s.save(r),another=await f.run();
 const latest=h.records.list().find(r=>r.reservation.plan.caseId===h.marked[6].id);h.records.reserve(latest.reservation.plan);
 assert.throws(()=>s.save(another));assert.deepEqual(s.read(),[saved]);assert.deepEqual(s.save(r),saved);
 for(const change of [state=>state.cases.find(c=>c.id===h.marked[6].id).split='train',state=>state.replayCases.find(r=>r.sourceCaseId===h.marked[6].id).checkpointHash='f'.repeat(64)]){
  const a=fixture(t),result=await execution(a).run();a.mutate(change);assert.throws(()=>comparisons(a).save(result));assert.deepEqual(comparisons(a).read(),[]);
 }
});
test('v4 run publication verifies actual durable packets and wire binding, including idempotent save damage checks',async t=>{
 const h=fixture(t);h.makeRun24();const f=execution(h);client(f);const r=await f.run(),s=comparisons(h),saved=s.save(r);
 assert.deepEqual(s.read(),[saved]);const row=r.cases.find(c=>c.execution?.level==='run').runs[0],file=path.join(h.scope.globalRoot,'run-replays',row.runReplayId+'.result.json'),bytes=fs.readFileSync(file);
 fs.writeFileSync(file,'{}');assert.throws(()=>s.save(r));assert.deepEqual(s.read(),[saved]);fs.writeFileSync(file,bytes);assert.deepEqual(s.save(r),saved);
});
test('v4 publication failure preserves the exclusive operator journal and cannot rerun models to repair storage',async t=>{
 const h=fixture(t),f=execution(h),config=path.join(h.root,'config.json'),output=path.join(h.root,'result.jsonl');fs.writeFileSync(config,JSON.stringify(h.config));
 const args=['--config',config,'--run','--confirmed','--expected-plan',f.pinned.summary.planHash,'--output',output],link=fs.linkSync;
 fs.linkSync=(a,b)=>{if(path.dirname(b)===path.join(h.scope.globalRoot,'comparisons'))throw Error('Synthetic disk failure');return link(a,b);};
 try{await assert.rejects(require('../../scripts/badcase-capture/compare-wiki-batch.cjs').main(args,f.options),{code:'wiki_comparison_write_failed'});}finally{fs.linkSync=link;}
 const bytes=fs.readFileSync(output),events=bytes.toString().trim().split('\n').map(JSON.parse);assert.equal(events.filter(e=>e.event==='run').length,40);
 assert.equal(events.at(-1).event,'page_execution_failed');assert.deepEqual(comparisons(h).read(),[]);
 assert.equal(require(base+'wiki-batch-execution-store').createWikiBatchExecutionStore(h.config).read()[0].status,'failed');
 await assert.rejects(require('../../scripts/badcase-capture/compare-wiki-batch.cjs').main(args,f.options),{code:'EEXIST'});assert.deepEqual(fs.readFileSync(output),bytes);
 const summary=events.find(e=>e.event==='batch_summary');assert.equal(comparisons(h).save(summary).gateDecision.outcome,'accepted');
});
test('v4 CLI formats ignored holdouts with their public numbers without changing retained result bytes',async t=>{
 const h=fixture(t),id=h.marked[7].id,old=h.records.list().find(r=>r.reservation.plan.caseId===id),claim=h.records.reserve(old.reservation.plan);
 h.records.finish(claim.id,{status:'completed',reason:null,runs:old.result.runs.map(r=>({...r,status:'pass'}))});
 h.config.cases=h.config.cases.filter(c=>c.sourceCaseId!==id);h.config.experiment.definition.cases=h.config.experiment.definition.cases.filter(c=>c.caseId!==id);
 const f=execution(h),config=path.join(h.root,'config.json'),output=path.join(h.root,'result.jsonl');fs.writeFileSync(config,JSON.stringify(h.config));
 const write=process.stdout.write;let text='';process.stdout.write=c=>{text+=c;return true;};
 try{await require('../../scripts/badcase-capture/compare-wiki-batch.cjs').main(['--config',config,'--run','--confirmed','--expected-plan',f.pinned.summary.planHash,'--output',output],f.options);}finally{process.stdout.write=write;}
 assert.match(text,/未参与判定：#24\n/);assert.ok(!text.includes(id));assert.match(text,/（阈值 0\.05）/);
 const saved=comparisons(h).read()[0];assert.deepEqual(saved.gateDecision.ignoredCaseIds,[id]);assert.ok(!JSON.stringify(saved).includes('displayNumber'));
});
test('v4 CLI saves full gate and durable gate-only progress with fake execution, without enabling validation or adoption',async t=>{
 const h=fixture(t),f=execution(h),config=path.join(h.root,'config.json'),output=path.join(h.root,'result.jsonl');fs.writeFileSync(config,JSON.stringify(h.config));
 const write=process.stdout.write;let text='';process.stdout.write=c=>{text+=c;return true;};
 try{await require('../../scripts/badcase-capture/compare-wiki-batch.cjs').main(['--config',config,'--run','--confirmed','--expected-plan',f.pinned.summary.planHash,'--output',output],f.options);}finally{process.stdout.write=write;}
 const saved=comparisons(h).read()[0],progress=require(base+'wiki-batch-execution-store').createWikiBatchExecutionStore(h.config).read()[0];
 assert.equal(saved.gateDecision.outcome,'accepted');assert.equal(progress.status,'completed');assert.equal(progress.comparisonId,saved.id);
 assert.deepEqual(Object.keys(progress.summary.byStage),['gate']);assert.match(text,/不可提交采纳/);
 const events=fs.readFileSync(output,'utf8').trim().split('\n').map(JSON.parse);assert.equal(events[0].event,'page_execution');assert.equal(events.at(-1).event,'page_execution_finished');
 assert.equal(events.filter(e=>e.event==='run').length,40);assert.equal(saved.validation.status,'not-planned');
});
