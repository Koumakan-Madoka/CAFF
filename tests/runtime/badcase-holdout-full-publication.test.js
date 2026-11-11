const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const fixture = require('../helpers/wiki-holdout-full-batch.cjs'), execution = require('../helpers/wiki-holdout-full-execution.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const comparisons = h => require(base + 'wiki-comparison-store').createWikiComparisonStore(h.config);
const cli = require('../../scripts/badcase-capture/compare-wiki-batch.cjs').main;
async function invoke(h, f, name = 'output') {
  const config = path.join(h.root, name + '.config.json'), output = path.join(h.root, name + '.jsonl');
  fs.writeFileSync(config, JSON.stringify(h.config));
  const args = ['--config', config, '--run', '--confirmed', '--expected-plan', f.pinned.summary.planHash, '--output', output];
  const write = process.stdout.write; let text = '';
  process.stdout.write = c => { text += c; return true; };
  try { await cli(args, f.options); } finally { process.stdout.write = write; }
  return { text, output, args };
}
test('full v4 results publish, list and re-save without executing models; source groups stay frozen', async t => {
  const h = fixture(t), before = h.store.read(), r = await execution(h).run(), s = comparisons(h), saved = s.save(r);
  assert.equal(saved.kind, 'wiki-mode-holdout-comparison-v2'); assert.equal(saved.outcome, 'validation-partial-coverage');
  assert.equal(saved.adoptionEligible, true); assert.deepEqual(s.read(), [saved]);
  const file = path.join(h.scope.globalRoot, 'comparisons', saved.id.slice(11) + '.json'), bytes = fs.readFileSync(file);
  assert.deepEqual(s.save(saved), saved); assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(h.store.read().cases, before.cases); assert.deepEqual(h.store.read().baselines, before.baselines);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE-REPLY|Synthetic private reply/);
});
test('full v4 new publication reuses current control confirmation and selection, retained list reads do not refresh it', async t => {
  const h = fixture(t), f = execution(h), s = comparisons(h), first = await f.run(), saved = s.save(first), next = await f.run();
  h.mutate(state => state.controlConfirmations = []);
  assert.throws(() => s.save(next), { code: 'wiki_comparison_invalid' });
  assert.deepEqual(s.read(), [saved]); assert.deepEqual(s.save(first), saved);
});
test('full v4 CLI reports gate then per-control validation, separate levels, public numbers, uncovered modes and human decision boundary', async t => {
  const h = fixture(t), f = execution(h), { text, output } = await invoke(h, f), saved = comparisons(h).read()[0];
  assert.equal(saved.outcome, 'validation-partial-coverage');
  const progress = require(base + 'wiki-batch-execution-store').createWikiBatchExecutionStore(h.config).read()[0];
  assert.equal(progress.status, 'completed'); assert.equal(progress.comparisonId, saved.id);
  assert.deepEqual(Object.keys(progress.summary.byStage), ['gate', 'validation']);
  assert.match(text, /门槛（本模式）/); assert.match(text, /验证（其他模式对照题）/);
  assert.ok(text.indexOf('门槛（本模式）') < text.indexOf('验证（其他模式对照题）'));
  assert.match(text, /#17.*原版 5\/5.*候选 5\/5.*未劣化/); assert.match(text, /未覆盖.*entry-2/);
  assert.match(text, /p=.*（阈值 0\.05）/); assert.match(text, /trace 级/); assert.match(text, /run 级/);
  assert.match(text, /人工.*采纳/); assert.doesNotMatch(text, /noHarm|测试题|验证尚未规划/);
  for (const c of saved.cases) assert.ok(!text.includes(c.sourceCaseId));
  const events = fs.readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events[0].event, 'page_execution'); assert.equal(events.at(-1).event, 'page_execution_finished');
  assert.ok(events.findIndex(e => e.event === 'gate_decision') < events.findIndex(e => e.event === 'run' && e.stage === 'validation'));
});
test('full report shows ignored cases with wikiDisplayCases numbers, not internal identifiers', async t => {
  const h = fixture(t), id = h.marked[7].id, old = h.records.list().find(r => r.reservation.plan.caseId === id), claim = h.records.reserve(old.reservation.plan);
  h.records.finish(claim.id, { status: 'completed', reason: null, runs: old.result.runs.map(r => ({ ...r, status: 'pass' })) });
  h.config.cases = h.config.cases.filter(c => c.sourceCaseId !== id); h.config.experiment.definition.cases = h.config.experiment.definition.cases.filter(c => c.caseId !== id);
  const { text } = await invoke(h, execution(h)); assert.match(text, /未参与判定：#24/); assert.ok(!text.includes(id));
});
test('full v4 rejected gate, degraded validation and blocked budgets remain honest in storage and CLI', async t => {
  for (const scenario of ['rejected', 'degraded', 'over-limit']) {
    const h = fixture(t);
    if (scenario === 'over-limit') h.config.evaluation.validation.policy = { maxEstimatedTokens: 1 };
    const f = execution(h, { gateCandidatePasses: scenario === 'rejected' ? 0 : 6, validationLoss: scenario === 'degraded' ? 2 : 0 });
    const exit = process.exitCode;
    try {
      const { text } = await invoke(h, f), saved = comparisons(h).read()[0];
      assert.equal(saved.adoptionEligible, false);
      assert.equal(saved.outcome, { rejected: 'gate-rejected', degraded: 'validation-degraded', 'over-limit': 'indeterminate' }[scenario]);
      assert.match(text, scenario === 'rejected' ? /门槛未通过.*验证未运行/ : scenario === 'degraded' ? /#17.*劣化/ : /用量估算超上限.*验证未运行/);
      if (scenario !== 'degraded') assert.ok(f.executions.every(c => c.stage === 'gate'));
    } finally { process.exitCode = exit; }
  }
});
test('all modes without controls are explicitly uncovered and require human adoption, never fabricated validation attempts', async t => {
  const h = fixture(t); h.mutate(s => s.controlConfirmations = []); h.sync();
  const f = execution(h), { text } = await invoke(h, f), saved = comparisons(h).read()[0];
  assert.equal(saved.outcome, 'validation-uncovered'); assert.equal(saved.adoptionEligible, true);
  assert.match(text, /未覆盖.*entry-1.*entry-2/); assert.ok(f.executions.every(c => c.stage === 'gate'));
});
test('failed full result publication leaves the journal available for recovery and refuses output-path re-execution', async t => {
  const h = fixture(t), f = execution(h), config = path.join(h.root, 'config.json'), output = path.join(h.root, 'failed.jsonl');
  fs.writeFileSync(config, JSON.stringify(h.config));
  const args = ['--config', config, '--run', '--confirmed', '--expected-plan', f.pinned.summary.planHash, '--output', output], link = fs.linkSync;
  fs.linkSync = (a, b) => { if (path.dirname(b) === path.join(h.scope.globalRoot, 'comparisons')) throw Error('Synthetic disk full'); return link(a, b); };
  try { await assert.rejects(cli(args, f.options), { code: 'wiki_comparison_write_failed' }); } finally { fs.linkSync = link; }
  const bytes = fs.readFileSync(output), events = bytes.toString().trim().split('\n').map(JSON.parse), calls = f.executions.length;
  assert.equal(events.at(-1).event, 'page_execution_failed'); assert.deepEqual(comparisons(h).read(), []);
  await assert.rejects(cli(args, f.options), { code: 'EEXIST' }); assert.equal(f.executions.length, calls); assert.deepEqual(fs.readFileSync(output), bytes);
  assert.equal(comparisons(h).save(events.find(e => e.event === 'batch_summary')).outcome, 'validation-partial-coverage');
});
test('full v4 run controls publish through the existing durable packet and wire proof path', async t => {
  const h = fixture(t); h.run18(); const f = execution(h);
  delete f.options.runProductionRunComparison;
  f.options.knownValues = [];
  f.options.createRunClient = async () => ({ state: () => ({ reason: null }), close: async () => {}, complete: async request => {
    const shape = require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items.find(x => x.case === 22 && x.step === 30);
    return { networkRequests: 1, durationMs: 1, wireRequest: require(base + 'wiki-run-wire').buildWikiRunWireRequest(request),
      message: { role: 'assistant', stopReason: 'toolUse', content: shape.toolCalls.map((c, i) => ({ type: 'toolCall', id: 'fake-' + i, ...c })) } };
  } });
  const saved = comparisons(h).save(await f.run()), control = saved.cases.find(c => c.stage === 'validation');
  assert.equal(control.execution.level, 'run'); assert.equal(control.runs.length, 10); assert.equal(control.runs[0].toolExecutions, 0);
  assert.deepEqual(comparisons(h).read(), [saved]);
});
