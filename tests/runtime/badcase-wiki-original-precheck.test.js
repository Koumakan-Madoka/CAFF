const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const api = () => require(base + 'wiki-original-precheck');
const storage = () => require(base + 'wiki-original-precheck-store');
const H = c => c.repeat(64);
function fixture(t, { run = false, reportOnly = false, policy } = {}) {
  const h = require('../helpers/wiki-scene-run.cjs')(t), state = h.store.read(), item = state.cases[0];
  item.split = 'gate';
  const replay = { id: 'synthetic-replay', sourceCaseId: item.id, checkpointHash: H('c'), request: { association: { checkpointId: item.sealedCheckpointId } } };
  state.replayCases = [replay];
  let replayChecks = [{ caseId: item.id, level: 'trace', status: 'supported', checkpointHash: replay.checkpointHash }];
  if (run && !reportOnly) {
    item.sealedCheckpointId = null; state.replayCases = [];
    replayChecks = [{ caseId: item.id, level: 'run', status: 'supported', traceHash: item.traceBundle.hash, decisionHash: h.decision.hash, cutStep: 29 }];
  }
  const input = { state, caseId: item.id, rubricHash: h.rubric.hash, inputHash: H('d'), replayChecks, ...(reportOnly ? { reportOnly: true } : {}), ...(policy ? { policy } : {}) };
  return { ...h, state, source: item, replay, input, plan: () => api().createWikiOriginalPrecheckPlan(input) };
}
function rows(statuses) {
  return statuses.map((status, i) => ({ iteration: i + 1, variant: 'original', status, artifactId: 'synthetic-output-' + (i + 1), artifactHash: H('e'), usageComplete: true }));
}
function summary(plan, statuses, status = 'completed') { return api().summarizeWikiOriginalPrecheck(plan, { status, reason: status === 'completed' ? null : 'operator_interrupted', runs: rows(statuses) }); }

