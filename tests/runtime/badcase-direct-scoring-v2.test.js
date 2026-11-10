const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto');
const { prepareComparison, runComparison, expectedTreeHash, formatComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const { createWikiRubric } = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric');
const { bindWikiJudge } = require('../../build/server/domain/runtime/badcase-capture/wiki-scoring-v2');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function fixture() {
  const key = 'synthetic-v2-executor-key-not-real', model = 'opencode-go/deepseek-v4.1-flash';
  const rubric = { ...createWikiRubric({ caseId: 'source-case', version: 1, model: 'deepseek/deepseek-v4-flash', actual: 'Unclear', expected: 'Clear result', scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' },
    questions: [{ id: 'q1', question: 'The result is clear.', evidence: 'reply' }, { id: 'q2', question: 'The next step is clear.', evidence: 'reply' }] }),
    status: 'frozen', confirmedAt: '2026-11-04T00:00:00.000Z', confirmationRecord: 'Synthetic approval' };
  const configuration = { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', settings: {}, promptHash: hash('synthetic-not-a-judge-prompt') };
  const scoring = { kind: 'wiki-score-v2', rubric, binding: bindWikiJudge(configuration, rubric), task: 'Explain what is ready and what is next.', expected: 'Clear result' };
  const config = { repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), request: {}, image: { imageId: 'sha256:' + '1'.repeat(64) },
    repeats: 1, candidateRole: 'DO_NOT_SEND_CANDIDATE_RULES', scoring, rules: { kind: 'public-reply-literals-v1', leadChars: 20, conclusionMarkers: ['结论'], forbiddenTerms: [], forbiddenPatterns: ['priority-code'] } };
  const input = { kind: 'prepared-caff-turn-v1', files: [{ path: 'a.txt', base64: Buffer.from('stable').toString('base64'), sha256: hash('stable') }],
    prompt: 'DO_NOT_SEND_ORIGINAL_RUNTIME_PROMPT', sessionText: null, deletions: [] };
  const state = { keys: 0, executions: 0, judgeInputs: [], events: [] };
  const judge = { configuration, async evaluate(value) { state.judgeInputs.push(value); return { judgments: rubric.questions.map(q => ({ criterionId: q.id, verdict: 'satisfied', reason: 'Synthetic assessment', evidence: [{ source: 'reply', text: 'Ready.' }] })) }; } };
  const options = { confirmed: true, judge, readKey: () => { state.keys++; return key; }, knownValues: [],
    prepare: (_request, replacement) => ({ supported: true, input: { ...input, prompt: replacement || input.prompt }, provenance: { caseId: 'case', checkpointId: 'cp', checkpointHash: hash('checkpoint'), commonInputHash: hash('common') } }),
    stage: (_repo, _deps, _image, value) => [{ path: 'probe.cjs', bytes: Buffer.from(JSON.stringify(value)) }, { path: 'runtime/test', bytes: Buffer.from('stable runtime') }],
    execute: async (_image, files) => { state.executions++; const manifest = manifestFor(files); return { code: 0, cleaned: true, containerId: 'a'.repeat(64), isolation: { privileged: false }, receipt: {
      kind: 'direct-caff-turn-v1', inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, success: true,
      beforeHash: expectedTreeHash(input), afterHash: expectedTreeHash(input), toolCalls: [], replySource: 'public', finalText: 'Ready. Next: test P1.',
      modelCalls: [{ model, durationMs: 1, success: true, httpStatus: 200, usage: null }] } }; },
    onEvent: event => state.events.push(event) };
  return { key, config, input, scoring, state, options, judge };
}
test('v2 comparison plans without judge/auth and keeps rubrics/expectations out of both worker inputs', () => {
  const h = fixture(), plan = prepareComparison(h.config, { ...h.options, judge: undefined });
  assert.equal(plan.supported, true); assert.equal(plan.summary.kind, 'sealed-prompt-comparison-v2');
  assert.equal(plan.summary.scoring.rubricHash, h.scoring.rubric.hash); assert.match(plan.summary.scoring.configHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(plan.inputs).includes('Is the result clear?'), false); assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
});
test('actual comparison execution routes v2 receipts to the judge, ignoring literal failure and hiding variant/config', async () => {
  const h = fixture(), r = await runComparison(h.config, h.options);
  assert.equal(r.completed, true); assert.equal(r.totals.original.passed, 1); assert.equal(r.totals.candidate.passed, 1);
  assert.equal(h.state.judgeInputs.length, 6); assert.ok(r.runs.every(row => row.assessment.referenceMetrics.noForbiddenTerms === false));
  const text = JSON.stringify(h.state.judgeInputs); assert.equal(text.includes('DO_NOT_SEND'), false); assert.equal(text.includes('candidate'), false);
  assert.match(formatComparison(r), /硬断言.*AI/); assert.ok(h.state.events.some(e => e.event === 'run' && e.assessment));
});
test('v2 new case has no mandatory legacy keyword rule definition', async () => {
  const h = fixture(); delete h.config.rules;
  const r = await runComparison(h.config, h.options); assert.equal(r.totals.candidate.passed, 1);
  assert.deepEqual(r.runs[0].assessment.referenceMetrics, {});
});
test('missing judge or changed model/prompt bindings refuse execution before keys, staging and model runs', async () => {
  for (const change of [h => delete h.options.judge, h => h.judge.configuration.promptHash = hash('changed'), h => h.judge.configuration.model = 'other-model']) {
    const h = fixture(); change(h);
    await assert.rejects(runComparison(h.config, h.options), /wiki_(judge_adapter_required|judge_binding_changed)/);
    assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
  }
});
test('unconfirmed rubric or malformed binding refuses even planning before any execution', () => {
  const h = fixture(), { confirmedAt, confirmationRecord, ...draft } = h.scoring.rubric;
  h.config.scoring.rubric = { ...draft, status: 'draft' };
  assert.throws(() => prepareComparison(h.config, h.options), /wiki_rubric_confirmation_required/);
  const other = fixture(); other.scoring.binding.promptHash = 'invalid';
  assert.throws(() => prepareComparison(other.config, other.options)); assert.equal(other.state.keys, 0);
});
test('insufficient evidence fails the assertion, continues the comparison and never replays a worker', async () => {
  const h = fixture();
  h.judge.evaluate = async () => ({ judgments: h.scoring.rubric.questions.map(q => ({ criterionId: q.id, verdict: 'not-satisfied', reason: 'Insufficient evidence', evidence: [] })) });
  const r = await runComparison(h.config, h.options); assert.equal(r.completed, true); assert.equal(h.state.executions, 2);
  assert.ok(r.runs.every(row => row.status === 'fail' && row.reason === 'rubric_not_satisfied'));
});
test('technical judge errors retry only the saved reply, continue remaining planned slots, and never buy replacement answers', async () => {
  for (const fault of ['backend', 'parse']) for (const persistent of [false, true]) {
    const h = fixture(); h.config.repeats = 2;
    const evaluate = h.judge.evaluate, seen = []; let calls = 0;
    h.judge.evaluate = async input => {
      seen.push(structuredClone(input)); const call = ++calls;
      // Only the first reply fails; later slots must still be executed/scored.
      if (call === 1 || persistent && call === 2) { if (fault === 'backend') throw Error('private backend fault'); return 'not-json'; }
      return evaluate(input);
    };
    const r = await runComparison(h.config, h.options);
    assert.equal(h.state.executions, 4, JSON.stringify({ fault, persistent }));
    assert.equal(r.runs.length, 4); assert.equal(r.runs[0].status, persistent ? 'error' : 'pass');
    assert.ok(r.runs.slice(1).every(row => row.status === 'pass'));
    assert.equal(calls, persistent ? 11 : 13); assert.deepEqual(seen[0], seen[1]);
    assert.equal(r.totals.original.errors, persistent ? 1 : 0); assert.equal(r.totals.candidate.errors, 0);
    assert.equal(r.completed, !persistent);
    const totals = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-totals').wikiComparisonTotals([{ runs: r.runs }], 2);
    assert.equal(totals.original.scored, persistent ? 1 : 2); assert.equal(totals.candidate.scored, 2);
    assert.equal(JSON.stringify(r).includes('private backend fault'), false);
  }
});
test('reply-only self-claims cannot satisfy trace assertions; source errors stay technical and do not replay workers', async () => {
  const h = fixture(); h.config.repeats = 2;
  const rubric = { ...createWikiRubric({ ...h.scoring.rubric, actual: 'Unclear', expected: 'Clear result',
    questions: h.scoring.rubric.questions.map(q => ({ ...q, evidence: q.id === 'q1' ? 'trace' : 'reply' })) }),
    status: 'frozen', confirmedAt: h.scoring.rubric.confirmedAt, confirmationRecord: h.scoring.rubric.confirmationRecord };
  h.scoring.rubric = rubric; h.scoring.binding = bindWikiJudge(h.judge.configuration, rubric);
  // The existing mock returns only reply citations even though trace is provided.
  const result = await runComparison(h.config, h.options);
  assert.equal(h.state.executions, 4); assert.equal(h.state.judgeInputs.length, 8); assert.equal(result.completed, false);
  assert(result.runs.every(r => r.status === 'error' && r.reason === 'judge_output_invalid'));
  assert.equal(result.totals.original.errors, 2); assert.equal(result.totals.candidate.errors, 2);
  const totals = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-totals').wikiComparisonTotals([{ runs: result.runs }], 2);
  assert.equal(totals.original.scored, 0); assert.equal(totals.candidate.scored, 0);
  for (let i = 0; i < 8; i += 2) assert.deepEqual(h.state.judgeInputs[i], h.state.judgeInputs[i + 1]);
});
test('missing required evidence still stops for investigation; only judge technical faults are nonfatal', async () => {
  const h = fixture();
  h.config.rules = { kind: 'file-literals-v1', files: [{ path: 'a.txt', contains: ['active'], notContains: [] }] };
  const r = await runComparison(h.config, h.options);
  assert.equal(h.state.executions, 1); assert.equal(r.completed, false);
  assert.equal(r.runs[0].reason, 'hard_evidence_missing'); assert.equal(h.state.judgeInputs.length, 0);
});
test('hard file failure remains fail without any judge call in the main executor', async () => {
  const h = fixture(); h.config.rules = { kind: 'file-literals-v1', files: [{ path: 'a.txt', contains: ['active'], notContains: [] }] };
  const execute = h.options.execute; h.options.execute = async (...args) => { const r = await execute(...args); r.receipt.fileEvidence = [{ path: 'a.txt', state: 'file', size: 4, base64: Buffer.from('idle').toString('base64'), sha256: hash('idle') }]; return r; };
  const r = await runComparison(h.config, h.options); assert.equal(r.runs[0].status, 'fail'); assert.equal(h.state.judgeInputs.length, 0);
});
test('rubric/task context is scanned for known keys before an executor or judge can receive it', async () => {
  const h = fixture(); h.scoring.task += ' ' + h.key;
  await assert.rejects(runComparison(h.config, h.options), /evaluation_input_contains_key/);
  assert.equal(h.state.executions, 0); assert.equal(h.state.judgeInputs.length, 0);
  assert.equal(JSON.stringify(h.state.events).includes(h.key), false);
});
test('judge output is scanned for executor key before any result/event can disclose it', async () => {
  const h = fixture(), evaluate = h.judge.evaluate; h.judge.evaluate = async input => { const r = await evaluate(input); r.judgments[0].reason = h.key; return r; };
  await assert.rejects(runComparison(h.config, h.options), /evaluation_output_contains_key/);
  assert.equal(JSON.stringify(h.state.events).includes(h.key), false);
});

function toolFixture({ only = false, reasons = ['valid'], native = false } = {}) {
  const h = fixture(), old = h.scoring.rubric;
  h.scoring.rubric = { ...createWikiRubric({ ...old, actual: 'Unclear', expected: 'Clear result',
    ...(only ? { questions: [], scoringModel: null } : {}), toolCheck: { method: 'code', target: { kind: native ? 'native' : 'caff-chat', name: native ? 'read' : 'suggest-goal' }, mode: 'on-call',
      rules: [{ parameter: native ? 'path' : 'reason', kind: 'max-chars', max: native ? 4 : 1000 }] } }), status: 'frozen', confirmedAt: old.confirmedAt, confirmationRecord: old.confirmationRecord };
  h.scoring.binding = only ? null : bindWikiJudge(h.judge.configuration, h.scoring.rubric);
  const executionId = crypto.randomUUID();
  h.goalEvidence = { kind: 'evaluation-goal-evidence-v1', executionId, goalState: 'unseeded', seed: null, seedHash: hash('null'),
    calls: reasons.map((reason, i) => ({ executionId, sequence: i + 1, endpoint: 'goal/suggest', parameters: { action: 'pause', reason },
      statusCode: reason.length > 1000 ? 400 : 200, errorCode: null, response: reason.length > 1000 ? { error: 'Goal proposal reason must be 1000 characters or fewer' } : { ok: true } })) };
  const execute = h.options.execute;
  h.options.execute = async (...args) => { const r = await execute(...args); r.receipt.goalEvidence = structuredClone(h.goalEvidence);
    if (native) r.receipt.toolCalls = [{ name: 'read', args: { path: 'safe' }, isError: false }]; return r; };
  if (only) delete h.options.judge;
  return h;
}
test('trace tool-only planning and execution require no judge and readable summary handles null binding', async () => {
  const h = toolFixture({ only: true });
  const plan = prepareComparison(h.config, h.options); assert.equal(plan.summary.scoring.binding, null);
  const r = await runComparison(h.config, h.options); assert.equal(r.completed, true); assert.equal(h.state.judgeInputs.length, 0);
  assert.equal(r.runs.length, 2); assert(r.runs.every(row => row.status === 'pass' && row.assessment.tool.status === 'pass'));
  assert.match(formatComparison(r), /代码工具检查/); assert.equal(r.totals.original.invalid, 0);
});
test('main trace executor judges records first and never calls a judge to rescue an overlong refusal', async () => {
  const h = toolFixture({ reasons: ['x'.repeat(1001), 'valid retry'] });
  const r = await runComparison(h.config, h.options);
  assert.equal(h.state.judgeInputs.length, 0); assert(r.runs.every(row => row.status === 'fail' && row.reason === 'tool_rule_failed'));
  assert.equal(r.totals.original.failed, 1); assert.equal(r.totals.candidate.failed, 1);
  for (const row of r.runs) assert.deepEqual(row.goalEvidence, h.goalEvidence);
});
test('trace no-check-reached stays invalid through executor events/totals and cannot complete a valid repeat', async () => {
  const h = toolFixture({ only: true, reasons: [] });
  const r = await runComparison(h.config, h.options);
  assert.equal(r.completed, false); assert(r.runs.every(row => row.status === 'invalid' && row.reason === 'no_check_reached'));
  assert.equal(r.totals.original.invalid, 1); assert.equal(r.totals.original.passed + r.totals.original.failed, 0);
  assert.equal(h.state.judgeInputs.length, 0); assert(h.state.events.filter(e => e.event === 'run').every(e => e.status === 'invalid'));
});
test('historical co-frozen toolCheck without new trace assessments does not gain invalid counters', () => {
  const { wikiComparisonTotals } = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-totals');
  const runs = [{ variant: 'original', status: 'pass' }, { variant: 'candidate', status: 'fail' }];
  assert.deepEqual(wikiComparisonTotals([{ rubric: { toolCheck: { method: 'code' } }, runs }], 1), wikiComparisonTotals([{ runs }], 1));
  assert.equal(Object.hasOwn(wikiComparisonTotals([{ runs }], 1).original, 'invalid'), false);
});
test('native structured args reach main trace scoring and mixed rules still use the original three-vote protocol', async () => {
  const h = toolFixture({ native: true });
  const r = await runComparison(h.config, h.options);
  assert.equal(r.completed, true); assert.equal(h.state.judgeInputs.length, 6); assert(r.runs.every(row => row.assessment.tool.status === 'pass'));
  assert(h.state.judgeInputs.every(v => !JSON.stringify(v).includes('goalEvidence')));
});

test('approximate Goal evidence survives host scoring, rows/events, JSON export and readable report, without entering judge input', async () => {
  const h = fixture(), executionId = crypto.randomUUID(), seed = { goalId: 'goal_' + crypto.randomUUID(), revision: 1, status: 'active', owner: { agentId: 'role-family-gpt' }, acceptanceCriteria: [{ status: 'pending' }], workItems: [{ status: 'todo' }], evidence: [] };
  const goalEvidence = { kind: 'evaluation-goal-evidence-v1', executionId, goalState: 'approximate-minimal-v1', seed, seedHash: hash(JSON.stringify(seed)), calls: [
    { executionId, sequence: 1, endpoint: 'goal/suggest', parameters: { action: 'pause', reason: 'x'.repeat(1001) }, statusCode: 400, errorCode: null, response: { error: 'reason must be at most 1000 characters' } }] };
  const execute = h.options.execute; h.options.execute = async (...args) => { const result = await execute(...args); result.receipt.goalEvidence = structuredClone(goalEvidence); return result; };
  const result = await runComparison(h.config, h.options);
  for (const row of result.runs) {
    assert.deepEqual(row.goalEvidence, goalEvidence); assert.equal(row.goalState, 'approximate-minimal-v1'); assert.equal(row.goalSeedHash, goalEvidence.seedHash); assert.equal(row.goalExecutionId, executionId);
    assert.equal(row.assessment.referenceMetrics.goalState, 'approximate-minimal-v1'); assert.equal(row.assessment.referenceMetrics.goalSeedHash, goalEvidence.seedHash);
  }
  assert(h.state.events.filter(e => e.event === 'run').every(e => e.goalState === 'approximate-minimal-v1'));
  assert.equal(JSON.stringify(h.state.judgeInputs).includes('approximate-minimal'), false);
  assert.match(formatComparison(result), /Goal 状态近似/);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).runs[0].goalEvidence, goalEvidence);
});
