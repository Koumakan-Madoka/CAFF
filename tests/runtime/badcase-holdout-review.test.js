const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const fixture = require('../helpers/wiki-holdout-full-batch.cjs'), execution = require('../helpers/wiki-holdout-full-execution.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const comparisons = h => require(base + 'wiki-comparison-store').createWikiComparisonStore(h.config);
const reviewInput = (h, saved, decision, reason) => ({ comparisonId: saved.id, candidateHash: saved.candidate.candidateHash,
  expectedRevision: h.store.read().revision, decision, reason, interpretation: 'Synthetic human decision; not production approval.' });
test('v4 non-adoption distinguishes gate rejection, degraded validation and user decline without changing a baseline', async t => {
  for (const [reason, params] of [['gate_rejected', { gateCandidatePasses: 0 }], ['validation_degraded', { validationLoss: 2 }], ['user_declined', {}]]) {
    const h = fixture(t), saved = comparisons(h).save(await execution(h, params).run()), before = h.store.read();
    const input = reviewInput(h, saved, 'not-adopted', reason), reviewed = h.store.reviewComparison(input), after = h.store.read();
    assert.equal(reviewed.reason, reason); assert.equal(reviewed.validationOutcome, saved.validation.status);
    assert.equal(reviewed.outcome, saved.outcome); assert.deepEqual(reviewed.uncovered, saved.validation.uncovered);
    assert.equal(reviewed.baselineChanged, false); assert.deepEqual(after.baselines, before.baselines); assert.deepEqual(after.cases, before.cases);
    assert.deepEqual(h.store.reviewComparison({ ...input, expectedRevision: after.revision }), reviewed); assert.equal(h.store.read().revision, after.revision);
    assert.throws(() => h.store.reviewComparison({ ...input, expectedRevision: after.revision, interpretation: 'Replace human decision' }), { code: 'wiki_comparison_reviewed' });
    const draft = after.experiences.at(-1); assert.equal(draft.summary.reviewId, reviewed.id); assert.match(draft.methods, /本轮未采纳/);
  }
});
test('early-stopped degradation can be rejected and written back as experience, but never adopted', async t => {
  const h = fixture(t); h.twoControls(); const saved = comparisons(h).save(await execution(h, { validationLoss: 2 }).run());
  assert.equal(saved.cases.at(-1).status, 'not-run'); assert.equal(saved.completed, true);
  assert.throws(() => h.store.reviewComparison(reviewInput(h, saved, 'adopted', 'user_accepted')), { code: 'wiki_comparison_review_invalid' });
  const review = h.store.reviewComparison(reviewInput(h, saved, 'not-adopted', 'validation_degraded'));
  assert.equal(review.reason, 'validation_degraded'); assert.equal(review.validationOutcome, 'degraded');
  assert.equal(h.store.read().baselines.length, 0);
  const draft = h.store.read().experiences.at(-1);
  assert.equal(draft.summary.validation.cases.at(-1).degraded, null); assert.match(draft.methods, /#18.*已有劣化而停止/);
  assert.doesNotMatch(draft.methods, /#18[^；\n]*未劣化/);
});
test('v4 adoption remains explicit human action and records partial, absent or full coverage exactly', async t => {
  for (const coverage of ['partial', 'none', 'full']) {
    const h = fixture(t);
    if (coverage === 'none') { h.mutate(s => s.controlConfirmations = []); h.sync(); }
    if (coverage === 'full') h.mutate(s => s.versions[0].entries = s.versions[0].entries.filter(e => e.id !== 'entry-2'));
    const saved = comparisons(h).save(await execution(h).run()), before = h.store.read();
    assert.equal(before.baselines.length, 0); assert.equal(before.comparisonReviews.length, 0);
    const accepted = h.store.reviewComparison(reviewInput(h, saved, 'adopted', 'user_accepted')), state = h.store.read();
    assert.equal(accepted.baselineChanged, true); assert.equal(state.baselines.length, 1);
    assert.equal(state.baselines[0].baseHash, saved.candidate.candidateHash); assert.deepEqual(accepted.uncovered, saved.validation.uncovered);
    assert.equal(accepted.outcome, { partial: 'validation-partial-coverage', none: 'validation-uncovered', full: 'validation-passed' }[coverage]);
    assert.equal(require(base + 'wiki-baseline').resolveWikiBaseline(state, saved.candidate.targetId).target.baseHash, saved.candidate.candidateHash);
    assert.deepEqual(state.cases, before.cases); assert.deepEqual(state.controlConfirmations, before.controlConfirmations);
    assert.equal(state.experiences.at(-1).summary.reviewId, accepted.id); assert.match(state.experiences.at(-1).methods, /用户明确采纳为评测基线/);
    assert.deepEqual(comparisons(h).read(), [saved]);
  }
});
test('v4 review does not accept failed/degraded/budget-blocked/incomplete evaluations as no-degradation adoption', async t => {
  for (const scenario of ['gate', 'degraded', 'over-limit', 'incomplete']) {
    const h = fixture(t); if (scenario === 'over-limit') h.config.evaluation.validation.policy = { maxEstimatedTokens: 1 };
    const f = execution(h, { gateCandidatePasses: scenario === 'gate' ? 0 : 6, validationLoss: scenario === 'degraded' ? 2 : 0 });
    if (scenario === 'incomplete') f.options.runProductionComparison = async () => { throw Error('Synthetic executor failure'); };
    const saved = comparisons(h).save(await f.run()), before = h.store.read();
    assert.throws(() => h.store.reviewComparison(reviewInput(h, saved, 'adopted', 'user_accepted')), { code: 'wiki_comparison_review_invalid' });
    if (scenario === 'over-limit' || scenario === 'incomplete') assert.throws(() => h.store.reviewComparison(reviewInput(h, saved, 'not-adopted', 'user_declined')), { code: 'wiki_comparison_review_invalid' });
    assert.deepEqual(h.store.read(), before);
  }
});
test('v4 rejection reasons must match their stage and legacy test failure cannot stand in for validation', async t => {
  const h = fixture(t), saved = comparisons(h).save(await execution(h).run()), before = h.store.read();
  for (const reason of ['gate_rejected', 'validation_degraded', 'test_not_passed']) assert.throws(() => h.store.reviewComparison(reviewInput(h, saved, 'not-adopted', reason)), { code: 'wiki_comparison_review_invalid' });
  for (const patch of [{ expectedRevision: before.revision - 1 }, { candidateHash: '0'.repeat(64) }]) assert.throws(() => h.store.reviewComparison({ ...reviewInput(h, saved, 'adopted', 'user_accepted'), ...patch }));
  assert.deepEqual(h.store.read(), before);
});
test('v4 safe experience reports pooled gate and per-control validation, never claims uncovered modes passed or copies outputs', async t => {
  const h = fixture(t), saved = comparisons(h).save(await execution(h, { validationLoss: 1 }).run()), before = h.store.read(), draft = before.experiences.at(-1);
  assert.equal(draft.status, 'draft'); assert.equal(draft.trainingTraceCount, 0); assert.equal(draft.tracePolicy, 'training-only-no-holdout-trajectories');
  assert.match(draft.methods, /门槛（本模式）.*合计.*Fisher/); assert.match(draft.methods, /验证（其他模式对照题）.*#17.*5\/5.*4\/5.*未劣化/);
  assert.match(draft.methods, /未覆盖.*entry-2/); assert.doesNotMatch(draft.methods, /测试：|开头结论已改善|模式整体变好了/);
  assert.doesNotMatch(JSON.stringify(draft), /PRIVATE-REPLY|Synthetic private reply|finalText|traceExcerpt|goalEvidence/);
  assert.equal(draft.summary.outcome, saved.outcome); assert.deepEqual(draft.summary.validation, saved.validation);
  assert.deepEqual(comparisons(h).save(saved), saved); assert.deepEqual(h.store.read(), before);
  h.store.reviewExperience({ experienceId: draft.id, expectedRevision: before.revision, decision: 'approved', patch: { methods: 'Synthetic human-edited method.' } });
  const approved = h.store.read().experiences.at(-1);
  const review = h.store.reviewComparison(reviewInput(h, saved, 'not-adopted', 'user_declined')), after = h.store.read();
  assert.deepEqual(after.experiences.find(e => e.id === approved.id), approved);
  assert.equal(after.experiences.at(-1).status, 'draft'); assert.equal(after.experiences.at(-1).parentId, approved.id); assert.equal(after.experiences.at(-1).summary.reviewId, review.id);
});
test('v4 experience recovery reuses the trusted command and exact saved comparison without any execution', async t => {
  const h = fixture(t), raw = await execution(h).run(), saved = comparisons(h).save(raw);
  const config = path.join(h.root, 'recovery.config.json'), result = path.join(h.root, 'raw.json');
  fs.writeFileSync(config, JSON.stringify(h.scope)); fs.writeFileSync(result, JSON.stringify(raw));
  const before = h.store.read(), write = process.stdout.write; process.stdout.write = () => true;
  try {
    const recovered = require('../../scripts/badcase-capture/draft-wiki-experience.cjs').main(['--config', config, '--comparison', saved.id, '--result', result, '--confirmed', '--expected-revision', String(before.revision)]);
    assert.equal(recovered.modelCalls, 0); assert.equal(recovered.experienceId, before.experiences.at(-1).id); assert.deepEqual(h.store.read(), before);
  } finally { process.stdout.write = write; }
});