test('precheck defaults to 3 trace / 5 run attempts, pins frozen identities, and never mutates Wiki', t => {
  for (const run of [false, true]) {
    const h = fixture(t, { run }), before = JSON.stringify(h.state), plan = h.plan();
    assert.equal(plan.variant, 'original'); assert.equal(plan.model, 'openai-codex/gpt-6.1-sol');
    assert.equal(plan.policy.repeats, run ? 5 : 3); assert.equal(plan.policy.failureThreshold, .5); assert.equal(plan.policy.controlThreshold, 1);
    assert.equal(plan.caseId, h.c.id); assert.equal(plan.rubricHash, h.rubric.hash); assert.equal(plan.rubricVersion, 1);
    assert.equal(plan.sourceHash, h.rubric.sourceHash); assert.equal(plan.execution.traceHash, h.source.traceBundle.hash);
    assert.equal(plan.execution.level, run ? 'run' : 'trace');
    if (run) { assert.equal(plan.execution.decisionHash, h.decision.hash); assert.equal(plan.execution.cutStep, 29); }
    else { assert.equal(plan.execution.replayId, h.replay.id); assert.equal(plan.execution.checkpointHash, H('c')); }
    assert.equal(JSON.stringify(h.state), before);
  }
});
test('reproduction is strictly above threshold; invalid and errors are outside its denominator', t => {
  const h = fixture(t, { policy: { repeats: 4 } }), plan = h.plan();
  const tie = summary(plan, ['pass', 'fail', 'invalid', 'error']);
  assert.equal(tie.valid, 2); assert.equal(tie.failureRatio, .5); assert.equal(tie.reproduced, false);
  assert.equal(tie.invalid, 1); assert.equal(tie.errors, 1);
  assert.equal(summary(plan, ['fail', 'fail', 'pass', 'invalid']).reproduced, true);
  const empty = summary(plan, ['error', 'invalid', 'invalid', 'error']);
  assert.equal(empty.failureRatio, null); assert.equal(empty.passRatio, null); assert.equal(empty.reproduced, false); assert.equal(empty.controlEligible, false);
});
test('counts and both thresholds are configurable and hashed; exact thresholds have distinct rules', t => {
  const h = fixture(t, { policy: { repeats: 4, failureThreshold: .75, controlThreshold: .75 } }), plan = h.plan();
  assert.equal(summary(plan, ['fail', 'fail', 'fail', 'pass']).reproduced, false);
  assert.equal(summary(plan, ['fail', 'fail', 'fail', 'fail']).reproduced, true);
  assert.equal(summary(plan, ['pass', 'pass', 'pass', 'fail']).controlEligible, true);
  assert.equal(summary(plan, ['pass', 'pass', 'fail', 'fail']).controlEligible, false);
  assert.deepEqual(plan, h.plan(), 'identical frozen inputs produce an identical plan and hash');
  h.input.policy.controlThreshold = 1; assert.notEqual(plan.planHash, h.plan().planHash);
});
test('default controls require every planned attempt to pass, not merely all valid attempts', t => {
  const h = fixture(t), plan = h.plan();
  assert.equal(summary(plan, ['pass', 'pass', 'pass']).controlEligible, true);
  for (const tail of ['fail', 'invalid', 'error']) assert.equal(summary(plan, ['pass', 'pass', tail]).controlEligible, false);
  assert.equal(summary(plan, ['pass'], 'stopped').controlEligible, false);
  assert.equal(summary(plan, ['fail'], 'failed').reproduced, false);
  for (const split of [null, 'train', 'test']) { h.source.split = split; assert.equal(summary(h.plan(), ['pass', 'pass', 'pass']).controlEligible, false); }
});
test('stopped, partial, unknown-usage or report-only runs cannot qualify as reproduction or controls', t => {
  const h = fixture(t), plan = h.plan();
  assert.throws(() => summary(plan, ['fail']), /wiki_original_precheck_invalid/);
  const stopped = summary(plan, ['fail', 'fail', 'fail'], 'stopped'); assert.equal(stopped.reproduced, false); assert.equal(stopped.complete, false);
  const value = { status: 'completed', reason: null, runs: rows(['pass', 'pass', 'pass']) }; value.runs[2].usageComplete = false;
  assert.throws(() => api().summarizeWikiOriginalPrecheck(plan, value), /wiki_original_precheck_invalid/);
  value.status = 'stopped'; value.reason = 'usage_unknown'; assert.equal(api().summarizeWikiOriginalPrecheck(plan, value).controlEligible, false);
  const report = fixture(t, { run: true, reportOnly: true }).plan();
  assert.equal(report.reportOnly, true); assert.equal(report.execution.level, 'run'); assert.equal(report.execution.cutStep, 29);
  assert.equal(summary(report, ['fail', 'fail', 'fail', 'fail', 'fail']).reproduced, false);
  assert.equal(summary(report, ['pass', 'pass', 'pass', 'pass', 'pass']).controlEligible, false);
});
test('new plans require an exact supported offline check and a frozen current assertion', t => {
  for (const mutate of [
    h => h.input.replayChecks = [], h => h.input.replayChecks[0].status = 'pending', h => h.input.replayChecks[0].checkpointHash = H('f'),
    h => h.state.rubrics[0].status = 'draft', h => h.source.expected = 'different expectation', h => h.input.rubricHash = H('f'),
    h => h.source.source.agentId = 'role-family-deepseek', h => h.state.replayCases[0].request.association.checkpointId = 'different-scene',
  ]) { const h = fixture(t); mutate(h); assert.throws(() => h.plan(), /wiki_(?:original_precheck|rubric)_/); }
  for (const mutate of [h => h.input.replayChecks[0].decisionHash = H('f'), h => h.input.replayChecks[0].traceHash = H('f'), h => h.state.dehydrations[0].decision.cutStep = 30]) {
    const h = fixture(t, { run: true }); mutate(h); assert.throws(() => h.plan(), /wiki_original_precheck_/);
  }
});
test('closed policy/plan rejects candidate selection, excessive attempts and invalid fractions before execution', t => {
  for (const policy of [{ repeats: 0 }, { repeats: 21 }, { repeats: 1.5 }, { failureThreshold: -1 }, { failureThreshold: 1.1 }, { failureThreshold: NaN }, { controlThreshold: 0 }, { controlThreshold: 1.1 }, { retries: 3 }]) {
    const h = fixture(t, { policy }); assert.throws(() => h.plan(), /wiki_original_precheck_invalid/);
  }
  const h = fixture(t); h.input.candidateId = 'candidate'; assert.throws(() => h.plan(), /wiki_original_precheck_invalid/);
  delete h.input.candidateId; const plan = h.plan();
  for (const change of [p => p.variant = 'candidate', p => p.rubricHash = H('f'), p => p.execution.cutStep = 29, p => p.model = 'another-model']) {
    const copy = structuredClone(plan); change(copy); assert.throws(() => api().validateWikiOriginalPrecheckPlan(copy), /wiki_original_precheck_invalid/);
  }
});
test('attempts are original-only, bounded, consecutive, and contain fixed safe evidence references', t => {
  const h = fixture(t), plan = h.plan();
  for (const mutate of [v => v.runs[0].variant = 'candidate', v => v.runs[1].iteration = 3, v => v.runs.push(v.runs[0]), v => v.runs[0].status = 'reached',
    v => v.runs[0].artifactId = '../private', v => v.runs[0].artifactHash = 'wrong', v => v.runs[0].rawReply = 'private reply', v => v.reason = 'private upstream response']) {
    const value = { status: 'completed', reason: null, runs: rows(['pass', 'fail', 'invalid']) }; mutate(value);
    assert.throws(() => api().summarizeWikiOriginalPrecheck(plan, value), /wiki_original_precheck_invalid/);
  }
});
test('offline reads create no directory; reservation and final records are separate immutable claims', t => {
  const h = fixture(t), plan = h.plan(), create = () => storage().createWikiOriginalPrecheckStore(h.scope), store = create();
  assert.deepEqual(store.list(), []); assert.equal(fs.existsSync(path.join(h.scope.globalRoot, 'original-prechecks')), false);
  const before = JSON.stringify(h.store.read()), reservation = store.reserve(plan), bytes = fs.readFileSync(path.join(h.scope.globalRoot, 'original-prechecks', reservation.id + '.json'));
  assert.equal(reservation.plan.planHash, plan.planHash); assert.equal(store.read(reservation.id).result, null, 'a crash leaves an explicit unknown reservation');
  const value = { status: 'completed', reason: null, runs: rows(['fail', 'fail', 'pass']) }, result = store.finish(reservation.id, value);
  assert.equal(result.summary.reproduced, true); assert.equal(result.planHash, plan.planHash); assert.equal(result.id, reservation.id);
  assert.throws(() => store.finish(reservation.id, value), /wiki_original_precheck_already_finished/);
  assert.deepEqual(fs.readFileSync(path.join(h.scope.globalRoot, 'original-prechecks', reservation.id + '.json')), bytes);
  assert.deepEqual(create().read(reservation.id).result, result); assert.equal(create().list().length, 1);
  assert.equal(JSON.stringify(h.store.read()), before, 'precheck evidence never enters Wiki snapshots or formal gate/test result stores');
  const another = store.reserve(plan); assert.notEqual(another.id, reservation.id, 'explicit new executions do not overwrite old results');
});
test('immutable records reject modified hashes, recomputed summaries, foreign plans and non-regular files', t => {
  for (const mutation of [
    e => e.result.summary.reproduced = false,
    e => { e.result.summary.reproduced = false; e.hash = require(base + 'wiki-rubric').wikiValueHash(e.result); },
    e => { e.result.planHash = H('f'); e.hash = require(base + 'wiki-rubric').wikiValueHash(e.result); },
    e => { e.result.runs[0].variant = 'candidate'; e.hash = require(base + 'wiki-rubric').wikiValueHash(e.result); },
    e => e.extra = 'unexpected',
    e => { e.result.finishedAt = '2000-01-01T00:00:00.000Z'; e.hash = require(base + 'wiki-rubric').wikiValueHash(e.result); },
  ]) {
    const h = fixture(t), store = storage().createWikiOriginalPrecheckStore(h.scope), r = store.reserve(h.plan());
    store.finish(r.id, { status: 'completed', reason: null, runs: rows(['fail', 'fail', 'pass']) });
    const file = path.join(h.scope.globalRoot, 'original-prechecks', r.id + '.result.json'), e = JSON.parse(fs.readFileSync(file, 'utf8')); mutation(e); fs.writeFileSync(file, JSON.stringify(e));
    assert.throws(() => store.read(r.id), /wiki_original_precheck_record_invalid/);
  }
  const h = fixture(t), store = storage().createWikiOriginalPrecheckStore(h.scope), r = store.reserve(h.plan()), file = path.join(h.scope.globalRoot, 'original-prechecks', r.id + '.json');
  fs.unlinkSync(file); fs.mkdirSync(file); assert.throws(() => store.read(r.id), /wiki_original_precheck_record_invalid/);
});
test('invalid finish never publishes; scoped storage rejects data inside the source worktree', t => {
  const h = fixture(t), store = storage().createWikiOriginalPrecheckStore(h.scope), r = store.reserve(h.plan());
  assert.throws(() => store.finish(r.id, { status: 'completed', reason: null, runs: rows(['fail']) }), /wiki_original_precheck_invalid/);
  assert.equal(store.read(r.id).result, null);
  assert.throws(() => storage().createWikiOriginalPrecheckStore({ globalRoot: path.join(h.scope.sourceWorktree, 'inside'), sourceWorktree: h.scope.sourceWorktree }), /wiki_storage_inside_source/);
  assert.throws(() => store.read('../foreign'), /wiki_original_precheck_invalid/);
});
