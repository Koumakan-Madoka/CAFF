const test = require('node:test'), assert = require('node:assert/strict');
const api = () => require('../../scripts/badcase-capture/wiki-judge-calibration.cjs');
function fixture() {
  const a = Array.from({ length: 40 }, (_, i) => ({ id: 'A' + i, side: i < 20 ? 'original' : 'candidate', human: { q1: i % 2 === 0, q2: i % 3 === 0 }, result: result(i % 2 === 0, i % 3 === 0) }));
  const b = [0, 1, 2].map(i => ({ id: 'B' + i, result: result(false, true) }));
  return { a, b };
}
function result(q1, q2) {
  const judgments = [q1, q2].map((yes, i) => ({ criterionId: 'q' + (i + 1), verdict: yes ? 'satisfied' : 'not-satisfied', majority: true }));
  return { status: q1 && q2 ? 'pass' : 'fail', votes: Array.from({ length: 3 }, () => judgments.map(({ majority, ...j }) => j)), judgments };
}
test('all D6 metrics including per-assertion agreement and 3-vote vector consistency are computed', () => {
  const f = fixture(), r = api().summarizeWikiCalibration(f);
  assert.equal(r.eligible, true); assert.equal(r.overall.correct, 40); assert.equal(r.sides.original.total, 20);
  assert.equal(r.assertions.q1.correct, 40); assert.equal(r.assertions.q1.required, true);
  assert.equal(r.repeatedResults.consistent, 40); assert.equal(r.knownBad.detected, 3);
});
test('always-fail judge cannot qualify using only overall failed replies', () => {
  const f = fixture(); f.a.forEach(r => r.result = result(false, false));
  const r = api().summarizeWikiCalibration(f); assert.equal(r.eligible, false); assert.ok(r.failures.includes('assertion:q1'));
});
test('overall, per-side and per-assertion gates remain independent', () => {
  const f = fixture();
  for (const i of [0, 6, 12, 18]) f.a[i].result = result(false, true);
  const r = api().summarizeWikiCalibration(f);
  assert.equal(r.overall.ratio, 0.9); assert.equal(r.sides.original.ratio, 0.8); assert.equal(r.eligible, false);
});
test('one inconsistent vector counts once per reply, not as one favorable majority', () => {
  const f = fixture(); for (let i = 0; i < 3; i++) f.a[i].result.votes[0][0].verdict = f.a[i].result.votes[0][0].verdict === 'satisfied' ? 'not-satisfied' : 'satisfied';
  const r = api().summarizeWikiCalibration(f); assert.equal(r.repeatedResults.ratio, 37 / 40); assert.equal(r.eligible, false);
});
test('technical errors are reported and excluded from agreement denominators, never silently qualifying partial sets', () => {
  const f = fixture(); f.a[0].result = { status: 'error', reason: 'judge_backend_failed', votes: [], judgments: [] };
  const r = api().summarizeWikiCalibration(f); assert.equal(r.errors.a, 1); assert.equal(r.overall.total, 39); assert.equal(r.eligible, false);
  assert.ok(r.failures.includes('incomplete'));
});
test('known bad must all fail; empty, duplicate and inconsistent baseline/result inputs are rejected', () => {
  const f = fixture(); f.b[0].result = result(true, true); assert.equal(api().summarizeWikiCalibration(f).eligible, false);
  assert.throws(() => api().summarizeWikiCalibration({ a: [], b: [] }));
  const dup = fixture(); dup.a[1].id = dup.a[0].id; assert.throws(() => api().summarizeWikiCalibration(dup));
  const bad = fixture(); bad.a[0].result.status = 'fail'; assert.throws(() => api().summarizeWikiCalibration(bad));
  const unsafe = fixture(); unsafe.a[0].human = JSON.parse('{"__proto__":false}');
  assert.throws(() => api().summarizeWikiCalibration(unsafe)); assert.equal(Object.prototype.positive, undefined);
});
