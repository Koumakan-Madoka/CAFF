const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('../helpers/wiki-holdout-batch.cjs'),execution=require('../helpers/wiki-holdout-execution.cjs');
const base='../../build/server/domain/runtime/badcase-capture/';
const {projectStagedResult}=require(base+'wiki-staged-result'),{wikiComparisonTotals:totals}=require(base+'wiki-comparison-totals');
const {wikiValueHash:hash}=require(base+'wiki-rubric');
const project=r=>projectStagedResult(r,totals);
test('v4 projection recomputes pooled gate without legacy test/control requirements and strips private worker fields',async t=>{
 const h=fixture(t),r=await execution(h).run(),p=project(r);
 assert.equal(p.kind,'wiki-mode-holdout-comparison-v1');assert.equal(p.gateDecision.outcome,'accepted');
 assert.equal(p.gateDecision.repair.candidate.passed,6);assert.equal(p.gateDecision.repair.original.total,20);
 assert.deepEqual(p.gateDecision,r.gateDecision);assert.deepEqual(p.byStage,r.byStage);assert.deepEqual(Object.keys(p.byStage),['gate']);
 assert.deepEqual(p.validation,{status:'not-planned'});assert.equal(p.adoptionEligible,false);assert.equal(p.completed,true);
 assert.equal(p.cases.find(c=>c.sourceCaseId===h.marked[7].id).split,'test');
 assert.equal(p.cases[0].runs[0].assessment.tool.status,'fail');assert.equal(p.cases[0].runs[0].assessment.binding,null);
 assert.doesNotMatch(JSON.stringify(p),/PRIVATE-REPLY|Synthetic bounded reason/);assert.deepEqual(project(p),p);
 assert.equal(hash(project(p)),hash(p));assert.equal(h.store.read().experiences.length,0);
});
test('v4 projection keeps complete rejected results, and separates invalid/error replacement attempts from valid counts',async t=>{
 for(const options of [{candidatePasses:0},{prefix:['invalid','error']},{prefix:Array(5).fill('invalid')}]){
  const h=fixture(t),r=await execution(h,options).run(),p=project(r);
  assert.deepEqual(p.gateDecision,r.gateDecision);assert.deepEqual(p.byStage,r.byStage);assert.equal(p.completed,r.completed);
  if(options.prefix?.length===2){assert.equal(p.gateDecision.outcome,'accepted');assert.equal(p.byStage.gate.original.invalid,2);assert.equal(p.byStage.gate.candidate.errors,2);}
  if(options.prefix?.length===5){assert.equal(p.completed,false);assert.equal(p.gateDecision.outcome,'indeterminate');}
 }
});
test('v4 projection ignores caller totals but rejects invented conclusions, membership, evidence and scoring',async t=>{
 const h=fixture(t),r=await execution(h).run();
 const ignored=structuredClone(r);ignored.byStage={untrusted:'PRIVATE'};ignored.cases[0].totals={};assert.deepEqual(project(ignored),project(r));
 const rehash=x=>{const{planHash,...body}=x.experiment;x.experiment.planHash=hash(body);};
 for(const mutate of [x=>x.gateDecision.outcome='rejected',x=>x.gateDecision.repair.candidate.passed++,x=>x.completed=false,
  x=>x.adoptionEligible=true,x=>x.validation.status='passed',x=>x.modelCallsKnown++,x=>x.callsUnavailable=true,
  x=>x.cases.reverse(),x=>x.cases[0].stage='test',x=>x.cases[0].split='train',x=>x.cases[0].category='control',
  x=>x.cases[0].runs[0].status='pass',x=>delete x.cases[0].runs[0].assessment.tool,x=>x.cases[0].runs[0].assessment.tool.status='pass',
  x=>x.cases[0].comparison.scoring.inputHash='f'.repeat(64),x=>x.cases[0].hardAssertionIds=['invented'],
  x=>x.cases[0].rubric.hash='f'.repeat(64),x=>x.experiment.planHash='f'.repeat(64),
  x=>{x.experiment.runner.settings.thinking='off';rehash(x);},x=>{x.experiment.variants[0].promptHash='f'.repeat(64);rehash(x);},
  x=>x.split.rows[0].split='train',
  x=>x.evaluation.targetEntryId='entry-other']){
  const x=structuredClone(r);mutate(x);assert.throws(()=>project(x));
 }
});
test('v4 incomplete trace/run rows preserve level and single-target warning without requiring attempts or a trace quota',t=>{
 const h=fixture(t);h.makeRun24();h.config.experiment.definition.cases=h.config.experiment.definition.cases.filter(c=>c.caseId===h.marked[7].id);
 h.config.cases=h.config.cases.filter(c=>c.sourceCaseId===h.marked[7].id);
 h.mutate(s=>s.patternLabels=s.patternLabels.filter(l=>l.caseId!==h.marked[6].id));
 const p=h.plan(),rows=p.prepared.map(c=>({ ...c,replayId:c.replayId||null,status:'not-run',reason:'operator_stop',runs:[],modelCallsKnown:0,callsUnavailable:false,
  rubric:c.comparisonConfig.scoring.rubric,hardAssertionIds:[]}));
 const decision=require(base+'wiki-holdout-plan').decideWikiHoldoutExperimentGate(p.summary.experiment,rows.map(c=>({caseId:c.sourceCaseId,status:c.status,runs:[]})));
 const r={...p.summary,executionId:'synthetic-execution',runtimeHash:null,cases:rows,gateDecision:decision,completed:false,validation:{status:'not-planned'},adoptionEligible:false,modelCallsKnown:0,callsUnavailable:false};
 const out=project(r);assert.equal(out.cases.length,1);assert.equal(out.cases[0].execution.level,'run');assert.equal(out.cases[0].replayId,null);
 assert.deepEqual(out.gateDecision.warnings,['只有 1 道门槛题']);assert.equal(out.gateDecision.byLevel.run.original.total,0);
 assert.deepEqual(project(out),out);
});
test('v4 real single-call kernel with a fake client retains run assessments, request hashes and separate level counts',async t=>{
 const h=fixture(t);h.makeRun24();const f=execution(h);let sends=0;
 f.options.knownValues=[];f.options.createRunClient=async()=>({state:()=>({reason:null}),close:async()=>{},complete:async request=>{
  sends++;const shape=require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items.find(x=>x.case===22&&x.step===(request.variant.kind==='original'?29:30));
  return {networkRequests:1,durationMs:1,wireRequest:require(base+'wiki-run-wire').buildWikiRunWireRequest(request),
   message:{role:'assistant',stopReason:'toolUse',content:shape.toolCalls.map((c,i)=>({type:'toolCall',id:'synthetic-'+i,...c}))}};
 }});
 const r=await f.run(),p=project(r);assert.equal(sends,20);assert.equal(p.completed,true);assert.equal(p.gateDecision.outcome,'accepted');
 const row=p.cases.find(c=>c.execution?.level==='run');assert.equal(row.runs.length,20);assert.equal(row.totals.original.failed,10);assert.equal(row.totals.candidate.passed,10);
 assert.equal(row.runs[0].toolExecutions,0);assert.match(row.runs[0].runReplayId,/^[a-f0-9]{64}$/);assert.ok(row.runs.every(r=>r.checks));
 assert.equal(p.gateDecision.byLevel.run.candidate.passed,10);assert.equal(p.gateDecision.byLevel.trace.candidate.passed,6);assert.deepEqual(project(p),p);
 for(const mutate of [x=>x.runs[0].checks.tool.status='pass',x=>x.runs[0].toolExecutions=1,x=>x.runs[0].requestHash='f'.repeat(64),x=>x.execution.requestHash='f'.repeat(64)]){
  const copy=structuredClone(r);mutate(copy.cases.find(c=>c.execution?.level==='run'));assert.throws(()=>project(copy));
 }
});
test('v4 progress accepts only gate stage, tracks structured-trace invalids, and validates persisted level reports',async t=>{
 const h=fixture(t),f=execution(h,{prefix:['invalid','error']}),store=require(base+'wiki-batch-execution-store').createWikiBatchExecutionStore(h.config);
 const start=store.start(f.pinned.summary);assert.equal(start.plan.kind,'wiki-mode-holdout-comparison-v1');
 assert.deepEqual(Object.keys(start.summary.byStage),['gate']);assert.equal(start.summary.byLevel.trace.original.planned,20);
 const r=await f.run();for(const e of f.events)store.event(start.id,e);
 const before=store.read()[0];assert.equal(before.summary.totals.original.invalid,2);assert.equal(before.summary.totals.candidate.errors,2);
 assert.deepEqual(before.summary.byLevel.run.original,{planned:0,attempted:0,passed:0,failed:0,errors:0,notRun:0});
 const saved={id:'comparison-'+hash(project(r)),...project(r)};
 const finished=store.finish(start.id,saved);assert.equal(finished.status,'completed');assert.deepEqual(store.read()[0],finished);
});
test('v4 immutable payload read is byte/hash stable and does not re-admit or upgrade it after current evidence changes',async t=>{
 const fs=require('node:fs'),path=require('node:path'),h=fixture(t),r=await execution(h).run(),payload=project(r);
 const byteHash=v=>require('node:crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const record={id:'comparison-'+byteHash(payload),createdAt:'2026-11-11T00:00:00.000Z',...payload},directory=path.join(h.scope.globalRoot,'comparisons');fs.mkdirSync(directory);
 const file=path.join(directory,record.id.slice(11)+'.json'),bytes=JSON.stringify({schemaVersion:1,checksum:byteHash(record),record})+'\n';fs.writeFileSync(file,bytes);
 const read=()=>require(base+'wiki-comparison-record').readWikiComparisonRecord(h.scope.globalRoot,record.id,project);
 assert.deepEqual(read(),record);h.mutate(s=>s.rubrics=[]);assert.deepEqual(read(),record);assert.equal(fs.readFileSync(file,'utf8'),bytes);
 const forged=structuredClone(record);forged.gateDecision.outcome='rejected';fs.writeFileSync(file,JSON.stringify({schemaVersion:1,checksum:byteHash(forged),record:forged}));assert.throws(read);
});
test('v4 progress can stop before the first scored attempt without inventing valid or invalid outcomes',async t=>{
 const h=fixture(t),f=execution(h),s=require(base+'wiki-batch-execution-store').createWikiBatchExecutionStore(h.config),a=s.start(f.pinned.summary);
 f.options.runProductionComparison=async()=>{throw Object.assign(Error('PRIVATE'),{code:'evaluation_codex_auth_failed'});};
 const r=await f.run(),p=project(r);for(const e of f.events)s.event(a.id,e);
 assert.equal(p.gateDecision.outcome,'indeterminate');assert.equal(p.completed,false);assert.equal(p.modelCallsKnown,0);assert.equal(p.callsUnavailable,true);
 assert.equal(s.finish(a.id,{id:'comparison-'+hash(p),...p}).status,'stopped');
});
test('v4 progress handles run-only gate plans and refuses counterfeit finish/plan and test-stage events',async t=>{
 const h=fixture(t);h.makeRun24();const f=execution(h),store=require(base+'wiki-batch-execution-store').createWikiBatchExecutionStore(h.config);
 const start=store.start(f.pinned.summary);assert.equal(start.summary.byLevel.run.original.planned,10);
 assert.throws(()=>store.event(start.id,{event:'run_start',sourceCaseId:h.marked[7].id,stage:'test',variant:'original',iteration:1}));
 const x=structuredClone(f.pinned.summary);x.cases[0].stage='test';assert.throws(()=>store.start(x));
 const y=structuredClone(f.pinned.summary);y.experiment.planHash='f'.repeat(64);assert.throws(()=>store.start(y));
 const plain=fixture(t),g=execution(plain),s=require(base+'wiki-batch-execution-store').createWikiBatchExecutionStore(plain.config),a=s.start(g.pinned.summary),r=await g.run();
 for(const e of g.events)s.event(a.id,e);const saved={id:'comparison-'+hash(project(r)),...project(r)};
 const bad=structuredClone(saved);bad.cases[0].totals.original.failed--;assert.throws(()=>s.finish(a.id,bad));
 assert.equal(s.read()[0].status,'running');assert.equal(s.finish(a.id,saved).status,'completed');
});
