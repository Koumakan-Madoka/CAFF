const test = require('node:test'), assert = require('node:assert/strict');
const { fisherImprovement, decideWikiGate } = require('../../build/server/domain/runtime/badcase-capture/wiki-gate-policy');
const rows = (id, category, original, candidate, n = 10) => ({ sourceCaseId: id, category, stage: 'gate', supported: true, status: 'completed', runs: ['original', 'candidate'].flatMap(variant => Array.from({ length: n }, (_, i) => ({ variant, iteration: i + 1, status: i < (variant === 'original' ? original : candidate) ? 'pass' : 'fail' }))) });
test('D16 one-sided Fisher exact thresholds, strict p<.05, never a rounded shortcut', () => {
  for (const [base, delta] of [[0,5],[1,5],[2,6],[3,6],[4,6]]) {
    assert.ok(fisherImprovement(base, 20, base + delta, 20) < .05);
    assert.ok(fisherImprovement(base, 20, base + delta - 1, 20) >= .05);
  }
  assert.equal(fisherImprovement(0, 20, 0, 20), 1);
  assert.equal(fisherImprovement(20, 20, 20, 20), 1);
  assert.ok(Math.abs(fisherImprovement(0, 20, 5, 20) - 0.02356202356202356) < 1e-12);
});
test('only target reproduction counts as repair; all gate controls count as harm; probes/test ignored', () => {
  const cases = [rows('a','reproduction',0,3),rows('b','reproduction',0,2),rows('control','control',10,9),rows('probe','probe',10,0),rows('other','reproduction',10,0),{...rows('test','control',10,0),stage:'test'}];
  const r = decideWikiGate(cases, ['a','b'], 10);
  assert.equal(r.outcome,'accepted'); assert.equal(r.repair.original.passed,0); assert.equal(r.repair.candidate.passed,5);
  assert.equal(r.noHarm.allowedLoss,1); assert.equal(r.noHarm.loss,1);
  cases[2] = rows('control','control',10,8); assert.equal(decideWikiGate(cases,['a','b'],10).outcome,'rejected');
  cases[0] = rows('a','reproduction',0,0); assert.equal(decideWikiGate(cases,['a','b'],10).repair.passed,false);
});
test('any missing/unsupported gate or exhausted environment errors is indeterminate, not reject/accept', () => {
  const cases = [rows('a','reproduction',0,6),rows('c','control',10,10),rows('p','probe',0,0)];
  cases[2].runs.pop(); assert.equal(decideWikiGate(cases,['a'],10).outcome,'indeterminate');
  cases[2].status='unsupported'; cases[2].runs=[]; assert.equal(decideWikiGate(cases,['a'],10).outcome,'indeterminate');
  assert.equal(decideWikiGate([],[],10).outcome,'indeterminate');
});
