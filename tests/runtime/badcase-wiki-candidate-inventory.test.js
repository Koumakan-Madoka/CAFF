const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fixture=require('../helpers/badcase-initialization-fixture.cjs');
const {collectWikiCandidateFiles}=require('../../build/server/domain/runtime/badcase-capture/wiki-candidate-files');
const {assertWikiCandidateNoLeak}=require('../../build/server/domain/runtime/badcase-capture/wiki-candidate');
const {getGlobalPromptTarget}=require('../../build/lib/agent-prompt-targets');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const file=txt=>({path:'reference.txt',base64:Buffer.from(txt).toString('base64'),sha256:sha(txt)});
test('unchanged base suffix plus newly inserted whitespace is not copied answer content; real cross-seam additions still reject',()=>{
 const target=getGlobalPromptTarget('global-harness-behavior-v1'),candidate=target.baseText+'\n\nWikiSkill 已审核准则：\n- 先用白话讲结论。';
 assert.doesNotThrow(()=>assertWikiCandidateNoLeak(candidate,[],[file('unrelated words '+target.baseText.slice(-12)+'\n\nUnrelated tail.')],target));
 const suffix='NEW-ANSWER';assert.throws(()=>assertWikiCandidateNoLeak(target.baseText+suffix,[],[file('other '+target.baseText.slice(-6)+suffix)],target),/wiki_candidate_leak/);
});
test('two valid real-sized seals do not exhaust a single-checkpoint file cap; late files still participate in leakage rejection',t=>{
 const late='SYNTHETIC-LATE-HELDOUT-LITERAL';const replayCases=Array.from({length:2},(_,j)=>{
  const f=fixture(t,'fresh',({cp,put})=>{for(let i=0;i<600;i++){const bytes=Buffer.from(j===1&&i===599?late:'safe fixture bytes '+j+' '+i);cp.files['f'+i+'.txt']={type:'file',size:bytes.length,hash:put(bytes)};}});
  return {id:'replay-'+j,request:f.request,checkpointHash:sha(JSON.stringify(f.cp))};
 });
 const files=collectWikiCandidateFiles({replayCases});assert.equal(files.length,1202);const target=getGlobalPromptTarget('global-harness-behavior-v1');
 assert.doesNotThrow(()=>assertWikiCandidateNoLeak(target.baseText+'\nUse plain language.',[],files,target));
 assert.throws(()=>assertWikiCandidateNoLeak(target.baseText+'\n'+late,[],files,target),/wiki_candidate_leak/);
});
