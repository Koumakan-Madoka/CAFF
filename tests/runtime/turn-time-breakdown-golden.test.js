// Golden sample regression for the turn time breakdown rules classifier.
//
// tests/fixtures/turn-time-breakdown-golden.json holds 300 real tool steps
// stratified-sampled from the 三期房间 (b7e50f1c) corpus (tool x rules-outcome
// x duration bucket), labeled by hand (Kimi) against the category semantics of
// docs/engineering/backend/turn-time-breakdown.md §5.
//
// Two guards:
//   1. Freeze: every step's stored rules result must equal what the current
//      classifier produces. Any rules change flips this test and forces an
//      explicit fixture re-baseline + contract update.
//   2. Quality: time-weighted agreement between rules and golden labels over
//      rules-resolved steps must stay >= 90%, and the disagreement set must
//      stay exactly the reviewed KNOWN_DISAGREEMENTS (W6 review; each entry
//      has a documented rationale in the contract).
const assert = require('node:assert/strict');
const test = require('node:test');

const { createTurnRuleClassifier } = require('../../build/server/domain/runtime/turn-time-breakdown');
const fixture = require('../fixtures/turn-time-breakdown-golden.json');
// Stratum population of the full corpus (tool × rules-outcome × duration
// bucket), regenerated only when re-baselining:
//   node scripts/replay-turn-time-breakdown.js --sandbox <sandbox> \
//     --conversation b7e50f1c --scan-sessions \
//     --emit-strata tests/fixtures/turn-time-breakdown-golden-strata.json
const strata = require('../fixtures/turn-time-breakdown-golden-strata.json');

// Reviewed disagreement set (W6). Each id is a deliberate or documented
// classification difference, not an unnoticed bug:
//  - gs-036/gs-046: pipelines mixing read-context bridge invocations with real
//    file reads; dominant category is debatable, rules chose process-report.
//  - gs-042/gs-150: rg searches whose pattern names a bridge tool; rules FP
//    to process-report, golden read.
//  - gs-297: node_modules patch + syntax check in one step; rules build-check,
//    golden write (borderline).
//  - gs-299: 185s wrapper that ran tests then hit harness timeout; rules
//    exception-retry (executed-then-failed policy), golden test.
const KNOWN_DISAGREEMENTS = new Set(['gs-036', 'gs-042', 'gs-046', 'gs-150', 'gs-297', 'gs-299']);

function classifyFixtureStep(s) {
  const classifier = createTurnRuleClassifier();
  return classifier.classify({
    toolName: s.toolName,
    args: s.toolName === 'bash' ? { command: s.command } : { path: s.command },
    output: (s.outputHead || '') + (s.outputTail || ''),
    isError: s.isError,
    durationMs: s.durationMs,
  });
}

test('golden sample: rules results frozen per step', () => {
  const flipped = [];
  for (const s of fixture) {
    const r = classifyFixtureStep(s);
    const got = { c: r ? (r.category ?? null) : null, sc: r ? (r.subcategory ?? null) : null, rk: r ? (r.runKind ?? null) : null };
    const want = { c: s.rulesCategory, sc: s.rulesSubcategory, rk: s.rulesRunKind };
    if (got.c !== want.c || got.sc !== want.sc || got.rk !== want.rk) {
      flipped.push({ id: s.sampleId, got, want });
    }
  }
  assert.deepEqual(flipped, [], 'rules output changed; re-baseline the fixture and update the contract');
});

test('golden sample: time-weighted agreement >= 90%, disagreement set frozen', () => {
  let agreeMs = 0, resolvedMs = 0, unclassifiedMs = 0, totalMs = 0;
  const disagreements = new Set();
  for (const s of fixture) {
    totalMs += s.durationMs;
    if (!s.rulesCategory) { unclassifiedMs += s.durationMs; continue; }
    resolvedMs += s.durationMs;
    if (s.rulesCategory === s.expectedCategory) agreeMs += s.durationMs;
    else disagreements.add(s.sampleId);
  }
  const agreement = agreeMs / resolvedMs;
  assert.ok(agreement >= 0.9, `time-weighted agreement ${(agreement * 100).toFixed(1)}% < 90%`);
  assert.deepEqual([...disagreements].sort(), [...KNOWN_DISAGREEMENTS].sort());
  // The sample-internal null share (41.3%) is a stratification artifact —
  // wrapper strata were deliberately over-sampled. The honest guard is the
  // stratum-weighted estimate of the corpus null share (contract §13.1):
  // weight each sampled step by population/sample per stratum. Measured
  // 21.3% ≈ the direct corpus scan (22.5% full window / 27.0% 10-14..21).
  const sampleCount = {};
  for (const s of fixture) {
    sampleCount[s.stratum] = (sampleCount[s.stratum] || 0) + 1;
  }
  let weightedNullMs = 0;
  let weightedTotalMs = 0;
  for (const s of fixture) {
    const population = strata[s.stratum];
    assert.ok(population && population.count > 0, `stratum population missing for ${s.stratum}`);
    const weight = population.count / sampleCount[s.stratum];
    weightedTotalMs += s.durationMs * weight;
    if (!s.rulesCategory) {
      weightedNullMs += s.durationMs * weight;
    }
  }
  const weightedNullShare = weightedNullMs / weightedTotalMs;
  assert.ok(weightedNullShare <= 0.3,
    `stratum-weighted corpus null share ${(weightedNullShare * 100).toFixed(1)}% exceeds 30% guard`);
});
