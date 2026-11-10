// Read-only projection of trusted immutable evidence. No model, restoration,
// input preparation or network; fake scored packets use production core shapes.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createWikiOriginalPrecheckPlan } = require(base + 'wiki-original-precheck');
const { createWikiOriginalPrecheckStore } = require(base + 'wiki-original-precheck-store');
const { projectWikiPipelineStates } = require(base + 'wiki-pipeline');
const { wikiValueHash } = require(base + 'wiki-rubric');
const H = c => c.repeat(64);
function fixture(t, { run = false, policy } = {}) {
  const h = require('../helpers/wiki-scene-run.cjs')(t, { scene: !run }), state = h.store.read(), item = state.cases[0]; item.split = 'gate';
  const replay = { id: 'synthetic-replay', sourceCaseId: item.id, checkpointHash: H('c'), request: { association: { checkpointId: item.sealedCheckpointId } } };
  state.replayCases = run ? [] : [replay];
  const replayChecks = [run ? { caseId: item.id, level: 'run', status: 'supported', traceHash: item.traceBundle.hash, decisionHash: h.decision.hash, cutStep: h.decision.cutStep }
    : { caseId: item.id, level: 'trace', status: 'supported', checkpointHash: replay.checkpointHash }];
  const records = createWikiOriginalPrecheckStore(h.scope), input = { state, caseId: item.id, rubricHash: h.rubric.hash, inputHash: H('d'), replayChecks, ...(policy ? { policy } : {}) };
  function save(statuses = ['fail', 'fail', 'pass'], status = 'completed', patch = {}) {
    const r = records.reserve(createWikiOriginalPrecheckPlan({ ...input, ...patch }));
    records.finish(r.id, { status, reason: status === 'completed' ? null : 'usage_unknown', runs: statuses.map((s, i) => ({ iteration: i + 1, variant: 'original', status: s, artifactId: 'synthetic-artifact-' + i, artifactHash: H('e'), usageComplete: status === 'completed' })) });
    return r;
  }
  const project = (extra = {}) => projectWikiPipelineStates({ state, replayChecks, originalPrechecks: records.list(), ...extra })[0];
  return { ...h, state, item, replay, replayChecks, records, input, save, project };
}
test('library admission reads original precheck outcomes, never formal comparison failures or raw original replies', t => {
  const h = fixture(t), comparisons = [{ id: 'old-formal', createdAt: '2026-11-09T00:00:00.000Z', kind: 'wiki-staged-batch-comparison-v2', model: 'openai-codex/gpt-6.1-sol', cases: [
    { sourceCaseId: h.item.id, replayId: h.replay.id, comparison: { checkpointHash: h.replay.checkpointHash }, rubric: h.rubric, runs: Array.from({ length: 10 }, () => ({ variant: 'original', status: 'fail' })) },
  ] }];
  const before = JSON.stringify({ state: h.state, comparisons }), empty = h.project({ comparisons });
  assert.equal(empty.inLibrary, false); assert.equal(empty.precheck.status, 'missing'); assert.equal(empty.precheck.reproduced, false);
  h.save(); const row = h.project({ comparisons }); assert.equal(row.inLibrary, true); assert.equal(row.precheck.reproduced, true);
  assert.equal(row.precheck.current.summary.pass, 1); assert.equal(row.precheck.current.summary.fail, 2); assert.equal(row.precheck.current.summary.failureRatio, 2 / 3);
  assert.equal(row.precheck.notFormalStatistics, true); assert.equal(row.original.comparisonId, 'old-formal', 'historical formal counts remain separately visible');
  assert.equal(JSON.stringify({ state: h.state, comparisons }), before);
});
test('projection retains per-version counts/thresholds and binds current rubric/trace/cut/scene/check/split without reading large inputs', t => {
  for (const run of [false, true]) {
    const h = fixture(t, { run, policy: { repeats: 4 } }), first = h.save(['fail', 'fail', 'pass', 'invalid']), row = h.project(), bytes = JSON.stringify(h.records.list());
    assert.equal(row.inLibrary, true); assert.equal(row.precheck.current.id, first.id); assert.equal(row.precheck.current.summary.invalid, 1); assert.equal(row.precheck.current.summary.valid, 3);
    assert.equal(row.precheck.current.rubricHash, h.rubric.hash); assert.equal(row.precheck.current.policy.repeats, 4); assert.equal(row.precheck.history.length, 1);
    assert.equal(JSON.stringify(h.records.list()), bytes); assert.doesNotMatch(JSON.stringify(row.precheck), /synthetic-artifact|rawReply|bodyBase64|globalRoot|sourceWorktree|callbackToken/);
    for (const change of [s => s.expected = 'changed', s => s.traceBundle.hash = H('f'), s => s.split = 'train']) {
      const old = structuredClone(h.item); change(h.item); assert.equal(h.project().precheck.status, 'missing'); assert.equal(h.project().inLibrary, false); Object.assign(h.item, old);
    }
    const wrongCheck = [{ ...h.replayChecks[0], status: 'pending' }]; assert.equal(h.project({ replayChecks: wrongCheck }).inLibrary, false);
    assert.equal(h.project({ replayChecks: wrongCheck }).precheck.history.length, 1, 'historical evidence is still disclosed');
    if (run) { h.state.dehydrations[0].decision.cutStep++; assert.equal(h.project().inLibrary, false); }
    else { h.replay.checkpointHash = H('f'); assert.equal(h.project().inLibrary, false); }
  }
});
test('newest matching reservation/stopped/error result blocks stale favorable fallback and samples never pool', t => {
  const h = fixture(t), first = h.save();
  const pending = h.records.reserve(createWikiOriginalPrecheckPlan(h.input));
  let list = h.records.list(); list.find(r => r.reservation.id === first.id).reservation.createdAt = '2026-11-01T00:00:00.000Z'; list.find(r => r.reservation.id === pending.id).reservation.createdAt = '2026-11-02T00:00:00.000Z';
  let row = h.project({ originalPrechecks: list }); assert.equal(row.precheck.status, 'reserved'); assert.equal(row.precheck.current.id, pending.id); assert.equal(row.inLibrary, false); assert.equal(row.precheck.current.summary, null);
  h.records.finish(pending.id, { status: 'stopped', reason: 'usage_unknown', runs: [{ iteration: 1, variant: 'original', status: 'fail', artifactId: 'synthetic', artifactHash: H('e'), usageComplete: false }] });
  list = h.records.list(); list.find(r => r.reservation.id === first.id).reservation.createdAt = '2026-11-01T00:00:00.000Z'; list.find(r => r.reservation.id === pending.id).reservation.createdAt = '2026-11-02T00:00:00.000Z';
  row = h.project({ originalPrechecks: list }); assert.equal(row.precheck.status, 'stopped'); assert.equal(row.precheck.current.summary.attempted, 1); assert.equal(row.precheck.reproduced, false); assert.equal(row.inLibrary, false);
  const x = fixture(t, { policy: { repeats: 4 } }); x.save(['pass', 'fail', 'invalid', 'error']); const tie = x.project();
  assert.equal(tie.precheck.current.summary.failureRatio, .5); assert.equal(tie.inLibrary, false);
});
test('superseded frozen assertions and report-only cut results remain history, not precheck admission', t => {
  const h = fixture(t); h.save();
  const draft = h.store.saveRubricDraft({ caseId: h.c.id, model: h.rubric.model, questions: [], scoringModel: null, toolCheck: { ...h.rubric.toolCheck, rules: [{ parameter: 'reason', kind: 'max-chars', max: 900 }] } }, h.store.read().revision);
  const frozen = h.store.confirmRubric({ rubricId: draft.id, hash: draft.hash, confirmationRecord: 'Synthetic second version' }, h.store.read().revision); h.state.rubrics.push(frozen);
  const old = h.project(); assert.equal(old.precheck.status, 'missing'); assert.equal(old.precheck.history[0].current, false); assert.equal(old.inLibrary, false);
  h.save(['pass', 'pass', 'pass'], 'completed', { rubricHash: frozen.hash }); const current = h.project(); assert.equal(current.precheck.controlEligible, true); assert.equal(current.precheck.reproduced, false); assert.equal(current.inLibrary, false, 'eligible is not user-confirmed');
  assert.equal(current.precheck.history.length, 2); assert.equal(current.precheck.history[0].rubricVersion, 2);
  const report = fixture(t); report.save(['fail', 'fail', 'fail', 'fail', 'fail'], 'completed', { reportOnly: true }); assert.equal(report.project().precheck.status, 'missing'); assert.equal(report.project().inLibrary, false);
  assert.equal(report.project().precheck.history[0].reportOnly, true);
});
test('a new valid precheck supersedes the old run-only invalid-baseline stop, without changing raw accounting', t => {
  const h = fixture(t, { run: true, policy: { repeats: 3 } }); h.save();
  const raw = { caseId: h.item.id, traceHash: h.item.traceBundle.hash, decisionHash: h.decision.hash, variant: { kind: 'original' }, status: 'invalid' }, before = JSON.stringify(raw);
  const row = h.project({ runReplays: [raw] }); assert.equal(row.stopReason, null); assert.equal(row.inLibrary, true); assert.equal(row.original.invalid, 1); assert.equal(JSON.stringify(raw), before);
});
test('reading and projection leave every reservation/result byte and hash unchanged, including older optional-judge plans', t => {
  const h = fixture(t); h.save(); const directory = path.join(h.scope.globalRoot, 'original-prechecks');
  const before = new Map(fs.readdirSync(directory).map(f => [f, fs.readFileSync(path.join(directory, f))]));
  const records = h.records.list(); assert.equal(Object.hasOwn(records[0].reservation.plan, 'judge'), false);
  const planHash = records[0].reservation.plan.planHash, resultHash = wikiValueHash(records[0].result);
  for (let i = 0; i < 3; i++) { h.records.list(); h.project(); }
  assert.equal(h.records.read(records[0].reservation.id).reservation.plan.planHash, planHash);
  assert.equal(wikiValueHash(h.records.read(records[0].reservation.id).result), resultHash);
  assert.deepEqual(fs.readdirSync(directory), [...before.keys()]);
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(directory, file)), bytes);
});
test('projection recomputes summaries from immutable attempts; malformed packets fail closed instead of using favorable flags', t => {
  const h = fixture(t); h.save(); const records = h.records.list(), before = JSON.stringify(records);
  records[0].result.summary.reproduced = false;
  assert.throws(() => h.project({ originalPrechecks: records }), /wiki_original_precheck_record_invalid/);
  assert.notEqual(JSON.stringify(records), before); assert.equal(h.project().inLibrary, true);
});
