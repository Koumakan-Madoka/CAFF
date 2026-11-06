const test=require('node:test'),assert=require('node:assert/strict');
const {planWikiEvaluationSuite,wikiSourceFamily}=require('../../build/server/domain/runtime/badcase-capture/wiki-evaluation-suite');
const {wikiGoalCaseNumber}=require('../../build/server/domain/runtime/badcase-capture/wiki-suite');
function fixture(){
 const a={id:'new-gpt-gate',kind:'marked-badcase',role:'role-family-gpt',source:{agentId:'role-family-gpt'},split:'gate',preclassification:{entryId:'entry-1'}};
 const b={...structuredClone(a),id:'new-gpt-test',split:'test'};
 const other={...structuredClone(a),id:'deepseek-gate',role:'GPT',source:{agentId:'role-family-deepseek'}};
 const state={cases:[a,b,other],versions:[{entries:[{id:'entry-1',status:'approved',caseIds:[]},{id:'entry-2',status:'approved',caseIds:[]}]}],classifications:[]};
 const selections=state.cases.map(c=>({sourceCaseId:c.id,category:'reproduction'}));
 const confirm=c=>state.classifications.push({caseId:c.id,entryId:'entry-1',source:'manual',confirmedAt:'2026-11-03T00:00:00.000Z'});
 return {state,selections,a,b,other,confirm,plan:()=>planWikiEvaluationSuite(state,selections,'entry-1')};
}
test('D15 official suite refuses pending classification for both gate and test; preclassification is not approval',()=>{
 const h=fixture();assert.throws(h.plan,/wiki_classification_confirmation_required/);h.confirm(h.a);assert.throws(h.plan,/wiki_classification_confirmation_required/);h.confirm(h.b);assert.throws(h.plan,/wiki_classification_confirmation_required/);h.confirm(h.other);
 const before=structuredClone(h.state),p=h.plan();assert.deepEqual(h.state,before);assert.deepEqual(p.targetReproductionCaseIds,[h.a.id]);assert.deepEqual(p.targetTestReproductionCaseIds,[h.b.id]);assert.deepEqual(p.reportOnlyCaseIds,[h.other.id]);
 assert.equal(p.cases.find(c=>c.sourceCaseId===h.a.id).classification.source,'manual');
});
test('Badcase-page confirmed labels unlock frozen holdouts without legacy preclassification and do not add learning members',()=>{
 const h=fixture();for(const c of h.state.cases)h.confirm(c);h.state.classifications=h.state.classifications.filter(c=>c.caseId!==h.a.id);delete h.a.preclassification;
 h.state.patternLabels=[{caseId:h.a.id,entryId:'entry-1',source:'badcase-page',confirmedAt:'2026-11-06T00:00:00.000Z'}];
 const before=structuredClone(h.state),p=h.plan();assert.deepEqual(p.targetReproductionCaseIds,[h.a.id]);assert.deepEqual(h.state,before);
 assert.deepEqual(p.cases.find(c=>c.sourceCaseId===h.a.id).classification,{entryId:'entry-1',source:'manual',confirmedAt:'2026-11-06T00:00:00.000Z'});
 h.state.patternLabels[0].entryId=null;assert.deepEqual(h.plan().targetReproductionCaseIds,[]);
 for(const patch of [{source:'model'},{confirmedAt:'not-a-date'}]){const x=fixture();for(const c of x.state.cases)x.confirm(c);delete x.a.preclassification;x.state.classifications=x.state.classifications.filter(c=>c.caseId!==x.a.id);x.state.patternLabels=[{caseId:x.a.id,entryId:'entry-1',source:'badcase-page',confirmedAt:'2026-11-06T00:00:00.000Z',...patch}];assert.throws(x.plan);}
});
test('authoritative agent family recognizes role-family-gpt and never promotes DeepSeek with a GPT display label',()=>{
 const h=fixture();assert.equal(wikiSourceFamily(h.a),'GPT');assert.equal(wikiSourceFamily(h.other),'deepseek');assert.equal(wikiSourceFamily({role:'GPT',source:{agentId:'legacy-custom'}}),'GPT');assert.equal(wikiSourceFamily({kind:'marked-badcase',role:'GPT',source:{agentId:'unknown'}}),null);
 for(const c of h.state.cases)h.confirm(c);h.state.classifications[0].entryId='entry-2';const p=h.plan();assert.deepEqual(p.targetReproductionCaseIds,[]);assert.ok(!p.cases.find(c=>c.sourceCaseId===h.a.id).targetReproduction);
});
test('clearing classification remains confirmed unclassified, not a target; invalid receipt/entry cannot unlock',()=>{
 for(const patch of [{source:'model'},{confirmedAt:'not-a-date'},{entryId:'unknown-entry'}]){const h=fixture();for(const c of h.state.cases)h.confirm(c);Object.assign(h.state.classifications[0],patch);assert.throws(h.plan,/wiki_classification_confirmation_required/);}
 const h=fixture();for(const c of h.state.cases)h.confirm(c);h.state.classifications[0].entryId=null;assert.deepEqual(h.plan().targetReproductionCaseIds,[]);
});
test('D15 derives frozen stages, refuses training/unallocated sources and duplicate selections',()=>{
 const h=fixture();for(const c of h.state.cases)h.confirm(c);
 assert.equal(h.plan().cases.find(c=>c.sourceCaseId===h.b.id).stage,'test');
 for(const split of ['train',null]){h.a.split=split;assert.throws(h.plan,/evaluation_batch_split_invalid/);}h.a.split='gate';
 h.selections.push(h.selections[0]);assert.throws(h.plan,/evaluation_batch_cases_invalid/);
});
test('grandfathered control stages are display projection only; their stored 13/3 split is not redrawn',()=>{
 const h=fixture();const ids=['text-7364c69567dcfaa751e631b7dc90ac48f03c9ce3e5d12a0588f7ea93c94338ac','text-26793884ceebb064ff09ebd41f4ce3b88771af2f9a8c0838ea41f52f71f4cb41','text-1c6e58c2f58ac57383a1910cd01dd96b4b6c2989078d6963b83284a4a8abaa47'];
 h.state.cases=ids.map(id=>({id,kind:'text-only',role:'GPT',split:wikiGoalCaseNumber(id)===16?'train':'test',source:{agentId:'role-family-gpt'}}));
 const before=structuredClone(h.state);const p=planWikiEvaluationSuite(h.state,ids.map(sourceCaseId=>({sourceCaseId,category:'control'})),'entry-1');assert.equal(p.gateCaseIds.length,1);assert.equal(p.testCaseIds.length,2);assert.deepEqual(h.state,before);assert.equal(p.cases.find(c=>wikiGoalCaseNumber(c.sourceCaseId)===16).split,'train');
});
