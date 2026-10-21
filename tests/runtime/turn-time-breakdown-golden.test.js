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
  // Rules-null share is JEV-bound by design (wrapper scripts); guard against
  // rules coverage regressions pushing it beyond the sampled 41.3%.
  assert.ok(unclassifiedMs / totalMs <= 0.45,
    `rules-null time share ${(unclassifiedMs / totalMs * 100).toFixed(1)}% exceeds 45% guard`);
});
