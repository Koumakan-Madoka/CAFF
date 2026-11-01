const test=require('node:test'),assert=require('node:assert/strict');
const {wikiGoalCaseNumber,wikiRoundStage,wikiDisplayCases}=require('../../build/server/domain/runtime/badcase-capture/wiki-suite');
const ids={one:'text-3ff896480224fea1cde010370be091785529db0b1b18d8b5e0648a0a4f15aa89',four:'text-ea8201f3c1ddf0fa73043f88d2ac6e10eb2d3529ed3140e0a2261a63503cc40b',ten:'text-26793884ceebb064ff09ebd41f4ce3b88771af2f9a8c0838ea41f52f71f4cb41',sixteen:'text-7364c69567dcfaa751e631b7dc90ac48f03c9ce3e5d12a0588f7ea93c94338ac'};
test('Goal numbering is source-ID anchored, independent of import/list ordering; projection never changes source split',()=>{
  for(const [name,n] of [['one',1],['four',4],['ten',10],['sixteen',16]])assert.equal(wikiGoalCaseNumber(ids[name]),n);
  const input=[{id:ids.sixteen,split:'train'},{id:ids.four,split:'test'},{id:'new-case',split:'gate'}],before=structuredClone(input),rows=wikiDisplayCases(input);
  assert.deepEqual(rows.map(c=>c.displayNumber),[16,4,17]);assert.deepEqual(input,before);
  assert.equal(rows[0].split,'train');assert.equal(rows[0].evaluationStage,'gate');assert.equal(rows[1].evaluationStage,'test');assert.equal(rows[2].split,'gate');
  assert.equal(wikiRoundStage(ids.one),'gate');assert.equal(wikiRoundStage('new-case'),null);
});
