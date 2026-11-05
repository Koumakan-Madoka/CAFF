const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
// Lazy imports let the initial red run enumerate every missing contract.
const api = () => require(base + 'wiki-scoring-v2');
function setup(evidence = 'reply', backend = 'deepseek') {
  const { createWikiRubric } = require(base + 'wiki-rubric');
  const scoringModel = { backend, model: backend === 'deepseek' ? 'deepseek/deepseek-v4-flash' : 'jev-latest' };
  const rubric = { ...createWikiRubric({ caseId: 'case-1', version: 1, model: 'deepseek/deepseek-v4-flash', scoringModel,
    actual: 'Unclear', expected: 'Clear result', questions: [
      { id: 'q1', question: 'The result is clear.', evidence }, { id: 'q2', question: 'The next step is clear.', evidence: 'reply' },
    ] }), status: 'frozen', confirmedAt: '2026-11-04T00:00:00.000Z', confirmationRecord: 'Synthetic user confirmation' };
  const configuration = { backend, model: backend === 'deepseek' ? 'deepseek/deepseek-v4-flash' : 'jev-latest', settings: { temperature: 0 }, promptHash: digest('synthetic-placeholder-not-a-judge-prompt') };
  const binding = api().bindWikiJudge(configuration, rubric);
  const run = { completed: true, replySource: 'public', publicReply: 'The fix is ready. Next: run the tests.', task: 'What is ready and what is next?', expected: 'Clear result' };
  const output = (verdict = 'satisfied', quote = 'The fix is ready.') => ({ judgments: rubric.questions.map(q => ({ criterionId: q.id, verdict, reason: 'Synthetic assessment',
    evidence: quote === null ? [] : [{ source: 'reply', text: quote }] })) });
  let calls = 0;
  const judge = { configuration, async evaluate(input) { calls++; return output(); } };
  const score = (patch = {}, adapter = judge) => api().scoreWikiRun({ rubric, binding, run, hardAssertions: [], referenceMetrics: {}, ...patch }, adapter);
  return { rubric, configuration, binding, run, output, judge, score, calls: () => calls };
}
test('AC1: a failed hard assertion cannot be rescued by a satisfied judge', async () => {
  const h = setup(), r = await h.score({ hardAssertions: [{ id: 'unchanged-files', status: 'fail' }] });
  assert.equal(r.status, 'fail'); assert.equal(h.calls(), 0); assert.equal(r.judgments.length, 0);
});
test('AC1: insufficient evidence is not-satisfied and stays in the failed denominator, never a third verdict', async () => {
  const h = setup(); let i = 0;
  h.judge.evaluate = async () => ++i < 3 ? h.output('not-satisfied', null) : h.output();
  const r = await h.score(); assert.equal(r.status, 'fail'); assert.equal(r.reason, 'rubric_not_satisfied');
  assert.equal(r.judgments[0].verdict, 'not-satisfied'); assert.equal(r.votes.length, 3);
  assert.ok(r.judgments.every(j => j.majority && ['satisfied', 'not-satisfied'].includes(j.verdict)));
  const { wikiComparisonTotals } = require(base + 'wiki-comparison-totals');
  const totals = wikiComparisonTotals([{ runs: [{ variant: 'original', ...r }] }], 1);
  assert.equal(totals.original.scored, 1); assert.equal(totals.original.failed, 1);
});
test('AC1: judge input is allowlisted, excludes version/candidate/other-run data and unnecessary evidence', async () => {
  const h = setup(), run = { ...h.run, variant: 'candidate', candidateGuideline: 'PRIVATE CANDIDATE', otherResults: ['old-result'],
    traceSummary: 'unneeded secret context', files: [{ path: 'unneeded.txt', content: 'not requested' }] };
  const input = api().buildWikiJudgeInput(run, h.rubric);
  assert.deepEqual(Object.keys(input).sort(), ['expected', 'publicReply', 'questions', 'task']);
  assert.deepEqual(input.questions, h.rubric.questions); assert.equal(JSON.stringify(input).includes('PRIVATE CANDIDATE'), false);
  const seen = [];
  h.judge.evaluate = async input => { seen.push(structuredClone(input)); input.task = 'mutated'; return h.output(); };
  assert.equal((await h.score({ run })).status, 'pass');
  assert.equal(seen.length, 3); assert.ok(seen.every(x => x.task === h.run.task));
});
test('AC1: model, settings, prompt and rubric hash drift each refuse scoring before calling a backend', async () => {
  for (const field of ['model', 'settings', 'promptHash', 'rubric']) {
    const h = setup();
    if (field === 'rubric') h.rubric.questions[0].question = 'Changed question';
    else h.configuration[field] = field === 'settings' ? { temperature: 1 } : field === 'promptHash' ? digest('changed') : 'other-model';
    await assert.rejects(h.score(), /wiki_(judge_binding_changed|rubric_hash_changed)/); assert.equal(h.calls(), 0);
  }
});
test('a new valid rubric version still requires a new plan binding, rather than just a self-consistent hash', async () => {
  const h = setup(), { createWikiRubric } = require(base + 'wiki-rubric');
  const next = { ...createWikiRubric({ caseId: h.rubric.caseId, version: 2, model: 'deepseek/deepseek-v4-flash', actual: 'Unclear',
    expected: 'Clear result', questions: h.rubric.questions, scoringModel: h.rubric.scoringModel }), status: 'frozen', confirmedAt: h.rubric.confirmedAt, confirmationRecord: 'User confirmed v2' };
  await assert.rejects(h.score({ rubric: next }), /wiki_judge_binding_changed/); assert.equal(h.calls(), 0);
});
test('hard completion/public reply checks and explicit unavailable evidence short-circuit without judge calls', async () => {
  for (const [patch, status] of [
    [{ run: { completed: false, replySource: 'public', publicReply: 'text' } }, 'fail'],
    [{ run: { completed: true, replySource: 'none', publicReply: '' } }, 'fail'],
    [{ run: { completed: true, replySource: 'internal', publicReply: 'Internal only' } }, 'fail'],
    [{ run: { completed: true } }, 'error'],
    [{ run: { environmentError: true } }, 'error'],
    [{ hardAssertions: [{ id: 'file-evidence', status: 'error' }] }, 'error'],
  ]) {
    const h = setup(); assert.equal((await h.score(patch)).status, status); assert.equal(h.calls(), 0);
  }
});
test('literal metrics are reference-only, and DeepSeek/JEV share the same typed evaluation contract', async () => {
  for (const backend of ['deepseek', 'jev']) {
    const h = setup('reply', backend), r = await h.score({ referenceMetrics: { conclusionInLead: false, priorityCode: true } });
    assert.equal(r.status, 'pass'); assert.equal(h.calls(), 3); assert.equal(r.referenceMetrics.priorityCode, true);
    assert.equal(r.binding.backend, backend); assert.equal(r.rubricHash, h.rubric.hash);
  }
});
test('three binary votes have an independent majority for every assertion; any rejection fails the reply', async () => {
  const h = setup(); let i = 0;
  h.judge.evaluate = async () => {
    const row = h.output();
    row.judgments[0] = h.output(i < 2 ? 'satisfied' : 'not-satisfied').judgments[0];
    row.judgments[1] = h.output(i++ < 2 ? 'not-satisfied' : 'satisfied').judgments[1];
    return row;
  };
  const r = await h.score(); assert.equal(r.status, 'fail');
  assert.deepEqual(r.judgments.map(j => [j.verdict, j.majority]), [['satisfied', true], ['not-satisfied', true]]);
});
test('a third verdict is invalid output, retried once, never persisted as an assertion judgment', async () => {
  const h = setup(); let calls = 0;
  h.judge.evaluate = async () => { calls++; return h.output('undetermined', null); };
  const r = await h.score(); assert.equal(r.status, 'error'); assert.equal(r.reason, 'judge_output_invalid');
  assert.equal(calls, 2); assert.deepEqual(r.votes, []); assert.deepEqual(r.judgments, []);
});
test('invalid JSON/schema/quotes retry once per vote; persistent failure or backend fault is error', async () => {
  const h = setup(); let calls = 0;
  h.judge.evaluate = async () => ++calls % 2 ? 'not-json' : JSON.stringify(h.output());
  assert.equal((await h.score()).status, 'pass'); assert.equal(calls, 6);
  for (const bad of ['{bad', { judgments: [] }, { ...h.output(), extra: 'must not be accepted' }, h.output('satisfied', 'fabricated quote'), h.output('satisfied', null)]) {
    calls = 0; h.judge.evaluate = async () => { calls++; return bad; };
    assert.equal((await h.score()).status, 'error'); assert.equal(calls, 2);
  }
  calls = 0; h.judge.evaluate = async () => { calls++; throw Error('private backend details'); };
  const r = await h.score(); assert.equal(r.status, 'error'); assert.equal(calls, 2);
  assert.equal(r.reason, 'judge_backend_failed'); assert.equal(JSON.stringify(r).includes('private backend details'), false);
});
test('transient backend faults retry the same frozen input, preserving earlier votes and never replaying the worker', async () => {
  for (const failedCall of [1, 2, 3]) {
    const h = setup(), seen = []; let calls = 0;
    h.judge.evaluate = async input => {
      seen.push(structuredClone(input)); input.publicReply = 'mutated';
      if (++calls === failedCall) throw Error('private backend details');
      return h.output();
    };
    const r = await h.score(); assert.equal(r.status, 'pass'); assert.equal(calls, 4); assert.equal(r.votes.length, 3);
    assert.ok(seen.every(input => JSON.stringify(input) === JSON.stringify(api().buildWikiJudgeInput(h.run, h.rubric))));
  }
});
test('one retry budget per vote covers both backend and parse faults, not two independent budgets', async () => {
  for (const backendFirst of [true, false]) {
    const h = setup(); let calls = 0;
    h.judge.evaluate = async () => { if ((++calls === 1) === backendFirst) throw Error('backend'); return 'not-json'; };
    const r = await h.score(); assert.equal(calls, 2); assert.equal(r.status, 'error');
    assert.equal(r.reason, backendFirst ? 'judge_output_invalid' : 'judge_backend_failed');
  }
});
test('binding mutation during a successful or failed asynchronous vote is fatal, never retried', async () => {
  for (const reject of [true, false]) {
    const h = setup(); let calls = 0;
    h.judge.evaluate = async () => { calls++; h.configuration.promptHash = digest('changed'); if (reject) throw Error('backend'); return h.output(); };
    await assert.rejects(h.score(), /wiki_judge_binding_changed/); assert.equal(calls, 1);
  }
});
test('only requested evidence is attached; UTF-8 byte caps and truncation flags are explicit', async () => {
  const h = setup('files'), run = { ...h.run, traceSummary: 'unneeded', files: Array.from({ length: 6 }, (_, i) => ({ path: `src/f${i}.txt`, content: '字'.repeat(30000) })) };
  const input = api().buildWikiJudgeInput(run, h.rubric);
  assert.equal(input.evidence.traceSummary, undefined); assert.equal(input.evidence.files.length, 6);
  assert.ok(input.evidence.files.every(f => Buffer.byteLength(f.content) <= 65536 && f.truncated && !f.content.includes('\ufffd')));
  assert.ok(input.evidence.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) <= 262144);
  const trace = setup('trace'), ti = api().buildWikiJudgeInput({ ...trace.run, traceSummary: 'a'.repeat(70000) }, trace.rubric);
  assert.equal(ti.evidence.traceSummary.truncated, true);
  assert.equal((await h.score()).status, 'error'); assert.equal(h.calls(), 0);
});
test('immutable scoring projection agrees with binary outcomes, early failures and partial votes', async () => {
  const { projectWikiAssessment } = require(base + 'wiki-comparison-scoring');
  for (const scenario of ['pass', 'hard-fail', 'missing', 'environment', 'insufficient', 'reject', 'invalid-verdict', 'bad-json', 'late-backend', 'missing-trace']) {
    const h = setup(scenario === 'missing-trace' ? 'trace' : 'reply'); let n = 0, patch = {};
    if (scenario === 'hard-fail') patch = { hardAssertions: [{ id: 'files', status: 'fail' }] };
    if (scenario === 'missing') patch = { hardAssertions: [{ id: 'files', status: 'error' }] };
    if (scenario === 'environment') patch = { run: { environmentError: true } };
    if (scenario === 'insufficient') h.judge.evaluate = async () => h.output('not-satisfied', null);
    if (scenario === 'reject') h.judge.evaluate = async () => h.output('not-satisfied');
    if (scenario === 'invalid-verdict') h.judge.evaluate = async () => h.output('undetermined', null);
    if (scenario === 'bad-json') h.judge.evaluate = async () => 'not-json';
    if (scenario === 'late-backend') h.judge.evaluate = async () => { if (++n >= 2) throw Error('Synthetic fault'); return h.output(); };
    const r = await h.score(patch), ids = r.hardAssertions.slice(2).map(a => a.id);
    assert.deepEqual(projectWikiAssessment(r, h.rubric, h.binding, ids), r, scenario);
    const changed = structuredClone(r); changed.status = r.status === 'pass' ? 'fail' : 'pass';
    assert.throws(() => projectWikiAssessment(changed, h.rubric, h.binding, ids));
  }
});
test('immutable projection rejects a third verdict even if the caller forges a matching aggregate', async () => {
  const h = setup(), r = await h.score(), { projectWikiAssessment } = require(base + 'wiki-comparison-scoring');
  for (const row of r.votes) { row[0].verdict = 'undetermined'; row[0].evidence = []; }
  r.judgments[0] = { criterionId: 'q1', verdict: 'undetermined', majority: true };
  r.status = 'error'; r.reason = 'judge_undetermined';
  assert.throws(() => projectWikiAssessment(r, h.rubric, h.binding, []));
});
test('frozen rubric, valid hashes, known backends and valid objective check structures are required', async () => {
  const h = setup();
  const { confirmedAt, confirmationRecord, ...draft } = h.rubric;
  await assert.rejects(h.score({ rubric: { ...draft, status: 'draft' } }), /wiki_rubric_confirmation_required/);
  assert.throws(() => api().bindWikiJudge({ ...h.configuration, backend: 'gpt' }, h.rubric));
  assert.throws(() => api().bindWikiJudge({ ...h.configuration, promptHash: 'invalid' }, h.rubric));
  await assert.rejects(h.score({ hardAssertions: [{ id: 'check', status: 'pass' }, { id: 'check', status: 'fail' }] }));
});
