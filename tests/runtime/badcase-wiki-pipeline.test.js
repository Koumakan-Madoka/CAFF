const test = require('node:test'), assert = require('node:assert/strict');
const { projectWikiPipelineStates, inspectWikiPipelineInputs } = require('../../build/server/domain/runtime/badcase-capture/wiki-pipeline');
const { createWikiRubric } = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric');
const { wikiRunHash } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-replay');
const H = c => c.repeat(64);
function fixture() {
  const c = { id: 'case-1', actual: 'too much jargon', expected: 'plain conclusion', split: 'gate', source: { projectId: null, conversationId: 'room', messageId: 'message', agentId: 'role-family-gpt' }, sealedCheckpointId: 'cp', traceBundle: { hash: H('a') } };
  const rubric = { ...createWikiRubric({ caseId: c.id, actual: c.actual, expected: c.expected, model: 'deepseek/deepseek-v4-flash', version: 1, questions: [{ id: 'q1', question: 'The reply opens with a plain conclusion.', evidence: 'reply' }], scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' } }), status: 'frozen', confirmedAt: '2026-11-06T00:00:00.000Z', confirmationRecord: 'synthetic consent' };
  const replay = { id: 'replay-1', sourceCaseId: c.id, checkpointHash: H('b'), request: { association: { checkpointId: 'cp' } } };
  const state = { cases: [c], rubrics: [rubric], replayCases: [replay], versions: [], dehydrations: [] };
  const comparison = { id: 'comparison-1', createdAt: '2026-11-06T01:00:00.000Z', kind: 'wiki-staged-batch-comparison-v2', model: 'openai-codex/gpt-6.1-sol', cases: [{ sourceCaseId: c.id, replayId: replay.id, comparison: { checkpointHash: replay.checkpointHash }, rubric, runs: [{ variant: 'original', status: 'fail' }, { variant: 'original', status: 'pass' }, { variant: 'original', status: 'error' }, { variant: 'candidate', status: 'fail' }] }] };
  const checks = [{ caseId: c.id, level: 'trace', status: 'supported', checkpointHash: replay.checkpointHash }];
  return { c, rubric, replay, state, comparison, checks };
}
const project = (h, extra = {}) => projectWikiPipelineStates({ state: h.state, comparisons: [h.comparison], replayChecks: h.checks, ...extra })[0];
test('pipeline projects frozen assertions, real replay support and one independently pinned original batch without mutation', () => {
  const h = fixture(), before = JSON.stringify(h), row = project(h);
  assert.equal(row.assertion.status, 'frozen'); assert.equal(row.assertion.version, 1); assert.equal(row.assertion.model, 'deepseek/deepseek-v4-flash');
  assert.deepEqual(row.assertion.questions, h.rubric.questions); assert.equal(row.replay.status, 'supported');
  assert.equal(row.original.valid, 2); assert.equal(row.original.pass, 1); assert.equal(row.original.fail, 1); assert.equal(row.original.errors, 1);
  assert.equal(row.original.reproduced, true); assert.equal(row.original.comparisonId, h.comparison.id); assert.equal(row.inLibrary, true);
  assert.equal(JSON.stringify(h), before);
});
test('new draft does not erase frozen version; draft-only, changed source and all-pass original do not claim reproduced/library', () => {
  const h = fixture(); h.state.rubrics.push({ ...h.rubric, version: 2, status: 'draft' });
  assert.equal(project(h).assertion.version, 1); assert.equal(project(h).assertion.draftVersion, 2);
  h.comparison.cases[0].runs = [{ variant: 'original', status: 'pass' }]; assert.equal(project(h).original.reproduced, false); assert.equal(project(h).inLibrary, false);
  h.state.rubrics = [{ ...h.rubric, status: 'draft' }]; assert.equal(project(h).assertion.status, 'missing'); assert.equal(project(h).original.valid, 0);
  h.state.rubrics = [h.rubric]; h.c.expected = 'changed expectation'; assert.equal(project(h).assertion.status, 'stale'); assert.equal(project(h).inLibrary, false);
});
test('legacy literal, proxy, interrupted, foreign scene and foreign rubric records never become v2 reproduction evidence', () => {
  for (const mutate of [
    h => h.comparison.kind = 'wiki-staged-batch-comparison-v1',
    h => h.comparison.model = 'deepseek/deepseek-v4-flash',
    h => h.comparison.cases[0].reason = 'operator_interrupted',
    h => h.comparison.cases[0].comparison.checkpointHash = H('c'),
    h => h.comparison.cases[0].rubric = { ...h.rubric, hash: H('d') },
  ]) { const h = fixture(); mutate(h); const row = project(h); assert.equal(row.original.valid, 0); assert.equal(row.inLibrary, false); }
});
test('a newer technical-error-only batch is shown as errors, not replaced by an older passing batch or raw unscored replies', () => {
  const h = fixture(), newer = structuredClone(h.comparison); newer.id = 'comparison-errors'; newer.createdAt = '2026-11-06T03:00:00.000Z'; newer.cases[0].runs = [{ variant: 'original', status: 'error' }];
  const row = project(h, { comparisons: [h.comparison, newer] }); assert.equal(row.original.valid, 0); assert.equal(row.original.errors, 1); assert.equal(row.original.comparisonId, newer.id); assert.equal(row.inLibrary, false);
});
test('latest matching original batch is reported alone, never pooled with older batches', () => {
  const h = fixture(), newer = structuredClone(h.comparison); newer.id = 'comparison-2'; newer.createdAt = '2026-11-06T02:00:00.000Z'; newer.cases[0].runs = [{ variant: 'original', status: 'fail' }];
  const row = project(h, { comparisons: [h.comparison, newer] }); assert.equal(row.original.valid, 1); assert.equal(row.original.comparisonId, 'comparison-2');
});
function runFixture() {
  const h = fixture(); delete h.c.sealedCheckpointId; h.state.replayCases = [];
  const d = { caseId: h.c.id, traceHash: h.c.traceBundle.hash, kind: 'single', level: 'run', cutStep: 1 }; d.hash = wikiRunHash(d);
  h.state.dehydrations = [{ caseId: h.c.id, traceHash: h.c.traceBundle.hash, decision: d }];
  h.checks = [{ caseId: h.c.id, level: 'run', status: 'supported', traceHash: h.c.traceBundle.hash, decisionHash: d.hash, cutStep: 1 }];
  const run = { caseId: h.c.id, traceHash: h.c.traceBundle.hash, decisionHash: d.hash, status: 'reached', baselineStatus: 'valid_output', variant: { kind: 'original' } };
  h.comparison.cases[0].execution = { level: 'run', traceBundleHash: run.traceHash, dehydrationHash: run.decisionHash };
  return { ...h, d, run };
}
test('run original raw outputs are unscored, candidate-only/error/reserved records do not create invalid baselines', () => {
  const h = runFixture(), row = project(h, { comparisons: [], runReplays: [h.run, { ...h.run, status: 'invalid' }, { ...h.run, status: 'error' }] });
  assert.equal(row.original.unscored, 1); assert.equal(row.original.invalid, 1); assert.equal(row.original.errors, 1); assert.equal(row.original.valid, 0); assert.equal(row.inLibrary, false);
  for (const rows of [[{ ...h.run, variant: { kind: 'candidate' }, status: 'invalid' }], [{ ...h.run, status: 'error' }], [{ ...h.run, status: 'reserved' }]]) assert.notEqual(project(h, { comparisons: [], runReplays: rows }).stopReason, 'invalid_baseline');
  assert.equal(project(h, { comparisons: [], runReplays: [{ ...h.run, status: 'invalid', baselineStatus: 'no_valid_output' }] }).stopReason, 'invalid_baseline');
  assert.equal(project(h, { runReplays: [h.run] }).inLibrary, true);
  h.comparison.cases[0].runs = [{ variant: 'original', status: 'error' }];
  const technical = project(h, { runReplays: [h.run] }); assert.equal(technical.original.valid, 0); assert.equal(technical.original.outputs, 1); assert.equal(technical.original.errors, 1);
  h.comparison.cases[0].execution.dehydrationHash = H('e'); assert.equal(project(h, { runReplays: [h.run] }).original.valid, 0);
});
test('run trace/files assertions are explicitly incompatible; neither raw output nor old rubric scoring can enter library', () => {
  for (const evidence of ['trace', 'files']) {
    const h = runFixture(); h.rubric.questions[0].evidence = evidence;
    const row = project(h, { runReplays: [h.run] }); assert.equal(row.assertion.status, 'incompatible'); assert.equal(row.inLibrary, false); assert.equal(row.original.valid, 0);
  }
});
test('preflight identity must match frozen scene/prefix; missing, unsupported and broken checks are not success', () => {
  const h = fixture(); assert.equal(project(h, { replayChecks: [] }).replay.status, 'pending');
  h.checks[0].checkpointHash = H('e'); assert.equal(project(h).replay.status, 'pending');
  h.checks[0] = { caseId: h.c.id, level: 'trace', status: 'unsupported', reason: 'replay_materials_invalid' }; assert.equal(project(h).replay.status, 'unsupported');
  const r = runFixture(); r.checks[0].decisionHash = H('f'); assert.equal(project(r).replay.status, 'pending');
});
test('page preflight resolves the local archive and returns only support/hash, never raw files or private diagnostics', () => {
  const { inspectPageReplay } = require('../../scripts/badcase-capture/wiki-page-runtime.cjs'), h = fixture();
  const scope = { globalRoot: 'synthetic-local-root' }, request = { local: true }; let resolved = 0, prepared = 0;
  const deps = { resolve: (got, input) => { assert.equal(got, scope); assert.equal(input, h.replay.request); resolved++; return request; },
    prepare: got => { assert.equal(got, request); prepared++; return { supported: true, provenance: { checkpointHash: h.replay.checkpointHash }, input: { prompt: 'PRIVATE RAW PROMPT', files: ['PRIVATE FILE'] } }; } };
  assert.deepEqual(inspectPageReplay({ replay: h.replay, scope }, deps), { supported: true, checkpointHash: h.replay.checkpointHash });
  assert.equal(resolved, 1); assert.equal(prepared, 1);
  assert.deepEqual(inspectPageReplay({ replay: h.replay, scope }, { ...deps, prepare: () => { throw Error('PRIVATE PATH'); } }), { supported: false, reason: 'replay_check_failed' });
  assert.deepEqual(inspectPageReplay({ replay: h.replay, scope }, { ...deps, prepare: () => ({ supported: true, provenance: { checkpointHash: H('e') } }) }), { supported: false, reason: 'replay_check_failed' });
});
test('trace preflight only accepts supported with the exact checkpoint hash, errors stay fixed-code and read-only', () => {
  const h = fixture(), before = JSON.stringify(h); let calls = 0;
  const inspect = result => inspectWikiPipelineInputs(h.state, { readTrace: () => { throw Error('not a run'); }, inspectReplay: replay => { calls++; assert.equal(replay, h.replay); return result; } });
  assert.equal(inspect({ supported: true, checkpointHash: h.replay.checkpointHash })[0].status, 'supported');
  assert.equal(inspect({ supported: true, checkpointHash: H('e') })[0].status, 'unsupported');
  assert.equal(inspectWikiPipelineInputs(h.state, {})[0].status, 'pending');
  const failed = inspectWikiPipelineInputs(h.state, { inspectReplay: () => { throw Error('private-path-and-key'); } })[0];
  assert.equal(failed.status, 'unsupported'); assert.doesNotMatch(JSON.stringify(failed), /private-path-and-key/);
  assert.equal(calls, 2); assert.equal(JSON.stringify(h), before);
});
test('run prefix check uses the actual frozen builder, not a reply/step count or invented tools', () => {
  const good = runFixture();
  const bundle = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', source: good.c.source, markedStep: 1, context: { systemPrompt: 'frozen system text', priorSessionEntries: [], trigger: { message: { role: 'user', content: 'frozen task' } } }, steps: [{ step: 1, output: { role: 'assistant', content: [{ type: 'text', text: 'cut output excluded' }] } }] };
  good.c.traceBundle.hash = wikiRunHash(bundle); good.d.traceHash = good.c.traceBundle.hash;
  const { hash: old, ...value } = good.d; good.d.hash = wikiRunHash(value); good.state.dehydrations[0].traceHash = good.c.traceBundle.hash;
  const before = JSON.stringify({ state: good.state, bundle });
  const valid = inspectWikiPipelineInputs(good.state, { readTrace: () => bundle }); assert.equal(valid[0].status, 'supported'); assert.equal(valid[0].traceHash, good.c.traceBundle.hash); assert.equal(valid[0].decisionHash, good.d.hash);
  assert.equal(JSON.stringify({ state: good.state, bundle }), before); assert.doesNotMatch(JSON.stringify(valid), /frozen task|frozen system text|cut output excluded/);
  const h = runFixture(); const checks = inspectWikiPipelineInputs(h.state, { readTrace: () => ({ kind: 'wikiskill-trace-bundle', steps: [] }) });
  assert.equal(checks[0].status, 'unsupported'); assert.equal(checks[0].level, 'run');
  h.state.dehydrations[0].decision.hash = H('f');
  assert.equal(inspectWikiPipelineInputs(h.state, { readTrace: () => { throw Error('should reject before read'); } })[0].reason, 'wiki_run_decision_invalid');
});
test('unassigned, non-GPT, legacy sources and reference-only do not enter library; scene always wins over stale run decision', () => {
  const h = fixture(); h.c.split = null; assert.equal(project(h).inLibrary, false);
  h.c.split = 'gate'; h.c.source.agentId = 'role-family-deepseek'; assert.equal(project(h).stopReason, 'report_only'); assert.equal(project(h).inLibrary, false);
  const r = runFixture(); r.state.dehydrations[0].decision.level = 'reference'; assert.equal(project(r).stopReason, 'reference_only');
  const scene = runFixture(); scene.c.sealedCheckpointId = 'cp'; assert.equal(project(scene).level, 'trace');
});
