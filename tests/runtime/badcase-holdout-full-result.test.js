const test = require('node:test'), assert = require('node:assert/strict');
const fixture = require('../helpers/wiki-holdout-full-batch.cjs'), execution = require('../helpers/wiki-holdout-full-execution.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { projectStagedResult } = require(base + 'wiki-staged-result'), { wikiComparisonTotals: totals } = require(base + 'wiki-comparison-totals');
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
const project = r => projectStagedResult(r, totals);
const saved = r => ({ id: 'comparison-' + hash(project(r)), ...project(r) });
test('full v4 result rederives pooled gate, per-control validation, coverage and stage totals; strips private fields', async t => {
 const h = fixture(t), f = execution(h), r = await f.run(), p = project(r);
 assert.equal(p.kind, 'wiki-mode-holdout-comparison-v2'); assert.equal(p.outcome, 'validation-partial-coverage');
 assert.equal(p.completed, true); assert.equal(p.adoptionEligible, true); assert.deepEqual(p.gateDecision, r.gateDecision);
 assert.deepEqual(p.validation, r.validation); assert.deepEqual(p.byStage, r.byStage); assert.equal(p.byStage.validation.original.planned, 5);
 assert.equal(p.validation.cases[0].original.passed, 5); assert.deepEqual(p.validation.uncovered, [{ entryId: 'entry-2', reason: 'no-confirmed-control' }]);
 assert.doesNotMatch(JSON.stringify(p), /PRIVATE-REPLY|Synthetic private reply/); assert.deepEqual(project(p), p); assert.equal(hash(project(p)), hash(p));
 assert.equal(h.store.read().experiences.length, 0);
});
test('full projection retains gate rejection, one-pass fluctuation, degradation, full coverage and entirely uncovered outcomes', async t => {
 for (const scenario of ['gate-rejected', 'fluctuation', 'validation-degraded', 'validation-passed', 'validation-uncovered']) {
  const h = fixture(t);
  if (scenario === 'validation-passed') h.mutate(s => s.versions[0].entries = s.versions[0].entries.filter(e => e.id !== 'entry-2'));
  if (scenario === 'validation-uncovered') { h.config.evaluation.validation.skippedCaseIds = [h.marked[0].id]; h.sync(); }
  const f = execution(h, { gateCandidatePasses: scenario === 'gate-rejected' ? 0 : 6, validationLoss: scenario === 'fluctuation' ? 1 : scenario === 'validation-degraded' ? 2 : 0 });
  const r = await f.run(), p = project(r);
  assert.equal(p.outcome, scenario === 'fluctuation' ? 'validation-partial-coverage' : scenario); assert.deepEqual(p.byStage, r.byStage);
  assert.deepEqual(p.validation, r.validation); assert.equal(p.adoptionEligible, !['gate-rejected', 'validation-degraded'].includes(scenario)); assert.equal(p.completed, true);
 }
});
test('full projection preserves budget/technical stops, and does not manufacture clean validation outputs', async t => {
 for (const scenario of ['over-limit', 'gate-error', 'validation-error']) {
  const h = fixture(t); if (scenario === 'over-limit') h.config.evaluation.validation.policy = { maxEstimatedTokens: 1 };
  const f = execution(h);
  if (scenario !== 'over-limit') f.options.runProductionComparison = async (c, o) => {
   if (scenario === 'validation-error' && c.scoring.rubric.caseId !== f.pinned.summary.evaluation.validationCaseIds[0]) return f.compare(c, o);
   throw Object.assign(Error('PRIVATE-ERROR'), { code: 'evaluation_codex_auth_failed' });
  };
  const r = await f.run(), p = project(r); assert.equal(p.completed, false); assert.equal(p.adoptionEligible, false); assert.equal(p.outcome, 'indeterminate');
  assert.equal(p.validation.status, scenario === 'over-limit' ? 'over-limit' : scenario === 'gate-error' ? 'not-run' : 'incomplete');
  assert.deepEqual(project(p), p); assert.doesNotMatch(JSON.stringify(p), /PRIVATE-ERROR/);
 }
});
test('full result ignores untrusted aggregate counters but refuses invented decisions, membership, scoring or attempted blocked stages', async t => {
 const h = fixture(t), r = await execution(h).run(), a = structuredClone(r); a.byStage = { private: true }; a.cases[0].totals = {};
 assert.deepEqual(project(a), project(r));
 for (const mutate of [x => x.outcome = 'validation-passed', x => x.adoptionEligible = false, x => x.validation.cases[0].degraded = true,
  x => x.validation.cases[0].candidate.passed--, x => x.validation.uncovered = [], x => x.gateDecision.outcome = 'rejected',
  x => x.completed = false, x => x.modelCallsKnown++, x => x.callsUnavailable = true, x => x.cases.at(-1).callsUnavailable = true,
  x => x.cases.reverse(), x => x.cases.at(-1).stage = 'test', x => x.cases.at(-1).split = 'train', x => x.cases.at(-1).category = 'reproduction',
  x => x.cases.at(-1).classification.entryId = 'entry-6', x => x.cases.at(-1).runs[0].status = 'fail',
  x => delete x.cases.at(-1).runs[0].assessment.tool, x => x.cases.at(-1).comparison.scoring.inputHash = hash('wrong'),
  x => x.cases.at(-1).rubric.hash = hash('wrong'), x => x.evaluation.validationCaseIds = [], x => x.split.validationCaseIds = [],
  x => x.experiment.validation.hash = hash('wrong'), x => x.experiment.planHash = hash('wrong')]) {
  const copy = structuredClone(r); mutate(copy); assert.throws(() => project(copy));
 }
 const rejected = await execution(fixture(t), { gateCandidatePasses: 0 }).run();
 rejected.cases.at(-1).runs = structuredClone(r.cases.at(-1).runs); rejected.cases.at(-1).status = 'completed'; assert.throws(() => project(rejected));
});
test('full real single-call projection binds request/check evidence, configurable validation repeats and run/trace reports', async t => {
 const h = fixture(t); h.makeRun24(); h.run18(); h.config.evaluation.validation.policy = { repeats: 3, degradationThreshold: 1 };
 const f = execution(h); let sends = 0;
 f.options.runProductionRunComparison = undefined; f.options.knownValues = [];
 f.options.createRunClient = async () => ({ state: () => ({ reason: null }), close: async () => {}, complete: async request => {
  sends++;
  const shape = require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items.find(x => x.case === 22 && x.step === (request.variant.kind === 'candidate' || request.metadata.caseId === h.marked[1].id ? 30 : 29));
  return { networkRequests: 1, durationMs: 1, wireRequest: require(base + 'wiki-run-wire').buildWikiRunWireRequest(request),
   message: { role: 'assistant', stopReason: 'toolUse', content: shape.toolCalls.map((c, i) => ({ type: 'toolCall', id: 'fake-' + i, ...c })) } };
 } });
 const r = await f.run(), p = project(r); assert.equal(sends, 26); assert.equal(p.completed, true); assert.equal(p.gateDecision.outcome, 'accepted');
 assert.equal(p.validation.byLevel.run.original.total, 3); assert.equal(p.validation.byLevel.trace.original.total, 0);
 const control = p.cases.at(-1); assert.equal(control.execution.level, 'run'); assert.equal(control.totals.original.planned, 3); assert.equal(control.totals.original.notRun, 0);
 assert.deepEqual(p.byStage, r.byStage); assert.deepEqual(project(p), p);
 for (const mutate of [c => c.comparison.repeats = 5, c => c.runs[0].requestHash = hash('wrong'), c => c.runs[0].checks.tool.status = 'fail', c => c.runs[0].toolExecutions = 1]) {
  const copy = structuredClone(r); mutate(copy.cases.at(-1)); assert.throws(() => project(copy));
 }
});
test('full progress/projection retains trace invalid/error replacements outside validation denominators', async t => {
 const h = fixture(t), f = execution(h, { prefixes: { [h.marked[0].id]: ['invalid', 'error'] } });
 const store = require(base + 'wiki-batch-execution-store').createWikiBatchExecutionStore(h.config), start = store.start(f.pinned.summary), r = await f.run(), p = project(r);
 assert.equal(p.validation.cases[0].original.total, 5); assert.equal(p.validation.byLevel.trace.original.invalid, 1); assert.equal(p.validation.byLevel.trace.candidate.errors, 1);
 assert.equal(p.byStage.validation.original.notRun, 0); assert.equal(p.byStage.validation.original.invalid, 1); assert.deepEqual(project(p), p);
 for (const e of f.events) store.event(start.id, e);
 const finish = store.finish(start.id, saved(r)); assert.equal(finish.status, 'completed'); assert.equal(finish.summary.byLevel.trace.original.invalid, 1);
});
test('full run validation supports twenty valid outputs per arm plus replacements in retained results and progress', async t => {
 const h = fixture(t); h.run18(); h.config.evaluation.validation.policy = { repeats: 20 };
 const f = execution(h); let sends = 0;
 f.options.runProductionRunComparison = undefined; f.options.knownValues = [];
 f.options.createRunClient = async () => ({ state: () => ({ reason: null }), close: async () => {}, complete: async request => {
  const invalid = ++sends === 1;
  const shape = require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items.find(x => x.case === (invalid ? 23 : 22) && x.step === (invalid ? 45 : 30));
  return { networkRequests: 1, durationMs: 1, wireRequest: require(base + 'wiki-run-wire').buildWikiRunWireRequest(request),
   message: { role: 'assistant', stopReason: 'toolUse', content: shape.toolCalls.map((c, i) => ({ type: 'toolCall', id: 'fake-' + i, ...c })) } };
 } });
 const store = require(base + 'wiki-batch-execution-store').createWikiBatchExecutionStore(h.config), start = store.start(f.pinned.summary), r = await f.run(), p = project(r);
 assert.equal(sends, 41); assert.equal(p.completed, true); assert.equal(p.validation.byLevel.run.original.total, 20);
 assert.equal(p.validation.byLevel.run.original.invalid, 1); assert.equal(p.byStage.validation.original.notRun, 0); assert.equal(p.cases.at(-1).runs.length, 41);
 assert.deepEqual(project(p), p); for (const e of f.events) store.event(start.id, e);
 const finish = store.finish(start.id, saved(r)); assert.equal(finish.status, 'completed'); assert.equal(finish.summary.byStage.validation.original.planned, 20);
 assert.equal(finish.summary.byLevel.run.original.invalid, 1); assert.deepEqual(store.read()[0], finish);
});
test('full unknown-usage projection remains indeterminate without backfilling or executing validation', async t => {
 const h = fixture(t), id = h.marked[0].id; h.mutate(s => s.controlConfirmations = []);
 const old = h.records.list().find(r => r.reservation.plan.caseId === id), claim = h.records.reserve(old.reservation.plan);
 h.records.finish(claim.id, { status: 'completed', reason: null, runs: old.result.runs.map(({ usage, ...r }) => ({ ...r, status: 'pass' })) }); h.confirm(id); h.sync();
 const f = execution(h), p = project(await f.run()); assert.equal(p.outcome, 'indeterminate'); assert.equal(p.validation.status, 'usage-unknown'); assert.equal(p.adoptionEligible, false);
 assert.equal(f.executions.length, 2); assert.deepEqual(project(p), p);
});
test('full immutable read is byte/hash stable after current confirmations/assertions change; no re-admission or silent upgrade', async t => {
 const fs = require('node:fs'), path = require('node:path'), h = fixture(t), payload = project(await execution(h).run());
 const byteHash = v => require('node:crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const record = { id: 'comparison-' + byteHash(payload), createdAt: '2026-11-11T00:00:00.000Z', ...payload }, dir = path.join(h.scope.globalRoot, 'comparisons'); fs.mkdirSync(dir);
 const file = path.join(dir, record.id.slice(11) + '.json'), bytes = JSON.stringify({ schemaVersion: 1, checksum: byteHash(record), record }) + '\n'; fs.writeFileSync(file, bytes);
 const read = () => require(base + 'wiki-comparison-record').readWikiComparisonRecord(h.scope.globalRoot, record.id, project);
 assert.deepEqual(read(), record); h.mutate(s => { s.rubrics = []; s.controlConfirmations = []; }); assert.deepEqual(read(), record); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
test('full progress records gate then validation, configured counts, stage/level reports and safe finish', async t => {
 const h = fixture(t); h.config.evaluation.validation.policy = { repeats: 3, degradationThreshold: 1 };
 const f = execution(h), store = require(base + 'wiki-batch-execution-store').createWikiBatchExecutionStore(h.config), start = store.start(f.pinned.summary);
 assert.equal(start.plan.kind, 'wiki-mode-holdout-comparison-v2'); assert.equal(start.plan.validationRepeats, 3);
 assert.deepEqual(Object.keys(start.summary.byStage), ['gate', 'validation']); assert.equal(start.summary.byStage.validation.original.planned, 3);
 assert.equal(start.summary.byLevel.trace.original.planned, 23);
 assert.throws(() => store.event(start.id, { event: 'run_start', sourceCaseId:h.marked[0].id, stage:'validation', variant:'original', iteration:1 }));
 const r = await f.run(); for (const e of f.events) store.event(start.id, e);
 const before = store.read()[0]; assert.equal(before.summary.totals.original.passed, 3);
 const forged = saved(r); forged.cases.at(-1).totals.original.planned = 10; assert.throws(() => store.finish(start.id, forged));
 assert.equal(store.read()[0].status, 'running'); const finish = store.finish(start.id, saved(r)); assert.equal(finish.status, 'completed'); assert.deepEqual(store.read()[0], finish);
});
test('full progress handles skipped validation, budget blocks, and early technical failure without fabricating outputs', async t => {
 for (const scenario of ['reject', 'budget', 'fatal']) {
  const h = fixture(t); if (scenario === 'budget') h.config.evaluation.validation.policy = { maxEstimatedTokens: 1 };
  const f = execution(h, { gateCandidatePasses: scenario === 'reject' ? 0 : 6 });
  if (scenario === 'fatal') f.options.runProductionComparison = async () => { throw Error('PRIVATE'); };
  const store = require(base + 'wiki-batch-execution-store').createWikiBatchExecutionStore(h.config), start = store.start(f.pinned.summary), r = await f.run();
  for (const e of f.events) store.event(start.id, e);
  const finish = store.finish(start.id, saved(r)); assert.equal(finish.status, scenario === 'reject' ? 'completed' : 'stopped');
  assert.equal(finish.summary.byStage.validation.original.attempted, 0); assert.equal(finish.summary.byStage.validation.original.notRun, 5);
 }
});
