const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
// Lazy imports let the initial red run enumerate every missing contract.
const api = () => require(base + 'wiki-scoring-v2');
function setup(evidence = 'reply', backend = 'deepseek') {
  const { createWikiRubric } = require(base + 'wiki-rubric');
  const rubric = { ...createWikiRubric({ caseId: 'case-1', version: 1, model: 'deepseek/deepseek-v4-flash',
    actual: 'Unclear', expected: 'Clear result', questions: [
      { id: 'q1', question: 'Is the result clear?', evidence }, { id: 'q2', question: 'Is the next step clear?', evidence: 'reply' },
    ] }), status: 'frozen', confirmedAt: '2026-11-04T00:00:00.000Z', confirmationRecord: 'Synthetic user confirmation' };
  const configuration = { backend, model: backend === 'deepseek' ? 'deepseek/deepseek-v4-flash' : 'jev-latest', settings: { temperature: 0 }, promptHash: digest('synthetic-placeholder-not-a-judge-prompt') };
  const binding = api().bindWikiJudge(configuration, rubric);
  const run = { completed: true, replySource: 'public', publicReply: 'The fix is ready. Next: run the tests.', task: 'What is ready and what is next?', expected: 'Clear result' };
  const output = (verdict = 'satisfied', quote = 'The fix is ready.') => ({ judgments: rubric.questions.map(q => ({ criterionId: q.id, verdict, reason: 'Synthetic assessment',
    evidence: verdict === 'undetermined' ? [] : [{ source: 'reply', text: quote }] })) });
  let calls = 0;
  const judge = { configuration, async evaluate(input) { calls++; return output(); } };
  const score = (patch = {}, adapter = judge) => api().scoreWikiRun({ rubric, binding, run, hardAssertions: [], referenceMetrics: {}, ...patch }, adapter);
  return { rubric, configuration, binding, run, output, judge, score, calls: () => calls };
}
test('AC1: a failed hard assertion cannot be rescued by a satisfied judge', async () => {
  const h = setup(), r = await h.score({ hardAssertions: [{ id: 'unchanged-files', status: 'fail' }] });
  assert.equal(r.status, 'fail'); assert.equal(h.calls(), 0); assert.equal(r.judgments.length, 0);
});
test('AC1: each criterion takes three votes; majority undetermined is error, never in scored denominator', async () => {
  const h = setup(); let i = 0;
  h.judge.evaluate = async () => h.output(++i < 3 ? 'undetermined' : 'satisfied');
  const r = await h.score(); assert.equal(r.status, 'error'); assert.equal(r.reason, 'judge_undetermined');
  assert.equal(r.judgments[0].verdict, 'undetermined'); assert.equal(r.votes.length, 3);
  const { wikiComparisonTotals } = require(base + 'wiki-comparison-totals');
  const totals = wikiComparisonTotals([{ runs: [{ variant: 'original', ...r }] }], 1);
  assert.equal(totals.original.scored, 0);
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
    expected: 'Clear result', questions: h.rubric.questions }), status: 'frozen', confirmedAt: h.rubric.confirmedAt, confirmationRecord: 'User confirmed v2' };
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
test('a majority rejection wins over undetermined criteria; three different votes are unresolved, not pass', async () => {
  const h = setup(); let i = 0;
  h.judge.evaluate = async () => {
    const o = h.output('undetermined'); o.judgments[0] = h.output('not-satisfied').judgments[0]; return o;
  };
  assert.equal((await h.score()).status, 'fail');
  h.judge.evaluate = async () => h.output(['satisfied', 'not-satisfied', 'undetermined'][i++]);
  assert.equal((await h.score()).status, 'error');
});
test('invalid JSON/schema/quotes retry once per vote; persistent failure or backend fault is error', async () => {
  const h = setup(); let calls = 0;
  h.judge.evaluate = async () => ++calls % 2 ? 'not-json' : JSON.stringify(h.output());
  assert.equal((await h.score()).status, 'pass'); assert.equal(calls, 6);
  for (const bad of ['{bad', { judgments: [] }, { ...h.output(), extra: 'must not be accepted' }, h.output('satisfied', 'fabricated quote')]) {
    calls = 0; h.judge.evaluate = async () => { calls++; return bad; };
    assert.equal((await h.score()).status, 'error'); assert.equal(calls, 2);
  }
  calls = 0; h.judge.evaluate = async () => { calls++; throw Error('private backend details'); };
  const r = await h.score(); assert.equal(r.status, 'error'); assert.equal(calls, 1);
  assert.equal(JSON.stringify(r).includes('private backend details'), false);
});
test('binding mutation during an asynchronous vote is detected, never retried as JSON failure', async () => {
  const h = setup(); h.judge.evaluate = async () => { h.configuration.promptHash = digest('changed'); return h.output(); };
  await assert.rejects(h.score(), /wiki_judge_binding_changed/);
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
test('frozen rubric, valid hashes, known backends and valid objective check structures are required', async () => {
  const h = setup();
  const { confirmedAt, confirmationRecord, ...draft } = h.rubric;
  await assert.rejects(h.score({ rubric: { ...draft, status: 'draft' } }), /wiki_rubric_confirmation_required/);
  assert.throws(() => api().bindWikiJudge({ ...h.configuration, backend: 'gpt' }, h.rubric));
  assert.throws(() => api().bindWikiJudge({ ...h.configuration, promptHash: 'invalid' }, h.rubric));
  await assert.rejects(h.score({ hardAssertions: [{ id: 'check', status: 'pass' }, { id: 'check', status: 'fail' }] }));
});
